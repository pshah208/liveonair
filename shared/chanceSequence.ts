import { isCameraFixture } from "./ballPath.js";
import { PITCH_LENGTH_M } from "./metrics.js";
import type { MatchEvent, MatchFixture, TeamId } from "./types.js";

/**
 * Chance sequence and event-derived territory.
 *
 * These are inferred from the event log. They are not provider possession chains, not ball-in-play time,
 * and not a pressure or momentum model. `inferred` is always true: boundaries come from event order.
 *
 * Sequence (metric version `chance-sequence/1`):
 * - A chance is the latest revision of a non-rescinded `shot` or `goal`.
 * - Walk backward through latest-revision, non-rescinded events at or before the chance.
 *   Equal match-clock seconds keep feed order: the first array index of that event id, not `id`
 *   sort. A later revision does not move the event. A pass supplied immediately before a shot in
 *   the same second stays before that shot.
 * - The sequence is same-team on-ball actions: pass (any outcome), shot, goal, save, corner, and a tackle
 *   only when `outcome === "success"` (tackle won). Pressure and unsuccessful tackles are skipped: they are
 *   not on-ball and do not break the chain.
 * - Stop, without including the boundary event, at:
 *   - an opponent on-ball action (pass, shot, goal, corner, save, or tackle won) — boundary `turnover`
 *   - a restart or stoppage (kickoff, halftime, fulltime, foul, yellow card, red card, substitution),
 *     either team — boundary `stoppage`
 *   - a match-clock gap greater than 15 seconds between consecutive included actions — boundary `time_gap`
 * - A same-team corner is included as the origin and ends the walk — boundary `corner_origin`. A corner
 *   starts a new set-piece sequence; earlier open play is not part of that chance.
 * - At most 10 actions, including the chance itself — boundary `action_cap` when a further action exists.
 * - Reaching the start of the log with no other boundary — `match_start`.
 * - Precedence while walking backward: stoppage, then opponent on-ball, then time gap, then the action cap,
 *   then include (and stop if the included action is a corner).
 *
 * Origin zone uses the logged start coordinates in the team's attacking frame (x = 100 is the goal attacked):
 * defensive x < 33.3, middle 33.3 <= x < 66.7, final x >= 66.7. Corners are not moved to the flag.
 *
 * Progression metres is the change in attacking-frame x from the origin start to the chance start, mapped
 * onto a 105 m pitch: `((chance.x - origin.x) / 100) * 105`, rounded to 0.1 m. It is not the sum of pass
 * lengths and not ball-travel distance. Null on camera fixtures (`id` starts with `video-`).
 *
 * `matchClockSpanSeconds` is chance clock minus origin clock. It is match-clock span, not ball-in-play time.
 *
 * Event-derived territory (never labelled possession or pressure):
 * - Current window is the 10 minutes of match clock before the chance, `[chanceSecond - 600, chanceSecond)`.
 *   The previous window is the equal span immediately before that. Both clamp at 0. The chance event itself
 *   is excluded. Events that share the chance's exact second are outside the window.
 * - Final-third entry: a completed pass with `endX` that starts before x 66.7 and ends at or after 66.7.
 * - Completed pass ending in the final third: completed pass with `endX >= 66.7`.
 * - If any completed pass in the window lacks `endX`, both of those counts are null (not a partial total).
 *   `passesMissingEndX` is the denominator note.
 * - Attacking actions are pass, shot, goal and corner. The final-third share is how many of those start at
 *   x >= 66.7, over how many were recorded. Share is null when the denominator is 0. It is a share of
 *   recorded actions, not a possession percentage.
 * - Change is current count minus previous count. Null when either side is null. No probability and no
 *   momentum score.
 */

export const CHANCE_SEQUENCE_VERSION = "chance-sequence/1" as const;
export const MAX_SEQUENCE_ACTIONS = 10;
export const MAX_ACTION_GAP_SECONDS = 15;
export const TERRITORY_WINDOW_SECONDS = 600;
export const FINAL_THIRD_X = 66.7;
export const DEFENSIVE_THIRD_X = 33.3;

