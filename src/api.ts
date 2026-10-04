import type {
  AnalysisRequest,
  AppHealth,
  FixtureSummary,
  Language,
  MatchFixture,
  MatchSnapshot,
  NarrativeRequest,
  NarrativeResponse
} from "../shared/types.js";
import type {
  ArchivePlayerProfile,
  ArchiveSummary,
  GenerateMatchRequest,
  LiveStatus,
  RecapStoryboard,
  ReviewStorylineRequest,
  StartLiveRequest,
  Storyline,
  VerifiedFact
} from "../shared/platform.js";

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  allowNotFound?: boolean;
};

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // ignore
  }
  const fallback = await response.text();
  return fallback || `Request failed with ${response.status}`;
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestOptions): Promise<T | null> {
  const headers = new Headers(init?.headers);
  const hasBody = init && Object.prototype.hasOwnProperty.call(init, "body");
  if (hasBody) headers.set("Content-Type", "application/json");
  const response = await fetch(input, {
    ...init,
    headers,
    body: hasBody ? JSON.stringify(init?.body) : undefined
  });
  if (init?.allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

export const api = {
  getHealth(signal?: AbortSignal) { return requestJson<AppHealth>("/api/health", { signal }); },
  getFixtures(signal?: AbortSignal) { return requestJson<FixtureSummary[]>("/api/fixtures", { signal }); },
  getFixture(id: string, signal?: AbortSignal) { return requestJson<MatchFixture>(`/api/fixtures/${id}`, { signal }); },
  analyze(body: AnalysisRequest, signal?: AbortSignal) { return requestJson<MatchSnapshot>("/api/analyze", { method: "POST", body, signal }); },
  narrate(body: NarrativeRequest, signal?: AbortSignal) { return requestJson<NarrativeResponse>("/api/narrate", { method: "POST", body, signal }); },
  narrateLive(body: { persona: "analyst" | "casual"; language: Language }, signal?: AbortSignal) { return requestJson<NarrativeResponse>("/api/live/narrate", { method: "POST", body, signal }); },
  getArchiveSummary(signal?: AbortSignal) { return requestJson<ArchiveSummary>("/api/archive/summary", { signal }); },
  getArchivePlayerProfile(archiveId: string, signal?: AbortSignal) { return requestJson<ArchivePlayerProfile>(`/api/archive/players/${archiveId}`, { signal }); },
  generateMatch(body: GenerateMatchRequest, signal?: AbortSignal) { return requestJson<FixtureSummary>("/api/matchlab/generate", { method: "POST", body, signal }); },
  getLiveStatus(signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/status", { signal }); },
  getLiveFixture(signal?: AbortSignal) { return requestJson<MatchFixture>("/api/live/fixture", { signal, allowNotFound: true }); },
  startLive(body: StartLiveRequest, signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/start", { method: "POST", body, signal }); },
  stopLive(signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/stop", { method: "POST", signal, allowNotFound: true }); },
  sendCorrection(eventId: string, signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/correction", { method: "POST", body: { eventId }, signal }); },
  getStudioStorylines(signal?: AbortSignal) { return requestJson<Storyline[]>("/api/studio/storylines", { signal }); },
  reviewStoryline(id: string, body: ReviewStorylineRequest, signal?: AbortSignal) { return requestJson<Storyline>(`/api/studio/storylines/${id}/review`, { method: "POST", body, signal }); },
  getStudioFacts(signal?: AbortSignal) { return requestJson<VerifiedFact[]>("/api/studio/facts", { signal }); },
  getStudioStoryboard(signal?: AbortSignal) { return requestJson<RecapStoryboard>("/api/studio/storyboard", { signal, allowNotFound: true }); },
  getStudioHealth(signal?: AbortSignal) { return requestJson<{ mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string }>("/api/studio/health", { signal }); }
};
