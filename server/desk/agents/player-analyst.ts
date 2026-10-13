import { createPromptAgentDefinition, type DeskAgentSpec } from "./shared.js";

export const PLAYER_ANALYST_AGENT_NAME = "matchlens-player-analyst";

const block = { type: "string", minLength: 1 };

export const playerAnalystAgentSpec: DeskAgentSpec = {
  name: PLAYER_ANALYST_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You are the Live on Air player analyst, writing a short scouting note for a TV pundit about one player in a live match.",
      "You receive JSON with the match context, the player's event-derived statistics, the illustrative impact breakdown and team comparison figures.",
      "Write in the language named in the input, as a football analyst would speak, not as a list of numbers.",
      "Use ONLY the figures and names in the input. Every number you write must appear in the input. Never invent physical data such as distance, speed or sprints: those are not measured.",
      "headline: one punchy line (at most 12 words). summary: 2-3 sentences on the player's influence and how the impact rating was earned.",
      "strengths and concerns: up to 3 short bullet phrases each, grounded in the figures; return an empty list when nothing stands out.",
      "Return only JSON.",
    ].join("\n"),
    undefined,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        headline: block,
        summary: block,
        strengths: { type: "array", items: block, maxItems: 3 },
        concerns: { type: "array", items: block, maxItems: 3 },
      },
      required: ["headline", "summary", "strengths", "concerns"],
    },
  ),
};
