import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_VIDEO_BATCH_FRAMES,
  LIVE_VIDEO_PENDING_BATCHES,
  liveVideoFrameCount,
  liveVideoSampleInterval,
  type ProgressiveFrame,
  type ProgressiveVideoBatch,
  type ProgressiveVideoSession,
  type StartProgressiveVideo
} from "../shared/progressiveVideo.js";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_FRAMES, MAX_VIDEO_SECONDS } from "../shared/video.js";
import { api, ApiError } from "../src/api.js";
import {
  canStartLiveVideo,
  confirmLiveVideoStop,
  liveVideoCleanupConfirmed,
  liveVideoStopError,
  plannedVideoFrames,
  playedWatermark,
  streamLocalVideo,
  validateLocalVideo,
  type LiveVideoClient
} from "../src/liveVideo.js";

function session(overrides: Partial<ProgressiveVideoSession> = {}): ProgressiveVideoSession {
  return {
    id: "session-1",
    fixtureId: "fixture-1",
    fileName: "match.mp4",
    durationSeconds: 10,
    stage: "streaming",
    acceptedFrames: 0,
    analyzedFrames: 0,
    uploadedThrough: 0,
    analyzedThrough: 0,
    nextBatchIndex: 0,
    pendingBatches: 0,
    inputComplete: false,
    events: [],
    evidence: [],
    live: {
      state: "running",
      transport: "local",
      transportConfigured: false,
      clockSecond: 0,
      speed: 1,
      eventsReceived: 0,
      duplicatesIgnored: 0,
      stress: false
    },
    ...overrides
  };
}

class FakeClient implements LiveVideoClient {
  readonly controller = new AbortController();
  readonly extracted: ProgressiveFrame[] = [];
  readonly batches: ProgressiveVideoBatch[] = [];
  readonly updates: ProgressiveVideoSession[] = [];
  readonly waits: number[] = [];
  readonly calls: string[] = [];
  playhead = 0;
  highWatermark = 0;
  getCount = 0;
  completeCount = 0;

  constructor(public current = session()) {}

  watermark(): number {
    this.highWatermark = playedWatermark(this.highWatermark, this.playhead, this.current.durationSeconds);
    return this.highWatermark;
  }

  async get(): Promise<ProgressiveVideoSession> {
    this.calls.push("get");
    assert.ok(++this.getCount <= 1_000, "producer did not terminate within the fake polling budget");
    return this.current;
  }

  async extract(frame: { index: number; timestampSeconds: number }): Promise<ProgressiveFrame> {
    this.calls.push(`extract:${frame.index}`);
    assert.ok(frame.timestampSeconds <= this.watermark(), "must not extract an unplayed future frame");
    const extracted = { ...frame, jpegBase64: `jpeg-${frame.index}` };
    this.extracted.push(extracted);
    return extracted;
  }

  async send(batch: ProgressiveVideoBatch): Promise<ProgressiveVideoSession> {
    this.calls.push(`send:${batch.batchIndex}`);
    assert.ok(this.current.pendingBatches < LIVE_VIDEO_PENDING_BATCHES);
    assert.ok(batch.frames.length > 0 && batch.frames.length <= LIVE_VIDEO_BATCH_FRAMES);
    assert.equal(batch.batchIndex, this.current.nextBatchIndex);
    assert.deepEqual(
      batch.frames.map((frame) => frame.index),
      batch.frames.map((_, index) => this.current.acceptedFrames + index)
    );
    this.batches.push(structuredClone(batch));
    this.current = {
      ...this.current,
      acceptedFrames: this.current.acceptedFrames + batch.frames.length,
      nextBatchIndex: batch.batchIndex + 1,
      uploadedThrough: batch.frames[batch.frames.length - 1].timestampSeconds
    };
    return this.current;
  }

  async complete(): Promise<ProgressiveVideoSession> {
    this.calls.push("complete");
    this.completeCount += 1;
    assert.equal(this.current.acceptedFrames, liveVideoFrameCount(this.current.durationSeconds));
    assert.equal(this.watermark(), this.current.durationSeconds);
    this.current = { ...this.current, inputComplete: true, stage: "complete" };
    return this.current;
  }

  update(next: ProgressiveVideoSession): void {
    this.updates.push(next);
  }

  async wait(ms: number, signal: AbortSignal): Promise<void> {
    assert.strictEqual(signal, this.controller.signal);
    signal.throwIfAborted();
    this.calls.push(`wait:${ms}`);
    this.waits.push(ms);
  }

  run(): Promise<void> {
    return streamLocalVideo(this.current, this, this.controller.signal);
  }
}

