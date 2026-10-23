import { placeEvent, isCameraFixture } from "./ballPath.js";
import { aggregatePasses, fastestShot, isProgressivePass, passQualities, physicalMetrics, scopedTracking } from "./metrics.js";
import { filterByPeriod, periodBoundary, sameHalf, type PeriodBoundary } from "./periods.js";
import type { MatchEvent, MatchFixture, MatchPeriod, Player, TeamId } from "./types.js";

/**
 * Per-player match analysis computed from the event feed. Every number here is derived from logged
 * events; physical metrics (distance, sprints, speed) come only from a tracking feed — built-in fixtures carry
 * seeded synthetic tracking — and are null without one.
 */

export interface PlayerTouch {
  x: number;
  y: number;
  type: MatchEvent["type"];
  minute: number;
  outcome: MatchEvent["outcome"];
}

export interface ImpactComponent {
  key: "scoring" | "creating" | "passing" | "defending" | "goalkeeping" | "discipline";
  label: string;
  value: number;
}

export interface PlayerAnalysis {
  player: Player;
  teamId: TeamId;
  involvements: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  /** xG assisted (inferred creator): xG of shots created by this player's passes or corners. */
  xa: number;
  keyPasses: number;
  passes: number;
  passesCompleted: number;
  passAccuracy: number | null;
  progressivePasses: number;
  crossesAndCorners: number;
  touchesInBox: number | null;
  tackles: number;
  tacklesWon: number;
  pressures: number;
  saves: number;
  possessionLost: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  /** Mean position of the player's actions on the shared pitch frame, or null without actions. */
  averagePosition: { x: number; y: number } | null;
  touches: PlayerTouch[];
  impact: { rating: number; total: number; components: ImpactComponent[] };
  /** Share of the team's logged actions this player was involved in, 0–100. */
  involvementShare: number;
  /** Mean pass length in metres (null on camera fixtures or without passes). */
  avgPassDistanceM: number | null;
  avgPassDifficulty: number | null;
  /** Completed passes minus expected completions, percentage points of attempts. */
  passCompletionOverExpected: number | null;
  hardestCompletedPass: { eventId: string; difficulty: number; distanceM: number } | null;
  topShotSpeedKmh: number | null;
  /** From synthetic tracking samples; null when the fixture carries no tracking. */
  distanceCoveredM: number | null;
  topSpeedKmh: number | null;
  sprints: number | null;
  trackingSource: "synthetic" | null;
}

export interface TrackingMetric {
  key: string;
  label: string;
  reason: string;
}

/** Metrics a pundit expects that an event feed cannot measure. Physical ones are filled from tracking when present. */
export const TRACKING_METRICS: TrackingMetric[] = [
  { key: "distance", label: "Distance covered", reason: "Needs continuous player tracking (positions many times a second)." },
  { key: "sprints", label: "Sprints / high-intensity runs", reason: "Needs tracked speed over time." },
  { key: "top_speed", label: "Top speed", reason: "Needs tracked positions with timestamps." },
  { key: "minutes", label: "Minutes played", reason: "Needs line-up and substitution data per player." },
];

const OFF_BALL = new Set<MatchEvent["type"]>(["kickoff", "halftime", "fulltime", "substitution"]);
const ASSIST_WINDOW_SECONDS = 15;
const second = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

export function activePlayerEvents(fixture: MatchFixture, uptoSecond = Number.POSITIVE_INFINITY): MatchEvent[] {
  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    if (second(event) > uptoSecond) continue;
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()].filter((event) => !event.rescinded).sort((a, b) => second(a) - second(b) || a.id.localeCompare(b.id));
}

/**
 * Which pass or corner created each shot: the explicit link, else the team's last completed pass in the 15 s
 * before it by another player. Neither may cross halftime.
 */
function creators(events: MatchEvent[], boundary: PeriodBoundary): Map<string, MatchEvent> {
  const byId = new Map(events.map((event) => [event.id, event]));
  const created = new Map<string, MatchEvent>();
  for (const shot of events) {
    if (shot.type !== "shot" && !(shot.type === "goal" && !shot.relatedEventId)) continue;
    const linked = shot.relatedEventId ? byId.get(shot.relatedEventId) : undefined;
    if (linked && (linked.type === "corner" || linked.type === "pass") && linked.playerId !== shot.playerId && sameHalf(linked, shot, boundary)) {
      created.set(shot.id, linked);
      continue;
    }
    const at = second(shot);
    const pass = events
      .filter((event) => event.type === "pass" && event.outcome === "complete" && event.teamId === shot.teamId && event.playerId !== shot.playerId)
      .filter((event) => second(event) <= at && at - second(event) <= ASSIST_WINDOW_SECONDS && sameHalf(event, shot, boundary))
      .at(-1);
    if (pass) created.set(shot.id, pass);
  }
  return created;
}

