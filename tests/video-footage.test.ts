import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { RunCommand } from "../server/video/ffmpeg.js";
import { parseVisionResult, type VisionAnalyzer, type VisionBatchResult } from "../server/video/vision.js";
import { BATCH_SIZE, createVideoWorker } from "../server/video/worker.js";
import type { MatchFixture } from "../shared/types.js";
import type { VideoJobRequest, VisionDetection } from "../shared/video.js";

type VisionInput = Parameters<VisionAnalyzer["analyzeBatch"]>[0];
type FootageCheck = VisionBatchResult["footageCheck"];
const match: FootageCheck = { category: "match", realFootballFootage: true, reason: "Camera match footage." };
const graphics: FootageCheck = { category: "broadcast_graphics", realFootballFootage: false, reason: "Football lineup." };
const unsupported: FootageCheck = { category: "unsupported", realFootballFootage: false, reason: "Football video game." };
const request: VideoJobRequest = { home: { name: "Blue Town", kit: "" }, away: { name: "Red City", kit: "" } };
const kits = { home: "blue shirts", away: "red shirts" };
const bogusKits = { home: "logo gold", away: "studio black" };

function detection(frameIndex: number): VisionDetection {
  return { frameIndex, type: "pass", team: "home", shirtNumber: null, outcome: "complete", x: 50, y: 50, confidence: 0.95, description: "A visible pass." };
}

async function processFootage(
  checks: FootageCheck[],
  options: { request?: VideoJobRequest; result?: (batch: number, input: VisionInput) => Partial<VisionBatchResult> } = {},
) {
  const workRoot = mkdtempSync(resolve(".matchlens-footage-test-"));
  const source = resolve(workRoot, "source.mp4");
  const registered: MatchFixture[] = [];
  const inputs: VisionInput[] = [];
  const snapshots: ReturnType<ReturnType<typeof createVideoWorker>["get"]>[] = [];
  const durationSeconds = checks.length * BATCH_SIZE;
  const run: RunCommand = async () => { throw new Error("External commands must not run."); };
  const worker = createVideoWorker({
    workRoot,
    run,
    probe: async () => ({ durationSeconds, width: 1280, height: 720, codec: "h264" }),
    extract: async ({ timestamps, onFrame }) => timestamps.map((timestampSeconds, index) => {
      onFrame?.(index + 1);
      return { index, timestampSeconds };
    }),
    readFrame: async () => Buffer.from("injected jpeg"),
    registerFixture: (fixture) => registered.push(fixture),
    vision: {
      configured: true,
      model: "injected-vision",
      async analyzeBatch(input) {
        const batch = inputs.length;
        inputs.push(structuredClone(input));
        snapshots.push(worker.get("footagecheck"));
        const footageCheck = checks[batch]!;
        return {
          footageCheck,
          kits: footageCheck.realFootballFootage ? kits : bogusKits,
          // Even rejected and graphics responses deliberately contain plausible but bogus evidence.
          detections: [detection(input.frames[0]!.index)],
          usage: { inputTokens: 100, outputTokens: 10 },
          ...options.result?.(batch, input),
        };
      },
    },
  });
  try {
    writeFileSync(source, "injected video");
    worker.submit({ jobId: "footagecheck", sourcePath: source, fileName: "broadcast.mp4", sizeBytes: 14, request: options.request ?? request });
    await worker.idle();
    const job = worker.get("footagecheck")!;
    assert.equal(existsSync(source), false, "source is removed on success and rejection");
    return { job, inputs, snapshots, registered };
  } finally {
    await worker.close();
  }
}

test("full upload accepts graphics then match even when graphics are the majority", async () => {
  const { job, inputs, snapshots, registered } = await processFootage([graphics, graphics, match]);
  assert.equal(job.stage, "ready", job.error);
  assert.equal(job.batchesTotal, 3);
  assert.equal(job.batchesDone, 3);
  assert.equal(job.progress, 100);
  assert.equal(job.frames.length, 3 * BATCH_SIZE);
  assert.ok(inputs.every((input) => input.frames.length === BATCH_SIZE && input.intervalSeconds === 1));
  assert.deepEqual(job.usage, { inputTokens: 300, outputTokens: 30 });
  assert.equal(snapshots[2]!.batchesDone, 2);
  assert.ok(snapshots[2]!.progress > snapshots[1]!.progress);
  assert.equal(snapshots[2]!.detectionsRaw, 0);
  assert.equal(snapshots[2]!.kits, undefined);
  assert.ok(inputs.every((input) => input.knownKits === undefined));
  assert.deepEqual(job.kits, kits);
  assert.equal(job.detectionsRaw, 1);
  assert.equal(job.detectionsAccepted, 1);
  assert.deepEqual(job.evidence.map((item) => item.frameIndex), [24]);
  assert.equal(registered.length, 1);
  assert.equal(job.footageCheck!.realFootballFootage, true);
  assert.match(job.footageCheck!.reason, /1 batch\(es\) reported real football footage; 2 football broadcast graphics/u);
  const skipped = job.log.filter((entry) => entry.message.includes("skipped football broadcast graphics"));
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]!.message, /0\.5–11\.5 s sampled coverage/u);
});

