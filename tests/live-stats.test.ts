import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { computeStats, countShotsOnTarget, passSharePossession } from "../server/engine.js";
import type { MatchEvent } from "../shared/types.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

let seq = 0;
function ev(partial: Partial<MatchEvent> & Pick<MatchEvent, "type" | "teamId">): MatchEvent {
  seq += 1;
  return {
    id: partial.id ?? `e${seq}`,
    revision: 1,
    minute: partial.minute ?? 10,
    second: partial.second ?? seq,
    playerId: partial.playerId ?? `${partial.teamId}-p9`,
    outcome: partial.outcome ?? "none",
    x: partial.x ?? 85,
    y: partial.y ?? 50,
    ...partial
  };
}

test("shot + goal pair counts once as a shot on target", () => {
  const events = [
    ev({ id: "s1", type: "shot", teamId: "home", outcome: "success", xg: 0.2 }),
    ev({ id: "g1", type: "goal", teamId: "home", outcome: "success", relatedEventId: "s1" })
  ];
  assert.deepEqual(countShotsOnTarget(events), { home: 1, away: 0 });
  const stats = computeStats(events);
  assert.equal(stats.home.shotsOnTarget, 1);
  assert.equal(stats.home.shots, 1);
  assert.equal(stats.home.goals, 1);
});

test("goal linked from the shot side (shot.relatedEventId = goal id) is not double-counted", () => {
  const events = [
    ev({ id: "g2", type: "goal", teamId: "away", outcome: "success" }),
    ev({ id: "s2", type: "shot", teamId: "away", outcome: "success", relatedEventId: "g2" })
  ];
  assert.deepEqual(countShotsOnTarget(events), { home: 0, away: 1 });
});

test("goal with no logged shot counts as a shot on target", () => {
  const events = [ev({ id: "g3", type: "goal", teamId: "away", outcome: "success" })];
  const stats = computeStats(events);
  assert.equal(stats.away.shotsOnTarget, 1);
  assert.equal(stats.away.shots, 0);
});

test("goal whose linked shot is rescinded counts once via the goal", () => {
  const events = [
    ev({ id: "s4", type: "shot", teamId: "home", outcome: "success", rescinded: true }),
    ev({ id: "g4", type: "goal", teamId: "home", outcome: "success", relatedEventId: "s4" })
  ];
  assert.deepEqual(countShotsOnTarget(events), { home: 1, away: 0 });
});

test("rescinded goal without a shot is excluded; saved shots count; misses and blocks do not", () => {
  const events = [
    ev({ id: "g5", type: "goal", teamId: "home", outcome: "success", rescinded: true }),
    ev({ type: "shot", teamId: "home", outcome: "saved" }),
    ev({ type: "shot", teamId: "home", outcome: "miss" }),
    ev({ type: "shot", teamId: "home", outcome: "blocked" })
  ];
  const stats = computeStats(events);
  assert.equal(stats.home.shotsOnTarget, 1);
  assert.equal(stats.home.goals, 0);
  assert.equal(stats.home.shots, 3);
});

test("saves are credited to the keeper's team and never inferred from shot outcome", () => {
  const events = [
    ev({ id: "s6", type: "shot", teamId: "home", outcome: "saved" }),
    ev({ type: "save", teamId: "away", playerId: "away-p1", outcome: "success", relatedEventId: "s6" }),
    ev({ type: "shot", teamId: "home", outcome: "saved" }),
    ev({ type: "save", teamId: "away", playerId: "away-p1", outcome: "success", rescinded: true })
  ];
  const stats = computeStats(events);
  assert.equal(stats.away.saves, 1);
  assert.equal(stats.home.saves, 0);
  assert.equal(stats.home.shotsOnTarget, 2);
});

test("possession (pass share) sums to 100 and uses attempted passes", () => {
  const events = [
    ...Array.from({ length: 2 }, () => ev({ type: "pass", teamId: "home", outcome: "complete" })),
    ev({ type: "pass", teamId: "home", outcome: "incomplete" }),
    ...Array.from({ length: 4 }, () => ev({ type: "pass", teamId: "away", outcome: "complete" }))
  ];
  const stats = computeStats(events);
  assert.equal(stats.home.passes, 3);
  assert.equal(stats.home.possessionPct, 43);
  assert.equal(stats.away.possessionPct, 57);
  for (const [h, a] of [[1, 2], [1, 1], [7, 3], [1, 0], [5, 13]]) {
    const share = passSharePossession(h, a);
    assert.equal((share.home ?? 0) + (share.away ?? 0), 100, `${h}/${a}`);
  }
});

test("possession is null for both teams when neither has attempted a pass", () => {
  const stats = computeStats([ev({ type: "shot", teamId: "home", outcome: "miss" })]);
  assert.equal(stats.home.possessionPct, null);
  assert.equal(stats.away.possessionPct, null);
  assert.deepEqual(passSharePossession(0, 0), { home: null, away: null });
});

test("Live stats table rows: order and labels", () => {
  const src = read("src/components.tsx");
  const block = src.slice(src.indexOf("const STAT_ROWS"), src.indexOf("export function LiveStats"));
  const labels = [...block.matchAll(/\{ label: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(labels, [
    "Possession (pass share, est.)",
    "Shots",
    "Shots on target",
    "illustrative xG",
    "Passes",
    "Pass accuracy",
    "Corners",
    "Fouls",
    "Tackles",
    "Interceptions",
    "Ball recoveries",
    "Yellow cards",
    "Red cards",
    "Saves",
    "Avg pass length",
    "Long-pass accuracy",
    "Avg pass difficulty (illustrative, uncalibrated)",
    "Completion vs heuristic (illustrative, uncalibrated)",
    "Fastest shot"
  ]);
  assert.match(block, /hint: "Share of attempted passes; not time on the ball"/);
  assert.match(block, /stats\.possessionPct, format: \(value\) => `\$\{Math\.round\(value\)\}%`/);
  assert.doesNotMatch(block, /label: "Cards"/);
  // Older snapshots without the new fields hide those rows rather than showing zeros.
  assert.match(src, /if \(homeValue === undefined && awayValue === undefined\) return null;/);
});
