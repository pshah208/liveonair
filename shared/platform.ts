// Shared contracts for Live on Air v2: synthetic archive, MatchLab, live feed and Storyline Desk.
// Browser and server both import these types. Keep them serialisable JSON.
import type {
  AgentStep,
  FixtureSummary,
  Language,
  MatchEvent,
  MatchPeriod,
  MatchSnapshot,
  Persona,
} from "./types.js";

export type Localized = Record<Language, string>;

// ---------------------------------------------------------------- Archive

export interface ArchiveClub {
  id: string;
  name: string;
  shortName: string;
  city: string;
  stadium: string;
  founded: number;
  honours: ArchiveHonour[];
}

export interface ArchiveHonour {
  id: string;
  competition: string;
  season: string;
  result: "winner" | "runner_up";
  finalMatchId?: string;
}

export interface ArchiveCareerSpell {
  clubId: string;
  fromYear: number;
  toYear: number | null;
  appearances: number;
  goals: number;
}

export type RelationKind = "parent" | "child" | "sibling";

/** `kind` is the role of `personId` relative to the record that lists it ("parent" = that person is this person's parent). */
export interface ArchiveRelation {
  kind: RelationKind;
  personId: string;
}

export interface ArchivePerson {
  id: string;
  name: string;
  birthYear: number;
  hometown: string;
  position: string;
  /** Club currently registered with, or null when retired. */
  currentClubId: string | null;
  career: ArchiveCareerSpell[];
  relations: ArchiveRelation[];
  retired: boolean;
}

export interface ArchiveGoal {
  personId: string;
  clubId: string;
  minute: number;
}

export interface ArchiveMatch {
  id: string;
  date: string; // ISO date
  season: string;
  competition: string;
  stage: "league" | "quarter_final" | "semi_final" | "final";
  homeClubId: string;
  awayClubId: string;
  homeScore: number;
  awayScore: number;
  venue: string;
  goals: ArchiveGoal[];
}

/** Searchable prose rendered deterministically from structured records. */
export interface ArchiveDocument {
  id: string;
  title: string;
  body: string;
  kind: "player_profile" | "club_history" | "match_report" | "family_note";
  recordIds: string[];
}

export interface ArchiveSnapshot {
  version: string;
  clubs: ArchiveClub[];
  people: ArchivePerson[];
  matches: ArchiveMatch[];
  documents: ArchiveDocument[];
}

/** GET /api/archive/players/:archiveId */
export interface ArchivePlayerProfile {
  person: ArchivePerson;
  clubs: Record<string, ArchiveClub>;
  relatives: ArchivePerson[];
  documents: ArchiveDocument[];
  careerGoals: number;
}

/** GET /api/archive/summary */
export interface ArchiveSummary {
  version: string;
  clubs: ArchiveClub[];
  peopleCount: number;
  matchCount: number;
  documentCount: number;
}

// ---------------------------------------------------------------- MatchLab

export type ScenarioKind = "comeback" | "red_card" | "set_piece" | "late_winner" | "goal_fest";

export interface GenerateMatchRequest {
  scenario: ScenarioKind;
  seed: number;
  homeClubId?: string;
  awayClubId?: string;
}

export type StressKind = "duplicate" | "out_of_order" | "late_correction" | "missing_event";

export interface StressFeedItem {
  /** Wall-clock offset from match start in seconds at which to publish. */
  publishAtSecond: number;
  event: MatchEvent;
  stress?: StressKind;
}

// ---------------------------------------------------------------- Live feed

export type LiveTransport = "fabric-eventstream" | "local";

export interface LiveEnvelope {
  kind: "match_start" | "match_event" | "match_end";
  matchId: string;
  sequence: number;
  publishedAt: string; // ISO timestamp
  event?: MatchEvent;
  fixture?: FixtureSummary;
}

