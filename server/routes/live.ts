import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import type { LiveMessage, LiveStreamQuery, StartLiveRequest } from "../../shared/platform.js";
import type { AnalysisRequest, MatchFixture } from "../../shared/types.js";
import type { AnalyzeFixture, LiveMatchView, LiveService, StorylineDesk } from "../contracts.js";
import { type TickSource } from "../live/service.js";
import { HttpError, assertKnownFavoritePlayer, isHttpError } from "../validation.js";

type CreateLiveRouterOptions = {
  live: LiveService;
  desk: StorylineDesk;
  analyzeFixture: AnalyzeFixture;
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
  language: z.enum(["en", "es", "fr"]),
  favoritePlayerId: boundedId.optional(),
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
  return role === "studio" || storyline.status === "approved" || storyline.status === "retracted";
}

function writeMessage(response: express.Response, message: LiveMessage): boolean {
  return response.write(`data: ${JSON.stringify(message)}\n\n`);
}

function safeCurrent(live: LiveService): LiveMatchView | undefined {
  return live.current();
}

function validateFavoritePlayer(liveFixture: MatchFixture | undefined, favoritePlayerId?: string): void {
  if (liveFixture) {
    assertKnownFavoritePlayer(liveFixture, favoritePlayerId);
  }
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
      validateFavoritePlayer(current?.fixture, query.favoritePlayerId);

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

        validateFavoritePlayer(view.fixture, query.favoritePlayerId);
        const analysisRequest: AnalysisRequest = {
          fixtureId: view.fixture.id,
          atSecond: Math.floor(view.clockSecond),
          persona: query.persona,
          language: query.language,
          favoritePlayerId: query.favoritePlayerId,
          correction: false,
        };
        const snapshot = options.analyzeFixture(view.fixture, analysisRequest);
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

      unsubscribeDesk = options.desk.subscribe((update) => {
        const matchId = options.live.status().matchId;
        if (closed || !matchId) {
          return;
        }
        if (update.storyline && update.storyline.matchId === matchId && filterStoryline(query.role, update.storyline)) {
          blocked = !writeMessage(response, { type: "storyline", storyline: update.storyline }) || blocked;
        }
        if (update.fact && update.fact.matchId === matchId) {
          blocked = !writeMessage(response, { type: "fact", fact: update.fact }) || blocked;
        }
      });

      streamState = { response, close };
      streams.add(streamState);

      blocked = !writeMessage(response, { type: "status", status: options.live.status() });
      if (current) {
        queueSnapshot();
        for (const storyline of options.desk.list(current.matchId)) {
          if (filterStoryline(query.role, storyline)) {
            blocked = !writeMessage(response, { type: "storyline", storyline }) || blocked;
          }
        }
        for (const fact of options.desk.facts(current.matchId)) {
          blocked = !writeMessage(response, { type: "fact", fact }) || blocked;
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
