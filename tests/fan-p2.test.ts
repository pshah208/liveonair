import assert from "node:assert/strict";
import test from "node:test";

import {
  alertPrefsOf,
  buildCatchUp,
  DEFAULT_FAN_ALERT_PREFS,
  fanAlertCandidates,
  fanMoments,
  momentCreditLine,
  parseFanPrefs,
  reconcileFanAlerts,
  type FanAlert,
  type FanAlertPrefs,
} from "../shared/fan.js";
import { momentMapPoint } from "../shared/fanCards.js";
import { buildHighlightReel } from "../shared/highlights.js";
import { buildAllPressPosts, BIG_CHANCE_XG, BIG_SAVE_XG } from "../shared/pressBox.js";
import type { Storyline } from "../shared/platform.js";
import type { MatchEvent, MatchFixture, Player } from "../shared/types.js";
import { HIGH_XG_SHOT_THRESHOLD } from "../shared/xg.js";
import { CREDITED_AGENT_ROLES, fanMomentCredits } from "../server/routes/fanMoments.js";

const home: Player[] = [
  { id: "hgk", name: "Gus Keeper", number: 1, position: "GK", teamId: "home" },
  { id: "hst", name: "Sam Striker", number: 9, position: "ST", teamId: "home" },
  { id: "hcb", name: "Cal Back", number: 4, position: "CB", teamId: "home" },
];
const away: Player[] = [
  { id: "agk", name: "Ana Keeper", number: 1, position: "GK", teamId: "away" },
  { id: "ast", name: "Ari Striker", number: 9, position: "ST", teamId: "away" },
];

let counter = 0;
function ev(input: Partial<MatchEvent> & Pick<MatchEvent, "type" | "teamId" | "playerId" | "minute">): MatchEvent {
  counter += 1;
  return { id: `p2e${counter}`, revision: 1, second: 0, outcome: "success", x: 50, y: 34, ...input };
}

function fixture(events: MatchEvent[], extra: Partial<MatchFixture> = {}): MatchFixture {
  return {
    id: "fx", seed: 1, title: "Blue v Red", description: "",
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: home },
    away: { id: "away", name: "Red FC", shortName: "RED", players: away },
    events, durationSeconds: 5400, correctionEventId: "none", correctionAvailableAt: 0,
    periods: { source: "synthetic", halftimeSecond: 45 * 60 },
    ...extra,
  };
}

function story(id: string, input: Partial<Omit<Storyline, "headline">> & { headline: string; line?: string }): Storyline {
  const { headline, line, ...rest } = input;
  const text = { en: headline, es: "", fr: "", pt: "" };
  return {
    id, matchId: "m1", triggerEventIds: [], triggerMinute: 1, createdAt: "", updatedAt: "", status: "approved", priority: 1,
    approvedAt: "2025-01-01T00:00:00Z",
    headline: text, onAirLine: { en: line ?? `${headline} matters`, es: "", fr: "", pt: "" }, overlay: text, claims: [], trace: [], version: 1, ...rest,
  } as Storyline;
}

const playersMap = new Map([...home, ...away].map((player) => [player.id, player]));
const teamNames = { home: "Blue FC", away: "Red FC" };

// ---------------------------------------------------------------- moment cards

test("fanMoments: only producer-approved copy; drafts never appear; withdrawn moments stay visible as corrected", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 12 });
  const stories = [
    story("ok", { triggerMinute: 12, triggerEventIds: [goal.id], headline: "Striker opens", priority: 5,
      claims: [
        { id: "c1", text: { en: "First goal of the season", es: "", fr: "", pt: "" }, status: "verified", sources: [{ type: "event", id: goal.id }] },
        { id: "c2", text: { en: "Unchecked rumour", es: "", fr: "", pt: "" }, status: "unsupported", sources: [] },
      ] as Storyline["claims"] }),
    story("draft", { triggerMinute: 13, status: "needs_review" as Storyline["status"], headline: "Draft copy", approvedAt: undefined }),
    story("rejected", { triggerMinute: 14, status: "rejected" as Storyline["status"], headline: "Rejected copy", approvedAt: undefined }),
    story("never-approved-retract", { triggerMinute: 15, status: "retracted" as Storyline["status"], headline: "Never on air", approvedAt: undefined }),
    story("pulled", { triggerMinute: 20, status: "retracted" as Storyline["status"], headline: "Hat-trick hero", retractionReason: "Goal ruled out for offside." }),
    story("insight", { triggerMinute: 25, headline: "Big chance", insightStatus: "withdrawn", insightNote: "Chance insight withdrawn." }),
  ];
  const moments = fanMoments(stories, [goal], "en");
  assert.deepEqual(moments.map((moment) => moment.id), ["insight", "pulled", "ok"], "newest first, no drafts or never-approved copy");
  const ok = moments.find((moment) => moment.id === "ok")!;
  assert.equal(ok.status, "approved");
  assert.equal(ok.whyItMatters, "Striker opens matters");
  assert.deepEqual(ok.evidence.map((item) => item.text), ["First goal of the season"], "only verified claims are evidence");
  assert.equal(ok.playerId, "hst");
  const pulled = moments.find((moment) => moment.id === "pulled")!;
  assert.equal(pulled.status, "corrected");
  assert.equal(pulled.correction, "Goal ruled out for offside.");
  assert.equal(moments.find((moment) => moment.id === "insight")!.status, "corrected");
});

