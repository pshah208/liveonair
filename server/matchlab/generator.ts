import type { GenerateMatchRequest } from "../../shared/platform.js";
import type { MatchEvent, MatchFixture, Team, TeamId } from "../../shared/types.js";
import { illustrativeXg } from "../../shared/xg.js";
import { getArchive, isArchivePlayer } from "../archive/index.js";
import {
  DURATION_SECONDS,
  clampCoord,
  createEvent,
  createTeam,
  eventSecond,
  lcg,
  sortEventsStable,
  syntheticTracking,
  withSyntheticBallFlight,
} from "../fixtures.js";

type TeamCounter = Record<TeamId, number>;

interface TeamTargets {
  passes: TeamCounter;
  completedPasses: TeamCounter;
  shots: TeamCounter;
  secondHalfShots: TeamCounter;
}

interface TeamProgress {
  passes: TeamCounter;
  completedPasses: TeamCounter;
  shots: TeamCounter;
  secondHalfShots: TeamCounter;
}

interface Point {
  x: number;
  y: number;
}

const PASS_TARGET_MIN = 350;
const PASS_TARGET_MAX = 600;
const SHOT_TARGET_MIN = 9;
const SHOT_TARGET_MAX = 17;
const PASS_COMPLETION_MIN = 0.78;
const PASS_COMPLETION_MAX = 0.88;
const MAX_MATCH_SECOND = DURATION_SECONDS - 2;
const PRESSURE_WINDOW_SECONDS = 2;
const PRESSURE_MAX_DISTANCE_M = 5;
const PITCH_LENGTH_M = 105;
const PITCH_WIDTH_M = 68;
const PRESSURE_CHANCE_BASE = 0.34;
const MAX_TACKLES_PER_PLAYER = 10;
const TURNOVER_EVENT_RATE = 0.16;
const TURNOVER_CAP_PER_MINUTE = 0.5;
const TURNOVER_CAP_BASE_ALLOWANCE = 4;
const TACKLE_TURNOVER_SHARE = 0.68;
const INTERCEPTION_TURNOVER_SHARE = 0.2;
const LOST_TACKLE_CHANCE = 0.026;
const SECOND_HALF_SHOT_SHARE_MIN = 0.45;
const SECOND_HALF_SHOT_SHARE_MAX = 0.55;
const RED_CARD_MIN_SECOND = 53 * 60;
const RED_CARD_MAX_SECOND = 58 * 60;
const TURNOVER_TYPES = new Set<MatchEvent["type"]>(["tackle", "interception", "ball_recovery"]);

type TurnoverEventKind = "tackle" | "interception" | "ball_recovery" | "none";

interface ScenarioConfig {
  randomSalt: number;
  shotTargetShift: number;
  pressureChance: number;
  shotSuccessBoost: number;
  setPieceShotChance: number;
  forceLateGoal: boolean;
  forceComebackShape: boolean;
  forceRedCard: boolean;
}

const archive = getArchive();
const clubIds = archive.clubs.map((club) => club.id).sort((a, b) => a.localeCompare(b));
const defaultNumbers = [1, 2, 4, 5, 3, 6, 8, 10, 7, 11, 9];

function teamFromArchive(teamId: TeamId, clubId: string): Team {
  const club = archive.clubs.find((entry) => entry.id === clubId);
  if (!club) {
    throw new RangeError(`Unknown archive club: ${clubId}`);
  }
  const players = archive.people
    .filter((person) => person.currentClubId === clubId && !person.retired && isArchivePlayer(person))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (players.length < 11) {
    throw new RangeError(`Archive club ${clubId} does not have a full starting XI`);
  }
  return createTeam(
    teamId,
    club.name,
    club.shortName,
    players.slice(0, 11).map((player, index) => [player.name, defaultNumbers[index] ?? index + 1, player.position] as [string, number, string]),
    clubId,
  );
}

function pickClubIds(request: GenerateMatchRequest): { homeClubId: string; awayClubId: string } {
  if (request.homeClubId && request.awayClubId) {
    if (request.homeClubId === request.awayClubId) {
      throw new RangeError("Generated matches require distinct clubs");
    }
    return { homeClubId: request.homeClubId, awayClubId: request.awayClubId };
  }

  const rand = lcg(request.seed);
  const homeClubId = request.homeClubId ?? clubIds[Math.floor(rand() * clubIds.length)];
  const awayPool = clubIds.filter((clubId) => clubId !== homeClubId);
  const awayClubId = request.awayClubId ?? awayPool[Math.floor(rand() * awayPool.length)];
  if (homeClubId === awayClubId) {
    throw new RangeError("Generated matches require distinct clubs");
  }
  return { homeClubId, awayClubId };
}

function firstByRole(team: Team, role: string, fallbackIndex: number): string {
  return team.players.find((player) => player.position === role)?.id ?? team.players[fallbackIndex]?.id ?? team.players[0].id;
}

function scenarioTitle(scenario: GenerateMatchRequest["scenario"], home: Team, away: Team): { title: string; description: string } {
  switch (scenario) {
    case "comeback":
      return {
        title: `${home.name} chase down ${away.name}`,
        description: `${away.shortName} lead early before ${home.shortName} flip the match in the second half.`,
      };
    case "red_card":
      return {
        title: `${home.name} manage the red-card swing`,
        description: `A dismissal changes the shape of ${home.shortName} versus ${away.shortName}.`,
      };
    case "set_piece":
      return {
        title: `${home.name} and ${away.name} test set-piece routines`,
        description: "Repeated corner patterns create the clearest openings of the night.",
      };
    case "late_winner":
      return {
        title: `${home.name} and ${away.name} go deep`,
        description: "The fixture stays level until a late decisive attack.",
      };
    case "goal_fest":
      return {
        title: `${home.name} and ${away.name} trade goals`,
        description: "An open synthetic game produces repeated shot-goal sequences.",
      };
  }
}

