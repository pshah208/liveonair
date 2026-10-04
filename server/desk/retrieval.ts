import {
  KnowledgeRetrievalClient,
  SearchClient,
  type KnowledgeBaseReference,
  type KnowledgeBaseRetrievalResponse,
} from "@azure/search-documents";

import { getAzureCredential } from "../azure/credential.js";
import type { ArchiveRetrieval, ArchiveSearchHit } from "./claims.js";

type SearchDocument = {
  id: string;
  title?: string | null;
  body?: string | null;
  recordIds?: string[] | null;
};

class UnconfiguredArchiveRetrieval implements ArchiveRetrieval {
  readonly mode = "unconfigured" as const;

  describe() {
    return "unconfigured";
  }

  async search(): Promise<ArchiveSearchHit[]> {
    throw new Error("archive search unavailable");
  }
}

class SearchIndexArchiveRetrieval implements ArchiveRetrieval {
  readonly mode = "azure-ai-search-index" as const;

  constructor(private readonly client: SearchClient<SearchDocument>) {}

  describe() {
    return this.mode;
  }

  async search(query: string): Promise<ArchiveSearchHit[]> {
    const result = await this.client.search(query, {
      queryType: "semantic",
      semanticSearchOptions: {
        configurationName: "default",
      },
      top: 5,
      select: ["id", "title", "body", "recordIds"] satisfies (keyof SearchDocument)[],
    });
    const hits: ArchiveSearchHit[] = [];
    for await (const item of result.results) {
      const document = item.document as SearchDocument;
      hits.push({
        id: document.id,
        title: document.title ?? "",
        body: document.body ?? "",
        recordIds: document.recordIds ?? [],
      });
    }
    return hits;
  }
}

function referenceRecordIds(reference: KnowledgeBaseReference): string[] {
  const payload = reference as KnowledgeBaseReference & { sourceData?: { recordIds?: unknown } };
  if (payload.sourceData && Array.isArray(payload.sourceData.recordIds)) {
    return payload.sourceData.recordIds.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function flattenRetrievalText(response: KnowledgeBaseRetrievalResponse): string {
  const parts: string[] = [];
  for (const message of response.response ?? []) {
    for (const content of message.content ?? []) {
      if (content.type === "text" && "text" in content && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n\n").trim();
}

class KnowledgeBaseArchiveRetrieval implements ArchiveRetrieval {
  readonly mode = "foundry-iq-knowledge-base" as const;

  constructor(
    private readonly client: KnowledgeRetrievalClient,
    private readonly knowledgeSourceName: string,
  ) {}

  describe() {
    return this.mode;
  }

  async search(query: string): Promise<ArchiveSearchHit[]> {
    const response = await this.client.retrieve({
      intents: [{ type: "semantic", search: query }],
      includeActivity: true,
      maxRuntimeInSeconds: 15,
      maxOutputSizeInTokens: 900,
      knowledgeSourceParams: [{
        kind: "searchIndex",
        knowledgeSourceName: this.knowledgeSourceName,
        includeReferences: true,
        includeReferenceSourceData: true,
      }],
    });
    const fallbackText = flattenRetrievalText(response);
    return (response.references ?? []).slice(0, 5).map((reference, index) => ({
      id: String(index),
      title: "knowledge-base-hit",
      body: fallbackText,
      recordIds: referenceRecordIds(reference),
    }));
  }
}

export function createArchiveRetrievalFromEnv(env: NodeJS.ProcessEnv = process.env): ArchiveRetrieval {
  const endpoint = env.AZURE_SEARCH_ENDPOINT;
  if (!endpoint) {
    return new UnconfiguredArchiveRetrieval();
  }

  const credential = getAzureCredential(env);
  if (env.AZURE_SEARCH_KNOWLEDGE_BASE && env.AZURE_SEARCH_KNOWLEDGE_SOURCE) {
    return new KnowledgeBaseArchiveRetrieval(
      new KnowledgeRetrievalClient(endpoint, env.AZURE_SEARCH_KNOWLEDGE_BASE, credential),
      env.AZURE_SEARCH_KNOWLEDGE_SOURCE,
    );
  }

  if (env.AZURE_SEARCH_INDEX) {
    return new SearchIndexArchiveRetrieval(
      new SearchClient<SearchDocument>(endpoint, env.AZURE_SEARCH_INDEX, credential),
    );
  }

  return new UnconfiguredArchiveRetrieval();
}
