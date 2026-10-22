import assert from "node:assert/strict";
import test from "node:test";

import { placeEvent } from "../shared/ballPath.js";
import { buildTrackingFrame, maxPlayerSpeedMps, TRACKING_PITCH_LENGTH_M, TRACKING_PITCH_WIDTH_M } from "../shared/tracking.js";
import type { MatchFixture, Player } from "../shared/types.js";

function makePlayers(teamId: "home" | "away"): Player[] {
  const roles = ["GK", "RB", "CB", "CB", "LB", "DM", "CM", "CM", "RW", "LW", "ST"] as const;
  return roles.map((position, index) => ({
    id: `${teamId}-p${index + 1}`,
    teamId,
    name: `${teamId}-${position}-${index + 1}`,
    number: index + 1,
    position,
  }));
}

function fixture(): MatchFixture {
  return {
    id: "tracking-fixture",
    seed: 424242,
    title: "Blue vs Red",
    description: "tracking test fixture",
    home: { id: "home", name: "Blue", shortName: "BLU", players: makePlayers("home") },
    away: { id: "away", name: "Red", shortName: "RED", players: makePlayers("away") },
    events: [
      { id: "e0", revision: 1, minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p10", outcome: "none", x: 50, y: 50 },
      { id: "e1", revision: 1, minute: 0, second: 5, type: "pass", teamId: "home", playerId: "home-p7", outcome: "complete", x: 44, y: 48, endX: 56, endY: 51 },
      { id: "e2", revision: 1, minute: 0, second: 9, type: "pass", teamId: "away", playerId: "away-p6", outcome: "complete", x: 61, y: 56, endX: 48, endY: 50 },
      { id: "e3", revision: 1, minute: 0, second: 13, type: "shot", teamId: "home", playerId: "home-p11", outcome: "saved", x: 83, y: 49 },
    ],
    durationSeconds: 180,
    correctionEventId: "e3",
    correctionAvailableAt: 100,
  };
}

test("every tracking frame carries 22 players inside 105x68 bounds", () => {
  const f = fixture();
  for (const second of [0, 1, 4.2, 9, 11.6, 17]) {
    const frame = buildTrackingFrame(f, second);
    assert.equal(frame.players.length, 22);
    for (const player of frame.players) {
      assert.ok(player.x >= 0 && player.x <= TRACKING_PITCH_LENGTH_M, `x out of bounds: ${player.id}`);
      assert.ok(player.y >= 0 && player.y <= TRACKING_PITCH_WIDTH_M, `y out of bounds: ${player.id}`);
    }
  }
});

test("tracking movement stays under ~10 m/s between 5 Hz frames", () => {
  const f = fixture();
  let previous = buildTrackingFrame(f, 0);
  for (let step = 1; step <= 120; step += 1) {
    const current = buildTrackingFrame(f, step / 5);
    const maxSpeed = maxPlayerSpeedMps(previous, current);
    assert.ok(maxSpeed <= 10.5, `max speed ${maxSpeed.toFixed(2)} m/s`);
    previous = current;
  }
});

test("ball sits at event location on event timestamps and actor stays near it", () => {
  const f = fixture();
  for (const event of f.events) {
    const at = event.minute * 60 + event.second;
    const frame = buildTrackingFrame(f, at);
    const point = placeEvent(f, event);
    const expectedX = (point.x / 100) * TRACKING_PITCH_LENGTH_M;
    const expectedY = TRACKING_PITCH_WIDTH_M - (point.y / 100) * TRACKING_PITCH_WIDTH_M;
    assert.ok(Math.abs(frame.ball.x - expectedX) < 0.01, `${event.id} x`);
    assert.ok(Math.abs(frame.ball.y - expectedY) < 0.01, `${event.id} y`);
    const actor = frame.players.find((player) => player.id === event.playerId);
    assert.ok(actor, `${event.id} actor missing`);
    assert.ok(Math.hypot((actor?.x ?? 0) - frame.ball.x, (actor?.y ?? 0) - frame.ball.y) <= 1.5, `${event.id} actor far from ball`);
  }
});

test("tracking generation is deterministic per seed and input fixture", () => {
  const f = fixture();
  const a = buildTrackingFrame(f, 12.4);
  const b = buildTrackingFrame(f, 12.4);
  assert.deepEqual(a, b);
});