export type PitchThird = "defensive" | "middle" | "final";
export type SequenceBoundary = "turnover" | "time_gap" | "stoppage" | "corner_origin" | "action_cap" | "match_start";
export type ChanceInsightStatus = "issued" | "revised" | "withdrawn";

export interface ChanceOrigin {
  eventId: string;
  type: MatchEvent["type"];
  x: number;
  y: number;
  zone: PitchThird;
}

export interface ChanceAction {
  eventId: string;
  type: MatchEvent["type"];
  playerId: string;
  minute: number;
  second: number;
}

export interface ChanceSequence {
  shotEventId: string;
  /** Chronological event ids, origin first, chance last. */
  eventIds: string[];
  /** Same order as eventIds, for evidence chips. */
  steps: ChanceAction[];
  origin: ChanceOrigin;
  actions: number;
  passes: number;
  /** Distinct player ids in order of first involvement. */
  playerIds: string[];
  /** Attacking-frame progression in metres. Null for camera fixtures. */
  progressionM: number | null;
  /** Match-clock span from origin to chance, in seconds. Not ball-in-play time. */
  matchClockSpanSeconds: number;
  boundary: SequenceBoundary;
  /** Chain boundaries are inferred from event order, not provider possession ids. */
  inferred: true;
}

export interface TerritorySlice {
  /** Null when a completed pass in the window has no endX. */
  finalThirdEntries: number | null;
  /** Null when a completed pass in the window has no endX. */
  completedPassesEndingInFinalThird: number | null;
  attackingActionsInFinalThird: number;
  /** Denominator for the final-third share. */
  attackingActions: number;
  /** attackingActionsInFinalThird / attackingActions. Null when the denominator is 0. */
  finalThirdShare: number | null;
  /** Completed passes excluded from the entry and ending counts because endX is missing. */
  passesMissingEndX: number;
}

export interface TerritoryDelta {
  finalThirdEntries: number | null;
  completedPassesEndingInFinalThird: number | null;
  attackingActionsInFinalThird: number;
  attackingActions: number;
}

export interface TerritoryContext {
  label: "event-derived territory";
  windowSeconds: number;
  chanceSecond: number;
  current: { startSecond: number; endSecond: number };
  previous: { startSecond: number; endSecond: number };
  home: { current: TerritorySlice; previous: TerritorySlice };
  away: { current: TerritorySlice; previous: TerritorySlice };
  /** Descriptive count deltas (current − previous). Not a probability or momentum score. */
  change: { home: TerritoryDelta; away: TerritoryDelta };
  coverageNotes: string[];
}

export interface EvidenceEventRef {
  eventId: string;
  revision: number;
}

export interface ChanceInsight {
  /** Stable for the chance event id (`chance:<eventId>`). */
  insightId: string;
  revision: number;
  matchId: string;
  status: ChanceInsightStatus;
  /** Match-clock second at which this revision became effective. */
  effectiveSecond: number;
  evidenceEventIds: EvidenceEventRef[];
  metricVersion: typeof CHANCE_SEQUENCE_VERSION;
  coverageNotes: string[];
  /** Last computed sequence. Kept after withdrawal so a studio can show what was withdrawn. */
  sequence: ChanceSequence | null;
  territory: TerritoryContext | null;
  summaryFacts: string[];
  withdrawalReason?: string;
  revisionReason?: string;
}

export interface ChanceClaimNumbers {
  shotEventId: string;
  actions: number;
  passes: number;
  players: number;
  originZone: PitchThird;
  /** Nearest metre, so producer copy and the number guard share one integer. Null on camera fixtures. */
  progressionM: number | null;
  matchClockSpanSeconds: number;
  boundary: SequenceBoundary;
  ownHalf: boolean;
  finalThirdEntries: number | null;
  completedPassesEndingInFinalThird: number | null;
  attackingActionsInFinalThird: number;
  attackingActions: number;
  windowMinutes: number;
}

