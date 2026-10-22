import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createApp } from "../server/app.js";
import { createArchiveRouter } from "../server/routes/archive.js";
import { createLiveRouter } from "../server/routes/live.js";
import { bearerToken, createStudioAuth, requiresStudioAuth, studioAccessGranted, studioAuthRequired, tokensMatch } from "../server/routes/studioAuth.js";
import { HttpError, isHttpError } from "../server/validation.js";

const TOKEN = "studio-secret";

function listen(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
    server.on("error", reject);
  });
}

function probeApp(token?: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createStudioAuth(token));
  app.get("/api/live/status", (_request, response) => response.json({ ok: true }));
  app.get("/api/studio/auth-required", (_request, response) => response.json({ required: true }));
  app.get("/api/studio/storylines", (_request, response) => response.json([]));
  app.post("/api/live/start", (_request, response) => response.json({ ok: true }));
  app.post("/api/live/stop", (_request, response) => response.json({ ok: true }));
  app.post("/api/live/correction", (_request, response) => response.json({ ok: true }));
  app.post("/api/studio/storylines/s1/review", (_request, response) => response.json({ ok: true }));
  app.post("/api/video/jobs", (_request, response) => response.json({ ok: true }));
  app.delete("/api/player-cam/jobs/job-1", (_request, response) => response.json({ ok: true }));
  app.post("/api/analyze", (_request, response) => response.json({ ok: true }));
  app.post("/api/narrate", (_request, response) => response.json({ ok: true }));
  app.post("/api/matchlab/generate", (_request, response) => response.json({ ok: true }));
  return app;
}

async function call(baseUrl: string, method: string, path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: method === "GET" ? undefined : "{}",
  });
}

test("studio auth stays open when no token is configured", async () => {
  assert.equal(studioAuthRequired(undefined), false);
  assert.equal(studioAuthRequired("  "), false);
  const server = await listen(probeApp(undefined));
  try {
    assert.equal((await call(server.baseUrl, "POST", "/api/live/start")).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/video/jobs")).status, 200);
    assert.equal((await call(server.baseUrl, "DELETE", "/api/player-cam/jobs/job-1")).status, 200);
  } finally {
    await server.close();
  }
});

test("studio token guards producer writes and studio reads, and leaves fan reads and narration open", async () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch("nope", TOKEN), false);
  assert.equal(tokensMatch("studio-secret-extra", TOKEN), false);
  assert.equal(bearerToken("Bearer studio-secret"), TOKEN);
  assert.equal(requiresStudioAuth("GET", "/api/studio/storylines"), true);
  assert.equal(requiresStudioAuth("GET", "/API/STUDIO/STORYLINES/"), true);
  assert.equal(requiresStudioAuth("GET", "/api/studio/auth-required"), false);
  assert.equal(requiresStudioAuth("GET", "/API/STUDIO/AUTH-REQUIRED/"), false);
  assert.equal(requiresStudioAuth("POST", "/API/LIVE/STOP"), true);
  assert.equal(requiresStudioAuth("POST", "/api/live/stop/"), true);
  assert.equal(requiresStudioAuth("POST", "/API/MATCHLAB/GENERATE"), true);
  assert.equal(requiresStudioAuth("GET", "/api/fan/moments"), false);
  assert.equal(requiresStudioAuth("GET", "/api/live/status"), false);
  assert.equal(requiresStudioAuth("GET", "/api/live/tracking/stream"), false);
  assert.equal(requiresStudioAuth("GET", "/api/overlay/stream"), false);
  assert.equal(requiresStudioAuth("GET", "/api/health"), false);
  assert.equal(requiresStudioAuth("GET", "/api/live/stream"), false);
  assert.equal(requiresStudioAuth("POST", "/api/analyze"), false);
  assert.equal(requiresStudioAuth("POST", "/api/live/start"), true);
  assert.equal(studioAccessGranted(undefined, undefined), true);
  assert.equal(studioAccessGranted(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(studioAccessGranted(undefined, TOKEN), false);
  assert.equal(studioAccessGranted("Bearer wrong", TOKEN), false);

  const server = await listen(probeApp(TOKEN));
  try {
    const missing = await call(server.baseUrl, "POST", "/api/live/start");
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, "Studio authorization required");
    assert.match(missing.headers.get("www-authenticate") ?? "", /realm="studio"/);

    const wrong = await call(server.baseUrl, "POST", "/api/studio/storylines/s1/review", "other-token");
    assert.equal(wrong.status, 401);
    assert.equal((await call(server.baseUrl, "POST", "/api/video/jobs", "other-token")).status, 401);
    assert.equal((await call(server.baseUrl, "DELETE", "/api/player-cam/jobs/job-1")).status, 401);

    assert.equal((await call(server.baseUrl, "POST", "/api/live/start", TOKEN)).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/live/stop", TOKEN)).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/live/correction", TOKEN)).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/video/jobs", TOKEN)).status, 200);

    assert.equal((await call(server.baseUrl, "POST", "/API/LIVE/STOP")).status, 401);
    assert.equal((await call(server.baseUrl, "POST", "/Api/Live/Stop/", TOKEN)).status, 200);
    assert.equal((await call(server.baseUrl, "GET", "/API/STUDIO/STORYLINES")).status, 401);
    assert.equal((await call(server.baseUrl, "GET", "/api/studio/storylines", TOKEN)).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/matchlab/generate")).status, 401);
    assert.equal((await call(server.baseUrl, "POST", "/API/MATCHLAB/GENERATE", TOKEN)).status, 200);

    assert.equal((await call(server.baseUrl, "GET", "/api/live/status")).status, 200);
    assert.equal((await call(server.baseUrl, "GET", "/api/studio/auth-required")).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/analyze")).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/narrate")).status, 200);
  } finally {
    await server.close();
  }
});