test("fanMoments: nothing after the clock, and missing translations fall back to English with a flag", () => {
  const late = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 70 });
  const stories = [story("early", { triggerMinute: 10, headline: "Early" }), story("late", { triggerMinute: 70, triggerEventIds: [late.id], headline: "Late" })];
  assert.deepEqual(fanMoments(stories, [late], "en", 30 * 60).map((moment) => moment.id), ["early"]);
  const es = fanMoments(stories, [late], "es");
  assert.equal(es[0]!.headline, "Late");
  assert.equal(es[0]!.fallback, true);
});

test("moment credits: drafts never leak and no trace detail is exposed", () => {
  const trace = [
    { role: "researcher", status: "complete", detail: "SECRET research notes", durationMs: 3 },
    { role: "producer", status: "complete", detail: "Drafted storyline copy", durationMs: 4 },
    { role: "fact-checker", status: "complete", detail: "checked", durationMs: 2 },
    { role: "localizer", status: "rejected", detail: "failed", durationMs: 1 },
    { role: "internal-tool", status: "complete", detail: "x", durationMs: 1 },
  ] as Storyline["trace"];
  const credits = fanMomentCredits([
    story("ok", { headline: "Approved", trace }),
    story("draft", { headline: "Draft", status: "needs_review" as Storyline["status"], approvedAt: undefined, trace }),
    story("pulled", { headline: "Pulled", status: "retracted" as Storyline["status"], trace }),
  ]);
  assert.deepEqual(credits.map((credit) => credit.id), ["ok", "pulled"]);
  assert.deepEqual(credits[0], { id: "ok", version: 1, status: "approved", agents: ["researcher", "producer", "fact-checker"], author: "producer" });
  assert.equal(credits[1]!.status, "retracted");
  const json = JSON.stringify(credits);
  assert.ok(!json.includes("SECRET") && !json.includes("Draft") && !json.includes("internal-tool"), "no trace text, drafts or unknown roles");
  assert.ok(credits[0]!.agents.every((role) => (CREDITED_AGENT_ROLES as readonly string[]).includes(role)));
  assert.equal(momentCreditLine(credits[0]), "Written by the Producer agent · checked by the Fact-checker · approved by the human producer");
  assert.equal(momentCreditLine(undefined), "Written by the desk agents · approved by the human producer");
});

test("momentMapPoint uses the canonical 105x68 frame and returns null for camera fixtures", () => {
  const shot = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 5, x: 100, y: 50 });
  const point = momentMapPoint(fixture([shot]), shot)!;
  assert.equal(point.x, 105);
  assert.equal(point.y, 34);
});

// ---------------------------------------------------------------- catch-up

