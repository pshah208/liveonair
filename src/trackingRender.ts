import type { TrackingFrame, TrackingPlayer } from "../shared/tracking.js";

/** Frames arrive at 5 Hz; glide each dot from the previous frame to the latest over one frame interval. */
export const TRACKING_LERP_MS = 200;
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

/** IDs of players with another player closer than `minGapM`; their numbers are hidden. */
export function crowdedPlayerIds(players: TrackingPlayer[], minGapM = TRACKING_NUMBER_MIN_GAP_M): Set<string> {
  const crowded = new Set<string>();
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i]!;
      const b = players[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < minGapM) {
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
