import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";

import express from "express";

import type { LiveEnvelope } from "../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import type { AnalyzeFixture, BuildFeedPlan, FixtureRegistry, GenerateMatch, StorylineDesk } from "../server/contracts.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";
import { startTrackingStream } from "../server/live/tracking.js";
import { createLocalTransport } from "../server/live/transport.js";
import { createLiveRouter } from "../server/routes/live.js";
import { HttpError } from "../server/validation.js";

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

  pending(): number {
    return this.tasks.size;
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

function flushAsync(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function matchEvent(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type" | "teamId" | "playerId" | "minute" | "second">): MatchEvent {
  return { revision: 1, outcome: "success", x: 50, y: 50, ...input };
}

function fixtureWithEvents(events: MatchEvent[] = [], durationSeconds = 90): MatchFixture {
  return {
    id: "fixture-pause",
    seed: 9,
    title: "Blue FC vs Red FC",
    description: "Pause and resume fixture",
    home: {
      id: "home",
      name: "Blue FC",
      shortName: "BLU",
      players: [{ id: "home-p1", name: "Alice", number: 9, position: "FW", teamId: "home" }],
    },
    away: {
      id: "away",
      name: "Red FC",
      shortName: "RED",
      players: [{ id: "away-p1", name: "Cara", number: 10, position: "FW", teamId: "away" }],
    },
    events,
    durationSeconds,
    correctionEventId: "goal-10",
    correctionAvailableAt: 45,
  };
}

function createRegistry(seed: MatchFixture): FixtureRegistry {
  const fixtures = new Map<string, MatchFixture>([[seed.id, structuredClone(seed)]]);
  return {
    listFixtures() {
      return [...fixtures.values()].map((fixture) => ({
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        home: fixture.home,
        away: fixture.away,
        durationSeconds: fixture.durationSeconds,
        eventCount: fixture.events.length,
        correctionAvailableAt: fixture.correctionAvailableAt,
      }));
    },
    getFixture(id: string) {
      const fixture = fixtures.get(id);
      if (!fixture) throw new RangeError(`Unknown fixture ${id}`);
      return structuredClone(fixture);
    },
    registerFixture(fixture: MatchFixture) {
      fixtures.set(fixture.id, structuredClone(fixture));
      return {
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        home: fixture.home,
        away: fixture.away,
        durationSeconds: fixture.durationSeconds,
        eventCount: fixture.events.length,
        correctionAvailableAt: fixture.correctionAvailableAt,
      };
    },
  };
}

const desk: StorylineDesk = {
  onEvent() {},
  list: () => [],
  facts: () => [],
  async review() { throw new Error("unused"); },
  storyboard: (view) => ({ matchId: view.matchId, stateVersion: "test", chapters: [] }),
  subscribe: () => () => undefined,
  health: () => ({ mode: "unconfigured", agents: [], retrieval: "none" }),
};

const analyzeFixture: AnalyzeFixture = (fixture, request) => ({
  fixtureId: fixture.id,
  atSecond: request.atSecond,
  stateVersion: "test",
  persona: request.persona,
  language: request.language,
  score: { home: 0, away: 0 },
  stats: {
    home: { goals: 0, shots: 0, passes: 0, completedPasses: 0, passAccuracy: 0, corners: 0, tackles: 0, pressureEvents: 0, fouls: 0, yellowCards: 0, redCards: 0, illustrativeXg: 0 },
    away: { goals: 0, shots: 0, passes: 0, completedPasses: 0, passAccuracy: 0, corners: 0, tackles: 0, pressureEvents: 0, fouls: 0, yellowCards: 0, redCards: 0, illustrativeXg: 0 },
  },
  stories: [],
  recentEvents: [],
  evidence: {},
  corrections: [],
  eventCount: fixture.events.length,
  evidenceCoverage: fixture.events.length,
  synthetic: true,
});

function feed(): BuildFeedPlan {
  const plan = [
    matchEvent({ id: "goal-10", type: "goal", teamId: "home", playerId: "home-p1", minute: 0, second: 10 }),
    matchEvent({ id: "pass-20", type: "pass", teamId: "away", playerId: "away-p1", minute: 0, second: 20, outcome: "complete" }),
    matchEvent({ id: "shot-30", type: "shot", teamId: "home", playerId: "home-p1", minute: 0, second: 30 }),
    matchEvent({ id: "pass-40", type: "pass", teamId: "home", playerId: "home-p1", minute: 0, second: 40, outcome: "complete" }),
  ];
  return () => plan.map((event) => ({ publishAtSecond: event.minute * 60 + event.second, event: { ...event } }));
}

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("pause then resume continues at the same second with no duplicate or missing events", async () => {
  const scheduler = new FakeScheduler();
  const transport = createLocalTransport();
  const envelopes: LiveEnvelope[] = [];
  await transport.subscribe((envelope) => { envelopes.push(envelope); });
  const service = createLiveService({
    transport,
    registry: createRegistry(fixtureWithEvents()),
    generateMatch: () => fixtureWithEvents(),
    buildFeedPlan: feed(),
    now: () => scheduler.now,
    scheduler,
  });

  const pause = service.pause;
  const resume = service.resume;
  assert.ok(pause && resume);
  const started = await service.start({ fixtureId: "fixture-pause", speed: 1 });
  assert.equal(started.state, "running");
  await flushAsync();
  await scheduler.advance(15_000);

  const paused = await pause();
  assert.equal(paused.state, "paused");
  assert.equal(paused.pausedAtSecond, 15);
  assert.equal(paused.clockSecond, 15);
  assert.deepEqual(service.current()?.fixture.events.map((event) => event.id), ["goal-10"]);
  const sequencesAtPause = envelopes.map((envelope) => envelope.sequence);
  const publishedAtPause = envelopes.length;

  await scheduler.advance(30_000);
  assert.equal(service.status().state, "paused");
  assert.equal(service.status().clockSecond, 15);
  assert.equal(service.status().pausedAtSecond, 15);
  assert.equal(envelopes.length, publishedAtPause, "pause must not publish events");
  assert.equal(scheduler.pending(), 0, "pause clears the feed timers and the clock ticker");

  const pausedAgain = await pause();
  assert.equal(pausedAgain.state, "paused");
  assert.equal(pausedAgain.pausedAtSecond, 15);

  await scheduler.advance(5_000);
  const resumed = await resume();
  assert.equal(resumed.state, "running");
  assert.equal(resumed.pausedAtSecond, undefined);
  assert.equal(resumed.clockSecond, 15);
  await flushAsync();
  assert.deepEqual(service.current()?.fixture.events.map((event) => event.id), ["goal-10"], "resume must not republish events already sent");

  await scheduler.advance(5_000);
  assert.equal(service.status().clockSecond, 20);
  assert.deepEqual(service.current()?.fixture.events.map((event) => event.id), ["goal-10", "pass-20"]);

  await scheduler.advance(20_000);
  assert.deepEqual(service.current()?.fixture.events.map((event) => `${event.id}@${event.revision}`), [
    "goal-10@1",
    "pass-20@1",
    "shot-30@1",
    "pass-40@1",
  ]);

  const eventEnvelopes = envelopes.filter((envelope) => envelope.kind === "match_event");
  assert.deepEqual(eventEnvelopes.map((envelope) => envelope.event?.id), ["goal-10", "pass-20", "shot-30", "pass-40"]);
  const sequences = envelopes.map((envelope) => envelope.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1), "event sequence stays contiguous");
  assert.deepEqual(sequences.slice(0, sequencesAtPause.length), sequencesAtPause);
  assert.equal(new Set(eventEnvelopes.map((envelope) => envelope.event?.id)).size, eventEnvelopes.length);

  const finished = await service.stop();
  assert.equal(finished.state, "finished");
  await service.close();
});

test("a long pause does not jump the speed-scaled clock", async () => {
  const scheduler = new FakeScheduler();
  const service = createLiveService({
    transport: createLocalTransport(),
    registry: createRegistry(fixtureWithEvents([], 5_400)),
    generateMatch: () => fixtureWithEvents([], 5_400),
    buildFeedPlan: () => [],
    now: () => scheduler.now,
    scheduler,
  });

  await service.start({ fixtureId: "fixture-pause", speed: 60 });
  await flushAsync();
  await scheduler.advance(1_000);
  assert.equal(service.status().clockSecond, 60);

  await service.pause!();
  await scheduler.advance(30_000);
  assert.equal(service.status().clockSecond, 60);
  assert.equal(service.status().pausedAtSecond, 60);

  const resumed = await service.resume!();
  assert.equal(resumed.clockSecond, 60);
  await scheduler.advance(1_000);
  assert.equal(service.status().clockSecond, 120, "resume must subtract paused wall time, not add pauseDuration * speed");
  await service.close();
});

test("pause and resume reject the wrong state, and a correction while paused keeps the frozen second", async () => {
  const scheduler = new FakeScheduler();
  const service = createLiveService({
    transport: createLocalTransport(),
    registry: createRegistry(fixtureWithEvents()),
    generateMatch: () => fixtureWithEvents(),
    buildFeedPlan: feed(),
    now: () => scheduler.now,
    scheduler,
  });

  await assert.rejects(() => service.pause!(), (error: unknown) => error instanceof HttpError && error.status === 409);
  await assert.rejects(() => service.resume!(), (error: unknown) => error instanceof HttpError && error.status === 409);

  await service.start({ fixtureId: "fixture-pause", speed: 1 });
  await flushAsync();
  await assert.rejects(() => service.resume!(), (error: unknown) => error instanceof HttpError && error.status === 409);
  await scheduler.advance(15_000);
  await service.pause!();
  await assert.rejects(() => service.start({ fixtureId: "fixture-pause", speed: 1 }), (error: unknown) => error instanceof HttpError && error.status === 409);

  await service.publishCorrection("goal-10");
  await flushAsync();
  assert.equal(service.status().state, "paused");
  assert.equal(service.status().clockSecond, 15);
  assert.ok(service.current()?.fixture.events.some((event) => event.id === "goal-10" && event.revision === 2 && event.rescinded));

  await service.stop();
  assert.equal(service.status().state, "finished");
  await assert.rejects(() => service.pause!(), (error: unknown) => error instanceof HttpError && error.status === 409);
  await assert.rejects(() => service.resume!(), (error: unknown) => error instanceof HttpError && error.status === 409);
  await service.close();
});

test("status and the event stream report paused without closing", async () => {
  const scheduler = new FakeScheduler();
  const service = createLiveService({
    transport: createLocalTransport(),
    registry: createRegistry(fixtureWithEvents()),
    generateMatch: (() => fixtureWithEvents()) as GenerateMatch,
    buildFeedPlan: () => [],
    now: () => scheduler.now,
    scheduler,
  });
  const app = express();
  app.use(express.json());
  app.use(createLiveRouter({ live: service, desk, analyzeFixture }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : "error" });
  });
  const server = await listen(app);
  const controller = new AbortController();
  try {
    await service.start({ fixtureId: "fixture-pause", speed: 1 });
    await flushAsync();
    const stream = await fetch(`${server.baseUrl}/api/live/stream?role=fan&persona=casual&language=en`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buffer = "";
    const nextMessage = async () => {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          return JSON.parse(line.slice(6)) as { type: string; status?: { state: string; pausedAtSecond?: number } };
        }
        const read = await reader.read();
        if (read.done) throw new Error("SSE stream closed");
        buffer += decoder.decode(read.value, { stream: true });
      }
    };

    const idle = await fetch(`${server.baseUrl}/api/live/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // Match is running, so this is the real pause. A second call is the idempotent one.
    if (idle.status !== 200) {
      throw new Error(`pause ${idle.status} ${JSON.stringify(Object.fromEntries(idle.headers.entries()))} ${await idle.text()}`);
    }
    const pausedBody = await idle.json() as { state: string; pausedAtSecond: number; clockSecond: number };
    assert.equal(pausedBody.state, "paused");
    assert.equal(pausedBody.pausedAtSecond, pausedBody.clockSecond);

    const again = await fetch(`${server.baseUrl}/api/live/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(again.status, 200);
    const status = await fetch(`${server.baseUrl}/api/live/status`);
    assert.equal((await status.json()).state, "paused");

    const seen = [await nextMessage()];
    const deadline = Date.now() + 2_000;
    while (!seen.some((message) => message.type === "status" && message.status?.state === "paused") && Date.now() < deadline) {
      seen.push(await nextMessage());
    }
    assert.ok(seen.some((message) => message.type === "status" && message.status?.state === "paused"));

    const resumed = await fetch(`${server.baseUrl}/api/live/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).state, "running");
    const notPaused = await fetch(`${server.baseUrl}/api/live/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(notPaused.status, 409);
  } finally {
    controller.abort();
    await server.close();
    await service.close();
  }
});

