/**
 * "Social Media Posts": a stream of synthetic posts from FICTIONAL football accounts.
 * Pure, DOM-free and deterministic: the same fixture and clock always give the same posts and counts.
 * Text is built only from fixture team and player names and from stats derivable from events up to the post's
 * own second. No real people, outlets, handles or links. (File name kept for compatibility.)
 */
import { eventSecondOf, latestRevisions } from "./highlights.js";
import type { MatchEvent, MatchFixture, Player, TeamId } from "./types.js";

export const MAX_PRESS_POSTS = 20;
export const MAX_POST_CHARS = 200;
export const PRESS_BOX_LABEL = "Synthetic posts · fictional accounts";

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
export const WEAK_KEEPER_MAX_XG = 0.1;

export type PersonaType = "fan-creator" | "stats" | "rival-fan" | "pundit-style" | "meme" | "local-news" | "fanzine";
export type PressKind =
  | "kickoff" | "goal" | "red_card" | "yellow_card" | "big_chance" | "save" | "substitution" | "halftime" | "fulltime" | "dominant" | "double" | "correction"
  | "prematch" | "lineup" | "stat_nugget" | "reaction" | "banter" | "form_context" | "hot_take" | "full_time";
export type PersonaId = string;

export interface PressPersona {
  id: PersonaId;
  name: string;
  handle: string;
  type: PersonaType;
  /** One-line description of the account. */
  role: string;
  verified: boolean;
  initials: string;
  /** Audience size on a 1 (tiny) to 10 (huge) scale. Scales engagement. */
  reach: number;
}

const persona = (id: string, name: string, handle: string, type: PersonaType, role: string, verified: boolean, initials: string, reach: number): PressPersona =>
  ({ id, name, handle, type, role, verified, initials, reach });

/** All fictional and invented. Any resemblance to real people, outlets or accounts is coincidental. */
export const PRESS_PERSONAS: Record<PersonaId, PressPersona> = Object.fromEntries([
  persona("jonty", "Jonty Vale", "@jontyvale_clips", "fan-creator", "Matchday clips and reactions", true, "JV", 8),
  persona("bex", "Bex Harrow", "@bexharrow_fc", "fan-creator", "Season-ticket holder, loud", false, "BH", 5),
  persona("nell", "Numbers Nell", "@nell_by_numbers", "stats", "Charts and counts", true, "NN", 7),
  persona("ledger", "The Shot Ledger", "@shotledger_fc", "stats", "Every shot, logged", false, "SL", 4),
  persona("dougie", "Dougie Pike", "@dougiepike_banter", "rival-fan", "Here for the wind-ups", false, "DP", 6),
  persona("winnie", "Winnie Achterberg", "@winnie_a_ultras", "rival-fan", "Neutral-ish. Not really.", false, "WA", 4),
  persona("calder", "Ruaridh Calder", "@calder_hotseat", "pundit-style", "Hot takes, no apologies", true, "RC", 9),
  persona("strand", "Imogen Strand", "@strand_says", "pundit-style", "Opinions on tap", true, "IS", 7),
  persona("gremlin", "Pitch Gremlin", "@pitchgremlin", "meme", "Memes from the stands", false, "PG", 8),
  persona("dippers", "Bin Dippers", "@bindippers_hq", "meme", "Football, but make it unwell", false, "BD", 5),
  persona("echo", "Kestrel Valley Echo Sport", "@kestrelechosport", "local-news", "Local match desk", true, "KE", 6),
  persona("dispatch", "Dunmore Dispatch Sport", "@dunmoredispatch", "local-news", "Your town, your team", true, "DD", 5),
  persona("terrace", "Terrace Ink", "@terraceink_zine", "fanzine", "Fanzine, printed badly", false, "TI", 3),
  persona("sixth", "Sixth Stand Fanzine", "@sixthstand_zine", "fanzine", "Words from the sixth stand", false, "SS", 3),
].map((p) => [p.id, p]));

const PERSONA_LIST: readonly PressPersona[] = Object.values(PRESS_PERSONAS);

