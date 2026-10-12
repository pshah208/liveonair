import { EventHubConsumerClient, EventHubProducerClient } from "@azure/event-hubs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { LiveEnvelope } from "../shared/platform.js";
import type { FixtureSummary, MatchEvent } from "../shared/types.js";

const execFileAsync = promisify(execFile);
const azExecutable = process.platform === "win32" ? "az.cmd" : "az";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const secretsPath = resolve(root, "fabric", ".secrets.local.json");
const subscriptionId = "5d2da101-2909-479c-a12f-c07083da7c18";

interface FabricSecrets {
  databaseName: string;
  queryServiceUri: string;
  eventstreamSourceConnectionString: string;
  eventstreamDestinationConnectionString: string;
  eventstreamConsumerGroup: string;
}

async function loadSecrets(): Promise<FabricSecrets> {
  const raw = await readFile(secretsPath, "utf8");
  return JSON.parse(raw) as FabricSecrets;
}

async function getKustoToken(resource: string): Promise<string> {
  const { stdout } = await execFileAsync(
    azExecutable,
    [
      "account",
      "get-access-token",
      "--subscription",
      subscriptionId,
      "--resource",
      resource.replace(/\/$/, ""),
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ],
    { shell: process.platform === "win32" },
  );
  return stdout.trim();
}

function tableRowsToObjects(response: any): Record<string, unknown>[] {
  const table = response?.Tables?.[0];
  if (!table) {
    return [];
  }

  return table.Rows.map((row: unknown[]) =>
    Object.fromEntries(table.Columns.map((column: { ColumnName: string }, index: number) => [column.ColumnName, row[index]])),
  );
}

async function queryKusto(clusterUri: string, databaseName: string, query: string): Promise<Record<string, unknown>[]> {
  const token = await getKustoToken(clusterUri);
  const response = await fetch(`${clusterUri.replace(/\/$/, "")}/v1/rest/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      db: databaseName,
      csl: query,
    }),
  });

  if (!response.ok) {
    throw new Error(`Kusto query failed with ${response.status}: ${await response.text()}`);
  }

  return tableRowsToObjects(await response.json());
}

function buildFixture(matchId: string): FixtureSummary {
  return {
    id: `${matchId}-fixture`,
    title: "Smoke FC vs Verify United",
    description: "Synthetic smoke test fixture for Live on Air Fabric.",
    home: {
      id: "home",
      name: "Smoke FC",
      shortName: "SMK",
      players: [],
      archiveClubId: "smoke-fc",
    },
    away: {
      id: "away",
      name: "Verify United",
      shortName: "VRF",
      players: [],
      archiveClubId: "verify-united",
    },
    durationSeconds: 5400,
    eventCount: 1,
    correctionAvailableAt: 0,
  };
}

function buildEvent(matchId: string): MatchEvent {
  return {
    id: `${matchId}-goal-1`,
    revision: 1,
    minute: 12,
    second: 34,
    type: "goal",
    teamId: "home",
    playerId: "player-smoke-9",
    outcome: "success",
    x: 0.88,
    y: 0.41,
    xg: 0.27,
  };
}

function parseEnvelopeBody(body: unknown): LiveEnvelope {
  if (typeof body === "string") {
    return JSON.parse(body) as LiveEnvelope;
  }

  if (body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString("utf8")) as LiveEnvelope;
  }

  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString("utf8")) as LiveEnvelope;
  }

  if (typeof body === "object" && body) {
    return body as LiveEnvelope;
  }

  throw new Error("Unsupported Event Hubs body payload.");
}

async function waitForRows(clusterUri: string, databaseName: string, matchId: string): Promise<number> {
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
      const rows = await queryKusto(
        clusterUri,
        databaseName,
        `MatchEvents | where MatchId == '${matchId}' | summarize RowCount = count()`,
      );
    const rowCount = Number(rows[0]?.RowCount ?? 0);
    if (rowCount >= 3) {
      return rowCount;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }

  throw new Error(`Timed out waiting for Eventhouse rows for ${matchId}.`);
}

async function main(): Promise<void> {
  const secrets = await loadSecrets();
  const matchId = `smoke-${Date.now()}`;
  const fixture = buildFixture(matchId);
  const event = buildEvent(matchId);

  const producer = new EventHubProducerClient(secrets.eventstreamSourceConnectionString);
  const consumer = new EventHubConsumerClient(
    secrets.eventstreamConsumerGroup,
    secrets.eventstreamDestinationConnectionString,
  );

  const latencies = new Map<number, number>();
  let resolveReceive!: () => void;
  let rejectReceive!: (error: Error) => void;
  const receivePromise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReceive = resolvePromise;
    rejectReceive = rejectPromise;
  });

  const subscription = consumer.subscribe(
    {
      processEvents: async (events) => {
        for (const received of events) {
          const envelope = parseEnvelopeBody(received.body);
          if (envelope.matchId !== matchId) {
            continue;
          }

          const publishedAt = Date.parse(envelope.publishedAt);
          latencies.set(envelope.sequence, Date.now() - publishedAt);
          if (latencies.size >= 3) {
            resolveReceive();
          }
        }
      },
      processError: async (error) => {
        rejectReceive(error instanceof Error ? error : new Error(String(error)));
      },
    },
    {
      startPosition: {
        enqueuedOn: new Date(),
      },
    },
  );

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));

  const envelopes: Array<Omit<LiveEnvelope, "publishedAt">> = [
    {
      kind: "match_start",
      matchId,
      sequence: 1,
      fixture,
    },
    {
      kind: "match_event",
      matchId,
      sequence: 2,
      event,
    },
    {
      kind: "match_end",
      matchId,
      sequence: 3,
    },
  ];

  for (const envelopeBase of envelopes) {
    const envelope: LiveEnvelope = {
      ...envelopeBase,
      publishedAt: new Date().toISOString(),
    };
    await producer.sendBatch([
      {
        body: envelope,
        contentType: "application/json",
      },
    ]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }

  await Promise.race([
    receivePromise,
    new Promise((_, rejectPromise) =>
      setTimeout(() => rejectPromise(new Error("Timed out waiting for all three custom endpoint events.")), 90_000),
    ),
  ]);

  await subscription.close();
  await consumer.close();
  await producer.close();

  const rowCount = await waitForRows(secrets.queryServiceUri, secrets.databaseName, matchId);
  const orderedLatencies = [...latencies.entries()].sort((a, b) => a[0] - b[0]);
  for (const [sequence, latencyMs] of orderedLatencies) {
    console.log(`Received sequence ${sequence} in ${latencyMs} ms`);
  }
  console.log(`Eventhouse rows for ${matchId}: ${rowCount}`);
  console.log(
    JSON.stringify({
      matchId,
      latenciesMs: orderedLatencies.map(([, latencyMs]) => latencyMs),
      rowCount,
    }),
  );
}

await main();
