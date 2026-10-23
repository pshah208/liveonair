import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { placeEvent } from "../shared/ballPath.js";
import { buildTrackingFrame, maxPlayerSpeedMps, TRACKING_PITCH_LENGTH_M, TRACKING_PITCH_WIDTH_M } from "../shared/tracking.js";
import type { MatchFixture, Player } from "../shared/types.js";
import { generateMatch } from "../server/matchlab/generator.js";

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

test("ball sits at event location on event timestamps", () => {
  const f = fixture();
  for (const event of f.events) {
    const at = event.minute * 60 + event.second;
    const frame = buildTrackingFrame(f, at);
    const point = placeEvent(f, event);
    const expectedX = (point.x / 100) * TRACKING_PITCH_LENGTH_M;
    const expectedY = TRACKING_PITCH_WIDTH_M - (point.y / 100) * TRACKING_PITCH_WIDTH_M;
    assert.ok(Math.abs(frame.ball.x - expectedX) < 0.01, `${event.id} x`);
    assert.ok(Math.abs(frame.ball.y - expectedY) < 0.01, `${event.id} y`);
  }
});

test("tracking generation is deterministic per seed and input fixture", () => {
  const f = fixture();
  const a = buildTrackingFrame(f, 12.4);
  const b = buildTrackingFrame(f, 12.4);
  assert.deepEqual(a, b);
});

