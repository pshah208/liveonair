import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import test, { after } from "node:test";

import { createApp } from "../server/app.js";
import { analyzeFixture } from "../server/engine.js";
import { parseLiveEnvelope } from "../server/live/transport.js";
import { uploadExtension } from "../server/routes/video.js";
import { HttpError } from "../server/validation.js";
import { buildVideoFixture, MIN_CONFIDENCE } from "../server/video/events.js";
import { sampleTimestamps, videoSampleInterval, type RunCommand } from "../server/video/ffmpeg.js";
import { buildVisionMessages, parseVisionResult, VISION_JSON_SCHEMA, VISION_INSTRUCTIONS, type VisionAnalyzer, type VisionBatchResult } from "../server/video/vision.js";
import { BATCH_SIZE, createVideoWorker, type VideoWorker } from "../server/video/worker.js";
import { buildHighlightReel } from "../shared/highlights.js";
import type { MatchFixture } from "../shared/types.js";
import { MAX_FRAME_INTERVAL_SECONDS, MAX_UPLOAD_BYTES, MAX_VIDEO_FRAMES, MAX_VIDEO_SECONDS, type VideoFrame, type VideoJob, type VideoJobRequest, type VisionDetection } from "../shared/video.js";
import { uploadPlayerCam, uploadVideo } from "../src/api.js";

const request: VideoJobRequest = { home: { name: "Blue Town", kit: "blue shirts" }, away: { name: "Red City", kit: "red shirts" } };
const frames: VideoFrame[] = Array.from({ length: 30 }, (_, index) => ({ index, timestampSeconds: 1 + index * 2 }));

function detection(partial: Partial<VisionDetection>): VisionDetection {
  return { frameIndex: 0, type: "pass", team: "home", shirtNumber: null, outcome: "complete", x: 50, y: 50, confidence: 0.9, description: "A pass.", ...partial };
}

test("builder gates confidence and team, de-duplicates and keeps football consistency", () => {
  const built = buildVideoFixture({
    jobId: "abc123def456",
    request,
    durationSeconds: 60.4,
    frames,
    detections: [
      detection({ frameIndex: 2, type: "pass", confidence: 0.95 }),
      detection({ frameIndex: 3, type: "pass", confidence: MIN_CONFIDENCE - 0.01 }),
      detection({ frameIndex: 4, type: "tackle", team: "unknown" }),
      detection({ frameIndex: 10, type: "goal", team: "away", shirtNumber: 9, x: 140 }),
      detection({ frameIndex: 11, type: "goal", team: "away", shirtNumber: 9 }),
      detection({ frameIndex: 20, type: "shot", team: "home", shirtNumber: 7, outcome: "miss" }),
      detection({ frameIndex: 21, type: "save", team: "away", shirtNumber: 1 }),
      detection({ frameIndex: 99, type: "red_card" }),
    ],
  });
  const { fixture } = built;
  const types = fixture.events.map((event) => event.type);
  assert.equal(fixture.id, "video-abc123def456");
  assert.equal(fixture.durationSeconds, 61);
  assert.equal(types[0], "kickoff");
  assert.equal(types.at(-1), "fulltime");
  assert.equal(types.filter((type) => type === "goal").length, 1, "repeat goal report within 20 s is merged");
  assert.equal(types.filter((type) => type === "pass").length, 1, "low-confidence pass dropped");
  assert.ok(!types.includes("tackle"), "unknown-team tackle dropped");
  assert.ok(!types.includes("red_card"), "detection citing an unknown frame dropped");

  const goal = fixture.events.find((event) => event.type === "goal")!;
  const shotBeforeGoal = fixture.events.find((event) => event.type === "shot" && event.teamId === "away");
  assert.ok(shotBeforeGoal && shotBeforeGoal.outcome === "success", "goal gets a successful shot");
  assert.equal(goal.x, 100, "positions are clamped");
  assert.equal(goal.playerId, "away-9");
  assert.ok(fixture.away.players.some((player) => player.id === "away-9" && player.name === "RED #9"));

  const save = fixture.events.find((event) => event.type === "save")!;
  const homeShot = fixture.events.find((event) => event.type === "shot" && event.teamId === "home")!;
  assert.equal(save.relatedEventId, homeShot.id);
  assert.equal(homeShot.outcome, "saved");

  assert.equal(built.evidence.length, built.acceptedCount);
  assert.ok(built.evidence.every((item) => fixture.events.some((event) => event.id === item.eventId)));

  // Every event must pass the Eventstream envelope contract, and the engine must accept the fixture.
  for (const [index, event] of fixture.events.entries()) {
    parseLiveEnvelope({ kind: "match_event", matchId: "m", sequence: index + 1, publishedAt: new Date(0).toISOString(), event });
  }
  const snapshot = analyzeFixture(fixture, { fixtureId: fixture.id, atSecond: fixture.durationSeconds, persona: "analyst", language: "en" });
  assert.deepEqual(snapshot.score, { home: 0, away: 1 });
});

