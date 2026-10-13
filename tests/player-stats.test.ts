import assert from "node:assert/strict";
import test from "node:test";

import { analysePlayers, heatGrid, TRACKING_METRICS } from "../shared/playerStats.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import { createPlayerAnalyst, rulesNote } from "../server/players/analyst.js";

function event(overrides: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type">): MatchEvent {
  return { revision: 1, minute: 10, second: 0, teamId: "home", playerId: "h9", outcome: "complete", x: 50, y: 50, ...overrides };
}

function fixture(events: MatchEvent[]): MatchFixture {
  return {
    id: "fx-1", seed: 1, title: "Rivergate vs Northbridge", description: "",
    home: { id: "home", name: "Rivergate", shortName: "RIV", players: [
      { id: "h9", name: "Ana Ruiz", number: 9, position: "FW", teamId: "home" },
      { id: "h8", name: "Lucia Vega", number: 8, position: "MF", teamId: "home" },
    ] },
    away: { id: "away", name: "Northbridge", shortName: "NOR", players: [
      { id: "a1", name: "Ola Berg", number: 1, position: "GK", teamId: "away" },
      { id: "a4", name: "Claire Dubois", number: 4, position: "DF", teamId: "away" },
    ] },
    events, durationSeconds: 5400, correctionEventId: "", correctionAvailableAt: 9999,
  };
}

const match = fixture([
  event({ id: "p1", type: "pass", playerId: "h8", second: 0, x: 40, y: 50, endX: 70, endY: 45 }),
  event({ id: "p2", type: "pass", playerId: "h8", second: 3, x: 70, y: 45, endX: 75, endY: 40, outcome: "incomplete" }),
  event({ id: "p3", type: "pass", playerId: "h8", second: 20, x: 60, y: 50, endX: 85, endY: 48 }),
  event({ id: "s1", type: "shot", playerId: "h9", second: 25, x: 88, y: 50, xg: 0.4, outcome: "success" }),
  event({ id: "g1", type: "goal", playerId: "h9", second: 26, x: 95, y: 50, outcome: "success", relatedEventId: "s1" }),
  event({ id: "s2", type: "shot", playerId: "h9", minute: 30, x: 80, y: 30, xg: 0.1, outcome: "saved" }),
  event({ id: "sv", type: "save", teamId: "away", playerId: "a1", minute: 30, second: 1, x: 94, y: 50, outcome: "success", relatedEventId: "s2" }),
  event({ id: "t1", type: "tackle", teamId: "away", playerId: "a4", minute: 40, x: 30, y: 50, outcome: "success" }),
  event({ id: "f1", type: "foul", teamId: "away", playerId: "a4", minute: 41, x: 30, y: 50, outcome: "none" }),
  event({ id: "y1", type: "yellow_card", teamId: "away", playerId: "a4", minute: 41, second: 10, x: 30, y: 50, outcome: "none" }),
  event({ id: "x1", type: "shot", playerId: "h9", minute: 50, x: 85, y: 50, outcome: "miss", rescinded: true }),
]);

test("player analysis derives scoring, creating, passing, defending and discipline from events", () => {
  const players = new Map(analysePlayers(match).map((entry) => [entry.player.id, entry]));
  const striker = players.get("h9")!;
  assert.equal(striker.goals, 1);
  assert.equal(striker.shots, 2, "rescinded shot excluded, goal counted through its shot");
  assert.equal(striker.shotsOnTarget, 2);
  assert.equal(striker.xg, 0.5);
  assert.equal(striker.touchesInBox, 2);

  const creator = players.get("h8")!;
  assert.equal(creator.assists, 1, "the completed pass within 15 s of the scoring shot is the assist");
  assert.equal(creator.keyPasses, 1);
  assert.equal(creator.xa, 0.4);
  assert.equal(creator.passes, 3);
  assert.equal(creator.passAccuracy, 67);
  assert.equal(creator.progressivePasses, 2);
  assert.equal(creator.possessionLost, 1);

  const keeper = players.get("a1")!;
  assert.equal(keeper.saves, 1);
  assert.ok(keeper.impact.components.find((component) => component.key === "goalkeeping")!.value > 0);

  const defender = players.get("a4")!;
  assert.equal(defender.tacklesWon, 1);
  assert.equal(defender.fouls, 1);
  assert.equal(defender.yellowCards, 1);
  assert.ok(defender.impact.components.find((component) => component.key === "discipline")!.value < 0);
  assert.equal(defender.touches.length, 2, "cards are not on-ball touches");
  // Away actions are mirrored so the away side attacks right to left.
  assert.equal(defender.touches[0]!.x, 70);

  assert.ok(striker.impact.rating > 6 && striker.impact.rating <= 10);
  assert.ok(striker.impact.rating > defender.impact.rating);
});

test("uptoSecond limits analysis to events already played", () => {
  const early = analysePlayers(match, 24).find((entry) => entry.player.id === "h9")!;
  assert.equal(early.goals, 0);
  assert.equal(early.involvements, 0);
});

test("heat grid is normalised and physical metrics are declared as tracking-only", () => {
  const grid = heatGrid([{ x: 10, y: 10 }, { x: 11, y: 11 }, { x: 90, y: 90 }], 4, 4);
  assert.equal(Math.max(...grid.flat()), 1);
  assert.equal(grid[0]![0], 1);
  assert.equal(grid[3]![3], 0.5);
  assert.ok(TRACKING_METRICS.some((metric) => metric.key === "distance"));
});

test("player analyst keeps grounded agent notes and falls back when a note invents numbers", async () => {
  const grounded = createPlayerAnalyst({ invoke: async () => ({ headline: "Ana Ruiz settles it", summary: "Ana Ruiz scored from 2 shots on target.", strengths: ["Clinical finishing"], concerns: [] }) });
  const kept = await grounded.write(match, "h9", "en", 5400);
  assert.equal(kept.source, "foundry");
  assert.equal(kept.headline, "Ana Ruiz settles it");

  const invented = createPlayerAnalyst({ invoke: async () => ({ headline: "Ana Ruiz ran 11.4 km", summary: "Covered 11400 metres.", strengths: [], concerns: [] }) });
  const rejected = await invented.write(match, "h9", "en", 5400);
  assert.equal(rejected.source, "rules");
  assert.match(rejected.problem ?? "", /unsupported numbers/u);

  const offline = createPlayerAnalyst();
  assert.equal(offline.configured, false);
  const rules = await offline.write(match, "h8", "en", 5400);
  assert.equal(rules.source, "rules");
  assert.ok(rules.strengths.some((item) => /chance/u.test(item)));
  assert.equal(rulesNote(analysePlayers(match).find((entry) => entry.player.id === "a4")!).concerns[0], "On a booking");

  await assert.rejects(() => offline.write(match, "nobody", "en", 5400), /Player not found/u);
});
