// Fan View presentation helpers: preferences, favourite resolution, feed priority, "what changed" and alerts.
// Pure functions so the browser and the server share one definition and tests run without a DOM.
import { latestRevisions, eventSecondOf, type HighlightClip } from "./highlights.js";
import { filterByPeriod, isMatchPeriod, periodBoundary } from "./periods.js";
import type { ClaimSource, Localized, Storyline, VerifiedFact } from "./platform.js";
import type { Language, MatchEvent, MatchFixture, MatchPeriod, Player, TeamId } from "./types.js";
import { HIGH_XG_SHOT_THRESHOLD, illustrativeXg } from "./xg.js";

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
  /** Which quiet in-page alerts the fan wants. Missing means the defaults (all on). */
  alerts?: FanAlertPrefs;
}

export interface FanAlertPrefs {
  /** Your favourite player's actions (shots, saves, cards, substitutions). */
  player: boolean;
  goals: boolean;
  /** Shots at or above the illustrative xG threshold. */
  chances: boolean;
  cards: boolean;
  /** Producer-approved moments. */
  stories: boolean;
}

export const DEFAULT_FAN_ALERT_PREFS: Readonly<FanAlertPrefs> = Object.freeze({ player: true, goals: true, chances: true, cards: true, stories: true });
const ALERT_PREF_KEYS = ["player", "goals", "chances", "cards", "stories"] as const;

