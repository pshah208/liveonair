import assert from "node:assert/strict";
import test from "node:test";

import { buildVideoFixture } from "../server/video/events.js";
import type { MatchEvent } from "../shared/types.js";
import { MAX_UPLOAD_BYTES, type VideoEventEvidence, type VideoJob } from "../shared/video.js";
import {
  CATEGORIES,
  MAX_ANNOTATIONS,
  MAX_LAB_JSON_BYTES,
  annotationsCsv,
  defaultFilters,
  deriveStats,
  deskTagFor,
  deskTagSent,
  filterAnnotations,
  labStorageKey,
  mergeAnnotations,
  paddedRange,
  parseLabReport as parseLab,
  serializeLabReport as serializeLab,
  suggestionAnnotations,
  validateAnnotations,
  validateFilters,
  validateSource,
  type Annotation,
  type LabSource,
} from "../shared/videoLab.js";

const duration = 125;
const source: LabSource = { name: "Match ⚽.mp4", size: 1024, lastModified: 123456, duration };

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "manual-1", inSeconds: 10, outSeconds: 18, title: "Passing sequence",
    category: "pass", team: "home", players: ["Player 7"], outcome: "unknown",
    notes: "", source: { kind: "manual" }, ...overrides,
  };
}

function ai(overrides: Partial<Annotation> = {}): Annotation {
  return annotation({
    id: "ai-1",
    source: {
      kind: "ai", jobId: "job-1", eventId: "event-1", confidence: 0.83,
      evidence: "Blue player passes the ball.", timestampSeconds: 13.25,
      frameIndex: 4, inferred: false,
    },
    ...overrides,
  });
}

function withProof(patch: Record<string, unknown>): Annotation {
  return { ...ai(), source: { ...ai().source, ...patch } } as Annotation;
}

function envelope(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1, source, filters: defaultFilters(duration), annotations: [],
    stats: deriveStats([], duration), ...patch,
  });
}

function invalidAnnotations(value: unknown): void {
  assert.throws(() => validateAnnotations(value, duration));
  assert.throws(() => serializeLab(source, defaultFilters(duration), value as Annotation[]));
  let nonfinite = false;
  JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isFinite(entry)) nonfinite = true;
    return entry;
  });
  // JSON converts nonfinite numbers to null, which is valid for some provenance fields.
  if (!nonfinite) assert.throws(() => parseLab(envelope({ annotations: value }), source));
}

function event(overrides: Partial<MatchEvent> = {}): MatchEvent {
  return {
    id: "event-1", revision: 1, minute: 0, second: 13, type: "pass",
    teamId: "home", playerId: "home-7", outcome: "complete", x: 40, y: 50,
    ...overrides,
  };
}

function evidence(overrides: Partial<VideoEventEvidence> = {}): VideoEventEvidence {
  return {
    eventId: "event-1", frameIndex: 4, timestampSeconds: 13.25, confidence: 0.83,
    description: "Blue player passes the ball.", source: "vision", ...overrides,
  };
}

function job(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: "job-1", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z", stage: "ready", progress: 100,
    fileName: source.name, sizeBytes: source.size, durationSeconds: duration,
    request: {
      home: { name: "Blue Town", kit: "blue shirts" },
      away: { name: "Red City", kit: "red shirts" },
    },
    frames: [{ index: 4, timestampSeconds: 13.25 }], batchesTotal: 1, batchesDone: 1,
    usage: { inputTokens: 0, outputTokens: 0 }, detectionsRaw: 1, detectionsAccepted: 1,
    evidence: [evidence()], events: [event()], manualTags: [], log: [], ...overrides,
  };
}

function ids(items: Annotation[]): string[] {
  return items.map((item) => item.id);
}

function proof(item: Annotation): Extract<Annotation["source"], { kind: "ai" }> {
  assert.equal(item.source.kind, "ai");
  if (item.source.kind !== "ai") throw new Error("Expected AI provenance");
  return item.source;
}

function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && char === "\r" && csv[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index++;
    } else {
      if (!quoted) assert.notEqual(char, "\n", "CSV records must use CRLF");
      cell += char;
    }
  }
  assert.equal(quoted, false, "CSV must close quoted fields");
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

test("video lab exposes exact categories, limits and independent default filters", () => {
  assert.deepEqual(CATEGORIES, ["goal", "shot", "pass", "tackle", "pressing", "set_piece", "defensive_shape", "custom", "save", "foul", "yellow_card", "red_card"]);
  assert.equal(MAX_ANNOTATIONS, 200);
  assert.equal(MAX_LAB_JSON_BYTES, 1048576);
  const filters = defaultFilters(duration);
  assert.deepEqual(filters, {
    team: "all", player: "", category: "all", source: "all", query: "", from: 0, to: duration,
  });
  filters.player = "changed";
  assert.equal(defaultFilters(duration).player, "");
});

test("source keys are versioned, fingerprint-specific and independent of duration/property order", () => {
  const key = labStorageKey(source);
  assert.ok(key.startsWith("matchlens:video-lab:v1"));
  assert.equal(key, labStorageKey({ duration: 120, lastModified: source.lastModified, size: source.size, name: source.name }));
  const variants = [
    source, { ...source, name: `${source.name} ` }, { ...source, size: source.size + 1 },
    { ...source, lastModified: source.lastModified + 1 },
    { ...source, name: "a:1", size: 2, lastModified: 3 },
    { ...source, name: "a", size: 1, lastModified: 23 },
    { ...source, name: "a", size: 12, lastModified: 3 },
    { ...source, name: '["a",12,3]' },
  ];
  assert.equal(new Set(variants.map(labStorageKey)).size, variants.length);
});

