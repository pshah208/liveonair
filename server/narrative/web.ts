import { getBearerTokenProvider } from "@azure/identity";
import { AzureOpenAI } from "openai";

import { getAzureCredential } from "../azure/credential.js";

/** Social and user-generated hosts. gpt-4.1-mini rejects filters.allowed_domains, so we filter here. */
const BLOCKED_DOMAINS = [
  "twitter.com",
  "x.com",
  "t.co",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "snapchat.com",
  "threads.net",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "pinterest.com",
  "discord.com",
  "discord.gg",
  "telegram.org",
  "t.me",
  "whatsapp.com",
  "tumblr.com",
  "medium.com",
  "substack.com",
  "quora.com",
  "blogspot.com",
  "wordpress.com",
  "wikipedia.org",
] as const;

const PREFERRED_DOMAINS = [
  "bbc.co.uk",
  "bbc.com",
  "theguardian.com",
  "reuters.com",
  "apnews.com",
  "skysports.com",
  "espn.com",
  "theathletic.com",
  "nytimes.com",
  "independent.co.uk",
  "telegraph.co.uk",
  "lemonde.fr",
  "lequipe.fr",
  "marca.com",
  "globo.com",
  "as.com",
];

export type WebCitation = {
  url: string;
  title: string;
  startIndex: number;
  endIndex: number;
};

export type WebScoutResult = {
  text: string;
  annotations: WebCitation[];
  sources: Array<{ url: string; title?: string }>;
  queries: string[];
};

export type WebScout = {
  search(input: { prompt: string; timeoutMs: number }): Promise<WebScoutResult>;
};

export type AcceptedWebItem = {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  preferred: boolean;
};

export type CitationFilter = {
  items: AcceptedWebItem[];
  rejectedUrls: string[];
};

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

/**
 * Citation identity. Lowercase scheme plus URL.host (hostname and non-default port).
 * URL.host already omits default ports 80 and 443 for their schemes. A leading www label,
 * one trailing slash and a fragment are dropped. Path and query are preserved exactly, so a
 * different port, query or path suffix does not match.
 */
export function citationUrlKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    const host = parsed.host.toLowerCase().replace(/^www\./u, "");
    const path = parsed.pathname.replace(/\/+$/u, "") || "/";
    return `${scheme}//${host}${path}${parsed.search}`;
  } catch {
    return undefined;
  }
}

