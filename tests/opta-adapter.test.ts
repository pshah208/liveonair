import assert from "node:assert/strict";
import test from "node:test";

import { generateMatch } from "../server/matchlab/generator.js";
import { OPTA_MAPPING, OPTA_STYLE_LABEL } from "../server/ingest/opta/mapping.js";
import {
  adaptOptaEvent,
  canonicalEventToOpta,
  mirrorAttackingDirection,
  roundTripCanonicalEvent,
} from "../server/ingest/opta/adapter.js";
import { createLiveService, type LiveScheduler } from "../server/live/service.js";
import { createLocalTransport } from "../server/live/transport.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";

const teams = [
  { id: OPTA_MAPPING.teams.home, side: "home" as const },
  { id: OPTA_MAPPING.teams.away, side: "away" as const },
];

function event(input: Partial<MatchEvent> & Pick<MatchEvent, "id" | "type" | "teamId" | "playerId">): MatchEvent {
  return {
    revision: 1,
    minute: 12,
    second: 5,
    outcome: "success",
    x: 80,
    y: 40,
    period: 1,
    ...input,
  };
}

function opta(input: Record<string, unknown>) {
  return {
    id: "evt-1",
    period: 1,
    min: 10,
    sec: 2,
    teamId: 1,
    playerId: "p1",
    outcome: 1,
    x: 20,
    y: 30,
    qualifiers: [],
    ...input,
  };
}

test("community type ids and qualifiers map onto canonical events", () => {
  const cases: Array<{ typeId: number; qualifiers?: Array<{ qualifierId: number; value?: string }>; type: string; outcome?: string }> = [
    { typeId: 1, type: "pass", outcome: "complete" },
    { typeId: 7, type: "tackle", outcome: "success" },
    { typeId: 10, type: "save", outcome: "success" },
    { typeId: 13, type: "shot", outcome: "miss" },
    { typeId: 14, type: "shot", outcome: "blocked" },
    { typeId: 15, type: "shot", outcome: "saved" },
    { typeId: 16, type: "goal", outcome: "success" },
    { typeId: 17, qualifiers: [{ qualifierId: 31, value: "yellow" }], type: "yellow_card", outcome: "none" },
    { typeId: 17, qualifiers: [{ qualifierId: 32, value: "second" }], type: "red_card", outcome: "none" },
    { typeId: 17, qualifiers: [{ qualifierId: 33, value: "red" }], type: "red_card", outcome: "none" },
    { typeId: 19, type: "substitution", outcome: "none" },
  ];
  for (const item of cases) {
    const adapted = adaptOptaEvent(opta({ id: `t-${item.typeId}-${item.type}`, typeId: item.typeId, qualifiers: item.qualifiers ?? [] }), teams, () => undefined);
    assert.equal(adapted.kind, "event", `type ${item.typeId}`);
    if (adapted.kind !== "event") continue;
    assert.equal(adapted.event.type, item.type);
    assert.equal(adapted.event.outcome, item.outcome);
  }

  const pressure = canonicalEventToOpta(event({ id: "press-1", type: "pressure", teamId: "home", playerId: "p1" }));
  assert.equal(pressure.typeId, 9101);
  assert.equal(pressure.qualifiers.some((item) => item.qualifierId === 9100 && item.value === "synthetic-extension:pressure"), true);
  const adaptedPressure = roundTripCanonicalEvent(event({ id: "press-1", type: "pressure", teamId: "home", playerId: "p1" }));
  assert.equal(adaptedPressure.kind, "event");
  if (adaptedPressure.kind === "event") assert.equal(adaptedPressure.event.type, "pressure");
});

test("attacking direction is mirrored only at ingestion and restored on the way back", () => {
  const away = event({ id: "pass-away", type: "pass", teamId: "away", playerId: "p2", x: 20, y: 30, endX: 40, endY: 55, outcome: "complete" });
  const encoded = canonicalEventToOpta(away);
  assert.equal(encoded.x, 80);
  assert.equal(encoded.y, 70);
  assert.equal(encoded.qualifiers.find((item) => item.qualifierId === 140)?.value, "60");
  assert.equal(encoded.qualifiers.find((item) => item.qualifierId === 141)?.value, "45");
  const restored = roundTripCanonicalEvent(away);
  assert.equal(restored.kind, "event");
  if (restored.kind === "event") {
    assert.equal(restored.event.x, 20);
    assert.equal(restored.event.y, 30);
    assert.equal(restored.event.endX, 40);
    assert.equal(restored.event.endY, 55);
  }

  const homeSecond = mirrorAttackingDirection(10, 15, "home", 2);
  assert.equal(homeSecond.x, 90);
  assert.equal(homeSecond.y, 85);
  const back = mirrorAttackingDirection(homeSecond.x, homeSecond.y, "home", 2);
  assert.equal(back.x, 10);
  assert.equal(back.y, 15);
});

