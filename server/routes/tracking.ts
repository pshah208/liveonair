import express from "express";

import type { LiveService } from "../contracts.js";
import { streamCap } from "../live/sse.js";
import { startTrackingStream, type TrackingScheduler } from "../live/tracking.js";

type CreateTrackingRouterOptions = {
  live: LiveService;
  scheduler?: TrackingScheduler;
  now?: () => number;
  /** Overrides TRACKING_STREAM_MAX. Default 200. */
  maxStreams?: number;
};

export function createTrackingRouter(options: CreateTrackingRouterOptions): express.Router {
  const router = express.Router();
  const maxStreams = streamCap(options.maxStreams, process.env.TRACKING_STREAM_MAX);
  let active = 0;

  router.get("/api/live/tracking/stream", (_request, response, next) => {
    if (active >= maxStreams) {
      response.status(503).json({ error: "Tracking stream capacity reached" });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    response.once("close", release);
    try {
      response.status(200);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      const stop = startTrackingStream({ live: options.live, response, scheduler: options.scheduler, now: options.now });
      response.once("close", stop);
    } catch (error) {
      release();
      next(error);
    }
  });
  return router;
}
