// Local MCP server over stdio for VS Code / GitHub Copilot / Claude Desktop:
//   npx tsx scripts/mcp-stdio.ts
// It runs the platform in-process (local live bus unless Eventstream is configured). Set MCP_STDIO_FIXTURE to a
// fixture ID to start replaying that synthetic match so the live tools have data. stdout is the MCP channel:
// never console.log here.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getArchive } from "../server/archive/index.js";
import { createArchiveRetrievalFromEnv } from "../server/desk/retrieval.js";
import { analyzeFixture } from "../server/engine.js";
import { createMcpServer } from "../server/mcp/index.js";
import { createPlatform } from "../server/platform.js";

const version = (JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
const platform = createPlatform(process.env);
const fixtureId = process.env.MCP_STDIO_FIXTURE?.trim();
if (fixtureId) {
  await platform.live.start({ fixtureId, speed: Number(process.env.MCP_STDIO_SPEED ?? 30) });
}

const server = createMcpServer({
  live: platform.live,
  desk: platform.desk,
  analyzeFixture,
  archive: getArchive(),
  retrieval: createArchiveRetrievalFromEnv(process.env),
  version,
}, { studio: true });

await server.connect(new StdioServerTransport());

async function shutdown(): Promise<void> {
  await server.close();
  await platform.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
