import express from "express";

import type { LiveService } from "../contracts.js";
import { startTrackingStream, type TrackingScheduler } from "../live/tracking.js";

type CreateTrackingRouterOptions = {
  live: LiveService;
  scheduler?: TrackingScheduler;
  now?: () => number;
};

export function createTrackingRouter(options: CreateTrackingRouterOptions): express.Router {
  const router = express.Router();
  router.get("/api/live/tracking/stream", (_request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    startTrackingStream({ live: options.live, response, scheduler: options.scheduler, now: options.now });
  });
  return router;
}
