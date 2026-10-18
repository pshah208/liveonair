/**
 * "Press box": a wall of synthetic posts from FICTIONAL football journalists.
 * Pure, DOM-free and deterministic: the same fixture and clock always give the same posts and counts.
 * Text is built only from fixture team and player names. No real people, outlets, handles or links.
 */
import { eventSecondOf, latestRevisions } from "./highlights.js";
import type { MatchEvent, MatchFixture, Player, TeamId } from "./types.js";

export const MAX_PRESS_POSTS = 12;
export const MAX_POST_CHARS = 200;
export const PRESS_BOX_LABEL = "Synthetic posts · fictional journalists";

export const BIG_CHANCE_XG = 0.3;
export const GOLDEN_CHANCE_XG = 0.5;
export const SAVE_MIN_XG = 0.15;
export const BIG_SAVE_XG = 0.3;
export const YELLOW_MIN_MINUTE = 80;
export const SUBS_MIN_MINUTE = 60;
export const DOMINANT_WINDOW_SECONDS = 15 * 60;
export const DOMINANT_MIN_SHOTS = 5;
export const DOMINANT_MAX_OPPONENT_SHOTS = 1;
export const DOMINANT_MIN_XG_GAP = 0.8;
export const QUICK_DOUBLE_SECONDS = 5 * 60;

export type PersonaId = "holloway" | "rakshit" | "whelan" | "carvalho" | "boyd" | "nandakumar";
export type PressKind = "kickoff" | "goal" | "red_card" | "yellow_card" | "big_chance" | "save" | "substitution" | "halftime" | "fulltime" | "dominant" | "double" | "correction";

export interface PressPersona {
  id: PersonaId;
  name: string;
  handle: string;
  outlet: string;
  role: string;
  verified: boolean;
  initials: string;
}

/** All fictional. Any resemblance to real journalists is coincidental. */
export const PRESS_PERSONAS: Record<PersonaId, PressPersona> = {
  holloway: { id: "holloway", name: "Marguerite Holloway", handle: "@mholloway_ledger", outlet: "The Northern Ledger", role: "Chief football writer", verified: true, initials: "MH" },
  rakshit: { id: "rakshit", name: "Dev Rakshit", handle: "@devrakshit_wire", outlet: "Meridian Sports Wire", role: "Breaking news", verified: true, initials: "DR" },
  whelan: { id: "whelan", name: "Tomasz Whelan", handle: "@tomwhelan_tactics", outlet: "The Pitchside Review", role: "Tactics columnist", verified: true, initials: "TW" },
  carvalho: { id: "carvalho", name: "Ines Carvalho", handle: "@ines_onthetouchline", outlet: "Harbour Radio Sport", role: "Live blog", verified: false, initials: "IC" },
  boyd: { id: "boyd", name: "Cal Boyd", handle: "@calboyd_terrace", outlet: "Terrace Talk Pod", role: "Podcaster", verified: false, initials: "CB" },
  nandakumar: { id: "nandakumar", name: "Priya Nandakumar", handle: "@priyanwrites", outlet: "Fulcrum Football Data", role: "Match-data reporter", verified: false, initials: "PN" },
};

const PERSONA_POOLS: Record<Exclude<PressKind, "correction">, PersonaId[]> = {
  kickoff: ["holloway", "carvalho"],
  goal: ["holloway", "rakshit", "carvalho", "boyd"],
  red_card: ["rakshit"],
  yellow_card: ["carvalho", "nandakumar"],
  big_chance: ["whelan", "boyd", "nandakumar"],
  save: ["whelan", "carvalho"],
  substitution: ["rakshit", "nandakumar"],
  halftime: ["holloway", "whelan", "nandakumar"],
  fulltime: ["holloway", "whelan", "boyd"],
  dominant: ["whelan", "nandakumar"],
  double: ["boyd"],
};