test("source validation rejects unknown/missing fields, wrong types and numeric bounds", () => {
  const invalid: unknown[] = [null, [], "", 1, {}, { ...source, extra: true }];
  for (const key of Object.keys(source)) {
    const value: Record<string, unknown> = { ...source };
    delete value[key];
    invalid.push(value);
  }
  for (const name of ["", " \t", "x".repeat(1025), 1, null]) invalid.push({ ...source, name });
  for (const size of [-1, 0.5, MAX_UPLOAD_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
    invalid.push({ ...source, size });
  }
  for (const lastModified of [-1, 0.5, 8640000000000001, NaN, Infinity, "1", null]) {
    invalid.push({ ...source, lastModified });
  }
  for (const length of [0, -1, 900.01, NaN, Infinity, "125", null]) invalid.push({ ...source, duration: length });
  for (const value of invalid) assert.throws(() => labStorageKey(value as LabSource), JSON.stringify(value));
  assert.doesNotThrow(() => labStorageKey({ name: "x".repeat(1024), size: MAX_UPLOAD_BYTES, lastModified: 8640000000000000, duration: 900 }));
  assert.doesNotThrow(() => labStorageKey({ name: "a", size: 0, lastModified: 0, duration: 0.1 }));
});

test("padded ranges use three seconds before and five after, clamping zero and exact end", () => {
  for (const [second, length, start, end] of [
    [10, 125, 7, 15], [13.25, 125, 10.25, 18.25], [0, 125, 0, 5],
    [125, 125, 122, 125], [124, 125, 121, 125], [0, 0.1, 0, 0.1],
    [0.1, 0.1, 0, 0.1],
  ]) {
    assert.deepEqual(paddedRange(second, length), { inSeconds: start, outSeconds: end });
  }
  for (const second of [-1, duration + 0.1, NaN, Infinity, -Infinity, "1", null]) {
    assert.throws(() => paddedRange(second as number, duration));
  }
});

test("all duration-sensitive entry points reject invalid durations even for empty input", () => {
  for (const length of [0, -1, 901, NaN, Infinity, -Infinity, "125", null]) {
    const value = length as number;
    assert.throws(() => defaultFilters(value));
    assert.throws(() => paddedRange(0, value));
    assert.throws(() => validateAnnotations([], value));
    assert.throws(() => validateFilters(defaultFilters(duration), value));
    assert.throws(() => deriveStats([], value));
    assert.throws(() => mergeAnnotations([], [], value));
  }
});

test("annotation validation accepts all enums, fractional ranges and exact inclusive limits", () => {
  const items = CATEGORIES.map((category, index) => annotation({
    id: `category-${index}`, category, inSeconds: 0, outSeconds: duration,
    team: (["home", "away", "neutral"] as const)[index % 3],
    outcome: (["success", "unsuccessful", "unknown"] as const)[index % 3],
  }));
  assert.deepEqual(validateAnnotations(items, duration), items);
  const maximum = annotation({
    id: "i".repeat(100), title: "t".repeat(120), notes: "n".repeat(2000),
    players: Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(60, "p")),
    inSeconds: 0.25, outSeconds: duration,
  });
  assert.deepEqual(validateAnnotations([maximum], duration), [maximum]);
  assert.doesNotThrow(() => validateAnnotations([annotation({ notes: "", players: [] })], duration));
});

test("annotation shapes are exact and sparse arrays cannot bypass validation", () => {
  for (const value of [null, {}, "annotations", 1, new Array(1)]) invalidAnnotations(value);
  for (const value of [null, [], "", 1, {}, { ...annotation(), extra: true }]) invalidAnnotations([value]);
  for (const key of Object.keys(annotation())) {
    const value: Record<string, unknown> = { ...annotation() };
    delete value[key];
    invalidAnnotations([value]);
  }
  invalidAnnotations([annotation({ players: new Array<string>(1) })]);
});

test("annotation strings, players, enums and ranges reject coercion and overflow", () => {
  for (const [field, limit] of Object.entries({ id: 100, title: 120, notes: 2000 })) {
    for (const value of [null, 1, [], {}, "x".repeat(limit + 1)]) invalidAnnotations([{ ...annotation(), [field]: value }]);
  }
  for (const field of ["id", "title"]) {
    for (const value of ["", " \t\n"]) invalidAnnotations([{ ...annotation(), [field]: value }]);
  }
  for (const players of [null, {}, "Player 7", [null], [1], [""], [" \t"], ["p".repeat(61)], Array(21).fill("p")]) {
    invalidAnnotations([{ ...annotation(), players }]);
  }
  for (const [field, values] of Object.entries({
    category: ["corner", "PASS", "", null, 1],
    team: ["all", "unknown", "HOME", null, 1],
    outcome: ["complete", "none", "", null, 1],
  })) {
    for (const value of values) invalidAnnotations([{ ...annotation(), [field]: value }]);
  }
  for (const patch of [
    { inSeconds: -0.1 }, { inSeconds: 18 }, { inSeconds: 19 }, { outSeconds: 0 },
    { outSeconds: duration + 0.01 }, { inSeconds: "0" }, { outSeconds: null },
    { inSeconds: NaN }, { outSeconds: Infinity }, { inSeconds: -Infinity },
  ]) invalidAnnotations([{ ...annotation(), ...patch }]);
});

