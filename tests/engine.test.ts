import test from "node:test";
import assert from "node:assert/strict";

import { analyzeFixture, analyzeMatch, reconcileEvents } from "../server/engine.js";
import { getFixture, listFixtures, resetGeneratedFixturesForTests } from "../server/fixtures.js";
import type { AnalysisRequest, MatchEvent, MatchFixture } from "../shared/types.js";

const baseRequest: AnalysisRequest = {
  fixtureId: "rivergate-comeback",
  atSecond: 72 * 60,
  correction: false,
  persona: "analyst",
  language: "en",
};

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

test.beforeEach(() => {
  resetGeneratedFixturesForTests();
});

test("deterministic snapshot output for same input", () => {
  const a = analyzeMatch(baseRequest);
  const b = analyzeMatch(baseRequest);
  assert.deepEqual(a, b);
});

test("future events are excluded from evidence and recent events", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const snap = analyzeMatch({ ...baseRequest, atSecond: 10 * 60 });
  assert.ok(Object.values(snap.evidence).every((event) => secondOf(event) <= 10 * 60));
  assert.ok(snap.recentEvents.every((event) => secondOf(event) <= 10 * 60));
  assert.ok(Object.keys(snap.evidence).length < fixture.events.length);
});

test("score equals active non-rescinded goals and stats are internally consistent", () => {
  const snap = analyzeMatch(baseRequest);
  const activeGoals = Object.values(snap.evidence).filter((event) => event.type === "goal" && !event.rescinded);
  const homeGoals = activeGoals.filter((event) => event.teamId === "home").length;
  const awayGoals = activeGoals.filter((event) => event.teamId === "away").length;
  assert.equal(snap.score.home, homeGoals);
  assert.equal(snap.score.away, awayGoals);
  assert.equal(snap.stats.home.goals, homeGoals);
  assert.equal(snap.stats.away.goals, awayGoals);
  assert.equal(
    snap.stats.home.shots + snap.stats.away.shots,
    Object.values(snap.evidence).filter((event) => event.type === "shot").length,
  );
});

test("correction applies as revision 2 and retracts goal impact without mutating unrelated evidence", () => {
  const pre = analyzeMatch({ ...baseRequest, atSecond: 60 * 60, correction: false });
  const post = analyzeMatch({ ...baseRequest, atSecond: 60 * 60, correction: true });
  const correctedId = getFixture(baseRequest.fixtureId).correctionEventId;
  const preGoal = pre.evidence[correctedId];
  const postGoal = post.evidence[correctedId];
  assert.equal(preGoal.revision, 1);
  assert.equal(postGoal.revision, 2);
  assert.equal(postGoal.rescinded, true);
  assert.ok(post.corrections.some((correction) => correction.eventId === correctedId));
  assert.equal(post.score.away, pre.score.away - 1);

  const stableId = "r1-goal-home-1";
  assert.deepEqual(post.evidence[stableId], pre.evidence[stableId]);
  const postStoryEvidence = new Set(post.stories.flatMap((story) => story.evidenceIds));
  assert.ok(!postStoryEvidence.has(correctedId));
});

test("correction toggle does not mutate fixture arrays or event objects", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const before = fixture.events.map((event) => ({ ...event }));
  analyzeMatch({ ...baseRequest, atSecond: 70 * 60, correction: true });
  const after = getFixture(baseRequest.fixtureId).events;
  assert.deepEqual(after, before);
});

test("window boundaries include exactly the last eight minutes", () => {
  const snap = analyzeMatch({ ...baseRequest, atSecond: 61 * 60 + 57, fixtureId: "setpiece-pattern" });
  const cutoff = 61 * 60 + 57 - 8 * 60;
  const passingStory = snap.stories.find((story) => story.id === "passing-window");
  assert.ok(passingStory);
  assert.equal(passingStory?.windowStart, cutoff);
  assert.equal(passingStory?.windowEnd, 61 * 60 + 57);
  const passIds = Object.values(snap.evidence)
    .filter((event) => event.type === "pass" && secondOf(event) >= cutoff && secondOf(event) <= 61 * 60 + 57)
    .map((event) => event.id)
    .sort();
  assert.deepEqual([...(passingStory?.evidenceIds ?? [])].sort(), passIds);
});

