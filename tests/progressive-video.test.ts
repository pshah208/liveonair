import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";

import { createApp } from "../server/app.js";
import type { FixtureRegistry, LiveMatchView, LiveService, LiveTransportClient, StorylineDesk } from "../server/contracts.js";
import { unregisterFixture } from "../server/fixtures.js";
import { createLiveService } from "../server/live/service.js";
import { createLocalTransport } from "../server/live/transport.js";
import { createNarrator } from "../server/narrator.js";
import { isProgressiveFrameRequest } from "../server/routes/progressiveVideo.js";
import { HttpError } from "../server/validation.js";
import type { PlayerCamWorker } from "../server/video/playerWorker.js";
import {
  createProgressiveVideoService, type ProgressiveVideoOptions, type ProgressiveVideoService,
} from "../server/video/progressive.js";
import type { VisionAnalyzer, VisionBatchResult } from "../server/video/vision.js";
import type { VideoWorker } from "../server/video/worker.js";
import type { LiveStatus } from "../shared/platform.js";
import {
  LIVE_VIDEO_BATCH_FRAMES, LIVE_VIDEO_FRAME_BYTES, LIVE_VIDEO_PENDING_BATCHES,
  liveVideoFrameCount, liveVideoSampleInterval,
  type ProgressiveVideoBatch, type ProgressiveVideoSession, type StartProgressiveVideo,
} from "../shared/progressiveVideo.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import type { VisionDetection } from "../shared/video.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const unexpected = (): never => { throw new Error("Unexpected legacy upload or external dependency call"); };
const jpeg = (bytes = 12, fill = 0x41) => {
  const buffer = Buffer.alloc(bytes, fill);
  buffer.set([0xff, 0xd8, 0xff].slice(0, bytes));
  return buffer.toString("base64");
};
const JPEG = jpeg();

function metadata(durationSeconds = 12): StartProgressiveVideo {
  return {
    fileName: "local-match.mp4", sizeBytes: 500 * 1024 * 1024, contentType: "video/mp4",
    durationSeconds, rightsConfirmed: true,
    request: { home: { name: "Blue Town", kit: "blue" }, away: { name: "Red City", kit: "red" } },
  };
}

function batch(batchIndex = 0, first = batchIndex * 4, count = 4, duration = 12, encoded = JPEG): ProgressiveVideoBatch {
  return {
    batchIndex,
    frames: Array.from({ length: count }, (_, offset) => ({
      index: first + offset,
      timestampSeconds: (first + offset) * liveVideoSampleInterval(duration),
      jpegBase64: encoded,
    })),
  };
}

function detection(partial: Partial<VisionDetection> = {}): VisionDetection {
  return {
    frameIndex: 2, type: "pass", team: "home", shirtNumber: 7, outcome: "complete",
    x: 50, y: 40, confidence: 0.95, description: "A visible pass.", ...partial,
  };
}

function result(detections: VisionDetection[] = [], partial: Partial<VisionBatchResult> = {}): VisionBatchResult {
  return {
    footageCheck: { realFootballFootage: true, reason: "Camera footage of football" },
    kits: { home: "blue", away: "red" }, detections,
    usage: { inputTokens: 10, outputTokens: 5 }, ...partial,
  };
}

function graphics(detections: VisionDetection[] = [], partial: Partial<VisionBatchResult> = {}): VisionBatchResult {
  return result(detections, {
    footageCheck: { realFootballFootage: false, category: "broadcast_graphics", reason: "A transition card." },
    kits: { home: "gold logos", away: "purple logos" },
    ...partial,
  });
}

class DeferredVision implements VisionAnalyzer {
  configured = true;
  model = "offline-deferred-test";
  calls: {
    input: Parameters<VisionAnalyzer["analyzeBatch"]>[0];
    borrowed: Parameters<VisionAnalyzer["analyzeBatch"]>[0];
    resolve(value: VisionBatchResult): void;
    reject(error: Error): void;
  }[] = [];

  analyzeBatch(input: Parameters<VisionAnalyzer["analyzeBatch"]>[0]): Promise<VisionBatchResult> {
    return new Promise((resolve, reject) => {
      this.calls.push({ input: structuredClone(input), borrowed: input, resolve, reject });
    });
  }

  releaseAll(): void {
    for (const call of this.calls) call.resolve(result());
  }
}

class FakeLive implements LiveService {
  value: LiveStatus = {
    state: "idle", transport: "local", transportConfigured: false, clockSecond: 0,
    speed: 0, eventsReceived: 0, duplicatesIgnored: 0, stress: false,
  };
  starts: MatchFixture[] = [];
  appends: { fixture: MatchFixture; watermark: number }[] = [];
  completions: string[] = [];
  stops: (string | undefined)[] = [];
  view?: LiveMatchView;

  status(): LiveStatus { return structuredClone(this.value); }
  current(): LiveMatchView | undefined { return this.view && structuredClone(this.view); }
  async start(): Promise<LiveStatus> { return unexpected(); }
  async startProgressive(fixture: MatchFixture): Promise<LiveStatus> {
    this.starts.push(structuredClone(fixture));
    this.value = { ...this.value, state: "running", fixtureId: fixture.id, matchId: `live-${fixture.id}`, clockSecond: 0 };
    this.view = { matchId: this.value.matchId!, fixture: structuredClone(fixture), clockSecond: 0 };
    return this.status();
  }
  async appendProgressive(fixture: MatchFixture, watermark: number): Promise<LiveStatus> {
    assert.equal(this.value.state, "running", "must never append after stop");
    assert.equal(this.value.fixtureId, fixture.id, "must never append to a replacement stream");
    this.appends.push({ fixture: structuredClone(fixture), watermark });
    this.value.clockSecond = watermark;
    this.value.eventsReceived = fixture.events.length;
    this.view = { matchId: this.value.matchId!, fixture: structuredClone(fixture), clockSecond: watermark };
    return this.status();
  }
  async completeProgressive(fixtureId: string): Promise<LiveStatus> {
    assert.equal(this.value.fixtureId, fixtureId);
    this.completions.push(fixtureId);
    this.value.state = "finished";
    return this.status();
  }
  async stop(): Promise<LiveStatus> {
    this.stops.push(this.value.fixtureId);
    this.value.state = "finished";
    return this.status();
  }
  async publishCorrection(): Promise<void> { unexpected(); }
  addListener(): () => void { return () => {}; }
  async close(): Promise<void> { this.value.state = "finished"; }
  replace(): void {
    this.value = { ...this.value, state: "running", fixtureId: "unrelated-live-fixture", matchId: "replacement" };
  }
}

async function eventually<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 200 && !predicate(value); attempt++) {
    await tick();
    value = await read();
  }
  assert.ok(predicate(value), `${label}; last value: ${JSON.stringify(value)}`);
  return value;
}

const analyzed = (service: ProgressiveVideoService, id: string, count: number) =>
  eventually(() => service.get(id), (session) => session.analyzedFrames === count && session.pendingBatches === 0, `analyze ${count} frames`);
const atStage = (service: ProgressiveVideoService, id: string, stage: ProgressiveVideoSession["stage"]) =>
  eventually(() => service.get(id), (session) => session.stage === stage, `reach ${stage}`);
const called = (vision: DeferredVision, count: number) =>
  eventually(() => vision.calls.length, (length) => length === count, `${count} deferred model calls`);

async function rejectsStatus(action: () => Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof HttpError, `Expected HttpError ${status}, got ${String(error)}`);
    assert.equal(error.status, status);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function noImages(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /jpegBase64|data:image|sourcePath|\/9j\//u);
}

function harness(t: TestContext, options: Partial<ProgressiveVideoOptions> = {}) {
  const vision = new DeferredVision();
  const live = new FakeLive();
  const registered: MatchFixture[] = [];
  const removed: string[] = [];
  const logs: { sessionId: string; reason: string }[] = [];
  const service = createProgressiveVideoService({
    vision, live, registerFixture: (fixture) => registered.push(structuredClone(fixture)),
    unregisterFixture: (id) => removed.push(id), logger: (entry) => logs.push(entry), ...options,
  });
  t.after(async () => {
    await (options.live ?? live).close();
    vision.releaseAll();
    for (let i = 0; i < 5; i++) await tick();
  });
  return { service, vision, live, registered, removed, logs };
}

test("shared progressive limits and sampling cover short and fifteen-minute clips", () => {
  assert.equal(LIVE_VIDEO_BATCH_FRAMES, 4);
  assert.equal(LIVE_VIDEO_PENDING_BATCHES, 2);
  assert.equal(LIVE_VIDEO_FRAME_BYTES, 256 * 1024);
  for (const [duration, interval, count] of [[0.05, 1, 1], [0.5, 1, 1], [4, 1, 4], [4.2, 1, 5], [300, 1, 300], [450, 1.5, 300], [900, 3, 300]]) {
    assert.equal(liveVideoSampleInterval(duration!), interval);
    assert.equal(liveVideoFrameCount(duration!), count);
    assert.ok((count! - 1) * interval! < duration!);
  }
});

test("create accepts metadata only, starts empty live footage, and never analyzes a full upload", async (t) => {
  const { service, vision, live, registered } = harness(t);
  const input = metadata();
  const created = await service.create(input);
  assert.match(created.id, /^[a-f0-9]{12}$/u);
  assert.equal(created.fixtureId, `video-${created.id}`);
  assert.equal(created.stage, "streaming");
  assert.equal(created.live.fixtureId, created.fixtureId);
  assert.deepEqual([created.acceptedFrames, created.analyzedFrames, created.pendingBatches, created.nextBatchIndex], [0, 0, 0, 0]);
  assert.equal(created.inputComplete, false);
  assert.deepEqual(created.events, []);
  assert.deepEqual(created.evidence, []);
  assert.equal(live.starts.length, 1);
  assert.deepEqual(live.starts[0]!.events, []);
  assert.equal(vision.calls.length, 0);
  assert.equal(registered.length, 0, "unfinished metadata must not be archived by the video service");
  input.request.home.name = "MUTATED";
  await service.batch(created.id, batch());
  await called(vision, 1);
  assert.equal(vision.calls[0]!.input.request.home.name, "Blue Town");
  noImages(created);
});

