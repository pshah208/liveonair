import { placeEvent } from "./ballPath.js";
import type { MatchEvent, MatchFixture, Team, TeamId } from "./types.js";

export const TRACKING_PITCH_LENGTH_M = 105;
export const TRACKING_PITCH_WIDTH_M = 68;
const MAX_PLAYER_SPEED_MPS = 10;

export interface TrackingPlayer {
  id: string;
  teamId: TeamId;
  number: number;
  x: number; // metres, origin bottom-left
  y: number; // metres, origin bottom-left
}

export interface TrackingBall {
  x: number; // metres, origin bottom-left
  y: number; // metres, origin bottom-left
}

export interface TrackingFrame {
  fixtureId: string;
  seed: number;
  second: number;
  synthetic: true;
  eventId?: string;
  carrierPlayerId?: string;
  players: TrackingPlayer[];
  ball: TrackingBall;
}

export type TrackingStreamMessage =
  | { type: "frame"; frame: TrackingFrame }
  | { type: "status"; status: "idle" | "no_data" | "ended"; message: string }
  | { type: "heartbeat"; at: string };

type Point = { x: number; y: number };

const POSSESSION_EVENTS = new Set<MatchEvent["type"]>([
  "pass", "shot", "goal", "save", "tackle", "pressure", "corner", "foul", "kickoff", "substitution",
]);

const FORMATIONS: Record<"4-3-3" | "4-4-2", Array<{ role: string; x: number; y: number }>> = {
  "4-3-3": [
    { role: "GK", x: 7, y: 34 },
    { role: "RB", x: 24, y: 9 }, { role: "CB", x: 21, y: 23 }, { role: "CB", x: 21, y: 45 }, { role: "LB", x: 24, y: 59 },
    { role: "DM", x: 40, y: 34 }, { role: "CM", x: 49, y: 23 }, { role: "CM", x: 49, y: 45 },
    { role: "RW", x: 69, y: 11 }, { role: "ST", x: 77, y: 34 }, { role: "LW", x: 69, y: 57 },
  ],
  "4-4-2": [
    { role: "GK", x: 7, y: 34 },
    { role: "RB", x: 24, y: 10 }, { role: "CB", x: 21, y: 24 }, { role: "CB", x: 21, y: 44 }, { role: "LB", x: 24, y: 58 },
    { role: "RM", x: 42, y: 12 }, { role: "CM", x: 44, y: 27 }, { role: "CM", x: 44, y: 41 }, { role: "LM", x: 42, y: 56 },
    { role: "ST", x: 71, y: 29 }, { role: "ST", x: 71, y: 39 },
  ],
};

