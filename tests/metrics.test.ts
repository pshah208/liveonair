import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregatePasses,
  ballSpeedKmh,
  completionOverExpected,
  expectedCompletion,
  fastestShot,
  passBand,
  passDifficulty,
  passDistanceM,
  passQualities,
  physicalMetrics,
  playerTags,
  scopedTracking,
  shotSpeedKmh,
  toMetres,
  SHOT_SPEED_THRESHOLD_KMH,
} from "../shared/metrics.js";
import { analysePlayers, activePlayerEvents } from "../shared/playerStats.js";
import { analyzeFixture, analyzeMatch } from "../server/engine.js";
import { getFixture, resetGeneratedFixturesForTests } from "../server/fixtures.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { getArchive } from "../server/archive/index.js";
import { buildArchiveIndexes, guardDraftText, verifyClaimProposal, type ClaimProposal } from "../server/desk/claims.js";
import { parseLiveEnvelope } from "../server/live/transport.js";
import type { AnalysisRequest, MatchEvent, MatchFixture } from "../shared/types.js";

const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;

function ev(partial: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type">): MatchEvent {
  return { revision: 1, minute: 10, second: 0, teamId: "home", playerId: "home-p7", outcome: "complete", x: 50, y: 50, ...partial };
}

test.beforeEach(() => {
  resetGeneratedFixturesForTests();
});

test("pass distance uses a 105 × 68 m pitch and bands short/medium/long", () => {
  assert.equal(passDistanceM(ev({ id: "p1", type: "pass", x: 0, y: 50, endX: 100, endY: 50 })), 105);
  assert.equal(passDistanceM(ev({ id: "p2", type: "pass", x: 50, y: 0, endX: 50, endY: 100 })), 68);
  assert.equal(passDistanceM(ev({ id: "p3", type: "pass", x: 40, y: 40, endX: 50, endY: 50 })), Math.round(Math.hypot(10.5, 6.8) * 10) / 10);
  assert.equal(passDistanceM(ev({ id: "p4", type: "pass", x: 40, y: 40 })), null, "no end point");
  assert.equal(passDistanceM(ev({ id: "s1", type: "shot", x: 80, y: 50 })), null, "not a pass");
  assert.equal(passBand(14.9), "short");
  assert.equal(passBand(15), "medium");
  assert.equal(passBand(30), "medium");
  assert.equal(passBand(30.1), "long");
});

test("away events are mirrored onto the shared frame but distances are frame-invariant", () => {
  const fixture = { id: "pitch-fixture" };
  const home = ev({ id: "h", type: "pass", x: 90, y: 20, endX: 95, endY: 30 });
  const away = ev({ id: "a", type: "pass", teamId: "away", x: 90, y: 20, endX: 95, endY: 30 });
  assert.deepEqual(toMetres(fixture, home), { x: 94.5, y: 13.6 });
  assert.deepEqual(toMetres(fixture, away), { x: 10.5, y: 54.4 }, "away x = 100 − x and y = 100 − y");
  assert.equal(passDistanceM(home), passDistanceM(away));
  assert.deepEqual(passDifficulty(home)?.score, passDifficulty(away)?.score, "difficulty is read in the attacking frame for both teams");
});

test("camera fixtures return null for every metre-based metric", () => {
  const camera = { camera: true };
  const pass = ev({ id: "p", type: "pass", x: 10, y: 10, endX: 60, endY: 60, flightMs: 900 });
  const shot = ev({ id: "s", type: "shot", x: 85, y: 50, speedKmh: 110, flightMs: 400 });
  assert.equal(toMetres({ id: "video-clip" }, pass), null);
  assert.equal(passDistanceM(pass, camera), null);
  assert.equal(passDifficulty(pass, [], camera), null);
  assert.equal(ballSpeedKmh(pass, camera), null);
  assert.equal(shotSpeedKmh(shot, camera), null);
  assert.deepEqual(passQualities([pass], camera), []);
});

