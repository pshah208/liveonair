// Contracts for the Video lab: an uploaded clip is processed by the video worker into match events.
import type { EventType, MatchEvent, TeamId } from "./types.js";

export type VideoJobStage = "queued" | "probing" | "extracting" | "analysing" | "building" | "ready" | "rejected" | "failed";

/** Event types the vision model may report. Kickoff/fulltime are added in code. */
export const DETECTABLE_EVENT_TYPES = ["pass", "shot", "goal", "save", "tackle", "foul", "corner", "yellow_card", "red_card"] as const;
export type DetectableEventType = (typeof DETECTABLE_EVENT_TYPES)[number] & EventType;

/** One observation returned by the vision model for a sampled frame. */
export interface VisionDetection {
  frameIndex: number;
  type: DetectableEventType;
  team: TeamId | "unknown";
  shirtNumber: number | null;
  outcome: MatchEvent["outcome"];
  /** Approximate position across the visible frame, 0–100 left to right / top to bottom. */
  x: number;
  y: number;
  confidence: number;
  description: string;
}

export interface VideoFrame {
  index: number;
  timestampSeconds: number;
}

export interface VideoTeamInput {
  name: string;
  kit: string;
}

export interface VideoJobRequest {
  home: VideoTeamInput;
  away: VideoTeamInput;
}

/** A detected event after the deterministic builder accepted it, with its evidence. */
export interface VideoEventEvidence {
  eventId: string;
  frameIndex: number;
  timestampSeconds: number;
  confidence: number;
  description: string;
}

export interface VideoJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: VideoJobStage;
  /** 0–100 progress through the pipeline. */
  progress: number;
  fileName: string;
  sizeBytes: number;
  request: VideoJobRequest;
  durationSeconds?: number;
  width?: number;
  height?: number;
  frames: VideoFrame[];
  batchesTotal: number;
  batchesDone: number;
  model?: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Kit descriptions the model reported, used to keep home/away consistent across batches. */
  kits?: { home: string; away: string };
  detectionsRaw: number;
  detectionsAccepted: number;
  fixtureId?: string;
  evidence: VideoEventEvidence[];
  events: MatchEvent[];
  log: { at: string; message: string }[];
  error?: string;
  footageCheck?: { realFootballFootage: boolean; reason: string };
}
