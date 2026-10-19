import type {
  AnalysisRequest,
  AppHealth,
  FixtureSummary,
  Language,
  MatchFixture,
  MatchPeriod,
  MatchSnapshot,
  NarrativeRequest,
  NarrativeResponse,
  PostMatchStorylinesResponse
} from "../shared/types.js";
import type { ChanceInsight } from "../shared/chanceSequence.js";
import type {
  ArchivePlayerProfile,
  ArchiveSummary,
  GenerateMatchRequest,
  LiveStatus,
  RecapStoryboard,
  ReviewStorylineRequest,
  StartLiveRequest,
  Storyline
} from "../shared/platform.js";
import { MAX_UPLOAD_BYTES, type ManualTagInput, type VideoJob, type VideoJobRequest, type VideoJobSummary } from "../shared/video.js";
import type { HighlightCommentary, HighlightCommentaryRequest } from "../shared/highlights.js";
import type { PlayerCamJob, PlayerCamJobSummary, PlayerCamRequest } from "../shared/playercam.js";
import type { ProgressiveVideoBatch, ProgressiveVideoSession, StartProgressiveVideo } from "../shared/progressiveVideo.js";

export type PlayerNote = {
  playerId: string;
  headline: string;
  summary: string;
  strengths: string[];
  concerns: string[];
  source: "foundry" | "rules";
  agent?: string;
  problem?: string;
  period?: MatchPeriod;
  asOfSecond?: number;
};

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  allowNotFound?: boolean;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

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
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

