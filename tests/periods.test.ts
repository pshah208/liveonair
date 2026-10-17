import assert from "node:assert/strict";
import test from "node:test";

import { eventPeriod, filterByPeriod, isMatchPeriod, periodBoundary, periodScope, periodWindow } from "../shared/periods.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import { getFixture } from "../server/fixtures.js";
import { generateMatch } from "../server/matchlab/generator.js";

function event(id: string, minute: number, second: number, overrides: Partial<MatchEvent> = {}): MatchEvent {
  return { id, revision: 1, minute, second, type: "pass", teamId: "home", playerId: "h1", outcome: "complete", x: 50, y: 50, ...overrides };
}

function fixture(events: MatchEvent[], overrides: Partial<MatchFixture> = {}): MatchFixture {
  return {
    id: "legacy-1", seed: 1, title: "Legacy", description: "",
    home: { id: "home", name: "Home", shortName: "HOM", players: [{ id: "h1", name: "Ana", number: 9, position: "FW", teamId: "home" }] },
    away: { id: "away", name: "Away", shortName: "AWY", players: [{ id: "a1", name: "Bo", number: 1, position: "GK", teamId: "away" }] },
    events, durationSeconds: 5400, correctionEventId: "", correctionAvailableAt: 9999, ...overrides,
  };
}

test("synthetic fixtures carry period metadata and annotate every event", () => {
  for (const match of [getFixture("rivergate-comeback"), generateMatch({ scenario: "goal_fest", seed: 7 })]) {
    assert.deepEqual(match.periods, { source: "synthetic", halftimeSecond: 45 * 60 });
    for (const item of match.events) {
      const second = item.minute * 60 + item.second;
      assert.equal(item.period, second <= 45 * 60 ? 1 : 2, `${item.id} at ${second}`);
    }
    assert.equal(match.events.find((item) => item.type === "halftime")?.period, 1);
    assert.equal(match.events.find((item) => item.type === "fulltime")?.period, 2);
  }
});

test("legacy fixtures split on the halftime event: stoppage time and the exact boundary stay in the first half", () => {
  const legacy = fixture([
    event("e1", 30, 0),
    event("stoppage", 46, 30),
    event("ht", 47, 0, { type: "halftime", outcome: "none" }),
    event("tie", 47, 0),
    event("e2", 47, 1),
    event("e3", 70, 0),
  ]);
  const boundary = periodBoundary(legacy);
  assert.deepEqual(boundary, { available: true, halftimeSecond: 47 * 60 });
  const periods = Object.fromEntries(legacy.events.map((item) => [item.id, eventPeriod(item, boundary)]));
  assert.deepEqual(periods, { e1: 1, stoppage: 1, ht: 1, tie: 1, e2: 2, e3: 2 });
  assert.deepEqual(filterByPeriod(legacy.events, "second", boundary).map((item) => item.id), ["e2", "e3"]);
  assert.equal(filterByPeriod(legacy.events, "full", boundary).length, legacy.events.length);
});

test("explicit event periods win over the clock and a rescinded halftime is ignored", () => {
  const match = fixture([
    event("late-first", 48, 0, { period: 1 }),
    event("ht-old", 45, 0, { type: "halftime", outcome: "none" }),
    event("ht-old", 45, 0, { type: "halftime", outcome: "none", revision: 2, rescinded: true }),
    event("ht", 48, 30, { type: "halftime", outcome: "none" }),
    event("early-second", 48, 10, { period: 2 }),
  ]);
  const boundary = periodBoundary(match);
  assert.equal(boundary.halftimeSecond, 48 * 60 + 30);
  assert.equal(eventPeriod(match.events[0]!, boundary), 1);
  assert.equal(eventPeriod(match.events[4]!, boundary), 2);
});

test("scope reports not started and unavailable separately from empty periods", () => {
  const synthetic = getFixture("rivergate-comeback");
  assert.deepEqual(periodScope(synthetic, "full", 0), { period: "full", available: true });
  assert.deepEqual(periodScope(synthetic, "first", 10), { period: "first", available: true });
  assert.deepEqual(periodScope(synthetic, "second", 45 * 60), { period: "second", available: false, reason: "not_started" });
  assert.deepEqual(periodScope(synthetic, "second", 45 * 60 + 1), { period: "second", available: true });

  const unknown = fixture([event("e1", 10, 0), event("e2", 80, 0)]);
  assert.deepEqual(periodScope(unknown, "first", 5400), { period: "first", available: false, reason: "unavailable" });
  assert.deepEqual(periodScope(unknown, "full", 5400), { period: "full", available: true });

  const explicit = fixture([event("e1", 10, 0, { period: 1 }), event("e2", 50, 0, { period: 2 })]);
  assert.equal(periodScope(explicit, "second", 49 * 60).reason, "not_started");
  assert.equal(periodScope(explicit, "second", 50 * 60).available, true);
});

test("video-derived fixtures never split halves, even with a halftime-like event or clip midpoint", () => {
  const clip = fixture([
    event("e1", 2, 0),
    event("ht", 45, 0, { type: "halftime", outcome: "none" }),
    event("e2", 50, 0),
  ], { id: "video-abc" });
  assert.deepEqual(periodBoundary(clip), { available: false, halftimeSecond: null });
  assert.equal(periodScope(clip, "first", 5400).reason, "unavailable");
  assert.equal(periodScope(clip, "second", 5400).reason, "unavailable");
  assert.deepEqual(filterByPeriod(clip.events, "first", periodBoundary(clip)), []);
  assert.equal(periodBoundary(fixture([event("ht", 45, 0, { type: "halftime", outcome: "none" })], { periods: { source: "video_unknown" } })).available, false);
});

test("period windows clamp to the selected half and the analysed watermark", () => {
  const boundary = { available: true, halftimeSecond: 2700 };
  assert.deepEqual(periodWindow("full", boundary, 4000), { start: 0, end: 4000 });
  assert.deepEqual(periodWindow("first", boundary, 4000), { start: 0, end: 2700 });
  assert.deepEqual(periodWindow("first", boundary, 1200), { start: 0, end: 1200 });
  assert.deepEqual(periodWindow("first", boundary, 4000, [event("stoppage", 46, 20)]), { start: 0, end: 2780 });
  assert.deepEqual(periodWindow("second", boundary, 4000), { start: 2701, end: 4000 });
  assert.ok(isMatchPeriod("first") && !isMatchPeriod("third"));
});
