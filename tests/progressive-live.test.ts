import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { LiveEnvelope } from "../shared/platform.js";
import type { FixtureSummary, MatchEvent, MatchFixture } from "../shared/types.js";
import type { BuildFeedPlan, FixtureRegistry, LiveTransportClient } from "../server/contracts.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

class FakeScheduler implements LiveScheduler {
  now = 1_000;
  timeoutsCreated = 0;
  intervalsCreated = 0;
  private nextId = 1;
  readonly tasks = new Map<number, { due: number; interval?: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number) {
    this.timeoutsCreated += 1;
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.tasks.delete(handle as number);
  }

  setInterval(callback: () => void, intervalMs: number) {
    this.intervalsCreated += 1;
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + intervalMs, interval: intervalMs, callback });
    return id;
  }

  clearInterval(handle: unknown) {
    this.tasks.delete(handle as number);
  }

  async advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.now = task.due;
      if (task.interval === undefined) this.tasks.delete(id);
      else task.due += task.interval;
      task.callback();
      await flushAsync();
    }
    this.now = target;
    await flushAsync();
  }
}

// Publishing and receiving are deliberately independent, as with an Eventstream receiver.
class FakeTransport implements LiveTransportClient {
  readonly name = "fabric-eventstream" as const;
  readonly configured = true;
  autoReceive = false;
  readonly attempts: LiveEnvelope[] = [];
  readonly published: LiveEnvelope[] = [];
  readonly pending: LiveEnvelope[] = [];
  private receiver?: (envelope: LiveEnvelope, receivedAt: number) => void;
  private readonly holds: Array<{
    kind: LiveEnvelope["kind"];
    entered: ReturnType<typeof deferred>;
    result: ReturnType<typeof deferred>;
    used: boolean;
  }> = [];

  constructor(private readonly now: () => number) {}

  holdNext(kind: LiveEnvelope["kind"]) {
    const hold = { kind, entered: deferred(), result: deferred(), used: false };
    this.holds.push(hold);
    return { entered: hold.entered.promise, release: hold.result.resolve, fail: hold.result.reject };
  }

  releaseAll() {
    for (const hold of this.holds) hold.result.resolve();
  }

  async subscribe(receiver: (envelope: LiveEnvelope, receivedAt: number) => void) {
    this.receiver = receiver;
    return async () => { this.receiver = undefined; };
  }

  async publish(envelope: LiveEnvelope) {
    const copy = structuredClone(envelope);
    this.attempts.push(copy);
    const hold = this.holds.find((item) => !item.used && item.kind === copy.kind);
    if (hold) {
      hold.used = true;
      hold.entered.resolve();
      await hold.result.promise;
    }
    this.published.push(copy);
    if (this.autoReceive) this.deliver(copy);
    else this.pending.push(copy);
  }

  deliver(envelope: LiveEnvelope) {
    assert.ok(this.receiver, "transport must be subscribed");
    this.receiver(structuredClone(envelope), this.now());
  }

  deliverNext() {
    const envelope = this.pending.shift();
    assert.ok(envelope, "expected a transport-received envelope");
    this.deliver(envelope);
    return envelope;
  }

  drain() {
    while (this.pending.length) this.deliverNext();
  }
}

function event(id = "goal-1", revision = 1, extra: Partial<MatchEvent> = {}): MatchEvent {
  return {
    id, revision, type: "goal", teamId: "home", playerId: "home-p1",
    minute: 0, second: 8, outcome: "success", x: 50, y: 50, ...extra,
  };
}

function fixture(events: MatchEvent[] = [], id = "video-live"): MatchFixture {
  return {
    id, seed: 9, title: "Blue vs Red", description: "Progressive video",
    home: {
      id: "home", name: "Blue", shortName: "BLU",
      players: [{ id: "home-p1", name: "Alice", number: 9, position: "FW", teamId: "home" }],
    },
    away: {
      id: "away", name: "Red", shortName: "RED",
      players: [{ id: "away-p1", name: "Cara", number: 10, position: "FW", teamId: "away" }],
    },
    events, durationSeconds: 120, correctionEventId: "goal-1", correctionAvailableAt: 8,
  };
}

function summary(value: MatchFixture): FixtureSummary {
  return {
    id: value.id, title: value.title, description: value.description,
    home: structuredClone(value.home), away: structuredClone(value.away),
    durationSeconds: value.durationSeconds, eventCount: value.events.length,
    correctionAvailableAt: value.correctionAvailableAt,
  };
}

