import express from "express";

import type { Storyline } from "../../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../../shared/types.js";
import type { LiveService, StorylineDesk } from "../contracts.js";
import { type TickSource } from "../live/service.js";
import { createSseGate, streamCap } from "../live/sse.js";

/** How long an approved lower third stays on the graphic after its trigger minute. */
export const OVERLAY_HOLD_SECONDS = 20;
export const OVERLAY_SCHEMA = "live-on-air.overlay/1";

export interface TimedOverlay {
  schema: typeof OVERLAY_SCHEMA;
  generatedAt: string;
  holdSeconds: number;
  match: null | {
    matchId: string;
    fixtureId: string;
    title: string;
    state: "idle" | "running" | "paused" | "finished";
    clockSecond: number;
    minute: number;
    second: number;
    score: { home: number; away: number };
    home: { name: string; shortName: string };
    away: { name: string; shortName: string };
  };
  lowerThird: null | {
    storylineId: string;
    version: number;
    status: "approved";
    minute: number;
    validFromSecond: number;
    validUntilSecond: number;
    headline: Storyline["headline"];
    overlay: Storyline["overlay"];
    onAirLine: Storyline["onAirLine"];
    claimSources: Array<{ type: "event" | "archive"; id: string }>;
  };
}

function latestEvents(events: MatchEvent[]): MatchEvent[] {
  const byId = new Map<string, MatchEvent>();
  for (const event of events) {
    const current = byId.get(event.id);
    if (!current || event.revision >= current.revision) byId.set(event.id, event);
  }
  return [...byId.values()];
}

function scoreOf(fixture: MatchFixture): { home: number; away: number } {
  const score = { home: 0, away: 0 };
  for (const event of latestEvents(fixture.events)) {
    if (event.type === "goal" && !event.rescinded) score[event.teamId] += 1;
  }
  return score;
}

function visibleLowerThird(storylines: Storyline[], clockSecond: number): Storyline | undefined {
  const visible = storylines.filter((storyline) => {
    if (storyline.status !== "approved") return false;
    const from = storyline.triggerMinute * 60;
    return clockSecond >= from && clockSecond < from + OVERLAY_HOLD_SECONDS;
  });
  visible.sort((left, right) => right.priority - left.priority || right.updatedAt.localeCompare(left.updatedAt));
  return visible[0];
}

export function buildTimedOverlay(live: LiveService, desk: StorylineDesk, now = new Date()): TimedOverlay {
  const status = live.status();
  const view = live.current();
  const clockSecond = Math.max(0, Math.floor(status.clockSecond));
  const base: TimedOverlay = {
    schema: OVERLAY_SCHEMA,
    generatedAt: now.toISOString(),
    holdSeconds: OVERLAY_HOLD_SECONDS,
    match: null,
    lowerThird: null,
  };
  if (!view) return base;
  const storyline = visibleLowerThird(desk.list(view.matchId), clockSecond);
  return {
    ...base,
    match: {
      matchId: view.matchId,
      fixtureId: view.fixture.id,
      title: view.fixture.title,
      state: status.state,
      clockSecond,
      minute: Math.floor(clockSecond / 60),
      second: clockSecond % 60,
      score: scoreOf(view.fixture),
      home: { name: view.fixture.home.name, shortName: view.fixture.home.shortName },
      away: { name: view.fixture.away.name, shortName: view.fixture.away.shortName },
    },
    lowerThird: storyline ? {
      storylineId: storyline.id,
      version: storyline.version,
      status: "approved",
      minute: storyline.triggerMinute,
      validFromSecond: storyline.triggerMinute * 60,
      validUntilSecond: storyline.triggerMinute * 60 + OVERLAY_HOLD_SECONDS,
      headline: storyline.headline,
      overlay: storyline.overlay,
      onAirLine: storyline.onAirLine,
      claimSources: storyline.claims.flatMap((claim) => claim.sources),
    } : null,
  };
}

function tickSource(live: LiveService): TickSource | undefined {
  if ("subscribeTicks" in live && typeof live.subscribeTicks === "function") {
    return live as LiveService & TickSource;
  }
  return undefined;
}

export function createOverlayRouter(deps: { live: LiveService; desk: StorylineDesk; maxStreams?: number }): express.Router {
  const router = express.Router();
  const maxStreams = streamCap(deps.maxStreams, process.env.OVERLAY_STREAM_MAX);
  let active = 0;

  router.get("/api/overlay/current", (_request, response) => {
    response.json(buildTimedOverlay(deps.live, deps.desk));
  });

  router.get("/api/overlay/stream", (request, response) => {
    if (active >= maxStreams) {
      response.status(503).json({ error: "Overlay stream capacity reached" });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    let closed = false;
    const gate = createSseGate((chunk) => response.write(chunk));
    const send = () => {
      if (closed) return;
      gate.write(`data: ${JSON.stringify(buildTimedOverlay(deps.live, deps.desk))}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!closed && !gate.blocked) gate.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 15_000);
    heartbeat.unref?.();
    const unsubscribeDesk = deps.desk.subscribe(() => send());
    const unsubscribeLive = deps.live.addListener({
      onEvent() { send(); },
      onMatchStart() { send(); },
      onMatchEnd() { send(); },
      onPause() { send(); },
      onResume() { send(); },
    });
    const unsubscribeTick = tickSource(deps.live)?.subscribeTicks(() => send()) ?? (() => undefined);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribeDesk();
      unsubscribeLive();
      unsubscribeTick();
      release();
      response.end();
    };
    response.on("close", close);
    response.on("drain", () => {
      if (!closed) gate.drain();
    });
    request.on("close", close);
    send();
  });

  return router;
}
