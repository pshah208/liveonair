// Fan View card engine: pure, DOM-free helpers behind the Player card, Match in numbers, Big moment and
// Player-of-the-match vote cards. Everything is derived from the same logged events as the rest of the app.
// All pitch coordinates stay on the canonical 105x68 frame; flipping is a render-time concern.
import { latestRevisions } from "./highlights.js";
import { isCameraFixture } from "./ballPath.js";
import { toMetres } from "./metrics.js";
import type { ChanceInsight, ChanceSequence, TerritoryContext } from "./chanceSequence.js";
import { analysePlayers, type PlayerAnalysis } from "./playerStats.js";
import type { Localized, Storyline } from "./platform.js";
import type { Language, MatchEvent, MatchFixture, Player, TeamId } from "./types.js";

export const MIN_PASSES_TO_RANK = 10;
export const MAX_PLAYER_CARD_ROWS = 8;
export const MIN_PLAYER_CARD_ROWS = 5;
export const RANK_ANNOUNCE_INTERVAL_MS = 10_000;
export const VOTE_OPENS_SECOND = 60 * 60;
export const FAN_VOTE_KEY = "liveonair.fan.vote.v1";
export const QUIET_CARD_MESSAGE = "A quiet one on the stats sheet. Not much logged yet.";
export const SYNTHETIC_FOOTER = "Synthetic demo data · Live on Air";

// ---------------------------------------------------------------- ordinals