test("unknown Opta-style types are ignored and logged, and deletions become corrections", () => {
  const logs: string[] = [];
  const unknown = adaptOptaEvent(opta({ typeId: 99, id: "mystery" }), teams, (entry) => logs.push(entry.reason));
  assert.deepEqual(unknown, { kind: "ignored", typeId: 99, reason: "unknown typeId" });
  assert.equal(logs.some((line) => line.includes("Unknown")), true);

  const deleted = adaptOptaEvent(opta({
    id: "del-1",
    typeId: 43,
    qualifiers: [{ qualifierId: 55, value: "goal-9" }],
  }), teams, () => undefined);
  assert.deepEqual(deleted, { kind: "correction", eventId: "goal-9" });

  const rescinded = roundTripCanonicalEvent(event({ id: "goal-9", type: "goal", teamId: "home", playerId: "p1", rescinded: true }));
  assert.deepEqual(rescinded, { kind: "correction", eventId: "goal-9" });
});

test("generator output round-trips through the synthetic Opta-style adapter", () => {
  const seeds = [1, 7, 42, 99, 20261027];
  for (const seed of seeds) {
    const fixture = generateMatch({ scenario: seed % 2 === 0 ? "late_winner" : "comeback", seed });
    assert.equal(fixture.events.length > 0, true);
    for (const original of fixture.events) {
      const adapted = roundTripCanonicalEvent(original);
      if (original.rescinded) {
        assert.equal(adapted.kind, "correction");
        if (adapted.kind === "correction") assert.equal(adapted.eventId, original.id);
        continue;
      }
      assert.equal(adapted.kind, "event", `${original.id} ${original.type}`);
      if (adapted.kind !== "event") continue;
      const next = adapted.event;
      assert.equal(next.id, original.id);
      assert.equal(next.type, original.type);
      assert.equal(next.teamId, original.teamId);
      assert.equal(next.playerId, original.playerId);
      assert.equal(next.outcome, original.outcome);
      assert.equal(next.minute, original.minute);
      assert.equal(next.second, original.second);
      assert.equal(next.revision, original.revision);
      assert.ok(Math.abs(next.x - original.x) <= 0.02, `${original.id} x`);
      assert.ok(Math.abs(next.y - original.y) <= 0.02, `${original.id} y`);
      if (original.endX !== undefined && original.endY !== undefined && next.endX !== undefined && next.endY !== undefined) {
        assert.ok(Math.abs(next.endX - original.endX) <= 0.02);
        assert.ok(Math.abs(next.endY - original.endY) <= 0.02);
      }
      if (original.xg !== undefined && next.xg !== undefined) assert.ok(Math.abs(next.xg - original.xg) < 1e-9);
      assert.equal(canonicalEventToOpta(original).typeId > 0, true);
    }
  }
  assert.equal(OPTA_STYLE_LABEL, "Opta-style format, synthetic data");
});

class FakeScheduler implements LiveScheduler {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  setInterval(): number { return 0; }
  clearInterval(): void {}
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].due;
      next[1].callback();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    }
    this.now = target;
  }
}

test("LIVE_SOURCE=opta-format publishes adapted events and rescinds deletions", async () => {
  const scheduler = new FakeScheduler();
  const goal: MatchEvent = event({ id: "goal-9", type: "goal", teamId: "home", playerId: "p1" });
  const deletedGoal: MatchEvent = { ...goal, rescinded: true };
  const pass: MatchEvent = event({ id: "pass-1", type: "pass", teamId: "away", playerId: "p2", x: 20, y: 30, outcome: "complete" });
  const seed: MatchFixture = {
    id: "opta-live",
    seed: 3,
    title: "Opta-style format, synthetic data",
    description: OPTA_STYLE_LABEL,
    home: { id: "home", name: "Blue FC", shortName: "BLU", players: [{ id: "p1", name: "Ada", number: 9, position: "FW", teamId: "home" }] },
    away: { id: "away", name: "Red FC", shortName: "RED", players: [{ id: "p2", name: "Bea", number: 8, position: "MF", teamId: "away" }] },
    events: [goal, pass],
    durationSeconds: 120,
    correctionEventId: "goal-9",
    correctionAvailableAt: 40,
  };
  const received: MatchEvent[] = [];
  const service = createLiveService({
    transport: createLocalTransport(),
    registry: {
      listFixtures: () => [],
      getFixture: () => structuredClone(seed),
      registerFixture: () => ({ id: seed.id, title: seed.title, description: seed.description, home: seed.home, away: seed.away, durationSeconds: seed.durationSeconds, eventCount: 2, correctionAvailableAt: 40 }),
    },
    generateMatch: () => seed,
    buildFeedPlan: () => [{ publishAtSecond: 0, event: pass }, { publishAtSecond: 0, event: deletedGoal }],
    scheduler,
    now: () => 1_700_000_000_000,
    liveSource: "opta-format",
  });
  service.addListener({ onEvent: (_view, item) => received.push(item) });
  try {
    await service.start({ fixtureId: seed.id, speed: 60 });
    assert.equal(service.status().source, "opta-format-synthetic");
    await scheduler.advance(1);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    const passEvent = received.find((item) => item.id === "pass-1");
    const rescinded = received.find((item) => item.id === "goal-9");
    assert.ok(passEvent);
    assert.equal(passEvent?.x, 20);
    assert.equal(rescinded?.rescinded, true);
    assert.equal(rescinded?.revision, 2);
  } finally {
    await service.close();
  }
});
