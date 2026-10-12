import { AIProjectClient, type FunctionTool } from "@azure/ai-projects";
import type OpenAI from "openai";
import { z } from "zod";

import type { ArchiveSnapshot } from "../../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../../shared/types.js";
import { getAzureCredential } from "../azure/credential.js";
import {
  DESK_AGENT_SPECS,
  FACT_CHECKER_AGENT_NAME,
  LOCALIZER_AGENT_NAME,
  PRODUCER_AGENT_NAME,
  RESEARCHER_AGENT_NAME,
} from "./agents/index.js";
import {
  activeEvents,
  claimProposalArraySchema,
  getPlayerProfile,
  scoreFromEvents,
  type ArchiveRetrieval,
} from "./claims.js";
import { researcherResponseSchema } from "./agents/researcher.js";

const producerDraftSchema = z.object({
  headline: z.string().trim().min(1).max(400),
  onAirLine: z.string().trim().min(1).max(1000),
  overlay: z.string().trim().min(1).max(400),
  priority: z.number().int().min(1).max(100),
}).strict();

const factCheckSchema = z.object({
  verdict: z.enum(["pass", "revise"]),
  issues: z.array(z.string().trim().min(1).max(200)).max(8),
}).strict();

const localizationSchema = z.object({
  es: z.object({
    headline: z.string().trim().min(1),
    onAirLine: z.string().trim().min(1),
    overlay: z.string().trim().min(1),
  }).strict(),
  fr: z.object({
    headline: z.string().trim().min(1),
    onAirLine: z.string().trim().min(1),
    overlay: z.string().trim().min(1),
  }).strict(),
  pt: z.object({
    headline: z.string().trim().min(1),
    onAirLine: z.string().trim().min(1),
    overlay: z.string().trim().min(1),
  }).strict(),
}).strict();

export type ProducerDraft = z.infer<typeof producerDraftSchema>;
export type FactCheckResult = z.infer<typeof factCheckSchema>;
export type LocalizationDraft = z.infer<typeof localizationSchema>;

export type ResearchToolContext = {
  archive: ArchiveSnapshot;
  retrieval: ArchiveRetrieval;
  fixture: MatchFixture;
  clockSecond: number;
  triggerEvent: MatchEvent;
};

export interface AgentRunner {
  configured(): boolean;
  health(): { mode: "foundry-agents" | "unconfigured"; agents: string[] };
  research(context: ResearchToolContext): Promise<z.infer<typeof claimProposalArraySchema>>;
  produce(input: { claims: string[]; feedback?: string[] }): Promise<ProducerDraft>;
  factCheck(input: { claims: string[]; headline: string; onAirLine: string; overlay: string }): Promise<FactCheckResult>;
  localize(input: { headline: string; onAirLine: string; overlay: string }): Promise<LocalizationDraft>;
}

type FoundryRunnerOptions = {
  endpoint?: string;
  credential?: ReturnType<typeof getAzureCredential>;
  maxToolIterations?: number;
  deadlineMs?: number;
};

function parseOutputText(response: { output?: Array<Record<string, unknown>> }): string {
  // Agents can emit interim messages alongside tool calls; the structured result is the final message.
  let last = "";
  for (const item of response.output ?? []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const text = (item.content as Array<Record<string, unknown>>)
        .filter((content) => content.type === "output_text" && typeof content.text === "string")
        .map((content) => content.text as string)
        .join("")
        .trim();
      if (text) {
        last = text;
      }
    }
  }
  return last;
}

function parseFunctionCalls(response: { output?: Array<Record<string, unknown>> }): Array<{ callId: string; name: string; argumentsText: string }> {
  const calls: Array<{ callId: string; name: string; argumentsText: string }> = [];
  for (const item of response.output ?? []) {
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      calls.push({
        callId: item.call_id,
        name: item.name,
        argumentsText: typeof item.arguments === "string" ? item.arguments : "{}",
      });
    }
  }
  return calls;
}

function createJsonSchema(name: string, schema: Record<string, unknown>) {
  return { type: "json_schema" as const, name, schema, strict: true };
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown tool error";
}

