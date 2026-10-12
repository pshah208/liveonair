import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { playerLabel, type PlayerCamJob, type PlayerCamJobSummary, type PlayerCamRequest, type PlayerSighting } from "../../shared/playercam.js";
import { MAX_VIDEO_FRAMES, MAX_VIDEO_SECONDS, type VideoFrame, type VideoJobStage } from "../../shared/video.js";
import { extractFrames, extractReferenceCrop, framePath, probeVideo, sampleTimestamps, videoSampleInterval, type ProbeResult, type RunCommand } from "./ffmpeg.js";
import { buildPlayerMoments } from "./playerMoments.js";
import type { PlayerVisionAnalyzer } from "./playerVision.js";
import { BATCH_SIZE, FRAME_WIDTH, VideoJobConflict } from "./worker.js";

const MAX_JOBS = 6;
const MAX_LOG = 40;
const TERMINAL: VideoJobStage[] = ["ready", "rejected", "failed"];

export interface PlayerCamWorkerDeps {
  vision: PlayerVisionAnalyzer;
  workRoot: string;
  probe?: (filePath: string) => Promise<ProbeResult>;
  extract?: typeof extractFrames;
  crop?: typeof extractReferenceCrop;
  readFrame?: (filePath: string) => Promise<Buffer>;
  run?: RunCommand;
  now?: () => number;
}

