import { randomUUID } from "node:crypto";

import type {
  ArchiveSnapshot,
  RecapChapter,
  RecapStoryboard,
  ReviewStorylineRequest,
  Storyline,
  StorylineHandoff,
  VerifiedFact,
} from "../../shared/platform.js";
import type { ChanceInsight } from "../../shared/chanceSequence.js";
import { chanceInsightId, shotEventIdFromInsight } from "../../shared/chanceSequence.js";
import type { AgentStep, MatchEvent, MatchFixture } from "../../shared/types.js";
import type { AnalyzeFixture, LiveMatchView, StorylineDesk } from "../contracts.js";
import { analyzeFixture } from "../engine.js";
import { recordHandoffSpan, withSpan } from "../telemetry.js";
import { HttpError } from "../validation.js";
import { cardsForTrigger, type TacticsCard } from "./agents/tactics-analyst.js";
import { decideNext, type DirectorInput, type DirectorProposal } from "./coordinator.js";
import {
  CircuitBreaker,
  CircuitOpenError,
  classifyError,
  errorMessage,
  isRetryable,
  withTimeout,
  type ErrorClass,
  type RecoveryAction,
} from "./recovery.js";
import {
  STEP_OWNER,
  createWorkspace,
  lastReview,
  verifiedClaimTexts,
  type DeskAgentKey,
  type DeskStep,
  type StorylineWorkspace,
} from "./state.js";
import {
  activeEvents,
  buildArchiveIndexes,
  buildChanceSequenceProposal,
  englishClaimTexts,
  guardDraftText,
  guardLocalization,
  hashStateVersion,
  knownNamesForGuard,
  outputWordCount,
  scoreFromEvents,
  verifyClaimProposal,
  type ArchiveRetrieval,
  type ArchiveSearchHit,
  type ClaimProposal,
  type TriggerContext,
} from "./claims.js";
import { createArchiveRetrievalFromEnv } from "./retrieval.js";
import { createFoundryAgentRunner, type AgentRunner, type FactCheckResult, type LocalizationDraft, type ProducerDraft } from "./runner.js";

type DeskOptions = {
  archive: ArchiveSnapshot;
  runner?: AgentRunner;
  retrieval?: ArchiveRetrieval;
  now?: () => number;
  maxPerMatch?: number;
  maxConcurrent?: number;
  /** Shared per-agent circuit breaker (inject one with a fake clock in tests). */
  breaker?: CircuitBreaker;
  /** Per-call agent timeout before the call is classified as `timeout`. */
  agentTimeoutMs?: number;
  /** Coordinator budget per storyline. */
  maxSteps?: number;
  deadlineMs?: number;
  /** Engine analysis used by the tactics analyst for story cards. */
  analyze?: AnalyzeFixture;
};

function labelEvent(event: MatchEvent): string {
  return event.type === "red_card" ? "Red card" : event.type === "goal" ? "Goal" : event.type;
}

type PendingJob = {
  storylineId: string;
  view: LiveMatchView;
  event: MatchEvent;
};

type StorylineUpdate = { storyline?: Storyline; fact?: VerifiedFact };

type MatchState = {
  storylines: Storyline[];
  facts: VerifiedFact[];
  triggeredEventIds: Set<string>;
  rescindedEventIds: Set<string>;
};

const EMPTY_LOCALIZED = { en: "", es: "", fr: "", pt: "" } as const;

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function isTriggerEvent(event: MatchEvent): boolean {
  return (event.type === "goal" && !event.rescinded) || event.type === "red_card";
}

function makeTrace(role: string, status: "complete" | "rejected", detail: string, startedAt: number, now: () => number): AgentStep {
  return {
    role,
    status,
    detail,
    durationMs: Math.max(0, now() - startedAt),
  };
}

function compareStorylines(left: Storyline, right: Storyline): number {
  return left.triggerMinute - right.triggerMinute || left.createdAt.localeCompare(right.createdAt);
}

function finalPhase(view: LiveMatchView): number {
  const fulltime = activeEvents(view.fixture, view.clockSecond).find((event) => event.type === "fulltime" && !event.rescinded);
  return fulltime ? eventSecond(fulltime) : view.clockSecond;
}

function eventWindowTitle(event: MatchEvent, fixture: MatchFixture) {
  const player = [...fixture.home.players, ...fixture.away.players].find((candidate) => candidate.id === event.playerId)?.name ?? "Unknown player";
  const team = event.teamId === "home" ? fixture.home.name : fixture.away.name;
  if (event.type === "goal") {
    return {
      en: `${event.minute}' Goal - ${player}`,
      es: `${event.minute}' Gol - ${player}`,
      fr: `${event.minute}' But - ${player}`,
      pt: `${event.minute}' Gol - ${player}`,
    };
  }
  return {
    en: `${event.minute}' Red card - ${player}`,
    es: `${event.minute}' Roja - ${player}`,
    fr: `${event.minute}' Rouge - ${player}`,
    pt: `${event.minute}' Vermelho - ${player}`,
  };
}

function eventWindowSummary(event: MatchEvent, fixture: MatchFixture, score: { home: number; away: number }) {
  const player = [...fixture.home.players, ...fixture.away.players].find((candidate) => candidate.id === event.playerId)?.name ?? "Unknown player";
  const team = event.teamId === "home" ? fixture.home.name : fixture.away.name;
  if (event.type === "goal") {
    return {
      en: `${player} made it ${score.home}-${score.away} for ${team}.`,
      es: `${player} puso el ${score.home}-${score.away} para ${team}.`,
      fr: `${player} a porté le score à ${score.home}-${score.away} pour ${team}.`,
      pt: `${player} fez ${score.home}-${score.away} para o ${team}.`,
    };
  }
  return {
    en: `${player} saw red for ${team}.`,
    es: `${player} vio la roja con ${team}.`,
    fr: `${player} a été expulsé pour ${team}.`,
    pt: `${player} foi expulso pelo ${team}.`,
  };
}

function introChapter(fixture: MatchFixture, endSecond: number): RecapChapter {
  return {
    id: "chapter-kickoff",
    title: {
      en: "Kickoff",
      es: "Inicio",
      fr: "Coup d'envoi",
      pt: "Início de jogo",
    },
    startSecond: 0,
    endSecond,
    eventIds: [],
    storylineIds: [],
    summary: {
      en: `${fixture.home.name} and ${fixture.away.name} settled into the match.`,
      es: `${fixture.home.name} y ${fixture.away.name} se asentaron en el partido.`,
      fr: `${fixture.home.name} et ${fixture.away.name} sont entrés dans le match.`,
      pt: `${fixture.home.name} e ${fixture.away.name} entraram no ritmo da partida.`,
    },
  };
}

