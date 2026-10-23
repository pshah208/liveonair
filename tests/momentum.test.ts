import assert from "node:assert/strict";
import test from "node:test";

import { getFixture } from "../server/fixtures.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { computeMomentum, controlVsChaos } from "../shared/momentum.js";
import type { MatchEvent } from "../shared/types.js";

function e(partial: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type" | "teamId" | "playerId">): MatchEvent {
  return {
    revision: 1,
    minute: 0,
    second: 0,
    outcome: "complete",
    x: 50,
    y: 50,
    ...partial,
  };
}

test("momentum is deterministic for a fixed generated seed", () => {
  const fixture = generateMatch({ scenario: "goal_fest", seed: 404 });
  const a = computeMomentum(fixture.events);
  const b = computeMomentum(fixture.events);
  assert.deepEqual(a, b);
});

test("momentum coverage uses observed minutes rather than the padded 90-minute grid", () => {
  const events = Array.from({ length: 15 }, (_, index) =>
    e({ id: `early-${index}`, type: "pass", teamId: "home", playerId: "h8", minute: Math.floor(index / 2), second: (index % 2) * 20 }),
  );
  const momentum = computeMomentum(events);
  assert.equal(momentum.points.length, 91);
  assert.equal(momentum.insufficientCoverage, false);
  assert.equal(computeMomentum([]).insufficientCoverage, true);
  assert.equal(computeMomentum(events, { minEventsPerMinute: 2 }).insufficientCoverage, true);
});

test("balanced synthetic stream stays near neutral net momentum", () => {
  const events: MatchEvent[] = [
    e({ id: "h1", type: "pass", teamId: "home", playerId: "h8", minute: 3, x: 40, y: 50, endX: 70, endY: 50 }),
    e({ id: "a1", type: "pass", teamId: "away", playerId: "a8", minute: 3, second: 20, x: 40, y: 50, endX: 70, endY: 50 }),
    e({ id: "hs", type: "shot", teamId: "home", playerId: "h9", minute: 6, x: 84, y: 52, outcome: "miss" }),
    e({ id: "as", type: "shot", teamId: "away", playerId: "a9", minute: 6, second: 20, x: 84, y: 48, outcome: "miss" }),
  ];
  const momentum = computeMomentum(events, { minEventsPerMinute: 0.1 });
  const mean = momentum.points.reduce((sum, point) => sum + point.netThreat, 0) / momentum.points.length;
  assert.ok(Math.abs(mean) < 0.05);
});

test("one-sided stream signs momentum and goal markers to minute", () => {
  const events: MatchEvent[] = [
    e({ id: "p1", type: "pass", teamId: "home", playerId: "h8", minute: 10, x: 35, y: 52, endX: 65, endY: 50 }),
    e({ id: "p2", type: "pass", teamId: "home", playerId: "h10", minute: 10, second: 10, x: 65, y: 50, endX: 82, endY: 49 }),
    e({ id: "s1", type: "shot", teamId: "home", playerId: "h9", minute: 10, second: 15, x: 88, y: 50, outcome: "success" }),
    e({ id: "g1", type: "goal", teamId: "home", playerId: "h9", minute: 10, second: 16, outcome: "success", relatedEventId: "s1" }),
    e({ id: "sub", type: "substitution", teamId: "home", playerId: "h14", minute: 11, outcome: "none" }),
  ];
  const momentum = computeMomentum(events, { minEventsPerMinute: 0.1 });
  assert.ok(momentum.points.some((point) => point.netThreat > 0.05));
  assert.deepEqual(momentum.goals.map((goal) => goal.minute), [10]);
  assert.deepEqual(momentum.substitutions.map((substitution) => substitution.minute), [11]);
});

test("control-vs-chaos tracks window pressure deltas and guards sparse windows", () => {
  const events: MatchEvent[] = [
    e({ id: "p1", type: "pass", teamId: "home", playerId: "h8", minute: 0, second: 10, x: 50, y: 50, endX: 70, endY: 50, outcome: "complete" }),
    e({ id: "pr1", type: "pressure", teamId: "away", playerId: "a4", minute: 0, second: 9, x: 50, y: 50, relatedEventId: "p1", outcome: "success" }),
    e({ id: "p2", type: "pass", teamId: "home", playerId: "h8", minute: 6, second: 10, x: 50, y: 50, endX: 70, endY: 50, outcome: "complete" }),
    e({ id: "pr2", type: "pressure", teamId: "away", playerId: "a5", minute: 6, second: 8, x: 50, y: 50, relatedEventId: "p2", outcome: "success" }),
  ];
  const windows = controlVsChaos(events, 5);
  assert.equal(windows[0]!.matchedPressureEvents, 1);
  assert.equal(windows[1]!.pressureDeltaFromPrevious, 0);
  assert.ok(windows.some((window) => window.insufficientCoverage));
});

