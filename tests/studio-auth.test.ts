import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createApp } from "../server/app.js";
import { bearerToken, createStudioAuth, requiresStudioAuth, studioAuthRequired, tokensMatch } from "../server/routes/studioAuth.js";

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

test("studio token guards producer writes and leaves fan reads and narration open", async () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch("nope", TOKEN), false);
  assert.equal(tokensMatch("studio-secret-extra", TOKEN), false);
  assert.equal(bearerToken("Bearer studio-secret"), TOKEN);
  assert.equal(requiresStudioAuth("GET", "/api/studio/storylines"), false);
  assert.equal(requiresStudioAuth("POST", "/api/analyze"), false);
  assert.equal(requiresStudioAuth("POST", "/api/live/start"), true);

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

    assert.equal((await call(server.baseUrl, "GET", "/api/live/status")).status, 200);
    assert.equal((await call(server.baseUrl, "GET", "/api/studio/storylines")).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/analyze")).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/narrate")).status, 200);
    assert.equal((await call(server.baseUrl, "POST", "/api/matchlab/generate")).status, 200);
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
