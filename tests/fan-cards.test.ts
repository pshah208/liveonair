import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChanceCard,
  chanceHeadline,
  territoryPhrase,
  buildPlayerCard,
  cardPhase,
  cardTitle,
  competitionRanks,
  contrastRatio,
  ordinal,
  phaseChip,
  pickBigMoment,
  playerCardFileName,
  rankAria,
  rankChangeAnnouncement,
  rankText,
  shirtStyle,
  shouldAnnounce,
  topByImpact,
  truncateHeadline,
  QUIET_CARD_MESSAGE,
  type RankedStat,
} from "../shared/fanCards.js";
import { resolveFavoritePlayer } from "../shared/fan.js";
import type { ChanceInsight } from "../shared/chanceSequence.js";
import type { Storyline } from "../shared/platform.js";
import type { MatchEvent, MatchFixture, Player } from "../shared/types.js";

const home: Player[] = [
  { id: "hgk", name: "Gus Keeper", number: 1, position: "GK", teamId: "home" },
  { id: "hcb", name: "Cal Back", number: 4, position: "CB", teamId: "home" },
  { id: "hcm", name: "Max Mid", number: 8, position: "CM", teamId: "home" },
  { id: "hst", name: "Sam Striker", number: 9, position: "ST", teamId: "home" },
];
const away: Player[] = [
  { id: "agk", name: "Ana Keeper", number: 1, position: "GK", teamId: "away" },
  { id: "ast", name: "Ari Striker", number: 9, position: "ST", teamId: "away" },
  { id: "aidle", name: "Ida Idle", number: 12, position: "CM", teamId: "away" },
];

let counter = 0;
function ev(input: Partial<MatchEvent> & Pick<MatchEvent, "type" | "teamId" | "playerId" | "minute">): MatchEvent {
  counter += 1;
  return { id: `e${counter}`, revision: 1, second: 0, outcome: "success", x: 50, y: 34, ...input };
}
function passes(teamId: "home" | "away", playerId: string, complete: number, failed: number, minute = 5): MatchEvent[] {
  return [
    ...Array.from({ length: complete }, () => ev({ type: "pass", teamId, playerId, minute, outcome: "complete", x: 40, y: 30, endX: 55, endY: 32 })),
    ...Array.from({ length: failed }, () => ev({ type: "pass", teamId, playerId, minute, outcome: "incomplete", x: 40, y: 30, endX: 55, endY: 32 })),
  ];
}

function fixture(events: MatchEvent[], extra: Partial<MatchFixture> = {}): MatchFixture {
  return {
    id: "fx",
    seed: 1,
    title: "Blue v Red",
    description: "",
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: home },
    away: { id: "away", name: "Red FC", shortName: "RED", players: away },
    events,
    durationSeconds: 5400,
    correctionEventId: "none",
    correctionAvailableAt: 0,
    periods: { source: "synthetic", halftimeSecond: 45 * 60 },
    ...extra,
  };
}

const row = (model: ReturnType<typeof buildPlayerCard>, key: string) => model?.rows.find((item) => item.key === key);

test("ordinals follow the language with English fallback and handle 11th-13th", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => ordinal(n)), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  assert.equal(ordinal(1, "es"), "1º");
  assert.equal(ordinal(3, "pt"), "3º");
  assert.equal(ordinal(1, "fr"), "1er");
  assert.equal(ordinal(2, "fr"), "2e");
  assert.equal(ordinal(2, "de" as never), "2nd", "unsupported languages fall back to English");
});

test("competition ranking gives 1,2,2,4 and leaves nulls unranked", () => {
  const ranks = competitionRanks([9, 5, 5, 1, null]);
  assert.deepEqual(ranks.map((r) => r.rank), [1, 2, 2, 4, null]);
  assert.deepEqual(ranks.map((r) => r.tied), [false, true, true, false, false]);
  assert.deepEqual(competitionRanks([0, 0]).map((r) => r.rank), [1, 1]);
  assert.equal(rankText({ rank: 2, tied: true }), "T-2nd");
  assert.equal(rankAria({ rank: 2, tied: true }), "joint second");
  assert.equal(rankText({ rank: 13, tied: false }), "13th");
  assert.equal(rankText({ rank: null, tied: false }), "—");
});