function secondOf(event: Pick<MatchEvent, "minute" | "second">): number {
  return event.minute * 60 + event.second;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hash(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function eventPointMetres(fixture: MatchFixture, event: MatchEvent): Point {
  const point = placeEvent(fixture, event);
  return { x: (point.x / 100) * TRACKING_PITCH_LENGTH_M, y: TRACKING_PITCH_WIDTH_M - (point.y / 100) * TRACKING_PITCH_WIDTH_M };
}

function visibleEvents(fixture: MatchFixture, atSecond: number): MatchEvent[] {
  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    if (!POSSESSION_EVENTS.has(event.type)) continue;
    if (secondOf(event) > atSecond) continue;
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()].filter((event) => !event.rescinded).sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
}

function nearestClosingPlayer(players: TrackingPlayer[], ball: Point): TrackingPlayer | undefined {
  return players.reduce<TrackingPlayer | undefined>((closest, player) => {
    if (!closest) return player;
    const d0 = (closest.x - ball.x) ** 2 + (closest.y - ball.y) ** 2;
    const d1 = (player.x - ball.x) ** 2 + (player.y - ball.y) ** 2;
    return d1 < d0 ? player : closest;
  }, undefined);
}

function assignSlots(team: Team, formation: Array<{ role: string; x: number; y: number }>): Array<{ playerId: string; number: number; x: number; y: number }> {
  const remaining = [...team.players];
  const pick = (predicate: (position: string) => boolean) => {
    const index = remaining.findIndex((player) => predicate(player.position));
    return index >= 0 ? remaining.splice(index, 1)[0] : remaining.shift();
  };
  return formation.map((slot) => {
    const player = pick((position) => position === slot.role || (slot.role === "CB" && position === "CB") || (slot.role === "CM" && /CM|DM|AM/.test(position)));
    return { playerId: player?.id ?? `${team.id}-${slot.role}`, number: player?.number ?? 0, x: slot.x, y: slot.y };
  });
}

function formationFor(seed: number, teamId: TeamId): keyof typeof FORMATIONS {
  const flip = lcg(hash(`${seed}:${teamId}:formation`))();
  return flip < 0.5 ? "4-3-3" : "4-4-2";
}

function applyBlockShift(point: Point, ball: Point, attackWeight: number): Point {
  const attack = clamp(attackWeight, 0, 1);
  const xScale = 0.13 + (0.12 * attack);
  const yScale = 0.16 + (0.06 * attack);
  const xMin = -6 - (4 * attack);
  const xMax = 8 + (4 * attack);
  const shiftX = clamp((ball.x - TRACKING_PITCH_LENGTH_M * 0.52) * xScale, xMin, xMax);
  const shiftY = clamp((ball.y - TRACKING_PITCH_WIDTH_M * 0.5) * yScale, -8, 8);
  return {
    x: clamp(point.x + shiftX, 1.2, TRACKING_PITCH_LENGTH_M - 1.2),
    y: clamp(point.y + shiftY, 1.2, TRACKING_PITCH_WIDTH_M - 1.2),
  };
}

function ballAt(events: MatchEvent[], fixture: MatchFixture, atSecond: number): { ball: Point; anchor?: MatchEvent } {
  if (events.length === 0) {
    return { ball: { x: TRACKING_PITCH_LENGTH_M / 2, y: TRACKING_PITCH_WIDTH_M / 2 } };
  }
  const anchor = events[events.length - 1];
  const anchorSecond = secondOf(anchor);
  const next = fixture.events
    .filter((event) => !event.rescinded && POSSESSION_EVENTS.has(event.type) && secondOf(event) > anchorSecond)
    .sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id))[0];
  const from = eventPointMetres(fixture, anchor);
  if (!next) return { ball: from, anchor };
  const to = eventPointMetres(fixture, next);
  const span = Math.max(0.2, secondOf(next) - anchorSecond);
  const t = clamp((atSecond - anchorSecond) / span, 0, 1);
  return { ball: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, anchor };
}

