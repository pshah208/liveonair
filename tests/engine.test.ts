import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMatch, reconcileEvents } from "../server/engine.js";
import { getFixture, listFixtures } from "../server/fixtures.js";
import type { AnalysisRequest } from "../shared/types.js";

const baseRequest: AnalysisRequest = {
  fixtureId: "rivergate-comeback",
  atSecond: 72 * 60,
  correction: false,
  persona: "analyst",
  language: "en"
};

test("deterministic snapshot output for same input", () => {
  const a = analyzeMatch(baseRequest);
  const b = analyzeMatch(baseRequest);
  assert.deepEqual(a, b);
});

test("future events are excluded from evidence and recent events", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const snap = analyzeMatch({ ...baseRequest, atSecond: 10 * 60 });
  assert.ok(Object.values(snap.evidence).every((e) => e.minute * 60 + e.second <= 10 * 60));
  assert.ok(snap.recentEvents.every((e) => e.minute * 60 + e.second <= 10 * 60));
  assert.ok(Object.keys(snap.evidence).length < fixture.events.length);
});

test("score equals active non-rescinded goals and stats are internally consistent", () => {
  const snap = analyzeMatch(baseRequest);
  const activeGoals = Object.values(snap.evidence).filter((e) => e.type === "goal" && !e.rescinded);
  const homeGoals = activeGoals.filter((e) => e.teamId === "home").length;
  const awayGoals = activeGoals.filter((e) => e.teamId === "away").length;
  assert.equal(snap.score.home, homeGoals);
  assert.equal(snap.score.away, awayGoals);
  assert.equal(snap.stats.home.goals, homeGoals);
  assert.equal(snap.stats.away.goals, awayGoals);
  assert.equal(
    snap.stats.home.shots + snap.stats.away.shots,
    Object.values(snap.evidence).filter((e) => e.type === "shot").length
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
  assert.ok(post.corrections.some((c) => c.eventId === correctedId));
  assert.equal(post.score.away, pre.score.away - 1);

  const stableId = "r1-goal-home-1";
  assert.deepEqual(post.evidence[stableId], pre.evidence[stableId]);
  const postStoryEvidence = new Set(post.stories.flatMap((s) => s.evidenceIds));
  assert.ok(!postStoryEvidence.has(correctedId));
});

test("correction toggle does not mutate fixture arrays or event objects", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const before = fixture.events.map((e) => ({ ...e }));
  analyzeMatch({ ...baseRequest, atSecond: 70 * 60, correction: true });
  const after = getFixture(baseRequest.fixtureId).events;
  assert.deepEqual(after, before);
});

test("window boundaries include exactly the last eight minutes", () => {
  const snap = analyzeMatch({ ...baseRequest, atSecond: 61 * 60 + 57, fixtureId: "setpiece-pattern" });
  const cutoff = 61 * 60 + 57 - 8 * 60;
  const passingStory = snap.stories.find((s) => s.id === "passing-window");
  assert.ok(passingStory);
  assert.equal(passingStory?.windowStart, cutoff);
  assert.equal(passingStory?.windowEnd, 61 * 60 + 57);
  const passIds = Object.values(snap.evidence)
    .filter((e) => e.type === "pass" && e.minute * 60 + e.second >= cutoff && e.minute * 60 + e.second <= 61 * 60 + 57)
    .map((e) => e.id)
    .sort();
  assert.deepEqual([...(passingStory?.evidenceIds ?? [])].sort(), passIds);
});

test("reconcileEvents merges duplicate ids by latest revision", () => {
  const fixture = getFixture(baseRequest.fixtureId);
  const seed = fixture.events.filter((e) => e.id === "r1-goal-away-1");
  const synthetic = [...seed, { ...seed[0], revision: 3 }];
  const { activeEvents } = reconcileEvents(synthetic, fixture, 90 * 60, false);
  const merged = activeEvents.find((e) => e.id === "r1-goal-away-1");
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

test("favorite player validation rejects unknown player id", () => {
  assert.throws(
    () => analyzeMatch({ ...baseRequest, favoritePlayerId: "bad-player-id" }),
    (error: unknown) => error instanceof RangeError && /Unknown favorite player/.test(error.message)
  );
});

test("unknown fixture and invalid clock throw range errors", () => {
  assert.throws(
    () => analyzeMatch({ ...baseRequest, fixtureId: "does-not-exist" }),
    (error: unknown) => error instanceof RangeError
  );
  assert.throws(
    () => analyzeMatch({ ...baseRequest, atSecond: -1 }),
    (error: unknown) => error instanceof RangeError
  );
  assert.throws(
    () => analyzeMatch({ ...baseRequest, atSecond: 999999 }),
    (error: unknown) => error instanceof RangeError
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

test("all fixtures are analyzable and return bounded story count and evidence coverage", () => {
  for (const fx of listFixtures()) {
    const snap = analyzeMatch({
      fixtureId: fx.id,
      atSecond: fx.durationSeconds,
      correction: true,
      persona: "analyst",
      language: "en"
    });
    assert.ok(snap.stories.length >= 0 && snap.stories.length <= 7);
    assert.ok(snap.evidenceCoverage >= 0 && snap.evidenceCoverage <= 100);
    assert.ok(snap.recentEvents.length <= 20);
  }
});

test("pressure story reports tie explicitly when both sides have equal pressure", () => {
  let found = false;
  for (let sec = 8 * 60; sec <= 90 * 60; sec += 30) {
    const snap = analyzeMatch({ ...baseRequest, fixtureId: "discipline-swing", atSecond: sec });
    const pressureStory = snap.stories.find((story) => story.id === "pressure-window");
    if (!pressureStory) continue;
    const homePressure = pressureStory.metrics.find((m) => /Home pressure|Presiones local|Pressings domicile/.test(m.label))?.value;
    const awayPressure = pressureStory.metrics.find((m) => /Away pressure|Presiones visitante|Pressings extérieur/.test(m.label))?.value;
    if (typeof homePressure === "number" && homePressure === awayPressure) {
      found = true;
      assert.match(pressureStory.summary, /tie|empat|égalité/i);
      break;
    }
  }
  assert.equal(found, true);
});

test("set piece story cites linked corner and shot events from story window", () => {
  const snap = analyzeMatch({ ...baseRequest, fixtureId: "setpiece-pattern", atSecond: 62 * 60 });
  const setPieceStory = snap.stories.find((story) => story.id === "setpiece-pattern");
  assert.ok(setPieceStory);
  const eventMap = new Map(Object.values(snap.evidence).map((evt) => [evt.id, evt]));
  for (const evidenceId of setPieceStory?.evidenceIds ?? []) {
    const event = eventMap.get(evidenceId);
    assert.ok(event);
    const sec = (event?.minute ?? 0) * 60 + (event?.second ?? 0);
    assert.ok(sec >= (setPieceStory?.windowStart ?? 0) && sec <= (setPieceStory?.windowEnd ?? 0));
  }
  const types = new Set((setPieceStory?.evidenceIds ?? []).map((id) => eventMap.get(id)?.type));
  assert.ok(types.has("corner"));
  assert.ok(types.has("shot"));
});

test("recent events exclude rescinded goals while evidence retains corrected revision", () => {
  const snap = analyzeMatch({ ...baseRequest, atSecond: 60 * 60, correction: true });
  const correctedId = getFixture(baseRequest.fixtureId).correctionEventId;
  assert.equal(snap.evidence[correctedId]?.rescinded, true);
  assert.ok(!snap.recentEvents.some((evt) => evt.id === correctedId));
});