export const api = {
  getHealth(signal?: AbortSignal) { return requestJson<AppHealth>("/api/health", { signal }); },
  getFixtures(signal?: AbortSignal) { return requestJson<FixtureSummary[]>("/api/fixtures", { signal }); },
  getFixture(id: string, signal?: AbortSignal) { return requestJson<MatchFixture>(`/api/fixtures/${id}`, { signal }); },
  analyze(body: AnalysisRequest, signal?: AbortSignal) { return requestJson<MatchSnapshot>("/api/analyze", { method: "POST", body, signal }); },
  narrate(body: NarrativeRequest, signal?: AbortSignal) { return requestJson<NarrativeResponse>("/api/narrate", { method: "POST", body, signal }); },
  narrateLive(body: { persona: "analyst" | "casual"; language: Language; favoritePlayerId?: string; favoriteClubId?: string }, signal?: AbortSignal) { return requestJson<NarrativeResponse>("/api/live/narrate", { method: "POST", body, signal }); },
  postMatchStorylines(body: { language: Language; persona?: "analyst" | "casual" | "player"; favoriteClubId?: string; favouriteClubId?: string; favoritePlayerId?: string; favouritePlayerId?: string }, signal?: AbortSignal) {
    return requestJson<PostMatchStorylinesResponse>("/api/live/storylines/postmatch", { method: "POST", body, signal });
  },
  highlightCommentary(body: HighlightCommentaryRequest, signal?: AbortSignal) { return requestJson<HighlightCommentary>("/api/live/highlights/commentary", { method: "POST", body, signal }); },
  analysePlayer(playerId: string, language: Language, period: MatchPeriod = "full", signal?: AbortSignal) { return requestJson<PlayerNote>(`/api/live/players/${encodeURIComponent(playerId)}/analysis`, { method: "POST", body: { language, period }, signal }); },
  getArchiveSummary(signal?: AbortSignal) { return requestJson<ArchiveSummary>("/api/archive/summary", { signal }); },
  getArchivePlayerProfile(archiveId: string, signal?: AbortSignal) { return requestJson<ArchivePlayerProfile>(`/api/archive/players/${archiveId}`, { signal }); },
  generateMatch(body: GenerateMatchRequest, signal?: AbortSignal) { return requestJson<FixtureSummary>("/api/matchlab/generate", { method: "POST", body, signal }); },
  getLiveStatus(signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/status", { signal }); },
  getChanceInsights(signal?: AbortSignal) { return requestJson<ChanceInsight[]>("/api/live/insights?role=studio", { signal }); },
  getLiveFixture(signal?: AbortSignal) { return requestJson<MatchFixture>("/api/live/fixture", { signal, allowNotFound: true }); },
  startLive(body: StartLiveRequest, signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/start", { method: "POST", body, signal }); },
  stopLive(signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/stop", { method: "POST", signal, allowNotFound: true }); },
  sendCorrection(eventId: string, signal?: AbortSignal) { return requestJson<LiveStatus>("/api/live/correction", { method: "POST", body: { eventId }, signal }); },
  getStudioStorylines(signal?: AbortSignal) { return requestJson<Storyline[]>("/api/studio/storylines", { signal }); },
  reviewStoryline(id: string, body: ReviewStorylineRequest, signal?: AbortSignal) { return requestJson<Storyline>(`/api/studio/storylines/${id}/review`, { method: "POST", body, signal }); },
  getStudioStoryboard(signal?: AbortSignal) { return requestJson<RecapStoryboard>("/api/studio/storyboard", { signal, allowNotFound: true }); },
  getStudioHealth(signal?: AbortSignal) { return requestJson<{ mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string }>("/api/studio/health", { signal }); },
  getVideoHealth(signal?: AbortSignal) { return requestJson<VideoHealth>("/api/video/health", { signal }); },
  startProgressiveVideo(body: StartProgressiveVideo, signal?: AbortSignal) { return requestJson<ProgressiveVideoSession>("/api/video/live-sessions", { method: "POST", body, signal }); },
  getProgressiveVideo(id: string, signal?: AbortSignal) { return requestJson<ProgressiveVideoSession>(`/api/video/live-sessions/${encodeURIComponent(id)}`, { signal }); },
  sendProgressiveBatch(id: string, body: ProgressiveVideoBatch, signal?: AbortSignal) { return requestJson<ProgressiveVideoSession>(`/api/video/live-sessions/${encodeURIComponent(id)}/batches`, { method: "POST", body, signal }); },
  completeProgressiveVideo(id: string, signal?: AbortSignal) { return requestJson<ProgressiveVideoSession>(`/api/video/live-sessions/${encodeURIComponent(id)}/complete`, { method: "POST", signal }); },
  stopProgressiveVideo(id: string, signal?: AbortSignal) { return requestJson<ProgressiveVideoSession>(`/api/video/live-sessions/${encodeURIComponent(id)}`, { method: "DELETE", signal, keepalive: true }); },
  getVideoJob(id: string, signal?: AbortSignal) { return requestJson<VideoJob>(`/api/video/jobs/${id}`, { signal }); },
  startVideoLive(id: string) { return requestJson<LiveStatus>(`/api/video/jobs/${id}/live`, { method: "POST" }); },
  swapVideoTeams(id: string) { return requestJson<VideoJob>(`/api/video/jobs/${id}/swap-teams`, { method: "POST" }); },
  addVideoTag(id: string, body: Omit<ManualTagInput, "note"> & { note?: string }) { return requestJson<VideoJob>(`/api/video/jobs/${id}/tags`, { method: "POST", body }); },
  removeVideoTag(id: string, tagId: string) { return requestJson<VideoJob>(`/api/video/jobs/${id}/tags/${tagId}`, { method: "DELETE" }); },
  listVideoJobs(signal?: AbortSignal) { return requestJson<VideoJobSummary[]>("/api/video/jobs", { signal }); },
  deleteVideoJob(id: string) { return requestJson<null>(`/api/video/jobs/${id}`, { method: "DELETE" }); },
  getPlayerCamJob(id: string, signal?: AbortSignal) { return requestJson<PlayerCamJob>(`/api/player-cam/jobs/${id}`, { signal }); },
  listPlayerCamJobs(signal?: AbortSignal) { return requestJson<PlayerCamJobSummary[]>("/api/player-cam/jobs", { signal }); },
  deletePlayerCamJob(id: string) { return requestJson<null>(`/api/player-cam/jobs/${id}`, { method: "DELETE" }); }
};

export type VideoHealth = { visionConfigured: boolean; ffmpeg: boolean; maxUploadBytes: number; maxVideoSeconds: number; maxFrames: number };

/** Streams a file to a worker endpoint. XHR rather than fetch so the UI can show upload progress. */
function uploadFile<T>(url: string, file: File, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      reject(new Error(`The clip is too large. Choose a video up to ${MAX_UPLOAD_BYTES / 1_048_576} MB.`));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new Error("The upload failed. Check your connection and try again."));
    xhr.onload = () => {
      let payload: unknown = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* non-JSON error */ }
      if (xhr.status === 202) resolve(payload as T);
      else reject(new Error((payload as { error?: string } | null)?.error ?? `Upload failed with ${xhr.status}`));
    };
    xhr.send(file);
  });
}

export function uploadVideo(file: File, request: VideoJobRequest, onProgress: (fraction: number) => void): Promise<VideoJob> {
  const query = new URLSearchParams({ fileName: file.name, homeName: request.home.name, homeKit: request.home.kit, awayName: request.away.name, awayKit: request.away.kit });
  return uploadFile<VideoJob>(`/api/video/jobs?${query.toString()}`, file, onProgress);
}

export function uploadPlayerCam(file: File, request: PlayerCamRequest, onProgress: (fraction: number) => void): Promise<PlayerCamJob> {
  const query = new URLSearchParams({ fileName: file.name, playerName: request.name, kit: request.kit });
  if (request.number !== null) query.set("number", String(request.number));
  if (request.anchor) {
    query.set("anchorSecond", request.anchor.second.toFixed(2));
    query.set("anchorX", request.anchor.x.toFixed(4));
    query.set("anchorY", request.anchor.y.toFixed(4));
  }
  return uploadFile<PlayerCamJob>(`/api/player-cam/jobs?${query.toString()}`, file, onProgress);
}