function scenarioConfig(scenario: GenerateMatchRequest["scenario"]): ScenarioConfig {
  switch (scenario) {
    case "goal_fest":
      return {
        randomSalt: 0x5f3759df,
        shotTargetShift: 1,
        pressureChance: PRESSURE_CHANCE_BASE + 0.02,
        shotSuccessBoost: 0.11,
        setPieceShotChance: 0.08,
        forceLateGoal: false,
        forceComebackShape: false,
        forceRedCard: false,
      };
    case "red_card":
      return {
        randomSalt: 0x1f123bb5,
        shotTargetShift: -1,
        pressureChance: PRESSURE_CHANCE_BASE - 0.02,
        shotSuccessBoost: -0.02,
        setPieceShotChance: 0.06,
        forceLateGoal: false,
        forceComebackShape: false,
        forceRedCard: true,
      };
    case "set_piece":
      return {
        randomSalt: 0x9e3779b9,
        shotTargetShift: 1,
        pressureChance: PRESSURE_CHANCE_BASE,
        shotSuccessBoost: 0.01,
        setPieceShotChance: 0.26,
        forceLateGoal: false,
        forceComebackShape: false,
        forceRedCard: false,
      };
    case "late_winner":
      return {
        randomSalt: 0x7f4a7c15,
        shotTargetShift: -1,
        pressureChance: PRESSURE_CHANCE_BASE - 0.01,
        shotSuccessBoost: -0.03,
        setPieceShotChance: 0.08,
        forceLateGoal: true,
        forceComebackShape: false,
        forceRedCard: false,
      };
    case "comeback":
      return {
        randomSalt: 0x243f6a88,
        shotTargetShift: 0,
        pressureChance: PRESSURE_CHANCE_BASE + 0.01,
        shotSuccessBoost: 0.02,
        setPieceShotChance: 0.1,
        forceLateGoal: false,
        forceComebackShape: true,
        forceRedCard: false,
      };
  }
}

function randomInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function otherTeam(teamId: TeamId): TeamId {
  return teamId === "home" ? "away" : "home";
}

function metresBetween(a: Point, b: Point): number {
  return Math.hypot(((a.x - b.x) / 100) * PITCH_LENGTH_M, ((a.y - b.y) / 100) * PITCH_WIDTH_M);
}

function shiftWithinMetres(rand: () => number, from: Point, metresMax: number): Point {
  const metresX = (rand() * 2 - 1) * metresMax;
  const metresY = (rand() * 2 - 1) * metresMax;
  return {
    x: clampCoord(from.x + (metresX / PITCH_LENGTH_M) * 100),
    y: clampCoord(from.y + (metresY / PITCH_WIDTH_M) * 100),
  };
}

function mirrorPoint(point: Point): Point {
  return { x: clampCoord(100 - point.x), y: clampCoord(100 - point.y) };
}

function choosePlayer(
  team: Team,
  rand: () => number,
  group: "defenders" | "midfield" | "attackers" | "any",
  excluded: ReadonlySet<string> = new Set<string>(),
): string {
  const selectors: Record<typeof group, string[]> = {
    defenders: ["RB", "LB", "CB"],
    midfield: ["DM", "CM", "AM"],
    attackers: ["RW", "LW", "ST", "AM"],
    any: [],
  };
  const available = team.players.filter((player) => !excluded.has(player.id));
  const basePool = available.length ? available : team.players;
  const pool = selectors[group].length
    ? basePool.filter((player) => selectors[group].includes(player.position))
    : basePool;
  const chosen = (pool.length ? pool : basePool)[Math.floor(rand() * (pool.length || basePool.length))];
  return chosen!.id;
}

function passOutcome(rand: () => number, teamId: TeamId, targets: TeamTargets, progress: TeamProgress): MatchEvent["outcome"] {
  const attemptsLeft = targets.passes[teamId] - progress.passes[teamId];
  const completesLeft = targets.completedPasses[teamId] - progress.completedPasses[teamId];
  if (attemptsLeft <= 0) return "incomplete";
  if (completesLeft <= 0) return "incomplete";
  if (completesLeft >= attemptsLeft) return "complete";
  return rand() < (completesLeft / attemptsLeft) ? "complete" : "incomplete";
}

function passEnd(rand: () => number, from: Point, complete: boolean): Point {
  const forward = complete ? 4 + rand() * 12 : -4 + rand() * 11;
  const sideways = (rand() * 2 - 1) * (complete ? 12 : 18);
  const end = {
    x: clampCoord(from.x + forward),
    y: clampCoord(from.y + sideways),
  };
  if (metresBetween(from, end) < 1.2) {
    end.x = clampCoord(from.x + (complete ? 3 : -3));
  }
  if (metresBetween(from, end) < 1.2) {
    end.y = clampCoord(from.y + (from.y <= 50 ? 3 : -3));
  }
  return end;
}

function shotOutcome(rand: () => number, successBoost = 0): MatchEvent["outcome"] {
  const roll = rand();
  const success = Math.max(0.05, Math.min(0.3, 0.14 + successBoost));
  const saved = Math.max(success + 0.1, Math.min(0.62, 0.50 + successBoost * 0.35));
  const blocked = Math.max(saved + 0.06, Math.min(0.86, 0.73 + successBoost * 0.15));
  if (roll < success) return "success";
  if (roll < saved) return "saved";
  if (roll < blocked) return "blocked";
  return "miss";
}

