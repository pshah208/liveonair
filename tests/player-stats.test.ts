import assert from "node:assert/strict";
import test from "node:test";

import { analysePlayers, heatGrid, impactRating, impactRatingTone, IMPACT_RATING_BASELINE, IMPACT_RATING_FORMULA, IMPACT_RATING_TIERS, IMPACT_WEIGHTS, IMPACT_WEIGHT_DESCRIPTIONS, TRACKING_METRICS } from "../shared/playerStats.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { getFixture } from "../server/fixtures.js";
import { analystInput, createPlayerAnalyst, rulesNote } from "../server/players/analyst.js";

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
  assert.equal(creator.progressivePasses, 2, "uses the 25%-closer-to-goal progressive-pass rule");
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

test("illustrative activity score and colour tiers remain spread over five seeds and five generator scenarios", () => {
  const pool: ReturnType<typeof analysePlayers> = [];
  for (const scenario of ["goal_fest", "comeback", "red_card", "set_piece", "late_winner"] as const) {
    for (const seed of [11, 42, 77, 2026, 9090]) {
      const fixture = generateMatch({ scenario, seed });
      const players = analysePlayers(fixture);
      pool.push(...players);
      const ratings = players.map((entry) => entry.impact.rating).sort((a, b) => a - b);
      const quantile = (fraction: number) => ratings[Math.floor((ratings.length - 1) * fraction)]!;
      assert.equal(players.length, 22, `${scenario}/${seed}: both starting XIs included`);
      assert.ok(quantile(0.5) >= 6.4 && quantile(0.5) <= 7.2, `${scenario}/${seed}: median ${quantile(0.5)}`);
      assert.ok(quantile(0.9) <= 8.3, `${scenario}/${seed}: p90 ${quantile(0.9)}`);
      assert.equal(ratings.filter((rating) => rating === 10).length, 0, `${scenario}/${seed}: no routine 10s`);
      const keepers = players.filter((entry) => entry.player.position === "GK");
      assert.equal(keepers.length, 2);
      assert.ok(keepers.every((entry) => entry.impact.rating >= IMPACT_RATING_BASELINE && entry.impact.rating <= 8.1), `${scenario}/${seed}: keepers earn score from actual saves`);
      assert.ok(players.filter((entry) => entry.involvements === 0).every((entry) => entry.impact.rating === IMPACT_RATING_BASELINE), "unused players retain baseline");
      if (scenario === "red_card") {
        assert.equal(fixture.events.filter((event) => event.type === "red_card").length, 1, "red-card scenario includes a dismissal");
      }
      for (const entry of players) {
        assert.equal(entry.impact.rating, impactRating(entry.impact.total));
        assert.equal(entry.impact.total, Math.round(entry.impact.components.reduce((sum, part) => sum + part.value, 0) * 100) / 100);
      }
    }
  }
  const sorted = pool.map((entry) => entry.impact.rating).sort((a, b) => a - b);
  assert.ok(sorted[Math.floor((sorted.length - 1) * 0.5)]! >= 6.5);
  assert.ok(sorted[Math.floor((sorted.length - 1) * 0.9)]! <= 8.3);
  assert.ok(IMPACT_RATING_TIERS.excellent > IMPACT_RATING_TIERS.good && IMPACT_RATING_TIERS.good > IMPACT_RATING_TIERS.neutral);
  const share = (tone: ReturnType<typeof impactRatingTone>) => pool.filter((entry) => impactRatingTone(entry.impact.rating) === tone).length / pool.length;
  assert.ok(share("excellent") >= 0.10 && share("excellent") <= 0.20, `top-tier share ${share("excellent")}`);
  assert.ok(share("poor") <= 0.20, `bottom-tier share ${share("poor")}`);
  assert.equal(impactRatingTone(IMPACT_RATING_BASELINE), "neutral", "inactive players are not coloured poor");
  assert.ok(IMPACT_WEIGHTS.tackleLost <= 0);
  assert.equal(IMPACT_WEIGHT_DESCRIPTIONS.length, Object.keys(IMPACT_WEIGHTS).length);
  assert.ok(IMPACT_WEIGHT_DESCRIPTIONS.some((label) => label.startsWith("tackle lost -")));
  assert.ok(IMPACT_WEIGHT_DESCRIPTIONS.some((label) => label.startsWith("shot off target +")));
  assert.equal(impactRating(0), IMPACT_RATING_BASELINE);
});

