import assert from "node:assert/strict";
import test from "node:test";

import { ballRoute, buildBallPath, placeEvent } from "../shared/ballPath.js";
import type { MatchEvent } from "../shared/types.js";

function event(overrides: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type">): MatchEvent {
  return { revision: 1, minute: 10, second: 0, teamId: "home", playerId: "p1", outcome: "complete", x: 50, y: 50, ...overrides };
}

const fixture = { id: "fixture-1" };

test("away coordinates are mirrored so both teams share one pitch frame", () => {
  assert.deepEqual(placeEvent(fixture, event({ id: "a", type: "shot", teamId: "away", x: 88, y: 40 })), { x: 12, y: 60 });
  assert.deepEqual(placeEvent(fixture, event({ id: "h", type: "shot", teamId: "home", x: 88, y: 40 })), { x: 88, y: 40 });
  // A home keeper's save is logged in the away shooter's frame.
  assert.deepEqual(placeEvent(fixture, event({ id: "s", type: "save", teamId: "home", x: 93, y: 50 })), { x: 7, y: 50 });
  // Camera-derived fixtures keep screen positions.
  assert.deepEqual(placeEvent({ id: "video-abc" }, event({ id: "v", type: "shot", teamId: "away", x: 88, y: 40 })), { x: 88, y: 40 });
});

test("ball path links passes, bridges short gaps and ends a scoring shot in the net", () => {
  const path = buildBallPath(fixture, [
    event({ id: "p1", type: "pass", second: 0, x: 40, y: 50, endX: 60, endY: 40 }),
    event({ id: "p2", type: "pass", second: 4, x: 62, y: 42, endX: 80, endY: 45 }),
    event({ id: "s1", type: "shot", second: 7, x: 84, y: 47, outcome: "success" }),
    event({ id: "g1", type: "goal", second: 8, x: 95, y: 49, outcome: "success", relatedEventId: "s1" }),
  ]);
  assert.deepEqual(path.segments.map((segment) => `${segment.kind}${segment.inferred ? "*" : ""}`), ["pass", "carry*", "pass", "carry*", "goal"]);
  const goal = path.segments.at(-1)!;
  assert.equal(goal.to.x, 100);
  assert.deepEqual(path.ball, { x: 50, y: 50 }, "after a goal the ball returns to the centre spot");
  assert.equal(path.touches.length, 4);
  assert.ok(ballRoute(path).length >= 6);
});

test("long gaps, cards and rescinded events do not invent ball movement", () => {
  const path = buildBallPath(fixture, [
    event({ id: "p1", type: "pass", second: 0, x: 40, y: 50, endX: 60, endY: 40 }),
    event({ id: "r1", type: "red_card", second: 5, x: 10, y: 10 }),
    event({ id: "p2", type: "pass", minute: 12, second: 0, x: 30, y: 30, endX: 35, endY: 35 }),
    event({ id: "x1", type: "shot", minute: 12, second: 5, x: 80, y: 50, outcome: "miss", rescinded: true }),
  ]);
  assert.deepEqual(path.segments.map((segment) => segment.kind), ["pass", "pass"]);
  assert.ok(path.touches.every((touch) => touch.type !== "red_card"));
});

test("corners start from the attacking flag and a saved shot stops at the goal line", () => {
  const path = buildBallPath(fixture, [
    event({ id: "c1", type: "corner", teamId: "away", x: 0, y: 5, endX: 85, endY: 58 }),
    event({ id: "s1", type: "shot", teamId: "away", second: 6, x: 85, y: 58, outcome: "saved" }),
  ]);
  const cross = path.segments[0]!;
  assert.equal(cross.kind, "cross");
  assert.equal(cross.from.x, 0, "an away corner is taken at the left-hand flag");
  const shot = path.segments.at(-1)!;
  assert.equal(shot.kind, "shot");
  assert.equal(shot.to.x, 3);
});
