import assert from "node:assert/strict";
import test from "node:test";

import {
  changesSince,
  clubPreferenceFor,
  createFanCursor,
  DEFAULT_FAN_PREFS,
  FAN_PREFS_KEY,
  isFanMoment,
  loadFanPrefs,
  newPlayerAlerts,
  parseFanCursor,
  parseFanPrefs,
  playerTimeline,
  prioritiseFanFeed,
  resolveFavoritePlayer,
  resolveFavoriteTeam,
  saveFanPrefs,
  alertKey,
} from "../shared/fan.js";
import type { Storyline } from "../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

function event(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type" | "teamId" | "playerId" | "minute">): MatchEvent {
  return { revision: 1, second: 0, outcome: "success", x: 50, y: 50, ...input };
}

function fixture(events: MatchEvent[] = []): MatchFixture {
  return {
    id: "fx",
    seed: 1,
    title: "Blue v Red",
    description: "",
    home: { id: "home", name: "Blue FC", shortName: "BLU", archiveClubId: "club-blue", players: [
      { id: "h1", name: "Alice", number: 9, position: "FW", teamId: "home", archiveId: "person-alice" },
      { id: "h2", name: "Bea", number: 4, position: "DF", teamId: "home" },
    ] },
    away: { id: "away", name: "Red FC", shortName: "RED", players: [{ id: "a1", name: "Cara", number: 10, position: "FW", teamId: "away" }] },
    events,
    durationSeconds: 5400,
    correctionEventId: "g1",
    correctionAvailableAt: 0,
    periods: { source: "synthetic", halftimeSecond: 45 * 60 },
  };
}

test("fan preferences default to casual, English, neutral, full match and reject malformed values", () => {
  assert.deepEqual(parseFanPrefs(null), DEFAULT_FAN_PREFS);
  assert.deepEqual(parseFanPrefs("{not json"), DEFAULT_FAN_PREFS);
  assert.deepEqual(parseFanPrefs({ version: 2, persona: "analyst" }), DEFAULT_FAN_PREFS, "unknown versions are ignored");
  const parsed = parseFanPrefs(JSON.stringify({
    version: 1,
    persona: "robot",
    language: "de",
    favoriteClubId: "bad club!",
    favoritePlayer: { id: "h1", name: "Alice", archiveId: "person-alice" },
    followPlayer: true,
    period: "third",
  }));
  assert.equal(parsed.persona, "casual");
  assert.equal(parsed.language, "en");
  assert.equal(parsed.favoriteClubId, undefined);
  assert.deepEqual(parsed.favoritePlayer, { id: "h1", name: "Alice", archiveId: "person-alice" });
  assert.equal(parsed.followPlayer, true);
  assert.equal(parsed.period, "full");
  assert.equal(parseFanPrefs({ version: 1, followPlayer: true }).followPlayer, false, "follow mode requires a player");
});

test("fan preferences round-trip through storage and fall back to memory when storage fails", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  const prefs = { ...DEFAULT_FAN_PREFS, persona: "analyst" as const, language: "pt" as const, favoriteClubId: "club-blue", period: "second" as const };
  assert.equal(saveFanPrefs(storage, prefs), true);
  assert.ok(store.has(FAN_PREFS_KEY));
  assert.deepEqual(loadFanPrefs(storage), { prefs, persisted: true });

  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(loadFanPrefs(broken), { prefs: DEFAULT_FAN_PREFS, persisted: false });
  assert.equal(saveFanPrefs(broken, prefs), false);
  assert.equal(saveFanPrefs(undefined, prefs), false);
});

test("favourites resolve by archive identity and never substitute another player", () => {
  const fx = fixture();
  assert.deepEqual(resolveFavoriteTeam(fx, "home"), { teamId: "home", inMatch: true });
  assert.deepEqual(resolveFavoriteTeam(fx, "club-blue"), { teamId: "home", inMatch: true });
  assert.deepEqual(resolveFavoriteTeam(fx, "club-green"), { inMatch: false });
  assert.deepEqual(resolveFavoriteTeam(fx), { inMatch: false });
  assert.equal(clubPreferenceFor(fx, "home"), "club-blue");
  assert.equal(clubPreferenceFor(fx, "away"), "away");

  assert.equal(resolveFavoritePlayer(fx, { id: "old-id", archiveId: "person-alice", name: "Alice" }).player?.id, "h1");
  assert.equal(resolveFavoritePlayer(fx, { id: "a1", name: "Cara" }).player?.id, "a1");
  // Same match-local ID, different archive person: not this player.
  assert.deepEqual(resolveFavoritePlayer(fx, { id: "h1", archiveId: "person-zoe", name: "Zoe" }), { inMatch: false });
  assert.deepEqual(resolveFavoritePlayer(fx, { id: "x9", name: "Nobody" }), { inMatch: false });
});

