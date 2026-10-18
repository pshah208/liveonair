import assert from "node:assert/strict";
import test from "node:test";

import { buildPressPosts, compactCount, MAX_PRESS_POSTS, PRESS_PERSONAS, relativeTime, type PressPost } from "../shared/pressBox.js";
import type { MatchEvent, MatchFixture, Player } from "../shared/types.js";

const home: Player[] = [
  { id: "hgk", name: "Gus Keeper", number: 1, position: "GK", teamId: "home" },
  { id: "hcb", name: "Cal Back", number: 4, position: "CB", teamId: "home" },
  { id: "hst", name: "Sam Striker", number: 9, position: "ST", teamId: "home" },
];
const away: Player[] = [
  { id: "agk", name: "Ana Keeper", number: 1, position: "GK", teamId: "away" },
  { id: "ast", name: "Ari Striker", number: 9, position: "ST", teamId: "away" },
];

let counter = 0;
function ev(input: Partial<MatchEvent> & Pick<MatchEvent, "type" | "teamId" | "playerId" | "minute">): MatchEvent {
  counter += 1;
  return { id: `p${counter}`, revision: 1, second: 0, outcome: "success", x: 50, y: 34, ...input };
}
function fixture(events: MatchEvent[], extra: Partial<MatchFixture> = {}): MatchFixture {
  return {
    id: "fx", seed: 7, title: "Blue v Red", description: "",
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: home },
    away: { id: "away", name: "Red FC", shortName: "RED", players: away },
    events, durationSeconds: 5400, correctionEventId: "none", correctionAvailableAt: 0,
    periods: { source: "synthetic", halftimeSecond: 45 * 60 },
    ...extra,
  };
}
const END = 5400;
const kinds = (posts: PressPost[]) => posts.map((p) => p.kind);

const BANNED = [/injur/i, /\bbet(s|ting)?\b/i, /\bodds\b/i, /\bVAR\b/, /offside/i, /handball/i, /tweet/i, /twitter/i, /sitter/i, /should have scored/i, /https?:/i, /\blate\b/i];

test("posts are deterministic for the same input", () => {
  const f = fixture([ev({ type: "kickoff", teamId: "home", playerId: "hcb", minute: 0 }), ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 })]);
  assert.deepEqual(buildPressPosts(f, END), buildPressPosts(f, END));
});

test("seed changes variants or counts but not the facts", () => {
  const events = [ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 })];
  const a = buildPressPosts(fixture(events, { seed: 1 }), END)[0]!;
  const b = buildPressPosts(fixture(events, { seed: 2 }), END)[0]!;
  assert.equal(a.kind, "goal");
  assert.ok(a.text.includes("Sam Striker") && b.text.includes("Sam Striker"));
});

test("never posts for pass, tackle, pressure, foul or corner", () => {
  const events = (["pass", "tackle", "pressure", "foul", "corner"] as const).map((type, i) => ev({ type, teamId: "home", playerId: "hcb", minute: 10 + i }));
  assert.deepEqual(buildPressPosts(fixture(events), END), []);
});

test("a goal post appears after a goal and names the player, team and score", () => {
  const posts = buildPressPosts(fixture([ev({ type: "goal", teamId: "home", playerId: "hst", minute: 12 })]), END);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.kind, "goal");
  assert.match(posts[0]!.text, /Sam Striker/);
  assert.match(posts[0]!.text, /Blue FC 1-0 Red FC/);
});

test("nothing appears after uptoSecond", () => {
  const f = fixture([ev({ type: "goal", teamId: "home", playerId: "hst", minute: 12 })]);
  assert.deepEqual(buildPressPosts(f, 12 * 60 - 1), []);
  assert.equal(buildPressPosts(f, 12 * 60).length, 1);
});

