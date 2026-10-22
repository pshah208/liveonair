import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createApp } from "../server/app.js";
import { createLiveRouter } from "../server/routes/live.js";
import { createStudioRouter } from "../server/routes/studio.js";
import { createStreamTicketStore, isStreamTicket, STREAM_TICKET_TTL_SECONDS } from "../server/routes/streamTickets.js";
import type { StreamTicketStore } from "../server/routes/streamTickets.js";
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

function localized(value: string) {
  return { en: value, es: value, fr: value, pt: value };
}

function mount(token: string | undefined, streamTickets?: StreamTicketStore): express.Express {
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
  app.use(express.json());
  const live = {
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
  };
  const desk = {
    list: () => [storyline],
    facts: () => [{ id: "fact-draft", matchId: "m1", minute: 1, text: localized("Draft fact"), sources: [], storylineId: "story-draft", createdAt: "2026-07-27T12:00:00.000Z" }],
    subscribe: () => () => undefined,
    health: () => ({ mode: "unconfigured", agents: [], retrieval: "none" }),
  };
  app.use(createStudioRouter({ desk: desk as never, live: live as never, authRequired: Boolean(token?.trim()), studioToken: token, streamTickets }));
  app.use(createLiveRouter({
    studioToken: token,
    streamTickets,
    analyzeFixture: () => ({}) as never,
    live: live as never,
    desk: desk as never,
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (response.headersSent) {
      _next(error);
      return;
    }
    if (isHttpError(error) || error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : "unexpected" });
  });
  return app;
}