test("planned samples follow the shared count and interval, including fractional durations and 15 minutes", () => {
  const cases = [
    { duration: 0.25, count: 1, interval: 1 },
    { duration: 1, count: 1, interval: 1 },
    { duration: 1.25, count: 2, interval: 1 },
    { duration: 2.75, count: 3, interval: 1 },
    { duration: 299.5, count: 300, interval: 1 },
    { duration: 300, count: 300, interval: 1 },
    { duration: 300.5, count: 300, interval: 300.5 / 300 },
    { duration: 899.5, count: 300, interval: 899.5 / 300 },
    { duration: 900, count: 300, interval: 3 }
  ];
  assert.equal(MAX_VIDEO_SECONDS, 900);
  assert.equal(MAX_VIDEO_FRAMES, 300);
  for (const { duration, count, interval } of cases) {
    const frames = plannedVideoFrames(duration);
    assert.equal(liveVideoFrameCount(duration), count);
    assert.equal(liveVideoSampleInterval(duration), interval);
    assert.equal(frames.length, count);
    assert.deepEqual(frames, Array.from({ length: count }, (_, index) => ({
      index,
      timestampSeconds: index * interval
    })));
    assert.ok(frames.every((frame) => frame.timestampSeconds >= 0 && frame.timestampSeconds < duration));
  }
  assert.equal(plannedVideoFrames(900).at(-1)?.timestampSeconds, 897);
});

test("planned samples reject zero, negative, unknown, nonfinite and over-limit durations", () => {
  for (const duration of [0, -0, -1, NaN, Infinity, -Infinity, 900.001, 901]) {
    assert.throws(() => plannedVideoFrames(duration), /known duration.*15 minutes/u);
  }
});

test("playedWatermark never regresses on backwards, negative or nonfinite playheads and caps at duration", () => {
  let watermark = 0;
  const readings = [0, 2.5, 8, 3, -1, NaN, Infinity, -Infinity, 100, 1];
  const expected = [0, 2.5, 8, 8, 8, 8, 8, 8, 10, 10];
  readings.forEach((current, index) => {
    watermark = playedWatermark(watermark, current, 10);
    assert.equal(watermark, expected[index]);
  });
});

test("local video validation accepts supported extensions and inclusive size boundaries", () => {
  for (const name of ["match.mp4", "match.WEBM", "match.MoV", "multi.part.MP4"]) {
    for (const size of [1, MAX_UPLOAD_BYTES]) {
      assert.doesNotThrow(() => validateLocalVideo({ name, size }));
    }
  }
});

test("local video validation rejects unsupported or disguised extensions and empty or oversized files", () => {
  for (const name of ["match", "match.avi", "match.mp4.exe", "match.mp4 ", "match.mp4?download=1"]) {
    assert.throws(() => validateLocalVideo({ name, size: 1 }), /MP4, WebM or MOV/u);
  }
  for (const size of [0, -1, MAX_UPLOAD_BYTES + 1, Infinity]) {
    assert.throws(() => validateLocalVideo({ name: "match.mp4", size }), /nonempty.*500 MB/u);
  }
});

test("stream waits at fractional playheads and never extracts future frames", async () => {
  const client = new FakeClient(session({ durationSeconds: 2.5 }));
  const wait = client.wait.bind(client);
  const readings = [0.75, 1, 1.75, 2, 2.5];
  const expectedExtractedCounts = [1, 1, 2, 2, 3];
  client.wait = async (ms, signal) => {
    await wait(ms, signal);
    assert.equal(ms, 750);
    const index = client.waits.length - 1;
    assert.ok(index < readings.length);
    assert.equal(client.extracted.length, expectedExtractedCounts[index]);
    assert.equal(client.completeCount, 0);
    client.playhead = readings[index];
  };
  await client.run();
  assert.deepEqual(client.extracted.map(({ timestampSeconds }) => timestampSeconds), [0, 1, 2]);
  assert.deepEqual(client.waits, [750, 750, 750, 750, 750]);
  assert.equal(client.completeCount, 1);
});

test("stream catches up skipped intervals sequentially despite backwards playback, in at most four-frame batches", async () => {
  const client = new FakeClient();
  const wait = client.wait.bind(client);
  const send = client.send.bind(client);
  client.wait = async (ms, signal) => {
    await wait(ms, signal);
    assert.equal(ms, 750);
    assert.equal(client.completeCount, 0);
    if (client.waits.length === 1) client.playhead = 8.5;
    else {
      assert.equal(client.waits.length, 2);
      assert.equal(client.current.acceptedFrames, 9);
      assert.equal(client.playhead, 2);
      client.playhead = 10;
    }
  };
  client.send = async (batch) => {
    const next = await send(batch);
    if (batch.batchIndex === 1) client.playhead = 2;
    return next;
  };
  await client.run();
  assert.deepEqual(client.extracted.map(({ index }) => index), Array.from({ length: 10 }, (_, index) => index));
  assert.deepEqual(client.batches.map(({ batchIndex, frames }) => [batchIndex, frames.length]), [
    [0, 1], [1, 4], [2, 4], [3, 1]
  ]);
  assert.equal(client.completeCount, 1);
});

