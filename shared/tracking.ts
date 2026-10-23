import { placeEvent } from "./ballPath.js";
import { EVENT_TYPES, type MatchEvent, type MatchFixture, type Team, type TeamId } from "./types.js";

export const TRACKING_PITCH_LENGTH_M = 105;
export const TRACKING_PITCH_WIDTH_M = 68;
export const TRACKING_DELAY_SECONDS = 3;
const MAX_PLAYER_SPEED_MPS = 9.5;
const MAX_ACCEL_MPS2 = 3.8;
const MAX_DECEL_MPS2 = 5;
const SIM_DT_SECONDS = 0.2;
const PLAYER_MARGIN_M = 3.5;
const TARGET_MARGIN_M = 3.5;
/** Last-resort position bound. Braking keeps players inside PLAYER_MARGIN_M, so this should not bite. */
const HARD_MARGIN_M = 0.5;
/** Target smoothing time constant for players without catch-up priority. */
const TARGET_SMOOTHING_TAU_SECONDS = 0.7;
/** Inside this distance from the smoothed target, speed ramps down linearly. */
const ARRIVE_RADIUS_M = 2.5;
/** Deceleration budget used to brake before a bound; below both MAX_ACCEL_MPS2 and MAX_DECEL_MPS2 so the final pass can always honour it. */
const EDGE_BRAKE_MPS2 = 3.5;
/** Goalkeeper depth limits in metres from the own goal line. Targets use both; positions only the hard one. */
const GK_SETTLED_DEPTH_M = 18;
const GK_SWEEPING_DEPTH_M = 24;

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
  urgentRunners: Set<string>;
  possessingTeam: TeamId;
  carrierPlayerId?: string;
  eventId?: string;
  eventActorId?: string;
  anchorEventPoint?: Point;
  anchorAgeSeconds?: number;
  anchorFlightSeconds?: number;
  anchorType?: MatchEvent["type"];
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
  /** Exponentially smoothed target; removes high-frequency target wobble. */
  sx: number;
  sy: number;
}

interface TimelineOrderEntry {
  id: string;
  teamId: TeamId;
  number: number;
  role: string;
}

interface FixtureTimelineContext {
  events: PossessionEventPoint[];
  slotsById: Map<string, PlayerSlot>;
  traitsById: Map<string, PlayerTraits>;
  deactivatedAt: Map<string, number>;
  eventSignature: string;
}

interface PackedTimeline {
  capacitySteps: number;
  stepCount: number;
  playerCount: number;
  players: Float32Array;
  ball: Float32Array;
  eventIds: Array<string | undefined>;
  carrierPlayerIds: Array<string | undefined>;
}

