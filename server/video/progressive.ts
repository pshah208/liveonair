import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import {
  LIVE_VIDEO_BATCH_FRAMES, LIVE_VIDEO_FRAME_BYTES, LIVE_VIDEO_PENDING_BATCHES,
  liveVideoFrameCount, liveVideoSampleInterval,
  type ProgressiveVideoBatch, type ProgressiveVideoSession,
} from "../../shared/progressiveVideo.js";
import type { MatchEvent, MatchFixture } from "../../shared/types.js";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_FRAMES, MAX_VIDEO_SECONDS, type VideoFrame, type VideoJobRequest, type VisionDetection } from "../../shared/video.js";
import type { LiveService } from "../contracts.js";
import { jobIdSchema, kitSchema, nameSchema, parseOr400 } from "../routes/video.js";
import { HttpError } from "../validation.js";
import { buildVideoFixture } from "./events.js";
import { parseVisionResult, type VisionAnalyzer } from "./vision.js";

export const PROGRESSIVE_SESSION_LIMIT = 6;
export const PROGRESSIVE_IDLE_MS = 30 * 60_000;
export const PROGRESSIVE_TOKEN_BUDGET = 1_000_000;

const teamSchema = z.object({ name: nameSchema, kit: kitSchema }).strict();
export const progressiveStartSchema = z.object({
  fileName: z.string().trim().min(1).max(120).regex(/^[^/\\\u0000-\u001f]+$/u),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  contentType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  durationSeconds: z.number().positive().max(MAX_VIDEO_SECONDS),
  request: z.object({ home: teamSchema, away: teamSchema }).strict(),
  rightsConfirmed: z.literal(true),
}).strict();