test("manual and AI provenance are exact discriminated shapes", () => {
  for (const value of [null, [], {}, { kind: "vision" }, { kind: "manual", jobId: "job" }, { ...ai().source, extra: true }]) {
    invalidAnnotations([{ ...annotation(), source: value }]);
  }
  for (const key of Object.keys(ai().source)) {
    const value: Record<string, unknown> = { ...ai().source };
    delete value[key];
    invalidAnnotations([{ ...ai(), source: value }]);
  }
  for (const field of ["jobId", "eventId"]) {
    for (const value of ["", " \n", "x".repeat(257), 1, null]) invalidAnnotations([withProof({ [field]: value })]);
  }
  for (const value of [-0.01, 1.01, NaN, Infinity, "0.5"]) invalidAnnotations([withProof({ confidence: value })]);
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "0"]) invalidAnnotations([withProof({ frameIndex: value })]);
  for (const value of [-0.1, duration + 0.1, NaN, Infinity, "0", null]) invalidAnnotations([withProof({ timestampSeconds: value })]);
  for (const value of ["x".repeat(2001), null, 1]) invalidAnnotations([withProof({ evidence: value })]);
  for (const value of ["false", 0, null]) invalidAnnotations([withProof({ inferred: value })]);
  invalidAnnotations([withProof({ inferred: true, confidence: 0.5, frameIndex: null })]);
  invalidAnnotations([withProof({ inferred: true, confidence: null, frameIndex: 0 })]);
  assert.doesNotThrow(() => validateAnnotations([withProof({
    jobId: "j".repeat(256), eventId: "e".repeat(256), evidence: "e".repeat(2000),
    confidence: 0, frameIndex: Number.MAX_SAFE_INTEGER, timestampSeconds: 0,
  })], duration));
  assert.doesNotThrow(() => validateAnnotations([withProof({ confidence: 1, frameIndex: 0, timestampSeconds: duration })], duration));
  assert.doesNotThrow(() => validateAnnotations([withProof({ confidence: null, frameIndex: null, inferred: true })], duration));
});

test("strict validation rejects duplicate annotation IDs and AI job/event pairs", () => {
  const items = Array.from({ length: MAX_ANNOTATIONS }, (_, index) => annotation({ id: `manual-${index}` }));
  assert.equal(validateAnnotations(items, duration).length, 200);
  invalidAnnotations([...items, annotation({ id: "overflow" })]);
  invalidAnnotations([annotation(), annotation({ title: "An edit" })]);
  invalidAnnotations([annotation({ id: "__proto__" }), annotation({ id: "__proto__" })]);
  invalidAnnotations([annotation({ id: ai().id }), ai()]);
  invalidAnnotations([ai(), ai({ id: "different-id", title: "Same provenance" })]);
  assert.equal(validateAnnotations([
    withProof({ jobId: "a:b", eventId: "c" }),
    { ...withProof({ jobId: "a", eventId: "b:c" }), id: "different" },
  ], duration).length, 2, "provenance keys must not have delimiter collisions");
});

test("filters enforce exact shape, enum values, string limits and half-open intervals", () => {
  const defaults = defaultFilters(duration);
  const invalid: unknown[] = [null, [], {}, 1, { ...defaults, extra: true }];
  for (const key of Object.keys(defaults)) {
    const value: Record<string, unknown> = { ...defaults };
    delete value[key];
    invalid.push(value);
  }
  for (const patch of [
    { team: "unknown" }, { category: "corner" }, { source: "vision" },
    { player: "p".repeat(61) }, { query: "q".repeat(2001) }, { player: null }, { query: 1 },
    { from: -1 }, { to: duration + 0.1 }, { from: 10, to: 10 }, { from: 11, to: 10 },
    { from: NaN }, { to: Infinity }, { from: "0" }, { to: null },
  ]) invalid.push({ ...defaults, ...patch });
  for (const value of invalid) {
    assert.throws(() => validateFilters(value, duration));
    // Filtering has no duration argument; source-duration bounds belong to validateFilters.
    if (!(typeof value === "object" && value !== null && "to" in value && value.to === duration + 0.1)) {
      assert.throws(() => filterAnnotations([], value as typeof defaults));
    }
  }
  assert.deepEqual(validateFilters({ ...defaults, player: "p".repeat(60), query: "q".repeat(2000) }, duration),
    { ...defaults, player: "p".repeat(60), query: "q".repeat(2000) });
});

test("filter predicates combine with AND and exact trimmed case-insensitive player matching", () => {
  const target = ai({
    id: "target", inSeconds: 20, outSeconds: 30, category: "shot", team: "away",
    players: [" Player Seven "], title: "Breakaway chance", notes: "Far POST",
  });
  const items = [
    target, { ...target, id: "wrong-team", team: "home" as const },
    { ...target, id: "wrong-player", players: ["Player Seventeen"] },
    { ...target, id: "wrong-category", category: "goal" as const },
    { ...target, id: "wrong-source", source: { kind: "manual" as const } },
    { ...target, id: "wrong-query", notes: "" },
    { ...target, id: "wrong-time", inSeconds: 40, outSeconds: 50 },
  ].map((item) => item.source.kind === "ai"
    ? { ...item, source: { ...item.source, eventId: item.id } }
    : item);
  const filters = {
    ...defaultFilters(duration), team: "away" as const, category: "shot" as const,
    source: "ai" as const, player: " player SEVEN ", query: "far post", from: 22, to: 29,
  };
  const before = structuredClone(items);
  assert.deepEqual(ids(filterAnnotations(items, filters)), ["target"]);
  assert.deepEqual(items, before);
  assert.deepEqual(filterAnnotations([target], { ...defaultFilters(duration), player: "Seven" }), []);
  assert.equal(filterAnnotations([annotation()], { ...defaultFilters(duration), source: "manual" }).length, 1);
});

test("free-text search covers title, notes, players, category and team without case sensitivity", () => {
  const item = annotation({ title: "Fast Counter", notes: "Far POST", players: ["Player Seven"], category: "defensive_shape", team: "neutral" });
  for (const query of ["COUNTER", "post", "seven", "DEFENSIVE_SHAPE", "NEUTRAL"]) {
    assert.deepEqual(filterAnnotations([item], { ...defaultFilters(duration), query }), [item]);
  }
  assert.deepEqual(filterAnnotations([item], { ...defaultFilters(duration), query: "missing" }), []);
});

