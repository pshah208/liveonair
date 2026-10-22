import { isCameraFixture, placeEvent } from "./ballPath.js";
import { periodBoundary } from "./periods.js";
import type { MatchEvent, MatchFixture, MatchPeriod, Player, TrackingSample } from "./types.js";

/**
 * Pure, deterministic ball and player metrics.
 *
 * Frame: feeds log each team's events in its own attacking frame on a 0–100 grid (x = 100 is the goal it
 * attacks). The grid maps onto a 105 × 68 m pitch. Distances are frame-invariant (mirroring preserves length),
 * forwardness is read in the attacking frame, and `toMetres` places a point on the shared home-attacks-right frame.
 * Camera (video-clip) fixtures report camera-frame positions, so every metre-based figure is null for them.
 *
 * Speeds come only from an event's own `flightMs` / `speedKmh`. They are NEVER derived from the time between two
 * logged events: the gap between events includes control, carries and stoppages, not ball flight.
 */

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;
export const SHORT_PASS_MAX_M = 15;
export const LONG_PASS_MIN_M = 30;
export const PRESSURE_WINDOW_SECONDS = 2;
export const PRESSURE_MAX_DISTANCE_M = 5;
export const SWITCH_OF_PLAY_UNITS = 40;
export const SPRINT_THRESHOLD_KMH = 25;
export const SHOT_SPEED_THRESHOLD_KMH = 100;
export const TOP_SPEED_THRESHOLD_KMH = 32;
export const DISTANCE_MILESTONE_M = 5000;
export const HARD_PASS_THRESHOLD = 75;

export type PassBand = "short" | "medium" | "long";
export type MetricOptions = { camera?: boolean };

export interface DifficultyFactor {
  key: "distance" | "forward" | "final_third" | "box" | "pressure" | "switch" | "cross" | "set_piece";
  label: string;
  points: number;
}

export interface PassDifficulty {
  score: number;
  factors: DifficultyFactor[];
}

/** The published difficulty formula, shown in the UI and used by agents to explain a number. */
export const PASS_DIFFICULTY_FORMULA = [
  "distance: 0.75 pts per metre, max 30",
  "forward progress: 0.6 pts per metre gained towards goal, max 20",
  "ends in the final third (x ≥ 66.7): +10, or in the box (x ≥ 83, 21 ≤ y ≤ 79): +15",
  `matched opponent pressure within ${PRESSURE_WINDOW_SECONDS} s and ${PRESSURE_MAX_DISTANCE_M} m: +15`,
  `switch of play (|Δy| ≥ ${SWITCH_OF_PLAY_UNITS} units): +10`,
  "cross from a wide area into the box, or a set-piece delivery: +10",
  "score = sum, capped at 100; expected completion = clamp(0.97 − 0.0075 × score, 0.2, 0.97)",
] as const;

const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const metresBetween = (dxUnits: number, dyUnits: number) => Math.hypot((dxUnits / 100) * PITCH_LENGTH_M, (dyUnits / 100) * PITCH_WIDTH_M);

function pressureDistanceM(pass: MatchEvent, pressure: MatchEvent): number {
  return metresBetween(pass.x - pressure.x, pass.y - pressure.y);
}

export function isMatchedPressureEvent(pass: MatchEvent, pressure: MatchEvent): boolean {
  if (pass.type !== "pass" || pressure.type !== "pressure") return false;
  if (pressure.teamId === pass.teamId || pressure.rescinded) return false;
  const passAt = secondOf(pass);
  const pressureAt = secondOf(pressure);
  if (pressureAt > passAt || passAt - pressureAt > PRESSURE_WINDOW_SECONDS) return false;
  if (pressure.relatedEventId && pressure.relatedEventId !== pass.id) return false;
  return pressureDistanceM(pass, pressure) <= PRESSURE_MAX_DISTANCE_M;
}

/** Opta-style illustrative rule: completed pass that ends at least 25% closer to the goal centre than it started. */
export function isProgressivePass(event: MatchEvent): boolean {
  if (event.type !== "pass" || event.outcome !== "complete" || event.endX === undefined || event.endY === undefined) return false;
  const start = Math.hypot(100 - event.x, 50 - event.y);
  const end = Math.hypot(100 - event.endX, 50 - event.endY);
  return end <= start * 0.75;
}

export function metricOptions(fixture: Pick<MatchFixture, "id">): MetricOptions {
  return { camera: isCameraFixture(fixture) };
}

