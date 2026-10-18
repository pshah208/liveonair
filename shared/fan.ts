// Fan View presentation helpers: preferences, favourite resolution, feed priority, "what changed" and alerts.
// Pure functions so the browser and the server share one definition and tests run without a DOM.
import { latestRevisions, eventSecondOf, type HighlightClip } from "./highlights.js";
import { filterByPeriod, isMatchPeriod, periodBoundary } from "./periods.js";
import type { Storyline } from "./platform.js";
import type { Language, MatchEvent, MatchFixture, MatchPeriod, Player, TeamId } from "./types.js";

export const FAN_PREFS_KEY = "liveonair.fan.prefs.v1";
export const FAN_PREFS_VERSION = 1;
export const FAN_CURSOR_KEY = "liveonair.fan.cursor.v1";

/** Fan View always asks the server for the casual persona. */
export const FAN_PERSONA = "casual" as const;
const LANGUAGES: readonly Language[] = ["en", "es", "fr", "pt"];
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/u;

export interface FanFavoritePlayer {
  /** Match-local player ID at the time of selection. */
  id: string;
  /** Stable synthetic archive person ID, preferred when resolving in a later match. */
  archiveId?: string;
  name: string;
}

export interface FanPrefs {
  version: typeof FAN_PREFS_VERSION;
  language: Language;
  /** "home" | "away" (match-local) or a synthetic archive club ID (stable across matches). */
  favoriteClubId?: string;
  favoritePlayer?: FanFavoritePlayer;
  period: MatchPeriod;
}

export const DEFAULT_FAN_PREFS: FanPrefs = Object.freeze({
  version: FAN_PREFS_VERSION,
  language: "en",
  period: "full",
}) as FanPrefs;

export function isFanId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates stored preferences field by field; anything unknown or malformed falls back to the default.
 * Legacy `persona` and `followPlayer` keys from earlier versions are ignored and dropped on the next save.
 */
export function parseFanPrefs(raw: unknown): FanPrefs {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) as unknown; } catch { return { ...DEFAULT_FAN_PREFS }; }
  }
  if (!isRecord(value) || value.version !== FAN_PREFS_VERSION) return { ...DEFAULT_FAN_PREFS };
  const prefs: FanPrefs = {
    version: FAN_PREFS_VERSION,
    language: LANGUAGES.includes(value.language as Language) ? value.language as Language : DEFAULT_FAN_PREFS.language,
    period: isMatchPeriod(value.period) ? value.period : DEFAULT_FAN_PREFS.period,
  };
  if (isFanId(value.favoriteClubId)) prefs.favoriteClubId = value.favoriteClubId;
  const player = value.favoritePlayer;
  if (isRecord(player) && isFanId(player.id) && typeof player.name === "string" && player.name.trim().length > 0 && player.name.length <= 120) {
    prefs.favoritePlayer = { id: player.id, name: player.name.trim(), ...(isFanId(player.archiveId) ? { archiveId: player.archiveId } : {}) };
  }
  return prefs;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadFanPrefs(storage: StorageLike | undefined): { prefs: FanPrefs; persisted: boolean } {
  if (!storage) return { prefs: { ...DEFAULT_FAN_PREFS }, persisted: false };
  try {
    return { prefs: parseFanPrefs(storage.getItem(FAN_PREFS_KEY)), persisted: true };
  } catch {
    return { prefs: { ...DEFAULT_FAN_PREFS }, persisted: false };
  }
}

