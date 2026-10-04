import type { FixtureSummary, MatchEvent, MatchFixture, Player, Team, TeamId } from "../shared/types.js";
import { getArchive } from "./archive/index.js";

interface EventInput {
  id: string;
  atSecond: number;
  type: MatchEvent["type"];
  teamId: TeamId;
  playerId: string;
  outcome: MatchEvent["outcome"];
  x: number;
  y: number;
  endX?: number;
  endY?: number;
  xg?: number;
  relatedEventId?: string;
  rescinded?: boolean;
}

export interface DismissalTimeline {
  teamId: TeamId;
  playerId: string;
  atSecond: number;
}

export const DURATION_SECONDS = 90 * 60;
const GENERATED_FIXTURE_LIMIT = 20;

const archive = getArchive();
const archiveCurrentPlayersByClub = new Map<string, Map<string, string>>();
for (const club of archive.clubs) {
  const players = archive.people
    .filter((person) => person.currentClubId === club.id && !person.retired)
    .sort((a, b) => a.id.localeCompare(b.id));
  archiveCurrentPlayersByClub.set(club.id, new Map(players.map((player) => [player.name, player.id])));
}

export function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

export function createEvent(input: EventInput): MatchEvent {
  return {
    id: input.id,
    revision: 1,
    minute: Math.floor(input.atSecond / 60),
    second: input.atSecond % 60,
    type: input.type,
    teamId: input.teamId,
    playerId: input.playerId,
    outcome: input.outcome,
    x: input.x,
    y: input.y,
    endX: input.endX,
    endY: input.endY,
    xg: input.xg,
    relatedEventId: input.relatedEventId,
    rescinded: input.rescinded,
  };
}