interface CachedTimeline {
  key: string;
  fixtureId: string;
  seed: number;
  rosterSignature: string;
  durationSeconds: number;
  order: TimelineOrderEntry[];
  players: SimPlayer[];
  context: FixtureTimelineContext;
  packed: PackedTimeline;
  builtStep: number;
  touchedAt: number;
  lastEventCount: number;
  lastTail: string;
  lastEventsRef: MatchEvent[];
  lastFixtureRef?: MatchFixture;
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

function eventPointMetresAt(fixture: MatchFixture, event: MatchEvent, x: number, y: number): Point {
  const point = placeEvent(fixture, event, x, y);
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

function findAnchorIndex(events: PossessionEvent[], atSecond: number, end = events.length): number {
  let low = 0;
  let high = end - 1;
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
    lissajousAmp: { x: 0.35 + rand() * 0.3, y: 0.35 + rand() * 0.3 },
    lissajousPeriod: { x: 14 + rand() * 8, y: 14 + rand() * 8 },
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
  end: number,
  deactivatedAt?: Map<string, number>,
): TacticalSnapshot {
  const index = findAnchorIndex(events, atSecond, end);
  const anchor = index >= 0 ? events[index] : undefined;
  const next = index + 1 < end ? events[index + 1] : undefined;
  const possession = anchor?.teamId ?? "home";
  let previousDifferent: PossessionEventPoint | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (events[i]!.teamId !== possession) { previousDifferent = events[i]; break; }
  }
  const turnover = anchor && previousDifferent && previousDifferent.teamId !== anchor.teamId
    ? { atSecond: anchor.atSecond, winner: anchor.teamId, loser: previousDifferent.teamId }
    : undefined;
  let ball = buildBallPoint(anchor, next, atSecond, fixture.seed);
  let anchorFlightSeconds: number | undefined;
  const anchorAge = anchor ? Math.max(0, atSecond - anchor.atSecond) : undefined;
  if (anchor && anchorAge !== undefined) {
    const endPoint = typeof anchor.endX === "number" && typeof anchor.endY === "number"
      ? eventPointMetresAt(fixture, anchor, anchor.endX, anchor.endY)
      : next?.__point;
    if ((anchor.type === "pass" || anchor.type === "shot" || anchor.type === "goal" || anchor.type === "corner") && endPoint) {
      const distance = Math.hypot(endPoint.x - anchor.__point.x, endPoint.y - anchor.__point.y);
      const configuredFlight = typeof anchor.flightMs === "number" && anchor.flightMs > 0 ? anchor.flightMs / 1000 : undefined;
      const speedMps = (typeof anchor.speedKmh === "number" && anchor.speedKmh > 0)
        ? (anchor.speedKmh / 3.6)
        : (anchor.type === "shot" || anchor.type === "goal" ? 28 : 18);
      const computedFlight = distance / Math.max(0.1, speedMps);
      anchorFlightSeconds = clamp(configuredFlight ?? computedFlight, SIM_DT_SECONDS, 3);
      const progress = clamp(anchorAge / anchorFlightSeconds, 0, 1);
      ball = {
        x: anchor.__point.x + (endPoint.x - anchor.__point.x) * progress,
        y: anchor.__point.y + (endPoint.y - anchor.__point.y) * progress,
      };
      if (anchorAge > anchorFlightSeconds && next && next.atSecond > anchor.atSecond + anchorFlightSeconds) {
        const travel = easeInOut(clamp((atSecond - anchor.atSecond - anchorFlightSeconds) / (next.atSecond - anchor.atSecond - anchorFlightSeconds), 0, 1));
        ball = { x: endPoint.x + (next.__point.x - endPoint.x) * travel, y: endPoint.y + (next.__point.y - endPoint.y) * travel };
      }
    } else if (["tackle", "interception", "recovery", "foul", "carry"].includes(anchor.type)) {
      const snapBlend = clamp(anchorAge / 0.35, 0, 1);
      ball = {
        x: anchor.__point.x + (ball.x - anchor.__point.x) * snapBlend,
        y: anchor.__point.y + (ball.y - anchor.__point.y) * snapBlend,
      };
    }
  }
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
  const clampX = (x: number) => clamp(x, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M);
  const clampY = (y: number) => clamp(y, TARGET_MARGIN_M, TRACKING_PITCH_WIDTH_M - TARGET_MARGIN_M);
  const active = (playerId: string) => !deactivatedAt || playerActive(playerId, atSecond, deactivatedAt);
  const distToBall = (point: Point) => Math.hypot(point.x - ball.x, point.y - ball.y);

  const byTeam: Record<TeamId, PlayerSlot[]> = { home: [], away: [] };
  for (const slot of slots.values()) byTeam[slot.teamId].push(slot);
  const sideOf = (slot: PlayerSlot) => (slot.sideNorm >= 0 ? 1 : -1);
  for (const teamId of ["home", "away"] as const) {
    const inPossession = teamId === possession;
    const ballLocalX = toLocalX(teamId, ball.x);
    const ballSide = ball.y >= 34 ? 1 : -1;
    const lineNoise = lcg(hash(`${fixture.seed}:${teamId}:line-noise`))();
    const widthNoise = lcg(hash(`${fixture.seed}:${teamId}:width-noise`))();
    // Compact unit: a back line, a midfield line and a front line whose
    // positions slide with the ball's x and shift toward the ball side.
    let backX: number;
    let midX: number;
    let frontX: number;
    if (inPossession) {
      backX = clamp(ballLocalX - 24 - lineNoise * 3, 9, 58);
      frontX = clamp(ballLocalX + 16 + lineNoise * 2, 40, 93);
      if (frontX - backX > 44) backX = frontX - 44;
      if (frontX - backX < 30) frontX = backX + 30;
      midX = backX + (frontX - backX) * 0.42;
    } else {
      backX = clamp(ballLocalX - 24 - lineNoise * 2, 10, 48);
      // The midfield line screens ~12 m behind the ball where depth allows.
      midX = clamp(ballLocalX - 12, backX + 8, backX + 13);
      frontX = midX + 14 + lineNoise * 4;
    }
    const centreY = 34 + clamp((ball.y - 34) * (inPossession ? 0.35 : 0.55), -14, 14);
    const stSlots = byTeam[teamId].filter((slot) => slot.role === "ST");
    const primarySt = stSlots.length > 0 ? stSlots[hash(`${anchor?.id ?? "none"}:${teamId}:lead-st`) % stSlots.length] : undefined;
    for (const slot of byTeam[teamId]) {
      const traitsFor = traits.get(slot.playerId)!;
      const side = sideOf(slot);
      const farSide = side !== ballSide;
      let localX = midX;
      let y = centreY;
      switch (slot.role) {
        case "GK":
          localX = backX > 40 ? 14 + lineNoise * 4 : 6 + lineNoise * 2;
          y = clamp(34 + (ball.y - 34) * 0.15, 25, 43);
          break;
        case "CB":
          localX = backX;
          y = inPossession
            ? 34 + side * (ballLocalX < 35 ? 15 : 11) + (ball.y - 34) * 0.15
            : centreY + side * (5.5 + widthNoise);
          break;
        case "RB":
        case "LB":
          if (inPossession) {
            localX = farSide ? backX + 6 : backX + (ballLocalX > 45 ? 18 : 12);
            y = 34 + side * (farSide ? 21 : 27);
          } else {
            localX = backX + (farSide ? 0 : 1);
            y = centreY + side * (16 + widthNoise * 2);
          }
          break;
        case "DM":
          localX = inPossession ? clamp(ballLocalX - 12, backX + 6, midX) : midX - 4;
          y = inPossession ? 34 + (ball.y - 34) * 0.4 : centreY;
          break;
        case "CM":
        case "AM":
          localX = inPossession ? midX + 2 : midX;
          y = centreY + side * (inPossession ? 11 : stSlots.length >= 2 ? 7 : 9);
          break;
        case "RW":
        case "LW":
        case "RM":
        case "LM": {
          const winger = slot.role === "RW" || slot.role === "LW";
          if (inPossession) {
            localX = winger ? frontX - 3 : midX + 6;
            y = 34 + side * 29;
          } else {
            // The far-side wide player stays wide as the counter outlet.
            localX = winger ? midX + (farSide ? 6 : 2) : midX;
            y = farSide ? 34 + side * 24 : centreY + side * 19;
          }
          break;
        }
        case "ST":
        default: {
          localX = frontX;
          const pair = stSlots.length >= 2 ? side * 6 : 0;
          y = 34 + (ball.y - 34) * (inPossession ? 0.3 : 0.4) + pair;
          if (inPossession && primarySt && slot.playerId === primarySt.playerId && next && next.teamId === teamId) {
            const lead = next.atSecond - atSecond;
            if (lead > 1.9 && lead <= 4.2 && ballLocalX > 34 && ballLocalX < 82) {
              localX = frontX + 4 + traitsFor.speedNoise * 2;
              markBurst(slot.playerId, 1.15);
            } else if (lead > 0.35 && lead <= 1.9) {
              y += slot.sideNorm >= 0 ? -3.3 : 3.3;
              markBurst(slot.playerId, 0.94);
            }
          }
          break;
        }
      }
      if (slot.role !== "GK") {
        const drift = lissajous(traitsFor, atSecond);
        localX += traitsFor.slotOffset.x * 0.6 + drift.x;
        y += traitsFor.slotOffset.y * 0.6 + drift.y;
      }
      const kickoffWindow = Boolean(anchor && anchor.type === "kickoff" && atSecond >= anchor.atSecond && atSecond <= anchor.atSecond + 2.5);
      if (kickoffWindow) {
        // The defending side must stay clear of the centre circle; the
        // attacking side leaves only the taker at the centre spot.
        localX = Math.min(localX, teamId === anchor!.teamId ? 50.3 : 43.1);
      }
      targets.set(slot.playerId, { x: clampX(toGlobalX(teamId, clamp(localX, TARGET_MARGIN_M, TRACKING_PITCH_LENGTH_M - TARGET_MARGIN_M))), y: clampY(y) });
    }
  }

  const possessionPlayers = [...targets.entries()]
    .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
    .filter((entry) => entry.slot.teamId === possession && entry.slot.role !== "GK" && active(entry.playerId));
  if (possessionPlayers.length > 0) {
    const nearestToBall = possessionPlayers.reduce((best, entry) => {
      const dist = distToBall(entry.point);
      return !best || dist < best.dist ? { playerId: entry.playerId, dist } : best;
    }, undefined as { playerId: string; dist: number } | undefined);
    carrierPlayerId = nearestToBall?.playerId;
  }
  const ballInFlight = anchorFlightSeconds !== undefined && anchorAge !== undefined && anchorAge <= anchorFlightSeconds;
  if (!ballInFlight && carrierPlayerId && targets.has(carrierPlayerId) && slots.get(carrierPlayerId)?.teamId === possession) {
    targets.set(carrierPlayerId, { x: clampX(ball.x), y: clampY(ball.y) });
  }

  // Out of possession: one primary presser goal-side of the ball and one
  // cover player; a third joins only in the counter-press window.
  const defending = opposite(possession);
  const counterPress = Boolean(turnover && turnover.loser === defending && atSecond - turnover.atSecond <= 3);
  const pressers: string[] = [];
  {
    const goalX = defending === "home" ? 0 : TRACKING_PITCH_LENGTH_M;
    const toGoalX = goalX - ball.x;
    const toGoalY = 34 - ball.y;
    const toGoalLen = Math.hypot(toGoalX, toGoalY) || 1;
    const ux = toGoalX / toGoalLen;
    const uy = toGoalY / toGoalLen;
    // Rank against a point that is stable for the whole event segment (where
    // the ball is going, else where it was played) so roles do not flicker.
    const rankPoint = next?.__point ?? anchor?.__point ?? ball;
    const candidates = [...targets.entries()]
      .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
      .filter((entry) => entry.slot.teamId === defending && entry.slot.role !== "GK" && active(entry.playerId))
      .map((entry) => ({ ...entry, dist: Math.min(distToBall(entry.point), Math.hypot(entry.point.x - rankPoint.x, entry.point.y - rankPoint.y)) }))
      .sort((a, b) => a.dist - b.dist || a.playerId.localeCompare(b.playerId));
    const first = candidates[0];
    if (first && first.dist <= 25) {
      targets.set(first.playerId, { x: clampX(ball.x + ux * 1.6), y: clampY(ball.y + uy * 1.6) });
      markBurst(first.playerId, 1.1);
      pressers.push(first.playerId);
      const cover = candidates[1];
      if (cover && cover.dist <= 25) {
        const lateral = ball.y >= 34 ? -2 : 2;
        targets.set(cover.playerId, { x: clampX(ball.x + ux * 6.5), y: clampY(ball.y + uy * 6.5 + lateral) });
        markBurst(cover.playerId, 0.6);
        pressers.push(cover.playerId);
      }
      const third = candidates[2];
      if (counterPress && third && third.dist <= 25) {
        targets.set(third.playerId, { x: clampX(ball.x - uy * 4.5), y: clampY(ball.y + ux * 4.5) });
        markBurst(third.playerId, 0.9);
        pressers.push(third.playerId);
      }
    }
  }

  // Counter-attack after a turnover: forwards break, two support options.
  if (turnover) {
    const elapsed = atSecond - turnover.atSecond;
    if (elapsed <= 6) {
      const winnerTargets = [...targets.entries()]
        .filter(([playerId]) => slots.get(playerId)?.teamId === turnover.winner && active(playerId))
        .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
        .sort((a, b) => distToBall(a.point) - distToBall(b.point));
      for (const entry of winnerTargets) {
        const delay = 0.5 + (traits.get(entry.playerId)?.speedNoise ?? 0) * 1.0;
        if (elapsed < delay || entry.playerId === carrierPlayerId) continue;
        if (entry.slot.role === "ST" || entry.slot.role === "RW" || entry.slot.role === "LW" || entry.slot.role === "RM" || entry.slot.role === "LM") {
          const localX = toLocalX(entry.slot.teamId, entry.point.x) + 6 + (traits.get(entry.playerId)?.speedNoise ?? 0) * 4;
          targets.set(entry.playerId, { x: clampX(toGlobalX(entry.slot.teamId, localX)), y: entry.point.y });
          markBurst(entry.playerId, 0.98);
        }
      }
    }
  }

  // In possession: two support options 10-20 m from the ball.
  if (carrierPlayerId) {
    const support = [...targets.entries()]
      .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
      .filter((entry) => entry.slot.teamId === possession && entry.slot.role !== "GK" && entry.playerId !== carrierPlayerId && active(entry.playerId))
      .map((entry) => ({ ...entry, dist: distToBall(entry.point) }))
      .sort((a, b) => a.dist - b.dist || a.playerId.localeCompare(b.playerId))
      .slice(0, 2);
    for (const entry of support) {
      if (entry.dist <= 18) continue;
      const scale = 15 / entry.dist;
      targets.set(entry.playerId, { x: clampX(ball.x + (entry.point.x - ball.x) * scale), y: clampY(ball.y + (entry.point.y - ball.y) * scale) });
    }
  }

  // Box occupation for an imminent shot or cut-back.
  if (next) {
    const lead = next.atSecond - atSecond;
    const isBoxPhase = lead > 0.2
      && lead <= 3
      && next.teamId === possession
      && (next.type === "shot" || next.type === "goal" || (next.type === "pass" && toLocalX(possession, next.__point.x) > 84 && Math.abs(next.__point.y - 34) < 22));
    if (isBoxPhase) {
      const direction = next.teamId === "home" ? 1 : -1;
      const attackers = [...targets.entries()]
        .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)! }))
        .filter((entry) => entry.slot.teamId === possession && entry.slot.role !== "GK" && entry.playerId !== carrierPlayerId && entry.playerId !== next.playerId && active(entry.playerId));
      const nearPost = attackers.find((entry) => ["ST", "RW", "LW"].includes(entry.slot.role));
      const farPost = attackers.find((entry) => entry !== nearPost && ["ST", "LW", "RW", "RM", "LM"].includes(entry.slot.role));
      const towardTop = next.__point.y >= 34;
      if (nearPost) {
        targets.set(nearPost.playerId, { x: clampX(next.__point.x + direction * 2.4), y: clampY(next.__point.y + (towardTop ? -4 : 4)) });
        markBurst(nearPost.playerId, 0.94);
      }
      if (farPost) {
        targets.set(farPost.playerId, { x: clampX(next.__point.x + direction * 1.6), y: clampY(next.__point.y + (towardTop ? 7 : -7)) });
        markBurst(farPost.playerId, 1.02);
      }
    }
  }

  // Event actors: only the anchor actor and the direct receiver (next actor)
  // get catch-up priority. Nobody else converges on the ball.
  const prepared = new Set<string>();
  if (anchor) {
    const d = Math.abs(atSecond - anchor.atSecond);
    const actorTarget = targets.get(anchor.playerId);
    if (actorTarget && d <= 2.4) {
      const influence = clamp(1 - d / 2.4, 0, 1);
      targets.set(anchor.playerId, {
        x: clampX(actorTarget.x + (anchor.__point.x - actorTarget.x) * influence),
        y: clampY(actorTarget.y + (anchor.__point.y - actorTarget.y) * influence),
      });
      markBurst(anchor.playerId, d <= 0.8 ? 1.1 : 0.96);
    }
  }
  if (next && next.atSecond >= atSecond && targets.has(next.playerId) && !(anchor?.type === "kickoff" && atSecond - anchor.atSecond <= 0.2)) {
    prepared.add(next.playerId);
    targets.set(next.playerId, next.__point);
    markBurst(next.playerId, 1.05);
  }
  if (anchor && atSecond - anchor.atSecond <= 0.4 && targets.has(anchor.playerId)) {
    targets.set(anchor.playerId, anchor.__point);
  }

  // Crowd cap: at most three of a team near the ball (two out of possession
  // outside the counter-press). Priority roles are never displaced.
  {
    const priority = new Set<string>([...pressers, ...prepared]);
    if (anchor) priority.add(anchor.playerId);
    if (carrierPlayerId) priority.add(carrierPlayerId);
    // Targets use a wider ring than the 10 m band so lagging positions stay outside it.
    const CAP_RADIUS_M = 12;
    const PUSH_RADIUS_M = 15;
    for (const teamId of ["home", "away"] as const) {
      const quota = teamId !== possession && counterPress ? 3 : 2;
      const near = [...targets.entries()]
        .filter(([playerId]) => slots.get(playerId)!.teamId === teamId && active(playerId))
        .map(([playerId, point]) => ({ playerId, point, slot: slots.get(playerId)!, dist: distToBall(point) }))
        .filter((entry) => entry.dist < PUSH_RADIUS_M)
        .sort((a, b) => {
          const pa = a.slot.role === "GK" || priority.has(a.playerId) ? 0 : 1;
          const pb = b.slot.role === "GK" || priority.has(b.playerId) ? 0 : 1;
          return pa - pb || a.dist - b.dist || a.playerId.localeCompare(b.playerId);
        });
      let kept = 0;
      for (const entry of near) {
        const fixed = entry.slot.role === "GK" || priority.has(entry.playerId);
        if (fixed || (kept < quota && entry.dist < CAP_RADIUS_M)) {
          if (entry.dist < CAP_RADIUS_M) kept += 1;
          continue;
        }
        if (entry.dist >= CAP_RADIUS_M && kept < quota) continue;
        // Push radially out, biased toward the player's own goal so the
        // displaced player drops into the block rather than past the ball.
        const ownGoalX = teamId === "home" ? -1 : 1;
        let ux = entry.point.x - ball.x;
        let uy = entry.point.y - ball.y;
        const len = Math.hypot(ux, uy);
        if (len < 0.5) { ux = ownGoalX; uy = 0; } else { ux /= len; uy /= len; }
        targets.set(entry.playerId, { x: clampX(ball.x + ux * PUSH_RADIUS_M), y: clampY(ball.y + uy * PUSH_RADIUS_M) });
        markBurst(entry.playerId, 0.85);
      }
    }
  }

  if (anchor?.type === "kickoff" && atSecond - anchor.atSecond <= 2.5) {
    for (const [playerId, point] of targets) {
      const slot = slots.get(playerId)!;
      if (slot.teamId === anchor.teamId && playerId === anchor.playerId) continue;
      const limit = slot.teamId === anchor.teamId ? 50.3 : 43.1;
      targets.set(playerId, { ...point, x: toGlobalX(slot.teamId, Math.min(toLocalX(slot.teamId, point.x), limit)) });
    }
  }
  // Depth limits act on the goalkeeper's target, never on the position, so a
  // change of sweeping state is followed at speed/acceleration limits.
  for (const [playerId, point] of targets) {
    const slot = slots.get(playerId)!;
    if (slot.role !== "GK") continue;
    const maxDepth = goalkeeperSweeping(slot.teamId, ball, point.y) ? GK_SWEEPING_DEPTH_M : GK_SETTLED_DEPTH_M;
    if (toLocalX(slot.teamId, point.x) > maxDepth) targets.set(playerId, { ...point, x: toGlobalX(slot.teamId, maxDepth) });
  }

  return {
    second: atSecond,
    ball,
    targets,
    bursts,
    urgentRunners: prepared,
    possessingTeam: possession,
    carrierPlayerId,
    ...(anchor ? { eventId: anchor.id } : {}),
    ...(anchor ? { eventActorId: anchor.playerId, anchorEventPoint: anchor.__point, anchorAgeSeconds: Math.max(0, atSecond - anchor.atSecond), anchorType: anchor.type } : {}),
    ...(anchorFlightSeconds !== undefined ? { anchorFlightSeconds } : {}),
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

/**
 * Minimum separation of ~2 m between any two players, except the duel between
 * the ball carrier and an opponent, which may close to 1.2 m.
 */
function enforceSpacing(players: SimPlayer[], carrierId?: string): void {
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i]!;
      const b = players[j]!;
      const duel = a.teamId !== b.teamId && carrierId !== undefined && (a.id === carrierId || b.id === carrierId);
      const min = duel ? 1.2 : 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= min) continue;
      const push = (min - (dist || 0.001)) / 2;
      const bounded = Math.min(push, 0.2);
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

