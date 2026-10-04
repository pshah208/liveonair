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
import type { VideoJob, VideoJobRequest } from "../shared/video.js";

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
  getStudioHealth(signal?: AbortSignal) { return requestJson<{ mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string }>("/api/studio/health", { signal }); },
  getVideoHealth(signal?: AbortSignal) { return requestJson<VideoHealth>("/api/video/health", { signal }); },
  getVideoJob(id: string, signal?: AbortSignal) { return requestJson<VideoJob>(`/api/video/jobs/${id}`, { signal }); },
  startVideoLive(id: string) { return requestJson<LiveStatus>(`/api/video/jobs/${id}/live`, { method: "POST" }); },
  swapVideoTeams(id: string) { return requestJson<VideoJob>(`/api/video/jobs/${id}/swap-teams`, { method: "POST" }); }
};

export type VideoHealth = { visionConfigured: boolean; ffmpeg: boolean; maxUploadBytes: number };

/** Streams the file to the video worker. XHR rather than fetch so the UI can show upload progress. */
export function uploadVideo(file: File, request: VideoJobRequest, onProgress: (fraction: number) => void): Promise<VideoJob> {
  const query = new URLSearchParams({ fileName: file.name, homeName: request.home.name, homeKit: request.home.kit, awayName: request.away.name, awayKit: request.away.kit });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/video/jobs?${query.toString()}`);
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new Error("The upload failed. Check your connection and try again."));
    xhr.onload = () => {
      let payload: unknown = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* non-JSON error */ }
      if (xhr.status === 202) resolve(payload as VideoJob);
      else reject(new Error((payload as { error?: string } | null)?.error ?? `Upload failed with ${xhr.status}`));
    };
    xhr.send(file);
  });
}
