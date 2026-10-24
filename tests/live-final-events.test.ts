import assert from "node:assert/strict";
import test from "node:test";

import type express from "express";

import type { LiveEnvelope } from "../shared/platform.js";
import { buildTrackingFrame, type TrackingFrame, type TrackingStreamMessage } from "../shared/tracking.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import type { BuildFeedPlan, FixtureRegistry } from "../server/contracts.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";
import { startTrackingStream } from "../server/live/tracking.js";
import type { createLocalTransport } from "../server/live/transport.js";

type Transport = ReturnType<typeof createLocalTransport>;

class FakeScheduler implements LiveScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; interval?: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  setInterval(callback: () => void, intervalMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + intervalMs, interval: intervalMs, callback });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.now = task.due;
      if (task.interval === undefined) this.tasks.delete(id);
      else this.tasks.set(id, { ...task, due: task.due + task.interval });
      task.callback();
      await flushAsync();
    }
    this.now = target;
    await flushAsync();
  }
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

/** Local-bus semantics, plus a send that never settles and a switch that holds delivery (Eventstream latency). */
function controllableTransport(options: { hangEventIds?: string[] } = {}) {
  const subscribers = new Set<(envelope: LiveEnvelope, receivedAt: number) => void>();
  const sent: LiveEnvelope[] = [];
  const held: LiveEnvelope[] = [];
  let holding = false;
  const deliver = (envelope: LiveEnvelope) => {
    for (const subscriber of subscribers) subscriber(structuredClone(envelope), Date.now());
  };
  const transport: Transport = {
    name: "local",
    configured: false,
    publish(envelope) {
      if (envelope.event && options.hangEventIds?.includes(envelope.event.id)) {
        return new Promise<void>(() => undefined);
      }
      sent.push(envelope);
      if (holding) held.push(envelope);
      else queueMicrotask(() => deliver(envelope));
      return Promise.resolve();
    },
    async subscribe(onEnvelope) {
      subscribers.add(onEnvelope);
      return async () => { subscribers.delete(onEnvelope); };
    },
    async close() {
      subscribers.clear();
    },
  };
  return {
    transport,
    sent,
    hold() { holding = true; },
    release() {
      holding = false;
      for (const envelope of held.splice(0)) deliver(envelope);
    },
  };
}

function registryFor(fixture: MatchFixture): FixtureRegistry {
  const summary = () => ({
    id: fixture.id,
    title: fixture.title,
    description: fixture.description,
    home: fixture.home,
    away: fixture.away,
    durationSeconds: fixture.durationSeconds,
    eventCount: fixture.events.length,
    correctionAvailableAt: fixture.correctionAvailableAt,
  });
  return {
    listFixtures: () => [summary()],
    getFixture(id: string) {
      if (id !== fixture.id) throw new RangeError(`Unknown fixture ${id}`);
      return structuredClone(fixture);
    },
    registerFixture: () => summary(),
  };
}

const eventSecond = (event: MatchEvent) => event.minute * 60 + event.second;

/** Generated match cut to `durationSeconds`, ending with a late goal and the fulltime whistle. */
function shortFixture(durationSeconds: number): MatchFixture {
  const full = generateMatch({ scenario: "late_winner", seed: 23 });
  const kept = full.events.filter((event) => eventSecond(event) <= durationSeconds - 10 && event.type !== "goal" && event.type !== "fulltime");
  const scorer = full.home.players.find((player) => player.position !== "GK")!;
  const at = (second: number) => ({ minute: Math.floor(second / 60), second: second % 60 });
  const lateGoal: MatchEvent = { id: "late-goal", revision: 1, type: "goal", teamId: "home", playerId: scorer.id, outcome: "success", x: 94, y: 50, ...at(durationSeconds - 2) };
  const fulltime: MatchEvent = { id: "fulltime", revision: 1, type: "fulltime", teamId: "home", playerId: scorer.id, outcome: "none", x: 50, y: 50, ...at(durationSeconds) };
  return { ...full, id: "final-events-fixture", durationSeconds, events: [...kept, lateGoal, fulltime] };
}