const MAX_TIMELINE_CACHE_ENTRIES = 4;
const INITIAL_CAPACITY_STEPS = 512;
const timelineCache = new Map<string, CachedTimeline>();

function timelineKey(fixture: MatchFixture): string {
  // Team ids are always home/away, so names keep two fixtures with the same id+seed apart.
  return `${fixture.id}:${fixture.seed}:${fixture.home.name}|${fixture.away.name}:${buildRosterSignature(fixture)}`;
}

function buildRosterSignature(fixture: MatchFixture): string {
  const serializeTeam = (team: Team) => team.players
    .map((player) => `${player.id}:${player.number}:${player.position}`)
    .sort()
    .join(",");
  return `${fixture.home.id}[${serializeTeam(fixture.home)}]|${fixture.away.id}[${serializeTeam(fixture.away)}]`;
}

function buildEventSignature(fixture: MatchFixture): string {
  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((event) => `${event.id}:${event.revision}:${event.type}:${event.minute}:${event.second}:${event.rescinded ? 1 : 0}`)
    .join("|");
}

function buildTimelineContext(fixture: MatchFixture): FixtureTimelineContext {
  const events: PossessionEventPoint[] = activePossessionEvents(fixture).map((event) => ({ ...event, __point: eventPointMetres(fixture, event) }));
  const homeSlots = assignSlots(fixture.home, "home", FORMATIONS[formationFor(fixture.seed, "home")]);
  const awaySlots = assignSlots(fixture.away, "away", FORMATIONS[formationFor(fixture.seed, "away")]);
  const allSlots = [...homeSlots, ...awaySlots];
  const slotsById = new Map(allSlots.map((slot) => [slot.playerId, slot]));
  const traitsById = new Map(allSlots.map((slot) => [slot.playerId, makeTraits(fixture.seed, slot)]));

  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  const deactivatedAt = new Map<string, number>();
  for (const event of latest.values()) {
    if (event.rescinded) continue;
    if (event.type !== "red_card" && event.type !== "substitution") continue;
    const second = secondOf(event);
    const prior = deactivatedAt.get(event.playerId);
    if (prior === undefined || second < prior) deactivatedAt.set(event.playerId, second);
  }
  return {
    events,
    slotsById,
    traitsById,
    deactivatedAt,
    eventSignature: buildEventSignature(fixture),
  };
}