export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function clampCoord(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

export function sortEventsStable(events: MatchEvent[]): MatchEvent[] {
  return [...events].sort((a, b) => eventSecond(a) - eventSecond(b) || a.id.localeCompare(b.id) || a.revision - b.revision);
}

export function cloneFixture(fixture: MatchFixture): MatchFixture {
  return {
    ...fixture,
    home: { ...fixture.home, players: fixture.home.players.map((player) => ({ ...player })) },
    away: { ...fixture.away, players: fixture.away.players.map((player) => ({ ...player })) },
    events: fixture.events.map((event) => ({ ...event })),
  };
}

export function fixtureSummary(fixture: MatchFixture): FixtureSummary {
  return {
    id: fixture.id,
    title: fixture.title,
    description: fixture.description,
    home: { ...fixture.home, players: fixture.home.players.map((player) => ({ ...player })) },
    away: { ...fixture.away, players: fixture.away.players.map((player) => ({ ...player })) },
    durationSeconds: fixture.durationSeconds,
    eventCount: fixture.events.length,
    correctionAvailableAt: fixture.correctionAvailableAt,
  };
}

export function createTeam(
  id: TeamId,
  name: string,
  shortName: string,
  starters: Array<[string, number, string]>,
  archiveClubId?: string,
): Team {
  const archiveLookup = archiveClubId ? archiveCurrentPlayersByClub.get(archiveClubId) : undefined;
  const players: Player[] = starters.map(([playerName, number, position], index) => ({
    id: `${id}-p${index + 1}`,
    name: playerName,
    number,
    position,
    teamId: id,
    archiveId: archiveLookup?.get(playerName),
  }));
  return { id, name, shortName, players, archiveClubId };
}

export function generateBackgroundEvents(
  seed: number,
  fixtureId: string,
  home: Team,
  away: Team,
  startSecond: number,
  endSecond: number,
  avoidSeconds: Set<number>,
  dismissals: DismissalTimeline[] = [],
): MatchEvent[] {
  const rand = lcg(seed);
  const types: MatchEvent["type"][] = ["pass", "pass", "pass", "pressure", "tackle"];
  const events: MatchEvent[] = [];
  let second = startSecond;
  let counter = 0;

  while (second < endSecond) {
    second += 27 + Math.floor(rand() * 23);
    if (second >= endSecond || avoidSeconds.has(second)) {
      continue;
    }

    const team = rand() >= 0.5 ? home : away;
    const type = types[Math.floor(rand() * types.length)];
    const availablePlayers = team.players.filter((candidate) => {
      return !dismissals.some((dismissal) => dismissal.teamId === team.id && dismissal.playerId === candidate.id && second > dismissal.atSecond);
    });
    if (availablePlayers.length === 0) {
      continue;
    }

    const player = availablePlayers[Math.floor(rand() * availablePlayers.length)];
    const x = clampCoord(rand() * 100);
    const y = clampCoord(rand() * 100);
    const endX = clampCoord(x + (rand() * 24 - 12));
    const endY = clampCoord(y + (rand() * 24 - 12));
    const outcome: MatchEvent["outcome"] = type === "pass"
      ? (rand() > 0.18 ? "complete" : "incomplete")
      : (rand() > 0.25 ? "success" : "miss");

    events.push(
      createEvent({
        id: `${fixtureId}-bg-${counter++}`,
        atSecond: second,
        type,
        teamId: team.id,
        playerId: player.id,
        outcome,
        x,
        y,
        endX,
        endY,
      }),
    );
  }

  return events;
}

export function buildComposedFixture(fixture: Omit<MatchFixture, "events"> & { curatedEvents: MatchEvent[] }): MatchFixture {
  const avoidSeconds = new Set(fixture.curatedEvents.map((event) => eventSecond(event)));
  const dismissals: DismissalTimeline[] = fixture.curatedEvents
    .filter((event) => event.type === "red_card")
    .map((event) => ({ teamId: event.teamId, playerId: event.playerId, atSecond: eventSecond(event) }));
  const backgroundEvents = generateBackgroundEvents(
    fixture.seed,
    fixture.id,
    fixture.home,
    fixture.away,
    30,
    fixture.durationSeconds - 30,
    avoidSeconds,
    dismissals,
  );
  return {
    id: fixture.id,
    seed: fixture.seed,
    title: fixture.title,
    description: fixture.description,
    home: fixture.home,
    away: fixture.away,
    events: sortEventsStable([...fixture.curatedEvents, ...backgroundEvents]),
    durationSeconds: fixture.durationSeconds,
    correctionEventId: fixture.correctionEventId,
    correctionAvailableAt: fixture.correctionAvailableAt,
  };
}

const RIVERGATE = createTeam("home", "Rivergate FC", "RIV", [
  ["Milo Hart", 1, "GK"],
  ["Theo Vale", 2, "RB"],
  ["Darian Cross", 4, "CB"],
  ["Jonas Mire", 5, "CB"],
  ["Elliot Pike", 3, "LB"],
  ["Kian Solis", 6, "DM"],
  ["Noah Finch", 8, "CM"],
  ["Rafi Calder", 10, "AM"],
  ["Leo Arden", 7, "RW"],
  ["Mateo Quinn", 11, "LW"],
  ["Ilias Rowan", 9, "ST"],
], "club-rivergate");

const NORTHBRIDGE = createTeam("away", "Northbridge Athletic", "NBA", [
  ["Soren Vale", 1, "GK"],
  ["Pavel Nix", 2, "RB"],
  ["Bram Keane", 4, "CB"],
  ["Oren Fiske", 5, "CB"],
  ["Galen Mott", 3, "LB"],
  ["Tomas Reed", 6, "DM"],
  ["Jude Asher", 8, "CM"],
  ["Caleb Frost", 10, "AM"],
  ["Ronan Bly", 7, "RW"],
  ["Silas Venn", 11, "LW"],
  ["Nico Hale", 9, "ST"],
], "club-northbridge");

const builtInFixtures: MatchFixture[] = [
  buildComposedFixture({
    id: "rivergate-comeback",
    seed: 12011,
    title: "Rivergate Rally After Early Setback",
    description: "Northbridge lead before Rivergate complete a second-half comeback with sustained pressure.",
    home: RIVERGATE,
    away: NORTHBRIDGE,
    durationSeconds: DURATION_SECONDS,
    correctionEventId: "r1-goal-away-2",
    correctionAvailableAt: 57 * 60,
    curatedEvents: [
      createEvent({ id: "r1-kickoff", atSecond: 0, type: "kickoff", teamId: "home", playerId: "home-p9", outcome: "none", x: 50, y: 50 }),
      createEvent({ id: "r1-shot-away-1", atSecond: 9 * 60 + 40, type: "shot", teamId: "away", playerId: "away-p11", outcome: "saved", x: 84, y: 49, xg: 0.22 }),
      createEvent({ id: "r1-save-home-1", atSecond: 9 * 60 + 42, type: "save", teamId: "home", playerId: "home-p1", outcome: "success", x: 93, y: 50, relatedEventId: "r1-shot-away-1" }),
      createEvent({ id: "r1-shot-away-2", atSecond: 17 * 60 + 12, type: "shot", teamId: "away", playerId: "away-p11", outcome: "success", x: 88, y: 52, xg: 0.31 }),
      createEvent({ id: "r1-goal-away-1", atSecond: 17 * 60 + 13, type: "goal", teamId: "away", playerId: "away-p11", outcome: "success", x: 95, y: 51, relatedEventId: "r1-shot-away-2" }),
      createEvent({ id: "r1-corner-away-1", atSecond: 34 * 60 + 20, type: "corner", teamId: "away", playerId: "away-p8", outcome: "complete", x: 100, y: 3, endX: 86, endY: 44 }),
      createEvent({ id: "r1-shot-away-3", atSecond: 34 * 60 + 27, type: "shot", teamId: "away", playerId: "away-p4", outcome: "success", x: 86, y: 45, xg: 0.18, relatedEventId: "r1-corner-away-1" }),
      createEvent({ id: "r1-goal-away-2", atSecond: 34 * 60 + 28, type: "goal", teamId: "away", playerId: "away-p4", outcome: "success", x: 94, y: 50, relatedEventId: "r1-shot-away-3" }),
      createEvent({ id: "r1-halftime", atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
      createEvent({ id: "r1-shot-home-1", atSecond: 54 * 60 + 11, type: "shot", teamId: "home", playerId: "home-p11", outcome: "success", x: 87, y: 50, xg: 0.28 }),
      createEvent({ id: "r1-goal-home-1", atSecond: 54 * 60 + 12, type: "goal", teamId: "home", playerId: "home-p11", outcome: "success", x: 96, y: 49, relatedEventId: "r1-shot-home-1" }),
      createEvent({ id: "r1-shot-home-2", atSecond: 66 * 60 + 2, type: "shot", teamId: "home", playerId: "home-p10", outcome: "miss", x: 82, y: 41, xg: 0.16 }),
      createEvent({ id: "r1-shot-home-3", atSecond: 77 * 60 + 8, type: "shot", teamId: "home", playerId: "home-p9", outcome: "success", x: 89, y: 55, xg: 0.26 }),
      createEvent({ id: "r1-goal-home-2", atSecond: 77 * 60 + 10, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 95, y: 53, relatedEventId: "r1-shot-home-3" }),
      createEvent({ id: "r1-fulltime", atSecond: 90 * 60, type: "fulltime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
    ],
  }),
  buildComposedFixture({
    id: "setpiece-pattern",
    seed: 22021,
    title: "Rivergate Set-Piece Pattern Match",
    description: "Repeated corner routines produce high-quality looks, with one direct conversion each side.",
    home: RIVERGATE,
    away: NORTHBRIDGE,
    durationSeconds: DURATION_SECONDS,
    correctionEventId: "r2-goal-home-2",
    correctionAvailableAt: 63 * 60,
    curatedEvents: [
      createEvent({ id: "r2-kickoff", atSecond: 0, type: "kickoff", teamId: "home", playerId: "home-p11", outcome: "none", x: 50, y: 50 }),
      createEvent({ id: "r2-corner-home-1", atSecond: 11 * 60 + 10, type: "corner", teamId: "home", playerId: "home-p8", outcome: "complete", x: 0, y: 95, endX: 84, endY: 44 }),
      createEvent({ id: "r2-shot-home-1", atSecond: 11 * 60 + 17, type: "shot", teamId: "home", playerId: "home-p4", outcome: "saved", x: 84, y: 44, xg: 0.19, relatedEventId: "r2-corner-home-1" }),
      createEvent({ id: "r2-save-away-1", atSecond: 11 * 60 + 18, type: "save", teamId: "away", playerId: "away-p1", outcome: "success", x: 94, y: 51, relatedEventId: "r2-shot-home-1" }),
      createEvent({ id: "r2-corner-home-2", atSecond: 28 * 60 + 41, type: "corner", teamId: "home", playerId: "home-p8", outcome: "complete", x: 100, y: 4, endX: 83, endY: 56 }),
      createEvent({ id: "r2-shot-home-2", atSecond: 28 * 60 + 48, type: "shot", teamId: "home", playerId: "home-p4", outcome: "success", x: 84, y: 55, xg: 0.23, relatedEventId: "r2-corner-home-2" }),
      createEvent({ id: "r2-goal-home-1", atSecond: 28 * 60 + 49, type: "goal", teamId: "home", playerId: "home-p4", outcome: "success", x: 95, y: 52, relatedEventId: "r2-shot-home-2" }),
      createEvent({ id: "r2-halftime", atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
      createEvent({ id: "r2-corner-away-1", atSecond: 58 * 60 + 5, type: "corner", teamId: "away", playerId: "away-p8", outcome: "complete", x: 0, y: 5, endX: 85, endY: 58 }),
      createEvent({ id: "r2-shot-away-1", atSecond: 58 * 60 + 10, type: "shot", teamId: "away", playerId: "away-p4", outcome: "success", x: 85, y: 58, xg: 0.21, relatedEventId: "r2-corner-away-1" }),
      createEvent({ id: "r2-goal-away-1", atSecond: 58 * 60 + 11, type: "goal", teamId: "away", playerId: "away-p4", outcome: "success", x: 95, y: 53, relatedEventId: "r2-shot-away-1" }),
      createEvent({ id: "r2-corner-home-3", atSecond: 61 * 60 + 51, type: "corner", teamId: "home", playerId: "home-p8", outcome: "complete", x: 100, y: 3, endX: 84, endY: 47 }),
      createEvent({ id: "r2-shot-home-3", atSecond: 61 * 60 + 57, type: "shot", teamId: "home", playerId: "home-p11", outcome: "success", x: 84, y: 47, xg: 0.24, relatedEventId: "r2-corner-home-3" }),
      createEvent({ id: "r2-goal-home-2", atSecond: 61 * 60 + 58, type: "goal", teamId: "home", playerId: "home-p11", outcome: "success", x: 95, y: 48, relatedEventId: "r2-shot-home-3" }),
      createEvent({ id: "r2-fulltime", atSecond: 90 * 60, type: "fulltime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
    ],
  }),
  buildComposedFixture({
    id: "discipline-swing",
    seed: 33031,
    title: "Discipline Swing Changes Tempo",
    description: "Cards shift control in phases, and late transitions decide the result.",
    home: RIVERGATE,
    away: NORTHBRIDGE,
    durationSeconds: DURATION_SECONDS,
    correctionEventId: "r3-goal-home-2",
    correctionAvailableAt: 86 * 60,
    curatedEvents: [
      createEvent({ id: "r3-kickoff", atSecond: 0, type: "kickoff", teamId: "home", playerId: "home-p11", outcome: "none", x: 50, y: 50 }),
      createEvent({ id: "r3-yellow-home-1", atSecond: 14 * 60 + 32, type: "yellow_card", teamId: "home", playerId: "home-p6", outcome: "none", x: 46, y: 58 }),
      createEvent({ id: "r3-shot-away-1", atSecond: 23 * 60 + 20, type: "shot", teamId: "away", playerId: "away-p10", outcome: "miss", x: 79, y: 40, xg: 0.11 }),
      createEvent({ id: "r3-shot-home-1", atSecond: 31 * 60 + 3, type: "shot", teamId: "home", playerId: "home-p11", outcome: "success", x: 86, y: 52, xg: 0.27 }),
      createEvent({ id: "r3-goal-home-1", atSecond: 31 * 60 + 4, type: "goal", teamId: "home", playerId: "home-p11", outcome: "success", x: 95, y: 50, relatedEventId: "r3-shot-home-1" }),
      createEvent({ id: "r3-halftime", atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
      createEvent({ id: "r3-red-away-1", atSecond: 52 * 60 + 41, type: "red_card", teamId: "away", playerId: "away-p6", outcome: "none", x: 49, y: 49 }),
      createEvent({ id: "r3-shot-home-2", atSecond: 60 * 60 + 38, type: "shot", teamId: "home", playerId: "home-p10", outcome: "blocked", x: 83, y: 43, xg: 0.14 }),
      createEvent({ id: "r3-shot-away-2", atSecond: 72 * 60 + 23, type: "shot", teamId: "away", playerId: "away-p11", outcome: "success", x: 88, y: 50, xg: 0.25 }),
      createEvent({ id: "r3-goal-away-1", atSecond: 72 * 60 + 24, type: "goal", teamId: "away", playerId: "away-p11", outcome: "success", x: 95, y: 51, relatedEventId: "r3-shot-away-2" }),
      createEvent({ id: "r3-shot-home-3", atSecond: 84 * 60 + 50, type: "shot", teamId: "home", playerId: "home-p9", outcome: "success", x: 87, y: 57, xg: 0.29 }),
      createEvent({ id: "r3-goal-home-2", atSecond: 84 * 60 + 51, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 96, y: 55, relatedEventId: "r3-shot-home-3" }),
      createEvent({ id: "r3-fulltime", atSecond: 90 * 60, type: "fulltime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
    ],
  }),
];

const generatedFixtures: MatchFixture[] = [];

export function resetGeneratedFixturesForTests(): void {
  generatedFixtures.length = 0;
}

function findFixtureRecord(id: string): MatchFixture | undefined {
  return generatedFixtures.find((fixture) => fixture.id === id) ?? builtInFixtures.find((fixture) => fixture.id === id);
}

export function listFixtures(): FixtureSummary[] {
  return [...builtInFixtures, ...generatedFixtures].map(fixtureSummary);
}

export function getFixture(id: string): MatchFixture {
  const fixture = findFixtureRecord(id);
  if (!fixture) {
    throw new RangeError(`Unknown fixture: ${id}`);
  }
  return cloneFixture(fixture);
}

export function registerFixture(fixture: MatchFixture): FixtureSummary {
  if (builtInFixtures.some((builtIn) => builtIn.id === fixture.id)) {
    throw new RangeError(`Cannot replace built-in fixture: ${fixture.id}`);
  }
  const existingIndex = generatedFixtures.findIndex((entry) => entry.id === fixture.id);
  if (existingIndex >= 0) {
    generatedFixtures.splice(existingIndex, 1);
  }
  generatedFixtures.push(cloneFixture(fixture));
  while (generatedFixtures.length > GENERATED_FIXTURE_LIMIT) {
    generatedFixtures.shift();
  }
  return fixtureSummary(fixture);
}

/** Removes a generated fixture (built-ins are never removed). Returns whether it existed. */
export function unregisterFixture(id: string): boolean {
  const index = generatedFixtures.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  generatedFixtures.splice(index, 1);
  return true;
}