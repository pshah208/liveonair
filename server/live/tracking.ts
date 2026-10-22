import type express from "express";

import { buildTrackingFrame, type TrackingStreamMessage } from "../../shared/tracking.js";
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

  const sendStatus = (status: "idle" | "no_data" | "ended", message: string) => {
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
    if (!Number.isFinite(lastRawClock) || Math.abs(rawClock - lastRawClock) > 1e-6) {
      lastRawClock = rawClock;
      baseClock = rawClock;
      baseAt = now();
    }
    const elapsed = Math.max(0, (now() - baseAt) / 1000);
    const projectedSecond = Math.min(view.fixture.durationSeconds, baseClock + elapsed * Math.max(0, status.speed || 0));
    const frame = buildTrackingFrame(view.fixture, projectedSecond);
    if (!blocked) {
      blocked = !writeSse(response, { type: "frame", frame });
    }
    if (projectedSecond >= view.fixture.durationSeconds || status.state === "finished") {
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