function createPackedTimeline(playerCount: number): PackedTimeline {
  return {
    capacitySteps: INITIAL_CAPACITY_STEPS,
    stepCount: 0,
    playerCount,
    players: new Float32Array(INITIAL_CAPACITY_STEPS * playerCount * 2),
    ball: new Float32Array(INITIAL_CAPACITY_STEPS * 2),
    eventIds: new Array<string | undefined>(INITIAL_CAPACITY_STEPS),
    carrierPlayerIds: new Array<string | undefined>(INITIAL_CAPACITY_STEPS),
  };
}

function ensurePackedCapacity(packed: PackedTimeline, requiredStep: number): void {
  if (requiredStep < packed.capacitySteps) return;
  let nextCapacity = packed.capacitySteps;
  while (requiredStep >= nextCapacity) nextCapacity *= 2;
  const nextPlayers = new Float32Array(nextCapacity * packed.playerCount * 2);
  nextPlayers.set(packed.players);
  packed.players = nextPlayers;
  const nextBall = new Float32Array(nextCapacity * 2);
  nextBall.set(packed.ball);
  packed.ball = nextBall;
  packed.eventIds.length = nextCapacity;
  packed.carrierPlayerIds.length = nextCapacity;
  packed.capacitySteps = nextCapacity;
}