test("reconcileEvents merges duplicate ids by latest revision", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const seed = fixture.events.filter((event) => event.id === "r1-goal-away-1");
  const synthetic = [...seed, { ...seed[0], revision: 3 }];
  const { activeEvents } = reconcileEvents(synthetic, fixture, 90 * 60, false);
  const merged = activeEvents.find((event) => event.id === "r1-goal-away-1");
  assert.equal(merged?.revision, 3);
});

test("persona and language affect content and stateVersion", () => {
  const analystEn = analyzeMatch({ ...baseRequest, persona: "analyst", language: "en" });
  const casualEs = analyzeMatch({ ...baseRequest, persona: "casual", language: "es", correction: true });
  const playerFr = analyzeMatch({ ...baseRequest, persona: "player", language: "fr" });
  assert.notEqual(analystEn.stateVersion, casualEs.stateVersion);
  assert.notEqual(casualEs.stateVersion, playerFr.stateVersion);
  assert.notEqual(analystEn.stories[0]?.summary, casualEs.stories[0]?.summary);
  assert.match(casualEs.corrections[0]?.message ?? "n/a", /anulado|Actualización|rev/i);
});

test("favorite player validation and mismatched fixture ids reject", () => {
  assert.throws(
    () => analyzeMatch({ ...baseRequest, favoritePlayerId: "bad-player-id" }),
    (error: unknown) => error instanceof RangeError && /Unknown favorite player/.test(error.message),
  );

  const fixture = getFixture(baseRequest.fixtureId);
  assert.throws(
    () => analyzeFixture(fixture, { ...baseRequest, fixtureId: "wrong-id" }),
    (error: unknown) => error instanceof RangeError && /does not match fixture/.test(error.message),
  );
});

test("unknown fixture and invalid clock throw range errors", () => {
  assert.throws(
    () => analyzeMatch({ ...baseRequest, fixtureId: "does-not-exist" }),
    (error: unknown) => error instanceof RangeError,
  );
  assert.throws(
    () => analyzeMatch({ ...baseRequest, atSecond: -1 }),
    (error: unknown) => error instanceof RangeError,
  );
  assert.throws(
    () => analyzeMatch({ ...baseRequest, atSecond: 999999 }),
    (error: unknown) => error instanceof RangeError,
  );
});