function personRelatives(archive: ArchiveSnapshot, personId: string) {
  const person = archive.people.find((candidate) => candidate.id === personId);
  if (!person) {
    throw new Error("Unknown person");
  }
  return person.relations.map((relation) => {
    const relative = archive.people.find((candidate) => candidate.id === relation.personId);
    if (!relative) {
      return undefined;
    }
    // Expose the relative's scoring record so the researcher can cite exact archive match IDs.
    const historicGoals = archive.matches.flatMap((match) => match.goals
      .filter((goal) => goal.personId === relative.id)
      .map((goal) => ({
        matchId: match.id,
        season: match.season,
        competition: match.competition,
        stage: match.stage,
        scoredForClubId: goal.clubId,
        opponentClubId: goal.clubId === match.homeClubId ? match.awayClubId : match.homeClubId,
        minute: goal.minute,
      })));
    return { relativeRole: relation.kind, person: relative, historicGoals };
  }).filter(Boolean);
}

function headToHead(archive: ArchiveSnapshot, clubAId: string, clubBId: string) {
  let matches = 0;
  let clubAWins = 0;
  let clubBWins = 0;
  let draws = 0;
  for (const match of archive.matches) {
    const involvesA = match.homeClubId === clubAId || match.awayClubId === clubAId;
    const involvesB = match.homeClubId === clubBId || match.awayClubId === clubBId;
    if (!involvesA || !involvesB) {
      continue;
    }
    matches += 1;
    const aScore = match.homeClubId === clubAId ? match.homeScore : match.awayScore;
    const bScore = match.homeClubId === clubBId ? match.homeScore : match.awayScore;
    if (aScore > bScore) {
      clubAWins += 1;
    } else if (bScore > aScore) {
      clubBWins += 1;
    } else {
      draws += 1;
    }
  }
  return { matches, clubAWins, clubBWins, draws };
}

function clubHonours(archive: ArchiveSnapshot, clubId: string) {
  const club = archive.clubs.find((candidate) => candidate.id === clubId);
  if (!club) {
    throw new Error("Unknown club");
  }
  return club.honours;
}

function careerGoals(archive: ArchiveSnapshot, personId: string): number {
  let total = 0;
  for (const match of archive.matches) {
    for (const goal of match.goals) {
      if (goal.personId === personId) {
        total += 1;
      }
    }
  }
  return total;
}

const RATE_LIMIT_ATTEMPTS = 4;

function retryAfterMs(error: unknown, attempt: number): number {
  const headers = (error as { headers?: Headers | Record<string, string> } | undefined)?.headers;
  const read = (name: string): string | null | undefined =>
    headers instanceof Headers ? headers.get(name) : (headers as Record<string, string> | undefined)?.[name];
  const ms = Number(read("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(read("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
  return 2_000 * 2 ** attempt;
}

/** Retries 429s within the job deadline so bursts of goals don't fail storylines outright. */
export async function createWithRateLimitRetry(
  createResponse: (body: unknown, options?: unknown) => Promise<Record<string, unknown>>,
  body: unknown,
  deadlineMs: number,
  startedAt: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadlineMs - (Date.now() - startedAt);
    try {
      return await createResponse(body, { timeout: Math.max(1_000, remaining), maxRetries: 0 });
    } catch (error) {
      const status = (error as { status?: number } | undefined)?.status;
      const wait = retryAfterMs(error, attempt);
      if (status !== 429 || attempt + 1 >= RATE_LIMIT_ATTEMPTS || wait + 1_000 >= deadlineMs - (Date.now() - startedAt)) {
        throw error;
      }
      await sleep(wait);
    }
  }
}

async function invokeAgentJson<T>(
  client: OpenAI,
  agentName: string,
  schemaName: string,
  schema: Record<string, unknown>,
  input: string,
  tools: FunctionTool[] | undefined,
  toolExecutor: ((call: { name: string; argumentsText: string }) => Promise<string>) | undefined,
  maxToolIterations: number,
  deadlineMs: number,
): Promise<T> {
  let previousResponseId: string | undefined;
  let currentInput: unknown = input;
  const createResponse = client.responses.create as unknown as (body: unknown, options?: unknown) => Promise<Record<string, unknown>>;
  const startedAt = Date.now();
  for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) {
      throw new Error(`Timed out invoking ${agentName}`);
    }
    const body: Record<string, unknown> = {
      input: currentInput,
      previous_response_id: previousResponseId,
      agent_reference: { name: agentName, type: "agent_reference" },
    };
    const response = await createWithRateLimitRetry(createResponse, body, deadlineMs, startedAt);
    previousResponseId = typeof response.id === "string" ? response.id : previousResponseId;
    const functionCalls = parseFunctionCalls(response);
    if (functionCalls.length === 0) {
      const raw = parseOutputText(response);
      return JSON.parse(raw) as T;
    }
    if (!toolExecutor) {
      throw new Error(`Agent ${agentName} requested tools unexpectedly`);
    }
    if (iteration === maxToolIterations) {
      throw new Error(`Agent ${agentName} exceeded tool-call budget`);
    }
    const outputs: Array<Record<string, unknown>> = [];
    for (const call of functionCalls) {
      let output: string;
      try {
        output = await toolExecutor(call);
      } catch (error) {
        output = JSON.stringify({ error: serializeError(error) });
      }
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output,
      });
    }
    currentInput = outputs;
  }
  throw new Error(`Agent ${agentName} did not complete`);
}