export interface LiveStatus {
  state: "idle" | "running" | "finished";
  transport: LiveTransport;
  transportConfigured: boolean;
  matchId?: string;
  fixtureId?: string;
  title?: string;
  clockSecond: number;
  speed: number;
  eventsReceived: number;
  duplicatesIgnored: number;
  lastEventAt?: string;
  /** Publish-to-receive latency of the most recent envelope, in milliseconds. */
  lagMs?: number;
  stress: boolean;
}

export interface StartLiveRequest {
  fixtureId?: string;
  generate?: GenerateMatchRequest;
  speed: number; // 1..60
  stress?: boolean;
}

// ---------------------------------------------------------------- Storyline Desk

export type ClaimKind =
  | "live_event"
  | "match_state"
  | "live_metric"
  | "former_club"
  | "family_link"
  | "career_goals"
  | "head_to_head"
  | "historic_final"
  | "club_honour";

export interface ClaimSource {
  type: "event" | "archive";
  id: string;
}

export interface StorylineClaim {
  id: string;
  kind: ClaimKind;
  text: Localized;
  sources: ClaimSource[];
  status: "verified" | "rejected";
  reason?: string;
}

export type StorylineStatus =
  | "researching"
  | "checking"
  | "drafting"
  | "needs_review"
  | "approved"
  | "rejected"
  | "retracted"
  | "failed";

export interface Storyline {
  id: string;
  matchId: string;
  triggerEventIds: string[];
  triggerMinute: number;
  createdAt: string;
  updatedAt: string;
  status: StorylineStatus;
  priority: number;
  headline: Localized;
  onAirLine: Localized;
  overlay: Localized;
  claims: StorylineClaim[];
  trace: AgentStep[];
  review?: { decision: "approved" | "rejected" | "edited"; at: string; note?: string };
  /** Set when a producer first approved the copy (approve or edit); survives retraction. */
  approvedAt?: string;
  retractionReason?: string;
  failureReason?: string;
  version: number;
  /** Coordinator handoff log (agent -> agent), including recoveries and director fallbacks. */
  handoffs?: StorylineHandoff[];
}

export interface StorylineHandoff {
  from: string;
  to: string;
  reason: string;
  at: string;
  outcome: "ok" | "retry" | "fallback" | "skipped" | "escalated" | "failed";
  /** Who chose the transition: the Foundry director agent or the deterministic policy. */
  decidedBy?: "director" | "policy";
  /** Set when the handoff is a recovery from an agent failure. */
  recovery?: string;
  errorClass?: string;
}

export interface ReviewStorylineRequest {
  decision: "approve" | "reject" | "edit";
  onAirLine?: string; // English edit; re-checked before approval
  note?: string;
}

export interface VerifiedFact {
  id: string;
  matchId: string;
  minute: number;
  text: Localized;
  sources: ClaimSource[];
  storylineId?: string;
  createdAt: string;
  /** Set when a cited event was later rescinded; the fact must no longer be shown as current. */
  retracted?: boolean;
}

export interface RecapChapter {
  id: string;
  title: Localized;
  startSecond: number;
  endSecond: number;
  eventIds: string[];
  storylineIds: string[];
  summary: Localized;
}

export interface RecapStoryboard {
  matchId: string;
  stateVersion: string;
  chapters: RecapChapter[];
}

// ---------------------------------------------------------------- Live stream messages (SSE)

export type LiveMessage =
  | { type: "status"; status: LiveStatus }
  | { type: "snapshot"; snapshot: MatchSnapshot; status: LiveStatus }
  | { type: "storyline"; storyline: Storyline }
  | { type: "fact"; fact: VerifiedFact }
  | { type: "heartbeat"; at: string };

export interface LiveStreamQuery {
  role: "fan" | "studio";
  persona: Persona;
  language: Language;
  favoritePlayerId?: string;
  /** "home" | "away" or a synthetic archive club ID; reorders/marks stories only. */
  favoriteClubId?: string;
  /** Scope of snapshot stats and stories; defaults to the full match. Score stays whole-match. */
  period?: MatchPeriod;
}
