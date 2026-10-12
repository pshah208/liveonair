import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import test, { after } from "node:test";

import { createApp } from "../server/app.js";
import type { RunCommand } from "../server/video/ffmpeg.js";
import { buildPlayerMoments, MIN_PLAYER_CONFIDENCE } from "../server/video/playerMoments.js";
import { buildPlayerMessages, parsePlayerResult, type PlayerVisionAnalyzer, type PlayerVisionResult } from "../server/video/playerVision.js";
import { createPlayerCamWorker, type PlayerCamWorker } from "../server/video/playerWorker.js";
import { boxAt, type PlayerCamJob, type PlayerCamRequest, type PlayerSighting } from "../shared/playercam.js";
import type { VideoFrame } from "../shared/video.js";

const request: PlayerCamRequest = { name: "Maya", number: 9, kit: "red shirt", anchor: null };
const frames: VideoFrame[] = Array.from({ length: 30 }, (_, index) => ({ index, timestampSeconds: 1 + index * 2 }));
const box = { x: 40, y: 30, w: 6, h: 20 };

function sighting(frameIndex: number, partial: Partial<PlayerSighting> = {}): PlayerSighting {
  return { frameIndex, visible: true, box, action: "off_ball", confidence: 0.8, description: "Player jogs back.", ...partial };
}

test("player moments group involvement, pad, merge and rank; low confidence is ignored", () => {
  const sightings = [
    sighting(2, { action: "dribble" }), sighting(3, { action: "dribble" }), // 5 s, 7 s
    sighting(4), // off-ball, not a moment
    sighting(10, { action: "shot", confidence: 0.9, description: "Shoots low from the edge of the box." }), // 21 s
    sighting(20, { action: "pass", confidence: MIN_PLAYER_CONFIDENCE - 0.1 }), // too unsure
    sighting(25, { action: "tackle", box: { x: 70, y: 40, w: 6, h: 20 } }), // 51 s
    sighting(26, { visible: false, box: null }),
  ];
  const { moments, track } = buildPlayerMoments({ request, frames, sightings, durationSeconds: 60, intervalSeconds: 2 });
  assert.deepEqual(moments.map((moment) => moment.action), ["dribble", "shot", "tackle"]);
  const shot = moments[1]!;
  assert.equal(shot.caption, "Shot · #9 Maya");
  assert.equal(shot.peakSecond, 21);
  assert.ok(shot.startSecond <= 18.5 && shot.endSecond >= 23, "padded around the action");
  assert.equal(shot.frameIndex, 10);
  assert.equal(track.length, 5, "track keeps every confident sighting, involved or not");
  const half = boxAt(track, 51);
  assert.equal(half?.x, 70);
  const between = boxAt(track, 6)!;
  assert.ok(between.x === 40, "interpolates between nearby sightings");
  assert.equal(boxAt(track, 40), undefined, "no box far from any sighting");
});

test("player moments fall back to positioning when the player is never involved", () => {
  const sightings = [sighting(1), sighting(2), sighting(15), sighting(16)];
  const { moments } = buildPlayerMoments({ request, frames, sightings, durationSeconds: 60, intervalSeconds: 2 });
  assert.equal(moments.length, 2);
  assert.ok(moments.every((moment) => moment.action === "off_ball" && moment.caption.startsWith("Positioning")));
});