function runnerAgents(): string[] {
  return DESK_AGENT_SPECS.map((spec) => spec.name);
}

class UnconfiguredAgentRunner implements AgentRunner {
  configured() {
    return false;
  }

  health() {
    return {
      mode: "unconfigured" as const,
      agents: runnerAgents(),
    };
  }

  async research(): Promise<z.infer<typeof claimProposalArraySchema>> {
    throw new Error("Storyline agents are not configured");
  }

  async produce(): Promise<ProducerDraft> {
    throw new Error("Storyline agents are not configured");
  }

  async factCheck(): Promise<FactCheckResult> {
    throw new Error("Storyline agents are not configured");
  }

  async localize(): Promise<LocalizationDraft> {
    throw new Error("Storyline agents are not configured");
  }
}

class FoundryAgentRunner implements AgentRunner {
  private readonly openai: OpenAI;
  private readonly maxToolIterations: number;
  private readonly deadlineMs: number;

  constructor(
    project: AIProjectClient,
    options: Required<Pick<FoundryRunnerOptions, "maxToolIterations" | "deadlineMs">>,
  ) {
    this.openai = project.getOpenAIClient();
    this.maxToolIterations = options.maxToolIterations;
    this.deadlineMs = options.deadlineMs;
  }

  configured() {
    return true;
  }

  health() {
    return {
      mode: "foundry-agents" as const,
      agents: runnerAgents(),
    };
  }

  async research(context: ResearchToolContext) {
    const toolExecutor = async (call: { name: string; argumentsText: string }) => {
      const args = call.argumentsText ? JSON.parse(call.argumentsText) as Record<string, unknown> : {};
      switch (call.name) {
        case "get_trigger_context": {
          const score = scoreFromEvents(activeEvents(context.fixture, context.clockSecond));
          const triggerPlayer = [...context.fixture.home.players, ...context.fixture.away.players].find((player) => player.id === context.triggerEvent.playerId);
          const profile = triggerPlayer?.archiveId ? getPlayerProfile(context.archive, triggerPlayer.archiveId) : undefined;
          return JSON.stringify({
            triggerEvent: context.triggerEvent,
            player: triggerPlayer ? {
              id: triggerPlayer.id,
              archiveId: triggerPlayer.archiveId,
              name: triggerPlayer.name,
            } : undefined,
            // Pre-fetched dossier so the researcher sees every storyline hook immediately.
            playerArchive: profile ? {
              careerGoals: profile.careerGoals,
              currentClubId: profile.person.currentClubId,
              career: profile.person.career,
              relatives: personRelatives(context.archive, profile.person.id),
            } : null,
            homeClub: { id: context.fixture.home.id, archiveClubId: context.fixture.home.archiveClubId, name: context.fixture.home.name },
            awayClub: { id: context.fixture.away.id, archiveClubId: context.fixture.away.archiveClubId, name: context.fixture.away.name },
            score,
            minute: context.triggerEvent.minute,
          });
        }
        case "get_player_profile": {
          return JSON.stringify(getPlayerProfile(context.archive, String(args.personId)) ?? null);
        }
        case "get_relatives": {
          return JSON.stringify(personRelatives(context.archive, String(args.personId)));
        }
        case "get_head_to_head": {
          return JSON.stringify(headToHead(context.archive, String(args.clubIdA), String(args.clubIdB)));
        }
        case "get_club_honours": {
          return JSON.stringify(clubHonours(context.archive, String(args.clubId)));
        }
        case "search_archive": {
          return JSON.stringify({
            mode: context.retrieval.mode,
            results: await context.retrieval.search(String(args.query)),
          });
        }
        default:
          throw new Error(`Unknown tool call: ${call.name}`);
      }
    };

    const raw = await invokeAgentJson<{ claims: Array<{ kind: string; params: Record<string, unknown>; sources: unknown[] }> }>(
      this.openai,
      RESEARCHER_AGENT_NAME,
      "research_claims",
      researcherResponseSchema,
      JSON.stringify({
        trigger: context.triggerEvent,
        fixture: {
          matchId: context.fixture.id,
          home: context.fixture.home.name,
          away: context.fixture.away.name,
        },
      }),
      DESK_AGENT_SPECS.find((spec) => spec.name === RESEARCHER_AGENT_NAME)?.definition.tools as FunctionTool[] | undefined,
      toolExecutor,
      this.maxToolIterations,
      this.deadlineMs,
    );
    return claimProposalArraySchema.parse(raw.claims.map((claim) => ({
      kind: claim.kind,
      // Strict structured output represents optional fields as null; the verifier schema expects them absent.
      params: Object.fromEntries(Object.entries(claim.params).filter(([, value]) => value !== null)),
      sources: claim.sources,
    })));
  }

