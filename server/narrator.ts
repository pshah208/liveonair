import { createHash } from "node:crypto";

import { AzureCliCredential, ManagedIdentityCredential, getBearerTokenProvider } from "@azure/identity";
import { AzureOpenAI } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";

import type {
  AgentStep,
  AppHealth,
  Language,
  MatchEvent,
  MatchFixture,
  MatchSnapshot,
  NarrativeClaim,
  NarrativeRequest,
  NarrativeResponse,
  StoryCard,
  TeamId,
} from "../shared/types.js";
import { HttpError } from "./validation.js";

type ModelUsage = { inputTokens: number; outputTokens: number };

type ChatMessage = Record<string, unknown>;
type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments?: string;
  };
};

type CompletionResult = {
  text: string;
  usage: ModelUsage;
  toolCalls: ToolCall[];
  assistantMessage: ChatMessage;
};

type CompletionClient = {
  createChatCompletion(args: {
    messages: ChatMessage[];
    tools?: unknown[];
    temperature?: number;
    maxTokens?: number;
    timeoutMs: number;
    requestId: string;
    responseSchema?: { name: string; schema: Record<string, unknown> };
  }): Promise<CompletionResult>;
};

type NarrationContext = {
  requestId: string;
  fixture?: MatchFixture;
};

export interface Narrator {
  health(): AppHealth["ai"];
  narrate(request: NarrativeRequest, snapshot: MatchSnapshot, context: NarrationContext): Promise<NarrativeResponse>;
}

type LedgerFact = {
  id: string;
  kind: "score" | "story" | "event" | "recap";
  headline: Record<Language, string>;
  text: Record<Language, string>;
  evidenceIds: string[];
  windowStart: number;
  windowEnd: number;
  teamId?: TeamId;
  playerId?: string;
  eventTypes?: string[];
  storyKind?: StoryCard["kind"];
};

type EvidenceLedger = {
  scoreFactId: string;
  recapFactId?: string;
  factOrder: string[];
  facts: Record<string, LedgerFact>;
  eventIndex: Record<string, MatchEvent>;
  storyFacts: Record<string, string>;
};

const boundedIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u);
const titleModeValues = ["scoreline", "turning_point", "player_focus", "momentum"] as const;
const emphasisValues = ["measured", "urgent", "calm"] as const;
const analystPlanSchema = z.object({
  selectedFactIds: z.array(boundedIdSchema).min(1).max(5),
  focusStoryId: boundedIdSchema.nullable().optional().transform((value) => value ?? undefined),
  rationale: z.string().trim().min(1).max(400),
}).strict();
const producerPlanSchema = z.object({
  titleMode: z.enum(titleModeValues),
  orderedFactIds: z.array(boundedIdSchema).min(1).max(5),
  emphasis: z.enum(emphasisValues),
}).strict();
const getMatchStateArgsSchema = z.object({}).strict();
const getStoryEvidenceArgsSchema = z.object({
  storyId: boundedIdSchema.optional(),
}).strict();
const queryEventsArgsSchema = z.object({
  types: z.array(z.enum(["goal", "yellow_card", "red_card"])).max(10).optional(),
  teamId: z.enum(["home", "away"]).optional(),
  playerId: boundedIdSchema.optional(),
  limit: z.int().min(1).max(10).optional(),
}).strict();

type AnalystPlan = z.infer<typeof analystPlanSchema>;
type ProducerPlan = z.infer<typeof producerPlanSchema>;

type ClaimDraft = {
  text: string;
  evidenceIds: string[];
};

type NarrativeDraft = {
  title: string;
  script: string;
  claims: ClaimDraft[];
};

type NarratorOptions = {
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  apiKey?: string;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  maxRequestsPerHour?: number;
  maxConcurrent?: number;
  completionClient?: CompletionClient;
  now?: () => number;
};

type CacheEntry = {
  expiresAt: number;
  response: NarrativeResponse;
};

type BudgetLease = {
  release(): void;
};

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX = 128;
const DEFAULT_HOURLY_LIMIT = 60;
const DEFAULT_CONCURRENT = 2;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_FACTS = 5;
const MODEL_LABEL = "GPT4.1mini2025-04-14";

function toSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function createUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(target: ModelUsage, next: ModelUsage): void {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
}

function inferAuthentication(endpoint?: string, apiKey?: string): AppHealth["ai"]["authentication"] {
  if (!endpoint) {
    return "unconfigured";
  }
  return apiKey ? "api_key" : "managed_identity_or_cli";
}

