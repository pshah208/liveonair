import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createApp, type EngineAdapter } from "../server/app.js";
import type {
  AnalysisRequest,
  MatchFixture,
  MatchSnapshot,
  NarrativeRequest,
  NarrativeResponse,
} from "../shared/types.js";

const staticDir = mkdtempSync(resolve(tmpdir(), "matchlens-api-test-"));
writeFileSync(
  resolve(staticDir, "index.html"),
  "<!doctype html><html><head><script>\n  window.__theme='dark';\n</script></head><body><div id='root'></div></body></html>",
  "utf8",
);

function createFixture(): MatchFixture {
  return {
    id: "fixture-1",
    seed: 7,
    title: "Blue FC vs Red FC",
    description: "Synthetic fixture",
    home: {
      id: "home",
      name: "Blue FC",
      shortName: "BLU",
      players: [
        { id: "p1", name: "Alice", number: 9, position: "FW", teamId: "home" },
        { id: "p2", name: "Bea", number: 8, position: "MF", teamId: "home" },
      ],
    },
    away: {
      id: "away",
      name: "Red FC",
      shortName: "RED",
      players: [
        { id: "p3", name: "Cara", number: 10, position: "FW", teamId: "away" },
      ],
    },
    events: [],
    durationSeconds: 5400,
    correctionEventId: "goal-1",
    correctionAvailableAt: 2100,
  };
}

function createSnapshot(stateVersion = "v1"): MatchSnapshot {
  return {
    fixtureId: "fixture-1",
    atSecond: 1800,
    stateVersion,
    persona: "analyst",
    language: "en",
    score: { home: 1, away: 0 },
    stats: {
      home: { goals: 1, shots: 4, passes: 20, completedPasses: 15, passAccuracy: 75, corners: 1, tackles: 2, pressureEvents: 3, fouls: 1, yellowCards: 0, redCards: 0, illustrativeXg: 0.8 },
      away: { goals: 0, shots: 2, passes: 18, completedPasses: 10, passAccuracy: 55.5, corners: 0, tackles: 3, pressureEvents: 4, fouls: 2, yellowCards: 1, redCards: 0, illustrativeXg: 0.3 },
    },
    stories: [
      {
        id: "s1",
        kind: "turning_point",
        title: "Blue press forces a finish",
        summary: "Summary",
        whyItMatters: "Why",
        evidenceIds: ["goal-1"],
        metrics: [{ label: "xG", value: 0.3 }],
        confidence: "observed",
        importance: 95,
        windowStart: 1200,
        windowEnd: 1800,
        teamId: "home",
      },
    ],
    recentEvents: [
      {
        id: "goal-1",
        revision: 1,
        minute: 28,
        second: 15,
        type: "goal",
        teamId: "home",
        playerId: "p1",
        outcome: "success",
        x: 0.8,
        y: 0.3,
      },
    ],
    evidence: {
      "goal-1": {
        id: "goal-1",
        revision: 1,
        minute: 28,
        second: 15,
        type: "goal",
        teamId: "home",
        playerId: "p1",
        outcome: "success",
        x: 0.8,
        y: 0.3,
      },
    },
    corrections: [],
    eventCount: 1,
    evidenceCoverage: 1,
    synthetic: true,
  };
}

class MockNarrator {
  constructor(
    private readonly configured: boolean,
    private readonly response?: NarrativeResponse,
  ) {}

  health() {
    return {
      configured: this.configured,
      deployment: this.configured ? "test-model" : "",
      authentication: this.configured ? "managed_identity_or_cli" : "unconfigured",
    } as const;
  }

  async narrate(): Promise<NarrativeResponse> {
    if (!this.configured || !this.response) {
      throw new Error("should not call");
    }
    return structuredClone(this.response);
  }
}

function createEngine(): EngineAdapter {
  const fixture = createFixture();
  const snapshot = createSnapshot();

  return {
    listFixtures() {
      return [{
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        home: fixture.home,
        away: fixture.away,
        durationSeconds: fixture.durationSeconds,
        eventCount: 1,
        correctionAvailableAt: fixture.correctionAvailableAt,
      }];
    },
    getFixture(id: string) {
      if (id !== fixture.id) {
        throw new RangeError("missing");
      }
      return fixture;
    },
    analyzeMatch(request: AnalysisRequest) {
      return { ...snapshot, persona: request.persona, language: request.language, atSecond: request.atSecond };
    },
  };
}

async function withServer(
  handler: (baseUrl: string) => Promise<void>,
  narrator = new MockNarrator(true, {
    title: "Blue lead",
    script: "Blue lead through the press.",
    claims: [{ text: "Blue lead through Alice's goal.", evidenceIds: ["goal-1"] }],
    trace: [],
    source: "foundry",
    model: "test-model",
    stateVersion: "v1",
    latencyMs: 5,
    cached: false,
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
  useRealEngine = false,
) {
  const app = createApp({ engine: useRealEngine ? undefined : createEngine(), narrator, staticDir, version: "test-version" });
  const server = http.createServer(app);
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer()));
  }
}

test("GET /api/fixtures and fixture detail work", async () => {
  await withServer(async (baseUrl) => {
    const fixtures = await fetch(`${baseUrl}/api/fixtures`).then((response) => response.json());
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].id, "fixture-1");

    const fixture = await fetch(`${baseUrl}/api/fixtures/fixture-1`).then((response) => response.json());
    assert.equal(fixture.home.players[0].id, "p1");
  });
});

test("unknown fixture returns 404", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fixtures/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Fixture not found" });
  });
});

test("unknown api route returns JSON 404", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  });
});

