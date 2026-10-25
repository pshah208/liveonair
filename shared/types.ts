export type TeamId = "home" | "away";
export type Persona = "analyst" | "casual" | "player";
export type Language = "en" | "es" | "fr" | "pt";
export const EVENT_TYPES = [
  "pass",
  "shot",
  "goal",
  "save",
  "tackle",
  "interception",
  "ball_recovery",
  "pressure",
  "corner",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "kickoff",
  "halftime",
  "fulltime",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface Player {
  id: string;
  name: string;
  number: number;
  position: string;
  teamId: TeamId;
  /** Global synthetic archive person ID (stable across matches and clubs). */
  archiveId?: string;
}

export interface Team {
  id: TeamId;
  name: string;
  shortName: string;
  players: Player[];
  /** Global synthetic archive club ID. */
  archiveClubId?: string;
}

export interface MatchEvent {
  id: string;
  revision: number;
  minute: number;
  second: number;
  type: EventType;
  teamId: TeamId;
  playerId: string;
  outcome: "success" | "fail" | "miss" | "blocked" | "saved" | "complete" | "incomplete" | "none";
  x: number;
  y: number;
  endX?: number;
  endY?: number;
  xg?: number;
  relatedEventId?: string;
  rescinded?: boolean;
  /** Explicit half from the source feed. Wins over any clock-based inference. */
  period?: 1 | 2;
  /** Ball travel time for this event's own delivery (pass, corner, shot), in milliseconds. Synthetic in built-in fixtures. */
  flightMs?: number;
  /** Measured ball speed for a shot, in km/h. Synthetic in built-in fixtures. */
  speedKmh?: number;
}

/** One coarse tracking sample: the interval (second - cadence, second] for one player. */
export interface TrackingSample {
  playerId: string;
  /** End of the interval on the match clock. */
  second: number;
  /** Distance covered within the interval, in metres. */
  distanceM: number;
  /** Peak speed reached within the interval, in km/h. */
  speedKmh: number;
}

/** Optional player tracking attached to a fixture. Built-in fixtures carry seeded synthetic samples only. */
export interface SyntheticTracking {
  source: "synthetic";
  cadenceSeconds: number;
  samples: TrackingSample[];
}

export type MatchPeriod = "full" | "first" | "second";

/**
 * How a fixture's halves are known. "synthetic"/"feed": halves split at halftimeSecond on the match clock
 * (or from explicit event periods). "video_unknown": clip-local clock, halves cannot be established.
 */
export interface FixturePeriods {
  source: "synthetic" | "feed" | "video_unknown";
  halftimeSecond?: number;
}

export interface MatchFixture {
  id: string;
  seed: number;
  title: string;
  description: string;
  home: Team;
  away: Team;
  events: MatchEvent[];
  durationSeconds: number;
  correctionEventId: string;
  correctionAvailableAt: number;
  periods?: FixturePeriods;
  /** Synthetic player tracking (distance / top speed / sprints); absent for real feeds and clips. */
  tracking?: SyntheticTracking;
}

export interface FixtureSummary {
  id: string;
  title: string;
  description: string;
  home: Team;
  away: Team;
  durationSeconds: number;
  eventCount: number;
  correctionAvailableAt: number;
}

export interface AnalysisRequest {
  fixtureId: string;
  atSecond: number;
  correction?: boolean;
  persona: Persona;
  language: Language;
  favoritePlayerId?: string;
  /** "home" | "away" or a synthetic archive club ID. Only reorders and marks stories; never changes stats or facts. */
  favoriteClubId?: string;
  /** Stats scope; defaults to the full match. The canonical score is never scoped. */
  period?: MatchPeriod;
}

export interface PeriodScope {
  period: MatchPeriod;
  available: boolean;
  reason?: "not_started" | "unavailable";
}

export interface TeamStats {
  goals: number;
  shots: number;
  passes: number;
  completedPasses: number;
  passAccuracy: number;
  corners: number;
  tackles: number;
  interceptions?: number;
  ballRecoveries?: number;
  pressureEvents: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  illustrativeXg: number;
  /** Non-rescinded shots with outcome success/saved, plus non-rescinded goals with no linked shot. Absent on older snapshots. */
  shotsOnTarget?: number;
  /** Non-rescinded save events credited to the keeper's team. Absent on older snapshots. */
  saves?: number;
  /** Possession proxy: share of both teams' attempted passes, 0–100 (teams sum to 100); null when no passes. */
  possessionPct?: number | null;
  /** Mean pass length in metres; null when unavailable (no passes or camera-frame coordinates). */
  avgPassDistanceM?: number | null;
  /** Completion % of long passes (> 30 m); null when none were attempted. */
  longPassAccuracy?: number | null;
  /** Mean pass difficulty, 0–100 (see shared/metrics.ts). */
  avgPassDifficulty?: number | null;
  /** Completed passes minus expected completions, as percentage points of attempts. */
  completionOverExpected?: number | null;
  /** Fastest shot in scope, km/h. */
  fastestShotKmh?: number | null;
}

export interface StoryMetric {
  label: string;
  value: number;
  unit?: string;
}

export interface StoryCard {
  id: string;
  kind: "pressure" | "turning_point" | "set_piece" | "player" | "rhythm";
  title: string;
  summary: string;
  whyItMatters: string;
  evidenceIds: string[];
  metrics: StoryMetric[];
  confidence: "observed" | "inferred";
  importance: number;
  windowStart: number;
  windowEnd: number;
  teamId?: TeamId;
  /** Set when the story concerns the requested favourite club (ranking emphasis only). */
  favorite?: boolean;
}

/** How the requested favourites resolved against this fixture. */
export interface SnapshotFocus {
  favoriteClubId?: string;
  favoriteTeamId?: TeamId;
  favoriteClubInMatch?: boolean;
  favoritePlayerId?: string;
  /** False when the requested favourite player is not in this match (fan streams only; never substituted). */
  favoritePlayerInMatch?: boolean;
}

export interface CorrectionNotice {
  eventId: string;
  message: string;
  previousRevision: number;
  revision: number;
}

export interface MatchSnapshot {
  fixtureId: string;
  atSecond: number;
  stateVersion: string;
  persona: Persona;
  language: Language;
  /** Canonical whole-match score so far, regardless of the selected period. */
  score: { home: number; away: number };
  /** Goals within the selected period (equals score for the full match). */
  periodScore?: { home: number; away: number };
  scope?: PeriodScope;
  focus?: SnapshotFocus;
  stats:{ home: TeamStats; away: TeamStats };
  stories: StoryCard[];
  recentEvents: MatchEvent[];
  evidence: Record<string, MatchEvent>;
  corrections: CorrectionNotice[];
  eventCount: number;
  evidenceCoverage: number;
  synthetic: true;
}

export interface AgentStep {
  role: string;
  status: "complete" | "rejected";
  detail: string;
  durationMs: number;
}

export interface NarrativeClaim {
  text: string;
  evidenceIds: string[];
}

export interface NarrativeRequest extends AnalysisRequest {
  format: "story" | "recap";
  storyId?: string;
}

export interface NarrativeResponse {
  title: string;
  script: string;
  claims: NarrativeClaim[];
  trace: AgentStep[];
  source: "foundry";
  model: string;
  stateVersion: string;
  latencyMs: number;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number };
  /** Neural-voice reading of the script, when Azure AI Speech is available. */
  audioUrl?: string;
}