  async produce(input: { claims: string[]; feedback?: string[] }) {
    const raw = await invokeAgentJson<ProducerDraft>(
      this.openai,
      PRODUCER_AGENT_NAME,
      "producer_draft",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string" },
          onAirLine: { type: "string" },
          overlay: { type: "string" },
          priority: { type: "integer" },
        },
        required: ["headline", "onAirLine", "overlay", "priority"],
      },
      JSON.stringify(input),
      undefined,
      undefined,
      this.maxToolIterations,
      this.deadlineMs,
    );
    return producerDraftSchema.parse(raw);
  }

  async factCheck(input: { claims: string[]; headline: string; onAirLine: string; overlay: string }) {
    const raw = await invokeAgentJson<FactCheckResult>(
      this.openai,
      FACT_CHECKER_AGENT_NAME,
      "fact_checker_review",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          verdict: { type: "string", enum: ["pass", "revise"] },
          issues: { type: "array", items: { type: "string" } },
        },
        required: ["verdict", "issues"],
      },
      JSON.stringify(input),
      undefined,
      undefined,
      this.maxToolIterations,
      this.deadlineMs,
    );
    return factCheckSchema.parse(raw);
  }

  async localize(input: { headline: string; onAirLine: string; overlay: string }) {
    const raw = await invokeAgentJson<LocalizationDraft>(
      this.openai,
      LOCALIZER_AGENT_NAME,
      "localized_storyline",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          es: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              onAirLine: { type: "string" },
              overlay: { type: "string" },
            },
            required: ["headline", "onAirLine", "overlay"],
          },
          fr: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              onAirLine: { type: "string" },
              overlay: { type: "string" },
            },
            required: ["headline", "onAirLine", "overlay"],
          },
          pt: {
            type: "object",
            additionalProperties: false,
            properties: {
              headline: { type: "string" },
              onAirLine: { type: "string" },
              overlay: { type: "string" },
            },
            required: ["headline", "onAirLine", "overlay"],
          },
        },
        required: ["es", "fr", "pt"],      },
      JSON.stringify(input),
      undefined,
      undefined,
      this.maxToolIterations,
      this.deadlineMs,
    );
    return localizationSchema.parse(raw);
  }
}

export function createFoundryAgentRunner(options: FoundryRunnerOptions = {}): AgentRunner {
  const endpoint = options.endpoint ?? process.env.PROJECT_ENDPOINT;
  if (!endpoint) {
    return new UnconfiguredAgentRunner();
  }

  const project = new AIProjectClient(endpoint, options.credential ?? getAzureCredential());
  return new FoundryAgentRunner(project, {
    maxToolIterations: options.maxToolIterations ?? 6,
    deadlineMs: options.deadlineMs ?? 45_000,
  });
}

export function createUnconfiguredAgentRunner(): AgentRunner {
  return new UnconfiguredAgentRunner();
}