const STOPPAGE_TYPES = new Set<MatchEvent["type"]>(["kickoff", "halftime", "fulltime", "foul", "yellow_card", "red_card", "substitution"]);
const ON_BALL_TYPES = new Set<MatchEvent["type"]>(["pass", "shot", "goal", "corner", "save"]);
const ATTACKING_TYPES = new Set<MatchEvent["type"]>(["pass", "shot", "goal", "corner"]);

export function eventSecond(event: Pick<MatchEvent, "minute" | "second">): number {
  return event.minute * 60 + event.second;
}

function round(value: number, digits = 1): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

export function chanceInsightId(shotEventId: string): string {
  return `chance:${shotEventId}`;
}

export function shotEventIdFromInsight(insightId: string): string | undefined {
  return insightId.startsWith("chance:") ? insightId.slice("chance:".length) : undefined;
}

export function pitchThird(x: number): PitchThird {
  if (x < DEFENSIVE_THIRD_X) return "defensive";
  if (x < FINAL_THIRD_X) return "middle";
  return "final";
}

/**
 * Latest revision of each event at or before `atSecond`, rescinded events removed.
 * Order is match clock, then the first array index of that event id (feed / source order).
 * Same-second events are not sorted by id. A later revision keeps the id's original place.
 */
export function latestOpenEvents(events: MatchEvent[], atSecond = Number.POSITIVE_INFINITY): MatchEvent[] {
  const sourceIndex = new Map<string, number>();
  const latest = new Map<string, MatchEvent>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!sourceIndex.has(event.id)) sourceIndex.set(event.id, index);
    if (eventSecond(event) > atSecond) continue;
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()]
    .filter((event) => !event.rescinded)
    .sort((left, right) => eventSecond(left) - eventSecond(right) || (sourceIndex.get(left.id) ?? 0) - (sourceIndex.get(right.id) ?? 0));
}

export function latestRevision(events: MatchEvent[], eventId: string, atSecond = Number.POSITIVE_INFINITY): MatchEvent | undefined {
  let selected: MatchEvent | undefined;
  for (const event of events) {
    if (event.id !== eventId || eventSecond(event) > atSecond) continue;
    if (!selected || event.revision >= selected.revision) selected = event;
  }
  return selected;
}

function isTackleWon(event: MatchEvent): boolean {
  return event.type === "tackle" && event.outcome === "success";
}

function isOnBall(event: MatchEvent): boolean {
  return ON_BALL_TYPES.has(event.type) || isTackleWon(event);
}

function isSequenceAction(event: MatchEvent, teamId: TeamId): boolean {
  return event.teamId === teamId && isOnBall(event);
}

function emptySlice(): TerritorySlice {
  return {
    finalThirdEntries: 0,
    completedPassesEndingInFinalThird: 0,
    attackingActionsInFinalThird: 0,
    attackingActions: 0,
    finalThirdShare: null,
    passesMissingEndX: 0,
  };
}

function sliceFor(events: MatchEvent[], teamId: TeamId): TerritorySlice {
  const slice = emptySlice();
  const completedPasses = events.filter((event) => event.teamId === teamId && event.type === "pass" && event.outcome === "complete");
  slice.passesMissingEndX = completedPasses.filter((event) => event.endX === undefined).length;
  const entriesKnown = slice.passesMissingEndX === 0;
  if (!entriesKnown) {
    slice.finalThirdEntries = null;
    slice.completedPassesEndingInFinalThird = null;
  } else {
    slice.finalThirdEntries = completedPasses.filter((event) => event.x < FINAL_THIRD_X && (event.endX ?? 0) >= FINAL_THIRD_X).length;
    slice.completedPassesEndingInFinalThird = completedPasses.filter((event) => (event.endX ?? 0) >= FINAL_THIRD_X).length;
  }
  const attacking = events.filter((event) => event.teamId === teamId && ATTACKING_TYPES.has(event.type));
  slice.attackingActions = attacking.length;
  slice.attackingActionsInFinalThird = attacking.filter((event) => event.x >= FINAL_THIRD_X).length;
  slice.finalThirdShare = slice.attackingActions === 0 ? null : round(slice.attackingActionsInFinalThird / slice.attackingActions, 3);
  return slice;
}

