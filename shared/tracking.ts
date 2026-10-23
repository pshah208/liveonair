import { placeEvent } from "./ballPath.js";
import { EVENT_TYPES, type MatchEvent, type MatchFixture, type Team, type TeamId } from "./types.js";

export const TRACKING_PITCH_LENGTH_M = 105;
export const TRACKING_PITCH_WIDTH_M = 68;
const MAX_PLAYER_SPEED_MPS = 9.5;
const MAX_ACCEL_MPS2 = 3.8;
const MAX_DECEL_MPS2 = 5;
const SIM_DT_SECONDS = 0.2;
const PLAYER_MARGIN_M = 3.5;
const TARGET_MARGIN_M = 3.5;

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
  | { type: "status"; status: "idle" | "no_data" | "ended" | "paused"; message: string }
  | { type: "heartbeat"; at: string };

type Point = { x: number; y: number };
type Vec = { x: number; y: number };
type PossessionEvent = MatchEvent & { atSecond: number };
type PossessionEventPoint = PossessionEvent & { __point: Point };

interface PlayerSlot {
  playerId: string;
  teamId: TeamId;
  number: number;
  role: string;
  localX: number;
  localY: number;
  sideNorm: number;
  lineIndex: number;
}

interface PlayerTraits {
  effort: number;
  reactionDelay: number;
  slotOffset: Vec;
  lissajousAmp: Vec;
  lissajousPeriod: Vec;
  lissajousPhase: Vec;
  speedNoise: number;
  sprintCycle: number;
  sprintPhase: number;
}

interface TacticalSnapshot {
  second: number;
  ball: Point;
  targets: Map<string, Point>;
  bursts: Map<string, number>;
  possessingTeam: TeamId;
  carrierPlayerId?: string;
  eventId?: string;
  turnover?: { atSecond: number; winner: TeamId; loser: TeamId };
}

interface SimPlayer {
  id: string;
  teamId: TeamId;
  number: number;
  role: string;
  sideNorm: number;
  traits: PlayerTraits;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface TimelineFrame {
  second: number;
  players: Point[];
  ball: Point;
  eventId?: string;
  carrierPlayerId?: string;
}

interface PrecomputedTimeline {
  order: Array<{ id: string; teamId: TeamId; number: number }>;
  frames: TimelineFrame[];
}

const POSSESSION_EVENTS = new Set<MatchEvent["type"]>(
  EVENT_TYPES.filter((type) => !["yellow_card", "red_card", "halftime", "fulltime", "substitution"].includes(type)),
);

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

function toLocalX(teamId: TeamId, x: number): number {
  return teamId === "home" ? x : TRACKING_PITCH_LENGTH_M - x;
}

function toGlobalX(teamId: TeamId, x: number): number {
  return teamId === "home" ? x : TRACKING_PITCH_LENGTH_M - x;
}

function eventPointMetres(fixture: MatchFixture, event: MatchEvent): Point {
  const point = placeEvent(fixture, event);
  return {
    x: (point.x / 100) * TRACKING_PITCH_LENGTH_M,
    y: TRACKING_PITCH_WIDTH_M - (point.y / 100) * TRACKING_PITCH_WIDTH_M,
  };
}

function activePossessionEvents(fixture: MatchFixture): PossessionEvent[] {
  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    if (!POSSESSION_EVENTS.has(event.type)) continue;
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()]
    .filter((event) => !event.rescinded)
    .map((event) => ({ ...event, atSecond: secondOf(event) }))
    .sort((a, b) => a.atSecond - b.atSecond || a.id.localeCompare(b.id));
}

function findAnchorIndex(events: PossessionEvent[], atSecond: number): number {
  let low = 0;
  let high = events.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid]!.atSecond <= atSecond) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function formationFor(seed: number, teamId: TeamId): keyof typeof FORMATIONS {
  const flip = lcg(hash(`${seed}:${teamId}:formation`))();
  return flip < 0.5 ? "4-3-3" : "4-4-2";
}

function lineIndexFor(role: string): number {
  if (role === "GK") return 0;
  if (role === "CB" || role === "RB" || role === "LB") return 1;
  if (role === "DM" || role === "CM" || role === "AM" || role === "RM" || role === "LM") return 2;
  return 3;
}

function assignSlots(team: Team, teamId: TeamId, formation: Array<{ role: string; x: number; y: number }>): PlayerSlot[] {
  const remaining = [...team.players];
  const pick = (predicate: (position: string) => boolean) => {
    const index = remaining.findIndex((player) => predicate(player.position));
    return index >= 0 ? remaining.splice(index, 1)[0] : remaining.shift();
  };
  return formation.map((slot) => {
    const player = pick((position) => (
      position === slot.role
      || (slot.role === "CB" && /CB|DF/u.test(position))
      || (slot.role === "CM" && /CM|DM|AM|MF/u.test(position))
      || ((slot.role === "RW" || slot.role === "RM") && /RW|RM|FW/u.test(position))
      || ((slot.role === "LW" || slot.role === "LM") && /LW|LM|FW/u.test(position))
      || (slot.role === "ST" && /ST|FW/u.test(position))
    ));
    const localY = teamId === "home" ? slot.y : TRACKING_PITCH_WIDTH_M - slot.y;
    return {
      playerId: player?.id ?? `${team.id}-${slot.role}`,
      teamId,
      number: player?.number ?? 0,
      role: slot.role,
      localX: slot.x,
      localY,
      sideNorm: clamp((localY - 34) / 34, -1, 1),
      lineIndex: lineIndexFor(slot.role),
    };
  });
}

