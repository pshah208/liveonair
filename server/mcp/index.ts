import express from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { ChanceInsight } from "../../shared/chanceSequence.js";
import { analysePlayers } from "../../shared/playerStats.js";
import type { ArchiveSnapshot } from "../../shared/platform.js";
import type { AnalysisRequest, MatchEvent } from "../../shared/types.js";
import { bearerMatches, liveClock, projectStoryline, visibleStorylines } from "../agentAccess.js";
import type { AnalyzeFixture, LiveService, StorylineDesk } from "../contracts.js";
import {
  activeEvents,
  buildArchiveIndexes,
  claimProposalSchema,
  scoreFromEvents,
  verifyClaimProposal,
  type ArchiveRetrieval,
  type ArchiveSearchHit,
} from "../desk/claims.js";

export type McpDeps = {
  live: LiveService;
  desk: StorylineDesk;
  insights?: { list(matchId: string): ChanceInsight[] };
  analyzeFixture: AnalyzeFixture;
  archive: ArchiveSnapshot;
  retrieval: ArchiveRetrieval;
  version: string;
};

type CallContext = { studio: boolean };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const boundedId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u);
const MAX_SEARCH_RESULTS = 5;

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Keyword search over the synthetic archive documents, used when Azure AI Search is not configured. */
export function localArchiveSearch(archive: ArchiveSnapshot, query: string): ArchiveSearchHit[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) {
    return [];
  }
  return archive.documents
    .map((document) => {
      const haystack = `${document.title} ${document.body}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { document, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
    .slice(0, MAX_SEARCH_RESULTS)
    .map(({ document }) => ({ id: document.id, title: document.title, body: document.body, recordIds: document.recordIds }));
}

function latestRevision(events: MatchEvent[], eventId: string): MatchEvent | undefined {
  return events
    .filter((event) => event.id === eventId)
    .sort((left, right) => right.revision - left.revision)[0];
}

/** Builds a read-only MCP server bound to the current platform. One instance per stateless HTTP request. */
export function createMcpServer(deps: McpDeps, context: CallContext): McpServer {
  const server = new McpServer({ name: "live-on-air", version: deps.version }, {
    instructions: "Read-only access to the Live on Air live match, synthetic archive and human-approved storylines. All match data is synthetic.",
  });
  const archiveIndexes = buildArchiveIndexes(deps.archive);
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool("get_live_status", {
    title: "Live status",
    description: "Live feed status: state, transport, match clock and event counts.",
    annotations: readOnly,
  }, async () => ok(deps.live.status()));

  server.registerTool("get_live_snapshot", {
    title: "Live match snapshot",
    description: "Deterministic engine analysis of the live match so far: score, team stats, story cards and recent events.",
    inputSchema: {
      persona: z.enum(["analyst", "casual", "player"]).optional(),
      language: z.enum(["en", "es", "fr", "pt"]).optional(),
      period: z.enum(["full", "first", "second"]).optional().describe("Optional match period scope"),
    },
    annotations: readOnly,
  }, async ({ persona, language, period }) => {
    const view = deps.live.current();
    if (!view) return fail("No live match");
    const request = {
      fixtureId: view.fixture.id,
      atSecond: liveClock(deps.live, view),
      persona: persona ?? "analyst",
      language: language ?? "en",
      ...(period ? { period } : {}),
    } as AnalysisRequest;
    const snapshot = deps.analyzeFixture(structuredClone(view.fixture), request);
    return ok({
      matchId: view.matchId,
      fixture: { id: view.fixture.id, title: view.fixture.title, home: view.fixture.home.name, away: view.fixture.away.name },
      atSecond: snapshot.atSecond,
      stateVersion: snapshot.stateVersion,
      score: snapshot.score,
      stats: snapshot.stats,
      stories: snapshot.stories,
      recentEvents: snapshot.recentEvents,
      corrections: snapshot.corrections,
      synthetic: true,
    });
  });

  server.registerTool("get_chance_insights", {
    title: "Chance insights",
    description: "Versioned chance-sequence insights for the live match: inferred build-up, event-derived territory, and issued/revised/withdrawn status. Read-only. Not possession or pressure.",
    annotations: readOnly,
  }, async () => {
    const view = deps.live.current();
    if (!view) return ok({ matchId: null, metricVersion: "chance-sequence/1", insights: [] });
    return ok({
      matchId: view.matchId,
      metricVersion: "chance-sequence/1",
      insights: deps.insights?.list(view.matchId) ?? [],
      note: "Sequence boundaries are inferred from event order. Territory is event-derived, not possession.",
    });
  });

  server.registerTool("get_event", {
    title: "Get live event",
    description: "Latest revision of one live match event by ID, including whether it was rescinded.",
    inputSchema: { eventId: boundedId },
    annotations: readOnly,
  }, async ({ eventId }) => {
    const view = deps.live.current();
    if (!view) return fail("No live match");
    const event = latestRevision(view.fixture.events, eventId);
    if (!event) return fail("Event not found");
    const player = [...view.fixture.home.players, ...view.fixture.away.players].find((candidate) => candidate.id === event.playerId);
    return ok({ event, player: player ? { id: player.id, name: player.name, teamId: player.teamId } : null });
  });

  server.registerTool("get_player_stats", {
    title: "Player statistics",
    description: "Event-derived per-player statistics for the live match (goals, xG, passes, pressures, impact rating).",
    inputSchema: {
      playerId: boundedId.optional().describe("Return one player; omit for every player"),
      period: z.enum(["full", "first", "second"]).optional(),
    },
    annotations: readOnly,
  }, async ({ playerId, period }) => {
    const view = deps.live.current();
    if (!view) return fail("No live match");
    const players = analysePlayers(view.fixture, liveClock(deps.live, view), period ?? "full")
      .filter((analysis) => !playerId || analysis.player.id === playerId)
      .map(({ touches: _touches, ...rest }) => rest);
    if (playerId && players.length === 0) return fail("Player not found");
    return ok({ matchId: view.matchId, players });
  });

  server.registerTool("search_archive", {
    title: "Search archive",
    description: "Search the synthetic football archive (Azure AI Search / Foundry IQ when configured, otherwise local keyword search).",
    inputSchema: { query: z.string().trim().min(2).max(200) },
    annotations: readOnly,
  }, async ({ query }) => {
    if (deps.retrieval.mode !== "unconfigured") {
      try {
        return ok({ mode: deps.retrieval.mode, results: (await deps.retrieval.search(query)).slice(0, MAX_SEARCH_RESULTS) });
      } catch {
        // Fall through to local search so the tool stays useful when the search service is down.
      }
    }
    return ok({ mode: "local-keyword", results: localArchiveSearch(deps.archive, query) });
  });

  server.registerTool("list_storylines", {
    title: "List storylines",
    description: "Storylines for the live match. Only human-approved copy unless the caller is an authenticated studio client.",
    inputSchema: { includeDrafts: z.boolean().optional().describe("Studio only: include storylines awaiting review") },
    annotations: readOnly,
  }, async ({ includeDrafts }) => {
    const view = deps.live.current();
    if (!view) return ok({ matchId: null, scope: "approved", storylines: [] });
    const studio = context.studio && Boolean(includeDrafts);
    return ok({
      matchId: view.matchId,
      scope: studio ? "studio" : "approved",
      storylines: visibleStorylines(deps.desk.list(view.matchId), studio).map((storyline) => projectStoryline(storyline, studio)),
    });
  });

  server.registerTool("verify_claim", {
    title: "Verify claim",
    description: "Runs the deterministic Storyline Desk verifier on a structured claim against the live event log and archive.",
    inputSchema: {
      kind: z.enum(["live_event", "match_state", "live_metric", "chance_sequence", "former_club", "family_link", "career_goals", "head_to_head", "historic_final", "club_honour"]),
      params: z.record(z.string(), z.unknown()),
      sources: z.array(z.object({ type: z.enum(["event", "archive"]), id: boundedId })).min(1).max(12),
      triggerEventId: boundedId.optional().describe("Event the claim is about; defaults to the latest goal or red card"),
    },
    annotations: readOnly,
  }, async ({ kind, params, sources, triggerEventId }) => {
    const view = deps.live.current();
    if (!view) return fail("No live match");
    const parsed = claimProposalSchema.safeParse({ kind, params, sources });
    if (!parsed.success) {
      return ok({ ok: false, reason: `Invalid claim: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` });
    }
    const clockSecond = liveClock(deps.live, view);
    const events = activeEvents(view.fixture, clockSecond);
    const trigger = triggerEventId
      ? events.find((event) => event.id === triggerEventId)
      : [...events].reverse().find((event) => !event.rescinded && (event.type === "goal" || event.type === "red_card")) ?? events.at(-1);
    if (!trigger) return fail("Trigger event not found");
    const result = verifyClaimProposal(deps.archive, archiveIndexes, view.fixture, {
      event: trigger,
      fixture: view.fixture,
      matchId: view.matchId,
      clockSecond,
      score: scoreFromEvents(events),
    }, "mcp-verify", new Date().toISOString(), parsed.data);
    return ok(result.ok
      ? { ok: true, kind: result.claim.kind, text: result.claim.text, sources: result.claim.sources }
      : { ok: false, kind: result.claim.kind, reason: result.claim.reason });
  });

  return server;
}

/** Stateless streamable-HTTP MCP endpoint at /mcp. Requires `Authorization: Bearer $MCP_TOKEN` when set. */
export function createMcpRouter(deps: McpDeps & { token?: string; limit?: number }): express.Router {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.limit ?? 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { jsonrpc: "2.0", error: { code: -32000, message: "Too many MCP requests" }, id: null },
  });

  router.all("/mcp", limiter, (request, response, next) => {
    if (deps.token && !bearerMatches(request, deps.token)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  });

  router.post("/mcp", async (request, response, next) => {
    const server = createMcpServer(deps, { studio: Boolean(deps.token) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        return;
      }
      next(error);
    }
  });

  // Stateless mode: no server-initiated SSE stream and no sessions to delete.
  router.all("/mcp", (_request, response) => {
    response.setHeader("Allow", "POST");
    response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return router;
}