test("middle and trailing graphics never contribute detections or replace known kits", async () => {
  const { job, inputs, snapshots } = await processFootage([match, graphics, match, graphics]);
  assert.equal(job.stage, "ready", job.error);
  assert.deepEqual(job.kits, kits);
  assert.deepEqual(inputs.slice(1).map((input) => input.knownKits), [kits, kits, kits]);
  assert.equal(snapshots[2]!.detectionsRaw, 1);
  assert.deepEqual(snapshots[2]!.kits, kits);
  assert.equal(job.detectionsRaw, 2);
  assert.equal(job.detectionsAccepted, 2);
  assert.deepEqual(job.evidence.map((item) => item.frameIndex), [0, 24]);
  assert.equal(job.batchesDone, 4);
  assert.deepEqual(job.usage, { inputTokens: 400, outputTokens: 40 });
  assert.equal(job.footageCheck!.realFootballFootage, true);
});

test("provided kits survive a graphics intro and conflicting model kit descriptions", async () => {
  const providedKits = { home: "white shirts", away: "green shirts" };
  const { job, inputs } = await processFootage([graphics, match], {
    request: { home: { name: "Home", kit: providedKits.home }, away: { name: "Away", kit: providedKits.away } },
  });
  assert.equal(job.stage, "ready", job.error);
  assert.deepEqual(job.kits, providedKits);
  assert.ok(inputs.every((input) => JSON.stringify(input.knownKits) === JSON.stringify(providedKits)));
});

test("all graphics rejects with no match footage, no kits or evidence, and full usage", async () => {
  const { job, registered, inputs } = await processFootage([graphics, graphics, graphics]);
  assert.equal(job.stage, "rejected");
  assert.match(job.error!, /^No match footage/u);
  assert.equal(job.footageCheck!.realFootballFootage, false);
  assert.equal(job.footageCheck!.reason, job.error);
  assert.equal(inputs.length, 3);
  assert.equal(job.batchesDone, 3);
  assert.deepEqual(job.usage, { inputTokens: 300, outputTokens: 30 });
  assert.equal(job.kits, undefined);
  assert.equal(job.detectionsRaw, 0);
  assert.equal(job.detectionsAccepted, 0);
  assert.deepEqual(job.events, []);
  assert.deepEqual(job.evidence, []);
  assert.equal(job.fixtureId, undefined);
  assert.deepEqual(registered, []);
});

for (const check of [
  unsupported,
  { realFootballFootage: false, reason: "Football broadcast intro, logos and lineup graphics." },
] satisfies FootageCheck[]) {
  for (const prefix of [[], [graphics], [match]]) {
    test(`${check.category ?? "legacy false"} rejects after ${prefix[0]?.category ?? "opening"} without trusting reason text`, async () => {
      const { job, registered, inputs } = await processFootage([...prefix, check, match]);
      assert.equal(job.stage, "rejected");
      assert.equal(job.error, check.reason);
      assert.equal(inputs.length, prefix.length + 1, "no inference after unsupported footage");
      assert.equal(job.batchesDone, inputs.length);
      assert.deepEqual(job.usage, { inputTokens: inputs.length * 100, outputTokens: inputs.length * 10 });
      assert.deepEqual(job.footageCheck, check);
      assert.equal(job.detectionsRaw, prefix[0] === match ? 1 : 0, "unsupported evidence never accumulates");
      assert.deepEqual(job.kits, prefix[0] === match ? kits : undefined);
      assert.equal(job.detectionsAccepted, 0);
      assert.deepEqual(job.events, []);
      assert.deepEqual(job.evidence, []);
      assert.equal(job.fixtureId, undefined);
      assert.deepEqual(registered, []);
    });
  }
}

test("legacy true remains supported and no detections are needed to establish match footage", async () => {
  const { job } = await processFootage([graphics, { realFootballFootage: true, reason: "Real football." }], {
    result: () => ({ detections: [], kits: { home: "", away: "" } }),
  });
  assert.equal(job.stage, "ready", job.error);
  assert.equal(job.footageCheck!.realFootballFootage, true);
  assert.equal(job.detectionsRaw, 0);
});

test("worker validates detection frame membership even for injected vision results", async () => {
  const { job } = await processFootage([graphics, match], {
    result: (batch, input) => batch === 1 ? {
      detections: [detection(0), detection(999), detection(input.frames[0]!.index)],
    } : {},
  });
  assert.equal(job.stage, "ready", job.error);
  assert.equal(job.detectionsRaw, 1);
  assert.deepEqual(job.evidence.map((item) => item.frameIndex), [12]);
});

test("parseVisionResult preserves explicit categories and rejects contradictions and unknown categories", () => {
  for (const footageCheck of [match, graphics, unsupported, { realFootballFootage: true, reason: "Legacy." }]) {
    const result = parseVisionResult({ footageCheck, kits, detections: [detection(4), detection(5)] }, new Set([4]));
    assert.deepEqual(result.footageCheck, footageCheck);
    assert.deepEqual(result.detections, [detection(4)]);
  }
  for (const footageCheck of [
    { ...match, realFootballFootage: false },
    { ...graphics, realFootballFootage: true },
    { ...unsupported, realFootballFootage: true },
    { ...graphics, category: "logo" },
  ]) {
    assert.throws(() => parseVisionResult({ footageCheck, kits, detections: [] }, new Set()));
  }
});

test("invalid injected classification fails closed without losing returned usage", async () => {
  const { job, inputs, registered } = await processFootage([{ ...graphics, realFootballFootage: true }, match]);
  assert.equal(job.stage, "failed");
  assert.match(job.error!, /contradicts/u);
  assert.equal(inputs.length, 1);
  assert.deepEqual(job.usage, { inputTokens: 100, outputTokens: 10 });
  assert.equal(job.detectionsRaw, 0);
  assert.equal(job.kits, undefined);
  assert.deepEqual(registered, []);
});