function delta(current: TerritorySlice, previous: TerritorySlice): TerritoryDelta {
  const subtract = (left: number | null, right: number | null) => (left === null || right === null ? null : left - right);
  return {
    finalThirdEntries: subtract(current.finalThirdEntries, previous.finalThirdEntries),
    completedPassesEndingInFinalThird: subtract(current.completedPassesEndingInFinalThird, previous.completedPassesEndingInFinalThird),
    attackingActionsInFinalThird: current.attackingActionsInFinalThird - previous.attackingActionsInFinalThird,
    attackingActions: current.attackingActions - previous.attackingActions,
  };
}

export function buildChanceSequence(events: MatchEvent[], shot: MatchEvent, camera: boolean): ChanceSequence | null {
  if ((shot.type !== "shot" && shot.type !== "goal") || shot.rescinded) return null;
  const open = latestOpenEvents(events, eventSecond(shot));
  const index = open.findIndex((event) => event.id === shot.id);
  if (index < 0) return null;
  const chain: MatchEvent[] = [open[index]];
  let boundary: SequenceBoundary = "match_start";
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = open[cursor];
    if (STOPPAGE_TYPES.has(candidate.type)) {
      boundary = "stoppage";
      break;
    }
    if (candidate.teamId !== shot.teamId && isOnBall(candidate)) {
      boundary = "turnover";
      break;
    }
    if (!isSequenceAction(candidate, shot.teamId)) continue;
    const gap = eventSecond(chain[0]) - eventSecond(candidate);
    if (gap > MAX_ACTION_GAP_SECONDS) {
      boundary = "time_gap";
      break;
    }
    if (chain.length >= MAX_SEQUENCE_ACTIONS) {
      boundary = "action_cap";
      break;
    }
    chain.unshift(candidate);
    if (candidate.type === "corner") {
      boundary = "corner_origin";
      break;
    }
  }
  const originEvent = chain[0];
  const chance = chain[chain.length - 1];
  const playerIds: string[] = [];
  for (const event of chain) {
    if (event.playerId && !playerIds.includes(event.playerId)) playerIds.push(event.playerId);
  }
  return {
    shotEventId: shot.id,
    eventIds: chain.map((event) => event.id),
    steps: chain.map((event) => ({
      eventId: event.id,
      type: event.type,
      playerId: event.playerId,
      minute: event.minute,
      second: event.second,
    })),
    origin: { eventId: originEvent.id, type: originEvent.type, x: originEvent.x, y: originEvent.y, zone: pitchThird(originEvent.x) },
    actions: chain.length,
    passes: chain.filter((event) => event.type === "pass").length,
    playerIds,
    progressionM: camera ? null : round(((chance.x - originEvent.x) / 100) * PITCH_LENGTH_M, 1),
    matchClockSpanSeconds: eventSecond(chance) - eventSecond(originEvent),
    boundary,
    inferred: true,
  };
}

