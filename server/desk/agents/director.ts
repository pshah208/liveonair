import { createPromptAgentDefinition, DIRECTOR_AGENT_NAME, type DeskAgentSpec } from "./shared.js";

/** Steps the director may choose between; the deterministic policy narrows these per decision. */
export const DIRECTOR_CHOICES = ["tactics", "produce", "fact_check", "revise", "localize", "needs_review", "failed", "done"] as const;

export const directorResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    next: { type: "string", enum: [...DIRECTOR_CHOICES] },
    reason: { type: "string", minLength: 1, maxLength: 300 },
  },
  required: ["next", "reason"],
} as const;

export const directorAgentSpec: DeskAgentSpec = {
  name: DIRECTOR_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You are the Live on Air storyline director coordinating a newsroom of specialist agents.",
      "Input is a compact workspace summary for one storyline plus the list of allowed next steps.",
      "Choose exactly one step from `allowed` and give a one-sentence reason a producer would understand.",
      "Guidance:",
      "- After verification, choose 'tactics' when the summary lists tactical cards (pressure, rhythm, turning point,",
      "  set piece, player) that would give a tactics-led angle; choose 'produce' when the verified archive claims",
      "  (family, former club, milestone, head-to-head) already make a strong archive-led storyline.",
      "- After a fact-check asks for revision, choose 'revise' when the issues are wording problems a rewrite can fix;",
      "  choose 'needs_review' when the issues need human judgement or the time budget (msLeft) is small.",
      "Never invent steps outside `allowed`. Human approval is always required before anything goes on air.",
      "Return only JSON.",
    ].join("\n"),
    undefined,
    directorResponseSchema as unknown as Record<string, unknown>,
  ),
};
