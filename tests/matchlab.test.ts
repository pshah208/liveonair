import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildFeedPlan } from "../server/matchlab/feed.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { resetGeneratedFixturesForTests } from "../server/fixtures.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function rangeStats(fixture: MatchFixture, teamId: "home" | "away"): { passes: number; completed: number; shots: number; passPct: number } {
  const passes = fixture.events.filter((event) => event.type === "pass" && event.teamId === teamId);
  const completed = passes.filter((event) => event.outcome === "complete").length;
  const shots = fixture.events.filter((event) => event.type === "shot" && event.teamId === teamId).length;
  return {
    passes: passes.length,
    completed,
    shots,
    passPct: passes.length ? completed / passes.length : 0,
  };
}

function defensiveStats(fixture: MatchFixture): {
  tackles: number;
  tacklesWon: number;
  interceptions: number;
  recoveries: number;
  pressuresHome: number;
  pressuresAway: number;
  maxTacklesByPlayer: number;
} {
  const open = fixture.events.filter((event) => !event.rescinded);
  const tackles = open.filter((event) => event.type === "tackle");
  const pressuresHome = open.filter((event) => event.type === "pressure" && event.teamId === "home").length;
  const pressuresAway = open.filter((event) => event.type === "pressure" && event.teamId === "away").length;
  const tacklesByPlayer = new Map<string, number>();
  for (const tackle of tackles) tacklesByPlayer.set(tackle.playerId, (tacklesByPlayer.get(tackle.playerId) ?? 0) + 1);
  return {
    tackles: tackles.length,
    tacklesWon: tackles.filter((event) => event.outcome === "success").length,
    interceptions: open.filter((event) => event.type === "interception").length,
    recoveries: open.filter((event) => event.type === "ball_recovery").length,
    pressuresHome,
    pressuresAway,
    maxTacklesByPlayer: Math.max(0, ...tacklesByPlayer.values()),
  };
}

function assertFixtureSemantics(fixture: MatchFixture): void {
  assert.equal(fixture.id, `gen-${fixture.id.split("-")[1]}-${fixture.seed}`);
  assert.equal(fixture.durationSeconds, 5400);
  assert.ok(fixture.home.archiveClubId);
  assert.ok(fixture.away.archiveClubId);
  assert.notEqual(fixture.home.archiveClubId, fixture.away.archiveClubId);
  assert.ok(fixture.home.players.every((player) => player.archiveId));
  assert.ok(fixture.away.players.every((player) => player.archiveId));

  const sorted = [...fixture.events].sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
  assert.deepEqual(fixture.events, sorted);

  const correctionTarget = fixture.events.find((event) => event.id === fixture.correctionEventId);
  assert.ok(correctionTarget);
  assert.equal(correctionTarget?.type, "goal");
  assert.ok(fixture.correctionAvailableAt > secondOf(correctionTarget as MatchEvent));

  for (const event of fixture.events) {
    for (const coord of [event.x, event.y, event.endX, event.endY]) {
      if (typeof coord === "number") {
        assert.ok(coord >= 0 && coord <= 100);
      }
    }
    if (event.type === "shot" && typeof event.xg === "number") {
      assert.ok(event.xg >= 0 && event.xg <= 1);
    }
  }

  for (const goal of fixture.events.filter((event) => event.type === "goal")) {
    const relatedShot = fixture.events.find((event) => event.id === goal.relatedEventId);
    assert.ok(relatedShot);
    assert.equal(relatedShot?.type, "shot");
    assert.equal(relatedShot?.teamId, goal.teamId);
  }

  for (const red of fixture.events.filter((event) => event.type === "red_card")) {
    const later = fixture.events.filter((event) => event.playerId === red.playerId && secondOf(event) > secondOf(red));
    assert.equal(later.length, 0);
  }
}

test.beforeEach(() => {
  resetGeneratedFixturesForTests();
});

test("generateMatch is deterministic and valid across scenarios and seeds", () => {
  const scenarios = ["comeback", "red_card", "set_piece", "late_winner", "goal_fest"] as const;
  const seeds = [17, 204, 9090] as const;

  for (const scenario of scenarios) {
    for (const seed of seeds) {
      const request = { scenario, seed };
      const a = generateMatch(request);
      const b = generateMatch(request);
      assert.deepEqual(a, b);
      assert.equal(a.id, `gen-${scenario}-${seed}`);
      assertFixtureSemantics(a);
    }
  }

  const explicit = generateMatch({
    scenario: "late_winner",
    seed: 77,
    homeClubId: "club-eastford",
    awayClubId: "club-kingsport",
  });
  assert.equal(explicit.home.archiveClubId, "club-eastford");
  assert.equal(explicit.away.archiveClubId, "club-kingsport");
});

