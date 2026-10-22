import type { GenerateMatchRequest } from "../../shared/platform.js";
import type { MatchEvent, MatchFixture, Team, TeamId } from "../../shared/types.js";
import { illustrativeXg } from "../../shared/xg.js";
import { getArchive } from "../archive/index.js";
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
}

interface TeamProgress {
  passes: TeamCounter;
  completedPasses: TeamCounter;
  shots: TeamCounter;
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

const archive = getArchive();
const clubIds = archive.clubs.map((club) => club.id).sort((a, b) => a.localeCompare(b));
const defaultNumbers = [1, 2, 4, 5, 3, 6, 8, 10, 7, 11, 9];

function teamFromArchive(teamId: TeamId, clubId: string): Team {
  const club = archive.clubs.find((entry) => entry.id === clubId);
  if (!club) {
    throw new RangeError(`Unknown archive club: ${clubId}`);
  }
  const players = archive.people
    .filter((person) => person.currentClubId === clubId && !person.retired)
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

function choosePlayer(team: Team, rand: () => number, group: "defenders" | "midfield" | "attackers" | "any"): string {
  const selectors: Record<typeof group, string[]> = {
    defenders: ["RB", "LB", "CB"],
    midfield: ["DM", "CM", "AM"],
    attackers: ["RW", "LW", "ST", "AM"],
    any: [],
  };
  const pool = selectors[group].length
    ? team.players.filter((player) => selectors[group].includes(player.position))
    : team.players;
  const chosen = (pool.length ? pool : team.players)[Math.floor(rand() * (pool.length || team.players.length))];
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

function shotOutcome(rand: () => number): MatchEvent["outcome"] {
  const roll = rand();
  if (roll < 0.14) return "success";
  if (roll < 0.50) return "saved";
  if (roll < 0.73) return "blocked";
  return "miss";
}

function shotPoint(rand: () => number, from: Point): Point {
  return {
    x: clampCoord(Math.max(from.x, 73) + rand() * 6),
    y: clampCoord(from.y + (rand() * 2 - 1) * 10),
  };
}

function buildTargets(rand: () => number): TeamTargets {
  const passes: TeamCounter = {
    home: randomInt(rand, PASS_TARGET_MIN, PASS_TARGET_MAX),
    away: randomInt(rand, PASS_TARGET_MIN, PASS_TARGET_MAX),
  };
  const completionRates: TeamCounter = {
    home: PASS_COMPLETION_MIN + rand() * (PASS_COMPLETION_MAX - PASS_COMPLETION_MIN),
    away: PASS_COMPLETION_MIN + rand() * (PASS_COMPLETION_MAX - PASS_COMPLETION_MIN),
  };
  return {
    passes,
    completedPasses: {
      home: Math.round(passes.home * completionRates.home),
      away: Math.round(passes.away * completionRates.away),
    },
    shots: {
      home: randomInt(rand, SHOT_TARGET_MIN, SHOT_TARGET_MAX),
      away: randomInt(rand, SHOT_TARGET_MIN, SHOT_TARGET_MAX),
    },
  };
}

function hasCompletedTargets(targets: TeamTargets, progress: TeamProgress): boolean {
  return (["home", "away"] as const).every((teamId) => (
    progress.passes[teamId] >= targets.passes[teamId]
    && progress.completedPasses[teamId] >= targets.completedPasses[teamId]
    && progress.shots[teamId] >= targets.shots[teamId]
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

function addPossessionChange(events: MatchEvent[], fixtureId: string, sequence: number, second: number, teamId: TeamId, at: Point, defenderId: string): MatchEvent {
  const turnover = createEvent({
    id: `${fixtureId}-turnover-${sequence}`,
    atSecond: second,
    type: "tackle",
    teamId,
    playerId: defenderId,
    outcome: "success",
    x: at.x,
    y: at.y,
  });
  events.push(turnover);
  return turnover;
}

function generatePossessionEvents(fixtureId: string, seed: number, home: Team, away: Team): MatchEvent[] {
  const rand = lcg(seed);
  const targets = buildTargets(rand);
  const progress: TeamProgress = {
    passes: { home: 0, away: 0 },
    completedPasses: { home: 0, away: 0 },
    shots: { home: 0, away: 0 },
  };
  const events: MatchEvent[] = [];
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

    const team = teamId === "home" ? home : away;
    const opponents = teamId === "home" ? away : home;
    const shotsLeft = targets.shots[teamId] - progress.shots[teamId];
    const steps = Math.max(1, Math.min(9, randomInt(rand, 2, 7) + (shotsLeft > 0 ? 1 : 0)));
    let ended = false;

    for (let step = 0; step < steps && second < MAX_MATCH_SECOND; step += 1) {
      const passesRemaining = targets.passes[teamId] - progress.passes[teamId];
      const shotsRemaining = targets.shots[teamId] - progress.shots[teamId];
      const mustShootSoon = shotsRemaining > 0 && (targets.shots[teamId] - progress.shots[teamId]) > (targets.passes[teamId] - progress.passes[teamId]) / 28;
      const canPass = passesRemaining > 0;
      const shootNow = (mustShootSoon || (shotsRemaining > 0 && step >= 1 && rand() < 0.12 + step * 0.06)) && (step >= 1 || !canPass);

      if (shootNow) {
        second += randomInt(rand, 3, 7);
        const shotFrom = shotPoint(rand, position);
        const shooter = choosePlayer(team, rand, "attackers");
        const shotOutcomeValue = shotOutcome(rand);
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
        const turnover = addPossessionChange(
          events,
          fixtureId,
          sequence++,
          Math.min(MAX_MATCH_SECOND, second + 1),
          otherTeam(teamId),
          position,
          choosePlayer(opponents, rand, "defenders"),
        );
        second = eventSecond(turnover);
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
      const passer = choosePlayer(team, rand, rand() < 0.65 ? "midfield" : "attackers");
      const outcome = passOutcome(rand, teamId, targets, progress);

      // Matched pressure is an opponent pressure event within 0–2 seconds and within 5 metres of the pass start.
      if (passSecond > PRESSURE_WINDOW_SECONDS + 1 && rand() < 0.20) {
        const pressureAt = passSecond - randomInt(rand, 0, PRESSURE_WINDOW_SECONDS);
        const pressureInPassFrame = shiftWithinMetres(rand, position, PRESSURE_MAX_DISTANCE_M);
        if (metresBetween(pressureInPassFrame, position) <= PRESSURE_MAX_DISTANCE_M) {
          const pressureInPressingFrame = mirrorPoint(pressureInPassFrame);
          events.push(createEvent({
            id: `${fixtureId}-pressure-${sequence++}`,
            atSecond: pressureAt,
            type: "pressure",
            teamId: otherTeam(teamId),
            playerId: choosePlayer(opponents, rand, "defenders"),
            outcome: "success",
            x: pressureInPressingFrame.x,
            y: pressureInPressingFrame.y,
            relatedEventId: `${fixtureId}-pass-${sequence}`,
          }));
        }
      }

      const end = passEnd(rand, position, outcome === "complete");
      const pass = createEvent({
        id: `${fixtureId}-pass-${sequence++}`,
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
      events.push(pass);
      second = passSecond;
      progress.passes[teamId] += 1;
      if (outcome === "complete") progress.completedPasses[teamId] += 1;
      position = end;

      if (outcome !== "complete") {
        const turnover = addPossessionChange(
          events,
          fixtureId,
          sequence++,
          Math.min(MAX_MATCH_SECOND, second + 1),
          otherTeam(teamId),
          position,
          choosePlayer(opponents, rand, "defenders"),
        );
        second = eventSecond(turnover);
        teamId = otherTeam(teamId);
        ended = true;
        break;
      }
    }

    if (!ended) {
      const turnover = addPossessionChange(
        events,
        fixtureId,
        sequence++,
        Math.min(MAX_MATCH_SECOND, second + 1),
        otherTeam(teamId),
        position,
        choosePlayer(otherTeam(teamId) === "home" ? home : away, rand, "defenders"),
      );
      second = eventSecond(turnover);
      teamId = otherTeam(teamId);
    }
  }

  if (!halftimeInserted) {
    events.push(createEvent({ id: `${fixtureId}-halftime`, atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: firstByRole(home, "GK", 0), outcome: "none", x: 50, y: 50 }));
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
  const base = generatePossessionEvents(fixtureId, request.seed, home, away);
  const secured = ensureGoals(base, fixtureId, lcg(request.seed ^ 0x9e3779b9));
  return buildFixture(fixtureId, request.seed, meta.title, meta.description, home, away, secured);
}