test("time filtering is overlap rather than containment, with half-open boundaries", () => {
  const items = [
    annotation({ id: "ends-at-from", inSeconds: 0, outSeconds: 20 }),
    annotation({ id: "left-overlap", inSeconds: 19, outSeconds: 21 }),
    annotation({ id: "contained", inSeconds: 21, outSeconds: 29 }),
    annotation({ id: "contains", inSeconds: 0, outSeconds: 40 }),
    annotation({ id: "exact", inSeconds: 20, outSeconds: 30 }),
    annotation({ id: "right-overlap", inSeconds: 29, outSeconds: 31 }),
    annotation({ id: "starts-at-to", inSeconds: 30, outSeconds: 40 }),
  ];
  assert.deepEqual(ids(filterAnnotations(items, { ...defaultFilters(duration), from: 20, to: 30 })),
    ["left-overlap", "contained", "contains", "exact", "right-overlap"]);
  assert.equal(filterAnnotations([annotation({ inSeconds: 0, outSeconds: duration })], defaultFilters(duration)).length, 1);
});

test("stats have an exact schema, distinguish goals from shots and count every defensive category", () => {
  const items = [
    annotation({ id: "goal", category: "goal", outcome: "success", inSeconds: 0, outSeconds: 1, players: [] }),
    annotation({ id: "shot", category: "shot", outcome: "unsuccessful", team: "away", inSeconds: 59, outSeconds: 62, players: [] }),
    annotation({ id: "pass-success", outcome: "success", inSeconds: 60, outSeconds: 61, players: [] }),
    annotation({ id: "pass-failure", outcome: "unsuccessful", team: "away", inSeconds: 61, outSeconds: 62, players: [] }),
    annotation({ id: "pass-unknown", team: "neutral", inSeconds: 119, outSeconds: 121, players: [] }),
    annotation({ id: "tackle", category: "tackle", inSeconds: 120, outSeconds: 121, players: [] }),
    annotation({ id: "press", category: "pressing", team: "away", inSeconds: 121, outSeconds: 122, players: [] }),
    annotation({ id: "shape", category: "defensive_shape", team: "neutral", inSeconds: 124, outSeconds: 125, players: [] }),
  ];
  assert.deepEqual(deriveStats(items, duration), {
    total: 8, shots: 1, goals: 1, passes: 3, defensiveActions: 3,
    teams: { home: 3, away: 3, neutral: 2 }, players: [],
    outcomes: { success: 2, unsuccessful: 2, unknown: 4 },
    passSuccess: { success: 1, known: 2, percent: 50 },
    activity: [{ from: 0, to: 60, count: 2 }, { from: 60, to: 120, count: 3 }, { from: 120, to: 125, count: 3 }],
  });
  assert.equal(deriveStats([annotation({ category: "goal" })], duration).shots, 0);
  assert.equal(deriveStats([annotation({ category: "set_piece" }), annotation({ id: "custom", category: "custom" })], duration).defensiveActions, 0);
});

test("pass percentages exclude unknown outcomes and remain null, zero or 100 at extremes", () => {
  assert.deepEqual(deriveStats([], duration).passSuccess, { success: 0, known: 0, percent: null });
  assert.deepEqual(deriveStats([annotation()], duration).passSuccess, { success: 0, known: 0, percent: null });
  for (const [outcome, success, percent] of [["success", 1, 100], ["unsuccessful", 0, 0]] as const) {
    assert.deepEqual(deriveStats([annotation({ outcome }), annotation({ id: "unknown" })], duration).passSuccess,
      { success, known: 1, percent });
  }
});

test("activity contains empty 60-second buckets, caps at 15 and counts starts only", () => {
  assert.deepEqual(deriveStats([], duration).activity,
    [{ from: 0, to: 60, count: 0 }, { from: 60, to: 120, count: 0 }, { from: 120, to: 125, count: 0 }]);
  assert.deepEqual(deriveStats([annotation({ inSeconds: 0, outSeconds: 125 })], duration).activity.map((bucket) => bucket.count), [1, 0, 0]);
  assert.deepEqual(deriveStats([], 0.1).activity, [{ from: 0, to: 0.1, count: 0 }]);
  assert.equal(deriveStats([], 120).activity.length, 2);
  const activity = deriveStats([annotation({ inSeconds: 899, outSeconds: 900 })], 900).activity;
  assert.equal(activity.length, 15);
  assert.deepEqual(activity.at(-1), { from: 840, to: 900, count: 1 });
});

test("player counts normalize case and whitespace and count each player once per annotation", () => {
  const stats = deriveStats([
    annotation({ players: [" Player Seven ", "player seven", "PLAYER SEVEN", "Player Nine"] }),
    annotation({ id: "second", players: ["PLAYER SEVEN", " Player Nine "] }),
  ], duration);
  assert.equal(stats.players.length, 2);
  assert.deepEqual(Object.fromEntries(stats.players.map(({ player, count }) => [player.trim().toLowerCase(), count])),
    { "player seven": 2, "player nine": 2 });
  assert.ok(stats.players.every(({ player }) => player === player.trim()));
});

test("stats defensively deduplicate AI provenance without collapsing separate jobs", () => {
  const first = ai({ category: "goal", outcome: "success" });
  const duplicate = ai({ id: "duplicate", category: "shot", outcome: "unsuccessful" });
  const otherJob = { ...withProof({ jobId: "job-2" }), id: "other-job" };
  assert.deepEqual(deriveStats([first, duplicate, otherJob], duration), deriveStats([first, otherJob], duration));
});

test("JSON serialization roundtrips exact envelope fields and derives stats from filtered annotations", () => {
  const items = [annotation({ title: '  Counter "⚽"  ', notes: "Line 1\nLine 2" }), ai({ team: "away" })];
  const filters = { ...defaultFilters(duration), team: "away" as const };
  const before = structuredClone({ source, filters, items });
  const json = serializeLab(source, filters, items);
  const value = JSON.parse(json);
  assert.deepEqual(Object.keys(value).sort(), ["annotations", "filters", "source", "stats", "version"]);
  assert.deepEqual(value, {
    version: 1, source, filters, annotations: items, stats: deriveStats([items[1]], duration),
  });
  assert.deepEqual(parseLab(json, source), value);
  assert.deepEqual({ source, filters, items }, before);
});

