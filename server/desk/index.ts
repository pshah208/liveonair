import { randomUUID } from "node:crypto";

import type {
  ArchiveSnapshot,
  RecapChapter,
  RecapStoryboard,
  ReviewStorylineRequest,
  Storyline,
  VerifiedFact,
} from "../../shared/platform.js";
import type { AgentStep, MatchEvent, MatchFixture } from "../../shared/types.js";
import type { LiveMatchView, StorylineDesk } from "../contracts.js";
import { HttpError } from "../validation.js";
import {
  activeEvents,
  buildArchiveIndexes,
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
import { createFoundryAgentRunner, type AgentRunner, type LocalizationDraft, type ProducerDraft } from "./runner.js";

type DeskOptions = {
  archive: ArchiveSnapshot;
  runner?: AgentRunner;
  retrieval?: ArchiveRetrieval;
  now?: () => number;
  maxPerMatch?: number;
  maxConcurrent?: number;
};

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
  private readonly byStorylineId = new Map<string, Storyline>();
  private readonly storylineFixtures = new Map<string, MatchFixture>();
  private readonly queue: PendingJob[] = [];
  private activeJobs = 0;

  constructor(private readonly archive: ArchiveSnapshot, options: Omit<Required<DeskOptions>, "archive"> & { archive?: ArchiveSnapshot }) {
    this.archiveIndexes = buildArchiveIndexes(archive);
    this.runner = options.runner;
    this.retrieval = options.retrieval;
    this.now = options.now;
    this.maxPerMatch = options.maxPerMatch;
    this.maxConcurrent = options.maxConcurrent;
  }

  private matchState(matchId: string): MatchState {
    const current = this.byMatchId.get(matchId);
    if (current) {
      return current;
    }
    const created: MatchState = { storylines: [], facts: [], triggeredEventIds: new Set() };
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
    mutate(storyline);
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
    const createdAt = storyline.createdAt;
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

    let proposals: ClaimProposal[];
    {
      const started = this.now();
      try {
        proposals = await this.runner.research({
          archive: this.archive,
          retrieval: this.retrieval,
          fixture: deepClone(job.view.fixture),
          clockSecond: job.view.clockSecond,
          triggerEvent: deepClone(job.event),
        });
        // The live analyst always contributes the scoreline context, so copy about leads or equalisers
        // can be checked against a verified claim instead of the producer's assumptions.
        if (!proposals.some((proposal) => proposal.kind === "match_state")) {
          proposals = [...proposals, {
            kind: "match_state",
            params: { eventIds: [job.event.id] },
            sources: [{ type: "event", id: job.event.id }],
          }];
        }
        this.updateStoryline(job.storylineId, (current) => {
          current.trace.push(makeTrace("researcher", "complete", `Produced ${proposals.length} claim proposal(s) via ${this.retrieval.describe()}`, started, this.now));
          current.status = "checking";
        });
      } catch (error) {
        this.updateStoryline(job.storylineId, (current) => {
          current.status = "failed";
          current.failureReason = error instanceof Error ? error.message : "Research failed";
          current.trace.push(makeTrace("researcher", "rejected", current.failureReason, started, this.now));
        });
        return;
      }
    }

    let verifiedFacts: VerifiedFact[] = [];
    {
      const started = this.now();
      this.updateStoryline(job.storylineId, (current) => {
        current.claims = [];
      });
      const verifiedClaims: Storyline["claims"] = [];
      const rejectedClaims: Storyline["claims"] = [];
      for (const proposal of proposals) {
        const result = verifyClaimProposal(this.archive, this.archiveIndexes, job.view.fixture, triggerContext, storyline.id, createdAt, proposal);
        if (result.ok) {
          verifiedClaims.push(result.claim);
          verifiedFacts.push(result.fact);
          const match = this.matchState(storyline.matchId);
          match.facts.push(result.fact);
          this.emit({ fact: result.fact });
        } else {
          rejectedClaims.push(result.claim);
        }
      }
      this.updateStoryline(job.storylineId, (current) => {
        current.claims = [...verifiedClaims, ...rejectedClaims];
        current.trace.push(makeTrace("verifier", verifiedClaims.length > 0 ? "complete" : "rejected", `Verified ${verifiedClaims.length}; rejected ${rejectedClaims.length}`, started, this.now));
        current.status = verifiedClaims.length > 0 ? "drafting" : "failed";
        if (verifiedClaims.length === 0) {
          current.failureReason = "No verified claims available";
        }
      });
      if (verifiedClaims.length === 0) {
        return;
      }
    }

    const claimTexts = verifiedFacts.map((fact) => fact.text.en);
    const knownNames = knownNamesForGuard(this.archive, job.view.fixture);

    let draft: ProducerDraft;
    {
      const started = this.now();
      const { draft: producerDraft, guardErrors } = await this.runProducerWithGuard(claimTexts, knownNames);
      if (!producerDraft) {
        this.updateStoryline(job.storylineId, (current) => {
          current.status = "failed";
          current.failureReason = `Producer output failed deterministic guard: ${guardErrors.join("; ")}`;
          current.trace.push(makeTrace("producer", "rejected", current.failureReason, started, this.now));
        });
        return;
      }
      draft = producerDraft;
      this.updateStoryline(job.storylineId, (current) => {
        current.priority = draft.priority;
        current.headline.en = draft.headline;
        current.onAirLine.en = draft.onAirLine;
        current.overlay.en = draft.overlay;
        current.trace.push(makeTrace("producer", "complete", "Drafted storyline copy", started, this.now));
      });
    }

    {
      const started = this.now();
      const initialReview = await this.runner.factCheck({
        claims: claimTexts,
        headline: draft.headline,
        onAirLine: draft.onAirLine,
        overlay: draft.overlay,
      });
      if (initialReview.verdict === "revise") {
        const { draft: revisedDraft, guardErrors: retryGuardErrors } = await this.runProducerWithGuard(claimTexts, knownNames, initialReview.issues);
        if (!revisedDraft) {
          this.updateStoryline(job.storylineId, (current) => {
            current.status = "failed";
            current.failureReason = `Producer retry failed deterministic guard: ${retryGuardErrors.join("; ")}`;
            current.trace.push(makeTrace("fact-checker", "rejected", `${initialReview.issues.join("; ") || "Revision requested"}; producer retry failed`, started, this.now));
          });
          return;
        }
        const secondReview = await this.runner.factCheck({
          claims: claimTexts,
          headline: revisedDraft.headline,
          onAirLine: revisedDraft.onAirLine,
          overlay: revisedDraft.overlay,
        });
        this.updateStoryline(job.storylineId, (current) => {
          current.priority = revisedDraft.priority;
          current.headline.en = revisedDraft.headline;
          current.onAirLine.en = revisedDraft.onAirLine;
          current.overlay.en = revisedDraft.overlay;
        });
        draft = revisedDraft;
        if (secondReview.verdict === "revise") {
          this.updateStoryline(job.storylineId, (current) => {
            current.status = "needs_review";
            current.trace.push(makeTrace("fact-checker", "rejected", secondReview.issues.join("; "), started, this.now));
          });
          return;
        }
        this.updateStoryline(job.storylineId, (current) => {
          current.trace.push(makeTrace("fact-checker", "complete", initialReview.issues.join("; ") || "Draft revised once", started, this.now));
        });
      } else {
        this.updateStoryline(job.storylineId, (current) => {
          current.trace.push(makeTrace("fact-checker", "complete", "Draft supported by verified claims", started, this.now));
        });
      }
    }

    {
      const started = this.now();
      const localized = await this.localizeWithGuard(knownNames, {
        headline: draft.headline,
        onAirLine: draft.onAirLine,
        overlay: draft.overlay,
      });
      this.updateStoryline(job.storylineId, (current) => {
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
    }
  }

  private async runProducerWithGuard(
    claimTexts: string[],
    knownNames: Set<string>,
    feedback?: string[],
  ): Promise<{ draft?: ProducerDraft; guardErrors: string[] }> {
    const guardErrors: string[] = [];
    for (let attempt = 0; attempt < PRODUCER_ATTEMPTS; attempt += 1) {
      const draft = await this.runner.produce({ claims: claimTexts, feedback });
      const guardError = this.guardProducerDraft(draft, claimTexts, knownNames);
      if (!guardError) {
        return { draft, guardErrors };
      }
      guardErrors.push(guardError);
      feedback = [...(feedback ?? []), guardError];
    }
    return { guardErrors };
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

  private async localizeWithGuard(knownNames: Set<string>, english: { headline: string; onAirLine: string; overlay: string }): Promise<LocalizationDraft & { detail: string }> {
    const failures: string[] = [];
    const empty = { headline: "", onAirLine: "", overlay: "" };
    const validated: LocalizationDraft = { es: { ...empty }, fr: { ...empty }, pt: { ...empty } };
    const first = await this.runner.localize(english);
    for (const language of ["es", "fr", "pt"] as const) {
      let selected = first[language];
      let guardError = guardLocalization(english.headline, selected.headline, knownNames)
        ?? guardLocalization(english.onAirLine, selected.onAirLine, knownNames)
        ?? guardLocalization(english.overlay, selected.overlay, knownNames);
      if (!guardError) {
        validated[language] = selected;
        continue;
      }
      const second = await this.runner.localize(english);
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

  onEvent(view: LiveMatchView, event: MatchEvent): void {
    const match = this.matchState(view.matchId);
    if (event.rescinded) {
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

  async review(id: string, request: ReviewStorylineRequest): Promise<Storyline> {
    const storyline = this.byStorylineId.get(id);
    if (!storyline) {
      throw new HttpError(404, "Storyline not found");
    }
    if (storyline.status !== "needs_review") {
      throw new HttpError(409, "Storyline is not awaiting review");
    }
    if (request.decision === "reject") {
      return deepClone(this.updateStoryline(id, (current) => {
        current.status = "rejected";
        current.review = { decision: "rejected", at: iso(this.now), note: request.note };
      }));
    }
    if (request.decision === "approve") {
      return deepClone(this.updateStoryline(id, (current) => {
        current.status = "approved";
        current.review = { decision: "approved", at: iso(this.now), note: request.note };
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
  return new DefaultStorylineDesk(deps.archive, {
    runner: deps.runner ?? createFoundryAgentRunner(),
    retrieval: deps.retrieval ?? createArchiveRetrievalFromEnv(),
    now: deps.now ?? Date.now,
    maxPerMatch: deps.maxPerMatch ?? 12,
    maxConcurrent: deps.maxConcurrent ?? 2,
  });
}

export { createArchiveRetrievalFromEnv, createFoundryAgentRunner };
export type { AgentRunner, ArchiveRetrieval, ArchiveSearchHit };
