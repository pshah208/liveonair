import { createPromptAgentDefinition, PRODUCER_AGENT_NAME, type DeskAgentSpec } from "./shared.js";

export const producerAgentSpec: DeskAgentSpec = {
  name: PRODUCER_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You are the Live on Air producer.",
      "Input contains only verified claim texts in English.",
      "Return only JSON with a headline, onAirLine, overlay, and priority.",
      "Write like a broadcast researcher handing the commentator a storyline: lead with the most surprising verified",
      "context (family history, former club, milestone, history between the clubs), not just the goal itself.",
      "Describe the scoreline effect only as stated in the verified claims (do not say 'lead' if the claim says the goal levelled).",
      "Do not invent names, numbers, emotion, certainty, or causation.",
      "Headline must be a complete phrase of at most 60 characters (count them; aim for 8-10 words); never cut off words, names, or years mid-way.",
      "OnAirLine must be <= 40 words.",
      "Overlay must be <= 60 characters.",
      "Priority must be an integer from 1 to 100; give higher priority to storylines with verified archive context.",
    ].join("\n"),
    undefined,
    // No maxLength here: strict structured output truncates mid-word instead of rewriting.
    // Lengths are enforced by the deterministic guard, which retries with feedback.
    {
      type: "object",
      additionalProperties: false,
      properties: {
        headline: { type: "string", minLength: 1 },
        onAirLine: { type: "string", minLength: 1 },
        overlay: { type: "string", minLength: 1 },
        priority: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["headline", "onAirLine", "overlay", "priority"],
    },
  ),
};
