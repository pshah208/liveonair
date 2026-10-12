import type { LiveStatus } from "./platform.js";
import type { MatchEvent } from "./types.js";
import { MAX_VIDEO_FRAMES, type VideoEventEvidence, type VideoJobRequest } from "./video.js";

export const LIVE_VIDEO_BATCH_FRAMES = 4;
export const LIVE_VIDEO_PENDING_BATCHES = 2;
export const LIVE_VIDEO_FRAME_BYTES = 256 * 1024;
export const LIVE_VIDEO_FRAME_WIDTH = 768;

export interface StartProgressiveVideo {
  fileName: string;
  sizeBytes: number;
  contentType: string;
  durationSeconds: number;
  request: VideoJobRequest;
  rightsConfirmed: true;
}

export interface ProgressiveFrame {
  index: number;
  timestampSeconds: number;
  jpegBase64: string;
}

export interface ProgressiveVideoBatch {
  batchIndex: number;
  frames: ProgressiveFrame[];
}

export interface ProgressiveVideoSession {
  id: string;
  fixtureId: string;
  fileName: string;
  durationSeconds: number;
  stage: "streaming" | "complete" | "stopped" | "failed";
  acceptedFrames: number;
  analyzedFrames: number;
  /** Analyzed frames skipped in explicit broadcast-graphics batches, not event evidence. */
  skippedFrames?: number;
  coverageNote?: string;
  uploadedThrough: number;
  analyzedThrough: number;
  nextBatchIndex: number;
  pendingBatches: number;
  inputComplete: boolean;
  events: MatchEvent[];
  evidence: VideoEventEvidence[];
  live: LiveStatus;
  error?: string;
}

export function liveVideoSampleInterval(durationSeconds: number): number {
  return Math.max(1, durationSeconds / MAX_VIDEO_FRAMES);
}

export function liveVideoFrameCount(durationSeconds: number): number {
  return Math.min(MAX_VIDEO_FRAMES, Math.ceil(durationSeconds / liveVideoSampleInterval(durationSeconds)));
}