test("buildFeedPlan preserves all events and injects stress duplicates, out-of-order arrivals and correction", () => {
  const fixture = generateMatch({
    scenario: "set_piece",
    seed: 42,
    homeClubId: "club-rivergate",
    awayClubId: "club-northbridge",
  });

  const normal = buildFeedPlan(fixture, false);
  assert.equal(normal.length, fixture.events.length);
  assert.ok(normal.every((item) => item.publishAtSecond === secondOf(item.event)));

  const stressed = buildFeedPlan(fixture, true);
  for (let index = 1; index < stressed.length; index += 1) {
    assert.ok(stressed[index - 1]!.publishAtSecond <= stressed[index]!.publishAtSecond);
  }

  for (const event of fixture.events) {
    assert.ok(stressed.some((item) => item.event.id === event.id && item.event.revision === event.revision));
  }

  const duplicates = stressed.filter((item) => item.stress === "duplicate");
  assert.ok(duplicates.length >= 2 && duplicates.length <= 3);
  for (const duplicate of duplicates) {
    const original = stressed.find((item) => !item.stress && item.event.id === duplicate.event.id && item.event.revision === duplicate.event.revision);
    assert.ok(original);
    assert.ok(duplicate.publishAtSecond > original!.publishAtSecond);
  }

  const outOfOrder = stressed.filter((item) => item.stress === "out_of_order");
  assert.equal(outOfOrder.length, 2);
  for (const item of outOfOrder) {
    assert.ok(item.publishAtSecond - secondOf(item.event) >= 20);
    assert.ok(item.publishAtSecond - secondOf(item.event) <= 40);
  }

  const correction = stressed.filter((item) => item.stress === "late_correction");
  assert.equal(correction.length, 1);
  const correctionItem = correction[0]!;
  const target = fixture.events.find((event) => event.id === fixture.correctionEventId)!;
  assert.equal(correctionItem.publishAtSecond, fixture.correctionAvailableAt);
  assert.equal(correctionItem.event.id, target.id);
  assert.equal(correctionItem.event.revision, target.revision + 1);
  assert.equal(correctionItem.event.rescinded, true);
});

test("generated fixtures hit possession-first volume targets across seeds", () => {
  const seeds = [11, 42, 77, 2026, 9090];
  for (const seed of seeds) {
    const fixture = generateMatch({ scenario: "goal_fest", seed });
    for (const teamId of ["home", "away"] as const) {
      const stats = rangeStats(fixture, teamId);
      assert.ok(stats.passes >= 350 && stats.passes <= 600, `${seed}-${teamId} passes ${stats.passes}`);
      assert.ok(stats.shots >= 9 && stats.shots <= 17, `${seed}-${teamId} shots ${stats.shots}`);
      assert.ok(stats.passPct >= 0.78 && stats.passPct <= 0.88, `${seed}-${teamId} completion ${stats.passPct.toFixed(3)}`);
    }
  }
});

test("generated fixtures keep realistic defensive-action density across five seeds", () => {
  const seeds = [11, 42, 77, 2026, 9090];
  let aggregateWon = 0;
  let aggregateTackles = 0;
  for (const seed of seeds) {
    const fixture = generateMatch({ scenario: "goal_fest", seed });
    const stats = defensiveStats(fixture);
    const attemptedShare = stats.tackles === 0 ? 0 : stats.tacklesWon / stats.tackles;
    aggregateWon += stats.tacklesWon;
    aggregateTackles += stats.tackles;
    assert.ok(stats.tackles >= 30 && stats.tackles <= 45, `seed ${seed} tackles ${stats.tackles}`);
    assert.ok(attemptedShare >= 0.55 && attemptedShare <= 0.65, `seed ${seed} tackle won share ${attemptedShare.toFixed(3)}`);
    assert.ok(stats.interceptions > 0, `seed ${seed} has interceptions`);
    assert.ok(stats.recoveries > 0, `seed ${seed} has recoveries`);
    assert.ok(stats.maxTacklesByPlayer <= 10, `seed ${seed} max tackles by player ${stats.maxTacklesByPlayer}`);
    assert.ok(stats.pressuresHome >= 120 && stats.pressuresHome <= 180, `seed ${seed} home pressure ${stats.pressuresHome}`);
    assert.ok(stats.pressuresAway >= 120 && stats.pressuresAway <= 180, `seed ${seed} away pressure ${stats.pressuresAway}`);
  }
  const aggregateShare = aggregateTackles === 0 ? 0 : aggregateWon / aggregateTackles;
  assert.ok(aggregateShare >= 0.55 && aggregateShare <= 0.65, `aggregate tackle won share ${aggregateShare.toFixed(3)}`);
});