function harness(t: TestContext, options: { autoReceive?: boolean; plan?: BuildFeedPlan; fixedNow?: boolean } = {}) {
  const scheduler = new FakeScheduler();
  const now = options.fixedNow ? () => 1_000 : () => scheduler.now;
  const transport = new FakeTransport(now);
  transport.autoReceive = options.autoReceive ?? false;
  const fixtures = new Map<string, MatchFixture>();
  const registry: FixtureRegistry = {
    listFixtures: () => [...fixtures.values()].map(summary),
    getFixture(id) {
      const value = fixtures.get(id);
      if (!value) throw new RangeError(`Unknown fixture ${id}`);
      return structuredClone(value);
    },
    registerFixture(value) {
      fixtures.set(value.id, structuredClone(value));
      return summary(value);
    },
  };
  registry.registerFixture(fixture());
  let planCalls = 0;
  const service = createLiveService({
    transport, registry, scheduler, now,
    generateMatch: () => assert.fail("progressive live must not generate a synthetic fixture"),
    buildFeedPlan(value, stress) {
      planCalls += 1;
      assert.ok(options.plan, "progressive live must not build a synthetic feed plan");
      return options.plan(value, stress);
    },
  });
  t.after(async () => {
    transport.releaseAll();
    await service.close();
  });
  assert.equal(typeof service.startProgressive, "function");
  assert.equal(typeof service.appendProgressive, "function");
  assert.equal(typeof service.completeProgressive, "function");
  return {
    service, transport, scheduler, registry, planCalls: () => planCalls,
    start: (value = fixture()) => service.startProgressive!(value),
    append: (value: MatchFixture, watermark: number) => service.appendProgressive!(value, watermark),
    complete: (id = fixture().id) => service.completeProgressive!(id),
  };
}

function keys(events: MatchEvent[]) {
  return events.map((value) => `${value.id}@${value.revision}`);
}

test("events received before match_start are buffered, not lost to publication deduplication", async (t) => {
  const h = harness(t);
  const seen: string[] = [];
  h.service.addListener({ onEvent: (_view, value) => { seen.push(value.id); } });
  await h.start();
  await h.append(fixture([event()]), 12);
  const [start, receivedEvent] = h.transport.pending.splice(0);
  h.transport.deliver(receivedEvent);
  assert.equal(h.service.current(), undefined);
  assert.deepEqual(seen, []);
  h.transport.deliver(start);
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["goal-1@1"]);
  assert.deepEqual(seen, ["goal-1"]);
  await h.append(fixture([event()]), 18);
  assert.equal(h.transport.published.filter((value) => value.kind === "match_event").length, 1);
});

test("completion received before start replays buffered events before the end notification", async (t) => {
  const h = harness(t);
  const seen: string[] = [];
  h.service.addListener({
    onEvent: (_view, value) => { seen.push(value.id); },
    onMatchEnd(view) {
      assert.deepEqual(keys(view.fixture.events), ["goal-1@1"]);
      seen.push("end");
    },
  });
  await h.start();
  await h.append(fixture([event()]), 12);
  await h.complete();
  const [start, receivedEvent, end] = h.transport.pending.splice(0);
  h.transport.deliver(end);
  h.transport.deliver(receivedEvent);
  h.transport.deliver(start);
  assert.deepEqual(seen, ["goal-1", "end"]);
  assert.equal(h.service.status().state, "finished");
  assert.equal(h.service.current()!.clockSecond, 120);
});

test("stopping before start receipt discards buffered events without restarting the session", async (t) => {
  const h = harness(t);
  await h.start();
  await h.append(fixture([event()]), 12);
  const [start, receivedEvent] = h.transport.pending.splice(0);
  h.transport.deliver(receivedEvent);
  await h.service.stop();
  h.transport.deliver(start);
  h.transport.drain();
  assert.equal(h.service.current(), undefined);
  assert.equal(h.service.status().eventsReceived, 0);
  assert.equal(h.service.status().clockSecond, 12);
  assert.equal(h.service.status().state, "finished");
});