test("difficulty factors follow the published formula", () => {
  const simple = passDifficulty(ev({ id: "short", type: "pass", x: 50, y: 50, endX: 50, endY: 60 }))!;
  assert.deepEqual(simple.factors.map((factor) => factor.key), ["distance"]);
  assert.equal(simple.score, Math.round(6.8 * 0.75));

  const pass = ev({ id: "hard", type: "pass", minute: 30, second: 10, x: 60, y: 10, endX: 88, endY: 55 });
  const pressure = ev({ id: "press", type: "pressure", teamId: "away", minute: 30, second: 8, outcome: "success", x: 60, y: 10 });
  const ownPressure = ev({ id: "own", type: "pressure", teamId: "home", minute: 30, second: 8, outcome: "success" });
  const stale = ev({ id: "stale", type: "pressure", teamId: "away", minute: 30, second: 4, outcome: "success", x: 60, y: 10 });
  const far = ev({ id: "far", type: "pressure", teamId: "away", minute: 30, second: 9, outcome: "success", x: 60, y: 30 });
  const later = ev({ id: "later", type: "pressure", teamId: "away", minute: 30, second: 12, outcome: "success" });
  const rescinded = ev({ id: "resc", type: "pressure", teamId: "away", minute: 30, second: 9, outcome: "success", x: 60, y: 11, rescinded: true });
  const wrongLink = ev({ id: "wrong-link", type: "pressure", teamId: "away", minute: 30, second: 9, outcome: "success", x: 60, y: 10, relatedEventId: "different-pass" });
  const withoutPressure = passDifficulty(pass, [ownPressure, stale, far, later, rescinded, wrongLink])!;
  assert.ok(!withoutPressure.factors.some((factor) => factor.key === "pressure"), "same-team, >2 s, >5 m, later, rescinded, and mismatched link pressures do not count");
  const result = passDifficulty(pass, [pressure])!;
  const keys = result.factors.map((factor) => factor.key);
  assert.deepEqual(keys, ["distance", "forward", "box", "pressure", "switch", "cross"]);
  const points = Object.fromEntries(result.factors.map((factor) => [factor.key, factor.points]));
  const distance = Math.hypot(28 * 1.05, 45 * 0.68);
  assert.equal(points.distance, Math.round(Math.min(30, distance * 0.75) * 10) / 10);
  assert.equal(points.forward, Math.round(Math.min(20, 28 * 1.05 * 0.6) * 10) / 10);
  assert.equal(points.box, 15);
  assert.equal(points.pressure, 15);
  assert.equal(points.switch, 10);
  assert.equal(points.cross, 10);
  assert.equal(result.score, Math.min(100, Math.round(result.factors.reduce((sum, factor) => sum + factor.points, 0))));
  assert.equal(result.score - withoutPressure.score, 15);

  const finalThird = passDifficulty(ev({ id: "ft", type: "pass", x: 50, y: 50, endX: 70, endY: 50 }))!;
  assert.ok(finalThird.factors.some((factor) => factor.key === "final_third"));
  const corner = passDifficulty(ev({ id: "c", type: "corner", x: 100, y: 2, endX: 88, endY: 50 }))!;
  assert.ok(corner.factors.some((factor) => factor.key === "set_piece"));
  assert.ok(!corner.factors.some((factor) => factor.key === "forward"));
  const backwards = passDifficulty(ev({ id: "b", type: "pass", x: 60, y: 50, endX: 40, endY: 50 }))!;
  assert.ok(!backwards.factors.some((factor) => factor.key === "forward"));
});

test("expected completion and completion over expected", () => {
  assert.equal(expectedCompletion(0), 0.97);
  assert.equal(expectedCompletion(40), 0.67);
  assert.equal(expectedCompletion(100), 0.22);
  assert.equal(completionOverExpected([]), null);
  const summary = completionOverExpected([{ expected: 0.9, completed: true }, { expected: 0.5, completed: true }, { expected: 0.6, completed: false }])!;
  assert.equal(summary.attempts, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.expected, 2);
  assert.equal(summary.overExpectedPct, 0);
  const passes = passQualities([
    ev({ id: "a", type: "pass", x: 20, y: 50, endX: 60, endY: 50, outcome: "complete" }),
    ev({ id: "b", type: "pass", x: 20, y: 50, endX: 25, endY: 50, outcome: "incomplete" }),
  ]);
  const aggregate = aggregatePasses(passes);
  assert.equal(aggregate.hardestCompleted?.event.id, "a");
  assert.equal(aggregate.longPassAccuracy, 100);
  assert.equal(aggregate.avgPassDistanceM, Math.round(((passes[0]!.distanceM + passes[1]!.distanceM) / 2) * 10) / 10);
});