test("future goals cannot change an earlier score or trigger a double", () => {
  const f = fixture([
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 }),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 13 }),
    ev({ type: "halftime", teamId: "home", playerId: "hcb", minute: 45 }),
    ev({ type: "fulltime", teamId: "home", playerId: "hcb", minute: 90 }),
  ]);
  const early = buildPressPosts(f, 11 * 60);
  assert.equal(early.length, 1);
  assert.match(early[0]!.text, /Blue FC 1-0 Red FC/);
  assert.ok(!kinds(early).includes("double"));
  assert.ok(!kinds(buildPressPosts(f, 44 * 60)).includes("halftime"));
  assert.ok(!kinds(buildPressPosts(f, 89 * 60)).includes("fulltime"));
});

test("future saves, reds and substitutions do not rewrite visible posts", () => {
  const shot = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 20, outcome: "saved", xg: 0.4 });
  const save = ev({ type: "save", teamId: "home", playerId: "hgk", minute: 20, second: 5, relatedEventId: shot.id });
  const yellow = ev({ type: "yellow_card", teamId: "away", playerId: "ast", minute: 80 });
  const red = ev({ type: "red_card", teamId: "away", playerId: "ast", minute: 80, second: 30 });
  const sub1 = ev({ type: "substitution", teamId: "home", playerId: "hcb", minute: 65 });
  const sub2 = ev({ type: "substitution", teamId: "home", playerId: "hst", minute: 65, second: 30 });
  const f = fixture([shot, save, yellow, red, sub1, sub2]);
  assert.ok(kinds(buildPressPosts(f, 20 * 60)).includes("big_chance"));
  assert.ok(!kinds(buildPressPosts(f, 20 * 60)).includes("save"));
  assert.ok(kinds(buildPressPosts(f, 80 * 60)).includes("yellow_card"));
  assert.match(buildPressPosts(f, 65 * 60).find((p) => p.kind === "substitution")!.text, /make a change|Substitution/);
});

test("known goal revision cannot be exposed before its publication clock", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 30 });
  const f = fixture([goal, { ...goal, revision: 2, rescinded: true },
    ev({ type: "halftime", teamId: "home", playerId: "hcb", minute: 45 })],
    { correctionEventId: goal.id, correctionAvailableAt: 31 * 60 });
  const early = buildPressPosts(f, 30 * 60 + 59);
  assert.equal(early.length, 1);
  assert.equal(early[0]!.ruledOut, undefined);
  assert.match(early[0]!.text, /1-0/);
  const late = buildPressPosts(f, 46 * 60);
  assert.equal(late.find((p) => p.kind === "goal")?.ruledOut, true);
  assert.match(late.find((p) => p.kind === "halftime")!.text, /0-0/);
});

test("caps at 12 posts, newest first", () => {
  const events = Array.from({ length: 20 }, (_, i) => ev({ type: "goal", teamId: i % 2 ? "home" : "away", playerId: i % 2 ? "hst" : "ast", minute: i * 4 }));
  const posts = buildPressPosts(fixture(events), END);
  assert.equal(posts.length, MAX_PRESS_POSTS);
  for (let i = 1; i < posts.length; i += 1) assert.ok(posts[i - 1]!.second >= posts[i]!.second);
  assert.equal(posts[0]!.second, 19 * 4 * 60 > END ? 0 : 19 * 4 * 60);
});