test("failed completion before start receipt remains progressive without creating a ticker", async (t) => {
  const h = harness(t);
  await h.start();
  await h.append(fixture([event()]), 12);
  const hold = h.transport.holdNext("match_end");
  const completing = h.complete();
  const rejected = assert.rejects(completing, /end failed/);
  await hold.entered;
  hold.fail(new Error("end failed"));
  await rejected;
  assert.equal(h.service.status().state, "running");
  assert.equal(h.service.status().clockSecond, 12);
  assert.equal(h.scheduler.intervalsCreated, 0);
  h.transport.drain();
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["goal-1@1"]);
  await h.complete();
  h.transport.drain();
  assert.equal(h.service.status().state, "finished");
});

test("an in-flight synthetic end cannot finish its replacement progressive match", async (t) => {
  const h = harness(t, { autoReceive: true, plan: () => [] });
  await h.service.start({ fixtureId: fixture().id, speed: 1 });
  const oldMatchId = h.service.status().matchId;
  const hold = h.transport.holdNext("match_end");
  await h.scheduler.advance(120_000);
  await hold.entered;
  h.transport.deliver(h.transport.attempts.at(-1)!);
  assert.equal(h.service.status().state, "finished");
  const replacement = h.start();
  await flushAsync();
  assert.equal(h.transport.attempts.filter((value) => value.kind === "match_start").length, 1);
  hold.release();
  await replacement;
  assert.notEqual(h.service.status().matchId, oldMatchId);
  assert.equal(h.service.status().state, "running");
  await h.append(fixture([event()]), 12);
  assert.equal(h.service.status().clockSecond, 12);
});

test("first incremental event arrives through transport before completion; only the watermark advances the clock", async (t) => {
  const h = harness(t);
  const seen: string[] = [];
  h.service.addListener({
    onEvent: (_view, value) => { seen.push(value.id); },
    onMatchEnd: () => { seen.push("end"); },
  });
  await h.start();
  assert.equal(h.service.current(), undefined, "no local match_start fallback");
  h.transport.deliverNext();
  const hold = h.transport.holdNext("match_event");
  const appending = h.append(fixture([event()]), 12);
  await hold.entered;
  assert.deepEqual(h.service.current()!.fixture.events, []);
  assert.deepEqual(seen, []);
  hold.release();
  await appending;
  assert.deepEqual(h.service.current()!.fixture.events, [], "publish acknowledgement is not receipt");
  h.transport.deliverNext();
  assert.deepEqual(seen, ["goal-1"]);
  assert.equal(h.service.status().state, "running");
  assert.equal(h.service.current()!.clockSecond, 12);
  await h.scheduler.advance(24 * 60 * 60 * 1_000);
  assert.equal(h.service.status().clockSecond, 12, "wall time must not outrun video analysis");
  await h.append(fixture([event()]), 18);
  assert.equal(h.service.current()!.clockSecond, 18);
  assert.equal(h.planCalls(), 0);
  assert.equal(h.scheduler.timeoutsCreated, 0);
  assert.equal(h.scheduler.intervalsCreated, 0);
  assert.equal(h.transport.published.some((value) => value.kind === "match_end"), false);
});

test("cumulative metadata and newly recognized shirt numbers update registry and view without leaking unreceived events", async (t) => {
  const h = harness(t);
  await h.start();
  h.transport.drain();
  await h.append(fixture([event()]), 12);
  h.transport.drain();
  const next = fixture([event(), event("pass-1", 1, { type: "pass", second: 20, playerId: "home-p2" })]);
  next.title = "Recognized Blue vs Red";
  next.description = "Second analysis window";
  next.home.name = "Recognized Blue";
  next.home.players[0].number = 19;
  next.home.players.push({ id: "home-p2", name: "Bianca", number: 27, position: "MF", teamId: "home" });
  next.away.players.push({ id: "away-p2", name: "Dana", number: 31, position: "DF", teamId: "away" });
  next.correctionAvailableAt = 20;
  await h.append(next, 24);
  assert.deepEqual(h.registry.getFixture(next.id), next);
  assert.deepEqual(h.service.current()!.fixture, { ...next, events: [event()] });
  assert.equal(h.service.status().title, next.title);
  h.transport.drain();
  assert.deepEqual(h.service.current()!.fixture, next);
});

