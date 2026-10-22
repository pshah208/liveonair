import express from "express";

import type { FanMomentCredit } from "../../shared/fan.js";
import type { Storyline } from "../../shared/platform.js";
import { isPublicStoryline } from "../agentAccess.js";
import type { LiveService, StorylineDesk } from "../contracts.js";

export type { FanMomentCredit };

/** Desk agent roles that may be credited on a fan moment card. Anything else is never exposed. */
export const CREDITED_AGENT_ROLES = ["researcher", "tactics-analyst", "player-analyst", "verifier", "producer", "fact-checker", "localizer"] as const;

/**
 * Read-only credits for Fan View moment cards. Only producer-approved storylines, or approved storylines that
 * were later withdrawn, are listed. Drafts, review notes, failure details and trace text never leave the studio.
 */
export function fanMomentCredits(storylines: Storyline[]): FanMomentCredit[] {
  return storylines.filter(isPublicStoryline).map((storyline) => {
    const completed = new Set(storyline.trace.filter((step) => step.status === "complete").map((step) => step.role));
    const agents = CREDITED_AGENT_ROLES.filter((role) => completed.has(role));
    return {
      id: storyline.id,
      version: storyline.version,
      status: storyline.status === "approved" ? "approved" : "retracted",
      agents: [...agents],
      ...(completed.has("producer") ? { author: "producer" } : {}),
    };
  });
}

export function createFanMomentsRouter(deps: { live: LiveService; desk: StorylineDesk }): express.Router {
  const router = express.Router();
  router.get("/api/fan/moments", (_request, response) => {
    const view = deps.live.current();
    response.setHeader("Cache-Control", "no-store");
    if (!view) {
      response.json({ matchId: null, moments: [] });
      return;
    }
    response.json({ matchId: view.matchId, moments: fanMomentCredits(deps.desk.list(view.matchId)) });
  });
  return router;
}
