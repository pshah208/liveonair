import test from "node:test";
import assert from "node:assert/strict";

import { generateMatch } from "../server/matchlab/generator.js";
import { getFixture, listFixtures, registerFixture, resetGeneratedFixturesForTests } from "../server/fixtures.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function assertFixtureSemantics(fixture: MatchFixture): void {
  const correctionTarget = fixture.events.find((event) => event.id === fixture.correctionEventId);
  assert.ok(correctionTarget, `${fixture.id} has correction target`);
  assert.equal(correctionTarget?.type, "goal");
  assert.ok(fixture.correctionAvailableAt > secondOf(correctionTarget as MatchEvent));

  const sorted = [...fixture.events].sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
  assert.deepEqual(fixture.events, sorted, `${fixture.id} events are pre-sorted`);

  const ids = new Set<string>();
  for (const event of fixture.events) {
    assert.ok(!ids.has(event.id), `${fixture.id} duplicate id ${event.id}`);
    ids.add(event.id);
    for (const coord of [event.x, event.y, event.endX, event.endY]) {
      if (typeof coord === "number") {
        assert.ok(coord >= 0 && coord <= 100, `${fixture.id} coordinate ${coord} out of bounds`);
      }
    }
    if (event.type === "shot" && typeof event.xg === "number") {
      assert.ok(event.xg >= 0 && event.xg <= 1);
    }
  }

  for (const goal of fixture.events.filter((event) => event.type === "goal")) {
    assert.ok(goal.relatedEventId, `${goal.id} has related shot`);
    const relatedShot = fixture.events.find((event) => event.id === goal.relatedEventId);
    assert.ok(relatedShot, `${goal.id} related shot exists`);
    assert.equal(relatedShot?.type, "shot");
    assert.equal(relatedShot?.teamId, goal.teamId);
  }
}

test.beforeEach(() => {
  resetGeneratedFixturesForTests();
});

test("listFixtures and getFixture expose deterministic built-in catalog with archive ids", () => {
  const first = listFixtures();
  const second = listFixtures();
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
  for (const summary of first) {
    assert.ok(summary.eventCount > 30);
    assert.equal(summary.durationSeconds, 5400);
    assert.ok(summary.correctionAvailableAt > 0);
    assert.ok(summary.home.archiveClubId);
    assert.ok(summary.away.archiveClubId);
    assert.ok(summary.home.players.every((player) => player.archiveId));
    assert.ok(summary.away.players.every((player) => player.archiveId));
  }
});

test("built-in fixture semantic integrity and dismissals remain valid", () => {
  for (const summary of listFixtures()) {
    const fixture = getFixture(summary.id);
    assertFixtureSemantics(fixture);

    for (const red of fixture.events.filter((event) => event.type === "red_card")) {
      const redSecond = secondOf(red);
      const laterByDismissedPlayer = fixture.events.filter((event) => event.playerId === red.playerId && secondOf(event) > redSecond);
      assert.equal(laterByDismissedPlayer.length, 0, `${fixture.id} has post-red activity for ${red.playerId}`);
    }
  }
});

test("generated registry evicts oldest generated fixtures and replaces duplicate ids", () => {
  for (let seed = 1; seed <= 22; seed += 1) {
    registerFixture(generateMatch({ scenario: "comeback", seed }));
  }

  assert.equal(listFixtures().length, 23);
  assert.throws(
    () => getFixture("gen-comeback-1"),
    (error: unknown) => error instanceof RangeError,
  );
  assert.throws(
    () => getFixture("gen-comeback-2"),
    (error: unknown) => error instanceof RangeError,
  );

  const replacement = generateMatch({ scenario: "comeback", seed: 10 });
  replacement.description = "Updated synthetic description";
  registerFixture(replacement);

  assert.equal(listFixtures().length, 23);
  assert.equal(getFixture("gen-comeback-10").description, "Updated synthetic description");
});
