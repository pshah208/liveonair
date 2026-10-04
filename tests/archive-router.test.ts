import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express, { type NextFunction, type Request, type Response } from "express";

import { generateMatch } from "../server/matchlab/generator.js";
import { createArchiveRouter } from "../server/routes/archive.js";
import { HttpError, isHttpError } from "../server/validation.js";
import { getFixture, listFixtures, registerFixture, resetGeneratedFixturesForTests } from "../server/fixtures.js";

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use(createArchiveRouter({
    registry: { listFixtures, getFixture, registerFixture },
    generateMatch,
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Malformed JSON body" });
      return;
    }
    if (isHttpError(error) || error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof RangeError) {
      response.status(404).json({ error: error.message });
      return;
    }
    response.status(503).json({ error: "Service unavailable" });
  });
  return app;
}

async function withServer(handler: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(createTestApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test.beforeEach(() => {
  resetGeneratedFixturesForTests();
});

test("archive router serves summary, export and player profiles", async () => {
  await withServer(async (baseUrl) => {
    const summary = await fetch(`${baseUrl}/api/archive/summary`).then((response) => response.json());
    assert.equal(summary.version, "archive-v1");
    assert.ok(summary.peopleCount > 80);

    const exportResponse = await fetch(`${baseUrl}/api/archive/export`);
    assert.equal(exportResponse.headers.get("cache-control"), "public, max-age=300");
    const exported = await exportResponse.json();
    assert.equal(exported.version, "archive-v1");

    const profile = await fetch(`${baseUrl}/api/archive/players/per-rivergate-leo-arden`).then((response) => response.json());
    assert.equal(profile.person.name, "Leo Arden");
    assert.ok(profile.relatives.some((person: { name: string }) => person.name === "Cassian Arden"));
  });
});

test("archive router validates archive ids and unknown players", async () => {
  await withServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/archive/players/not-an-id`);
    assert.equal(invalid.status, 400);

    const missing = await fetch(`${baseUrl}/api/archive/players/per-missing-player`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Archive player not found" });
  });
});

test("generate route registers fixtures and validates request bodies", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: "goal_fest",
        seed: 501,
        homeClubId: "club-eastford",
        awayClubId: "club-kingsport",
      }),
    });
    assert.equal(response.status, 201);
    const summary = await response.json();
    assert.equal(summary.id, "gen-goal_fest-501");
    assert.equal(getFixture(summary.id).home.archiveClubId, "club-eastford");

    const badDistinct = await fetch(`${baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: "goal_fest",
        seed: 502,
        homeClubId: "club-eastford",
        awayClubId: "club-eastford",
      }),
    });
    assert.equal(badDistinct.status, 400);

    const unknownClub = await fetch(`${baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: "goal_fest",
        seed: 503,
        homeClubId: "club-nowhere",
      }),
    });
    assert.equal(unknownClub.status, 400);

    const extraField = await fetch(`${baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: "goal_fest",
        seed: 504,
        extra: true,
      }),
    });
    assert.equal(extraField.status, 400);
  });
});

test("generate route rate limits at 20 requests per minute", async () => {
  await withServer(async (baseUrl) => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const response = await fetch(`${baseUrl}/api/matchlab/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "comeback", seed }),
      });
      assert.equal(response.status, 201);
    }

    const limited = await fetch(`${baseUrl}/api/matchlab/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "comeback", seed: 21 }),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "Too many matchlab generate requests" });
  });
});