const EN_WORDS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** Ordinal text per language (en/es/fr/pt); anything else falls back to English. */
export function ordinal(n: number, language: Language = "en"): string {
  if (language === "es" || language === "pt") return `${n}º`;
  if (language === "fr") return n === 1 ? "1er" : `${n}e`;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Visible rank text: "2nd", joint "T-2nd" (other languages: "=2º"), or an em dash when unranked. */
export function rankText(stat: Pick<RankedStat, "rank" | "tied">, language: Language = "en"): string {
  if (stat.rank === null) return "—";
  const text = ordinal(stat.rank, language);
  if (!stat.tied) return text;
  return language === "en" ? `T-${text}` : `=${text}`;
}

/** Screen-reader rank text: "second", "joint second". */
export function rankAria(stat: Pick<RankedStat, "rank" | "tied">, language: Language = "en"): string {
  if (stat.rank === null) return "not ranked";
  const word = language === "en" && stat.rank < EN_WORDS.length ? EN_WORDS[stat.rank]! : ordinal(stat.rank, language);
  if (!stat.tied) return word;
  switch (language) {
    case "es": return `empatado en ${word}`;
    case "fr": return `ex æquo ${word}`;
    case "pt": return `empatado em ${word}`;
    default: return `joint ${word}`;
  }
}

// ---------------------------------------------------------------- ranking

export interface RankedStat {
  key: string;
  label: string;
  value: number | null;
  display: string;
  rank: number | null;
  /** Players with a non-null value for this stat. */
  of: number;
  tied: boolean;
  note?: string;
}

/** Competition ranking (1, 2, 2, 4): higher is better; null values are not ranked. */
export function competitionRanks(values: ReadonlyArray<number | null>): Array<{ rank: number | null; tied: boolean }> {
  return values.map((value) => {
    if (value === null || !Number.isFinite(value)) return { rank: null, tied: false };
    let better = 0;
    let equal = 0;
    for (const other of values) {
      if (other === null || !Number.isFinite(other)) continue;
      if (other > value) better += 1;
      else if (other === value) equal += 1;
    }
    return { rank: better + 1, tied: equal > 1 };
  });
}

type StatGroup = "GK" | "DEF" | "MID" | "ATT";

/** Maps a free-text position onto a coarse role; unknown positions are treated as midfield. */
export function positionGroup(position: string): StatGroup {
  const value = position.trim().toUpperCase();
  if (value === "GK" || value === "G") return "GK";
  if (["DF", "D", "CB", "RB", "LB", "RWB", "LWB", "SW"].includes(value)) return "DEF";
  if (["FW", "F", "ST", "CF", "RW", "LW", "SS"].includes(value)) return "ATT";
  return "MID";
}

interface StatDef {
  key: string;
  label: string;
  kind: "count" | "metric";
  /** Raw value for the pool; null = not rankable for this player. */
  get: (analysis: PlayerAnalysis) => number | null;
  display: (value: number, analysis: PlayerAnalysis) => string;
  nullNote?: string;
  gkOnly?: boolean;
}

const int = (value: number) => String(Math.round(value));

const STAT_DEFS: Record<string, StatDef> = {
  goals: { key: "goals", label: "Goals", kind: "count", get: (a) => a.goals, display: int },
  shots: { key: "shots", label: "Shots", kind: "count", get: (a) => a.shots, display: int },
  shotsOnTarget: { key: "shotsOnTarget", label: "Shots on target", kind: "count", get: (a) => a.shotsOnTarget, display: int },
  chances: { key: "chances", label: "Chances created", kind: "count", get: (a) => a.keyPasses, display: int },
  passesCompleted: { key: "passesCompleted", label: "Passes completed", kind: "count", get: (a) => a.passesCompleted, display: int },
  passAccuracy: {
    key: "passAccuracy",
    label: "Pass accuracy",
    kind: "metric",
    get: (a) => (a.passes >= MIN_PASSES_TO_RANK ? a.passAccuracy : null),
    display: (value) => `${Math.round(value)}%`,
    nullNote: "Too few passes to rank",
  },
  tacklesWon: { key: "tacklesWon", label: "Tackles won", kind: "count", get: (a) => a.tacklesWon, display: int },
  saves: { key: "saves", label: "Saves", kind: "count", get: (a) => a.saves, display: int, gkOnly: true },
  hardestPass: {
    key: "hardestPass",
    label: "Hardest pass",
    kind: "metric",
    get: (a) => a.hardestCompletedPass?.difficulty ?? null,
    display: (value, a) => (a.hardestCompletedPass && Number.isFinite(a.hardestCompletedPass.distanceM) ? `${Math.round(a.hardestCompletedPass.distanceM)} m` : value.toFixed(2)),
  },
  topSpeed: {
    key: "topSpeed",
    label: "Top speed",
    kind: "metric",
    // Synthetic tracking only; absent (never zero) otherwise.
    get: (a) => (a.trackingSource === "synthetic" && a.topSpeedKmh !== null && a.topSpeedKmh > 0 ? a.topSpeedKmh : null),
    display: (value) => `${value.toFixed(1)} km/h`,
  },
};

const ROW_ORDER: Record<StatGroup, string[]> = {
  GK: ["saves", "passesCompleted", "passAccuracy", "hardestPass", "chances", "tacklesWon", "shots", "goals", "shotsOnTarget", "topSpeed"],
  DEF: ["tacklesWon", "passesCompleted", "passAccuracy", "hardestPass", "chances", "topSpeed", "shots", "goals", "shotsOnTarget"],
  MID: ["chances", "passesCompleted", "passAccuracy", "tacklesWon", "hardestPass", "shots", "goals", "shotsOnTarget", "topSpeed"],
  ATT: ["goals", "shots", "shotsOnTarget", "chances", "passesCompleted", "passAccuracy", "hardestPass", "tacklesWon", "topSpeed"],
};

/** The shared pool: every player with at least one logged involvement. */
export function rankingPool(fixture: MatchFixture, uptoSecond = Number.POSITIVE_INFINITY): PlayerAnalysis[] {
  return analysePlayers(fixture, uptoSecond, "full").filter((entry) => entry.involvements > 0);
}

export function rankStat(def: StatDef, subject: PlayerAnalysis, pool: PlayerAnalysis[]): RankedStat {
  const values = pool.map(def.get);
  const own = def.get(subject);
  const of = values.filter((value) => value !== null).length;
  if (own === null) {
    return { key: def.key, label: def.label, value: null, display: "—", rank: null, of, tied: false, ...(def.nullNote ? { note: def.nullNote } : {}) };
  }
  if (def.kind === "count" && values.every((value) => value === 0 || value === null)) {
    return { key: def.key, label: def.label, value: 0, display: "0", rank: null, of, tied: false, note: "No one yet" };
  }
  const index = pool.findIndex((entry) => entry.player.id === subject.player.id);
  const ranks = competitionRanks(values);
  const { rank, tied } = index >= 0 ? ranks[index]! : competitionRanks([...values, own]).at(-1)!;
  return { key: def.key, label: def.label, value: own, display: def.display(own, subject), rank, of, tied, };
}

export type PlayerCardTitle = "The one and only" | "Top of the class" | "Right in the mix" | "Quiet but busy" | "Their moment is coming";

export interface PlayerCardModel {
  state: "ok" | "no-data";
  player: Player;
  teamId: TeamId;
  /** Players in the ranking pool ("N players in this match"). */
  poolSize: number;
  rows: RankedStat[];
  title: PlayerCardTitle;
  subtitle: string;
  /** Fewer than five ranked rows: show the quiet-card message. */
  quiet: boolean;
  involvements: number;
  impactRating: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Card headline from the best ranks: rank 1 in two+ stats, rank 1 in one, a 2nd/3rd, else involvement-based copy. */
export function cardTitle(rows: RankedStat[], involvements: number, medianInvolvements: number): PlayerCardTitle {
  const ranked = rows.filter((row): row is RankedStat & { rank: number } => row.rank !== null);
  const firsts = ranked.filter((row) => row.rank === 1).length;
  if (firsts >= 2) return "The one and only";
  if (firsts === 1) return "Top of the class";
  if (ranked.some((row) => row.rank <= 3)) return "Right in the mix";
  return involvements >= medianInvolvements ? "Quiet but busy" : "Their moment is coming";
}

export function buildPlayerCard(fixture: MatchFixture, playerId: string, uptoSecond = Number.POSITIVE_INFINITY): PlayerCardModel | null {
  const all = analysePlayers(fixture, uptoSecond, "full");
  const subject = all.find((entry) => entry.player.id === playerId);
  if (!subject) return null;
  const pool = all.filter((entry) => entry.involvements > 0);
  const subtitle = `${subject.player.name} among the ${pool.length} players in this match`;
  if (subject.involvements === 0) {
    return { state: "no-data", player: subject.player, teamId: subject.teamId, poolSize: pool.length, rows: [], title: "Their moment is coming", subtitle, quiet: true, involvements: 0, impactRating: subject.impact.rating };
  }
  const group = positionGroup(subject.player.position);
  const candidates = ROW_ORDER[group]
    .map((key) => STAT_DEFS[key]!)
    .filter((def) => !def.gkOnly || group === "GK")
    .map((def) => rankStat(def, subject, pool));
  const ranked = candidates.filter((row) => row.rank !== null);
  // Unrankable rows without an explanation are dropped; explained ones ("No one yet") fill any spare space.
  const explained = candidates.filter((row) => row.rank === null && row.note !== undefined);
  const rows = [...ranked, ...explained].slice(0, MAX_PLAYER_CARD_ROWS);
  const title = cardTitle(rows, subject.involvements, median(pool.map((entry) => entry.involvements)));
  return {
    state: "ok",
    player: subject.player,
    teamId: subject.teamId,
    poolSize: pool.length,
    rows,
    title,
    subtitle,
    quiet: rows.filter((row) => row.rank !== null).length < MIN_PLAYER_CARD_ROWS,
    involvements: subject.involvements,
    impactRating: subject.impact.rating,
  };
}

/** Top players by impact rating (ties: total, then involvements, then shirt number). Used for spotlight and the vote. */
export function topByImpact(fixture: MatchFixture, uptoSecond = Number.POSITIVE_INFINITY, count = 3, teamId?: TeamId): PlayerAnalysis[] {
  return rankingPool(fixture, uptoSecond)
    .filter((entry) => !teamId || entry.teamId === teamId)
    .sort((a, b) => b.impact.rating - a.impact.rating || b.impact.total - a.impact.total || b.involvements - a.involvements || a.player.number - b.player.number)
    .slice(0, count);
}

// ---------------------------------------------------------------- card chrome

export type CardPhase = "pre" | "live" | "final";

export function cardPhase(clockSecond: number, finished: boolean): CardPhase {
  if (finished) return "final";
  return clockSecond > 0 ? "live" : "pre";
}

/** "Live 63′" or "Final"; null before kickoff. */
export function phaseChip(phase: CardPhase, clockSecond: number): string | null {
  if (phase === "final") return "Final";
  if (phase === "live") return `Live ${Math.floor(clockSecond / 60)}′`;
  return null;
}

/** Throttled, polite rank-change copy: the first row whose rank changed, or null. */
export function rankChangeAnnouncement(previous: RankedStat[], next: RankedStat[], language: Language = "en"): string | null {
  for (const row of next) {
    const before = previous.find((item) => item.key === row.key);
    if (!before || before.rank === row.rank || row.rank === null) continue;
    return `${row.label}: now ${rankAria(row, language)} of ${row.of}.`;
  }
  return null;
}

export function shouldAnnounce(lastAnnouncedAt: number | null, now: number, intervalMs = RANK_ANNOUNCE_INTERVAL_MS): boolean {
  return lastAnnouncedAt === null || now - lastAnnouncedAt >= intervalMs;
}

// ---------------------------------------------------------------- kit colours + contrast

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match) return 0;
  const n = Number.parseInt(match[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const TEAM_KIT: Record<TeamId, string> = { home: "#1d4ed8", away: "#b45309" };
const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#09090b";

export interface ShirtStyle {
  fill: string;
  number: string;
  /** True when neither white nor near-black reaches 4.5:1 on the kit colour, so the number gets an outline. */
  outline: boolean;
}

/** Kit colour for a side plus a legible number colour (>= 4.5:1, else best of white/near-black with an outline). */
export function shirtStyle(teamId: TeamId, fill: string = TEAM_KIT[teamId]): ShirtStyle {
  const light = contrastRatio(fill, LIGHT_TEXT);
  const dark = contrastRatio(fill, DARK_TEXT);
  const best = light >= dark ? LIGHT_TEXT : DARK_TEXT;
  return { fill, number: best, outline: Math.max(light, dark) < 4.5 };
}

// ---------------------------------------------------------------- match in numbers

export interface HeadToHeadRow {
  key: string;
  label: string;
  home: number | null;
  away: number | null;
  homeDisplay: string;
  awayDisplay: string;
  /** Bar fill 0..1 for each side; both 0 for an empty track. */
  homeBar: number;
  awayBar: number;
  leader: TeamId | "level" | "none";
}

function headToHead(key: string, label: string, home: number | null, away: number | null, format: (value: number) => string, percent = false): HeadToHeadRow {
  const bar = (value: number | null, other: number | null): number => {
    if (value === null || value <= 0) return 0;
    if (percent) return Math.min(1, value / 100);
    const top = Math.max(value, other ?? 0);
    return top > 0 ? value / top : 0;
  };
  const empty = (home === null || home === 0) && (away === null || away === 0);
  const leader: HeadToHeadRow["leader"] = home === null && away === null ? "none"
    : empty && !percent ? "none"
    : (home ?? -1) === (away ?? -1) ? "level"
    : (home ?? -1) > (away ?? -1) ? "home" : "away";
  return {
    key, label, home, away,
    homeDisplay: home === null || (empty && !percent) ? "—" : format(home),
    awayDisplay: away === null || (empty && !percent) ? "—" : format(away),
    homeBar: bar(home, away),
    awayBar: bar(away, home),
    leader,
  };
}

/** Team totals as head-to-head rows. No possession (no data); no xG (shown only if a card labels it "Illustrative xG"). */
export function buildMatchInNumbers(fixture: MatchFixture, uptoSecond = Number.POSITIVE_INFINITY): HeadToHeadRow[] {
  const analyses = analysePlayers(fixture, uptoSecond, "full");
  const sum = (teamId: TeamId, pick: (entry: PlayerAnalysis) => number) => analyses.filter((entry) => entry.teamId === teamId).reduce((total, entry) => total + pick(entry), 0);
  const both = (pick: (entry: PlayerAnalysis) => number): [number, number] => [sum("home", pick), sum("away", pick)];
  const rows: HeadToHeadRow[] = [];
  const add = (key: string, label: string, pick: (entry: PlayerAnalysis) => number) => {
    const [h, a] = both(pick);
    rows.push(headToHead(key, label, h, a, int));
  };
  add("goals", "Goals", (e) => e.goals);
  add("shots", "Shots", (e) => e.shots);
  add("shotsOnTarget", "On target", (e) => e.shotsOnTarget);
  add("passesCompleted", "Passes completed", (e) => e.passesCompleted);
  const [hp, ap] = both((e) => e.passes);
  const [hc, ac] = both((e) => e.passesCompleted);
  rows.push(headToHead("passAccuracy", "Pass accuracy", hp > 0 ? Math.round((hc / hp) * 100) : null, ap > 0 ? Math.round((ac / ap) * 100) : null, (v) => `${v}%`, true));
  add("corners", "Corners", (e) => e.crossesAndCorners);
  add("fouls", "Fouls", (e) => e.fouls);
  add("cards", "Cards", (e) => e.yellowCards + e.redCards);
  return rows;
}

// ---------------------------------------------------------------- big moment

export interface MiniMapPoint { x: number; y: number; endX?: number; endY?: number }

export interface BigMoment {
  state: "moment" | "updated" | "empty";
  storylineId?: string;
  kind?: "goal" | "red_card" | "latest";
  minute?: number;
  headline?: string;
  teamId?: TeamId;
  playerId?: string;
  /** Metres on the shared 105x68 frame. Absent for camera fixtures. */
  map?: MiniMapPoint;
  /** True for camera fixtures, where no metric pitch location exists. */
  cameraView?: boolean;
}

export function localizedText(localized: Localized | undefined, language: Language): string {
  if (!localized) return "";
  return localized[language]?.trim() || localized.en?.trim() || "";
}

/** Truncates at a word boundary to ~max characters with an ellipsis. */
export function truncateHeadline(text: string, max = 120): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max + 1);
  const cut = slice.lastIndexOf(" ");
  const base = cut >= Math.floor(max * 0.5) ? slice.slice(0, cut) : clean.slice(0, max);
  return `${base.replace(/[\s,.;:–—-]+$/u, "")}…`;
}

const KIND_RANK = { goal: 0, red_card: 1, latest: 2 } as const;

/**
 * The single Big moment: producer-approved, non-retracted storylines only. Goals first, then red cards, then the
 * latest. A storyline whose linked goal was ruled out is skipped. When `previousId` was shown and has since been
 * retracted (and nothing replaces it), the card says the moment was updated.
 */
export function pickBigMoment(fixture: MatchFixture, storylines: Storyline[], language: Language = "en", previousId?: string): BigMoment {
  const latest = new Map(latestRevisions(fixture.events).map((event) => [event.id, event]));
  const candidates = storylines
    .filter((item) => item.status === "approved")
    .map((item) => {
      const linked = item.triggerEventIds.map((id) => latest.get(id)).filter((event): event is MatchEvent => Boolean(event));
      const goal = linked.find((event) => event.type === "goal" && !event.rescinded);
      const red = linked.find((event) => event.type === "red_card" && !event.rescinded);
      const ruledOut = linked.some((event) => event.type === "goal" && event.rescinded) && !goal;
      const kind: "goal" | "red_card" | "latest" = goal ? "goal" : red ? "red_card" : "latest";
      const primary = goal ?? red ?? linked.find((event) => !event.rescinded);
      return { item, kind, primary, ruledOut };
    })
    .filter((entry) => !entry.ruledOut)
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.item.triggerMinute - a.item.triggerMinute || b.item.version - a.item.version);
  const top = candidates[0];
  if (!top) {
    const wasRetracted = previousId !== undefined && storylines.some((item) => item.id === previousId && item.status === "retracted");
    return { state: wasRetracted ? "updated" : "empty" };
  }
  const headline = truncateHeadline(localizedText(top.item.headline, language) || localizedText(top.item.onAirLine, language));
  const event = top.primary;
  const camera = isCameraFixture(fixture);
  // Metres on the shared 105x68 frame (home attacks left to right); camera fixtures have no metric pitch location.
  const start = event ? toMetres(fixture, event) : null;
  const end = event && event.endX !== undefined && event.endY !== undefined ? toMetres(fixture, event, event.endX, event.endY) : null;
  return {
    state: "moment",
    storylineId: top.item.id,
    kind: top.kind,
    minute: top.item.triggerMinute,
    headline,
    ...(event ? {
      teamId: event.teamId,
      playerId: event.playerId,
      ...(start ? { map: { x: start.x, y: start.y, ...(end ? { endX: end.x, endY: end.y } : {}) } } : {}),
      ...(camera ? { cameraView: true } : {}),
    } : {}),
  };
}

