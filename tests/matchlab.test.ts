import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildFeedPlan } from "../server/matchlab/feed.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { getFixture, listFixtures, resetGeneratedFixturesForTests } from "../server/fixtures.js";
import { computeStats } from "../server/engine.js";
import { filterByPeriod, periodBoundary } from "../shared/periods.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function continuityDistance(previous: MatchEvent, next: MatchEvent): number | null {
  if (previous.type !== "pass" || next.type !== "pass" || previous.endX === undefined || previous.endY === undefined) return null;
  const nextX = next.teamId === previous.teamId ? next.x : 100 - next.x;
  const nextY = next.teamId === previous.teamId ? next.y : 100 - next.y;
  return Math.hypot(nextX - previous.endX, nextY - previous.endY);
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
    assert.equal(lateWinner.events.filter((event) => event.type === "goal" && event.rescinded).length, 0, `late_winner seed ${seed} has no rescinded goals`);
    const lateGoals = lateWinner.events.filter((event) => event.type === "goal" && !event.rescinded).sort((a, b) => secondOf(a) - secondOf(b));
    assert.ok(lateGoals.some((event) => event.id === lateWinner.correctionEventId), `late_winner seed ${seed} correction target is a live goal`);
    assert.equal(lateGoals.length >= 1, true, `late_winner seed ${seed} has a goal`);
    assert.equal(lateGoals[lateGoals.length - 1]!.minute >= 81 && lateGoals[lateGoals.length - 1]!.minute <= 88, true, `late_winner seed ${seed} decisive goal is 81'-88'`);
    const before80 = lateGoals.filter((goal) => secondOf(goal) < 80 * 60);
    const homeBefore = before80.filter((goal) => goal.teamId === "home").length;
    const awayBefore = before80.filter((goal) => goal.teamId === "away").length;
    assert.equal(homeBefore, awayBefore, `late_winner seed ${seed} stays level until late phase`);
    const homeFinal = lateGoals.filter((goal) => goal.teamId === "home").length;
    const awayFinal = lateGoals.filter((goal) => goal.teamId === "away").length;
    assert.notEqual(homeFinal, awayFinal, `late_winner seed ${seed} has a decisive winner`);

    const comeback = generateMatch({ scenario: "comeback", seed });
    assert.equal(comeback.events.filter((event) => event.type === "goal" && event.rescinded).length, 0, `comeback seed ${seed} has no rescinded goals`);
    const comebackGoals = comeback.events.filter((event) => event.type === "goal" && !event.rescinded).sort((a, b) => secondOf(a) - secondOf(b));
    assert.ok(comebackGoals.some((event) => event.id === comeback.correctionEventId), `comeback seed ${seed} correction target is a live goal`);
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
  let passTransitions = 0;
  let nearTransitions = 0;
  for (let index = 1; index < open.length; index += 1) {
    const previous = open[index - 1]!;
    const current = open[index]!;
    const distance = continuityDistance(previous, current);
    if (distance !== null) {
      passTransitions += 1;
      if (distance <= 8) nearTransitions += 1;
    }
  }
  const continuityShare = passTransitions === 0 ? 0 : nearTransitions / passTransitions;
  assert.ok(continuityShare >= 0.7, `continuity share ${continuityShare.toFixed(3)}`);
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