test("shot volume is spread across halves", () => {
  const seeds = [1, 11, 42, 77, 2026];
  for (const seed of seeds) {
    const fixture = generateMatch({ scenario: "goal_fest", seed });
    const shots = fixture.events.filter((event) => event.type === "shot");
    const firstHalf = shots.filter((event) => secondOf(event) < 45 * 60).length;
    const secondHalf = shots.length - firstHalf;
    const secondHalfShare = shots.length ? secondHalf / shots.length : 0;
    assert.ok(secondHalfShare >= 0.45 && secondHalfShare <= 0.55, `seed ${seed} second-half share ${secondHalfShare.toFixed(3)}`);
  }
});

test("interceptions and recoveries never count as tackles or reduce player ratings", async () => {
  const { analysePlayers } = await import("../shared/playerStats.js");
  const fixture = generateMatch({ scenario: "set_piece", seed: 2026 });
  const withBallWins: MatchFixture = {
    ...fixture,
    events: [
      ...fixture.events,
      {
        id: "interception-only",
        revision: 1,
        minute: 70,
        second: 10,
        type: "interception",
        teamId: "home",
        playerId: fixture.home.players[2]!.id,
        outcome: "success",
        x: 58,
        y: 48,
      },
      {
        id: "recovery-only",
        revision: 1,
        minute: 71,
        second: 15,
        type: "ball_recovery",
        teamId: "home",
        playerId: fixture.home.players[2]!.id,
        outcome: "success",
        x: 61,
        y: 46,
      },
    ],
  };
  const baseline = analysePlayers(fixture).find((player) => player.player.id === fixture.home.players[2]!.id)!;
  const updated = analysePlayers(withBallWins).find((player) => player.player.id === fixture.home.players[2]!.id)!;
  assert.equal(updated.tackles, baseline.tackles, "ball wins are not counted as tackles");
  assert.equal(updated.tacklesWon, baseline.tacklesWon, "ball wins are not counted as tackles won");
  assert.ok(updated.impact.total >= baseline.impact.total, "ball wins do not lower rating");
});

test("scenario outcomes match descriptions across required seeds", () => {
  const seeds = [1, 11, 42, 77, 2026];
  for (const seed of seeds) {
    const lateWinner = generateMatch({ scenario: "late_winner", seed });
    const lateGoals = lateWinner.events.filter((event) => event.type === "goal" && !event.rescinded).sort((a, b) => secondOf(a) - secondOf(b));
    assert.equal(lateGoals.length >= 1, true, `late_winner seed ${seed} has a goal`);
    assert.equal(lateGoals[lateGoals.length - 1]!.minute >= 80, true, `late_winner seed ${seed} decisive goal is late`);
    const before80 = lateGoals.filter((goal) => secondOf(goal) < 80 * 60);
    const homeBefore = before80.filter((goal) => goal.teamId === "home").length;
    const awayBefore = before80.filter((goal) => goal.teamId === "away").length;
    assert.equal(homeBefore, awayBefore, `late_winner seed ${seed} stays level until late phase`);
    const homeFinal = lateGoals.filter((goal) => goal.teamId === "home").length;
    const awayFinal = lateGoals.filter((goal) => goal.teamId === "away").length;
    assert.notEqual(homeFinal, awayFinal, `late_winner seed ${seed} has a decisive winner`);

    const comeback = generateMatch({ scenario: "comeback", seed });
    const comebackGoals = comeback.events.filter((event) => event.type === "goal" && !event.rescinded).sort((a, b) => secondOf(a) - secondOf(b));
    let home = 0;
    let away = 0;
    let trailed = false;
    for (const goal of comebackGoals) {
      if (goal.teamId === "home") home += 1;
      else away += 1;
      if (home < away) trailed = true;
    }
    assert.equal(trailed, true, `comeback seed ${seed} includes a trailing phase`);
    assert.ok(home > away, `comeback seed ${seed} finishes ahead`);
    assert.ok(comebackGoals.some((goal) => goal.teamId === "away" && secondOf(goal) < 45 * 60), `comeback seed ${seed} away leads in first half`);
    assert.ok(comebackGoals.filter((goal) => goal.teamId === "home" && secondOf(goal) >= 45 * 60).length >= 2, `comeback seed ${seed} home recovers after break`);
  }
});

