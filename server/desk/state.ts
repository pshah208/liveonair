import type { StoryCard, MatchEvent } from "../../shared/types.js";
import type { StorylineClaim, StorylineHandoff, VerifiedFact } from "../../shared/platform.js";
import type { ClaimProposal, TriggerContext } from "./claims.js";
import type { FactCheckResult, LocalizationDraft, ProducerDraft } from "./runner.js";

/** Pipeline steps the coordinator can hand off between. `needs_review`, `failed` and `done` are terminal. */
export type DeskStep =
  | "research"
  | "verify"
  | "tactics"
  | "produce"
  | "fact_check"
  | "revise"
  | "localize"
  | "needs_review"
  | "failed"
  | "done";

export const DESK_STEPS: readonly DeskStep[] = [
  "research", "verify", "tactics", "produce", "fact_check", "revise", "localize", "needs_review", "failed", "done",
];

export type DeskAgentKey = "researcher" | "verifier" | "tactics-analyst" | "producer" | "fact-checker" | "localizer" | "director";

/** Agent (or actor) that owns each step, used for handoff log entries and telemetry. */
export const STEP_OWNER: Record<DeskStep, string> = {
  research: "researcher",
  verify: "verifier",
  tactics: "tactics-analyst",
  produce: "producer",
  fact_check: "fact-checker",
  revise: "producer",
  localize: "localizer",
  needs_review: "human-review",
  failed: "desk",
  done: "desk",
};

export type WorkspaceBudget = {
  maxSteps: number;
  stepsTaken: number;
  startedAt: number;
  deadlineAt: number;
};

/**
 * Shared blackboard for one storyline run. Every agent step reads its inputs from here and writes its
 * outputs back, so the coordinator can reason about the whole run from one object.
 */
export interface StorylineWorkspace {
  storylineId: string;
  matchId: string;
  trigger: TriggerContext;
  knownNames: Set<string>;
  /** Last step that ran; the coordinator decides what follows it. */
  step: DeskStep | "start";
  proposals: ClaimProposal[];
  claims: {
    verified: StorylineClaim[];
    rejected: StorylineClaim[];
    facts: VerifiedFact[];
  };
  tactics: {
    done: boolean;
    cards: Array<Pick<StoryCard, "id" | "kind" | "title" | "importance" | "windowStart" | "windowEnd">>;
    proposals: ClaimProposal[];
  };
  drafts: ProducerDraft[];
  currentDraft?: ProducerDraft;
  reviews: FactCheckResult[];
  /** Fact-check issues awaiting a producer revision. */
  pendingIssues?: string[];
  /** When the first fact-check started, so the fact-checker trace spans the revise loop. */
  factCheckStartedAt?: number;
  revisions: number;
  maxRevisions: number;
  localization?: LocalizationDraft & { detail: string };
  englishOnly: boolean;
  attempts: Record<DeskAgentKey, number>;
  budget: WorkspaceBudget;
  handoffs: StorylineHandoff[];
}

export function createWorkspace(input: {
  storylineId: string;
  matchId: string;
  trigger: TriggerContext;
  knownNames: Set<string>;
  now: number;
  maxSteps: number;
  deadlineMs: number;
  maxRevisions?: number;
}): StorylineWorkspace {
  return {
    storylineId: input.storylineId,
    matchId: input.matchId,
    trigger: input.trigger,
    knownNames: input.knownNames,
    step: "start",
    proposals: [],
    claims: { verified: [], rejected: [], facts: [] },
    tactics: { done: false, cards: [], proposals: [] },
    drafts: [],
    reviews: [],
    revisions: 0,
    maxRevisions: input.maxRevisions ?? 1,
    englishOnly: false,
    attempts: {
      researcher: 0,
      verifier: 0,
      "tactics-analyst": 0,
      producer: 0,
      "fact-checker": 0,
      localizer: 0,
      director: 0,
    },
    budget: {
      maxSteps: input.maxSteps,
      stepsTaken: 0,
      startedAt: input.now,
      deadlineAt: input.now + input.deadlineMs,
    },
    handoffs: [],
  };
}

export function verifiedClaimTexts(workspace: StorylineWorkspace): string[] {
  return workspace.claims.facts.map((fact) => fact.text.en);
}

export function lastReview(workspace: StorylineWorkspace): FactCheckResult | undefined {
  return workspace.reviews.at(-1);
}

export function triggerSummary(event: MatchEvent, fixture: TriggerContext["fixture"]) {
  const player = [...fixture.home.players, ...fixture.away.players].find((candidate) => candidate.id === event.playerId);
  return {
    eventId: event.id,
    type: event.type,
    minute: event.minute,
    team: event.teamId === "home" ? fixture.home.name : fixture.away.name,
    player: player?.name,
  };
}

export type WorkspaceSummary = ReturnType<typeof summarizeWorkspace>;

/** Compact, model-friendly view of the blackboard for the director. Contains no draft copy beyond the headline. */
export function summarizeWorkspace(workspace: StorylineWorkspace, now: number) {
  const review = lastReview(workspace);
  return {
    storylineId: workspace.storylineId,
    trigger: triggerSummary(workspace.trigger.event, workspace.trigger.fixture),
    score: workspace.trigger.score,
    lastStep: workspace.step,
    claims: {
      verified: workspace.claims.verified.length,
      rejected: workspace.claims.rejected.length,
      kinds: [...new Set(workspace.claims.verified.map((claim) => claim.kind))],
    },
    tacticsCards: workspace.tactics.cards.map((card) => ({ kind: card.kind, title: card.title, importance: card.importance })),
    tacticsDone: workspace.tactics.done,
    draftHeadline: workspace.currentDraft?.headline,
    lastVerdict: review?.verdict,
    issues: review?.issues ?? [],
    revisions: workspace.revisions,
    maxRevisions: workspace.maxRevisions,
    attempts: workspace.attempts,
    stepsLeft: Math.max(0, workspace.budget.maxSteps - workspace.budget.stepsTaken),
    msLeft: Math.max(0, workspace.budget.deadlineAt - now),
  };
}