test("JSON parser rejects corrupt storage, bad versions and unknown or missing envelope keys", () => {
  for (const json of ["", "{", "undefined", '{"version":1,"annotations":[}', "null", "[]", "1", '"text"']) {
    assert.throws(() => parseLab(json, source));
  }
  const valid = JSON.parse(envelope()) as Record<string, unknown>;
  for (const key of Object.keys(valid)) {
    const value = { ...valid };
    delete value[key];
    assert.throws(() => parseLab(JSON.stringify(value), source), `missing ${key}`);
  }
  for (const version of [0, 2, "1", null]) assert.throws(() => parseLab(envelope({ version }), source));
  assert.throws(() => parseLab(envelope({ extra: true }), source));
  assert.throws(() => parseLab(envelope({ filters: { ...defaultFilters(duration), extra: true } }), source));
});

test("claimed JSON stats are never trusted or spread into the recomputed result", () => {
  const items = [annotation({ outcome: "success" }), ai({ team: "away" })];
  const filters = { ...defaultFilters(duration), team: "home" as const };
  const expected = deriveStats([items[0]], duration);
  for (const stats of [null, 123, "fake", [], { total: 999, passSuccess: { percent: 999 } }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const parsed = parseLab(envelope({ annotations: items, filters, stats }), source);
    assert.deepEqual(parsed.stats, expected);
    assert.deepEqual(parsed.annotations, items);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
});

test("JSON source matching is exact except for at most 0.05 seconds of duration drift", () => {
  for (const patch of [{ name: "other.mp4" }, { name: source.name.toUpperCase() }, { size: source.size + 1 }, { lastModified: source.lastModified + 1 }]) {
    assert.throws(() => parseLab(envelope(), { ...source, ...patch }));
  }
  for (const delta of [-0.05, -0.01, 0, 0.01, 0.05]) {
    assert.doesNotThrow(() => parseLab(envelope(), { ...source, duration: duration + delta }));
  }
  for (const delta of [-0.051, 0.051]) {
    assert.throws(() => parseLab(envelope(), { ...source, duration: duration + delta }));
  }
  assert.throws(() => parseLab(envelope({ source: { ...source, extra: true } }), source));
});

test("JSON budget is exactly 1 MiB of UTF-8 including otherwise harmless whitespace", () => {
  const json = envelope({ annotations: [annotation({ notes: "漢⚽" })] });
  const atLimit = json + " ".repeat(MAX_LAB_JSON_BYTES - Buffer.byteLength(json, "utf8"));
  assert.equal(Buffer.byteLength(atLimit, "utf8"), MAX_LAB_JSON_BYTES);
  assert.doesNotThrow(() => parseLab(atLimit, source));
  assert.throws(() => parseLab(atLimit + " ", source), /byte|limit|MiB|MB|large|exceed/i);
  assert.throws(() => parseLab(" ".repeat(MAX_LAB_JSON_BYTES) + "{", source), /byte|limit|MiB|MB|large|exceed/i);
});

test("both serialization and parsing reject multibyte payloads below the UTF-16 length budget", () => {
  const items = Array.from({ length: 180 }, (_, index) => annotation({ id: `wide-${index}`, notes: "漢".repeat(2000) }));
  const json = envelope({ annotations: items });
  assert.ok(json.length < MAX_LAB_JSON_BYTES);
  assert.ok(Buffer.byteLength(json, "utf8") > MAX_LAB_JSON_BYTES);
  assert.throws(() => parseLab(json, source), /byte|limit|MiB|MB|large|exceed/i);
  assert.throws(() => serializeLab(source, defaultFilters(duration), items), /byte|limit|MiB|MB|large|exceed/i);
});

test("CSV quotes and escapes text, uses CRLF and carries full AI provenance", () => {
  const item = ai({ title: 'Counter, "far post"', notes: 'Line one\r\nLine "two"' });
  const csv = annotationsCsv([item]);
  assert.ok(csv.includes('"Counter, ""far post"""'));
  assert.ok(csv.includes('"\'Line one\r\nLine ""two"""'));
  const [headers, values] = csvRows(csv);
  assert.equal(values.length, headers.length);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  for (const key of ["jobId", "eventId", "confidence", "evidence", "timestampSeconds", "frameIndex", "inferred"]) {
    assert.ok(headers.includes(key), `missing AI CSV column ${key}`);
  }
  assert.equal(row.jobId, "job-1");
  assert.equal(row.eventId, "event-1");
  assert.equal(row.confidence, "0.83");
  assert.equal(row.timestampSeconds, "13.25");
  assert.equal(row.frameIndex, "4");
  assert.equal(row.inferred, "false");
  assert.equal(row.evidence, proof(item).evidence);
  assert.ok(headers.some((header, index) => /source|kind/i.test(header) && values[index] === "ai"));
});

test("CSV neutralizes formulas even after whitespace and protects every free-text field", () => {
  for (const dangerous of ["=1+1", "+SUM(1,2)", "-1+2", "@SUM(A1)", "  =1+1", " \t+1", "\ttext", "\rtext", "\ntext"]) {
    const item = ai({
      id: dangerous, title: dangerous, notes: dangerous, players: [dangerous],
      source: { ...proof(ai()), jobId: dangerous, eventId: dangerous, evidence: dangerous },
    });
    const [headers, values] = csvRows(annotationsCsv([item]));
    for (const key of ["id", "title", "notes", "jobId", "eventId", "evidence"]) {
      const index = headers.indexOf(key);
      assert.ok(index >= 0, `missing CSV column ${key}`);
      assert.equal(values[index], `'${dangerous}`, `${key}: ${JSON.stringify(dangerous)}`);
    }
    const playerIndex = headers.findIndex((header) => /players/i.test(header));
    assert.ok(playerIndex >= 0, "missing players column");
    assert.deepEqual(JSON.parse(values[playerIndex]), [dangerous]);
    assert.equal(values[playerIndex][0], "[", "JSON-encoded player lists cannot begin a spreadsheet formula");
  }
});

test("CSV manual and inferred rows leave absent provenance numeric fields empty", () => {
  const inferred = withProof({ inferred: true, confidence: null, frameIndex: null });
  const [headers, manual, inferredRow] = csvRows(annotationsCsv([annotation(), inferred]));
  for (const key of ["jobId", "eventId", "confidence", "evidence", "timestampSeconds", "frameIndex", "inferred"]) {
    assert.equal(manual[headers.indexOf(key)], "", `manual ${key}`);
  }
  assert.equal(inferredRow[headers.indexOf("confidence")], "");
  assert.equal(inferredRow[headers.indexOf("frameIndex")], "");
  assert.equal(inferredRow[headers.indexOf("inferred")], "true");
  assert.equal(csvRows(annotationsCsv([])).length, 1, "empty CSV still includes a header");
});

test("merge uses AI provenance first, preserving first edits and input order without mutation", () => {
  const edited = ai({ title: "Coach's edit", notes: "Keep this", players: ["Player Nine"], inSeconds: 2, outSeconds: 9 });
  const incoming = [ai(), ai({ id: "renamed-duplicate" }), annotation({ id: "new-manual" })];
  const before = structuredClone({ edited, incoming });
  assert.deepEqual(mergeAnnotations([edited], incoming, duration), [edited, incoming[2]]);
  assert.deepEqual(mergeAnnotations([], incoming, duration), [incoming[0], incoming[2]]);
  assert.deepEqual({ edited, incoming }, before);
  const otherJob = { ...withProof({ jobId: "job-2" }), id: "other-job" };
  assert.equal(mergeAnnotations([edited], [otherJob], duration).length, 2);
});

test("merge always rejects manual ID collisions and validates duplicates before discarding them", () => {
  assert.throws(() => mergeAnnotations([annotation()], [annotation()], duration));
  assert.throws(() => mergeAnnotations([], [annotation(), annotation()], duration));
  assert.throws(() => mergeAnnotations([ai()], [annotation({ id: ai().id })], duration));
  assert.throws(() => mergeAnnotations([annotation({ id: ai().id })], [ai()], duration));
  assert.throws(() => mergeAnnotations([ai()], [ai({ outSeconds: duration + 1 })], duration));
  assert.throws(() => mergeAnnotations([annotation({ title: "" })], [], duration));
  const existing = Array.from({ length: 199 }, (_, index) => annotation({ id: `manual-${index}` }));
  existing.push(ai());
  assert.equal(mergeAnnotations(existing, [ai()], duration).length, 200);
  assert.throws(() => mergeAnnotations(existing, [annotation({ id: "overflow" })], duration));
});

test("suggestions use actual evidence timestamps/frames rather than rounded match clocks", () => {
  const input = job({ events: [event({ second: 99 })] });
  const before = structuredClone(input);
  const result = suggestionAnnotations(input, duration);
  assert.equal(result.length, 1);
  const item = result[0];
  assert.deepEqual({ inSeconds: item.inSeconds, outSeconds: item.outSeconds }, { inSeconds: 10.25, outSeconds: 18.25 });
  assert.equal(item.category, "pass");
  assert.equal(item.team, "home");
  assert.deepEqual(proof(item), {
    kind: "ai", jobId: input.id, eventId: input.events[0].id, confidence: 0.83,
    evidence: proof(item).evidence, timestampSeconds: 13.25, frameIndex: 4, inferred: false,
  });
  assert.ok(proof(item).evidence.includes(input.evidence[0].description));
  assert.equal(item.outcome, "unknown", "builder-normalized complete is not evidence of completion");
  assert.match(proof(item).evidence, /builder|normalis|normaliz/i);
  assert.match(proof(item).evidence, /uncertain|unknown|not.*confirm|not.*verif/i);
  assert.deepEqual(input, before);
  assert.doesNotThrow(() => validateAnnotations(result, duration));
});

test("suggestion mappings keep saves, fouls and cards distinct and exclude lifecycle events", () => {
  const mappings = [
    ["goal", "goal"], ["shot", "shot"], ["pass", "pass"], ["tackle", "tackle"],
    ["pressure", "pressing"], ["corner", "set_piece"], ["save", "save"],
    ["foul", "foul"], ["yellow_card", "yellow_card"], ["red_card", "red_card"],
  ] as const;
  for (const [type, category] of mappings) {
    const result = suggestionAnnotations(job({ events: [event({ type })] }), duration);
    assert.equal(result.length, 1, type);
    assert.equal(result[0].category, category, type);
  }
  for (const type of ["kickoff", "halftime", "fulltime", "substitution"] as const) {
    assert.deepEqual(suggestionAnnotations(job({ events: [event({ type })] }), duration), [], type);
  }
});

test("suggested ranges retain evidence at zero and the exact clip end", () => {
  for (const timestampSeconds of [0, duration]) {
    const result = suggestionAnnotations(job({ evidence: [evidence({ timestampSeconds, frameIndex: 0 })] }), duration);
    assert.equal(result.length, 1);
    assert.equal(proof(result[0]).timestampSeconds, timestampSeconds);
    assert.equal(proof(result[0]).frameIndex, 0);
    assert.deepEqual(
      { inSeconds: result[0].inSeconds, outSeconds: result[0].outSeconds },
      paddedRange(timestampSeconds, duration),
    );
    assert.doesNotThrow(() => validateAnnotations(result, duration));
  }
});

test("suggestions select highest revision independent of array order, honoring rescinded corrections", () => {
  const old = event({ revision: 1, type: "shot" });
  const current = event({ revision: 3, type: "goal", teamId: "away" });
  const middle = event({ revision: 2, type: "corner" });
  for (const events of [[current, old, middle], [old, middle, current]]) {
    const result = suggestionAnnotations(job({ events }), duration);
    assert.equal(result.length, 1);
    assert.equal(result[0].category, "goal");
    assert.equal(result[0].team, "away");
  }
  for (const events of [[{ ...current, rescinded: true }, old], [old, { ...current, rescinded: true }]]) {
    assert.deepEqual(suggestionAnnotations(job({ events }), duration), []);
  }
  assert.equal(suggestionAnnotations(job({ events: [{ ...old, rescinded: true }, current] }), duration).length, 1);
});

test("suggestion IDs are stable, bounded and distinct for ambiguous long job/event identities", () => {
  const get = (jobId: string, eventId: string) => suggestionAnnotations(job({
    id: jobId, events: [event({ id: eventId })], evidence: [evidence({ eventId })],
  }), duration)[0];
  const pairs = [["a:b", "c"], ["a", "b:c"], ["j".repeat(256), "e".repeat(256)], ["j".repeat(255) + "k", "e".repeat(256)]];
  const items = pairs.map(([jobId, eventId]) => {
    const item = get(jobId, eventId);
    assert.equal(item.id, get(jobId, eventId).id);
    assert.ok(item.id.length > 0 && item.id.length <= 100);
    assert.equal(proof(item).jobId, jobId);
    assert.equal(proof(item).eventId, eventId);
    return item;
  });
  assert.equal(new Set(ids(items)).size, pairs.length);
  const before = suggestionAnnotations(job(), duration)[0];
  const revised = suggestionAnnotations(job({ events: [event({ revision: 2, type: "goal" })] }), duration)[0];
  assert.equal(before.id, revised.id);
});

test("only evidence-free shots are inferred and inference is never presented as a detection", () => {
  const result = suggestionAnnotations(job({ evidence: [], events: [event({ type: "shot", outcome: "success" })] }), duration);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Rule-inferred shot (not a detection)");
  assert.equal(result[0].category, "shot");
  assert.equal(result[0].outcome, "unknown");
  assert.equal(proof(result[0]).inferred, true);
  assert.equal(proof(result[0]).confidence, null);
  assert.equal(proof(result[0]).frameIndex, null);
  assert.equal(proof(result[0]).timestampSeconds, 13);
  assert.match(proof(result[0]).evidence, /infer|rule|builder/i);
  assert.match(proof(result[0]).evidence, /not.*detect|no.*(frame|evidence|detect)/i);
  for (const type of ["pass", "goal", "save", "tackle", "pressure", "corner", "foul", "yellow_card", "red_card"] as const) {
    assert.deepEqual(suggestionAnnotations(job({ evidence: [], events: [event({ type })] }), duration), [], type);
  }
});

test("manual evidence must never masquerade as AI detection or evidence-free inference", () => {
  for (const type of ["shot", "goal", "pass"] as const) {
    const input = job({
      events: [event({ type })],
      evidence: [evidence({ source: "manual", tagId: "tag-1", confidence: 1, frameIndex: -1 })],
    });
    assert.deepEqual(suggestionAnnotations(input, duration), [], type);
  }
});

test("builder-produced synthetic shots and normalized pass/tackle outcomes stay conservative", () => {
  const base = job();
  const built = buildVideoFixture({
    jobId: base.id, request: base.request, durationSeconds: duration,
    frames: [
      { index: 0, timestampSeconds: 10.25 }, { index: 1, timestampSeconds: 20.5 },
      { index: 2, timestampSeconds: 30.75 }, { index: 3, timestampSeconds: 50.25 },
    ],
    detections: [
      { frameIndex: 0, type: "pass", team: "home", shirtNumber: 7, outcome: "none", x: 50, y: 50, confidence: 0.9, description: "Ball moving between blue players." },
      { frameIndex: 1, type: "pass", team: "home", shirtNumber: 7, outcome: "incomplete", x: 50, y: 50, confidence: 0.9, description: "Pass intercepted." },
      { frameIndex: 2, type: "tackle", team: "away", shirtNumber: 4, outcome: "none", x: 50, y: 50, confidence: 0.9, description: "Challenge for possession." },
      { frameIndex: 3, type: "goal", team: "home", shirtNumber: 9, outcome: "none", x: 50, y: 50, confidence: 0.9, description: "Ball in the net." },
    ],
  });
  const suggestions = suggestionAnnotations(job({ events: built.fixture.events, evidence: built.evidence }), duration);
  assert.equal(suggestions.length, 5);
  const inferred = suggestions.filter((item) => proof(item).inferred);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].title, "Rule-inferred shot (not a detection)");
  assert.equal(inferred[0].outcome, "unknown");
  assert.equal(proof(inferred[0]).confidence, null);
  const passes = suggestions.filter((item) => item.category === "pass");
  assert.deepEqual(passes.map((item) => item.outcome).sort(), ["unknown", "unsuccessful"]);
  assert.equal(suggestions.find((item) => item.category === "tackle")?.outcome, "unknown");
  assert.deepEqual(deriveStats(suggestions, duration).passSuccess, { success: 0, known: 1, percent: 0 });
  assert.doesNotThrow(() => validateAnnotations(suggestions, duration));
});