test("CSP is set for SPA responses", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self' 'sha256-/u);
    assert.match(csp, /media-src 'self' blob:/u);
    assert.doesNotMatch(csp, /connect-src[^;]*blob:/u);
    const { hashInlineScript } = await import("../server/narrator.js");
    assert.ok(csp.includes(hashInlineScript("\n  window.__theme='dark';\n")));
  });
});

test("malformed JSON body returns 400", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Malformed JSON body" });
  });
});

test("strict validation rejects unknown fields and bad player IDs", async () => {
  await withServer(async (baseUrl) => {
    const withExtra = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "fixture-1",
        atSecond: 1800,
        persona: "analyst",
        language: "en",
        extra: true,
      }),
    });
    assert.equal(withExtra.status, 400);

    const wrongPlayer = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "fixture-1",
        atSecond: 1800,
        persona: "analyst",
        language: "en",
        favoritePlayerId: "missing-player",
      }),
    });
    assert.equal(wrongPlayer.status, 400);

    const wrongClock = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "fixture-1",
        atSecond: 5401,
        persona: "analyst",
        language: "en",
      }),
    });
    assert.equal(wrongClock.status, 400);
  });
});

test("health exposes configured AI mode", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`).then((result) => result.json());
    assert.equal(response.ai.configured, true);
    assert.equal(response.version, "test-version");
  });
});

test("narrate returns 503 when AI is unavailable", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/narrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "fixture-1",
        atSecond: 1800,
        persona: "analyst",
        language: "en",
        format: "story",
      } satisfies NarrativeRequest),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "AI narration is not configured" });
  }, new MockNarrator(false));
});

test("narration route returns provider result", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/narrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixtureId: "fixture-1",
        atSecond: 1800,
        persona: "analyst",
        language: "en",
        format: "story",
        storyId: "s1",
      } satisfies NarrativeRequest),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.source, "foundry");
  });
});

test("default application wiring serves real fixtures and isolated corrected states", async () => {
  await withServer(async (baseUrl) => {
    const catalog = await fetch(`${baseUrl}/api/fixtures`).then((response) => response.json());
    assert.equal(catalog.length, 3);
    const fixture = await fetch(`${baseUrl}/api/fixtures/${catalog[0].id}`).then((response) => response.json());
    const payload = { fixtureId: fixture.id, atSecond: 5400, persona: "analyst", language: "en" };
    async function analyze(correction: boolean): Promise<MatchSnapshot> {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, correction }),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const original = await analyze(false);
    const corrected = await analyze(true);
    const anotherViewer = await analyze(false);
    assert.deepEqual(original, anotherViewer);
    assert.notEqual(original.stateVersion, corrected.stateVersion);
    assert.equal(
      original.score.home + original.score.away,
      corrected.score.home + corrected.score.away + 1,
    );
    assert.ok(corrected.evidence[fixture.correctionEventId].rescinded);
    assert.ok(!corrected.recentEvents.some((event) => event.rescinded));
  }, new MockNarrator(false), true);
});

test("oversized JSON is rejected with an explicit 413 response", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oversized: "x".repeat(17_000) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "JSON body exceeds the 16kb limit" });
  });
});

test("POST /api/live/narrate narrates the live view, honouring live corrections", async () => {
  const { getFixture } = await import("../server/fixtures.js");
  const liveFixture = structuredClone(getFixture("rivergate-comeback"));
  const goal = liveFixture.events.find((event) => event.type === "goal")!;
  liveFixture.events.push({ ...goal, revision: goal.revision + 1, rescinded: true });
  const seen: { request?: NarrativeRequest; snapshot?: MatchSnapshot } = {};
  const narrator = {
    health: () => ({ configured: true, deployment: "test-model", authentication: "managed_identity_or_cli" }) as const,
    async narrate(request: NarrativeRequest, snapshot: MatchSnapshot): Promise<NarrativeResponse> {
      seen.request = request;
      seen.snapshot = snapshot;
      return { title: "Recap", script: "Script", claims: [], trace: [], source: "foundry", model: "test-model", stateVersion: snapshot.stateVersion, latencyMs: 1, cached: false, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  let view: { matchId: string; fixture: MatchFixture; clockSecond: number } | undefined;
  const platform = {
    live: {
      status: () => ({ state: view ? "finished" : "idle", transport: "local", transportConfigured: false, clockSecond: 0, speed: 1, eventsReceived: 0, duplicatesIgnored: 0, stress: false }),
      current: () => view,
    },
    desk: {},
    close: async () => undefined,
  };
  const app = createApp({ narrator: narrator as never, platform: platform as never, staticDir, version: "test-version" });
  const server = http.createServer(app);
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const missing = await fetch(`${baseUrl}/api/live/narrate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: "analyst", language: "en" }) });
    assert.equal(missing.status, 404);

    view = { matchId: "m1", fixture: liveFixture, clockSecond: liveFixture.durationSeconds };
    const invalid = await fetch(`${baseUrl}/api/live/narrate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: "robot", language: "en" }) });
    assert.equal(invalid.status, 400);

    const response = await fetch(`${baseUrl}/api/live/narrate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: "casual", language: "es" }) });
    assert.equal(response.status, 200);
    assert.equal(seen.request?.fixtureId, liveFixture.id);
    assert.equal(seen.request?.atSecond, liveFixture.durationSeconds);
    assert.equal(seen.request?.format, "recap");
    assert.equal(seen.request?.language, "es");
    const activeGoals = liveFixture.events.filter((event) => event.type === "goal" && event.revision === 1 && event.id !== goal.id).length;
    assert.equal((seen.snapshot?.score.home ?? 0) + (seen.snapshot?.score.away ?? 0), activeGoals);
  } finally {
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
  }
});

test.after(() => {
  rmSync(staticDir, { recursive: true, force: true });
});
