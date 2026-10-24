import {
  LIVE_VIDEO_BATCH_FRAMES, LIVE_VIDEO_PENDING_BATCHES, LIVE_VIDEO_FRAME_BYTES, LIVE_VIDEO_FRAME_WIDTH,
  liveVideoFrameCount, liveVideoSampleInterval,
  type ProgressiveFrame, type ProgressiveVideoBatch, type ProgressiveVideoSession
} from "../shared/progressiveVideo.js";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_SECONDS } from "../shared/video.js";
import type { LiveStatus } from "../shared/platform.js";
import { getErrorMessage } from "./utils.js";

export function canStartLiveVideo(
  ready: boolean, busy: boolean, session: ProgressiveVideoSession | null, status: LiveStatus | null
): boolean {
  return ready && !busy && status?.state !== "running" && status?.state !== "paused"
    && (!session || session.stage === "failed" || session.stage === "stopped");
}

export function liveVideoStopError(original: string | null, reason: unknown): string {
  const cleanup = `Local sampling stopped; server stop could not be confirmed: ${getErrorMessage(reason)}\nRetry server stop.`;
  return original ? `${original}\n${cleanup}` : cleanup;
}

type LiveVideoRunIdentity = { id: string; fixtureId?: string; matchId?: string };

export function liveVideoCleanupConfirmed(run: LiveVideoRunIdentity, live: LiveStatus | null): boolean {
  if (!live) return false;
  if (live.state !== "running" && live.state !== "paused") return true;
  if (!run.fixtureId || !run.matchId || !live.fixtureId || !live.matchId) return false;
  return live.fixtureId !== run.fixtureId || live.matchId !== run.matchId;
}

export async function confirmLiveVideoStop(
  run: LiveVideoRunIdentity,
  client: {
    stop: (id: string) => Promise<ProgressiveVideoSession | null>;
    status: () => Promise<LiveStatus | null>;
  }
): Promise<{ session: ProgressiveVideoSession | null; live: LiveStatus }> {
  let stopped: ProgressiveVideoSession | null;
  try {
    stopped = await client.stop(run.id);
  } catch (reason) {
    if (!(reason instanceof Error && "status" in reason && reason.status === 404)) throw reason;
    const live = await client.status();
    if (!liveVideoCleanupConfirmed(run, live)) {
      throw new Error("The video session is missing, but its live stream may still be running. Retry server stop; if this persists, ask the operator to clean up this exact match safely.");
    }
    return { session: null, live: live! };
  }
  if (!stopped || stopped.id !== run.id || stopped.fixtureId !== run.fixtureId || stopped.stage === "streaming") {
    throw new Error("The live video service did not confirm that this session stopped.");
  }
  if (!liveVideoCleanupConfirmed(run, stopped.live)) {
    throw new Error(`${stopped.error ? `${stopped.error}\n` : ""}This video's live stream may still be running. Retry server stop.`);
  }
  return { session: stopped, live: stopped.live };
}

export function validateLocalVideo(file: { name: string; size: number }): void {
  if (!/\.(mp4|webm|mov)$/iu.test(file.name)) throw new Error("Choose an MP4, WebM or MOV video. Its codec must be supported by this browser.");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_UPLOAD_BYTES) throw new Error("Choose a nonempty video up to 500 MB.");
}

export function plannedVideoFrames(duration: number): { index: number; timestampSeconds: number }[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_SECONDS) throw new Error("Choose a video with a known duration of up to 15 minutes.");
  return Array.from({ length: liveVideoFrameCount(duration) }, (_, index) => ({
    index, timestampSeconds: index * liveVideoSampleInterval(duration)
  }));
}

export function playedWatermark(previous: number, current: number, duration: number): number {
  return Math.max(previous, Math.min(duration, Math.max(0, Number.isFinite(current) ? current : 0)));
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function mediaReady(video: HTMLVideoElement, signal: AbortSignal, seek?: number): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const event = seek === undefined ? "loadeddata" : "seeked";
    const clean = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const done = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error("This browser cannot decode or seek this video. Try an H.264 MP4; Video Lab also offers optional AI upload.")); };
    const abort = () => { clean(); reject(signal.reason); };
    const timer = setTimeout(fail, 20_000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (video.error) { fail(); return; }
    if (seek !== undefined) {
      try { video.currentTime = seek; } catch { fail(); }
    } else if (video.readyState >= 2) done();
  });
}