test("successive cumulative appends deduplicate id+revision before a delayed receiver catches up", async (t) => {
  const h = harness(t);
  await h.start();
  h.transport.drain();
  const first = event();
  const revised = event("goal-1", 2, { x: 60 });
  const other = event("pass-1", 1, { type: "pass", second: 6 });
  await h.append(fixture([first]), 10);
  await h.append(fixture([first, revised, other, revised]), 20);
  await h.append(fixture([first, revised, other]), 25);
  const sent = h.transport.published.filter((value) => value.kind === "match_event");
  assert.deepEqual(keys(sent.map((value) => value.event!)), ["goal-1@1", "goal-1@2", "pass-1@1"]);
  assert.equal(h.service.status().eventsReceived, 0);
  assert.deepEqual(h.service.current()!.fixture.events, []);
  for (const envelope of [...h.transport.pending.splice(0)].reverse()) h.transport.deliver(envelope);
  h.transport.deliver(sent[0]);
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["pass-1@1", "goal-1@1", "goal-1@2"]);
  assert.equal(h.service.status().eventsReceived, 3);
  assert.equal(h.service.status().duplicatesIgnored, 1);
  await h.append(fixture([first, revised, other]), 25);
  assert.equal(h.transport.published.length, 4, "received revisions must not be republished either");
});

test("manual goal rescission survives higher raw reanalysis while the correction receiver is delayed", async (t) => {
  const h = harness(t);
  await h.start();
  h.transport.drain();
  await h.append(fixture([event()]), 12);
  // Even the original goal has only been published, not received.
  await h.service.publishCorrection("goal-1");
  const correction = event("goal-1", 2, { rescinded: true });
  assert.deepEqual(h.registry.getFixture(fixture().id).events, [correction]);
  await h.append(fixture([event(), event("goal-1", 9, { rescinded: false })]), 30);
  assert.deepEqual(h.registry.getFixture(fixture().id).events, [correction]);
  assert.deepEqual(keys(h.transport.published.filter((value) => value.event).map((value) => value.event!)), [
    "goal-1@1", "goal-1@2",
  ]);
  assert.deepEqual(h.service.current()!.fixture.events, []);
  h.transport.drain();
  assert.deepEqual(h.service.current()!.fixture.events, [event(), correction]);
  const latest = h.service.current()!.fixture.events.reduce((left, right) => left.revision > right.revision ? left : right);
  assert.equal(latest.rescinded, true);
  await assert.rejects(h.service.publishCorrection("goal-1"), { status: 409 });
  assert.deepEqual(h.registry.getFixture(fixture().id).events, [correction]);
});

test("append and complete require a matching, running progressive session", async (t) => {
  const h = harness(t, { autoReceive: true, plan: () => [] });
  await assert.rejects(h.append(fixture(), 0), { status: 409 });
  await assert.rejects(h.complete(), { status: 409 });
  await h.service.start({ fixtureId: fixture().id, speed: 2 });
  await assert.rejects(h.append(fixture(), 1), { status: 409 });
  await assert.rejects(h.complete(), { status: 409 });
  await h.service.stop();
  await h.start();
  await assert.rejects(h.start(), { status: 409 });
  await assert.rejects(h.append(fixture([], "wrong-fixture"), 1), { status: 409 });
  await assert.rejects(h.complete("wrong-fixture"), { status: 409 });
  assert.equal(h.service.status().state, "running");
  await h.service.stop();
  await assert.rejects(h.append(fixture(), 2), { status: 409 });
  await assert.rejects(h.complete(), { status: 409 });
  await h.start();
  await h.complete();
  await assert.rejects(h.append(fixture(), 120), { status: 409 });
  await assert.rejects(h.complete(), { status: 409 });
});

test("watermarks must be finite, monotonic, nonnegative and bounded by duration", async (t) => {
  for (const watermark of [NaN, Infinity, -Infinity, -1, 9, 121]) {
    await t.test(`rejects ${String(watermark)} without changing state or publishing`, async (t) => {
      const h = harness(t, { autoReceive: true });
      await h.start();
      await h.append(fixture(), 10);
      const before = h.service.current();
      const registered = h.registry.getFixture(fixture().id);
      const count = h.transport.attempts.length;
      await assert.rejects(h.append(fixture([event()]), watermark), { status: 400 });
      assert.deepEqual(h.service.current(), before);
      assert.deepEqual(h.registry.getFixture(fixture().id), registered);
      assert.equal(h.transport.attempts.length, count);
      assert.equal(h.service.status().state, "running");
    });
  }
  await t.test("accepts zero, equal watermarks and the exact duration", async (t) => {
    const h = harness(t, { autoReceive: true });
    await h.start();
    for (const watermark of [0, 0, 10, 10, 120]) {
      assert.equal((await h.append(fixture(), watermark)).clockSecond, watermark);
    }
    assert.equal(h.service.status().state, "running", "duration watermark alone is not completion");
  });
});

