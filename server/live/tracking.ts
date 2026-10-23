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

/** Dedicated 5 Hz synthetic tracking stream with backpressure dropping/thinning. */
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
      sendStatus("paused", "Match paused.");
      return;
    }
    if (holdingPause || !Number.isFinite(lastRawClock) || Math.abs(rawClock - lastRawClock) > 1e-6) {
      holdingPause = false;
      lastRawClock = rawClock;
      baseClock = rawClock;
      baseAt = now();
    }
    const elapsed = Math.max(0, (now() - baseAt) / 1000);
    const projectedSecond = Math.min(view.fixture.durationSeconds, baseClock + elapsed * Math.max(0, status.speed || 0));
    // Never project the event horizon past the service's published clock.
    const publishedSecond = Math.min(projectedSecond, rawClock);
    const delayedSecond = Math.max(0, Math.floor((publishedSecond - TRACKING_DELAY_SECONDS + 1e-6) * 5) / 5);
    // The final published events still need their three seconds of simulated
    // tracking. Drain them at the ordinary 5 Hz output cadence after finish.
    let frameSecond = status.state === "finished"
      ? Math.min(view.fixture.durationSeconds, Math.max(delayedSecond, lastFrameSecond + 0.2))
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