test("stream honors two pending batches by polling and waiting before extracting or sending", async () => {
  const client = new FakeClient(session({ durationSeconds: 1, pendingBatches: 2 }));
  client.playhead = 1;
  const wait = client.wait.bind(client);
  client.wait = async (ms, signal) => {
    await wait(ms, signal);
    assert.equal(ms, 1_000);
    assert.equal(client.extracted.length, 0);
    assert.equal(client.batches.length, 0);
    assert.equal(client.completeCount, 0);
    if (client.waits.length === 2) client.current = { ...client.current, pendingBatches: 1 };
  };
  await client.run();
  assert.equal(LIVE_VIDEO_PENDING_BATCHES, 2);
  assert.deepEqual(client.calls.slice(0, 6), ["get", "wait:1000", "get", "wait:1000", "get", "extract:0"]);
  assert.deepEqual(client.waits, [1_000, 1_000]);
  assert.equal(client.batches.length, 1);
});

test("send acknowledgments filling the two-batch queue pause production until GET reports capacity", async () => {
  const client = new FakeClient(session({ durationSeconds: 9 }));
  client.playhead = 9;
  const send = client.send.bind(client);
  const wait = client.wait.bind(client);
  client.send = async (batch) => {
    await send(batch);
    client.current = { ...client.current, pendingBatches: client.current.pendingBatches + 1 };
    return client.current;
  };
  client.wait = async (ms, signal) => {
    await wait(ms, signal);
    assert.equal(ms, 1_000);
    assert.equal(client.current.pendingBatches, 2);
    assert.equal(client.completeCount, 0);
    assert.equal(client.extracted.length, client.waits.length === 1 ? 8 : 9);
    client.current = { ...client.current, pendingBatches: 1 };
  };
  await client.run();
  assert.deepEqual(client.batches.map(({ frames }) => frames.length), [4, 4, 1]);
  const firstWait = client.calls.indexOf("wait:1000");
  assert.deepEqual(client.calls.slice(firstWait - 2, firstWait + 4), [
    "send:1", "get", "wait:1000", "get", "extract:8", "send:2"
  ]);
  assert.deepEqual(client.waits, [1_000, 1_000]);
});

test("429 retains the exact batch and JPEG objects through backoff and fresh capacity polling", async () => {
  const client = new FakeClient(session({ durationSeconds: 5 }));
  client.playhead = 5;
  const send = client.send.bind(client);
  const wait = client.wait.bind(client);
  const attempts: ProgressiveVideoBatch[] = [];
  let rejectedSnapshot: ProgressiveVideoBatch | undefined;
  client.send = async (batch) => {
    attempts.push(batch);
    if (attempts.length <= 2) {
      if (!rejectedSnapshot) rejectedSnapshot = structuredClone(batch);
      client.current = { ...client.current, pendingBatches: 2 };
      throw new ApiError("Queue full", 429);
    }
    if (attempts.length === 3) {
      assert.strictEqual(batch, attempts[0]);
      assert.strictEqual(batch.frames, attempts[0].frames);
      batch.frames.forEach((frame, index) => assert.strictEqual(frame, attempts[0].frames[index]));
      assert.deepEqual(batch, rejectedSnapshot);
      assert.equal(client.extracted.length, 4);
    }
    return send(batch);
  };
  client.wait = async (ms, signal) => {
    await wait(ms, signal);
    assert.equal(client.extracted.length, 4, "retry must not decode replacement or later frames");
    assert.equal(client.completeCount, 0);
    if (ms === 1_000) client.current = { ...client.current, pendingBatches: 0 };
    else assert.equal(ms, 1_500);
  };
  await client.run();
  assert.strictEqual(attempts[1], attempts[0]);
  assert.deepEqual(client.waits, [1_500, 1_000, 1_500, 1_000]);
  assert.deepEqual(attempts.map(({ batchIndex }) => batchIndex), [0, 0, 0, 1]);
  assert.deepEqual(client.extracted.map(({ index }) => index), [0, 1, 2, 3, 4]);
  assert.equal(client.completeCount, 1);
});

test("input completes only after all planned frames AND playback end, then polls until analysis drains", async () => {
  const client = new FakeClient(session({ durationSeconds: 4.5 }));
  client.playhead = 4;
  const wait = client.wait.bind(client);
  const get = client.get.bind(client);
  let drainPolls = 0;
  client.complete = async () => {
    client.calls.push("complete");
    client.completeCount += 1;
    assert.equal(client.current.acceptedFrames, 5);
    assert.equal(client.extracted.length, 5);
    assert.equal(client.watermark(), 4.5);
    client.current = { ...client.current, inputComplete: true, pendingBatches: 2 };
    return client.current;
  };
  client.get = async () => {
    if (client.current.inputComplete) {
      drainPolls += 1;
      client.current = { ...client.current, pendingBatches: Math.max(0, 3 - drainPolls) };
      if (drainPolls === 3) {
        client.current = { ...client.current, stage: "complete", pendingBatches: 0, analyzedFrames: 5 };
      }
    }
    return get();
  };
  client.wait = async (ms, signal) => {
    await wait(ms, signal);
    if (!client.current.inputComplete) {
      assert.equal(ms, 750);
      assert.equal(client.current.acceptedFrames, 5);
      assert.equal(client.completeCount, 0);
      client.playhead = 4.5;
    } else {
      assert.equal(ms, 1_000);
      assert.equal(client.completeCount, 1);
      assert.equal(client.extracted.length, 5);
      assert.equal(client.batches.length, 2);
    }
  };
  await client.run();
  assert.deepEqual(client.waits, [750, 1_000, 1_000]);
  assert.equal(drainPolls, 3);
  assert.equal(client.completeCount, 1);
  assert.deepEqual(client.calls.slice(client.calls.indexOf("complete")), [
    "complete", "get", "wait:1000", "get", "wait:1000", "get"
  ]);
  assert.equal(client.updates.at(-1)?.stage, "complete");
});