const invalidMetadata: [string, unknown][] = [
  ["null", null], ["array", []], ["missing fields", {}],
  ["rights denied", { ...metadata(), rightsConfirmed: false }],
  ["rights omitted", { ...metadata(), rightsConfirmed: undefined }],
  ["full upload field", { ...metadata(), videoBase64: JPEG }],
  ["frames on create", { ...metadata(), frames: batch().frames }],
  ["path traversal", { ...metadata(), fileName: "..\\clip.mp4" }],
  ["forward slash path", { ...metadata(), fileName: "../clip.mp4" }],
  ["empty name", { ...metadata(), fileName: "" }],
  ["oversized name", { ...metadata(), fileName: "a".repeat(121) }],
  ["control character", { ...metadata(), fileName: "clip\u0000.mp4" }],
  ["zero bytes", { ...metadata(), sizeBytes: 0 }],
  ["over 500 MiB", { ...metadata(), sizeBytes: 500 * 1024 * 1024 + 1 }],
  ["fractional bytes", { ...metadata(), sizeBytes: 1.5 }],
  ["wrong MIME", { ...metadata(), contentType: "image/jpeg" }],
  ["zero duration", metadata(0)], ["negative duration", metadata(-1)],
  ["over fifteen minutes", metadata(900.01)], ["infinite duration", metadata(Infinity)],
  ["NaN duration", metadata(NaN)],
  ["unknown request field", { ...metadata(), request: { ...metadata().request, sourcePath: "clip.mp4" } }],
  ["blank team", { ...metadata(), request: { ...metadata().request, home: { name: "", kit: "blue" } } }],
];
for (const [name, input] of invalidMetadata) {
  test(`metadata rejects ${name} before starting live`, async (t) => {
    const { service, live, vision } = harness(t);
    await rejectsStatus(() => service.create(input), 400);
    assert.equal(live.starts.length, 0);
    assert.equal(vision.calls.length, 0);
  });
}

test("unconfigured vision, missing progressive live support, and an active stream fail closed", async (t) => {
  const a = harness(t);
  a.vision.configured = false;
  await rejectsStatus(() => a.service.create(metadata()), 503);
  const unsupported: LiveService = { ...a.live, ...{
    status: () => a.live.status(), current: () => a.live.current(), start: () => a.live.start(),
    stop: () => a.live.stop(), close: () => a.live.close(),
    addListener: () => () => {}, publishCorrection: async () => {},
  } };
  const b = harness(t, { live: unsupported });
  await rejectsStatus(() => b.service.create(metadata()), 503);
  const c = harness(t);
  c.live.replace();
  await rejectsStatus(() => c.service.create(metadata()), 409);
  assert.equal(c.live.starts.length, 0);
  assert.deepEqual(c.live.stops, []);
});

test("concurrent create requests admit only one live session", async (t) => {
  const { service, live } = harness(t);
  const outcomes = await Promise.allSettled([service.create(metadata()), service.create(metadata())]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = outcomes.find((item) => item.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof HttpError);
  assert.equal(rejected.reason.status, 409);
  assert.equal(live.starts.length, 1);
});

test("first analyzed batch publishes events BEFORE complete and preserves accepted response snapshots", async (t) => {
  const { service, vision, live } = harness(t);
  const created = await service.create(metadata(8));
  const input = batch();
  const accepted = await service.batch(created.id, input);
  const original = structuredClone(accepted);
  assert.equal(accepted.pendingBatches, 1);
  assert.equal(accepted.analyzedFrames, 0);
  assert.deepEqual(accepted.events, []);
  await called(vision, 1);
  assert.deepEqual(vision.calls[0]!.input.frames, input.frames);
  vision.calls[0]!.resolve(result([detection()]));
  const partial = await analyzed(service, created.id, 4);
  assert.equal(partial.stage, "streaming");
  assert.equal(partial.inputComplete, false);
  assert.equal(partial.analyzedThrough, 3);
  assert.equal(partial.uploadedThrough, 3);
  assert.ok(partial.events.some((event) => event.type === "pass"));
  assert.ok(!partial.events.some((event) => event.type === "fulltime"));
  assert.equal(live.appends.length, 1);
  assert.equal(live.appends[0]!.watermark, 3);
  assert.deepEqual(live.appends[0]!.fixture.events, partial.events);
  assert.deepEqual(live.completions, []);
  assert.deepEqual(accepted, original);
  assert.ok(vision.calls[0]!.borrowed.frames.every((frame) => frame.jpegBase64 === ""), "model frame references are scrubbed after analysis");
  assert.ok(input.frames.every((frame) => frame.jpegBase64 === JPEG), "caller payload is not scrubbed");
  noImages(partial);
});

test("broadcast graphics intro stays empty and preserves unknown kits until match footage succeeds", async (t) => {
  const { service, vision, live, registered } = harness(t);
  const input = metadata(12);
  input.request.home.kit = "";
  input.request.away.kit = "";
  const created = await service.create(input);
  assert.equal(created.coverageNote, "Waiting for match footage.");
  const initialFixture = structuredClone(live.starts[0]!);
  await service.batch(created.id, batch());
  await called(vision, 1);
  vision.calls[0]!.resolve(graphics([
    detection({ frameIndex: 0, type: "goal", outcome: "success" }),
    detection({ frameIndex: 1, type: "shot", outcome: "saved" }),
    detection({ frameIndex: 2, type: "pass" }),
  ]));
  const intro = await analyzed(service, created.id, 4);
  assert.equal(intro.stage, "streaming");
  assert.equal(intro.error, undefined);
  assert.equal(intro.analyzedThrough, 3);
  assert.equal(intro.skippedFrames, 4);
  assert.match(intro.coverageNote!, /waiting for match footage/iu);
  assert.deepEqual(intro.events, [], "graphics must not imply kickoff, shot, goal, or fulltime");
  assert.deepEqual(intro.evidence, []);
  assert.deepEqual(live.appends, [{ fixture: initialFixture, watermark: 3 }], "advance without building a football fixture");
  assert.doesNotMatch(live.appends[0]!.fixture.description, /events detected|local football footage/iu);
  assert.deepEqual(live.completions, []);
  assert.deepEqual(live.stops, []);

  await service.batch(created.id, batch(1));
  await called(vision, 2);
  assert.deepEqual(vision.calls[1]!.input.knownKits, { home: "", away: "" });
  vision.calls[1]!.resolve(result([detection({ frameIndex: 6 })], {
    footageCheck: { realFootballFootage: true, category: "match", reason: "Camera footage" },
    kits: { home: "green shirts", away: "white shirts" },
  }));
  const match = await analyzed(service, created.id, 8);
  assert.equal(match.skippedFrames, 4);
  assert.equal(match.coverageNote, "Match footage detected; 4 broadcast graphics frames skipped.");
  assert.ok(match.events.some((event) => event.type === "pass"));
  assert.ok(!match.events.some((event) => ["shot", "goal", "fulltime"].includes(event.type)));
  assert.ok(match.evidence.length > 0);
  assert.ok(match.evidence.every((item) => item.frameIndex >= 4));
  assert.deepEqual(intro.events, [], "later match results cannot mutate the intro snapshot");

  await service.batch(created.id, batch(2));
  await called(vision, 3);
  assert.deepEqual(vision.calls[2]!.input.knownKits, { home: "green shirts", away: "white shirts" });
  vision.calls[2]!.resolve(result());
  await analyzed(service, created.id, 12);
  await service.complete(created.id);
  const completed = await atStage(service, created.id, "complete");
  assert.equal(completed.skippedFrames, 4);
  assert.equal(completed.events.filter((event) => event.type === "fulltime").length, 1);
  assert.ok(!completed.events.some((event) => ["shot", "goal"].includes(event.type)));
  assert.ok(completed.evidence.every((item) => item.frameIndex >= 4));
  assert.deepEqual(live.completions, [created.fixtureId]);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0]!.events, completed.events);
  noImages(completed);
});

test("midmatch broadcast graphics advance watermarks without rebuilding events or filling blank kits", async (t) => {
  const { service, vision, live } = harness(t);
  const input = metadata(16);
  input.request.home.kit = "";
  input.request.away.kit = "";
  const { id } = await service.create(input);
  await service.batch(id, batch());
  await called(vision, 1);
  vision.calls[0]!.resolve(result([detection({ frameIndex: 3, type: "shot", outcome: "miss" })], {
    kits: { home: "", away: "" },
  }));
  const match = await analyzed(service, id, 4);
  const fixture = structuredClone(live.appends[0]!.fixture);
  for (let index = 1; index <= 2; index++) {
    await service.batch(id, batch(index));
    await called(vision, index + 1);
    assert.deepEqual(vision.calls[index]!.input.knownKits, { home: "", away: "" });
    vision.calls[index]!.resolve(graphics([
      detection({ frameIndex: index * 4, type: "save", team: "away", shirtNumber: 1 }),
      detection({ frameIndex: index * 4 + 2, type: "goal", outcome: "success" }),
    ]));
    const skipped = await analyzed(service, id, (index + 1) * 4);
    assert.equal(skipped.stage, "streaming");
    assert.equal(skipped.analyzedThrough, index * 4 + 3);
    assert.equal(skipped.live.clockSecond, skipped.analyzedThrough);
    assert.equal(skipped.skippedFrames, index * 4);
    assert.match(skipped.coverageNote!, /skipping broadcast graphics/iu);
    assert.deepEqual(skipped.events, match.events, "even valid fake saves must not revise the prior shot");
    assert.deepEqual(skipped.evidence, match.evidence);
    assert.deepEqual(live.appends[index], { fixture, watermark: index * 4 + 3 });
  }
  await service.batch(id, batch(3));
  await called(vision, 4);
  assert.deepEqual(vision.calls[3]!.input.knownKits, { home: "", away: "" }, "graphics must not fill initially unknown match kits");
  vision.calls[3]!.resolve(result([detection({ frameIndex: 14 })]));
  const resumed = await analyzed(service, id, 16);
  assert.equal(resumed.coverageNote, "Match footage detected; 8 broadcast graphics frames skipped.");
  assert.equal(resumed.skippedFrames, 8);
  for (const event of match.events) assert.deepEqual(resumed.events.find((item) => item.id === event.id), event);
  assert.ok(!resumed.events.some((event) => ["save", "goal", "fulltime"].includes(event.type)));
  assert.ok(resumed.evidence.every((item) => item.frameIndex < 4 || item.frameIndex >= 12));
  assert.deepEqual(live.completions, []);
  assert.deepEqual(live.stops, []);
});