function shotPoint(rand: () => number, from: Point): Point {
  return {
    x: clampCoord(Math.max(from.x, 73) + rand() * 6),
    y: clampCoord(from.y + (rand() * 2 - 1) * 10),
  };
}

function buildTargets(rand: () => number, config: ScenarioConfig): TeamTargets {
  const shotMin = Math.max(SHOT_TARGET_MIN, Math.min(SHOT_TARGET_MAX, SHOT_TARGET_MIN + config.shotTargetShift));
  const shotMax = Math.max(shotMin, Math.min(SHOT_TARGET_MAX, SHOT_TARGET_MAX + config.shotTargetShift));
  const passes: TeamCounter = {
    home: randomInt(rand, PASS_TARGET_MIN, PASS_TARGET_MAX),
    away: randomInt(rand, PASS_TARGET_MIN, PASS_TARGET_MAX),
  };
  const completionRates: TeamCounter = {
    home: PASS_COMPLETION_MIN + rand() * (PASS_COMPLETION_MAX - PASS_COMPLETION_MIN),
    away: PASS_COMPLETION_MIN + rand() * (PASS_COMPLETION_MAX - PASS_COMPLETION_MIN),
  };
  const shots: TeamCounter = {
    home: randomInt(rand, shotMin, shotMax),
    away: randomInt(rand, shotMin, shotMax),
  };
  return {
    passes,
    completedPasses: {
      home: Math.round(passes.home * completionRates.home),
      away: Math.round(passes.away * completionRates.away),
    },
    shots,
    secondHalfShots: {
      home: secondHalfTarget(shots.home, rand),
      away: secondHalfTarget(shots.away, rand),
    },
  };
}

function secondHalfTarget(totalShots: number, rand: () => number): number {
  const share = SECOND_HALF_SHOT_SHARE_MIN + rand() * (SECOND_HALF_SHOT_SHARE_MAX - SECOND_HALF_SHOT_SHARE_MIN);
  return Math.max(1, Math.min(totalShots - 1, Math.round(totalShots * share)));
}

function turnoverCapBySecond(second: number): number {
  const minute = Math.max(0, Math.floor(second / 60));
  return TURNOVER_CAP_BASE_ALLOWANCE + Math.floor(minute * TURNOVER_CAP_PER_MINUTE);
}

function hasCompletedTargets(targets: TeamTargets, progress: TeamProgress): boolean {
  return (["home", "away"] as const).every((teamId) => (
    progress.passes[teamId] >= targets.passes[teamId]
    && progress.completedPasses[teamId] >= targets.completedPasses[teamId]
    && progress.shots[teamId] >= targets.shots[teamId]
    && progress.secondHalfShots[teamId] >= targets.secondHalfShots[teamId]
  ));
}

function forSecond(second: number): { minute: number; second: number } {
  return { minute: Math.floor(second / 60), second: second % 60 };
}

function eventAtSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function withFlight(events: MatchEvent[], seed: number): MatchEvent[] {
  const sorted = sortEventsStable(events);
  const byId = new Map(sorted.map((event) => [event.id, event]));
  return sorted.map((event) => withSyntheticBallFlight(event, seed, byId));
}

function enforcePassCompletionFloor(events: MatchEvent[], teamId: TeamId, minRate = PASS_COMPLETION_MIN): void {
  const passes = events.filter((event) => event.type === "pass" && event.teamId === teamId);
  if (passes.length === 0) return;
  let completed = passes.filter((event) => event.outcome === "complete").length;
  const required = Math.ceil(passes.length * minRate);
  if (completed >= required) return;
  const incomplete = passes.filter((event) => event.outcome !== "complete");
  for (const pass of incomplete) {
    pass.outcome = "complete";
    const passSecond = eventAtSecond(pass);
    const turnoverIndex = events.findIndex((event) => (
      TURNOVER_TYPES.has(event.type)
      && event.teamId !== teamId
      && !event.rescinded
      && eventAtSecond(event) >= passSecond
      && eventAtSecond(event) <= passSecond + 2
      && Math.abs(event.x - (pass.endX ?? pass.x)) <= 1.5
      && Math.abs(event.y - (pass.endY ?? pass.y)) <= 1.5
    ));
    if (turnoverIndex >= 0) events.splice(turnoverIndex, 1);
    completed += 1;
    if (completed >= required) break;
  }
}

function chooseTurnoverEventKind(rand: () => number): TurnoverEventKind {
  if (rand() >= TURNOVER_EVENT_RATE) return "none";
  const roll = rand();
  if (roll < TACKLE_TURNOVER_SHARE) return "tackle";
  if (roll < TACKLE_TURNOVER_SHARE + INTERCEPTION_TURNOVER_SHARE) return "interception";
  return "ball_recovery";
}

function addPossessionChange(
  events: MatchEvent[],
  fixtureId: string,
  sequence: number,
  second: number,
  teamId: TeamId,
  at: Point,
  defenderId: string,
  kind: TurnoverEventKind,
): MatchEvent | undefined {
  if (kind === "none") return undefined;
  const eventType: MatchEvent["type"] = kind === "tackle" ? "tackle" : kind;
  const turnover = createEvent({
    id: `${fixtureId}-${kind}-${sequence}`,
    atSecond: second,
    type: eventType,
    teamId,
    playerId: defenderId,
    outcome: "success",
    x: at.x,
    y: at.y,
  });
  events.push(turnover);
  return turnover;
}

