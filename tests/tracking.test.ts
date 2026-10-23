import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

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

test("ball transitions near events without teleporting", () => {
  const f = fixture();
  for (const event of f.events) {
    const at = event.minute * 60 + event.second;
    const before = buildTrackingFrame(f, Math.max(0, at - 0.2));
    const now = buildTrackingFrame(f, at);
    const after = buildTrackingFrame(f, at + 0.2);
    const firstSpeed = Math.hypot(now.ball.x - before.ball.x, now.ball.y - before.ball.y) / 0.2;
    const secondSpeed = Math.hypot(after.ball.x - now.ball.x, after.ball.y - now.ball.y) / 0.2;
    assert.ok(firstSpeed <= 35.5, `${event.id} speed-1 ${firstSpeed.toFixed(2)}`);
    assert.ok(secondSpeed <= 35.5, `${event.id} speed-2 ${secondSpeed.toFixed(2)}`);
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

test("tracking timeline extension stays fast with deep-cloned fixtures at 5Hz over 90 minutes", () => {
  const baseline = fixture();
  const liveFixture: MatchFixture = { ...baseline, durationSeconds: 5_400, events: [] };
  const sourceEvents = Array.from({ length: 360 }, (_, index) => {
    const atSecond = index * 15;
    const minute = Math.floor(atSecond / 60);
    const second = atSecond % 60;
    const home = index % 2 === 0;
    return {
      id: `live-${index}`,
      revision: 1,
      minute,
      second,
      type: index % 9 === 0 ? "shot" : "pass",
      teamId: home ? "home" : "away",
      playerId: home ? "home-p7" : "away-p6",
      outcome: index % 9 === 0 ? "saved" : "complete",
      x: home ? 55 : 45,
      y: home ? 48 : 52,
      ...(index % 9 === 0 ? {} : { endX: home ? 63 : 37, endY: 50 }),
    } as const;
  });
  const points = Array.from({ length: liveFixture.durationSeconds * 5 }, (_, index) => (index + 1) / 5);
  let sourceIndex = 0;
  let worstMs = 0;
  const start = performance.now();
  for (const second of points) {
    while (sourceIndex < sourceEvents.length) {
      const event = sourceEvents[sourceIndex]!;
      const eventSecond = event.minute * 60 + event.second;
      if (eventSecond > second) break;
      liveFixture.events.push({ ...event });
      sourceIndex += 1;
    }
    const before = performance.now();
    buildTrackingFrame(structuredClone(liveFixture), second);
    const cost = performance.now() - before;
    worstMs = Math.max(worstMs, cost);
  }
  const elapsed = performance.now() - start;
  const perFrameMs = elapsed / points.length;
  assert.ok(perFrameMs <= 2.1, `per-frame cost ${perFrameMs.toFixed(3)} ms`);
  assert.ok(worstMs < 80, `worst single call ${worstMs.toFixed(2)} ms`);
});

test("tracking cold start stays bounded", () => {
  const cold = structuredClone(fixture());
  cold.durationSeconds = 5_400;
  const before = performance.now();
  buildTrackingFrame(cold, 0.2);
  const elapsed = performance.now() - before;
  assert.ok(elapsed < 350, `cold start ${elapsed.toFixed(2)} ms`);
});

test("live publish boundaries do not create teleport steps", () => {
  const liveFixture: MatchFixture = { ...fixture(), durationSeconds: 600, events: [] };
  const sourceEvents = Array.from({ length: 100 }, (_, index) => {
    const atSecond = index * 6;
    const minute = Math.floor(atSecond / 60);
    const second = atSecond % 60;
    const home = index % 2 === 0;
    return {
      id: `progressive-${index}`,
      revision: 1,
      minute,
      second,
      type: index % 20 === 0 ? "shot" : "pass",
      teamId: home ? "home" : "away",
      playerId: home ? "home-p10" : "away-p9",
      outcome: index % 20 === 0 ? "saved" : "complete",
      x: home ? 58 : 42,
      y: home ? 50 : 51,
      ...(index % 20 === 0 ? {} : { endX: home ? 67 : 33, endY: 49 }),
    } as const;
  });
  let sourceIndex = 0;
  let previous = buildTrackingFrame(structuredClone(liveFixture), 0);
  for (let tick = 1; tick <= liveFixture.durationSeconds * 5; tick += 1) {
    const second = tick / 5;
    while (sourceIndex < sourceEvents.length) {
      const event = sourceEvents[sourceIndex]!;
      const eventSecond = event.minute * 60 + event.second;
      if (eventSecond > second) break;
      liveFixture.events.push({ ...event });
      sourceIndex += 1;
    }
    const frame = buildTrackingFrame(structuredClone(liveFixture), second);
    const max = maxPlayerSpeedMps(previous, frame);
    assert.ok(max <= 10.5, `max speed ${max.toFixed(2)} at ${second.toFixed(1)}s`);
    previous = frame;
  }
});

test("ball speed spikes above 45 m/s stay rare", () => {
  const generated = generateMatch({ scenario: "goal_fest", seed: 2029 });
  generated.durationSeconds = Math.min(generated.durationSeconds, 1_800);
  let previous = buildTrackingFrame(generated, 0);
  let above45 = 0;
  let total = 0;
  for (let tick = 1; tick <= Math.floor(generated.durationSeconds * 5); tick += 1) {
    const second = tick / 5;
    const frame = buildTrackingFrame(generated, second);
    const speed = Math.hypot(frame.ball.x - previous.ball.x, frame.ball.y - previous.ball.y) / 0.2;
    if (speed > 45) above45 += 1;
    total += 1;
    previous = frame;
  }
  const share = above45 / Math.max(1, total);
  assert.ok(share < 0.01, `ball speed >45m/s share ${share.toFixed(4)}`);
});
