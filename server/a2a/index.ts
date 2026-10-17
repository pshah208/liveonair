import { randomUUID } from "node:crypto";

import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { bearerMatches, projectStoryline, visibleStorylines } from "../agentAccess.js";
import type { LiveService, StorylineDesk } from "../contracts.js";

export const A2A_PROTOCOL_VERSION = "0.3.0";
const MAX_TASKS = 200;

export type A2aDeps = {
  live: LiveService;
  desk: StorylineDesk;
  version: string;
  /** Bearer token that unlocks studio scope (drafts awaiting review). Unauthenticated callers get approved copy only. */
  token?: string;
  limit?: number;
};

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(200), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});

const partSchema = z.union([
  z.object({ kind: z.literal("text"), text: z.string().max(4_000), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ kind: z.literal("data"), data: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ kind: z.literal("file"), file: z.unknown(), metadata: z.record(z.string(), z.unknown()).optional() }),
]);

const messageSchema = z.object({
  kind: z.literal("message"),
  role: z.enum(["user", "agent"]),
  messageId: z.string().min(1).max(200),
  parts: z.array(partSchema).min(1).max(10),
  contextId: z.string().max(200).optional(),
  taskId: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const messageSendParamsSchema = z.object({
  message: messageSchema,
  configuration: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const taskQueryParamsSchema = z.object({
  id: z.string().min(1).max(200),
  historyLength: z.number().int().min(0).max(100).optional(),
});

type A2aMessage = z.infer<typeof messageSchema>;
type JsonRpcId = string | number | null;

type A2aTask = {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: "completed" | "rejected"; timestamp: string; message: A2aMessage };
  artifacts: Array<{ artifactId: string; name: string; description: string; parts: Array<Record<string, unknown>> }>;
  history: A2aMessage[];
  metadata: Record<string, unknown>;
};

const ERRORS = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid Request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  taskNotFound: { code: -32001, message: "Task not found" },
} as const;

function rpcError(id: JsonRpcId, error: { code: number; message: string }, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: data === undefined ? error : { ...error, data } };
}

function baseUrl(request: express.Request): string {
  return `${request.protocol}://${request.get("host") ?? "localhost"}`;
}

export function buildAgentCard(url: string, deps: Pick<A2aDeps, "version" | "token">) {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Live on Air Storyline Desk",
    description: "Multi-agent newsroom for synthetic live football: a director coordinates researcher, tactics analyst, producer, fact-checker and localizer agents; every claim is deterministically verified. Returns storylines for a match event. Only human-approved copy is public; this agent never approves anything itself.",
    url: `${url}/a2a`,
    preferredTransport: "JSONRPC",
    version: deps.version,
    provider: { organization: "Live on Air (synthetic demo)", url },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: [{
      id: "storylines-for-event",
      name: "Storylines for a match event",
      description: "Given a live event ID (data part {\"eventId\": \"...\"} or the ID in text), returns the current storylines that cite it. Without an event ID returns every storyline for the live match. Unauthenticated callers receive approved copy only.",
      tags: ["football", "storylines", "broadcast", "fact-checked", "human-in-the-loop"],
      examples: [
        "Give me the approved storyline for event goal-home-72",
        "{\"eventId\": \"goal-home-72\"}",
      ],
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json", "text/plain"],
    }],
    ...(deps.token ? { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Optional: unlocks studio scope (drafts awaiting human review)." } } } : {}),
  };
}

function extractEventId(message: A2aMessage, knownIds: Set<string>): string | undefined {
  for (const part of message.parts) {
    if (part.kind === "data" && typeof part.data.eventId === "string") {
      return part.data.eventId;
    }
  }
  for (const part of message.parts) {
    if (part.kind === "text") {
      const token = part.text.split(/[^A-Za-z0-9:_-]+/u).find((candidate) => knownIds.has(candidate));
      if (token) return token;
    }
  }
  return undefined;
}

/** A2A Agent Card plus a minimal JSON-RPC 2.0 endpoint (message/send, tasks/get). Read-only. */
export function createA2aRouter(deps: A2aDeps): express.Router {
  const router = express.Router();
  const tasks = new Map<string, A2aTask>();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.limit ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: rpcError(null, { code: -32000, message: "Too many A2A requests" }),
  });

  const sendCard = (request: express.Request, response: express.Response) => {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(buildAgentCard(baseUrl(request), deps));
  };
  router.get("/.well-known/agent-card.json", limiter, sendCard);
  router.get("/.well-known/agent.json", limiter, sendCard);

  function remember(task: A2aTask): void {
    tasks.set(task.id, task);
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value;
      if (oldest === undefined) break;
      tasks.delete(oldest);
    }
  }

  function messageSend(params: z.infer<typeof messageSendParamsSchema>, studio: boolean): A2aTask {
    const userMessage = params.message;
    const taskId = randomUUID();
    const contextId = userMessage.contextId ?? randomUUID();
    const view = deps.live.current();
    const knownIds = new Set(view?.fixture.events.map((event) => event.id) ?? []);
    const eventId = extractEventId(userMessage, knownIds);
    const all = view ? deps.desk.list(view.matchId) : [];
    const forEvent = eventId
      ? all.filter((storyline) => storyline.triggerEventIds.includes(eventId)
        || storyline.claims.some((claim) => claim.sources.some((source) => source.type === "event" && source.id === eventId)))
      : all;
    const storylines = visibleStorylines(forEvent, studio).map((storyline) => projectStoryline(storyline, studio));
    const pendingReview = forEvent.filter((storyline) => storyline.status === "needs_review").length;
    const summary = !view
      ? "No live match is running."
      : storylines.length === 0
        ? `No ${studio ? "" : "approved "}storylines${eventId ? ` for event ${eventId}` : ""} yet.${!studio && pendingReview > 0 ? ` ${pendingReview} awaiting human review.` : ""}`
        : storylines.map((storyline) => `${storyline.triggerMinute}' [${storyline.status}] ${storyline.headline.en}: ${storyline.onAirLine.en}`).join("\n");
    const agentMessage: A2aMessage = {
      kind: "message",
      role: "agent",
      messageId: randomUUID(),
      parts: [{ kind: "text", text: summary }],
      taskId,
      contextId,
    };
    const task: A2aTask = {
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "completed", timestamp: new Date().toISOString(), message: agentMessage },
      artifacts: [{
        artifactId: randomUUID(),
        name: "storylines",
        description: studio ? "Storylines in every review state (studio scope)." : "Human-approved storylines only.",
        parts: [
          { kind: "data", data: { matchId: view?.matchId ?? null, eventId: eventId ?? null, scope: studio ? "studio" : "approved", storylines } },
          { kind: "text", text: summary },
        ],
      }],
      history: [{ ...userMessage, taskId, contextId }],
      metadata: { humanApprovalRequired: true, synthetic: true },
    };
    remember(task);
    return task;
  }

  router.post("/a2a", limiter, (request, response) => {
    const body: unknown = request.body;
    if (Array.isArray(body)) {
      response.json(rpcError(null, ERRORS.invalidRequest, "Batch requests are not supported"));
      return;
    }
    const parsed = jsonRpcRequestSchema.safeParse(body);
    if (!parsed.success) {
      response.json(rpcError(null, ERRORS.invalidRequest));
      return;
    }
    const id: JsonRpcId = parsed.data.id ?? null;
    const studio = bearerMatches(request, deps.token);
    switch (parsed.data.method) {
      case "message/send": {
        const params = messageSendParamsSchema.safeParse(parsed.data.params);
        if (!params.success) {
          response.json(rpcError(id, ERRORS.invalidParams, params.error.issues[0]?.message));
          return;
        }
        response.json({ jsonrpc: "2.0", id, result: messageSend(params.data, studio) });
        return;
      }
      case "tasks/get": {
        const params = taskQueryParamsSchema.safeParse(parsed.data.params);
        if (!params.success) {
          response.json(rpcError(id, ERRORS.invalidParams, params.error.issues[0]?.message));
          return;
        }
        const task = tasks.get(params.data.id);
        if (!task) {
          response.json(rpcError(id, ERRORS.taskNotFound));
          return;
        }
        const history = params.data.historyLength === undefined ? task.history : task.history.slice(-params.data.historyLength || task.history.length);
        response.json({ jsonrpc: "2.0", id, result: { ...task, history: params.data.historyLength === 0 ? [] : history } });
        return;
      }
      default:
        response.json(rpcError(id, ERRORS.methodNotFound));
    }
  });

  return router;
}

export { ERRORS as A2A_ERRORS };