test("GET /api/studio/auth-required reports whether a producer token is configured", async () => {
  const platform = {
    live: {
      status: () => ({ state: "idle", transport: "local", transportConfigured: false, clockSecond: 0, speed: 1, eventsReceived: 0, duplicatesIgnored: 0, stress: false, source: "synthetic", fallbackReason: null }),
      current: () => undefined,
      addListener: () => () => undefined,
      subscribeTicks: () => () => undefined,
    },
    desk: {
      list: () => [],
      facts: () => [],
      subscribe: () => () => undefined,
      health: () => ({ mode: "unconfigured", agents: [], retrieval: "none" }),
    },
    close: async () => undefined,
  };
  const open = createApp({ narrator: { health: () => ({ configured: false }) } as never, platform: platform as never, studioToken: "", version: "test" });
  const closed = createApp({ narrator: { health: () => ({ configured: false }) } as never, platform: platform as never, studioToken: TOKEN, version: "test" });
  const openServer = await listen(open);
  const closedServer = await listen(closed);
  try {
    assert.deepEqual(await (await fetch(`${openServer.baseUrl}/api/studio/auth-required`)).json(), { required: false });
    assert.deepEqual(await (await fetch(`${closedServer.baseUrl}/api/studio/auth-required`)).json(), { required: true });
    const overlay = await (await fetch(`${closedServer.baseUrl}/api/overlay/current`)).json();
    assert.equal(overlay.schema, "live-on-air.overlay/1");
    assert.equal(JSON.stringify(overlay).includes("playerTags"), false);
    const blocked = await fetch(`${closedServer.baseUrl}/api/live/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generate: { scenario: "late_winner", seed: 1 }, speed: 1 }),
    });
    assert.equal(blocked.status, 401);
  } finally {
    await openServer.close();
    await closedServer.close();
  }
});

test("configured studio token locks studio reads and matchlab generate without closing public surfaces", async () => {
  const platform = {
    live: {
      status: () => ({ state: "idle", transport: "local", transportConfigured: false, clockSecond: 0, speed: 1, eventsReceived: 0, duplicatesIgnored: 0, stress: false, source: "synthetic", fallbackReason: null }),
      current: () => undefined,
      addListener: () => () => undefined,
      subscribeTicks: () => () => undefined,
    },
    desk: {
      list: () => [],
      facts: () => [],
      subscribe: () => () => undefined,
      health: () => ({ mode: "unconfigured", agents: [], retrieval: "none" }),
    },
    close: async () => undefined,
  };
  const open = createApp({ narrator: { health: () => ({ configured: false }) } as never, platform: platform as never, studioToken: "", version: "test" });
  const closed = createApp({ narrator: { health: () => ({ configured: false }) } as never, platform: platform as never, studioToken: TOKEN, version: "test" });
  const openServer = await listen(open);
  const closedServer = await listen(closed);
  const tracking = new AbortController();
  try {
    const openGenerate = await fetch(`${openServer.baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(openGenerate.status, 400);

    const hidden = await fetch(`${closedServer.baseUrl}/API/STUDIO/STORYLINES`);
    assert.equal(hidden.status, 401);
    const shown = await fetch(`${closedServer.baseUrl}/api/studio/storylines`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(shown.status, 200);
    const storyboard = await fetch(`${closedServer.baseUrl}/api/studio/storyboard`);
    assert.equal(storyboard.status, 401);
    assert.deepEqual(await (await fetch(`${closedServer.baseUrl}/API/STUDIO/AUTH-REQUIRED/`)).json(), { required: true });

    const generate = await fetch(`${closedServer.baseUrl}/API/MATCHLAB/GENERATE`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(generate.status, 401);
    const authedGenerate = await fetch(`${closedServer.baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    assert.equal(authedGenerate.status, 400);
    assert.equal((await fetch(`${closedServer.baseUrl}/API/LIVE/STOP`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

    assert.equal((await fetch(`${closedServer.baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${closedServer.baseUrl}/api/live/status`)).status, 200);
    assert.equal((await fetch(`${closedServer.baseUrl}/api/archive/summary`)).status, 200);
    assert.equal((await fetch(`${closedServer.baseUrl}/api/fan/moments`)).status, 200);
    assert.equal((await fetch(`${closedServer.baseUrl}/api/overlay/current`)).status, 200);
    const trackingResponse = await fetch(`${closedServer.baseUrl}/api/live/tracking/stream`, { signal: tracking.signal });
    assert.equal(trackingResponse.status, 200);
  } finally {
    tracking.abort();
    await openServer.close();
    await closedServer.close();
  }
});

test("archive generate stays protected when the router is mounted with a token and no global guard", async () => {
  const app = express();
  app.use(express.json());
  app.use(createArchiveRouter({
    registry: {
      listFixtures: () => [],
      getFixture: () => { throw new RangeError("missing"); },
      registerFixture: () => { throw new Error("should not register"); },
    },
    generateMatch: () => { throw new Error("should not generate"); },
    studioToken: TOKEN,
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error) || error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: "unexpected" });
  });
  const server = await listen(app);
  try {
    assert.equal((await fetch(`${server.baseUrl}/api/archive/summary`)).status, 200);
    const blocked = await fetch(`${server.baseUrl}/API/MATCHLAB/GENERATE`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "late_winner", seed: 1 }),
    });
    assert.equal(blocked.status, 401);
    const authed = await fetch(`${server.baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    assert.equal(authed.status, 400);
  } finally {
    await server.close();
  }
});

function localized(value: string) {
  return { en: value, es: value, fr: value, pt: value };
}

function studioStreamApp(token?: string): express.Express {
  const storyline = {
    id: "story-draft",
    matchId: "m1",
    triggerEventIds: ["e1"],
    triggerMinute: 1,
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z",
    status: "drafting" as const,
    priority: 1,
    headline: localized("Draft"),
    onAirLine: localized("Draft line"),
    overlay: localized("Draft overlay"),
    claims: [],
    trace: [{ role: "researcher", status: "complete" as const, detail: "internal-trace", durationMs: 4 }],
    version: 1,
  };
  const app = express();
  app.use(createLiveRouter({
    studioToken: token,
    analyzeFixture: () => ({}) as never,
    live: {
      status: () => ({ state: "running", transport: "local", transportConfigured: false, clockSecond: 10, speed: 1, eventsReceived: 0, duplicatesIgnored: 0, stress: false, source: "synthetic", fallbackReason: null, matchId: "m1" }),
      current: () => ({
        matchId: "m1",
        clockSecond: 10,
        fixture: {
          id: "fx",
          seed: 1,
          title: "A vs B",
          description: "synthetic",
          home: { id: "home", name: "A", shortName: "A", players: [] },
          away: { id: "away", name: "B", shortName: "B", players: [] },
          events: [],
          durationSeconds: 90,
          correctionEventId: "none",
          correctionAvailableAt: 0,
        },
      }),
      addListener: () => () => undefined,
      subscribeTicks: () => () => undefined,
    } as never,
    desk: {
      list: () => [storyline],
      facts: () => [{ id: "fact-draft", matchId: "m1", minute: 1, text: localized("Draft fact"), sources: [], storylineId: "story-draft", createdAt: "2026-07-27T12:00:00.000Z" }],
      subscribe: () => () => undefined,
    } as never,
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error) || error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : "unexpected" });
  });
  return app;
}

async function readStream(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: controller.signal });
  if (response.status !== 200 || !response.body) {
    return { status: response.status, body: await response.text() };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  const timer = setTimeout(() => controller.abort(), 400);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
      if (body.includes("internal-trace") || body.includes("fact-draft") || body.split("\n\n").length > 3) break;
    }
  } catch {
    // The abort ends the read once the bootstrap events are in.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status: response.status, body };
}

test("studio-role stream falls back to the fan projection unless the Authorization bearer matches", async () => {
  const open = await listen(studioStreamApp(undefined));
  const closed = await listen(studioStreamApp(TOKEN));
  try {
    const unconfigured = await readStream(`${open.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`);
    assert.equal(unconfigured.status, 200);
    assert.match(unconfigured.body, /internal-trace/);

    const missing = await readStream(`${closed.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.includes("internal-trace"), false);
    assert.equal(missing.body.includes("fact-draft"), false);
    assert.equal(missing.body.includes("story-draft"), false);

    const wrong = await readStream(`${closed.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en&token=nope`);
    assert.equal(wrong.status, 200);
    assert.equal(wrong.body.includes("internal-trace"), false);

    const queryToken = await readStream(`${closed.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en&token=${encodeURIComponent(TOKEN)}`);
    assert.equal(queryToken.status, 200);
    assert.equal(queryToken.body.includes("internal-trace"), false);
    assert.equal(queryToken.body.includes("fact-draft"), false);

    const headerToken = await readStream(`${closed.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`, { authorization: `Bearer ${TOKEN}` });
    assert.match(headerToken.body, /internal-trace/);

    const downgraded = await fetch(`${closed.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en&favoritePlayerId=missing-player`);
    assert.equal(downgraded.status, 200);
    await downgraded.body?.cancel();
    const rejectedPlayer = await fetch(`${closed.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en&favoritePlayerId=missing-player`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(rejectedPlayer.status, 400);
  } finally {
    await open.close();
    await closed.close();
  }
});