test("production code does not infer event kind from event id text", () => {
  const targets = [
    path.resolve("shared"),
    path.resolve("server"),
    path.resolve("src"),
  ];
  const badPatterns = ["-interception-", "-recovery-"];
  for (const root of targets) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop()!;
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
        continue;
      }
      if (!current.endsWith(".ts") && !current.endsWith(".tsx")) continue;
      const text = fs.readFileSync(current, "utf8");
      for (const pattern of badPatterns) {
        assert.equal(text.includes(pattern), false, `${path.relative(process.cwd(), current)} contains ${pattern}`);
      }
    }
  }
});

test("generated squads exclude staff roles from player lists", () => {
  const fixture = generateMatch({ scenario: "comeback", seed: 17 });
  const isStaff = (position: string) => position.toLowerCase().includes("coach");
  assert.ok(fixture.home.players.every((player) => !isStaff(player.position)));
  assert.ok(fixture.away.players.every((player) => !isStaff(player.position)));
});

test("scenario variants produce visible differences and red_card includes a dismissal with ten-player aftermath", () => {
  const seed = 2028;
  const scenarios = ["comeback", "red_card", "set_piece", "late_winner", "goal_fest"] as const;
  const fixtures = scenarios.map((scenario) => generateMatch({ scenario, seed }));
  const signatures = fixtures.map((fixture) => JSON.stringify({
    goals: fixture.events.filter((event) => event.type === "goal").length,
    shots: fixture.events.filter((event) => event.type === "shot").length,
    corners: fixture.events.filter((event) => event.type === "corner").length,
    redCards: fixture.events.filter((event) => event.type === "red_card").length,
  }));
  assert.equal(new Set(signatures).size, scenarios.length, "each scenario changes the match shape");

  const byScenario = new Map(fixtures.map((fixture) => [fixture.id.split("-")[1]!, fixture]));
  const redCardFixture = byScenario.get("red_card")!;
  const redCard = redCardFixture.events.find((event) => event.type === "red_card");
  assert.ok(redCard, "red_card scenario emits a dismissal");
  assert.ok(secondOf(redCard!) >= 53 * 60 && secondOf(redCard!) <= 58 * 60, `red card timing ${secondOf(redCard!)}s`);
  const afterCardTeamEvents = redCardFixture.events.filter((event) => (
    event.teamId === redCard!.teamId && secondOf(event) > secondOf(redCard!)
  ));
  const playersAfter = new Set(afterCardTeamEvents.map((event) => event.playerId));
  assert.equal(playersAfter.has(redCard!.playerId), false, "dismissed player has no later events");
  assert.ok(playersAfter.size <= 10, `dismissed side uses at most ten players after card (saw ${playersAfter.size})`);
});

test("possession transitions are explicit and pressure is matched to passes", () => {
  const fixture = generateMatch({ scenario: "set_piece", seed: 2027 });
  const open = fixture.events.filter((event) => !event.rescinded);
  for (let index = 1; index < open.length; index += 1) {
    const previous = open[index - 1]!;
    const current = open[index]!;
    if (previous.type === "pass" && previous.endX !== undefined && previous.endY !== undefined && current.type === "pass") {
      assert.equal(current.x, previous.endX);
      assert.equal(current.y, previous.endY);
    }
  }
  assert.ok(open.some((event) => event.type === "tackle"), "turnovers are explicit");
  const pressures = open.filter((event) => event.type === "pressure");
  assert.ok(pressures.length > 0);
  for (const pressure of pressures) {
    const match = open.find((candidate) => candidate.type === "pass" && candidate.id === pressure.relatedEventId);
    assert.ok(match, `pressure ${pressure.id} links to pass`);
    const dt = secondOf(match!) - secondOf(pressure);
    assert.ok(dt >= 0 && dt <= 2, `pressure dt=${dt}`);
    assert.equal(pressure.teamId === match!.teamId, false);
  }
  assert.ok(open.some((event) => event.type === "shot" && event.outcome === "miss"));
  assert.ok(open.some((event) => event.type === "shot" && event.outcome === "saved"));
  assert.ok(open.some((event) => event.type === "shot" && event.outcome === "blocked"));
});
