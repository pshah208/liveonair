import type { MatchEvent } from "./types.js";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_SECONDS, type DetectableEventType, type ManualTagInput, type VideoJob } from "./video.js";

// New categories are appended so saved reviews and backups from earlier versions stay valid.
export const CATEGORIES = ["goal", "shot", "pass", "tackle", "pressing", "set_piece", "defensive_shape", "custom", "save", "foul", "yellow_card", "red_card"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Team = "home" | "away" | "neutral";
export type Outcome = "success" | "unsuccessful" | "unknown";

export interface LabSource {
  name: string;
  size: number;
  lastModified: number;
  duration: number;
}

export interface Annotation {
  id: string;
  inSeconds: number;
  outSeconds: number;
  title: string;
  category: Category;
  team: Team;
  players: string[];
  outcome: Outcome;
  notes: string;
  readonly source: Readonly<{ kind: "manual" }> | Readonly<{
    kind: "ai";
    jobId: string;
    eventId: string;
    confidence: number | null;
    evidence: string;
    timestampSeconds: number;
    frameIndex: number | null;
    inferred: boolean;
  }>;
}

export interface Filters {
  team: Team | "all";
  player: string;
  category: Category | "all";
  source: "all" | "manual" | "ai";
  query: string;
  from: number;
  to: number;
}

export interface LabStats {
  total: number;
  shots: number;
  goals: number;
  passes: number;
  defensiveActions: number;
  teams: { home: number; away: number; neutral: number };
  players: { player: string; count: number }[];
  outcomes: { success: number; unsuccessful: number; unknown: number };
  passSuccess: { success: number; known: number; percent: number | null };
  activity: { from: number; to: number; count: number }[];
}

export interface LabReport {
  version: 1;
  source: LabSource;
  filters: Filters;
  annotations: Annotation[];
  stats: LabStats;
}

export const MAX_ANNOTATIONS = 200;
export const MAX_LAB_JSON_BYTES = 1048576;
const TEAMS = ["home", "away", "neutral"] as const;
const OUTCOMES = ["success", "unsuccessful", "unknown"] as const;
const ANNOTATION_FIELDS = ["id", "inSeconds", "outSeconds", "title", "category", "team", "players", "outcome", "notes", "source"];
const AI_FIELDS = ["kind", "jobId", "eventId", "confidence", "evidence", "timestampSeconds", "frameIndex", "inferred"];

function shape(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length ||
    !fields.every((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
      Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    throw new Error(`${label} has an invalid shape.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number, label: string, required = false): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) {
    throw new Error(`${label} must be ${required ? "a nonempty" : "a"} string of at most ${limit} characters.`);
  }
  return value;
}

function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be finite and between ${min} and ${max}.`);
  }
  return value;
}

function integer(value: unknown, max: number, label: string): number {
  const result = number(value, 0, max, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be a safe integer.`);
  return result;
}

function durationValue(value: unknown): number {
  const result = number(value, 0, MAX_VIDEO_SECONDS, "duration");
  if (result === 0) throw new Error("duration must be positive.");
  return result;
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`Invalid ${label}.`);
  return value as T;
}

function range(start: unknown, end: unknown, duration: number): { inSeconds: number; outSeconds: number } {
  const inSeconds = number(start, 0, duration, "range start");
  const outSeconds = number(end, 0, duration, "range end");
  if (inSeconds >= outSeconds) throw new Error("Invalid range: start must precede end.");
  return { inSeconds, outSeconds };
}

export function validateSource(value: unknown): LabSource {
  const source = shape(value, ["name", "size", "lastModified", "duration"], "Source");
  return {
    name: text(source.name, 1024, "source name", true),
    size: integer(source.size, MAX_UPLOAD_BYTES, "source size"),
    lastModified: integer(source.lastModified, 8640000000000000, "source lastModified"),
    duration: durationValue(source.duration),
  };
}

function validateAnnotation(value: unknown, duration: number): Annotation {
  const item = shape(value, ANNOTATION_FIELDS, "Annotation");
  if (!Array.isArray(item.players) || item.players.length > 20) {
    throw new Error("players must be an array of at most 20 strings.");
  }
  const players: string[] = [];
  for (const player of item.players) players.push(text(player, 60, "player", true));
  const raw = item.source;
  let source: Annotation["source"];
  if (typeof raw === "object" && raw !== null && Object.getOwnPropertyDescriptor(raw, "kind")?.value === "manual") {
    shape(raw, ["kind"], "Manual source");
    source = Object.freeze({ kind: "manual" });
  } else {
    const ai = shape(raw, AI_FIELDS, "AI source");
    choice(ai.kind, ["ai"], "source kind");
    if (typeof ai.inferred !== "boolean") throw new Error("inferred must be boolean.");
    const confidence = ai.confidence === null ? null : number(ai.confidence, 0, 1, "confidence");
    const frameIndex = ai.frameIndex === null ? null : integer(ai.frameIndex, Number.MAX_SAFE_INTEGER, "frameIndex");
    if (ai.inferred && (confidence !== null || frameIndex !== null)) {
      throw new Error("Inferred evidence must have null confidence and frameIndex.");
    }
    source = Object.freeze({
      kind: "ai",
      jobId: text(ai.jobId, 256, "jobId", true),
      eventId: text(ai.eventId, 256, "eventId", true),
      confidence,
      evidence: text(ai.evidence, 2000, "evidence", true),
      timestampSeconds: number(ai.timestampSeconds, 0, duration, "timestampSeconds"),
      frameIndex,
      inferred: ai.inferred,
    });
  }
  return {
    id: text(item.id, 100, "id", true),
    ...range(item.inSeconds, item.outSeconds, duration),
    title: text(item.title, 120, "title", true),
    category: choice(item.category, CATEGORIES, "category"),
    team: choice(item.team, TEAMS, "team"),
    players,
    outcome: choice(item.outcome, OUTCOMES, "outcome"),
    notes: text(item.notes, 2000, "notes"),
    source,
  };
}

function provenance(item: Annotation): string | null {
  return item.source.kind === "ai" ? JSON.stringify([item.source.jobId, item.source.eventId]) : null;
}

function annotationList(value: unknown, duration: number): Annotation[] {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS) {
    throw new Error(`Annotations must be an array of at most ${MAX_ANNOTATIONS} entries.`);
  }
  const result: Annotation[] = [];
  for (const item of value) result.push(validateAnnotation(item, duration));
  return result;
}

function uniqueAnnotations(items: Annotation[], dedupeAI: boolean): Annotation[] {
  const ids = new Map<string, string | null>();
  const seen = new Set<string>();
  const result: Annotation[] = [];
  for (const item of items) {
    const key = provenance(item);
    if (ids.has(item.id) && !(dedupeAI && key !== null && ids.get(item.id) === key)) {
      throw new Error("Annotation has a duplicate id.");
    }
    ids.set(item.id, key);
    if (key !== null && seen.has(key)) {
      if (dedupeAI) continue;
      throw new Error("Annotation has duplicate AI provenance.");
    }
    if (key !== null) seen.add(key);
    result.push(item);
  }
  if (result.length > MAX_ANNOTATIONS) throw new Error(`Annotations must contain at most ${MAX_ANNOTATIONS} entries.`);
  return result;
}

export function validateAnnotations(value: unknown, duration: number): Annotation[] {
  return uniqueAnnotations(annotationList(value, durationValue(duration)), false);
}

export function defaultFilters(duration: number): Filters {
  return { team: "all", player: "", category: "all", source: "all", query: "", from: 0, to: durationValue(duration) };
}

export function validateFilters(value: unknown, duration: number): Filters {
  const item = shape(value, ["team", "player", "category", "source", "query", "from", "to"], "Filters");
  const { inSeconds: from, outSeconds: to } = range(item.from, item.to, durationValue(duration));
  return {
    team: choice(item.team, [...TEAMS, "all"], "filter team"),
    player: text(item.player, 60, "filter player"),
    category: choice(item.category, [...CATEGORIES, "all"], "filter category"),
    source: choice(item.source, ["all", "manual", "ai"], "filter source"),
    query: text(item.query, 2000, "filter query"),
    from,
    to,
  };
}

export function labStorageKey(source: LabSource): string {
  const valid = validateSource(source);
  return `matchlens:video-lab:v1:${JSON.stringify([valid.name, valid.size, valid.lastModified])}`;
}

export function paddedRange(second: number, duration: number): { inSeconds: number; outSeconds: number } {
  durationValue(duration);
  number(second, 0, duration, "second");
  return range(Math.max(0, second - 3), Math.min(duration, second + 5), duration);
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function filterAnnotations(annotations: Annotation[], filters: Filters): Annotation[] {
  const valid = validateFilters(filters, MAX_VIDEO_SECONDS);
  const player = normalized(valid.player);
  const query = normalized(valid.query);
  return validateAnnotations(annotations, MAX_VIDEO_SECONDS).filter((item) =>
    (valid.team === "all" || item.team === valid.team) &&
    (valid.category === "all" || item.category === valid.category) &&
    (valid.source === "all" || item.source.kind === valid.source) &&
    (!player || item.players.some((entry) => normalized(entry) === player)) &&
    (!query || [item.title, item.notes, ...item.players, item.category, item.team].some((entry) => normalized(entry).includes(query))) &&
    item.inSeconds < valid.to && item.outSeconds > valid.from);
}

export function deriveStats(filtered: Annotation[], duration: number): LabStats {
  durationValue(duration);
  const annotations = uniqueAnnotations(annotationList(filtered, duration), true);
  const stats: LabStats = {
    total: annotations.length, shots: 0, goals: 0, passes: 0, defensiveActions: 0,
    teams: { home: 0, away: 0, neutral: 0 },
    players: [],
    outcomes: { success: 0, unsuccessful: 0, unknown: 0 },
    passSuccess: { success: 0, known: 0, percent: null },
    activity: Array.from({ length: Math.max(1, Math.ceil(duration / 60)) }, (_, index) => ({
      from: index * 60, to: Math.min(duration, (index + 1) * 60), count: 0,
    })),
  };
  const players = new Map<string, { player: string; count: number }>();
  for (const item of annotations) {
    if (item.category === "shot") stats.shots++;
    if (item.category === "goal") stats.goals++;
    if (item.category === "pass") {
      stats.passes++;
      if (item.outcome !== "unknown") stats.passSuccess.known++;
      if (item.outcome === "success") stats.passSuccess.success++;
    }
    if (["tackle", "pressing", "defensive_shape"].includes(item.category)) stats.defensiveActions++;
    stats.teams[item.team]++;
    stats.outcomes[item.outcome]++;
    stats.activity[Math.floor(item.inSeconds / 60)].count++;
    const counted = new Set<string>();
    for (const player of item.players) {
      const key = normalized(player);
      if (counted.has(key)) continue;
      counted.add(key);
      const entry = players.get(key) ?? { player: player.trim(), count: 0 };
      entry.count++;
      players.set(key, entry);
    }
  }
  stats.players = [...players.values()].sort((a, b) => b.count - a.count ||
    (normalized(a.player) < normalized(b.player) ? -1 : normalized(a.player) > normalized(b.player) ? 1 : 0));
  if (stats.passSuccess.known) stats.passSuccess.percent = stats.passSuccess.success / stats.passSuccess.known * 100;
  return stats;
}

function jsonBudget(json: string): void {
  if (typeof json !== "string") throw new Error("Lab JSON must be a string.");
  if (json.length > MAX_LAB_JSON_BYTES || new TextEncoder().encode(json).byteLength > MAX_LAB_JSON_BYTES) {
    throw new Error("Lab JSON exceeds the 1 MiB (1048576 byte) budget.");
  }
}

function report(source: LabSource, filters: unknown, annotations: unknown): LabReport {
  const validSource = validateSource(source);
  const validFilters = validateFilters(filters, validSource.duration);
  const validAnnotations = validateAnnotations(annotations, validSource.duration);
  return {
    version: 1, source: validSource, filters: validFilters, annotations: validAnnotations,
    stats: deriveStats(filterAnnotations(validAnnotations, validFilters), validSource.duration),
  };
}

export function serializeLabReport(source: LabSource, filters: Filters, annotations: Annotation[]): string {
  const json = JSON.stringify(report(source, filters, annotations));
  jsonBudget(json);
  return json;
}

export function parseLabReport(json: string, expectedSource: LabSource): LabReport {
  jsonBudget(json);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Lab JSON is corrupt or invalid.");
  }
  const envelope = shape(value, ["version", "source", "filters", "annotations", "stats"], "Lab envelope");
  if (envelope.version !== 1) throw new Error("Unsupported lab report version.");
  const source = validateSource(envelope.source);
  const expected = validateSource(expectedSource);
  if (labStorageKey(source) !== labStorageKey(expected)) throw new Error("Source fingerprint mismatch.");
  if (Math.abs(source.duration - expected.duration) > 0.05 + 1e-10) throw new Error("Source duration mismatch.");
  // Claimed statistics are untrusted; the bounded JSON is never merged into the computed report.
  return report(source, envelope.filters, envelope.annotations);
}

function csvCell(value: string | number | boolean | null): string {
  let cell = value === null ? "" : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(cell) || /[\t\r\n]/u.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/gu, '""')}"`;
}

export function annotationsCsv(annotations: Annotation[]): string {
  const valid = validateAnnotations(annotations, MAX_VIDEO_SECONDS);
  const rows: (string | number | boolean | null)[][] = [[
    "id", "inSeconds", "outSeconds", "title", "category", "team", "players", "outcome", "notes",
    "source", "jobId", "eventId", "confidence", "evidence", "timestampSeconds", "frameIndex", "inferred",
  ]];
  for (const item of valid) {
    const ai = item.source.kind === "ai" ? item.source : null;
    rows.push([
      item.id, item.inSeconds, item.outSeconds, item.title, item.category, item.team,
      JSON.stringify(item.players), item.outcome, item.notes, item.source.kind,
      ai?.jobId ?? null, ai?.eventId ?? null, ai?.confidence ?? null, ai?.evidence ?? null,
      ai?.timestampSeconds ?? null, ai?.frameIndex ?? null, ai?.inferred ?? null,
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function mergeAnnotations(existing: Annotation[], incoming: Annotation[], duration: number): Annotation[] {
  durationValue(duration);
  return uniqueAnnotations([...annotationList(existing, duration), ...annotationList(incoming, duration)], true);
}

function suggestionId(jobId: string, eventId: string): string {
  const identity = JSON.stringify([jobId, eventId]);
  // Two independent 32-bit hashes keep IDs bounded without async or platform-specific crypto.
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < identity.length; index++) {
    first = Math.imul(first ^ identity.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ identity.charCodeAt(index);
  }
  return `ai-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function eventCategory(type: MatchEvent["type"]): Category | undefined {
  switch (type) {
    case "goal": case "shot": case "pass": case "tackle": case "save": case "foul": case "yellow_card": case "red_card": return type;
    case "pressure": return "pressing";
    case "corner": return "set_piece";
    default: return undefined;
  }
}

/** Video Lab categories that the match-feed builder understands as producer tags. */
const DESK_EVENT: Partial<Record<Category, DetectableEventType>> = {
  goal: "goal", shot: "shot", pass: "pass", tackle: "tackle", set_piece: "corner",
  save: "save", foul: "foul", yellow_card: "yellow_card", red_card: "red_card",
};

export function deskEventType(category: Category): DetectableEventType | undefined {
  return DESK_EVENT[category];
}

/**
 * Turns a reviewed moment into a producer tag for the live desk, or explains why it cannot be sent.
 * The tag time is the marked moment itself: presets pad 3 s before it, so it sits 3 s after the in point.
 */
export function deskTagFor(item: Annotation, clipSeconds: number): { tag: ManualTagInput } | { reason: string } {
  const type = DESK_EVENT[item.category];
  if (!type) return { reason: "This category is analysis-only; it does not become a match event." };
  if (item.team === "neutral") return { reason: "Choose Home or Away to send this moment to the desk." };
  const limit = Math.max(0, Math.floor(clipSeconds));
  const second = Math.min(limit, Math.max(0, Math.round(item.inSeconds + Math.min(3, (item.outSeconds - item.inSeconds) / 2))));
  const number = item.players.map((player) => /(?:^|#|\b)(\d{1,2})\b/u.exec(player)?.[1]).find(Boolean);
  const shirtNumber = number && Number(number) >= 1 && Number(number) <= 99 ? Number(number) : null;
  const note = item.title.replace(/[^\p{L}\p{N} ,.'!?#()&/:-]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
  return { tag: { type, team: item.team, second, shirtNumber, note } };
}

/** True when the job already carries a producer tag equivalent to this one. */
export function deskTagSent(job: Pick<VideoJob, "manualTags">, tag: ManualTagInput): boolean {
  return job.manualTags.some((existing) => existing.type === tag.type && existing.team === tag.team && existing.second === tag.second);
}

export function suggestionAnnotations(job: VideoJob, duration: number): Annotation[] {
  durationValue(duration);
  const jobId = text(job.id, 256, "jobId", true);
  const latest = new Map<string, MatchEvent>();
  for (const event of job.events) {
    text(event.id, 256, "eventId", true);
    integer(event.revision, Number.MAX_SAFE_INTEGER, "revision");
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  const evidence = new Map(job.evidence.map((entry) => [entry.eventId, entry]));
  const manualIds = new Set(job.evidence.filter((entry) => entry.source === "manual").map((entry) => entry.eventId));
  const annotations: Annotation[] = [];
  for (const event of latest.values()) {
    const category = eventCategory(event.type);
    if (event.rescinded || !category || manualIds.has(event.id)) continue;
    const proof = evidence.get(event.id);
    if (proof && proof.source !== "vision") continue;
    if (!proof && event.type !== "shot") continue;
    const inferred = !proof;
    if (inferred) {
      // Manual goals can also cause builder-only shots. Do not rebrand these as AI observations.
      const manualGoal = [...latest.values()].some((candidate) =>
        !candidate.rescinded && candidate.type === "goal" && candidate.teamId === event.teamId &&
        manualIds.has(candidate.id) && candidate.minute * 60 + candidate.second >= event.minute * 60 + event.second &&
        candidate.minute * 60 + candidate.second - (event.minute * 60 + event.second) <= 6);
      if (manualGoal) continue;
      integer(event.minute, Math.floor(MAX_VIDEO_SECONDS / 60), "event minute");
      number(event.second, 0, 59.999999999, "event second");
    }
    const timestampSeconds = proof ? proof.timestampSeconds : event.minute * 60 + event.second;
    // The builder rounds short clips up to two seconds and can place an inferred shot beyond the media.
    if (inferred && timestampSeconds > duration) continue;
    number(timestampSeconds, 0, duration, "timestampSeconds");
    let outcome: Outcome = "unknown";
    if (!inferred) {
      if (event.type === "goal" && event.outcome === "success") outcome = "success";
      else if (event.outcome === "incomplete" || event.outcome === "blocked") outcome = "unsuccessful";
      // Shot success/saved can be rewritten by later goals/saves (including manual tags).
      // Complete passes, missed shots and successful tackles can also be builder defaults.
    }
    const caveat = event.type === "pass"
      ? ` Builder pass outcome "${event.outcome}"; completion may be a rule default, not an observed result. Unknown completion remains unknown.`
      : ` Builder outcome "${event.outcome}"; unverified or defaulted outcomes remain unknown.`;
    const evidenceText = proof
      ? `${text(proof.description, 2000, "evidence description").slice(0, 1600) || "Vision frame evidence."}${caveat}`
      : "Rule-inferred shot (not a detection). Added by the video builder; no visual frame evidence or measured confidence. Outcome unknown.";
    annotations.push({
      id: suggestionId(jobId, event.id),
      ...paddedRange(timestampSeconds, duration),
      title: inferred ? "Rule-inferred shot (not a detection)" : `${event.type.replace(/_/gu, " ")} — review suggestion`,
      category,
      team: TEAMS.includes(event.teamId) ? event.teamId : "neutral",
      players: event.playerId && !event.playerId.endsWith("-unidentified") ? [text(event.playerId, 60, "player", true)] : [],
      outcome,
      notes: "",
      source: {
        kind: "ai", jobId, eventId: event.id, confidence: proof ? proof.confidence : null,
        evidence: evidenceText, timestampSeconds, frameIndex: proof ? proof.frameIndex : null, inferred,
      },
    });
    if (annotations.length === MAX_ANNOTATIONS) break;
  }
  return validateAnnotations(annotations, duration);
}
