import { classifyError, errorMessage, type ErrorClass } from "./recovery.js";
import { lastReview, summarizeWorkspace, type DeskStep, type StorylineWorkspace, type WorkspaceSummary } from "./state.js";

export type DirectorInput = { workspace: WorkspaceSummary; allowed: DeskStep[] };
export type DirectorProposal = { next: DeskStep; reason: string };

export type CoordinatorCapabilities = {
  /** The runner has a tactics analyst and its circuit is not open. */
  tactics: boolean;
};

export type Decision = {
  step: DeskStep;
  reason: string;
  decidedBy: "director" | "policy";
  outcome: "ok" | "fallback";
  /** Set when the policy overrode or replaced the director. */
  recovery?: "policy_fallback" | "budget";
  errorClass?: ErrorClass;
};

/**
 * Deterministic transition policy:
 * research → verify → [tactics] → produce → fact-check → (revise → fact-check | localize | needs_review) → done.
 * The first entry of each list is the default when no director is available.
 */
export function allowedNext(workspace: StorylineWorkspace, caps: CoordinatorCapabilities): DeskStep[] {
  switch (workspace.step) {
    case "start":
      return ["research"];
    case "research":
      return ["verify"];
    case "verify":
      if (workspace.claims.verified.length === 0) return ["failed"];
      return caps.tactics && !workspace.tactics.done ? ["tactics", "produce"] : ["produce"];
    case "tactics":
      return ["produce"];
    case "produce":
    case "revise":
      return workspace.currentDraft ? ["fact_check"] : ["failed"];
    case "fact_check": {
      const review = lastReview(workspace);
      if (!review) return ["needs_review"];
      if (review.verdict === "pass") return ["localize"];
      return workspace.revisions < workspace.maxRevisions ? ["revise", "needs_review"] : ["needs_review"];
    }
    case "localize":
      return ["done"];
    default:
      return ["done"];
  }
}

export function defaultNext(allowed: DeskStep[]): DeskStep {
  return allowed[0] ?? "done";
}

export function budgetExhausted(workspace: StorylineWorkspace, now: number): string | undefined {
  if (workspace.budget.stepsTaken >= workspace.budget.maxSteps) {
    return `step budget of ${workspace.budget.maxSteps} exhausted`;
  }
  if (now >= workspace.budget.deadlineAt) {
    return "storyline deadline passed";
  }
  return undefined;
}

export function isLegalTransition(workspace: StorylineWorkspace, caps: CoordinatorCapabilities, next: DeskStep): boolean {
  return allowedNext(workspace, caps).includes(next);
}

/**
 * Picks the next handoff. The director agent is consulted only where the policy offers a real choice; any
 * director error or illegal proposal falls back to the deterministic default and is reported as such.
 */
export async function decideNext(
  workspace: StorylineWorkspace,
  deps: {
    now: () => number;
    caps: CoordinatorCapabilities;
    direct?: (input: DirectorInput) => Promise<DirectorProposal>;
  },
): Promise<Decision> {
  const exhausted = budgetExhausted(workspace, deps.now());
  const terminal = workspace.step === "localize" || workspace.step === "start";
  if (exhausted && !terminal) {
    return {
      step: workspace.currentDraft ? "needs_review" : "failed",
      reason: `Coordinator stopped the run: ${exhausted}`,
      decidedBy: "policy",
      outcome: "fallback",
      recovery: "budget",
    };
  }
  const allowed = allowedNext(workspace, deps.caps);
  const fallback = defaultNext(allowed);
  if (allowed.length <= 1) {
    return { step: fallback, reason: "Only legal transition", decidedBy: "policy", outcome: "ok" };
  }
  if (!deps.direct) {
    return { step: fallback, reason: "Deterministic default (no director agent)", decidedBy: "policy", outcome: "ok" };
  }
  let proposal: DirectorProposal;
  try {
    proposal = await deps.direct({ workspace: summarizeWorkspace(workspace, deps.now()), allowed });
  } catch (error) {
    const errorClass = classifyError(error);
    return {
      step: fallback,
      reason: `Director unavailable (${errorClass}: ${errorMessage(error)}); using deterministic default`,
      decidedBy: "policy",
      outcome: "fallback",
      recovery: "policy_fallback",
      errorClass,
    };
  }
  if (!allowed.includes(proposal.next)) {
    return {
      step: fallback,
      reason: `Director proposed illegal transition ${workspace.step} → ${proposal.next}; using deterministic default`,
      decidedBy: "policy",
      outcome: "fallback",
      recovery: "policy_fallback",
      errorClass: "schema_invalid",
    };
  }
  return { step: proposal.next, reason: proposal.reason.slice(0, 300) || "Director choice", decidedBy: "director", outcome: "ok" };
}