test("invalid fixture durations are rejected on progressive start and append", async (t) => {
  for (const durationSeconds of [NaN, Infinity, -Infinity, 0, -1]) {
    await t.test(`duration ${String(durationSeconds)}`, async (t) => {
      const h = harness(t, { autoReceive: true });
      const invalid = { ...fixture(), durationSeconds };
      await assert.rejects(h.start(invalid), { status: 400 });
      assert.equal(h.service.status().state, "idle");
      assert.equal(h.transport.attempts.length, 0);
      await h.start();
      await assert.rejects(h.append(invalid, 0), { status: 400 });
      assert.equal(h.registry.getFixture(fixture().id).durationSeconds, 120);
      assert.equal(h.service.current()!.clockSecond, 0);
    });
  }
});

test("stale fixture append and completion cannot affect a different active fixture", async (t) => {
  const h = harness(t, { autoReceive: true });
  await h.start();
  await h.append(fixture([event()]), 12);
  await h.service.stop();
  const next = fixture([], "next-video");
  await h.start(next);
  const before = h.service.current();
  const published = h.transport.published.length;
  await assert.rejects(h.append(fixture([event("stale")]), 20), { status: 409 });
  await assert.rejects(h.complete(fixture().id), { status: 409 });
  assert.deepEqual(h.service.current(), before);
  assert.equal(h.transport.published.length, published);
});

test("stop retains the partial watermark despite delayed match_start and match_end", async (t) => {
  for (const receiveStart of [false, true]) {
    await t.test(`start received before stop: ${receiveStart}`, async (t) => {
      const h = harness(t);
      await h.start();
      const start = h.transport.pending.shift()!;
      if (receiveStart) h.transport.deliver(start);
      await h.append(fixture(), 37);
      const stopped = await h.service.stop();
      assert.equal(stopped.state, "finished");
      assert.equal(stopped.clockSecond, 37);
      h.transport.deliver(start);
      h.transport.drain();
      h.transport.deliver(start);
      await h.scheduler.advance(300_000);
      assert.equal(h.service.status().state, "finished");
      assert.equal(h.service.status().clockSecond, 37);
      if (receiveStart) assert.equal(h.service.current()!.clockSecond, 37);
      else assert.equal(h.service.current(), undefined, "late start must not create a stopped view");
      assert.equal(h.scheduler.tasks.size, 0);
    });
  }
});

test("completion reaches duration and sends one normal end notification through the delayed receiver", async (t) => {
  const h = harness(t);
  const ends: number[] = [];
  h.service.addListener({
    onEvent() {},
    onMatchEnd: (view) => { ends.push(view.clockSecond); },
  });
  await h.start();
  h.transport.drain();
  await h.append(fixture([event()]), 15);
  h.transport.drain();
  const completed = await h.complete();
  assert.equal(completed.state, "finished");
  assert.equal(completed.clockSecond, 120);
  assert.equal(h.service.current()!.clockSecond, 120);
  assert.deepEqual(ends, [], "end listeners follow transport receipt, not local fallback");
  const end = h.transport.deliverNext();
  assert.equal(end.kind, "match_end");
  h.transport.deliver(end);
  assert.deepEqual(ends, [120]);
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["goal-1@1"]);
});

test("deferred start publication serializes a following append", async (t) => {
  const h = harness(t);
  const hold = h.transport.holdNext("match_start");
  const starting = h.start();
  await hold.entered;
  let settled = false;
  const appending = h.append(fixture([event()]), 10).then((value) => { settled = true; return value; });
  await flushAsync();
  assert.equal(settled, false);
  assert.deepEqual(h.transport.attempts.map((value) => value.kind), ["match_start"]);
  hold.release();
  const [started, appended] = await Promise.all([starting, appending]);
  assert.equal(appended.matchId, started.matchId);
  assert.deepEqual(h.transport.published.map((value) => value.kind), ["match_start", "match_event"]);
  assert.equal(h.service.current(), undefined);
  h.transport.drain();
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["goal-1@1"]);
});

