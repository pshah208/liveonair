import type { GenerateMatchRequest } from "../../shared/platform.js";
import type { MatchEvent, MatchFixture, Team, TeamId } from "../../shared/types.js";
import { getArchive } from "../archive/index.js";
import {
  DURATION_SECONDS,
  buildComposedFixture,
  clampCoord,
  createEvent,
  createTeam,
  eventSecond,
  lcg,
} from "../fixtures.js";

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

function firstAttacker(team: Team, offset = 0): string {
  const attackers = team.players.filter((player) => ["RW", "LW", "ST", "AM"].includes(player.position));
  return attackers[offset]?.id ?? attackers[0]?.id ?? team.players[0].id;
}

function firstMidfielder(team: Team): string {
  return team.players.find((player) => ["DM", "CM", "AM"].includes(player.position))?.id ?? team.players[6]?.id ?? team.players[0].id;
}

function firstDefender(team: Team, offset = 0): string {
  const defenders = team.players.filter((player) => ["RB", "LB", "CB"].includes(player.position));
  return defenders[offset]?.id ?? defenders[0]?.id ?? team.players[0].id;
}

function shotAndGoal(fixtureId: string, stem: string, atSecond: number, teamId: TeamId, playerId: string, x: number, y: number, xg: number): MatchEvent[] {
  const shotId = `${fixtureId}-${stem}-shot`;
  return [
    createEvent({ id: shotId, atSecond, type: "shot", teamId, playerId, outcome: "success", x, y, xg }),
    createEvent({ id: `${fixtureId}-${stem}-goal`, atSecond: atSecond + 1, type: "goal", teamId, playerId, outcome: "success", x: clampCoord(x + 8), y: clampCoord(y + 1), relatedEventId: shotId }),
  ];
}

