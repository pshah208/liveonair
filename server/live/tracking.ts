import type express from "express";

import { buildTrackingFrame, TRACKING_DELAY_SECONDS, type TrackingStreamMessage } from "../../shared/tracking.js";
import type { LiveService } from "../contracts.js";

type TimerHandle = unknown;

export interface TrackingScheduler {
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

type StartTrackingStreamOptions = {
  live: LiveService;
  response: express.Response;
  scheduler?: TrackingScheduler;
  now?: () => number;
  hz?: number;
};

function defaultScheduler(): TrackingScheduler {
  return {
    setInterval(callback, intervalMs) {
      return globalThis.setInterval(callback, intervalMs);
    },
    clearInterval(handle) {
      clearInterval(handle as NodeJS.Timeout);
    },
  };
}

function writeSse(response: express.Response, message: TrackingStreamMessage): boolean {
  return response.write(`data: ${JSON.stringify(message)}\n\n`);
}

function hasPositionalData(live: LiveService): boolean {
  const status = live.status();
  if (status.source === "video-vision") return false;
  const view = live.current();
  return Boolean(view && !view.fixture.id.startsWith("video-"));
}

/**
 * Dedicated 5 Hz synthetic tracking stream with backpressure dropping/thinning.
 * Frames never look past the live service's received-event watermark, so a live
 * frame at t equals buildTrackingFrame(fullFixture, t) for an in-order feed.
 */
export function startTrackingStream({
  live,
  response,
  scheduler = defaultScheduler(),
  now = Date.now,
  hz = 5,
}: StartTrackingStreamOptions): () => void {
  let closed = false;
  let blocked = false;
  let lastStatus = "";
  let baseClock = 0;
  let baseAt = now();
  let lastRawClock = Number.NaN;
  let holdingPause = false;
  let lastFrameSecond = -1;
  let lastTickAt = now();

  const sendStatus = (status: "idle" | "no_data" | "ended" | "paused", message: string) => {
    const key = `${status}:${message}`;
    if (key === lastStatus || closed || blocked) return;
    lastStatus = key;
    blocked = !writeSse(response, { type: "status", status, message }) || blocked;
  };

  const tick = () => {
    if (closed) return;
    const status = live.status();
    const view = live.current();
    if (!view || status.state === "idle") {
      sendStatus("idle", "Live match is idle.");
      return;
    }
    if (!hasPositionalData(live)) {
      sendStatus("no_data", "No positional data for this feed (events only).");
      return;
    }

    const rawClock = view.clockSecond;
    if (status.state === "paused") {
      // The 5 Hz projector otherwise keeps adding wall time * speed after the service clock has frozen.
      holdingPause = true;
      lastRawClock = rawClock;
      baseClock = rawClock;
      baseAt = now();
      lastTickAt = baseAt;
      sendStatus("paused", "Match paused.");
      return;
    }
    if (holdingPause || !Number.isFinite(lastRawClock) || Math.abs(rawClock - lastRawClock) > 1e-6) {
      holdingPause = false;
      lastRawClock = rawClock;
      baseClock = rawClock;
      baseAt = now();
    }
    const tickAt = now();
    const speed = Math.max(0, status.speed || 0);
    const elapsed = Math.max(0, (tickAt - baseAt) / 1000);
    const projectedSecond = Math.min(view.fixture.durationSeconds, baseClock + elapsed * speed);
    // view.clockSecond is the service's wall-clock ticker, not a record of what
    // has arrived: events land on their own publish timers and can trail it
    // when the event loop stalls. The received watermark is the only safe
    // horizon; a frame built past it would be cached with events missing.
    const watermark = live.publishedThroughSecond?.() ?? rawClock;
    const horizonSecond = Math.min(projectedSecond, rawClock, watermark);
    const delayedSecond = Math.max(0, Math.floor((horizonSecond - TRACKING_DELAY_SECONDS + 1e-6) * 5) / 5);
    // Until the first TRACKING_DELAY_SECONDS of events have arrived, any frame
    // (even t=0) would be simulated from an incomplete feed and then cached.
    if (status.state !== "finished" && horizonSecond < TRACKING_DELAY_SECONDS - 1e-6) return;
    // The final published events still need their three seconds of simulated
    // tracking. Drain them at match speed (at least one 0.2 s step per tick).
    const drainStep = Math.max(0.2, Math.floor(((tickAt - lastTickAt) / 1000) * speed * 5 + 1e-6) / 5);
    lastTickAt = tickAt;
    let frameSecond = status.state === "finished"
      ? Math.min(view.fixture.durationSeconds, watermark, Math.max(delayedSecond, lastFrameSecond + drainStep))
      : delayedSecond;
    if (status.state === "finished" && frameSecond >= view.fixture.durationSeconds - 1e-6) frameSecond = view.fixture.durationSeconds;
    const frame = buildTrackingFrame(view.fixture, frameSecond);
    lastFrameSecond = frame.second;
    if (!blocked) {
      blocked = !writeSse(response, { type: "frame", frame });
    }
    if (status.state === "finished" && frame.second >= view.fixture.durationSeconds - 1e-6) {
      if (!blocked) writeSse(response, { type: "status", status: "ended", message: "Match ended; tracking stream closed." });
      cleanup();
      response.end();
    }
  };

  const frameHandle = scheduler.setInterval(tick, Math.max(120, Math.round(1000 / hz)));
  const heartbeatHandle = scheduler.setInterval(() => {
    if (!closed && !blocked) blocked = !writeSse(response, { type: "heartbeat", at: new Date().toISOString() }) || blocked;
  }, 15_000);

  const onDrain = () => { blocked = false; };
  const onClose = () => { cleanup(); };
  response.on("drain", onDrain);
  response.on("close", onClose);

  function cleanup() {
    if (closed) return;
    closed = true;
    scheduler.clearInterval(frameHandle);
    scheduler.clearInterval(heartbeatHandle);
    response.off("drain", onDrain);
    response.off("close", onClose);
  }

  tick();
  return cleanup;
}
