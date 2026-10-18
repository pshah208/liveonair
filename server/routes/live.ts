import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import type { ChanceInsight } from "../../shared/chanceSequence.js";
import type { LiveMessage, LiveStreamQuery, StartLiveRequest, Storyline, VerifiedFact } from "../../shared/platform.js";
import type { AnalysisRequest, MatchFixture, MatchSnapshot } from "../../shared/types.js";
import type { AnalyzeFixture, LiveMatchView, LiveService, StorylineDesk } from "../contracts.js";
import { isPublicStoryline } from "../agentAccess.js";
import { type TickSource } from "../live/service.js";
import { HttpError, assertKnownFavoritePlayer, isHttpError } from "../validation.js";

type ChanceInsightFeed = {
  list(matchId: string): ChanceInsight[];
  subscribe(listener: (insight: ChanceInsight) => void): () => void;
};

type CreateLiveRouterOptions = {
  live: LiveService;
  desk: StorylineDesk;
  analyzeFixture: AnalyzeFixture;
  /** Optional so existing test routers keep working. Fan and studio both receive issued, revised and withdrawn insights. */
  insights?: ChanceInsightFeed;
  maxStreams?: number;
};

type StreamState = {
  response: express.Response;
  close(): void;
};

const boundedId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u);

const startLiveRequestSchema: z.ZodType<StartLiveRequest> = z.object({
  fixtureId: boundedId.optional(),
  generate: z.object({
    scenario: z.enum(["comeback", "red_card", "set_piece", "late_winner", "goal_fest"]),
    seed: z.number().int().min(1).max(1_000_000_000),
    homeClubId: boundedId.optional(),
    awayClubId: boundedId.optional(),
  }).strict().optional(),
  speed: z.number().int().min(1).max(60),
  stress: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const count = Number(Boolean(value.fixtureId)) + Number(Boolean(value.generate));
  if (count !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of fixtureId or generate is required",
      path: ["fixtureId"],
    });
  }
});

const correctionSchema = z.object({
  eventId: boundedId,
}).strict();

const streamQuerySchema: z.ZodType<LiveStreamQuery> = z.object({
  role: z.enum(["fan", "studio"]),
  persona: z.enum(["analyst", "casual", "player"]),
  language: z.enum(["en", "es", "fr", "pt"]),
  favoritePlayerId: boundedId.optional(),
  favoriteClubId: boundedId.optional(),
  period: z.enum(["full", "first", "second"]).optional(),
}).strict();

function parseStrict<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, `${path}${issue.message}`);
  }
  return result.data;
}

function sendJsonError(response: express.Response, status: number, message: string): void {
  response.status(status).json({ error: message });
}

function filterStoryline(role: LiveStreamQuery["role"], storyline: ReturnType<StorylineDesk["list"]>[number]): boolean {
  return role === "studio" || isPublicStoryline(storyline);
}

/**
 * Fan projection of a storyline: producer-approved copy and verified claims only. Agent traces, handoffs,
 * review notes and failure details stay in the studio. Presentation filtering, not access control.
 */
export function projectFanStoryline(storyline: Storyline): Storyline {
  return {
    id: storyline.id,
    matchId: storyline.matchId,
    triggerEventIds: [...storyline.triggerEventIds],
    triggerMinute: storyline.triggerMinute,
    createdAt: storyline.createdAt,
    updatedAt: storyline.updatedAt,
    status: storyline.status,
    priority: storyline.priority,
    headline: storyline.headline,
    onAirLine: storyline.onAirLine,
    overlay: storyline.overlay,
    claims: storyline.claims.filter((claim) => claim.status === "verified").map((claim) => ({ id: claim.id, kind: claim.kind, text: claim.text, sources: claim.sources, status: claim.status })),
    trace: [],
    ...(storyline.review ? { review: { decision: storyline.review.decision, at: storyline.review.at } } : {}),
    ...(storyline.approvedAt ? { approvedAt: storyline.approvedAt } : {}),
    ...(storyline.retractionReason ? { retractionReason: storyline.retractionReason } : {}),
    ...(storyline.insightId ? { insightId: storyline.insightId } : {}),
    ...(storyline.insightRevision !== undefined ? { insightRevision: storyline.insightRevision } : {}),
    ...(storyline.insightStatus ? { insightStatus: storyline.insightStatus } : {}),
    ...(storyline.insightNote ? { insightNote: storyline.insightNote } : {}),
    version: storyline.version,
  };
}

/**
 * Fans only receive facts of approved storylines, plus the retraction of a fact that was already published.
 * A chance revision sends the storyline back to review instead of withdrawing it; that retraction must still
 * reach a connected fan. Never-approved drafts stay off the ticker on bootstrap, reconnect and update.
 */
