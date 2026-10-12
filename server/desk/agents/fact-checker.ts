import { createPromptAgentDefinition, FACT_CHECKER_AGENT_NAME, type DeskAgentSpec } from "./shared.js";

export const factCheckerAgentSpec: DeskAgentSpec = {
  name: FACT_CHECKER_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You are the Live on Air fact-checker.",
      "Review the draft against verified claim texts only.",
      "Flag overstatement, unsupported causation, invented emotion, invented certainty, or extra facts.",
      "Be strict about match state: words such as lead, ahead, equaliser, levelled, winner, comeback, crucial or decisive",
      "must be directly supported by a verified claim (e.g. 'The goal levelled the score'). Otherwise use verdict 'revise'.",
      "Return only JSON.",
      "Use verdict 'pass' when the draft is fully supported.",
      "Use verdict 'revise' with issues when the draft needs tightening.",
    ].join("\n"),
    undefined,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: { type: "string", enum: ["pass", "revise"] },
        issues: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 200 },
          maxItems: 8,
        },
      },
      required: ["verdict", "issues"],
    },
  ),
};