/** A point in metres on the shared frame (home attacks left to right). Null for camera fixtures. */
export function toMetres(fixture: Pick<MatchFixture, "id">, event: MatchEvent, x = event.x, y = event.y): { x: number; y: number } | null {
  if (isCameraFixture(fixture)) return null;
  const point = placeEvent(fixture, event, x, y);
  return { x: round((point.x / 100) * PITCH_LENGTH_M, 2), y: round((point.y / 100) * PITCH_WIDTH_M, 2) };
}

/** Where a delivery starts in the attacking frame. Corners always start at the flag, whatever the feed logged. */
function deliveryStart(event: MatchEvent): { x: number; y: number } {
  if (event.type === "corner") return { x: 100, y: event.y < 50 ? 1 : 99 };
  return { x: event.x, y: event.y };
}

/** Length of a pass or corner in metres, or null without an end point or on camera fixtures. */
export function passDistanceM(event: MatchEvent, options: MetricOptions = {}): number | null {
  if (options.camera) return null;
  if (event.type !== "pass" && event.type !== "corner") return null;
  if (event.endX === undefined || event.endY === undefined) return null;
  const start = deliveryStart(event);
  return round(metresBetween(event.endX - start.x, event.endY - start.y));
}

export function passBand(distanceM: number): PassBand {
  if (distanceM < SHORT_PASS_MAX_M) return "short";
  if (distanceM > LONG_PASS_MIN_M) return "long";
  return "medium";
}

function inBox(x: number, y: number): boolean {
  return x >= 83 && y >= 21 && y <= 79;
}

/**
 * Difficulty of a pass or corner, 0–100, from the published formula (PASS_DIFFICULTY_FORMULA).
 * `recentEvents` supplies opponent pressure context; only events up to the pass's own second count.
 */
export function passDifficulty(event: MatchEvent, recentEvents: MatchEvent[] = [], options: MetricOptions = {}): PassDifficulty | null {
  const distance = passDistanceM(event, options);
  if (distance === null) return null;
  const start = deliveryStart(event);
  const endX = event.endX!;
  const endY = event.endY!;
  const factors: DifficultyFactor[] = [];
  const add = (key: DifficultyFactor["key"], label: string, points: number) => {
    if (points > 0) factors.push({ key, label, points: round(points) });
  };
  add("distance", `${Math.round(distance)} m pass`, Math.min(30, distance * 0.75));
  const forwardM = ((endX - start.x) / 100) * PITCH_LENGTH_M;
  if (event.type !== "corner") add("forward", `${Math.round(Math.max(0, forwardM))} m towards goal`, Math.min(20, Math.max(0, forwardM) * 0.6));
  if (inBox(endX, endY)) add("box", "Ends in the box", 15);
  else if (endX >= 66.7) add("final_third", "Ends in the final third", 10);
  const pressured = recentEvents.some((other) => isMatchedPressureEvent(event, other));
  if (pressured) add("pressure", `Under pressure (≤ ${PRESSURE_WINDOW_SECONDS} s)`, 15);
  if (Math.abs(endY - start.y) >= SWITCH_OF_PLAY_UNITS) add("switch", "Switch of play", 10);
  if (event.type === "corner") add("set_piece", "Set-piece delivery", 10);
  else if ((start.y <= 20 || start.y >= 80) && inBox(endX, endY)) add("cross", "Cross from a wide area", 10);
  const score = Math.min(100, Math.round(factors.reduce((sum, factor) => sum + factor.points, 0)));
  return { score, factors };
}

/** Expected completion probability for a pass of the given difficulty. */
export function expectedCompletion(difficulty: number): number {
  return round(Math.min(0.97, Math.max(0.2, 0.97 - 0.0075 * difficulty)), 3);
}

export interface PassQuality {
  event: MatchEvent;
  distanceM: number;
  band: PassBand;
  difficulty: PassDifficulty;
  expected: number;
  completed: boolean;
}

/** Distance, band, difficulty and expected completion for every open-play pass in `events` (corners excluded). */
export function passQualities(events: MatchEvent[], options: MetricOptions = {}): PassQuality[] {
  if (options.camera) return [];
  const pressures = events.filter((event) => event.type === "pressure" && !event.rescinded);
  const out: PassQuality[] = [];
  for (const event of events) {
    if (event.type !== "pass" || event.rescinded) continue;
    const difficulty = passDifficulty(event, pressures, options);
    const distanceM = passDistanceM(event, options);
    if (!difficulty || distanceM === null) continue;
    out.push({ event, distanceM, band: passBand(distanceM), difficulty, expected: expectedCompletion(difficulty.score), completed: event.outcome === "complete" });
  }
  return out;
}

