import type { FixtureSummary, MatchEvent, MatchFixture, Player, Team, TeamId } from "../shared/types.js";

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
}

interface DismissalTimeline {
  teamId: TeamId;
  playerId: string;
  atSecond: number;
}

const DURATION_SECONDS = 90 * 60;

function event(input: EventInput): MatchEvent {
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
    relatedEventId: input.relatedEventId
  };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clampCoord(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

function createTeam(id: TeamId, name: string, shortName: string, starters: Array<[string, number, string]>): Team {
  const players: Player[] = starters.map(([playerName, number, position], index) => ({
    id: `${id}-p${index + 1}`,
    name: playerName,
    number,
    position,
    teamId: id
  }));
  return { id, name, shortName, players };
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
  ["Ilias Rowan", 9, "ST"]
]);

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
  ["Nico Hale", 9, "ST"]
]);

function generateBackgroundEvents(
  seed: number,
  fixtureId: string,
  home: Team,
  away: Team,
  startSecond: number,
  endSecond: number,
  avoidSeconds: Set<number>,
  dismissals: DismissalTimeline[] = []
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
    const isHome = rand() >= 0.5;
    const team = isHome ? home : away;
    const type = types[Math.floor(rand() * types.length)];
    const availablePlayers = team.players.filter((candidate) => {
      return !dismissals.some((dismissal) => {
        return (
          dismissal.teamId === team.id &&
          dismissal.playerId === candidate.id &&
          second > dismissal.atSecond
        );
      });
    });
    if (availablePlayers.length === 0) {
      continue;
    }
    const player = availablePlayers[Math.floor(rand() * availablePlayers.length)];
    const x = clampCoord(rand() * 100);
    const y = clampCoord(rand() * 100);
    const endX = clampCoord(x + (rand() * 24 - 12));
    const endY = clampCoord(y + (rand() * 24 - 12));
    const outcome: MatchEvent["outcome"] =
      type === "pass" ? (rand() > 0.18 ? "complete" : "incomplete") : (rand() > 0.25 ? "success" : "miss");

    events.push(
      event({
        id: `${fixtureId}-bg-${counter++}`,
        atSecond: second,
        type,
        teamId: team.id,
        playerId: player.id,
        outcome,
        x,
        y,
        endX,
        endY
      })
    );
  }

  return events;
}

function buildComposedFixture(fixture: Omit<MatchFixture, "events"> & { curatedEvents: MatchEvent[] }): MatchFixture {
  const avoidSeconds = new Set(fixture.curatedEvents.map((e) => e.minute * 60 + e.second));
  const dismissals: DismissalTimeline[] = fixture.curatedEvents
    .filter((event) => event.type === "red_card")
    .map((event) => ({
      teamId: event.teamId,
      playerId: event.playerId,
      atSecond: event.minute * 60 + event.second
    }));
  const background = generateBackgroundEvents(
    fixture.seed,
    fixture.id,
    fixture.home,
    fixture.away,
    30,
    fixture.durationSeconds - 30,
    avoidSeconds,
    dismissals
  );
  const events = [...fixture.curatedEvents, ...background].sort((a, b) => {
    const timeA = a.minute * 60 + a.second;
    const timeB = b.minute * 60 + b.second;
    return timeA - timeB || a.id.localeCompare(b.id);
  });
  return {
    id: fixture.id,
    seed: fixture.seed,
    title: fixture.title,
    description: fixture.description,
    home: fixture.home,
    away: fixture.away,
    events,
    durationSeconds: fixture.durationSeconds,
    correctionEventId: fixture.correctionEventId,
    correctionAvailableAt: fixture.correctionAvailableAt
  };
}