export function alertPrefsOf(prefs: Pick<FanPrefs, "alerts">): FanAlertPrefs {
  return { ...DEFAULT_FAN_ALERT_PREFS, ...(prefs.alerts ?? {}) };
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
  if (isRecord(value.alerts)) {
    const stored = value.alerts;
    prefs.alerts = Object.fromEntries(ALERT_PREF_KEYS.map((key) => [key, typeof stored[key] === "boolean" ? stored[key] : DEFAULT_FAN_ALERT_PREFS[key]])) as unknown as FanAlertPrefs;
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

// ---------------------------------------------------------------- producer-approved moment cards

export type FanMomentStatus = "approved" | "corrected";

export interface FanMomentEvidence {
  id: string;
  text: string;
  sources: ClaimSource[];
}

export interface FanMoment {
  id: string;
  version: number;
  minute: number;
  priority: number;
  status: FanMomentStatus;
  headline: string;
  /** The producer-approved on-air line: why the moment matters. */
  whyItMatters: string;
  /** True when the copy fell back to English because no translation exists yet. */
  fallback: boolean;
  /** Why the moment was corrected (retraction reason or insight note). */
  correction?: string;
  evidence: FanMomentEvidence[];
  eventIds: string[];
  teamId?: TeamId;
  playerId?: string;
}

type MomentStoryline = Pick<Storyline, "id" | "status" | "version" | "triggerMinute" | "triggerEventIds" | "priority" | "headline" | "onAirLine" | "claims"
  | "approvedAt" | "retractionReason" | "insightStatus" | "insightNote">;

function localized(value: Localized | undefined, language: Language): { text: string; fallback: boolean } {
  const own = value?.[language]?.trim();
  if (own) return { text: own, fallback: false };
  const english = value?.en?.trim() ?? "";
  return { text: english, fallback: language !== "en" && english.length > 0 };
}

/** Public visibility for Fan View: approved copy, or copy that was approved and has since been withdrawn. */
export function isFanVisibleStoryline(storyline: Pick<Storyline, "status" | "approvedAt">): boolean {
  return storyline.status === "approved" || (storyline.status === "retracted" && Boolean(storyline.approvedAt));
}

export function isCorrectedStoryline(storyline: Pick<Storyline, "status" | "insightStatus">): boolean {
  return storyline.status === "retracted" || storyline.insightStatus === "withdrawn";
}

/**
 * Moment cards for Fan View: producer-approved storylines only (drafts never appear), newest first.
 * Withdrawn moments stay visible, marked as corrected. Nothing after `uptoSecond` is shown.
 */
export function fanMoments(
  storylines: MomentStoryline[],
  events: MatchEvent[],
  language: Language = "en",
  uptoSecond = Number.POSITIVE_INFINITY,
  facts: Pick<VerifiedFact, "id" | "storylineId" | "text" | "sources" | "retracted">[] = [],
): FanMoment[] {
  const byId = new Map(latestRevisions(events).map((event) => [event.id, event]));
  return storylines
    .filter(isFanVisibleStoryline)
    .filter((storyline) => withinClock(storyline, byId, uptoSecond))
    .map((storyline): FanMoment => {
      const headline = localized(storyline.headline, language);
      const line = localized(storyline.onAirLine, language);
      const corrected = isCorrectedStoryline(storyline);
      const trigger = storyline.triggerEventIds.map((id) => byId.get(id)).find((event): event is MatchEvent => Boolean(event));
      const claims = storyline.claims.filter((claim) => claim.status === "verified").map((claim) => ({ id: claim.id, text: localized(claim.text, language).text, sources: claim.sources }));
      const extraFacts = facts
        .filter((fact) => fact.storylineId === storyline.id && !fact.retracted && !claims.some((claim) => claim.text === localized(fact.text, language).text))
        .map((fact) => ({ id: fact.id, text: localized(fact.text, language).text, sources: fact.sources }));
      const correction = corrected ? (storyline.retractionReason ?? storyline.insightNote ?? "The producer withdrew this moment after a correction.") : undefined;
      return {
        id: storyline.id,
        version: storyline.version,
        minute: storyline.triggerMinute,
        priority: storyline.priority,
        status: corrected ? "corrected" : "approved",
        headline: headline.text,
        whyItMatters: line.text,
        fallback: headline.fallback || line.fallback,
        ...(correction ? { correction } : {}),
        evidence: [...claims, ...extraFacts].filter((item) => item.text.length > 0),
        eventIds: [...storyline.triggerEventIds],
        ...(trigger ? { teamId: trigger.teamId, playerId: trigger.playerId } : {}),
      };
    })
    .sort((a, b) => b.minute - a.minute || b.priority - a.priority || a.id.localeCompare(b.id));
}

function withinClock(storyline: Pick<Storyline, "triggerMinute" | "triggerEventIds">, byId: Map<string, MatchEvent>, uptoSecond: number): boolean {
  if (storyline.triggerMinute * 60 > uptoSecond) return false;
  return storyline.triggerEventIds.every((id) => {
    const event = byId.get(id);
    return !event || eventSecondOf(event) <= uptoSecond;
  });
}

/** Public credits for a moment card, served read-only by GET /api/fan/moments. */
export interface FanMomentCredit {
  id: string;
  version: number;
  status: "approved" | "retracted";
  /** Agent roles that completed a step for this storyline, in pipeline order. No trace detail is exposed. */
  agents: string[];
  /** The agent that drafted the on-air copy, when the producer agent completed the draft. */
  author?: string;
}

/** "Written by … · checked by … · approved by the producer" for a moment card. */
export function momentCreditLine(credit: Pick<FanMomentCredit, "agents" | "author"> | undefined): string {
  if (!credit) return "Written by the desk agents · approved by the human producer";
  const author = credit.author ? `the ${agentLabel(credit.author)}` : "the desk agents";
  const checked = credit.agents.includes("fact-checker") ? " · checked by the Fact-checker" : "";
  return `Written by ${author}${checked} · approved by the human producer`;
}

/** Desk agent roles shown on a moment card, in pipeline order. */
export const FAN_AGENT_LABEL: Record<string, string> = {
  researcher: "Researcher",
  "tactics-analyst": "Tactics analyst",
  "player-analyst": "Player analyst",
  verifier: "Verifier",
  producer: "Producer agent",
  "fact-checker": "Fact-checker",
  localizer: "Localizer",
  director: "Director",
};

export function agentLabel(role: string): string {
  return FAN_AGENT_LABEL[role] ?? role.replace(/[-_]+/gu, " ").replace(/^./u, (char) => char.toUpperCase());
}

// ---------------------------------------------------------------- join-late catch-up

export interface CatchUpMoment {
  key: string;
  minute: number;
  second: number;
  source: "approved" | "feed";
  title: string;
  detail: string;
  storylineId?: string;
  eventId?: string;
  teamId?: TeamId;
}

export interface CatchUp {
  /** The minute the catch-up is written up to. Nothing after it is ever included. */
  minute: number;
  lines: [string, string, string];
  /** Up to three biggest moments, chronological. */
  moments: CatchUpMoment[];
}

export interface CatchUpInput {
  fixture: Pick<MatchFixture, "home" | "away" | "events">;
  storylines: MomentStoryline[];
  currentSecond: number;
  language?: Language;
}

/** Illustrative xG for a shot: the feed value when present, otherwise the location-only model. */
export function shotXg(event: Pick<MatchEvent, "xg" | "x" | "y">): number {
  return event.xg ?? illustrativeXg(event.x, event.y);
}

export function isHighXgShot(event: MatchEvent): boolean {
  return event.type === "shot" && event.outcome !== "success" && shotXg(event) >= HIGH_XG_SHOT_THRESHOLD;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Instant catch-up for a fan who arrives late. Built only from the verified event feed and producer-approved
 * storylines, up to `currentSecond`. Never calls a model and never reveals anything after the current minute.
 */
export function buildCatchUp({ fixture, storylines, currentSecond, language = "en" }: CatchUpInput): CatchUp {
  const upto = Math.max(0, Math.floor(currentSecond));
  const minute = Math.floor(upto / 60);
  const events = latestRevisions(fixture.events).filter((event) => eventSecondOf(event) <= upto);
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player.name]));
  const nameOf = (id: string) => players.get(id) ?? "Unknown player";
  const team = (teamId: TeamId) => fixture[teamId].name;

  const goals = events.filter((event) => event.type === "goal" && !event.rescinded);
  const score = { home: goals.filter((goal) => goal.teamId === "home").length, away: goals.filter((goal) => goal.teamId === "away").length };
  const scorers = goals.map((goal) => `${nameOf(goal.playerId)} ${goal.minute}'`).join(", ");
  const line1 = `${team("home")} ${score.home}–${score.away} ${team("away")} after ${minute}'.${goals.length ? ` Goals: ${scorers}.` : " No goals yet."}`;

  const highXg = events.filter(isHighXgShot);
  const bookings = events.filter((event) => event.type === "yellow_card" && !event.rescinded).length;
  const reds = events.filter((event) => event.type === "red_card" && !event.rescinded);
  const line2 = `${plural(highXg.length, "high illustrative xG shot", "high illustrative xG shots")} without a goal · ${plural(bookings, "booking", "bookings")} · ${reds.length ? reds.map((red) => `red card for ${nameOf(red.playerId)} ${red.minute}'`).join(", ") : "no red cards"}.`;

  const moments = fanMoments(storylines, fixture.events, language, upto);
  const approved = moments.filter((moment) => moment.status === "approved");
  const corrected = moments.length - approved.length;
  const top = approved.slice().sort((a, b) => b.priority - a.priority || b.minute - a.minute)[0];
  const sentence = (text: string) => (/[.!?…]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`);
  const line3 = (top ? `Producer-approved: ${sentence(top.headline)}` : "No producer-approved moments yet.")
    + (corrected ? ` ${plural(corrected, "moment was", "moments were")} corrected.` : "");

  const covered = new Set(approved.flatMap((moment) => moment.eventIds));
  const byId = new Map(events.map((event) => [event.id, event]));
  const ranked: Array<CatchUpMoment & { weight: number }> = approved.map((moment) => {
    const trigger = moment.eventIds.map((id) => byId.get(id)).find(Boolean);
    const major = trigger && (trigger.type === "goal" || trigger.type === "red_card") ? 40 : 0;
    return {
      key: `story:${moment.id}`, minute: moment.minute, second: trigger ? eventSecondOf(trigger) : moment.minute * 60, source: "approved",
      title: moment.headline, detail: moment.whyItMatters, storylineId: moment.id, ...(moment.teamId ? { teamId: moment.teamId } : {}),
      weight: 60 + major + Math.max(0, Math.min(10, moment.priority)),
    };
  });
  for (const event of events) {
    if (covered.has(event.id) || event.rescinded) continue;
    let weight = 0;
    let title = "";
    if (event.type === "goal") { weight = 100; title = `Goal: ${nameOf(event.playerId)} (${team(event.teamId)})`; }
    else if (event.type === "red_card") { weight = 90; title = `Red card: ${nameOf(event.playerId)} (${team(event.teamId)})`; }
    else if (isHighXgShot(event)) { weight = 50 + shotXg(event) * 10; title = `High illustrative xG shot: ${nameOf(event.playerId)} (${team(event.teamId)})`; }
    if (!weight) continue;
    ranked.push({
      key: `event:${event.id}`, minute: event.minute, second: eventSecondOf(event), source: "feed", title,
      detail: event.type === "shot" ? `${shotXg(event).toFixed(2)} illustrative xG · ${event.outcome}` : "From the verified match feed.",
      eventId: event.id, teamId: event.teamId, weight,
    });
  }
  const picked = ranked
    .filter((item) => item.second <= upto && item.minute <= minute)
    .sort((a, b) => b.weight - a.weight || b.second - a.second)
    .slice(0, 3)
    .sort((a, b) => a.second - b.second)
    .map(({ weight: _weight, ...item }) => item);
  return { minute, lines: [line1, line2, line3], moments: picked };
}

// ---------------------------------------------------------------- quiet major-moment alerts

export type FanAlertKind = "goal" | "high_xg_shot" | "card" | "story" | "player";

export interface FanAlert {
  /** Stable per moment (event or storyline ID), so a revision never creates a duplicate alert. */
  key: string;
  /** Changes only when the meaning changes (approved -> corrected). */
  signature: string;
  kind: FanAlertKind;
  minute: number;
  second: number;
  title: string;
  detail: string;
  corrected: boolean;
  correction?: string;
  yourPlayer: boolean;
  playerId?: string;
  teamId?: TeamId;
  eventId?: string;
  storylineId?: string;
}

export interface FanAlertInput {
  events: MatchEvent[];
  storylines: MomentStoryline[];
  players: ReadonlyMap<string, { name: string }>;
  teamNames: Record<TeamId, string>;
  favoritePlayerId?: string;
  prefs: FanAlertPrefs;
  uptoSecond?: number;
  language?: Language;
}

const KIND_TITLE: Record<Exclude<FanAlertKind, "player" | "card" | "story">, string> = { goal: "Goal", high_xg_shot: "High illustrative xG shot" };

/** Every alertable moment the fan's preferences allow, one per event or storyline. */
export function fanAlertCandidates({ events, storylines, players, teamNames, favoritePlayerId, prefs, uptoSecond = Number.POSITIVE_INFINITY, language = "en" }: FanAlertInput): FanAlert[] {
  const name = (id: string) => players.get(id)?.name ?? "Unknown player";
  const playerMoments = new Set(newPlayerAlerts(events, favoritePlayerId, new Set()).map((event) => event.id));
  const out: FanAlert[] = [];
  for (const event of latestRevisions(events)) {
    const second = eventSecondOf(event);
    if (second > uptoSecond) continue;
    const yourPlayer = Boolean(favoritePlayerId) && event.playerId === favoritePlayerId;
    let kind: FanAlertKind | undefined;
    let title = "";
    if (event.type === "goal" && prefs.goals) { kind = "goal"; title = KIND_TITLE.goal; }
    else if ((event.type === "yellow_card" || event.type === "red_card") && prefs.cards) { kind = "card"; title = event.type === "red_card" ? "Red card" : "Booking"; }
    else if (event.type === "shot" && prefs.chances && event.outcome !== "success" && shotXg(event) >= HIGH_XG_SHOT_THRESHOLD) { kind = "high_xg_shot"; title = KIND_TITLE.high_xg_shot; }
    if (!kind && yourPlayer && prefs.player && playerMoments.has(event.id)) { kind = "player"; title = event.type.replace(/_/gu, " ").replace(/^./u, (char) => char.toUpperCase()); }
    if (!kind) continue;
    const corrected = Boolean(event.rescinded);
    const detail = `${name(event.playerId)} · ${teamNames[event.teamId]}${kind === "high_xg_shot" ? ` · ${shotXg(event).toFixed(2)} illustrative xG` : ""}`;
    out.push({
      key: `event:${event.id}`, signature: corrected ? "corrected" : "ok", kind, minute: event.minute, second, title, detail, corrected,
      ...(corrected ? { correction: event.type === "goal" ? "Goal ruled out after review." : "This moment was corrected in the match feed." } : {}),
      yourPlayer, playerId: event.playerId, teamId: event.teamId, eventId: event.id,
    });
  }
  if (prefs.stories) {
    for (const moment of fanMoments(storylines, events, language, uptoSecond)) {
      const corrected = moment.status === "corrected";
      out.push({
        key: `story:${moment.id}`, signature: corrected ? "corrected" : "ok", kind: "story", minute: moment.minute, second: moment.minute * 60,
        title: "Producer-approved moment", detail: moment.headline, corrected, ...(moment.correction ? { correction: moment.correction } : {}),
        yourPlayer: Boolean(favoritePlayerId) && moment.playerId === favoritePlayerId, storylineId: moment.id,
        ...(moment.playerId ? { playerId: moment.playerId } : {}), ...(moment.teamId ? { teamId: moment.teamId } : {}),
      });
    }
  }
  return out.sort((a, b) => a.second - b.second || a.key.localeCompare(b.key));
}

export interface ReconcileResult {
  alerts: FanAlert[];
  seen: Record<string, string>;
  /** Text for a polite live region: the newest alert or correction, if any. */
  announcement?: string;
}

/**
 * Deduplicates alerts and applies corrections. `seen` maps alert key to the last signature the fan was shown.
 * - With `prime`, everything already present is marked seen silently (opening the view never floods alerts).
 * - A new key raises one alert, unless the moment is already corrected (nothing to correct for the fan).
 * - A seen key whose signature turns "corrected" updates the visible alert in place, or adds a correction.
 * - Dismissed alerts stay dismissed: their keys remain in `seen`.
 */
export function reconcileFanAlerts(current: FanAlert[], candidates: FanAlert[], seen: Record<string, string>, options: { prime?: boolean; limit?: number } = {}): ReconcileResult {
  const limit = options.limit ?? 5;
  const nextSeen = { ...seen };
  let alerts = [...current];
  let announcement: string | undefined;
  for (const candidate of candidates) {
    const previous = nextSeen[candidate.key];
    nextSeen[candidate.key] = candidate.signature;
    // Refresh a visible alert in place (e.g. it now involves the newly chosen favourite) without re-announcing it.
    const visible = alerts.findIndex((alert) => alert.key === candidate.key);
    if (visible >= 0 && previous === candidate.signature) alerts[visible] = candidate;
    if (options.prime || previous === candidate.signature) continue;
    if (previous === undefined) {
      if (candidate.corrected) continue;
      alerts = [candidate, ...alerts.filter((alert) => alert.key !== candidate.key)];
      announcement = `${candidate.title} ${candidate.minute}': ${candidate.detail}`;
    } else if (candidate.corrected) {
      const index = alerts.findIndex((alert) => alert.key === candidate.key);
      if (index >= 0) alerts[index] = candidate;
      else alerts = [candidate, ...alerts];
      announcement = `Correction ${candidate.minute}': ${candidate.title}. ${candidate.correction ?? ""}`.trim();
    }
  }
  return { alerts: alerts.slice(0, limit), seen: nextSeen, ...(announcement ? { announcement } : {}) };
}