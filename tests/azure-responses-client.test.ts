import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";

import { createApp } from "../server/app.js";
import {
  azureResponsesBaseUrl,
  AZURE_RESPONSES_API_VERSION,
  createAzureResponsesClient,
  createWebScoutFromEnv,
} from "../server/narrative/web.js";

const ENDPOINT = "https://example.openai.azure.com/";
const EXPECTED_BASE_URL = "https://example.openai.azure.com/openai/v1/";

/** Prod app settings from infra/app.bicep. No API key: managed identity only. */
function prodLikeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    NARRATIVE_WEB_SEARCH: "on",
    AZURE_OPENAI_ENDPOINT: ENDPOINT,
    AZURE_OPENAI_DEPLOYMENT: "matchlens-narrator",
    AZURE_OPENAI_API_VERSION: "2024-10-21",
    AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    ...overrides,
  };
}

function tokenProvider(): Promise<string> {
  return Promise.resolve("stub-token");
}

const AMBIENT_KEYS = [
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_VERSION",
] as const;

function withoutAmbientSdkDefaults(run: () => void): void {
  const saved = new Map(AMBIENT_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of AMBIENT_KEYS) delete process.env[key];
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Azure Responses client startup", { concurrency: 1 }, () => {
test("Responses client uses only baseURL and does not throw for a prod-like endpoint", () => {
  withoutAmbientSdkDefaults(() => {
    const env = prodLikeEnv();
    const scout = createWebScoutFromEnv(env, { tokenProvider });
    assert.ok(scout);
    assert.equal(scout.baseURL, EXPECTED_BASE_URL);
    assert.equal(azureResponsesBaseUrl(ENDPOINT), EXPECTED_BASE_URL);

    const client = createAzureResponsesClient(ENDPOINT, tokenProvider);
    assert.equal(client.baseURL, EXPECTED_BASE_URL);
    // A dated chat api-version (2024-10-21) on /openai/v1/ returns 400 "API version not supported".
    assert.equal(client.apiVersion, AZURE_RESPONSES_API_VERSION);
    assert.equal(client.baseURL.includes("/deployments/"), false);

    const bare = createWebScoutFromEnv(prodLikeEnv({ AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com" }), { tokenProvider });
    assert.equal(bare?.baseURL, EXPECTED_BASE_URL);
    assert.equal(createWebScoutFromEnv(prodLikeEnv({ NARRATIVE_WEB_SEARCH: "off" }), { tokenProvider }), undefined);
  });
});

test("createApp does not throw when narrative web search and the Azure endpoint are set", async () => {
  const keys = [
    "NODE_ENV",
    "NARRATIVE_WEB_SEARCH",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_VERSION",
    "PROJECT_ENDPOINT",
    "AZURE_SEARCH_ENDPOINT",
    "AZURE_CLIENT_ID",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const env = prodLikeEnv();
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value;
    }
    const app = createApp({
      platform: {
        live: {
          current: () => undefined,
          status: () => ({ state: "idle", transport: "local", transportConfigured: false }),
        },
        desk: { list: () => [], health: () => ({ configured: false }) },
        insights: { list: () => [] },
        close: async () => {},
      } as never,
      version: "test",
      logger: () => {},
    });
    const server = http.createServer(app);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      const body = await response.json() as { status?: string };
      assert.equal(body.status, "ok");
    } finally {
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
});