export function buildTerritory(events: MatchEvent[], chance: MatchEvent, windowSeconds = TERRITORY_WINDOW_SECONDS): TerritoryContext {
  const chanceSecond = eventSecond(chance);
  const currentStart = Math.max(0, chanceSecond - windowSeconds);
  const previousEnd = currentStart;
  const previousStart = Math.max(0, chanceSecond - windowSeconds * 2);
  const open = latestOpenEvents(events, chanceSecond).filter((event) => event.id !== chance.id);
  const inWindow = (start: number, end: number) => open.filter((event) => {
    const second = eventSecond(event);
    return second >= start && second < end;
  });
  const currentEvents = inWindow(currentStart, chanceSecond);
  const previousEvents = inWindow(previousStart, previousEnd);
  const home = { current: sliceFor(currentEvents, "home"), previous: sliceFor(previousEvents, "home") };
  const away = { current: sliceFor(currentEvents, "away"), previous: sliceFor(previousEvents, "away") };
  const coverageNotes = [
    "Event-derived territory counts recorded actions in a match-clock window. It is not possession and not pressure.",
  ];
  if (currentStart === 0 && chanceSecond < windowSeconds) {
    coverageNotes.push("Current window is clipped at match clock 0.");
  }
  if (previousEnd - previousStart < windowSeconds) {
    coverageNotes.push("Previous comparison window is clipped or empty because the match clock starts at 0.");
  }
  const missing = home.current.passesMissingEndX + away.current.passesMissingEndX + home.previous.passesMissingEndX + away.previous.passesMissingEndX;
  if (missing > 0) {
    coverageNotes.push(`${missing} completed pass(es) lack endX, so final-third entry and ending-pass counts are null rather than partial.`);
  }
  return {
    label: "event-derived territory",
    windowSeconds,
    chanceSecond,
    current: { startSecond: currentStart, endSecond: chanceSecond },
    previous: { startSecond: previousStart, endSecond: previousEnd },
    home,
    away,
    change: { home: delta(home.current, home.previous), away: delta(away.current, away.previous) },
    coverageNotes,
  };
}

function countText(value: number | null, ready: string, missing: string): string {
  return value === null ? missing : ready.replaceAll("{n}", String(value));
}

/**
 * Numbers for the shooting team. `teamId` selects which territory slice the claim may cite.
 * The verifier recomputes this and rejects a proposal that disagrees.
 */
export function chanceClaimNumbersForTeam(sequence: ChanceSequence, territory: TerritoryContext, teamId: TeamId): ChanceClaimNumbers {
  const shooting = teamId === "home" ? territory.home.current : territory.away.current;
  const windowMinutes = Math.max(0, Math.round((territory.current.endSecond - territory.current.startSecond) / 60));
  return {
    shotEventId: sequence.shotEventId,
    actions: sequence.actions,
    passes: sequence.passes,
    players: sequence.playerIds.length,
    originZone: sequence.origin.zone,
    progressionM: sequence.progressionM === null ? null : Math.round(sequence.progressionM),
    matchClockSpanSeconds: sequence.matchClockSpanSeconds,
    boundary: sequence.boundary,
    ownHalf: sequence.origin.x < 50,
    finalThirdEntries: shooting.finalThirdEntries,
    completedPassesEndingInFinalThird: shooting.completedPassesEndingInFinalThird,
    attackingActionsInFinalThird: shooting.attackingActionsInFinalThird,
    attackingActions: shooting.attackingActions,
    windowMinutes,
  };
}

const ZONE_LABEL = {
  en: { defensive: "defensive third", middle: "middle third", final: "final third" },
  es: { defensive: "tercio defensivo", middle: "tercio medio", final: "tercio final" },
  fr: { defensive: "tiers défensif", middle: "tiers médian", final: "tiers offensif" },
  pt: { defensive: "terço defensivo", middle: "terço do meio", final: "terço final" },
} as const;

