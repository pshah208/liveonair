import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateMatchRequest } from "../shared/platform.js";
import type { MatchFixture } from "../shared/types.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";
import { createLocalTransport } from "../server/live/transport.js";

class FakeScheduler implements LiveScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  setInterval(callback: () => void, intervalMs: number): number {
    return this.setTimeout(callback, intervalMs);
  }
  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.due <= target).sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.now = task.due;
      this.tasks.delete(id);
      task.callback();
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
    }
    this.now = target;
  }
}

function demoFixture(): MatchFixture {
  return {
    id: "gen-late_winner-20261027",
    seed: 20261027,
    title: "Demo FC vs Idle FC",
    description: "Synthetic demo",
    home: { id: "home", name: "Demo FC", shortName: "DEM", players: [{ id: "p1", name: "Ada", number: 9, position: "FW", teamId: "home" }] },
    away: { id: "away", name: "Idle FC", shortName: "IDL", players: [{ id: "p2", name: "Bea", number: 1, position: "GK", teamId: "away" }] },
    events: [],
    durationSeconds: 3600,
    correctionEventId: "none",
    correctionAvailableAt: 30,
  };
}

test("idle watchdog starts one synthetic demo and stays quiet when disabled or a match is live", async () => {
  const scheduler = new FakeScheduler();
  const requests: GenerateMatchRequest[] = [];
  const logs: string[] = [];
  const original = console.info;
  console.info = (line?: unknown) => {
    logs.push(String(line));
  };
  const service = createLiveService({
    transport: createLocalTransport(),
    registry: { listFixtures: () => [], getFixture: () => demoFixture(), registerFixture: (fixture) => ({ id: fixture.id, title: fixture.title, description: fixture.description, home: fixture.home, away: fixture.away, durationSeconds: fixture.durationSeconds, eventCount: 0, correctionAvailableAt: fixture.correctionAvailableAt }) },
    generateMatch: (request) => {
      requests.push(request);
      return demoFixture();
    },
    buildFeedPlan: () => [],
    scheduler,
    now: () => 1_700_000_000_000,
    watchdogMinutes: 1,
  });
  try {
    assert.equal(service.status().state, "idle");
    await scheduler.advance(59_999);
    assert.equal(service.status().state, "idle");
    await scheduler.advance(1);
    for (let index = 0; index < 20 && service.status().state !== "running"; index += 1) {
      await Promise.resolve();
    }
    assert.equal(service.status().state, "running");
    assert.deepEqual(requests, [{ scenario: "late_winner", seed: 20261027 }]);
    assert.equal(logs.some((line) => line.includes("demo_watchdog")), true);

    await scheduler.advance(30_000);
    assert.equal(requests.length, 1, "a live match must not be replaced by the demo");

    await service.stop();
    await scheduler.advance(60_000);
    for (let index = 0; index < 20 && requests.length < 2; index += 1) await Promise.resolve();
    assert.equal(requests.length, 2);
    assert.equal(service.status().state, "running");
  } finally {
    console.info = original;
    await service.close();
  }
});

test("a zero watchdog does not auto-start a demo", async () => {
  const scheduler = new FakeScheduler();
  let generated = 0;
  const service = createLiveService({
    transport: createLocalTransport(),
    registry: { listFixtures: () => [], getFixture: () => { throw new RangeError("missing"); }, registerFixture: (fixture) => ({ id: fixture.id, title: fixture.title, description: fixture.description, home: fixture.home, away: fixture.away, durationSeconds: fixture.durationSeconds, eventCount: 0, correctionAvailableAt: fixture.correctionAvailableAt }) },
    generateMatch: () => {
      generated += 1;
      return demoFixture();
    },
    buildFeedPlan: () => [],
    scheduler,
    watchdogMinutes: 0,
  });
  try {
    await scheduler.advance(60 * 60_000);
    assert.equal(service.status().state, "idle");
    assert.equal(generated, 0);
  } finally {
    await service.close();
  }
});