export interface PressPost {
  id: string;
  personaId: PersonaId;
  persona: PressPersona;
  /** Display minute, e.g. "34" or "45+2". */
  minute: string;
  /** Match-clock second the post appears at. */
  second: number;
  text: string;
  kind: PressKind;
  /** Team the post is about, when there is one (used by the "My team" filter). */
  teamId?: TeamId;
  replies: number;
  reposts: number;
  likes: number;
  quoted?: { personaHandle: string; text: string };
  /** Set on an original goal post once a correction has been posted. */
  ruledOut?: boolean;
}

export interface PressOptions {
  limit?: number;
}

/* ---------- helpers ---------- */

/** FNV-1a, 32-bit. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: string): T {
  return items[hashString(seed) % items.length]!;
}

export function compactCount(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const fmt = (v: number, unit: string) => {
    const tenth = Math.floor(v * 10) / 10;
    return `${v >= 10 ? Math.floor(v) : tenth}${unit}`;
  };
  if (value < 1000) return String(value);
  if (value < 1_000_000) return fmt(value / 1000, "K");
  return fmt(value / 1_000_000, "M");
}

/** Relative age of a post on the MATCH clock (not wall time). */
export function relativeTime(postSecond: number, clockSecond: number): string {
  const delta = clockSecond - postSecond;
  if (!(delta >= 60)) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  return `${Math.floor(delta / 3600)}h`;
}

const RANGES = {
  verified: { replies: [20, 180], reposts: [80, 900], likes: [400, 6000] },
  standard: { replies: [2, 40], reposts: [5, 150], likes: [30, 900] },
} as const;

function multiplierFor(kind: PressKind): number {
  if (kind === "goal" || kind === "red_card") return 1;
  if (kind === "correction") return 0.3;
  return 0.6;
}

function engagement(seed: string, persona: PressPersona, kind: PressKind): Pick<PressPost, "replies" | "reposts" | "likes"> {
  const ranges = persona.verified ? RANGES.verified : RANGES.standard;
  const mult = multiplierFor(kind);
  const draw = (key: "replies" | "reposts" | "likes") => {
    const [lo, hi] = ranges[key];
    return Math.round((lo + (hashString(`${seed}|${key}`) % (hi - lo + 1))) * mult);
  };
  return { replies: draw("replies"), reposts: draw("reposts"), likes: draw("likes") };
}

function clip(text: string): string {
  return text.length <= MAX_POST_CHARS ? text : `${text.slice(0, MAX_POST_CHARS - 1).trimEnd()}…`;
}

function displayMinute(event: Pick<MatchEvent, "minute" | "period">, second: number, halftimeSecond: number | undefined): string {
  const period = event.period ?? (halftimeSecond === undefined ? undefined : second <= halftimeSecond ? 1 : 2);
  if (period === 1 && event.minute > 45) return `45+${event.minute - 45}`;
  if (period === 2 && event.minute > 90) return `90+${event.minute - 90}`;
  return String(event.minute);
}

interface Draft {
  key: string;
  kind: PressKind;
  second: number;
  order: number;
  minute: string;
  teamId?: TeamId;
  text: (variantSeed: string) => string;
  pool?: PersonaId[];
  personaId?: PersonaId;
  quoted?: { personaHandle: string; text: string };
  ruledOutOf?: string;
}

/* ---------- engine ---------- */