function writeStep(
  packed: PackedTimeline,
  step: number,
  players: SimPlayer[],
  ball: Point,
  eventId?: string,
  carrierPlayerId?: string,
): void {
  ensurePackedCapacity(packed, step);
  const playerOffset = step * packed.playerCount * 2;
  for (let index = 0; index < players.length; index += 1) {
    const player = players[index]!;
    const base = playerOffset + index * 2;
    packed.players[base] = player.x;
    packed.players[base + 1] = player.y;
  }
  const ballOffset = step * 2;
  packed.ball[ballOffset] = ball.x;
  packed.ball[ballOffset + 1] = ball.y;
  packed.eventIds[step] = eventId;
  packed.carrierPlayerIds[step] = carrierPlayerId;
  packed.stepCount = Math.max(packed.stepCount, step + 1);
}

function resolveBall(snapshot: TacticalSnapshot, players: SimPlayer[]): Point {
  const projectedBall = { ...snapshot.ball };
  const inBallisticFlight = Boolean(
    snapshot.anchorType
    && ["pass", "shot", "goal", "corner"].includes(snapshot.anchorType)
    && snapshot.anchorAgeSeconds !== undefined
    && snapshot.anchorFlightSeconds !== undefined
    && snapshot.anchorAgeSeconds <= snapshot.anchorFlightSeconds + 0.25,
  );
  if (!inBallisticFlight && snapshot.anchorAgeSeconds !== undefined && snapshot.anchorAgeSeconds > 0.4 && snapshot.carrierPlayerId) {
    const carrier = players.find((player) => player.id === snapshot.carrierPlayerId);
    if (carrier && Math.hypot(carrier.x - projectedBall.x, carrier.y - projectedBall.y) < 2) {
      projectedBall.x = projectedBall.x * 0.8 + carrier.x * 0.2;
      projectedBall.y = projectedBall.y * 0.8 + carrier.y * 0.2;
    }
  }
  return projectedBall;
}

function playerActive(playerId: string, atSecond: number, deactivatedAt: Map<string, number>): boolean {
  const removedAt = deactivatedAt.get(playerId);
  return removedAt === undefined || atSecond <= removedAt + 1e-6;
}

function goalkeeperSweeping(teamId: TeamId, ball: Point, keeperY: number): boolean {
  return toLocalX(teamId, ball.x) < GK_SWEEPING_DEPTH_M && Math.abs(ball.y - keeperY) < 18;
}

function speedCap(player: SimPlayer, snapshot: TacticalSnapshot): number {
  if (player.role !== "GK") return MAX_PLAYER_SPEED_MPS;
  return goalkeeperSweeping(player.teamId, snapshot.ball, player.y) ? 7.2 : 6.7;
}

/**
 * Caps each velocity component that heads toward a bound to the speed from
 * which EDGE_BRAKE_MPS2 still stops before it. Bounds are the soft pitch
 * margin and, for goalkeepers, the hard sweeping depth.
 */