test("resuming a session starts at its accepted frame and next batch index", async () => {
  const client = new FakeClient(session({ durationSeconds: 6, acceptedFrames: 3, nextBatchIndex: 2 }));
  client.playhead = 6;
  await client.run();
  assert.deepEqual(client.extracted.map(({ index }) => index), [3, 4, 5]);
  assert.deepEqual(client.batches.map(({ batchIndex }) => batchIndex), [2]);
});

test("abort cancellation prevents sends before work, after GET, during extraction and during capacity wait", async (t) => {
  for (const phase of ["before", "get", "extract", "wait"] as const) {
    await t.test(phase, async () => {
      const client = new FakeClient(session({ pendingBatches: phase === "wait" ? 2 : 0 }));
      client.playhead = 10;
      const reason = new Error(`Cancelled at ${phase}`);
      if (phase === "before") client.controller.abort(reason);
      if (phase === "get") {
        const get = client.get.bind(client);
        client.get = async () => {
          const next = await get();
          client.controller.abort(reason);
          return next;
        };
      }
      if (phase === "extract") {
        const extract = client.extract.bind(client);
        client.extract = async (frame) => {
          const result = await extract(frame);
          client.controller.abort(reason);
          return result;
        };
      }
      if (phase === "wait") {
        client.wait = async (_ms, signal) => {
          client.controller.abort(reason);
          signal.throwIfAborted();
        };
      }
      await assert.rejects(client.run(), (error: unknown) => error === reason);
      assert.equal(client.batches.length, 0);
      assert.equal(client.completeCount, 0);
      if (phase === "before") assert.equal(client.getCount, 0);
      if (phase === "extract") assert.equal(client.extracted.length, 1);
    });
  }
});

test("abort during 429 backoff prevents retrying the retained batch", async () => {
  const client = new FakeClient();
  client.playhead = 10;
  const reason = new Error("Cancelled during backoff");
  let attempts = 0;
  client.send = async () => {
    attempts += 1;
    throw new ApiError("Queue full", 429);
  };
  client.wait = async (ms, signal) => {
    assert.equal(ms, 1_500);
    client.controller.abort(reason);
    signal.throwIfAborted();
  };
  await assert.rejects(client.run(), (error: unknown) => error === reason);
  assert.equal(attempts, 1);
  assert.equal(client.extracted.length, 4);
  assert.equal(client.completeCount, 0);
});

test("stopped and failed sessions returned by GET or send exit without further work", async (t) => {
  for (const stage of ["stopped", "failed"] as const) {
    for (const source of ["get", "send"] as const) {
      await t.test(`${stage} from ${source}`, async () => {
        const client = new FakeClient();
        client.playhead = 10;
        const terminal = session({ stage, error: stage === "failed" ? "Vision service failed" : undefined });
        let terminalCalls = 0;
        client[source] = async () => {
          terminalCalls += 1;
          return terminal;
        };
        if (stage === "failed") await assert.rejects(client.run(), /Vision service failed/u);
        else await client.run();
        assert.equal(terminalCalls, 1);
        assert.equal(client.extracted.length, source === "get" ? 0 : 4);
        assert.equal(client.completeCount, 0);
        assert.deepEqual(client.waits, []);
        assert.strictEqual(client.updates.at(-1), terminal);
      });
    }
  }
});

test("already stopped or complete sessions do not contact the server", async () => {
  for (const stage of ["stopped", "complete"] as const) {
    const client = new FakeClient(session({ stage }));
    await client.run();
    assert.deepEqual(client.calls, []);
  }
});

test("non-429 send failures propagate without retry or completion", async () => {
  const client = new FakeClient();
  const failure = new ApiError("Service unavailable", 503);
  client.send = async () => { throw failure; };
  await assert.rejects(client.run(), (error: unknown) => error === failure);
  assert.equal(client.completeCount, 0);
  assert.deepEqual(client.waits, []);
});

function requestClient(phase: "send" | "complete"): FakeClient {
  const client = new FakeClient(session({
    durationSeconds: 1,
    acceptedFrames: phase === "complete" ? 1 : 0,
    nextBatchIndex: phase === "complete" ? 1 : 0
  }));
  client.playhead = 1;
  return client;
}