export interface CompletionOverExpected {
  attempts: number;
  completed: number;
  expected: number;
  /** (completed − expected) / attempts × 100, in percentage points. */
  overExpectedPct: number;
}

export function completionOverExpected(passes: Pick<PassQuality, "expected" | "completed">[]): CompletionOverExpected | null {
  if (passes.length === 0) return null;
  const completed = passes.filter((pass) => pass.completed).length;
  const expected = passes.reduce((sum, pass) => sum + pass.expected, 0);
  return { attempts: passes.length, completed, expected: round(expected, 2), overExpectedPct: round(((completed - expected) / passes.length) * 100) };
}

export interface PassAggregate {
  avgPassDistanceM: number | null;
  longPassAccuracy: number | null;
  avgPassDifficulty: number | null;
  completionOverExpected: number | null;
  hardestCompleted: PassQuality | null;
}

export function aggregatePasses(passes: PassQuality[]): PassAggregate {
  if (passes.length === 0) {
    return { avgPassDistanceM: null, longPassAccuracy: null, avgPassDifficulty: null, completionOverExpected: null, hardestCompleted: null };
  }
  const long = passes.filter((pass) => pass.band === "long");
  const hardestCompleted = passes.filter((pass) => pass.completed)
    .sort((a, b) => b.difficulty.score - a.difficulty.score || secondOf(a.event) - secondOf(b.event) || a.event.id.localeCompare(b.event.id))[0] ?? null;
  return {
    avgPassDistanceM: round(passes.reduce((sum, pass) => sum + pass.distanceM, 0) / passes.length),
    longPassAccuracy: long.length ? round((long.filter((pass) => pass.completed).length / long.length) * 100) : null,
    avgPassDifficulty: round(passes.reduce((sum, pass) => sum + pass.difficulty.score, 0) / passes.length),
    completionOverExpected: completionOverExpected(passes)?.overExpectedPct ?? null,
    hardestCompleted,
  };
}

/** Ball speed of a pass or corner from its own distance and flight time. Null without `flightMs`. */
export function ballSpeedKmh(event: MatchEvent, options: MetricOptions = {}): number | null {
  const distance = passDistanceM(event, options);
  if (distance === null || typeof event.flightMs !== "number" || !Number.isFinite(event.flightMs) || event.flightMs <= 0) return null;
  return round((distance / (event.flightMs / 1000)) * 3.6);
}

/** Distance from a shot's position to the centre of the goal it attacks, in metres. */
export function shotDistanceM(event: MatchEvent, options: MetricOptions = {}): number | null {
  if (options.camera || event.type !== "shot") return null;
  return round(metresBetween(100 - event.x, 50 - event.y));
}

/**
 * Shot speed: the feed's own measured `speedKmh` when present, else distance to goal ÷ the shot's own `flightMs`.
 * Null otherwise and always null for camera fixtures.
 */
export function shotSpeedKmh(event: MatchEvent, options: MetricOptions = {}): number | null {
  if (options.camera || event.type !== "shot" || event.rescinded) return null;
  if (typeof event.speedKmh === "number" && Number.isFinite(event.speedKmh) && event.speedKmh > 0) return round(event.speedKmh);
  const distance = shotDistanceM(event, options);
  if (distance === null || typeof event.flightMs !== "number" || !Number.isFinite(event.flightMs) || event.flightMs <= 0) return null;
  return round((distance / (event.flightMs / 1000)) * 3.6);
}

/** The fastest shot among `events`; ties go to the earlier shot. */
export function fastestShot(events: MatchEvent[], options: MetricOptions = {}): { event: MatchEvent; speedKmh: number } | null {
  let best: { event: MatchEvent; speedKmh: number } | null = null;
  for (const event of events) {
    const speedKmh = shotSpeedKmh(event, options);
    if (speedKmh === null) continue;
    if (!best || speedKmh > best.speedKmh) best = { event, speedKmh };
  }
  return best;
}

// ------------------------------------------------------------------ synthetic tracking

/**
 * Tracking samples in scope, or null when the fixture has no tracking or the period cannot be established.
 * A sample covers (second − cadence, second]; it belongs to the first half when second ≤ the halftime second.
 */
export function scopedTracking(fixture: Pick<MatchFixture, "id" | "events" | "periods" | "tracking">, uptoSecond = Number.POSITIVE_INFINITY, period: MatchPeriod = "full"): TrackingSample[] | null {
  if (!fixture.tracking || isCameraFixture(fixture)) return null;
  const visible = fixture.tracking.samples.filter((sample) => sample.second <= uptoSecond);
  if (period === "full") return visible;
  const boundary = periodBoundary(fixture);
  if (!boundary.available || boundary.halftimeSecond === null) return null;
  const halftime = boundary.halftimeSecond;
  return visible.filter((sample) => (period === "first" ? sample.second <= halftime : sample.second > halftime));
}