const fixtures: MatchFixture[] = [
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
      event({ id: "r1-kickoff", atSecond: 0, type: "kickoff", teamId: "home", playerId: "home-p9", outcome: "none", x: 50, y: 50 }),
      event({ id: "r1-shot-away-1", atSecond: 9 * 60 + 40, type: "shot", teamId: "away", playerId: "away-p11", outcome: "saved", x: 84, y: 49, xg: 0.22 }),
      event({ id: "r1-save-home-1", atSecond: 9 * 60 + 42, type: "save", teamId: "home", playerId: "home-p1", outcome: "success", x: 93, y: 50, relatedEventId: "r1-shot-away-1" }),
      event({ id: "r1-shot-away-2", atSecond: 17 * 60 + 12, type: "shot", teamId: "away", playerId: "away-p9", outcome: "success", x: 88, y: 52, xg: 0.31 }),
      event({ id: "r1-goal-away-1", atSecond: 17 * 60 + 13, type: "goal", teamId: "away", playerId: "away-p9", outcome: "success", x: 95, y: 51, relatedEventId: "r1-shot-away-2" }),
      event({ id: "r1-corner-away-1", atSecond: 34 * 60 + 20, type: "corner", teamId: "away", playerId: "away-p10", outcome: "complete", x: 100, y: 3, endX: 86, endY: 44 }),
      event({ id: "r1-shot-away-3", atSecond: 34 * 60 + 27, type: "shot", teamId: "away", playerId: "away-p4", outcome: "success", x: 86, y: 45, xg: 0.18, relatedEventId: "r1-corner-away-1" }),
      event({ id: "r1-goal-away-2", atSecond: 34 * 60 + 28, type: "goal", teamId: "away", playerId: "away-p4", outcome: "success", x: 94, y: 50, relatedEventId: "r1-shot-away-3" }),
      event({ id: "r1-halftime", atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
      event({ id: "r1-shot-home-1", atSecond: 54 * 60 + 11, type: "shot", teamId: "home", playerId: "home-p9", outcome: "success", x: 87, y: 50, xg: 0.28 }),
      event({ id: "r1-goal-home-1", atSecond: 54 * 60 + 12, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 96, y: 49, relatedEventId: "r1-shot-home-1" }),
      event({ id: "r1-shot-home-2", atSecond: 66 * 60 + 2, type: "shot", teamId: "home", playerId: "home-p11", outcome: "miss", x: 82, y: 41, xg: 0.16 }),
      event({ id: "r1-shot-home-3", atSecond: 77 * 60 + 8, type: "shot", teamId: "home", playerId: "home-p7", outcome: "success", x: 89, y: 55, xg: 0.26 }),
      event({ id: "r1-goal-home-2", atSecond: 77 * 60 + 10, type: "goal", teamId: "home", playerId: "home-p7", outcome: "success", x: 95, y: 53, relatedEventId: "r1-shot-home-3" }),
      event({ id: "r1-fulltime", atSecond: 90 * 60, type: "fulltime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 })
    ]
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
      event({ id: "r2-kickoff", atSecond: 0, type: "kickoff", teamId: "home", playerId: "home-p9", outcome: "none", x: 50, y: 50 }),
      event({ id: "r2-corner-home-1", atSecond: 11 * 60 + 10, type: "corner", teamId: "home", playerId: "home-p10", outcome: "complete", x: 0, y: 95, endX: 84, endY: 44 }),
      event({ id: "r2-shot-home-1", atSecond: 11 * 60 + 17, type: "shot", teamId: "home", playerId: "home-p4", outcome: "saved", x: 84, y: 44, xg: 0.19, relatedEventId: "r2-corner-home-1" }),
      event({ id: "r2-save-away-1", atSecond: 11 * 60 + 18, type: "save", teamId: "away", playerId: "away-p1", outcome: "success", x: 94, y: 51, relatedEventId: "r2-shot-home-1" }),
      event({ id: "r2-corner-home-2", atSecond: 28 * 60 + 41, type: "corner", teamId: "home", playerId: "home-p10", outcome: "complete", x: 100, y: 4, endX: 83, endY: 56 }),
      event({ id: "r2-shot-home-2", atSecond: 28 * 60 + 48, type: "shot", teamId: "home", playerId: "home-p5", outcome: "success", x: 84, y: 55, xg: 0.23, relatedEventId: "r2-corner-home-2" }),
      event({ id: "r2-goal-home-1", atSecond: 28 * 60 + 49, type: "goal", teamId: "home", playerId: "home-p5", outcome: "success", x: 95, y: 52, relatedEventId: "r2-shot-home-2" }),
      event({ id: "r2-halftime", atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
      event({ id: "r2-corner-away-1", atSecond: 58 * 60 + 5, type: "corner", teamId: "away", playerId: "away-p10", outcome: "complete", x: 0, y: 5, endX: 85, endY: 58 }),
      event({ id: "r2-shot-away-1", atSecond: 58 * 60 + 10, type: "shot", teamId: "away", playerId: "away-p4", outcome: "success", x: 85, y: 58, xg: 0.21, relatedEventId: "r2-corner-away-1" }),
      event({ id: "r2-goal-away-1", atSecond: 58 * 60 + 11, type: "goal", teamId: "away", playerId: "away-p4", outcome: "success", x: 95, y: 53, relatedEventId: "r2-shot-away-1" }),
      event({ id: "r2-corner-home-3", atSecond: 61 * 60 + 51, type: "corner", teamId: "home", playerId: "home-p10", outcome: "complete", x: 100, y: 3, endX: 84, endY: 47 }),
      event({ id: "r2-shot-home-3", atSecond: 61 * 60 + 57, type: "shot", teamId: "home", playerId: "home-p9", outcome: "success", x: 84, y: 47, xg: 0.24, relatedEventId: "r2-corner-home-3" }),
      event({ id: "r2-goal-home-2", atSecond: 61 * 60 + 58, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 95, y: 48, relatedEventId: "r2-shot-home-3" }),
      event({ id: "r2-fulltime", atSecond: 90 * 60, type: "fulltime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 })
    ]
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
      event({ id: "r3-kickoff", atSecond: 0, type: "kickoff", teamId: "home", playerId: "home-p9", outcome: "none", x: 50, y: 50 }),
      event({ id: "r3-yellow-home-1", atSecond: 14 * 60 + 32, type: "yellow_card", teamId: "home", playerId: "home-p6", outcome: "none", x: 46, y: 58 }),
      event({ id: "r3-shot-away-1", atSecond: 23 * 60 + 20, type: "shot", teamId: "away", playerId: "away-p11", outcome: "miss", x: 79, y: 40, xg: 0.11 }),
      event({ id: "r3-shot-home-1", atSecond: 31 * 60 + 3, type: "shot", teamId: "home", playerId: "home-p9", outcome: "success", x: 86, y: 52, xg: 0.27 }),
      event({ id: "r3-goal-home-1", atSecond: 31 * 60 + 4, type: "goal", teamId: "home", playerId: "home-p9", outcome: "success", x: 95, y: 50, relatedEventId: "r3-shot-home-1" }),
      event({ id: "r3-halftime", atSecond: 45 * 60, type: "halftime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 }),
      event({ id: "r3-red-away-1", atSecond: 52 * 60 + 41, type: "red_card", teamId: "away", playerId: "away-p6", outcome: "none", x: 49, y: 49 }),
      event({ id: "r3-shot-home-2", atSecond: 60 * 60 + 38, type: "shot", teamId: "home", playerId: "home-p11", outcome: "blocked", x: 83, y: 43, xg: 0.14 }),
      event({ id: "r3-shot-away-2", atSecond: 72 * 60 + 23, type: "shot", teamId: "away", playerId: "away-p9", outcome: "success", x: 88, y: 50, xg: 0.25 }),
      event({ id: "r3-goal-away-1", atSecond: 72 * 60 + 24, type: "goal", teamId: "away", playerId: "away-p9", outcome: "success", x: 95, y: 51, relatedEventId: "r3-shot-away-2" }),
      event({ id: "r3-shot-home-3", atSecond: 84 * 60 + 50, type: "shot", teamId: "home", playerId: "home-p7", outcome: "success", x: 87, y: 57, xg: 0.29 }),
      event({ id: "r3-goal-home-2", atSecond: 84 * 60 + 51, type: "goal", teamId: "home", playerId: "home-p7", outcome: "success", x: 96, y: 55, relatedEventId: "r3-shot-home-3" }),
      event({ id: "r3-fulltime", atSecond: 90 * 60, type: "fulltime", teamId: "home", playerId: "home-p1", outcome: "none", x: 50, y: 50 })
    ]
  })
];

function cloneFixture(fixture: MatchFixture): MatchFixture {
  return {
    ...fixture,
    home: { ...fixture.home, players: fixture.home.players.map((p) => ({ ...p })) },
    away: { ...fixture.away, players: fixture.away.players.map((p) => ({ ...p })) },
    events: fixture.events.map((evt) => ({ ...evt }))
  };
}

export function listFixtures(): FixtureSummary[] {
  return fixtures.map((fixture) => ({
    id: fixture.id,
    title: fixture.title,
    description: fixture.description,
    home: { ...fixture.home, players: fixture.home.players.map((p) => ({ ...p })) },
    away: { ...fixture.away, players: fixture.away.players.map((p) => ({ ...p })) },
    durationSeconds: fixture.durationSeconds,
    eventCount: fixture.events.length,
    correctionAvailableAt: fixture.correctionAvailableAt
  }));
}

export function getFixture(id: string): MatchFixture {
  const fixture = fixtures.find((item) => item.id === id);
  if (!fixture) {
    throw new RangeError(`Unknown fixture: ${id}`);
  }
  return cloneFixture(fixture);
}