test("graphics-only completion fails with zero events and cannot extend frame or duration limits", async (t) => {
  const { service, vision, live, registered } = harness(t);
  const { id, fixtureId } = await service.create(metadata(5));
  await service.batch(id, batch());
  await called(vision, 1);
  vision.calls[0]!.resolve(graphics());
  await analyzed(service, id, 4);
  await rejectsStatus(() => service.complete(id), 409, /every planned frame/iu);
  await rejectsStatus(() => service.batch(id, batch(1, 4, 2)), 400, /planned video frame count/iu);
  const beyondDuration = batch(1, 4, 1);
  beyondDuration.frames[0]!.timestampSeconds = 5;
  await rejectsStatus(() => service.batch(id, beyondDuration), 400, /timestamp/iu);
  await service.batch(id, batch(1, 4, 1));
  await called(vision, 2);
  await rejectsStatus(() => service.batch(id, batch(2, 5, 1)), 400, /planned video frame count/iu);
  const draining = await service.complete(id);
  assert.equal(draining.inputComplete, true);
  assert.equal(draining.stage, "streaming");
  assert.deepEqual(live.completions, []);
  vision.calls[1]!.resolve(graphics([detection({ frameIndex: 4, type: "goal", outcome: "success" })]));
  const failed = await atStage(service, id, "failed");
  assert.match(failed.error!, /^No match footage/iu);
  assert.equal(failed.acceptedFrames, 5);
  assert.equal(failed.analyzedFrames, 5);
  assert.equal(failed.analyzedThrough, 4);
  assert.equal(failed.skippedFrames, 5);
  assert.equal(failed.pendingBatches, 0);
  assert.deepEqual(failed.events, []);
  assert.deepEqual(failed.evidence, []);
  assert.equal(live.appends.length, 2);
  assert.deepEqual(live.appends.map((item) => item.watermark), [3, 4]);
  for (const append of live.appends) assert.deepEqual(append.fixture, live.starts[0]);
  assert.deepEqual(live.completions, []);
  assert.deepEqual(live.stops, [fixtureId]);
  assert.deepEqual(registered, []);
});

test("unsupported and legacy false footage reject football-logo reasons before or after a match", async (t) => {
  for (const category of ["unsupported", undefined] as const) {
    for (const afterMatch of [false, true]) {
      await t.test(`${category ?? "legacy"} ${afterMatch ? "after match" : "initial batch"}`, async (t) => {
        const { service, vision, live, registered } = harness(t);
        const { id, fixtureId } = await service.create(metadata(12));
        const index = afterMatch ? 1 : 0;
        if (afterMatch) {
          await service.batch(id, batch());
          await called(vision, 1);
          vision.calls[0]!.resolve(result([detection()]));
          await analyzed(service, id, 4);
        }
        const before = await service.get(id);
        await service.batch(id, batch(index));
        await service.batch(id, batch(index + 1));
        await called(vision, index + 1);
        vision.calls[index]!.resolve(result([], {
          footageCheck: {
            realFootballFootage: false,
            reason: "Football broadcast graphics: animated club logos and a football scoreboard.",
            ...(category ? { category } : {}),
          },
        }));
        const failed = await atStage(service, id, "failed");
        assert.match(failed.error!, /not real football footage/iu);
        assert.equal(failed.analyzedFrames, before.analyzedFrames);
        assert.equal(failed.analyzedThrough, before.analyzedThrough);
        assert.equal(failed.skippedFrames ?? 0, 0);
        assert.equal(failed.pendingBatches, 0);
        assert.deepEqual(failed.events, before.events);
        assert.deepEqual(failed.evidence, before.evidence);
        assert.equal(vision.calls.length, index + 1, "rejection discards queued batches");
        assert.equal(live.appends.length, index);
        assert.deepEqual(live.completions, []);
        assert.deepEqual(live.stops, [fixtureId]);
        assert.deepEqual(registered, []);
      });
    }
  }
});

test("broadcast graphics cannot bypass detection, schema, category, or token-usage validation", async (t) => {
  const malformed: [string, unknown, RegExp?][] = [
    ["excess detections", graphics(Array.from({ length: 4 }, () => detection({ frameIndex: 0 }))), /detection budget/iu],
    ["missing kits", { ...graphics(), kits: undefined }],
    ["invalid kit schema", { ...graphics(), kits: { home: 7, away: "" } }],
    ["invalid detections schema", { ...graphics(), detections: {} }],
    ["invalid outcome", { ...graphics(), detections: [{ ...detection({ frameIndex: 0 }), outcome: "invented" }] }],
    ["negative confidence", graphics([detection({ frameIndex: 0, confidence: -0.01 })])],
    ["confidence above one", graphics([detection({ frameIndex: 0, confidence: 1.01 })])],
    ["invalid reason schema", { ...graphics(), footageCheck: { ...graphics().footageCheck, reason: 42 } }],
    ["invalid category", { ...graphics(), footageCheck: { ...graphics().footageCheck, category: "logo" } }],
    ["false match contradiction", result([], { footageCheck: { realFootballFootage: false, category: "match", reason: "Football logos" } })],
    ["true graphics contradiction", graphics([], { footageCheck: { realFootballFootage: true, category: "broadcast_graphics", reason: "Football logos" } })],
    ["true unsupported contradiction", result([], { footageCheck: { realFootballFootage: true, category: "unsupported", reason: "Football logos" } })],
    ...[
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 0, outputTokens: -1 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: 0, outputTokens: Infinity },
      { inputTokens: NaN, outputTokens: 0 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
    ].map((usage): [string, unknown, RegExp] => [
      `invalid usage ${String(usage.inputTokens)}/${String(usage.outputTokens)}`, graphics([], { usage }), /token budget/iu,
    ]),
  ];
  for (const [name, invalid, message] of malformed) {
    await t.test(name, async (t) => {
      const { service, vision, live, registered } = harness(t);
      const { id, fixtureId } = await service.create(metadata(2));
      await service.batch(id, batch(0, 0, 1));
      await service.batch(id, batch(1, 1, 1));
      await called(vision, 1);
      vision.calls[0]!.resolve(invalid as VisionBatchResult);
      const failed = await atStage(service, id, "failed");
      if (message) assert.match(failed.error!, message);
      assert.equal(failed.analyzedFrames, 0);
      assert.equal(failed.analyzedThrough, 0);
      assert.equal(failed.skippedFrames ?? 0, 0);
      assert.equal(failed.pendingBatches, 0);
      assert.deepEqual(failed.events, []);
      assert.deepEqual(failed.evidence, []);
      assert.equal(vision.calls.length, 1);
      assert.deepEqual(live.appends, []);
      assert.deepEqual(live.completions, []);
      assert.deepEqual(live.stops, [fixtureId]);
      assert.deepEqual(registered, []);
    });
  }
});

test("graphics and match batches share the accumulated input-plus-output token budget", async (t) => {
  for (const firstGraphics of [true, false]) {
    await t.test(firstGraphics ? "graphics-match-graphics" : "match-graphics-match", async (t) => {
      const { service, vision, live } = harness(t, { tokenBudget: 30 });
      const { id } = await service.create(metadata(12));
      for (let index = 0; index < 2; index++) {
        await service.batch(id, batch(index));
        await called(vision, index + 1);
        const isGraphics = index === 0 ? firstGraphics : !firstGraphics;
        vision.calls[index]!.resolve(isGraphics ? graphics() : result([detection({ frameIndex: index * 4 + 2 })]));
        const accepted = await analyzed(service, id, (index + 1) * 4);
        assert.equal(accepted.stage, "streaming", "exact combined budget remains valid");
      }
      const before = await service.get(id);
      assert.equal(before.skippedFrames, 4);
      await service.batch(id, batch(2));
      await called(vision, 3);
      const usage = { inputTokens: 0, outputTokens: 1 };
      vision.calls[2]!.resolve(firstGraphics ? graphics([], { usage }) : result([], { usage }));
      const failed = await atStage(service, id, "failed");
      assert.match(failed.error!, /token budget/iu);
      assert.equal(failed.analyzedFrames, 8);
      assert.equal(failed.analyzedThrough, 7);
      assert.equal(failed.skippedFrames, 4);
      assert.deepEqual(failed.events, before.events);
      assert.deepEqual(failed.evidence, before.evidence);
      assert.equal(live.appends.length, 2);
      assert.deepEqual(live.completions, []);
    });
  }
});

test("queue bound is TWO INCLUDING in-flight; exact retries stay idempotent even while busy", async (t) => {
  const { service, vision, live } = harness(t);
  const { id } = await service.create(metadata(12));
  const first = batch();
  const second = batch(1);
  await service.batch(id, first);
  await called(vision, 1);
  await service.batch(id, second);
  const busy = await service.get(id);
  assert.equal(busy.pendingBatches, 2);
  assert.equal(busy.acceptedFrames, 8);
  assert.equal(vision.calls.length, 1, "queued second batch is not analyzed concurrently");
  await rejectsStatus(() => service.batch(id, batch(2)), 429, /queue/u);
  assert.deepEqual(await service.get(id), busy, "rejected work must not consume indices or frames");
  assert.deepEqual(await service.batch(id, structuredClone(first)), busy);
  assert.deepEqual(await service.batch(id, structuredClone(second)), busy);
  for (const changed of [
    { ...first, frames: [{ ...first.frames[0]!, jpegBase64: jpeg(12, 0x42) }, ...first.frames.slice(1)] },
    { ...first, frames: [{ ...first.frames[0]!, timestampSeconds: 0.05 }, ...first.frames.slice(1)] },
    { ...first, frames: first.frames.slice(0, 3) },
  ]) await rejectsStatus(() => service.batch(id, changed), 409, /retry/u);
  vision.calls[0]!.resolve(result());
  await called(vision, 2);
  assert.equal((await service.get(id)).pendingBatches, 1);
  assert.equal((await service.batch(id, batch(2))).pendingBatches, 2, "capacity is released after the first model result");
  vision.calls[1]!.resolve(result());
  await called(vision, 3);
  vision.calls[2]!.resolve(result());
  await analyzed(service, id, 12);
  const appendCount = live.appends.length;
  const replay = await service.batch(id, first);
  assert.equal(replay.acceptedFrames, 12);
  assert.equal(replay.pendingBatches, 0);
  await tick();
  assert.equal(vision.calls.length, 3);
  assert.equal(live.appends.length, appendCount);
});

