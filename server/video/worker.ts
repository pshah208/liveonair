import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { MatchFixture } from "../../shared/types.js";
import type { VideoFrame, VideoJob, VideoJobRequest, VideoJobStage, VisionDetection } from "../../shared/video.js";
import { buildVideoFixture } from "./events.js";
import { extractFrames, framePath, probeVideo, sampleTimestamps, type ProbeResult, type RunCommand } from "./ffmpeg.js";
import type { VisionAnalyzer } from "./vision.js";

export const MAX_VIDEO_SECONDS = 180;
export const MAX_FRAMES = 60;
export const MIN_INTERVAL_SECONDS = 1;
export const BATCH_SIZE = 12;
export const FRAME_WIDTH = 768;
const MAX_JOBS = 6;
const MAX_LOG = 40;

export interface VideoWorkerDeps {
  vision: VisionAnalyzer;
  registerFixture(fixture: MatchFixture): unknown;
  workRoot: string;
  probe?: (filePath: string) => Promise<ProbeResult>;
  extract?: typeof extractFrames;
  readFrame?: (filePath: string) => Promise<Buffer>;
  run?: RunCommand;
  now?: () => number;
}

export interface SubmitVideoJob {
  jobId: string;
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  request: VideoJobRequest;
}

export interface VideoWorker {
  newJobId(): string;
  jobDirectory(jobId: string): string;
  submit(input: SubmitVideoJob): VideoJob;
  get(jobId: string): VideoJob | undefined;
  frameFile(jobId: string, index: number): string | undefined;
  /** Flips which kit is home and which is away, then rebuilds and re-registers the fixture. */
  swapTeams(jobId: string): VideoJob;
  /** Resolves when the queue is empty; used by tests. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

class RejectedFootage extends Error {}

export function createVideoWorker(deps: VideoWorkerDeps): VideoWorker {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? ((filePath: string) => probeVideo(filePath, deps.run));
  const extract = deps.extract ?? extractFrames;
  const readFrame = deps.readFrame ?? ((filePath: string) => readFile(filePath));
  const jobs = new Map<string, VideoJob>();
  const sources = new Map<string, string>();
  const detectionsByJob = new Map<string, VisionDetection[]>();
  const queue: string[] = [];
  let running: Promise<void> | null = null;
  let closed = false;

  const iso = () => new Date(now()).toISOString();
  const directory = (jobId: string) => path.join(deps.workRoot, jobId);

  function update(job: VideoJob, patch: Partial<VideoJob>, message?: string) {
    Object.assign(job, patch, { updatedAt: iso() });
    if (message) {
      job.log.push({ at: job.updatedAt, message });
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    }
  }

  function setStage(job: VideoJob, stage: VideoJobStage, progress: number, message: string) {
    update(job, { stage, progress }, message);
  }

  async function evict() {
    const finished = [...jobs.values()].filter((job) => ["ready", "rejected", "failed"].includes(job.stage)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (jobs.size > MAX_JOBS && finished.length > 0) {
      const oldest = finished.shift()!;
      jobs.delete(oldest.id);
      detectionsByJob.delete(oldest.id);
      await rm(directory(oldest.id), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function runJob(job: VideoJob) {
    const sourcePath = sources.get(job.id)!;
    try {
      setStage(job, "probing", 5, "Reading the video with ffprobe");
      const info = await probe(sourcePath);
      if (info.durationSeconds > MAX_VIDEO_SECONDS + 1) {
        throw new Error(`The clip is ${Math.round(info.durationSeconds)} s long; the limit is ${MAX_VIDEO_SECONDS} s.`);
      }
      update(job, { durationSeconds: Math.round(info.durationSeconds * 10) / 10, width: info.width, height: info.height }, `${info.codec} ${info.width}×${info.height}, ${info.durationSeconds.toFixed(1)} s`);

      const interval = Math.max(MIN_INTERVAL_SECONDS, info.durationSeconds / MAX_FRAMES);
      const timestamps = sampleTimestamps(info.durationSeconds, interval, MAX_FRAMES);
      setStage(job, "extracting", 8, `Extracting ${timestamps.length} frames, one every ${interval.toFixed(1)} s`);
      const frames: VideoFrame[] = await extract({
        inputPath: sourcePath,
        outputDirectory: path.join(directory(job.id), "frames"),
        timestamps,
        maxWidth: FRAME_WIDTH,
        run: deps.run,
        onFrame: (done) => update(job, { progress: 8 + Math.round((done / timestamps.length) * 17) }),
      });
      const batchesTotal = Math.ceil(frames.length / BATCH_SIZE);
      update(job, { frames, batchesTotal, model: deps.vision.model }, `${frames.length} frames ready`);

      setStage(job, "analysing", 25, `Sending ${batchesTotal} batch(es) of frames to ${deps.vision.model}`);
      const detections: VisionDetection[] = [];
      let knownKits = job.request.home.kit && job.request.away.kit ? { home: job.request.home.kit, away: job.request.away.kit } : undefined;
      let rejectedBatches = 0;
      for (let batch = 0; batch < batchesTotal; batch += 1) {
        const slice = frames.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
        const inputs = await Promise.all(slice.map(async (frame) => ({ ...frame, jpegBase64: (await readFrame(framePath(path.join(directory(job.id), "frames"), frame.index))).toString("base64") })));
        const result = await deps.vision.analyzeBatch({ frames: inputs, request: job.request, knownKits, intervalSeconds: Math.round(interval * 10) / 10 });
        job.usage.inputTokens += result.usage.inputTokens;
        job.usage.outputTokens += result.usage.outputTokens;
        if (!result.footageCheck.realFootballFootage) {
          rejectedBatches += 1;
          update(job, { footageCheck: result.footageCheck });
          // Fail closed early: if the opening frames are not football, stop before spending more tokens.
          if (batch === 0) throw new RejectedFootage(result.footageCheck.reason || "The frames do not show real football footage.");
        }
        if (!knownKits && result.kits.home.trim() && result.kits.away.trim()) {
          knownKits = { home: result.kits.home.trim(), away: result.kits.away.trim() };
          update(job, { kits: knownKits }, `Kits identified: home ${knownKits.home}; away ${knownKits.away}`);
        }
        detections.push(...result.detections);
        update(job, { batchesDone: batch + 1, detectionsRaw: detections.length, progress: 25 + Math.round(((batch + 1) / batchesTotal) * 65) }, `Batch ${batch + 1}/${batchesTotal}: ${result.detections.length} detection(s)`);
      }
      if (rejectedBatches * 2 > batchesTotal) {
        throw new RejectedFootage(job.footageCheck?.reason || "Most frames do not show real football footage.");
      }
      if (!job.footageCheck) update(job, { footageCheck: { realFootballFootage: true, reason: "All batches reported real football footage." } });
      if (knownKits && !job.kits) update(job, { kits: knownKits });

      setStage(job, "building", 92, "Applying confidence, de-duplication and football consistency rules");
      const built = buildVideoFixture({ jobId: job.id, request: job.request, durationSeconds: info.durationSeconds, frames, detections });
      detectionsByJob.set(job.id, detections);
      deps.registerFixture(built.fixture);
      update(job, {
        fixtureId: built.fixture.id,
        events: built.fixture.events,
        evidence: built.evidence,
        detectionsAccepted: built.acceptedCount,
      });
      setStage(job, "ready", 100, `${built.acceptedCount} of ${built.rawCount} detections accepted; fixture ${built.fixture.id} registered`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Video processing failed.";
      if (error instanceof RejectedFootage) setStage(job, "rejected", 100, `Rejected: ${message}`);
      else setStage(job, "failed", 100, `Failed: ${message}`);
      update(job, { error: message });
    } finally {
      // The source video is only needed while processing; frames stay as evidence until eviction.
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
      const job: VideoJob = {
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
        detectionsRaw: 0,
        detectionsAccepted: 0,
        evidence: [],
        events: [],
        log: [{ at: createdAt, message: `Uploaded ${input.fileName} (${(input.sizeBytes / 1_048_576).toFixed(1)} MB)` }],
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
    frameFile(jobId, index) {
      const job = jobs.get(jobId);
      if (!job || !job.frames.some((frame) => frame.index === index)) return undefined;
      return framePath(path.join(directory(jobId), "frames"), index);
    },
    swapTeams(jobId) {
      const job = jobs.get(jobId);
      const detections = detectionsByJob.get(jobId);
      if (!job || job.stage !== "ready" || !detections || job.durationSeconds === undefined) {
        throw new Error("Only a processed clip can have its teams swapped.");
      }
      const flipped = detections.map((detection) => ({ ...detection, team: detection.team === "home" ? "away" as const : detection.team === "away" ? "home" as const : detection.team }));
      detectionsByJob.set(jobId, flipped);
      // Names stay where the user typed them; only the kit (and so every detection) changes side.
      const kits = job.kits ? { home: job.kits.away, away: job.kits.home } : undefined;
      const request = { home: { ...job.request.home, kit: job.request.away.kit }, away: { ...job.request.away, kit: job.request.home.kit } };
      const built = buildVideoFixture({ jobId, request, durationSeconds: job.durationSeconds, frames: job.frames, detections: flipped });
      deps.registerFixture(built.fixture);
      update(job, { request, kits, events: built.fixture.events, evidence: built.evidence, detectionsAccepted: built.acceptedCount }, kits ? `Teams swapped: ${job.request.home.name} now wears ${kits.home}` : "Teams swapped");
      return structuredClone(job);
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