/** Which account types may post each kind. */
const PERSONA_TYPES: Record<Exclude<PressKind, "correction">, PersonaType[]> = {
  kickoff: ["local-news", "fan-creator"],
  goal: ["local-news", "fan-creator", "pundit-style", "meme"],
  red_card: ["local-news", "pundit-style", "rival-fan"],
  yellow_card: ["stats", "fanzine"],
  big_chance: ["stats", "pundit-style", "fan-creator"],
  save: ["stats", "fanzine"],
  substitution: ["local-news", "stats"],
  halftime: ["local-news", "pundit-style", "stats"],
  fulltime: ["local-news", "pundit-style"],
  dominant: ["stats", "pundit-style"],
  double: ["stats", "meme"],
  prematch: ["fan-creator", "fanzine", "local-news", "pundit-style"],
  lineup: ["local-news", "fanzine"],
  stat_nugget: ["stats"],
  reaction: ["fan-creator", "meme", "pundit-style"],
  banter: ["rival-fan"],
  form_context: ["rival-fan", "fan-creator", "local-news"],
  hot_take: ["pundit-style", "fan-creator"],
  full_time: ["pundit-style", "local-news", "fan-creator", "stats"],
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
  views: number;
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

/** How much attention a kind of post draws. Goals and red cards draw the most. */
const KIND_WEIGHT: Record<PressKind, number> = {
  goal: 1, red_card: 1, double: 0.7, hot_take: 0.7, reaction: 0.6, full_time: 0.6, banter: 0.5, big_chance: 0.5, correction: 0.5,
  fulltime: 0.5, kickoff: 0.4, save: 0.4, halftime: 0.35, dominant: 0.35, stat_nugget: 0.3, prematch: 0.3, form_context: 0.25,
  lineup: 0.25, yellow_card: 0.2, substitution: 0.15,
};

/** Deterministic engagement, seeded from fixture id and post id, scaled by account reach and event weight. */
function engagement(fixtureId: string, postId: string, persona: PressPersona, kind: PressKind): Pick<PressPost, "replies" | "reposts" | "likes" | "views"> {
  const unit = (key: string) => hashString(`${fixtureId}|${postId}|${key}`) / 0x100000000;
  const reach = Math.min(10, Math.max(1, persona.reach));
  const base = reach * reach * 1500 * KIND_WEIGHT[kind] * (persona.verified ? 1.3 : 1);
  const views = Math.max(40, Math.round(base * (0.5 + unit("views"))));
  const likes = Math.min(views, Math.round(views * (0.02 + 0.04 * unit("likes"))));
  const reposts = Math.round(likes * (0.1 + 0.2 * unit("reposts")));
  const replies = Math.round(likes * (0.05 + 0.1 * unit("replies")));
  return { replies, reposts, likes, views };
}

/** Popularity used by the "Top" ordering. Views count least; reposts and replies count more than likes. */
export function postPopularity(post: Pick<PressPost, "replies" | "reposts" | "likes" | "views">): number {
  return post.likes + 2 * post.reposts + 1.5 * post.replies + post.views / 20;
}

export type PressOrder = "top" | "latest";

/**
 * Orders posts for display. Only posts already visible at `uptoSecond` are considered, so a future post can
 * never surface in "Top". "Latest" is newest first; "Top" is by popularity, newest first on ties.
 */
export function rankPressPosts(posts: readonly PressPost[], order: PressOrder, uptoSecond: number): PressPost[] {
  const visible = posts.filter((post) => post.second <= uptoSecond);
  const byNewest = (a: PressPost, b: PressPost) => b.second - a.second || a.id.localeCompare(b.id);
  if (order === "latest") return visible.sort(byNewest);
  return visible.sort((a, b) => postPopularity(b) - postPopularity(a) || byNewest(a, b));
}

/** "Pre-match" before kickoff, otherwise the match-clock age. */
export function postTimeLabel(postSecond: number, clockSecond: number): string {
  return postSecond < 0 ? "Pre-match" : relativeTime(postSecond, clockSecond);
}

function pickPersona(types: readonly PersonaType[], seed: string): PressPersona {
  const pool = PERSONA_LIST.filter((p) => types.includes(p.type));
  return pick(pool.length > 0 ? pool : PERSONA_LIST, seed);
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
  text: (variantSeed: string, persona: PressPersona) => string;
  types?: PersonaType[];
  personaId?: PersonaId;
  quoted?: { personaHandle: string; text: string };
  ruledOutOf?: string;
  /** Key of the draft this one reacts to; it is flagged too if that goal is later ruled out. */
  reactsTo?: string;
}

/* ---------- engine ---------- */

export function buildPressPosts(fixture: MatchFixture, uptoSecond: number, opts: PressOptions = {}): PressPost[] {
  const limit = Math.max(0, Math.min(opts.limit ?? MAX_PRESS_POSTS, MAX_PRESS_POSTS));
  return buildAllPressPosts(fixture, uptoSecond).slice(0, limit);
}

/**
 * The posts to display: the full clock-visible set, filtered to `focusTeamId` when given (league-wide posts are kept),
 * ranked or sorted, and only then capped. Capping first would rank only the newest posts.
 */
export function selectPressPosts(fixture: MatchFixture, uptoSecond: number, order: PressOrder, focusTeamId?: TeamId): PressPost[] {
  const all = buildAllPressPosts(fixture, uptoSecond);
  const scoped = focusTeamId ? all.filter((post) => post.teamId === undefined || post.teamId === focusTeamId) : all;
  return rankPressPosts(scoped, order, uptoSecond).slice(0, MAX_PRESS_POSTS);
}

/** Every post visible at the clock, newest first, with no cap. */
export function buildAllPressPosts(fixture: MatchFixture, uptoSecond: number): PressPost[] {
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

  // Facts known at a given second: the fixture's designated correction only takes effect from correctionAvailableAt,
  // so a goal ruled out later still counts for posts published before that.
  const knownGoals = events.filter((e) => e.type === "goal" && (!e.rescinded || e.id === fixture.correctionEventId))
    .sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
  const countsAt = (g: MatchEvent, second: number) => !g.rescinded || second < Math.max(fixture.correctionAvailableAt, secondOf(g) + 1);
  const scoreAt = (second: number, inclusive: boolean): { home: number; away: number } => {
    const score = { home: 0, away: 0 };
    for (const g of knownGoals) {
      const s = secondOf(g);
      if ((inclusive ? s <= second : s < second) && countsAt(g, second)) score[g.teamId] += 1;
    }
    return score;
  };
  const scoreLine = (score: { home: number; away: number }) => `${teamName("home")} ${score.home}-${score.away} ${teamName("away")}`;
  const keeperOf = (team: TeamId) => [...players.values()].find((p) => p.teamId === team && p.position === "GK")?.name;
  const minuteAtSecond = (second: number, period?: 1 | 2) => displayMinute({ minute: Math.floor(second / 60), period }, second, halftimeSecond);

  const drafts: Draft[] = [];
  let order = 0;
  const add = (draft: Omit<Draft, "order">) => drafts.push({ ...draft, order: order++ });

  // Kickoff, halftime, fulltime
  for (const e of events) {
    if (e.rescinded) continue;
    const s = secondOf(e);
    if (e.type === "kickoff") {
      add({ key: e.id, kind: "kickoff", second: s, minute: minuteOf(e), types: PERSONA_TYPES.kickoff, text: (v) => (e.period ?? (halftimeSecond !== undefined && s > halftimeSecond ? 2 : 1)) === 2
        ? pick([`Second half underway: ${teamName("home")} v ${teamName("away")}.`, `Second half underway at ${teamName("home")} v ${teamName("away")}.`], v)
        : pick([
          `We're underway: ${teamName("home")} v ${teamName("away")}. Settle in.`,
          `Kickoff! ${teamName("home")} host ${teamName("away")}. Here we go.`,
          `And we're off at ${teamName("home")} v ${teamName("away")}.`,
        ], v) });
    } else if (e.type === "halftime" || e.type === "fulltime") {
      const line = scoreLine(scoreAt(s, true));
      add({ key: e.id, kind: e.type, second: s, minute: minuteOf(e), types: PERSONA_TYPES[e.type], text: (v) => e.type === "halftime"
        ? pick([`HT: ${line}. Plenty to unpick.`, `Half-time: ${line}. Back shortly.`, `HT: ${line}. Lots to talk about.`], v)
        : pick([`FT: ${line}.`, `Full-time: ${line}. That's that.`, `FT: ${line}. Thanks for following along.`], v) });
    }
  }

  // Goals, corrections, quick doubles
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
    // Score before and after, using only what was known at this goal's own second (a goal is described as first reported).
    const before = scoreAt(s, false);
    const after = scoreAt(s, true);
    const mine = before[team];
    const theirs = before[other(team)];
    const nowMine = after[team];
    const nowTheirs = after[other(team)];
    const minute = minuteOf(e);
    // Did this team trail at any earlier point? (Only valid goals before this one count.)
    const trailedBefore = (() => {
      const run = { home: 0, away: 0 };
      for (const g of knownGoals) {
        if (secondOf(g) >= s) break;
        if (!countsAt(g, s)) continue;
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
      key: e.id, kind: "goal", second: s, minute, teamId: team, types: PERSONA_TYPES.goal,
      text: (v) => `${pick(["GOAL!", "Goal!", "It's in!"], v)} ${pick(phrase(), `${v}p`)}. ${line}, ${minute}'.`,
    };
    add(draft);

    // Social reactions to the goal. Everything below uses only the score and names at the goal's own second.
    {
      const conceder = other(team);
      const c = teamName(conceder);
      const keeper = keeperOf(conceder);
      const margin = nowMine - nowTheirs;
      const goalXg = e.xg ?? [...shotsById.values()].find((sh) => sh.playerId === e.playerId && sh.teamId === e.teamId && Math.abs(secondOf(sh) - s) <= 10)?.xg;
      const delayed = (tag: string, lo: number, hi: number) => s + lo + (hashString(`${fixture.seed}|${e.id}|${tag}`) % (hi - lo + 1));
      const react = delayed("react", 20, 90);
      add({
        key: `${e.id}:reaction`, kind: "reaction", second: react, minute: minuteAtSecond(react, e.period), teamId: team, types: PERSONA_TYPES.reaction, reactsTo: e.id,
        text: (v, who) => {
          if (ownGoal) return pick([`Own goal. Brutal. ${line}.`, `${name} will want to forget that one. ${line}.`], v);
          if (who.type === "meme") return pick([`${name}. Absolute scenes. ${line}.`, `${c} defending like it's a group chat. ${line}.`], v);
          if (hashString(`${v}|side`) % 2 === 0) return pick([`${name}! ${t} deserve that. ${line}.`, `Take a bow, ${name}. ${line}.`, `That's why you keep ${name} in the side. ${line}.`], v);
          if (margin >= 2) return pick([`Not good enough from ${c}. ${line}.`, `Not good enough. ${c} are being picked apart. ${line}.`], v);
          if (!keeper) return `Weak from ${c}. ${line}.`;
          return goalXg !== undefined && goalXg <= WEAK_KEEPER_MAX_XG
            ? pick([`Weak by ${keeper}… ${c} will be furious. ${line}.`, `Weak by ${keeper}… that has to be saved. ${line}.`], v)
            : pick([`No chance for ${keeper}. ${line}.`, `Nothing ${keeper} could do about that. ${line}.`], v);
        },
      });
      if (!ownGoal) {
        if (hashString(`${fixture.seed}|${e.id}|extra`) % 2 === 0) {
          const at = delayed("banter", 30, 100);
          add({
            key: `${e.id}:banter`, kind: "banter", second: at, minute: minuteAtSecond(at, e.period), teamId: conceder, types: PERSONA_TYPES.banter, reactsTo: e.id,
            text: (v) => pick([`${c} fans, how are we feeling? ${line}.`, `${c} conceding? Shocking. ${line}.`, `Imagine being a ${c} fan right now. ${line}.`], v),
          });
        } else {
          const at = delayed("take", 30, 100);
          add({
            key: `${e.id}:take`, kind: "hot_take", second: at, minute: minuteAtSecond(at, e.period), teamId: team, types: PERSONA_TYPES.hot_take, reactsTo: e.id,
            text: (v) => margin >= 2
              ? pick([`${c} need to wake up. ${line}.`, `${c} look rattled. ${line}.`], v)
              : margin === 0
                ? pick([`${t} are back in it. Game on. ${line}.`, `That changes the mood. ${line}.`], v)
                : margin < 0
                  ? pick([`${t} have a lifeline. ${line}.`, `Game on? ${t} pull one back. ${line}.`], v)
                  : pick([`${t} look like they mean it. ${line}.`, `${t} are taking control of this. ${line}.`], v),
          });
        }
      }
    }

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
          key: `${e.id}:double`, kind: "double", second: s, minute, teamId: team, types: PERSONA_TYPES.double,
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
  const yellowsOf = (e: MatchEvent) => cards.filter((c) => c.type === "yellow_card" && c.playerId === e.playerId && c.id !== e.id);
  // A second yellow: a yellow within 60s before the red, and an earlier yellow before that one. Otherwise a straight red.
  const isSecondYellowRed = (e: MatchEvent) => {
    const ys = yellowsOf(e);
    return ys.some((y1) => secondOf(y1) <= secondOf(e) && secondOf(e) - secondOf(y1) <= 60 && ys.some((y0) => y0.id !== y1.id && secondOf(y0) < secondOf(y1)));
  };
  const menWord = (n: number) => (n === 10 ? "ten" : n === 9 ? "nine" : String(n));
  const isSecondYellow = (e: MatchEvent) => e.type === "yellow_card" && yellowsOf(e).some((c) => secondOf(c) < secondOf(e));
  const hasRedSoonAfter = (e: MatchEvent) => cards.some((c) => c.type === "red_card" && c.playerId === e.playerId && secondOf(c) >= secondOf(e) && secondOf(c) - secondOf(e) <= 60);
  // Dismissals: explicit reds plus second yellows that have no accompanying red event (still a sending-off under Law 12).
  const dismissals = cards.filter((c) => c.type === "red_card" || (isSecondYellow(c) && !hasRedSoonAfter(c)));
  const dismissedUpTo = (e: MatchEvent) => dismissals.filter((c) => c.teamId === e.teamId && (secondOf(c) < secondOf(e) || (secondOf(c) === secondOf(e) && c.id <= e.id))).length;
  for (const e of cards) {
    const t = teamName(e.teamId);
    const name = nameOf(e.playerId);
    const minute = minuteOf(e);
    if (e.type === "red_card") {
      const second = isSecondYellowRed(e);
      const reds = dismissedUpTo(e);
      const w = menWord(Math.max(1, 11 - reds));
      const W = w.charAt(0).toUpperCase() + w.slice(1);
      add({ key: e.id, kind: "red_card", second: secondOf(e), minute, teamId: e.teamId, types: PERSONA_TYPES.red_card, text: (v) => second
        ? pick([`RED CARD: ${name} is sent off for ${t} after a second yellow, ${minute}'.`, `${t} down to ${w}: ${name} is off after a second yellow, ${minute}'.`], v)
        : pick([`RED CARD: ${name} is sent off for ${t} with a straight red, ${minute}'.`, `${t} down to ${w}: ${name} sees a straight red, ${minute}'.`], v) });
      const redAt = secondOf(e) + 20 + (hashString(`${fixture.seed}|${e.id}|react`) % 71);
      add({ key: `${e.id}:reaction`, kind: "reaction", second: redAt, minute: minuteAtSecond(redAt, e.period), teamId: e.teamId, types: PERSONA_TYPES.reaction,
        text: (v) => {
          const sc = scoreAt(redAt, true);
          const leading = sc[e.teamId] > sc[other(e.teamId)];
          return pick([
            `${t} down to ${w}. That changes the game.`,
            `Red card for ${name}. ${t} have made it hard for themselves.`,
            leading ? `${t} will have to dig in and see this out.` : `${W} men. ${t} have a mountain to climb now.`,
          ], v);
        } });
      if (hashString(`${fixture.seed}|${e.id}|extra`) % 2 === 0) {
        const bantAt = redAt + 15;
        add({ key: `${e.id}:banter`, kind: "banter", second: bantAt, minute: minuteAtSecond(bantAt, e.period), teamId: e.teamId, types: PERSONA_TYPES.banter,
          text: (v) => pick([`${t} with ${w} men. Love to see it. Don't @ me.`, `${name} walks. ${t} fans, breathe.`], v) });
      }
    } else {
      const secondYellow = isSecondYellow(e);
      const followedByRed = hasRedSoonAfter(e);
      if (followedByRed || (!secondYellow && e.minute < YELLOW_MIN_MINUTE)) continue;
      const left = menWord(Math.max(1, 11 - dismissedUpTo(e)));
      add({ key: e.id, kind: "yellow_card", second: secondOf(e), minute, teamId: e.teamId, types: PERSONA_TYPES.yellow_card, text: (v) => secondYellow
        ? `Second yellow for ${name} (${t}), ${minute}'. That's a red, ${t} down to ${left}.`
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
    add({ key: sv.id, kind: "save", second: secondOf(sv), minute, teamId: sv.teamId, types: PERSONA_TYPES.save, text: (v) => big
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
    add({ key: e.id, kind: "big_chance", second: secondOf(e), minute, teamId: e.teamId, types: PERSONA_TYPES.big_chance, text: (v) => golden
      ? pick([`Golden chance gone: ${name}'s effort for ${t} was a chance worth ${xgText(xg)} illustrative xG, ${minute}'.`, `${name} (${t}) misses a golden chance, ${xgText(xg)} illustrative xG, ${minute}'.`], v)
      : pick([`Big chance gone: ${name}'s effort for ${t} was a chance worth ${xgText(xg)} illustrative xG.`, `${t} will want that back: ${name}, ${xgText(xg)} illustrative xG, ${minute}'.`], v) });
    if (golden) {
      const takeAt = secondOf(e) + 30 + (hashString(`${fixture.seed}|${e.id}|take`) % 31);
      add({ key: `${e.id}:take`, kind: "hot_take", second: takeAt, minute: minuteAtSecond(takeAt, e.period), teamId: e.teamId, types: PERSONA_TYPES.hot_take,
        text: (v) => pick([`Weak by ${name}… ${xgText(xg)} illustrative xG and nothing to show for it.`, `Weak by ${name}… ${t} should have scored that.`], v) });
    }
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
    add({ key: `sub:${key}`, kind: "substitution", second: secondOf(first), minute, teamId: first.teamId, types: PERSONA_TYPES.substitution, text: (v) => n === 1
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
      add({ key: `dominant:${team}:${end}`, kind: "dominant", second: end, minute, teamId: team, types: PERSONA_TYPES.dominant, text: (v) => pick([
        `${t} are in control: ${nMine} shots to ${nTheirs} over the last 15 minutes, and the illustrative xG gap is ${xgText(gap)}.`,
        `Spell of pressure from ${t}: ${nMine}-${nTheirs} on shots in the last 15 minutes, a ${xgText(gap)} illustrative xG edge.`,
      ], v) });
    }
  }

  // ---- Social-only content: pre-match, team news, stat nuggets, form, half-time and full-time takes.
  const home = fixture.home;
  const away = fixture.away;
  const guess = (tag: string) => hashString(`${fixture.seed}|${tag}`);
  const gA = guess("pred-a") % 3;
  const gB = guess("pred-b") % 3;
  const pre = (key: string, second: number, text: (v: string, who: PressPersona) => string) =>
    add({ key, kind: "prematch", second, minute: "Pre", types: PERSONA_TYPES.prematch, text });
  // Fan-voice lines only from fan accounts; news and pundit accounts get a desk line.
  const fanVoice = (who: PressPersona) => who.type === "fan-creator" || who.type === "fanzine";
  pre("pre:1", -55 * 60, (v, who) => !fanVoice(who) ? `Team news due shortly for ${home.name} v ${away.name}.` : pick([
    `Matchday. ${home.name} v ${away.name}. Predictions? I'm going ${home.name} ${gA}-${gB}. Don't @ me.`,
    `${home.name} v ${away.name} today. Coffee on, scarf out, nerves already shredded.`,
  ], v));
  pre("pre:2", -35 * 60, (v, who) => !fanVoice(who) ? `Fans are arriving for ${home.name} v ${away.name}.` : pick([
    `Atmosphere building for ${home.name} v ${away.name}. This is why we do it.`,
    `Walking up for ${home.name} v ${away.name}. Can't wait.`,
  ], v));
  pre("pre:3", -10 * 60, (v, who) => !fanVoice(who) ? `Kickoff in ten minutes: ${home.name} v ${away.name}.` : pick([
    `${home.name} host ${away.name} in ten minutes. Come on.`,
    `Ten minutes. ${home.shortName} v ${away.shortName}. Let's go.`,
  ], v));
  for (const [idx, side] of (["home", "away"] as const).entries()) {
    const squad = fixture[side].players.filter((p) => p.position !== "GK").slice().sort((a, b) => a.number - b.number).slice(0, 3).map((p) => p.name);
    if (squad.length < 2) continue;
    const t = fixture[side].name;
    const lineupAt = (-50 + idx * 2) * 60;
    add({ key: `lineup:${side}`, kind: "lineup", second: lineupAt, minute: "Pre", teamId: side, types: PERSONA_TYPES.lineup,
      text: (v) => pick([`Squad news: ${squad.join(", ")} all in the ${t} squad.`, `${t} squad: ${squad.join(", ")} among those named.`], v) });
  }

  const nuggetHorizon = Math.min(uptoSecond, fixture.durationSeconds);
  const shotsUpTo = (second: number) => events.filter((e) => e.type === "shot" && !e.rescinded && secondOf(e) <= second);
  for (const m of [20, 35, 55, 70, 85]) {
    const at = m * 60;
    if (at > nuggetHorizon) break;
    const upto = shotsUpTo(at);
    if (upto.length < 3) continue;
    const nHome = upto.filter((e) => e.teamId === "home").length;
    const nAway = upto.length - nHome;
    const xgKnown = upto.every((e) => e.xg !== undefined);
    const xgHome = upto.filter((e) => e.teamId === "home").reduce((sum, e) => sum + (e.xg ?? 0), 0);
    const xgAway = upto.filter((e) => e.teamId === "away").reduce((sum, e) => sum + (e.xg ?? 0), 0);
    add({ key: `nugget:${m}`, kind: "stat_nugget", second: at, minute: minuteAtSecond(at), types: PERSONA_TYPES.stat_nugget, text: (v) => {
      if (xgKnown && hashString(`${v}|xg`) % 2 === 0) return `By the ${m}' mark, illustrative xG reads ${home.name} ${xgText(xgHome)}, ${away.name} ${xgText(xgAway)}.`;
      if (nHome === nAway) return `Shots are level at ${nHome}-${nAway} after ${m} minutes.`;
      const lead = nHome > nAway ? home.name : away.name;
      return `${lead} lead the shot count ${Math.max(nHome, nAway)}-${Math.min(nHome, nAway)} after ${m} minutes.`;
    } });
  }

  for (const m of [25, 65]) {
    const at = m * 60;
    if (at > nuggetHorizon) break;
    const sc = scoreAt(at, true);
    const hot = sc.home >= 2 ? "home" : sc.away >= 2 ? "away" : undefined;
    if (hot) {
      const t = teamName(hot);
      const n = sc[hot];
      if (n >= 3 || (n >= 2 && m <= 25)) {
        add({ key: `form:${m}`, kind: "form_context", second: at, minute: minuteAtSecond(at), teamId: hot, types: ["rival-fan"],
          text: (v) => pick([`${t} have scored ${n} in ${m} minutes. We play them next. Going to be a tough one.`, `${n} goals for ${t} in ${m} minutes. We play them next. Not ideal.`], v) });
      } else {
        add({ key: `form:${m}`, kind: "form_context", second: at, minute: minuteAtSecond(at), teamId: hot, types: ["fan-creator", "local-news"],
          text: (v) => pick([`${t} have scored ${n} in ${m} minutes. Strong spell.`, `${n} goals for ${t} in ${m} minutes. They look sharp today.`], v) });
      }
    } else {
      add({ key: `form:${m}`, kind: "form_context", second: at, minute: minuteAtSecond(at), types: PERSONA_TYPES.form_context,
        text: (v) => pick([`Nobody at ${home.name} v ${away.name} is relaxed. Nobody.`, `Fixtures like ${home.name} v ${away.name} don't follow a script.`], v) });
    }
  }

  for (const e of events) {
    if (e.rescinded) continue;
    const s = secondOf(e);
    if (e.type === "halftime") {
      const sc = scoreAt(s, true);
      const at = s + 25;
      add({ key: `${e.id}:take`, kind: "hot_take", second: at, minute: minuteAtSecond(at, 1), types: PERSONA_TYPES.hot_take, text: (v) => {
        if (sc.home === sc.away) return pick([`Level at the break and nobody should be happy with that.`, `All square at half-time. Somebody has to blink.`], v);
        const [lead, trail] = sc.home > sc.away ? [home.name, away.name] : [away.name, home.name];
        return pick([`${trail} must change something at half-time. ${lead} are in charge.`, `${lead} lead at the break. ${trail} need a better second half.`], v);
      } });
    } else if (e.type === "fulltime") {
      const sc = scoreAt(s, true);
      const upto = shotsUpTo(s);
      const sHome = upto.filter((x) => x.teamId === "home").length;
      const sAway = upto.length - sHome;
      const at = s;
      add({ key: `${e.id}:verdict`, kind: "full_time", second: at, minute: minuteAtSecond(at, 2), types: PERSONA_TYPES.full_time, text: (v) => {
        const shotsLine = `Shots ${sHome}-${sAway}.`;
        if (sc.home === sc.away) return pick([`Honours even. ${scoreLine(sc)}. ${shotsLine} Both will feel they could have won it.`, `${scoreLine(sc)}. ${shotsLine} A point each, and nobody is thrilled.`], v);
        const winner = sc.home > sc.away ? home.name : away.name;
        return pick([`${winner} win it. ${scoreLine(sc)}. ${shotsLine}`, `Take the three points, ${winner}. ${scoreLine(sc)}. ${shotsLine}`], v);
      } });
    }
  }

  // Materialise: filter by clock, assign persona and counts deterministically.
  const visible = drafts.filter((d) => d.second <= uptoSecond);
  const posts: PressPost[] = [];
  const postByKey = new Map<string, PressPost>();
  const reactsToOf = new Map<string, string>();
  // First pass: non-corrections
  for (const d of visible.filter((x) => x.kind !== "correction")) {
    const who = pickPersona(d.types ?? [], `${fixture.seed}|${d.key}|persona`);
    const seed = `${fixture.seed}|${d.key}|${who.id}`;
    const post: PressPost = {
      id: `press-${d.key}`, personaId: who.id, persona: who, minute: d.minute, second: d.second,
      text: clip(d.text(seed, who)), kind: d.kind, ...(d.teamId ? { teamId: d.teamId } : {}), ...engagement(fixture.id, `press-${d.key}`, who, d.kind),
    };
    posts.push(post);
    postByKey.set(d.key, post);
    if (d.reactsTo) reactsToOf.set(post.id, d.reactsTo);
  }
  // Corrections: same persona as the original, quoting it. The original goal post is created even when it sits earlier.
  for (const d of visible.filter((x) => x.kind === "correction")) {
    const original = postByKey.get(d.ruledOutOf!);
    if (!original) continue;
    const who = original.persona;
    const seed = `${fixture.seed}|${d.key}|${who.id}`;
    original.ruledOut = true;
    for (const post of posts) if (reactsToOf.get(post.id) === d.ruledOutOf) post.ruledOut = true;
    posts.push({
      id: `press-${d.key}`, personaId: who.id, persona: who, minute: d.minute, second: d.second,
      text: clip(d.text(seed, who)), kind: "correction", ...(d.teamId ? { teamId: d.teamId } : {}), ...engagement(fixture.id, `press-${d.key}`, who, "correction"),
      quoted: { personaHandle: who.handle, text: original.text },
    });
  }

  return posts
    .sort((a, b) => b.second - a.second || (b.kind === "correction" ? 1 : 0) - (a.kind === "correction" ? 1 : 0) || a.id.localeCompare(b.id));
}