test("validation creates independent data and freezes provenance without freezing editable fields", () => {
  const original = ai();
  const before = structuredClone(original);
  const [validated] = validateAnnotations([original], duration);
  validated.title = "Reviewed by coach";
  validated.players.push("Player 9");
  assert.notEqual(validated.source, original.source);
  assert.equal(Object.isFrozen(validated.source), true);
  assert.throws(() => Object.assign(validated.source, { confidence: 1 }));
  assert.deepEqual(original, before);
  assert.notEqual(validateSource(source), source);
  const imported = parseLab(serializeLab(source, defaultFilters(duration), [original]), source);
  assert.equal(Object.isFrozen(imported.annotations[0].source), true);
  if (false) {
    // @ts-expect-error provenance replacement is forbidden by the UI contract
    validated.source = { kind: "manual" };
    // @ts-expect-error AI provenance fields cannot be edited
    proof(validated).evidence = "rewritten";
    // @ts-expect-error source discriminants are also immutable
    validated.source.kind = "manual";
  }
});

test("validators reject inherited fields, hidden extra fields, symbols and accessors without executing getters", () => {
  let reads = 0;
  const getter = { ...source };
  Object.defineProperty(getter, "name", { enumerable: true, get: () => { reads++; return "malicious"; } });
  for (const value of [
    Object.create(source), getter,
    Object.defineProperty({ ...source }, "extra", { value: true }),
    { ...source, [Symbol("extra")]: true },
  ]) assert.throws(() => validateSource(value));
  const fakeProof = { ...ai().source };
  Object.defineProperty(fakeProof, "kind", { enumerable: true, get: () => { reads++; return "manual"; } });
  assert.throws(() => validateAnnotations([{ ...ai(), source: fakeProof }], duration));
  assert.equal(reads, 0);
  assert.doesNotThrow(() => validateSource(Object.assign(Object.create(null), source)));
});