test("player card ranks ties jointly, titles from best rank and counts the pool of involved players only", () => {
  const events = [
    ...passes("home", "hcm", 12, 0),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 }),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 20 }),
    ev({ type: "goal", teamId: "away", playerId: "ast", minute: 30 }),
    ev({ type: "goal", teamId: "home", playerId: "hcm", minute: 35 }),
    ev({ type: "tackle", teamId: "home", playerId: "hcb", minute: 40 }),
    ev({ type: "save", teamId: "home", playerId: "hgk", minute: 41, outcome: "saved" }),
    ev({ type: "foul", teamId: "away", playerId: "agk", minute: 42, outcome: "none" }),
  ];
  const fx = fixture(events);
  const striker = buildPlayerCard(fx, "hst", 5400)!;
  assert.equal(striker.poolSize, 6, "Ida Idle has no involvement and is excluded");
  assert.match(striker.subtitle, /among the 6 players in this match/);
  const goals = row(striker, "goals")!;
  assert.deepEqual([goals.rank, goals.of, goals.tied, goals.display], [1, 6, false, "2"]);
  assert.ok(striker.rows.length <= 8);
  assert.equal(striker.rows[0]?.key, "goals", "attackers lead with goals");

  // Max and Ari each have one goal: joint second.
  const mid = buildPlayerCard(fx, "hcm", 5400)!;
  const midGoals = row(mid, "goals")!;
  assert.deepEqual([midGoals.rank, midGoals.tied], [2, true]);
  assert.equal(rankText(midGoals), "T-2nd");
  assert.equal(mid.rows[0]?.key, "passesCompleted", "midfielders' ranked rows follow the midfield order; unexplained all-zero rows go last");
  assert.equal(mid.rows.at(-1)?.note !== undefined, true);
  assert.equal(row(mid, "passesCompleted")?.rank, 1);

  const gk = buildPlayerCard(fx, "hgk", 5400)!;
  assert.equal(gk.rows[0]?.key, "saves");
  assert.equal(row(striker, "saves"), undefined, "saves are for goalkeepers only");
  assert.equal(buildPlayerCard(fx, "nobody", 5400), null);

  assert.ok(["The one and only", "Top of the class"].includes(striker.title));
});

test("card title thresholds", () => {
  const stat = (rank: number | null): RankedStat => ({ key: String(Math.random()), label: "x", value: 1, display: "1", rank, of: 10, tied: false });
  assert.equal(cardTitle([stat(1), stat(1), stat(5)], 10, 5), "The one and only");
  assert.equal(cardTitle([stat(1), stat(4)], 10, 5), "Top of the class");
  assert.equal(cardTitle([stat(3), stat(4)], 10, 5), "Right in the mix");
  assert.equal(cardTitle([stat(5), stat(null)], 5, 5), "Quiet but busy");
  assert.equal(cardTitle([stat(5)], 4, 5), "Their moment is coming");
});

test("all-zero count stats show no rank, value 0 and a 'No one yet' note", () => {
  const fx = fixture([...passes("home", "hcm", 4, 0), ...passes("away", "ast", 3, 0)]);
  const model = buildPlayerCard(fx, "hcm", 5400)!;
  const goals = row(model, "goals")!;
  assert.deepEqual([goals.rank, goals.value, goals.display, goals.note], [null, 0, "0", "No one yet"]);
  assert.equal(model.quiet, true, "fewer than five ranked rows");
  assert.equal(QUIET_CARD_MESSAGE, "A quiet one on the stats sheet. Not much logged yet.");
  assert.ok(model.rows.length <= 8);
});

test("pass accuracy ranks only players with at least 10 passes", () => {
  const fx = fixture([...passes("home", "hcm", 9, 1), ...passes("home", "hcb", 8, 1), ...passes("away", "ast", 5, 0)]);
  const mid = buildPlayerCard(fx, "hcm", 5400)!;
  assert.equal(row(mid, "passAccuracy")?.rank, 1, "the only player over the floor ranks 1st of 1");
  assert.equal(row(mid, "passAccuracy")?.of, 1);
  const back = buildPlayerCard(fx, "hcb", 5400)!;
  const accuracy = row(back, "passAccuracy")!;
  assert.deepEqual([accuracy.rank, accuracy.value, accuracy.display, accuracy.note], [null, null, "—", "Too few passes to rank"]);
});

