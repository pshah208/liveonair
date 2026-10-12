import { rm } from "node:fs/promises";
import path from "node:path";

import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { runCommand, type RunCommand } from "../video/ffmpeg.js";
import { MAX_VIDEO_SECONDS } from "../../shared/video.js";
import type { PlayerCamWorker } from "../video/playerWorker.js";
import { HttpError } from "../validation.js";
import { conflictTo409, createFfmpegCheck, jobIdSchema, kitSchema, nameSchema, parseOr400, uploadExtension, writeUpload } from "./video.js";

const optionalNumber = (min: number, max: number) => z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number().min(min).max(max).optional());

const uploadQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(120),
  playerName: nameSchema,
  number: z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number().int().min(1).max(99).optional()),
  kit: kitSchema.default(""),
  anchorSecond: optionalNumber(0, MAX_VIDEO_SECONDS),
  anchorX: optionalNumber(0, 1),
  anchorY: optionalNumber(0, 1),
}).strict().superRefine((value, context) => {
  const anchorParts = [value.anchorSecond, value.anchorX, value.anchorY].filter((part) => part !== undefined).length;
  if (anchorParts !== 0 && anchorParts !== 3) context.addIssue({ code: z.ZodIssueCode.custom, message: "anchorSecond, anchorX and anchorY go together", path: ["anchorSecond"] });
  if (anchorParts === 0 && value.number === undefined && !value.kit) context.addIssue({ code: z.ZodIssueCode.custom, message: "click the player, or give a shirt number or kit so the worker can find them", path: ["number"] });
});

type CreatePlayerCamRouterOptions = {
  worker: PlayerCamWorker;
  visionConfigured: boolean;
  run?: RunCommand;
};

export function createPlayerCamRouter(options: CreatePlayerCamRouterOptions): express.Router {
  const router = express.Router();
  const checkFfmpeg = createFfmpegCheck(options.run ?? runCommand);
  const uploadLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { error: "Too many video uploads; try again in a few minutes" } });

  router.post("/api/player-cam/jobs", uploadLimiter, async (request, response, next) => {
    let jobDirectory: string | undefined;
    try {
      if (!options.visionConfigured) throw new HttpError(503, "Video analysis is not configured on this server");
      if (!(await checkFfmpeg())) throw new HttpError(503, "ffmpeg is not available on this server");
      const extension = uploadExtension(request);
      const query = parseOr400(uploadQuerySchema, request.query);
      const jobId = options.worker.newJobId();
      jobDirectory = options.worker.jobDirectory(jobId);
      const sourcePath = path.join(jobDirectory, `source.${extension}`);
      const sizeBytes = await writeUpload(request, sourcePath);
      const job = options.worker.submit({
        jobId,
        sourcePath,
        fileName: path.basename(query.fileName).slice(0, 120),
        sizeBytes,
        request: {
          name: query.playerName,
          number: query.number ?? null,
          kit: query.kit,
          anchor: query.anchorSecond !== undefined ? { second: query.anchorSecond, x: query.anchorX!, y: query.anchorY! } : null,
        },
      });
      response.status(202).json(job);
    } catch (error) {
      if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (!response.headersSent && error instanceof HttpError && error.status === 413) response.setHeader("Connection", "close");
      next(error);
    }
  });

  router.get("/api/player-cam/jobs", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(options.worker.list());
  });

  router.get("/api/player-cam/jobs/:id", (request, response, next) => {
    try {
      const job = options.worker.get(parseOr400(jobIdSchema, request.params.id));
      if (!job) throw new HttpError(404, "Player cam job not found");
      response.setHeader("Cache-Control", "no-store");
      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  const sendJpeg = (response: express.Response, next: express.NextFunction, file: string | undefined) => {
    if (!file) throw new HttpError(404, "Image not found");
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.type("jpeg").sendFile(file, (error) => { if (error && !response.headersSent) next(new HttpError(404, "Image not found")); });
  };

  router.get("/api/player-cam/jobs/:id/frames/:index", (request, response, next) => {
    try {
      const id = parseOr400(jobIdSchema, request.params.id);
      const index = parseOr400(z.coerce.number().int().min(0).max(999), request.params.index);
      sendJpeg(response, next, options.worker.frameFile(id, index));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/player-cam/jobs/:id/reference", (request, response, next) => {
    try {
      sendJpeg(response, next, options.worker.referenceFile(parseOr400(jobIdSchema, request.params.id)));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/player-cam/jobs/:id", async (request, response, next) => {
    try {
      const id = parseOr400(jobIdSchema, request.params.id);
      if (!options.worker.get(id)) throw new HttpError(404, "Player cam job not found");
      await options.worker.remove(id);
      response.status(204).end();
    } catch (error) {
      next(conflictTo409(error));
    }
  });

  return router;
}