export function buildPressPosts(fixture: MatchFixture, uptoSecond: number, opts: PressOptions = {}): PressPost[] {
  const limit = Math.max(0, Math.min(opts.limit ?? MAX_PRESS_POSTS, MAX_PRESS_POSTS));
  // A revision retains the original event clock. Select only events available at
  // this clock before collapsing revisions, or a future correction rewrites history.
  const events = latestRevisions(fixture.events.filter((e) =>
    eventSecondOf(e) <= uptoSecond &&
    !(e.rescinded && e.id === fixture.correctionEventId && uptoSecond < fixture.correctionAvailableAt)
  ));
  const players = new Map<string, Player>([...fixture.home.players, ...fixture.away.players].map((p) => [p.id, p]));
  const nameOf = (id: string) => players.get(id)?.name ?? "the player";
  const teamName = (id: TeamId) => fixture[id].name;
  const halftimeSecond = fixture.periods?.source === "video_unknown" ? undefined : fixture.periods?.halftimeSecond;
  const other = (id: TeamId): TeamId => (id === "home" ? "away" : "home");
  const secondOf = eventSecondOf;
  const minuteOf = (e: MatchEvent) => displayMinute(e, secondOf(e), halftimeSecond);
  const shotsById = new Map(events.filter((e) => e.type === "shot").map((e) => [e.id, e]));

  const validGoals = events.filter((e) => e.type === "goal" && !e.rescinded);
  const scoreAt = (second: number, inclusive: boolean): { home: number; away: number } => {
    const score = { home: 0, away: 0 };
    for (const g of validGoals) {
      const s = secondOf(g);
      if (inclusive ? s <= second : s < second) score[g.teamId] += 1;
    }
    return score;
  };
  const scoreLine = (score: { home: number; away: number }) => `${teamName("home")} ${score.home}-${score.away} ${teamName("away")}`;

  const drafts: Draft[] = [];
  let order = 0;
  const add = (draft: Omit<Draft, "order">) => drafts.push({ ...draft, order: order++ });

  // Kickoff, halftime, fulltime
  for (const e of events) {
    if (e.rescinded) continue;
    const s = secondOf(e);
    if (e.type === "kickoff") {
      add({ key: e.id, kind: "kickoff", second: s, minute: minuteOf(e), pool: PERSONA_POOLS.kickoff, text: (v) => pick([
        `We're underway: ${teamName("home")} v ${teamName("away")}. Settle in.`,
        `Kickoff! ${teamName("home")} host ${teamName("away")}. Here we go.`,
        `And we're off at ${teamName("home")} v ${teamName("away")}.`,
      ], v) });
    } else if (e.type === "halftime" || e.type === "fulltime") {
      const line = scoreLine(scoreAt(s, true));
      add({ key: e.id, kind: e.type, second: s, minute: minuteOf(e), pool: PERSONA_POOLS[e.type], text: (v) => e.type === "halftime"
        ? pick([`HT: ${line}. Plenty to unpick.`, `Half-time: ${line}. Back shortly.`, `HT: ${line}. Lots to talk about.`], v)
        : pick([`FT: ${line}.`, `Full-time: ${line}. That's that.`, `FT: ${line}. Thanks for following along.`], v) });
    }
  }

  // Goals, corrections, quick doubles
  const goalDraftsByEvent = new Map<string, Draft>();
  const lastValidGoalByTeam = new Map<TeamId, MatchEvent>();
  for (const e of events.filter((ev) => ev.type === "goal").sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id))) {
    // Only the fixture's designated correction has a known publication time; any other ruled-out goal is
    // dropped (as in the rest of the app) rather than given a guessed correction time that could leak spoilers.
    if (e.rescinded && e.id !== fixture.correctionEventId) continue;
    const s = secondOf(e);
    const team = e.teamId;
    const scorer = players.get(e.playerId);
    const ownGoal = Boolean(scorer && scorer.teamId !== e.teamId);
    const name = nameOf(e.playerId);
    // Score before and after, counting only valid goals. A rescinded goal is described as it was first reported.
    const before = scoreAt(s, false);
    const after = e.rescinded ? { ...before, [team]: before[team] + 1 } as { home: number; away: number } : scoreAt(s, true);
    const mine = before[team];
    const theirs = before[other(team)];
    const nowMine = after[team];
    const nowTheirs = after[other(team)];
    const minute = minuteOf(e);
    // Did this team trail at any earlier point? (Only valid goals before this one count.)
    const trailedBefore = (() => {
      const run = { home: 0, away: 0 };
      for (const g of validGoals) {
        if (secondOf(g) >= s) break;
        run[g.teamId] += 1;
        if (run[team] < run[other(team)]) return true;
      }
      return false;
    })();
    const t = teamName(team);
    const line = scoreLine(after);
    const phrase = (): string[] => {
      if (ownGoal) return [`${name} diverts the ball into the wrong net and ${t} are credited`];
      if (mine === theirs && trailedBefore) return [`${name} turned it around for ${t}`, `${name} completes the turnaround for ${t}`];
      if (mine === theirs) return [`${name} puts ${t} ahead`, `${name} gives ${t} the lead`];
      if (mine < theirs && nowMine === nowTheirs) return [`${name} equalises for ${t}`, `${name} levels it for ${t}`];
      if (mine < theirs) return [`${name} pulls one back for ${t}`];
      if (nowMine - nowTheirs === 2) return [`${name} gives ${t} a two-goal cushion`];
      return [`${name} extends ${t}'s lead`];
    };
    const draft: Omit<Draft, "order"> = {
      key: e.id, kind: "goal", second: s, minute, teamId: team, pool: PERSONA_POOLS.goal,
      text: (v) => `${pick(["GOAL!", "Goal!", "It's in!"], v)} ${pick(phrase(), `${v}p`)}. ${line}, ${minute}'.`,
    };
    add(draft);
    goalDraftsByEvent.set(e.id, draft as Draft);

    if (e.rescinded) {
      const at = Math.max(s, fixture.correctionAvailableAt);
      const current = scoreAt(at, true);
      const currentLine = scoreLine(current);
      const origKey = e.id;
      add({
        key: `${e.id}:correction`, kind: "correction", second: at, minute: displayMinute({ minute: Math.floor(at / 60), period: e.period }, at, halftimeSecond), teamId: team,
        ruledOutOf: origKey,
        text: (v) => pick([
          `Correction: ${name}'s goal for ${t} has been ruled out. It's ${currentLine}.`,
          `Update: ${name}'s goal for ${t} is disallowed. Score stands at ${currentLine}.`,
        ], v),
      });
    } else {
      const prev = lastValidGoalByTeam.get(team);
      if (prev && s - secondOf(prev) <= QUICK_DOUBLE_SECONDS) {
        const mins = Math.max(1, Math.round((s - secondOf(prev)) / 60));
        add({
          key: `${e.id}:double`, kind: "double", second: s, minute, teamId: team, pool: PERSONA_POOLS.double,
          text: (v) => pick([
            `Two in ${mins} ${mins === 1 ? "minute" : "minutes"} for ${t}! ${line}.`,
            `${t} strike twice in ${mins} ${mins === 1 ? "minute" : "minutes"}. ${line}.`,
          ], v),
        });
      }
      lastValidGoalByTeam.set(team, e);
    }
  }

  // Reds and yellows
  const cards = events.filter((e) => (e.type === "yellow_card" || e.type === "red_card") && !e.rescinded);
  const hadYellowBefore = (e: MatchEvent) => cards.some((c) => c.type === "yellow_card" && c.playerId === e.playerId && c.id !== e.id && secondOf(c) <= secondOf(e));
  for (const e of cards) {
    const t = teamName(e.teamId);
    const name = nameOf(e.playerId);
    const minute = minuteOf(e);
    if (e.type === "red_card") {
      const second = hadYellowBefore(e);
      add({ key: e.id, kind: "red_card", second: secondOf(e), minute, teamId: e.teamId, pool: PERSONA_POOLS.red_card, text: (v) => second
        ? pick([`RED CARD: ${name} is sent off for ${t} after a second yellow, ${minute}'.`, `${t} down to ten: ${name} is off after a second yellow, ${minute}'.`], v)
        : pick([`RED CARD: ${name} is sent off for ${t} with a straight red, ${minute}'.`, `${t} down to ten: ${name} sees a straight red, ${minute}'.`], v) });
    } else {
      const secondYellow = cards.some((c) => c.type === "yellow_card" && c.playerId === e.playerId && c.id !== e.id && secondOf(c) < secondOf(e));
      const followedByRed = cards.some((c) => c.type === "red_card" && c.playerId === e.playerId && secondOf(c) >= secondOf(e) && secondOf(c) - secondOf(e) <= 60);
      if (followedByRed || (!secondYellow && e.minute < YELLOW_MIN_MINUTE)) continue;
      add({ key: e.id, kind: "yellow_card", second: secondOf(e), minute, teamId: e.teamId, pool: PERSONA_POOLS.yellow_card, text: (v) => secondYellow
        ? pick([`Yellow for ${name} (${t}), ${minute}'. A second booking this match.`, `${name} (${t}) is booked again, ${minute}'.`], v)
        : pick([`Yellow card: ${name} (${t}) goes into the book, ${minute}'.`, `${name} of ${t} is booked, ${minute}'.`], v) });
    }
  }

  // Shots and saves
  const saves = events.filter((e) => e.type === "save" && !e.rescinded);
  const mergedShots = new Set<string>();
  const xgText = (xg: number) => xg.toFixed(2);
  for (const sv of saves) {
    const shot = (sv.relatedEventId ? shotsById.get(sv.relatedEventId) : undefined)
      ?? [...shotsById.values()].filter((sh) => sh.teamId !== sv.teamId && secondOf(sh) <= secondOf(sv) && sv.minute - sh.minute <= 1 && !mergedShots.has(sh.id) && sh.outcome !== "blocked").pop();
    if (!shot || shot.teamId === sv.teamId || shot.outcome === "blocked" || shot.rescinded) continue;
    if (mergedShots.has(shot.id)) continue;
    if (shot.xg === undefined) continue;
    const xg = shot.xg;
    if (xg < SAVE_MIN_XG) continue;
    mergedShots.add(shot.id);
    const keeper = nameOf(sv.playerId);
    const shooter = nameOf(shot.playerId);
    const minute = minuteOf(sv);
    const big = xg >= BIG_SAVE_XG;
    add({ key: sv.id, kind: "save", second: secondOf(sv), minute, teamId: sv.teamId, pool: PERSONA_POOLS.save, text: (v) => big
      ? pick([`What a stop! ${keeper} denies ${shooter}, ${minute}'. A chance worth ${xgText(xg)} illustrative xG.`, `Big save! ${keeper} keeps out ${shooter}'s effort, ${minute}'. ${xgText(xg)} illustrative xG.`], v)
      : pick([`Good stop: ${keeper} denies ${shooter}, ${minute}'.`, `${keeper} gets down to save from ${shooter}, ${minute}'.`], v) });
  }
  for (const e of events) {
    if (e.type !== "shot" || e.rescinded || e.outcome === "success" || e.outcome === "blocked" || mergedShots.has(e.id)) continue;
    if (e.xg === undefined) continue;
    const xg = e.xg;
    if (xg < BIG_CHANCE_XG) continue;
    const name = nameOf(e.playerId);
    const t = teamName(e.teamId);
    const minute = minuteOf(e);
    const golden = xg >= GOLDEN_CHANCE_XG;
    add({ key: e.id, kind: "big_chance", second: secondOf(e), minute, teamId: e.teamId, pool: PERSONA_POOLS.big_chance, text: (v) => golden
      ? pick([`Golden chance gone: ${name}'s effort for ${t} was a chance worth ${xgText(xg)} illustrative xG, ${minute}'.`, `${name} (${t}) misses a golden chance, ${xgText(xg)} illustrative xG, ${minute}'.`], v)
      : pick([`Big chance gone: ${name}'s effort for ${t} was a chance worth ${xgText(xg)} illustrative xG.`, `${t} will want that back: ${name}, ${xgText(xg)} illustrative xG, ${minute}'.`], v) });
  }

  // Substitutions: group same team and minute
  const subGroups = new Map<string, MatchEvent[]>();
  for (const e of events) {
    if (e.type !== "substitution" || e.rescinded || e.minute < SUBS_MIN_MINUTE) continue;
    const key = `${e.teamId}:${e.minute}`;
    subGroups.set(key, [...(subGroups.get(key) ?? []), e]);
  }
  for (const [key, group] of subGroups) {
    const first = group.slice().sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id))[0]!;
    const t = teamName(first.teamId);
    const minute = minuteOf(first);
    const n = group.length;
    add({ key: `sub:${key}`, kind: "substitution", second: secondOf(first), minute, teamId: first.teamId, pool: PERSONA_POOLS.substitution, text: (v) => n === 1
      ? pick([`${t} make a change, ${minute}'.`, `Substitution for ${t}, ${minute}'.`], v)
      : pick([`${t} make ${n} changes, ${minute}'.`, `${n} substitutions for ${t}, ${minute}'.`], v) });
  }

  // Dominant spells: evaluated every 5 match minutes over the trailing 15, at most one per team per 15.
  const shots = events.filter((e) => e.type === "shot" && !e.rescinded);
  const lastDominant = new Map<TeamId, number>();
  const horizon = Math.max(0, Math.min(uptoSecond, fixture.durationSeconds));
  for (let end = DOMINANT_WINDOW_SECONDS; end <= horizon; end += 300) {
    const inWindow = shots.filter((e) => secondOf(e) > end - DOMINANT_WINDOW_SECONDS && secondOf(e) <= end);
    for (const team of ["home", "away"] as const) {
      const mine = inWindow.filter((e) => e.teamId === team);
      const theirs = inWindow.filter((e) => e.teamId !== team);
      // Withhold the xG comparison when any shot in the window has no xG: a missing value is not zero.
      if (inWindow.some((e) => e.xg === undefined)) continue;
      const gap = mine.reduce((sum, e) => sum + e.xg!, 0) - theirs.reduce((sum, e) => sum + e.xg!, 0);
      const last = lastDominant.get(team);
      if (mine.length < DOMINANT_MIN_SHOTS || theirs.length > DOMINANT_MAX_OPPONENT_SHOTS || gap < DOMINANT_MIN_XG_GAP) continue;
      if (last !== undefined && end - last < DOMINANT_WINDOW_SECONDS) continue;
      lastDominant.set(team, end);
      const t = teamName(team);
      const minute = displayMinute({ minute: Math.floor(end / 60), period: undefined }, end, halftimeSecond);
      const nMine = mine.length;
      const nTheirs = theirs.length;
      add({ key: `dominant:${team}:${end}`, kind: "dominant", second: end, minute, teamId: team, pool: PERSONA_POOLS.dominant, text: (v) => pick([
        `${t} are in control: ${nMine} shots to ${nTheirs} over the last 15 minutes, and the illustrative xG gap is ${xgText(gap)}.`,
        `Spell of pressure from ${t}: ${nMine}-${nTheirs} on shots in the last 15 minutes, a ${xgText(gap)} illustrative xG edge.`,
      ], v) });
    }
  }

  // Materialise: filter by clock, assign persona and counts deterministically.
  const visible = drafts.filter((d) => d.second <= uptoSecond);
  const personaOfDraft = new Map<string, PersonaId>();
  const posts: PressPost[] = [];
  const postByKey = new Map<string, PressPost>();
  // First pass: non-corrections
  for (const d of visible.filter((x) => x.kind !== "correction")) {
    const personaId = pick(d.pool!, `${fixture.seed}|${d.key}|persona`);
    personaOfDraft.set(d.key, personaId);
    const persona = PRESS_PERSONAS[personaId];
    const seed = `${fixture.seed}|${d.key}|${personaId}`;
    const post: PressPost = {
      id: `press-${d.key}`, personaId, persona, minute: d.minute, second: d.second,
      text: clip(d.text(seed)), kind: d.kind, ...(d.teamId ? { teamId: d.teamId } : {}), ...engagement(seed, persona, d.kind),
    };
    posts.push(post);
    postByKey.set(d.key, post);
  }
  // Corrections: same persona as the original, quoting it. The original goal post is created even when it sits earlier.
  for (const d of visible.filter((x) => x.kind === "correction")) {
    const original = postByKey.get(d.ruledOutOf!);
    if (!original) continue;
    const persona = original.persona;
    const seed = `${fixture.seed}|${d.key}|${persona.id}`;
    original.ruledOut = true;
    posts.push({
      id: `press-${d.key}`, personaId: persona.id, persona, minute: d.minute, second: d.second,
      text: clip(d.text(seed)), kind: "correction", ...(d.teamId ? { teamId: d.teamId } : {}), ...engagement(seed, persona, "correction"),
      quoted: { personaHandle: persona.handle, text: original.text },
    });
  }

  return posts
    .sort((a, b) => b.second - a.second || (b.kind === "correction" ? 1 : 0) - (a.kind === "correction" ? 1 : 0) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