test("deferred append/stop/start serialize; queued stale work and late envelopes cannot enter a same-fixture restart", async (t) => {
  const h = harness(t, { fixedNow: true });
  const first = await h.start();
  h.transport.drain();
  const eventHold = h.transport.holdNext("match_event");
  const endHold = h.transport.holdNext("match_end");
  const appending = h.append(fixture([event()]), 10);
  await eventHold.entered;
  const stopping = h.service.stop();
  const restarting = h.start();
  const staleAppend = assert.rejects(h.append(fixture([event("stale")]), 20), { status: 409 });
  const staleComplete = assert.rejects(h.complete(), { status: 409 });
  await flushAsync();
  assert.deepEqual(h.transport.attempts.map((value) => value.kind), ["match_start", "match_event"]);
  eventHold.release();
  await appending;
  await endHold.entered;
  assert.equal(h.service.status().matchId, first.matchId);
  assert.equal(h.transport.attempts.filter((value) => value.kind === "match_start").length, 1);
  endHold.release();
  assert.equal((await stopping).clockSecond, 10);
  const second = await restarting;
  await Promise.all([staleAppend, staleComplete]);
  assert.notEqual(second.matchId, first.matchId, "fixed now + same fixture still needs a unique matchId");
  assert.deepEqual(h.transport.published.map((value) => [value.kind, value.matchId]), [
    ["match_start", first.matchId], ["match_event", first.matchId],
    ["match_end", first.matchId], ["match_start", second.matchId],
  ]);
  const old = h.transport.published.filter((value) => value.matchId === first.matchId);
  h.transport.drain();
  for (const envelope of old) h.transport.deliver(envelope);
  assert.equal(h.service.current()!.matchId, second.matchId);
  assert.deepEqual(h.service.current()!.fixture.events, []);
  assert.equal(h.service.status().eventsReceived, 0);
  assert.equal(h.service.status().state, "running");
  await h.append(fixture([event("fresh")]), 8);
  h.transport.drain();
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["fresh@1"]);
});

test("queued cleanup for an old session cannot stop its replacement", async (t) => {
  const h = harness(t, { autoReceive: true });
  const first = await h.start();
  const hold = h.transport.holdNext("match_event");
  const appending = h.append(fixture([event()]), 10);
  await hold.entered;
  const stopping = h.service.stop();
  const restarting = h.start();
  const staleCleanup = h.service.stop();
  hold.release();
  await appending;
  await stopping;
  const replacement = await restarting;
  await staleCleanup;
  assert.notEqual(replacement.matchId, first.matchId);
  assert.equal(h.service.status().matchId, replacement.matchId);
  assert.equal(h.service.status().state, "running");
  assert.deepEqual(
    h.transport.published.filter((value) => value.kind === "match_end").map((value) => value.matchId),
    [first.matchId],
  );
});

test("transport start rejection propagates without local fallback and permits a clean retry", async (t) => {
  const h = harness(t);
  const hold = h.transport.holdNext("match_start");
  const failure = new Error("start publish failed");
  const rejected = assert.rejects(h.start(), (error) => error === failure);
  await hold.entered;
  hold.fail(failure);
  await rejected;
  assert.equal(h.service.status().state, "idle");
  assert.equal(h.service.status().matchId, undefined);
  assert.equal(h.service.current(), undefined);
  assert.equal(h.transport.published.length, 0);
  assert.equal(h.service.status().transport, "fabric-eventstream");
  assert.equal(h.scheduler.tasks.size, 0);
  const restarted = await h.start();
  assert.equal(restarted.state, "running");
  assert.notEqual(restarted.matchId, h.transport.attempts[0].matchId);
  assert.equal(h.service.current(), undefined);
  h.transport.drain();
  assert.equal(h.service.current()!.matchId, restarted.matchId);
});

test("partial append rejection propagates and retry publishes only the unacknowledged revision under receiver lag", async (t) => {
  const h = harness(t);
  await h.start();
  h.transport.drain();
  const firstHold = h.transport.holdNext("match_event");
  const secondHold = h.transport.holdNext("match_event");
  const batch = fixture([event(), event("pass-1", 1, { type: "pass", second: 15 })]);
  const failure = new Error("second event publish failed");
  const rejected = assert.rejects(h.append(batch, 20), (error) => error === failure);
  await firstHold.entered;
  firstHold.release();
  await secondHold.entered;
  secondHold.fail(failure);
  await rejected;
  assert.equal(h.service.status().state, "running");
  assert.deepEqual(h.service.current()!.fixture.events, []);
  assert.equal(h.service.status().eventsReceived, 0);
  assert.deepEqual(keys(h.transport.published.filter((value) => value.event).map((value) => value.event!)), ["goal-1@1"]);
  await h.append(batch, 20);
  assert.deepEqual(keys(h.transport.attempts.filter((value) => value.event).map((value) => value.event!)), [
    "goal-1@1", "pass-1@1", "pass-1@1",
  ]);
  assert.deepEqual(h.service.current()!.fixture.events, []);
  h.transport.drain();
  assert.deepEqual(h.service.current()!.fixture.events, batch.events);
  assert.equal(h.service.status().clockSecond, 20);
  assert.equal(h.service.status().eventsReceived, 2);
  await h.complete();
  assert.equal(h.service.status().state, "finished");
});