const invalidBatches: [string, (valid: ProgressiveVideoBatch) => unknown, number][] = [
  ["missing body", () => undefined, 400],
  ["empty frames", (valid) => ({ ...valid, frames: [] }), 400],
  ["five frames", () => batch(0, 0, 5), 400],
  ["skipped batch", (valid) => ({ ...valid, batchIndex: 1 }), 409],
  ["negative batch", (valid) => ({ ...valid, batchIndex: -1 }), 400],
  ["fractional batch", (valid) => ({ ...valid, batchIndex: 0.5 }), 400],
  ["batch field injection", (valid) => ({ ...valid, fileName: "upload.mp4" }), 400],
  ["first frame not zero", () => batch(0, 1), 409],
  ["duplicate frame", (valid) => ({ ...valid, frames: [valid.frames[0], valid.frames[0]] }), 409],
  ["out of order frames", (valid) => ({ ...valid, frames: [...valid.frames].reverse() }), 409],
  ["gap within batch", (valid) => ({ ...valid, frames: [valid.frames[0], valid.frames[2]] }), 409],
  ["fractional frame", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], index: 0.5 }] }), 400],
  ["negative time", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], timestampSeconds: -0.01 }] }), 400],
  ["NaN time", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], timestampSeconds: NaN }] }), 400],
  ["infinite time", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], timestampSeconds: Infinity }] }), 400],
  ["wrong time", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], timestampSeconds: 0.101 }] }), 400],
  ["exact 0.1 tolerance", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], timestampSeconds: 0.1 }] }), 400],
  ["frame unknown field", (valid) => ({ ...valid, frames: [{ ...valid.frames[0], path: "frame.jpg" }] }), 400],
];
for (const [name, mutate, status] of invalidBatches) {
  test(`batch validation rejects ${name} atomically`, async (t) => {
    const { service, vision } = harness(t);
    const { id } = await service.create(metadata());
    await rejectsStatus(() => service.batch(id, mutate(batch())), status);
    const untouched = await service.get(id);
    assert.deepEqual([untouched.acceptedFrames, untouched.nextBatchIndex, untouched.pendingBatches], [0, 0, 0]);
    assert.equal(vision.calls.length, 0);
    assert.equal((await service.batch(id, batch())).acceptedFrames, 4);
  });
}

test("frame indices remain contiguous across partial batches", async (t) => {
  const { service, vision } = harness(t);
  const { id } = await service.create(metadata());
  await service.batch(id, batch(0, 0, 2));
  await rejectsStatus(() => service.batch(id, batch(1, 3, 2)), 409);
  await rejectsStatus(() => service.batch(id, batch(1, 1, 2)), 409);
  assert.equal((await service.batch(id, batch(1, 2, 2))).acceptedFrames, 4);
  await called(vision, 1);
  assert.deepEqual(vision.calls[0]!.input.frames.map((frame) => frame.index), [0, 1]);
});

test("timestamps allow offsets strictly inside tolerance and use the long-clip sample interval", async (t) => {
  const { service, vision } = harness(t);
  const { id } = await service.create(metadata(900));
  const input = batch(0, 0, 4, 900);
  input.frames[0]!.timestampSeconds += 0.099;
  input.frames[1]!.timestampSeconds -= 0.099;
  await service.batch(id, input);
  await called(vision, 1);
  assert.equal(vision.calls[0]!.input.intervalSeconds, 3);
  await rejectsStatus(() => service.batch(id, batch(1, 4, 4, 12)), 400);
});

test("timestamps reject the exact lower 0.1 boundary, including floating-point subtraction", async (t) => {
  const { service } = harness(t);
  const { id } = await service.create(metadata());
  const input = batch(0, 0, 2);
  input.frames[1]!.timestampSeconds = 0.9;
  await rejectsStatus(() => service.batch(id, input), 400);
});

test("timestamps must precede duration and frame count cannot exceed the sampling plan", async (t) => {
  const { service } = harness(t);
  const { id } = await service.create(metadata(0.05));
  const input = batch(0, 0, 1);
  input.frames[0]!.timestampSeconds = 0.05;
  await rejectsStatus(() => service.batch(id, input), 400);
  await rejectsStatus(() => service.batch(id, batch(0, 0, 2)), 400);
  input.frames[0]!.timestampSeconds = 0;
  assert.equal((await service.batch(id, input)).acceptedFrames, 1);
});

