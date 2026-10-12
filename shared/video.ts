// Contracts for the Video lab: an uploaded clip is processed by the video worker into match events.
import type { EventType, MatchEvent, TeamId } from "./types.js";

export const MAX_VIDEO_SECONDS = 15 * 60;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_FRAME_INTERVAL_SECONDS = 3;
export const MAX_VIDEO_FRAMES = MAX_VIDEO_SECONDS / MAX_FRAME_INTERVAL_SECONDS;

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

/** A producer can add a few events the model missed; they go through the same builder rules. */
export const MAX_MANUAL_TAGS = 5;

export interface ManualTagInput {
  type: DetectableEventType;
  team: TeamId;
  /** Clip time in whole seconds. */
  second: number;
  shirtNumber: number | null;
  note: string;
}

export interface ManualTag extends ManualTagInput {
  id: string;
}

/** A detected event after the deterministic builder accepted it, with its evidence. */
export interface VideoEventEvidence {
  eventId: string;
  /** Frame the model cited, or the nearest sampled frame for a manual tag (-1 if none). */
  frameIndex: number;
  timestampSeconds: number;
  confidence: number;
  description: string;
  source: "vision" | "manual";
  tagId?: string;
}

/** What the clip library shows for each processed or failed upload. */
export interface VideoJobSummary {
  id: string;
  fileName: string;
  createdAt: string;
  stage: VideoJobStage;
  title: string;
  durationSeconds?: number;
  eventCount: number;
  manualTagCount: number;
  fixtureId?: string;
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
  manualTags: ManualTag[];
  log: { at: string; message: string }[];
  error?: string;
  footageCheck?: { realFootballFootage: boolean; reason: string };
}