test("staged comeback activity scores remain differentiated despite sparse events", () => {
  const players = analysePlayers(getFixture("rivergate-comeback")).filter((entry) => entry.involvements >= 10);
  const ratings = players.map((entry) => entry.impact.rating);
  assert.ok(players.length >= 3);
  assert.ok(new Set(ratings).size >= 2);
  assert.ok(ratings.every((rating) => rating >= 5.5 && rating < 9));
  assert.ok(players.some((entry) => entry.goals > 0 && entry.impact.rating > 7));
});

test("a lost tackle cannot increase a player's score", () => {
  const alone = fixture([]);
  const lost = fixture([event({ id: "lost-tackle", type: "tackle", outcome: "incomplete" })]);
  const before = analysePlayers(alone).find((entry) => entry.player.id === "h9")!;
  const after = analysePlayers(lost).find((entry) => entry.player.id === "h9")!;
  assert.ok(after.impact.total < before.impact.total);
  assert.ok(after.impact.rating <= before.impact.rating);
});

test("inactive substitutes stay at baseline and a short appearance is not penalised by minutes", () => {
  const staged = analysePlayers(getFixture("discipline-swing"));
  assert.ok(staged.some((entry) => entry.involvements === 0 && entry.impact.rating === IMPACT_RATING_BASELINE));
  const withSub = fixture([
    event({ id: "starter-pass", type: "pass", playerId: "h9", minute: 10, endX: 70, endY: 50 }),
    event({ id: "sub-on", type: "substitution", playerId: "h8", minute: 85, outcome: "none" }),
    event({ id: "sub-pass", type: "pass", playerId: "h8", minute: 89, endX: 70, endY: 50 }),
  ]);
  const players = analysePlayers(withSub);
  assert.equal(players.find((entry) => entry.player.id === "h8")!.impact.rating, players.find((entry) => entry.player.id === "h9")!.impact.rating);
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
  assert.equal(analystInput(match, "h9", "en", 5400).payload.impactModel, `${IMPACT_RATING_FORMULA} Illustrative, from logged events only.`);
  assert.match(rulesNote(analysePlayers(fixture([event({ id: "missed", type: "pass", outcome: "incomplete" })])).find((entry) => entry.player.id === "h9")!).summary, /6\.2 baseline/);

  const formulaNote = createPlayerAnalyst({ invoke: async () => ({ headline: "Ana Ruiz", summary: "Baseline 6.2, span 3.8, scale 4.5; range 3 to 10.", strengths: [], concerns: [] }) });
  assert.equal((await formulaNote.write(match, "h9", "en", 5400)).source, "foundry", "model constants are permitted by grounding guard");

  await assert.rejects(() => offline.write(match, "nobody", "en", 5400), /Player not found/u);
});

const halves = fixture([
  event({ id: "k1", type: "pass", playerId: "h8", minute: 10, second: 0, endX: 80 }),
  event({ id: "k2", type: "pass", playerId: "h8", minute: 10, second: 5, outcome: "incomplete" }),
  event({ id: "ks", type: "shot", playerId: "h9", minute: 10, second: 10, xg: 0.3, outcome: "success" }),
  event({ id: "kg", type: "goal", playerId: "h9", minute: 10, second: 11, outcome: "success", relatedEventId: "ks" }),
  // Pass in first-half stoppage, shot after the whistle: within 15 s but across halftime.
  event({ id: "late-pass", type: "pass", playerId: "h8", minute: 46, second: 55 }),
  event({ id: "ht", type: "halftime", playerId: "h9", minute: 47, second: 0, outcome: "none" }),
  event({ id: "s2", type: "shot", playerId: "h9", minute: 47, second: 5, xg: 0.2, outcome: "success" }),
  event({ id: "g2", type: "goal", playerId: "h9", minute: 47, second: 6, outcome: "success", relatedEventId: "s2" }),
  event({ id: "p3", type: "pass", playerId: "h8", minute: 60, second: 0 }),
  event({ id: "p4", type: "pass", playerId: "h8", minute: 61, second: 0 }),
  event({ id: "p5", type: "pass", playerId: "h8", minute: 62, second: 0, outcome: "incomplete" }),
  event({ id: "t1", type: "tackle", teamId: "away", playerId: "a4", minute: 20, x: 30, outcome: "success" }),
  // Rescinded in the first half by a revision published during the second half.
  event({ id: "ag", type: "goal", teamId: "away", playerId: "a4", minute: 30, outcome: "success" }),
  event({ id: "ag", revision: 2, type: "goal", teamId: "away", playerId: "a4", minute: 30, outcome: "success", rescinded: true }),
]);

