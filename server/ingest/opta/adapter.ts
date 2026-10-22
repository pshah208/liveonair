import type { EventType, MatchEvent, TeamId } from "../../../shared/types.js";
import { OPTA_MAPPING, OPTA_STYLE_LABEL } from "./mapping.js";

export interface OptaStyleQualifier {
  qualifierId: number;
  value?: string;
}

/** Synthetic F24-like event. Not a licensed Opta payload. */
export interface OptaStyleEvent {
  id: string;
  typeId: number;
  period: 1 | 2;
  min: number;
  sec: number;
  teamId: number | TeamId;
  playerId: string;
  outcome: 0 | 1;
  x: number;
  y: number;
  qualifiers: OptaStyleQualifier[];
}

export interface OptaStyleTeam {
  id: number;
  side: TeamId;
}

export interface OptaStyleFeed {
  label: typeof OPTA_STYLE_LABEL;
  synthetic: true;
  teams: OptaStyleTeam[];
  events: OptaStyleEvent[];
}

export type AdaptedOptaItem =
  | { kind: "event"; event: MatchEvent }
  | { kind: "correction"; eventId: string }
  | { kind: "ignored"; typeId: number; reason: string };

export type OptaLog = (entry: {
  level: "warn";
  component: "opta-adapter";
  reason: string;
  typeId?: number;
  eventId?: string;
}) => void;

const EVENT_TYPES = new Set<EventType>([
  "pass", "shot", "goal", "save", "tackle", "pressure", "corner", "foul",
  "yellow_card", "red_card", "substitution", "kickoff", "halftime", "fulltime",
]);

const OUTCOMES = new Set<MatchEvent["outcome"]>(["success", "miss", "blocked", "saved", "complete", "incomplete", "none"]);

const Q = OPTA_MAPPING.qualifiers;
const T = OPTA_MAPPING.types;

const TYPE_BY_ID = new Map<number, { canonical: string; outcome?: MatchEvent["outcome"] }>([
  [T.pass.typeId, { canonical: "pass" }],
  [T.tackle.typeId, { canonical: "tackle" }],
  [T.save.typeId, { canonical: "save" }],
  [T.shotMiss.typeId, { canonical: "shot", outcome: "miss" }],
  [T.shotBlocked.typeId, { canonical: "shot", outcome: "blocked" }],
  [T.shotSaved.typeId, { canonical: "shot", outcome: "saved" }],
  [T.goal.typeId, { canonical: "goal" }],
  [T.card.typeId, { canonical: "card" }],
  [T.subOff.typeId, { canonical: "substitution" }],
  [T.subOn.typeId, { canonical: "substitution" }],
  [T.deleted.typeId, { canonical: "deleted" }],
  [T.pressure.typeId, { canonical: "pressure" }],
  [T.corner.typeId, { canonical: "corner" }],
  [T.foul.typeId, { canonical: "foul" }],
  [T.kickoff.typeId, { canonical: "kickoff" }],
  [T.halftime.typeId, { canonical: "halftime" }],
  [T.fulltime.typeId, { canonical: "fulltime" }],
]);

function defaultLog(entry: Parameters<OptaLog>[0]): void {
  console.warn(JSON.stringify(entry));
}