test("generated five-minute passages include non-chaotic windows even when high pressure drives chaos-heavy labels", () => {
  const totals = { controlled: 0, mixed: 0, chaotic: 0 };
  for (const seed of [1, 2, 3, 4, 5]) {
    const fixture = generateMatch({ scenario: "goal_fest", seed });
    const windows = controlVsChaos(fixture.events).filter((window) => window.endMinute <= 90);
    assert.deepEqual(controlVsChaos(fixture.events), controlVsChaos(fixture.events), `seed ${seed} is deterministic`);
    assert.equal(windows.length, 18);
    assert.ok(windows.every((window) => !window.insufficientCoverage), `seed ${seed} has adequate coverage`);
    assert.ok(windows.filter((window) => window.lowDetail).length <= 1, `seed ${seed} is mostly dense`);
    const counts = { controlled: 0, mixed: 0, chaotic: 0 };
    for (const window of windows) counts[window.label] += 1;
    assert.ok(counts.chaotic > 0, `seed ${seed}: includes chaotic windows`);
    assert.ok(counts.controlled + counts.mixed >= 2, `seed ${seed}: keeps non-chaotic windows`);
    for (const label of ["controlled", "mixed", "chaotic"] as const) totals[label] += counts[label];
  }
  assert.ok(totals.chaotic > totals.controlled + totals.mixed, "high-pressure generator now yields chaos-heavy rhythm labels");
  assert.ok(totals.controlled > 0 && totals.mixed > 0);
});

test("sparse staged live fixture gets conservative low-detail readings by minute 43", () => {
  const staged = getFixture("rivergate-comeback").events.filter((event) => event.minute <= 43);
  const windows = controlVsChaos(staged).filter((window) => window.endMinute <= 40);
  assert.equal(windows.length, 8);
  assert.ok(windows.some((window) => !window.insufficientCoverage && window.lowDetail));
  const latest = windows.at(-1)!;
  assert.equal(latest.startMinute, 35);
  assert.equal(latest.label, "mixed");
  assert.equal(latest.insufficientCoverage, false);
  assert.equal(latest.lowDetail, true);
  assert.equal(latest.possessionChanges, 3);
  assert.equal(controlVsChaos(staged)[0]!.insufficientCoverage, true);
});

test("rate and sequence thresholds do not call isolated shots or ordinary switches chaos", () => {
  const passes = Array.from({ length: 16 }, (_, index) =>
    e({ id: `pass-${index}`, minute: Math.floor(index / 4), second: (index % 4) * 10,
      type: "pass", teamId: index < 8 ? "home" : "away", playerId: "h8" }),
  );
  const shots = Array.from({ length: 3 }, (_, index) =>
    e({ id: `shot-${index}`, type: "shot", teamId: "away", playerId: "a9", minute: 4, second: index * 10 + 20 }),
  );
  const window = controlVsChaos([...passes, ...shots])[0]!;
  assert.equal(window.shots, 3);
  assert.equal(window.label, "controlled");
  assert.equal(window.avgSequenceLength, 9.5);
  assert.equal(window.turnoverRate, 0.056);
});

test("low-detail chaos needs a shot flurry as well as frequent switches", () => {
  const events = Array.from({ length: 8 }, (_, index) =>
    e({ id: `action-${index}`, type: index < 3 ? "shot" : "pass",
      teamId: index % 2 ? "away" : "home", playerId: "p9",
      minute: index < 4 ? 1 : 2, second: (index % 4) * 10 }),
  );
  const window = controlVsChaos(events)[0]!;
  assert.equal(window.lowDetail, true);
  assert.equal(window.insufficientCoverage, false);
  assert.equal(window.shots, 3);
  assert.equal(window.label, "chaotic");
  assert.equal(controlVsChaos(events.filter((event) => event.type !== "shot"))[0]!.insufficientCoverage, true);
});