test("409 races refresh once and surface failed or stopped server errors without replay", async (t) => {
  for (const phase of ["send", "complete"] as const) {
    for (const stage of ["failed", "stopped"] as const) {
      await t.test(`${phase}: ${stage}`, async () => {
        const client = requestClient(phase);
        const conflict = new ApiError("Request raced with analysis", 409);
        const terminal = session({ ...client.current, stage, error: `${stage}: vision worker unavailable` });
        const get = client.get.bind(client);
        let attempts = 0;
        client[phase] = async () => {
          attempts += 1;
          client.calls.push(phase);
          throw conflict;
        };
        client.get = async () => {
          await get();
          return attempts ? terminal : client.current;
        };
        await assert.rejects(client.run(), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, terminal.error);
          assert.notStrictEqual(error, conflict);
          return true;
        });
        assert.equal(attempts, 1);
        assert.equal(client.getCount, 2, "one ordinary GET and exactly one recovery GET");
        assert.deepEqual(client.calls.slice(client.calls.indexOf(phase)), [phase, "get"]);
        assert.strictEqual(client.updates.at(-1), terminal);
        assert.equal(client.extracted.length, phase === "send" ? 1 : 0);
        assert.equal(client.batches.length, 0);
        assert.equal(client.completeCount, 0);
        assert.deepEqual(client.waits, []);
      });
    }
  }
});

test("genuine 409 conflicts retain their identity after active or reasonless successful terminal refresh", async (t) => {
  for (const phase of ["send", "complete"] as const) {
    for (const stage of ["streaming", "stopped", "complete"] as const) {
      await t.test(`${phase}: ${stage}`, async () => {
        const client = requestClient(phase);
        const conflict = new ApiError("Batch sequence conflict", 409);
        const refreshed = session({ ...client.current, stage });
        const get = client.get.bind(client);
        let attempts = 0;
        client[phase] = async () => {
          attempts += 1;
          throw conflict;
        };
        client.get = async () => {
          await get();
          return attempts ? refreshed : client.current;
        };
        await assert.rejects(client.run(), (error: unknown) => error === conflict);
        assert.equal(attempts, 1);
        assert.equal(client.getCount, 2);
        assert.strictEqual(client.updates.at(-1), refreshed);
        assert.equal(client.completeCount, 0);
        assert.equal(client.batches.length, 0);
        assert.deepEqual(client.waits, []);
      });
    }
  }
});

test("failed recovery sessions without a reason report a generic failure, not the conflict", async (t) => {
  for (const phase of ["send", "complete"] as const) {
    await t.test(phase, async () => {
      const client = requestClient(phase);
      const conflict = new ApiError("Sequence conflict", 409);
      const terminal = session({ ...client.current, stage: "failed" });
      const get = client.get.bind(client);
      let attempts = 0;
      client[phase] = async () => {
        attempts += 1;
        throw conflict;
      };
      client.get = async () => {
        await get();
        return attempts ? terminal : client.current;
      };
      await assert.rejects(client.run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.notStrictEqual(error, conflict);
        assert.match(error.message, /fail/iu);
        return true;
      });
      assert.equal(attempts, 1);
      assert.equal(client.getCount, 2);
      assert.strictEqual(client.updates.at(-1), terminal);
      assert.deepEqual(client.waits, []);
    });
  }
});

test("409 recovery GET failure preserves both errors in order, original cause and both messages", async (t) => {
  for (const phase of ["send", "complete"] as const) {
    await t.test(phase, async () => {
      const client = requestClient(phase);
      const conflict = new ApiError(`${phase} conflict`, 409);
      const refreshError = new ApiError("Recovery service unavailable", 503);
      const get = client.get.bind(client);
      let attempts = 0;
      let updatesBeforeRecovery: ProgressiveVideoSession[] = [];
      client[phase] = async () => {
        attempts += 1;
        updatesBeforeRecovery = [...client.updates];
        throw conflict;
      };
      client.get = async () => {
        const next = await get();
        if (attempts) throw refreshError;
        return next;
      };
      await assert.rejects(client.run(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.strictEqual(error.errors[0], conflict);
        assert.strictEqual(error.errors[1], refreshError);
        assert.strictEqual(error.cause, conflict);
        assert.ok(error.message.includes(conflict.message));
        assert.ok(error.message.includes(refreshError.message));
        return true;
      });
      assert.equal(attempts, 1);
      assert.equal(client.getCount, 2);
      assert.deepEqual(client.updates, updatesBeforeRecovery);
      assert.equal(client.completeCount, 0);
      assert.equal(client.batches.length, 0);
      assert.deepEqual(client.waits, []);
    });
  }
});

test("recovery rejects mismatched session IDs before adopting terminal errors", async (t) => {
  for (const phase of ["send", "complete"] as const) {
    await t.test(phase, async () => {
      const client = requestClient(phase);
      const conflict = new ApiError("Sequence conflict", 409);
      const stale = session({ id: "other-session", stage: "failed", error: "Unrelated worker failure" });
      const get = client.get.bind(client);
      let attempts = 0;
      let updatesBeforeRecovery: ProgressiveVideoSession[] = [];
      client[phase] = async () => {
        attempts += 1;
        updatesBeforeRecovery = [...client.updates];
        throw conflict;
      };
      client.get = async () => {
        await get();
        return attempts ? stale : client.current;
      };
      await assert.rejects(client.run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.notStrictEqual(error, conflict);
        assert.notEqual(error.message, stale.error);
        assert.match(error.message, /session/iu);
        return true;
      });
      assert.equal(attempts, 1);
      assert.equal(client.getCount, 2);
      assert.deepEqual(client.updates, updatesBeforeRecovery);
      assert.equal(client.batches.length, 0);
      assert.equal(client.completeCount, 0);
      assert.deepEqual(client.waits, []);
    });
  }
});