test("player vision sends the reference first and keeps one clamped sighting per frame", () => {
  const messages = buildPlayerMessages({ frames: [{ index: 0, timestampSeconds: 1, jpegBase64: "AAA" }], request, referenceJpegBase64: "REF", intervalSeconds: 2 });
  const content = messages[1]!.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.match(content[0]!.text!, /number 9, wearing red shirt/u);
  assert.match(content[1]!.text!, /yellow box/u);
  assert.equal(content[2]!.image_url!.url, "data:image/jpeg;base64,REF");
  const parsed = parsePlayerResult({
    footageCheck: { realFootballFootage: true, reason: "ok" },
    sightings: [
      { frameIndex: 0, visible: true, box: { x: 95, y: -5, w: 20, h: 30 }, action: "shot", confidence: 0.9, description: " Shoots. " },
      { frameIndex: 0, visible: true, box: { x: 1, y: 1, w: 1, h: 1 }, action: "pass", confidence: 0.9, description: "dup" },
      { frameIndex: 7, visible: true, box: { x: 1, y: 1, w: 5, h: 5 }, action: "pass", confidence: 0.9, description: "not in batch" },
      { frameIndex: 1, visible: true, box: { x: 0, y: 0, w: 0, h: 0 }, action: "pass", confidence: 0.9, description: "no box" },
    ],
  }, new Set([0, 1]));
  assert.equal(parsed.sightings.length, 2);
  assert.deepEqual(parsed.sightings[0]!.box, { x: 95, y: 0, w: 5, h: 30 });
  assert.equal(parsed.sightings[0]!.description, "Shoots.");
  assert.deepEqual([parsed.sightings[1]!.visible, parsed.sightings[1]!.action, parsed.sightings[1]!.confidence], [false, "off_ball", 0]);
});

test("player vision never tags off_ball when the target has the ball", () => {
  const raw = (action: string, ballContact: boolean, description: string) => ({ frameIndex: 0, visible: true, box, ballContact, action, confidence: 0.9, description });
  const parse = (item: ReturnType<typeof raw>) => parsePlayerResult({ footageCheck: { realFootballFootage: true, reason: "ok" }, sightings: [item] }, new Set([0])).sightings[0]!.action;
  assert.equal(parse(raw("off_ball", true, "Stands near the touchline.")), "on_ball");
  assert.equal(parse(raw("off_ball", false, "Controls the ball under pressure.")), "on_ball");
  assert.equal(parse(raw("off_ball", false, "Receives the ball on the half-turn.")), "on_ball");
  assert.equal(parse(raw("off_ball", false, "Runs into space without the ball.")), "off_ball");
  assert.equal(parse(raw("off_ball", false, "Tracks back to mark a runner.")), "off_ball");
  assert.equal(parse(raw("shot", true, "Strikes the ball.")), "shot");
});

type PlayerVisionInput = Parameters<PlayerVisionAnalyzer["analyzeBatch"]>[0];

function fakePlayerVision(results: (batch: number, input: PlayerVisionInput) => Partial<PlayerVisionResult> = () => ({})): PlayerVisionAnalyzer & { calls: number; references: (string | undefined)[]; inputs: PlayerVisionInput[] } {
  const analyzer = {
    configured: true,
    model: "test-vision",
    calls: 0,
    references: [] as (string | undefined)[],
    inputs: [] as PlayerVisionInput[],
    async analyzeBatch(input: PlayerVisionInput): Promise<PlayerVisionResult> {
      const batch = analyzer.calls++;
      analyzer.references.push(input.referenceJpegBase64);
      analyzer.inputs.push(input);
      return {
        footageCheck: { realFootballFootage: true, reason: "ok" },
        sightings: input.frames.map((frame, index) => sighting(frame.index, { action: index === 2 ? "shot" : "off_ball" })),
        usage: { inputTokens: 100, outputTokens: 10 },
        ...results(batch, input),
      };
    },
  };
  return analyzer;
}