export function chanceClaimText(numbers: ChanceClaimNumbers, teamName: string, playerNames: string[]): { en: string; es: string; fr: string; pt: string } {
  const originEn = numbers.ownHalf ? "from their own half" : `from the ${ZONE_LABEL.en[numbers.originZone]}`;
  const originEs = numbers.ownHalf ? "desde su propio campo" : `desde el ${ZONE_LABEL.es[numbers.originZone]}`;
  const originFr = numbers.ownHalf ? "depuis leur propre moitié" : `depuis le ${ZONE_LABEL.fr[numbers.originZone]}`;
  const originPt = numbers.ownHalf ? "a partir do próprio campo" : `a partir do ${ZONE_LABEL.pt[numbers.originZone]}`;
  const progressionEn = numbers.progressionM === null ? "progression unavailable" : `${numbers.progressionM} m progression`;
  const progressionEs = numbers.progressionM === null ? "progresión no disponible" : `${numbers.progressionM} m de progresión`;
  const progressionFr = numbers.progressionM === null ? "progression indisponible" : `${numbers.progressionM} m de progression`;
  const progressionPt = numbers.progressionM === null ? "progressão indisponível" : `${numbers.progressionM} m de progressão`;
  const entriesEn = countText(numbers.finalThirdEntries, "{n} final-third entries", "final-third entries unavailable");
  const endingEn = countText(numbers.completedPassesEndingInFinalThird, "{n} completed passes ending in the final third", "completed final-third passes unavailable");
  const entriesEs = countText(numbers.finalThirdEntries, "{n} entradas al tercio final", "entradas al tercio final no disponibles");
  const endingEs = countText(numbers.completedPassesEndingInFinalThird, "{n} pases completados que terminan en el tercio final", "pases completados al tercio final no disponibles");
  const entriesFr = countText(numbers.finalThirdEntries, "{n} entrées dans le tiers offensif", "entrées dans le tiers offensif indisponibles");
  const endingFr = countText(numbers.completedPassesEndingInFinalThird, "{n} passes réussies finissant dans le tiers offensif", "passes réussies dans le tiers offensif indisponibles");
  const entriesPt = countText(numbers.finalThirdEntries, "{n} entradas no terço final", "entradas no terço final indisponíveis");
  const endingPt = countText(numbers.completedPassesEndingInFinalThird, "{n} passes completos terminando no terço final", "passes completos no terço final indisponíveis");
  const names = playerNames.length > 0 ? ` Players: ${playerNames.join(", ")}.` : "";
  return {
    en: `Inferred build-up for ${teamName}: a ${numbers.passes}-pass move ${originEn}, ${numbers.players} players involved, ${numbers.actions} actions, ${progressionEn}, ${numbers.matchClockSpanSeconds} s match-clock span, boundary ${numbers.boundary}. Event-derived territory over ${numbers.windowMinutes} min: ${entriesEn}, ${endingEn}, ${numbers.attackingActionsInFinalThird} of ${numbers.attackingActions} recorded attacking actions in the final third.${names}`,
    es: `Construcción inferida de ${teamName}: una jugada de ${numbers.passes} pases ${originEs}, ${numbers.players} jugadores, ${numbers.actions} acciones, ${progressionEs}, ${numbers.matchClockSpanSeconds} s de reloj de partido, límite ${numbers.boundary}. Territorio derivado de eventos en ${numbers.windowMinutes} min: ${entriesEs}, ${endingEs}, ${numbers.attackingActionsInFinalThird} de ${numbers.attackingActions} acciones ofensivas registradas en el tercio final.${names}`,
    fr: `Construction inférée de ${teamName} : une action de ${numbers.passes} passes ${originFr}, ${numbers.players} joueurs, ${numbers.actions} actions, ${progressionFr}, ${numbers.matchClockSpanSeconds} s au chrono du match, limite ${numbers.boundary}. Territoire dérivé des événements sur ${numbers.windowMinutes} min : ${entriesFr}, ${endingFr}, ${numbers.attackingActionsInFinalThird} des ${numbers.attackingActions} actions offensives enregistrées dans le tiers offensif.${names}`,
    pt: `Construção inferida do ${teamName}: uma jogada de ${numbers.passes} passes ${originPt}, ${numbers.players} jogadores, ${numbers.actions} ações, ${progressionPt}, ${numbers.matchClockSpanSeconds} s no relógio da partida, limite ${numbers.boundary}. Território derivado de eventos em ${numbers.windowMinutes} min: ${entriesPt}, ${endingPt}, ${numbers.attackingActionsInFinalThird} de ${numbers.attackingActions} ações ofensivas registradas no terço final.${names}`,
  };
}