function cornerShot(fixtureId: string, stem: string, atSecond: number, teamId: TeamId, takerId: string, shooterId: string, xg: number, goal = false): MatchEvent[] {
  const cornerId = `${fixtureId}-${stem}-corner`;
  const shotId = `${fixtureId}-${stem}-shot`;
  return [
    createEvent({ id: cornerId, atSecond, type: "corner", teamId, playerId: takerId, outcome: "complete", x: teamId === "home" ? 100 : 0, y: teamId === "home" ? 4 : 6, endX: 84, endY: 47 }),
    createEvent({ id: shotId, atSecond: atSecond + 6, type: "shot", teamId, playerId: shooterId, outcome: goal ? "success" : "saved", x: 84, y: 47, xg, relatedEventId: cornerId }),
    ...(goal ? [createEvent({ id: `${fixtureId}-${stem}-goal`, atSecond: atSecond + 7, type: "goal", teamId, playerId: shooterId, outcome: "success", x: 95, y: 49, relatedEventId: shotId })] : []),
  ];
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

function curatedEventsForScenario(fixtureId: string, scenario: GenerateMatchRequest["scenario"], home: Team, away: Team): MatchEvent[] {
  const homeStriker = firstByRole(home, "ST", 10);
  const awayStriker = firstByRole(away, "ST", 10);
  const homeCreator = firstAttacker(home, 0);
  const awayCreator = firstAttacker(away, 0);
  const homeWide = firstAttacker(home, 1);
  const awayWide = firstAttacker(away, 1);
  const homeDefender = firstDefender(home, 1);
  const awayDefender = firstDefender(away, 1);
  const awayMid = firstMidfielder(away);
  const homeMid = firstMidfielder(home);

  const kickoff = createEvent({ id: `${fixtureId}-kickoff`, atSecond: 0, type: "kickoff", teamId: "home", playerId: homeStriker, outcome: "none", x: 50, y: 50 });
  const halftime = createEvent({ id: `${fixtureId}-halftime`, atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: firstByRole(home, "GK", 0), outcome: "none", x: 50, y: 50 });
  const fulltime = createEvent({ id: `${fixtureId}-fulltime`, atSecond: DURATION_SECONDS, type: "fulltime", teamId: "home", playerId: firstByRole(home, "GK", 0), outcome: "none", x: 50, y: 50 });

  if (scenario === "comeback") {
    return [
      kickoff,
      ...shotAndGoal(fixtureId, "away-early", 11 * 60 + 15, "away", awayStriker, 87, 50, 0.24),
      ...cornerShot(fixtureId, "away-corner", 29 * 60 + 34, "away", awayCreator, awayDefender, 0.19, true),
      halftime,
      ...shotAndGoal(fixtureId, "home-1", 53 * 60 + 11, "home", homeStriker, 88, 49, 0.27),
      ...shotAndGoal(fixtureId, "home-2", 68 * 60 + 2, "home", homeWide, 85, 58, 0.21),
      ...shotAndGoal(fixtureId, "home-3", 82 * 60 + 44, "home", homeCreator, 89, 54, 0.29),
      fulltime,
    ];
  }

  if (scenario === "red_card") {
    return [
      kickoff,
      ...shotAndGoal(fixtureId, "home-open", 18 * 60 + 20, "home", homeStriker, 87, 50, 0.26),
      halftime,
      createEvent({ id: `${fixtureId}-away-red`, atSecond: 52 * 60 + 18, type: "red_card", teamId: "away", playerId: awayMid, outcome: "none", x: 51, y: 50 }),
      createEvent({ id: `${fixtureId}-home-blocked-shot`, atSecond: 61 * 60 + 9, type: "shot", teamId: "home", playerId: homeWide, outcome: "blocked", x: 82, y: 44, xg: 0.15 }),
      ...shotAndGoal(fixtureId, "away-level", 71 * 60 + 6, "away", awayStriker, 88, 49, 0.22),
      ...shotAndGoal(fixtureId, "home-late", 84 * 60 + 37, "home", homeCreator, 86, 56, 0.28),
      fulltime,
    ];
  }

  if (scenario === "set_piece") {
    return [
      kickoff,
      ...cornerShot(fixtureId, "home-corner-1", 12 * 60 + 8, "home", homeCreator, homeDefender, 0.18),
      ...cornerShot(fixtureId, "home-corner-2", 31 * 60 + 25, "home", homeCreator, homeStriker, 0.23, true),
      halftime,
      ...cornerShot(fixtureId, "away-corner-1", 57 * 60 + 14, "away", awayCreator, awayDefender, 0.21, true),
      ...cornerShot(fixtureId, "home-corner-3", 63 * 60 + 3, "home", homeCreator, homeStriker, 0.24, true),
      fulltime,
    ];
  }

  if (scenario === "late_winner") {
    return [
      kickoff,
      ...shotAndGoal(fixtureId, "home-first", 24 * 60 + 22, "home", homeCreator, 86, 55, 0.24),
      halftime,
      ...shotAndGoal(fixtureId, "away-equalizer", 67 * 60 + 11, "away", awayWide, 85, 45, 0.2),
      ...shotAndGoal(fixtureId, "home-winner", 89 * 60 + 4, "home", homeStriker, 90, 50, 0.3),
      fulltime,
    ];
  }

  return [
    kickoff,
    ...shotAndGoal(fixtureId, "home-1", 7 * 60 + 18, "home", homeStriker, 88, 51, 0.28),
    ...shotAndGoal(fixtureId, "away-1", 15 * 60 + 8, "away", awayStriker, 87, 48, 0.24),
    ...shotAndGoal(fixtureId, "home-2", 29 * 60 + 55, "home", homeCreator, 84, 58, 0.19),
    ...shotAndGoal(fixtureId, "away-2", 41 * 60 + 21, "away", awayCreator, 85, 41, 0.17),
    halftime,
    ...shotAndGoal(fixtureId, "home-3", 52 * 60 + 13, "home", homeMid, 83, 49, 0.16),
    ...shotAndGoal(fixtureId, "away-3", 63 * 60 + 46, "away", awayMid, 84, 52, 0.18),
    ...shotAndGoal(fixtureId, "home-4", 78 * 60 + 33, "home", homeWide, 89, 53, 0.27),
    fulltime,
  ];
}

export function generateMatch(request: GenerateMatchRequest): MatchFixture {
  const { homeClubId, awayClubId } = pickClubIds(request);
  const home = teamFromArchive("home", homeClubId);
  const away = teamFromArchive("away", awayClubId);
  const fixtureId = `gen-${request.scenario}-${request.seed}`;
  const curatedEvents = curatedEventsForScenario(fixtureId, request.scenario, home, away);
  const goalIds = curatedEvents.filter((event) => event.type === "goal").map((event) => event.id);
  const correctionEventId = goalIds[Math.min(1, goalIds.length - 1)]!;
  const correctionMoment = eventSecond(curatedEvents.find((event) => event.id === correctionEventId)!);
  const meta = scenarioTitle(request.scenario, home, away);

  return buildComposedFixture({
    id: fixtureId,
    seed: request.seed,
    title: meta.title,
    description: meta.description,
    home,
    away,
    durationSeconds: DURATION_SECONDS,
    correctionEventId,
    correctionAvailableAt: Math.min(DURATION_SECONDS - 5, correctionMoment + 150),
    curatedEvents,
  });
}
