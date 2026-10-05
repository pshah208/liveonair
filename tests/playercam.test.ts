import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { buildPlayerMoments, MIN_PLAYER_CONFIDENCE } from "../server/video/playerMoments.js";
import { buildPlayerMessages, parsePlayerResult, type PlayerVisionAnalyzer, type PlayerVisionResult } from "../server/video/playerVision.js";
import { createPlayerCamWorker } from "../server/video/playerWorker.js";
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

function fakePlayerVision(results: (batch: number) => Partial<PlayerVisionResult> = () => ({})): PlayerVisionAnalyzer & { calls: number; references: (string | undefined)[] } {
  const analyzer = {
    configured: true,
    model: "test-vision",
    calls: 0,
    references: [] as (string | undefined)[],
    async analyzeBatch(input: Parameters<PlayerVisionAnalyzer["analyzeBatch"]>[0]): Promise<PlayerVisionResult> {
      const batch = analyzer.calls++;
      analyzer.references.push(input.referenceJpegBase64);
      return {
        footageCheck: { realFootballFootage: true, reason: "ok" },
        sightings: input.frames.map((frame, index) => sighting(frame.index, { action: index === 2 ? "shot" : "off_ball" })),
        usage: { inputTokens: 100, outputTokens: 10 },
        ...results(batch),
      };
    },
  };
  return analyzer;
}

test("player cam worker crops the reference, finds moments and deletes cleanly", async () => {
  const workRoot = mkdtempSync(resolve(tmpdir(), "matchlens-playercam-test-"));
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
    assert.ok(job.moments.length >= 1 && job.moments.every((moment) => moment.action === "shot"));
    assert.equal(job.track.length, 48);
    assert.equal(worker.list()[0]!.playerLabel, "#9 Maya");
    assert.ok(worker.referenceFile("aaaaaaaaaaaa"));
    await worker.remove("aaaaaaaaaaaa");
    assert.equal(worker.get("aaaaaaaaaaaa"), undefined);
  } finally {
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("player cam worker fails closed on footage that isn't football", async () => {
  const workRoot = mkdtempSync(resolve(tmpdir(), "matchlens-playercam-test-"));
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
  } finally {
    await worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

const staticDir = mkdtempSync(resolve(tmpdir(), "matchlens-playercam-static-"));
writeFileSync(resolve(staticDir, "index.html"), "<!doctype html><html><body></body></html>", "utf8");

test("player cam API validates identity hints and supports list and delete", async () => {
  const app = createApp({ staticDir, version: "test", video: { playerVision: fakePlayerVision(), run: async () => "" } });
  const server = http.createServer(app);
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const post = (query: string, type = "video/mp4") => fetch(`${base}/api/player-cam/jobs?${query}`, { method: "POST", headers: { "content-type": type }, body: Buffer.from("fake video") });
  try {
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 200)); // the fake probe fails, so the job settles
    assert.equal((await fetch(`${base}/api/player-cam/jobs/${job.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/player-cam/jobs/${job.id}`)).status, 404);
  } finally {
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
  }
});