test("buildCatchUp: three lines, at most three moments, chronological, and nothing after the current minute", () => {
  const g1 = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 8 });
  const chance = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 15, outcome: "saved", xg: 0.45 });
  const small = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 16, outcome: "miss", xg: HIGH_XG_SHOT_THRESHOLD - 0.01 });
  const booking = ev({ type: "yellow_card", teamId: "home", playerId: "hcb", minute: 20, outcome: "none" });
  const red = ev({ type: "red_card", teamId: "away", playerId: "agk", minute: 25, outcome: "none" });
  const futureGoal = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 31 });
  const sameMinuteLater = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 30, second: 40 });
  const fx = fixture([g1, chance, small, booking, red, futureGoal, sameMinuteLater]);
  const stories = [
    story("s1", { triggerMinute: 8, triggerEventIds: [g1.id], headline: "Striker opens the scoring", priority: 5 }),
    story("future", { triggerMinute: 31, triggerEventIds: [futureGoal.id], headline: "FUTURE equaliser", priority: 9 }),
    story("draft", { triggerMinute: 10, status: "needs_review" as Storyline["status"], approvedAt: undefined, headline: "DRAFT copy", priority: 9 }),
    story("pulled", { triggerMinute: 18, status: "retracted" as Storyline["status"], headline: "PULLED story", retractionReason: "wrong" }),
  ];
  const currentSecond = 30 * 60 + 20; // 30:20 — the 30:40 goal has not happened yet
  const result = buildCatchUp({ fixture: fx, storylines: stories, currentSecond });
  assert.equal(result.minute, 30);
  assert.equal(result.lines.length, 3);
  assert.match(result.lines[0], /Blue FC 1–0 Red FC after 30'\. Goals: Sam Striker 8'\./u);
  assert.match(result.lines[1], /1 high illustrative xG shot without a goal · 1 booking · red card for Ana Keeper 25'/u);
  assert.match(result.lines[2], /Producer-approved: Striker opens the scoring\. 1 moment was corrected\./u);
  assert.ok(result.moments.length <= 3);
  assert.deepEqual(result.moments.map((moment) => moment.key), ["story:s1", `event:${chance.id}`, `event:${red.id}`]);
  assert.deepEqual(result.moments.map((moment) => moment.minute), [8, 15, 25], "chronological");
  assert.equal(result.moments[0]!.source, "approved");
  const everything = JSON.stringify(result);
  assert.ok(!everything.includes("FUTURE") && !everything.includes("DRAFT") && !everything.includes("PULLED"), "no future, draft or corrected copy as a moment");
  for (const moment of result.moments) assert.ok(moment.second <= currentSecond && moment.minute <= result.minute);
});

test("buildCatchUp: never beyond the current minute at any point of the match", () => {
  const events = Array.from({ length: 30 }, (_, index) => ev({ type: index % 3 === 0 ? "goal" : "shot", teamId: index % 2 ? "home" : "away", playerId: index % 2 ? "hst" : "ast", minute: index * 3, second: 30, outcome: "saved", xg: 0.5 }));
  const stories = events.filter((event) => event.type === "goal").map((event) => story(`s-${event.id}`, { triggerMinute: event.minute, triggerEventIds: [event.id], headline: `Story ${event.minute}` }));
  const fx = fixture(events);
  for (let second = 0; second <= 90 * 60; second += 47) {
    const result = buildCatchUp({ fixture: fx, storylines: stories, currentSecond: second });
    assert.equal(result.minute, Math.floor(second / 60));
    for (const moment of result.moments) assert.ok(moment.second <= second, `moment at ${moment.second}s leaked into catch-up at ${second}s`);
    const goals = events.filter((event) => event.type === "goal" && event.minute * 60 + 30 <= second).length;
    const [, homeGoals, awayGoals] = /(\d+)–(\d+)/u.exec(result.lines[0])!;
    assert.equal(Number(homeGoals) + Number(awayGoals), goals);
  }
});

test("buildCatchUp: an empty match gives a calm three-line recap", () => {
  const result = buildCatchUp({ fixture: fixture([]), storylines: [], currentSecond: 0 });
  assert.deepEqual(result.lines, ["Blue FC 0–0 Red FC after 0'. No goals yet.", "0 high illustrative xG shots without a goal · 0 bookings · no red cards.", "No producer-approved moments yet."]);
  assert.deepEqual(result.moments, []);
});

// ---------------------------------------------------------------- alerts

const allOn: FanAlertPrefs = { ...DEFAULT_FAN_ALERT_PREFS };

