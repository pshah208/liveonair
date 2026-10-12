import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import type {
  LiveMessage,
  Storyline,
  VerifiedFact,
} from "../shared/platform.js";
import type { MatchEvent, MatchFixture, MatchSnapshot } from "../shared/types.js";
import type {
  AnalyzeFixture,
  BuildFeedPlan,
  FixtureRegistry,
  GenerateMatch,
  LiveMatchView,
  StorylineDesk,
} from "../server/contracts.js";
import { createLiveRouter } from "../server/routes/live.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";
import { createLocalTransport, liveEnvelopeSchema, parseLiveEnvelope } from "../server/live/transport.js";

class FakeScheduler implements LiveScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; interval?: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + delayMs, callback });
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
        .sort((left, right) => left[1].due - right[1].due)[0];

      if (!next) {
        break;
      }

      const [id, task] = next;
      this.now = task.due;
      if (task.interval === undefined) {
        this.tasks.delete(id);
      } else {
        this.tasks.set(id, { ...task, due: task.due + task.interval });
      }
      task.callback();
      await flushAsync();
    }
    this.now = target;
    await flushAsync();
  }
}

class FakeDesk implements StorylineDesk {
  private readonly updates = new Set<(update: { storyline?: Storyline; fact?: VerifiedFact }) => void>();

  constructor(
    private readonly storylinesByMatch = new Map<string, Storyline[]>(),
    private readonly factsByMatch = new Map<string, VerifiedFact[]>(),
  ) {}

  onEvent(): void {}
  onMatchStart(): void {}
  onMatchEnd(): void {}

  list(matchId: string): Storyline[] {
    return this.storylinesByMatch.get(matchId)?.map((storyline) => structuredClone(storyline)) ?? [];
  }

  facts(matchId: string): VerifiedFact[] {
    return this.factsByMatch.get(matchId)?.map((fact) => structuredClone(fact)) ?? [];
  }

  async review(id: string): Promise<Storyline> {
    const storyline = [...this.storylinesByMatch.values()].flat().find((item) => item.id === id);
    assert.ok(storyline);
    return structuredClone(storyline);
  }

  storyboard(view: LiveMatchView) {
    return {
      matchId: view.matchId,
      stateVersion: "test",
      chapters: [],
    };
  }

  subscribe(listener: (update: { storyline?: Storyline; fact?: VerifiedFact }) => void): () => void {
    this.updates.add(listener);
    return () => {
      this.updates.delete(listener);
    };
  }

  health() {
    return { mode: "unconfigured" as const, agents: [], retrieval: "none" };
  }

  emit(update: { storyline?: Storyline; fact?: VerifiedFact }) {
    for (const listener of this.updates) {
      listener(structuredClone(update));
    }
  }

  seed(matchId: string, storylines: Storyline[], facts: VerifiedFact[]) {
    this.storylinesByMatch.set(matchId, storylines.map((item) => structuredClone(item)));
    this.factsByMatch.set(matchId, facts.map((item) => structuredClone(item)));
  }
}

function fixtureWithEvents(id = "fixture-live"): MatchFixture {
  return {
    id,
    seed: 9,
    title: "Blue FC vs Red FC",
    description: "Synthetic live fixture",
    home: {
      id: "home",
      name: "Blue FC",
      shortName: "BLU",
      players: [
        { id: "home-p1", name: "Alice", number: 9, position: "FW", teamId: "home" },
        { id: "home-p2", name: "Bianca", number: 8, position: "MF", teamId: "home" },
      ],
    },
    away: {
      id: "away",
      name: "Red FC",
      shortName: "RED",
      players: [
        { id: "away-p1", name: "Cara", number: 10, position: "FW", teamId: "away" },
      ],
    },
    events: [],
    durationSeconds: 120,
    correctionEventId: "goal-1",
    correctionAvailableAt: 45,
  };
}

function matchEvent(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type" | "teamId" | "playerId" | "minute" | "second">): MatchEvent {
  return {
    revision: 1,
    outcome: "success",
    x: 50,
    y: 50,
    ...input,
  };
}