/** Returns false when storage is unavailable; callers keep the in-memory preferences. */
export function saveFanPrefs(storage: StorageLike | undefined, prefs: FanPrefs): boolean {
  if (!storage) return false;
  try {
    storage.setItem(FAN_PREFS_KEY, JSON.stringify(parseFanPrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- favourites

type TeamsOf = Pick<MatchFixture, "home" | "away">;

/** Resolves a favourite club to a side of this match; an archive club absent from the fixture is "not in this match". */
export function resolveFavoriteTeam(fixture: TeamsOf, favoriteClubId?: string): { teamId?: TeamId; inMatch: boolean } {
  if (!favoriteClubId) return { inMatch: false };
  if (favoriteClubId === "home" || favoriteClubId === "away") return { teamId: favoriteClubId, inMatch: true };
  if (fixture.home.archiveClubId === favoriteClubId) return { teamId: "home", inMatch: true };
  if (fixture.away.archiveClubId === favoriteClubId) return { teamId: "away", inMatch: true };
  return { inMatch: false };
}

/** The value to store when a fan picks a side: the stable archive club ID when the fixture has one. */
export function clubPreferenceFor(fixture: TeamsOf, teamId: TeamId): string {
  return fixture[teamId].archiveClubId ?? teamId;
}

/** Resolves a stored favourite player against this fixture. Never substitutes a different player. */
export function resolveFavoritePlayer(fixture: TeamsOf, favorite?: FanFavoritePlayer): { player?: Player; inMatch: boolean } {
  if (!favorite) return { inMatch: false };
  const players = [...fixture.home.players, ...fixture.away.players];
  const byArchive = favorite.archiveId ? players.find((player) => player.archiveId === favorite.archiveId) : undefined;
  if (byArchive) return { player: byArchive, inMatch: true };
  // Match-local IDs are only trusted when no archive identity says otherwise.
  const byId = players.find((player) => player.id === favorite.id && (!favorite.archiveId || !player.archiveId || player.archiveId === favorite.archiveId));
  return byId ? { player: byId, inMatch: true } : { inMatch: false };
}

export function favoritePlayerOf(player: Player): FanFavoritePlayer {
  return { id: player.id, name: player.name, ...(player.archiveId ? { archiveId: player.archiveId } : {}) };
}

// ---------------------------------------------------------------- feed

export interface FanFocus {
  teamId?: TeamId;
  playerId?: string;
}

export type FanRelevance = "player" | "club" | "essential" | "other";

export interface FanFeedItem {
  event: MatchEvent;
  relevance: FanRelevance;
  /** Goals, ruled-out goals and red cards for either side: never filtered out. */
  essential: boolean;
}

const META_TYPES = new Set<MatchEvent["type"]>(["kickoff", "halftime", "fulltime"]);
const NOTABLE_TYPES = new Set<MatchEvent["type"]>(["goal", "shot", "save", "yellow_card", "red_card", "corner", "substitution"]);

export function isEssentialEvent(event: MatchEvent): boolean {
  return event.type === "goal" || event.type === "red_card";
}

export function fanRelevance(event: MatchEvent, focus: FanFocus): FanRelevance {
  if (focus.playerId && event.playerId === focus.playerId) return "player";
  if (focus.teamId && event.teamId === focus.teamId) return "club";
  return isEssentialEvent(event) ? "essential" : "other";
}

/**
 * "My match" feed: latest revision of each event, newest first. With a favourite, only their moments plus
 * goals, ruled-out goals and red cards for both sides are kept. Without one, notable events for both sides.
 * The limit never drops an essential event.
 */
export function prioritiseFanFeed(events: MatchEvent[], focus: FanFocus, limit = 20): FanFeedItem[] {
  const hasFocus = Boolean(focus.teamId || focus.playerId);
  const items = latestRevisions(events)
    .filter((event) => !META_TYPES.has(event.type))
    .map((event): FanFeedItem => ({ event, relevance: fanRelevance(event, focus), essential: isEssentialEvent(event) }))
    .filter((item) => {
      if (item.essential) return true;
      if (item.relevance === "player") return true;
      if (item.relevance === "club") return NOTABLE_TYPES.has(item.event.type) || item.event.type === "tackle";
      return !hasFocus && NOTABLE_TYPES.has(item.event.type);
    })
    .sort((a, b) => eventSecondOf(b.event) - eventSecondOf(a.event) || b.event.revision - a.event.revision);
  const essentials = items.filter((item) => item.essential);
  const rest = items.filter((item) => !item.essential).slice(0, Math.max(0, limit - essentials.length));
  const keep = new Set([...essentials, ...rest]);
  return items.filter((item) => keep.has(item));
}

/** A player's logged actions (latest revisions) in the selected period, chronological. */
export function playerTimeline(fixture: MatchFixture, playerId: string, period: MatchPeriod = "full", uptoSecond = Number.POSITIVE_INFINITY): MatchEvent[] {
  const events = latestRevisions(fixture.events).filter((event) => eventSecondOf(event) <= uptoSecond);
  const boundary = periodBoundary(fixture);
  if (period !== "full" && !boundary.available) return [];
  return filterByPeriod(events, period, boundary).filter((event) => event.playerId === playerId && !META_TYPES.has(event.type));
}

/** Fan moments: highlight clips for the favourite player or club; everything when no favourite is set. */
export function isFanMoment(clip: Pick<HighlightClip, "teamId" | "playerId">, focus: FanFocus): boolean {
  if (!focus.teamId && !focus.playerId) return true;
  return (Boolean(focus.playerId) && clip.playerId === focus.playerId) || (Boolean(focus.teamId) && clip.teamId === focus.teamId);
}

// ---------------------------------------------------------------- what changed since you last looked

export interface FanCursor {
  matchId: string;
  /** Latest seen revision per event ID. */
  events: Record<string, number>;
  /** Seen version per approved/retracted storyline ID. */
  storylines: Record<string, number>;
  at: string;
}

export type FanChangeKind = "goal" | "ruled_out" | "red_card" | "booking" | "correction" | "story" | "story_retracted";

export interface FanChange {
  kind: FanChangeKind;
  id: string;
  minute: number;
  teamId?: TeamId;
  playerId?: string;
  storylineId?: string;
}

type StorylineView = Pick<Storyline, "id" | "status" | "version" | "triggerMinute">;

export function createFanCursor(matchId: string, events: MatchEvent[], storylines: StorylineView[], at = new Date().toISOString()): FanCursor {
  return {
    matchId,
    events: Object.fromEntries(latestRevisions(events).map((event) => [event.id, event.revision])),
    storylines: Object.fromEntries(storylines.filter((item) => item.status === "approved" || item.status === "retracted").map((item) => [item.id, item.version])),
    at,
  };
}

export function parseFanCursor(raw: unknown): FanCursor | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) as unknown; } catch { return null; }
  }
  if (!isRecord(value) || !isFanId(value.matchId) || !isRecord(value.events) || !isRecord(value.storylines) || typeof value.at !== "string") return null;
  const numbers = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry))) as Record<string, number>;
  return { matchId: value.matchId, events: numbers(value.events), storylines: numbers(value.storylines), at: value.at };
}