function addLostTackleAttempt(
  events: MatchEvent[],
  fixtureId: string,
  sequence: number,
  second: number,
  teamId: TeamId,
  at: Point,
  defenderId: string,
): MatchEvent {
  const attempt = createEvent({
    id: `${fixtureId}-tackle-lost-${sequence}`,
    atSecond: second,
    type: "tackle",
    teamId,
    playerId: defenderId,
    outcome: "fail",
    x: at.x,
    y: at.y,
  });
  events.push(attempt);
  return attempt;
}

function pickDefenderForTackle(
  team: Team,
  rand: () => number,
  dismissed: ReadonlySet<string>,
  tacklesByPlayer: Map<string, number>,
): string {
  const defenders = team.players
    .filter((player) => !dismissed.has(player.id))
    .filter((player) => ["RB", "LB", "CB", "DM", "CM"].includes(player.position));
  const pool = (defenders.length ? defenders : team.players.filter((player) => !dismissed.has(player.id)))
    .filter((player) => (tacklesByPlayer.get(player.id) ?? 0) < MAX_TACKLES_PER_PLAYER);
  const eligible = pool.length ? pool : team.players.filter((player) => !dismissed.has(player.id));
  const chosen = eligible[Math.floor(rand() * eligible.length)] ?? team.players[0]!;
  tacklesByPlayer.set(chosen.id, (tacklesByPlayer.get(chosen.id) ?? 0) + 1);
  return chosen.id;
}