test("top speed appears only with synthetic tracking and never as zero", () => {
  const events = [...passes("home", "hst", 3, 0), ...passes("home", "hcm", 3, 0)];
  assert.equal(row(buildPlayerCard(fixture(events), "hst", 5400), "topSpeed"), undefined, "no tracking means no row");
  const tracking = {
    source: "synthetic" as const,
    cadenceSeconds: 60,
    samples: [
      { playerId: "hst", second: 300, distanceM: 200, speedKmh: 31.5 },
      { playerId: "hcm", second: 300, distanceM: 180, speedKmh: 28.0 },
    ],
  };
  const model = buildPlayerCard(fixture(events, { tracking }), "hst", 5400)!;
  const speed = row(model, "topSpeed");
  assert.ok(speed, "tracked fixtures include top speed");
  assert.equal(speed?.rank, 1);
  assert.match(speed!.display, /km\/h$/);
});

test("a favourite who is not in the match resolves to nothing; the spotlight is the top-impact player", () => {
  const events = [
    ...passes("home", "hcm", 6, 0),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 }),
  ];
  const fx = fixture(events);
  assert.deepEqual(resolveFavoritePlayer(fx, { id: "zz", name: "Zed" }), { inMatch: false });
  const [spotlight] = topByImpact(fx, 5400, 3);
  assert.equal(spotlight?.player.id, "hst");
  assert.equal(topByImpact(fixture([]), 5400, 3).length, 0, "no pool before anything is logged");
  assert.equal(buildPlayerCard(fx, "aidle", 5400)?.state, "no-data", "a player with no involvements gets the quiet card");
});

test("big moment map: metres inside 105x68 for both sides, none for camera fixtures", () => {
  const homeGoal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10, x: 95, y: 98 });
  const awayGoal = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 20, x: 95, y: 98 });
  const fx = fixture([homeGoal, awayGoal]);
  const home = pickBigMoment(fx, [story("h", { triggerEventIds: [homeGoal.id], headline: "H" })]);
  const away = pickBigMoment(fx, [story("a", { triggerEventIds: [awayGoal.id], headline: "A" })]);
  assert.deepEqual([home.map?.x, home.map?.y], [99.75, 66.64]);
  assert.deepEqual([away.map?.x, away.map?.y], [5.25, 1.36], "away attacks the other way");
  for (const point of [home.map!, away.map!]) assert.ok(point.x >= 0 && point.x <= 105 && point.y >= 0 && point.y <= 68);
  const cam = fixture([homeGoal], { id: "video-clip" });
  const camMoment = pickBigMoment(cam, [story("h", { triggerEventIds: [homeGoal.id], headline: "H" })]);
  assert.equal(camMoment.map, undefined);
  assert.equal(camMoment.cameraView, true);
  assert.equal(home.cameraView, undefined);
});

test("big moment: rescinded and revised events never count towards ranks or the big moment", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 });
  const ruledOut = { ...goal, revision: 2, rescinded: true };
  const fx = fixture([goal, ruledOut, ...passes("home", "hcm", 3, 0)]);
  const model = buildPlayerCard(fx, "hst", 5400);
  assert.equal(model?.state, "no-data", "the only logged action was ruled out");
  const stories = [story("s1", { triggerEventIds: [goal.id], triggerMinute: 10, headline: "Striker scores" }), story("s2", { triggerEventIds: [], triggerMinute: 12, headline: "Late story" })];
  const moment = pickBigMoment(fx, stories);
  assert.equal(moment.storylineId, "s2", "the ruled-out goal's story is skipped");
  const revised = { ...goal, revision: 3, x: 90, y: 20 };
  const fx2 = fixture([goal, ruledOut, revised]);
  const again = pickBigMoment(fx2, [story("s1", { triggerEventIds: [goal.id], triggerMinute: 10, headline: "Striker scores" })]);
  assert.deepEqual([again.kind, again.map?.x, again.map?.y], ["goal", 94.5, 13.6], "the latest revision supplies the map point (metres)");
});