// ---------------------------------------------------------------- chance build-up (fan copy)

export interface FanChanceChip { player: string; action: string }

export interface FanChanceCard {
  state: "chance" | "empty";
  insight?: ChanceInsight;
  teamId?: TeamId;
  isGoal: boolean;
  revised: boolean;
  headline?: string;
  chips: FanChanceChip[];
  /** Event-derived comparison with the previous window; null when there is no territory context. */
  territory: string | null;
  /** True when at least one chance insight was withdrawn after a correction. */
  withdrawnNote: boolean;
}

const ACTION_LABEL: Record<string, string> = { pass: "pass", shot: "shot", goal: "goal", corner: "corner", save: "save" };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ZONE_COPY = { defensive: "their defensive third", middle: "the middle third", final: "the final third" } as const;

/** "6 passes from their own half, 3 players involved". Descriptive, event-derived, no possession claims. */
export function chanceHeadline(sequence: ChanceSequence): string {
  const players = plural(sequence.playerIds.length, "player", "players");
  const corner = sequence.origin.type === "corner" || sequence.boundary === "corner_origin";
  const origin = corner ? "from a corner" : sequence.origin.x < 50 ? "from their own half" : `from ${ZONE_COPY[sequence.origin.zone]}`;
  if (sequence.passes === 0) return `A direct chance ${origin}, ${players} involved`;
  return `${plural(sequence.passes, "pass", "passes")} ${origin}, ${players} involved`;
}

