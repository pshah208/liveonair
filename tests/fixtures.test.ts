import test from "node:test";
import assert from "node:assert/strict";
import { getFixture, listFixtures } from "../server/fixtures.js";
import type { MatchEvent } from "../shared/types.js";

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

test("listFixtures and getFixture expose deterministic fixture catalog", () => {
  const first = listFixtures();
  const second = listFixtures();
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
  for (const summary of first) {
    assert.ok(summary.eventCount > 30);
    assert.equal(summary.durationSeconds, 5400);
    assert.ok(summary.correctionAvailableAt > 0);
  }
});

test("fixture semantic integrity: correction target, timing, ordering, positions, and goal/shot links", () => {
  for (const summary of listFixtures()) {
    const fixture = getFixture(summary.id);
    const correctionTarget = fixture.events.find((e) => e.id === fixture.correctionEventId);
    assert.ok(correctionTarget, `${fixture.id} has correction target`);
    assert.equal(correctionTarget?.type, "goal");
    assert.ok(fixture.correctionAvailableAt > secondOf(correctionTarget as MatchEvent));

    const sorted = [...fixture.events].sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
    assert.deepEqual(fixture.events, sorted, `${fixture.id} events are pre-sorted`);

    const ids = new Set<string>();
    for (const evt of fixture.events) {
      assert.ok(!ids.has(evt.id), `${fixture.id} duplicate id ${evt.id}`);
      ids.add(evt.id);
      for (const coord of [evt.x, evt.y, evt.endX, evt.endY]) {
        if (typeof coord === "number") {
          assert.ok(coord >= 0 && coord <= 100, `${fixture.id} coordinate ${coord} out of bounds`);
        }
      }
      if (evt.type === "shot" && typeof evt.xg === "number") {
        assert.ok(Number.isFinite(evt.xg));
        assert.ok(evt.xg >= 0 && evt.xg <= 1);
      }
    }

    for (const goal of fixture.events.filter((e) => e.type === "goal")) {
      assert.ok(goal.relatedEventId, `${goal.id} has related shot`);
      const relatedShot = fixture.events.find((e) => e.id === goal.relatedEventId);
      assert.ok(relatedShot, `${goal.id} related shot exists`);
      assert.equal(relatedShot?.type, "shot");
      assert.equal(relatedShot?.teamId, goal.teamId);
    }
  }
});

test("red-carded players do not appear in later events", () => {
  for (const summary of listFixtures()) {
    const fixture = getFixture(summary.id);
    const redCards = fixture.events.filter((evt) => evt.type === "red_card");
    for (const red of redCards) {
      const redSecond = secondOf(red);
      const laterByDismissedPlayer = fixture.events.filter((evt) => evt.playerId === red.playerId && secondOf(evt) > redSecond);
      assert.equal(
        laterByDismissedPlayer.length,
        0,
        `${fixture.id} has post-red activity for dismissed player ${red.playerId}`
      );
    }
  }
});
