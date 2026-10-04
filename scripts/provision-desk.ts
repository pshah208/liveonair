import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { AIProjectClient } from "@azure/ai-projects";
import { SearchClient, SearchIndexClient, type SearchIndex } from "@azure/search-documents";

import type { ArchiveSnapshot } from "../shared/platform.js";
import { getAzureCredential } from "../server/azure/credential.js";
import { DESK_AGENT_SPECS } from "../server/desk/agents/index.js";

const SEARCH_API_VERSION = "2026-04-01";
const SEARCH_INDEX_NAME = "matchlens-archive";
const KNOWLEDGE_BASE_NAME = "matchlens-archive-kb";
const KNOWLEDGE_SOURCE_NAME = "matchlens-archive";

type ArchiveRecord = {
  id: string;
  title: string;
  body: string;
  kind: string;
  recordIds: string[];
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function loadArchive(): Promise<ArchiveSnapshot> {
  try {
    const module = await import("../server/archive/index.js");
    if (!module.getArchive || typeof module.getArchive !== "function") {
      throw new Error("server/archive/index.ts must export getArchive()");
    }
    return module.getArchive() as ArchiveSnapshot;
  } catch (error) {
    throw new Error(`Archive module is not available yet: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function archiveDocuments(archive: ArchiveSnapshot): ArchiveRecord[] {
  return archive.documents.map((document) => ({
    id: document.id,
    title: document.title,
    body: document.body,
    kind: document.kind,
    recordIds: document.recordIds,
  }));
}

function createIndexDefinition(): SearchIndex {
  return {
    name: SEARCH_INDEX_NAME,
    fields: [
      { name: "id", type: "Edm.String", key: true, searchable: false, filterable: true, sortable: true, retrievable: true },
      { name: "title", type: "Edm.String", searchable: true, retrievable: true },
      { name: "body", type: "Edm.String", searchable: true, retrievable: true },
      { name: "kind", type: "Edm.String", searchable: false, filterable: true, retrievable: true },
      { name: "recordIds", type: "Collection(Edm.String)", searchable: false, filterable: true, retrievable: true },
    ],
    semanticSearch: {
      configurations: [{
        name: "default",
        prioritizedFields: {
          titleField: { name: "title" },
          contentFields: [{ name: "body" }],
        },
      }],
    },
  } as SearchIndex;
}

async function upsertAgents(project: AIProjectClient) {
  const results: Array<{ name: string; version: string }> = [];
  for (const spec of DESK_AGENT_SPECS) {
    try {
      const agent = await project.agents.update(spec.name, spec.definition);
      results.push({ name: agent.name, version: agent.versions.latest.version });
    } catch {
      const agent = await project.agents.create(spec.name, spec.definition);
      results.push({ name: agent.name, version: agent.versions.latest.version });
    }
  }
  return results;
}

async function upsertIndex(endpoint: string, credential: ReturnType<typeof getAzureCredential>, documents: ArchiveRecord[]) {
  const indexClient = new SearchIndexClient(endpoint, credential, { serviceVersion: SEARCH_API_VERSION });
  await indexClient.createOrUpdateIndex(createIndexDefinition());
  const client = new SearchClient<ArchiveRecord>(endpoint, SEARCH_INDEX_NAME, credential, { serviceVersion: SEARCH_API_VERSION });
  const batchSize = 200;
  for (let start = 0; start < documents.length; start += batchSize) {
    await client.uploadDocuments(documents.slice(start, start + batchSize));
  }
}

async function createKnowledgeBase(endpoint: string, credential: ReturnType<typeof getAzureCredential>) {
  const token = await credential.getToken("https://search.azure.com/.default");
  if (!token?.token) {
    throw new Error("Failed to acquire Azure AI Search token");
  }
  const headers = {
    authorization: `Bearer ${token.token}`,
    accept: "application/json;odata.metadata=minimal",
    "content-type": "application/json",
    prefer: "return=representation",
  };
  const knowledgeSourceResponse = await fetch(`${endpoint}/knowledgesources('${KNOWLEDGE_SOURCE_NAME}')?api-version=${SEARCH_API_VERSION}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: KNOWLEDGE_SOURCE_NAME,
      kind: "searchIndex",
      description: "Synthetic MatchLens archive search index.",
      searchIndexParameters: {
        searchIndexName: SEARCH_INDEX_NAME,
        semanticConfigurationName: "default",
        sourceDataFields: [{ name: "title" }, { name: "body" }],
        searchFields: [{ name: "*" }],
      },
    }),
  });
  if (!knowledgeSourceResponse.ok) {
    throw new Error(`Knowledge source create/update failed: ${knowledgeSourceResponse.status} ${await knowledgeSourceResponse.text()}`);
  }
  const knowledgeBaseResponse = await fetch(`${endpoint}/knowledgebases('${KNOWLEDGE_BASE_NAME}')?api-version=${SEARCH_API_VERSION}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: KNOWLEDGE_BASE_NAME,
      description: "Synthetic MatchLens archive knowledge base.",
      knowledgeSources: [{ name: KNOWLEDGE_SOURCE_NAME }],
    }),
  });
  if (!knowledgeBaseResponse.ok) {
    throw new Error(`Knowledge base create/update failed: ${knowledgeBaseResponse.status} ${await knowledgeBaseResponse.text()}`);
  }
}

async function main() {
  const projectEndpoint = required("PROJECT_ENDPOINT");
  const searchEndpoint = required("AZURE_SEARCH_ENDPOINT");
  const credential = getAzureCredential();
  const archive = await loadArchive();
  const project = new AIProjectClient(projectEndpoint, credential);
  const agents = await upsertAgents(project);
  const documents = archiveDocuments(archive);
  await upsertIndex(searchEndpoint, credential, documents);
  await createKnowledgeBase(searchEndpoint, credential);
  const details = {
    projectEndpoint,
    agents,
    search: {
      indexName: SEARCH_INDEX_NAME,
      knowledgeBaseName: KNOWLEDGE_BASE_NAME,
      knowledgeSourceName: KNOWLEDGE_SOURCE_NAME,
      apiVersion: SEARCH_API_VERSION,
      documentCount: documents.length,
    },
  };
  writeFileSync(resolve(process.cwd(), ".desk.local.json"), `${JSON.stringify(details, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(details, null, 2));
}

await main();