function generatePossessionEvents(
  fixtureId: string,
  seed: number,
  scenario: GenerateMatchRequest["scenario"],
  home: Team,
  away: Team,
): MatchEvent[] {
  const config = scenarioConfig(scenario);
  const rand = lcg(seed ^ config.randomSalt);
  const targets = buildTargets(rand, config);
  const progress: TeamProgress = {
    passes: { home: 0, away: 0 },
    completedPasses: { home: 0, away: 0 },
    shots: { home: 0, away: 0 },
    secondHalfShots: { home: 0, away: 0 },
  };
  const events: MatchEvent[] = [];
  const dismissedByTeam: Record<TeamId, Set<string>> = { home: new Set<string>(), away: new Set<string>() };
  const tackleAttemptsByPlayer = new Map<string, number>();
  let turnoverEventsLogged = 0;
  const redCardSecond = config.forceRedCard ? randomInt(rand, RED_CARD_MIN_SECOND, RED_CARD_MAX_SECOND) : null;
  const redCardTeam: TeamId = rand() < 0.5 ? "home" : "away";
  let redCardIssued = false;
  const homeKickoff = firstByRole(home, "ST", 10);
  events.push(createEvent({ id: `${fixtureId}-kickoff`, atSecond: 0, type: "kickoff", teamId: "home", playerId: homeKickoff, outcome: "none", x: 50, y: 50 }));

  let second = 3;
  let position: Point = { x: 50, y: 50 };
  let teamId: TeamId = "home";
  let sequence = 0;
  let halftimeInserted = false;

  while (second < MAX_MATCH_SECOND && !hasCompletedTargets(targets, progress)) {
    if (!halftimeInserted && second >= 45 * 60) {
      events.push(createEvent({ id: `${fixtureId}-halftime`, atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: firstByRole(home, "GK", 0), outcome: "none", x: 50, y: 50 }));
      halftimeInserted = true;
      second = Math.max(second, 45 * 60 + 2);
      position = { x: 50, y: 50 };
      teamId = "away";
    }

    if (!redCardIssued && redCardSecond !== null && second >= redCardSecond) {
      const side = redCardTeam;
      const bookedTeam = side === "home" ? home : away;
      const dismissed = choosePlayer(bookedTeam, rand, "defenders", dismissedByTeam[side]);
      dismissedByTeam[side].add(dismissed);
      events.push(createEvent({
        id: `${fixtureId}-red-card-${sequence++}`,
        atSecond: Math.min(second, MAX_MATCH_SECOND),
        type: "red_card",
        teamId: side,
        playerId: dismissed,
        outcome: "none",
        x: clampCoord(42 + rand() * 16),
        y: clampCoord(30 + rand() * 40),
      }));
      redCardIssued = true;
    }

    const team = teamId === "home" ? home : away;
    const opponents = teamId === "home" ? away : home;
    const shotsLeft = targets.shots[teamId] - progress.shots[teamId];
    const steps = Math.max(1, Math.min(9, randomInt(rand, 2, 7) + (shotsLeft > 0 ? 1 : 0)));
    let ended = false;

    for (let step = 0; step < steps && second < MAX_MATCH_SECOND; step += 1) {
      const passesRemaining = targets.passes[teamId] - progress.passes[teamId];
      const shotsRemaining = targets.shots[teamId] - progress.shots[teamId];
      const inSecondHalf = second >= 45 * 60;
      const secondHalfShotsRemaining = targets.secondHalfShots[teamId] - progress.secondHalfShots[teamId];
      const firstHalfShotCap = targets.shots[teamId] - targets.secondHalfShots[teamId];
      const firstHalfCapReached = !inSecondHalf && progress.shots[teamId] >= firstHalfShotCap;
      const mustShootSoon = shotsRemaining > 0 && (
        (targets.shots[teamId] - progress.shots[teamId]) > (targets.passes[teamId] - progress.passes[teamId]) / 28
        || (inSecondHalf && secondHalfShotsRemaining > 0)
      );
      const canPass = passesRemaining > 0;
      const shootChance = 0.12 + step * 0.06 + (config.shotTargetShift > 0 ? 0.03 : 0);
      const canShootByHalfPlan = !firstHalfCapReached || !canPass;
      const shootNow = canShootByHalfPlan
        && (mustShootSoon || (shotsRemaining > 0 && step >= 1 && rand() < shootChance))
        && (step >= 1 || !canPass);

      if (shootNow) {
        const setPieceShot = rand() < config.setPieceShotChance;
        if (setPieceShot) {
          const cornerSecond = Math.min(MAX_MATCH_SECOND, second + randomInt(rand, 2, 5));
          const cornerAtTop = rand() < 0.5;
          const cornerFrom = { x: 100, y: cornerAtTop ? 4 : 96 };
          const cornerTo = {
            x: clampCoord(82 + rand() * 8),
            y: clampCoord(43 + (rand() * 2 - 1) * 10),
          };
          events.push(createEvent({
            id: `${fixtureId}-corner-${sequence++}`,
            atSecond: cornerSecond,
            type: "corner",
            teamId,
            playerId: choosePlayer(team, rand, "midfield", dismissedByTeam[teamId]),
            outcome: "complete",
            x: cornerFrom.x,
            y: cornerFrom.y,
            endX: cornerTo.x,
            endY: cornerTo.y,
          }));
          second = cornerSecond;
          position = cornerTo;
        }
        second += randomInt(rand, 3, 7);
        const shotFrom = shotPoint(rand, position);
        const shooter = choosePlayer(team, rand, "attackers", dismissedByTeam[teamId]);
        const shotOutcomeValue = shotOutcome(rand, config.shotSuccessBoost);
        const shotId = `${fixtureId}-shot-${sequence++}`;
        const shot = createEvent({
          id: shotId,
          atSecond: Math.min(second, MAX_MATCH_SECOND),
          type: "shot",
          teamId,
          playerId: shooter,
          outcome: shotOutcomeValue,
          x: shotFrom.x,
          y: shotFrom.y,
          xg: illustrativeXg(shotFrom.x, shotFrom.y),
        });
        events.push(shot);
        progress.shots[teamId] += 1;
        if (second >= 45 * 60) progress.secondHalfShots[teamId] += 1;
        position = shotFrom;

        if (shotOutcomeValue === "saved") {
          const saveSecond = Math.min(MAX_MATCH_SECOND, second + 1);
          events.push(createEvent({
            id: `${fixtureId}-save-${sequence++}`,
            atSecond: saveSecond,
            type: "save",
            teamId: otherTeam(teamId),
            playerId: firstByRole(opponents, "GK", 0),
            outcome: "success",
            x: clampCoord(Math.min(97, shotFrom.x + 8)),
            y: clampCoord(50 + (shotFrom.y - 50) * 0.3),
            relatedEventId: shotId,
          }));
          second = saveSecond;
          position = { x: clampCoord(Math.min(97, shotFrom.x + 8)), y: clampCoord(50 + (shotFrom.y - 50) * 0.3) };
        } else if (shotOutcomeValue === "success") {
          const goalSecond = Math.min(MAX_MATCH_SECOND, second + 1);
          events.push(createEvent({
            id: `${fixtureId}-goal-${sequence++}`,
            atSecond: goalSecond,
            type: "goal",
            teamId,
            playerId: shooter,
            outcome: "success",
            x: clampCoord(Math.max(93, shotFrom.x)),
            y: clampCoord(50 + (shotFrom.y - 50) * 0.2),
            relatedEventId: shotId,
          }));
          second = goalSecond;
          position = { x: 50, y: 50 };
        } else {
          second = Math.min(MAX_MATCH_SECOND, second + 1);
        }

        // Possession changes explicitly after every terminal shot action.
        const turnoverKind = turnoverEventsLogged >= turnoverCapBySecond(second) ? "none" : chooseTurnoverEventKind(rand);
        const defenderId = turnoverKind === "none"
          ? choosePlayer(opponents, rand, "midfield", dismissedByTeam[otherTeam(teamId)])
          : pickDefenderForTackle(opponents, rand, dismissedByTeam[otherTeam(teamId)], tackleAttemptsByPlayer);
        const turnover = addPossessionChange(
          events,
          fixtureId,
          sequence++,
          Math.min(MAX_MATCH_SECOND, second + 1),
          otherTeam(teamId),
          position,
          defenderId,
          turnoverKind,
        );
        if (turnover) turnoverEventsLogged += 1;
        second = turnover ? eventSecond(turnover) : Math.min(MAX_MATCH_SECOND, second + 1);
        teamId = otherTeam(teamId);
        ended = true;
        break;
      }

      if (!canPass) {
        ended = true;
        teamId = otherTeam(teamId);
        break;
      }

      const passSecond = Math.min(MAX_MATCH_SECOND, second + randomInt(rand, 3, 8));
      const passer = choosePlayer(team, rand, rand() < 0.65 ? "midfield" : "attackers", dismissedByTeam[teamId]);
      const outcome = passOutcome(rand, teamId, targets, progress);
      const passId = `${fixtureId}-pass-${sequence}`;

      // Matched pressure is an opponent pressure event within 0–2 seconds and within 5 metres of the pass start.
      if (passSecond > PRESSURE_WINDOW_SECONDS + 1 && rand() < config.pressureChance) {
        const pressureAt = passSecond - randomInt(rand, 0, PRESSURE_WINDOW_SECONDS);
        const pressureInPassFrame = shiftWithinMetres(rand, position, PRESSURE_MAX_DISTANCE_M);
        if (metresBetween(pressureInPassFrame, position) <= PRESSURE_MAX_DISTANCE_M) {
          const pressureInPressingFrame = mirrorPoint(pressureInPassFrame);
          events.push(createEvent({
            id: `${fixtureId}-pressure-${sequence++}`,
            atSecond: pressureAt,
            type: "pressure",
            teamId: otherTeam(teamId),
            playerId: choosePlayer(opponents, rand, "defenders", dismissedByTeam[otherTeam(teamId)]),
            outcome: "success",
            x: pressureInPressingFrame.x,
            y: pressureInPressingFrame.y,
            relatedEventId: passId,
          }));
        }
      }

      if (outcome === "complete" && turnoverEventsLogged < turnoverCapBySecond(passSecond) && rand() < LOST_TACKLE_CHANCE) {
        const presser = pickDefenderForTackle(opponents, rand, dismissedByTeam[otherTeam(teamId)], tackleAttemptsByPlayer);
        addLostTackleAttempt(
          events,
          fixtureId,
          sequence++,
          Math.max(0, passSecond - 1),
          otherTeam(teamId),
          mirrorPoint(position),
          presser,
        );
        turnoverEventsLogged += 1;
      }

      const end = passEnd(rand, position, outcome === "complete");
      const pass = createEvent({
        id: passId,
        atSecond: passSecond,
        type: "pass",
        teamId,
        playerId: passer,
        outcome,
        x: position.x,
        y: position.y,
        endX: end.x,
        endY: end.y,
      });
      sequence += 1;
      events.push(pass);
      second = passSecond;
      progress.passes[teamId] += 1;
      if (outcome === "complete") progress.completedPasses[teamId] += 1;
      position = end;

      if (outcome !== "complete") {
        const turnoverKind = turnoverEventsLogged >= turnoverCapBySecond(second) ? "none" : chooseTurnoverEventKind(rand);
        const defenderId = turnoverKind === "none"
          ? choosePlayer(opponents, rand, "midfield", dismissedByTeam[otherTeam(teamId)])
          : pickDefenderForTackle(opponents, rand, dismissedByTeam[otherTeam(teamId)], tackleAttemptsByPlayer);
        const turnover = addPossessionChange(
          events,
          fixtureId,
          sequence++,
          Math.min(MAX_MATCH_SECOND, second + 1),
          otherTeam(teamId),
          position,
          defenderId,
          turnoverKind,
        );
        if (turnover) turnoverEventsLogged += 1;
        second = turnover ? eventSecond(turnover) : Math.min(MAX_MATCH_SECOND, second + 1);
        teamId = otherTeam(teamId);
        ended = true;
        break;
      }
    }

    if (!ended) {
      const turnoverKind = turnoverEventsLogged >= turnoverCapBySecond(second) ? "none" : chooseTurnoverEventKind(rand);
      const defendingTeam = otherTeam(teamId) === "home" ? home : away;
      const defenderId = turnoverKind === "none"
        ? choosePlayer(defendingTeam, rand, "midfield", dismissedByTeam[otherTeam(teamId)])
        : pickDefenderForTackle(defendingTeam, rand, dismissedByTeam[otherTeam(teamId)], tackleAttemptsByPlayer);
      const turnover = addPossessionChange(
        events,
        fixtureId,
        sequence++,
        Math.min(MAX_MATCH_SECOND, second + 1),
        otherTeam(teamId),
        position,
        defenderId,
        turnoverKind,
      );
      if (turnover) turnoverEventsLogged += 1;
      second = turnover ? eventSecond(turnover) : Math.min(MAX_MATCH_SECOND, second + 1);
      teamId = otherTeam(teamId);
    }
  }

  if (!halftimeInserted) {
    events.push(createEvent({ id: `${fixtureId}-halftime`, atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: firstByRole(home, "GK", 0), outcome: "none", x: 50, y: 50 }));
  }
  if (config.forceRedCard && !redCardIssued) {
    const side = redCardTeam;
    const bookedTeam = side === "home" ? home : away;
    const dismissed = choosePlayer(bookedTeam, rand, "defenders", dismissedByTeam[side]);
    events.push(createEvent({
      id: `${fixtureId}-red-card-${sequence++}`,
      atSecond: randomInt(rand, RED_CARD_MIN_SECOND, RED_CARD_MAX_SECOND),
      type: "red_card",
      teamId: side,
      playerId: dismissed,
      outcome: "none",
      x: clampCoord(44 + rand() * 12),
      y: clampCoord(34 + rand() * 32),
    }));
  }
  enforcePassCompletionFloor(events, "home");
  enforcePassCompletionFloor(events, "away");
  const openTackles = () => events.filter((event) => event.type === "tackle" && !event.rescinded);
  const tackleWonShare = () => {
    const tackles = openTackles();
    if (tackles.length === 0) return 0;
    const won = tackles.filter((event) => event.outcome === "success").length;
    return won / tackles.length;
  };
  let guard = 0;
  while ((openTackles().length < 30 || tackleWonShare() < 0.55 || tackleWonShare() > 0.65) && openTackles().length < 45 && guard < 80) {
    const currentShare = tackleWonShare();
    const mustAddWin = currentShare < 0.55;
    const outcome: MatchEvent["outcome"] = mustAddWin ? "success" : "fail";
    const teamIdForBalance: TeamId = rand() < 0.5 ? "home" : "away";
    const teamForBalance = teamIdForBalance === "home" ? home : away;
    const defender = pickDefenderForTackle(teamForBalance, rand, dismissedByTeam[teamIdForBalance], tackleAttemptsByPlayer);
    const atSecond = randomInt(rand, 8 * 60, 88 * 60);
    events.push(createEvent({
      id: `${fixtureId}-tackle-balance-${sequence++}`,
      atSecond,
      type: "tackle",
      teamId: teamIdForBalance,
      playerId: defender,
      outcome,
      x: clampCoord(34 + rand() * 32),
      y: clampCoord(18 + rand() * 64),
    }));
    guard += 1;
  }
  events.push(createEvent({ id: `${fixtureId}-fulltime`, atSecond: DURATION_SECONDS, type: "fulltime", teamId: "home", playerId: firstByRole(home, "GK", 0), outcome: "none", x: 50, y: 50 }));
  return sortEventsStable(events);
}