test("all texts are 200 characters or fewer and free of banned terms", () => {
  const long: Player = { id: "lng", name: "A".repeat(80), number: 10, position: "ST", teamId: "home" };
  const events = [
    ev({ type: "kickoff", teamId: "home", playerId: "hcb", minute: 0 }),
    ev({ type: "goal", teamId: "home", playerId: "lng", minute: 10 }),
    ev({ type: "shot", teamId: "away", playerId: "ast", minute: 20, outcome: "miss", xg: 0.6 }),
    ev({ type: "yellow_card", teamId: "home", playerId: "hcb", minute: 85 }),
    ev({ type: "red_card", teamId: "home", playerId: "hcb", minute: 88 }),
    ev({ type: "substitution", teamId: "away", playerId: "ast", minute: 70 }),
    ev({ type: "halftime", teamId: "home", playerId: "hcb", minute: 45 }),
    ev({ type: "fulltime", teamId: "home", playerId: "hcb", minute: 90 }),
  ];
  const f = fixture(events);
  f.home.players = [...home, long];
  const posts = buildPressPosts(f, END);
  assert.ok(posts.length >= 6);
  for (const post of posts) {
    assert.ok(post.text.length <= 200, post.text);
    for (const re of BANNED) assert.doesNotMatch(post.text, re, post.text);
    assert.doesNotMatch(post.persona.name + post.persona.handle + post.persona.outlet, /twitter|tweet/i);
  }
});

test("personas are fictional, with handles and initials", () => {
  for (const persona of Object.values(PRESS_PERSONAS)) {
    assert.match(persona.handle, /^@\w+$/);
    assert.ok(persona.initials.length === 2);
  }
});

test("a rescinded goal keeps its post (flagged) and adds a quoted correction from the same persona", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 30 });
  const ruled: MatchEvent = { ...goal, revision: 2, rescinded: true };
  const f = fixture([goal, ruled], { correctionEventId: goal.id, correctionAvailableAt: 31 * 60 });
  const before = buildPressPosts(f, 30 * 60 + 10);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.ruledOut, undefined);
  const posts = buildPressPosts(f, 32 * 60);
  const original = posts.find((p) => p.kind === "goal")!;
  const correction = posts.find((p) => p.kind === "correction")!;
  assert.equal(original.ruledOut, true);
  assert.equal(correction.personaId, original.personaId);
  assert.equal(correction.quoted?.text, original.text);
  assert.equal(correction.quoted?.personaHandle, original.persona.handle);
  assert.match(correction.text, /ruled out|disallowed/);
  assert.match(correction.text, /Blue FC 0-0 Red FC/);
  assert.equal(posts[0]!.kind, "correction");
});

test("a ruled-out goal without a known correction time gets no guessed correction or goal post", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 30 });
  const f = fixture([goal, { ...goal, revision: 2, rescinded: true }]);
  for (const upto of [30 * 60 + 10, 31 * 60 + 30, 90 * 60]) {
    const posts = buildPressPosts(f, upto);
    assert.equal(posts.some((p) => p.kind === "correction" || p.kind === "goal"), false);
  }
});

test("an own goal is worded as one", () => {
  const og = ev({ type: "goal", teamId: "away", playerId: "hcb", minute: 40 });
  const [post] = buildPressPosts(fixture([og]), END);
  assert.match(post!.text, /wrong net/);
  assert.match(post!.text, /Blue FC 0-1 Red FC/);
});

test("game-state wording for equaliser, turnaround and cushion", () => {
  const events = [
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 }),
    ev({ type: "goal", teamId: "away", playerId: "ast", minute: 30 }),
    ev({ type: "goal", teamId: "away", playerId: "ast", minute: 50 }),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 60 }),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 70 }),
    ev({ type: "goal", teamId: "home", playerId: "hst", minute: 80 }),
  ];
  const goals = buildPressPosts(fixture(events), END).filter((p) => p.kind === "goal").reverse();
  assert.match(goals[1]!.text, /equalis|levels/);
  assert.match(goals[2]!.text, /turned it around|turnaround/);
  assert.match(goals[3]!.text, /equalis|levels/);
  assert.match(goals[4]!.text, /turned it around|turnaround/);
  assert.match(goals[5]!.text, /two-goal cushion/);
});

test("a quick double adds a pattern post only within five minutes", () => {
  const close = fixture([ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 }), ev({ type: "goal", teamId: "home", playerId: "hst", minute: 13 })]);
  assert.ok(kinds(buildPressPosts(close, END)).includes("double"));
  const far = fixture([ev({ type: "goal", teamId: "home", playerId: "hst", minute: 10 }), ev({ type: "goal", teamId: "home", playerId: "hst", minute: 20 })]);
  assert.ok(!kinds(buildPressPosts(far, END)).includes("double"));
});