function scored(shot: MatchEvent, events: MatchEvent[]): boolean {
  if (shot.type === "goal") return true;
  if (shot.outcome === "success") return true;
  return events.some((event) => event.type === "goal" && event.relatedEventId === shot.id);
}

/** Box test in the player's attacking frame: x ≥ 83 and 21 ≤ y ≤ 79. Saves are logged in the shooter's frame. */
function inOpponentBox(event: MatchEvent): boolean {
  return event.type !== "save" && event.x >= 83 && event.y >= 21 && event.y <= 79;
}

/**
 * Illustrative impact model. Weights are deliberately simple and published in the UI so a pundit can see
 * why a player rates where they do. Routine actions carry small weights so possession volume
 * cannot overwhelm goals and chance creation; the total is mapped through a smooth curve.
 */
export const IMPACT_WEIGHTS = {
  goal: 1.4,
  assist: 0.6,
  keyPass: 0.12,
  xa: 0.5,
  shotOnTarget: 0.12,
  shotOffTarget: 0.04,
  xg: 0.4,
  passCompleted: 0.003,
  passFailed: -0.02,
  progressivePass: 0.025,
  tackleWon: 0.018,
  tackleLost: 0.002,
  pressure: 0.002,
  save: 0.3,
  savedXg: 0.8,
  foul: -0.08,
  yellow: -0.25,
  red: -1.0,
};

export const IMPACT_RATING_FORMULA = "Score = clamp(6.2 + 3.8 × tanh(sum of the displayed contributions ÷ 4.5), 3, 10), rounded to 0.1. Routine actions have small weights so logged event volume alone cannot dominate.";

/** Smoothly compress exceptional activity without hard-capping typical players. */
export function impactRating(total: number): number {
  return round(Math.min(10, Math.max(3, 6.2 + 3.8 * Math.tanh(total / 4.5))), 1);
}

/**
 * Per-player figures for a period. Revisions are reconciled over the whole match first, so a correction made
 * in the second half still changes the first-half figures; then events are scoped. Percentages, shares and
 * ratings are recomputed from the scoped counts, never averaged across halves.
 */
