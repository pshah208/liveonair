import assert from "node:assert/strict";
import test from "node:test";

import type { LiveEnvelope } from "../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import { createLiveService } from "../server/live/service.js";
import { createLocalTransport } from "../server/live/transport.js";

function visionFixture(): MatchFixture {
  const event: MatchEvent = {
    id: "vision-pass-1",
    revision: 1,
    minute: 3,
    second: 12,
    type: "pass",
    teamId: "home",
    playerId: "p1",
    outcome: "complete",
    x: 44,
    y: 51,
    period: 1,
  };
  return {
    id: "vision-fixture",
    seed: 4,
    title: "Vision FC vs Tape FC",
    description: "Synthetic progressive fixture",
    home: { id: "home", name: "Vision FC", shortName: "VIS", players: [{ id: "p1", name: "Ada", number: 8, position: "MF", teamId: "home" }] },
    away: { id: "away", name: "Tape FC", shortName: "TAP", players: [{ id: "p2", name: "Bea", number: 4, position: "DF", teamId: "away" }] },
    events: [event],
    durationSeconds: 90,
    correctionEventId: "none",
    correctionAvailableAt: 0,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test("a progressive vision event still reaches the live service and is tagged video-vision", async () => {
  const published: LiveEnvelope[] = [];
  const local = createLocalTransport();
  const transport = {
    name: "local" as const,
    configured: false,
    async publish(envelope: LiveEnvelope) {
      published.push(structuredClone(envelope));
      await local.publish(envelope);
    },
    subscribe: (onEnvelope: (envelope: LiveEnvelope, receivedAt: number) => void) => local.subscribe(onEnvelope),
    async close() {
      await local.close();
    },
  };
  const received: string[] = [];
  const service = createLiveService({
    transport,
    registry: {
      listFixtures: () => [],
      getFixture: (id) => {
        if (id !== "vision-fixture") throw new RangeError(id);
        return visionFixture();
      },
      registerFixture: (fixture) => ({
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        home: fixture.home,
        away: fixture.away,
        durationSeconds: fixture.durationSeconds,
        eventCount: fixture.events.length,
        correctionAvailableAt: fixture.correctionAvailableAt,
      }),
    },
    generateMatch: () => visionFixture(),
    buildFeedPlan: () => [],
    now: () => 1_700_000_000_000,
  });
  service.addListener({ onEvent: (_view, event) => received.push(event.id) });
  try {
    assert.ok(service.startProgressive);
    assert.ok(service.appendProgressive);
    await service.startProgressive(visionFixture());
    await service.appendProgressive(visionFixture(), 20);
    await flush();
    assert.deepEqual(received, ["vision-pass-1"]);
    const eventEnvelope = published.find((envelope) => envelope.kind === "match_event");
    assert.equal(eventEnvelope?.source, "video-vision");
    assert.equal(eventEnvelope?.event?.id, "vision-pass-1");
    assert.equal(service.status().source, "video-vision");
    assert.equal(published.find((envelope) => envelope.kind === "match_start")?.source, "video-vision");
  } finally {
    await service.close();
  }
});
