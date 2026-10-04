import test from "node:test";
import assert from "node:assert/strict";

import { buildFeedPlan } from "../server/matchlab/feed.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { resetGeneratedFixturesForTests } from "../server/fixtures.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
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