test("early clock behavior returns neutral no-attack card", () => {
  const snap = analyzeMatch({ ...baseRequest, atSecond: 0, correction: true });
  assert.equal(snap.score.home, 0);
  assert.equal(snap.score.away, 0);
  assert.ok(snap.eventCount >= 1);
  assert.equal(snap.stories.length, 1);
  assert.equal(snap.stories[0]?.id, "early-feed");
  assert.ok(/no attacking evidence|sin evidencia de ataque|aucune preuve d'attaque/i.test(snap.stories[0]?.summary ?? ""));
});

test("all built-in fixtures are analyzable and return bounded story count and evidence coverage", () => {
  for (const fixture of listFixtures()) {
    const snap = analyzeMatch({
      fixtureId: fixture.id,
      atSecond: fixture.durationSeconds,
      correction: true,
      persona: "analyst",
      language: "en",
    });
    assert.ok(snap.stories.length >= 0 && snap.stories.length <= 7);
    assert.ok(snap.evidenceCoverage >= 0 && snap.evidenceCoverage <= 100);
    assert.ok(snap.recentEvents.length <= 20);
  }
});

test("pressure story reports tie explicitly when both sides have equal pressure", () => {
  let found = false;
  for (let second = 8 * 60; second <= 90 * 60; second += 30) {
    const snap = analyzeMatch({ ...baseRequest, fixtureId: "discipline-swing", atSecond: second });
    const pressureStory = snap.stories.find((story) => story.id === "pressure-window");
    if (!pressureStory) continue;
    const homePressure = pressureStory.metrics.find((metric) => /Home pressure|Presiones local|Pressings domicile/.test(metric.label))?.value;
    const awayPressure = pressureStory.metrics.find((metric) => /Away pressure|Presiones visitante|Pressings extérieur/.test(metric.label))?.value;
    if (typeof homePressure === "number" && homePressure === awayPressure) {
      found = true;
      assert.match(pressureStory.summary, /tie|empat|égalité/i);
      break;
    }
  }
  assert.equal(found, true);
});

test("set piece radar cue uses exact so-far counts and cites linked corners and shots", () => {
  const snap = analyzeMatch({ ...baseRequest, fixtureId: "setpiece-pattern", atSecond: 62 * 60 });
  const setPieceStory = snap.stories.find((story) => story.id === "setpiece-pattern");
  assert.ok(setPieceStory);
  assert.match(setPieceStory?.summary ?? "", /Watch Rivergate FC's next corner: 3 of their 3 corners so far led directly to a shot\./);

  const evidence = Object.values(snap.evidence);
  const evidenceById = new Map(evidence.map((event) => [event.id, event]));
  const homeCornerLinks = evidence
    .filter((event) => event.type === "shot" && event.teamId === "home" && event.relatedEventId && evidenceById.get(event.relatedEventId)?.type === "corner")
    .flatMap((event) => [event.relatedEventId as string, event.id])
    .sort();
  assert.ok(homeCornerLinks.length >= 6);
  assert.deepEqual(
    [...new Set(homeCornerLinks)].sort(),
    [...new Set((setPieceStory?.evidenceIds ?? []).filter((id) => homeCornerLinks.includes(id)))].sort(),
  );
});

test("analyzeFixture reconciles partial fixtures with rescinded revisions already in the feed", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const partialEvents = fixture.events.filter((event) => secondOf(event) <= 60 * 60);
  const correctionTarget = partialEvents.find((event) => event.id === fixture.correctionEventId)!;
  const partialFixture: MatchFixture = {
    ...fixture,
    events: [...partialEvents, { ...correctionTarget, revision: correctionTarget.revision + 1, rescinded: true }],
  };

  const snapshot = analyzeFixture(partialFixture, { ...baseRequest, atSecond: 60 * 60, correction: false });
  assert.equal(snapshot.evidence[fixture.correctionEventId]?.revision, 2);
  assert.equal(snapshot.evidence[fixture.correctionEventId]?.rescinded, true);
  assert.equal(snapshot.score.away, 1);
});

test("recent events exclude rescinded goals while evidence retains corrected revision", () => {
  const snap = analyzeMatch({ ...baseRequest, atSecond: 60 * 60, correction: true });
  const correctedId = getFixture(baseRequest.fixtureId).correctionEventId;
  assert.equal(snap.evidence[correctedId]?.rescinded, true);
  assert.ok(!snap.recentEvents.some((event) => event.id === correctedId));
});

test("full-match scope is the default and leaves the snapshot unchanged", () => {
  const implicit = analyzeMatch(baseRequest);
  const explicit = analyzeMatch({ ...baseRequest, period: "full" });
  assert.deepEqual(explicit, implicit);
  assert.deepEqual(implicit.scope, { period: "full", available: true });
  assert.deepEqual(implicit.periodScore, implicit.score);
});

test("first-half scope during the second half keeps the canonical score and scopes stats, stories and evidence", () => {
  const request = { ...baseRequest, correction: true };
  const full = analyzeMatch(request);
  const first = analyzeMatch({ ...request, period: "first" });
  const second = analyzeMatch({ ...request, period: "second" });
  assert.deepEqual(first.score, full.score, "the scorebug stays whole-match");
  assert.deepEqual(full.score, { home: 1, away: 1 });
  assert.deepEqual(first.periodScore, { home: 0, away: 1 }, "the first-half goal rescinded at 57' leaves the first half");
  assert.deepEqual(second.periodScore, { home: 1, away: 0 });
  assert.equal(first.stats.away.goals, 1);
  assert.equal(first.evidence[getFixture(baseRequest.fixtureId).correctionEventId]?.rescinded, true);
  for (const team of ["home", "away"] as const) {
    assert.equal(first.stats[team].passes + second.stats[team].passes, full.stats[team].passes);
    assert.equal(first.stats[team].shots + second.stats[team].shots, full.stats[team].shots);
    const { passes, completedPasses, passAccuracy } = first.stats[team];
    assert.equal(passAccuracy, passes ? Number(((completedPasses / passes) * 100).toFixed(2)) : 0);
  }
  assert.ok(Object.values(first.evidence).every((event) => secondOf(event) <= 45 * 60));
  assert.ok(first.recentEvents.every((event) => secondOf(event) <= 45 * 60));
  assert.ok(Object.values(second.evidence).every((event) => secondOf(event) > 45 * 60));
  assert.ok(first.stories.length > 0, "a finished half still yields its own insights");
  assert.ok(first.stories.every((story) => story.windowEnd <= 45 * 60 && story.evidenceIds.every((id) => first.evidence[id])));
  assert.ok(second.stories.every((story) => story.windowStart > 45 * 60));
  assert.equal(new Set([full.stateVersion, first.stateVersion, second.stateVersion]).size, 3);
});

test("second half before kick-off is not started rather than empty, and video fixtures report halves unavailable", () => {
  const early = analyzeMatch({ ...baseRequest, atSecond: 30 * 60, period: "second" });
  assert.deepEqual(early.scope, { period: "second", available: false, reason: "not_started" });
  assert.deepEqual(early.stories, []);
  assert.equal(early.eventCount, 0);
  assert.deepEqual(early.score, analyzeMatch({ ...baseRequest, atSecond: 30 * 60 }).score);

  const source = getFixture(baseRequest.fixtureId);
  const clip: MatchFixture = { ...source, id: "video-clip", periods: undefined, events: source.events.map(({ period: _period, ...rest }) => rest) };
  const unavailable = analyzeFixture(clip, { ...baseRequest, fixtureId: clip.id, period: "first" });
  assert.deepEqual(unavailable.scope, { period: "first", available: false, reason: "unavailable" });
  assert.equal(unavailable.stats.home.passes, 0);
  const whole = analyzeFixture(clip, { ...baseRequest, fixtureId: clip.id });
  assert.ok(whole.stats.home.passes > 0, "full/clip analysis keeps working");
});

test("favourite club only reorders and marks stories; stats, score and story text are unchanged", () => {
  const neutral = analyzeMatch(baseRequest);
  const fixture = getFixture(baseRequest.fixtureId);
  let marked = 0;
  for (const side of ["home", "away"] as const) {
    const favored = analyzeMatch({ ...baseRequest, favoriteClubId: side });
    marked += favored.stories.filter((story) => story.favorite).length;
    assert.deepEqual(favored.stats, neutral.stats);
    assert.deepEqual(favored.score, neutral.score);
    assert.notEqual(favored.stateVersion, neutral.stateVersion);
    assert.deepEqual(favored.focus, { favoriteClubId: side, favoriteClubInMatch: true, favoriteTeamId: side });
    for (const story of favored.stories) {
      assert.equal(story.favorite === true, story.teamId === side);
      const original = neutral.stories.find((item) => item.id === story.id);
      if (original) {
        assert.equal(story.summary, original.summary);
        assert.deepEqual(story.metrics, original.metrics);
      }
    }
    for (let index = 1; index < favored.stories.length; index += 1) {
      assert.ok(favored.stories[index - 1]!.importance >= favored.stories[index]!.importance);
    }
    for (const story of favored.stories.filter((item) => item.favorite)) {
      const original = neutral.stories.find((item) => item.id === story.id);
      if (original) assert.ok(story.importance > original.importance);
    }
  }
  assert.ok(marked > 0, "fixture should have team-attributed stories");
  if (fixture.home.archiveClubId) {
    const byArchive = analyzeMatch({ ...baseRequest, favoriteClubId: fixture.home.archiveClubId });
    assert.equal(byArchive.focus?.favoriteTeamId, "home");
  }
  const absent = analyzeMatch({ ...baseRequest, favoriteClubId: "club-not-in-this-match" });
  assert.equal(absent.focus?.favoriteClubInMatch, false);
  assert.deepEqual(absent.stories.map((story) => story.id), neutral.stories.map((story) => story.id));
  assert.ok(absent.stories.every((story) => !story.favorite));
});
