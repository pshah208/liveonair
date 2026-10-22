import assert from "node:assert/strict";
import test from "node:test";

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