test("big chances need xG >= 0.30, use xG wording, and goals never count as misses", () => {
  const f = fixture([
    ev({ type: "shot", teamId: "home", playerId: "hst", minute: 10, outcome: "miss", xg: 0.29 }),
    ev({ type: "shot", teamId: "home", playerId: "hst", minute: 20, outcome: "miss", xg: 0.42 }),
    ev({ type: "shot", teamId: "away", playerId: "ast", minute: 30, outcome: "miss", xg: 0.55 }),
    ev({ type: "shot", teamId: "away", playerId: "ast", minute: 35, outcome: "success", xg: 0.8 }),
  ]);
  const posts = buildPressPosts(f, END).filter((p) => p.kind === "big_chance").reverse();
  assert.equal(posts.length, 2);
  assert.match(posts[0]!.text, /0\.42 illustrative xG/);
  assert.match(posts[1]!.text, /[Gg]olden chance/);
});

test("a shot and its save merge into one post; low xG and blocked shots do not post", () => {
  const shot = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 20, outcome: "saved", xg: 0.4 });
  const save = ev({ type: "save", teamId: "home", playerId: "hgk", minute: 20, second: 5 });
  const lowShot = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 40, outcome: "saved", xg: 0.1 });
  const lowSave = ev({ type: "save", teamId: "home", playerId: "hgk", minute: 40, second: 5 });
  const blocked = ev({ type: "shot", teamId: "away", playerId: "ast", minute: 50, outcome: "blocked", xg: 0.4 });
  const blockedSave = ev({ type: "save", teamId: "home", playerId: "hgk", minute: 50, second: 5 });
  const posts = buildPressPosts(fixture([shot, save, lowShot, lowSave, blocked, blockedSave]), END);
  assert.equal(posts.filter((p) => p.kind === "save").length, 1);
  assert.match(posts.find((p) => p.kind === "save")!.text, /Gus Keeper denies Ari Striker|Gus Keeper keeps out Ari Striker/);
  assert.ok(!posts.some((p) => p.second === 20 * 60 && p.kind === "big_chance"));
  assert.ok(!posts.some((p) => p.second === 50 * 60 && p.kind === "big_chance"));
});

test("yellow cards post only for a second yellow or from the 80th minute; reds say how", () => {
  const f = fixture([
    ev({ type: "yellow_card", teamId: "home", playerId: "hcb", minute: 30 }),
    ev({ type: "yellow_card", teamId: "away", playerId: "ast", minute: 82 }),
    ev({ type: "yellow_card", teamId: "home", playerId: "hst", minute: 20 }),
    ev({ type: "red_card", teamId: "home", playerId: "hcb", minute: 60 }),
    ev({ type: "red_card", teamId: "away", playerId: "ast", minute: 70 }),
  ]);
  const posts = buildPressPosts(f, END);
  assert.equal(posts.filter((p) => p.kind === "yellow_card").length, 1);
  const reds = posts.filter((p) => p.kind === "red_card");
  assert.match(reds.find((p) => p.teamId === "home")!.text, /second yellow/);
  assert.match(reds.find((p) => p.teamId === "away")!.text, /straight red/);
});

test("substitutions: from minute 60 only, grouped per team and minute", () => {
  const f = fixture([
    ev({ type: "substitution", teamId: "home", playerId: "hcb", minute: 55 }),
    ev({ type: "substitution", teamId: "home", playerId: "hst", minute: 65 }),
    ev({ type: "substitution", teamId: "home", playerId: "hcb", minute: 65, second: 4 }),
  ]);
  const posts = buildPressPosts(f, END).filter((p) => p.kind === "substitution");
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.text, /2 (changes|substitutions)|make 2 changes/);
});

