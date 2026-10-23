import assert from "node:assert/strict";
import test from "node:test";

import type express from "express";

import type { FixtureRegistry } from "../server/contracts.js";
import { eventSecond } from "../server/fixtures.js";
import { buildFeedPlan } from "../server/matchlab/feed.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";
import { startTrackingStream } from "../server/live/tracking.js";
import { createLocalTransport } from "../server/live/transport.js";
import { buildTrackingFrame, TRACKING_DELAY_SECONDS, type TrackingFrame, type TrackingStreamMessage } from "../shared/tracking.js";
import type { MatchFixture } from "../shared/types.js";

/**
 * Fake clock that can model an event-loop stall: while `holdTimeouts` is set,
 * interval callbacks (the service ticker, the tracking tick) keep firing but
 * one-shot timers (feed publishes) stay queued, exactly as when the ticker
 * wins the race against overdue publish timers.
 */
class StallScheduler implements LiveScheduler {
  now = 0;
  holdTimeouts = false;
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
        .filter(([, task]) => task.due <= target && !(this.holdTimeouts && task.interval === undefined))
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.now = Math.max(this.now, task.due);
      if (task.interval === undefined) this.tasks.delete(id);
      else this.tasks.set(id, { ...task, due: task.due + task.interval });
      task.callback();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    }
    this.now = target;
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  }
}

const DURATION_SECONDS = 900;

function truncatedFixture(): MatchFixture {
  const full = generateMatch({ scenario: "goal_fest", seed: 17 });
  return {
    ...full,
    id: "watermark-fixture",
    durationSeconds: DURATION_SECONDS,
    events: full.events.filter((event) => eventSecond(event) <= DURATION_SECONDS - 5),
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

type Emitted = { frame: TrackingFrame; watermark: number; clock: number };

function fakeResponse(onMessage: (message: TrackingStreamMessage) => void): express.Response & { ended: boolean } {
  const response = {
    ended: false,
    write(chunk: string) {
      onMessage(JSON.parse(chunk.replace(/^data: /, "").trim()) as TrackingStreamMessage);
      return true;
    },
    on() { return response; },
    off() { return response; },
    end() { response.ended = true; return response; },
  };
  return response as unknown as express.Response & { ended: boolean };
}

test("live tracking frames never look past the received-event watermark and equal replay after a stall", async () => {
  const fixture = truncatedFixture();
  const scheduler = new StallScheduler();
  const live = createLiveService({
    transport: createLocalTransport(),
    registry: registryFor(fixture),
    generateMatch,
    buildFeedPlan,
    now: () => scheduler.now,
    scheduler,
  });

  const emitted: Emitted[] = [];
  const statuses: string[] = [];
  const response = fakeResponse((message) => {
    if (message.type === "frame") {
      emitted.push({ frame: message.frame, watermark: live.publishedThroughSecond!(), clock: live.current()?.clockSecond ?? 0 });
    } else if (message.type === "status") {
      statuses.push(message.status);
    }
  });

  try {
    await live.start({ fixtureId: fixture.id, speed: 60 });
    const stop = startTrackingStream({ live, response, scheduler, now: () => scheduler.now });

    await scheduler.advance(3_000);
    const beforeStall = emitted.length;
    assert.ok(beforeStall > 0, "frames flow before the stall");

    // Stall: the 1 s service ticker and 5 Hz tracking tick keep firing while
    // the due publish timers are starved. The clock runs ~300 s ahead.
    scheduler.holdTimeouts = true;
    await scheduler.advance(1); // let already-dispatched publishes settle
    const stallWatermark = live.publishedThroughSecond!();
    await scheduler.advance(5_000);
    const stalled = emitted.slice(beforeStall);
    assert.ok(stalled.length > 0, "the tracking tick keeps emitting during the stall");
    const clockDuringStall = live.current()!.clockSecond;
    const watermarkAfterStall = live.publishedThroughSecond!();
    // Publishes already dispatched before the stall may still settle; nothing new is due.
    assert.ok(watermarkAfterStall < stallWatermark + 30, `watermark ${watermarkAfterStall} should be held near ${stallWatermark}`);
    assert.ok(clockDuringStall - watermarkAfterStall > 200, `ticker ran ahead (clock ${clockDuringStall}, watermark ${watermarkAfterStall})`);
    assert.ok(stalled.some((entry) => entry.clock - TRACKING_DELAY_SECONDS - entry.frame.second > 100),
      "the clock-only horizon would have built these frames far past the received events");
    for (const entry of stalled) {
      assert.ok(entry.frame.second === 0 || entry.frame.second + TRACKING_DELAY_SECONDS <= entry.watermark + 1e-6,
        `frame ${entry.frame.second} built past watermark ${entry.watermark} (clock ${entry.clock})`);
    }

    // Release: overdue publishes land, then the match runs and drains to the end.
    scheduler.holdTimeouts = false;
    for (let index = 0; index < 40 && !response.ended; index += 1) await scheduler.advance(1_000);
    stop();
    assert.equal(response.ended, true, "stream closes after the end-of-match drain");
    assert.equal(statuses.at(-1), "ended");

    for (const entry of emitted) {
      assert.ok(entry.frame.second === 0 || entry.frame.second + TRACKING_DELAY_SECONDS <= entry.watermark + 1e-6 || entry.watermark >= DURATION_SECONDS,
        `frame ${entry.frame.second} built past watermark ${entry.watermark}`);
    }

    // Replay against the full fixture on a fresh timeline (different cache key).
    const finalFixture = live.current()!.fixture;
    const replayFixture: MatchFixture = { ...structuredClone(finalFixture), id: `${finalFixture.id}-replay` };
    let maxDiff = 0;
    let worst = "";
    for (const { frame } of emitted) {
      const replay = buildTrackingFrame(replayFixture, frame.second);
      const byId = new Map(replay.players.map((player) => [player.id, player]));
      for (const player of frame.players) {
        const other = byId.get(player.id);
        assert.ok(other, `player ${player.id} missing in replay`);
        const diff = Math.hypot(player.x - other.x, player.y - other.y);
        if (diff > maxDiff) { maxDiff = diff; worst = `${player.id}@${frame.second}`; }
      }
    }
    assert.ok(maxDiff < 1e-3, `live diverged from replay by ${maxDiff.toFixed(3)} m at ${worst}`);
    assert.equal(emitted.at(-1)!.frame.second, DURATION_SECONDS);
  } finally {
    await live.close();
  }
});