export function summaryFacts(sequence: ChanceSequence, territory: TerritoryContext, teamId: TeamId): string[] {
  const numbers = chanceClaimNumbersForTeam(sequence, territory, teamId);
  const progression = numbers.progressionM === null ? "Progression unavailable (camera frame)." : `Progression ${numbers.progressionM} m on the 105 m pitch (attacking-frame x, not pass length).`;
  const entries = numbers.finalThirdEntries === null
    ? "Final-third entries unavailable because a completed pass has no end point."
    : `Event-derived territory: ${numbers.finalThirdEntries} final-third entries and ${numbers.completedPassesEndingInFinalThird} completed passes ending in the final third in ${numbers.windowMinutes} min (denominators in the territory record).`;
  return [
    `Inferred sequence: ${numbers.passes} passes, ${numbers.actions} actions, ${numbers.players} players, origin ${numbers.originZone}${numbers.ownHalf ? " (own half)" : ""}.`,
    progression,
    `Match-clock span ${numbers.matchClockSpanSeconds} s (not ball-in-play). Boundary: ${numbers.boundary}.`,
    entries,
    `${numbers.attackingActionsInFinalThird} of ${numbers.attackingActions} recorded attacking actions started in the final third.`,
  ];
}

export function sequenceCoverageNotes(sequence: ChanceSequence, territory: TerritoryContext, camera: boolean): string[] {
  const notes = [
    "Sequence boundaries are inferred from event order, not provider possession ids.",
    "Elapsed time is match-clock span, not ball-in-play.",
    ...territory.coverageNotes,
  ];
  if (camera || sequence.progressionM === null) {
    notes.push("Progression unavailable: camera-frame coordinates have no metric scale.");
  }
  return notes;
}

const EVIDENCE_CAP = 40;

export function evidenceForChance(events: MatchEvent[], sequence: ChanceSequence, territory: TerritoryContext, atSecond: number): { refs: EvidenceEventRef[]; truncated: boolean } {
  const latest = new Map<string, MatchEvent>();
  for (const event of events) {
    if (eventSecond(event) > atSecond) continue;
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  const ids: string[] = [];
  const push = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const id of sequence.eventIds) push(id);
  const open = latestOpenEvents(events, atSecond).filter((event) => event.id !== sequence.shotEventId);
  for (const event of open) {
    const second = eventSecond(event);
    if (second < territory.current.startSecond || second >= territory.current.endSecond) continue;
    if (ATTACKING_TYPES.has(event.type)) push(event.id);
  }
  const truncated = ids.length > EVIDENCE_CAP;
  const refs = ids.slice(0, EVIDENCE_CAP).map((eventId) => ({ eventId, revision: latest.get(eventId)?.revision ?? 0 }));
  return { refs, truncated };
}

export interface RecomputeInput {
  previous: ChanceInsight[];
  events: MatchEvent[];
  matchId: string;
  atSecond: number;
  camera: boolean;
  /** Match-clock second of the event that triggered this recompute. */
  effectiveSecond: number;
}

function contentKey(sequence: ChanceSequence, territory: TerritoryContext, refs: EvidenceEventRef[]): string {
  return JSON.stringify({
    ids: sequence.eventIds,
    boundary: sequence.boundary,
    actions: sequence.actions,
    passes: sequence.passes,
    players: sequence.playerIds,
    zone: sequence.origin.zone,
    x: sequence.origin.x,
    y: sequence.origin.y,
    type: sequence.origin.type,
    progression: sequence.progressionM,
    span: sequence.matchClockSpanSeconds,
    evidence: refs.map((ref) => [ref.eventId, ref.revision]),
    territory,
  });
}

function buildIssued(input: RecomputeInput, shot: MatchEvent, revision: number, status: ChanceInsightStatus, reason?: string): ChanceInsight {
  const sequence = buildChanceSequence(input.events, shot, input.camera);
  if (!sequence) {
    throw new Error(`Chance ${shot.id} has no sequence`);
  }
  const territory = buildTerritory(input.events, shot);
  const evidence = evidenceForChance(input.events, sequence, territory, input.atSecond);
  const notes = sequenceCoverageNotes(sequence, territory, input.camera);
  if (evidence.truncated) notes.push(`Evidence list truncated at ${EVIDENCE_CAP} events.`);
  const insight: ChanceInsight = {
    insightId: chanceInsightId(shot.id),
    revision,
    matchId: input.matchId,
    status,
    effectiveSecond: status === "issued" ? eventSecond(shot) : input.effectiveSecond,
    evidenceEventIds: evidence.refs,
    metricVersion: CHANCE_SEQUENCE_VERSION,
    coverageNotes: notes,
    sequence,
    territory,
    summaryFacts: summaryFacts(sequence, territory, shot.teamId),
  };
  if (status === "revised") insight.revisionReason = reason ?? "Sequence or event-derived territory changed";
  return insight;
}