function ensureGoals(events: MatchEvent[], fixtureId: string, rand: () => number): MatchEvent[] {
  const withGoals = [...events];
  const shotIndexes = withGoals
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "shot");
  const existingGoals = withGoals.filter((event) => event.type === "goal");
  const needed = Math.max(0, 2 - existingGoals.length);
  for (let index = 0; index < needed && index < shotIndexes.length; index += 1) {
    const pick = shotIndexes[index]!;
    const shot = pick.event;
    shot.outcome = "success";
    const goalAt = Math.min(MAX_MATCH_SECOND, eventAtSecond(shot) + 1);
    withGoals.push(createEvent({
      id: `${fixtureId}-forced-goal-${index}`,
      atSecond: goalAt,
      type: "goal",
      teamId: shot.teamId,
      playerId: shot.playerId,
      outcome: "success",
      x: clampCoord(Math.max(93, shot.x + rand() * 4)),
      y: clampCoord(50 + (shot.y - 50) * 0.2),
      relatedEventId: shot.id,
    }));
  }
  return sortEventsStable(withGoals);
}

function forceGoalForShot(events: MatchEvent[], fixtureId: string, shot: MatchEvent, suffix: string, rand: () => number): void {
  shot.outcome = "success";
  const goalAt = Math.min(MAX_MATCH_SECOND, eventAtSecond(shot) + 1);
  if (!events.some((event) => event.type === "goal" && !event.rescinded && event.relatedEventId === shot.id)) {
    events.push(createEvent({
      id: `${fixtureId}-${suffix}`,
      atSecond: goalAt,
      type: "goal",
      teamId: shot.teamId,
      playerId: shot.playerId,
      outcome: "success",
      x: clampCoord(Math.max(93, shot.x + rand() * 4)),
      y: clampCoord(50 + (shot.y - 50) * 0.2),
      relatedEventId: shot.id,
    }));
  }
}

