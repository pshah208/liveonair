import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import type {
  AnalysisRequest,
  AppHealth,
  FixtureSummary,
  Language,
  MatchFixture,
  MatchSnapshot,
  NarrativeRequest,
} from "../shared/types.js";
import { createNarrator, createCompletionClientFromEnv, hashInlineScript, type Narrator } from "./narrator.js";
import { createPostMatchNarrator, createPostMatchNarratorFromEnv, type PostMatchNarrator } from "./narrative/postmatch.js";
import { commentaryRequestSchema, createCommentator, type Commentator } from "./commentary.js";
import { createPlayerAnalyst, type PlayerAnalyst } from "./players/analyst.js";
import { z } from "zod";
import { createSpeechService, type SpeechService } from "./speech.js";
import { analyzeFixture, analyzeMatch } from "./engine.js";
import { getFixture, listFixtures, registerFixture, unregisterFixture } from "./fixtures.js";
import { generateMatch } from "./matchlab/generator.js";
import { createPlatform, type Platform } from "./platform.js";
import { createArchiveRouter } from "./routes/archive.js";
import { createLiveRouter } from "./routes/live.js";
import { createOverlayRouter } from "./routes/overlay.js";
import { createStudioAuth, studioAuthRequired } from "./routes/studioAuth.js";
import { createStudioRouter } from "./routes/studio.js";
import { createA2aRouter } from "./a2a/index.js";
import { getArchive } from "./archive/index.js";
import { createArchiveRetrievalFromEnv } from "./desk/retrieval.js";
import { createMcpRouter } from "./mcp/index.js";
import { createVideoRouter } from "./routes/video.js";
import { createProgressiveVideoRouter, isProgressiveFrameRequest, PROGRESSIVE_BODY_LIMIT } from "./routes/progressiveVideo.js";
import { createProgressiveVideoService } from "./video/progressive.js";
import { createPlayerCamRouter } from "./routes/playercam.js";
import { createPlayerVisionAnalyzer, type PlayerVisionAnalyzer } from "./video/playerVision.js";
import { createPlayerCamWorker, type PlayerCamWorker } from "./video/playerWorker.js";
import type { RunCommand } from "./video/ffmpeg.js";
import { createVisionAnalyzerFromEnv, createVisionCallerFromEnv, type VisionAnalyzer } from "./video/vision.js";
import { createVideoWorker, type VideoWorker } from "./video/worker.js";
import {
  HttpError,
  assertFixtureWindow,
  assertKnownFavoritePlayer,
  assertKnownStory,
  isHttpError,
  parseAnalysisRequest,
  parseNarrativeRequest,
  parseStrict,
} from "./validation.js";

export type EngineAdapter = {
  getFixture(id: string): MatchFixture;
  listFixtures(): FixtureSummary[];
  analyzeMatch(request: AnalysisRequest): MatchSnapshot;
};

type CreateAppOptions = {
  narrator?: Narrator;
  /** Injected so tests never construct an Azure client for post-match storylines. */
  postMatch?: PostMatchNarrator;
  speech?: SpeechService;
  commentator?: Commentator;
  playerAnalyst?: PlayerAnalyst;
  engine?: EngineAdapter;
  platform?: Platform;
  /** Undefined reads STUDIO_TOKEN. Empty string forces local-dev open mode. */
  studioToken?: string;
  video?: { vision?: VisionAnalyzer; worker?: VideoWorker; run?: RunCommand; playerVision?: PlayerVisionAnalyzer; playerWorker?: PlayerCamWorker };
  staticDir?: string;
  logger?: (entry: { level: "error"; requestId: string; reason: string; path: string }) => void;
  version?: string;
};

type StaticMeta = {
  indexPath: string;
  scriptHashes: string[];
};

function defaultLogger(entry: { level: "error"; requestId: string; reason: string; path: string }) {
  console.error(JSON.stringify(entry));
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function readPackageVersion(): string {
  const content = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string") {
    throw new Error("package.json must declare a version");
  }
  return value.version;
}