test("abort while recovery GET is in flight prevents stale adoption and request replay", async (t) => {
  for (const phase of ["send", "complete"] as const) {
    for (const stage of ["streaming", "failed"] as const) {
      await t.test(`${phase}: ${stage}`, async () => {
        const client = requestClient(phase);
        const reason = new Error("Selected source changed during recovery");
        const stale = session({ ...client.current, stage, error: stage === "failed" ? "Old source failed" : undefined });
        const get = client.get.bind(client);
        let attempts = 0;
        let release!: (next: ProgressiveVideoSession) => void;
        let recoveryStarted!: () => void;
        const pending = new Promise<ProgressiveVideoSession>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
        client[phase] = async () => {
          attempts += 1;
          throw new ApiError("Sequence conflict", 409);
        };
        client.get = async () => {
          const next = await get();
          if (!attempts) return next;
          recoveryStarted();
          return pending;
        };
        const rejected = assert.rejects(client.run(), (error: unknown) => error === reason);
        await started;
        const updatesBeforeAbort = [...client.updates];
        client.controller.abort(reason);
        release(stale);
        await rejected;
        assert.equal(attempts, 1);
        assert.equal(client.getCount, 2);
        assert.deepEqual(client.updates, updatesBeforeAbort);
        assert.ok(!client.updates.includes(stale));
        assert.equal(client.extracted.length, phase === "send" ? 1 : 0);
        assert.equal(client.batches.length, 0);
        assert.equal(client.completeCount, 0);
        assert.deepEqual(client.waits, []);
      });
    }
  }
});

test("ordinary GET, send and complete validate session IDs before updating", async (t) => {
  for (const phase of ["get", "send", "complete"] as const) {
    await t.test(phase, async () => {
      const client = requestClient(phase === "complete" ? "complete" : "send");
      const stale = session({ id: "other-session", stage: "failed", error: "Wrong session failure" });
      let attempts = 0;
      let updatesBeforeResponse: ProgressiveVideoSession[] = [];
      client[phase] = async () => {
        attempts += 1;
        updatesBeforeResponse = [...client.updates];
        return stale;
      };
      await assert.rejects(client.run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /session/iu);
        assert.notEqual(error.message, stale.error);
        return true;
      });
      assert.equal(attempts, 1);
      assert.deepEqual(client.updates, updatesBeforeResponse);
      assert.equal(client.getCount, phase === "get" ? 0 : 1);
      assert.equal(client.completeCount, 0);
      assert.equal(client.batches.length, 0);
      assert.deepEqual(client.waits, []);
    });
  }
});

test("ordinary terminal responses surface errors or exit cleanly without replay", async (t) => {
  for (const phase of ["get", "send", "complete"] as const) {
    for (const stage of ["failed", "stopped"] as const) {
      for (const withReason of [true, false]) {
        await t.test(`${phase}: ${stage} ${withReason ? "with" : "without"} reason`, async () => {
          const client = requestClient(phase === "complete" ? "complete" : "send");
          const terminal = session({
            ...client.current,
            stage,
            error: withReason ? `${stage}: server analysis interrupted` : undefined
          });
          let attempts = 0;
          client[phase] = async () => {
            attempts += 1;
            return terminal;
          };
          if (withReason || stage === "failed") {
            await assert.rejects(client.run(), (error: unknown) => {
              assert.ok(error instanceof Error);
              if (withReason) assert.equal(error.message, terminal.error);
              else assert.match(error.message, /fail/iu);
              return true;
            });
          } else {
            await client.run();
          }
          assert.equal(attempts, 1);
          assert.strictEqual(client.updates.at(-1), terminal);
          assert.equal(client.getCount, phase === "get" ? 0 : 1);
          assert.equal(client.extracted.length, phase === "send" ? 1 : 0);
          assert.equal(client.batches.length, 0);
          assert.equal(client.completeCount, 0);
          assert.deepEqual(client.waits, []);
        });
      }
    }
  }
});

test("non-conflict request failures and ordinary GET failures propagate unchanged without recovery", async (t) => {
  for (const phase of ["get", "send", "complete"] as const) {
    const failures = [
      new ApiError("Bad request", 400),
      new ApiError("Service unavailable", 503),
      new Error("Network disconnected"),
      Object.assign(new Error("Not a numeric HTTP status"), { status: "409" }),
      ...(phase === "get" ? [new ApiError("Ordinary GET conflict", 409)] : [])
    ];
    for (const failure of failures) {
      await t.test(`${phase}: ${failure.message}`, async () => {
        const client = requestClient(phase === "complete" ? "complete" : "send");
        let attempts = 0;
        let updatesBeforeFailure: ProgressiveVideoSession[] = [];
        client[phase] = async () => {
          attempts += 1;
          updatesBeforeFailure = [...client.updates];
          throw failure;
        };
        await assert.rejects(client.run(), (error: unknown) => error === failure);
        assert.equal(attempts, 1);
        assert.equal(client.getCount, phase === "get" ? 0 : 1);
        assert.deepEqual(client.updates, updatesBeforeFailure);
        assert.equal(client.extracted.length, phase === "send" ? 1 : 0);
        assert.equal(client.completeCount, 0);
        assert.equal(client.batches.length, 0);
        assert.deepEqual(client.waits, []);
      });
    }
  }
});