test("subsecond clips retain actual evidence when builder-only shots fall beyond the media", () => {
  const built = buildVideoFixture({
    jobId: "tiny", request: job().request, durationSeconds: 0.8,
    frames: [{ index: 0, timestampSeconds: 0.4 }],
    detections: [{
      frameIndex: 0, type: "goal", team: "home", shirtNumber: 9, outcome: "success",
      x: 50, y: 50, confidence: 0.9, description: "Ball in net.",
    }],
  });
  const result = suggestionAnnotations(job({ events: built.fixture.events, evidence: built.evidence }), 0.8);
  assert.equal(result.length, 1);
  assert.equal(result[0].category, "goal");
  assert.equal(proof(result[0]).timestampSeconds, 0.4);
  assert.deepEqual({ inSeconds: result[0].inSeconds, outSeconds: result[0].outSeconds }, { inSeconds: 0, outSeconds: 0.8 });
  assert.deepEqual(deriveStats([], Number.MIN_VALUE).activity, [{ from: 0, to: Number.MIN_VALUE, count: 0 }]);
});

test("manual goals cannot promote an observed shot outcome or induce an AI-only shot suggestion", () => {
  for (const hasObservedShot of [true, false]) {
    const built = buildVideoFixture({
      jobId: "manual-goal", request: job().request, durationSeconds: duration,
      frames: [{ index: 0, timestampSeconds: 10 }],
      detections: hasObservedShot ? [{
        frameIndex: 0, type: "shot", team: "home", shirtNumber: 9, outcome: "miss",
        x: 50, y: 50, confidence: 0.9, description: "Shot misses wide.",
      }] : [],
      manualTags: [{ id: "producer", type: "goal", team: "home", second: 12, shirtNumber: 9, note: "Producer goal" }],
    });
    const result = suggestionAnnotations(job({ events: built.fixture.events, evidence: built.evidence }), duration);
    assert.equal(result.length, hasObservedShot ? 1 : 0);
    if (hasObservedShot) {
      assert.equal(built.fixture.events.find((entry) => entry.type === "shot")?.outcome, "success");
      assert.equal(result[0].outcome, "unknown");
      assert.match(proof(result[0]).evidence, /Shot misses wide/);
      assert.match(proof(result[0]).evidence, /unverified|unknown/i);
    }
  }
  for (const outcome of ["success", "saved", "miss", "none"] as const) {
    const result = suggestionAnnotations(job({ events: [event({ type: "shot", outcome })] }), duration);
    assert.equal(result[0].outcome, "unknown", outcome);
  }
});