function parseJsonWithSchema<T>(value: string, label: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(503, `AI returned invalid ${label} JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw createSanitizedHttpError(503, `AI returned invalid ${label} shape`, {
      retryable: false,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  return result.data;
}

function localize(
  kind:
    | "also"
    | "focus"
    | "home_side"
    | "away_side"
    | "intro_story"
    | "intro_recap"
    | "key_moments"
    | "momentum"
    | "player"
    | "turning",
  language: Language,
): string {
  const phrases: Record<Language, Record<typeof kind, string>> = {
    en: {
      also: "Also",
      focus: "Story focus:",
      home_side: "home side",
      away_side: "away side",
      intro_story: "Here is the clearest live story so far.",
      intro_recap: "Here is the match recap so far.",
      key_moments: "Key moments:",
      momentum: "Momentum is tilting around",
      player: "The player focus is",
      turning: "The turning point is",
    },
    es: {
      also: "Además",
      focus: "Historia clave:",
      home_side: "equipo local",
      away_side: "equipo visitante",
      intro_story: "Esta es la historia más clara del partido hasta ahora.",
      intro_recap: "Este es el resumen del partido hasta ahora.",
      key_moments: "Momentos clave:",
      momentum: "La dinámica gira alrededor de",
      player: "El foco del jugador está en",
      turning: "El punto de inflexión es",
    },
    fr: {
      also: "Aussi",
      focus: "Point clé :",
      home_side: "équipe à domicile",
      away_side: "équipe à l'extérieur",
      intro_story: "Voici le récit le plus clair du match pour l'instant.",
      intro_recap: "Voici le récapitulatif du match pour l'instant.",
      key_moments: "Temps forts :",
      momentum: "La dynamique tourne autour de",
      player: "Le joueur mis en avant est",
      turning: "Le moment charnière est",
    },
  };

  return phrases[language][kind];
}

function localizedRecord(language: Language, text: string): Record<Language, string> {
  return {
    en: language === "en" ? text : text,
    es: language === "es" ? text : text,
    fr: language === "fr" ? text : text,
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

const functionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    parameters: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict() satisfies z.ZodType<ChatCompletionFunctionTool>;

const assistantToolCallSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().min(1).max(80),
    arguments: z.string().max(8_000).optional(),
  }).strict(),
}).strict();

const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().optional(),
  tool_calls: z.array(assistantToolCallSchema).max(10).optional(),
}).strict();

const toolMessageSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string().min(1).max(120),
  content: z.string().max(8_000),
}).strict();

function createLruCache(maxEntries: number, ttlMs: number, now: () => number) {
  const entries = new Map<string, CacheEntry>();

  return {
    get(key: string): NarrativeResponse | undefined {
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry.response);
    },
    set(key: string, response: NarrativeResponse): void {
      if (entries.has(key)) {
        entries.delete(key);
      }
      entries.set(key, {
        expiresAt: now() + ttlMs,
        response: structuredClone(response),
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) {
          break;
        }
        entries.delete(oldest);
      }
    },
  };
}

function createBudget(maxRequestsPerHour: number, maxConcurrent: number, now: () => number) {
  const issuedAt: number[] = [];
  let inFlight = 0;

  return {
    acquire(): BudgetLease {
      const cutoff = now() - 60 * 60 * 1000;
      while (issuedAt.length > 0 && issuedAt[0] < cutoff) {
        issuedAt.shift();
      }

      if (issuedAt.length >= maxRequestsPerHour) {
        throw new HttpError(429, "AI hourly request quota reached");
      }
      if (inFlight >= maxConcurrent) {
        throw new HttpError(429, "AI concurrency limit reached");
      }

      issuedAt.push(now());
      inFlight += 1;

      let released = false;
      return {
        release() {
          if (released) {
            return;
          }
          released = true;
          inFlight = Math.max(0, inFlight - 1);
        },
      };
    },
  };
}

function renderScoreText(snapshot: MatchSnapshot, language: Language, fixture?: MatchFixture): string {
  const score = `${snapshot.score.home}-${snapshot.score.away}`;
  const clock = `${Math.floor(snapshot.atSecond / 60)}:${String(snapshot.atSecond % 60).padStart(2, "0")}`;
  const namedScore = fixture ? `${fixture.home.name} ${score} ${fixture.away.name}` : score;
  const fullTime = snapshot.atSecond === (fixture?.durationSeconds ?? 5400);
  if (language === "es") {
    return `${fullTime ? "Marcador final" : `Marcador a ${clock}`}: ${namedScore}.`;
  }
  if (language === "fr") {
    return `${fullTime ? "Score final" : `Score à ${clock}`} : ${namedScore}.`;
  }
  return `${fullTime ? "Full time" : `Score at ${clock}`}: ${namedScore}.`;
}

function resolveTeamName(language: Language, fixture: MatchFixture | undefined, teamId: TeamId): string {
  if (fixture) {
    return teamId === "home" ? fixture.home.name : fixture.away.name;
  }
  return localize(teamId === "home" ? "home_side" : "away_side", language);
}

function resolvePlayerName(fixture: MatchFixture | undefined, playerId: string): string {
  if (!fixture) {
    return playerId;
  }
  const players = [...fixture.home.players, ...fixture.away.players];
  return players.find((player) => player.id === playerId)?.name ?? playerId;
}

function buildStoryFact(snapshot: MatchSnapshot, story: StoryCard): LedgerFact {
  const text = `${story.summary.trim()} ${story.whyItMatters.trim()}`.trim();
  return {
    id: `story:${story.id}`,
    kind: "story",
    headline: {
      en: story.title,
      es: story.title,
      fr: story.title,
    },
    text: localizedRecord(snapshot.language, text),
    evidenceIds: uniqueIds(story.evidenceIds),
    windowStart: story.windowStart,
    windowEnd: story.windowEnd,
    teamId: story.teamId,
    storyKind: story.kind,
  };
}

function buildEventText(event: MatchEvent, fixture: MatchFixture | undefined): LedgerFact | undefined {
  const minuteLabel = `${event.minute}:${String(event.second).padStart(2, "0")}`;
  const playerName = resolvePlayerName(fixture, event.playerId);

  if (event.type === "goal") {
    return {
      id: `event:${event.id}`,
      kind: "event",
      headline: {
        en: `Goal: ${playerName}`,
        es: `Gol: ${playerName}`,
        fr: `But : ${playerName}`,
      },
      text: {
        en: `${playerName} scored for ${resolveTeamName("en", fixture, event.teamId)} at ${minuteLabel}.`,
        es: `${playerName} marcó para ${resolveTeamName("es", fixture, event.teamId)} en ${minuteLabel}.`,
        fr: `${playerName} a marqué pour ${resolveTeamName("fr", fixture, event.teamId)} à ${minuteLabel}.`,
      },
      evidenceIds: [event.id],
      windowStart: toSecond(event),
      windowEnd: toSecond(event),
      teamId: event.teamId,
      playerId: event.playerId,
      eventTypes: [event.type],
    };
  }

  if (event.type === "yellow_card" || event.type === "red_card") {
    const label = event.type === "yellow_card" ? {
      en: "Yellow card",
      es: "Tarjeta amarilla",
      fr: "Carton jaune",
    } : {
      en: "Red card",
      es: "Tarjeta roja",
      fr: "Carton rouge",
    };
    return {
      id: `event:${event.id}`,
      kind: "event",
      headline: {
        en: `${label.en}: ${playerName}`,
        es: `${label.es}: ${playerName}`,
        fr: `${label.fr} : ${playerName}`,
      },
      text: {
        en: `${playerName} received a ${label.en.toLowerCase()} for ${resolveTeamName("en", fixture, event.teamId)} at ${minuteLabel}.`,
        es: `${playerName} recibió una ${label.es.toLowerCase()} para ${resolveTeamName("es", fixture, event.teamId)} en ${minuteLabel}.`,
        fr: `${playerName} a reçu un ${label.fr.toLowerCase()} pour ${resolveTeamName("fr", fixture, event.teamId)} à ${minuteLabel}.`,
      },
      evidenceIds: [event.id],
      windowStart: toSecond(event),
      windowEnd: toSecond(event),
      teamId: event.teamId,
      playerId: event.playerId,
      eventTypes: [event.type],
    };
  }

  return undefined;
}

function buildRecapFact(snapshot: MatchSnapshot, facts: Record<string, LedgerFact>, activeEvents: MatchEvent[]): LedgerFact | undefined {
  const milestoneFacts = activeEvents
    .filter((event) => event.type === "goal" || event.type === "red_card")
    .sort((left, right) => toSecond(left) - toSecond(right))
    .map((event) => facts[`event:${event.id}`])
    .filter((fact): fact is LedgerFact => Boolean(fact));

  if (milestoneFacts.length === 0) {
    return undefined;
  }

  return {
    id: "recap:milestones",
    kind: "recap",
    headline: {
      en: localize("key_moments", "en"),
      es: localize("key_moments", "es"),
      fr: localize("key_moments", "fr"),
    },
    text: {
      en: `${localize("key_moments", "en")} ${milestoneFacts.map((fact) => fact.text.en).join(" ")}`,
      es: `${localize("key_moments", "es")} ${milestoneFacts.map((fact) => fact.text.es).join(" ")}`,
      fr: `${localize("key_moments", "fr")} ${milestoneFacts.map((fact) => fact.text.fr).join(" ")}`,
    },
    evidenceIds: uniqueIds(milestoneFacts.flatMap((fact) => fact.evidenceIds)),
    windowStart: milestoneFacts[0].windowStart,
    windowEnd: milestoneFacts[milestoneFacts.length - 1].windowEnd,
  };
}

export function buildEvidenceLedger(snapshot: MatchSnapshot, fixture?: MatchFixture): EvidenceLedger {
  const facts: Record<string, LedgerFact> = {};
  const eventIndex: Record<string, MatchEvent> = {};
  const storyFacts: Record<string, string> = {};
  const activeEvents = Object.values(snapshot.evidence)
    .filter((event) => toSecond(event) <= snapshot.atSecond && !event.rescinded);

  for (const event of activeEvents) {
    eventIndex[event.id] = structuredClone(event);
  }

  const scoreEvidenceIds = activeEvents
    .filter((event) => event.type === "goal")
    .map((event) => event.id);

  facts.score = {
    id: "score",
    kind: "score",
    headline: {
      en: fixture ? `${fixture.home.name} ${snapshot.score.home}-${snapshot.score.away} ${fixture.away.name}` : `${snapshot.score.home}-${snapshot.score.away}`,
      es: fixture ? `${fixture.home.name} ${snapshot.score.home}-${snapshot.score.away} ${fixture.away.name}` : `${snapshot.score.home}-${snapshot.score.away}`,
      fr: fixture ? `${fixture.home.name} ${snapshot.score.home}-${snapshot.score.away} ${fixture.away.name}` : `${snapshot.score.home}-${snapshot.score.away}`,
    },
    text: {
      en: renderScoreText(snapshot, "en", fixture),
      es: renderScoreText(snapshot, "es", fixture),
      fr: renderScoreText(snapshot, "fr", fixture),
    },
    evidenceIds: scoreEvidenceIds,
    windowStart: 0,
    windowEnd: snapshot.atSecond,
  };

  for (const story of snapshot.stories) {
    const fact = buildStoryFact(snapshot, story);
    facts[fact.id] = fact;
    storyFacts[story.id] = fact.id;
  }

  for (const event of activeEvents) {
    const fact = buildEventText(event, fixture);
    if (fact) {
      facts[fact.id] = fact;
    }
  }

  const recapFact = buildRecapFact(snapshot, facts, activeEvents);
  if (recapFact) {
    facts[recapFact.id] = recapFact;
  }

  const factOrder = Object.values(facts)
    .sort((left, right) => {
      if (left.kind === "score") {
        return -1;
      }
      if (right.kind === "score") {
        return 1;
      }
      if (left.kind === "recap") {
        return -1;
      }
      if (right.kind === "recap") {
        return 1;
      }
      return right.windowEnd - left.windowEnd;
    })
    .map((fact) => fact.id);

  return {
    scoreFactId: "score",
    recapFactId: recapFact?.id,
    factOrder,
    facts,
    eventIndex,
    storyFacts,
  };
}

export function validateGroundedNarrativeDraft(
  draft: NarrativeDraft,
  snapshot: MatchSnapshot,
  ledger: EvidenceLedger,
): void {
  if (draft.title.length > 180 || draft.script.length > 2_000) {
    throw new HttpError(503, "Narrative text exceeded allowed bounds");
  }

  if (draft.claims.length === 0 || draft.claims.length > MAX_FACTS) {
    throw new HttpError(503, "Narrative claims exceeded allowed bounds");
  }

  const factsByEvidence = new Map<string, LedgerFact[]>();
  for (const fact of Object.values(ledger.facts)) {
    const key = [...fact.evidenceIds].sort().join("|");
    const existing = factsByEvidence.get(key);
    if (existing) {
      existing.push(fact);
    } else {
      factsByEvidence.set(key, [fact]);
    }
  }

  for (const claim of draft.claims) {
    if (claim.text.length === 0 || claim.text.length > 400) {
      throw new HttpError(503, "Narrative claim text exceeded allowed bounds");
    }

    const seen = new Set<string>();
    for (const evidenceId of claim.evidenceIds) {
      if (seen.has(evidenceId)) {
        throw new HttpError(503, "Narrative claim referenced duplicate evidence IDs");
      }
      seen.add(evidenceId);
      const event = ledger.eventIndex[evidenceId];
      if (!event) {
        throw new HttpError(503, "Narrative claim referenced unknown evidence");
      }
      if (event.rescinded) {
        throw new HttpError(503, "Narrative claim referenced rescinded evidence");
      }
      if (toSecond(event) > snapshot.atSecond) {
        throw new HttpError(503, "Narrative claim referenced future evidence");
      }
    }

    const factKey = [...claim.evidenceIds].sort().join("|");
    const approvedFacts = factsByEvidence.get(factKey) ?? [];
    if (approvedFacts.length === 0) {
      throw new HttpError(503, "Narrative claim did not match an approved fact");
    }
    if (approvedFacts.every((fact) => !Object.values(fact.text).includes(claim.text))) {
      throw new HttpError(503, "Narrative claim text did not match approved evidence");
    }
  }
}

function createNarrativeCacheKey(request: NarrativeRequest, snapshot: MatchSnapshot): string {
  return [
    snapshot.fixtureId,
    snapshot.stateVersion,
    request.format,
    request.persona,
    request.language,
    request.storyId ?? "-",
    request.favoritePlayerId ?? "-",
    String(request.atSecond),
    request.correction ? "1" : "0",
  ].join("|");
}

function createSanitizedHttpError(status: number, message: string, metadata: Record<string, unknown>): HttpError {
  const error = new HttpError(status, message);
  Object.assign(error, { cause: metadata, metadata });
  return error;
}

function scrubMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [redacted]")
    .replace(/api[-_ ]?key["=: ]+[A-Za-z0-9._-]+/giu, "api-key=[redacted]")
    .slice(0, 240);
}

function sanitizeUpstreamError(error: unknown): never {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  const metadata = {
    retryable: status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === undefined,
    status: status ?? null,
    name: typeof error === "object" && error !== null && "name" in error ? String(error.name) : "Error",
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined,
    message: error instanceof Error ? scrubMessage(error.message) : undefined,
  };

  if (status === 429) {
    throw createSanitizedHttpError(429, "AI request limit reached", metadata);
  }
  if (status === 400 || status === 401 || status === 403) {
    throw createSanitizedHttpError(503, "AI request rejected by configured upstream", { ...metadata, retryable: false });
  }
  throw createSanitizedHttpError(503, "AI narration is temporarily unavailable", metadata);
}

function createAzureCompletionClient(options: Required<Pick<NarratorOptions, "endpoint" | "deployment" | "apiVersion">> & Pick<NarratorOptions, "apiKey">): CompletionClient {
  const credential = process.env.NODE_ENV === "production"
    ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID ? { clientId: process.env.AZURE_CLIENT_ID } : {})
    : new AzureCliCredential({
        subscription: process.env.AZURE_SUBSCRIPTION_ID,
        tenantId: process.env.AZURE_SUBSCRIPTION_ID ? undefined : process.env.AZURE_TENANT_ID,
        processTimeoutInMs: 10_000,
      });
  const tokenProvider = getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default");
  const client = new AzureOpenAI({
    endpoint: options.endpoint,
    deployment: options.deployment,
    apiVersion: options.apiVersion,
    ...(options.apiKey ? { apiKey: options.apiKey } : { azureADTokenProvider: tokenProvider }),
    maxRetries: 0,
  });

  function toAssistantToolCall(toolCall: z.infer<typeof assistantToolCallSchema>): ChatCompletionMessageFunctionToolCall {
    return {
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments ?? "{}",
      },
    };
  }

  function fromSdkToolCall(toolCall: ChatCompletionMessageFunctionToolCall): ToolCall {
    return {
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    };
  }

  function toSdkMessage(message: ChatMessage): ChatCompletionMessageParam {
    if (message.role === "system" && typeof message.content === "string") {
      return { role: "system", content: message.content };
    }
    if (message.role === "user" && typeof message.content === "string") {
      return { role: "user", content: message.content };
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string" && typeof message.content === "string") {
      const parsed = toolMessageSchema.parse(message);
      const toolMessage: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: parsed.tool_call_id,
        content: parsed.content,
      };
      return toolMessage;
    }
    if (message.role === "assistant") {
      const parsed = assistantMessageSchema.parse(message);
      const assistantMessage: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: parsed.content ?? "",
        tool_calls: parsed.tool_calls?.map(toAssistantToolCall),
      };
      return assistantMessage;
    }
    throw new HttpError(503, "Internal AI message contract is invalid");
  }

  function toSdkMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map(toSdkMessage);
  }

  function toSdkTools(tools: unknown[] | undefined): ChatCompletionTool[] | undefined {
    if (!tools) {
      return undefined;
    }
    return tools.map((tool) => functionToolSchema.parse(tool));
  }

  async function createChatCompletion(args: {
    messages: ChatMessage[];
    tools?: unknown[];
    temperature?: number;
    maxTokens?: number;
    timeoutMs: number;
    requestId: string;
    responseSchema?: { name: string; schema: Record<string, unknown> };
  }): Promise<CompletionResult> {
    const controller = AbortSignal.timeout(args.timeoutMs);
    try {
      const request: ChatCompletionCreateParamsNonStreaming = {
        model: options.deployment,
        messages: toSdkMessages(args.messages),
        tools: toSdkTools(args.tools),
        tool_choice: args.tools ? "auto" : undefined,
        response_format: args.responseSchema
          ? { type: "json_schema", json_schema: { ...args.responseSchema, strict: true } }
          : { type: "json_object" },
        temperature: args.temperature ?? 0.2,
        max_tokens: args.maxTokens ?? 700,
      };
      const result = await client.chat.completions.create(request, {
        signal: controller,
        headers: { "x-ms-client-request-id": args.requestId },
      });

      const choice = result.choices[0]?.message;
      if (!choice) {
        throw new HttpError(503, "AI returned no completion choices");
      }

      return {
        text: choice.content ?? "",
        usage: {
          inputTokens: result.usage?.prompt_tokens ?? 0,
          outputTokens: result.usage?.completion_tokens ?? 0,
        },
        toolCalls: (choice.tool_calls ?? [])
          .filter((toolCall): toolCall is ChatCompletionMessageFunctionToolCall => toolCall.type === "function")
          .map(fromSdkToolCall),
        assistantMessage: {
          role: "assistant",
          content: choice.content ?? "",
          tool_calls: (choice.tool_calls ?? [])
            .filter((toolCall): toolCall is ChatCompletionMessageFunctionToolCall => toolCall.type === "function")
            .map(fromSdkToolCall),
        },
      };
    } catch (error) {
      sanitizeUpstreamError(error);
    }
  }

  return { createChatCompletion };
}

function getRemainingTime(deadline: number): number {
  return Math.max(1_000, deadline - Date.now());
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof HttpError)) {
    return false;
  }
  const metadata = ("metadata" in error && typeof error.metadata === "object" && error.metadata !== null)
    ? error.metadata as Record<string, unknown>
    : undefined;
  return metadata?.retryable === true;
}

async function completeWithSingleRetry(
  client: CompletionClient,
  args: Parameters<CompletionClient["createChatCompletion"]>[0],
  deadline: number,
): Promise<CompletionResult> {
  try {
    return await client.createChatCompletion(args);
  } catch (error) {
    if (isRetryableError(error) && getRemainingTime(deadline) > 1_200) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, getRemainingTime(deadline) - 1_000)));
      return client.createChatCompletion({
        ...args,
        timeoutMs: Math.min(args.timeoutMs, getRemainingTime(deadline)),
      });
    }
    throw error;
  }
}

function createAnalystTools(): ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "get_match_state",
        description: "Returns the localized score fact plus scoreboard context. Approved fact IDs only appear in approvedFactIds.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_story_evidence",
        description: "Returns localized story facts and supporting event facts for one story or all stories. Use approvedFactIds for selectable IDs.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            storyId: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query_events",
        description: "Returns localized event facts filtered by event type, team, or player. Use approvedFactIds for selectable IDs.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            types: { type: "array", items: { type: "string", enum: ["goal", "yellow_card", "red_card"] } },
            teamId: { type: "string", enum: ["home", "away"] },
            playerId: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
        },
      },
    },
  ];
}

function serializeToolFact(fact: LedgerFact, language: Language) {
  return {
    id: fact.id,
    kind: fact.kind,
    headline: fact.headline[language],
    text: fact.text[language],
    evidenceIds: [...fact.evidenceIds],
  };
}

function validateToolArguments(
  name: string,
  rawArguments: string | undefined,
): z.infer<typeof getMatchStateArgsSchema> | z.infer<typeof getStoryEvidenceArgsSchema> | z.infer<typeof queryEventsArgsSchema> {
  const parsed = parseJsonWithSchema(rawArguments ?? "{}", "tool arguments", z.record(z.string(), z.unknown()));
  if (name === "get_match_state") {
    return getMatchStateArgsSchema.parse(parsed);
  }
  if (name === "get_story_evidence") {
    return getStoryEvidenceArgsSchema.parse(parsed);
  }
  if (name === "query_events") {
    return queryEventsArgsSchema.parse(parsed);
  }
  throw new HttpError(503, `Unsupported analyst tool: ${name}`);
}

function executeAnalystTool(
  name: string,
  args: z.infer<typeof getMatchStateArgsSchema> | z.infer<typeof getStoryEvidenceArgsSchema> | z.infer<typeof queryEventsArgsSchema>,
  request: NarrativeRequest,
  snapshot: MatchSnapshot,
  ledger: EvidenceLedger,
): { payload: Record<string, unknown>; approvedFactIds: string[] } {
  if (name === "get_match_state") {
    getMatchStateArgsSchema.parse(args);
    const approvedFactIds = uniqueIds([
      ledger.scoreFactId,
      ...(request.format === "recap" && ledger.recapFactId ? [ledger.recapFactId] : []),
    ]);
    return {
      payload: {
        fixtureId: snapshot.fixtureId,
        atSecond: snapshot.atSecond,
        score: snapshot.score,
        eventCount: snapshot.eventCount,
        evidenceCoverage: snapshot.evidenceCoverage,
        stories: snapshot.stories.map((story) => ({
          id: story.id,
          title: story.title,
          summary: story.summary,
          whyItMatters: story.whyItMatters,
        })),
        facts: approvedFactIds.map((factId) => serializeToolFact(ledger.facts[factId], request.language)),
        approvedFactIds,
      },
      approvedFactIds,
    };
  }

  if (name === "get_story_evidence") {
    const parsed = getStoryEvidenceArgsSchema.parse(args);
    const stories = snapshot.stories
      .filter((story) => !parsed.storyId || story.id === parsed.storyId)
      .map((story) => {
        const storyFactId = ledger.storyFacts[story.id];
        const supportingFactIds = uniqueIds([
          storyFactId,
          ...story.evidenceIds
            .map((evidenceId) => `event:${evidenceId}`)
            .filter((factId) => Boolean(ledger.facts[factId])),
        ]);
        return {
          id: story.id,
          title: story.title,
          importance: story.importance,
          approvedFactIds: supportingFactIds,
          facts: supportingFactIds.map((factId) => serializeToolFact(ledger.facts[factId], request.language)),
        };
      });
    if (parsed.storyId && stories.length === 0) {
      throw new HttpError(503, "AI analyst requested an unknown story");
    }
    return {
      payload: {
        stories,
        approvedFactIds: uniqueIds(stories.flatMap((story) => story.approvedFactIds)),
      },
      approvedFactIds: uniqueIds(stories.flatMap((story) => story.approvedFactIds)),
    };
  }

  if (name === "query_events") {
    const parsed = queryEventsArgsSchema.parse(args);
    const types = parsed.types ? new Set<string>(parsed.types) : undefined;
    const limit = parsed.limit ?? 6;

    const matches = Object.values(ledger.facts)
      .filter((fact) => fact.kind === "event")
      .filter((fact) => !parsed.teamId || fact.teamId === parsed.teamId)
      .filter((fact) => !parsed.playerId || fact.playerId === parsed.playerId)
      .filter((fact) => !types || fact.eventTypes?.some((eventType) => types.has(eventType)))
      .slice(0, limit)
      .map((fact) => serializeToolFact(fact, request.language));
    const approvedFactIds = matches.map((fact) => fact.id);
    return {
      payload: {
        facts: matches,
        approvedFactIds,
      },
      approvedFactIds,
    };
  }

  throw new HttpError(503, `Unsupported analyst tool: ${name}`);
}

async function runAnalystStep(
  client: CompletionClient,
  request: NarrativeRequest,
  snapshot: MatchSnapshot,
  ledger: EvidenceLedger,
  requestId: string,
  deadline: number,
): Promise<{ plan: AnalystPlan; usage: ModelUsage; toolCount: number }> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        `You are the MatchLens analyst for ${MODEL_LABEL}.`,
        `Call get_match_state and at least one supporting tool (get_story_evidence or query_events) before returning final JSON.`,
        `Only choose 1-${MAX_FACTS} selectedFactIds from approvedFactIds returned by the tools you actually called.`,
        "Set focusStoryId to null if no single story is the focus. Otherwise it must be a returned story ID whose story fact is also selected.",
        "Keep rationale between 1 and 400 characters. Do not add any other JSON keys.",
        "For a recap, focusStoryId MUST be null. For a requested story, select its story fact.",
        "For a recap, include one available story fact that explains a pattern, in addition to key events and the score.",
        "Return strict JSON only with keys selectedFactIds, focusStoryId, rationale.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        format: request.format,
        persona: request.persona,
        language: request.language,
        requestedStoryId: request.storyId ?? null,
        favoritePlayerId: request.favoritePlayerId ?? null,
      }),
    },
  ];

  const tools = createAnalystTools();
  const usage = createUsage();
  let toolCount = 0;
  const approvedFactIds = new Set<string>();
  const usedTools = new Set<string>();

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const completion = await completeWithSingleRetry(client, {
      messages,
      tools,
      temperature: 0,
      maxTokens: 500,
      timeoutMs: Math.min(15_000, getRemainingTime(deadline)),
      requestId,
      responseSchema: {
        name: "matchlens_analyst",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["selectedFactIds", "focusStoryId", "rationale"],
          properties: {
            selectedFactIds: { type: "array", items: { type: "string", enum: ledger.factOrder } },
            focusStoryId: {
              type: ["string", "null"],
              enum: request.format === "recap" ? [null] : [null, ...Object.keys(ledger.storyFacts)],
            },
            rationale: { type: "string" },
          },
        },
      },
    }, deadline);
    addUsage(usage, completion.usage);

    if (completion.toolCalls.length === 0) {
      if (!usedTools.has("get_match_state") || (!usedTools.has("get_story_evidence") && !usedTools.has("query_events"))) {
        throw new HttpError(503, "AI analyst did not ground its selection");
      }
      const plan = parseJsonWithSchema(completion.text, "analyst", analystPlanSchema);
      for (const factId of plan.selectedFactIds) {
        if (!approvedFactIds.has(factId)) {
          throw new HttpError(503, "AI analyst selected facts outside grounded tool results");
        }
        if (!ledger.facts[factId]) {
          throw new HttpError(503, "AI analyst selected unknown facts");
        }
      }
      if (plan.focusStoryId) {
        const storyFactId = ledger.storyFacts[plan.focusStoryId];
        if (!storyFactId || !plan.selectedFactIds.includes(storyFactId)) {
          throw new HttpError(503, "AI analyst focusStoryId was not grounded by a selected story fact");
        }
      }
      if (request.storyId) {
        const requestedStoryFactId = ledger.storyFacts[request.storyId];
        if (requestedStoryFactId && !plan.selectedFactIds.includes(requestedStoryFactId)) {
          throw new HttpError(503, "AI analyst omitted the requested story fact");
        }
      }
      return { plan, usage, toolCount };
    }

    messages.push(completion.assistantMessage);

    for (const toolCall of completion.toolCalls) {
      toolCount += 1;
      usedTools.add(toolCall.function.name);
      const args = validateToolArguments(toolCall.function.name, toolCall.function.arguments);
      const result = executeAnalystTool(toolCall.function.name, args, request, snapshot, ledger);
      for (const factId of result.approvedFactIds) {
        approvedFactIds.add(factId);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.payload),
      });
    }
  }

  throw new HttpError(503, "AI analyst exceeded tool-call budget");
}

async function runProducerStep(
  client: CompletionClient,
  request: NarrativeRequest,
  ledger: EvidenceLedger,
  analystPlan: AnalystPlan,
  requestId: string,
  deadline: number,
): Promise<{ plan: ProducerPlan; usage: ModelUsage }> {
  const allowedFacts = analystPlan.selectedFactIds
    .map((factId) => ledger.facts[factId])
    .filter((fact): fact is LedgerFact => Boolean(fact))
    .map((fact) => ({
      id: fact.id,
      headline: fact.headline[request.language],
      text: fact.text[request.language],
      evidenceIds: fact.evidenceIds,
      kind: fact.kind,
    }));

  if (allowedFacts.length === 0) {
    throw new HttpError(503, "AI analyst selected no approved facts");
  }

  const completion = await completeWithSingleRetry(client, {
    messages: [
      {
        role: "system",
        content: [
          `You are the MatchLens producer for ${MODEL_LABEL}.`,
          `Choose 1-${MAX_FACTS} orderedFactIds only from the provided selectedFactIds.`,
          `Accepted titleMode values: ${titleModeValues.join(", ")}.`,
          `Accepted emphasis values: ${emphasisValues.join(", ")}.`,
          "Return strict JSON only with keys titleMode, orderedFactIds, emphasis.",
          "Include a provided story fact when available to explain context rather than merely listing goals.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          format: request.format,
          persona: request.persona,
          language: request.language,
          rationale: analystPlan.rationale,
          allowedFacts,
        }),
      },
    ],
    temperature: 0.2,
    maxTokens: 350,
    timeoutMs: Math.min(12_000, getRemainingTime(deadline)),
    requestId,
    responseSchema: {
      name: "matchlens_producer",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["titleMode", "orderedFactIds", "emphasis"],
        properties: {
          titleMode: { type: "string", enum: [...titleModeValues] },
          orderedFactIds: { type: "array", items: { type: "string", enum: analystPlan.selectedFactIds } },
          emphasis: { type: "string", enum: [...emphasisValues] },
        },
      },
    },
  }, deadline);

  const plan = parseJsonWithSchema(completion.text, "producer", producerPlanSchema);
  for (const factId of plan.orderedFactIds) {
    if (!analystPlan.selectedFactIds.includes(factId)) {
      throw new HttpError(503, "AI producer ordered facts outside analyst selection");
    }
  }

  return {
    plan,
    usage: completion.usage,
  };
}

function supportsMomentumTitle(fact: LedgerFact): boolean {
  return fact.kind === "story" && (fact.storyKind === "pressure" || fact.storyKind === "rhythm");
}

function createTitle(orderedFacts: LedgerFact[], plan: ProducerPlan, request: NarrativeRequest, ledger: EvidenceLedger): string {
  const lead = orderedFacts[0] ?? ledger.facts[ledger.scoreFactId];
  if (!lead) {
    return request.format === "story"
      ? localize("intro_story", request.language)
      : localize("intro_recap", request.language);
  }

  if (plan.titleMode === "scoreline") {
    return lead.headline[request.language];
  }
  if (plan.titleMode === "player_focus" && lead.playerId) {
    return `${localize("player", request.language)} ${lead.headline[request.language]}`;
  }
  if (plan.titleMode === "momentum" && supportsMomentumTitle(lead)) {
    return `${localize("momentum", request.language)} ${lead.headline[request.language]}`;
  }
  if (plan.titleMode === "turning_point" && lead.kind === "story" && lead.storyKind === "turning_point") {
    return `${localize("turning", request.language)} ${lead.headline[request.language]}`;
  }
  return `${localize("focus", request.language)} ${lead.headline[request.language]}`;
}

function buildRenderableFactIds(
  request: NarrativeRequest,
  ledger: EvidenceLedger,
  producerPlan: ProducerPlan,
  analystPlan: AnalystPlan,
): string[] {
  const ordered: string[] = [];
  const pushFact = (factId: string | undefined) => {
    if (!factId || !ledger.facts[factId] || ordered.includes(factId)) {
      return;
    }
    ordered.push(factId);
  };

  if (request.format === "story") {
    pushFact(request.storyId ? ledger.storyFacts[request.storyId] : undefined);
    pushFact(analystPlan.focusStoryId ? ledger.storyFacts[analystPlan.focusStoryId] : undefined);
  }
  pushFact(ledger.scoreFactId);
  if (request.format === "recap") {
    pushFact(ledger.recapFactId);
    pushFact(analystPlan.selectedFactIds.find((id) => ledger.facts[id]?.kind === "story"));
  }
  for (const factId of producerPlan.orderedFactIds) {
    pushFact(factId);
  }
  return ordered.slice(0, MAX_FACTS);
}

function renderNarrative(
  request: NarrativeRequest,
  ledger: EvidenceLedger,
  producerPlan: ProducerPlan,
  analystPlan: AnalystPlan,
): NarrativeDraft {
  const orderedFacts = buildRenderableFactIds(request, ledger, producerPlan, analystPlan)
    .map((factId) => ledger.facts[factId])
    .filter((fact): fact is LedgerFact => Boolean(fact))
    .slice(0, MAX_FACTS);

  if (orderedFacts.length === 0) {
    throw new HttpError(503, "AI producer returned no approved facts");
  }

  const claims: NarrativeClaim[] = orderedFacts.map((fact) => ({
    text: fact.text[request.language],
    evidenceIds: fact.evidenceIds,
  }));

  const intro = request.format === "story"
    ? localize("intro_story", request.language)
    : localize("intro_recap", request.language);

  const script = [intro, ...claims.map((claim, index) => index === 0 ? claim.text : `${localize("also", request.language)} ${claim.text}`)]
    .join(" ")
    .trim();

  return {
    title: createTitle(orderedFacts, producerPlan, request, ledger),
    script,
    claims,
  };
}

class ConfiguredNarrator implements Narrator {
  private readonly healthState: AppHealth["ai"];
  private readonly cache;
  private readonly budget;
  private readonly now: () => number;
  private readonly deployment: string;

  constructor(
    private readonly client: CompletionClient,
    private readonly options: Required<Pick<NarratorOptions, "cacheMaxEntries" | "cacheTtlMs" | "maxRequestsPerHour" | "maxConcurrent" | "now">> & Pick<NarratorOptions, "endpoint" | "deployment" | "apiKey">,
  ) {
    this.healthState = {
      configured: Boolean(options.endpoint && options.deployment),
      deployment: options.deployment ?? "",
      authentication: inferAuthentication(options.endpoint, options.apiKey),
    };
    this.cache = createLruCache(options.cacheMaxEntries, options.cacheTtlMs, options.now);
    this.budget = createBudget(options.maxRequestsPerHour, options.maxConcurrent, options.now);
    this.now = options.now;
    this.deployment = options.deployment ?? "unconfigured";
  }

  health(): AppHealth["ai"] {
    return { ...this.healthState };
  }

  async narrate(request: NarrativeRequest, snapshot: MatchSnapshot, context: NarrationContext): Promise<NarrativeResponse> {
    if (!this.healthState.configured) {
      throw new HttpError(503, "AI narration is not configured");
    }

    const startedAt = this.now();
    const cacheKey = createNarrativeCacheKey(request, snapshot);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.cached = true;
      cached.latencyMs = this.now() - startedAt;
      return cached;
    }

    const lease = this.budget.acquire();
    try {
      const deadline = Date.now() + REQUEST_TIMEOUT_MS;
      const ledger = buildEvidenceLedger(snapshot, context.fixture);
      const trace: AgentStep[] = [];
      const usage = createUsage();

      const analystStarted = this.now();
      const analyst = await runAnalystStep(this.client, request, snapshot, ledger, context.requestId, deadline);
      addUsage(usage, analyst.usage);
      trace.push({
        role: "analyst",
        status: "complete",
        detail: `Selected ${analyst.plan.selectedFactIds.length} approved facts using ${analyst.toolCount} grounded tool calls.`,
        durationMs: this.now() - analystStarted,
      });

      const producerStarted = this.now();
      const producer = await runProducerStep(this.client, request, ledger, analyst.plan, context.requestId, deadline);
      for (const factId of producer.plan.orderedFactIds) {
        if (!analyst.plan.selectedFactIds.includes(factId)) {
          throw new HttpError(503, "AI producer ordered facts outside analyst selection");
        }
      }
      addUsage(usage, producer.usage);
      trace.push({
        role: "producer",
        status: "complete",
        detail: `Ordered ${producer.plan.orderedFactIds.length} approved facts with ${producer.plan.titleMode} framing.`,
        durationMs: this.now() - producerStarted,
      });

      const guardStarted = this.now();
      const narrative = renderNarrative(request, ledger, producer.plan, analyst.plan);
      validateGroundedNarrativeDraft(narrative, snapshot, ledger);
      trace.push({
        role: "grounding",
        status: "complete",
        detail: "Validated approved evidence IDs, active windows, and bounded text output.",
        durationMs: this.now() - guardStarted,
      });

      const response: NarrativeResponse = {
        title: narrative.title,
        script: narrative.script,
        claims: narrative.claims,
        trace,
        source: "foundry",
        model: this.deployment,
        stateVersion: snapshot.stateVersion,
        latencyMs: this.now() - startedAt,
        cached: false,
        usage,
      };

      this.cache.set(cacheKey, response);
      return structuredClone(response);
    } finally {
      lease.release();
    }
  }
}

class UnconfiguredNarrator implements Narrator {
  private readonly healthState: AppHealth["ai"];

  constructor(endpoint?: string, deployment?: string, apiKey?: string) {
    this.healthState = {
      configured: false,
      deployment: deployment ?? "",
      authentication: inferAuthentication(endpoint, apiKey),
    };
  }

  health(): AppHealth["ai"] {
    return { ...this.healthState };
  }

  async narrate(): Promise<NarrativeResponse> {
    throw new HttpError(503, "AI narration is not configured");
  }
}

export function createNarrator(options: NarratorOptions = {}): Narrator {
  const endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
  const apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
  const now = options.now ?? Date.now;

  if (!endpoint || !deployment) {
    return new UnconfiguredNarrator(endpoint, deployment, apiKey);
  }

  const completionClient = options.completionClient ?? createAzureCompletionClient({
    endpoint,
    deployment,
    apiVersion,
    apiKey,
  });

  return new ConfiguredNarrator(completionClient, {
    cacheMaxEntries: options.cacheMaxEntries ?? DEFAULT_CACHE_MAX,
    cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    maxRequestsPerHour: options.maxRequestsPerHour ?? Number(process.env.AI_MAX_REQUESTS_PER_HOUR ?? DEFAULT_HOURLY_LIMIT),
    maxConcurrent: options.maxConcurrent ?? Number(process.env.AI_MAX_CONCURRENT ?? DEFAULT_CONCURRENT),
    now,
    endpoint,
    deployment,
    apiKey,
  });
}

export function hashInlineScript(script: string): string {
  return `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;
}
