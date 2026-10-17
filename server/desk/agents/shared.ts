import type { FunctionTool, PromptAgentDefinition } from "@azure/ai-projects";

export const DESK_MODEL_DEPLOYMENT = "matchlens-narrator";
export const RESEARCHER_AGENT_NAME = "matchlens-researcher";
export const PRODUCER_AGENT_NAME = "matchlens-producer";
export const FACT_CHECKER_AGENT_NAME = "matchlens-fact-checker";
export const LOCALIZER_AGENT_NAME = "matchlens-localizer";
export const DIRECTOR_AGENT_NAME = "liveonair-director";
export const TACTICS_ANALYST_AGENT_NAME = "liveonair-tactics-analyst";

export type DeskAgentSpec = {
  name: string;
  definition: PromptAgentDefinition;
};

export function createPromptAgentDefinition(
  instructions: string,
  tools: FunctionTool[] | undefined,
  outputSchema: Record<string, unknown>,
): PromptAgentDefinition {
  return {
    kind: "prompt",
    model: DESK_MODEL_DEPLOYMENT,
    instructions,
    temperature: 0,
    tools,
    text: {
      format: {
        type: "json_schema",
        name: "desk_output",
        schema: outputSchema,
        strict: true,
      },
    },
  };
}