test("my-match feed keeps favourite moments plus every goal, ruled-out goal and red card for both sides", () => {
  const events = [
    event({ id: "p1", type: "pass", teamId: "home", playerId: "h2", minute: 1 }),
    event({ id: "p2", type: "pass", teamId: "away", playerId: "a1", minute: 2 }),
    event({ id: "s1", type: "shot", teamId: "away", playerId: "a1", minute: 3, outcome: "miss" }),
    event({ id: "g1", type: "goal", teamId: "away", playerId: "a1", minute: 10 }),
    event({ id: "g1", type: "goal", teamId: "away", playerId: "a1", minute: 10, revision: 2, rescinded: true }),
    event({ id: "r1", type: "red_card", teamId: "away", playerId: "a1", minute: 20, outcome: "none" }),
    event({ id: "t1", type: "tackle", teamId: "home", playerId: "h1", minute: 30 }),
    event({ id: "k1", type: "kickoff", teamId: "home", playerId: "h1", minute: 0 }),
  ];
  const club = prioritiseFanFeed(events, { teamId: "home" });
  assert.deepEqual(club.map((item) => item.event.id), ["t1", "r1", "g1"], "newest first; opposing passes and shots dropped");
  assert.equal(club.find((item) => item.event.id === "g1")?.event.revision, 2, "the ruled-out revision is shown");
  assert.deepEqual(club.map((item) => item.relevance), ["club", "essential", "essential"]);

  const player = prioritiseFanFeed(events, { playerId: "h2" });
  assert.deepEqual(player.map((item) => item.event.id), ["r1", "g1", "p1"], "a favourite player's passes are kept");

  const neutral = prioritiseFanFeed(events, {});
  assert.deepEqual(neutral.map((item) => item.event.id), ["r1", "g1", "s1"]);

  const many = Array.from({ length: 30 }, (_, index) => event({ id: `t${index}`, type: "tackle", teamId: "home", playerId: "h1", minute: 40 + index }));
  const limited = prioritiseFanFeed([...events, ...many], { teamId: "home" }, 5);
  assert.equal(limited.length, 5);
  assert.ok(limited.some((item) => item.event.id === "g1") && limited.some((item) => item.event.id === "r1"), "essentials survive the limit");
});

test("player timeline follows logged actions in the selected half only", () => {
  const fx = fixture([
    event({ id: "a", type: "pass", teamId: "home", playerId: "h1", minute: 5 }),
    event({ id: "b", type: "shot", teamId: "home", playerId: "h1", minute: 60 }),
    event({ id: "c", type: "pass", teamId: "home", playerId: "h2", minute: 61 }),
  ]);
  assert.deepEqual(playerTimeline(fx, "h1").map((item) => item.id), ["a", "b"]);
  assert.deepEqual(playerTimeline(fx, "h1", "first").map((item) => item.id), ["a"]);
  assert.deepEqual(playerTimeline(fx, "h1", "second").map((item) => item.id), ["b"]);
  assert.deepEqual(playerTimeline(fx, "h1", "full", 30 * 60).map((item) => item.id), ["a"]);
  assert.deepEqual(playerTimeline(fx, "a1"), []);
});

test("moments filter keeps favourite club or player clips, or everything without a favourite", () => {
  assert.equal(isFanMoment({ teamId: "away", playerId: "a1" }, {}), true);
  assert.equal(isFanMoment({ teamId: "away", playerId: "a1" }, { teamId: "home" }), false);
  assert.equal(isFanMoment({ teamId: "home", playerId: "h2" }, { teamId: "home" }), true);
  assert.equal(isFanMoment({ teamId: "away", playerId: "a1" }, { teamId: "home", playerId: "a1" }), true);
});

test("what changed since last look reports new goals, cards, corrections and approved stories for the same match only", () => {
  const before = [event({ id: "g1", type: "goal", teamId: "home", playerId: "h1", minute: 10 })];
  const story = (status: Storyline["status"], version: number) => ({ id: "s1", status, version, triggerMinute: 10 });
  const cursor = createFanCursor("m1", before, [story("needs_review", 1)], "2025-01-01T00:00:00.000Z");
  assert.deepEqual(cursor.storylines, {}, "unapproved storylines are not part of the cursor");
  assert.deepEqual(parseFanCursor(JSON.stringify(cursor)), cursor);
  assert.equal(parseFanCursor("{}"), null);

  const after = [
    ...before,
    event({ id: "g1", type: "goal", teamId: "home", playerId: "h1", minute: 10, revision: 2, rescinded: true }),
    event({ id: "y1", type: "yellow_card", teamId: "away", playerId: "a1", minute: 30, outcome: "none" }),
    event({ id: "r1", type: "red_card", teamId: "away", playerId: "a1", minute: 40, outcome: "none" }),
    event({ id: "g2", type: "goal", teamId: "away", playerId: "a1", minute: 50 }),
    event({ id: "p9", type: "pass", teamId: "away", playerId: "a1", minute: 51 }),
  ];
  const changes = changesSince(cursor, "m1", after, [story("approved", 2)]);
  assert.deepEqual(changes.map((change) => change.kind), ["ruled_out", "story", "booking", "red_card", "goal"]);
  assert.deepEqual(changesSince(cursor, "m2", after, []), [], "a cursor never applies to another match");
  assert.deepEqual(changesSince(null, "m1", after, []), []);

  const seen = createFanCursor("m1", after, [story("approved", 2)]);
  assert.deepEqual(changesSince(seen, "m1", after, [story("retracted", 3)]).map((change) => change.kind), ["story_retracted"]);
});

test("favourite-player alerts are deduplicated by event and revision", () => {
  const events = [
    event({ id: "s1", type: "shot", teamId: "home", playerId: "h1", minute: 5, outcome: "saved" }),
    event({ id: "p1", type: "pass", teamId: "home", playerId: "h1", minute: 6 }),
    event({ id: "g1", type: "goal", teamId: "away", playerId: "a1", minute: 7 }),
  ];
  const seen = new Set<string>();
  const first = newPlayerAlerts(events, "h1", seen);
  assert.deepEqual(first.map((item) => item.id), ["s1"]);
  for (const item of first) seen.add(alertKey(item));
  assert.deepEqual(newPlayerAlerts(events, "h1", seen), []);
  const corrected = [...events, event({ id: "s1", type: "shot", teamId: "home", playerId: "h1", minute: 5, revision: 2, outcome: "miss" })];
  assert.deepEqual(newPlayerAlerts(corrected, "h1", seen).map(alertKey), ["s1@2"]);
  assert.deepEqual(newPlayerAlerts(events, undefined, seen), []);
});