/** Deterministic synthetic tracking from event coordinates in the shared 105x68 frame. */
export function buildTrackingFrame(fixture: MatchFixture, atSecond: number): TrackingFrame {
  const at = clamp(atSecond, 0, fixture.durationSeconds);
  const events = visibleEvents(fixture, at);
  const { ball, anchor } = ballAt(events, fixture, at);
  const possessingTeam: TeamId = anchor?.teamId ?? "home";
  const anchorSecond = anchor ? secondOf(anchor) : 0;
  const previousTeam = anchor
    ? [...events].reverse().find((event) => event.id !== anchor.id && event.teamId !== possessingTeam)?.teamId
    : undefined;
  const transition = anchor ? clamp((at - anchorSecond) / 2, 0, 1) : 1;
  const attackWeight = (teamId: TeamId) => {
    if (previousTeam && transition < 1) {
      if (teamId === possessingTeam) return transition;
      if (teamId === previousTeam) return 1 - transition;
    }
    return teamId === possessingTeam ? 1 : 0;
  };

  const homeSlots = assignSlots(fixture.home, FORMATIONS[formationFor(fixture.seed, "home")]);
  const awaySlots = assignSlots(fixture.away, FORMATIONS[formationFor(fixture.seed, "away")]);
  const micro = (seedKey: string, t: number) => {
    const phase = hash(seedKey) % 628;
    return Math.sin((phase / 100) + t * 0.9) * 0.55;
  };

  const home = homeSlots.map((slot) => {
    const base = { x: slot.x, y: slot.y };
    const shifted = applyBlockShift(base, ball, attackWeight("home"));
    return {
      id: slot.playerId,
      teamId: "home" as const,
      number: slot.number,
      x: clamp(shifted.x + micro(`${fixture.seed}:${slot.playerId}:x`, at), 0.6, TRACKING_PITCH_LENGTH_M - 0.6),
      y: clamp(shifted.y + micro(`${fixture.seed}:${slot.playerId}:y`, at), 0.6, TRACKING_PITCH_WIDTH_M - 0.6),
    };
  });

  const away = awaySlots.map((slot) => {
    const mirrored = { x: TRACKING_PITCH_LENGTH_M - slot.x, y: TRACKING_PITCH_WIDTH_M - slot.y };
    const shifted = applyBlockShift(mirrored, ball, attackWeight("away"));
    return {
      id: slot.playerId,
      teamId: "away" as const,
      number: slot.number,
      x: clamp(shifted.x + micro(`${fixture.seed}:${slot.playerId}:x`, at), 0.6, TRACKING_PITCH_LENGTH_M - 0.6),
      y: clamp(shifted.y + micro(`${fixture.seed}:${slot.playerId}:y`, at), 0.6, TRACKING_PITCH_WIDTH_M - 0.6),
    };
  });

  const players = [...home, ...away];

  const playerEvents = fixture.events
    .filter((event) => !event.rescinded && POSSESSION_EVENTS.has(event.type))
    .sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
  const sigma = 3.8;
  for (const player of players) {
    const nearest = playerEvents
      .filter((event) => event.playerId === player.id)
      .reduce<{ event: MatchEvent; delta: number } | null>((best, event) => {
      const delta = Math.abs(at - secondOf(event));
      if (!best || delta < best.delta) return { event, delta };
      return best;
    }, null);
    if (!nearest) continue;
    const influence = Math.exp(-((nearest.delta * nearest.delta) / (2 * sigma * sigma)));
    const target = eventPointMetres(fixture, nearest.event);
    player.x = clamp(player.x * (1 - influence) + (target.x + 0.45) * influence, 0.6, TRACKING_PITCH_LENGTH_M - 0.6);
    player.y = clamp(player.y * (1 - influence) + (target.y + 0.45) * influence, 0.6, TRACKING_PITCH_WIDTH_M - 0.6);
  }

  const defenders = players.filter((player) => player.teamId !== possessingTeam);
  const presser = nearestClosingPlayer(defenders, ball);
  if (presser) {
    const dx = ball.x - presser.x;
    const dy = ball.y - presser.y;
    const dist = Math.hypot(dx, dy) || 1;
    const close = Math.min(1.8, dist);
    presser.x = clamp(presser.x + (dx / dist) * close, 0.6, TRACKING_PITCH_LENGTH_M - 0.6);
    presser.y = clamp(presser.y + (dy / dist) * close, 0.6, TRACKING_PITCH_WIDTH_M - 0.6);
  }

  let carrierPlayerId: string | undefined;
  if (anchor && Math.abs(at - secondOf(anchor)) < 0.06) {
    carrierPlayerId = anchor.playerId;
  }

  return {
    fixtureId: fixture.id,
    seed: fixture.seed,
    second: at,
    synthetic: true,
    ...(anchor ? { eventId: anchor.id } : {}),
    ...(carrierPlayerId ? { carrierPlayerId } : {}),
    players,
    ball,
  };
}

/** Hard speed guard so tests and stream checks share the same threshold. */
export function maxPlayerSpeedMps(previous: TrackingFrame, next: TrackingFrame): number {
  const dt = Math.max(0.001, next.second - previous.second);
  const byId = new Map(previous.players.map((player) => [player.id, player]));
  let max = 0;
  for (const player of next.players) {
    const from = byId.get(player.id);
    if (!from) continue;
    max = Math.max(max, Math.hypot(player.x - from.x, player.y - from.y) / dt);
  }
  return max;
}

export function speedWithinLimit(previous: TrackingFrame, next: TrackingFrame, limit = MAX_PLAYER_SPEED_MPS): boolean {
  return maxPlayerSpeedMps(previous, next) <= limit;
}

export function isTrackingStreamMessage(value: unknown): value is TrackingStreamMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<TrackingStreamMessage>;
  if (message.type === "heartbeat") return typeof (message as { at?: unknown }).at === "string";
  if (message.type === "status") return typeof (message as { message?: unknown }).message === "string";
  if (message.type !== "frame") return false;
  const frame = (message as { frame?: Partial<TrackingFrame> }).frame;
  return Boolean(frame && Array.isArray(frame.players) && frame.ball && typeof frame.ball.x === "number" && typeof frame.ball.y === "number");
}