function appendShotAndGoal(
  events: MatchEvent[],
  fixtureId: string,
  team: Team,
  atSecond: number,
  suffix: string,
  asGoal: boolean,
  rand: () => number,
): void {
  const teamId = team.id;
  const playerId = choosePlayer(team, rand, "attackers");
  const shotId = `${fixtureId}-${suffix}-shot`;
  const shotPointX = clampCoord(82 + ((atSecond / 17) % 7));
  const shotPointY = clampCoord(45 + ((atSecond / 23) % 11));
  events.push(createEvent({
    id: shotId,
    atSecond,
    type: "shot",
    teamId,
    playerId,
    outcome: asGoal ? "success" : "saved",
    x: shotPointX,
    y: shotPointY,
    xg: illustrativeXg(shotPointX, shotPointY),
  }));
  if (asGoal) {
    events.push(createEvent({
      id: `${fixtureId}-${suffix}-goal`,
      atSecond: Math.min(MAX_MATCH_SECOND, atSecond + 1),
      type: "goal",
      teamId,
      playerId,
      outcome: "success",
      x: clampCoord(Math.max(93, shotPointX + 3)),
      y: clampCoord(50 + (shotPointY - 50) * 0.2),
      relatedEventId: shotId,
    }));
  }
}

function resetGoals(events: MatchEvent[]): void {
  for (const event of events) {
    if (event.type === "goal") event.rescinded = true;
    if (event.type === "shot" && event.outcome === "success") event.outcome = "saved";
  }
}

