import type { FunctionTool } from "@azure/ai-projects";

import { createPromptAgentDefinition, RESEARCHER_AGENT_NAME, type DeskAgentSpec } from "./shared.js";

const claimSourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["event", "archive"] },
    id: { type: "string" },
  },
  required: ["type", "id"],
} satisfies Record<string, unknown>;

function createTool(name: string, description: string, parameters: Record<string, unknown>): FunctionTool {
  return {
    type: "function",
    name,
    description,
    parameters,
    strict: true,
  };
}

export const researcherTools: FunctionTool[] = [
  createTool("get_trigger_context", "Get the live trigger context for the current event.", {
    type: "object",
    additionalProperties: false,
    properties: {},
  }),
  createTool("get_player_profile", "Get the synthetic archive profile for one player.", {
    type: "object",
    additionalProperties: false,
    properties: {
      personId: { type: "string" },
    },
    required: ["personId"],
  }),
  createTool("get_relatives", "Get relatives for a player from the synthetic archive.", {
    type: "object",
    additionalProperties: false,
    properties: {
      personId: { type: "string" },
    },
    required: ["personId"],
  }),
  createTool("get_head_to_head", "Get historic head-to-head counts for two clubs.", {
    type: "object",
    additionalProperties: false,
    properties: {
      clubIdA: { type: "string" },
      clubIdB: { type: "string" },
    },
    required: ["clubIdA", "clubIdB"],
  }),
  createTool("get_club_honours", "Get the honours list for a club.", {
    type: "object",
    additionalProperties: false,
    properties: {
      clubId: { type: "string" },
    },
    required: ["clubId"],
  }),
  createTool("search_archive", "Search the archive knowledge base for supporting passages.", {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["query"],
  }),
];

const idString = { type: "string" } as const;
const intNumber = { type: "integer" } as const;
const sourcesSchema = { type: "array", items: claimSourceSchema } as const;

function proposal(kind: string, params: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: [kind] },
      params: { type: "object", additionalProperties: false, properties: params, required },
      sources: sourcesSchema,
    },
    required: ["kind", "params", "sources"],
  };
}

/** Strict structured-output schema: each claim kind has its own typed params, so the model cannot guess shapes. */
export const researcherResponseSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    claims: {
      type: "array",
      items: {
        anyOf: [
          proposal("live_event", { eventId: idString }, ["eventId"]),
          proposal("match_state", { eventIds: { type: "array", items: idString } }, ["eventIds"]),
          proposal("family_link", {
            personId: idString,
            relativeId: idString,
            relation: { type: "string", enum: ["parent", "child", "sibling"] },
            matchId: idString,
            opponentClubId: { type: ["string", "null"] },
          }, ["personId", "relativeId", "relation", "matchId", "opponentClubId"]),
          proposal("former_club", {
            personId: idString, clubId: idString, fromYear: intNumber, toYear: intNumber, goals: intNumber,
          }, ["personId", "clubId", "fromYear", "toYear", "goals"]),
          proposal("career_goals", { personId: idString, total: intNumber }, ["personId", "total"]),
          proposal("head_to_head", {
            clubAId: idString, clubBId: idString, clubAWins: intNumber, clubBWins: intNumber, draws: intNumber,
          }, ["clubAId", "clubBId", "clubAWins", "clubBWins", "draws"]),
          proposal("historic_final", { matchId: idString }, ["matchId"]),
          proposal("club_honour", { clubId: idString, honourId: idString }, ["clubId", "honourId"]),
          proposal("live_metric", {
            eventId: idString, metric: { type: "string", enum: ["pass_distance", "pass_difficulty", "shot_speed"] },
          }, ["eventId", "metric"]),
        ],
      },
    },
  },
  required: ["claims"],
};

export const researcherAgentSpec: DeskAgentSpec = {
  name: RESEARCHER_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You are the Live on Air storyline researcher for a synthetic football broadcast product.",
      "Return only JSON matching the response schema.",
      "Always call get_trigger_context first. It includes playerArchive (career spells, careerGoals, relatives with",
      "relativeRole and historicGoals). Call get_head_to_head for the two clubs. Use search_archive only to discover extra record IDs.",
      "If playerArchive.relatives contains any historicGoals, you MUST include a family_link claim for the most relevant one",
      "(prefer finals and goals involving today's clubs).",
      "Never write prose claims. Propose grounded claim objects only, copying IDs and numbers exactly from tool results.",
      "Return 1 to 5 claim proposals relevant to the trigger, most broadcast-worthy first.",
      "Every proposal must include at least one source. Event sources use the live event id from get_trigger_context",
      "(triggerEvent.id), never the match or fixture id. Archive sources use exact archive record ids (people, clubs, matches, honours).",
      "For a goal trigger, include the live_event claim for that goal.",
      "Use family_link when the trigger player has a relative who scored in an archive match: relation = relativeRole from",
      "get_relatives (the relative's role, e.g. 'parent' when the relative is the player's parent), matchId = the historicGoals",
      "matchId, opponentClubId = that goal's opponentClubId when it is one of today's clubs, else null.",
      "Use former_club only when the trigger player previously played for one of today's two clubs (copy fromYear, toYear, goals).",
      "If you propose career_goals, total = the profile careerGoals plus the player's live goals in this match.",
      "Use live_metric (metric = shot_speed for a shot, pass_distance or pass_difficulty for a pass) when a computed ball metric",
      "is broadcast-worthy; the verifier computes the number, so never invent speeds or distances.",
    ].join("\n"),
    researcherTools,
    researcherResponseSchema,
  ),
};