const invalidJpegs: [string, string][] = [
  ["empty", ""], ["non-base64", "!!!!"], ["whitespace", `${JPEG}\n`],
  ["data URL", `data:image/jpeg;base64,${JPEG}`],
  ["PNG magic", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")],
  ["two-byte JPEG prefix", jpeg(2)],
  ["wrong third magic byte", Buffer.from([0xff, 0xd8, 0x00]).toString("base64")],
  ["missing padding", jpeg(4).replace(/=+$/u, "")],
  ["noncanonical pad bits", "/9j/QR=="],
  ["URL-safe alphabet", JPEG.replace(/\//gu, "_")],
  ["decoded 256 KiB plus one", jpeg(256 * 1024 + 1)],
];
for (const [name, encoded] of invalidJpegs) {
  test(`JPEG rejects ${name}`, async (t) => {
    const { service, vision } = harness(t);
    const { id } = await service.create(metadata());
    await rejectsStatus(() => service.batch(id, batch(0, 0, 1, 12, encoded)), 400);
    assert.equal((await service.get(id)).acceptedFrames, 0);
    assert.equal(vision.calls.length, 0);
  });
}

test("JPEG accepts canonical base64 at the exact decoded 256 KiB limit", async (t) => {
  const { service, vision } = harness(t);
  const { id } = await service.create(metadata());
  const maximum = jpeg(256 * 1024);
  assert.equal(Buffer.from(maximum, "base64").length, 256 * 1024);
  await service.batch(id, batch(0, 0, 4, 12, maximum));
  await called(vision, 1);
  assert.ok(vision.calls[0]!.input.frames.every((frame) => frame.jpegBase64 === maximum));
});

test("complete requires ALL planned frames, drains accepted work, and is idempotent", async (t) => {
  const { service, vision, live, registered, removed } = harness(t);
  const { id, fixtureId } = await service.create(metadata(5));
  await rejectsStatus(() => service.complete(id), 409, /every planned frame/iu);
  const first = batch();
  await service.batch(id, first);
  await rejectsStatus(() => service.complete(id), 409);
  const second = batch(1, 4, 1);
  await service.batch(id, second);
  await called(vision, 1);
  const completing = await service.complete(id);
  assert.equal(completing.inputComplete, true);
  assert.equal(completing.stage, "streaming");
  assert.equal(completing.pendingBatches, 2);
  assert.deepEqual(live.completions, []);
  assert.equal((await service.complete(id)).inputComplete, true);
  assert.equal((await service.batch(id, first)).acceptedFrames, 5);
  await rejectsStatus(() => service.batch(id, batch(2, 5, 1)), 409);
  vision.calls[0]!.resolve(result([detection()]));
  await called(vision, 2);
  assert.equal((await service.get(id)).stage, "streaming");
  assert.equal(live.completions.length, 0);
  vision.calls[1]!.resolve(result([detection({ frameIndex: 4, type: "goal", team: "away" })]));
  const completed = await atStage(service, id, "complete");
  assert.equal(completed.analyzedFrames, 5);
  assert.equal(completed.analyzedThrough, 5);
  assert.equal(completed.pendingBatches, 0);
  assert.equal(completed.events.filter((event) => event.type === "fulltime").length, 1);
  assert.deepEqual(live.completions, [fixtureId]);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0]!.events, completed.events);
  assert.ok(completed.events.some((event) => event.id === registered[0]!.correctionEventId && event.type === "goal"));
  assert.deepEqual(await service.complete(id), completed);
  assert.deepEqual(await service.batch(id, second), completed);
  assert.equal(live.completions.length, 1);
  assert.equal((await service.stop(id)).stage, "stopped");
  assert.deepEqual(removed, [fixtureId]);
  noImages(completed);
});

test("stable event IDs, revisions, save.relatedEventId and evidence survive incremental rebuilds", async (t) => {
  const { service, vision } = harness(t);
  const { id } = await service.create(metadata(12));
  await service.batch(id, batch());
  await called(vision, 1);
  vision.calls[0]!.resolve(result([
    detection({ frameIndex: 1, type: "pass" }),
    detection({ frameIndex: 3, type: "shot", outcome: "miss" }),
  ]));
  const first = await analyzed(service, id, 4);
  const shot = first.events.find((event) => event.type === "shot")!;
  const pass = first.events.find((event) => event.type === "pass")!;
  assert.ok(shot && pass);
  assert.equal(shot.revision, 1);
  await service.batch(id, batch(1));
  await called(vision, 2);
  vision.calls[1]!.resolve(result([detection({ frameIndex: 4, type: "save", team: "away", shirtNumber: 1 })]));
  const second = await analyzed(service, id, 8);
  const revised = second.events.find((event) => event.type === "shot")!;
  const save = second.events.find((event) => event.type === "save")!;
  assert.equal(revised.id, shot.id);
  assert.equal(revised.revision, shot.revision + 1);
  assert.equal(revised.outcome, "saved");
  assert.equal(save.relatedEventId, shot.id);
  assert.deepEqual(second.events.find((event) => event.id === pass.id), pass);
  assert.equal(shot.outcome, "miss", "older response stays immutable");
  assert.ok(second.evidence.some((item) => item.eventId === shot.id && item.frameIndex === 3));
  assert.ok(second.evidence.some((item) => item.eventId === save.id && item.frameIndex === 4));
  await service.batch(id, batch(2));
  await called(vision, 3);
  vision.calls[2]!.resolve(result([detection({ frameIndex: 9, type: "corner" })]));
  const third = await analyzed(service, id, 12);
  await service.complete(id);
  const complete = await atStage(service, id, "complete");
  for (const session of [third, complete]) {
    for (const event of second.events) assert.deepEqual(session.events.find((item) => item.id === event.id), event);
    const ids = new Set(session.events.map((event) => event.id));
    assert.equal(ids.size, session.events.length);
    assert.ok(session.evidence.every((item) => ids.has(item.eventId)));
    assert.ok(session.events.filter((event) => event.relatedEventId).every((event) => ids.has(event.relatedEventId!)));
    noImages(session);
  }
});

test("response objects and nested events, evidence and live status cannot mutate service state", async (t) => {
  const { service, vision } = harness(t);
  const { id } = await service.create(metadata());
  await service.batch(id, batch());
  await called(vision, 1);
  vision.calls[0]!.resolve(result([detection()]));
  const response = await analyzed(service, id, 4);
  const original = structuredClone(response);
  response.stage = "failed";
  response.events[0]!.id = "tampered";
  response.events.push(structuredClone(response.events[0]!));
  response.evidence[0]!.description = "tampered";
  response.live.fixtureId = "tampered";
  assert.deepEqual(await service.get(id), original);
  noImages(original);
});

for (const action of ["stop", "external stop", "replacement"] as const) {
  test(`${action} during deferred model work discards queued work and never appends`, async (t) => {
    const { service, vision, live, registered } = harness(t);
    const { id } = await service.create(metadata(8));
    await service.batch(id, batch());
    await service.batch(id, batch(1));
    await called(vision, 1);
    if (action === "stop") await service.stop(id);
    if (action === "external stop") await live.stop();
    if (action === "replacement") live.replace();
    vision.calls[0]!.resolve(result([detection()]));
    const stopped = await atStage(service, id, "stopped");
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(stopped.pendingBatches, 0);
    assert.equal(stopped.analyzedFrames, 0);
    assert.equal(vision.calls.length, 1);
    assert.equal(live.appends.length, 0);
    assert.equal(live.completions.length, 0);
    assert.equal(registered.length, 0);
    assert.ok(vision.calls[0]!.borrowed.frames.every((frame) => !frame.jpegBase64));
    await rejectsStatus(() => service.batch(id, batch(2, 8, 1)), 409);
    await rejectsStatus(() => service.complete(id), 409);
    const stopCalls = live.stops.length;
    assert.equal((await service.stop(id)).stage, "stopped");
    assert.equal(live.stops.length, stopCalls);
    if (action === "replacement") {
      assert.deepEqual(live.stops, []);
      assert.equal(live.status().fixtureId, "unrelated-live-fixture");
      assert.equal(live.status().state, "running");
    }
  });
}

test("a new session waits safely behind a stopped session's deferred model", async (t) => {
  const { service, vision, live } = harness(t);
  const first = await service.create(metadata());
  await service.batch(first.id, batch());
  await called(vision, 1);
  await service.stop(first.id);
  const second = await service.create(metadata());
  assert.notEqual(first.id, second.id);
  await service.batch(second.id, batch());
  vision.calls[0]!.resolve(result([detection()]));
  await called(vision, 2);
  assert.equal(live.appends.length, 0);
  vision.calls[1]!.resolve(result([detection()]));
  await analyzed(service, second.id, 4);
  assert.ok(live.appends.every((item) => item.fixture.id === second.fixtureId));
  assert.equal((await service.get(first.id)).analyzedFrames, 0);
});

for (const rejectedBatch of [0, 1, 2]) {
  test(`realFootballFootage is checked on batch ${rejectedBatch}, not only the first`, async (t) => {
    const { service, vision, live, registered, logs } = harness(t);
    const { id, fixtureId } = await service.create(metadata(16));
    for (let index = 0; index < rejectedBatch; index++) {
      await service.batch(id, batch(index));
      await called(vision, index + 1);
      vision.calls[index]!.resolve(result([detection({ frameIndex: index * 4 + 2 })]));
      await analyzed(service, id, (index + 1) * 4);
    }
    const before = await service.get(id);
    const appends = live.appends.length;
    await service.batch(id, batch(rejectedBatch));
    await service.batch(id, batch(rejectedBatch + 1));
    await called(vision, rejectedBatch + 1);
    vision.calls[rejectedBatch]!.resolve(result([detection({ frameIndex: rejectedBatch * 4 + 2 })], {
      footageCheck: { realFootballFootage: false, reason: "Video game footage" },
    }));
    const failed = await atStage(service, id, "failed");
    assert.match(failed.error!, /not real football footage/iu);
    assert.equal(failed.pendingBatches, 0);
    assert.equal(failed.analyzedFrames, before.analyzedFrames);
    assert.deepEqual(failed.events, before.events);
    assert.equal(vision.calls.length, rejectedBatch + 1);
    assert.equal(live.appends.length, appends);
    assert.deepEqual(live.stops, [fixtureId]);
    assert.equal(registered.length, 0);
    noImages([failed, logs]);
  });
}

test("a rejected or thrown deferred result never stops somebody else's replacement fixture", async (t) => {
  for (const reject of [false, true]) {
    const { service, vision, live } = harness(t);
    const { id } = await service.create(metadata());
    await service.batch(id, batch());
    await called(vision, 1);
    live.replace();
    if (reject) vision.calls[0]!.reject(new Error("offline model failure"));
    else vision.calls[0]!.resolve(result([], { footageCheck: { realFootballFootage: false, reason: "animation" } }));
    await eventually(() => vision.calls[0]!.borrowed.frames[0]!.jpegBase64, (value) => value === "", "discard obsolete model input");
    assert.equal(live.stops.length, 0);
    assert.equal(live.appends.length, 0);
    assert.equal(live.status().state, "running");
    assert.equal(live.status().fixtureId, "unrelated-live-fixture");
  }
});

test("token budget includes input AND output across batches, permits exact budget, then fails closed", async (t) => {
  const { service, vision, live } = harness(t, { tokenBudget: 30 });
  const { id } = await service.create(metadata());
  for (let index = 0; index < 2; index++) {
    await service.batch(id, batch(index));
    await called(vision, index + 1);
    vision.calls[index]!.resolve(result());
    await analyzed(service, id, (index + 1) * 4);
  }
  await service.batch(id, batch(2));
  await called(vision, 3);
  vision.calls[2]!.resolve(result([], { usage: { inputTokens: 0, outputTokens: 1 } }));
  const failed = await atStage(service, id, "failed");
  assert.match(failed.error!, /token budget/iu);
  assert.equal(failed.analyzedFrames, 8);
  assert.equal(live.appends.length, 2);
});

for (const usage of [
  { inputTokens: -1, outputTokens: 0 },
  { inputTokens: 0, outputTokens: -1 },
  { inputTokens: 1.5, outputTokens: 0 },
  { inputTokens: 0, outputTokens: Infinity },
  { inputTokens: NaN, outputTokens: 0 },
  { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
]) {
  test(`invalid model token usage fails closed: ${String(usage.inputTokens)}/${String(usage.outputTokens)}`, async (t) => {
    const { service, vision, live } = harness(t);
    const { id } = await service.create(metadata());
    await service.batch(id, batch());
    await called(vision, 1);
    vision.calls[0]!.resolve(result([], { usage }));
    const failed = await atStage(service, id, "failed");
    assert.match(failed.error!, /token budget/iu);
    assert.equal(live.appends.length, 0);
  });
}

test("model exceptions and excess detections fail safely rather than publishing partial work", async (t) => {
  for (const mode of ["throw", "too many detections"] as const) {
    const { service, vision, live, logs } = harness(t);
    const { id } = await service.create(metadata());
    await service.batch(id, batch(0, 0, 1));
    await called(vision, 1);
    if (mode === "throw") vision.calls[0]!.reject(new Error("offline failure"));
    else vision.calls[0]!.resolve(result(Array.from({ length: 4 }, () => detection({ frameIndex: 0 }))));
    const failed = await atStage(service, id, "failed");
    assert.equal(failed.pendingBatches, 0);
    assert.equal(failed.analyzedFrames, 0);
    assert.equal(live.appends.length, 0);
    assert.equal(logs.length, 1);
    noImages(failed);
  }
});

test("TTL uses injected time, refreshes on access, and cancels stale deferred work", async (t) => {
  let now = 0;
  const { service, vision, live } = harness(t, { now: () => now, idleMs: 100 });
  const { id, fixtureId } = await service.create(metadata());
  await service.batch(id, batch());
  await called(vision, 1);
  now = 99;
  assert.equal((await service.get(id)).stage, "streaming");
  now = 198;
  assert.equal((await service.get(id)).stage, "streaming");
  now = 298;
  await rejectsStatus(() => service.get(id), 404);
  assert.deepEqual(live.stops, [fixtureId]);
  vision.calls[0]!.resolve(result([detection()]));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(live.appends.length, 0);
  const replacement = await service.create(metadata());
  assert.notEqual(replacement.id, id);
});

test("TTL expiry never stops a replacement live fixture", async (t) => {
  let now = 0;
  const { service, live } = harness(t, { now: () => now, idleMs: 100 });
  const { id } = await service.create(metadata());
  live.replace();
  now = 100;
  await rejectsStatus(() => service.get(id), 404);
  assert.deepEqual(live.stops, []);
  assert.equal(live.status().state, "running");
});

test("six retained sessions are bounded and expired stopped sessions release capacity", async (t) => {
  let now = 0;
  const { service } = harness(t, { now: () => now, idleMs: 100 });
  const ids: string[] = [];
  for (let index = 0; index < 6; index++) {
    const { id } = await service.create(metadata());
    ids.push(id);
    await service.stop(id);
  }
  assert.equal(new Set(ids).size, 6);
  await rejectsStatus(() => service.create(metadata()), 429);
  now = 100;
  assert.equal((await service.create(metadata())).stage, "streaming");
  for (const id of ids) await rejectsStatus(() => service.get(id), 404);
});

test("malformed and unknown IDs fail consistently on every service operation", async (t) => {
  const { service } = harness(t);
  for (const id of ["../bad", "ABCDEF012345", "short", "abcdef012345"]) {
    const expected = id === "abcdef012345" ? 404 : 400;
    for (const operation of [
      () => service.get(id), () => service.batch(id, batch()), () => service.complete(id), () => service.stop(id),
    ]) await rejectsStatus(operation, expected);
  }
});

function localLive(transport: LiveTransportClient = createLocalTransport()) {
  const fixtures = new Map<string, MatchFixture>();
  const registry: FixtureRegistry = {
    listFixtures: () => [...fixtures.values()].map((fixture) => ({ ...structuredClone(fixture), eventCount: fixture.events.length })),
    getFixture: (id) => {
      const fixture = fixtures.get(id);
      if (!fixture) throw new RangeError("Fixture not found");
      return structuredClone(fixture);
    },
    registerFixture: (fixture) => {
      fixtures.set(fixture.id, structuredClone(fixture));
      return { ...structuredClone(fixture), eventCount: fixture.events.length };
    },
  };
  const live = createLiveService({
    transport, registry, generateMatch: unexpected, buildFeedPlan: unexpected,
  });
  return { live, fixtures, registry };
}

for (const ending of ["stop", "failure", "expiry"] as const) {
  test(`real transport stop publish failure remains retryable after ${ending}`, async (t) => {
    let now = 0;
    let rejectEnd = true;
    let attempts = 0;
    const transport = createLocalTransport();
    const publish = transport.publish.bind(transport);
    transport.publish = async (envelope) => {
      await publish(envelope);
      if (envelope.kind === "match_end") {
        attempts++;
        if (rejectEnd) throw new Error("Transport acknowledgement failed");
      }
    };
    const { live, registry, fixtures } = localLive(transport);
    const removed: string[] = [];
    const { service, vision } = harness(t, {
      live, now: () => now, idleMs: 100, registerFixture: registry.registerFixture,
      unregisterFixture: (id) => { removed.push(id); fixtures.delete(id); },
    });
    const created = await service.create(metadata());
    if (ending === "stop") await service.stop(created.id);
    if (ending === "expiry") now = 100;
    if (ending === "failure") {
      await service.batch(created.id, batch());
      await called(vision, 1);
      vision.calls[0]!.reject(new Error("Model unavailable"));
    }
    const failedCleanup = await eventually(() => service.get(created.id),
      (session) => Boolean(session.error?.includes("Retry server stop")), "report retryable cleanup");
    const stage = ending === "failure" ? "failed" : "stopped";
    assert.equal(failedCleanup.stage, stage);
    assert.equal(failedCleanup.live.state, "running", "LiveService restores running after publication rejects");
    assert.equal(failedCleanup.live.matchId, created.live.matchId);
    assert.match(failedCleanup.error!, /Could not stop the video live stream\. Retry server stop\./u);
    if (ending === "failure") assert.match(failedCleanup.error!, /^Video analysis or live publication failed;/u);
    if (ending === "expiry") assert.match(failedCleanup.error!, /^Video session expired after inactivity;/u);
    assert.ok(fixtures.has(created.fixtureId), "failed stop must retain the running fixture");
    assert.deepEqual(removed, []);
    assert.equal(attempts, 1);

    const retry = await service.stop(created.id);
    assert.equal(retry.stage, stage);
    assert.equal(retry.error, failedCleanup.error, "retries preserve the original error without duplicating cleanup text");
    assert.equal(retry.live.state, "running");
    assert.equal(attempts, 2);
    rejectEnd = false;
    const recovered = await service.stop(created.id);
    assert.equal(recovered.stage, stage);
    assert.equal(recovered.live.state, "finished");
    assert.equal(recovered.error, failedCleanup.error);
    assert.equal(fixtures.has(created.fixtureId), false);
    assert.deepEqual(removed, [created.fixtureId]);
    await service.stop(created.id);
    assert.equal(attempts, 3);
    assert.deepEqual(removed, [created.fixtureId], "successful cleanup is idempotent");
    now += 100;
    await rejectsStatus(() => service.get(created.id), 404);
  });
}

test("failed expiry retains its session across sweeps until stop publication recovers", async (t) => {
  let now = 0;
  let rejectEnd = true;
  let attempts = 0;
  const transport = createLocalTransport();
  const publish = transport.publish.bind(transport);
  transport.publish = async (envelope) => {
    if (envelope.kind === "match_end") {
      attempts++;
      if (rejectEnd) throw new Error("Transport offline");
    }
    await publish(envelope);
  };
  const { live, registry, fixtures } = localLive(transport);
  const { service } = harness(t, {
    live, now: () => now, idleMs: 100,
    registerFixture: registry.registerFixture, unregisterFixture: (id) => fixtures.delete(id),
  });
  const { id, fixtureId } = await service.create(metadata());
  now = 100;
  const first = await service.get(id);
  now = 200;
  const second = await service.get(id);
  assert.equal(second.stage, "stopped");
  assert.equal(second.error, first.error);
  assert.equal(second.live.state, "running");
  assert.equal(attempts, 2);
  assert.ok(fixtures.has(fixtureId));
  rejectEnd = false;
  now = 300;
  await rejectsStatus(() => service.get(id), 404);
  assert.equal(attempts, 3);
  assert.equal(live.status().state, "finished");
  assert.equal(fixtures.has(fixtureId), false);
  await rejectsStatus(() => service.stop(id), 404);
});

for (const recovery of ["stop", "expiry"] as const) {
  test(`fixture unregister failure survives expiry and recovers via ${recovery}`, async (t) => {
    let now = 0;
    let rejectRemoval = true;
    let removals = 0;
    const { service, live } = harness(t, {
      now: () => now, idleMs: 100,
      unregisterFixture: () => {
        removals++;
        assert.equal(live.status().state, "finished", "stop must settle before unregister");
        if (rejectRemoval) throw new Error("Registry busy");
      },
    });
    const { id, fixtureId } = await service.create(metadata());
    const stopped = await service.stop(id);
    assert.match(stopped.error!, /Could not remove the video fixture\. Retry server stop\./u);
    now = 100;
    const retained = await service.get(id);
    assert.equal(retained.error, stopped.error);
    assert.equal(retained.stage, "stopped");
    assert.equal(removals, 2);
    rejectRemoval = false;
    if (recovery === "stop") {
      assert.equal((await service.stop(id)).stage, "stopped");
      await service.stop(id);
    }
    now = 200;
    await rejectsStatus(() => service.get(id), 404);
    assert.equal(removals, 3);
    assert.deepEqual(live.stops, [fixtureId]);
  });
}

for (const sameFixture of [false, true]) {
  test(`terminal stop and expiry never clean up a replacement (${sameFixture ? "same" : "different"} fixture)`, async (t) => {
    let now = 0;
    const { service, live, removed } = harness(t, { now: () => now, idleMs: 100 });
    const { id, fixtureId } = await service.create(metadata());
    live.stop = async () => {
      live.stops.push(live.value.fixtureId);
      throw new Error("Stop unavailable");
    };
    const stopped = await service.stop(id);
    live.replace();
    if (sameFixture) live.value.fixtureId = fixtureId;
    const replacement = live.status();
    const retry = await service.stop(id);
    assert.equal(retry.error, stopped.error);
    assert.deepEqual(live.status(), replacement);
    assert.deepEqual(live.stops, [fixtureId]);
    assert.deepEqual(removed, sameFixture ? [] : [fixtureId]);
    now = 100;
    if (sameFixture) {
      assert.equal((await service.get(id)).stage, "stopped");
      assert.deepEqual(removed, [], "running replacement still needs this fixture");
      live.value.state = "finished";
      now = 200;
      assert.equal((await service.stop(id)).stage, "stopped");
      assert.deepEqual(removed, [], "replacement's finished status may be provisional");
      live.value.state = "running";
      now = 300;
      assert.equal((await service.get(id)).live.state, "running");
      assert.deepEqual(removed, [], "replacement can resume after failed completion publication");
      live.value.state = "idle";
      now = 400;
      assert.equal((await service.get(id)).stage, "stopped");
      assert.deepEqual(removed, [], "fixture ownership is independent of replacement state");
      live.replace();
      now = 500;
    }
    await rejectsStatus(() => service.get(id), 404);
    assert.deepEqual(removed, [fixtureId]);
    assert.deepEqual(live.stops, [fixtureId]);
  });
}

for (const replacement of [false, true]) {
  test(`partial startup pins cleanup ownership before terminal retries (replacement: ${replacement})`, async (t) => {
    const live = new FakeLive();
    const start = live.startProgressive.bind(live);
    live.startProgressive = async (fixture) => {
      await start(fixture);
      throw new Error("Startup failed after activating stream");
    };
    const stop = live.stop.bind(live);
    live.stop = async () => {
      live.stops.push(live.value.fixtureId);
      throw new Error("Stop unavailable");
    };
    const { service, removed } = harness(t, { live });
    await rejectsStatus(() => service.create(metadata()), 503, /Could not start.*Retry server stop/u);
    const fixtureId = live.starts[0]!.id;
    const id = fixtureId.slice("video-".length);
    const failed = await service.get(id);
    assert.equal(failed.stage, "failed");
    assert.deepEqual(live.stops, [fixtureId], "partial startup fallback stops only the matching fixture");
    assert.deepEqual(removed, []);
    live.stop = stop;
    if (replacement) live.value.matchId = "new-run-same-fixture";
    const retried = await service.stop(id);
    assert.equal(retried.stage, "failed");
    assert.equal(retried.error, failed.error);
    assert.equal(retried.live.state, replacement ? "running" : "finished");
    assert.equal(live.stops.length, replacement ? 1 : 2);
    assert.deepEqual(removed, replacement ? [] : [fixtureId]);
  });
}

test("failed startup never adopts a different fixture's stream for cleanup", async (t) => {
  const live = new FakeLive();
  live.startProgressive = async (fixture) => {
    live.starts.push(fixture);
    live.replace();
    throw new Error("Another stream started first");
  };
  const { service } = harness(t, { live });
  await rejectsStatus(() => service.create(metadata()), 503);
  const id = live.starts[0]!.id.slice("video-".length);
  assert.equal((await service.stop(id)).stage, "failed");
  assert.equal(live.status().state, "running");
  assert.deepEqual(live.stops, []);
});

for (const startup of ["before activation", "after activation", "partial failure"] as const) {
  test(`stop waits for pending startup (${startup}) before confirming cleanup`, async (t) => {
    const live = new FakeLive();
    const start = live.startProgressive.bind(live);
    const stop = live.stop.bind(live);
    let fixtureId: string | undefined;
    let release!: () => void;
    live.startProgressive = async (fixture) => {
      fixtureId = fixture.id;
      if (startup !== "before activation") await start(fixture);
      await new Promise<void>((resolve) => { release = resolve; });
      if (startup === "partial failure") throw new Error("Startup acknowledgement failed");
      return startup === "before activation" ? start(fixture) : live.status();
    };
    if (startup === "partial failure") {
      live.stop = async () => {
        live.stops.push(live.value.fixtureId);
        throw new Error("Stop unavailable");
      };
    }
    const { service, removed } = harness(t, { live });
    const creating = startup === "partial failure"
      ? rejectsStatus(() => service.create(metadata()), 503, /Could not start.*Retry server stop/u)
      : service.create(metadata());
    await eventually(() => Boolean(release), Boolean, "hold startup acknowledgement");
    const id = fixtureId!.slice("video-".length);
    let stopResolved = false;
    const stopping = service.stop(id).then((session) => {
      stopResolved = true;
      return session;
    });
    const overlapping = service.stop(id);
    try {
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(stopResolved, false, "unsettled startup may still activate the stream");
      assert.deepEqual(live.stops, [], "wait until startup has pinned ownership");
      assert.deepEqual(removed, []);
    } finally {
      release();
    }
    const stopped = await stopping;
    await overlapping;
    await creating;
    assert.equal(stopped.stage, startup === "partial failure" ? "failed" : "stopped");
    assert.equal(stopped.live.state, startup === "partial failure" ? "running" : "finished");
    assert.deepEqual(live.stops, [fixtureId], "overlapping callers share post-start cleanup");
    assert.deepEqual(removed, startup === "partial failure" ? [] : [fixtureId]);
    if (startup === "partial failure") {
      assert.match(stopped.error!, /Retry server stop/u);
      live.stop = stop;
      assert.equal((await service.stop(id)).live.state, "finished");
      assert.deepEqual(removed, [fixtureId]);
    }
  });
}

test("overlapping stop requests share cleanup and unregister only once", async (t) => {
  const { service, live, removed } = harness(t);
  const { id, fixtureId } = await service.create(metadata());
  let release!: () => void;
  live.stop = async () => {
    live.stops.push(live.value.fixtureId);
    await new Promise<void>((resolve) => { release = resolve; });
    live.value.state = "finished";
    return live.status();
  };
  const first = service.stop(id);
  const second = service.stop(id);
  await eventually(() => live.stops.length, (count) => count === 1, "start shared stop");
  assert.deepEqual(removed, []);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((session) => session.stage === "stopped" && session.live.state === "finished"));
  assert.deepEqual(live.stops, [fixtureId]);
  assert.deepEqual(removed, [fixtureId]);
});

for (const publication of ["stop", "completion"] as const) {
  test(`pending ${publication} acknowledgement keeps the fixture until cleanup settles`, async (t) => {
    let rejectAcknowledgement!: (error: Error) => void;
    let attempts = 0;
    let rejectEnd = true;
    const transport = createLocalTransport();
    const publish = transport.publish.bind(transport);
    transport.publish = async (envelope) => {
      await publish(envelope);
      if (envelope.kind !== "match_end") return;
      attempts++;
      if (attempts === 1) {
        await new Promise<void>((_resolve, reject) => { rejectAcknowledgement = reject; });
      } else if (rejectEnd) throw new Error("Transport still unavailable");
    };
    const { live, registry, fixtures } = localLive(transport);
    const removed: string[] = [];
    const { service, vision } = harness(t, {
      live, registerFixture: registry.registerFixture,
      unregisterFixture: (id) => { removed.push(id); fixtures.delete(id); },
    });
    const { id, fixtureId } = await service.create(metadata(4));
    await service.batch(id, batch());
    await called(vision, 1);
    let stopping: Promise<ProgressiveVideoSession> | undefined;
    if (publication === "stop") stopping = service.stop(id);
    else {
      await service.complete(id);
      vision.calls[0]!.resolve(result());
    }
    await eventually(() => attempts, (count) => count === 1, "deliver match_end before acknowledgement");
    assert.equal(live.status().state, "finished");
    if (publication === "stop") {
      vision.calls[0]!.resolve(result());
      for (let i = 0; i < 5; i++) await tick();
    } else stopping = service.stop(id);
    let stopResolved = false;
    void stopping!.then(() => { stopResolved = true; });
    try {
      for (let i = 0; i < 5; i++) await tick();
      assert.equal(stopResolved, false, "STOP must await publication, not confirm provisional finished status");
      await rejectsStatus(() => service.create(metadata()), 409);
      assert.ok(fixtures.has(fixtureId), "finished transport state is provisional until publication settles");
      assert.deepEqual(removed, []);
    } finally {
      rejectAcknowledgement(new Error("Delayed acknowledgement failed"));
    }
    const retryable = await stopping!;
    assert.equal(retryable.stage, "stopped");
    assert.equal(retryable.live.state, "running");
    assert.match(retryable.error!, /Retry server stop/u);
    assert.equal(attempts, publication === "completion" ? 2 : 1);
    assert.ok(fixtures.has(fixtureId));
    assert.deepEqual(removed, []);
    rejectEnd = false;
    assert.equal((await service.stop(id)).live.state, "finished");
    assert.deepEqual(removed, [fixtureId]);
    await tick();
    assert.equal((await service.get(id)).live.state, "finished");
  });
}

test("completion failure cleans up without deadlocking the pump and remains retryable", async (t) => {
  let rejectEnd = true;
  let attempts = 0;
  const transport = createLocalTransport();
  const publish = transport.publish.bind(transport);
  transport.publish = async (envelope) => {
    await publish(envelope);
    if (envelope.kind === "match_end") {
      attempts++;
      if (rejectEnd) throw new Error("Completion and cleanup publication unavailable");
    }
  };
  const { live, registry, fixtures } = localLive(transport);
  const { service, vision } = harness(t, {
    live, registerFixture: registry.registerFixture, unregisterFixture: (id) => fixtures.delete(id),
  });
  const { id, fixtureId } = await service.create(metadata(4));
  await service.batch(id, batch());
  await service.complete(id);
  await called(vision, 1);
  vision.calls[0]!.resolve(result());
  const failed = await eventually(() => service.get(id),
    (session) => Boolean(session.error?.includes("Retry server stop")), "settle finalize failure cleanup");
  assert.equal(failed.stage, "failed");
  assert.equal(failed.live.state, "running");
  assert.equal(attempts, 2, "completion failure must trigger one cleanup attempt");
  assert.ok(fixtures.has(fixtureId));
  rejectEnd = false;
  assert.equal((await service.stop(id)).live.state, "finished");
  assert.equal(fixtures.has(fixtureId), false);
  const next = await service.create(metadata(4));
  await service.batch(next.id, batch());
  await service.complete(next.id);
  await called(vision, 2);
  vision.calls[1]!.resolve(result());
  await atStage(service, next.id, "complete");
});

test("real local LiveService receives incremental events and shot revisions before completion", async (t) => {
  const { live, registry, fixtures } = localLive();
  const { service, vision } = harness(t, {
    live, registerFixture: registry.registerFixture, unregisterFixture: (id) => fixtures.delete(id),
  });
  const seen: MatchEvent[] = [];
  const remove = live.addListener({ onEvent: (_view, event) => seen.push(structuredClone(event)) });
  t.after(remove);
  const { id, fixtureId } = await service.create(metadata(8));
  assert.equal(live.status().state, "running");
  await service.batch(id, batch());
  await called(vision, 1);
  vision.calls[0]!.resolve(result([detection({ frameIndex: 3, type: "shot", outcome: "miss" })]));
  const first = await analyzed(service, id, 4);
  const shot = first.events.find((event) => event.type === "shot")!;
  assert.ok(seen.some((event) => event.id === shot.id && event.revision === 1));
  assert.equal(live.status().clockSecond, 3);
  assert.equal(live.status().fixtureId, fixtureId);
  assert.equal(first.inputComplete, false);
  await service.batch(id, batch(1));
  await called(vision, 2);
  vision.calls[1]!.resolve(result([detection({ frameIndex: 4, type: "save", team: "away", shirtNumber: 1 })]));
  await analyzed(service, id, 8);
  assert.ok(seen.some((event) => event.id === shot.id && event.revision === 2 && event.outcome === "saved"));
  assert.equal(live.status().state, "running");
  await service.complete(id);
  await atStage(service, id, "complete");
  assert.equal(live.status().state, "finished");
  assert.ok(seen.some((event) => event.type === "fulltime"));
  noImages(live.current());
});

test("polling while the final live publication resolves does not cancel successful completion", async (t) => {
  const live = new FakeLive();
  let finish!: () => void;
  let finishing = false;
  live.completeProgressive = async (fixtureId) => {
    live.completions.push(fixtureId);
    live.value.state = "finished";
    finishing = true;
    await new Promise<void>((resolve) => { finish = resolve; });
    return live.status();
  };
  const { service, vision, registered, removed } = harness(t, { live });
  const { id } = await service.create(metadata(4));
  await service.batch(id, batch());
  await service.complete(id);
  await called(vision, 1);
  vision.calls[0]!.resolve(result([detection()]));
  await eventually(() => finishing, Boolean, "reach final live publication");
  const pending = await service.get(id);
  assert.equal(pending.stage, "streaming");
  assert.equal(pending.live.state, "finished", "status reflects the current transport rather than a cached snapshot");
  assert.deepEqual(removed, []);
  finish();
  const completed = await atStage(service, id, "complete");
  assert.equal(completed.events.at(-1)!.type, "fulltime");
  assert.equal(registered.length, 1);
  assert.deepEqual(removed, []);
});

test("explicit stop during completion cannot be undone by its delayed result", async (t) => {
  const live = new FakeLive();
  let finish!: () => void;
  let finishing = false;
  live.completeProgressive = async () => {
    live.value.state = "finished";
    finishing = true;
    await new Promise<void>((resolve) => { finish = resolve; });
    return live.status();
  };
  const { service, vision, removed } = harness(t, { live });
  const { id, fixtureId } = await service.create(metadata(4));
  await service.batch(id, batch());
  await service.complete(id);
  await called(vision, 1);
  vision.calls[0]!.resolve(result());
  await eventually(() => finishing, Boolean, "reach final live publication");
  let stopResolved = false;
  const stopping = service.stop(id).then((session) => {
    stopResolved = true;
    return session;
  });
  try {
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(stopResolved, false);
    assert.deepEqual(removed, []);
  } finally {
    finish();
  }
  const stopped = await stopping;
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.live.state, "finished");
  await tick();
  assert.equal((await service.get(id)).stage, "stopped");
  assert.deepEqual(removed, [fixtureId]);
});

