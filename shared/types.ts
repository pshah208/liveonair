export type TeamId = "home" | "away";
export type Persona = "analyst" | "casual" | "player";
export type Language = "en" | "es" | "fr";
export type EventType =
  | "pass" | "shot" | "goal" | "save" | "tackle" | "pressure"
  | "corner" | "foul" | "yellow_card" | "red_card" | "substitution"
  | "kickoff" | "halftime" | "fulltime";

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
  outcome: "success" | "miss" | "blocked" | "saved" | "complete" | "incomplete" | "none";
  x: number;
  y: number;
  endX?: number;
  endY?: number;
  xg?: number;
  relatedEventId?: string;
  rescinded?: boolean;
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
}

export interface TeamStats {
  goals: number;
  shots: number;
  passes: number;
  completedPasses: number;
  passAccuracy: number;
  corners: number;
  tackles: number;
  pressureEvents: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  illustrativeXg: number;
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
  score: { home: number; away: number };
  stats: { home: TeamStats; away: TeamStats };
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
}

export interface AppHealth {
  status: "ok";
  ai: { configured: boolean; deployment: string; authentication: string };
  version: string;
}