export function isBlockedDomain(url: string): boolean {
  const host = hostOf(url);
  if (!host) return true;
  return BLOCKED_DOMAINS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

export function isPreferredDomain(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return PREFERRED_DOMAINS.some((preferred) => host === preferred || host.endsWith(`.${preferred}`));
}

/**
 * A web claim is usable only when its url_citation URL is also in web_search_call.action.sources
 * and the host is not on the social/UGC block list.
 */
export function acceptWebCitations(result: WebScoutResult): CitationFilter {
  const sourceKeys = new Set(
    result.sources
      .map((source) => citationUrlKey(source.url))
      .filter((key): key is string => Boolean(key)),
  );
  const rejectedUrls: string[] = [];
  const items: AcceptedWebItem[] = [];
  const seen = new Set<string>();
  for (const annotation of result.annotations) {
    const key = citationUrlKey(annotation.url);
    if (!key || !sourceKeys.has(key) || isBlockedDomain(annotation.url)) {
      rejectedUrls.push(annotation.url);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const start = Math.max(0, annotation.startIndex);
    const end = Math.max(start, annotation.endIndex);
    const snippet = result.text.slice(start, end).replace(/\s+/gu, " ").trim().slice(0, 400);
    if (!snippet) {
      rejectedUrls.push(annotation.url);
      continue;
    }
    items.push({
      title: annotation.title.trim() || hostOf(annotation.url) || annotation.url,
      url: annotation.url,
      domain: hostOf(annotation.url) ?? annotation.url,
      snippet,
      preferred: isPreferredDomain(annotation.url),
    });
  }
  items.sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.domain.localeCompare(right.domain));
  return { items, rejectedUrls };
}

export type PrecedentSituation = {
  comebackFrom: number;
  earlyRedCard: boolean;
  redCardStillWon: boolean;
  lateWinnerMinute?: number;
  setPieceGoal: boolean;
};

/** Real-world precedent queries only. Synthetic names are never added here. */
export function buildPrecedentQueries(situation: PrecedentSituation, realWorldNames: readonly string[] = []): string[] {
  const queries: string[] = [];
  if (situation.comebackFrom >= 2) queries.push("Premier League comebacks from two goals down");
  else if (situation.comebackFrom === 1) queries.push("Premier League comeback from a goal down");
  if (situation.earlyRedCard) {
    queries.push(situation.redCardStillWon
      ? "football team won after an early red card"
      : "early red card changes a football match");
  }
  if (situation.lateWinnerMinute !== undefined && situation.lateWinnerMinute >= 90) {
    queries.push("Premier League late winners after the 90th minute");
  }
  if (situation.setPieceGoal) queries.push("Premier League set piece goal trends");
  if (queries.length === 0) queries.push("football match turning points and comebacks");
  for (const name of realWorldNames) {
    const cleaned = name.trim();
    if (cleaned.length >= 3 && cleaned.length <= 80 && !/\d/u.test(cleaned)) {
      queries.push(`${cleaned} latest football news`);
    }
  }
  return [...new Set(queries)].slice(0, 3);
}

export function describePublicSituation(situation: PrecedentSituation): string {
  const bits: string[] = [];
  if (situation.comebackFrom > 0) bits.push(`a side recovered from ${situation.comebackFrom} goals down`);
  if (situation.earlyRedCard) bits.push("a side was shown a red card in the first half");
  if (situation.lateWinnerMinute !== undefined) bits.push(`a goal arrived in minute ${situation.lateWinnerMinute}`);
  if (situation.setPieceGoal) bits.push("a goal followed a set piece");
  return bits.join("; ") || "a competitive league match with a clear turning point";
}

export function buildScoutPrompt(situation: PrecedentSituation, queries: readonly string[]): string {
  return [
    "Search the public web for real-world football precedent only.",
    `Situation, with no club or person names: ${describePublicSituation(situation)}.`,
    `Search queries to cover: ${queries.join(" | ")}.`,
    "Write 2 to 4 short comparisons. Each comparison must be backed by a page you actually opened.",
    "Do not mention fictional clubs, fictional players or fictional coaches.",
    "Do not invent statistics. If a figure is not on the cited page, leave it out.",
    "Phrase comparisons as comparisons. Do not claim a record unless the cited page states it.",
    "If you cannot cite a source, say no citable precedent was found.",
  ].join(" ");
}

export function resolveWebSearchMode(env: NodeJS.ProcessEnv = process.env): "on" | "off" {
  const raw = (env.NARRATIVE_WEB_SEARCH ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "on" || raw === "1" || raw === "true") return "on";
  return env.AZURE_OPENAI_ENDPOINT ? "on" : "off";
}

type LooseResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    action?: {
      type?: string;
      queries?: string[];
      query?: string;
      sources?: Array<{ url?: string; title?: string }>;
    };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }>;
    }>;
  }>;
};

export function parseResponsesWebResult(payload: LooseResponse): WebScoutResult {
  const queries: string[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const annotations: WebCitation[] = [];
  let text = payload.output_text ?? "";
  for (const item of payload.output ?? []) {
    if (item.type === "web_search_call" && item.action) {
      for (const query of item.action.queries ?? []) queries.push(query);
      if (item.action.query) queries.push(item.action.query);
      for (const source of item.action.sources ?? []) {
        if (source.url) sources.push({ url: source.url, title: source.title });
      }
    }
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        if (content.type === "output_text" && content.text) {
          if (!text) text = content.text;
          for (const annotation of content.annotations ?? []) {
            if (annotation.type !== "url_citation" || !annotation.url) continue;
            annotations.push({
              url: annotation.url,
              title: annotation.title ?? "",
              startIndex: annotation.start_index ?? 0,
              endIndex: annotation.end_index ?? 0,
            });
          }
        }
      }
    }
  }
  return { text, annotations, sources, queries: [...new Set(queries)] };
}

/** Live web scout. Free-text Responses call so url_citation annotations are kept (json_schema drops them). */
export function createWebScoutFromEnv(env: NodeJS.ProcessEnv = process.env): WebScout | undefined {
  if (resolveWebSearchMode(env) !== "on") return undefined;
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) return undefined;
  const deployment = env.AZURE_OPENAI_DEPLOYMENT || "matchlens-narrator";
  const root = endpoint.replace(/\/$/u, "");
  const tokenProvider = getBearerTokenProvider(getAzureCredential(env), "https://cognitiveservices.azure.com/.default");
  const client = new AzureOpenAI({
    endpoint: root,
    baseURL: `${root}/openai/v1/`,
    apiVersion: env.AZURE_OPENAI_API_VERSION || "2024-10-21",
    azureADTokenProvider: tokenProvider,
    maxRetries: 0,
  });

  return {
    async search({ prompt, timeoutMs }) {
      const response = await client.responses.create({
        model: deployment,
        input: prompt,
        tools: [{
          type: "web_search",
          search_context_size: "low",
          user_location: { type: "approximate", country: "GB" },
        }],
        include: ["web_search_call.action.sources"],
      }, { signal: AbortSignal.timeout(timeoutMs) });
      return parseResponsesWebResult(response as LooseResponse);
    },
  };
}