function story(id: string, input: Partial<Omit<Storyline, "headline">> & { headline: string }): Storyline {
  const { headline, ...rest } = input;
  const text = { en: headline, es: "", fr: "", pt: "" };
  return {
    id, matchId: "m1", triggerEventIds: [], triggerMinute: 1, createdAt: "", updatedAt: "", status: "approved", priority: 1,
    headline: text, onAirLine: text, overlay: text, claims: [], trace: [], version: 1, ...rest,
  } as Storyline;
}

test("big moment: goals first, then red cards, then latest; only approved stories; retraction says updated", () => {
  const goal = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 20, endX: 100, endY: 30 });
  const red = ev({ type: "red_card", teamId: "home", playerId: "hcb", minute: 70, outcome: "none" });
  const fx = fixture([goal, red]);
  const stories = [
    story("late", { triggerMinute: 80, headline: "Late chance" }),
    story("red", { triggerMinute: 70, triggerEventIds: [red.id], headline: "Red card" }),
    story("goal", { triggerMinute: 20, triggerEventIds: [goal.id], headline: "Opening goal" }),
    story("draft", { triggerMinute: 85, status: "needs_review" as Storyline["status"], triggerEventIds: [goal.id], headline: "Draft" }),
  ];
  const first = pickBigMoment(fx, stories);
  assert.deepEqual([first.state, first.storylineId, first.kind, first.minute, first.teamId], ["moment", "goal", "goal", 20, "away"]);
  assert.deepEqual(first.map, { x: 52.5, y: 44.88, endX: 0, endY: 47.6 }, "away events are flipped into the shared frame and converted to metres");
  assert.equal(pickBigMoment(fx, stories.filter((item) => item.id !== "goal")).storylineId, "red");
  assert.equal(pickBigMoment(fx, [stories[0]!]).kind, "latest");

  const retracted = stories.filter((item) => item.id === "goal").map((item) => ({ ...item, status: "retracted" as Storyline["status"], version: 2 }));
  assert.equal(pickBigMoment(fx, retracted, "en", "goal").state, "updated");
  assert.equal(pickBigMoment(fx, [], "en").state, "empty");
  assert.equal(pickBigMoment(fx, [story("es", { headline: "Hello" })], "es").headline, "Hello", "falls back to English copy");
});

test("headlines truncate at a word boundary", () => {
  const text = "Striker ".repeat(30).trim();
  const out = truncateHeadline(text, 120);
  assert.ok(out.length <= 121);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.slice(0, -1).endsWith(" "));
  assert.equal(truncateHeadline("Short one"), "Short one");
});

test("shirt colours keep the number legible (>= 4.5:1) or fall back with an outline", () => {
  for (const side of ["home", "away"] as const) {
    const style = shirtStyle(side);
    assert.ok(contrastRatio(style.fill, style.number) >= 4.5 || style.outline);
  }
  assert.equal(shirtStyle("home", "#ffffff").number, "#09090b");
  const mid = shirtStyle("home", "#757575");
  assert.ok(contrastRatio(mid.fill, mid.number) >= 4.5, "white or near-black always reaches 4.5:1, even on the crossover grey");
});

test("phase chip, rank-change announcements and throttle", () => {
  assert.equal(cardPhase(0, false), "pre");
  assert.equal(phaseChip("live", 63 * 60 + 5), "Live 63′");
  assert.equal(phaseChip("final", 5400), "Final");
  assert.equal(phaseChip("pre", 0), null);
  const a: RankedStat = { key: "shots", label: "Shots", value: 2, display: "2", rank: 3, of: 8, tied: false };
  const b: RankedStat = { ...a, value: 4, display: "4", rank: 2, tied: true };
  assert.equal(rankChangeAnnouncement([a], [b]), "Shots: now joint second of 8.");
  assert.equal(rankChangeAnnouncement([a], [a]), null);
  assert.equal(shouldAnnounce(null, 1000), true);
  assert.equal(shouldAnnounce(1000, 5000), false);
  assert.equal(shouldAnnounce(1000, 11_000), true);
});