test("canStartLiveVideo permits only ready idle sources with no session or a retryable terminal session", () => {
  for (const current of [null, session({ stage: "failed" }), session({ stage: "stopped" }),
    session({ stage: "streaming" }), session({ stage: "complete" })]) {
    for (const ready of [true, false]) {
      for (const busy of [true, false]) {
        for (const status of [null, { ...session().live, state: "idle" as const },
          { ...session().live, state: "finished" as const },
          { ...session().live, state: "running" as const }]) {
          const retryable = current === null || current.stage === "failed" || current.stage === "stopped";
          assert.equal(
            canStartLiveVideo(ready, busy, current, status),
            ready && !busy && retryable && status?.state !== "running",
            JSON.stringify({ ready, busy, stage: current?.stage ?? null, status: status?.state ?? null })
          );
        }
      }
    }
  }
});

test("liveVideoStopError preserves the original error and makes unconfirmed cleanup visible", () => {
  const reasons: { reason: unknown; detail: string }[] = [
    { reason: new Error("Stop network failure"), detail: "Stop network failure" },
    { reason: new ApiError("Stop service unavailable", 503), detail: "Stop service unavailable" },
    { reason: "Stop request rejected", detail: "Something went wrong." },
    { reason: null, detail: "Something went wrong." },
    { reason: undefined, detail: "Something went wrong." },
    { reason: { message: "Not an Error instance" }, detail: "Something went wrong." }
  ];
  for (const original of [null, "", "Vision analysis failed", "Original failure\nAdditional context"]) {
    for (const { reason, detail } of reasons) {
      assert.equal(
        liveVideoStopError(original, reason),
        `${original ? `${original}\n` : ""}Local sampling stopped; server stop could not be confirmed: ${detail}\nRetry server stop.`
      );
    }
  }
});

const ownRun = { id: "session-1", fixtureId: "fixture-1", matchId: "match-1" };
const ownLive = () => ({ ...session().live, fixtureId: ownRun.fixtureId, matchId: ownRun.matchId });

test("cleanup confirmation checks both fixture and match binding, and fails closed without status or identity", () => {
  assert.equal(liveVideoCleanupConfirmed(ownRun, ownLive()), false);
  assert.equal(liveVideoCleanupConfirmed(ownRun, null), false);
  assert.equal(liveVideoCleanupConfirmed(ownRun, session().live), false);
  assert.equal(liveVideoCleanupConfirmed({ id: ownRun.id }, ownLive()), false);
  assert.equal(liveVideoCleanupConfirmed(ownRun, { ...ownLive(), state: "finished" }), true);
  assert.equal(liveVideoCleanupConfirmed(ownRun, { ...ownLive(), state: "idle" }), true);
  assert.equal(liveVideoCleanupConfirmed(ownRun, { ...ownLive(), matchId: "replacement" }), true);
  assert.equal(liveVideoCleanupConfirmed(ownRun, { ...ownLive(), fixtureId: "replacement" }), true);
});

test("terminal stop responses with the same running match retain the cleanup lock and original server reason", async () => {
  for (const stage of ["failed", "stopped", "complete"] as const) {
    const terminal = session({ stage, live: ownLive(), error: "Vision analysis failed; publish failed" });
    await assert.rejects(confirmLiveVideoStop(ownRun, {
      stop: async () => terminal,
      status: async () => { assert.fail("Only missing sessions require a status GET"); }
    }), /Vision analysis failed; publish failed[\s\S]*Retry server stop/u);
    assert.equal(terminal.live.state, "running");
  }
});

test("a retry can confirm server stop, while replacement matches are preserved without further writes", async () => {
  let attempts = 0;
  const client = {
    stop: async (id: string) => {
      assert.equal(id, ownRun.id);
      attempts++;
      return session({ stage: "stopped", live: { ...ownLive(), state: attempts === 1 ? "running" : "finished" } });
    },
    status: async () => { assert.fail("Unexpected fallback"); }
  };
  await assert.rejects(confirmLiveVideoStop(ownRun, client), /Retry server stop/u);
  assert.equal((await confirmLiveVideoStop(ownRun, client)).live.state, "finished");
  assert.equal(attempts, 2);
  for (const live of [
    { ...ownLive(), matchId: "new-run" },
    { ...ownLive(), fixtureId: "other-fixture" },
    { ...ownLive(), fixtureId: "other-fixture", matchId: "other-match" }
  ]) {
    const terminal = session({ stage: "stopped", live });
    const before = structuredClone(terminal);
    const confirmed = await confirmLiveVideoStop(ownRun, { ...client, stop: async () => terminal });
    assert.strictEqual(confirmed.live, live);
    assert.deepEqual(terminal, before);
  }
});

