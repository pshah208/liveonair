import { isMatchedPressureEvent } from "./metrics.js";
import type { MatchEvent, TeamId } from "./types.js";
import { illustrativeXg } from "./xg.js";

export interface MomentumOptions {
  windowMinutes?: number;
  smoothingMinutes?: number;
  minEventsPerMinute?: number;
}

export interface MomentumMarker {
  eventId: string;
  minute: number;
  teamId: TeamId;
  period: 1 | 2;
}

export interface MomentumPoint {
  minute: number;
  period: 1 | 2;
  homeThreat: number;
  awayThreat: number;
  netThreat: number;
}

export interface MomentumSeries {
  points: MomentumPoint[];
  goals: MomentumMarker[];
  substitutions: MomentumMarker[];
  insufficientCoverage: boolean;
}

export interface ControlChaosWindow {
  startMinute: number;
  endMinute: number;
  period: 1 | 2;
  completedPassShare: number | null;
  possessionChanges: number;
  /** Team switches divided by adjacent on-ball event pairs. */
  turnoverRate?: number | null;
  /** Recorded on-ball events per inferred same-team run, including window-edge runs. */
  avgSequenceLength?: number | null;
  lowDetail?: boolean;
  shots: number;
  matchedPressureEvents: number;
  pressureDeltaFromPrevious: number | null;
  label: "controlled" | "chaotic" | "mixed";
  insufficientCoverage: boolean;
}

const GRID_COLS = 12;
const GRID_ROWS = 8;
const ON_BALL = new Set<MatchEvent["type"]>(["pass", "shot", "goal", "save", "corner", "tackle", "interception", "ball_recovery"]);
const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function isOnBall(event: MatchEvent): boolean {
  if (!ON_BALL.has(event.type)) return false;
  if (event.type !== "tackle") return true;
  return event.outcome === "success";
}

function latestEvents(events: MatchEvent[]): MatchEvent[] {
  const latestById = new Map<string, MatchEvent>();
  for (const event of events) {
    const previous = latestById.get(event.id);
    if (!previous || event.revision >= previous.revision) latestById.set(event.id, event);
  }
  return [...latestById.values()]
    .filter((event) => !event.rescinded)
    .sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));
}

function periodForSecond(second: number): 1 | 2 {
  return second <= 45 * 60 ? 1 : 2;
}

function minuteOf(second: number): number {
  return Math.floor(second / 60);
}

function cellThreat(col: number, row: number): number {
  const x = ((col + 0.5) / GRID_COLS) * 100;
  const y = ((row + 0.5) / GRID_ROWS) * 100;
  return illustrativeXg(x, y);
}

const THREAT_GRID = Array.from({ length: GRID_ROWS }, (_, row) => Array.from({ length: GRID_COLS }, (_, col) => cellThreat(col, row)));

function clampCellX(x: number): number {
  return Math.max(0, Math.min(GRID_COLS - 1, Math.floor((Math.max(0, Math.min(100, x)) / 100) * GRID_COLS)));
}

function clampCellY(y: number): number {
  return Math.max(0, Math.min(GRID_ROWS - 1, Math.floor((Math.max(0, Math.min(100, y)) / 100) * GRID_ROWS)));
}

function threatAt(x: number, y: number): number {
  return THREAT_GRID[clampCellY(y)]![clampCellX(x)]!;
}

function movingAverage(values: number[], windowMinutes: number): number[] {
  if (windowMinutes <= 1) return values.map((value) => round(value));
  const radius = Math.floor(windowMinutes / 2);
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);
    const slice = values.slice(start, end + 1);
    return round(slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length));
  });
}

function contributesCarry(from: MatchEvent, to: MatchEvent): boolean {
  if (from.teamId !== to.teamId) return false;
  if (!isOnBall(from) || !isOnBall(to)) return false;
  const gap = secondOf(to) - secondOf(from);
  return gap > 0 && gap <= 12;
}

function addThreat(acc: Record<TeamId, number[]>, teamId: TeamId, minute: number, threat: number): void {
  acc[teamId][minute] = round((acc[teamId][minute] ?? 0) + threat);
}