const jpegSchema = z.string().min(4).max(4 * Math.ceil(LIVE_VIDEO_FRAME_BYTES / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  .refine((encoded) => {
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length >= 3 && bytes.length <= LIVE_VIDEO_FRAME_BYTES
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes.toString("base64") === encoded;
  }, "Expected a base64 JPEG no larger than 256 KiB");

export const progressiveBatchSchema = z.object({
  batchIndex: z.number().int().min(0).max(MAX_VIDEO_FRAMES - 1),
  frames: z.array(z.object({
    index: z.number().int().min(0).max(MAX_VIDEO_FRAMES - 1),
    timestampSeconds: z.number().nonnegative().max(MAX_VIDEO_SECONDS),
    jpegBase64: jpegSchema,
  }).strict()).min(1).max(LIVE_VIDEO_BATCH_FRAMES),
}).strict();

export interface ProgressiveVideoService {
  create(input: unknown): Promise<ProgressiveVideoSession>;
  get(id: string): Promise<ProgressiveVideoSession>;
  batch(id: string, input: unknown): Promise<ProgressiveVideoSession>;
  complete(id: string): Promise<ProgressiveVideoSession>;
  stop(id: string): Promise<ProgressiveVideoSession>;
}

export interface ProgressiveVideoOptions {
  vision: VisionAnalyzer;
  live: LiveService;
  registerFixture(fixture: MatchFixture): unknown;
  unregisterFixture?(fixtureId: string): unknown;
  now?: () => number;
  idleMs?: number;
  tokenBudget?: number;
  logger?: (entry: { sessionId: string; reason: string }) => void;
}

type Session = {
  value: Omit<ProgressiveVideoSession, "live">;
  request: VideoJobRequest;
  fixture: MatchFixture;
  frames: VideoFrame[];
  detections: VisionDetection[];
  hashes: Map<number, string>;
  queue: ProgressiveVideoBatch[];
  inFlight?: ProgressiveVideoBatch;
  kits: { home: string; away: string };
  tokens: number;
  touched: number;
  ready: boolean;
  registered: boolean;
  completing: boolean;
  matchId?: string;
  pendingLive?: Promise<unknown>;
  cleanup?: Promise<void>;
};

function dispose(batch: ProgressiveVideoBatch): void {
  for (const frame of batch.frames) frame.jpegBase64 = "";
}

/** Only hashes and frame metadata survive an analysis call, never sampled images or source video. */
export function createProgressiveVideoService(options: ProgressiveVideoOptions): ProgressiveVideoService {
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const live = options.live;
  let creating = false;
  let closing = 0;
  let pumping = false;

  function log(session: Session, reason: string): void {
    try {
      (options.logger ?? ((entry) => console.error(JSON.stringify(entry))))({ sessionId: session.value.id, reason });
    } catch {
      console.error("Progressive video error logger failed");
    }
  }

  function snapshot(session: Session): ProgressiveVideoSession {
    return structuredClone({ ...session.value, live: live.status() });
  }

  function discardImages(session: Session): void {
    for (const batch of session.queue) dispose(batch);
    session.queue = [];
    if (session.inFlight) dispose(session.inFlight);
    session.value.pendingBatches = 0;
  }

  function ownStreamRunning(session: Session): boolean {
    const status = live.status();
    return status.state === "running" && status.fixtureId === session.value.fixtureId
      && session.matchId !== undefined && status.matchId === session.matchId;
  }

  function cleanupError(session: Session, message: string): void {
    if (!session.value.error?.includes(message)) {
      session.value.error = `${session.value.error ? `${session.value.error}; ` : ""}${message}`;
    }
  }

  async function stopOwnStream(session: Session): Promise<void> {
    closing++;
    try {
      // Wait only for the live operation, not finalize/create: those paths also await cleanup.
      if (session.pendingLive) await session.pendingLive.catch(() => {});
      if (ownStreamRunning(session)) await live.stop();
    } catch (error) {
      cleanupError(session, "Could not stop the video live stream. Retry server stop.");
      log(session, `Live cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      closing--;
    }
  }

  function unregister(session: Session): void {
    if (!session.registered || !options.unregisterFixture || session.cleanup || session.pendingLive || session.completing) return;
    // Replacement status may be provisional; its fixture is not ours to remove in any state.
    const status = live.status();
    if (status.fixtureId === session.value.fixtureId
      && (status.state === "running" || status.matchId !== session.matchId)) return;
    try {
      options.unregisterFixture(session.value.fixtureId);
      session.registered = false;
    } catch (error) {
      cleanupError(session, "Could not remove the video fixture. Retry server stop.");
      log(session, `Fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function cleanup(session: Session): Promise<void> {
    session.cleanup ??= stopOwnStream(session).finally(() => {
      session.cleanup = undefined;
      unregister(session);
    });
    return session.cleanup;
  }

  async function end(session: Session, stage: "stopped" | "failed", error?: string): Promise<void> {
    session.value.stage = stage;
    if (error) session.value.error = error;
    discardImages(session);
    await cleanup(session);
  }

  function ownsStream(session: Session): boolean {
    if (!session.ready || session.value.stage !== "streaming") return false;
    const status = live.status();
    if (status.fixtureId === session.value.fixtureId && status.matchId === session.matchId
      && (status.state === "running" || (session.completing && status.state === "finished"))) return true;
    session.value.stage = "stopped";
    session.value.error = "The video live stream was stopped or replaced";
    discardImages(session);
    unregister(session);
    return false;
  }

  async function sweep(): Promise<void> {
    for (const [id, session] of sessions) {
      if (now() - session.touched < (options.idleMs ?? PROGRESSIVE_IDLE_MS)) {
        if (session.ready && session.value.stage === "streaming") ownsStream(session);
        continue;
      }
      if (session.value.stage === "streaming") await end(session, "stopped", "Video session expired after inactivity");
      else await cleanup(session);
      if (!ownStreamRunning(session) && !(session.registered && options.unregisterFixture)) sessions.delete(id);
    }
  }

  async function find(id: string): Promise<Session> {
    parseOr400(jobIdSchema, id);
    await sweep();
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, "Video live session not found");
    session.touched = now();
    return session;
  }

  function requireStreaming(session: Session): void {
    if (!ownsStream(session)) throw new HttpError(409, "Video session is no longer streaming");
  }

  function build(session: Session, final: boolean) {
    const built = buildVideoFixture({
      jobId: session.value.id, request: session.request, durationSeconds: session.value.durationSeconds,
      frames: session.frames, detections: session.detections,
    });
    const fixture = built.fixture;
    fixture.description = "Events detected from browser-sampled frames of local football footage. The original video stays on the device; positions are approximate, not tracking data.";
    const ids = new Map(fixture.events.map((event) => [
      event.id, `${fixture.id}-${event.type}-${event.teamId}-${event.minute}-${event.second}`,
    ]));
    const previous = new Map(session.fixture.events.map((event) => [event.id, event]));
    const eligible = new Map<string, MatchEvent>();
    for (const source of fixture.events) {
      if (!final && (source.type === "fulltime" || source.minute * 60 + source.second > session.value.analyzedThrough)) continue;
      const event = { ...source, id: ids.get(source.id)! };
      if (event.relatedEventId) event.relatedEventId = ids.get(event.relatedEventId)!;
      // An inferred scoring shot and an observed shot can occupy the same second.
      const sameMoment = eligible.get(event.id);
      if (sameMoment?.type === "shot" && sameMoment.outcome === "success") event.outcome = "success";
      const old = previous.get(event.id);
      if (old) {
        event.revision = old.revision;
        if (JSON.stringify({ ...old, revision: 1 }) !== JSON.stringify({ ...event, revision: 1 })) event.revision++;
      }
      eligible.set(event.id, event);
    }
    fixture.events = [...eligible.values()];
    fixture.correctionEventId = ids.get(fixture.correctionEventId) ?? "";
    built.evidence = built.evidence
      .map((item) => ({ ...item, eventId: ids.get(item.eventId)! }))
      .filter((item) => eligible.has(item.eventId));
    return built;
  }

  function commit(session: Session, built: ReturnType<typeof build>): void {
    session.fixture = built.fixture;
    session.value.events = built.fixture.events;
    session.value.evidence = built.evidence;
    session.touched = now();
  }

  async function append(session: Session, fixture: MatchFixture, watermark: number): Promise<void> {
    session.registered = true;
    try {
      await live.appendProgressive!(structuredClone(fixture), watermark);
    } finally {
      if (session.value.stage !== "streaming") {
        // The live service can register a fixture after cancellation, while its publication is pending.
        session.registered = true;
        unregister(session);
      }
    }
  }

  async function finalize(session: Session): Promise<void> {
    if (!ownsStream(session) || !session.value.inputComplete || session.value.pendingBatches !== 0) return;
    if (session.frames.length === 0) {
      throw new HttpError(422, "No match footage found in the analyzed video; only football broadcast graphics or studio coverage was seen.");
    }
    const built = build(session, true);
    options.registerFixture(structuredClone(built.fixture));
    session.registered = true;
    await append(session, built.fixture, built.fixture.durationSeconds);
    if (!ownsStream(session)) return;
    session.completing = true;
    try {
      session.pendingLive = live.completeProgressive!(session.value.fixtureId);
      await session.pendingLive;
    } finally {
      session.pendingLive = undefined;
      session.completing = false;
      if (session.value.stage !== "streaming") await cleanup(session);
    }
    // Completion changes live.state itself; ownership must be checked without requiring "running".
    if (session.value.stage !== "streaming") return;
    if (live.status().fixtureId !== session.value.fixtureId || live.status().matchId !== session.matchId) {
      ownsStream(session);
      return;
    }
    commit(session, built);
    session.value.analyzedThrough = session.value.durationSeconds;
    session.value.stage = "complete";
  }

  async function processBatch(session: Session, batch: ProgressiveVideoBatch): Promise<void> {
    const metadata = batch.frames.map(({ index, timestampSeconds }) => ({ index, timestampSeconds }));
    try {
      const result = await options.vision.analyzeBatch({
        frames: batch.frames, request: structuredClone(session.request),
        knownKits: { ...session.kits }, intervalSeconds: liveVideoSampleInterval(session.value.durationSeconds),
      });
      dispose(batch);
      if (!ownsStream(session)) return;
      const usage = result.usage.inputTokens + result.usage.outputTokens;
      if (![result.usage.inputTokens, result.usage.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
        || session.tokens + usage > (options.tokenBudget ?? PROGRESSIVE_TOKEN_BUDGET)) {
        throw new HttpError(422, "Video analysis token budget exceeded");
      }
      if (result.detections.length > metadata.length * 3) throw new HttpError(422, "Video analysis exceeded the per-frame detection budget");
      const parsed = parseVisionResult(result, new Set(metadata.map((frame) => frame.index)));
      session.tokens += usage;
      if (!parsed.footageCheck.realFootballFootage && parsed.footageCheck.category !== "broadcast_graphics") {
        throw new HttpError(422, `Not real football footage: ${parsed.footageCheck.reason.slice(0, 240)}`);
      }
      session.value.analyzedFrames += metadata.length;
      session.value.analyzedThrough = metadata.at(-1)!.timestampSeconds;
      if (parsed.footageCheck.category === "broadcast_graphics") {
        session.value.skippedFrames = (session.value.skippedFrames ?? 0) + metadata.length;
        session.value.coverageNote = session.frames.length
          ? "Skipping broadcast graphics; match event detection will resume with match footage."
          : "Skipping football broadcast graphics; waiting for match footage.";
        // Advance the live watermark without rebuilding synthetic kickoff/fulltime events.
        await append(session, session.fixture, session.value.analyzedThrough);
        if (ownsStream(session)) session.touched = now();
        return;
      }
      session.value.coverageNote = session.value.skippedFrames
        ? `Match footage detected; ${session.value.skippedFrames} broadcast graphics frames skipped.`
        : "Match footage detected.";
      for (const side of ["home", "away"] as const) {
        if (!session.kits[side]) session.kits[side] = parsed.kits[side].trim().slice(0, 60);
      }
      session.frames.push(...metadata);
      session.detections.push(...parsed.detections.map((detection) => ({ ...detection, description: detection.description.slice(0, 240) })));
      const built = build(session, false);
      await append(session, built.fixture, session.value.analyzedThrough);
      if (ownsStream(session)) commit(session, built);
    } finally {
      dispose(batch);
      session.inFlight = undefined;
      if (session.value.stage === "streaming") session.value.pendingBatches--;
      else unregister(session);
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const session = [...sessions.values()].find((candidate) => candidate.ready
          && candidate.value.stage === "streaming" && (candidate.queue.length || candidate.value.inputComplete));
        if (!session) break;
        if (!ownsStream(session)) continue;
        try {
          const batch = session.queue.shift();
          if (batch) {
            session.inFlight = batch;
            await processBatch(session, batch);
          }
          await finalize(session);
        } catch (error) {
          log(session, `Video analysis failed: ${error instanceof Error ? error.message : String(error)}`);
          if (session.value.stage === "streaming") {
            await end(session, "failed", error instanceof HttpError ? error.message : "Video analysis or live publication failed");
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  function schedule(): void {
    // Defer work so accepted responses are immutable enqueue snapshots, even with an immediate fake model.
    setImmediate(() => {
      void pump().catch((error) => {
        for (const session of sessions.values()) {
          if (session.value.stage !== "streaming") continue;
          log(session, `Progressive worker failed: ${error instanceof Error ? error.message : String(error)}`);
          void end(session, "failed", "Progressive video worker failed").catch((cleanupError) => {
            log(session, `Progressive cleanup failed: ${String(cleanupError)}`);
          });
        }
      });
    });
  }

  return {
    async create(input) {
      const parsed = parseOr400(progressiveStartSchema, input);
      if (!options.vision.configured) throw new HttpError(503, "Video analysis is not configured on this server");
      if (!live.startProgressive || !live.appendProgressive || !live.completeProgressive) throw new HttpError(503, "Progressive live video is not available");
      if (creating || closing) throw new HttpError(409, "A video stream transition is already in progress");
      creating = true;
      try {
        await sweep();
        if (live.status().state === "running" || [...sessions.values()].some((session) => session.value.stage === "streaming")) {
          throw new HttpError(409, "Stop the active live stream before starting another video");
        }
        if (sessions.size >= PROGRESSIVE_SESSION_LIMIT) throw new HttpError(429, "Video session limit reached; wait for idle sessions to expire");
        let id: string;
        do { id = randomBytes(6).toString("hex"); } while (sessions.has(id));
        const { fixture } = buildVideoFixture({ jobId: id, request: parsed.request, durationSeconds: parsed.durationSeconds, frames: [], detections: [] });
        fixture.events = [];
        fixture.description = "Browser-sampled local video; original footage stays on the device.";
        const session: Session = {
          value: {
            id, fixtureId: fixture.id, fileName: parsed.fileName, durationSeconds: parsed.durationSeconds,
            stage: "streaming", acceptedFrames: 0, analyzedFrames: 0, uploadedThrough: 0, analyzedThrough: 0,
             nextBatchIndex: 0, pendingBatches: 0, inputComplete: false, events: [], evidence: [],
            coverageNote: "Waiting for match footage.",
          },
          request: parsed.request, fixture, frames: [], detections: [], hashes: new Map(), queue: [],
          kits: { home: parsed.request.home.kit, away: parsed.request.away.kit },
          tokens: 0, touched: now(), ready: false, registered: true, completing: false,
        };
        sessions.set(id, session);
        try {
          try {
            const starting = live.startProgressive(structuredClone(fixture));
            session.pendingLive = starting;
            const started = await starting;
            session.matchId = started.matchId;
            session.ready = true;
          } finally {
            session.pendingLive = undefined;
          }
          if (session.value.stage !== "streaming") {
            session.registered = true;
            await cleanup(session);
          }
          else ownsStream(session);
          return snapshot(session);
        } catch (error) {
          log(session, `Video start failed: ${error instanceof Error ? error.message : String(error)}`);
          // Partial startup may throw before returning its match ID. Pin the fallback once,
          // rather than allowing future cleanup retries to adopt a replacement match.
          const status = live.status();
          if (!session.matchId && status.fixtureId === session.value.fixtureId) session.matchId = status.matchId;
          await end(session, "failed", "Could not start the video live stream");
          throw new HttpError(503, session.value.error!);
        }
      } finally {
        creating = false;
      }
    },
    async get(id) {
      return snapshot(await find(id));
    },
    async batch(id, input) {
      const session = await find(id);
      const parsed = parseOr400(progressiveBatchSchema, input);
      const hash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
      const prior = session.hashes.get(parsed.batchIndex);
      if (prior) {
        if (prior !== hash) throw new HttpError(409, "Batch retry does not match the accepted payload");
        return snapshot(session);
      }
      requireStreaming(session);
      if (session.value.inputComplete) throw new HttpError(409, "Video input is already complete");
      if (parsed.batchIndex !== session.value.nextBatchIndex) throw new HttpError(409, "Batch indices must be contiguous");
      const planned = liveVideoFrameCount(session.value.durationSeconds);
      if (session.value.acceptedFrames + parsed.frames.length > planned) throw new HttpError(400, "Batch exceeds the planned video frame count");
      const interval = liveVideoSampleInterval(session.value.durationSeconds);
      for (const [offset, frame] of parsed.frames.entries()) {
        if (frame.index !== session.value.acceptedFrames + offset) throw new HttpError(409, "Frame indices must be contiguous starting at zero");
        const plannedTime = frame.index * interval;
        if (frame.timestampSeconds >= session.value.durationSeconds
          || frame.timestampSeconds <= plannedTime - 0.1 || frame.timestampSeconds >= plannedTime + 0.1) {
          throw new HttpError(400, "Frame timestamp must match its planned sampling time");
        }
      }
      if (session.value.pendingBatches >= LIVE_VIDEO_PENDING_BATCHES) throw new HttpError(429, "Video frame queue is full; retry this batch");
      session.queue.push(parsed);
      session.hashes.set(parsed.batchIndex, hash);
      session.value.acceptedFrames += parsed.frames.length;
      session.value.uploadedThrough = parsed.frames.at(-1)!.timestampSeconds;
      session.value.nextBatchIndex++;
      session.value.pendingBatches++;
      schedule();
      return snapshot(session);
    },
    async complete(id) {
      const session = await find(id);
      if (session.value.stage === "complete") return snapshot(session);
      requireStreaming(session);
      if (session.value.acceptedFrames !== liveVideoFrameCount(session.value.durationSeconds) || session.value.acceptedFrames < 1) {
        throw new HttpError(409, "Upload every planned frame before completing video input");
      }
      session.value.inputComplete = true;
      schedule();
      return snapshot(session);
    },
    async stop(id) {
      const session = await find(id);
      if (session.value.stage === "streaming" || session.value.stage === "complete") await end(session, "stopped");
      else await cleanup(session);
      return snapshot(session);
    },
  };
}
