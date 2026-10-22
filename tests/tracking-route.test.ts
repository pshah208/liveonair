import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import type { LiveStatus } from "../shared/platform.js";
import type { MatchFixture } from "../shared/types.js";
import type { LiveService } from "../server/contracts.js";
import { createTrackingRouter } from "../server/routes/tracking.js";
import type { TrackingScheduler } from "../server/live/tracking.js";

class FakeScheduler implements TrackingScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; interval: number; callback: () => void }>();

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
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.now = task.due;
      this.tasks.set(id, { ...task, due: task.due + task.interval });
      task.callback();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
}

function fixture(): MatchFixture {
  const players = (teamId: "home" | "away") => Array.from({ length: 11 }, (_, index) => ({
    id: `${teamId}-p${index + 1}`,
    teamId,
    name: `${teamId}-${index + 1}`,
    number: index + 1,
    position: index === 0 ? "GK" : index < 5 ? "CB" : index < 8 ? "CM" : "ST",
  }));
  return {
    id: "fixture-stream",
    seed: 7,
    title: "Blue vs Red",
    description: "tracking stream test",
    home: { id: "home", name: "Blue", shortName: "BLU", players: players("home") },
    away: { id: "away", name: "Red", shortName: "RED", players: players("away") },
    events: [{ id: "e1", revision: 1, minute: 0, second: 0, type: "kickoff", teamId: "home", playerId: "home-p10", outcome: "none", x: 50, y: 50 }],
    durationSeconds: 2,
    correctionEventId: "e1",
    correctionAvailableAt: 1,
  };
}

function createLive(scheduler: FakeScheduler): LiveService {
  const f = fixture();
  const status = (): LiveStatus => {
    const clockSecond = Math.min(f.durationSeconds, scheduler.now / 1000);
    return {
      state: clockSecond >= f.durationSeconds ? "finished" : "running",
      transport: "local",
      transportConfigured: false,
      source: "synthetic",
      clockSecond,
      speed: 1,
      eventsReceived: 1,
      duplicatesIgnored: 0,
      stress: false,
      fixtureId: f.id,
      title: f.title,
      matchId: "match-1",
    };
  };
  return {
    status,
    current() {
      return { matchId: "match-1", fixture: f, clockSecond: Math.min(f.durationSeconds, scheduler.now / 1000) };
    },
    async start() { return status(); },
    async stop() { return status(); },
    async publishCorrection() {},
    addListener() { return () => undefined; },
    async close() {},
  };
}

test("tracking SSE stream closes when the match ends", async () => {
  const scheduler = new FakeScheduler();
  const app = express();
  app.use(createTrackingRouter({ live: createLive(scheduler), scheduler, now: () => scheduler.now }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  try {
    const response = await fetch(`${base}/api/live/tracking/stream`, { headers: { accept: "text/event-stream" } });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);

    await scheduler.advance(2_600);
    let done = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const chunk = await reader!.read();
      if (chunk.done) {
        done = true;
        break;
      }
    }
    assert.equal(done, true, "stream should end once fixture duration is reached");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