export interface AppHealth {
  status: "ok";
  ai: { configured: boolean; deployment: string; authentication: string };
  version: string;
}

/** Where a post-match storyline sentence is allowed to come from. */
export type NarrativeSourceType = "match" | "history" | "news_wire" | "web";

export interface NarrativeEvidenceRef {
  type: NarrativeSourceType;
  id: string;
  label: string;
  url?: string;
  /** Synthetic news-wire items must stay labelled in the UI. */
  synthetic?: boolean;
}

export interface PostMatchStorylineCard {
  id: string;
  title: string;
  angle: string;
  narrative: string;
  evidence: NarrativeEvidenceRef[];
  sourceTypes: NarrativeSourceType[];
  /** Set when this card leads because it concerns the requested favourite. */
  favourite?: boolean;
}

export interface PostMatchWebItem {
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

export interface PostMatchWebContext {
  status: "used" | "disabled" | "unavailable" | "no_live_web_context" | "filtered";
  used: boolean;
  queries: string[];
  /** Human label. "No live web context" when search was off, failed, or yielded nothing citable. */
  label: string;
  items: PostMatchWebItem[];
}

/** POST /api/live/storylines/postmatch */
export interface PostMatchStorylinesResponse {
  headline: string;
  summary: string;
  storylines: PostMatchStorylineCard[];
  sources: NarrativeEvidenceRef[];
  webContext: PostMatchWebContext;
  language: Language;
  phase: "postmatch" | "so_far";
  audioUrl?: string;
  cached: boolean;
  model: string;
  source: "foundry" | "fallback";
  configured: boolean;
}
