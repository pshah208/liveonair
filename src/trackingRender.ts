import type { TrackingFrame, TrackingPlayer } from "../shared/tracking.js";

/** A jump larger than this (seek, resume, restart) snaps instead of gliding across the pitch. */
export const TRACKING_SNAP_DISTANCE_M = 15;
/** Shirt numbers are dropped when another dot is closer than this, so badges never overlap. */
export const TRACKING_NUMBER_MIN_GAP_M = 2;
/** Length of the fading ball trail. */
export const TRACKING_BALL_TRAIL_MS = 600;

export type TrailPoint = { x: number; y: number; at: number };

export function interpolateFrame(from: TrackingFrame, to: TrackingFrame, t: number): TrackingFrame {
  const byId = new Map(from.players.map((player) => [player.id, player]));
  const players = to.players.map((player) => {
    const previous = byId.get(player.id);
    if (!previous) return player;
    return { ...player, x: previous.x + (player.x - previous.x) * t, y: previous.y + (player.y - previous.y) * t };
  });
  return {
    ...to,
    players,
    ball: { x: from.ball.x + (to.ball.x - from.ball.x) * t, y: from.ball.y + (to.ball.y - from.ball.y) * t },
  };
}

/** Largest movement in metres of the ball or any player present in both frames. */
export function maxDisplacement(from: TrackingFrame, to: TrackingFrame): number {
  let max = Math.hypot(to.ball.x - from.ball.x, to.ball.y - from.ball.y);
  const byId = new Map(from.players.map((player) => [player.id, player]));
  for (const player of to.players) {
    const previous = byId.get(player.id);
    if (previous) max = Math.max(max, Math.hypot(player.x - previous.x, player.y - previous.y));
  }
  return max;
}

/** True when the next frame should be drawn directly instead of interpolated. */
export function shouldSnap(from: TrackingFrame | null, to: TrackingFrame, reducedMotion: boolean): boolean {
  if (reducedMotion || !from || from.fixtureId !== to.fixtureId) return true;
  return maxDisplacement(from, to) > TRACKING_SNAP_DISTANCE_M;
}

/** A hidden number only comes back once the nearest dot is farther than this (hysteresis). */
export const TRACKING_NUMBER_RELEASE_GAP_M = 2.5;

/**
 * IDs of players with another player closer than `minGapM`; their numbers are hidden.
 * Pass the previous result as `previous` for hysteresis: a pair that was already crowded
 * stays crowded until it separates beyond `releaseGapM`, so numbers do not flicker at 2 m.
 */
export function crowdedPlayerIds(
  players: TrackingPlayer[],
  minGapM = TRACKING_NUMBER_MIN_GAP_M,
  previous?: ReadonlySet<string>,
  releaseGapM = TRACKING_NUMBER_RELEASE_GAP_M,
): Set<string> {
  const crowded = new Set<string>();
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i]!;
      const b = players[j]!;
      const sticky = previous !== undefined && previous.has(a.id) && previous.has(b.id);
      if (Math.hypot(a.x - b.x, a.y - b.y) < (sticky ? Math.max(minGapM, releaseGapM) : minGapM)) {
        crowded.add(a.id);
        crowded.add(b.id);
      }
    }
  }
  return crowded;
}

/** Appends a ball position and drops points older than the trail window. */
export function pushTrail(trail: TrailPoint[], point: TrailPoint, windowMs = TRACKING_BALL_TRAIL_MS): TrailPoint[] {
  return [...trail, point].filter((entry) => point.at - entry.at <= windowMs);
}

/**
 * Playout buffer: frames are drawn about this much wall time behind the newest one,
 * on a clock that advances at the measured stream rate (match seconds per wall second).
 * Late or bunched SSE frames then never freeze or jump the dots, at 1x or 60x.
 */
export const PLAYOUT_DELAY_MS = 350;
/** A gap this long between buffered frames (seek, late join) is cut, not glided across. */
export const PLAYOUT_MAX_GLIDE_SECONDS = 15;
const PLAYOUT_MAX_FRAMES = 48;

export type Playout = {
  frames: TrackingFrame[];
  /** Match second currently drawn; null until the first sample. */
  clock: number | null;
  /** Estimated match seconds per wall second. */
  rate: number;
  last: { second: number; at: number } | null;
  sampledAt: number | null;
};

export function createPlayout(): Playout {
  return { frames: [], clock: null, rate: 0, last: null, sampledAt: null };
}

/** Adds a received frame (mutates `state`). Duplicates are dropped; a rewind or new fixture restarts the buffer. */
export function addPlayoutFrame(state: Playout, frame: TrackingFrame, at: number): Playout {
  const latest = state.frames[state.frames.length - 1];
  if (latest && (frame.fixtureId !== latest.fixtureId || frame.second < latest.second - 1e-6)) {
    Object.assign(state, createPlayout());
  } else if (latest && frame.second <= latest.second + 1e-6) {
    return state;
  }
  if (state.last) {
    const wall = (at - state.last.at) / 1000;
    // Skip the estimate across long silences (pause, tab in background): it is not the stream rate.
    if (wall > 0.05 && wall < 1.5) {
      const instant = (frame.second - state.last.second) / wall;
      state.rate = Math.min(120, Math.max(0, state.rate === 0 ? instant : state.rate + (instant - state.rate) * 0.25));
    }
  }
  state.last = { second: frame.second, at };
  state.frames.push(frame);
  if (state.frames.length > PLAYOUT_MAX_FRAMES) state.frames.splice(0, state.frames.length - PLAYOUT_MAX_FRAMES);
  return state;
}

/** Advances the playout clock to wall time `at` and returns the interpolated frame (mutates `state`). */
export function samplePlayout(state: Playout, at: number): TrackingFrame | null {
  const frames = state.frames;
  if (frames.length === 0) return null;
  const first = frames[0]!;
  const latest = frames[frames.length - 1]!;
  const dt = state.sampledAt === null ? 0 : Math.max(0, Math.min(0.25, (at - state.sampledAt) / 1000));
  state.sampledAt = at;
  const target = latest.second - (PLAYOUT_DELAY_MS / 1000) * state.rate;
  if (state.clock === null || Math.abs(target - state.clock) > Math.max(2, state.rate * 1.5)) {
    state.clock = target;
  } else {
    // Run at the stream rate and ease gently toward the target, so jitter never shows as a jump.
    state.clock += dt * state.rate + (target - state.clock) * Math.min(1, dt * 1.5);
  }
  state.clock = Math.min(latest.second, Math.max(first.second, state.clock));
  if (frames.length === 1 || state.clock >= latest.second) return latest;
  let index = 0;
  while (index < frames.length - 2 && frames[index + 1]!.second < state.clock) index += 1;
  const from = frames[index]!;
  const to = frames[index + 1]!;
  const span = to.second - from.second;
  const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (state.clock - from.second) / span));
  if (span > PLAYOUT_MAX_GLIDE_SECONDS) return t < 0.5 ? from : to;
  return interpolateFrame(from, to, t);
}