/** The decoder is separate from the user's player; never seek the visible video for sampling. */
export async function decodeVideoFrame(
  decoder: HTMLVideoElement, canvas: HTMLCanvasElement,
  frame: { index: number; timestampSeconds: number }, signal: AbortSignal
): Promise<ProgressiveFrame> {
  await mediaReady(decoder, signal);
  if (decoder.seeking || Math.abs(decoder.currentTime - frame.timestampSeconds) > 0.001) {
    await mediaReady(decoder, signal, frame.timestampSeconds);
  }
  signal.throwIfAborted();
  if (!decoder.videoWidth || !decoder.videoHeight) throw new Error("The video has no decodable picture. Try H.264 MP4; Video Lab also offers optional AI upload.");
  canvas.width = Math.min(LIVE_VIDEO_FRAME_WIDTH, decoder.videoWidth);
  canvas.height = Math.max(1, Math.round(decoder.videoHeight * canvas.width / decoder.videoWidth));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas frame extraction is unavailable in this browser.");
  context.drawImage(decoder, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.65, 0.45, 0.25]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    signal.throwIfAborted();
    if (!blob || blob.size > LIVE_VIDEO_FRAME_BYTES) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    signal.throwIfAborted();
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { ...frame, jpegBase64: btoa(binary) };
  }
  throw new Error("A sampled JPEG exceeds 256 KiB. Try a lower-resolution source or optional AI upload in Video Lab.");
}

export interface LiveVideoClient {
  get: () => Promise<ProgressiveVideoSession>;
  send: (batch: ProgressiveVideoBatch) => Promise<ProgressiveVideoSession>;
  complete: () => Promise<ProgressiveVideoSession>;
  extract: (frame: { index: number; timestampSeconds: number }) => Promise<ProgressiveFrame>;
  watermark: () => number;
  update: (session: ProgressiveVideoSession) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** One bounded producer. A rejected batch stays in memory and retains its exact index and frames. */
export async function streamLocalVideo(initial: ProgressiveVideoSession, client: LiveVideoClient, signal: AbortSignal): Promise<void> {
  const plan = plannedVideoFrames(initial.durationSeconds);
  const wait = client.wait?.bind(client) ?? abortableDelay;
  let session = initial;
  let nextFrame = initial.acceptedFrames;
  let pending: ProgressiveVideoBatch | null = null;
  const adopt = (next: ProgressiveVideoSession) => {
    signal.throwIfAborted();
    if (next.id !== initial.id) throw new Error("The live video session changed.");
    session = next;
    client.update(next);
    if (next.stage === "failed" || (next.stage === "stopped" && next.error)) {
      throw new Error(next.error || "Live video analysis failed.");
    }
  };
  const mutate = async (request: () => Promise<ProgressiveVideoSession>) => {
    try {
      return await request();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Error && "status" in error && error.status === 409)) throw error;
      // Analysis can fail while a batch or completion request is in flight.
      let latest: ProgressiveVideoSession;
      try {
        latest = await client.get();
      } catch (refreshError) {
        signal.throwIfAborted();
        throw new AggregateError([error, refreshError],
          `${error.message}; Could not refresh video session: ${getErrorMessage(refreshError)}`, { cause: error });
      }
      adopt(latest);
      throw error; // A fresh snapshot must not hide a genuine protocol conflict.
    }
  };
  adopt(initial);
  while (session.stage === "streaming") {
    signal.throwIfAborted();
    adopt(await client.get());
    if (session.stage !== "streaming") break;
    if (session.inputComplete || session.pendingBatches >= LIVE_VIDEO_PENDING_BATCHES) {
      await wait(1_000, signal);
      continue;
    }
    if (!pending && nextFrame < plan.length && plan[nextFrame].timestampSeconds <= client.watermark()) {
      const frames: ProgressiveFrame[] = [];
      while (nextFrame + frames.length < plan.length && frames.length < LIVE_VIDEO_BATCH_FRAMES) {
        const frame = plan[nextFrame + frames.length];
        if (frame.timestampSeconds > client.watermark()) break;
        frames.push(await client.extract(frame));
        signal.throwIfAborted();
      }
      pending = { batchIndex: session.nextBatchIndex, frames };
    }
    if (pending) {
      try {
        const batch = pending;
        adopt(await mutate(() => client.send(batch)));
        if (session.stage !== "streaming") break;
        nextFrame += pending.frames.length;
        pending = null;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error && "status" in error && error.status === 429)) throw error;
        await wait(1_500, signal);
      }
    } else if (nextFrame === plan.length && client.watermark() >= initial.durationSeconds) {
      adopt(await mutate(() => client.complete()));
    } else {
      await wait(750, signal);
    }
  }
}
