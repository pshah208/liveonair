import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import express from "express";

import type { LiveStatus } from "../shared/platform.js";
import type { AnalysisRequest, MatchFixture, MatchSnapshot } from "../shared/types.js";
import type { LiveMatchView, LiveService, StorylineDesk } from "../server/contracts.js";
import { analyzeFixture } from "../server/engine.js";
import { generateMatch } from "../server/matchlab/generator.js";
import { createLiveRouter } from "../server/routes/live.js";

type Listener = { onEvent?: () => void };

function stubLive(fixture: MatchFixture) {
  const listeners = new Set<Listener>();
  let eventsReceived = 0;
  let clockSecond = 600;
  let currentCalls = 0;
  const visible = () => fixture.events.filter((event) => event.minute * 60 + event.second <= clockSecond);
  const live = {
    status: (): LiveStatus => ({ state: "running", transport: "local", transportConfigured: false, matchId: "m1", clockSecond, speed: 60, eventsReceived, duplicatesIgnored: 0, lagMs: 0, stress: false } as unknown as LiveStatus),
    current: (): LiveMatchView => {
      currentCalls += 1;
      return { matchId: "m1", clockSecond, fixture: { ...fixture, events: visible().map((event) => ({ ...event })) } };
    },
    addListener: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    live: live as unknown as LiveService,
    advance(seconds: number) {
      clockSecond += seconds;
      eventsReceived += 1;
      for (const listener of listeners) listener.onEvent?.();
    },
    currentCalls: () => currentCalls,
  };
}

const desk = { list: () => [], facts: () => [], subscribe: () => () => undefined } as unknown as StorylineDesk;

function openStream(port: number, path: string): { frames: string[]; close(): void } {
  const frames: string[] = [];
  let buffer = "";
  const request = http.get({ port, path }, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    });
  });
  request.on("error", () => undefined);
  return { frames, close: () => request.destroy() };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("live fan-out analyses and serialises each snapshot once per query and matches per-client output", async () => {
  const fixture = generateMatch({ scenario: "late_winner", seed: 23 });
  const stub = stubLive(fixture);
  let analyses = 0;
  const counted = (target: MatchFixture, request: AnalysisRequest): MatchSnapshot => {
    analyses += 1;
    return analyzeFixture(target, request);
  };
  const app = express();
  app.use(createLiveRouter({ live: stub.live, desk, analyzeFixture: counted, studioToken: "" }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const streams = [
    openStream(port, "/api/live/stream?role=fan&persona=casual&language=en"),
    openStream(port, "/api/live/stream?role=fan&persona=casual&language=en"),
    openStream(port, "/api/live/stream?role=studio&persona=casual&language=en"),
    openStream(port, "/api/live/stream?role=fan&persona=analyst&language=es"),
  ];
  try {
    await wait(700);
    analyses = 0;
    const callsBefore = stub.currentCalls();
    stub.advance(60);
    await wait(50);
    // Two distinct queries, four clients; one view clone for the whole fan-out.
    assert.equal(analyses, 2);
    assert.equal(stub.currentCalls() - callsBefore, 1);
    const latest = streams.map((stream) => stream.frames.filter((frame) => frame.includes('"type":"snapshot"')).at(-1)!);
    assert.equal(latest[0], latest[1]);
    assert.equal(latest[0], latest[2]);
    assert.notEqual(latest[0], latest[3]);
    // Byte-identical to serialising the per-client message, as before the fan-out cache.
    const view = stub.live.current()!;
    const status = stub.live.status();
    for (const [index, query] of [[0, { persona: "casual", language: "en" }], [3, { persona: "analyst", language: "es" }]] as const) {
      const snapshot = analyzeFixture(view.fixture, { fixtureId: view.fixture.id, atSecond: Math.floor(view.clockSecond), persona: query.persona, language: query.language, favoritePlayerId: undefined, correction: false });
      assert.equal(latest[index], `data: ${JSON.stringify({ type: "snapshot", snapshot, status })}`);
    }
    // The next event changes the view; nothing is served from the previous fingerprint.
    await wait(550);
    stub.advance(600);
    await wait(50);
    const next = streams[0].frames.filter((frame) => frame.includes('"type":"snapshot"')).at(-1)!;
    assert.notEqual(next, latest[0]);
    assert.match(next, /"atSecond":1260/u);
  } finally {
    for (const stream of streams) stream.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