test("generated fixtures keep spatial distributions realistic across scenario and seed mix", () => {
  const scenarios = ["comeback", "red_card", "set_piece", "late_winner"] as const;
  const seeds = [42, 2026] as const;
  const defensiveTypes = new Set<MatchEvent["type"]>(["tackle", "interception", "ball_recovery", "pressure"]);

  let totalPasses = 0;
  let passX90 = 0;
  let middleThirdPasses = 0;
  const defensiveXs: number[] = [];
  let continuityDenominator = 0;
  let continuityNumerator = 0;

  for (const scenario of scenarios) {
    for (const seed of seeds) {
      const fixture = generateMatch({ scenario, seed });
      const open = fixture.events.filter((event) => !event.rescinded);
      for (let index = 0; index < open.length; index += 1) {
        const event = open[index]!;
        if (event.type === "pass") {
          totalPasses += 1;
          if (event.x >= 90) passX90 += 1;
          if (event.x >= 33.3333 && event.x < 66.6667) middleThirdPasses += 1;
        }
        if (defensiveTypes.has(event.type)) defensiveXs.push(event.x);
        const next = open[index + 1];
        if (next) {
          const distance = continuityDistance(event, next);
          if (distance !== null) {
            continuityDenominator += 1;
            if (distance <= 8) continuityNumerator += 1;
          }
        }
      }
    }
  }

  defensiveXs.sort((a, b) => a - b);
  const midpoint = Math.floor(defensiveXs.length / 2);
  const medianDefensiveX = defensiveXs.length % 2 === 1
    ? defensiveXs[midpoint]!
    : (defensiveXs[midpoint - 1]! + defensiveXs[midpoint]!) / 2;

  const highBandShare = passX90 / totalPasses;
  const middleThirdShare = middleThirdPasses / totalPasses;
  const continuityShare = continuityDenominator === 0 ? 0 : continuityNumerator / continuityDenominator;

  assert.ok(highBandShare <= 0.12, `x>=90 share ${highBandShare.toFixed(3)}`);
  assert.ok(middleThirdShare >= 0.30, `middle-third share ${middleThirdShare.toFixed(3)}`);
  assert.ok(medianDefensiveX >= 20 && medianDefensiveX <= 60, `defensive median x ${medianDefensiveX.toFixed(2)}`);
  assert.ok(continuityShare >= 0.70, `continuity share ${continuityShare.toFixed(3)}`);
});

const SAVE_SCENARIOS = ["comeback", "red_card", "set_piece", "late_winner", "goal_fest"] as const;
const SAVE_SEEDS = [1, 2, 3, 4, 5] as const;

function savedShotsBy(events: MatchEvent[], teamId: "home" | "away"): number {
  return events.filter((event) => event.type === "shot" && !event.rescinded && event.outcome === "saved" && event.teamId === teamId).length;
}

test("each keeper's saves equal the opponent's saved shots, for the full match and each half", () => {
  for (const scenario of SAVE_SCENARIOS) {
    for (const seed of SAVE_SEEDS) {
      const fixture = generateMatch({ scenario, seed });
      const boundary = periodBoundary(fixture);
      assert.ok(boundary.available, `${scenario}/${seed}: halves available`);
      for (const period of ["full", "first", "second"] as const) {
        const scoped = filterByPeriod(fixture.events, period, boundary);
        const stats = computeStats(scoped);
        for (const teamId of ["home", "away"] as const) {
          const opponent = teamId === "home" ? "away" : "home";
          assert.equal(stats[teamId].saves ?? 0, savedShotsBy(scoped, opponent), `${scenario}/${seed}/${period}: ${teamId} saves vs ${opponent} saved shots`);
        }
      }
    }
  }
});

test("every save links to exactly one opponent saved shot, credited to that team's goalkeeper", () => {
  const generated = SAVE_SCENARIOS.flatMap((scenario) => SAVE_SEEDS.map((seed) => generateMatch({ scenario, seed })));
  const scripted = listFixtures().map((summary) => getFixture(summary.id));
  for (const fixture of [...generated, ...scripted]) {
    const byId = new Map(fixture.events.map((event) => [event.id, event]));
    const keepers = new Set([...fixture.home.players, ...fixture.away.players].filter((player) => player.position === "GK").map((player) => player.id));
    const claimed = new Set<string>();
    for (const save of fixture.events.filter((event) => event.type === "save" && !event.rescinded)) {
      const label = `${fixture.id}: ${save.id}`;
      const shot = save.relatedEventId ? byId.get(save.relatedEventId) : undefined;
      assert.ok(shot, `${label} has no linked shot`);
      assert.equal(shot!.type, "shot", label);
      assert.ok(!shot!.rescinded && shot!.outcome === "saved", `${label} links to a shot that was not saved`);
      assert.notEqual(shot!.teamId, save.teamId, `${label} belongs to the defending team`);
      assert.ok(keepers.has(save.playerId), `${label} is credited to a goalkeeper`);
      const gap = (save.minute * 60 + save.second) - (shot!.minute * 60 + shot!.second);
      assert.ok(gap >= 0 && gap <= 1, `${label} comes 0-1 s after its shot (gap ${gap})`);
      assert.ok(!claimed.has(shot!.id), `${label} duplicates a save for ${shot!.id}`);
      claimed.add(shot!.id);
    }
    const unsaved = fixture.events.filter((event) => event.type === "shot" && !event.rescinded && event.outcome === "saved" && !claimed.has(event.id));
    assert.deepEqual(unsaved.map((event) => event.id), [], `${fixture.id}: saved shots without a save`);
  }
});