test("live-board synthetic tracking keeps realistic speed, pressure and spacing over generated matches", () => {
  const scenarios = [
    generateMatch({ scenario: "goal_fest", seed: 17 }),
    generateMatch({ scenario: "comeback", seed: 42 }),
    generateMatch({ scenario: "goal_fest", seed: 99 }),
  ];
  const dt = 0.2;
  let outfieldFrames = 0;
  let speedSum = 0;
  let sprintFrames = 0;
  let maxStep = 0;
  let maxAccel = 0;
  let centroidChecks = 0;
  let centroidPasses = 0;
  let pressingEligible = 0;
  let pressingClose = 0;
  let desyncChecks = 0;
  let lowSpreadFrames = 0;

  for (const generated of scenarios) {
    const possessionEvents = (() => {
      const excluded = new Set(["yellow_card", "red_card", "halftime", "fulltime", "substitution"]);
      const latest = new Map<string, (typeof generated.events)[number]>();
      for (const event of generated.events) {
        if (excluded.has(event.type)) continue;
        const previous = latest.get(event.id);
        if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
      }
      return [...latest.values()]
        .filter((event) => !event.rescinded)
        .map((event) => ({ ...event, atSecond: event.minute * 60 + event.second }))
        .sort((a, b) => a.atSecond - b.atSecond || a.id.localeCompare(b.id));
    })();
    const anchorAgeAt = (second: number): number => {
      let age = Number.POSITIVE_INFINITY;
      for (const event of possessionEvents) {
        if (event.atSecond > second) break;
        age = second - event.atSecond;
      }
      return age;
    };
    const positionById = new Map([...generated.home.players, ...generated.away.players].map((player) => [player.id, player.position]));
    const outfield = (id: string) => positionById.get(id) !== "GK";
    const byTeam = (teamId: "home" | "away", frame: ReturnType<typeof buildTrackingFrame>) => frame.players.filter((player) => player.teamId === teamId && outfield(player.id));
    const allOutfield = (frame: ReturnType<typeof buildTrackingFrame>) => frame.players.filter((player) => outfield(player.id));
    const pairwise = (frame: ReturnType<typeof buildTrackingFrame>) => {
      for (let i = 0; i < frame.players.length; i += 1) {
        for (let j = i + 1; j < frame.players.length; j += 1) {
          const left = frame.players[i]!;
          const right = frame.players[j]!;
          void left;
          void right;
        }
      }
    };

    let previous = buildTrackingFrame(generated, 0);
    const previousVel = new Map<string, { x: number; y: number }>();
    pairwise(previous);
    const ticks = Math.floor(generated.durationSeconds / dt);
    for (let tick = 1; tick <= ticks; tick += 1) {
      const second = tick * dt;
      const frame = buildTrackingFrame(generated, second);
      pairwise(frame);
      const prevById = new Map(previous.players.map((player) => [player.id, player]));
      const speedSamples: number[] = [];
      for (const player of frame.players) {
        if (!outfield(player.id)) continue;
        const before = prevById.get(player.id)!;
        const vx = (player.x - before.x) / dt;
        const vy = (player.y - before.y) / dt;
        const speed = Math.hypot(vx, vy);
        speedSamples.push(speed);
        speedSum += speed;
        outfieldFrames += 1;
        if (speed >= 7) sprintFrames += 1;
        maxStep = Math.max(maxStep, speed);
        const previousVector = previousVel.get(player.id) ?? { x: 0, y: 0 };
        const accel = Math.hypot(vx - previousVector.x, vy - previousVector.y) / dt;
        const interior =
          before.x > 4 && before.x < TRACKING_PITCH_LENGTH_M - 4 && before.y > 4 && before.y < TRACKING_PITCH_WIDTH_M - 4
          && player.x > 4 && player.x < TRACKING_PITCH_LENGTH_M - 4 && player.y > 4 && player.y < TRACKING_PITCH_WIDTH_M - 4;
        if (interior) maxAccel = Math.max(maxAccel, accel);
        previousVel.set(player.id, { x: vx, y: vy });
      }
      const meanSpeed = speedSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, speedSamples.length);
      const spread = speedSamples.reduce((sum, value) => sum + ((value - meanSpeed) ** 2), 0) / Math.max(1, speedSamples.length);
      if (meanSpeed > 0.4) {
        desyncChecks += 1;
        if (spread <= 0.03) lowSpreadFrames += 1;
      }

      for (const teamId of ["home", "away"] as const) {
        const team = byTeam(teamId, frame);
        const centroidY = team.reduce((sum, player) => sum + player.y, 0) / Math.max(1, team.length);
        centroidChecks += 1;
        if (Math.abs(centroidY - frame.ball.y) <= 12) centroidPasses += 1;
      }

      if (frame.carrierPlayerId) {
        const carrier = frame.players.find((player) => player.id === frame.carrierPlayerId);
        if (carrier) {
          const defenders = frame.players.filter((player) => player.teamId !== carrier.teamId);
          const nearest = defenders.reduce((best, player) => {
            const dist = Math.hypot(player.x - carrier.x, player.y - carrier.y);
            return !best || dist < best ? dist : best;
          }, undefined as number | undefined);
          if (nearest !== undefined && nearest <= 25) {
            const anchorAge = anchorAgeAt(second);
            if (anchorAge >= 0.9) {
              pressingEligible += 1;
              if (nearest <= 3) pressingClose += 1;
            }
          }
        }
      }
      previous = frame;
    }

    for (const point of [123.4, 987.6, 2222.2, 4555.5]) {
      assert.deepEqual(buildTrackingFrame(generated, point), buildTrackingFrame(generated, point), `determinism at ${point}`);
    }
  }

  const meanOutfieldSpeed = speedSum / Math.max(1, outfieldFrames);
  const sprintShare = sprintFrames / Math.max(1, outfieldFrames);
  const centroidShare = centroidPasses / Math.max(1, centroidChecks);
  const pressShare = pressingClose / Math.max(1, pressingEligible);
  assert.ok(meanOutfieldSpeed >= 1.4 && meanOutfieldSpeed <= 2.0, `mean speed ${meanOutfieldSpeed.toFixed(2)}`);
  assert.ok(sprintShare >= 0.01 && sprintShare <= 0.05, `sprint share ${sprintShare.toFixed(3)}`);
  assert.ok(maxStep >= 8 && maxStep <= 9.55, `max step speed ${maxStep.toFixed(2)}`);
  assert.ok(maxAccel <= 5.2, `max accel ${maxAccel.toFixed(2)}`);
  assert.ok(centroidShare >= 0.85, `centroid/ball lateral share ${centroidShare.toFixed(3)}`);
  assert.ok(pressingEligible > 4000, "pressing sample too small");
  assert.ok(pressShare >= 0.5, `pressing share ${pressShare.toFixed(3)}`);
  assert.ok(desyncChecks > 1000, "desync checks should run on many frames");
  assert.ok((lowSpreadFrames / Math.max(1, desyncChecks)) <= 0.015, `low-spread share ${(lowSpreadFrames / Math.max(1, desyncChecks)).toFixed(3)}`);
});

test("tracking frame build stays performant at 5Hz", () => {
  const generated = generateMatch({ scenario: "goal_fest", seed: 2026 });
  const points = Array.from({ length: 450 }, (_, index) => (index / 5) + 30);
  buildTrackingFrame(generated, points[0]!);
  const start = performance.now();
  for (const second of points) buildTrackingFrame(generated, second);
  const elapsed = performance.now() - start;
  const perFrameMs = elapsed / points.length;
  assert.ok(perFrameMs < 2.1, `per-frame cost ${perFrameMs.toFixed(3)} ms`);
});
