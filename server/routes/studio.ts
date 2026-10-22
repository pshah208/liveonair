import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import type { ReviewStorylineRequest } from "../../shared/platform.js";
import type { LiveService, StorylineDesk } from "../contracts.js";
import { HttpError } from "../validation.js";
import { requireStudioToken } from "./studioAuth.js";

const reviewSchema = z.object({
  decision: z.enum(["approve", "reject", "edit"]),
  onAirLine: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().max(300).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "edit" && !value.onAirLine) {
    context.addIssue({
      code: "custom",
      message: "onAirLine is required when decision is edit",
      path: ["onAirLine"],
    });
  }
});

function parseReviewRequest(payload: unknown): ReviewStorylineRequest {
  const result = reviewSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new HttpError(400, `${path}${issue.message}`);
  }
  return result.data;
}

export function createStudioRouter(deps: { desk: StorylineDesk; live: LiveService; authRequired?: boolean; studioToken?: string }): Router {
  const router = express.Router();
  const reviewLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many storyline review requests" },
  });

  router.get("/api/studio/auth-required", (_request, response) => {
    response.json({ required: Boolean(deps.authRequired) });
  });

  // After the public probe so Express's case-insensitive match, not a path string, is what requires the token.
  router.use("/api/studio", requireStudioToken(deps.studioToken));

  router.get("/api/studio/storylines", (_request, response) => {
    const current = deps.live.current();
    response.json(current ? deps.desk.list(current.matchId) : []);
  });

  router.get("/api/studio/facts", (_request, response) => {
    const current = deps.live.current();
    response.json(current ? deps.desk.facts(current.matchId) : []);
  });

  router.post("/api/studio/storylines/:id/review", reviewLimiter, async (request, response, next) => {
    try {
      const payload = parseReviewRequest(request.body);
      response.json(await deps.desk.review(String(request.params.id), payload));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/studio/storyboard", (_request, response, next) => {
    try {
      const current = deps.live.current();
      if (!current) {
        throw new HttpError(404, "No live match");
      }
      response.json(deps.desk.storyboard(current));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/studio/health", (_request, response) => {
    response.json(deps.desk.health());
  });

  return router;
}
