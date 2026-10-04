import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ArchiveClub,
  ArchiveMatch,
  ArchivePerson,
  ArchiveSnapshot,
} from "../shared/platform.js";

const execFileAsync = promisify(execFile);
const azExecutable = process.platform === "win32" ? "az.cmd" : "az";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const secretsPath = resolve(root, "fabric", ".secrets.local.json");
const archiveModulePath = resolve(root, "server", "archive", "index.ts");
const subscriptionId = "5d2da101-2909-479c-a12f-c07083da7c18";

interface FabricSecrets {
  databaseName: string;
  queryServiceUri: string;
}

interface KustoTableShape {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rows: Record<string, unknown>[];
}

async function loadSecrets(): Promise<FabricSecrets> {
  const raw = await readFile(secretsPath, "utf8");
  return JSON.parse(raw) as FabricSecrets;
}

async function importArchive(): Promise<ArchiveSnapshot> {
  const moduleUrl = pathToFileURL(archiveModulePath).href;
  const module = await import(moduleUrl);
  if (typeof module.getArchive !== "function") {
    throw new Error("server/archive/index.ts does not export getArchive().");
  }

  const snapshot = await module.getArchive();
  return snapshot as ArchiveSnapshot;
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

async function invokeKusto(clusterUri: string, databaseName: string, endpoint: "mgmt" | "query", csl: string): Promise<any> {
  const token = await getKustoToken(clusterUri);
  const response = await fetch(`${clusterUri.replace(/\/$/, "")}/v1/rest/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      db: databaseName,
      csl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Kusto ${endpoint} call failed with ${response.status}: ${await response.text()}`);
  }

  return response.json();
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

function escapeKustoString(value: string): string {
  // JSON string escaping is valid KQL double-quoted string syntax.
  return JSON.stringify(value);
}

function toKustoLiteral(value: unknown, type: string): string {
  if (value === null || value === undefined) {
    // KQL has no null string literal; empty string is the null-equivalent for strings.
    return type === "string" ? '""' : `${type}(null)`;
  }

  switch (type) {
    case "string":
      return escapeKustoString(String(value));
    case "int":
      return Number.isFinite(Number(value)) ? `${Math.trunc(Number(value))}` : "int(null)";
    case "long":
      return Number.isFinite(Number(value)) ? `${Math.trunc(Number(value))}` : "long(null)";
    case "real":
      return Number.isFinite(Number(value)) ? `${Number(value)}` : "real(null)";
    case "bool":
      return `${Boolean(value)}`;
    case "datetime":
      return `datetime(${String(value)})`;
    case "dynamic":
      return `dynamic(${JSON.stringify(value)})`;
    default:
      throw new Error(`Unsupported Kusto type ${type}.`);
  }
}

function buildTableCommand(table: KustoTableShape, rows: Record<string, unknown>[], replace: boolean): string {
  // datatable() rejects nested dynamic literals, so dynamic columns travel as JSON strings.
  const columnDefinition = table.columns
    .map((column) => `['${column.name}']:${column.type === "dynamic" ? "string" : column.type}`)
    .join(", ");
  const rowLiterals = rows
    .map((row) =>
      table.columns
        .map((column) =>
          column.type === "dynamic"
            ? toKustoLiteral(row[column.name] === undefined ? null : JSON.stringify(row[column.name]), "string")
            : toKustoLiteral(row[column.name], column.type),
        )
        .join(", "),
    )
    .join(",\n");
  const dynamicColumns = table.columns.filter((column) => column.type === "dynamic");
  const conversion = dynamicColumns.length
    ? ` | extend ${dynamicColumns.map((column) => `['${column.name}'] = parse_json(['${column.name}'])`).join(", ")}`
    : "";
  const operator = replace ? ".set-or-replace" : ".append";
  return `${operator} ${table.name} <| datatable(${columnDefinition}) [\n${rowLiterals}\n]${conversion}`;
}

async function ingestTable(
  clusterUri: string,
  databaseName: string,
  table: KustoTableShape,
  batchSize = 200,
): Promise<void> {
  const batches: Record<string, unknown>[][] = [];
  for (let index = 0; index < table.rows.length; index += batchSize) {
    batches.push(table.rows.slice(index, index + batchSize));
  }

  if (batches.length === 0) {
    batches.push([]);
  }

  for (const [batchIndex, batch] of batches.entries()) {
    const command = buildTableCommand(table, batch, batchIndex === 0);
    await invokeKusto(clusterUri, databaseName, "mgmt", command);
  }
}

function toClubRow(club: ArchiveClub): Record<string, unknown> {
  return {
    Id: club.id,
    Name: club.name,
    ShortName: club.shortName,
    City: club.city,
    Stadium: club.stadium,
    Founded: club.founded,
  };
}

function toPersonRow(person: ArchivePerson): Record<string, unknown> {
  return {
    Id: person.id,
    Name: person.name,
    BirthYear: person.birthYear,
    Hometown: person.hometown,
    Position: person.position,
    CurrentClubId: person.currentClubId,
    Retired: person.retired,
    Career: person.career,
  };
}

function toMatchRow(match: ArchiveMatch): Record<string, unknown> {
  return {
    Id: match.id,
    Date: match.date,
    Season: match.season,
    Competition: match.competition,
    Stage: match.stage,
    HomeClubId: match.homeClubId,
    AwayClubId: match.awayClubId,
    HomeScore: match.homeScore,
    AwayScore: match.awayScore,
    Venue: match.venue,
  };
}

function getTables(snapshot: ArchiveSnapshot): KustoTableShape[] {
  return [
    {
      name: "Clubs",
      columns: [
        { name: "Id", type: "string" },
        { name: "Name", type: "string" },
        { name: "ShortName", type: "string" },
        { name: "City", type: "string" },
        { name: "Stadium", type: "string" },
        { name: "Founded", type: "int" },
      ],
      rows: snapshot.clubs.map(toClubRow),
    },
    {
      name: "People",
      columns: [
        { name: "Id", type: "string" },
        { name: "Name", type: "string" },
        { name: "BirthYear", type: "int" },
        { name: "Hometown", type: "string" },
        { name: "Position", type: "string" },
        { name: "CurrentClubId", type: "string" },
        { name: "Retired", type: "bool" },
        { name: "Career", type: "dynamic" },
      ],
      rows: snapshot.people.map(toPersonRow),
    },
    {
      name: "HistoricMatches",
      columns: [
        { name: "Id", type: "string" },
        { name: "Date", type: "datetime" },
        { name: "Season", type: "string" },
        { name: "Competition", type: "string" },
        { name: "Stage", type: "string" },
        { name: "HomeClubId", type: "string" },
        { name: "AwayClubId", type: "string" },
        { name: "HomeScore", type: "int" },
        { name: "AwayScore", type: "int" },
        { name: "Venue", type: "string" },
      ],
      rows: snapshot.matches.map(toMatchRow),
    },
    {
      name: "HistoricGoals",
      columns: [
        { name: "MatchId", type: "string" },
        { name: "PersonId", type: "string" },
        { name: "ClubId", type: "string" },
        { name: "Minute", type: "int" },
      ],
      rows: snapshot.matches.flatMap((match) =>
        match.goals.map((goal) => ({
          MatchId: match.id,
          PersonId: goal.personId,
          ClubId: goal.clubId,
          Minute: goal.minute,
        })),
      ),
    },
    {
      name: "Honours",
      columns: [
        { name: "Id", type: "string" },
        { name: "ClubId", type: "string" },
        { name: "Competition", type: "string" },
        { name: "Season", type: "string" },
        { name: "Result", type: "string" },
        { name: "FinalMatchId", type: "string" },
      ],
      rows: snapshot.clubs.flatMap((club) =>
        club.honours.map((honour) => ({
          Id: honour.id,
          ClubId: club.id,
          Competition: honour.competition,
          Season: honour.season,
          Result: honour.result,
          FinalMatchId: honour.finalMatchId ?? null,
        })),
      ),
    },
    {
      name: "Relations",
      columns: [
        { name: "PersonId", type: "string" },
        { name: "RelatedPersonId", type: "string" },
        { name: "Kind", type: "string" },
      ],
      rows: snapshot.people.flatMap((person) =>
        person.relations.map((relation) => ({
          PersonId: person.id,
          RelatedPersonId: relation.personId,
          Kind: relation.kind,
        })),
      ),
    },
  ];
}

async function getCounts(clusterUri: string, databaseName: string): Promise<Record<string, unknown>[]> {
  const response = await invokeKusto(
    clusterUri,
    databaseName,
    "query",
    `union
      (Clubs | summarize Count = count() | project TableName = "Clubs", Count),
      (People | summarize Count = count() | project TableName = "People", Count),
      (HistoricMatches | summarize Count = count() | project TableName = "HistoricMatches", Count),
      (HistoricGoals | summarize Count = count() | project TableName = "HistoricGoals", Count),
      (Honours | summarize Count = count() | project TableName = "Honours", Count),
      (Relations | summarize Count = count() | project TableName = "Relations", Count)
    | order by TableName asc`,
  );

  return tableRowsToObjects(response);
}

async function main(): Promise<void> {
  const secrets = await loadSecrets();
  const snapshot = await importArchive();
  const tables = getTables(snapshot);

  for (const table of tables) {
    await ingestTable(secrets.queryServiceUri, secrets.databaseName, table);
  }

  const counts = await getCounts(secrets.queryServiceUri, secrets.databaseName);
  for (const row of counts) {
    console.log(`${row.TableName}: ${row.Count}`);
  }
  console.log(JSON.stringify({ counts }));
}

await main();
