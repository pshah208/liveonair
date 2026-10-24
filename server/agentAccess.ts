import { timingSafeEqual } from "node:crypto";

import type { Request } from "express";

import { isMatchInProgress, type Storyline } from "../shared/platform.js";
import type { LiveMatchView, LiveService } from "./contracts.js";

/** Constant-time check of `Authorization: Bearer <token>`. */
export function bearerMatches(request: Request, token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const header = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  if (!match) {
    return false;
  }
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Clock the public live endpoints use: the live second while running or paused, or the whole match once it has stopped. */
export function liveClock(live: LiveService, view: LiveMatchView): number {
  const status = live.status();
  return isMatchInProgress(status.state)
    ? Math.min(view.fixture.durationSeconds, Math.max(0, Math.round(status.clockSecond)))
    : view.fixture.durationSeconds;
}

/**
 * Public projection of a storyline for external agents. Only human-approved copy is public; studio callers
 * (authenticated) also see drafts and the handoff log, clearly labelled with their review status.
 */
export function projectStoryline(storyline: Storyline, studio: boolean) {
  return {
    id: storyline.id,
    matchId: storyline.matchId,
    status: storyline.status,
    approved: storyline.status === "approved",
    triggerEventIds: storyline.triggerEventIds,
    triggerMinute: storyline.triggerMinute,
    priority: storyline.priority,
    headline: storyline.headline,
    onAirLine: storyline.onAirLine,
    overlay: storyline.overlay,
    claims: storyline.claims
      .filter((claim) => claim.status === "verified")
      .map((claim) => ({ kind: claim.kind, text: claim.text.en, sources: claim.sources })),
    review: storyline.review,
    retractionReason: storyline.retractionReason,
    ...(studio ? { handoffs: storyline.handoffs ?? [], failureReason: storyline.failureReason } : {}),
  };
}

/**
 * Public (fan / unauthenticated agent) visibility: approved copy, or the retraction of copy that was approved
 * before it was withdrawn. Never-approved drafts stay in the studio even after they are retracted.
 */
export function isPublicStoryline(storyline: Storyline): boolean {
  return storyline.status === "approved" || (storyline.status === "retracted" && Boolean(storyline.approvedAt));
}

export function visibleStorylines(storylines: Storyline[], studio: boolean): Storyline[] {
  return studio ? storylines : storylines.filter(isPublicStoryline);
}