test("expired cleanup404 releases only after authoritative status confirms the own run is not running", async () => {
  for (const live of [
    { ...ownLive(), state: "finished" as const },
    { ...session().live, state: "idle" as const },
    { ...ownLive(), matchId: "new-run" },
    { ...ownLive(), fixtureId: "other-fixture" }
  ]) {
    const calls: string[] = [];
    const before = structuredClone(live);
    const confirmed = await confirmLiveVideoStop(ownRun, {
      stop: async (id) => { calls.push(`stop:${id}`); throw new ApiError("Session expired", 404); },
      status: async () => { calls.push("status"); return live; }
    });
    assert.deepEqual(calls, ["stop:session-1", "status"]);
    assert.equal(confirmed.session, null);
    assert.strictEqual(confirmed.live, live);
    assert.deepEqual(live, before, "confirmation must not mutate another match");
  }
});

test("missing sessions with an own running or unknown stream retain actionable cleanup failure", async () => {
  for (const live of [ownLive(), null, session().live]) {
    await assert.rejects(confirmLiveVideoStop(ownRun, {
      stop: async () => { throw new ApiError("Session expired", 404); },
      status: async () => live
    }), /session is missing[\s\S]*Retry server stop[\s\S]*exact match safely/u);
  }
});

test("stop transport errors, failed status refresh and invalid stop responses cannot confirm cleanup", async () => {
  for (const status of [401, 409, 503]) {
    const error = new ApiError("Stop failed", status);
    await assert.rejects(confirmLiveVideoStop(ownRun, {
      stop: async () => { throw error; },
      status: async () => { assert.fail("Non-404 failures must not trigger fallback"); }
    }), (reason) => reason === error);
  }
  const refreshError = new Error("Status unavailable");
  await assert.rejects(confirmLiveVideoStop(ownRun, {
    stop: async () => { throw new ApiError("Expired", 404); },
    status: async () => { throw refreshError; }
  }), (reason) => reason === refreshError);
  for (const invalid of [
    null,
    session({ stage: "stopped", id: "other-session" }),
    session({ stage: "stopped", fixtureId: "other-fixture" }),
    session()
  ]) {
    await assert.rejects(confirmLiveVideoStop(ownRun, {
      stop: async () => invalid,
      status: async () => { assert.fail("Invalid responses must not trigger fallback"); }
    }), /did not confirm/u);
  }
});

test("progressive API uses JSON metadata and sampled batches, not a full-source upload", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: { url: string; init: RequestInit }[] = [];
  const response = session();
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const controller = new AbortController();
  const metadata: StartProgressiveVideo = {
    fileName: "source.mp4",
    sizeBytes: MAX_UPLOAD_BYTES,
    contentType: "video/mp4",
    durationSeconds: 10,
    request: { home: { name: "Blue", kit: "blue" }, away: { name: "Red", kit: "red" } },
    rightsConfirmed: true
  };
  const batch: ProgressiveVideoBatch = {
    batchIndex: 0,
    frames: [{ index: 0, timestampSeconds: 0, jpegBase64: "anBlZw==" }]
  };
  const id = "session /?#";
  assert.deepEqual(await api.startProgressiveVideo(metadata, controller.signal), response);
  assert.deepEqual(await api.getProgressiveVideo(id, controller.signal), response);
  assert.deepEqual(await api.sendProgressiveBatch(id, batch, controller.signal), response);
  assert.deepEqual(await api.completeProgressiveVideo(id, controller.signal), response);
  assert.deepEqual(await api.stopProgressiveVideo(id, controller.signal), response);
  const root = "/api/video/live-sessions";
  const encoded = `${root}/${encodeURIComponent(id)}`;
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method ?? "GET"]), [
    [root, "POST"], [encoded, "GET"], [`${encoded}/batches`, "POST"],
    [`${encoded}/complete`, "POST"], [encoded, "DELETE"]
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), metadata);
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), batch);
  for (const { init } of calls) {
    assert.strictEqual(init.signal, controller.signal);
    if (init.body !== undefined) {
      assert.equal(typeof init.body, "string");
      assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
      assert.ok(String(init.body).length < 1_024, "only metadata or sampled JPEG JSON is sent");
    }
  }
  for (const index of [1, 3, 4]) assert.equal(calls[index].init.body, undefined);
  assert.equal(calls[4].init.keepalive, true);
});

test("progressive API exposes a 429 ApiError with the server message and preserves the batch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const batch: ProgressiveVideoBatch = {
    batchIndex: 7,
    frames: [{ index: 28, timestampSeconds: 28, jpegBase64: "anBlZw==" }]
  };
  const before = structuredClone(batch);
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, JSON.stringify(before));
    return new Response(JSON.stringify({ error: "Two batches are pending" }), {
      status: 429, headers: { "Content-Type": "application/json" }
    });
  };
  await assert.rejects(api.sendProgressiveBatch("session-1", batch), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, "ApiError");
    assert.equal(error.status, 429);
    assert.equal(error.message, "Two batches are pending");
    return true;
  });
  assert.equal(requests, 1, "backoff belongs to the producer, not the fetch wrapper");
  assert.deepEqual(batch, before);
});
