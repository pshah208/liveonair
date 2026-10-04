import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import type { FixtureRegistry, GenerateMatch } from "../contracts.js";
import { getArchive, getClub, getPlayerProfile } from "../archive/index.js";
import { HttpError } from "../validation.js";

const archiveIdSchema = z.string().trim().regex(/^per-[a-z0-9-]+$/u, "archiveId must be a valid synthetic person id");
const generateSchema = z.object({
  scenario: z.enum(["comeback", "red_card", "set_piece", "late_winner", "goal_fest"]),
  seed: z.number().int().min(1).max(1_000_000_000),
  homeClubId: z.string().trim().optional(),
  awayClubId: z.string().trim().optional(),
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

function withErrorBoundary(handler: (request: Request, response: Response) => void | Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      await handler(request, response);
    } catch (error) {
      next(error);
    }
  };
}

export function createArchiveRouter(deps: { registry: FixtureRegistry; generateMatch: GenerateMatch }): express.Router {
  const router = express.Router();
  const generateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many matchlab generate requests" },
  });

  router.get("/api/archive/summary", withErrorBoundary((_request, response) => {
    const archive = getArchive();
    response.json({
      version: archive.version,
      clubs: archive.clubs,
      peopleCount: archive.people.length,
      matchCount: archive.matches.length,
      documentCount: archive.documents.length,
    });
  }));

  router.get("/api/archive/players/:archiveId", withErrorBoundary((request, response) => {
    const archiveId = parseStrict(archiveIdSchema, request.params.archiveId);
    try {
      response.json(getPlayerProfile(archiveId));
    } catch (error) {
      if (error instanceof RangeError) {
        throw new HttpError(404, "Archive player not found");
      }
      throw error;
    }
  }));

  router.get("/api/archive/export", withErrorBoundary((_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(getArchive());
  }));

  router.post("/api/matchlab/generate", generateLimiter, withErrorBoundary((request, response) => {
    const parsed = parseStrict(generateSchema, request.body);
    if (parsed.homeClubId) {
      try {
        getClub(parsed.homeClubId);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new HttpError(400, "homeClubId must be a known archive club id");
        }
        throw error;
      }
    }
    if (parsed.awayClubId) {
      try {
        getClub(parsed.awayClubId);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new HttpError(400, "awayClubId must be a known archive club id");
        }
        throw error;
      }
    }
    if (parsed.homeClubId && parsed.awayClubId && parsed.homeClubId === parsed.awayClubId) {
      throw new HttpError(400, "homeClubId and awayClubId must be distinct");
    }

    const fixture = deps.generateMatch(parsed);
    const summary = deps.registry.registerFixture(fixture);
    response.status(201).json(summary);
  }));

  return router;
}
