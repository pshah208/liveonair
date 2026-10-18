import type { PromptAgentDefinition } from "@azure/ai-projects";

import { DESK_MODEL_DEPLOYMENT, type DeskAgentSpec } from "../desk/agents/shared.js";

export const NEWS_SCOUT_AGENT_NAME = "liveonair-news-scout";

/**
 * Optional Foundry agent. The in-process Responses path in web.ts does not require this
 * agent to be provisioned. filters.allowed_domains is omitted: gpt-4.1-mini returns HTTP 400 for it.
 */
export const newsScoutAgentSpec: DeskAgentSpec = {
  name: NEWS_SCOUT_AGENT_NAME,
  definition: {
    kind: "prompt",
    model: DESK_MODEL_DEPLOYMENT,
    temperature: 0.2,
    instructions: [
      "You scout real-world football precedent for a synthetic broadcast.",
      "Search only for the public situation you are given: comebacks, red cards, late winners, set pieces.",
      "Never attribute real news to fictional clubs, players or coaches.",
      "Never invent a statistic. If the cited page does not state it, leave it out.",
      "Do not request or repeat personal, youth, biometric or private data.",
      "Domain filtering is applied after you reply. Do not rely on allowed_domains.",
    ].join(" "),
    tools: [{
      type: "web_search",
      search_context_size: "low",
      user_location: { type: "approximate", country: "GB" },
    }],
  } satisfies PromptAgentDefinition,
};