for (const state of ["running", "finished"] as const) {
  test(`a ${state} replacement reusing the fixture cannot receive obsolete results or lose its registry entry`, async (t) => {
    const { service, vision, live, removed } = harness(t);
    const { id } = await service.create(metadata());
    await service.batch(id, batch());
    await called(vision, 1);
    live.value.matchId = "replacement-of-the-same-fixture";
    live.value.state = state;
    vision.calls[0]!.resolve(result([detection()]));
    const stopped = await atStage(service, id, "stopped");
    assert.match(stopped.error!, /replaced/iu);
    assert.equal(live.appends.length, 0);
    assert.equal(live.stops.length, 0);
    assert.deepEqual(removed, []);
  });
}

for (const ending of ["stop", "failure", "expiry"] as const) {
  test(`real local registry removes unfinished footage on ${ending}`, async (t) => {
    let now = 0;
    const { live, registry, fixtures } = localLive();
    const { service, vision } = harness(t, {
      live, now: () => now, idleMs: 100,
      registerFixture: registry.registerFixture, unregisterFixture: (id) => fixtures.delete(id),
    });
    const { id, fixtureId } = await service.create(metadata());
    assert.ok(fixtures.has(fixtureId), "real live registers its initial fixture");
    await service.batch(id, batch());
    await called(vision, 1);
    vision.calls[0]!.resolve(result([detection()]));
    await analyzed(service, id, 4);
    if (ending === "stop") await service.stop(id);
    if (ending === "expiry") {
      now = 100;
      await rejectsStatus(() => service.get(id), 404);
    }
    if (ending === "failure") {
      await service.batch(id, batch(1));
      await called(vision, 2);
      vision.calls[1]!.resolve(result([], { footageCheck: { realFootballFootage: false, reason: "animation" } }));
      await atStage(service, id, "failed");
      await eventually(() => fixtures.has(fixtureId), (registered) => !registered, "finish failed-session cleanup");
    }
    assert.equal(fixtures.has(fixtureId), false, `${ending} must unregister the unfinished fixture registered by the real LiveService`);
  });
}