test("producer tags are trusted, win over model duplicates and keep the rules", () => {
  const built = buildVideoFixture({
    jobId: "tagged",
    request,
    durationSeconds: 60,
    frames,
    detections: [
      detection({ frameIndex: 10, type: "shot", team: "home", outcome: "miss", confidence: 0.9 }), // 21 s
      detection({ frameIndex: 12, type: "goal", team: "home", confidence: 0.6 }), // 25 s, duplicate of the tag
    ],
    manualTags: [
      { id: "aaaa0001", type: "goal", team: "home", second: 23, shirtNumber: 9, note: "Header" },
      { id: "aaaa0002", type: "yellow_card", team: "away", second: 500, shirtNumber: null, note: "" },
    ],
  });
  const goals = built.fixture.events.filter((event) => event.type === "goal");
  assert.equal(goals.length, 1, "the model's report of the same goal is dropped");
  assert.equal(goals[0]!.playerId, "home-9");
  assert.equal(goals[0]!.minute * 60 + goals[0]!.second, 23);
  assert.equal(built.fixture.events.find((event) => event.type === "shot")!.outcome, "success", "the model's shot becomes the scoring shot");
  const card = built.fixture.events.find((event) => event.type === "yellow_card")!;
  assert.equal(card.minute * 60 + card.second, 59, "tag time is clamped inside the clip");
  const proof = built.evidence.find((item) => item.eventId === goals[0]!.id)!;
  assert.deepEqual([proof.source, proof.tagId, proof.confidence, proof.description, proof.frameIndex], ["manual", "aaaa0001", 1, "Header", 11]);
  assert.equal(built.acceptedCount, 1, "only model detections count towards accepted");
  assert.equal(built.fixture.correctionEventId, goals[0]!.id);

  // Footage fixtures have no xG, so the recap still picks up attempts and saves.
  const reel = buildHighlightReel(built.fixture, [], { language: "en" });
  assert.deepEqual(reel.clips.map((clip) => clip.kind), ["goal", "booking"]);
  const chances = buildHighlightReel(buildVideoFixture({ jobId: "chance", request, durationSeconds: 60, frames, detections: [
    detection({ frameIndex: 5, type: "shot", team: "away", outcome: "miss" }), // 11 s
    detection({ frameIndex: 25, type: "save", team: "away" }), // 51 s
  ] }).fixture);
  assert.deepEqual(chances.clips.map((clip) => clip.kind), ["big_chance", "key_save"]);
  assert.match(chances.clips[0]!.caption, /goes for goal/u);
  assert.doesNotMatch(chances.clips.map((clip) => clip.caption).join(" "), /xG/u);
});

test("vision messages carry each frame with its index and kit context; results only cite sent frames", () => {
  const messages = buildVisionMessages({ frames: [{ index: 4, timestampSeconds: 9, jpegBase64: "AAA" }], request, intervalSeconds: 2 });
  const user = messages[1]!.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.match(user[0]!.text!, /Blue Town, wearing blue shirts/u);
  assert.equal(user[1]!.text, "frameIndex 4 at 9.0 s");
  assert.equal(user[2]!.image_url!.url, "data:image/jpeg;base64,AAA");

  const parsed = parseVisionResult({
    footageCheck: { realFootballFootage: true, reason: "Match footage" },
    kits: { home: "blue", away: "red" },
    detections: [detection({ frameIndex: 4 }), detection({ frameIndex: 5 })],
  }, new Set([4]));
  assert.equal(parsed.detections.length, 1);
  assert.throws(() => parseVisionResult({ footageCheck: { realFootballFootage: true, reason: "" }, kits: { home: "", away: "" }, detections: [{ ...detection({}), type: "dribble" }] }, new Set([0])));
});