test("suggestions stay bounded and fail closed on invalid evidence rather than manufacturing confidence or time", () => {
  const count = MAX_ANNOTATIONS + 10;
  const result = suggestionAnnotations(job({
    events: Array.from({ length: count }, (_, index) => event({ id: `event-${index}` })),
    evidence: Array.from({ length: count }, (_, index) => evidence({ eventId: `event-${index}` })),
  }), duration);
  assert.equal(result.length, MAX_ANNOTATIONS);
  assert.equal(new Set(ids(result)).size, MAX_ANNOTATIONS);
  for (const patch of [
    { confidence: NaN }, { confidence: 1.01 }, { frameIndex: -1 },
    { timestampSeconds: duration + 1 }, { timestampSeconds: NaN },
  ]) {
    assert.throws(() => suggestionAnnotations(job({ evidence: [evidence(patch)] }), duration));
  }
  assert.throws(() => parseLab(null as unknown as string, source));
});

test("reviewed moments map to live-desk producer tags at the marked time", () => {
  const preset = annotation({ category: "red_card", team: "away", title: "Late lunge — straight red!", players: ["#4", "Alex"], ...paddedRange(40, duration) });
  const mapped = deskTagFor(preset, duration);
  assert.ok("tag" in mapped);
  assert.deepEqual(mapped.tag, { type: "red_card", team: "away", second: 40, shirtNumber: 4, note: "Late lunge straight red!" });
  assert.equal(deskTagFor(annotation({ category: "set_piece" }), duration).hasOwnProperty("tag"), true);
  assert.equal((deskTagFor(annotation({ category: "set_piece" }), duration) as { tag: { type: string } }).tag.type, "corner");
  assert.ok("reason" in deskTagFor(annotation({ category: "pressing" }), duration));
  assert.ok("reason" in deskTagFor(annotation({ category: "goal", team: "neutral" }), duration));
  const clamped = deskTagFor(annotation({ category: "goal", inSeconds: 124, outSeconds: 125 }), 120);
  assert.ok("tag" in clamped && clamped.tag.second === 120);
  assert.equal(deskTagSent({ manualTags: [{ id: "a1b2c3d4", ...mapped.tag }] }, mapped.tag), true);
  assert.equal(deskTagSent({ manualTags: [] }, mapped.tag), false);
});