function createRegistry(seedFixture = fixtureWithEvents()): FixtureRegistry & { stored: MatchFixture[] } {
  const fixtures = new Map<string, MatchFixture>([[seedFixture.id, structuredClone(seedFixture)]]);
  return {
    stored: [structuredClone(seedFixture)],
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
      if (!fixture) {
        throw new RangeError(`Unknown fixture ${id}`);
      }
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

function createAnalyzeFixture(): AnalyzeFixture {
  return (fixture, request): MatchSnapshot => ({
    fixtureId: fixture.id,
    atSecond: request.atSecond,
    stateVersion: `${fixture.events.length}-${request.language}-${request.persona}`,
    persona: request.persona,
    language: request.language,
    score: {
      home: fixture.events.filter((event) => event.type === "goal" && event.teamId === "home" && !event.rescinded).length,
      away: fixture.events.filter((event) => event.type === "goal" && event.teamId === "away" && !event.rescinded).length,
    },
    stats: {
      home: { goals: 0, shots: 0, passes: 0, completedPasses: 0, passAccuracy: 0, corners: 0, tackles: 0, pressureEvents: 0, fouls: 0, yellowCards: 0, redCards: 0, illustrativeXg: 0 },
      away: { goals: 0, shots: 0, passes: 0, completedPasses: 0, passAccuracy: 0, corners: 0, tackles: 0, pressureEvents: 0, fouls: 0, yellowCards: 0, redCards: 0, illustrativeXg: 0 },
    },
    stories: [],
    recentEvents: fixture.events.slice(-3),
    evidence: Object.fromEntries(fixture.events.map((event) => [event.id, event])),
    corrections: [],
    eventCount: fixture.events.length,
    evidenceCoverage: fixture.events.length,
    synthetic: true,
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function withHttpServer(
  app: express.Express,
  handler: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function connectSse(url: string): Promise<{
  response: Response;
  nextMessage: () => Promise<LiveMessage>;
  close: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    response,
    async nextMessage() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
          if (!line) {
            continue;
          }
          return JSON.parse(line.slice(6));
        }

        const read = await reader.read();
        if (read.done) {
          throw new Error("SSE stream closed");
        }
        buffer += decoder.decode(read.value, { stream: true });
      }
    },
    close() {
      controller.abort();
    },
  };
}

test("local live service round-trips, sorts out-of-order events, ignores duplicates, and publishes corrections", async () => {
  const scheduler = new FakeScheduler();
  const transport = createLocalTransport();
  const registry = createRegistry();
  const generatedFixture = fixtureWithEvents("generated-fixture");
  const generateMatch: GenerateMatch = () => structuredClone(generatedFixture);
  const buildFeedPlan: BuildFeedPlan = () => [
    { publishAtSecond: 2, event: matchEvent({ id: "goal-1", type: "goal", teamId: "home", playerId: "home-p1", minute: 0, second: 8 }) },
    { publishAtSecond: 3, event: matchEvent({ id: "pass-1", type: "pass", teamId: "away", playerId: "away-p1", minute: 0, second: 6, outcome: "complete" }) },
    { publishAtSecond: 4, event: matchEvent({ id: "goal-1", type: "goal", teamId: "home", playerId: "home-p1", minute: 0, second: 8 }) },
  ];

  const service = createLiveService({
    transport,
    registry,
    generateMatch,
    buildFeedPlan,
    now: () => scheduler.now,
    scheduler,
  });

  const seen: Array<{ kind: string; id?: string }> = [];
  service.addListener({
    onMatchStart() {
      seen.push({ kind: "start" });
    },
    onEvent(_view, event) {
      seen.push({ kind: "event", id: `${event.id}@${event.revision}` });
    },
    onMatchEnd() {
      seen.push({ kind: "end" });
    },
  });

  const started = await service.start({ fixtureId: "fixture-live", speed: 60, stress: true });
  assert.equal(started.state, "running");
  await flushAsync();

  await scheduler.advance(4_100);
  const current = service.current();
  assert.ok(current);
  assert.deepEqual(current.fixture.events.map((event) => `${event.id}@${event.revision}`), ["pass-1@1", "goal-1@1"]);
  assert.equal(service.status().duplicatesIgnored, 1);
  assert.equal(service.status().eventsReceived, 2);

  await service.publishCorrection("goal-1");
  await flushAsync();
  const corrected = service.current();
  assert.ok(corrected);
  assert.deepEqual(corrected.fixture.events.map((event) => `${event.id}@${event.revision}${event.rescinded ? "-rescinded" : ""}`), [
    "pass-1@1",
    "goal-1@1",
    "goal-1@2-rescinded",
  ]);
  assert.ok(seen.some((entry) => entry.id === "goal-1@2"));

  const finished = await service.stop();
  await flushAsync();
  assert.equal(finished.state, "finished");
  assert.ok(seen.some((entry) => entry.kind === "end"));

  await service.close();
});

test("live router validates start requests, reports unknown fixtures, and rejects double start", async () => {
  const scheduler = new FakeScheduler();
  const transport = createLocalTransport();
  const registry = createRegistry();
  const service = createLiveService({
    transport,
    registry,
    generateMatch: () => fixtureWithEvents("generated"),
    buildFeedPlan: () => [],
    now: () => scheduler.now,
    scheduler,
  });
  const desk = new FakeDesk();
  const app = express();
  app.use(express.json());
  app.use(createLiveRouter({ live: service, desk, analyzeFixture: createAnalyzeFixture() }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 500).json({
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  });

  await withHttpServer(app, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: 0, fixtureId: "fixture-live", generate: { scenario: "comeback", seed: 1 } }),
    });
    assert.equal(invalid.status, 400);

    const missing = await fetch(`${baseUrl}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: 2, fixtureId: "missing" }),
    });
    assert.equal(missing.status, 404);

    const started = await fetch(`${baseUrl}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: 2, fixtureId: "fixture-live" }),
    });
    assert.equal(started.status, 202);

    const conflict = await fetch(`${baseUrl}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: 2, fixtureId: "fixture-live" }),
    });
    assert.equal(conflict.status, 409);
  });

  await service.close();
});

test("live stream sends status, snapshots, storyline filtering, facts, and enforces stream caps", async () => {
  const scheduler = new FakeScheduler();
  const transport = createLocalTransport();
  const registry = createRegistry();
  const service = createLiveService({
    transport,
    registry,
    generateMatch: () => fixtureWithEvents("generated"),
    buildFeedPlan: () => [
      { publishAtSecond: 1, event: matchEvent({ id: "goal-1", type: "goal", teamId: "home", playerId: "home-p1", minute: 0, second: 4 }) },
    ],
    now: () => scheduler.now,
    scheduler,
  });
  const desk = new FakeDesk();
  const app = express();
  app.use(express.json());
  app.use(createLiveRouter({ live: service, desk, analyzeFixture: createAnalyzeFixture(), maxStreams: 2 }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 500).json({
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  });

  await service.start({ fixtureId: "fixture-live", speed: 60 });
  await flushAsync();
  const matchId = service.status().matchId;
  assert.ok(matchId);

  desk.seed(matchId, [
    {
      id: "story-approved",
      matchId,
      triggerEventIds: ["goal-1"],
      triggerMinute: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "approved",
      priority: 90,
      headline: { en: "Approved", es: "Approved", fr: "Approved", pt: "Approved" },
      onAirLine: { en: "Approved", es: "Approved", fr: "Approved", pt: "Approved" },
      overlay: { en: "Approved", es: "Approved", fr: "Approved", pt: "Approved" },
      claims: [],
      trace: [],
      version: 1,
    },
    {
      id: "story-researching",
      matchId,
      triggerEventIds: ["goal-1"],
      triggerMinute: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "researching",
      priority: 50,
      headline: { en: "Researching", es: "Researching", fr: "Researching", pt: "Researching" },
      onAirLine: { en: "Researching", es: "Researching", fr: "Researching", pt: "Researching" },
      overlay: { en: "Researching", es: "Researching", fr: "Researching", pt: "Researching" },
      claims: [],
      trace: [],
      version: 1,
    },
  ], [
    {
      id: "fact-1",
      matchId,
      minute: 4,
      text: { en: "Goal", es: "Goal", fr: "Goal", pt: "Goal" },
      sources: [{ type: "event", id: "goal-1" }],
      createdAt: new Date().toISOString(),
      retracted: true,
    },
  ]);

  await withHttpServer(app, async (baseUrl) => {
    const badFavorite = await fetch(`${baseUrl}/api/live/stream?role=fan&persona=analyst&language=en&favoritePlayerId=missing-player`);
    assert.equal(badFavorite.status, 400);

    const fan = await connectSse(`${baseUrl}/api/live/stream?role=fan&persona=casual&language=en`);
    const status = await fan.nextMessage();
    assert.equal(status.type, "status");
    const snapshot = await fan.nextMessage();
    assert.equal(snapshot.type, "snapshot");
    const approvedStory = await fan.nextMessage();
    assert.equal(approvedStory.type, "storyline");
    assert.equal((approvedStory as { storyline: Storyline }).storyline.id, "story-approved");
    const fact = await fan.nextMessage();
    assert.equal(fact.type, "fact");
    assert.equal((fact as { fact: VerifiedFact }).fact.retracted, true);

    const studio = await connectSse(`${baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`);
    const studioStatus = await studio.nextMessage();
    assert.equal(studioStatus.type, "status");

    const capped = await fetch(`${baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`, {
      headers: { accept: "text/event-stream" },
    });
    assert.equal(capped.status, 503);

    await scheduler.advance(1_100);
    const updatedSnapshot = await fan.nextMessage();
    assert.equal(updatedSnapshot.type, "snapshot");

    desk.emit({
      storyline: {
        id: "story-retracted",
        matchId,
        triggerEventIds: ["goal-1"],
        triggerMinute: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "retracted",
        priority: 20,
        headline: { en: "Retracted", es: "Retracted", fr: "Retracted", pt: "Retracted" },
        onAirLine: { en: "Retracted", es: "Retracted", fr: "Retracted", pt: "Retracted" },
        overlay: { en: "Retracted", es: "Retracted", fr: "Retracted", pt: "Retracted" },
        claims: [],
        trace: [],
        version: 1,
        retractionReason: "Correction",
      },
    });
    const retracted = await fan.nextMessage();
    assert.equal(retracted.type, "storyline");
    assert.equal((retracted as { storyline: Storyline }).storyline.id, "story-retracted");

    studio.close();
    fan.close();
  });

  await service.close();
});

test("stop publishes match_end and status route reflects finished state", async () => {
  const scheduler = new FakeScheduler();
  const transport = createLocalTransport();
  const registry = createRegistry();
  const service = createLiveService({
    transport,
    registry,
    generateMatch: () => fixtureWithEvents("generated"),
    buildFeedPlan: () => [],
    now: () => scheduler.now,
    scheduler,
  });
  const desk = new FakeDesk();
  const app = express();
  app.use(express.json());
  app.use(createLiveRouter({ live: service, desk, analyzeFixture: createAnalyzeFixture() }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 500).json({
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  });

  await withHttpServer(app, async (baseUrl) => {
    const start = await fetch(`${baseUrl}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: 3, fixtureId: "fixture-live" }),
    });
    assert.equal(start.status, 202);
    await flushAsync();

    const stopped = await fetch(`${baseUrl}/api/live/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).state, "finished");

    const status = await fetch(`${baseUrl}/api/live/status`).then((result) => result.json());
    assert.equal(status.state, "finished");
  });

  await service.close();
});

test("envelope schema rejects malformed payloads", () => {
  assert.throws(() => parseLiveEnvelope({
    kind: "match_event",
    matchId: "m1",
    sequence: 1,
    publishedAt: "not-iso",
    event: { id: "e1" },
  }), /publishedAt/u);

  const result = liveEnvelopeSchema.safeParse({
    kind: "match_event",
    matchId: "m1",
    sequence: 1,
    publishedAt: new Date().toISOString(),
    event: {
      id: "e1",
      revision: 1,
      minute: 0,
      second: 61,
      type: "goal",
      teamId: "home",
      playerId: "home-p1",
      outcome: "success",
      x: 1,
      y: 1,
    },
  });
  assert.equal(result.success, false);
});