function brakeBeforeBounds(player: SimPlayer, x: number, y: number, velocity: Vec): Vec {
  // Discrete-time braking speed: v <= sqrt(2a(room - v*dt)) also leaves room for this step.
  const brakeStep = EDGE_BRAKE_MPS2 * SIM_DT_SECONDS;
  const safe = (room: number) => Math.max(0, -brakeStep + Math.sqrt(brakeStep * brakeStep + 2 * EDGE_BRAKE_MPS2 * Math.max(0, room)));
  let maxPosX = safe((TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M) - x);
  let maxNegX = safe(x - PLAYER_MARGIN_M);
  if (player.role === "GK") {
    const room = safe(GK_SWEEPING_DEPTH_M - toLocalX(player.teamId, x));
    if (player.teamId === "home") maxPosX = Math.min(maxPosX, room);
    else maxNegX = Math.min(maxNegX, room);
  }
  const maxPosY = safe((TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M) - y);
  const maxNegY = safe(y - PLAYER_MARGIN_M);
  return {
    x: clamp(velocity.x, -maxNegX, maxPosX),
    y: clamp(velocity.y, -maxNegY, maxPosY),
  };
}

/** Hard goalkeeper depth bound. The correction itself never exceeds one top-speed step. */
function clampGoalkeeperHardDepth(player: SimPlayer, start: Point): void {
  if (player.role !== "GK") return;
  const excess = toLocalX(player.teamId, player.x) - GK_SWEEPING_DEPTH_M;
  if (excess <= 0) return;
  const correction = Math.min(excess, MAX_PLAYER_SPEED_MPS * SIM_DT_SECONDS);
  player.x += player.teamId === "home" ? -correction : correction;
  const dx = player.x - start.x;
  const dy = player.y - start.y;
  const step = Math.hypot(dx, dy);
  const maxStep = MAX_PLAYER_SPEED_MPS * SIM_DT_SECONDS;
  if (step > maxStep) {
    player.x = start.x + (dx / step) * maxStep;
    player.y = start.y + (dy / step) * maxStep;
  }
}

function createInitialTimeline(fixture: MatchFixture, key: string): CachedTimeline {
  const context = buildTimelineContext(fixture);
  const allSlots = [...context.slotsById.values()];
  const order: TimelineOrderEntry[] = allSlots.map((slot) => ({ id: slot.playerId, teamId: slot.teamId, number: slot.number, role: slot.role }));
  const initial = buildSnapshot(fixture, context.events, context.slotsById, context.traitsById, 0, findAnchorIndex(context.events, TRACKING_DELAY_SECONDS + 1e-6) + 1, context.deactivatedAt);
  const players: SimPlayer[] = allSlots.map((slot) => {
    const point = initial.targets.get(slot.playerId)!;
    return {
      id: slot.playerId,
      teamId: slot.teamId,
      number: slot.number,
      role: slot.role,
      sideNorm: slot.sideNorm,
      traits: context.traitsById.get(slot.playerId)!,
      x: point.x,
      y: point.y,
      vx: 0,
      vy: 0,
      sx: point.x,
      sy: point.y,
    };
  });
  for (let settle = 0; settle < 8; settle += 1) enforceSpacing(players);
  if (context.events[0]?.type === "kickoff" && context.events[0].atSecond === 0) {
    for (const player of players) {
      player.x = player.teamId === "home" ? Math.min(player.x, TRACKING_PITCH_LENGTH_M / 2) : Math.max(player.x, TRACKING_PITCH_LENGTH_M / 2);
    }
  }
  const packed = createPackedTimeline(players.length);
  writeStep(packed, 0, players, resolveBall(initial, players), initial.eventId, initial.carrierPlayerId);
  return {
    key,
    fixtureId: fixture.id,
    seed: fixture.seed,
    rosterSignature: buildRosterSignature(fixture),
    durationSeconds: fixture.durationSeconds,
    order,
    players,
    context,
    packed,
    builtStep: 0,
    touchedAt: Date.now(),
    lastEventCount: fixture.events.length,
    lastTail: fixture.events.length > 0 ? `${fixture.events.at(-1)!.id}:${fixture.events.at(-1)!.revision}` : "",
    lastEventsRef: fixture.events,
    lastFixtureRef: fixture,
  };
}

function touchTimeline(entry: CachedTimeline): void {
  entry.touchedAt = Date.now();
}

