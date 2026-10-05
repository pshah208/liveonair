// Contracts for Player cam: one uploaded clip, one player, a personal highlight reel. Nothing is published to Eventstream.
import type { VideoFrame, VideoJobStage } from "./video.js";

export const PLAYER_ACTIONS = ["shot", "header", "save", "dribble", "tackle", "pass", "on_ball", "celebration", "off_ball"] as const;
export type PlayerAction = (typeof PLAYER_ACTIONS)[number];

export const ACTION_LABEL: Record<PlayerAction, string> = {
  shot: "Shot",
  header: "Header",
  save: "Save",
  dribble: "Dribble",
  tackle: "Tackle",
  celebration: "Celebration",
  pass: "Pass",
  on_ball: "On the ball",
  off_ball: "Positioning",
};

/** Where the user clicked the player in the clip: clip second and 0–1 position in the frame. */
export interface PlayerAnchor {
  second: number;
  x: number;
  y: number;
}

export interface PlayerCamRequest {
  name: string;
  /** Shirt number, if known. */
  number: number | null;
  /** Kit description, e.g. "red shirt, white shorts". */
  kit: string;
  anchor: PlayerAnchor | null;
}

/** Box in the visible frame, 0–100 from left/top. */
export interface PlayerBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One frame-level observation of the target player from the vision model. */
export interface PlayerSighting {
  frameIndex: number;
  visible: boolean;
  box: PlayerBox | null;
  action: PlayerAction;
  confidence: number;
  description: string;
}

export interface PlayerTrackPoint {
  second: number;
  box: PlayerBox;
}

export interface PlayerMoment {
  id: string;
  action: PlayerAction;
  startSecond: number;
  endSecond: number;
  peakSecond: number;
  /** Frame that best shows the moment. */
  frameIndex: number;
  confidence: number;
  score: number;
  caption: string;
  description: string;
}

export interface PlayerCamJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: VideoJobStage;
  progress: number;
  fileName: string;
  sizeBytes: number;
  request: PlayerCamRequest;
  durationSeconds?: number;
  width?: number;
  height?: number;
  frames: VideoFrame[];
  batchesTotal: number;
  batchesDone: number;
  model?: string;
  usage: { inputTokens: number; outputTokens: number };
  /** True when a crop around the clicked player was sent to the model as the reference. */
  referenceCaptured: boolean;
  sightings: PlayerSighting[];
  /** Visible positions over time, for the spotlight and the vertical reframe. */
  track: PlayerTrackPoint[];
  moments: PlayerMoment[];
  log: { at: string; message: string }[];
  error?: string;
  footageCheck?: { realFootballFootage: boolean; reason: string };
}

export interface PlayerCamJobSummary {
  id: string;
  createdAt: string;
  stage: VideoJobStage;
  fileName: string;
  playerLabel: string;
  durationSeconds?: number;
  momentCount: number;
}

export function playerLabel(request: Pick<PlayerCamRequest, "name" | "number">): string {
  return `${request.number !== null ? `#${request.number} ` : ""}${request.name}`.trim();
}

/** Linear interpolation of the player's box at a clip second; undefined when the nearest sighting is too far away. */
export function boxAt(track: PlayerTrackPoint[], second: number, maxGap = 3): PlayerTrackPoint["box"] | undefined {
  if (track.length === 0) return undefined;
  let after = track.findIndex((point) => point.second >= second);
  if (after === -1) after = track.length;
  const prev = track[after - 1];
  const next = track[after];
  if (prev && next) {
    if (next.second - prev.second > maxGap * 2) return Math.abs(second - prev.second) < Math.abs(next.second - second) ? (second - prev.second <= maxGap ? prev.box : undefined) : (next.second - second <= maxGap ? next.box : undefined);
    const t = (second - prev.second) / Math.max(0.001, next.second - prev.second);
    const mix = (a: number, b: number) => a + (b - a) * t;
    return { x: mix(prev.box.x, next.box.x), y: mix(prev.box.y, next.box.y), w: mix(prev.box.w, next.box.w), h: mix(prev.box.h, next.box.h) };
  }
  const only = prev ?? next!;
  return Math.abs(only.second - second) <= maxGap ? only.box : undefined;
}
