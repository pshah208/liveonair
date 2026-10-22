import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import type { Storyline } from "../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import type { LiveService, StorylineDesk } from "../server/contracts.js";
import { buildTimedOverlay, createOverlayRouter, OVERLAY_SCHEMA } from "../server/routes/overlay.js";

function text(value: string) {
  return { en: value, es: value, fr: value, pt: value };
}

function storyline(id: string, status: Storyline["status"], minute: number, priority: number): Storyline {
  return {
    id,
    matchId: "match-1",
    triggerEventIds: ["goal-1"],
    triggerMinute: minute,
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: `2026-07-27T12:0${priority}:00.000Z`,
    status,
    priority,
    headline: text("Approved headline"),
    onAirLine: text("On-air line"),
    overlay: text("Lower third"),
    claims: [{ id: "c1", kind: "live_event", text: text("Goal"), sources: [{ type: "event", id: "goal-1" }], status: "verified" }],
    trace: [],
    version: 3,
  };
}

function fixture(): MatchFixture {
  const goal = (id: string, teamId: "home" | "away", rescinded = false): MatchEvent => ({
    id, revision: rescinded ? 2 : 1, minute: 1, second: 0, type: "goal", teamId, playerId: "p1", outcome: "success", x: 90, y: 50, rescinded,
  });
  return {
    id: "fixture-overlay",
    seed: 1,
    title: "Blue FC vs Red FC",
    description: "Synthetic overlay fixture",
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: [] },
    away: { id: "away", name: "Red FC", shortName: "RED", players: [] },
    events: [goal("goal-home", "home"), goal("goal-away", "away", true)],
    durationSeconds: 5400,
    correctionEventId: "goal-away",
    correctionAvailableAt: 120,
  };
}

function harness(clockSecond: number, storylines: Storyline[]) {
  const live = {
    status: () => ({ state: "running", transport: "local", transportConfigured: false, clockSecond, speed: 1, eventsReceived: 1, duplicatesIgnored: 0, stress: false }),
    current: () => ({ matchId: "match-1", fixture: fixture(), clockSecond }),
    addListener: () => () => undefined,
    subscribeTicks: () => () => undefined,
  } as unknown as LiveService & { subscribeTicks: () => () => void };
  const desk = {
    list: () => storylines,
    subscribe: () => () => undefined,
  } as unknown as StorylineDesk;
  return { live, desk };
}

test("timed overlay keeps one approved lower third and omits playerTags", () => {
  const { live, desk } = harness(70, [
    storyline("draft", "drafting", 1, 9),
    storyline("approved-low", "approved", 1, 1),
    storyline("approved-high", "approved", 1, 5),
    storyline("too-old", "approved", 0, 9),
  ]);
  const overlay = buildTimedOverlay(live, desk, new Date("2026-07-27T12:00:00.000Z"));
  assert.equal(overlay.schema, OVERLAY_SCHEMA);
  assert.equal(overlay.holdSeconds, 20);
  assert.equal(overlay.match?.score.home, 1);
  assert.equal(overlay.match?.score.away, 0);
  assert.equal(overlay.lowerThird?.storylineId, "approved-high");
  assert.equal(overlay.lowerThird?.validFromSecond, 60);
  assert.equal(overlay.lowerThird?.validUntilSecond, 80);
  assert.equal(JSON.stringify(overlay).includes("playerTags"), false);

  const expired = buildTimedOverlay(harness(80, [storyline("approved-high", "approved", 1, 5)]).live, harness(80, [storyline("approved-high", "approved", 1, 5)]).desk);
  assert.equal(expired.lowerThird, null);
  assert.equal(JSON.stringify(expired).includes("playerTags"), false);
});

test("GET /api/overlay/current and the SSE channel follow the contract", async () => {
  const { live, desk } = harness(70, [storyline("approved-high", "approved", 1, 5)]);
  const app = express();
  app.use(createOverlayRouter({ live, desk }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const current = await (await fetch(`${baseUrl}/api/overlay/current`)).json() as { schema: string; lowerThird: { storylineId: string } | null };
    assert.equal(current.schema, "live-on-air.overlay/1");
    assert.equal(current.lowerThird?.storylineId, "approved-high");
    assert.equal(JSON.stringify(current).includes("playerTags"), false);

    const stream = await fetch(`${baseUrl}/api/overlay/stream`);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const chunk = await reader.read();
    const textBody = new TextDecoder().decode(chunk.value);
    assert.match(textBody, /data: /);
    assert.equal(textBody.includes("playerTags"), false);
    assert.match(textBody, /approved-high/);
    await reader.cancel();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