function trimTimelineCache(): void {
  if (timelineCache.size <= MAX_TIMELINE_CACHE_ENTRIES) return;
  const removable = [...timelineCache.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  while (timelineCache.size > MAX_TIMELINE_CACHE_ENTRIES) {
    const victim = removable.shift();
    if (!victim) break;
    timelineCache.delete(victim[0]);
  }
}

function getOrCreateTimeline(fixture: MatchFixture): CachedTimeline {
  const key = timelineKey(fixture);
  const existing = timelineCache.get(key);
  if (existing) {
    touchTimeline(existing);
    return existing;
  }
  const created = createInitialTimeline(fixture, key);
  timelineCache.set(key, created);
  trimTimelineCache();
  return created;
}

function refreshContextIfNeeded(entry: CachedTimeline, fixture: MatchFixture): void {
  const nextRosterSignature = buildRosterSignature(fixture);
  if (entry.rosterSignature !== nextRosterSignature) {
    const rebuilt = createInitialTimeline(fixture, entry.key);
    Object.assign(entry, rebuilt);
    return;
  }
  const tail = fixture.events.length > 0 ? `${fixture.events.at(-1)!.id}:${fixture.events.at(-1)!.revision}` : "";
  if (entry.lastFixtureRef === fixture && entry.lastEventsRef === fixture.events && entry.lastEventCount === fixture.events.length && entry.lastTail === tail) return;
  if (entry.lastEventsRef === fixture.events && entry.lastEventCount === fixture.events.length && entry.lastTail === tail) {
    entry.lastFixtureRef = fixture;
    return;
  }
  const signature = buildEventSignature(fixture);
  if (signature !== entry.context.eventSignature) {
    entry.context = buildTimelineContext(fixture);
  }
  entry.lastEventCount = fixture.events.length;
  entry.lastTail = tail;
  entry.lastEventsRef = fixture.events;
  entry.lastFixtureRef = fixture;
}

function extendTimeline(entry: CachedTimeline, fixture: MatchFixture, targetStep: number): void {
  refreshContextIfNeeded(entry, fixture);
  const snapshotCache = new Map<string, TacticalSnapshot>();
  const getSnapshot = (second: number): TacticalSnapshot => {
    const snapped = clamp(Math.round(second / SIM_DT_SECONDS) * SIM_DT_SECONDS, 0, fixture.durationSeconds);
    const key = snapped.toFixed(3);
    const cached = snapshotCache.get(key);
    if (cached) return cached;
    const horizonEnd = findAnchorIndex(entry.context.events, snapped + TRACKING_DELAY_SECONDS + 1e-6) + 1;
    const snapshot = buildSnapshot(
      fixture,
      entry.context.events,
      entry.context.slotsById,
      entry.context.traitsById,
      snapped,
      horizonEnd,
      entry.context.deactivatedAt,
    );
    snapshotCache.set(key, snapshot);
    return snapshot;
  };
  for (let step = entry.builtStep + 1; step <= targetStep; step += 1) {
    const second = clamp(step * SIM_DT_SECONDS, 0, fixture.durationSeconds);
    const now = getSnapshot(second);
    const activePlayers = entry.players.filter((player) => playerActive(player.id, second, entry.context.deactivatedAt));
    const stepStart = new Map(activePlayers.map((player) => [player.id, { x: player.x, y: player.y, vx: player.vx, vy: player.vy }]));

    for (const player of entry.players) {
      if (!playerActive(player.id, second, entry.context.deactivatedAt)) {
        player.vx = 0;
        player.vy = 0;
      }
    }

    for (const player of activePlayers) {
      const ballSideFar = (now.ball.y >= 34 && player.sideNorm < 0) || (now.ball.y < 34 && player.sideNorm > 0);
      const distToBall = Math.hypot(player.x - now.ball.x, player.y - now.ball.y);
      const quick = distToBall < 12 ? 0.65 : distToBall < 20 ? 0.82 : 1;
      const immediateBurst = now.bursts.get(player.id) ?? 0;
      const reactionDelay = Math.max(0.05, (player.traits.reactionDelay * quick + (ballSideFar ? 0.25 : 0)) - immediateBurst * 1.1);
      const perceived = immediateBurst >= 0.9 ? now : getSnapshot(second - reactionDelay);
      const nowTarget = now.targets.get(player.id);
      // Clear-out: a player near the ball whose current target is outside the ring leaves without reaction delay.
      const clearOut = Boolean(nowTarget) && distToBall < 11 && Math.hypot(nowTarget!.x - now.ball.x, nowTarget!.y - now.ball.y) > 12;
      const rawTarget = (clearOut ? nowTarget : perceived.targets.get(player.id)) ?? { x: player.x, y: player.y };
      const burst = Math.max(immediateBurst, perceived.bursts.get(player.id) ?? 0);
      const actorCatchup = now.eventActorId === player.id && (now.anchorAgeSeconds ?? Number.POSITIVE_INFINITY) <= 1.4;
      const urgent = now.urgentRunners.has(player.id) || actorCatchup;
      // EMA on the target (tau ~0.7 s, ~0.35 s for pressers); event actors and
      // the direct receiver track their raw target so event spots are reached.
      const tau = urgent ? 0 : burst >= 0.9 || clearOut ? 0.35 : TARGET_SMOOTHING_TAU_SECONDS;
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-SIM_DT_SECONDS / tau);
      player.sx += (rawTarget.x - player.sx) * alpha;
      player.sy += (rawTarget.y - player.sy) * alpha;
      const tx = player.sx - player.x;
      const ty = player.sy - player.y;
      const dist = Math.hypot(tx, ty);
      let movementScale = burst >= 1 ? 0.82 : 0.42 + burst * 0.42;
      // Out-of-shape players hurry back; anyone inside the ball ring whose
      // target is outside it clears out instead of lingering near the ball.
      movementScale = Math.min(0.82, movementScale + clamp((dist - 4) / 16, 0, 1) * 0.3);
      const targetBallDist = Math.hypot(player.sx - now.ball.x, player.sy - now.ball.y);
      if (distToBall < 11 && targetBallDist > 12) movementScale = Math.max(movementScale, 0.8);
      if (urgent) movementScale = 1;
      // Arrive smoothly: speed ramps down inside the last few metres.
      const arrive = urgent ? 1 : clamp(dist / ARRIVE_RADIUS_M, 0, 1);
      let speed = desiredSpeed(dist, player.traits, burst) * player.traits.effort * movementScale * arrive;
      if (!urgent && Math.sin(second * Math.PI * 2 / player.traits.sprintCycle + player.traits.sprintPhase) < 0.45) speed = Math.min(speed, 6.8);
      let desired = dist < 0.01
        ? { x: player.vx * 0.7, y: player.vy * 0.7 }
        : { x: (tx / dist) * speed, y: (ty / dist) * speed };
      const rightRoom = (TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M) - player.x;
      const leftRoom = player.x - PLAYER_MARGIN_M;
      const topRoom = (TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M) - player.y;
      const bottomRoom = player.y - PLAYER_MARGIN_M;
      if (desired.x > 0 && rightRoom < 3) desired = { ...desired, x: desired.x * clamp(rightRoom / 3, 0, 1) };
      if (desired.x < 0 && leftRoom < 3) desired = { ...desired, x: desired.x * clamp(leftRoom / 3, 0, 1) };
      if (desired.y > 0 && topRoom < 3) desired = { ...desired, y: desired.y * clamp(topRoom / 3, 0, 1) };
      if (desired.y < 0 && bottomRoom < 3) desired = { ...desired, y: desired.y * clamp(bottomRoom / 3, 0, 1) };
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
      const absoluteCap = speedCap(player, now);
      const ratio = absoluteCap / Math.max(0.001, Math.hypot(limited.x, limited.y));
      player.vx = ratio < 1 ? limited.x * ratio : limited.x;
      player.vy = ratio < 1 ? limited.y * ratio : limited.y;
      player.x += player.vx * SIM_DT_SECONDS;
      player.y += player.vy * SIM_DT_SECONDS;
      player.x = clamp(player.x, PLAYER_MARGIN_M, TRACKING_PITCH_LENGTH_M - PLAYER_MARGIN_M);
      player.y = clamp(player.y, PLAYER_MARGIN_M, TRACKING_PITCH_WIDTH_M - PLAYER_MARGIN_M);
    }

    for (let settle = 0; settle < 4; settle += 1) enforceSpacing(activePlayers, now.carrierPlayerId);

    if (now.carrierPlayerId) {
      const carrier = activePlayers.find((player) => player.id === now.carrierPlayerId);
      if (carrier) {
        const defenders = activePlayers
          .filter((player) => player.teamId !== carrier.teamId)
          .map((player) => ({ player, dist: Math.hypot(player.x - carrier.x, player.y - carrier.y) }))
          .sort((a, b) => a.dist - b.dist);
        const anchorAge = now.anchorAgeSeconds ?? 99;
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
        // Only the primary presser closes the carrier down; the cover holds.
        if (anchorAge >= 0.9) nudgeToward(defenders[0], 2.2, 0.25);
      }
    }

    enforceSpacing(activePlayers, now.carrierPlayerId);

    // Authoritative kinematic pass: everything above only proposes a position.
    // Brake before bounds first, then limit acceleration and speed against the
    // previous emitted velocity, so the emitted step is what gets limited.
    for (const player of activePlayers) {
      const start = stepStart.get(player.id)!;
      const proposed = brakeBeforeBounds(player, start.x, start.y, {
        x: (player.x - start.x) / SIM_DT_SECONDS,
        y: (player.y - start.y) / SIM_DT_SECONDS,
      });
      const limited = limitDeltaVelocity({ x: start.vx, y: start.vy }, proposed, SIM_DT_SECONDS);
      const cap = speedCap(player, now);
      const speed = Math.hypot(limited.x, limited.y);
      const capped = speed > cap
        ? { x: (limited.x / speed) * cap, y: (limited.y / speed) * cap }
        : limited;
      player.x = clamp(start.x + capped.x * SIM_DT_SECONDS, HARD_MARGIN_M, TRACKING_PITCH_LENGTH_M - HARD_MARGIN_M);
      player.y = clamp(start.y + capped.y * SIM_DT_SECONDS, HARD_MARGIN_M, TRACKING_PITCH_WIDTH_M - HARD_MARGIN_M);
      clampGoalkeeperHardDepth(player, start);
      player.vx = (player.x - start.x) / SIM_DT_SECONDS;
      player.vy = (player.y - start.y) / SIM_DT_SECONDS;
    }

    const simulatedBall = resolveBall(now, activePlayers);
    const previousBall = readBallXY(entry.packed, step - 1);
    const dx = simulatedBall.x - previousBall.x;
    const dy = simulatedBall.y - previousBall.y;
    const speed = Math.hypot(dx, dy) / SIM_DT_SECONDS;
    // Non-flight segments also have to make the next published event origin;
    // bound the actual emitted step rather than teleporting at the anchor.
    const maxBallSpeed = 44.9;
    if (speed > maxBallSpeed) {
      const scale = maxBallSpeed / Math.max(1e-6, speed);
      simulatedBall.x = previousBall.x + dx * scale;
      simulatedBall.y = previousBall.y + dy * scale;
    }
    writeStep(entry.packed, step, entry.players, simulatedBall, now.eventId, now.carrierPlayerId);
    entry.builtStep = step;
  }
}