/**
 * Recompute the insight list from the full event log (all revisions).
 * A new chance is `issued` at revision 1. A change to a contributing event's revision or to the
 * computed sequence/territory bumps revision and sets `revised`. A rescinded or removed shot/goal
 * is `withdrawn` and stays in the list so clients can drop it.
 */
export function recomputeChanceInsights(input: RecomputeInput): { insights: ChanceInsight[]; changed: ChanceInsight[] } {
  const previousById = new Map(input.previous.map((insight) => [insight.insightId, insight]));
  const chances = latestOpenEvents(input.events, input.atSecond).filter((event) => event.type === "shot" || event.type === "goal");
  const next: ChanceInsight[] = [];
  const changed: ChanceInsight[] = [];
  const seen = new Set<string>();

  for (const shot of chances) {
    const insightId = chanceInsightId(shot.id);
    seen.add(insightId);
    const sequence = buildChanceSequence(input.events, shot, input.camera);
    if (!sequence) continue;
    const territory = buildTerritory(input.events, shot);
    const evidence = evidenceForChance(input.events, sequence, territory, input.atSecond);
    const key = contentKey(sequence, territory, evidence.refs);
    const previous = previousById.get(insightId);
    if (!previous || previous.sequence === null || previous.territory === null) {
      const issued = buildIssued(input, shot, (previous?.revision ?? 0) + 1, previous ? "revised" : "issued", previous ? "Shot or goal restored" : undefined);
      next.push(issued);
      changed.push(issued);
      continue;
    }
    const previousKey = contentKey(previous.sequence, previous.territory, previous.evidenceEventIds);
    if (previous.status !== "withdrawn" && previousKey === key) {
      next.push(previous);
      continue;
    }
    const reason = previous.status === "withdrawn"
      ? "Shot or goal restored"
      : evidenceChanged(previous.evidenceEventIds, evidence.refs)
        ? "A contributing event was revised"
        : "Sequence or event-derived territory counts changed";
    const revised = buildIssued(input, shot, previous.revision + 1, "revised", reason);
    next.push(revised);
    changed.push(revised);
  }

  for (const previous of input.previous) {
    if (seen.has(previous.insightId)) continue;
    if (previous.status === "withdrawn") {
      next.push(previous);
      continue;
    }
    const shotId = shotEventIdFromInsight(previous.insightId);
    const latest = shotId ? latestRevision(input.events, shotId, input.atSecond) : undefined;
    const withdrawn: ChanceInsight = {
      ...previous,
      revision: previous.revision + 1,
      status: "withdrawn",
      effectiveSecond: input.effectiveSecond,
      withdrawalReason: latest?.rescinded ? "Shot or goal was rescinded" : "Shot or goal was removed",
      revisionReason: undefined,
    };
    next.push(withdrawn);
    changed.push(withdrawn);
  }

  next.sort((left, right) => right.effectiveSecond - left.effectiveSecond || left.insightId.localeCompare(right.insightId));
  return { insights: next, changed };
}

function evidenceChanged(previous: EvidenceEventRef[], next: EvidenceEventRef[]): boolean {
  if (previous.length !== next.length) return true;
  return previous.some((ref, index) => ref.eventId !== next[index]?.eventId || ref.revision !== next[index]?.revision);
}

export function isChanceFixtureCamera(fixture: Pick<MatchFixture, "id">): boolean {
  return isCameraFixture(fixture);
}