test("footage categories are required by the model schema but optional for legacy runtime results", () => {
  const schema = VISION_JSON_SCHEMA.properties.footageCheck;
  assert.ok(schema.required.some((field) => field === "category"));
  assert.deepEqual(schema.properties.category.enum, ["match", "broadcast_graphics", "unsupported"]);
  const base = { kits: { home: "", away: "" }, detections: [] };
  const checks: VisionBatchResult["footageCheck"][] = [
    { realFootballFootage: true, reason: "Legacy camera footage" },
    { realFootballFootage: false, reason: "Legacy rejection" },
    { realFootballFootage: true, category: "match", reason: "Camera footage" },
    { realFootballFootage: false, category: "broadcast_graphics", reason: "A transition card." },
    { realFootballFootage: false, category: "unsupported", reason: "Animation" },
  ];
  for (const footageCheck of checks) {
    assert.deepEqual(parseVisionResult({ ...base, footageCheck }, new Set([0])).footageCheck, footageCheck);
  }
  for (const footageCheck of [
    { realFootballFootage: false, category: "match", reason: "Contradiction" },
    { realFootballFootage: true, category: "broadcast_graphics", reason: "Contradiction" },
    { realFootballFootage: true, category: "unsupported", reason: "Contradiction" },
    { realFootballFootage: false, category: "logo", reason: "Football broadcast graphics" },
    { realFootballFootage: false, category: null, reason: "Football broadcast graphics" },
  ]) {
    assert.throws(() => parseVisionResult({ ...base, footageCheck }, new Set([0])));
  }
});

test("vision instructions distinguish football broadcasts from unsupported content and gate mixed-frame evidence", () => {
  assert.match(VISION_INSTRUCTIONS, /team logos, lineups, title graphics or football studio coverage/u);
  assert.match(VISION_INSTRUCTIONS, /test patterns, video games \(even football games\)/u);
  assert.match(VISION_INSTRUCTIONS, /detect events ONLY on the genuine match frames/u);
  assert.match(VISION_INSTRUCTIONS, /never inferred from logos, graphics or studio clothing/u);
  assert.match(VISION_INSTRUCTIONS, /broadcast_graphics or unsupported, return no detections/u);
});

test("frame sampling spaces frames evenly inside the clip", () => {
  const times = sampleTimestamps(120, 2, 60);
  assert.equal(times.length, 60);
  assert.equal(times[0], 1);
  assert.ok(times.at(-1)! < 120);
  assert.equal(sampleTimestamps(5, 2, 60).length, 2);
});

test("video limits allow fifteen minutes, 500 MiB and 300 frames in batches of twelve", () => {
  assert.equal(MAX_VIDEO_SECONDS, 900);
  assert.equal(MAX_UPLOAD_BYTES, 500 * 1024 * 1024);
  assert.equal(MAX_VIDEO_FRAMES, 300);
  assert.equal(MAX_FRAME_INTERVAL_SECONDS, 3);
  assert.equal(BATCH_SIZE, 12);
});

test("shared sampling preserves short clips and covers the end of fifteen-minute clips", () => {
  for (const duration of [0.5, 5, 30, 48, 60, 90, 120, 180]) {
    const originalInterval = Math.max(1, duration / 60);
    assert.equal(videoSampleInterval(duration), originalInterval, `${duration} s interval`);
    assert.deepEqual(
      sampleTimestamps(duration, videoSampleInterval(duration), MAX_VIDEO_FRAMES),
      sampleTimestamps(duration, originalInterval, 60),
      `${duration} s retains the original frame count and timestamps`,
    );
  }
  for (const duration of [181, 300, 600, 899, 900, 901]) {
    const interval = videoSampleInterval(duration);
    if (duration <= 900) assert.equal(interval, 3);
    const times = sampleTimestamps(duration, interval, MAX_VIDEO_FRAMES);
    assert.equal(times.length, Math.min(300, Math.floor(duration / 3)), `${duration} s frame budget`);
    assert.ok(times[0]! > 0);
    assert.ok(times.at(-1)! < duration && times.at(-1)! > duration - 3, "sampling reaches the end, not just the first three minutes");
    assert.ok(times.every((second, index) => index === 0 || second > times[index - 1]!));
    if (duration === 900) assert.deepEqual([times[0], times.at(-1)], [1.5, 898.5]);
  }
});