test("tracking stream freezes on pause and does not project wall time", async () => {
  let now = 0;
  let state: "running" | "paused" = "running";
  const clock = 12;
  const fixture = fixtureWithEvents();
  const messages: Array<{ type: string; status?: string; frame?: { second: number } }> = [];
  let ended = false;
  const response = {
    write(chunk: string) {
      messages.push(JSON.parse(chunk.replace(/^data: /, "").trim()) as { type: string; status?: string; frame?: { second: number } });
      return true;
    },
    end() { ended = true; },
    on() {},
    off() {},
  };
  const live = {
    status: () => ({
      state,
      transport: "local" as const,
      transportConfigured: false,
      source: "synthetic" as const,
      clockSecond: clock,
      speed: 60,
      eventsReceived: 1,
      duplicatesIgnored: 0,
      stress: false,
      matchId: "match-pause",
      fixtureId: fixture.id,
    }),
    current: () => ({ matchId: "match-pause", fixture, clockSecond: clock }),
    async start() { return live.status(); },
    async stop() { return live.status(); },
    async publishCorrection() {},
    addListener: () => () => undefined,
    async close() {},
  };
  const ticks: Array<() => void> = [];
  const stop = startTrackingStream({
    live,
    response: response as unknown as express.Response,
    now: () => now,
    scheduler: {
      setInterval(callback) {
        ticks.push(callback);
        return ticks.length;
      },
      clearInterval() {},
    },
  });
  const tick = ticks[0];
  assert.ok(tick);
  assert.equal(messages.some((message) => message.type === "frame"), true);
  state = "paused";
  now += 30_000;
  tick();
  assert.equal(ended, false);
  assert.equal(messages.filter((message) => message.type === "frame").length, 1, "pause must not project another frame");
  assert.ok(messages.some((message) => message.type === "status" && message.status === "paused"));
  now += 30_000;
  tick();
  assert.equal(messages.filter((message) => message.type === "frame").length, 1);
  state = "running";
  tick();
  const resumedFrame = messages.filter((message) => message.type === "frame").at(-1);
  assert.ok(resumedFrame?.frame);
  assert.ok(resumedFrame.frame.second < 20, "resume must not add the paused wall interval times speed");
  stop();
});

test("Studio shows Pause, Resume and Stop, and the board can say Paused", () => {
  const studio = readFileSync(new URL("../src/StudioPage.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  const fan = readFileSync(new URL("../src/FanPage.tsx", import.meta.url), "utf8");
  const bar = readFileSync(new URL("../src/components.tsx", import.meta.url), "utf8");
  assert.match(studio, />Pause</);
  assert.match(studio, />Resume</);
  assert.match(studio, />Stop match</);
  assert.match(studio, /paused=\{state === "paused"\}/);
  assert.match(api, /\/api\/live\/pause/);
  assert.match(api, /\/api\/live\/resume/);
  assert.match(fan, /Paused/);
  assert.match(bar, /Paused/);
});