test("correction publish failure does not commit a local rescission and can be retried", async (t) => {
  const h = harness(t);
  await h.start();
  h.transport.drain();
  await h.append(fixture([event()]), 10);
  h.transport.drain();
  const hold = h.transport.holdNext("match_event");
  const failure = new Error("correction publish failed");
  const rejected = assert.rejects(h.service.publishCorrection("goal-1"), (error) => error === failure);
  await hold.entered;
  hold.fail(failure);
  await rejected;
  assert.equal(h.service.status().state, "running");
  assert.deepEqual(h.registry.getFixture(fixture().id).events, [event()]);
  assert.deepEqual(h.service.current()!.fixture.events, [event()]);
  await h.service.publishCorrection("goal-1");
  assert.deepEqual(h.service.current()!.fixture.events, [event()], "no correction fallback before receipt");
  assert.deepEqual(h.registry.getFixture(fixture().id).events, [event("goal-1", 2, { rescinded: true })]);
  h.transport.drain();
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["goal-1@1", "goal-1@2"]);
  assert.equal(h.service.current()!.fixture.events[1].rescinded, true);
});

test("transport end failures propagate, restore a usable partial session and allow retry", async (t) => {
  for (const operation of ["stop", "complete"] as const) {
    await t.test(operation, async (t) => {
      const h = harness(t);
      const ends: number[] = [];
      h.service.addListener({ onEvent() {}, onMatchEnd: (view) => { ends.push(view.clockSecond); } });
      await h.start();
      h.transport.drain();
      await h.append(fixture([event()]), 25);
      h.transport.drain();
      const hold = h.transport.holdNext("match_end");
      const finish = () => operation === "stop" ? h.service.stop() : h.complete();
      const failure = new Error(`${operation} publish failed`);
      const rejected = assert.rejects(finish(), (error) => error === failure);
      await hold.entered;
      hold.fail(failure);
      await rejected;
      assert.equal(h.service.status().state, "running");
      assert.equal(h.service.status().clockSecond, 25);
      assert.equal(h.service.current()!.clockSecond, 25);
      assert.deepEqual(ends, []);
      assert.equal(h.transport.published.some((value) => value.kind === "match_end"), false);
      await h.append(fixture([event()]), 30);
      const finished = await finish();
      assert.equal(finished.state, "finished");
      assert.equal(finished.clockSecond, operation === "complete" ? 120 : 30);
      assert.deepEqual(ends, []);
      h.transport.drain();
      assert.deepEqual(ends, [operation === "complete" ? 120 : 30]);
    });
  }
});

test("synthetic live still builds and schedules its feed, advances by wall clock and ends normally", async (t) => {
  const h = harness(t, {
    autoReceive: true,
    plan: (_fixture, stress) => {
      assert.equal(stress, true);
      return [{ publishAtSecond: 8, event: event() }];
    },
  });
  await h.service.start({ fixtureId: fixture().id, speed: 2, stress: true });
  assert.equal(h.planCalls(), 1);
  assert.equal(h.scheduler.timeoutsCreated, 2);
  assert.equal(h.scheduler.intervalsCreated, 1);
  await h.scheduler.advance(3_000);
  assert.equal(h.service.current()!.clockSecond, 6);
  assert.deepEqual(h.service.current()!.fixture.events, []);
  await h.scheduler.advance(1_000);
  assert.deepEqual(keys(h.service.current()!.fixture.events), ["goal-1@1"]);
  await h.scheduler.advance(56_000);
  assert.equal(h.service.status().state, "finished");
  assert.equal(h.service.current()!.clockSecond, 120);
  assert.equal(h.scheduler.tasks.size, 0);
});