export function analysePlayers(fixture: MatchFixture, uptoSecond = Number.POSITIVE_INFINITY, period: MatchPeriod = "full"): PlayerAnalysis[] {
  const boundary = periodBoundary(fixture);
  const events = filterByPeriod(activePlayerEvents(fixture, uptoSecond), period, boundary).filter((event) => !OFF_BALL.has(event.type));
  const byId = new Map(events.map((event) => [event.id, event]));
  const createdBy = creators(events, boundary);
  const camera = isCameraFixture(fixture);
  const metricOpts = { camera };
  const qualities = passQualities(events, metricOpts);
  const tracking = scopedTracking(fixture, uptoSecond, period);
  const teamActions: Record<TeamId, number> = { home: 0, away: 0 };
  for (const event of events) teamActions[event.teamId] += 1;

  return [...fixture.home.players, ...fixture.away.players].map((player) => {
    const own = events.filter((event) => event.playerId === player.id);
    const shots = own.filter((event) => event.type === "shot");
    // A goal without a logged shot still counts as a shot on target.
    const unshotGoals = own.filter((event) => event.type === "goal" && !(event.relatedEventId && byId.get(event.relatedEventId)?.type === "shot"));
    const goals = own.filter((event) => event.type === "goal").length;
    const shotsOnTarget = shots.filter((shot) => shot.outcome === "success" || shot.outcome === "saved").length + unshotGoals.length;
    const xg = shots.reduce((sum, shot) => sum + (shot.xg ?? 0), 0);
    const createdShots = [...createdBy.entries()].filter(([, creator]) => creator.playerId === player.id).map(([shotId]) => byId.get(shotId)!);
    const assists = createdShots.filter((shot) => scored(shot, events)).length;
    const xa = createdShots.reduce((sum, shot) => sum + (shot.xg ?? 0), 0);
    const passes = own.filter((event) => event.type === "pass");
    const passesCompleted = passes.filter((pass) => pass.outcome === "complete").length;
    const progressivePasses = passes.filter(isProgressivePass).length;
    const tackles = own.filter((event) => event.type === "tackle");
    const tacklesWon = tackles.filter((tackle) => tackle.outcome === "success" || tackle.outcome === "complete").length;
    const saves = own.filter((event) => event.type === "save");
    const savedXg = saves.reduce((sum, save) => sum + ((save.relatedEventId ? byId.get(save.relatedEventId)?.xg : undefined) ?? 0), 0);
    const fouls = own.filter((event) => event.type === "foul").length;
    const yellowCards = own.filter((event) => event.type === "yellow_card").length;
    const redCards = own.filter((event) => event.type === "red_card").length;
    const pressures = own.filter((event) => event.type === "pressure").length;
    const onBall = own.filter((event) => event.type !== "yellow_card" && event.type !== "red_card");
    const touches: PlayerTouch[] = onBall.map((event) => ({ ...placeEvent(fixture, event), type: event.type, minute: event.minute, outcome: event.outcome }));
    const averagePosition = touches.length
      ? { x: round(touches.reduce((sum, touch) => sum + touch.x, 0) / touches.length, 1), y: round(touches.reduce((sum, touch) => sum + touch.y, 0) / touches.length, 1) }
      : null;
    const w = IMPACT_WEIGHTS;
    const components: ImpactComponent[] = [
      { key: "scoring", label: "Scoring", value: goals * w.goal + (shotsOnTarget - goals) * w.shotOnTarget + (shots.length + unshotGoals.length - shotsOnTarget) * w.shotOffTarget + xg * w.xg },
      { key: "creating", label: "Chance creation", value: assists * w.assist + createdShots.length * w.keyPass + xa * w.xa },
      { key: "passing", label: "Passing", value: passesCompleted * w.passCompleted + (passes.length - passesCompleted) * w.passFailed + progressivePasses * w.progressivePass },
      { key: "defending", label: "Defending", value: tacklesWon * w.tackleWon + (tackles.length - tacklesWon) * w.tackleLost + pressures * w.pressure },
      { key: "goalkeeping", label: "Goalkeeping", value: saves.length * w.save + savedXg * w.savedXg },
      { key: "discipline", label: "Discipline", value: fouls * w.foul + yellowCards * w.yellow + redCards * w.red },
    ].map((component) => ({ ...component, value: round(component.value) })) as ImpactComponent[];
    const total = round(components.reduce((sum, component) => sum + component.value, 0));
    const passAggregate = aggregatePasses(qualities.filter((quality) => quality.event.playerId === player.id));
    const topShot = fastestShot(shots, metricOpts);
    const physical = tracking ? physicalMetrics(tracking, player.id) : null;
    return {
      player,
      teamId: player.teamId,
      involvements: own.length,
      goals,
      assists,
      shots: shots.length + unshotGoals.length,
      shotsOnTarget,
      xg: round(xg),
      xa: round(xa),
      keyPasses: createdShots.length,
      passes: passes.length,
      passesCompleted,
      passAccuracy: passes.length ? Math.round((passesCompleted / passes.length) * 100) : null,
      progressivePasses,
      crossesAndCorners: own.filter((event) => event.type === "corner").length,
      touchesInBox: camera ? null : onBall.filter(inOpponentBox).length,
      tackles: tackles.length,
      tacklesWon,
      pressures,
      saves: saves.length,
      possessionLost: passes.length - passesCompleted,
      fouls,
      yellowCards,
      redCards,
      averagePosition,
      touches,
      impact: { rating: impactRating(total), total, components },
      involvementShare: teamActions[player.teamId] ? Math.round((own.length / teamActions[player.teamId]) * 100) : 0,
      avgPassDistanceM: passAggregate.avgPassDistanceM,
      avgPassDifficulty: passAggregate.avgPassDifficulty,
      passCompletionOverExpected: passAggregate.completionOverExpected,
      hardestCompletedPass: passAggregate.hardestCompleted
        ? { eventId: passAggregate.hardestCompleted.event.id, difficulty: passAggregate.hardestCompleted.difficulty.score, distanceM: passAggregate.hardestCompleted.distanceM }
        : null,
      topShotSpeedKmh: topShot?.speedKmh ?? null,
      // Outfield players with tracking but no samples in scope (e.g. sent off earlier) covered 0 m.
      distanceCoveredM: tracking ? physical?.distanceCoveredM ?? (player.position === "GK" ? null : 0) : null,
      topSpeedKmh: tracking ? physical?.topSpeedKmh ?? null : null,
      sprints: tracking ? physical?.sprints ?? (player.position === "GK" ? null : 0) : null,
      trackingSource: tracking && physical ? "synthetic" : null,
    };
  });
}

/** Density grid for a heat map: counts per cell on a cols × rows grid over the pitch, normalised to 0–1. */
export function heatGrid(touches: Pick<PlayerTouch, "x" | "y">[], cols = 12, rows = 8): number[][] {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (const touch of touches) {
    const column = Math.min(cols - 1, Math.max(0, Math.floor((touch.x / 100) * cols)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((touch.y / 100) * rows)));
    grid[row]![column]! += 1;
  }
  const peak = Math.max(1, ...grid.flat());
  return grid.map((row) => row.map((value) => value / peak));
}