async function issue(baseUrl: string, token?: string): Promise<{ status: number; body: { ticket?: string | null; expiresInSeconds?: number; error?: string } }> {
  const response = await fetch(`${baseUrl}/api/studio/stream-ticket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });
  return { status: response.status, body: await response.json() as { ticket?: string | null; expiresInSeconds?: number; error?: string } };
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

function streamUrl(baseUrl: string, query: string): string {
  return `${baseUrl}/api/live/stream?role=studio&persona=analyst&language=en&${query}`;
}

test("a stream ticket works only once", async () => {
  const tickets = createStreamTicketStore();
  const server = await listen(mount(TOKEN, tickets));
  try {
    const issued = await issue(server.baseUrl, TOKEN);
    assert.equal(issued.status, 200);
    assert.equal(issued.body.expiresInSeconds, STREAM_TICKET_TTL_SECONDS);
    assert.equal(isStreamTicket(issued.body.ticket), true);
    assert.notEqual(issued.body.ticket, TOKEN);

    const first = await readStream(streamUrl(server.baseUrl, `ticket=${issued.body.ticket}`));
    assert.equal(first.status, 200);
    assert.match(first.body, /internal-trace/);
    assert.match(first.body, /fact-draft/);

    const second = await readStream(streamUrl(server.baseUrl, `ticket=${issued.body.ticket}`));
    assert.equal(second.status, 200);
    assert.equal(second.body.includes("internal-trace"), false);
    assert.equal(second.body.includes("fact-draft"), false);
  } finally {
    await server.close();
  }
});

test("an expired stream ticket is rejected and a fresh ticket still opens the studio projection", async () => {
  const clock = { now: 10_000 };
  const tickets = createStreamTicketStore({ now: () => clock.now });
  const server = await listen(mount(TOKEN, tickets));
  try {
    const stale = await issue(server.baseUrl, TOKEN);
    assert.equal(stale.status, 200);
    clock.now += 60_000;
    const rejected = await readStream(streamUrl(server.baseUrl, `ticket=${stale.body.ticket}`));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.includes("internal-trace"), false);

    const fresh = await issue(server.baseUrl, TOKEN);
    const opened = await readStream(streamUrl(server.baseUrl, `ticket=${fresh.body.ticket}`));
    assert.match(opened.body, /internal-trace/);
  } finally {
    await server.close();
  }
});

test("a query token is ignored and falls back to the fan projection", async () => {
  const tickets = createStreamTicketStore();
  const server = await listen(mount(TOKEN, tickets));
  try {
    const leaked = await readStream(`${server.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en&token=${encodeURIComponent(TOKEN)}`);
    assert.equal(leaked.status, 200);
    assert.equal(leaked.body.includes("internal-trace"), false);
    assert.equal(leaked.body.includes("fact-draft"), false);

    const issued = await issue(server.baseUrl, TOKEN);
    const withLeftover = await readStream(streamUrl(server.baseUrl, `ticket=${issued.body.ticket}&token=${encodeURIComponent(TOKEN)}`));
    assert.equal(withLeftover.status, 200);
    assert.match(withLeftover.body, /internal-trace/);
  } finally {
    await server.close();
  }
});

test("the stream-ticket endpoint requires the studio bearer when a token is configured", async () => {
  const server = await listen(mount(TOKEN, createStreamTicketStore()));
  try {
    const missing = await issue(server.baseUrl);
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, "Studio authorization required");
    assert.equal(missing.body.ticket, undefined);

    const wrong = await issue(server.baseUrl, "other-token");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.ticket, undefined);
  } finally {
    await server.close();
  }
});

test("fan streams and unauthenticated studio streams stay on the fan projection", async () => {
  const tickets = createStreamTicketStore();
  const server = await listen(mount(TOKEN, tickets));
  try {
    const fan = await readStream(`${server.baseUrl}/api/live/stream?role=fan&persona=casual&language=en`);
    assert.equal(fan.status, 200);
    assert.equal(fan.body.includes("internal-trace"), false);

    const missing = await readStream(`${server.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`);
    assert.equal(missing.body.includes("internal-trace"), false);

    const garbage = await readStream(streamUrl(server.baseUrl, "ticket=not-a-ticket"));
    assert.equal(garbage.body.includes("internal-trace"), false);

    const issued = await issue(server.baseUrl, TOKEN);
    const fanWithTicket = await readStream(`${server.baseUrl}/api/live/stream?role=fan&persona=casual&language=en&ticket=${issued.body.ticket}`);
    assert.equal(fanWithTicket.body.includes("internal-trace"), false);
    const stillGood = await readStream(streamUrl(server.baseUrl, `ticket=${issued.body.ticket}`));
    assert.match(stillGood.body, /internal-trace/);
  } finally {
    await server.close();
  }
});

test("open mode needs no ticket when the studio token is unset", async () => {
  const server = await listen(mount(undefined));
  try {
    const issued = await issue(server.baseUrl);
    assert.equal(issued.status, 200);
    assert.deepEqual(issued.body, { ticket: null, expiresInSeconds: 0 });

    const opened = await readStream(`${server.baseUrl}/api/live/stream?role=studio&persona=analyst&language=en`);
    assert.equal(opened.status, 200);
    assert.match(opened.body, /internal-trace/);
  } finally {
    await server.close();
  }
});

test("stream ticket store prunes expired entries and caps the map", () => {
  let now = 0;
  let n = 0;
  const store = createStreamTicketStore({
    now: () => now,
    ttlMs: 1_000,
    maxEntries: 2,
    randomBytes: (size) => {
      const buffer = Buffer.alloc(size);
      buffer[0] = n++;
      return buffer;
    },
  });
  const first = store.issue();
  const second = store.issue();
  const third = store.issue();
  assert.equal(store.consume(first.ticket), false);
  assert.equal(store.consume(second.ticket), true);
  now = 1_000;
  const fourth = store.issue();
  assert.equal(store.consume(third.ticket), false);
  assert.equal(store.consume(fourth.ticket), true);
  assert.equal(store.consume(fourth.ticket), false);
});

test("createApp shares the ticket store and keeps the endpoint behind the studio bearer", async () => {
  const clock = { now: 5_000 };
  const streamTickets = createStreamTicketStore({ now: () => clock.now });
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
  const narrator = { health: () => ({ configured: false }) } as never;
  const closed = createApp({ narrator, platform: platform as never, studioToken: TOKEN, streamTickets, version: "test" });
  const open = createApp({ narrator, platform: platform as never, studioToken: "", version: "test" });
  const closedServer = await listen(closed);
  const openServer = await listen(open);
  try {
    assert.equal((await issue(closedServer.baseUrl)).status, 401);
    const issued = await issue(closedServer.baseUrl, TOKEN);
    assert.equal(issued.status, 200);
    assert.equal(streamTickets.consume(issued.body.ticket ?? ""), true);

    const again = await issue(closedServer.baseUrl, TOKEN);
    const stream = await readStream(streamUrl(closedServer.baseUrl, `ticket=${again.body.ticket}`));
    assert.equal(stream.status, 200);
    assert.equal(streamTickets.consume(again.body.ticket ?? ""), false);

    assert.deepEqual((await issue(openServer.baseUrl)).body, { ticket: null, expiresInSeconds: 0 });
  } finally {
    await closedServer.close();
    await openServer.close();
  }
});

test("src and server no longer construct or parse a token query", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    const root = new URL(`../${dir}/`, import.meta.url);
    for (const name of readdirSync(root)) {
      const child = new URL(name, root);
      if (statSync(child).isDirectory()) {
        walk(`${dir}/${name}`);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (readFileSync(child, "utf8").includes("token=")) offenders.push(`${dir}/${name}`);
    }
  };
  walk("src");
  walk("server");
  assert.deepEqual(offenders, []);
});