export function roundPitch(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/**
 * Fixed-frame convention used only at ingestion (unverified community reading):
 * period 1 home attacks toward x=100; away attacks toward x=0. Ends switch in period 2.
 * Canonical events already use the attacking frame (x=100 is the goal being attacked).
 * The mirror is an involution, so the same function converts both ways.
 */
export function mirrorAttackingDirection(x: number, y: number, teamId: TeamId, period: 1 | 2): { x: number; y: number } {
  const homeAttacksHighX = period === 1;
  const attacksHighX = teamId === "home" ? homeAttacksHighX : !homeAttacksHighX;
  if (attacksHighX) return { x: roundPitch(x), y: roundPitch(y) };
  return { x: roundPitch(100 - x), y: roundPitch(100 - y) };
}

function periodOf(event: Pick<MatchEvent, "period" | "minute" | "second">): 1 | 2 {
  if (event.period === 1 || event.period === 2) return event.period;
  return event.minute * 60 + event.second <= 45 * 60 ? 1 : 2;
}

function qualifier(list: OptaStyleQualifier[], id: number): string | undefined {
  return list.find((item) => item.qualifierId === id)?.value;
}

function pushQualifier(list: OptaStyleQualifier[], id: number, value: string): void {
  list.push({ qualifierId: id, value });
}

function outcomeBit(event: MatchEvent): 0 | 1 {
  if (event.outcome === "complete" || event.outcome === "success" || event.outcome === "saved") return 1;
  return 0;
}

function shotTypeId(event: MatchEvent): number {
  if (event.outcome === "miss") return T.shotMiss.typeId;
  if (event.outcome === "blocked") return T.shotBlocked.typeId;
  if (event.outcome === "saved" || event.outcome === "success") return T.shotSaved.typeId;
  return T.shotMiss.typeId;
}

function endQualifiers(event: MatchEvent, teamId: TeamId, period: 1 | 2): OptaStyleQualifier[] {
  if (event.endX === undefined || event.endY === undefined) return [];
  const end = mirrorAttackingDirection(event.endX, event.endY, teamId, period);
  return [
    { qualifierId: Q.passEndX.qualifierId, value: String(end.x) },
    { qualifierId: Q.passEndY.qualifierId, value: String(end.y) },
  ];
}

export function canonicalEventToOpta(event: MatchEvent): OptaStyleEvent {
  const period = periodOf(event);
  const teamId = event.teamId;
  const start = mirrorAttackingDirection(event.x, event.y, teamId, period);
  const qualifiers: OptaStyleQualifier[] = [];

  let typeId: number;
  if (event.rescinded) {
    typeId = T.deleted.typeId;
    pushQualifier(qualifiers, Q.relatedEvent.qualifierId, event.id);
  } else {
    switch (event.type) {
      case "pass":
        typeId = T.pass.typeId;
        qualifiers.push(...endQualifiers(event, teamId, period));
        break;
      case "tackle":
        typeId = T.tackle.typeId;
        break;
      case "save":
        typeId = T.save.typeId;
        break;
      case "shot":
        typeId = shotTypeId(event);
        break;
      case "goal":
        typeId = T.goal.typeId;
        break;
      case "yellow_card":
        typeId = T.card.typeId;
        pushQualifier(qualifiers, Q.yellowCard.qualifierId, "yellow");
        break;
      case "red_card":
        typeId = T.card.typeId;
        pushQualifier(qualifiers, Q.redCard.qualifierId, "red");
        break;
      case "substitution":
        typeId = T.subOn.typeId;
        break;
      case "pressure":
        typeId = T.pressure.typeId;
        pushQualifier(qualifiers, Q.syntheticPressure.qualifierId, Q.syntheticPressure.value);
        break;
      case "corner":
        typeId = T.corner.typeId;
        qualifiers.push(...endQualifiers(event, teamId, period));
        break;
      case "foul":
        typeId = T.foul.typeId;
        break;
      case "kickoff":
        typeId = T.kickoff.typeId;
        break;
      case "halftime":
        typeId = T.halftime.typeId;
        break;
      case "fulltime":
        typeId = T.fulltime.typeId;
        break;
      default: {
        const unhandled: never = event.type;
        throw new Error(`No Opta-style mapping for ${String(unhandled)}`);
      }
    }
    if (event.relatedEventId) pushQualifier(qualifiers, Q.relatedEvent.qualifierId, event.relatedEventId);
    pushQualifier(qualifiers, Q.syntheticOutcome.qualifierId, `synthetic-extension:outcome:${event.outcome}`);
    if (event.xg !== undefined) pushQualifier(qualifiers, Q.syntheticXg.qualifierId, String(event.xg));
    if (event.flightMs !== undefined) pushQualifier(qualifiers, Q.syntheticFlightMs.qualifierId, String(event.flightMs));
    if (event.speedKmh !== undefined) pushQualifier(qualifiers, Q.syntheticSpeedKmh.qualifierId, String(event.speedKmh));
    if (event.revision !== 1) pushQualifier(qualifiers, Q.syntheticRevision.qualifierId, String(event.revision));
  }

  return {
    id: event.id,
    typeId,
    period,
    min: event.minute,
    sec: event.second,
    teamId: OPTA_MAPPING.teams[teamId],
    playerId: event.playerId,
    outcome: outcomeBit(event),
    x: start.x,
    y: start.y,
    qualifiers,
  };
}

export function canonicalEventsToOptaFeed(events: MatchEvent[]): OptaStyleFeed {
  return {
    label: OPTA_STYLE_LABEL,
    synthetic: true,
    teams: [
      { id: OPTA_MAPPING.teams.home, side: "home" },
      { id: OPTA_MAPPING.teams.away, side: "away" },
    ],
    events: events.map((event) => canonicalEventToOpta(event)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readPeriod(raw: Record<string, unknown>): 1 | 2 | undefined {
  const value = raw.period ?? raw.periodId;
  return value === 1 || value === 2 ? value : undefined;
}

function readQualifiers(raw: unknown): OptaStyleQualifier[] {
  if (!Array.isArray(raw)) return [];
  const qualifiers: OptaStyleQualifier[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record || typeof record.qualifierId !== "number") continue;
    qualifiers.push({
      qualifierId: record.qualifierId,
      ...(record.value === undefined || record.value === null ? {} : { value: String(record.value) }),
    });
  }
  return qualifiers;
}

function resolveTeam(teamId: unknown, teams: OptaStyleTeam[]): TeamId | undefined {
  if (teamId === "home" || teamId === "away") return teamId;
  if (typeof teamId === "number" || (typeof teamId === "string" && teamId.trim())) {
    return teams.find((team) => String(team.id) === String(teamId))?.side;
  }
  return undefined;
}

function readTeams(raw: unknown): OptaStyleTeam[] {
  const fallback = [
    { id: OPTA_MAPPING.teams.home, side: "home" as const },
    { id: OPTA_MAPPING.teams.away, side: "away" as const },
  ];
  if (!Array.isArray(raw)) return fallback;
  const teams: OptaStyleTeam[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const side = record.side === "home" || record.side === "away" ? record.side : undefined;
    const id = typeof record.id === "number" ? record.id : Number(record.id);
    if (!side || !Number.isFinite(id)) continue;
    teams.push({ id, side });
  }
  return teams.length > 0 ? teams : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inferredOutcome(canonical: EventType, bit: 0 | 1, shotOutcome: MatchEvent["outcome"] | undefined): MatchEvent["outcome"] {
  if (canonical === "pass" || canonical === "corner") return bit === 1 ? "complete" : "incomplete";
  if (canonical === "shot") return shotOutcome ?? (bit === 1 ? "saved" : "miss");
  if (canonical === "tackle") return bit === 1 ? "success" : "incomplete";
  if (canonical === "yellow_card" || canonical === "red_card" || canonical === "substitution" || canonical === "kickoff" || canonical === "halftime" || canonical === "fulltime" || canonical === "foul") {
    return "none";
  }
  if (canonical === "goal" || canonical === "save" || canonical === "pressure") return "success";
  return bit === 1 ? "success" : "none";
}

function parseOutcomeQualifier(value: string | undefined): MatchEvent["outcome"] | undefined {
  if (!value?.startsWith("synthetic-extension:outcome:")) return undefined;
  const outcome = value.slice("synthetic-extension:outcome:".length);
  return OUTCOMES.has(outcome as MatchEvent["outcome"]) ? outcome as MatchEvent["outcome"] : undefined;
}

export function adaptOptaEvent(
  raw: unknown,
  teams: OptaStyleTeam[],
  log: OptaLog = defaultLog,
): AdaptedOptaItem {
  const record = asRecord(raw);
  if (!record) {
    log({ level: "warn", component: "opta-adapter", reason: "Opta-style event ignored: not an object" });
    return { kind: "ignored", typeId: -1, reason: "not an object" };
  }
  const typeId = typeof record.typeId === "number" ? record.typeId : -1;
  const mapped = TYPE_BY_ID.get(typeId);
  if (!mapped) {
    log({
      level: "warn",
      component: "opta-adapter",
      reason: "Unknown Opta-style typeId ignored",
      typeId,
      eventId: record.id === undefined ? undefined : String(record.id),
    });
    return { kind: "ignored", typeId, reason: "unknown typeId" };
  }

  const qualifiers = readQualifiers(record.qualifiers ?? record.qualifier);
  const eventId = String(record.id ?? record.eventId ?? "").trim();
  if (mapped.canonical === "deleted") {
    const related = qualifier(qualifiers, Q.relatedEvent.qualifierId)?.trim();
    if (!related) {
      log({ level: "warn", component: "opta-adapter", reason: "Deleted Opta-style event ignored: missing related event", typeId, eventId });
      return { kind: "ignored", typeId, reason: "deletion missing related event" };
    }
    return { kind: "correction", eventId: related };
  }

  const period = readPeriod(record);
  const teamId = resolveTeam(record.teamId, teams);
  const minute = finiteNumber(record.min ?? record.minute);
  const second = finiteNumber(record.sec ?? record.second);
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (!period || !teamId || minute === undefined || second === undefined || x === undefined || y === undefined || !eventId) {
    log({ level: "warn", component: "opta-adapter", reason: "Opta-style event ignored: missing required fields", typeId, eventId });
    return { kind: "ignored", typeId, reason: "missing required fields" };
  }
  if (!Number.isInteger(minute) || minute < 0 || !Number.isInteger(second) || second < 0 || second > 59) {
    log({ level: "warn", component: "opta-adapter", reason: "Opta-style event ignored: invalid clock", typeId, eventId });
    return { kind: "ignored", typeId, reason: "invalid clock" };
  }

  let canonical = mapped.canonical;
  let shotOutcome = mapped.outcome;
  if (canonical === "card") {
    const yellow = qualifiers.some((item) => item.qualifierId === Q.yellowCard.qualifierId);
    const secondYellow = qualifiers.some((item) => item.qualifierId === Q.secondYellow.qualifierId);
    const red = qualifiers.some((item) => item.qualifierId === Q.redCard.qualifierId);
    if (secondYellow || red) canonical = "red_card";
    else if (yellow) canonical = "yellow_card";
    else {
      log({ level: "warn", component: "opta-adapter", reason: "Card ignored: missing qualifier 31, 32 or 33", typeId, eventId });
      return { kind: "ignored", typeId, reason: "card missing qualifier" };
    }
  }
  if (canonical === "pressure") {
    const marker = qualifier(qualifiers, Q.syntheticPressure.qualifierId);
    if (marker && marker !== Q.syntheticPressure.value) {
      log({ level: "warn", component: "opta-adapter", reason: "Pressure extension ignored: qualifier was not the synthetic marker", typeId, eventId });
      return { kind: "ignored", typeId, reason: "pressure qualifier mismatch" };
    }
  }
  if (!EVENT_TYPES.has(canonical as EventType)) {
    log({ level: "warn", component: "opta-adapter", reason: "Opta-style event ignored: unmapped canonical type", typeId, eventId });
    return { kind: "ignored", typeId, reason: "unmapped canonical type" };
  }

  const bit: 0 | 1 = record.outcome === 1 || record.outcome === true ? 1 : 0;
  const markedOutcome = parseOutcomeQualifier(qualifier(qualifiers, Q.syntheticOutcome.qualifierId));
  if (canonical === "shot" && markedOutcome === "success") shotOutcome = "success";
  const outcome = markedOutcome ?? inferredOutcome(canonical as EventType, bit, shotOutcome);
  const attacking = mirrorAttackingDirection(x, y, teamId, period);
  const endXRaw = qualifier(qualifiers, Q.passEndX.qualifierId);
  const endYRaw = qualifier(qualifiers, Q.passEndY.qualifierId);
  const endX = endXRaw === undefined ? undefined : finiteNumber(Number(endXRaw));
  const endY = endYRaw === undefined ? undefined : finiteNumber(Number(endYRaw));
  const end = endX !== undefined && endY !== undefined ? mirrorAttackingDirection(endX, endY, teamId, period) : undefined;
  const related = qualifier(qualifiers, Q.relatedEvent.qualifierId)?.trim();
  const xgRaw = qualifier(qualifiers, Q.syntheticXg.qualifierId);
  const flightRaw = qualifier(qualifiers, Q.syntheticFlightMs.qualifierId);
  const speedRaw = qualifier(qualifiers, Q.syntheticSpeedKmh.qualifierId);
  const revisionRaw = qualifier(qualifiers, Q.syntheticRevision.qualifierId);
  const xg = xgRaw === undefined ? undefined : finiteNumber(Number(xgRaw));
  const flightMs = flightRaw === undefined ? undefined : finiteNumber(Number(flightRaw));
  const speedKmh = speedRaw === undefined ? undefined : finiteNumber(Number(speedRaw));
  const revisionNumber = revisionRaw === undefined ? undefined : finiteNumber(Number(revisionRaw));
  const revision = revisionNumber !== undefined && Number.isInteger(revisionNumber) && revisionNumber >= 1 ? revisionNumber : 1;
  const playerId = String(record.playerId ?? "").trim();
  if (!playerId) {
    log({ level: "warn", component: "opta-adapter", reason: "Opta-style event ignored: missing playerId", typeId, eventId });
    return { kind: "ignored", typeId, reason: "missing playerId" };
  }

  const event: MatchEvent = {
    id: eventId,
    revision,
    minute,
    second,
    type: canonical as EventType,
    teamId,
    playerId,
    outcome,
    x: attacking.x,
    y: attacking.y,
    period,
    ...(end ? { endX: end.x, endY: end.y } : {}),
    ...(xg !== undefined ? { xg } : {}),
    ...(related ? { relatedEventId: related } : {}),
    ...(flightMs !== undefined && flightMs > 0 ? { flightMs } : {}),
    ...(speedKmh !== undefined && speedKmh > 0 ? { speedKmh } : {}),
  };
  return { kind: "event", event };
}

export function adaptOptaFeed(feed: unknown, log: OptaLog = defaultLog): { label: string; items: AdaptedOptaItem[] } {
  const record = asRecord(feed);
  const events = Array.isArray(feed) ? feed : Array.isArray(record?.events) ? record.events : [];
  const teams = readTeams(record?.teams);
  const label = typeof record?.label === "string" ? record.label : "";
  if (!Array.isArray(feed) && label !== OPTA_STYLE_LABEL) {
    log({
      level: "warn",
      component: "opta-adapter",
      reason: "Opta-style feed is missing the synthetic label. Parsing continues; this is not a licensed feed.",
    });
  }
  return {
    label: label || OPTA_STYLE_LABEL,
    items: events.map((event) => adaptOptaEvent(event, teams, log)),
  };
}

export function roundTripCanonicalEvent(event: MatchEvent, log?: OptaLog): AdaptedOptaItem {
  const feed = canonicalEventsToOptaFeed([event]);
  const adapted = adaptOptaFeed(feed, log ?? (() => undefined));
  return adapted.items[0] ?? { kind: "ignored", typeId: -1, reason: "empty feed" };
}