export interface PhysicalMetrics {
  distanceCoveredM: number;
  topSpeedKmh: number;
  /** Tracking intervals in which the player exceeded the sprint threshold (≥ 25 km/h). */
  sprints: number;
}

export function physicalMetrics(samples: TrackingSample[], playerId: string): PhysicalMetrics | null {
  const own = samples.filter((sample) => sample.playerId === playerId);
  if (own.length === 0) return null;
  return {
    distanceCoveredM: Math.round(own.reduce((sum, sample) => sum + sample.distanceM, 0)),
    topSpeedKmh: round(Math.max(...own.map((sample) => sample.speedKmh))),
    sprints: own.filter((sample) => sample.speedKmh >= SPRINT_THRESHOLD_KMH).length,
  };
}

// ------------------------------------------------------------------ threshold player-ID tags

export type PlayerTagMetric = "shot_speed" | "top_speed" | "distance" | "pass_difficulty";

export interface PlayerTag {
  playerId: string;
  name: string;
  metric: PlayerTagMetric;
  value: number;
  unit: string;
  atSecond: number;
  eventId?: string;
}

/**
 * Timed lower-third player-ID entries, emitted when a threshold is crossed within the scope:
 * shot ≥ 100 km/h, completed pass difficulty ≥ 75, a player's first top speed ≥ 32 km/h, and every 5 km covered.
 * `events` must already be reconciled (latest revisions) and scoped; ordering is deterministic.
 */
export function playerTags(fixture: Pick<MatchFixture, "id" | "events" | "periods" | "tracking" | "home" | "away">, events: MatchEvent[], uptoSecond = Number.POSITIVE_INFINITY, period: MatchPeriod = "full"): PlayerTag[] {
  const options = metricOptions(fixture);
  if (options.camera) return [];
  const players = new Map<string, Player>([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]));
  const name = (id: string) => players.get(id)?.name ?? id;
  const tags: PlayerTag[] = [];
  const scoped = events.filter((event) => !event.rescinded && secondOf(event) <= uptoSecond);
  for (const event of scoped) {
    const speed = shotSpeedKmh(event, options);
    if (speed !== null && speed >= SHOT_SPEED_THRESHOLD_KMH) {
      tags.push({ playerId: event.playerId, name: name(event.playerId), metric: "shot_speed", value: Math.round(speed), unit: "km/h", atSecond: secondOf(event), eventId: event.id });
    }
  }
  for (const pass of passQualities(scoped, options)) {
    if (pass.completed && pass.difficulty.score >= HARD_PASS_THRESHOLD) {
      tags.push({ playerId: pass.event.playerId, name: name(pass.event.playerId), metric: "pass_difficulty", value: pass.difficulty.score, unit: "/100", atSecond: secondOf(pass.event), eventId: pass.event.id });
    }
  }
  const samples = scopedTracking(fixture, uptoSecond, period) ?? [];
  const crossedTopSpeed = new Set<string>();
  const covered = new Map<string, number>();
  for (const sample of [...samples].sort((a, b) => a.second - b.second || a.playerId.localeCompare(b.playerId))) {
    if (sample.speedKmh >= TOP_SPEED_THRESHOLD_KMH && !crossedTopSpeed.has(sample.playerId)) {
      crossedTopSpeed.add(sample.playerId);
      tags.push({ playerId: sample.playerId, name: name(sample.playerId), metric: "top_speed", value: round(sample.speedKmh), unit: "km/h", atSecond: sample.second });
    }
    const before = covered.get(sample.playerId) ?? 0;
    const after = before + sample.distanceM;
    covered.set(sample.playerId, after);
    const milestone = Math.floor(after / DISTANCE_MILESTONE_M);
    if (milestone > Math.floor(before / DISTANCE_MILESTONE_M)) {
      tags.push({ playerId: sample.playerId, name: name(sample.playerId), metric: "distance", value: (milestone * DISTANCE_MILESTONE_M) / 1000, unit: "km", atSecond: sample.second });
    }
  }
  return tags.sort((a, b) => a.atSecond - b.atSecond || a.playerId.localeCompare(b.playerId) || a.metric.localeCompare(b.metric));
}

/** Difficulty colour band used by the pitch: easy < 35 ≤ medium < 60 ≤ hard. */
export function difficultyBand(score: number): "easy" | "medium" | "hard" {
  if (score >= 60) return "hard";
  if (score >= 35) return "medium";
  return "easy";
}