export function computeMomentum(events: MatchEvent[], opts: MomentumOptions = {}): MomentumSeries {
  const open = latestEvents(events);
  const maxMinute = Math.max(90, ...open.map((event) => minuteOf(secondOf(event))));
  const seriesLength = maxMinute + 1;
  const home = Array.from({ length: seriesLength }, () => 0);
  const away = Array.from({ length: seriesLength }, () => 0);
  const byTeam: Record<TeamId, number[]> = { home, away };
  const goals: MomentumMarker[] = [];
  const substitutions: MomentumMarker[] = [];

  for (const event of open) {
    const minute = minuteOf(secondOf(event));
    const period = event.period ?? periodForSecond(secondOf(event));
    if (event.type === "goal") goals.push({ eventId: event.id, minute, teamId: event.teamId, period });
    if (event.type === "substitution") substitutions.push({ eventId: event.id, minute, teamId: event.teamId, period });
    if (event.type === "shot") addThreat(byTeam, event.teamId, minute, illustrativeXg(event.x, event.y));
    if (event.type === "pass" && event.outcome === "complete" && event.endX !== undefined && event.endY !== undefined) {
      addThreat(byTeam, event.teamId, minute, Math.max(0, threatAt(event.endX, event.endY) - threatAt(event.x, event.y)));
    }
  }

  for (let index = 1; index < open.length; index += 1) {
    const previous = open[index - 1]!;
    const current = open[index]!;
    if (!contributesCarry(previous, current)) continue;
    const minute = minuteOf(secondOf(current));
    const startX = previous.endX ?? previous.x;
    const startY = previous.endY ?? previous.y;
    addThreat(byTeam, current.teamId, minute, Math.max(0, threatAt(current.x, current.y) - threatAt(startX, startY)));
  }

  const smoothingMinutes = Math.max(1, Math.round(opts.smoothingMinutes ?? 3));
  const net = movingAverage(home.map((value, minute) => value - (away[minute] ?? 0)), smoothingMinutes);
  const points: MomentumPoint[] = net.map((value, minute) => ({
    minute,
    period: minute < 45 ? 1 : 2,
    homeThreat: round(home[minute] ?? 0),
    awayThreat: round(away[minute] ?? 0),
    netThreat: value,
  }));

  const minEventsPerMinute = opts.minEventsPerMinute ?? 1.2;
  const qualifyingEvents = open.filter((event) => isOnBall(event)).length;
  // The point grid extends to 90 for display; unplayed future minutes are not observed coverage.
  const observedMinutes = open.length ? minuteOf(secondOf(open[open.length - 1]!)) + 1 : 0;
  const insufficientCoverage = observedMinutes === 0 || qualifyingEvents < observedMinutes * minEventsPerMinute;
  return { points, goals, substitutions, insufficientCoverage };
}

function matchedPressuresInWindow(open: MatchEvent[], startSecond: number, endSecond: number): number {
  const passes = open.filter((event) => event.type === "pass" && secondOf(event) >= startSecond && secondOf(event) < endSecond);
  const pressures = open.filter((event) => event.type === "pressure" && secondOf(event) >= startSecond - 2 && secondOf(event) < endSecond);
  return pressures.filter((pressure) => passes.some((pass) => isMatchedPressureEvent(pass, pressure))).length;
}

export function controlVsChaos(events: MatchEvent[], windowMinutes = 5): ControlChaosWindow[] {
  const open = latestEvents(events);
  const width = Math.max(1, Math.round(windowMinutes));
  const maxMinute = Math.max(90, ...open.map((event) => minuteOf(secondOf(event))));
  const out: ControlChaosWindow[] = [];
  let previousPressureCount: number | null = null;

  for (let start = 0; start <= maxMinute; start += width) {
    const end = Math.min(maxMinute + 1, start + width);
    const startSecond = start * 60;
    const endSecond = end * 60;
    const scoped = open.filter((event) => {
      const at = secondOf(event);
      return at >= startSecond && at < endSecond;
    });
    const passes = scoped.filter((event) => event.type === "pass");
    const completedPasses = passes.filter((event) => event.outcome === "complete").length;
    const passShare = passes.length ? completedPasses / passes.length : null;
    const shots = scoped.filter((event) => event.type === "shot").length;
    const onBall = scoped.filter((event) => isOnBall(event));
    let possessionChanges = 0;
    for (let index = 1; index < onBall.length; index += 1) {
      if (onBall[index]!.teamId !== onBall[index - 1]!.teamId) possessionChanges += 1;
    }
    const pressureCount = matchedPressuresInWindow(open, startSecond, endSecond);
    const turnoverRate = onBall.length > 1 ? possessionChanges / (onBall.length - 1) : null;
    const avgSequenceLength = onBall.length ? onBall.length / (possessionChanges + 1) : null;
    // Fewer than six observations cannot support even the coarse, low-detail classification.
    const insufficientCoverage = onBall.length < 6;
    const lowDetail = onBall.length < 20;
    // Sparse feeds often select notable events rather than logging every pass. Do not interpret
    // their apparent switch rate alone as chaos; require a shot flurry as corroboration.
    const chaotic = lowDetail
      ? shots >= 3 && turnoverRate !== null && turnoverRate >= 0.4
      : turnoverRate !== null && (turnoverRate >= 0.28 || (shots >= 3 && turnoverRate >= 0.26));
    const controlled = !chaotic && passShare !== null && passShare >= 0.8
      && passes.length >= 4 && turnoverRate !== null && turnoverRate <= (lowDetail ? 0.25 : 0.235);
    out.push({
      startMinute: start,
      endMinute: end,
      period: start < 45 ? 1 : 2,
      completedPassShare: passShare === null ? null : round(passShare, 3),
      possessionChanges,
      turnoverRate: turnoverRate === null ? null : round(turnoverRate, 3),
      avgSequenceLength: avgSequenceLength === null ? null : round(avgSequenceLength, 2),
      lowDetail,
      shots,
      matchedPressureEvents: pressureCount,
      pressureDeltaFromPrevious: previousPressureCount === null ? null : pressureCount - previousPressureCount,
      label: chaotic ? "chaotic" : controlled ? "controlled" : "mixed",
      insufficientCoverage,
    });
    previousPressureCount = pressureCount;
  }

  return out;
}