function applyScenarioAdjustments(
  events: MatchEvent[],
  scenario: GenerateMatchRequest["scenario"],
  fixtureId: string,
  seed: number,
  home: Team,
  away: Team,
): MatchEvent[] {
  const adjusted = [...events];
  const rand = lcg(seed ^ 0xa5a5a5a5);
  const shots = () => adjusted.filter((event) => event.type === "shot" && !event.rescinded);
  const goals = () => adjusted.filter((event) => event.type === "goal" && !event.rescinded);

  if (scenario === "goal_fest") {
    const targetGoals = 5;
    let index = 0;
    const currentShots = shots();
    while (goals().length < targetGoals && index < currentShots.length) {
      forceGoalForShot(adjusted, fixtureId, currentShots[index]!, `goalfest-${index}`, rand);
      index += 1;
    }
    for (const teamId of ["home", "away"] as const) {
      const teamShots = () => adjusted.filter((event) => event.type === "shot" && event.teamId === teamId).length;
      if (teamShots() < 15) {
        appendShotAndGoal(adjusted, fixtureId, teamId === "home" ? home : away, teamId === "home" ? 38 * 60 : 74 * 60, `goalfest-extra-${teamId}`, true, rand);
      }
    }
  }

  if (scenario === "set_piece") {
    const corners = adjusted.filter((event) => event.type === "corner");
    const required = Math.max(3, Math.min(5, corners.length + 1));
    for (let index = corners.length; index < required; index += 1) {
      const teamId: TeamId = index % 2 === 0 ? "home" : "away";
      const atSecond = 10 * 60 + index * 14 * 60;
      const cornerId = `${fixtureId}-setpiece-corner-${index}`;
      adjusted.push(createEvent({
        id: cornerId,
        atSecond,
        type: "corner",
        teamId,
        playerId: choosePlayer(teamId === "home" ? home : away, rand, "midfield"),
        outcome: "complete",
        x: 100,
        y: index % 2 ? 95 : 5,
        endX: 84,
        endY: 50,
      }));
      adjusted.push(createEvent({
        id: `${fixtureId}-setpiece-shot-${index}`,
        atSecond: Math.min(MAX_MATCH_SECOND, atSecond + 6),
        type: "shot",
        teamId,
        playerId: choosePlayer(teamId === "home" ? home : away, rand, "attackers"),
        outcome: "saved",
        x: 84,
        y: 50,
        xg: illustrativeXg(84, 50),
        relatedEventId: cornerId,
      }));
    }
  }

  if (scenario === "late_winner") {
    resetGoals(adjusted);
    const lateShot = shots()
      .filter((event) => eventAtSecond(event) >= 80 * 60)
      .sort((left, right) => eventAtSecond(right) - eventAtSecond(left))[0]
      ?? shots().sort((left, right) => eventAtSecond(right) - eventAtSecond(left))[0];
    if (lateShot) {
      lateShot.minute = 84;
      lateShot.second = 0;
      forceGoalForShot(adjusted, fixtureId, lateShot, "late-winner", rand);
    } else {
      appendShotAndGoal(adjusted, fixtureId, home, 84 * 60, "late-winner", true, rand);
    }
  }

  if (scenario === "comeback") {
    resetGoals(adjusted);
    const awayEarlyShot = shots().find((event) => event.teamId === "away" && eventAtSecond(event) < 45 * 60);
    if (awayEarlyShot) {
      awayEarlyShot.minute = 21;
      awayEarlyShot.second = 0;
      forceGoalForShot(adjusted, fixtureId, awayEarlyShot, "comeback-away", rand);
    } else {
      appendShotAndGoal(adjusted, fixtureId, away, 21 * 60, "comeback-away-forced", true, rand);
    }
    const homeSecondHalfShots = shots().filter((event) => event.teamId === "home" && eventAtSecond(event) >= 45 * 60);
    const targetTimes = [66 * 60, 82 * 60];
    for (let index = 0; index < targetTimes.length; index += 1) {
      const shot = homeSecondHalfShots[index];
      if (shot) {
        shot.minute = Math.floor(targetTimes[index]! / 60);
        shot.second = targetTimes[index]! % 60;
        forceGoalForShot(adjusted, fixtureId, shot, `comeback-home-${index}`, rand);
      } else {
        appendShotAndGoal(adjusted, fixtureId, home, targetTimes[index]!, `comeback-home-forced-${index + 1}`, true, rand);
      }
    }
  }

  return sortEventsStable(adjusted);
}

function buildFixture(fixtureId: string, seed: number, title: string, description: string, home: Team, away: Team, events: MatchEvent[]): MatchFixture {
  const sorted = sortEventsStable(events).map((event) => ({ ...event }));
  const goalEvents = sorted.filter((event) => event.type === "goal");
  const correctionTarget = goalEvents[Math.min(1, goalEvents.length - 1)] ?? goalEvents[0];
  if (!correctionTarget) {
    throw new Error("Generated fixture must include at least one goal");
  }
  const correctionMoment = eventSecond(correctionTarget);
  const withBallFlight = withFlight(sorted, seed);
  const dismissals = withBallFlight
    .filter((event) => event.type === "red_card")
    .map((event) => ({ teamId: event.teamId, playerId: event.playerId, atSecond: eventSecond(event) }));
  const tracking = syntheticTracking(seed, home, away, DURATION_SECONDS, dismissals);
  const halftimeSecond = 45 * 60;
  const perioded = withBallFlight.map((event): MatchEvent => ({ ...event, period: eventSecond(event) <= halftimeSecond ? 1 : 2 }));
  return {
    id: fixtureId,
    seed,
    title,
    description,
    home,
    away,
    events: perioded,
    durationSeconds: DURATION_SECONDS,
    correctionEventId: correctionTarget.id,
    correctionAvailableAt: Math.min(DURATION_SECONDS - 5, correctionMoment + 150),
    periods: { source: "synthetic", halftimeSecond },
    tracking,
  };
}

export function generateMatch(request: GenerateMatchRequest): MatchFixture {
  const { homeClubId, awayClubId } = pickClubIds(request);
  const home = teamFromArchive("home", homeClubId);
  const away = teamFromArchive("away", awayClubId);
  const fixtureId = `gen-${request.scenario}-${request.seed}`;
  const meta = scenarioTitle(request.scenario, home, away);
  const base = generatePossessionEvents(fixtureId, request.seed, request.scenario, home, away);
  const secured = ensureGoals(base, fixtureId, lcg(request.seed ^ 0x9e3779b9));
  const scenaried = applyScenarioAdjustments(secured, request.scenario, fixtureId, request.seed, home, away);
  return buildFixture(fixtureId, request.seed, meta.title, meta.description, home, away, scenaried);
}
