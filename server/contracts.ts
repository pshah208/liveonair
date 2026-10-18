// Server-internal module contracts. Each module owner implements its side; app.ts wires them.
import type { ChanceInsight } from "../shared/chanceSequence.js";
import type { AnalysisRequest, FixtureSummary, MatchEvent, MatchFixture, MatchSnapshot } from "../shared/types.js";
import type {
  ArchiveSnapshot,
  GenerateMatchRequest,
  LiveEnvelope,
  LiveStatus,
  RecapStoryboard,
  ReviewStorylineRequest,
  StartLiveRequest,
  StressFeedItem,
  Storyline,
  VerifiedFact,
} from "../shared/platform.js";

// ---- engine.ts (owner: engine/archive) -------------------------------------------
// analyzeFixture analyses an arbitrary fixture object (registered or live partial event list).
// Existing analyzeMatch(request) keeps working for registered fixtures.
export type AnalyzeFixture = (fixture: MatchFixture, request: AnalysisRequest) => MatchSnapshot;

// ---- fixtures.ts / matchlab (owner: engine/archive) ---------------------------------
export interface FixtureRegistry {
  listFixtures(): FixtureSummary[];
  getFixture(id: string): MatchFixture; // throws RangeError when unknown
  registerFixture(fixture: MatchFixture): FixtureSummary; // bounded; oldest generated evicted
}
export type GenerateMatch = (request: GenerateMatchRequest) => MatchFixture;
/** Ordered publish plan; with stress=true, injects duplicates, out-of-order and a late correction. */
export type BuildFeedPlan = (fixture: MatchFixture, stress: boolean) => StressFeedItem[];

// ---- archive (owner: engine/archive) -----------------------------------------------
export type GetArchive = () => ArchiveSnapshot;

// ---- live (owner: live) ------------------------------------------------------------
export interface LiveTransportClient {
  readonly name: "fabric-eventstream" | "local";
  readonly configured: boolean;
  publish(envelope: LiveEnvelope): Promise<void>;
  /** Starts consuming; returns a stop function. */
  subscribe(onEnvelope: (envelope: LiveEnvelope, receivedAt: number) => void): Promise<() => Promise<void>>;
}

export interface LiveMatchView {
  matchId: string;
  /** Fixture metadata with events = every received envelope event (all revisions, deduplicated by id+revision). */
  fixture: MatchFixture;
  clockSecond: number;
}

export interface LiveListener {
  /** Called after each newly accepted event (not for duplicates). */
  onEvent(view: LiveMatchView, event: MatchEvent): void;
  onMatchStart?(view: LiveMatchView): void;
  onMatchEnd?(view: LiveMatchView): void;
}

export interface LiveService {
  status(): LiveStatus;
  current(): LiveMatchView | undefined;
  start(request: StartLiveRequest): Promise<LiveStatus>;
  /** Incremental video uses an analysis watermark, not a precomputed event schedule. */
  startProgressive?(fixture: MatchFixture): Promise<LiveStatus>;
  appendProgressive?(fixture: MatchFixture, analyzedThrough: number): Promise<LiveStatus>;
  completeProgressive?(fixtureId: string): Promise<LiveStatus>;
  stop(): Promise<LiveStatus>;
  /** Publishes a revision of an existing goal marking it rescinded. */
  publishCorrection(eventId: string): Promise<void>;
  addListener(listener: LiveListener): () => void;
  close(): Promise<void>;
}

// ---- desk (owner: desk) ------------------------------------------------------------
export interface StorylineDesk extends LiveListener {
  /** Optional so test doubles stay valid. Links insight revisions to storylines. */
  applyChanceInsight?(insight: ChanceInsight): void;
  list(matchId: string): Storyline[];
  facts(matchId: string): VerifiedFact[];
  review(id: string, request: ReviewStorylineRequest): Promise<Storyline>;
  storyboard(view: LiveMatchView): RecapStoryboard;
  subscribe(listener: (update: { storyline?: Storyline; fact?: VerifiedFact }) => void): () => void;
  health(): { mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string };
}