test("a publish that never settles is skipped after the receipt timeout and the watermark keeps advancing", async () => {
  const scheduler = new FakeScheduler();
  const fixture = shortFixture(90);
  const at = (second: number) => ({ minute: Math.floor(second / 60), second: second % 60 });
  const base = { revision: 1, teamId: "home" as const, playerId: fixture.home.players[0]!.id, outcome: "complete" as const, x: 50, y: 50 };
  const plan: MatchEvent[] = [
    { ...base, id: "hang-10", type: "pass", ...at(10) },
    { ...base, id: "pass-20", type: "pass", ...at(20) },
    { ...base, id: "pass-30", type: "pass", ...at(30) },
  ];
  const buildFeedPlan: BuildFeedPlan = () => plan.map((event) => ({ publishAtSecond: eventSecond(event), event: { ...event } }));
  const { transport, sent } = controllableTransport({ hangEventIds: ["hang-10"] });
  const live = createLiveService({
    transport,
    registry: registryFor({ ...fixture, events: plan }),
    generateMatch,
    buildFeedPlan,
    now: () => scheduler.now,
    scheduler,
  });
  try {
    await live.start({ fixtureId: fixture.id, speed: 1 });
    await scheduler.advance(10_500);
    assert.ok(live.publishedThroughSecond!() < 10, "the hung send holds the watermark below its due second");

    // The timeout runs from the start of the send (t=10 s), not from a settle that never happens.
    await scheduler.advance(9_000);
    assert.ok(live.publishedThroughSecond!() < 10, "still within the receipt timeout");

    await scheduler.advance(1_500);
    const watermark = live.publishedThroughSecond!();
    assert.ok(watermark > 20 && watermark < 30, `watermark ${watermark} advances past the hung send to the next outstanding event`);
    assert.ok(sent.some((envelope) => envelope.event?.id === "pass-20"), "the serialized publish queue is not blocked by the hung send");
    assert.deepEqual(live.current()!.fixture.events.map((event) => event.id), ["pass-20"]);

    await scheduler.advance(15_000);
    assert.ok(live.publishedThroughSecond!() > 30, "later events keep flowing");
  } finally {
    await live.close();
  }
});

test("match end publishes the final events and the tracking stream drains to ended only after they are received", async () => {
  const duration = 120;
  const fixture = shortFixture(duration);
  const scheduler = new FakeScheduler();
  // A deliberately late (stress) item due after full time must still be published before match_end.
  const lateId = fixture.events.filter((event) => event.type === "pass").at(-1)!.id;
  const buildFeedPlan: BuildFeedPlan = (source) => source.events
    .map((event) => ({ publishAtSecond: event.id === lateId ? duration + 5 : eventSecond(event), event: { ...event } }))
    .sort((left, right) => left.publishAtSecond - right.publishAtSecond);
  const bus = controllableTransport();
  const live = createLiveService({
    transport: bus.transport,
    registry: registryFor(fixture),
    generateMatch,
    buildFeedPlan,
    now: () => scheduler.now,
    scheduler,
  });
  const frames: TrackingFrame[] = [];
  const statuses: string[] = [];
  const response = {
    ended: false,
    write(chunk: string) {
      const message = JSON.parse(chunk.replace(/^data: /, "").trim()) as TrackingStreamMessage;
      if (message.type === "frame") frames.push(message.frame);
      else if (message.type === "status") statuses.push(message.status);
      return true;
    },
    on() { return response; },
    off() { return response; },
    end() { response.ended = true; return response; },
  };
  try {
    await live.start({ fixtureId: fixture.id, speed: 60 });
    const stop = startTrackingStream({ live, response: response as unknown as express.Response, scheduler, now: () => scheduler.now });

    // Eventstream latency: from match second ~90 nothing comes back until released.
    await scheduler.advance(1_500);
    bus.hold();
    await scheduler.advance(1_000);

    assert.equal(live.status().state, "finished");
    const kinds = bus.sent.map((envelope) => envelope.event?.id ?? envelope.kind);
    const endIndex = kinds.indexOf("match_end");
    assert.ok(endIndex > 0, "match_end was published");
    for (const id of ["late-goal", "fulltime", lateId]) {
      const index = kinds.indexOf(id);
      assert.ok(index >= 0 && index < endIndex, `${id} is published before match_end`);
    }
    assert.ok(live.publishedThroughSecond!() < duration, "the watermark waits for the final events to be received");
    assert.equal(response.ended, false, "tracking does not end before the final events arrive");

    bus.release();
    for (let index = 0; index < 40 && !response.ended; index += 1) await scheduler.advance(200);
    stop();

    assert.equal(live.publishedThroughSecond!(), duration);
    const received = live.current()!.fixture.events.map((event) => event.id);
    for (const id of ["late-goal", "fulltime", lateId]) assert.ok(received.includes(id), `${id} reached the live view`);
    assert.equal(response.ended, true, "tracking stream drains and closes");
    assert.equal(statuses.at(-1), "ended");
    assert.equal(frames.at(-1)!.second, duration);
    for (let index = 1; index < frames.length; index += 1) {
      assert.ok(frames[index]!.second >= frames[index - 1]!.second, "frames are forward-only");
    }

    // Every live frame equals a replay of the complete feed (fresh cache key).
    const replayFixture: MatchFixture = { ...structuredClone(live.current()!.fixture), id: `${fixture.id}-replay` };
    for (const frame of frames) {
      const replay = new Map(buildTrackingFrame(replayFixture, frame.second).players.map((player) => [player.id, player]));
      for (const player of frame.players) {
        const other = replay.get(player.id)!;
        assert.ok(Math.hypot(player.x - other.x, player.y - other.y) < 1e-3, `${player.id}@${frame.second} matches replay`);
      }
    }
  } finally {
    await live.close();
  }
});