test("full match is the default and matches an explicit full scope", () => {
  assert.deepEqual(analysePlayers(match), analysePlayers(match, Number.POSITIVE_INFINITY, "full"));
  assert.deepEqual(analysePlayers(halves, 5400), analysePlayers(halves, 5400, "full"));
});

test("half scopes split additive counts and recompute percentages from scoped counts", () => {
  const pick = (period: "full" | "first" | "second", id: string) => analysePlayers(halves, 5400, period).find((entry) => entry.player.id === id)!;
  const [full, first, second] = (["full", "first", "second"] as const).map((period) => pick(period, "h8"));
  assert.equal(first!.passes + second!.passes, full!.passes);
  assert.equal(first!.passAccuracy, 67);
  assert.equal(second!.passAccuracy, 67);
  assert.equal(full!.passAccuracy, 67);
  assert.equal(pick("first", "h9").goals + pick("second", "h9").goals, pick("full", "h9").goals);
  assert.equal(pick("second", "h9").goals, 1);
  assert.equal(pick("second", "a4").tackles, 0);
  assert.equal(pick("second", "a4").involvementShare, 0);
  assert.equal(pick("second", "h9").touches.every((touch) => touch.minute >= 47), true);
});

test("assists never cross halftime, in a half or in the full match", () => {
  assert.equal(analysePlayers(halves, 5400, "full").find((entry) => entry.player.id === "h8")!.assists, 1, "only the first-half assist counts");
  assert.equal(analysePlayers(halves, 5400, "first").find((entry) => entry.player.id === "h8")!.assists, 1);
  assert.equal(analysePlayers(halves, 5400, "second").find((entry) => entry.player.id === "h8")!.assists, 0);
  const noHalftime = fixture(halves.events.filter((item) => item.id !== "ht"));
  assert.equal(analysePlayers(noHalftime, 5400).find((entry) => entry.player.id === "h8")!.assists, 2, "without halves the 15 s heuristic still applies");
});

test("a first-half goal rescinded during the second half is removed from the first half", () => {
  const before = fixture(halves.events.filter((item) => !(item.id === "ag" && item.revision === 2)));
  assert.equal(analysePlayers(before, 5400, "first").find((entry) => entry.player.id === "a4")!.goals, 1);
  assert.equal(analysePlayers(halves, 5400, "first").find((entry) => entry.player.id === "a4")!.goals, 0);
});

test("player analyst scopes notes to the period, returns as-of identity and refuses unavailable scopes", async () => {
  const inputs: string[] = [];
  const analyst = createPlayerAnalyst({ invoke: async (input) => { inputs.push(input); return { headline: "Ana Ruiz", summary: "Ana Ruiz scored.", strengths: [], concerns: [] }; } });
  const first = await analyst.write(halves, "h9", "en", 5400, "first");
  assert.equal(first.period, "first");
  assert.equal(first.asOfSecond, 5400);
  assert.match(inputs.at(-1)!, /first half only/u);
  const full = await analyst.write(halves, "h9", "en", 5400);
  assert.equal(full.period, "full");
  assert.equal(inputs.length, 2, "cached notes never leak across periods");
  await analyst.write(halves, "h9", "en", 5400, "first");
  assert.equal(inputs.length, 2, "same period reuses the cache");

  const offline = createPlayerAnalyst();
  await assert.rejects(() => offline.write(halves, "h9", "en", 40 * 60, "second"), (error: unknown) => (error as { status?: number }).status === 409 && /not started/u.test((error as Error).message));
  await assert.rejects(() => offline.write(match, "h9", "en", 5400, "first"), /unavailable/u);
});