/** Territory change for the shooting side, phrased as logged-event counts rather than possession or pressure. */
export function territoryPhrase(territory: TerritoryContext | null, teamId: TeamId | undefined): string | null {
  if (!territory || !teamId) return null;
  const delta = territory.change[teamId].attackingActionsInFinalThird;
  const minutes = Math.max(1, Math.round(territory.windowSeconds / 60));
  const base = `the previous ${minutes} min`;
  if (delta > 0) return `From logged events: more attacks in the final third than ${base}.`;
  if (delta < 0) return `From logged events: fewer attacks in the final third than ${base}.`;
  return `From logged events: about the same number of attacks in the final third as ${base}.`;
}

/**
 * The Fan View chance card: the latest non-withdrawn insight for this match. Favourite player involvement first,
 * then the favourite club's chances, then goals, then the most recent.
 */
export function buildChanceCard(
  fixture: MatchFixture,
  insights: ChanceInsight[],
  focus: { teamId?: TeamId; playerId?: string } = {},
  matchId?: string,
): FanChanceCard {
  const mine = insights.filter((item) => !matchId || item.matchId === matchId);
  const withdrawnNote = mine.some((item) => item.status === "withdrawn");
  const latest = new Map(latestRevisions(fixture.events).map((event) => [event.id, event]));
  const candidates = mine
    .filter((item) => item.status !== "withdrawn" && item.sequence !== null)
    .map((insight) => {
      const shot = latest.get(insight.sequence!.shotEventId);
      const teamId = shot?.teamId;
      const involved = Boolean(focus.playerId && insight.sequence!.playerIds.includes(focus.playerId));
      return { insight, teamId, isGoal: shot?.type === "goal", favourite: involved ? 2 : focus.teamId && teamId === focus.teamId ? 1 : 0 };
    })
    .sort((a, b) => b.favourite - a.favourite || Number(b.isGoal) - Number(a.isGoal) || b.insight.effectiveSecond - a.insight.effectiveSecond || a.insight.insightId.localeCompare(b.insight.insightId));
  const top = candidates[0];
  if (!top) return { state: "empty", isGoal: false, revised: false, chips: [], territory: null, withdrawnNote };
  const names = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player.name]));
  const sequence = top.insight.sequence!;
  return {
    state: "chance",
    insight: top.insight,
    teamId: top.teamId,
    isGoal: top.isGoal,
    revised: top.insight.status === "revised",
    headline: chanceHeadline(sequence),
    chips: sequence.steps.map((step) => ({ player: names.get(step.playerId) ?? "Unknown player", action: ACTION_LABEL[step.type] ?? step.type.replaceAll("_", " ") })),
    territory: territoryPhrase(top.insight.territory, top.teamId),
    withdrawnNote,
  };
}