function makeTraits(seed: number, slot: PlayerSlot): PlayerTraits {
  const rand = lcg(hash(`${seed}:${slot.playerId}:traits`));
  const offsetAngle = rand() * Math.PI * 2;
  const offsetRadius = 1.5 + rand() * 1.5;
  return {
    effort: 0.85 + rand() * 0.15,
    reactionDelay: 0.5 + rand(),
    slotOffset: { x: Math.cos(offsetAngle) * offsetRadius, y: Math.sin(offsetAngle) * offsetRadius },
    lissajousAmp: { x: 0.45 + rand() * 0.35, y: 0.45 + rand() * 0.35 },
    lissajousPeriod: { x: 6 + rand() * 4, y: 6 + rand() * 4 },
    lissajousPhase: { x: rand() * Math.PI * 2, y: rand() * Math.PI * 2 },
    speedNoise: rand(),
    sprintCycle: 6 + rand() * 4,
    sprintPhase: rand() * Math.PI * 2,
  };
}

function lissajous(traits: PlayerTraits, second: number): Vec {
  return {
    x: Math.sin(((second / traits.lissajousPeriod.x) * Math.PI * 2) + traits.lissajousPhase.x) * traits.lissajousAmp.x,
    y: Math.sin(((second / traits.lissajousPeriod.y) * Math.PI * 2) + traits.lissajousPhase.y) * traits.lissajousAmp.y,
  };
}

function bezier(a: Point, b: Point, c: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: (u * u * a.x) + (2 * u * t * b.x) + (t * t * c.x),
    y: (u * u * a.y) + (2 * u * t * b.y) + (t * t * c.y),
  };
}

function easeInOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function buildBallPoint(anchor: PossessionEventPoint | undefined, next: PossessionEventPoint | undefined, atSecond: number, seed: number): Point {
  if (!anchor) return { x: TRACKING_PITCH_LENGTH_M / 2, y: TRACKING_PITCH_WIDTH_M / 2 };
  const from = anchor.__point;
  if (!next) return from;
  const to = next.__point;
  const span = Math.max(0.2, next.atSecond - anchor.atSecond);
  const t = clamp((atSecond - anchor.atSecond) / span, 0, 1);
  const eased = easeInOut(t);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const perp = { x: -dy / length, y: dx / length };
  const ampSeed = lcg(hash(`${seed}:${anchor.id}:${next.id}:curve`))();
  const signed = ampSeed < 0.5 ? -1 : 1;
  const amp = signed * Math.min(2.4, 0.7 + length * 0.08);
  const control = { x: mid.x + perp.x * amp, y: mid.y + perp.y * amp };
  return bezier(from, control, to, eased);
}

function opposite(teamId: TeamId): TeamId {
  return teamId === "home" ? "away" : "home";
}