export function fanFactAllowed(fact: VerifiedFact, storylines: Storyline[]): boolean {
  if (!fact.storylineId) return false;
  const storyline = storylines.find((item) => item.id === fact.storylineId);
  if (!storyline) return false;
  if (storyline.status === "approved") return true;
  return fact.retracted === true
    && Boolean(storyline.approvedAt)
    && (storyline.status === "retracted" || storyline.status === "needs_review");
}

function writeMessage(response: express.Response, message: LiveMessage): boolean {
  return response.write(`data: ${JSON.stringify(message)}\n\n`);
}

function safeCurrent(live: LiveService): LiveMatchView | undefined {
  return live.current();
}

function validateFavoritePlayer(role: LiveStreamQuery["role"], liveFixture: MatchFixture | undefined, favoritePlayerId?: string): void {
  // A fan's saved favourite may simply not play in this match: the snapshot reports it instead of failing.
  if (liveFixture && role === "studio") {
    assertKnownFavoritePlayer(liveFixture, favoritePlayerId);
  }
}

function isKnownPlayer(fixture: MatchFixture, playerId: string): boolean {
  return [...fixture.home.players, ...fixture.away.players].some((player) => player.id === playerId);
}

function withStoryline(storylines: Storyline[], storyline: Storyline): Storyline[] {
  return [...storylines.filter((item) => item.id !== storyline.id), storyline];
}

function tickSource(live: LiveService): TickSource | undefined {
  if ("subscribeTicks" in live && typeof live.subscribeTicks === "function") {
    return live as LiveService & TickSource;
  }
  return undefined;
}

