import assert from "node:assert/strict";
import test from "node:test";

import type { LiveEnvelope } from "../shared/platform.js";
import type { MatchFixture } from "../shared/types.js";
import type { FixtureRegistry, LiveTransportClient } from "../server/contracts.js";
import { createLiveService } from "../server/live/service.js";
import { createFallbackTransport, createLocalTransport } from "../server/live/transport.js";

function fixture(): MatchFixture {
  return {
    id: "fallback-fixture",
    seed: 1,
    title: "Blue FC vs Red FC",
    description: "Synthetic fallback fixture",
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: [{ id: "p1", name: "Alice", number: 9, position: "FW", teamId: "home" }] },
    away: { id: "away", name: "Red FC", shortName: "RED", players: [{ id: "p2", name: "Cara", number: 10, position: "FW", teamId: "away" }] },
    events: [],
    durationSeconds: 90,
    correctionEventId: "goal-1",
    correctionAvailableAt: 45,
  };
}

function registry(seed = fixture()): FixtureRegistry {
  const fixtures = new Map<string, MatchFixture>([[seed.id, structuredClone(seed)]]);
  return {
    listFixtures: () => [],
    getFixture(id) {
      const found = fixtures.get(id);
      if (!found) throw new RangeError(id);
      return structuredClone(found);
    },
    registerFixture(next) {
      fixtures.set(next.id, structuredClone(next));
      return { id: next.id, title: next.title, description: next.description, home: next.home, away: next.away, durationSeconds: next.durationSeconds, eventCount: next.events.length, correctionAvailableAt: next.correctionAvailableAt };
    },
  };
}

class FlakyPrimary implements LiveTransportClient {
  readonly name = "fabric-eventstream" as const;
  readonly configured = true;
  publishes = 0;
  fail = true;
  async publish(): Promise<void> {
    this.publishes += 1;
    if (this.fail) {
      throw new Error("Endpoint=sb://secret.servicebus.windows.net/;SharedAccessKey=super-secret; publish failed");
    }
  }
  async subscribe(): Promise<() => Promise<void>> {
    return async () => undefined;
  }
  async close(): Promise<void> {}
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test("a failed Eventstream publish falls back to the local bus without dropping the event", async () => {
  const primary = new FlakyPrimary();
  const logs: Array<Record<string, unknown>> = [];
  const transport = createFallbackTransport(primary, createLocalTransport(), (entry) => logs.push(entry));
  const seen: string[] = [];
  const service = createLiveService({
    transport,
    registry: registry(),
    generateMatch: () => { throw new Error("not used"); },
    buildFeedPlan: () => [],
    now: () => 1_700_000_000_000,
  });
  service.addListener({
    onMatchStart: () => seen.push("start"),
    onEvent: () => seen.push("event"),
    onMatchEnd: () => seen.push("end"),
  });

  assert.equal(service.status().transport, "eventstream");
  assert.equal(service.status().fallbackReason, null);

  await service.start({ fixtureId: "fallback-fixture", speed: 60 });
  await flush();

  assert.equal(primary.publishes, 1);
  assert.equal(transport.name, "local");
  assert.equal(service.status().transport, "local");
  assert.match(String(service.status().fallbackReason), /publish failed/);
  assert.equal(String(service.status().fallbackReason).includes("super-secret"), false);
  assert.equal(String(service.status().fallbackReason).includes("secret.servicebus"), false);
  assert.deepEqual(seen, ["start"]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.reason, "Eventstream publish failed; switching to local bus");

  await service.stop();
  await flush();
  assert.equal(primary.publishes, 1, "fallback must not retry Eventstream");
  assert.equal(logs.length, 1, "the switch is logged once");
  assert.deepEqual(seen, ["start", "end"]);
  await service.close();
});

test("a healthy Eventstream publish stays on eventstream", async () => {
  const primary = new FlakyPrimary();
  primary.fail = false;
  const delivered: LiveEnvelope[] = [];
  const transport = createFallbackTransport(primary, createLocalTransport());
  await transport.subscribe((envelope) => delivered.push(envelope));
  await transport.publish({
    kind: "match_end",
    matchId: "m-1",
    sequence: 1,
    publishedAt: "2026-07-27T12:00:00.000Z",
    source: "synthetic",
  });
  assert.equal(transport.name, "eventstream");
  assert.equal(transport.fallbackReason, null);
  assert.equal(primary.publishes, 1);
  assert.equal(delivered.length, 0, "a successful primary publish is not copied onto the local bus");
  await transport.close();
});