test("shared upload headers accept exactly 500 MiB and reject one byte over with 413", () => {
  const headers = (size: number) => ({
    header: (name: string) => ({ "content-type": "video/mp4", "content-length": String(size) })[name],
  }) as Parameters<typeof uploadExtension>[0];
  for (const size of [MAX_UPLOAD_BYTES - 1, MAX_UPLOAD_BYTES]) {
    assert.equal(uploadExtension(headers(size)), "mp4");
  }
  assert.throws(
    () => uploadExtension(headers(MAX_UPLOAD_BYTES + 1)),
    (error: unknown) => error instanceof HttpError && error.status === 413 && /500/u.test(error.message),
  );
});

test("browser uploads enforce the shared byte limit before sending either video mode", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const sent: { url: string; file: File }[] = [];
  let constructed = 0;
  class FakeXhr {
    upload = { onprogress: null };
    status = 202;
    responseText = JSON.stringify({ id: "accepted" });
    onload?: () => void;
    url = "";
    constructor() { constructed += 1; }
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send(file: File) { sent.push({ url: this.url, file }); this.onload?.(); }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXhr });
  try {
    const uploaders = [
      { path: "/api/video/jobs?", upload: (file: File) => uploadVideo(file, request, () => {}) },
      { path: "/api/player-cam/jobs?", upload: (file: File) => uploadPlayerCam(file, { name: "Maya", number: 9, kit: "red", anchor: null }, () => {}) },
    ];
    for (const { path, upload } of uploaders) {
      for (const size of [MAX_UPLOAD_BYTES - 1, MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES + 1]) {
        const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
        Object.defineProperty(file, "size", { value: size });
        const before = constructed;
        if (size > MAX_UPLOAD_BYTES) {
          await assert.rejects(async () => upload(file), /500/u);
          assert.equal(constructed, before, "oversized files never create an XHR");
        } else {
          assert.equal((await upload(file)).id, "accepted");
          assert.equal(constructed, before + 1);
          assert.ok(sent.at(-1)!.url.startsWith(path));
          assert.equal(sent.at(-1)!.file, file);
        }
      }
    }
    assert.equal(sent.length, 4);
  } finally {
    if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  }
});

type VisionInput = Parameters<VisionAnalyzer["analyzeBatch"]>[0];

function fakeVision(results: (batch: number, input: VisionInput) => Partial<VisionBatchResult>): VisionAnalyzer & { calls: number; inputs: VisionInput[] } {
  const analyzer = {
    configured: true,
    model: "test-vision",
    calls: 0,
    inputs: [] as VisionInput[],
    async analyzeBatch(input: VisionInput): Promise<VisionBatchResult> {
      const batch = analyzer.calls++;
      analyzer.inputs.push(input);
      return {
        footageCheck: { realFootballFootage: true, reason: "ok" },
        kits: { home: "blue", away: "red" },
        detections: [detection({ frameIndex: input.frames[0]!.index, type: "pass" })],
        usage: { inputTokens: 100, outputTokens: 10 },
        ...results(batch, input),
      };
    },
  };
  return analyzer;
}

function workerFor(vision: VisionAnalyzer, durationSeconds: number, registered: MatchFixture[] = []) {
  const workRoot = mkdtempSync(resolve(".matchlens-video-test-"));
  const unregistered: string[] = [];
  const worker = createVideoWorker({
    vision,
    registerFixture: (fixture) => registered.push(fixture),
    unregisterFixture: (id) => unregistered.push(id),
    workRoot,
    probe: async () => ({ durationSeconds, width: 1280, height: 720, codec: "h264" }),
    extract: async ({ timestamps, onFrame }) => timestamps.map((timestampSeconds, index) => { onFrame?.(index + 1); return { index, timestampSeconds }; }),
    readFrame: async () => Buffer.from("jpeg"),
  });
  const source = resolve(workRoot, "source.mp4");
  writeFileSync(source, "video");
  return { worker, workRoot, source, unregistered };
}