test("dominant spell needs shots, a quiet opponent and an xG gap, at most once per 15 minutes", () => {
  const shots = Array.from({ length: 6 }, (_, i) => ev({ type: "shot", teamId: "home", playerId: "hst", minute: 2 + i * 2, outcome: "saved", xg: 0.16 }));
  const f = fixture(shots);
  assert.ok(kinds(buildPressPosts(f, END)).includes("dominant"));
  assert.equal(buildPressPosts(f, END).filter((p) => p.kind === "dominant").length, 1);
  const quiet = fixture(shots.map((s) => ({ ...s, xg: 0.05 })));
  assert.ok(!kinds(buildPressPosts(quiet, END)).includes("dominant"));
  assert.match(buildPressPosts(f, END).find((p) => p.kind === "dominant")!.text, /illustrative xG/);
  // A shot with no xG is not a zero: the comparison is withheld, not computed.
  const missing = fixture(shots.map((s, i) => (i === 0 ? { ...s, xg: undefined } : s)));
  assert.ok(!kinds(buildPressPosts(missing, END)).includes("dominant"));
  const noXgAtAll = fixture(shots.map((s) => ({ ...s, xg: undefined })));
  assert.ok(!kinds(buildPressPosts(noXgAtAll, END)).includes("dominant"));
});

test("posts never quote xG without the illustrative label", () => {
  const f = fixture([
    ev({ type: "shot", teamId: "home", playerId: "hst", minute: 20, outcome: "miss", xg: 0.6 }),
    ev({ type: "shot", teamId: "away", playerId: "ast", minute: 30, outcome: "miss" }),
  ]);
  const posts = buildPressPosts(f, END);
  for (const post of posts) assert.doesNotMatch(post.text, /(?<!illustrative )\bxG\b/);
  assert.ok(posts.some((p) => /0\.60 illustrative xG/.test(p.text)));
  assert.equal(posts.filter((p) => p.kind === "big_chance").length, 1, "a shot with no xG is not a big chance");
});

test("stoppage time shows 45+N and the first half never says 'late'", () => {
  const goal = ev({ type: "goal", teamId: "home", playerId: "hst", minute: 47, period: 1 });
  const [post] = buildPressPosts(fixture([goal]), END);
  assert.equal(post!.minute, "45+2");
  assert.doesNotMatch(post!.text, /\blate\b/i);
});

test("engagement counts follow persona and kind ranges", () => {
  const events = Array.from({ length: 30 }, (_, i) => ev({ type: "goal", teamId: "home", playerId: "hst", minute: i }));
  const f = fixture(events, { seed: 99 });
  for (const post of buildPressPosts(f, END, { limit: 12 })) {
    const v = post.persona.verified;
    assert.ok(post.replies >= (v ? 20 : 2) && post.replies <= (v ? 180 : 40));
    assert.ok(post.reposts >= (v ? 80 : 5) && post.reposts <= (v ? 900 : 150));
    assert.ok(post.likes >= (v ? 400 : 30) && post.likes <= (v ? 6000 : 900));
  }
});

test("relativeTime uses the match clock", () => {
  assert.equal(relativeTime(100, 100), "now");
  assert.equal(relativeTime(100, 159), "now");
  assert.equal(relativeTime(100, 160), "1m");
  assert.equal(relativeTime(0, 3599), "59m");
  assert.equal(relativeTime(0, 3600), "1h");
  assert.equal(relativeTime(0, 7300), "2h");
  assert.equal(relativeTime(500, 100), "now");
});

test("compactCount abbreviates thousands and millions", () => {
  assert.equal(compactCount(0), "0");
  assert.equal(compactCount(999), "999");
  assert.equal(compactCount(1000), "1K");
  assert.equal(compactCount(1234), "1.2K");
  assert.equal(compactCount(12345), "12K");
  assert.equal(compactCount(1_250_000), "1.2M");
});