function readPlayerXY(packed: PackedTimeline, step: number, index: number): Point {
  const base = step * packed.playerCount * 2 + index * 2;
  return { x: packed.players[base]!, y: packed.players[base + 1]! };
}

function readBallXY(packed: PackedTimeline, step: number): Point {
  const base = step * 2;
  return { x: packed.ball[base]!, y: packed.ball[base + 1]! };
}

/** Deterministic synthetic tracking from event coordinates in the shared 105x68 frame. */
export function buildTrackingFrame(fixture: MatchFixture, atSecond: number): TrackingFrame {
  const at = clamp(atSecond, 0, fixture.durationSeconds);
  const rawTick = at / SIM_DT_SECONDS;
  const nearestTick = Math.round(rawTick);
  const sampledAt = Math.abs(rawTick - nearestTick) < 1e-6 ? nearestTick * SIM_DT_SECONDS : at;
  const timeline = getOrCreateTimeline(fixture);
  touchTimeline(timeline);
  const targetStep = Math.min(Math.floor(fixture.durationSeconds / SIM_DT_SECONDS), Math.abs(rawTick - nearestTick) < 1e-6 ? nearestTick : Math.ceil(sampledAt / SIM_DT_SECONDS));
  if (targetStep > timeline.builtStep) extendTimeline(timeline, fixture, targetStep);
  const maxStep = Math.max(0, Math.min(targetStep, timeline.packed.stepCount - 1));
  const position = clamp(sampledAt / SIM_DT_SECONDS, 0, maxStep);
  const low = Math.floor(position);
  const high = Math.min(maxStep, Math.ceil(position));
  const alpha = position - low;
  const leftBall = readBallXY(timeline.packed, low);
  const rightBall = readBallXY(timeline.packed, high);

  refreshContextIfNeeded(timeline, fixture);
  const activeAt = timeline.context.deactivatedAt;
  const trackingPlayers: TrackingPlayer[] = [];
  for (let index = 0; index < timeline.order.length; index += 1) {
    const meta = timeline.order[index]!;
    if (!playerActive(meta.id, at, activeAt)) continue;
    const a = readPlayerXY(timeline.packed, low, index);
    const b = readPlayerXY(timeline.packed, high, index);
    trackingPlayers.push({
      id: meta.id,
      teamId: meta.teamId,
      number: meta.number,
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
    });
  }
  const ball = {
    x: leftBall.x + (rightBall.x - leftBall.x) * alpha,
    y: leftBall.y + (rightBall.y - leftBall.y) * alpha,
  };
  const tagStep = alpha < 0.5 ? low : high;

  return {
    fixtureId: fixture.id,
    seed: fixture.seed,
    second: at,
    synthetic: true,
    ...(timeline.packed.eventIds[tagStep] ? { eventId: timeline.packed.eventIds[tagStep] } : {}),
    ...(timeline.packed.carrierPlayerIds[tagStep] ? { carrierPlayerId: timeline.packed.carrierPlayerIds[tagStep] } : {}),
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

/** Event marker horizon while the delayed tracking overlay is shown: frame second + one 5 Hz step. */
export function trackingMarkerHorizon(frameSecond: number): number {
  return frameSecond + 0.2;
}

/**
 * Hides event markers the delayed tracking overlay has not reached yet, so a
 * goal marker does not appear seconds before the tracked shot. A null horizon
 * (overlay off) returns the input array unchanged.
 */
export function eventsWithinTrackingHorizon<T extends { minute: number; second: number }>(events: T[], horizonSecond: number | null): T[] {
  if (horizonSecond === null) return events;
  const visible = events.filter((event) => event.minute * 60 + event.second <= horizonSecond + 1e-6);
  return visible.length === events.length ? events : visible;
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