export function createLiveRouter(options: CreateLiveRouterOptions): express.Router {
  const router = express.Router();
  const startLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many live start requests" },
  });
  const maxStreams = options.maxStreams ?? 200;
  const streams = new Set<StreamState>();

  router.get("/api/live/status", (_request, response) => {
    response.json(options.live.status());
  });

  router.get("/api/live/insights", (request, response, next) => {
    try {
      parseStrict(z.object({ role: z.enum(["fan", "studio"]).optional() }).strict(), request.query);
      const current = safeCurrent(options.live);
      response.json(current && options.insights ? options.insights.list(current.matchId) : []);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/live/fixture", (_request, response) => {
    const current = safeCurrent(options.live);
    if (!current) {
      sendJsonError(response, 404, "Live fixture not found");
      return;
    }
    response.json(current.fixture);
  });

  router.post("/api/live/start", startLimiter, async (request, response, next) => {
    try {
      const parsed = parseStrict(startLiveRequestSchema, request.body);
      const status = await options.live.start(parsed);
      response.status(202).json(status);
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/live/stop", async (_request, response, next) => {
    try {
      response.json(await options.live.stop());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/live/correction", async (request, response, next) => {
    try {
      const parsed = parseStrict(correctionSchema, request.body);
      await options.live.publishCorrection(parsed.eventId);
      response.status(202).json(options.live.status());
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/live/stream", (request, response, next) => {
    try {
      if (streams.size >= maxStreams) {
        sendJsonError(response, 503, "Live stream capacity reached");
        return;
      }

      const query = parseStrict(streamQuerySchema, request.query);
      const current = safeCurrent(options.live);
      validateFavoritePlayer(query.role, current?.fixture, query.favoritePlayerId);

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();

      let closed = false;
      let blocked = false;
      let pendingSnapshot = false;
      let lastSnapshotAt = 0;
      let snapshotTimer: NodeJS.Timeout | undefined;
      let unsubscribeLive = () => {};
      let unsubscribeDesk = () => {};
      let unsubscribeInsights = () => {};
      let unsubscribeTick = () => {};
      let streamState: StreamState | undefined;
      const heartbeat = setInterval(() => {
        if (!closed) {
          blocked = !writeMessage(response, { type: "heartbeat", at: new Date().toISOString() }) || blocked;
        }
      }, 15_000);

      const sendSnapshot = () => {
        if (closed || blocked) {
          pendingSnapshot = true;
          return;
        }
        const view = safeCurrent(options.live);
        if (!view) {
          pendingSnapshot = false;
          return;
        }
        const nowMs = Date.now();
        const waitMs = Math.max(0, 500 - (nowMs - lastSnapshotAt));
        if (waitMs > 0) {
          pendingSnapshot = true;
          if (!snapshotTimer) {
            snapshotTimer = setTimeout(() => {
              snapshotTimer = undefined;
              sendSnapshot();
            }, waitMs);
          }
          return;
        }

        validateFavoritePlayer(query.role, view.fixture, query.favoritePlayerId);
        const missingFavorite = query.role === "fan" && query.favoritePlayerId !== undefined && !isKnownPlayer(view.fixture, query.favoritePlayerId);
        const analysisRequest: AnalysisRequest = {
          fixtureId: view.fixture.id,
          atSecond: Math.floor(view.clockSecond),
          persona: query.persona,
          language: query.language,
          favoritePlayerId: missingFavorite ? undefined : query.favoritePlayerId,
          correction: false,
          ...(query.favoriteClubId ? { favoriteClubId: query.favoriteClubId } : {}),
          ...(query.period ? { period: query.period } : {}),
        };
        let snapshot: MatchSnapshot = options.analyzeFixture(view.fixture, analysisRequest);
        if (missingFavorite) {
          snapshot = { ...snapshot, focus: { ...snapshot.focus, favoritePlayerId: query.favoritePlayerId, favoritePlayerInMatch: false } };
        }
        pendingSnapshot = false;
        lastSnapshotAt = nowMs;
        blocked = !writeMessage(response, { type: "snapshot", snapshot, status: options.live.status() });
      };

      const queueSnapshot = () => {
        pendingSnapshot = true;
        sendSnapshot();
      };

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
        }
        unsubscribeLive();
        unsubscribeTick?.();
        unsubscribeDesk();
        unsubscribeInsights();
        if (streamState) {
          streams.delete(streamState);
        }
        response.end();
      };

      response.on("drain", () => {
        blocked = false;
        if (pendingSnapshot) {
          sendSnapshot();
        }
      });
      response.on("close", close);
      request.on("close", close);

      unsubscribeLive = options.live.addListener({
        onMatchStart() {
          if (!closed) {
            blocked = !writeMessage(response, { type: "status", status: options.live.status() }) || blocked;
            queueSnapshot();
          }
        },
        onEvent() {
          queueSnapshot();
        },
        onMatchEnd() {
          if (!closed) {
            blocked = !writeMessage(response, { type: "status", status: options.live.status() }) || blocked;
            queueSnapshot();
          }
        },
      });

      unsubscribeTick = tickSource(options.live)?.subscribeTicks(() => {
        queueSnapshot();
      }) ?? (() => {});

      unsubscribeInsights = options.insights?.subscribe((insight) => {
        const matchId = options.live.status().matchId;
        if (closed || !matchId || insight.matchId !== matchId) {
          return;
        }
        blocked = !writeMessage(response, { type: "insight", insight }) || blocked;
      }) ?? (() => {});

      unsubscribeDesk = options.desk.subscribe((update) => {
        const matchId = options.live.status().matchId;
        if (closed || !matchId) {
          return;
        }
        if (query.role === "studio") {
          if (update.storyline && update.storyline.matchId === matchId) {
            blocked = !writeMessage(response, { type: "storyline", storyline: update.storyline }) || blocked;
          }
          if (update.fact && update.fact.matchId === matchId) {
            blocked = !writeMessage(response, { type: "fact", fact: update.fact }) || blocked;
          }
          return;
        }
        if (update.storyline && update.storyline.matchId === matchId && filterStoryline(query.role, update.storyline)) {
          const storyline = update.storyline;
          blocked = !writeMessage(response, { type: "storyline", storyline: projectFanStoryline(storyline) }) || blocked;
          // Facts drafted before approval were withheld; release them now that the producer approved the storyline.
          const storylines = withStoryline(options.desk.list(matchId), storyline);
          for (const fact of options.desk.facts(matchId)) {
            if (fact.storylineId === storyline.id && fanFactAllowed(fact, storylines)) {
              blocked = !writeMessage(response, { type: "fact", fact }) || blocked;
            }
          }
        }
        if (update.fact && update.fact.matchId === matchId) {
          const storylines = update.storyline ? withStoryline(options.desk.list(matchId), update.storyline) : options.desk.list(matchId);
          if (fanFactAllowed(update.fact, storylines)) {
            blocked = !writeMessage(response, { type: "fact", fact: update.fact }) || blocked;
          }
        }
      });

      streamState = { response, close };
      streams.add(streamState);

      blocked = !writeMessage(response, { type: "status", status: options.live.status() });
      if (current) {
        queueSnapshot();
        const storylines = options.desk.list(current.matchId);
        for (const storyline of storylines) {
          if (filterStoryline(query.role, storyline)) {
            blocked = !writeMessage(response, { type: "storyline", storyline: query.role === "fan" ? projectFanStoryline(storyline) : storyline }) || blocked;
          }
        }
        for (const fact of options.desk.facts(current.matchId)) {
          if (query.role === "studio" || fanFactAllowed(fact, storylines)) {
            blocked = !writeMessage(response, { type: "fact", fact }) || blocked;
          }
        }
        for (const insight of options.insights?.list(current.matchId) ?? []) {
          blocked = !writeMessage(response, { type: "insight", insight }) || blocked;
        }
      }
    } catch (error) {
      next(error);
    }
  });

  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (isHttpError(error)) {
      sendJsonError(response, error.status, error.message);
      return;
    }
    next(error);
  });

  return router;
}