test("speeds come only from the event's own flight data, never from gaps between events", () => {
  const pass = ev({ id: "p", type: "pass", x: 0, y: 50, endX: 20, endY: 50, flightMs: 1000 });
  assert.equal(ballSpeedKmh(pass), Math.round(21 * 3.6 * 10) / 10);
  const untimed = ev({ id: "u", type: "pass", x: 0, y: 50, endX: 20, endY: 50 });
  assert.equal(ballSpeedKmh(untimed), null, "no flightMs: no speed, even if a later event exists");
  const shot = ev({ id: "s", type: "shot", x: 80, y: 50, flightMs: 500 });
  assert.equal(shotSpeedKmh(shot), Math.round((21 / 0.5) * 3.6 * 10) / 10);
  assert.equal(shotSpeedKmh({ ...shot, speedKmh: 112.4 }), 112.4, "measured speed wins");
  assert.equal(shotSpeedKmh(ev({ id: "s2", type: "shot", x: 80, y: 50 })), null);
  assert.equal(shotSpeedKmh({ ...shot, speedKmh: 120, rescinded: true }), null);
  assert.equal(fastestShot([shot, { ...shot, id: "s3", speedKmh: 160 }])?.event.id, "s3");
});

test("synthetic ball flight and tracking are seeded, deterministic and in realistic ranges", () => {
  for (const fixture of [getFixture("rivergate-comeback"), generateMatch({ scenario: "set_piece", seed: 42 }), generateMatch({ scenario: "goal_fest", seed: 9090 })]) {
    const again = fixture.id.startsWith("gen-") ? generateMatch({ scenario: fixture.id.split("-")[1] as "set_piece", seed: fixture.seed }) : getFixture(fixture.id);
    assert.deepEqual(fixture.events, again.events);
    assert.deepEqual(fixture.tracking, again.tracking);
    const byId = new Map(fixture.events.map((event) => [event.id, event]));
    for (const event of fixture.events) {
      if (event.type === "pass" && event.endX !== undefined && passDistanceM(event)! >= 1) {
        assert.ok(event.flightMs && event.flightMs > 0, `${event.id} has flight time`);
        const speed = ballSpeedKmh(event)!;
        assert.ok(speed >= 38 && speed <= 102, `${event.id} pass speed ${speed}`);
      }
      if (event.type === "shot") {
        const header = byId.get(event.relatedEventId ?? "")?.type === "corner";
        assert.ok(typeof event.speedKmh === "number");
        if (header) assert.ok(event.speedKmh! >= 35 && event.speedKmh! <= 75, `${event.id} header ${event.speedKmh}`);
        else assert.ok(event.speedKmh! >= 60 && event.speedKmh! <= 130, `${event.id} shot ${event.speedKmh}`);
      }
      if (event.type !== "pass" && event.type !== "corner" && event.type !== "shot") assert.equal(event.flightMs, undefined);
      for (const coord of [event.x, event.y, event.endX, event.endY]) if (typeof coord === "number") assert.ok(coord >= 0 && coord <= 100);
    }
    const tracking = fixture.tracking!;
    assert.equal(tracking.source, "synthetic");
    assert.equal(tracking.cadenceSeconds, 60);
    const goalkeepers = new Set([...fixture.home.players, ...fixture.away.players].filter((player) => player.position === "GK").map((player) => player.id));
    assert.ok(tracking.samples.every((sample) => !goalkeepers.has(sample.playerId)));
    assert.ok(tracking.samples.every((sample) => sample.distanceM >= 80 && sample.distanceM <= 150 && sample.speedKmh >= 14 && sample.speedKmh <= 34.5));
    for (const red of fixture.events.filter((event) => event.type === "red_card")) {
      assert.ok(tracking.samples.every((sample) => sample.playerId !== red.playerId || sample.second - 60 < secondOf(red)));
    }
  }
  const lengths = passQualities(getFixture("setpiece-pattern").events).map((pass) => pass.band);
  assert.ok(lengths.includes("short") && lengths.includes("medium") && lengths.includes("long"), "pass lengths have spread");
});