// Producer drafts get feedback from the deterministic guard between attempts.
const PRODUCER_ATTEMPTS = 3;

export class DefaultStorylineDesk implements StorylineDesk {
  private readonly archiveIndexes;
  private readonly retrieval: ArchiveRetrieval;
  private readonly runner: AgentRunner;
  private readonly now: () => number;
  private readonly maxPerMatch: number;
  private readonly maxConcurrent: number;
  private readonly listeners = new Set<(update: StorylineUpdate) => void>();
  private readonly byMatchId = new Map<string, MatchState>();
  private readonly chanceInsights = new Map<string, ChanceInsight>();
  private readonly byStorylineId = new Map<string, Storyline>();
  private readonly storylineFixtures = new Map<string, MatchFixture>();
  private readonly queue: PendingJob[] = [];
  private activeJobs = 0;
  private readonly breaker: CircuitBreaker;
  private readonly agentTimeoutMs: number;
  private readonly maxSteps: number;
  private readonly deadlineMs: number;
  private readonly analyze: AnalyzeFixture;

  constructor(private readonly archive: ArchiveSnapshot, options: Omit<Required<DeskOptions>, "archive"> & { archive?: ArchiveSnapshot }) {
    this.archiveIndexes = buildArchiveIndexes(archive);
    this.runner = options.runner;
    this.retrieval = options.retrieval;
    this.now = options.now;
    this.maxPerMatch = options.maxPerMatch;
    this.maxConcurrent = options.maxConcurrent;
    this.breaker = options.breaker;
    this.agentTimeoutMs = options.agentTimeoutMs;
    this.maxSteps = options.maxSteps;
    this.deadlineMs = options.deadlineMs;
    this.analyze = options.analyze;
  }

  private matchState(matchId: string): MatchState {
    const current = this.byMatchId.get(matchId);
    if (current) {
      return current;
    }
    const created: MatchState = { storylines: [], facts: [], triggeredEventIds: new Set(), rescindedEventIds: new Set() };
    this.byMatchId.set(matchId, created);
    return created;
  }

  private emit(update: StorylineUpdate): void {
    for (const listener of this.listeners) {
      listener({
        storyline: update.storyline ? deepClone(update.storyline) : undefined,
        fact: update.fact ? deepClone(update.fact) : undefined,
      });
    }
  }

  private saveStoryline(storyline: Storyline): Storyline {
    const match = this.matchState(storyline.matchId);
    const index = match.storylines.findIndex((candidate) => candidate.id === storyline.id);
    if (index >= 0) {
      match.storylines[index] = storyline;
    } else {
      match.storylines.push(storyline);
      match.storylines.sort(compareStorylines);
    }
    this.byStorylineId.set(storyline.id, storyline);
    return storyline;
  }

  private updateStoryline(id: string, mutate: (storyline: Storyline) => void): Storyline {
    const storyline = this.byStorylineId.get(id);
    if (!storyline) {
      throw new HttpError(404, "Storyline not found");
    }
    const wasRetracted = storyline.status === "retracted";
    mutate(storyline);
    // Retraction is terminal: in-flight pipeline steps may still log trace, but never revive the status.
    if (wasRetracted) {
      storyline.status = "retracted";
    }
    storyline.updatedAt = iso(this.now);
    storyline.version += 1;
    this.saveStoryline(storyline);
    this.emit({ storyline });
    return storyline;
  }

  private createBaseStoryline(view: LiveMatchView, event: MatchEvent): Storyline {
    const createdAt = iso(this.now);
    const storyline: Storyline = {
      id: randomUUID(),
      matchId: view.matchId,
      triggerEventIds: [event.id],
      triggerMinute: event.minute,
      createdAt,
      updatedAt: createdAt,
      status: "researching",
      priority: 0,
      headline: { ...EMPTY_LOCALIZED },
      onAirLine: { ...EMPTY_LOCALIZED },
      overlay: { ...EMPTY_LOCALIZED },
      claims: [],
      trace: [],
      version: 1,
    };
    if (event.type === "shot" || event.type === "goal") {
      const insightId = chanceInsightId(event.id);
      storyline.insightId = insightId;
      const insight = this.chanceInsights.get(insightId);
      if (insight && insight.matchId === view.matchId) {
        storyline.insightRevision = insight.revision;
        storyline.insightStatus = insight.status;
      }
    }
    this.saveStoryline(storyline);
    this.storylineFixtures.set(storyline.id, deepClone(view.fixture));
    this.emit({ storyline });
    return storyline;
  }

