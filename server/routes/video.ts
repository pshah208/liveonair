import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import type { LiveService } from "../contracts.js";
import { DETECTABLE_EVENT_TYPES, type VideoJob } from "../../shared/video.js";
import { runCommand, type RunCommand } from "../video/ffmpeg.js";
import { MAX_VIDEO_SECONDS, VideoJobConflict, type VideoWorker } from "../video/worker.js";
import { HttpError } from "../validation.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const nameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} .'&-]+$/u, "use letters, numbers, spaces and . ' & -");
const kitSchema = z.string().trim().max(60).regex(/^[\p{L}\p{N} ,.'/-]*$/u, "use letters, numbers, spaces and , . ' / -");

const uploadQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(120),
  homeName: nameSchema,
  homeKit: kitSchema.default(""),
  awayName: nameSchema,
  awayKit: kitSchema.default(""),
}).strict();

const jobIdSchema = z.string().regex(/^[a-f0-9]{12}$/u);

const tagSchema = z.object({
  type: z.enum(DETECTABLE_EVENT_TYPES),
  team: z.enum(["home", "away"]),
  second: z.number().int().min(0).max(MAX_VIDEO_SECONDS),
  shirtNumber: z.number().int().min(1).max(99).nullable().optional(),
  note: z.string().max(120).regex(/^[\p{L}\p{N} ,.'!?#()&/:-]*$/u, "use letters, numbers and basic punctuation").optional(),
}).strict();

type CreateVideoRouterOptions = {
  worker: VideoWorker;
  live: LiveService;
  visionConfigured: boolean;
  run?: RunCommand;
};

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  }
  return result.data;
}

/** Counts bytes as they stream to disk and aborts as soon as the cap is passed. */
function byteLimit(limit: number, onBytes: (total: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      onBytes(total);
      if (total > limit) callback(new HttpError(413, `The video is larger than ${Math.round(limit / 1_048_576)} MB.`));
      else callback(null, chunk);
    },
  });
}

function conflictTo409(error: unknown): unknown {
  return error instanceof VideoJobConflict ? new HttpError(409, error.message) : error;
}

