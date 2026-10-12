import { createPromptAgentDefinition, LOCALIZER_AGENT_NAME, type DeskAgentSpec } from "./shared.js";

export const localizerAgentSpec: DeskAgentSpec = {
  name: LOCALIZER_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You localize Live on Air producer copy from English to Spanish and French.",
      "Preserve every proper name and every number exactly.",
      "Do not add or remove facts.",
      "Return only JSON.",
    ].join("\n"),
    undefined,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        es: {
          type: "object",
          additionalProperties: false,
          properties: {
            headline: { type: "string", minLength: 1 },
            onAirLine: { type: "string", minLength: 1 },
            overlay: { type: "string", minLength: 1 },
          },
          required: ["headline", "onAirLine", "overlay"],
        },
        fr: {
          type: "object",
          additionalProperties: false,
          properties: {
            headline: { type: "string", minLength: 1 },
            onAirLine: { type: "string", minLength: 1 },
            overlay: { type: "string", minLength: 1 },
          },
          required: ["headline", "onAirLine", "overlay"],
        },
      },
      required: ["es", "fr"],
    },
  ),
};