  private queueJob(storylineId: string, view: LiveMatchView, event: MatchEvent): void {
    this.queue.push({
      storylineId,
      view: deepClone(view),
      event: deepClone(event),
    });
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.activeJobs < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        return;
      }
      this.activeJobs += 1;
      void this.runPipeline(job).finally(() => {
        this.activeJobs -= 1;
        this.drainQueue();
      });
    }
  }

  private async runPipeline(job: PendingJob): Promise<void> {
    const storyline = this.byStorylineId.get(job.storylineId);
    if (!storyline) {
      return;
    }
    const triggerContext: TriggerContext = {
      event: job.event,
      fixture: job.view.fixture,
      matchId: job.view.matchId,
      clockSecond: job.view.clockSecond,
      score: scoreFromEvents(activeEvents(job.view.fixture, job.view.clockSecond)),
    };

    if (!this.runner.configured()) {
      const started = this.now();
      this.updateStoryline(job.storylineId, (current) => {
        current.status = "failed";
        current.failureReason = "Storyline agents are not configured";
        current.trace.push(makeTrace("researcher", "rejected", "Storyline agents are not configured", started, this.now));
      });
      return;
    }

    const workspace = createWorkspace({
      storylineId: storyline.id,
      matchId: storyline.matchId,
      trigger: triggerContext,
      knownNames: knownNamesForGuard(this.archive, job.view.fixture),
      now: this.now(),
      maxSteps: this.maxSteps,
      deadlineMs: this.deadlineMs,
    });

    await withSpan("desk.storyline", { storylineId: storyline.id, matchId: storyline.matchId, trigger: job.event.id }, async (span) => {
      this.handoff(workspace, {
        from: "desk",
        to: STEP_OWNER.research,
        reason: `${labelEvent(job.event)} at ${job.event.minute}' triggered a storyline`,
        outcome: "ok",
        decidedBy: "policy",
      });
      let step: DeskStep = "research";
      let reason = "";
      while (true) {
        if (this.isRetracted(workspace.storylineId)) {
          break;
        }
        workspace.budget.stepsTaken += 1;
        const terminal = await this.executeStep(workspace, step, job, reason);
        workspace.step = step;
        if (this.isRetracted(workspace.storylineId)) {
          break;
        }
        if (terminal) {
          this.recordTerminalHandoff(workspace, step);
          break;
        }
        const decision = await decideNext(workspace, {
          now: this.now,
          caps: { tactics: this.tacticsAvailable() },
          direct: this.directorFor(workspace),
        });
        const fallbackTrace = decision.outcome === "fallback"
          ? makeTrace("director", "rejected", `Recovery (${decision.recovery ?? "policy_fallback"}): ${decision.reason}`, this.now(), this.now)
          : undefined;
        this.handoff(workspace, {
          from: STEP_OWNER[step],
          to: STEP_OWNER[decision.step],
          reason: decision.reason,
          outcome: decision.outcome,
          decidedBy: decision.decidedBy,
          recovery: decision.recovery,
          errorClass: decision.errorClass,
        }, fallbackTrace);
        if (decision.step === "done") {
          break;
        }
        step = decision.step;
        reason = decision.reason;
      }
      const final = this.byStorylineId.get(workspace.storylineId);
      span.setAttribute("outcome", final?.status ?? "unknown");
      span.setAttribute("handoffs", workspace.handoffs.length);
      span.setAttribute("recoveries", workspace.handoffs.filter((entry) => entry.recovery).length);
    });
  }

  private isRetracted(storylineId: string): boolean {
    return this.byStorylineId.get(storylineId)?.status === "retracted";
  }

  /** Closes the handoff log: either to human review (approval is always manual) or to the desk on failure. */
  private recordTerminalHandoff(workspace: StorylineWorkspace, step: DeskStep): void {
    const status = this.byStorylineId.get(workspace.storylineId)?.status;
    const last = workspace.handoffs.at(-1);
    if (status === "needs_review") {
      if (last?.to === "human-review") {
        return;
      }
      this.handoff(workspace, {
        from: STEP_OWNER[step] === "human-review" ? "director" : STEP_OWNER[step],
        to: "human-review",
        reason: workspace.englishOnly ? "English-only copy awaiting human approval" : "Copy awaiting human approval",
        outcome: "ok",
        decidedBy: "policy",
      });
    } else if (status === "failed" && last?.to !== "desk") {
      this.handoff(workspace, {
        from: STEP_OWNER[step],
        to: "desk",
        reason: this.byStorylineId.get(workspace.storylineId)?.failureReason ?? "Storyline failed",
        outcome: "failed",
        decidedBy: "policy",
      });
    }
  }

  private tacticsAvailable(): boolean {
    return typeof this.runner.tactics === "function" && this.breaker.canCall("tactics-analyst");
  }

  private directorFor(workspace: StorylineWorkspace): ((input: DirectorInput) => Promise<DirectorProposal>) | undefined {
    const direct = this.runner.direct?.bind(this.runner);
    if (!direct) {
      return undefined;
    }
    return (input) => this.callAgent(workspace, "director", () => direct(input), { timeoutMs: Math.min(this.agentTimeoutMs, 20_000) });
  }

  /** Appends a handoff to the workspace log (and optionally a trace step) and persists both on the storyline. */
  private handoff(workspace: StorylineWorkspace, entry: Omit<StorylineHandoff, "at">, traceStep?: AgentStep): void {
    const full: StorylineHandoff = Object.fromEntries(
      Object.entries({ ...entry, at: iso(this.now) }).filter(([, value]) => value !== undefined),
    ) as unknown as StorylineHandoff;
    workspace.handoffs.push(full);
    recordHandoffSpan({
      storylineId: workspace.storylineId,
      from: full.from,
      to: full.to,
      outcome: full.outcome,
      decidedBy: full.decidedBy,
      recovery: full.recovery,
      errorClass: full.errorClass,
    });
    this.updateStoryline(workspace.storylineId, (current) => {
      if (traceStep) {
        current.trace.push(traceStep);
      }
      current.handoffs = deepClone(workspace.handoffs);
    });
  }

  /** Every recovery is a rejected trace step for the failing agent plus a handoff describing the re-route. */
  private recover(
    workspace: StorylineWorkspace,
    input: { agent: string; to: string; reason: string; outcome: StorylineHandoff["outcome"]; recovery: RecoveryAction; errorClass: ErrorClass; started?: number },
  ): void {
    this.handoff(workspace, {
      from: input.agent,
      to: input.to,
      reason: input.reason,
      outcome: input.outcome,
      decidedBy: "policy",
      recovery: input.recovery,
      errorClass: input.errorClass,
    }, makeTrace(input.agent, "rejected", `Recovery (${input.recovery}): ${input.reason}`, input.started ?? this.now(), this.now));
  }

  /** Calls one agent behind its circuit breaker and a timeout, retrying transient failures. */
  private async callAgent<T>(
    workspace: StorylineWorkspace,
    agent: DeskAgentKey,
    run: () => Promise<T>,
    options: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = options.retries ?? 0;
    for (let attempt = 0; ; attempt += 1) {
      workspace.attempts[agent] += 1;
      const started = this.now();
      try {
        const result = await withSpan(`desk.agent.${agent}`, { agent, storylineId: workspace.storylineId, attempt: attempt + 1 }, async (span) => {
          try {
            this.breaker.assertCanCall(agent);
            const value = await withTimeout(agent, options.timeoutMs ?? this.agentTimeoutMs, run);
            span.setAttribute("outcome", "ok");
            return value;
          } catch (error) {
            span.setAttribute("outcome", classifyError(error));
            throw error;
          }
        });
        this.breaker.recordSuccess(agent);
        return result;
      } catch (error) {
        const errorClass = classifyError(error);
        if (!(error instanceof CircuitOpenError)) {
          this.breaker.recordFailure(agent);
        }
        if (attempt < retries && isRetryable(errorClass) && this.breaker.canCall(agent) && this.now() < workspace.budget.deadlineAt) {
          this.recover(workspace, {
            agent,
            to: agent,
            reason: `${errorClass}: ${errorMessage(error)}; retrying`,
            outcome: "retry",
            recovery: "retry",
            errorClass,
            started,
          });
          continue;
        }
        throw error;
      }
    }
  }

  /** Runs one step against the workspace. Returns true when the storyline reached a terminal status. */
  private async executeStep(workspace: StorylineWorkspace, step: DeskStep, job: PendingJob, reason: string): Promise<boolean> {
    switch (step) {
      case "research":
        return this.stepResearch(workspace, job);
      case "verify":
        return this.stepVerify(workspace, job);
      case "tactics":
        return this.stepTactics(workspace, job);
      case "produce":
        return this.stepProduce(workspace);
      case "fact_check":
        return this.stepFactCheck(workspace);
      case "revise":
        return this.stepRevise(workspace);
      case "localize":
        return this.stepLocalize(workspace);
      case "needs_review":
        return this.stepNeedsReview(workspace, reason);
      case "failed": {
        const started = this.now();
        this.updateStoryline(workspace.storylineId, (current) => {
          current.status = "failed";
          current.failureReason = reason || "Coordinator stopped the run";
          current.trace.push(makeTrace("director", "rejected", current.failureReason, started, this.now));
        });
        return true;
      }
      case "done":
        return true;
    }
  }

  private async stepResearch(workspace: StorylineWorkspace, job: PendingJob): Promise<boolean> {
    const started = this.now();
    try {
      let proposals = await this.callAgent(workspace, "researcher", () => this.runner.research({
        archive: this.archive,
        retrieval: this.retrieval,
        fixture: deepClone(job.view.fixture),
        clockSecond: job.view.clockSecond,
        triggerEvent: deepClone(job.event),
      }), { retries: 1 });
      // The live analyst always contributes the scoreline context, so copy about leads or equalisers
      // can be checked against a verified claim instead of the producer's assumptions.
      if (!proposals.some((proposal) => proposal.kind === "match_state")) {
        proposals = [...proposals, {
          kind: "match_state",
          params: { eventIds: [job.event.id] },
          sources: [{ type: "event", id: job.event.id }],
        }];
      }
      proposals = this.withChanceProposal(job, proposals);
      workspace.proposals = proposals;
      this.updateStoryline(workspace.storylineId, (current) => {
        current.trace.push(makeTrace("researcher", "complete", `Produced ${proposals.length} claim proposal(s) via ${this.retrieval.describe()}`, started, this.now));
        current.status = "checking";
      });
      return false;
    } catch (error) {
      this.updateStoryline(workspace.storylineId, (current) => {
        current.status = "failed";
        current.failureReason = error instanceof Error ? error.message : "Research failed";
        current.trace.push(makeTrace("researcher", "rejected", current.failureReason, started, this.now));
      });
      return true;
    }
  }

  /** Runs the deterministic verifier over proposals and records verified facts on the workspace. */
  private verifyInto(workspace: StorylineWorkspace, job: PendingJob, proposals: ClaimProposal[]): { verified: number; rejected: number } {
    let verified = 0;
    let rejected = 0;
    // A storyline retracted mid-run verifies against a stale fixture: publish no new facts for it.
    if (this.isRetracted(workspace.storylineId)) {
      return { verified, rejected };
    }
    const createdAt= this.byStorylineId.get(workspace.storylineId)?.createdAt ?? iso(this.now);
    for (const proposal of proposals) {
      const result = verifyClaimProposal(this.archive, this.archiveIndexes, job.view.fixture, workspace.trigger, workspace.storylineId, createdAt, proposal);
      if (result.ok) {
        verified += 1;
        workspace.claims.verified.push(result.claim);
        workspace.claims.facts.push(result.fact);
        this.matchState(workspace.matchId).facts.push(result.fact);
        this.emit({ fact: result.fact });
      } else {
        rejected += 1;
        workspace.claims.rejected.push(result.claim);
      }
    }
    return { verified, rejected };
  }

  private async stepVerify(workspace: StorylineWorkspace, job: PendingJob): Promise<boolean> {
    const started = this.now();
    this.updateStoryline(workspace.storylineId, (current) => {
      current.claims = [];
    });
    workspace.proposals = this.withChanceProposal(job, workspace.proposals);
    const { verified, rejected } = this.verifyInto(workspace, job, workspace.proposals);
    this.updateStoryline(workspace.storylineId, (current) => {
      current.claims = [...workspace.claims.verified, ...workspace.claims.rejected];
      current.trace.push(makeTrace("verifier", verified > 0 ? "complete" : "rejected", `Verified ${verified}; rejected ${rejected}`, started, this.now));
      current.status = verified > 0 ? "drafting" : "failed";
      if (verified === 0) {
        current.failureReason = "No verified claims available";
      }
    });
    return verified === 0;
  }

  private async stepTactics(workspace: StorylineWorkspace, job: PendingJob): Promise<boolean> {
    const started = this.now();
    workspace.tactics.done = true;
    const tactics = this.runner.tactics?.bind(this.runner);
    if (!tactics) {
      return false;
    }
    let cards: TacticsCard[] = [];
    try {
      const atSecond = Math.min(job.view.fixture.durationSeconds, Math.max(0, Math.round(job.view.clockSecond)));
      const snapshot = this.analyze(deepClone(job.view.fixture), {
        fixtureId: job.view.fixture.id,
        atSecond,
        persona: "analyst",
        language: "en",
      });
      cards = cardsForTrigger(snapshot.stories, job.event);
    } catch {
      cards = [];
    }
    workspace.tactics.cards = cards.map(({ id, kind, title, importance, windowStart, windowEnd }) => ({ id, kind, title, importance, windowStart, windowEnd }));
    if (cards.length === 0) {
      this.updateStoryline(workspace.storylineId, (current) => {
        current.trace.push(makeTrace("tactics-analyst", "complete", "No tactical story cards in the trigger window", started, this.now));
      });
      return false;
    }
    try {
      const proposals = await this.callAgent(workspace, "tactics-analyst", () => tactics({
        trigger: deepClone(job.event),
        cards: deepClone(cards),
        events: activeEvents(job.view.fixture, job.view.clockSecond),
        existing: deepClone(workspace.proposals),
      }));
      const chance = this.withChanceProposal(job, workspace.proposals).filter((proposal) => proposal.kind === "chance_sequence" && !workspace.proposals.some((existing) => existing.kind === "chance_sequence"));
      workspace.tactics.proposals = proposals;
      workspace.proposals = [...workspace.proposals, ...proposals, ...chance];
      const { verified, rejected } = this.verifyInto(workspace, job, [...proposals, ...chance]);
      this.updateStoryline(workspace.storylineId, (current) => {
        current.claims = [...workspace.claims.verified, ...workspace.claims.rejected];
        current.trace.push(makeTrace(
          "tactics-analyst",
          "complete",
          `Read ${cards.length} card(s) (${cards.map((card) => card.kind).join(", ")}); proposed ${proposals.length} claim(s); verified ${verified}; rejected ${rejected}`,
          started,
          this.now,
        ));
      });
    } catch (error) {
      const errorClass = classifyError(error);
      this.recover(workspace, {
        agent: "tactics-analyst",
        to: "producer",
        reason: `Skipped optional tactics analyst (${errorClass}: ${errorMessage(error)})`,
        outcome: "skipped",
        recovery: "skip_optional",
        errorClass,
        started,
      });
    }
    return false;
  }

  private applyDraft(workspace: StorylineWorkspace, draft: ProducerDraft): void {
    workspace.currentDraft = draft;
    this.updateStoryline(workspace.storylineId, (current) => {
      current.priority = draft.priority;
      current.headline.en = draft.headline;
      current.onAirLine.en = draft.onAirLine;
      current.overlay.en = draft.overlay;
    });
  }

  private async stepProduce(workspace: StorylineWorkspace): Promise<boolean> {
    const started = this.now();
    const { draft, guardErrors, agentError } = await this.runProducerWithGuard(workspace);
    if (!draft) {
      this.updateStoryline(workspace.storylineId, (current) => {
        current.status = "failed";
        current.failureReason = agentError
          ? `Producer unavailable (${agentError.errorClass}): ${agentError.message}`
          : `Producer output failed deterministic guard: ${guardErrors.join("; ")}`;
        current.trace.push(makeTrace("producer", "rejected", current.failureReason, started, this.now));
      });
      return true;
    }
    this.applyDraft(workspace, draft);
    this.updateStoryline(workspace.storylineId, (current) => {
      current.trace.push(makeTrace("producer", "complete", "Drafted storyline copy", started, this.now));
    });
    return false;
  }

  private async stepFactCheck(workspace: StorylineWorkspace): Promise<boolean> {
    workspace.factCheckStartedAt ??= this.now();
    const started = workspace.factCheckStartedAt;
    const draft = workspace.currentDraft;
    if (!draft) {
      return false;
    }
    let review: FactCheckResult;
    try {
      review = await this.callAgent(workspace, "fact-checker", () => this.runner.factCheck({
        claims: verifiedClaimTexts(workspace),
        headline: draft.headline,
        onAirLine: draft.onAirLine,
        overlay: draft.overlay,
      }), { retries: 1 });
    } catch (error) {
      const errorClass = classifyError(error);
      this.recover(workspace, {
        agent: "fact-checker",
        to: "human-review",
        reason: `Fact-checker unavailable (${errorClass}: ${errorMessage(error)}); escalated guard-checked English copy to human review`,
        outcome: "escalated",
        recovery: "escalate_review",
        errorClass,
        started,
      });
      this.updateStoryline(workspace.storylineId, (current) => {
        current.status = "needs_review";
      });
      return true;
    }
    workspace.reviews.push(review);
    if (review.verdict === "pass") {
      const detail = workspace.revisions > 0
        ? workspace.reviews[0].issues.join("; ") || "Draft revised once"
        : "Draft supported by verified claims";
      workspace.pendingIssues = undefined;
      this.updateStoryline(workspace.storylineId, (current) => {
        current.trace.push(makeTrace("fact-checker", "complete", detail, started, this.now));
      });
    } else {
      workspace.pendingIssues = review.issues;
    }
    return false;
  }

  private async stepRevise(workspace: StorylineWorkspace): Promise<boolean> {
    const issues = workspace.pendingIssues ?? [];
    const { draft, guardErrors, agentError } = await this.runProducerWithGuard(workspace, issues);
    if (!draft) {
      this.updateStoryline(workspace.storylineId, (current) => {
        current.status = "failed";
        current.failureReason = agentError
          ? `Producer retry unavailable (${agentError.errorClass}): ${agentError.message}`
          : `Producer retry failed deterministic guard: ${guardErrors.join("; ")}`;
        current.trace.push(makeTrace("fact-checker", "rejected", `${issues.join("; ") || "Revision requested"}; producer retry failed`, workspace.factCheckStartedAt ?? this.now(), this.now));
      });
      return true;
    }
    workspace.revisions += 1;
    this.applyDraft(workspace, draft);
    return false;
  }

  private async stepNeedsReview(workspace: StorylineWorkspace, reason: string): Promise<boolean> {
    const review = lastReview(workspace);
    const started = workspace.factCheckStartedAt ?? this.now();
    this.updateStoryline(workspace.storylineId, (current) => {
      current.status = "needs_review";
      if (review?.verdict === "revise") {
        current.trace.push(makeTrace("fact-checker", "rejected", review.issues.join("; "), started, this.now));
      } else {
        current.trace.push(makeTrace("director", "rejected", `English-only copy sent to human review: ${reason}`, this.now(), this.now));
      }
    });
    return true;
  }

  private async stepLocalize(workspace: StorylineWorkspace): Promise<boolean> {
    const started = this.now();
    const draft = workspace.currentDraft;
    if (!draft) {
      return true;
    }
    try {
      const localized = await this.localizeWithGuard(workspace.knownNames, {
        headline: draft.headline,
        onAirLine: draft.onAirLine,
        overlay: draft.overlay,
      }, (english) => this.callAgent(workspace, "localizer", () => this.runner.localize(english), { retries: 1 }));
      workspace.localization = localized;
      this.updateStoryline(workspace.storylineId, (current) => {
        current.headline.es = localized.es.headline;
        current.onAirLine.es = localized.es.onAirLine;
        current.overlay.es = localized.es.overlay;
        current.headline.fr = localized.fr.headline;
        current.onAirLine.fr = localized.fr.onAirLine;
        current.overlay.fr = localized.fr.overlay;
        current.headline.pt = localized.pt.headline;
        current.onAirLine.pt = localized.pt.onAirLine;
        current.overlay.pt = localized.pt.overlay;
        current.status = "needs_review";
        current.trace.push(makeTrace("localizer", "complete", localized.detail, started, this.now));
      });
    } catch (error) {
      const errorClass = classifyError(error);
      workspace.englishOnly = true;
      this.recover(workspace, {
        agent: "localizer",
        to: "human-review",
        reason: `Localizer unavailable (${errorClass}: ${errorMessage(error)}); English-only copy flagged for review`,
        outcome: "skipped",
        recovery: "english_only",
        errorClass,
        started,
      });
      this.updateStoryline(workspace.storylineId, (current) => {
        current.status = "needs_review";
      });
    }
    return true;
  }

  private async runProducerWithGuard(
    workspace: StorylineWorkspace,
    feedback?: string[],
  ): Promise<{ draft?: ProducerDraft; guardErrors: string[]; agentError?: { errorClass: ErrorClass; message: string } }> {
    const claimTexts = verifiedClaimTexts(workspace);
    const guardErrors: string[] = [];
    let agentError: { errorClass: ErrorClass; message: string } | undefined;
    for (let attempt = 0; attempt < PRODUCER_ATTEMPTS; attempt += 1) {
      let draft: ProducerDraft;
      try {
        const currentFeedback = feedback;
        draft = await this.callAgent(workspace, "producer", () => this.runner.produce({ claims: claimTexts, feedback: currentFeedback }));
      } catch (error) {
        const errorClass = classifyError(error);
        agentError = { errorClass, message: errorMessage(error) };
        if (!isRetryable(errorClass) || !this.breaker.canCall("producer") || attempt + 1 >= PRODUCER_ATTEMPTS) {
          break;
        }
        this.recover(workspace, {
          agent: "producer",
          to: "producer",
          reason: `${errorClass}: ${agentError.message}; retrying with feedback`,
          outcome: "retry",
          recovery: "retry_with_feedback",
          errorClass,
        });
        if (errorClass === "schema_invalid") {
          feedback = [...(feedback ?? []), "Previous output did not match the schema; return exactly headline, onAirLine, overlay and priority."];
        }
        continue;
      }
      agentError = undefined;
      workspace.drafts.push(draft);
      const guardError = this.guardProducerDraft(draft, claimTexts, workspace.knownNames);
      if (!guardError) {
        return { draft, guardErrors };
      }
      guardErrors.push(guardError);
      if (attempt + 1 < PRODUCER_ATTEMPTS) {
        this.recover(workspace, {
          agent: "producer",
          to: "producer",
          reason: `Guard rejected draft: ${guardError}; retrying with feedback`,
          outcome: "retry",
          recovery: "retry_with_feedback",
          errorClass: "guard_reject",
        });
      }
      feedback = [...(feedback ?? []), guardError];
    }
    return { guardErrors, agentError };
  }

  private guardProducerDraft(draft: ProducerDraft, claimTexts: string[], knownNames: Set<string>): string | undefined {
    if (draft.headline.length > 70) {
      return `Headline is ${draft.headline.length} characters; rewrite it as a complete phrase of at most 60 characters`;
    }
    if (draft.overlay.length > 60) {
      return `Overlay is ${draft.overlay.length} characters; rewrite it as a complete phrase of at most 50 characters`;
    }
    if (outputWordCount(draft.onAirLine) > 40) {
      return `On-air line is ${outputWordCount(draft.onAirLine)} words; rewrite it in at most 35 words`;
    }
    for (const [label, segment] of [["Headline", draft.headline], ["Overlay", draft.overlay], ["On-air line", draft.onAirLine]] as const) {
      if (/[\/\-–,:;(&]\s*$/.test(segment.trim())) {
        return `${label} ends mid-phrase; rewrite it as a complete phrase`;
      }
    }
    for (const segment of [draft.headline, draft.onAirLine, draft.overlay]) {
      const guardError = guardDraftText(segment, claimTexts, knownNames);
      if (guardError) {
        return guardError;
      }
    }
    return undefined;
  }
  private async localizeWithGuard(
    knownNames: Set<string>,
    english: { headline: string; onAirLine: string; overlay: string },
    localize: (english: { headline: string; onAirLine: string; overlay: string }) => Promise<LocalizationDraft> = (input) => this.runner.localize(input),
  ): Promise<LocalizationDraft & { detail: string }> {
    const failures: string[] = [];
    const empty = { headline: "", onAirLine: "", overlay: "" };
    const validated: LocalizationDraft = { es: { ...empty }, fr: { ...empty }, pt: { ...empty } };
    const first = await localize(english);
    for (const language of ["es", "fr", "pt"] as const) {
      let selected = first[language];
      let guardError = guardLocalization(english.headline, selected.headline, knownNames)
        ?? guardLocalization(english.onAirLine, selected.onAirLine, knownNames)
        ?? guardLocalization(english.overlay, selected.overlay, knownNames);
      if (!guardError) {
        validated[language] = selected;
        continue;
      }
      let second: LocalizationDraft;
      try {
        second = await localize(english);
      } catch (error) {
        failures.push(`${language}: ${guardError}; retry unavailable (${classifyError(error)})`);
        continue;
      }
      selected = second[language];
      guardError = guardLocalization(english.headline, selected.headline, knownNames)
        ?? guardLocalization(english.onAirLine, selected.onAirLine, knownNames)
        ?? guardLocalization(english.overlay, selected.overlay, knownNames);
      if (!guardError) {
        validated[language] = selected;
        continue;
      }
      failures.push(`${language}: ${guardError}`);
    }
    return {
      ...validated,
      detail: failures.length > 0 ? `Translation unavailable for ${failures.join("; ")}` : "Localized English draft to es, fr and pt",
    };
  }

  private withChanceProposal(job: PendingJob, proposals: ClaimProposal[]): ClaimProposal[] {
    if (proposals.some((proposal) => proposal.kind === "chance_sequence")) {
      return proposals;
    }
    const chance = buildChanceSequenceProposal(job.view.fixture, job.event, job.view.clockSecond);
    return chance ? [...proposals, chance] : proposals;
  }

  /**
   * Records an insight revision and retracts or flags storylines that explain that chance.
   * Called by the insight feed, which runs before this desk on the live listener list.
   */
  applyChanceInsight(insight: ChanceInsight): void {
    this.chanceInsights.set(insight.insightId, insight);
    const match = this.byMatchId.get(insight.matchId);
    if (!match) {
      return;
    }
    const shotId = shotEventIdFromInsight(insight.insightId);
    for (const storyline of [...match.storylines]) {
      const linked = storyline.insightId === insight.insightId
        || (shotId !== undefined && storyline.triggerEventIds.includes(shotId));
      if (!linked || storyline.status === "retracted") {
        continue;
      }
      if (insight.status === "withdrawn") {
        const reason = insight.withdrawalReason ?? "Chance insight was withdrawn";
        this.updateStoryline(storyline.id, (current) => {
          current.status = "retracted";
          current.retractionReason = reason;
          current.insightId = insight.insightId;
          current.insightRevision = insight.revision;
          current.insightStatus = "withdrawn";
          current.insightNote = reason;
        });
        for (const fact of match.facts) {
          if (fact.storylineId === storyline.id && !fact.retracted) {
            fact.retracted = true;
            this.emit({ fact });
          }
        }
        continue;
      }
      if (insight.status === "revised") {
        const published = storyline.status === "approved" || Boolean(storyline.approvedAt);
        this.updateStoryline(storyline.id, (current) => {
          current.insightId = insight.insightId;
          current.insightRevision = insight.revision;
          current.insightStatus = "revised";
          current.insightNote = insight.revisionReason ?? `Chance insight revised to revision ${insight.revision}. On-air numbers may be stale.`;
          if (current.status === "approved") {
            current.status = "needs_review";
          }
        });
        // Previously published facts are stale the moment the insight moves. Retract them now and
        // emit, so a connected fan drops them without waiting for a reconnect.
        if (published) {
          for (const fact of match.facts) {
            if (fact.storylineId === storyline.id && !fact.retracted) {
              fact.retracted = true;
              this.emit({ fact });
            }
          }
        }
        continue;
      }
      if (storyline.insightRevision !== insight.revision || storyline.insightStatus !== insight.status) {
        this.updateStoryline(storyline.id, (current) => {
          current.insightId = insight.insightId;
          current.insightRevision = insight.revision;
          current.insightStatus = insight.status;
        });
      }
    }
    if (insight.status === "withdrawn" && shotId) {
      for (const fact of match.facts) {
        const citesShot = fact.sources.some((source) => source.type === "event" && source.id === shotId);
        if (citesShot && !fact.retracted) {
          fact.retracted = true;
          this.emit({ fact });
        }
      }
    }
  }

  onEvent(view: LiveMatchView, event: MatchEvent): void {
    const match = this.matchState(view.matchId);
    if (event.rescinded) {
      match.rescindedEventIds.add(event.id);
      this.retractForEvent(view.matchId, event.id, `Event ${event.id} was rescinded`);
      return;
    }
    if (!isTriggerEvent(event)) {
      return;
    }
    if (match.triggeredEventIds.has(event.id)) {
      return;
    }
    if (match.storylines.length >= this.maxPerMatch) {
      return;
    }
    match.triggeredEventIds.add(event.id);
    const storyline = this.createBaseStoryline(view, event);
    this.queueJob(storyline.id, view, event);
  }

  private retractForEvent(matchId: string, eventId: string, reason: string): void {
    const match = this.byMatchId.get(matchId);
    if (!match) {
      return;
    }
    for (const storyline of match.storylines) {
      const citesEvent = storyline.triggerEventIds.includes(eventId)
        || storyline.claims.some((claim) => claim.sources.some((source) => source.type === "event" && source.id === eventId));
      if (!citesEvent || storyline.status === "retracted") {
        continue;
      }
      this.updateStoryline(storyline.id, (current) => {
        current.status = "retracted";
        current.retractionReason = reason;
      });
    }
    for (const fact of match.facts) {
      const citesEvent = fact.sources.some((source) => source.type === "event" && source.id === eventId);
      if (!citesEvent || fact.retracted) {
        continue;
      }
      fact.retracted = true;
      this.emit({ fact });
    }
  }

  onMatchStart(): void {}

  onMatchEnd(): void {}

  list(matchId: string): Storyline[] {
    return deepClone(this.matchState(matchId).storylines);
  }

  facts(matchId: string): VerifiedFact[] {
    return deepClone(this.matchState(matchId).facts);
  }

  subscribe(listener: (update: StorylineUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  health(): { mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string } {
    const runnerHealth = this.runner.health();
    return {
      mode: runnerHealth.mode,
      agents: runnerHealth.agents,
      retrieval: this.retrieval.mode,
    };
  }

  /** Approval is only possible while the storyline awaits review and none of its trigger events were rescinded. */
  private assertApprovable(storyline: Storyline): void {
    if (storyline.status === "retracted") {
      throw new HttpError(409, "Storyline was retracted");
    }
    const rescinded = this.byMatchId.get(storyline.matchId)?.rescindedEventIds;
    if (rescinded && storyline.triggerEventIds.some((eventId) => rescinded.has(eventId))) {
      throw new HttpError(409, "Storyline trigger event was rescinded");
    }
    if (storyline.status !== "needs_review") {
      throw new HttpError(409, "Storyline is not awaiting review");
    }
  }

  async review(id: string, request: ReviewStorylineRequest): Promise<Storyline> {
    const storyline = this.byStorylineId.get(id);
    if (!storyline) {
      throw new HttpError(404, "Storyline not found");
    }
    if (request.decision === "reject") {
      if (storyline.status !== "needs_review") {
        throw new HttpError(409, "Storyline is not awaiting review");
      }
      return deepClone(this.updateStoryline(id, (current) => {
        current.status = "rejected";
        current.review = { decision: "rejected", at: iso(this.now), note: request.note };
      }));
    }
    this.assertApprovable(storyline);
    if (request.decision === "approve") {
      return deepClone(this.updateStoryline(id, (current) => {
        current.status = "approved";
        current.review = { decision: "approved", at: iso(this.now), note: request.note };
        current.approvedAt ??= iso(this.now);
      }));
    }
    const editedLine = request.onAirLine?.trim();
    if (!editedLine) {
      throw new HttpError(400, "onAirLine is required when decision is edit");
    }
    const guardError = guardDraftText(editedLine, englishClaimTexts(storyline.claims), knownNamesForGuard(this.archive, this.findFixtureForStoryline(storyline)));
    if (guardError) {
      throw new HttpError(400, guardError);
    }
    const localized = await this.localizeWithGuard(knownNamesForGuard(this.archive, this.findFixtureForStoryline(storyline)), {
      headline: storyline.headline.en,
      onAirLine: editedLine,
      overlay: storyline.overlay.en,
    });
    // Localization is async: the trigger may have been rescinded (and the storyline retracted) meanwhile.
    this.assertApprovable(storyline);
    return deepClone(this.updateStoryline(id, (current) => {
      current.onAirLine.en = editedLine;
      current.onAirLine.es = localized.es.onAirLine;
      current.onAirLine.fr = localized.fr.onAirLine;
      current.headline.es = localized.es.headline || current.headline.es;
      current.headline.fr = localized.fr.headline || current.headline.fr;
      current.overlay.es = localized.es.overlay || current.overlay.es;
      current.overlay.fr = localized.fr.overlay || current.overlay.fr;
      current.onAirLine.pt = localized.pt.onAirLine;
      current.headline.pt = localized.pt.headline || current.headline.pt;
      current.overlay.pt = localized.pt.overlay || current.overlay.pt;
      current.status = "approved";
      current.review = { decision: "edited", at: iso(this.now), note: request.note };
      current.approvedAt ??= iso(this.now);
      current.trace.push({
        role: "review",
        status: "complete",
        detail: localized.detail,
        durationMs: 0,
      });
    }));
  }

  private findFixtureForStoryline(storyline: Storyline): MatchFixture {
    const fixture = this.storylineFixtures.get(storyline.id);
    if (fixture) {
      return deepClone(fixture);
    }
    throw new HttpError(500, `Fixture unavailable for storyline ${storyline.id}`);
  }

  storyboard(view: LiveMatchView): RecapStoryboard {
    const events = activeEvents(view.fixture, view.clockSecond).filter((event) => !event.rescinded);
    const markers = events.filter((event) => event.type === "goal" || event.type === "red_card");
    const chapters: RecapChapter[] = [];
    const matchStorylines = this.list(view.matchId).filter((storyline) => storyline.status === "approved");
    if (markers.length === 0) {
      chapters.push({
        ...introChapter(view.fixture, finalPhase(view)),
        storylineIds: matchStorylines.map((storyline) => storyline.id),
      });
      return {
        matchId: view.matchId,
        stateVersion: hashStateVersion(events),
        chapters,
      };
    }

    chapters.push(introChapter(view.fixture, eventSecond(markers[0])));
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const nextMarker = markers[index + 1];
      const chapterEvents = events.filter((event) => eventSecond(event) >= eventSecond(marker) && eventSecond(event) < (nextMarker ? eventSecond(nextMarker) : finalPhase(view)));
      chapters.push({
        id: `chapter-${index + 1}-${marker.id}`,
        title: eventWindowTitle(marker, view.fixture),
        startSecond: eventSecond(marker),
        endSecond: nextMarker ? eventSecond(nextMarker) : finalPhase(view),
        eventIds: chapterEvents.map((event) => event.id),
        storylineIds: matchStorylines.filter((storyline) => storyline.triggerMinute * 60 >= eventSecond(marker) && storyline.triggerMinute * 60 < (nextMarker ? eventSecond(nextMarker) : finalPhase(view))).map((storyline) => storyline.id),
        summary: eventWindowSummary(marker, view.fixture, scoreFromEvents(events.filter((event) => eventSecond(event) <= eventSecond(marker)))),
      });
    }
    const lastMarker = markers[markers.length - 1];
    const finalScore = scoreFromEvents(events);
    const fullTime = view.clockSecond >= view.fixture.durationSeconds;
    const scoreline = `${view.fixture.home.name} ${finalScore.home}-${finalScore.away} ${view.fixture.away.name}`;
    chapters.push({
      id: "chapter-final",
      title: fullTime
        ? { en: "Full time", es: "Final del partido", fr: "Fin du match", pt: "Fim de jogo" }
        : { en: "Latest state", es: "Estado actual", fr: "État actuel", pt: "Situação atual" },
      startSecond: eventSecond(lastMarker),
      endSecond: finalPhase(view),
      eventIds: events.filter((event) => eventSecond(event) >= eventSecond(lastMarker) && eventSecond(event) <= finalPhase(view)).map((event) => event.id),
      storylineIds: matchStorylines.filter((storyline) => storyline.triggerMinute * 60 >= eventSecond(lastMarker)).map((storyline) => storyline.id),
      summary: fullTime
        ? { en: `Full time: ${scoreline}.`, es: `Final: ${scoreline}.`, fr: `Score final : ${scoreline}.`, pt: `Placar final: ${scoreline}.` }
        : { en: `Current score: ${scoreline}.`, es: `Marcador actual: ${scoreline}.`, fr: `Score actuel : ${scoreline}.`, pt: `Placar atual: ${scoreline}.` },
    });
    return {
      matchId: view.matchId,
      stateVersion: hashStateVersion(events),
      chapters,
    };
  }
}

export function createStorylineDesk(deps: DeskOptions): StorylineDesk {
  const now = deps.now ?? Date.now;
  return new DefaultStorylineDesk(deps.archive, {
    runner: deps.runner ?? createFoundryAgentRunner(),
    retrieval: deps.retrieval ?? createArchiveRetrievalFromEnv(),
    now,
    maxPerMatch: deps.maxPerMatch ?? 12,
    maxConcurrent: deps.maxConcurrent ?? 2,
    breaker: deps.breaker ?? new CircuitBreaker({ now }),
    agentTimeoutMs: deps.agentTimeoutMs ?? 90_000,
    maxSteps: deps.maxSteps ?? 12,
    deadlineMs: deps.deadlineMs ?? 240_000,
    analyze: deps.analyze ?? analyzeFixture,
  });
}

export { createArchiveRetrievalFromEnv, createFoundryAgentRunner, CircuitBreaker };
export type { AgentRunner, ArchiveRetrieval, ArchiveSearchHit, StorylineWorkspace };
