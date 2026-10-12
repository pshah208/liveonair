import assert from "node:assert/strict";
import test from "node:test";

import {
  coachingStorageKey,
  MAX_COACHING_CLIPS,
  parseCoachingClips,
  serializeCoachingClips,
  validClipRange
} from "../shared/coaching.js";
import type { CoachingClip, SourceFingerprint } from "../shared/coaching.js";

const duration = 90;

function clip(overrides: Partial<CoachingClip> = {}): CoachingClip {
  return {
    id: "clip-1",
    inSeconds: 0,
    outSeconds: 12.5,
    title: "Pressing sequence",
    tag: "",
    playerTags: ["Player 7"],
    notes: "",
    ...overrides
  };
}

function envelope(clips: unknown): string {
  return JSON.stringify({ version: 1, clips });
}

function rejectsClips(clips: unknown, error: RegExp): void {
  assert.throws(() => parseCoachingClips(envelope(clips), duration), error);
  assert.throws(() => serializeCoachingClips(clips as CoachingClip[], duration), error);
}

test("clip ranges allow zero start, fractional seconds and exact duration end", () => {
  for (const [start, end, length] of [[0, 90, 90], [1.25, 2.5, 3], [0, 0.1, 0.1]]) {
    assert.equal(validClipRange(start, end, length), true);
  }
});

test("clip ranges reject nonfinite, nonpositive, reversed and out-of-bounds intervals", () => {
  const ranges = [
    [-1, 2, 90], [0, 0, 90], [3, 2, 90], [89, 91, 90], [91, 92, 90],
    [0, 1, 0], [0, 1, -1], [0, 1, Infinity], [0, 1, NaN],
    [NaN, 2, 90], [Infinity, 2, 90], [-Infinity, 2, 90],
    [0, NaN, 90], [0, Infinity, 90], [0, -Infinity, 90]
  ];
  for (const range of ranges) {
    assert.equal(validClipRange(range[0], range[1], range[2]), false, String(range));
  }
  assert.equal(validClipRange("0" as unknown as number, 1, 90), false);
});

test("storage keys are deterministic and distinguish all fingerprint fields without delimiter collisions", () => {
  const source: SourceFingerprint = { name: 'match:["a",1]:⚽.mp4', size: 12, lastModified: 34 };
  assert.equal(coachingStorageKey(source), coachingStorageKey({ ...source }));
  assert.equal(coachingStorageKey(source), coachingStorageKey({
    lastModified: source.lastModified, size: source.size, name: source.name
  }));
  const sources = [
    source,
    { ...source, name: `${source.name} ` },
    { ...source, size: 13 },
    { ...source, lastModified: 35 },
    { name: "a:1", size: 2, lastModified: 3 },
    { name: "a", size: 1, lastModified: 23 },
    { name: "a", size: 12, lastModified: 3 },
    { name: '["a",12,3]', size: 12, lastModified: 3 }
  ];
  assert.equal(new Set(sources.map(coachingStorageKey)).size, sources.length);
});

test("invalid fingerprint numbers cannot collapse into JSON null keys", () => {
  for (const value of [NaN, Infinity, -Infinity, 1.5]) {
    assert.throws(() => coachingStorageKey({ name: "a", size: value, lastModified: 1 }), /fingerprint/);
    assert.throws(() => coachingStorageKey({ name: "a", size: 1, lastModified: value }), /fingerprint/);
  }
});

test("persistence roundtrips exactly without mutating clips or player tags", () => {
  const clips = [clip({ title: "  Press ⚽  ", tag: "Attack", notes: 'Line 1\n"Line 2"' }),
    clip({ id: "clip-2", inSeconds: 40, outSeconds: 90, playerTags: [] })];
  const before = structuredClone(clips);
  const json = serializeCoachingClips(clips, duration);
  assert.deepEqual(JSON.parse(json), { version: 1, clips });
  const parsed = parseCoachingClips(json, duration);
  assert.deepEqual(parsed, clips);
  assert.equal(serializeCoachingClips(parsed, duration), json);
  parsed[0].playerTags.push("Player 9");
  assert.deepEqual(clips, before);
});

test("absent storage and empty clip lists return empty arrays", () => {
  assert.deepEqual(parseCoachingClips(null, duration), []);
  assert.deepEqual(parseCoachingClips(serializeCoachingClips([], duration), duration), []);
});

