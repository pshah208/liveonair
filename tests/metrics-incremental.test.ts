import test from "node:test";
import assert from "node:assert/strict";

import { aggregatePasses, passQualities, passQualitiesFull } from "../shared/metrics.js";
import { generateMatch } from "../server/matchlab/generator.js";
import type { MatchEvent } from "../shared/types.js";

const secondOf = (event: MatchEvent) => event.minute * 60 + event.second;

/** Latest revision per id, in feed order: what the engine sees after reconciling corrections. */
function reconcile(log: MatchEvent[]): MatchEvent[] {
  const byId = new Map<string, MatchEvent>();
  for (const event of log) {
    const previous = byId.get(event.id);
    if (!previous || event.revision >= previous.revision) byId.set(event.id, { ...event });
  }
  return [...byId.values()].sort((a, b) => secondOf(a) - secondOf(b));
}

test("incremental pass metrics equal a full recompute across a whole match with corrections", () => {
  for (const [scenario, seed] of [["late_winner", 23], ["goal_fest", 7], ["red_card", 101]] as const) {
    const fixture = generateMatch({ scenario, seed });
    const events = [...fixture.events].sort((a, b) => secondOf(a) - secondOf(b));
    const log: MatchEvent[] = [];
    let passIndex = 0;
    let pressureIndex = 0;
    let corrections = 0;
    let checks = 0;
    for (const event of events) {
      log.push({ ...event });
      if (event.type === "pass" && ++passIndex % 7 === 0 && event.endX !== undefined) {
        // A later correction moves the end point and bumps the revision.
        log.push({ ...event, revision: event.revision + 1, endX: Math.min(100, event.endX + 12) });
        corrections += 1;
      }
      if (event.type === "pass" && passIndex % 11 === 0) {
        // A correction rescinds the pass outright.
        log.push({ ...event, revision: event.revision + 2, rescinded: true });
        corrections += 1;
      }
      if (event.type === "pressure" && ++pressureIndex % 5 === 0) {
        // Rescinding a pressure changes the context of passes that already counted it.
        log.push({ ...event, revision: event.revision + 1, rescinded: true });
        corrections += 1;
      }
      const active = reconcile(log);
      const incremental = passQualities(active);
      const full = passQualitiesFull(active);
      assert.deepEqual(incremental, full, `${scenario}: pass qualities diverged at ${event.id}`);
      for (const teamId of ["home", "away"] as const) {
        assert.deepEqual(
          aggregatePasses(incremental.filter((quality) => quality.event.teamId === teamId)),
          aggregatePasses(full.filter((quality) => quality.event.teamId === teamId)),
        );
      }
      checks += 1;
    }
    assert.ok(corrections > 10, `${scenario}: expected corrections in the log`);
    assert.ok(checks > 100);
    // A second, unrelated fixture reusing event ids must not read the first fixture's memo.
    const other = generateMatch({ scenario, seed: seed + 1 });
    assert.deepEqual(passQualities(other.events), passQualitiesFull(other.events));
  }
  assert.deepEqual(passQualities(generateMatch({ scenario: "comeback", seed: 3 }).events, { camera: true }), []);
});