// ---------------------------------------------------------------- export

export function playerCardFileName(playerId: string, matchId: string, minute: number): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 60) || "x";
  return `playercard_${safe(playerId)}_${safe(matchId)}_${Math.max(0, Math.floor(minute))}.png`;
}

// ---------------------------------------------------------------- player of the match vote (local only)

export type VotePhase = "not_open" | "open" | "locked";

export function votePhase(clockSecond: number, finished: boolean): VotePhase {
  if (finished) return "locked";
  return clockSecond >= VOTE_OPENS_SECOND ? "open" : "not_open";
}

export interface VoteCandidate { playerId: string; name: string; number: number; teamId: TeamId; rating: number }

/** Top three per team by impact rating. */
export function voteCandidates(fixture: MatchFixture, uptoSecond = Number.POSITIVE_INFINITY): Record<TeamId, VoteCandidate[]> {
  const pick = (teamId: TeamId) => topByImpact(fixture, uptoSecond, 3, teamId).map((entry) => ({
    playerId: entry.player.id, name: entry.player.name, number: entry.player.number, teamId, rating: entry.impact.rating,
  }));
  return { home: pick("home"), away: pick("away") };
}

export type VoteStore = Record<string, string>;

/** Parses stored votes ({matchId: playerId}); malformed input yields an empty store. Keeps at most 20 matches. */
export function parseVotes(raw: unknown): VoteStore {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) as unknown; } catch { return {}; }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.votes !== "object" || record.votes === null) return {};
  const out: VoteStore = {};
  for (const [matchId, playerId] of Object.entries(record.votes as Record<string, unknown>)) {
    if (/^[A-Za-z0-9:_-]{1,120}$/u.test(matchId) && typeof playerId === "string" && /^[A-Za-z0-9:_-]{1,120}$/u.test(playerId)) out[matchId] = playerId;
  }
  return Object.fromEntries(Object.entries(out).slice(-20));
}

export function serializeVotes(votes: VoteStore): string {
  return JSON.stringify({ version: 1, votes: Object.fromEntries(Object.entries(votes).slice(-20)) });
}

/** Applies a vote; refused unless the vote is open and the player is a current candidate. */
export function castVote(votes: VoteStore, matchId: string, playerId: string, phase: VotePhase, candidates: Record<TeamId, VoteCandidate[]>): VoteStore {
  if (phase !== "open") return votes;
  if (![...candidates.home, ...candidates.away].some((candidate) => candidate.playerId === playerId)) return votes;
  const { [matchId]: _previous, ...rest } = votes;
  return { ...rest, [matchId]: playerId };
}