export interface PlayerCamWorker {
  newJobId(): string;
  jobDirectory(jobId: string): string;
  submit(input: { jobId: string; sourcePath: string; fileName: string; sizeBytes: number; request: PlayerCamRequest }): PlayerCamJob;
  get(jobId: string): PlayerCamJob | undefined;
  list(): PlayerCamJobSummary[];
  frameFile(jobId: string, index: number): string | undefined;
  referenceFile(jobId: string): string | undefined;
  remove(jobId: string): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

class RejectedFootage extends Error {}

/** Same pipeline shape as the Video lab worker, but it follows one player and never publishes events. */
export function createPlayerCamWorker(deps: PlayerCamWorkerDeps): PlayerCamWorker {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? ((filePath: string) => probeVideo(filePath, deps.run));
  const extract = deps.extract ?? extractFrames;
  const crop = deps.crop ?? extractReferenceCrop;
  const readFrame = deps.readFrame ?? ((filePath: string) => readFile(filePath));
  const jobs = new Map<string, PlayerCamJob>();
  const sources = new Map<string, string>();
  const queue: string[] = [];
  let running: Promise<void> | null = null;
  let closed = false;

  const iso = () => new Date(now()).toISOString();
  const directory = (jobId: string) => path.join(deps.workRoot, jobId);
  const framesDir = (jobId: string) => path.join(directory(jobId), "frames");
  const referencePath = (jobId: string) => path.join(directory(jobId), "reference.jpg");

  function update(job: PlayerCamJob, patch: Partial<PlayerCamJob>, message?: string) {
    Object.assign(job, patch, { updatedAt: iso() });
    if (message) {
      job.log.push({ at: job.updatedAt, message });
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    }
  }

  async function evict() {
    const finished = [...jobs.values()].filter((job) => TERMINAL.includes(job.stage)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (jobs.size > MAX_JOBS && finished.length > 0) {
      const oldest = finished.shift()!;
      jobs.delete(oldest.id);
      await rm(directory(oldest.id), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function runJob(job: PlayerCamJob) {
    const sourcePath = sources.get(job.id)!;
    try {
      update(job, { stage: "probing", progress: 5 }, "Reading the video with ffprobe");
      const info = await probe(sourcePath);
      if (info.durationSeconds > MAX_VIDEO_SECONDS + 1) throw new Error(`The clip is ${Math.round(info.durationSeconds)} s long; the limit is ${MAX_VIDEO_SECONDS} s.`);
      update(job, { durationSeconds: Math.round(info.durationSeconds * 10) / 10, width: info.width, height: info.height }, `${info.codec} ${info.width}×${info.height}, ${info.durationSeconds.toFixed(1)} s`);

      const interval = videoSampleInterval(info.durationSeconds);
      const timestamps = sampleTimestamps(info.durationSeconds, interval, MAX_VIDEO_FRAMES);
      update(job, { stage: "extracting", progress: 8 }, `Extracting ${timestamps.length} frames, one every ${interval.toFixed(1)} s`);
      let referenceJpegBase64: string | undefined;
      const anchor = job.request.anchor;
      if (anchor) {
        await crop({ inputPath: sourcePath, outputPath: referencePath(job.id), second: Math.min(anchor.second, info.durationSeconds - 0.05), x: anchor.x, y: anchor.y, run: deps.run });
        referenceJpegBase64 = (await readFrame(referencePath(job.id))).toString("base64");
        update(job, { referenceCaptured: true }, `Reference crop taken where you clicked at ${anchor.second.toFixed(1)} s`);
      }
      const frames: VideoFrame[] = await extract({
        inputPath: sourcePath,
        outputDirectory: framesDir(job.id),
        timestamps,
        maxWidth: FRAME_WIDTH,
        run: deps.run,
        onFrame: (done) => update(job, { progress: 8 + Math.round((done / timestamps.length) * 17) }),
      });
      const batchesTotal = Math.ceil(frames.length / BATCH_SIZE);
      update(job, { frames, batchesTotal, model: deps.vision.model }, `${frames.length} frames ready`);

      update(job, { stage: "analysing", progress: 25 }, `Looking for ${playerLabel(job.request)} in ${batchesTotal} batch(es) with ${deps.vision.model}`);
      const sightings: PlayerSighting[] = [];
      let rejectedBatches = 0;
      for (let batch = 0; batch < batchesTotal; batch += 1) {
        const slice = frames.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
        const inputs = await Promise.all(slice.map(async (frame) => ({ ...frame, jpegBase64: (await readFrame(framePath(framesDir(job.id), frame.index))).toString("base64") })));
        const result = await deps.vision.analyzeBatch({ frames: inputs, request: job.request, referenceJpegBase64, intervalSeconds: Math.round(interval * 10) / 10 });
        job.usage.inputTokens += result.usage.inputTokens;
        job.usage.outputTokens += result.usage.outputTokens;
        if (!result.footageCheck.realFootballFootage) {
          rejectedBatches += 1;
          update(job, { footageCheck: result.footageCheck });
          if (batch === 0) throw new RejectedFootage(result.footageCheck.reason || "The frames do not show real football footage.");
        }
        sightings.push(...result.sightings);
        const seen = result.sightings.filter((item) => item.visible).length;
        update(job, { sightings: [...sightings], batchesDone: batch + 1, progress: 25 + Math.round(((batch + 1) / batchesTotal) * 65) }, `Batch ${batch + 1}/${batchesTotal}: player seen in ${seen} of ${slice.length} frames`);
      }
      if (rejectedBatches * 2 > batchesTotal) throw new RejectedFootage(job.footageCheck?.reason || "Most frames do not show real football footage.");
      if (!job.footageCheck) update(job, { footageCheck: { realFootballFootage: true, reason: "All batches reported real football footage." } });

      update(job, { stage: "building", progress: 92 }, "Grouping sightings into moments, padding and ranking them");
      const built = buildPlayerMoments({ request: job.request, frames, sightings, durationSeconds: info.durationSeconds, intervalSeconds: interval });
      update(job, { track: built.track, moments: built.moments });
      const visible = built.track.length;
      update(job, { stage: "ready", progress: 100 }, visible === 0
        ? "The player was not found with enough confidence. Try clicking them in the video or adding the shirt number."
        : `Player found in ${visible} of ${frames.length} frames; ${built.moments.length} moment(s) selected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Video processing failed.";
      update(job, { stage: error instanceof RejectedFootage ? "rejected" : "failed", progress: 100, error: message }, `${error instanceof RejectedFootage ? "Rejected" : "Failed"}: ${message}`);
    } finally {
      await rm(sourcePath, { force: true }).catch(() => undefined);
      sources.delete(job.id);
    }
  }

  function pump() {
    if (running || closed) return;
    const next = queue.shift();
    if (!next) return;
    const job = jobs.get(next);
    if (!job) { pump(); return; }
    running = runJob(job).finally(async () => {
      running = null;
      await evict();
      pump();
    });
  }

  return {
    newJobId: () => randomUUID().replaceAll("-", "").slice(0, 12),
    jobDirectory: directory,
    submit(input) {
      const createdAt = iso();
      const job: PlayerCamJob = {
        id: input.jobId,
        createdAt,
        updatedAt: createdAt,
        stage: "queued",
        progress: 0,
        fileName: input.fileName,
        sizeBytes: input.sizeBytes,
        request: input.request,
        frames: [],
        batchesTotal: 0,
        batchesDone: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        referenceCaptured: false,
        sightings: [],
        track: [],
        moments: [],
        log: [{ at: createdAt, message: `Uploaded ${input.fileName} (${(input.sizeBytes / 1_048_576).toFixed(1)} MB) for ${playerLabel(input.request)}` }],
      };
      jobs.set(job.id, job);
      sources.set(job.id, input.sourcePath);
      queue.push(job.id);
      pump();
      return structuredClone(job);
    },
    get(jobId) {
      const job = jobs.get(jobId);
      return job ? structuredClone(job) : undefined;
    },
    list() {
      return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => ({
        id: job.id,
        createdAt: job.createdAt,
        stage: job.stage,
        fileName: job.fileName,
        playerLabel: playerLabel(job.request),
        durationSeconds: job.durationSeconds,
        momentCount: job.moments.length,
      }));
    },
    frameFile(jobId, index) {
      const job = jobs.get(jobId);
      if (!job || !job.frames.some((frame) => frame.index === index)) return undefined;
      return framePath(framesDir(jobId), index);
    },
    referenceFile(jobId) {
      const job = jobs.get(jobId);
      return job?.referenceCaptured ? referencePath(jobId) : undefined;
    },
    async remove(jobId) {
      const job = jobs.get(jobId);
      if (!job) return;
      if (!TERMINAL.includes(job.stage)) throw new VideoJobConflict("The clip is still processing; delete it when it finishes.");
      jobs.delete(jobId);
      await rm(directory(jobId), { recursive: true, force: true }).catch(() => undefined);
    },
    async idle() {
      while (running || queue.length > 0) await (running ?? Promise.resolve());
    },
    async close() {
      closed = true;
      queue.length = 0;
      await running;
      await rm(deps.workRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