function buildSnapshot(
  fixture: MatchFixture,
  events: PossessionEventPoint[],
  slots: Map<string, PlayerSlot>,
  traits: Map<string, PlayerTraits>,
  atSecond: number,
): TacticalSnapshot {
  const index = findAnchorIndex(events, atSecond);
  const anchor = index >= 0 ? events[index] : undefined;
  const next = index >= 0 && index + 1 < events.length ? events[index + 1] : events[0];
  const possession = anchor?.teamId ?? "home";
  const previousDifferent = index > 0 ? [...events.slice(0, index)].reverse().find((event) => event.teamId !== possession) : undefined;
  const turnover = anchor && previousDifferent && previousDifferent.teamId !== anchor.teamId
    ? { atSecond: anchor.atSecond, winner: anchor.teamId, loser: previousDifferent.teamId }
    : undefined;
  const ball = buildBallPoint(anchor, next, atSecond, fixture.seed);
  const carrierProgress = anchor && next ? clamp((atSecond - anchor.atSecond) / Math.max(0.2, next.atSecond - anchor.atSecond), 0, 1) : 0;
  const bursts = new Map<string, number>();
  const markBurst = (playerId: string, intensity: number) => {
    const prior = bursts.get(playerId) ?? 0;
    bursts.set(playerId, Math.max(prior, clamp(intensity, 0, 1.15)));
  };
  let carrierPlayerId = (() => {
    if (!anchor && !next) return undefined;
    if (!anchor) return next?.playerId;
    if (!next || next.teamId !== anchor.teamId) return anchor.playerId;
    return carrierProgress > 0.82 ? next.playerId : anchor.playerId;
  })();
  const targets = new Map<string, Point>();

  const byTeam: Record<TeamId, PlayerSlot[]> = { home: [], away: [] };
  for (const slot of slots.values()) byTeam[slot.teamId].push(slot);
  for (const teamId of ["home", "away"] as const) {
    const inPossession = teamId === possession;
    const ballLocalX = toLocalX(teamId, ball.x);
    const ballWide = Math.abs(ball.y - 34) > 18;
    const lineNoise = lcg(hash(`${fixture.seed}:${teamId}:line-noise`))();
    const widthNoise = lcg(hash(`${fixture.seed}:${teamId}:width-noise`))();
    const defLineLocal = inPossession
      ? clamp(ballLocalX - 30, 25, 70)
      : clamp(ballLocalX - 8 + lineNoise * 2, 24, 62);
    const blockLength = inPossession ? 35 + lineNoise * 5 : 22 + lineNoise * 3;
    const blockWidth = inPossession ? 52 + widthNoise * 6 : ballWide ? 20 : 24 + widthNoise * 2;
    const gap1 = inPossession ? 10 + lineNoise * 3 : 6.2 + lineNoise * 1.2;
    const gap2 = inPossession ? 10 + (1 - lineNoise) * 3 : 6.2 + (1 - lineNoise) * 1.2;
    const lineX = [6, defLineLocal, defLineLocal + gap1, defLineLocal + gap1 + gap2];
    const lateralShift = clamp((ball.y - 34) * 0.35, -12, 12);
    const cbSlots = byTeam[teamId].filter((slot) => slot.role === "CB");
    const stSlots = byTeam[teamId].filter((slot) => slot.role === "ST");
    const primarySt = stSlots.length > 0 ? stSlots[hash(`${anchor?.id ?? "none"}:${teamId}:lead-st`) % stSlots.length] : undefined;
    const oppDefLineLocal = (() => {
      const oppInPossession = opposite(teamId) === possession;
      const oppBallLocalX = toLocalX(opposite(teamId), ball.x);
      return oppInPossession ? clamp(oppBallLocalX - 30, 25, 70) : clamp(35 + lineNoise * 10 + (oppBallLocalX - 52.5) * 0.08, 35, 45);
    })();
    for (const slot of byTeam[teamId]) {
      const traitsFor = traits.get(slot.playerId)!;
      let localX = lineX[slot.lineIndex] ?? slot.localX;
      let localY = 34 + slot.sideNorm * (blockWidth / 2) + lateralShift;
      const nearBallSide = (ball.y >= 34 && slot.sideNorm >= 0) || (ball.y < 34 && slot.sideNorm < 0);
      const narrow = nearBallSide ? 1 : inPossession ? 0.82 : 0.68;
      localY = 34 + (localY - 34) * narrow;

      if (slot.role === "GK") {
        localX = defLineLocal > 47 ? 14 + lineNoise * 4 : 6 + lineNoise * 2;
        localY = clamp(34 + (ball.y - 34) * 0.15, 25, 43);
      } else if (slot.role === "DM") {
        localX = defLineLocal + 8.5 + lineNoise * 1.5;
      } else if (slot.role === "CB") {
        const indexOnLine = cbSlots.findIndex((entry) => entry.playerId === slot.playerId);
        const span = 6 + lineNoise * 1.5;
        localY = 34 + (indexOnLine === 0 ? -span : span);
        if (!inPossession && ballLocalX > localX + 7) {
          const recover = clamp(ballLocalX - localX, 0, 16);
          localX -= 3.5 + recover * 0.48;
          markBurst(slot.playerId, 1);
        }
      } else if (slot.role === "RB" || slot.role === "LB") {
        const right = slot.role === "RB";
        const sameSide = right ? ball.y < 34 : ball.y >= 34;
        if (inPossession && sameSide && ballLocalX > 45) {
          localX += 12 + lineNoise * 6;
          localY = right ? 8 + widthNoise * 2 : 60 - widthNoise * 2;
          markBurst(slot.playerId, 1);
        } else if (!sameSide) {
          localY = 34 + (localY - 34) * 0.6;
        }
      } else if (slot.role === "RW" || slot.role === "LW" || slot.role === "RM" || slot.role === "LM") {
        const right = slot.role === "RW" || slot.role === "RM";
        const sameSide = right ? ball.y < 34 : ball.y >= 34;
        const ownFb = byTeam[teamId].find((entry) => entry.role === (right ? "RB" : "LB"));
        const ownFbPoint = ownFb ? targets.get(ownFb.playerId) : undefined;
        const fbOverlapping = ownFbPoint ? toLocalX(teamId, ownFbPoint.x) > defLineLocal + 10 : false;
        if (inPossession && sameSide && !fbOverlapping) {
          localY = right ? 4 + widthNoise * 2 : 64 - widthNoise * 2;
        } else {
          localY = right ? 23 : 45;
        }
      } else if (slot.role === "ST") {
        const lead = next && next.teamId === teamId ? next.atSecond - atSecond : Infinity;
        const dartWindow = lead > 0.35 && lead <= 1.9;
        const sprintWindow = lead > 1.9 && lead <= 4.2;
        const runWindow = inPossession && ballLocalX > 34 && ballLocalX < 82;
        if (runWindow && primarySt && slot.playerId === primarySt.playerId) {
          if (sprintWindow) {
            localX = Math.max(localX, oppDefLineLocal + 12 + traitsFor.speedNoise * 3);
            markBurst(slot.playerId, 1.15);
          } else {
            localX = Math.max(localX, oppDefLineLocal + 11 + traitsFor.speedNoise * 3);
            markBurst(slot.playerId, 0.94);
          }
        } else if (runWindow) {
          localX = Math.max(localX, oppDefLineLocal + 5 + traitsFor.speedNoise * 3);
          markBurst(slot.playerId, 0.52);
        }
        if (dartWindow && primarySt && slot.playerId === primarySt.playerId) {
          localY += slot.sideNorm >= 0 ? -3.3 : 3.3;
          localX = Math.max(localX, oppDefLineLocal + 4.5 + traitsFor.speedNoise * 1.2);
          markBurst(slot.playerId, 1.02);
        }
      }

      localX += slot.localX >= 45 ? (blockLength - 32) * 0.24 : 0;
      const drift = lissajous(traitsFor, atSecond);
      localX += traitsFor.slotOffset.x + drift.x;
      localY += traitsFor.slotOffset.y + drift.y;
      localX = clamp(localX, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M);
      localY = clamp(localY, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M);
      targets.set(slot.playerId, { x: toGlobalX(teamId, localX), y: localY });
    }
  }

  const possessionPlayers = [...targets.entries()]
    .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
    .filter((entry) => entry.slot.teamId === possession);
  if (possessionPlayers.length > 0) {
    const nearestToBall = possessionPlayers.reduce((best, entry) => {
      const dist = Math.hypot(entry.point.x - ball.x, entry.point.y - ball.y);
      return !best || dist < best.dist ? { playerId: entry.playerId, dist } : best;
    }, undefined as { playerId: string; dist: number } | undefined);
    carrierPlayerId = nearestToBall?.playerId;
  }

  const carrierPoint = carrierPlayerId ? targets.get(carrierPlayerId) : undefined;
  if (carrierPoint) {
    const defenders = [...targets.entries()]
      .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
      .filter((entry) => entry.slot.teamId !== possession)
      .sort((left, right) => Math.hypot(left.point.x - carrierPoint.x, left.point.y - carrierPoint.y) - Math.hypot(right.point.x - carrierPoint.x, right.point.y - carrierPoint.y));
    const first = defenders[0];
    const second = defenders[1];
    const third = defenders[2];
    const nearestDist = first ? Math.hypot(first.point.x - carrierPoint.x, first.point.y - carrierPoint.y) : Infinity;
    const anchorAge = anchor ? atSecond - anchor.atSecond : 99;
    if (first && nearestDist <= 25) {
      const vx = carrierPoint.x - first.point.x;
      const vy = carrierPoint.y - first.point.y;
      const d = Math.hypot(vx, vy) || 1;
      targets.set(first.playerId, {
        x: clamp(carrierPoint.x - (vx / d) * 1.55, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
        y: clamp(carrierPoint.y - (vy / d) * 1.55, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
      });
      markBurst(first.playerId, 1.1);
    }
    if (second && nearestDist <= 25 && anchorAge >= 0.9) {
      const vx = carrierPoint.x - second.point.x;
      const vy = carrierPoint.y - second.point.y;
      const d = Math.hypot(vx, vy) || 1;
      const side = second.slot.sideNorm >= 0 ? 1 : -1;
      targets.set(second.playerId, {
        x: clamp(carrierPoint.x - (vx / d) * 2.2, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
        y: clamp(carrierPoint.y - (vy / d) * 2.2 + side * 0.8, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
      });
      markBurst(second.playerId, 1);
    }
    if (third && nearestDist <= 25) {
      const options = [...targets.entries()]
        .filter(([playerId]) => playerId !== carrierPlayerId && slots.get(playerId)?.teamId === possession)
        .map(([playerId, point]) => ({ playerId, point, dist: Math.hypot(point.x - carrierPoint.x, point.y - carrierPoint.y) }))
        .filter((entry) => entry.dist >= 8)
        .sort((a, b) => a.dist - b.dist);
      const lane = options[0]?.point;
      if (lane) {
        targets.set(third.playerId, {
          x: clamp((carrierPoint.x * 0.55) + (lane.x * 0.45), TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
          y: clamp((carrierPoint.y * 0.55) + (lane.y * 0.45), TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
        });
        markBurst(third.playerId, 0.7);
      }
      if (nearestDist <= 25) {
        for (const [index, defender] of defenders.slice(0, 5).entries()) {
          const current = targets.get(defender.playerId)!;
          const toCarrierX = carrierPoint.x - current.x;
          const toCarrierY = carrierPoint.y - current.y;
          const d = Math.hypot(toCarrierX, toCarrierY) || 1;
          const step = Math.max(0, 2.1 - index * 0.35);
          targets.set(defender.playerId, {
            x: clamp(current.x + (toCarrierX / d) * step, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
            y: clamp(current.y + (toCarrierY / d) * step, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
          });
          markBurst(defender.playerId, 0.36 - index * 0.05);
        }
      }
    }
  }

  if (turnover) {
    const elapsed = atSecond - turnover.atSecond;
    if (elapsed <= 6) {
      const loserTargets = [...targets.entries()]
        .filter(([playerId]) => slots.get(playerId)?.teamId === turnover.loser)
        .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
        .sort((a, b) => Math.hypot(a.point.x - ball.x, a.point.y - ball.y) - Math.hypot(b.point.x - ball.x, b.point.y - ball.y));
      for (let i = 0; i < loserTargets.length; i += 1) {
        const entry = loserTargets[i]!;
        if (i < 3 && elapsed <= 5) {
          const push = 1 - (elapsed / 5);
          const toBallX = ball.x - entry.point.x;
          const toBallY = ball.y - entry.point.y;
          const d = Math.hypot(toBallX, toBallY) || 1;
          targets.set(entry.playerId, {
            x: clamp(entry.point.x + (toBallX / d) * push * (6 - i * 1.5), TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
            y: clamp(entry.point.y + (toBallY / d) * push * (6 - i * 1.5), TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
          });
          markBurst(entry.playerId, 1.05 - i * 0.13);
        } else {
          const dropDuration = entry.slot.role === "CB" ? 4 : 6;
          const blend = clamp(elapsed / dropDuration, 0, 1);
          const localX = toLocalX(entry.slot.teamId, entry.point.x) - (1 - blend) * (entry.slot.role === "CB" ? 4 : 8);
          targets.set(entry.playerId, { x: toGlobalX(entry.slot.teamId, localX), y: entry.point.y });
        }
      }
      const winnerTargets = [...targets.entries()]
        .filter(([playerId]) => slots.get(playerId)?.teamId === turnover.winner)
        .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
        .sort((a, b) => Math.hypot(a.point.x - ball.x, a.point.y - ball.y) - Math.hypot(b.point.x - ball.x, b.point.y - ball.y));
      const winnerCarrier = carrierPlayerId && slots.get(carrierPlayerId)?.teamId === turnover.winner ? carrierPlayerId : undefined;
      const support = winnerCarrier ? winnerTargets.filter((entry) => entry.playerId !== winnerCarrier).slice(0, 2) : [];
      for (const entry of winnerTargets) {
        const delay = 0.5 + (traits.get(entry.playerId)?.speedNoise ?? 0) * 1.0;
        if (elapsed < delay) continue;
        if (entry.slot.role === "ST" || entry.slot.role === "RW" || entry.slot.role === "LW" || entry.slot.role === "RM" || entry.slot.role === "LM") {
          const localX = toLocalX(entry.slot.teamId, entry.point.x) + 6 + (traits.get(entry.playerId)?.speedNoise ?? 0) * 4;
          targets.set(entry.playerId, { x: toGlobalX(entry.slot.teamId, localX), y: entry.point.y });
          markBurst(entry.playerId, 0.98);
        }
      }
      if (winnerCarrier) {
        const carrier = targets.get(winnerCarrier);
        if (carrier) {
          for (const [index, entry] of support.entries()) {
            const dx = index === 0 ? -8 : 10;
            const dy = index === 0 ? -7 : 7;
            const localX = toLocalX(entry.slot.teamId, carrier.x) + dx;
            targets.set(entry.playerId, {
              x: clamp(toGlobalX(entry.slot.teamId, localX), TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
              y: clamp(carrier.y + dy, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
            });
          }
        }
      }
    }
  }

  if (anchor) {
    const d = Math.abs(atSecond - anchor.atSecond);
    const actorTarget = targets.get(anchor.playerId);
    if (actorTarget && d <= 1.2) {
      const influence = d < 0.25 ? 1 : clamp(1 - d / 1.2, 0, 1);
      const dx = ball.x - actorTarget.x;
      const dy = ball.y - actorTarget.y;
      const dist = Math.hypot(dx, dy) || 1;
      const step = Math.min(12, dist) * influence;
      targets.set(anchor.playerId, {
        x: clamp(actorTarget.x + (dx / dist) * step, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
        y: clamp(actorTarget.y + (dy / dist) * step, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
      });
    }
  }
  if (next && next.atSecond >= atSecond) {
    const lead = next.atSecond - atSecond;
    if (lead <= 3) {
      const runnerTarget = targets.get(next.playerId);
      if (runnerTarget) {
        const influence = clamp(1 - lead / 3, 0, 1);
        const dx = next.__point.x - runnerTarget.x;
        const dy = next.__point.y - runnerTarget.y;
        const dist = Math.hypot(dx, dy) || 1;
        const step = Math.min(10, dist) * influence;
        targets.set(next.playerId, {
          x: clamp(runnerTarget.x + (dx / dist) * step, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
          y: clamp(runnerTarget.y + (dy / dist) * step, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
        });
      }
    }
  }

  if (next) {
    const lead = next.atSecond - atSecond;
    const isBoxPhase = lead > 0.2
      && lead <= 3
      && next.teamId === possession
      && (next.type === "shot" || next.type === "goal" || (next.type === "pass" && next.__point.x > 84 && Math.abs(next.__point.y - 34) < 22));
    if (isBoxPhase) {
      const direction = next.teamId === "home" ? 1 : -1;
      const attackers = [...targets.entries()]
        .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
        .filter((entry) => entry.slot.teamId === possession && entry.slot.role !== "GK");
      const pickRole = (roles: string[]) => attackers.find((entry) => roles.includes(entry.slot.role));
      const nearPost = pickRole(["ST", "RW", "LW"]);
      const farPost = attackers.find((entry) => entry !== nearPost && ["ST", "LW", "RW", "RM", "LM"].includes(entry.slot.role));
      const edge = attackers.find((entry) => entry !== nearPost && entry !== farPost && ["CM", "DM", "AM", "RM", "LM"].includes(entry.slot.role));
      const towardTop = next.__point.y >= 34;
      if (nearPost) {
        targets.set(nearPost.playerId, {
          x: clamp(next.__point.x + direction * 2.4, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
          y: clamp(next.__point.y + (towardTop ? -2.8 : 2.8), TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
        });
        markBurst(nearPost.playerId, 0.94);
      }
      if (farPost) {
        targets.set(farPost.playerId, {
          x: clamp(next.__point.x + direction * 1.6, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
          y: clamp(next.__point.y + (towardTop ? 5.8 : -5.8), TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
        });
        markBurst(farPost.playerId, 1.02);
      }
      if (edge) {
        targets.set(edge.playerId, {
          x: clamp(next.__point.x - direction * 8.5, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M),
          y: clamp(next.__point.y + (towardTop ? 1.8 : -1.8), TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M),
        });
        markBurst(edge.playerId, 0.9);
      }
    }
  }

  return {
    second: atSecond,
    ball,
    targets,
    bursts,
    possessingTeam: possession,
    carrierPlayerId,
    ...(anchor ? { eventId: anchor.id } : {}),
    ...(turnover ? { turnover } : {}),
  };
}

function desiredSpeed(dist: number, traits: PlayerTraits, burst = 0): number {
  const idle = 0.2 + traits.speedNoise * 0.35;
  const jog = 1.2 + traits.speedNoise * 1.2;
  const run = 2.8 + traits.speedNoise * 1.4;
  const sprint = 7.1 + traits.speedNoise * 2.1;
  if (burst >= 0.2) {
    const bridge = run + (sprint - run) * clamp((burst - 0.2) / 0.8, 0, 1);
    return burst > 0.9 ? sprint + 0.3 : bridge;
  }
  if (dist < 1.2) return idle;
  if (dist < 3) return jog;
  if (dist < 11) return run;
  if (dist < 18) return run + 0.5;
  return run + 0.8;
}

function limitDeltaVelocity(current: Vec, desired: Vec, dt: number, accelLimit = MAX_ACCEL_MPS2, decelLimit = MAX_DECEL_MPS2): Vec {
  const dvx = desired.x - current.x;
  const dvy = desired.y - current.y;
  const delta = Math.hypot(dvx, dvy);
  if (delta < 1e-9) return desired;
  const currentSpeed = Math.hypot(current.x, current.y);
  const desiredSpeedNow = Math.hypot(desired.x, desired.y);
  const maxDelta = (desiredSpeedNow > currentSpeed ? accelLimit : decelLimit) * dt;
  if (delta <= maxDelta) return desired;
  const scale = maxDelta / delta;
  return { x: current.x + dvx * scale, y: current.y + dvy * scale };
}

function enforceSpacing(players: SimPlayer[]): void {
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i]!;
      const b = players[j]!;
      const min = a.teamId === b.teamId ? 2 : 1.2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= min) continue;
      const push = (min - (dist || 0.001)) / 2;
      const bounded = Math.min(push, 0.32);
      const ux = dist < 0.001 ? 1 : dx / dist;
      const uy = dist < 0.001 ? 0 : dy / dist;
      a.x = clamp(a.x - ux * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
      a.y = clamp(a.y - uy * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
      b.x = clamp(b.x + ux * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
      b.y = clamp(b.y + uy * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
    }
  }
}

function enforceOutputSpacing(players: TrackingPlayer[]): void {
  for (let settle = 0; settle < 3; settle += 1) {
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        const left = players[i]!;
        const right = players[j]!;
        const min = left.teamId === right.teamId ? 2 : 1.2;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= min) continue;
        const gap = (min - (dist || 0.001)) / 2;
        const bounded = Math.min(gap, 0.18);
        const ux = dist < 0.001 ? 1 : dx / dist;
        const uy = dist < 0.001 ? 0 : dy / dist;
        left.x = clamp(left.x - ux * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
        left.y = clamp(left.y - uy * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
        right.x = clamp(right.x + ux * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
        right.y = clamp(right.y + uy * bounded, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
      }
    }
  }
}

const timelineCache = new WeakMap<MatchFixture, PrecomputedTimeline>();

function resolveBall(snapshot: TacticalSnapshot, players: SimPlayer[], exactEventMoment: boolean): Point {
  const projectedBall = { ...snapshot.ball };
  if (!exactEventMoment && snapshot.carrierPlayerId) {
    const carrier = players.find((player) => player.id === snapshot.carrierPlayerId);
    if (carrier) {
      const dx = projectedBall.x - carrier.x;
      const dy = projectedBall.y - carrier.y;
      const dist = Math.hypot(dx, dy) || 1;
      const lead = 0.5 + (carrier.traits.speedNoise * 0.5);
      projectedBall.x = clamp(carrier.x + (dx / dist) * lead, 0.6, TRACKING_PITCH_LENGTH_M - 0.6);
      projectedBall.y = clamp(carrier.y + (dy / dist) * lead, 0.6, TRACKING_PITCH_WIDTH_M - 0.6);
    }
  }
  return projectedBall;
}

function buildTimeline(fixture: MatchFixture): PrecomputedTimeline {
  const events: PossessionEventPoint[] = activePossessionEvents(fixture).map((event) => ({ ...event, __point: eventPointMetres(fixture, event) }));
  const homeSlots = assignSlots(fixture.home, "home", FORMATIONS[formationFor(fixture.seed, "home")]);
  const awaySlots = assignSlots(fixture.away, "away", FORMATIONS[formationFor(fixture.seed, "away")]);
  const allSlots = [...homeSlots, ...awaySlots];
  const slotsById = new Map(allSlots.map((slot) => [slot.playerId, slot]));
  const traitsById = new Map(allSlots.map((slot) => [slot.playerId, makeTraits(fixture.seed, slot)]));

  const snapshotCache = new Map<string, TacticalSnapshot>();
  const getSnapshot = (second: number): TacticalSnapshot => {
    const snapped = clamp(Math.round(second / SIM_DT_SECONDS) * SIM_DT_SECONDS, 0, fixture.durationSeconds);
    const key = snapped.toFixed(3);
    const existing = snapshotCache.get(key);
    if (existing) return existing;
    const snapshot = buildSnapshot(fixture, events, slotsById, traitsById, snapped);
    snapshotCache.set(key, snapshot);
    return snapshot;
  };
  const initial = getSnapshot(0);
  const players: SimPlayer[] = allSlots.map((slot) => {
  const point = initial.targets.get(slot.playerId)!;
  return {
      id: slot.playerId,
      teamId: slot.teamId,
      number: slot.number,
      role: slot.role,
      sideNorm: slot.sideNorm,
      traits: traitsById.get(slot.playerId)!,
      x: point.x,
      y: point.y,
      vx: 0,
      vy: 0,
    };
  });
  const kickoff = events.find((event) => event.atSecond === 0 && event.type === "kickoff");
  if (kickoff) {
    const actor = players.find((player) => player.id === kickoff.playerId);
    if (actor) {
      actor.x = kickoff.__point.x;
      actor.y = kickoff.__point.y;
    }
  }
  for (let settle = 0; settle < 8; settle += 1) enforceSpacing(players);
  const frames: TimelineFrame[] = [];
  frames.push({
    second: 0,
    players: players.map((player) => ({ x: player.x, y: player.y })),
    ball: resolveBall(initial, players, Boolean(events[0] && Math.abs(events[0]!.atSecond) < 0.001)),
    ...(initial.eventId ? { eventId: initial.eventId } : {}),
    ...(initial.carrierPlayerId ? { carrierPlayerId: initial.carrierPlayerId } : {}),
  });

  for (let second = SIM_DT_SECONDS; second <= fixture.durationSeconds + 1e-6; second += SIM_DT_SECONDS) {
    const now = getSnapshot(second);
    const stepStart = new Map(players.map((player) => [player.id, { x: player.x, y: player.y, vx: player.vx, vy: player.vy }]));
    for (const player of players) {
      const ballSideFar = (now.ball.y >= 34 && player.sideNorm < 0) || (now.ball.y < 34 && player.sideNorm > 0);
      const distToBall = Math.hypot(player.x - now.ball.x, player.y - now.ball.y);
      const quick = distToBall < 12 ? 0.65 : distToBall < 20 ? 0.82 : 1;
      const immediateBurst = now.bursts.get(player.id) ?? 0;
      const reactionDelay = Math.max(0.05, (player.traits.reactionDelay * quick + (ballSideFar ? 0.25 : 0)) - immediateBurst * 1.1);
      const perceived = immediateBurst >= 0.9 ? now : getSnapshot(second - reactionDelay);
      const target = perceived.targets.get(player.id) ?? { x: player.x, y: player.y };
      const burst = Math.max(immediateBurst, perceived.bursts.get(player.id) ?? 0);
      const tx = target.x - player.x;
      const ty = target.y - player.y;
      const dist = Math.hypot(tx, ty);
      const movementScale = burst >= 1 ? 0.9 : 0.12 + burst * 0.5;
      const speed = desiredSpeed(dist, player.traits, burst) * player.traits.effort * movementScale;
      let desired = dist < 0.01
        ? { x: player.vx * 0.7, y: player.vy * 0.7 }
        : { x: (tx / dist) * speed, y: (ty / dist) * speed };
      const rightRoom = (TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M) - player.x;
      const leftRoom = player.x - PLAYER_MARGIN_M;
      const topRoom = (TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M) - player.y;
      const bottomRoom = player.y - PLAYER_MARGIN_M;
      if (desired.x > 0 && rightRoom < 10) desired = { ...desired, x: desired.x * ((clamp(rightRoom / 10, 0, 1)) ** 2) };
      if (desired.x < 0 && leftRoom < 10) desired = { ...desired, x: desired.x * ((clamp(leftRoom / 10, 0, 1)) ** 2) };
      if (desired.y > 0 && topRoom < 6) desired = { ...desired, y: desired.y * ((clamp(topRoom / 6, 0, 1)) ** 2) };
      if (desired.y < 0 && bottomRoom < 6) desired = { ...desired, y: desired.y * ((clamp(bottomRoom / 6, 0, 1)) ** 2) };
      const safePosX = Math.sqrt(Math.max(0, 2 * MAX_DECEL_MPS2 * Math.max(0, rightRoom - 0.1)));
      const safeNegX = -Math.sqrt(Math.max(0, 2 * MAX_DECEL_MPS2 * Math.max(0, leftRoom - 0.1)));
      const safePosY = Math.sqrt(Math.max(0, 2 * MAX_DECEL_MPS2 * Math.max(0, topRoom - 0.1)));
      const safeNegY = -Math.sqrt(Math.max(0, 2 * MAX_DECEL_MPS2 * Math.max(0, bottomRoom - 0.1)));
      if (desired.x > safePosX) desired = { ...desired, x: safePosX };
      if (desired.x < safeNegX) desired = { ...desired, x: safeNegX };
      if (desired.y > safePosY) desired = { ...desired, y: safePosY };
      if (desired.y < safeNegY) desired = { ...desired, y: safeNegY };
      const accelLimit = immediateBurst >= 0.9 ? 5 : MAX_ACCEL_MPS2;
      const decelLimit = immediateBurst >= 0.9 ? 5.5 : MAX_DECEL_MPS2;
      const limited = limitDeltaVelocity({ x: player.vx, y: player.vy }, desired, SIM_DT_SECONDS, accelLimit, decelLimit);
      const cap = MAX_PLAYER_SPEED_MPS / Math.max(0.001, Math.hypot(limited.x, limited.y));
      player.vx = cap < 1 ? limited.x * cap : limited.x;
      player.vy = cap < 1 ? limited.y * cap : limited.y;
      player.x = clamp(player.x + player.vx * SIM_DT_SECONDS, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
      player.y = clamp(player.y + player.vy * SIM_DT_SECONDS, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
    }
    for (let settle = 0; settle < 4; settle += 1) enforceSpacing(players);
    for (const player of players) {
      const start = stepStart.get(player.id)!;
      const proposed = {
        x: (player.x - start.x) / SIM_DT_SECONDS,
        y: (player.y - start.y) / SIM_DT_SECONDS,
      };
      const limited = limitDeltaVelocity({ x: start.vx, y: start.vy }, proposed, SIM_DT_SECONDS);
      const speed = Math.hypot(limited.x, limited.y);
      const capped = speed > MAX_PLAYER_SPEED_MPS
        ? { x: (limited.x / speed) * MAX_PLAYER_SPEED_MPS, y: (limited.y / speed) * MAX_PLAYER_SPEED_MPS }
        : limited;
      const nextX = clamp(start.x + capped.x * SIM_DT_SECONDS, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
      const nextY = clamp(start.y + capped.y * SIM_DT_SECONDS, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
      player.vx = (nextX - start.x) / SIM_DT_SECONDS;
      player.vy = (nextY - start.y) / SIM_DT_SECONDS;
      player.x = nextX;
      player.y = nextY;
    }
    for (let settle = 0; settle < 2; settle += 1) enforceSpacing(players);
    if (now.carrierPlayerId) {
      const carrier = players.find((player) => player.id === now.carrierPlayerId);
      if (carrier) {
        const defenders = players
          .filter((player) => player.teamId !== carrier.teamId)
          .map((player) => ({ player, dist: Math.hypot(player.x - carrier.x, player.y - carrier.y) }))
          .sort((a, b) => a.dist - b.dist);
        const first = defenders[0];
        const secondDef = defenders[1];
        const anchor = events[findAnchorIndex(events, second)];
        const anchorAge = anchor ? second - anchor.atSecond : 99;
        const nudgeToward = (entry: { player: SimPlayer; dist: number } | undefined, targetDist: number, maxStep: number) => {
          if (!entry || entry.dist > 25) return;
          const dx = carrier.x - entry.player.x;
          const dy = carrier.y - entry.player.y;
          const d = Math.hypot(dx, dy) || 1;
          const desired = Math.max(0, d - targetDist);
          const step = Math.min(desired, maxStep);
          if (step <= 1e-4) return;
          entry.player.x = clamp(entry.player.x + (dx / d) * step, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
          entry.player.y = clamp(entry.player.y + (dy / d) * step, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
        };
        nudgeToward(first, 2.2, 0.35);
        if (anchorAge >= 0.9) nudgeToward(secondDef, 3.1, 0.28);
      }
    }
    enforceSpacing(players);
    for (const player of players) {
      const start = stepStart.get(player.id)!;
      const proposed = {
        x: (player.x - start.x) / SIM_DT_SECONDS,
        y: (player.y - start.y) / SIM_DT_SECONDS,
      };
      const limited = limitDeltaVelocity({ x: start.vx, y: start.vy }, proposed, SIM_DT_SECONDS);
      const speed = Math.hypot(limited.x, limited.y);
      const capped = speed > MAX_PLAYER_SPEED_MPS
        ? { x: (limited.x / speed) * MAX_PLAYER_SPEED_MPS, y: (limited.y / speed) * MAX_PLAYER_SPEED_MPS }
        : limited;
      const nextX = clamp(start.x + capped.x * SIM_DT_SECONDS, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
      const nextY = clamp(start.y + capped.y * SIM_DT_SECONDS, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
      player.vx = (nextX - start.x) / SIM_DT_SECONDS;
      player.vy = (nextY - start.y) / SIM_DT_SECONDS;
      player.x = nextX;
      player.y = nextY;
    }
    const anchor = events[findAnchorIndex(events, second)];
    const exactEventMoment = Boolean(anchor && Math.abs(anchor.atSecond - second) < 0.001);
    frames.push({
      second: clamp(second, 0, fixture.durationSeconds),
      players: players.map((player) => ({ x: player.x, y: player.y })),
      ball: resolveBall(now, players, exactEventMoment),
      ...(now.eventId ? { eventId: now.eventId } : {}),
      ...(now.carrierPlayerId ? { carrierPlayerId: now.carrierPlayerId } : {}),
    });
  }
  return {
    order: allSlots.map((slot) => ({ id: slot.playerId, teamId: slot.teamId, number: slot.number })),
    frames,
  };
}

/** Deterministic synthetic tracking from event coordinates in the shared 105x68 frame. */
export function buildTrackingFrame(fixture: MatchFixture, atSecond: number): TrackingFrame {
  const at = clamp(atSecond, 0, fixture.durationSeconds);
  const rawTick = at / SIM_DT_SECONDS;
  const nearestTick = Math.round(rawTick);
  const sampledAt = Math.abs(rawTick - nearestTick) < 1e-6 ? nearestTick * SIM_DT_SECONDS : at;
  let timeline = timelineCache.get(fixture);
  if (!timeline) {
    timeline = buildTimeline(fixture);
    timelineCache.set(fixture, timeline);
  }
  const position = clamp(sampledAt / SIM_DT_SECONDS, 0, timeline.frames.length - 1);
  const low = Math.floor(position);
  const high = Math.min(timeline.frames.length - 1, Math.ceil(position));
  const alpha = position - low;
  const left = timeline.frames[low]!;
  const right = timeline.frames[high]!;

  const trackingPlayers: TrackingPlayer[] = timeline.order.map((meta, index) => {
    const a = left.players[index]!;
    const b = right.players[index]!;
    return {
      id: meta.id,
      teamId: meta.teamId,
      number: meta.number,
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
    };
  });
  const ball = {
    x: left.ball.x + (right.ball.x - left.ball.x) * alpha,
    y: left.ball.y + (right.ball.y - left.ball.y) * alpha,
  };
  const tag = alpha < 0.5 ? left : right;
  const events = activePossessionEvents(fixture);
  const anchorIndex = findAnchorIndex(events, sampledAt);
  const anchor = anchorIndex >= 0 ? events[anchorIndex] : undefined;
  const exactEvent = anchor && Math.abs(anchor.atSecond - sampledAt) < 0.001 ? anchor : undefined;
  if (exactEvent) {
    const point = eventPointMetres(fixture, exactEvent);
    ball.x = point.x;
    ball.y = point.y;
  }

  return {
    fixtureId: fixture.id,
    seed: fixture.seed,
    second: at,
    synthetic: true,
    ...(tag.eventId ? { eventId: tag.eventId } : {}),
    ...(tag.carrierPlayerId ? { carrierPlayerId: tag.carrierPlayerId } : {}),
    players: trackingPlayers,
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