function fakeDesk(): StorylineDesk {
  return {
    onEvent: () => {}, onMatchStart: () => {}, onMatchEnd: () => {},
    list: () => [], facts: () => [], review: async () => unexpected(),
    storyboard: (view) => ({ matchId: view.matchId, stateVersion: "test", chapters: [] }),
    subscribe: () => () => {}, health: () => ({ mode: "unconfigured", agents: [], retrieval: "none" }),
  };
}

const worker: VideoWorker = {
  newJobId: unexpected, jobDirectory: unexpected, submit: unexpected,
  get: () => undefined, list: () => [], remove: async () => {},
  frameFile: () => undefined, swapTeams: unexpected, addTag: unexpected, removeTag: unexpected,
  idle: async () => {}, close: async () => {},
};
const playerWorker: PlayerCamWorker = {
  newJobId: unexpected, jobDirectory: unexpected, submit: unexpected,
  get: () => undefined, list: () => [], remove: async () => {},
  frameFile: () => undefined, referenceFile: () => undefined, idle: async () => {}, close: async () => {},
};

async function withApp(t: TestContext) {
  const live = new FakeLive();
  const vision = new DeferredVision();
  const inheritedEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  let app: ReturnType<typeof createApp>;
  // createApp constructs an env-backed vision caller even when both analyzers are injected.
  // Keep this synchronous so no other test observes the temporary environment change.
  try {
    process.env.AZURE_OPENAI_ENDPOINT = "";
    app = createApp({
      narrator: createNarrator({ endpoint: "", deployment: "", apiKey: "" }),
      platform: { live, desk: fakeDesk(), close: () => live.close() },
      version: "progressive-test", logger: () => {},
      video: {
        vision, worker, playerWorker, run: async () => unexpected(),
        playerVision: { configured: false, model: "offline-test", analyzeBatch: async () => unexpected() },
      },
    });
  } finally {
    if (inheritedEndpoint === undefined) delete process.env.AZURE_OPENAI_ENDPOINT;
    else process.env.AZURE_OPENAI_ENDPOINT = inheritedEndpoint;
  }
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    await live.close();
    vision.releaseAll();
    for (let index = 0; index < 5; index++) await tick();
    for (const fixture of live.starts) unregisterFixture(fixture.id);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });
  const send = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { live, vision, send };
}