test("fanAlertCandidates: goals, cards, high illustrative xG shots and approved moments, filtered by preferences", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 5 });
  const high = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 6, outcome: "saved", xg: HIGH_XG_SHOT_THRESHOLD });
  const low = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 7, outcome: "saved", xg: HIGH_XG_SHOT_THRESHOLD - 0.01 });
  const card = ev({ type: "yellow_card", teamId: "home", playerId: "hcb", minute: 8, outcome: "none" });
  const pass = ev({ type: "pass", teamId: "home", playerId: "hcb", minute: 9, outcome: "complete" });
  const later = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 50 });
  const stories = [story("s", { triggerMinute: 5, triggerEventIds: [goal.id], headline: "Opener" }), story("d", { triggerMinute: 6, status: "needs_review" as Storyline["status"], approvedAt: undefined, headline: "Draft" })];
  const base = { events: [goal, high, low, card, pass, later], storylines: stories, players: playersMap, teamNames, uptoSecond: 10 * 60 };
  const all = fanAlertCandidates({ ...base, prefs: allOn });
  assert.deepEqual(all.map((alert) => alert.key), [`event:${goal.id}`, "story:s", `event:${high.id}`, `event:${card.id}`]);
  assert.equal(all.find((alert) => alert.key === `event:${high.id}`)!.title, "High illustrative xG shot");

  const onlyGoals = fanAlertCandidates({ ...base, prefs: { ...allOn, chances: false, cards: false, stories: false } });
  assert.deepEqual(onlyGoals.map((alert) => alert.kind), ["goal"]);

  const fav = fanAlertCandidates({ ...base, favoritePlayerId: "hcb", prefs: { ...allOn, goals: false, chances: false, cards: false, stories: false } });
  assert.ok(fav.every((alert) => alert.yourPlayer && alert.playerId === "hcb"), "favourite-only alerts are the player's own actions");
  assert.ok(fav.length >= 1);
});

test("reconcileFanAlerts: priming is silent, alerts are deduplicated and dismissed alerts stay dismissed", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 5 });
  const next = ev({ type: "goal", teamId: "away", playerId: "ast", minute: 9 });
  const input = { storylines: [], players: playersMap, teamNames, prefs: allOn };
  const primed = reconcileFanAlerts([], fanAlertCandidates({ ...input, events: [goal] }), {}, { prime: true });
  assert.deepEqual(primed.alerts, []);
  assert.equal(primed.announcement, undefined);

  const fresh = reconcileFanAlerts(primed.alerts, fanAlertCandidates({ ...input, events: [goal, next] }), primed.seen);
  assert.deepEqual(fresh.alerts.map((alert) => alert.key), [`event:${next.id}`]);
  assert.match(fresh.announcement ?? "", /^Goal 9'/u);

  // The same candidates again (e.g. a re-render or an unrelated revision) never duplicate the alert.
  const revised = { ...next, revision: 2, x: 60 };
  const again = reconcileFanAlerts(fresh.alerts, fanAlertCandidates({ ...input, events: [goal, next, revised] }), fresh.seen);
  assert.equal(again.alerts.length, 1);
  assert.equal(again.announcement, undefined);

  // Dismissed: removed by the page, and it does not come back.
  const dismissed = reconcileFanAlerts([], fanAlertCandidates({ ...input, events: [goal, next] }), again.seen);
  assert.deepEqual(dismissed.alerts, []);
});

test("reconcileFanAlerts: a withdrawn moment is visibly corrected in place, even after dismissal", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 5 });
  const stories = [story("s", { triggerMinute: 5, triggerEventIds: [goal.id], headline: "Opener" })];
  const input = { players: playersMap, teamNames, prefs: allOn };
  const primed = reconcileFanAlerts([], fanAlertCandidates({ ...input, events: [], storylines: [] }), {}, { prime: true });
  const shown = reconcileFanAlerts(primed.alerts, fanAlertCandidates({ ...input, events: [goal], storylines: stories }), primed.seen);
  assert.deepEqual(shown.alerts.map((alert) => alert.key).sort(), [`event:${goal.id}`, "story:s"]);

  const ruledOut = { ...goal, revision: 2, rescinded: true };
  const pulled = [{ ...stories[0]!, status: "retracted" as Storyline["status"], version: 2, retractionReason: "Offside on review." }];
  const corrected = reconcileFanAlerts(shown.alerts, fanAlertCandidates({ ...input, events: [goal, ruledOut], storylines: pulled }), shown.seen);
  assert.equal(corrected.alerts.length, 2, "corrections replace alerts in place, no duplicates");
  assert.ok(corrected.alerts.every((alert) => alert.corrected));
  assert.equal(corrected.alerts.find((alert) => alert.key === "story:s")!.correction, "Offside on review.");
  assert.match(corrected.announcement ?? "", /^Correction 5'/u);

  // Dismissed before the correction: the correction still appears once, so the fan is not left misinformed.
  const afterDismiss = reconcileFanAlerts([], fanAlertCandidates({ ...input, events: [goal, ruledOut], storylines: pulled }), shown.seen);
  assert.equal(afterDismiss.alerts.length, 2);
  assert.ok(afterDismiss.alerts.every((alert) => alert.corrected));
  const settled = reconcileFanAlerts([], fanAlertCandidates({ ...input, events: [goal, ruledOut], storylines: pulled }), afterDismiss.seen);
  assert.deepEqual(settled.alerts, [], "a dismissed correction stays dismissed");
});