test("player cam worker crops the reference, finds moments and deletes cleanly", async () => {
  const workRoot = mkdtempSync(resolve(".matchlens-playercam-test-"));
  const vision = fakePlayerVision();
  const crops: { second: number; x: number; y: number }[] = [];
  const worker = createPlayerCamWorker({
    vision,
    workRoot,
    probe: async () => ({ durationSeconds: 48, width: 1280, height: 720, codec: "h264" }),
    extract: async ({ timestamps }) => timestamps.map((timestampSeconds, index) => ({ index, timestampSeconds })),
    crop: async (options) => { crops.push({ second: options.second, x: options.x, y: options.y }); },
    readFrame: async () => Buffer.from("jpeg"),
  });
  const source = resolve(workRoot, "source.mp4");
  writeFileSync(source, "video");
  try {
    worker.submit({ jobId: "aaaaaaaaaaaa", sourcePath: source, fileName: "match.mp4", sizeBytes: 5, request: { ...request, anchor: { second: 12, x: 0.4, y: 0.5 } } });
    await worker.idle();
    const job = worker.get("aaaaaaaaaaaa") as PlayerCamJob;
    assert.equal(job.stage, "ready", job.error);
    assert.deepEqual(crops, [{ second: 12, x: 0.4, y: 0.5 }]);
    assert.equal(job.referenceCaptured, true);
    assert.ok(vision.references.every((reference) => reference === Buffer.from("jpeg").toString("base64")), "every batch carries the reference");
    assert.equal(job.frames.length, 48);
    assert.equal(vision.calls, 4);
    assert.ok(vision.inputs.every((input) => input.intervalSeconds === 1));
    assert.ok(job.moments.length >= 1 && job.moments.every((moment) => moment.action === "shot"));
    assert.equal(job.track.length, 48);
    assert.equal(existsSync(source), false, "source is removed after success");
    assert.equal(worker.list()[0]!.playerLabel, "#9 Maya");
    assert.ok(worker.referenceFile("aaaaaaaaaaaa"));
    await worker.remove("aaaaaaaaaaaa");
    assert.equal(worker.get("aaaaaaaaaaaa"), undefined);
  } finally {
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

for (const durationSeconds of [900, 901]) {
  test(`player cam processes 300 frames at ${durationSeconds} seconds and retains the final player moment`, async () => {
    const workRoot = mkdtempSync(resolve(".matchlens-playercam-test-"));
    const crops: number[] = [];
    const vision = fakePlayerVision((_batch, input) => ({
      sightings: input.frames.filter((frame) => frame.index === 299).map((frame) => sighting(frame.index, { action: "shot", confidence: 0.95 })),
    }));
    const worker = createPlayerCamWorker({
      vision, workRoot,
      probe: async () => ({ durationSeconds, width: 1280, height: 720, codec: "h264" }),
      extract: async ({ timestamps, onFrame }) => timestamps.map((timestampSeconds, index) => { onFrame?.(index + 1); return { index, timestampSeconds }; }),
      crop: async ({ second }) => { crops.push(second); },
      readFrame: async () => Buffer.from("jpeg"),
    });
    const source = resolve(workRoot, "source.mp4");
    writeFileSync(source, "video");
    try {
      worker.submit({ jobId: "dddddddddddd", sourcePath: source, fileName: "long.mp4", sizeBytes: 5, request: { ...request, anchor: { second: 900, x: 0.4, y: 0.5 } } });
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
      assert.deepEqual(crops, [Math.min(900, durationSeconds - 0.05)]);
      assert.equal(job.referenceCaptured, true);
      assert.ok(vision.references.every((reference) => reference === Buffer.from("jpeg").toString("base64")));
      const last = job.frames.at(-1)!;
      assert.ok(last.timestampSeconds > durationSeconds - 3 && last.timestampSeconds < durationSeconds);
      assert.equal(job.moments.length, 1);
      const moment = job.moments[0]!;
      assert.equal(moment.frameIndex, 299);
      assert.equal(moment.action, "shot");
      assert.equal(moment.peakSecond, last.timestampSeconds);
      assert.ok(moment.startSecond > durationSeconds - 6);
      assert.equal(moment.endSecond, durationSeconds, "late moment padding stays inside the clip");
      assert.equal(job.track.at(-1)!.second, last.timestampSeconds);
      assert.deepEqual(boxAt(job.track, last.timestampSeconds), box);
      assert.equal(existsSync(source), false, "source is removed before idle resolves");
    } finally {
      await worker.close();
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
}

test("player cam rejects 902 seconds before extracting, cropping or calling vision", async () => {
  const workRoot = mkdtempSync(resolve(".matchlens-playercam-test-"));
  const vision = fakePlayerVision();
  let extracts = 0;
  let crops = 0;
  let reads = 0;
  const worker = createPlayerCamWorker({
    vision, workRoot,
    probe: async () => ({ durationSeconds: 902, width: 1280, height: 720, codec: "h264" }),
    extract: async () => { extracts += 1; return []; },
    crop: async () => { crops += 1; },
    readFrame: async () => { reads += 1; return Buffer.from("jpeg"); },
  });
  const source = resolve(workRoot, "source.mp4");
  writeFileSync(source, "video");
  try {
    worker.submit({ jobId: "cccccccccccc", sourcePath: source, fileName: "too-long.mp4", sizeBytes: 5, request: { ...request, anchor: { second: 900, x: 0.4, y: 0.5 } } });
    await worker.idle();
    const job = worker.get("cccccccccccc")!;
    assert.equal(job.stage, "failed");
    assert.match(job.error!, /limit is 900 s/u);
    assert.deepEqual([extracts, crops, reads, vision.calls], [0, 0, 0, 0]);
    assert.equal(job.frames.length, 0);
    assert.equal(job.moments.length, 0);
    assert.equal(job.track.length, 0);
    assert.equal(existsSync(source), false, "source is removed after duration rejection");
  } finally {
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("player cam worker fails closed on footage that isn't football", async () => {
  const workRoot = mkdtempSync(resolve(".matchlens-playercam-test-"));
  const vision = fakePlayerVision(() => ({ footageCheck: { realFootballFootage: false, reason: "A cartoon" } }));
  const worker = createPlayerCamWorker({
    vision,
    workRoot,
    probe: async () => ({ durationSeconds: 30, width: 640, height: 360, codec: "h264" }),
    extract: async ({ timestamps }) => timestamps.map((timestampSeconds, index) => ({ index, timestampSeconds })),
    readFrame: async () => Buffer.from("jpeg"),
  });
  const source = resolve(workRoot, "source.mp4");
  writeFileSync(source, "video");
  try {
    worker.submit({ jobId: "bbbbbbbbbbbb", sourcePath: source, fileName: "cartoon.mp4", sizeBytes: 5, request });
    await worker.idle();
    const job = worker.get("bbbbbbbbbbbb")!;
    assert.equal(job.stage, "rejected");
    assert.equal(vision.calls, 1);
    assert.equal(job.moments.length, 0);
    assert.equal(existsSync(source), false, "source is removed after footage rejection");
  } finally {
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

const staticDir = mkdtempSync(resolve(".matchlens-playercam-static-"));
writeFileSync(resolve(staticDir, "index.html"), "<!doctype html><html><body></body></html>", "utf8");
after(() => rmSync(staticDir, { recursive: true, force: true }));

async function withPlayerCamServer(vision: PlayerVisionAnalyzer, handler: (base: string, worker: PlayerCamWorker, cropSeconds: number[]) => Promise<void>, durationSeconds?: number) {
  const workRoot = mkdtempSync(resolve(".matchlens-playercam-api-"));
  const cropSeconds: number[] = [];
  const run: RunCommand = async (command, args) => {
    if (command === "ffprobe" && durationSeconds !== undefined) {
      return JSON.stringify({ format: { duration: String(durationSeconds) }, streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }] });
    }
    if (command === "ffmpeg" && args.at(-1)?.endsWith("reference.jpg")) cropSeconds.push(Number(args[args.indexOf("-ss") + 1]));
    return "";
  };
  const worker = createPlayerCamWorker({ vision, workRoot, run, readFrame: async () => Buffer.from("jpeg") });
  const app = createApp({ staticDir, version: "test", logger: () => {}, video: { playerVision: vision, playerWorker: worker, run } });
  const server = http.createServer(app);
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    await handler(base, worker, cropSeconds);
  } finally {
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
}

test("player cam API validates identity hints and supports list and delete", async () => {
  await withPlayerCamServer(fakePlayerVision(), async (base, worker) => {
    const post = (query: string, type = "video/mp4") => fetch(`${base}/api/player-cam/jobs?${query}`, { method: "POST", headers: { "content-type": type }, body: Buffer.from("fake video") });
    assert.equal((await post("fileName=a.mp4&playerName=Maya&number=9", "image/png")).status, 415);
    assert.equal((await post("fileName=a.mp4&playerName=Maya")).status, 400, "needs a click, number or kit");
    assert.equal((await post("fileName=a.mp4&playerName=Maya&anchorSecond=3")).status, 400, "anchor parts go together");
    assert.equal((await post("fileName=a.mp4&playerName=Maya&number=120")).status, 400);
    assert.equal((await post("fileName=a.mp4&playerName=%3Cb%3E&number=9")).status, 400);
    const created = await post("fileName=a.mp4&playerName=Maya&anchorSecond=3.5&anchorX=0.4&anchorY=0.6");
    assert.equal(created.status, 202);
    const job = await created.json() as PlayerCamJob;
    assert.deepEqual(job.request.anchor, { second: 3.5, x: 0.4, y: 0.6 });
    assert.equal(job.request.number, null);
    const listed = await (await fetch(`${base}/api/player-cam/jobs`)).json() as { id: string }[];
    assert.ok(listed.some((item) => item.id === job.id));
    assert.equal((await fetch(`${base}/api/player-cam/jobs/${job.id}/reference`)).status, 404);
    await worker.idle();
    assert.equal((await fetch(`${base}/api/player-cam/jobs/${job.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/player-cam/jobs/${job.id}`)).status, 404);
  });
});

test("player cam API accepts late anchors and 900 seconds, but rejects 901", async () => {
  const vision = fakePlayerVision((_batch, input) => ({
    sightings: input.frames.filter((frame) => frame.index === 299).map((frame) => sighting(frame.index, { action: "shot", confidence: 0.95 })),
  }));
  await withPlayerCamServer(vision, async (base, worker, cropSeconds) => {
    const post = (second: number) => fetch(`${base}/api/player-cam/jobs?fileName=long.mp4&playerName=Maya&anchorSecond=${second}&anchorX=0.4&anchorY=0.6`, {
      method: "POST", headers: { "content-type": "video/mp4" }, body: Buffer.from("fake video"),
    });
    for (const second of [899, 900]) {
      const response = await post(second);
      assert.equal(response.status, 202, `anchor at ${second} s`);
      const created = await response.json() as PlayerCamJob;
      assert.deepEqual(created.request.anchor, { second, x: 0.4, y: 0.6 });
      assert.equal(created.request.number, null, "a late anchor alone identifies the player");
      await worker.idle();
      const job = await (await fetch(`${base}/api/player-cam/jobs/${created.id}`)).json() as PlayerCamJob;
      assert.equal(job.stage, "ready", job.error);
      assert.equal(job.durationSeconds, 900);
      assert.equal(job.frames.length, 300);
      assert.equal(job.batchesDone, 25);
      assert.equal(job.referenceCaptured, true);
      assert.ok(job.moments.some((moment) => moment.frameIndex === 299 && moment.peakSecond === 898.5));
      assert.equal(existsSync(resolve(worker.jobDirectory(job.id), "source.mp4")), false);
    }
    const invalid = await post(901);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as { error: string }).error, /anchorSecond/u);
    assert.equal(worker.list().length, 2, "invalid anchors never create a job");
    assert.equal(vision.calls, 50);
    assert.deepEqual(cropSeconds, [899, 899.95], "an anchor at the duration is cropped just inside the clip");
    assert.ok(vision.references.every((reference) => reference === Buffer.from("jpeg").toString("base64")));
  }, 900);
});