const sessionsPath = "/api/video/live-sessions";

test("app wiring supports metadata create, get, batch, complete, archive, and DELETE with correct statuses", async (t) => {
  const { send, live, vision } = await withApp(t);
  const createdResponse = await send(sessionsPath, "POST", metadata(4));
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("cache-control"), "no-store");
  const created = await createdResponse.json() as ProgressiveVideoSession;
  const path = `${sessionsPath}/${created.id}`;
  assert.equal(live.starts.length, 1);
  assert.equal(vision.calls.length, 0);
  const get = await send(path);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), created);
  const acceptedResponse = await send(`${path}/batches`, "POST", batch());
  assert.equal(acceptedResponse.status, 202);
  const accepted = await acceptedResponse.json();
  noImages(accepted);
  await called(vision, 1);
  vision.calls[0]!.resolve(result([detection()]));
  await eventually(() => live.appends.length, (length) => length === 1, "HTTP batch publishes before complete");
  assert.equal(live.completions.length, 0);
  const completion = await send(`${path}/complete`, "POST", {});
  assert.equal(completion.status, 202);
  await completion.json();
  const done = await eventually(
    async () => (await send(path)).json() as Promise<ProgressiveVideoSession>,
    (session) => session.stage === "complete", "HTTP completion drains",
  );
  assert.equal(done.analyzedFrames, 4);
  const archive = await send(`/api/fixtures/${created.fixtureId}`);
  assert.equal(archive.status, 200);
  assert.deepEqual((await archive.json()).events, done.events);
  const stopped = await send(path, "DELETE");
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).stage, "stopped");
  assert.equal(stopped.headers.get("cache-control"), "no-store");
  noImages(done);
});

test("HTTP surfaces validation, unknown sessions, missing frames, busy queues and retry conflicts", async (t) => {
  const { send, vision } = await withApp(t);
  assert.equal((await send(`${sessionsPath}/abcdef012345`)).status, 404);
  assert.equal((await send(`${sessionsPath}/bad`)).status, 400);
  assert.equal((await send(sessionsPath, "POST", { ...metadata(), rightsConfirmed: false })).status, 400);
  const created = await (await send(sessionsPath, "POST", metadata())).json() as ProgressiveVideoSession;
  const path = `${sessionsPath}/${created.id}`;
  assert.equal((await send(`${path}/complete`, "POST", {})).status, 409);
  assert.equal((await send(`${path}/batches`, "POST", batch(0, 0, 1, 12, "!!!!"))).status, 400);
  assert.equal((await send(`${path}/batches`, "POST", batch())).status, 202);
  await called(vision, 1);
  assert.equal((await send(`${path}/batches`, "POST", batch(1))).status, 202);
  assert.equal((await send(`${path}/batches`, "POST", batch(2))).status, 429);
  assert.equal((await send(`${path}/batches`, "POST", batch())).status, 202);
  assert.equal((await send(`${path}/batches`, "POST", batch(0, 0, 4, 12, jpeg(12, 0x42)))).status, 409);
});

test("app routes only POST frame batches through the 1.5 MiB parser", async (t) => {
  const { send, vision } = await withApp(t);
  const created = await (await send(sessionsPath, "POST", metadata())).json() as ProgressiveVideoSession;
  const path = `${sessionsPath}/${created.id}/batches`;
  const maximumBatch = batch(0, 0, 4, 12, jpeg(256 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify(maximumBatch)) > 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumBatch)) < 1.5 * 1024 * 1024);
  assert.equal((await send(path, "POST", maximumBatch)).status, 202);
  await called(vision, 1);
  const bodyOfSize = (size: number) => ({ padding: "x".repeat(size - Buffer.byteLength(JSON.stringify({ padding: "" }))) });
  const exact = await send(path, "POST", bodyOfSize(1.5 * 1024 * 1024));
  assert.equal(exact.status, 400, "exact parser limit reaches strict payload validation, not 413");
  const oversized = await send(path, "POST", bodyOfSize(1.5 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /1\.5mb/iu);
  const regularExact = await send(sessionsPath, "POST", bodyOfSize(16 * 1024));
  assert.equal(regularExact.status, 400);
  const regularOver = await send(sessionsPath, "POST", bodyOfSize(16 * 1024 + 1));
  assert.equal(regularOver.status, 413);
});

const smallBodyRoutes: [string, string][] = [
  ["POST", sessionsPath],
  ["POST", `${sessionsPath}/abcdef012345/complete`],
  ["DELETE", `${sessionsPath}/abcdef012345`],
  ["PUT", `${sessionsPath}/abcdef012345/batches`],
  ["POST", `${sessionsPath}/invalid-id/batches`],
  ["POST", `${sessionsPath}/ABCDEF012345/batches`],
  ["POST", `${sessionsPath}/abcdef012345/batches/extra`],
  ["POST", "/api/analyze"], ["POST", "/api/narrate"], ["POST", "/api/live/start"],
  ["POST", "/api/video/jobs"], ["POST", "/api/playercam/jobs"], ["POST", "/api/unknown"],
];
for (const [method, path] of smallBodyRoutes) {
  test(`non-frame route retains 16 KiB cap: ${method} ${path}`, async (t) => {
    const { send } = await withApp(t);
    const response = await send(path, method, { padding: "x".repeat(16 * 1024) });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /16kb/iu);
  });
}

test("frame route matcher does not grant the large parser to lookalike paths or other verbs", () => {
  const path = `${sessionsPath}/abcdef012345/batches`;
  assert.equal(isProgressiveFrameRequest({ method: "POST", path }), true);
  assert.equal(isProgressiveFrameRequest({ method: "POST", path: `${path}/` }), true);
  for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"]) {
    assert.equal(isProgressiveFrameRequest({ method, path }), false);
  }
  for (const invalid of [path.toUpperCase(), `${path}x`, `${path}/extra`, `/prefix${path}`, path.replace("abcdef012345", "abcdef01234")]) {
    assert.equal(isProgressiveFrameRequest({ method: "POST", path: invalid }), false);
  }
});

test("create limiter allows six creations per IP per TEN minutes; reads and batches remain available", async (t) => {
  const { send, live } = await withApp(t);
  let last: ProgressiveVideoSession | undefined;
  for (let index = 0; index < 6; index++) {
    const response = await send(sessionsPath, "POST", metadata());
    assert.equal(response.status, 201, `creation ${index + 1} is permitted`);
    assert.equal(response.headers.get("ratelimit-limit"), "6");
    assert.match(response.headers.get("ratelimit-policy") ?? "", /6;w=600/u);
    last = await response.json() as ProgressiveVideoSession;
    if (index < 5) assert.equal((await send(`${sessionsPath}/${last.id}`, "DELETE")).status, 200);
  }
  const denied = await send(sessionsPath, "POST", metadata());
  assert.equal(denied.status, 429);
  assert.match((await denied.json()).error, /too many video live sessions/iu);
  assert.ok(Number(denied.headers.get("retry-after")) > 0 && Number(denied.headers.get("retry-after")) <= 600);
  assert.equal(live.starts.length, 6, "limiter prevents a seventh service create");
  assert.equal((await send(`${sessionsPath}/${last!.id}`)).status, 200);
  assert.equal((await send(`${sessionsPath}/${last!.id}/batches`, "POST", batch())).status, 202);
});
