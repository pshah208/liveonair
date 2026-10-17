import type { MatchFixture } from "../shared/types.js";
import type { LiveStatus } from "../shared/platform.js";

/**
 * The active match as seen by the Studio Desk, shared read-only with Fan View. Studio keeps owning the
 * producer controls, video lifecycle and its canonical stream; Fan View never starts or stops a match.
 */
export type ActiveMatchContext = {
  fixture: MatchFixture | null;
  status: LiveStatus | null;
  /** Browser-local footage for this exact fixture, when this browser has it. Never uploaded or shared. */
  footage: { fixtureId: string; url: string; name: string } | null;
  /** Analysed-through watermark (match seconds) when the match comes from progressive video analysis. */
  analyzedThrough?: number;
  /** Video analysis stopped or failed before the end: never present it as full time. */
  analysisStoppedEarly: boolean;
  aiReady: boolean;
};

export const EMPTY_MATCH_CONTEXT: ActiveMatchContext = { fixture: null, status: null, footage: null, analysisStoppedEarly: false, aiReady: false };