export function createVideoRouter(options: CreateVideoRouterOptions): express.Router {
  const router = express.Router();
  const run = options.run ?? runCommand;
  let ffmpegAvailable: Promise<boolean> | null = null;
  const checkFfmpeg = () => (ffmpegAvailable ??= run("ffmpeg", ["-hide_banner", "-version"]).then(() => true, () => false));

  const uploadLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { error: "Too many video uploads; try again in a few minutes" } });

  /** A job that exists, is processed and isn't currently streaming, so its fixture can be rebuilt. */
  function editableJob(rawId: unknown, action: string): VideoJob {
    const id = parseOr400(jobIdSchema, rawId);
    const job = options.worker.get(id);
    if (!job) throw new HttpError(404, "Video job not found");
    const status = options.live.status();
    if (status.state === "running" && status.fixtureId === job.fixtureId) throw new HttpError(409, `Stop the live stream before ${action}`);
    if (job.stage !== "ready") throw new HttpError(409, "The video has not finished processing");
    return job;
  }

  router.get("/api/video/health", async (_request, response) => {
    response.json({ visionConfigured: options.visionConfigured, ffmpeg: await checkFfmpeg(), maxUploadBytes: MAX_UPLOAD_BYTES });
  });

  router.post("/api/video/jobs", uploadLimiter, async (request, response, next) => {
    let jobDirectory: string | undefined;
    try {
      if (!options.visionConfigured) throw new HttpError(503, "Video analysis is not configured on this server");
      if (!(await checkFfmpeg())) throw new HttpError(503, "ffmpeg is not available on this server");
      const contentType = (request.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const extension = CONTENT_TYPES[contentType];
      if (!extension) throw new HttpError(415, "Upload an MP4, MOV or WebM video");
      const declared = Number(request.header("content-length") ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, `The video is larger than ${MAX_UPLOAD_BYTES / 1_048_576} MB.`);
      const query = parseOr400(uploadQuerySchema, request.query);

      const jobId = options.worker.newJobId();
      jobDirectory = options.worker.jobDirectory(jobId);
      await mkdir(jobDirectory, { recursive: true });
      const sourcePath = path.join(jobDirectory, `source.${extension}`);
      let sizeBytes = 0;
      await pipeline(request, byteLimit(MAX_UPLOAD_BYTES, (total) => { sizeBytes = total; }), createWriteStream(sourcePath));
      if (sizeBytes === 0) throw new HttpError(400, "The upload was empty");

      const job = options.worker.submit({
        jobId,
        sourcePath,
        fileName: path.basename(query.fileName).slice(0, 120),
        sizeBytes,
        request: { home: { name: query.homeName, kit: query.homeKit }, away: { name: query.awayName, kit: query.awayKit } },
      });
      response.status(202).json(job);
    } catch (error) {
      if (jobDirectory) await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (!response.headersSent && error instanceof HttpError && error.status === 413) {
        // Stop reading an oversized body so the client gets the 413 promptly.
        response.setHeader("Connection", "close");
      }
      next(error);
    }
  });

  router.get("/api/video/jobs", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(options.worker.list());
  });

  router.delete("/api/video/jobs/:id", async (request, response, next) => {
    try {
      const id = parseOr400(jobIdSchema, request.params.id);
      const job = options.worker.get(id);
      if (!job) throw new HttpError(404, "Video job not found");
      const status = options.live.status();
      if (status.state === "running" && job.fixtureId && status.fixtureId === job.fixtureId) throw new HttpError(409, "Stop the live stream before deleting this clip");
      await options.worker.remove(id);
      response.status(204).end();
    } catch (error) {
      next(conflictTo409(error));
    }
  });

  router.get("/api/video/jobs/:id", (request, response, next) => {
    try {
      const id = parseOr400(jobIdSchema, request.params.id);
      const job = options.worker.get(id);
      if (!job) throw new HttpError(404, "Video job not found");
      response.setHeader("Cache-Control", "no-store");
      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/video/jobs/:id/frames/:index", (request, response, next) => {
    try {
      const id = parseOr400(jobIdSchema, request.params.id);
      const index = parseOr400(z.coerce.number().int().min(0).max(999), request.params.index);
      const file = options.worker.frameFile(id, index);
      if (!file) throw new HttpError(404, "Frame not found");
      response.setHeader("Cache-Control", "private, max-age=3600");
      response.type("jpeg").sendFile(file, (error) => { if (error && !response.headersSent) next(new HttpError(404, "Frame not found")); });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/video/jobs/:id/swap-teams", (request, response, next) => {
    try {
      const job = editableJob(request.params.id, "swapping teams");
      response.json(options.worker.swapTeams(job.id));
    } catch (error) {
      next(conflictTo409(error));
    }
  });

  router.post("/api/video/jobs/:id/tags", (request, response, next) => {
    try {
      const job = editableJob(request.params.id, "tagging events");
      const tag = parseOr400(tagSchema, request.body);
      response.status(201).json(options.worker.addTag(job.id, { ...tag, shirtNumber: tag.shirtNumber ?? null, note: tag.note ?? "" }));
    } catch (error) {
      next(conflictTo409(error));
    }
  });

  router.delete("/api/video/jobs/:id/tags/:tagId", (request, response, next) => {
    try {
      const job = editableJob(request.params.id, "removing tags");
      const tagId = parseOr400(z.string().regex(/^[a-f0-9]{8}$/u), request.params.tagId);
      response.json(options.worker.removeTag(job.id, tagId));
    } catch (error) {
      next(conflictTo409(error));
    }
  });

  router.post("/api/video/jobs/:id/live", async (request, response, next) => {
    try {
      const id = parseOr400(jobIdSchema, request.params.id);
      const job = options.worker.get(id);
      if (!job) throw new HttpError(404, "Video job not found");
      if (job.stage !== "ready" || !job.fixtureId) throw new HttpError(409, "The video has not finished processing");
      // Real-time speed keeps the Eventstream feed in step with the clip playing in the browser.
      response.status(202).json(await options.live.start({ fixtureId: job.fixtureId, speed: 1 }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