function createStaticMeta(staticDir: string): StaticMeta {
  const indexPath = resolve(staticDir, "index.html");
  try {
    statSync(indexPath);
    const html = readFileSync(indexPath, "utf8");
    const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)]
      .map((match) => match[1]).filter((script) => script.trim().length > 0);
    return {
      indexPath,
      scriptHashes: inlineScripts.map((script) => hashInlineScript(script)),
    };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    return {
      indexPath,
      scriptHashes: [],
    };
  }
}

function createEngineResolver(engine?: EngineAdapter) {
  const adapter = engine ?? { getFixture, listFixtures, analyzeMatch };
  return async (): Promise<EngineAdapter> => adapter;
}

function sendJsonError(response: Response, status: number, message: string): void {
  response.status(status).json({ error: message });
}

function ensureFixture(engine: EngineAdapter, fixtureId: string): MatchFixture {
  try {
    return deepClone(engine.getFixture(fixtureId));
  } catch (error) {
    if (error instanceof RangeError) {
      throw new HttpError(404, "Fixture not found");
    }
    throw error;
  }
}

function healthResponse(narrator: Narrator, version: string): AppHealth {
  return {
    status: "ok",
    ai: narrator.health(),
    version,
  };
}

function buildCspHeader(staticMeta: StaticMeta): string {
  const scriptSrc = ["'self'", ...staticMeta.scriptHashes.map((hash) => `'${hash}'`)].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // Local footage is played from an object URL; it never leaves the browser.
    "media-src 'self' blob:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const narrator = options.narrator ?? createNarrator();
  // Same rule as speech and commentary: an injected narrator means this process must not open Azure clients.
  const postMatch = options.postMatch ?? (options.narrator ? createPostMatchNarrator() : createPostMatchNarratorFromEnv());
  // Tests that inject a narrator get no speech unless they inject it too, so they never reach Azure.
  const speech = options.speech ?? (options.narrator ? createSpeechService({ endpoint: "" }) : createSpeechService());
  const voiceRecap = (script: string, language: Language) => {
    const audioUrl = speech.register(script, language, "calm");
    if (audioUrl) speech.warm?.(audioUrl);
    return audioUrl;
  };
  // Tests that inject a narrator get a rules-only analyst unless they inject one, so they never reach Foundry.
  const playerAnalyst = options.playerAnalyst ?? createPlayerAnalyst({ endpoint: options.narrator ? undefined : process.env.PROJECT_ENDPOINT });
  const commentator = options.commentator ?? createCommentator({
    completion: options.narrator ? undefined : createCompletionClientFromEnv(),
    speech,
  });
  const getEngine = createEngineResolver(options.engine);
  const staticDir = options.staticDir ?? resolve(process.cwd(), "dist", "client");
  const staticMeta = createStaticMeta(staticDir);
  const version = options.version ?? readPackageVersion();
  const logger = options.logger ?? defaultLogger;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((request, response, next) => {
    const requestId = request.header("x-request-id")?.slice(0, 120) || randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    next();
  });

  app.use((request, response, next) => {
    response.setHeader("Content-Security-Policy", buildCspHeader(staticMeta));
    next();
  });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  const smallJson = express.json({ limit: "16kb" });
  const frameJson = express.json({ limit: PROGRESSIVE_BODY_LIMIT });
  app.use((request, response, next) => {
    const frames = isProgressiveFrameRequest(request);
    response.locals.jsonBodyLimit = frames ? PROGRESSIVE_BODY_LIMIT : "16kb";
    (frames ? frameJson : smallJson)(request, response, next);
  });

  const analyzeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many analyze requests" },
  });
  const narrateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many narration requests" },
  });
  // Separate from the narrate limiter. Distributed cost is bounded in the narrator
  // (one scout per match, one generation per phase bucket, language and persona).
  const storylineLimiter = rateLimit({
    windowMs: 60_000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many storyline requests" },
  });

  app.get("/api/health", (_request, response) => {
    response.json(healthResponse(narrator, version));
  });

  app.get("/api/fixtures", async (_request, response, next) => {
    try {
      const engine = await getEngine();
      response.json(deepClone(engine.listFixtures()));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/fixtures/:id", async (request, response, next) => {
    try {
      const engine = await getEngine();
      response.json(ensureFixture(engine, request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/analyze", analyzeLimiter, async (request, response, next) => {
    try {
      const parsed = parseAnalysisRequest(request.body);
      const engine = await getEngine();
      const fixture = ensureFixture(engine, parsed.fixtureId);
      assertFixtureWindow(fixture, parsed.atSecond);
      assertKnownFavoritePlayer(fixture, parsed.favoritePlayerId);
      response.json(deepClone(engine.analyzeMatch(parsed)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/narrate", narrateLimiter, async (request, response, next) => {
    try {
      const parsed = parseNarrativeRequest(request.body);
      if (!narrator.health().configured) {
        throw new HttpError(503, "AI narration is not configured");
      }

      const engine = await getEngine();
      const fixture = ensureFixture(engine, parsed.fixtureId);
      assertFixtureWindow(fixture, parsed.atSecond);
      assertKnownFavoritePlayer(fixture, parsed.favoritePlayerId);

      const snapshot = deepClone(engine.analyzeMatch(parsed));
      assertKnownStory(snapshot, parsed.storyId);
      const narrative = await narrator.narrate(parsed, snapshot, {
        requestId: response.locals.requestId as string,
        fixture,
      });
      response.json({ ...narrative, audioUrl: voiceRecap(narrative.script, parsed.language) });
    } catch (error) {
      next(error);
    }
  });

  app.use(createArchiveRouter({ registry: { listFixtures, getFixture, registerFixture }, generateMatch }));
  const platform = options.platform ?? createPlatform();

  // Recap of the current live match, narrated from the live view so every correction applies.
  app.post("/api/live/narrate", narrateLimiter, async (request, response, next) => {
    try {
      if (!narrator.health().configured) {
        throw new HttpError(503, "AI narration is not configured");
      }
      const view = platform.live.current();
      if (!view) {
        throw new HttpError(404, "Live match not found");
      }
      const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
      const status = platform.live.status();
      const atSecond = status.state === "running"
        ? Math.min(view.fixture.durationSeconds, Math.max(0, Math.round(status.clockSecond)))
        : view.fixture.durationSeconds;
      const parsed = parseNarrativeRequest({
        fixtureId: view.fixture.id,
        atSecond,
        persona: body.persona,
        language: body.language,
        format: "recap",
        ...(body.period === undefined ? {} : { period: body.period }),
        ...(body.favoritePlayerId === undefined ? {} : { favoritePlayerId: body.favoritePlayerId }),
        ...(body.favoriteClubId === undefined ? {} : { favoriteClubId: body.favoriteClubId }),
      });
      const fixture = deepClone(view.fixture);
      assertKnownFavoritePlayer(fixture, parsed.favoritePlayerId);
      const snapshot = analyzeFixture(fixture, { ...parsed, correction: false });
      const narrative = await narrator.narrate(parsed, snapshot, {
        requestId: response.locals.requestId as string,
        fixture,
        storylines: platform.desk.list(view.matchId),
      });
      response.json({ ...narrative, audioUrl: voiceRecap(narrative.script, parsed.language) });
    } catch (error) {
      next(error);
    }
  });

  const postMatchRequestSchema = z.object({
    language: z.enum(["en", "es", "fr", "pt"]).default("en"),
    persona: z.enum(["analyst", "casual", "player"]).default("analyst"),
    favoriteClubId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9:_.-]+$/u).optional(),
    favouriteClubId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9:_.-]+$/u).optional(),
    favoritePlayerId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_.-]+$/u).optional(),
    favouritePlayerId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_.-]+$/u).optional(),
  }).strict();

  // Post-match storylines. Separate from /api/live/narrate so the existing recap contract stays stable.
  app.post("/api/live/storylines/postmatch", storylineLimiter, async (request, response, next) => {
    try {
      if (!postMatch.configured) {
        throw new HttpError(503, "AI narration is not configured");
      }
      const body = parseStrict(postMatchRequestSchema, request.body ?? {});
      if (body.favoriteClubId && body.favouriteClubId && body.favoriteClubId !== body.favouriteClubId) {
        throw new HttpError(400, "favoriteClubId and favouriteClubId must match");
      }
      if (body.favoritePlayerId && body.favouritePlayerId && body.favoritePlayerId !== body.favouritePlayerId) {
        throw new HttpError(400, "favoritePlayerId and favouritePlayerId must match");
      }
      const favoriteClubId = body.favoriteClubId ?? body.favouriteClubId;
      const favoritePlayerId = body.favoritePlayerId ?? body.favouritePlayerId;
      const status = platform.live.status();
      if (status.state !== "running" && status.state !== "finished") {
        throw new HttpError(409, "Post-match storylines are available once a match is running or finished");
      }
      const view = platform.live.current();
      if (!view) {
        throw new HttpError(404, "Live match not found");
      }
      const fixture = deepClone(view.fixture);
      assertKnownFavoritePlayer(fixture, favoritePlayerId);
      const phase = status.state === "finished" ? "postmatch" : "so_far";
      const atSecond = status.state === "running"
        ? Math.min(fixture.durationSeconds, Math.max(0, Math.round(status.clockSecond)))
        : fixture.durationSeconds;
      const snapshot = analyzeFixture(fixture, {
        fixtureId: fixture.id,
        atSecond,
        persona: body.persona,
        language: body.language,
        correction: false,
        ...(favoritePlayerId ? { favoritePlayerId } : {}),
        ...(favoriteClubId ? { favoriteClubId } : {}),
      });
      const chanceInsights = (platform.insights?.list(view.matchId) ?? [])
        .filter((insight) => insight.status !== "withdrawn" && insight.summaryFacts.length > 0)
        .map((insight) => ({
          id: insight.insightId,
          text: insight.summaryFacts.join(" "),
          evidenceIds: insight.evidenceEventIds.map((ref) => ref.eventId),
        }));
      const result = await postMatch.generate({
        fixture,
        snapshot,
        language: body.language,
        persona: body.persona,
        phase,
        matchId: view.matchId,
        ...(favoriteClubId ? { favoriteClubId } : {}),
        ...(favoritePlayerId ? { favoritePlayerId } : {}),
        approvedStorylines: platform.desk.list(view.matchId),
        ...(chanceInsights.length > 0 ? { chanceInsights } : {}),
      }, { requestId: response.locals.requestId as string });
      const audioUrl = voiceRecap(`${result.headline}. ${result.summary}`, body.language);
      console.info(JSON.stringify({
        level: "info",
        event: "postmatch_storylines",
        requestId: response.locals.requestId,
        phase: result.phase,
        language: result.language,
        source: result.source,
        web: result.webContext.status,
        storylines: result.storylines.length,
      }));
      response.json(audioUrl ? { ...result, audioUrl } : result);
    } catch (error) {
      next(error);
    }
  });

  // Scouting note for one player of the live match, from event-derived statistics.
  app.post("/api/live/players/:playerId/analysis", narrateLimiter, async (request, response, next) => {
    try {
      const view = platform.live.current();
      if (!view) throw new HttpError(404, "Live match not found");
      const playerId = parseStrict(z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_.-]+$/u), request.params.playerId);
      const body = parseStrict(z.object({ language: z.enum(["en", "es", "fr", "pt"]).default("en"), period: z.enum(["full", "first", "second"]).default("full") }).strict(), request.body ?? {});
      const fixture = deepClone(view.fixture);
      const status = platform.live.status();
      const clock = status.state === "running" ? Math.max(0, Math.round(status.clockSecond)) : fixture.durationSeconds;
      response.json(await playerAnalyst.write(fixture, playerId, body.language, clock, body.period));
    } catch (error) {
      next(error);
    }
  });

  // Spoken highlights commentaryfor the live match's reel, grounded in the live view's events.
  app.post("/api/live/highlights/commentary", narrateLimiter, async (request, response, next) => {
    try {
      if (!commentator.configured) {
        throw new HttpError(503, "Highlights commentary is not configured");
      }
      const parsed = parseStrict(commentaryRequestSchema, request.body);
      const view = platform.live.current();
      if (!view) {
        throw new HttpError(404, "Live match not found");
      }
      const fixture = deepClone(view.fixture);
      const commentary = await commentator.write(parsed, fixture, platform.desk.list(view.matchId), response.locals.requestId as string);
      response.json(commentary);
    } catch (error) {
      next(error);
    }
  });

  const audioLimiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many audio requests" },
  });
  app.get("/api/audio/:file", audioLimiter, async (request, response, next) => {
    try {
      const match = /^([a-f0-9]{32})\.mp3$/u.exec(String(request.params.file));
      if (!match) {
        throw new HttpError(404, "Audio not found");
      }
      const audio = await speech.synthesize(match[1]);
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("Cache-Control", "private, max-age=3600, immutable");
      response.send(audio);
    } catch (error) {
      next(error);
    }
  });

  const studioToken = options.studioToken ?? process.env.STUDIO_TOKEN;
  app.use(createStudioAuth(studioToken));
  app.use(createLiveRouter({ live: platform.live, desk: platform.desk, analyzeFixture, insights: platform.insights }));
  app.use(createStudioRouter({ desk: platform.desk, live: platform.live, authRequired: studioAuthRequired(studioToken) }));
  app.use(createOverlayRouter({ live: platform.live, desk: platform.desk }));
  app.use(createMcpRouter({
    live: platform.live, desk: platform.desk, analyzeFixture, archive: getArchive(),
    retrieval: createArchiveRetrievalFromEnv(), version, token: process.env.MCP_TOKEN || undefined,
    insights: platform.insights,
  }));
  app.use(createA2aRouter({ live: platform.live, desk: platform.desk, version, token: process.env.A2A_TOKEN || undefined }));

  const visionCaller = createVisionCallerFromEnv();
  const vision = options.video?.vision ?? createVisionAnalyzerFromEnv(process.env, visionCaller);
  app.use(createProgressiveVideoRouter(createProgressiveVideoService({
    vision, live: platform.live, registerFixture, unregisterFixture,
    logger: ({ sessionId, reason }) => logger({
      level: "error", requestId: sessionId, reason, path: "/api/video/live-sessions",
    }),
  })));
  const videoWorker = options.video?.worker ?? createVideoWorker({
    vision,
    registerFixture,
    unregisterFixture,
    workRoot: resolve(tmpdir(), `matchlens-video-${process.pid}`),
  });
  app.use(createVideoRouter({ worker: videoWorker, live: platform.live, visionConfigured: vision.configured, run: options.video?.run }));

  const playerVision = options.video?.playerVision ?? createPlayerVisionAnalyzer(visionCaller);
  const playerWorker = options.video?.playerWorker ?? createPlayerCamWorker({
    vision: playerVision,
    workRoot: resolve(tmpdir(), `matchlens-playercam-${process.pid}`),
  });
  app.use(createPlayerCamRouter({ worker: playerWorker, visionConfigured: playerVision.configured, run: options.video?.run }));

  app.use("/api", (_request, response) => {
    sendJsonError(response, 404, "Not found");
  });

  app.use(express.static(staticDir, { index: false, fallthrough: true, redirect: false }));

  app.get(/^(?!\/api(?:\/|$)).*$/u, (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    response.sendFile(staticMeta.indexPath, (error) => {
      if (error) {
        next(error);
      }
    });
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
      sendJsonError(response, 413, `JSON body exceeds the ${String(response.locals.jsonBodyLimit ?? "16kb")} limit`);
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      sendJsonError(response, 400, "Malformed JSON body");
      return;
    }

    if (error instanceof RangeError) {
      sendJsonError(response, 404, "Fixture not found");
      return;
    }

    if (isHttpError(error)) {
      logger({
        level: "error",
        requestId: (response.locals.requestId as string | undefined) ?? "unknown",
        reason: error.message,
        path: request.path,
      });
      sendJsonError(response, error.status, error.message);
      return;
    }

    logger({
      level: "error",
      requestId: (response.locals.requestId as string | undefined) ?? "unknown",
      reason: "Unexpected server error",
      path: request.path,
    });
    sendJsonError(response, 503, "Service unavailable");
  });

  return app;
}
