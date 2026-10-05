import { ACTION_LABEL, playerLabel, type PlayerAction, type PlayerCamRequest, type PlayerMoment, type PlayerSighting, type PlayerTrackPoint } from "../../shared/playercam.js";
import type { VideoFrame } from "../../shared/video.js";

/**
 * Turns per-frame sightings of one player into highlight moments. Deterministic: the model only says where the
 * player is and what they are doing; thresholds, grouping, padding and ranking live here.
 */

export const MIN_PLAYER_CONFIDENCE = 0.5;
export const MAX_PLAYER_MOMENTS = 8;
const PRE_ROLL = 2.5;
const POST_ROLL = 2;
const MIN_MOMENT = 4;
const MAX_FALLBACK_MOMENTS = 3;

export const ACTION_WEIGHT: Record<PlayerAction, number> = {
  shot: 100,
  header: 75,
  save: 75,
  dribble: 65,
  tackle: 60,
  celebration: 55,
  pass: 45,
  on_ball: 40,
  off_ball: 10,
};



type Seen = PlayerSighting & { second: number };

function group(items: Seen[], gap: number): Seen[][] {
  const groups: Seen[][] = [];
  for (const item of items) {
    const current = groups.at(-1);
    if (current && item.second - current.at(-1)!.second <= gap) current.push(item);
    else groups.push([item]);
  }
  return groups;
}

export function buildPlayerMoments(input: {
  request: PlayerCamRequest;
  frames: VideoFrame[];
  sightings: PlayerSighting[];
  durationSeconds: number;
  intervalSeconds: number;
}): { moments: PlayerMoment[]; track: PlayerTrackPoint[] } {
  const duration = Math.max(1, input.durationSeconds);
  const time = new Map(input.frames.map((frame) => [frame.index, frame.timestampSeconds]));
  const seen: Seen[] = input.sightings
    .filter((sighting) => sighting.visible && sighting.box && sighting.confidence >= MIN_PLAYER_CONFIDENCE && time.has(sighting.frameIndex))
    .map((sighting) => ({ ...sighting, second: time.get(sighting.frameIndex)! }))
    .sort((a, b) => a.second - b.second);
  const track = seen.map((item) => ({ second: item.second, box: item.box! }));

  const involved = seen.filter((item) => item.action !== "off_ball");
  const gap = Math.max(3, input.intervalSeconds * 2.5);
  const fallback = involved.length === 0;
  const groups = group(fallback ? seen : involved, gap);

  type Window = { start: number; end: number; peak: Seen; score: number };
  let windows: Window[] = groups.map((items) => {
    const peak = items.reduce((best, item) => (ACTION_WEIGHT[item.action] * item.confidence > ACTION_WEIGHT[best.action] * best.confidence ? item : best));
    let start = Math.max(0, items[0]!.second - PRE_ROLL);
    let end = Math.min(duration, items.at(-1)!.second + POST_ROLL);
    if (end - start < MIN_MOMENT) {
      const centre = (start + end) / 2;
      start = Math.max(0, centre - MIN_MOMENT / 2);
      end = Math.min(duration, start + MIN_MOMENT);
      start = Math.max(0, end - MIN_MOMENT);
    }
    // Sustained involvement adds a little, so a long dribble outranks a single touch.
    const score = Math.round(ACTION_WEIGHT[peak.action] * peak.confidence + Math.min(20, (items.length - 1) * 4));
    return { start, end, peak, score };
  });

  // Padding can make neighbours touch; merge so footage never repeats, keeping the stronger peak.
  windows = windows.reduce<Window[]>((merged, window) => {
    const previous = merged.at(-1);
    if (previous && window.start < previous.end) {
      const keep = window.score > previous.score ? window : previous;
      merged[merged.length - 1] = { ...keep, start: previous.start, end: Math.max(previous.end, window.end), score: Math.max(previous.score, window.score) };
    } else merged.push(window);
    return merged;
  }, []);

  const limit = fallback ? MAX_FALLBACK_MOMENTS : MAX_PLAYER_MOMENTS;
  const chosen = [...windows].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit).sort((a, b) => a.start - b.start);
  const label = playerLabel(input.request);
  const moments: PlayerMoment[] = chosen.map((window, index) => ({
    id: `m${String(index + 1).padStart(2, "0")}`,
    action: window.peak.action,
    startSecond: Math.round(window.start * 10) / 10,
    endSecond: Math.round(window.end * 10) / 10,
    peakSecond: window.peak.second,
    frameIndex: window.peak.frameIndex,
    confidence: Math.round(window.peak.confidence * 100) / 100,
    score: window.score,
    caption: `${ACTION_LABEL[window.peak.action]} · ${label}`,
    description: window.peak.description,
  }));
  return { moments, track };
}