test("reconcileFanAlerts: choosing a favourite refreshes visible alerts in place without re-announcing", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 5 });
  const input = { storylines: [], players: playersMap, teamNames, prefs: allOn, events: [goal] };
  const primed = reconcileFanAlerts([], fanAlertCandidates({ ...input, events: [] }), {}, { prime: true });
  const shown = reconcileFanAlerts(primed.alerts, fanAlertCandidates(input), primed.seen);
  assert.equal(shown.alerts[0]!.yourPlayer, false);
  const refreshed = reconcileFanAlerts(shown.alerts, fanAlertCandidates({ ...input, favoritePlayerId: "hst" }), shown.seen, { prime: true });
  assert.equal(refreshed.alerts.length, 1, "no duplicate");
  assert.equal(refreshed.alerts[0]!.yourPlayer, true);
  assert.equal(refreshed.announcement, undefined);
});

test("reconcileFanAlerts: a moment that is already corrected when first seen raises no alert; the list is capped", () => {
  const ruled = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 5, rescinded: true });
  const result = reconcileFanAlerts([], fanAlertCandidates({ events: [ruled], storylines: [], players: playersMap, teamNames, prefs: allOn }), {});
  assert.deepEqual(result.alerts, []);
  const many: FanAlert[] = Array.from({ length: 8 }, (_, index) => ({ key: `k${index}`, signature: "ok", kind: "goal", minute: index, second: index * 60, title: "Goal", detail: "", corrected: false, yourPlayer: false }));
  assert.equal(reconcileFanAlerts([], many, {}, { limit: 5 }).alerts.length, 5);
});

test("fan alert preferences are optional, validated and default to on", () => {
  assert.deepEqual(alertPrefsOf({}), DEFAULT_FAN_ALERT_PREFS);
  const parsed = parseFanPrefs({ version: 1, language: "en", period: "full", alerts: { player: true, goals: false, chances: true, cards: false, stories: true } });
  assert.deepEqual(parsed.alerts, { player: true, goals: false, chances: true, cards: false, stories: true });
  const bad = parseFanPrefs({ version: 1, language: "en", period: "full", alerts: { goals: "yes" } });
  assert.deepEqual(alertPrefsOf(bad), DEFAULT_FAN_ALERT_PREFS);
});

// ---------------------------------------------------------------- threshold cleanup

test("high illustrative xG shot threshold is shared: 0.29 is not a clip, 0.30 is", () => {
  assert.equal(HIGH_XG_SHOT_THRESHOLD, 0.3);
  assert.equal(BIG_CHANCE_XG, HIGH_XG_SHOT_THRESHOLD);
  assert.equal(BIG_SAVE_XG, HIGH_XG_SHOT_THRESHOLD);
  const below = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 10, outcome: "miss", xg: 0.29 });
  const at = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 20, outcome: "miss", xg: 0.3 });
  const reel = buildHighlightReel(fixture([below, at]));
  const chances = reel.clips.filter((clip) => clip.kind === "big_chance");
  assert.deepEqual(chances.map((clip) => clip.keyEventId), [at.id]);
  assert.match(chances[0]!.title, /High illustrative xG shot/u);
});

test("press box wording: 'High illustrative xG shot missed', and only from the shared threshold", () => {
  const below = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 10, outcome: "miss", xg: 0.29 });
  const at = ev({ type: "shot", teamId: "home", playerId: "hst", minute: 20, outcome: "miss", xg: 0.4 });
  const texts = (events: MatchEvent[]) => buildAllPressPosts(fixture(events), 5400).map((post) => post.text);
  assert.ok(!texts([below]).some((text) => /illustrative xG/u.test(text) && /0\.29/u.test(text)), "below the threshold is not a big-chance post");
  assert.ok(texts([at]).some((text) => /0\.40 illustrative xG|illustrative xG, 20'/u.test(text)));
  assert.ok(texts([at]).every((text) => !/Big chance gone/u.test(text)));
});
