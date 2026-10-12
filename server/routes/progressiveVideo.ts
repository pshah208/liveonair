import express from "express";
import rateLimit from "express-rate-limit";

import type { ProgressiveVideoService } from "../video/progressive.js";

export const PROGRESSIVE_BODY_LIMIT = "1.5mb";
export function isProgressiveFrameRequest(request: Pick<express.Request, "method" | "path">): boolean {
  return request.method === "POST" && /^\/api\/video\/live-sessions\/[a-f0-9]{12}\/batches\/?$/u.test(request.path);
}

export function createProgressiveVideoRouter(service: ProgressiveVideoService): express.Router {
  const router = express.Router();
  const createLimiter = rateLimit({
    windowMs: 10 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many video live sessions; try again in a few minutes" },
  });
  const batchLimiter = rateLimit({
    windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many video frame requests; try again in a minute" },
  });
  router.use("/api/video/live-sessions", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.post("/api/video/live-sessions", createLimiter, async (request, response, next) => {
    try { response.status(201).json(await service.create(request.body)); } catch (error) { next(error); }
  });
  router.get("/api/video/live-sessions/:id", async (request, response, next) => {
    try { response.json(await service.get(String(request.params.id))); } catch (error) { next(error); }
  });
  router.post("/api/video/live-sessions/:id/batches", batchLimiter, async (request, response, next) => {
    try { response.status(202).json(await service.batch(String(request.params.id), request.body)); } catch (error) { next(error); }
  });
  router.post("/api/video/live-sessions/:id/complete", async (request, response, next) => {
    try { response.status(202).json(await service.complete(String(request.params.id))); } catch (error) { next(error); }
  });
  router.delete("/api/video/live-sessions/:id", async (request, response, next) => {
    try { response.json(await service.stop(String(request.params.id))); } catch (error) { next(error); }
  });
  return router;
}