test("save-as-picture file name is safe and carries player, match and minute", () => {
  assert.equal(playerCardFileName("h1", "match-9", 63.9), "playercard_h1_match-9_63.png");
  assert.equal(playerCardFileName("a/b c", "m:1", -3), "playercard_a-b-c_m-1_0.png");
});

function insight(shotId: string, input: Partial<ChanceInsight> = {}, playerIds = ["hcm", "hst"], originX = 30): ChanceInsight {
  const zero = { finalThirdEntries: 0, completedPassesEndingInFinalThird: 0, attackingActionsInFinalThird: 0, attackingActions: 0, finalThirdShare: null, passesMissingEndX: 0 };
  const delta = { finalThirdEntries: 1, completedPassesEndingInFinalThird: 1, attackingActionsInFinalThird: 3, attackingActions: 3 };
  return {
    insightId: `chance:${shotId}`, revision: 1, matchId: "m1", status: "issued", effectiveSecond: 600, evidenceEventIds: [], metricVersion: "chance-sequence/1",
    coverageNotes: [], summaryFacts: [],
    sequence: {
      shotEventId: shotId, eventIds: [], steps: playerIds.map((playerId, i) => ({ eventId: `s${i}`, playerId, type: i === playerIds.length - 1 ? "shot" : "pass", minute: 10, second: i })),
      origin: { eventId: "o", type: "pass", x: originX, y: 30, zone: "middle" }, actions: playerIds.length, passes: 6, playerIds, progressionM: 40, matchClockSpanSeconds: 20, boundary: "turnover", inferred: true,
    },
    territory: { label: "event-derived territory", windowSeconds: 600, chanceSecond: 600, current: { startSecond: 0, endSecond: 600 }, previous: { startSecond: 0, endSecond: 0 },
      home: { current: zero, previous: zero }, away: { current: zero, previous: zero }, change: { home: delta, away: { ...delta, attackingActionsInFinalThird: -2 } }, coverageNotes: [] },
    ...input,
  } as ChanceInsight;
}

test("chance card: casual copy, chips, event-derived territory", () => {
  const shot = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 10 });
  const card = buildChanceCard(fixture([shot]), [insight(shot.id, {}, ["hcm", "hst", "hcb"])]);
  assert.equal(card.state, "chance");
  assert.equal(card.headline, "6 passes from their own half, 3 players involved");
  assert.deepEqual(card.chips[0], { player: "Max Mid", action: "pass" });
  assert.equal(card.chips[2].action, "shot");
  assert.match(card.territory!, /more attacks in the final third than the previous 10 min/);
  assert.match(territoryPhrase(insight("x").territory, "away")!, /fewer attacks/);
  assert.equal(territoryPhrase(null, "home"), null);
  assert.match(chanceHeadline(insight("x", {}, ["hcm"]).sequence!), /1 player involved/);
});

test("chance card: goals and favourites first, withdrawn removed with a note, revised flagged", () => {
  const shot = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 10 });
  const goal = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 5 });
  const fx = fixture([shot, goal]);
  const list = [insight(shot.id, { effectiveSecond: 700 }), insight(goal.id, { effectiveSecond: 300, status: "revised", revision: 2 }, ["ast"])];
  const byGoal = buildChanceCard(fx, list);
  assert.equal(byGoal.isGoal, true);
  assert.equal(byGoal.revised, true);
  assert.equal(byGoal.teamId, "away");
  assert.equal(buildChanceCard(fx, list, { teamId: "home" }).insight!.insightId, `chance:${shot.id}`);
  assert.equal(buildChanceCard(fx, list, { playerId: "ast", teamId: "home" }).insight!.insightId, `chance:${goal.id}`);
  const withdrawn = [insight(shot.id, { status: "withdrawn", withdrawalReason: "correction" })];
  const gone = buildChanceCard(fx, withdrawn);
  assert.equal(gone.state, "empty");
  assert.equal(gone.withdrawnNote, true);
  assert.equal(buildChanceCard(fx, list, {}, "other-match").state, "empty");
  assert.equal(buildChanceCard(fx, []).withdrawnNote, false);
});