/** Significant changes since the cursor; empty for a different match (the cursor belongs to another game). */
export function changesSince(cursor: FanCursor | null, matchId: string, events: MatchEvent[], storylines: StorylineView[]): FanChange[] {
  if (!cursor || cursor.matchId !== matchId) return [];
  const changes: FanChange[] = [];
  for (const event of latestRevisions(events)) {
    const seen = cursor.events[event.id];
    const base = { id: `${event.id}@${event.revision}`, minute: event.minute, teamId: event.teamId, playerId: event.playerId };
    if (seen === undefined) {
      if (event.type === "goal") changes.push({ ...base, kind: event.rescinded ? "ruled_out" : "goal" });
      else if (event.type === "red_card") changes.push({ ...base, kind: "red_card" });
      else if (event.type === "yellow_card") changes.push({ ...base, kind: "booking" });
    } else if (event.revision > seen) {
      changes.push({ ...base, kind: event.type === "goal" && event.rescinded ? "ruled_out" : "correction" });
    }
  }
  for (const storyline of storylines) {
    const seen = cursor.storylines[storyline.id];
    if (storyline.status === "approved" && (seen === undefined || storyline.version > seen)) {
      changes.push({ kind: "story", id: `${storyline.id}@${storyline.version}`, minute: storyline.triggerMinute, storylineId: storyline.id });
    } else if (storyline.status === "retracted" && seen !== undefined && storyline.version > seen) {
      changes.push({ kind: "story_retracted", id: `${storyline.id}@${storyline.version}`, minute: storyline.triggerMinute, storylineId: storyline.id });
    }
  }
  return changes.sort((a, b) => a.minute - b.minute);
}

// ---------------------------------------------------------------- favourite-player alerts (in-app only)

const ALERT_TYPES = new Set<MatchEvent["type"]>(["goal", "shot", "save", "yellow_card", "red_card", "substitution"]);

export function alertKey(event: Pick<MatchEvent, "id" | "revision">): string {
  return `${event.id}@${event.revision}`;
}

/** New alertable moments for the favourite player, deduplicated by event ID and revision. */
export function newPlayerAlerts(events: MatchEvent[], playerId: string | undefined, seen: ReadonlySet<string>): MatchEvent[] {
  if (!playerId) return [];
  return latestRevisions(events).filter((event) => event.playerId === playerId && ALERT_TYPES.has(event.type) && !seen.has(alertKey(event)));
}