test("worker runs probe, frames, vision batches and registers a fixture", async () => {
  const registered: MatchFixture[] = [];
  const vision = fakeVision((batch) => (batch === 1 ? { detections: [detection({ frameIndex: 14, type: "goal", team: "away", shirtNumber: 10 })] } : {}));
  const { worker, workRoot, source, unregistered } = workerFor(vision, 90, registered);
  try {
    worker.submit({ jobId: "aaaaaaaaaaaa", sourcePath: source, fileName: "clip.mp4", sizeBytes: 5, request });
    await worker.idle();
    const job = worker.get("aaaaaaaaaaaa") as VideoJob;
    assert.equal(job.stage, "ready", job.error);
    assert.equal(job.frames.length, 60);
    assert.equal(job.batchesTotal, 5);
    assert.equal(vision.calls, 5);
    assert.ok(vision.inputs.every((input) => input.intervalSeconds === 1.5));
    assert.equal(job.usage.inputTokens, 500);
    assert.equal(existsSync(source), false, "source is removed after success");
    assert.equal(registered[0]!.id, "video-aaaaaaaaaaaa");
    assert.ok(job.events.some((event) => event.type === "goal" && event.teamId === "away"));

    const swapped = worker.swapTeams("aaaaaaaaaaaa");
    assert.ok(swapped.events.some((event) => event.type === "goal" && event.teamId === "home"), "swap moves detections to the other side");
    assert.deepEqual(swapped.kits, { home: "red shirts", away: "blue shirts" });
    assert.equal(swapped.request.home.name, "Blue Town", "names stay where the user typed them");
    assert.equal(registered.at(-1)!.events.find((event) => event.type === "goal")!.teamId, "home");

    // Producer tags: limited, validated against the clip, flipped by swap, removable.
    let tagged = worker.addTag("aaaaaaaaaaaa", { type: "goal", team: "away", second: 70, shirtNumber: 7, note: "" });
    assert.equal(tagged.manualTags.length, 1);
    assert.ok(tagged.evidence.some((item) => item.source === "manual" && item.tagId === tagged.manualTags[0]!.id));
    assert.ok(registered.at(-1)!.events.some((event) => event.type === "goal" && event.playerId === "away-7"), "tag is in the re-registered fixture");
    assert.throws(() => worker.addTag("aaaaaaaaaaaa", { type: "foul", team: "home", second: 95, shirtNumber: null, note: "" }), /after the end/u);
    for (let index = 0; index < 4; index += 1) tagged = worker.addTag("aaaaaaaaaaaa", { type: "foul", team: "home", second: 5 + index * 10, shirtNumber: null, note: "" });
    assert.throws(() => worker.addTag("aaaaaaaaaaaa", { type: "foul", team: "home", second: 80, shirtNumber: null, note: "" }), /up to 5/u);
    const reswapped = worker.swapTeams("aaaaaaaaaaaa");
    assert.equal(reswapped.manualTags[0]!.team, "home");
    const removed = worker.removeTag("aaaaaaaaaaaa", reswapped.manualTags[0]!.id);
    assert.equal(removed.manualTags.length, 4);
    assert.ok(!removed.events.some((event) => event.playerId === "home-7"));

    const [summary] = worker.list();
    assert.deepEqual([summary!.id, summary!.stage, summary!.manualTagCount, summary!.title], ["aaaaaaaaaaaa", "ready", 4, "Blue Town vs Red City"]);
    await worker.remove("aaaaaaaaaaaa");
    assert.equal(worker.get("aaaaaaaaaaaa"), undefined);
    assert.equal(worker.list().length, 0);
    assert.deepEqual(unregistered, ["video-aaaaaaaaaaaa"]);
    assert.equal(worker.frameFile("aaaaaaaaaaaa", 0), undefined);
  } finally {
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

for (const durationSeconds of [900, 901]) {
  test(`video worker processes all 300 frames at ${durationSeconds} seconds, including the last batch`, async () => {
    const registered: MatchFixture[] = [];
    const vision = fakeVision((_batch, input) => ({
      detections: input.frames.filter((frame) => frame.index === 299).map((frame) => detection({ frameIndex: frame.index, type: "goal", team: "away", shirtNumber: 9 })),
    }));
    const { worker, workRoot, source } = workerFor(vision, durationSeconds, registered);
    try {
      worker.submit({ jobId: "dddddddddddd", sourcePath: source, fileName: "fifteen-minutes.mp4", sizeBytes: 5, request });
      await worker.idle();
      const job = worker.get("dddddddddddd")!;
      assert.equal(job.stage, "ready", job.error);
      assert.equal(job.durationSeconds, durationSeconds);
      assert.equal(job.frames.length, 300);
      assert.equal(job.batchesTotal, 25);
      assert.equal(job.batchesDone, 25);
      assert.equal(vision.calls, 25);
      assert.ok(vision.inputs.every((input) => input.frames.length === 12 && input.intervalSeconds === 3));
      assert.deepEqual(vision.inputs.flatMap((input) => input.frames.map((frame) => frame.index)), Array.from({ length: 300 }, (_, index) => index));
      assert.deepEqual(job.usage, { inputTokens: 2500, outputTokens: 250 });
      const last = job.frames.at(-1)!;
      assert.ok(last.timestampSeconds > durationSeconds - 3 && last.timestampSeconds < durationSeconds);
      const goal = job.events.find((event) => event.type === "goal")!;
      assert.ok(goal, "a detection from the final batch becomes an event");
      assert.ok(goal.minute * 60 + goal.second >= durationSeconds - 3);
      assert.ok(job.evidence.some((item) => item.eventId === goal.id && item.frameIndex === 299 && item.timestampSeconds === last.timestampSeconds));
      assert.equal(registered.length, 1);
      assert.equal(registered[0]!.durationSeconds, durationSeconds);
      assert.ok(registered[0]!.events.some((event) => event.id === goal.id));
      assert.equal(existsSync(source), false, "source is removed before idle resolves");
    } finally {
      await worker.close();
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
}

test("worker fails closed on non-football footage and rejects over-long clips", async () => {
  const notFootball = fakeVision(() => ({ footageCheck: { realFootballFootage: false, reason: "A colour test pattern" } }));
  const first = workerFor(notFootball, 30);
  try {
    first.worker.submit({ jobId: "bbbbbbbbbbbb", sourcePath: first.source, fileName: "bars.mp4", sizeBytes: 5, request });
    await first.worker.idle();
    const job = first.worker.get("bbbbbbbbbbbb")!;
    assert.equal(job.stage, "rejected");
    assert.match(job.error!, /test pattern/u);
    assert.equal(notFootball.calls, 1, "stops after the first batch");
    assert.equal(job.fixtureId, undefined);
    assert.equal(existsSync(first.source), false, "source is removed after footage rejection");
  } finally {
    await first.worker.close();
  }

  const vision = fakeVision(() => ({}));
  const registered: MatchFixture[] = [];
  const long = workerFor(vision, 902, registered);
  try {
    long.worker.submit({ jobId: "cccccccccccc", sourcePath: long.source, fileName: "long.mp4", sizeBytes: 5, request });
    await long.worker.idle();
    const job = long.worker.get("cccccccccccc")!;
    assert.equal(job.stage, "failed");
    assert.match(job.error!, /limit is 900 s/u);
    assert.equal(vision.calls, 0, "duration is rejected before vision");
    assert.equal(job.frames.length, 0, "duration is rejected before frame extraction");
    assert.equal(registered.length, 0);
    assert.equal(existsSync(long.source), false, "source is removed after duration rejection");
  } finally {
    await long.worker.close();
  }
});

const staticDir = mkdtempSync(resolve(".matchlens-video-static-"));
writeFileSync(resolve(staticDir, "index.html"), "<!doctype html><html><body></body></html>", "utf8");
after(() => rmSync(staticDir, { recursive: true, force: true }));

async function withVideoServer(vision: VisionAnalyzer, handler: (baseUrl: string, worker: VideoWorker) => Promise<void>, durationSeconds?: number) {
  const workRoot = mkdtempSync(resolve(".matchlens-video-api-"));
  const run: RunCommand = async (command) => command === "ffprobe" && durationSeconds !== undefined
    ? JSON.stringify({ format: { duration: String(durationSeconds) }, streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }] })
    : "";
  const worker = createVideoWorker({ vision, workRoot, registerFixture: () => {}, run, readFrame: async () => Buffer.from("jpeg") });
  const app = createApp({ staticDir, version: "test", logger: () => {}, video: { vision, worker, run } });
  const server = http.createServer(app);
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await handler(`http://127.0.0.1:${port}`, worker);
  } finally {
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
}

test("video API validates uploads and job state", async () => {
  await withVideoServer(fakeVision(() => ({})), async (baseUrl, worker) => {
    const health = await (await fetch(`${baseUrl}/api/video/health`)).json();
    assert.deepEqual(health, { visionConfigured: true, ffmpeg: true, maxUploadBytes: 500 * 1024 * 1024, maxVideoSeconds: 900, maxFrames: 300 });

    const query = "fileName=clip.mp4&homeName=Blue%20Town&awayName=Red%20City";
    const wrongType = await fetch(`${baseUrl}/api/video/jobs?${query}`, { method: "POST", headers: { "content-type": "image/png" }, body: "x" });
    assert.equal(wrongType.status, 415);

    const badName = await fetch(`${baseUrl}/api/video/jobs?fileName=a.mp4&homeName=%3Cscript%3E&awayName=Red`, { method: "POST", headers: { "content-type": "video/mp4" }, body: "x" });
    assert.equal(badName.status, 400);

    const created = await fetch(`${baseUrl}/api/video/jobs?${query}`, { method: "POST", headers: { "content-type": "video/mp4" }, body: Buffer.from("fake video bytes") });
    assert.equal(created.status, 202);
    const job = await created.json() as VideoJob;
    assert.match(job.id, /^[a-f0-9]{12}$/u);
    assert.equal(job.request.home.name, "Blue Town");

    const fetched = await fetch(`${baseUrl}/api/video/jobs/${job.id}`);
    assert.equal(fetched.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/not-an-id`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/${job.id}/frames/500`)).status, 404);

    const tagBody = JSON.stringify({ type: "goal", team: "home", second: 5 });
    const tagHeaders = { "content-type": "application/json" };
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/${job.id}/tags`, { method: "POST", headers: tagHeaders, body: tagBody })).status, 409, "cannot tag before processing finishes");
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/ffffffffffff/tags`, { method: "POST", headers: tagHeaders, body: tagBody })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/${job.id}/tags/zz`, { method: "DELETE" })).status, 409);

    const listed = await (await fetch(`${baseUrl}/api/video/jobs`)).json() as { id: string }[];
    assert.ok(listed.some((item) => item.id === job.id));
    await worker.idle();
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/${job.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/${job.id}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/video/jobs/${job.id}`, { method: "DELETE" })).status, 404);
  });
});