test("corrupt JSON and invalid envelopes fail explicitly", () => {
  for (const json of ["", "{", '{"version":1,"clips":[}', "undefined"]) {
    assert.throws(() => parseCoachingClips(json, duration), /JSON.*(corrupt|invalid)/);
  }
  for (const value of [null, [], 1, "text", {}, { version: 1 }, { clips: [] },
    { version: 1, clips: [], unexpected: true }]) {
    assert.throws(() => parseCoachingClips(JSON.stringify(value), duration), /envelope.*shape/);
  }
  for (const version of [0, 2, "1", null]) {
    assert.throws(() => parseCoachingClips(JSON.stringify({ version, clips: [] }), duration), /version/);
  }
  for (const value of [null, {}, "clips", 1]) rejectsClips(value, /array/);
});

test("invalid clip shapes and missing fields reject the whole list", () => {
  for (const value of [null, [], "clip", 1, {}, { ...clip(), extra: true }]) {
    rejectsClips([clip({ id: "valid" }), value], /shape/);
  }
  for (const field of Object.keys(clip())) {
    const value: Record<string, unknown> = { ...clip() };
    delete value[field];
    rejectsClips([value], /shape/);
  }
});

test("all string fields enforce types, length bounds and required nonblank values", () => {
  const limits = { id: 100, title: 120, tag: 60, notes: 2000 };
  for (const [field, limit] of Object.entries(limits)) {
    for (const value of [null, 1, [], {}, "x".repeat(limit + 1)]) {
      rejectsClips([{ ...clip(), [field]: value }], new RegExp(field));
    }
  }
  for (const field of ["id", "title"]) {
    for (const value of ["", " \t\n"]) {
      rejectsClips([{ ...clip(), [field]: value }], /nonempty/);
    }
  }
  const maximum = clip({
    id: "i".repeat(100), title: "t".repeat(120), tag: "g".repeat(60),
    playerTags: Array.from({ length: 20 }, () => "p".repeat(60)), notes: "n".repeat(2000)
  });
  assert.deepEqual(parseCoachingClips(serializeCoachingClips([maximum], duration), duration), [maximum]);
});

test("player tags enforce array, count, entry type and entry length bounds", () => {
  for (const playerTags of [null, "player", {}, [null], [1], [{}], ["p".repeat(61)],
    Array.from({ length: 21 }, () => "p")]) {
    rejectsClips([{ ...clip(), playerTags }], /playerTags/);
  }
  const empty = clip({ tag: "", notes: "", playerTags: [] });
  assert.deepEqual(parseCoachingClips(serializeCoachingClips([empty], duration), duration), [empty]);
});

test("range and duration validation applies to both persistence directions", () => {
  for (const value of [
    { inSeconds: -1 }, { inSeconds: 12.5 }, { outSeconds: 91 }, { outSeconds: 0 },
    { inSeconds: "0" }, { outSeconds: null }, { inSeconds: NaN }, { outSeconds: Infinity }
  ]) {
    rejectsClips([{ ...clip(), ...value }], /range/);
  }
  for (const length of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => parseCoachingClips(envelope([]), length), /duration/);
    assert.throws(() => serializeCoachingClips([], length), /duration/);
  }
});

test("clip count is capped at 200 and duplicate ids are rejected", () => {
  assert.equal(MAX_COACHING_CLIPS, 200);
  const clips = Array.from({ length: MAX_COACHING_CLIPS }, (_, index) => clip({ id: `clip-${index}` }));
  assert.deepEqual(parseCoachingClips(serializeCoachingClips(clips, duration), duration), clips);
  rejectsClips([...clips, clip({ id: "overflow" })], /at most 200/);
  rejectsClips([clip(), clip({ title: "Different title" })], /duplicate id/);
  rejectsClips([clip({ id: "__proto__" }), clip({ id: "__proto__" })], /duplicate id/);
});

test("serialization rejects sparse arrays rather than silently dropping entries", () => {
  assert.throws(() => serializeCoachingClips(new Array<CoachingClip>(1), duration), /shape/);
  assert.throws(() => serializeCoachingClips([clip({ playerTags: new Array<string>(1) })], duration), /playerTags/);
});

test("raw JSON budget includes whitespace and is exactly 1 MiB", () => {
  const json = envelope([]);
  const atLimit = json + " ".repeat(1024 * 1024 - json.length);
  assert.deepEqual(parseCoachingClips(atLimit, duration), []);
  assert.throws(() => parseCoachingClips(atLimit + " ", duration), /1 MB/);
});

test("JSON budget counts UTF-8 bytes for both parsing and serialization", () => {
  const clips = Array.from({ length: 180 }, (_, index) =>
    clip({ id: `clip-${index}`, notes: "漢".repeat(2000) }));
  const json = envelope(clips);
  assert.ok(json.length < 1024 * 1024);
  assert.ok(Buffer.byteLength(json, "utf8") > 1024 * 1024);
  assert.throws(() => parseCoachingClips(json, duration), /1 MB/);
  assert.throws(() => serializeCoachingClips(clips, duration), /1 MB/);
});