test("live transport accepts the optional metric fields and rejects nonsense", () => {
  const event = getFixture("rivergate-comeback").events.find((entry) => entry.type === "shot")!;
  const base = { kind: "match_event", matchId: "m", sequence: 1, publishedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(parseLiveEnvelope({ ...base, event }).kind, "match_event");
  assert.throws(() => parseLiveEnvelope({ ...base, event: { ...event, speedKmh: -4 } }));
});

test("tracking is scoped by clock and period, and player stats expose physical metrics only with tracking", () => {
  const fixture = getFixture("rivergate-comeback");
  const full = scopedTracking(fixture, 90 * 60)!;
  const first = scopedTracking(fixture, 90 * 60, "first")!;
  const second = scopedTracking(fixture, 90 * 60, "second")!;
  assert.equal(first.length + second.length, full.length);
  assert.ok(first.every((sample) => sample.second <= 45 * 60) && second.every((sample) => sample.second > 45 * 60));
  assert.ok(scopedTracking(fixture, 10 * 60)!.every((sample) => sample.second <= 600));
  assert.equal(scopedTracking({ ...fixture, tracking: undefined }), null);

  const pick = (period: "full" | "first" | "second", id = "home-p7") => analysePlayers(fixture, 90 * 60, period).find((entry) => entry.player.id === id)!;
  const mid = pick("full");
  const expected = physicalMetrics(full, "home-p7")!;
  assert.equal(mid.distanceCoveredM, expected.distanceCoveredM);
  assert.equal(mid.topSpeedKmh, expected.topSpeedKmh);
  assert.equal(mid.sprints, full.filter((sample) => sample.playerId === "home-p7" && sample.speedKmh >= 25).length);
  assert.equal(mid.trackingSource, "synthetic");
  assert.ok(mid.distanceCoveredM! > 9000 && mid.distanceCoveredM! < 14000);
  assert.equal(pick("first").distanceCoveredM! + pick("second").distanceCoveredM!, mid.distanceCoveredM);
  assert.equal(pick("full", "home-p1").distanceCoveredM, null, "goalkeepers are not tracked");

  const untracked = analysePlayers({ ...fixture, tracking: undefined }, 90 * 60).find((entry) => entry.player.id === "home-p7")!;
  assert.equal(untracked.distanceCoveredM, null);
  assert.equal(untracked.topSpeedKmh, null);
  assert.equal(untracked.sprints, null);
  assert.equal(untracked.trackingSource, null);

  const camera = analysePlayers({ ...fixture, id: "video-clip" }, 90 * 60).find((entry) => entry.player.id === "home-p7")!;
  assert.equal(camera.avgPassDistanceM, null);
  assert.equal(camera.distanceCoveredM, null);
});

test("player pass metrics and top shot speed respect the selected half", () => {
  const fixture = getFixture("rivergate-comeback");
  for (const period of ["full", "first", "second"] as const) {
    for (const player of analysePlayers(fixture, 90 * 60, period)) {
      if (player.hardestCompletedPass) {
        const event = fixture.events.find((entry) => entry.id === player.hardestCompletedPass!.eventId)!;
        if (period === "first") assert.ok(secondOf(event) <= 45 * 60);
        if (period === "second") assert.ok(secondOf(event) > 45 * 60);
        assert.ok(player.hardestCompletedPass.difficulty >= (player.avgPassDifficulty ?? 0) - 0.5 || player.passes > player.passesCompleted);
      }
    }
  }
  const striker = (period: "full" | "first" | "second") => analysePlayers(fixture, 90 * 60, period).find((entry) => entry.player.id === "away-p11")!;
  const firstHalfShots = fixture.events.filter((event) => event.type === "shot" && event.playerId === "away-p11" && secondOf(event) <= 45 * 60);
  assert.equal(striker("first").topShotSpeedKmh, Math.max(...firstHalfShots.map((shot) => shot.speedKmh!)));
  assert.equal(striker("second").topShotSpeedKmh, null);
});

const request: AnalysisRequest = { fixtureId: "rivergate-comeback", atSecond: 90 * 60, persona: "analyst", language: "en" };

test("team stats gain pass and shot metrics, scoped by period", () => {
  const full = analyzeMatch(request);
  const first = analyzeMatch({ ...request, period: "first" });
  const fixture = getFixture("rivergate-comeback");
  const firstEvents = activePlayerEvents(fixture, 45 * 60).filter((event) => event.teamId === "away" && secondOf(event) <= 45 * 60);
  assert.equal(first.stats.away.fastestShotKmh, fastestShot(firstEvents)?.speedKmh ?? null);
  assert.equal(first.stats.home.fastestShotKmh, null, "home had no first-half shot");
  assert.ok((full.stats.home.fastestShotKmh ?? 0) > 0);
  for (const stats of [full.stats.home, full.stats.away, first.stats.home]) {
    assert.ok(stats.avgPassDistanceM! > 0 && stats.avgPassDistanceM! < 60);
    assert.ok(stats.avgPassDifficulty! >= 0 && stats.avgPassDifficulty! <= 100);
    assert.equal(typeof stats.completionOverExpected, "number");
  }
  const clip: MatchFixture = { ...fixture, id: "video-clip", periods: undefined };
  const camera = analyzeFixture(clip, { ...request, fixtureId: clip.id });
  assert.equal(camera.stats.home.avgPassDistanceM, null);
  assert.equal(camera.stats.home.fastestShotKmh, null);
  assert.ok(!camera.stories.some((story) => ["hardest-pass", "fastest-shot", "metric-thresholds"].includes(story.id)));
});

test("hardest-pass, fastest-shot and threshold cards are evidence-linked, localized and period-scoped", () => {
  const fixture = getFixture("rivergate-comeback");
  for (const period of ["full", "first", "second"] as const) {
    const snap = analyzeMatch({ ...request, period });
    const fastest = snap.stories.find((story) => story.id === "fastest-shot");
    assert.ok(fastest, `${period} has a fastest-shot card`);
    const shot = snap.evidence[fastest!.evidenceIds[0]!]!;
    assert.equal(shot.type, "shot");
    assert.match(fastest!.summary, new RegExp(`${Math.round(shot.speedKmh!)} km/h`));
    if (period === "first") assert.ok(secondOf(shot) <= 45 * 60);
    if (period === "second") assert.ok(secondOf(shot) > 45 * 60);
    const scopedShots = Object.values(snap.evidence).filter((event) => event.type === "shot");
    assert.equal(fastest!.metrics[0]!.value, Math.max(...scopedShots.map((event) => event.speedKmh!)));
    const hardest = snap.stories.find((story) => story.id === "hardest-pass");
    if (hardest) {
      const pass = snap.evidence[hardest.evidenceIds[0]!]!;
      assert.equal(pass.type, "pass");
      assert.equal(pass.outcome, "complete");
      const best = Math.max(...passQualities(Object.values(snap.evidence)).filter((entry) => entry.completed).map((entry) => entry.difficulty.score));
      assert.equal(hardest.metrics[0]!.value, best);
    }
    for (const story of snap.stories) assert.ok(story.evidenceIds.every((id) => snap.evidence[id]));
  }
  const es = analyzeMatch({ ...request, language: "es", persona: "casual" }).stories.find((story) => story.id === "fastest-shot")!;
  const fr = analyzeMatch({ ...request, language: "fr", persona: "player" }).stories.find((story) => story.id === "fastest-shot")!;
  assert.match(es.title, /Tiro más rápido/);
  assert.match(fr.title, /Frappe la plus rapide/);
  assert.notEqual(es.summary, fr.summary);

  const tags = playerTags(fixture, activePlayerEvents(fixture, 90 * 60), 90 * 60);
  const fastShots = tags.filter((tag) => tag.metric === "shot_speed");
  assert.ok(fastShots.every((tag) => tag.value >= SHOT_SPEED_THRESHOLD_KMH && tag.eventId));
  assert.ok(tags.some((tag) => tag.metric === "distance" && tag.value === 5));
  assert.equal(new Set(tags.filter((tag) => tag.metric === "top_speed").map((tag) => tag.playerId)).size, tags.filter((tag) => tag.metric === "top_speed").length, "one top-speed alert per player");
  assert.deepEqual(tags, [...tags].sort((a, b) => a.atSecond - b.atSecond || a.playerId.localeCompare(b.playerId) || a.metric.localeCompare(b.metric)));
  const thresholds = analyzeMatch(request).stories.find((story) => story.id === "metric-thresholds");
  assert.ok(thresholds);
  assert.ok(thresholds!.evidenceIds.every((id) => tags.some((tag) => tag.eventId === id)));
  const firstTags = playerTags(fixture, activePlayerEvents(fixture, 90 * 60).filter((event) => secondOf(event) <= 45 * 60), 90 * 60, "first");
  assert.ok(firstTags.every((tag) => tag.atSecond <= 45 * 60));
});

test("live_metric claims verify computed numbers that pass the number guard", () => {
  const fixture = getFixture("rivergate-comeback");
  const archive = getArchive();
  const indexes = buildArchiveIndexes(archive);
  const shot = fixture.events.find((event) => event.id === "r1-shot-away-1")!;
  const pass = fixture.events.find((event) => event.type === "pass" && event.endX !== undefined && secondOf(event) < 20 * 60)!;
  const context = { event: shot, fixture, matchId: "m-1", clockSecond: 20 * 60, score: { home: 0, away: 1 } };
  const verify = (proposal: ClaimProposal) => verifyClaimProposal(archive, indexes, fixture, context, "story-1", "2026-01-01T00:00:00.000Z", proposal);

  const speed = verify({ kind: "live_metric", params: { eventId: shot.id, metric: "shot_speed" }, sources: [{ type: "event", id: shot.id }] });
  assert.equal(speed.ok, true);
  const kmh = Math.round(shot.speedKmh!);
  assert.match(speed.claim.text.en, new RegExp(`${kmh} km/h`));
  for (const language of ["es", "fr", "pt"] as const) assert.match(speed.claim.text[language], new RegExp(String(kmh)));
  assert.equal(guardDraftText(`Nico Hale with a ${kmh} km/h strike!`, [speed.claim.text.en], new Set(["Nico Hale"])), undefined);
  assert.match(guardDraftText(`Nico Hale with a ${kmh + 9} km/h strike!`, [speed.claim.text.en], new Set(["Nico Hale"])) ?? "", /Unsupported number/);

  const distance = verify({ kind: "live_metric", params: { eventId: pass.id, metric: "pass_distance" }, sources: [{ type: "event", id: pass.id }] });
  assert.equal(distance.ok, true);
  assert.match(distance.claim.text.en, new RegExp(`${Math.round(passDistanceM(pass)!)} m pass`));
  const difficulty = verify({ kind: "live_metric", params: { eventId: pass.id, metric: "pass_difficulty" }, sources: [{ type: "event", id: pass.id }] });
  assert.equal(difficulty.ok, true);
  assert.match(difficulty.claim.text.en, new RegExp(`${passDifficulty(pass, activePlayerEvents(fixture, 20 * 60))!.score}/100`));

  assert.equal(verify({ kind: "live_metric", params: { eventId: pass.id, metric: "shot_speed" }, sources: [{ type: "event", id: pass.id }] }).ok, false, "wrong event type");
  assert.equal(verify({ kind: "live_metric", params: { eventId: shot.id, metric: "pass_distance" }, sources: [{ type: "event", id: shot.id }] }).ok, false);
  const future = fixture.events.find((event) => event.id === "r1-shot-home-1")!;
  assert.equal(verify({ kind: "live_metric", params: { eventId: future.id, metric: "shot_speed" }, sources: [{ type: "event", id: future.id }] }).ok, false, "future event");
  const cameraFixture = { ...fixture, id: "video-clip" };
  const camera = verifyClaimProposal(archive, indexes, cameraFixture, { ...context, fixture: cameraFixture }, "story-1", "2026-01-01T00:00:00.000Z", { kind: "live_metric", params: { eventId: shot.id, metric: "shot_speed" }, sources: [{ type: "event", id: shot.id }] });
  assert.equal(camera.ok, false);
});