test("video API processes a fifteen-minute upload and accepts tags at 899 and 900, not 901", async () => {
  const vision = fakeVision((_batch, input) => ({
    detections: input.frames.filter((frame) => frame.index === 299).map((frame) => detection({ frameIndex: frame.index, type: "shot", team: "away", outcome: "miss" })),
  }));
  await withVideoServer(vision, async (baseUrl, worker) => {
    const created = await fetch(`${baseUrl}/api/video/jobs?fileName=long.mp4&homeName=Blue&awayName=Red`, {
      method: "POST", headers: { "content-type": "video/mp4" }, body: Buffer.from("fake video"),
    });
    assert.equal(created.status, 202);
    const { id } = await created.json() as VideoJob;
    await worker.idle();
    const job = await (await fetch(`${baseUrl}/api/video/jobs/${id}`)).json() as VideoJob;
    assert.equal(job.stage, "ready", job.error);
    assert.equal(job.durationSeconds, 900);
    assert.equal(job.frames.length, 300);
    assert.equal(job.batchesDone, 25);
    assert.equal(vision.calls, 25);
    assert.ok(job.events.some((event) => event.type === "shot" && event.minute * 60 + event.second >= 898));
    assert.equal(existsSync(resolve(worker.jobDirectory(id), "source.mp4")), false);
    for (const second of [899, 900]) {
      const response = await fetch(`${baseUrl}/api/video/jobs/${id}/tags`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: second === 899 ? "goal" : "yellow_card", team: "home", second, shirtNumber: 9 }),
      });
      assert.equal(response.status, 201, `tag at ${second} s`);
      const tagged = await response.json() as VideoJob;
      const tag = tagged.manualTags.find((item) => item.second === second)!;
      assert.ok(tag);
      assert.ok(tagged.evidence.some((item) => item.tagId === tag.id && item.frameIndex === 299));
    }
    const invalid = await fetch(`${baseUrl}/api/video/jobs/${id}/tags`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "foul", team: "home", second: 901 }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: string }).error, /second/u);
    assert.equal(worker.get(id)!.manualTags.length, 2, "invalid tags do not mutate the ready job");
  }, 900);
});

test("video API refuses uploads when vision is not configured", async () => {
  const unconfigured: VisionAnalyzer = { configured: false, model: "none", analyzeBatch: async () => { throw new Error("no"); } };
  await withVideoServer(unconfigured, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/video/jobs?fileName=a.mp4&homeName=A&awayName=B`, { method: "POST", headers: { "content-type": "video/mp4" }, body: "x" });
    assert.equal(response.status, 503);
  });
});
