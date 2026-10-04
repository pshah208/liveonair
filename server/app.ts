import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import type {
  AnalysisRequest,
  AppHealth,
  FixtureSummary,
  MatchFixture,
  MatchSnapshot,
  NarrativeRequest,
} from "../shared/types.js";
import { createNarrator, hashInlineScript, type Narrator } from "./narrator.js";
import { analyzeFixture, analyzeMatch } from "./engine.js";
import { getFixture, listFixtures, registerFixture } from "./fixtures.js";
import { generateMatch } from "./matchlab/generator.js";
import { createPlatform, type Platform } from "./platform.js";
import { createArchiveRouter } from "./routes/archive.js";
import { createLiveRouter } from "./routes/live.js";
import { createStudioRouter } from "./routes/studio.js";
import {
  HttpError,
  assertFixtureWindow,
  assertKnownFavoritePlayer,
  assertKnownStory,
  isHttpError,
  parseAnalysisRequest,
  parseNarrativeRequest,
} from "./validation.js";

export type EngineAdapter = {
  getFixture(id: string): MatchFixture;
  listFixtures(): FixtureSummary[];
  analyzeMatch(request: AnalysisRequest): MatchSnapshot;
};

type CreateAppOptions = {
  narrator?: Narrator;
  engine?: EngineAdapter;
  platform?: Platform;
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
  app.use(express.json({ limit: "16kb" }));

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
      response.json(narrative);
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
      });
      const fixture = deepClone(view.fixture);
      const snapshot = analyzeFixture(fixture, { ...parsed, correction: false });
      const narrative = await narrator.narrate(parsed, snapshot, {
        requestId: response.locals.requestId as string,
        fixture,
      });
      response.json(narrative);
    } catch (error) {
      next(error);
    }
  });

  app.use(createLiveRouter({ live: platform.live, desk: platform.desk, analyzeFixture }));
  app.use(createStudioRouter({ desk: platform.desk, live: platform.live }));

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
      sendJsonError(response, 413, "JSON body exceeds the 16kb limit");
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
