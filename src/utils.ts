import type { Language, MatchEvent, MatchFixture, TeamId } from "../shared/types.js";
import { latestRevisions } from "../shared/highlights.js";
import type { ClaimSource, LiveStatus, Localized, RecapChapter, ScenarioKind, Storyline, StorylineClaim, StorylineStatus, VerifiedFact } from "../shared/platform.js";

export type Theme = "light" | "dark";

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

export const LANGUAGES: Language[] = ["en", "es", "fr"];
export const LANGUAGE_LABEL: Record<Language, string> = { en: "English", es: "Español", fr: "Français" };
export const SCENARIOS: ScenarioKind[] = ["comeback", "red_card", "set_piece", "late_winner", "goal_fest"];
export const STORYLINE_STATUS_ORDER: StorylineStatus[] = ["needs_review", "researching", "checking", "drafting", "approved", "failed", "rejected", "retracted"];

export function createAsyncState<T>(loading = false): AsyncState<T> {
  return { data: null, loading, error: null };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minute = Math.floor(safeSeconds / 60);
  const second = safeSeconds % 60;
  return `${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")}`;
}

export function formatMinuteLabel(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(safeSeconds / 60)}'${(safeSeconds % 60).toString().padStart(2, "0")}`;
}

export function labelize(value: string): string {
  return value.replaceAll("_", " ");
}

export function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function teamTint(teamId: TeamId): string {
  return teamId === "home" ? "var(--cp-accent)" : "var(--cp-warning)";
}

export function outcomeLabel(event: MatchEvent): string {
  if (event.rescinded) return "ruled out";
  if (event.type === "goal") return "scored";
  if (event.outcome === "none") return "logged";
  return event.outcome;
}

export function localizeText(localized: Localized, language: Language): { text: string; fallback: boolean } {
  const preferred = localized[language]?.trim();
  if (preferred) return { text: preferred, fallback: false };
  const english = localized.en?.trim();
  if (english) return { text: english, fallback: language !== "en" };
  const backup = LANGUAGES.map((item) => localized[item]?.trim()).find(Boolean);
  return { text: backup ?? "", fallback: Boolean(backup) && language !== "en" };
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadJson(filename: string, payload: unknown): void {
  triggerDownload(filename, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  triggerDownload(filename, blob);
}

export function mergeById<T extends { id: string }>(items: T[], incoming: T): T[] {
  const map = new Map(items.map((item) => [item.id, item]));
  map.set(incoming.id, incoming);
  return [...map.values()];
}

export function sortFactsNewestFirst(facts: VerifiedFact[]): VerifiedFact[] {
  return facts.slice().sort((a, b) => Number(Boolean(a.retracted)) - Number(Boolean(b.retracted)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function sortStudioStorylines(storylines: Storyline[]): Storyline[] {
  return storylines.slice().sort((a, b) => {
    const groupGap = STORYLINE_STATUS_ORDER.indexOf(a.status) - STORYLINE_STATUS_ORDER.indexOf(b.status);
    if (groupGap !== 0) return groupGap;
    if (a.triggerMinute !== b.triggerMinute) return b.triggerMinute - a.triggerMinute;
    return b.priority - a.priority;
  });
}

export function computeScoreFromEvents(fixture: MatchFixture | null | undefined): { home: number; away: number } {
  const score = { home: 0, away: 0 };
  for (const event of latestRevisions(fixture?.events ?? [])) {
    if (event.type === "goal" && !event.rescinded) score[event.teamId] += 1;
  }
  return score;
}

export function liveTransportLabel(status: Pick<LiveStatus, "transport" | "transportConfigured">): string {
  return status.transport === "fabric-eventstream" ? "Fabric Eventstream" : status.transportConfigured ? "Local bus" : "Local bus (Fabric off)";
}

export function statusTone(status: StorylineStatus): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "approved": return "success";
    case "needs_review": return "info";
    case "researching":
    case "checking":
    case "drafting": return "warning";
    case "failed":
    case "rejected":
    case "retracted": return "danger";
    default: return "neutral";
  }
}

export function hasActiveSpinner(status: StorylineStatus): boolean {
  return status === "researching" || status === "checking" || status === "drafting";
}

export function formatClaimSource(source: ClaimSource): string {
  return `${source.type}:${source.id}`;
}

export function claimText(claim: StorylineClaim, language: Language): { text: string; fallback: boolean } {
  return localizeText(claim.text, language);
}

export function factText(fact: VerifiedFact, language: Language): { text: string; fallback: boolean } {
  return localizeText(fact.text, language);
}

export function storylineText(localized: Localized, language: Language): { text: string; fallback: boolean } {
  return localizeText(localized, language);
}

export function chapterText(chapter: RecapChapter, language: Language): { title: string; summary: string; titleFallback: boolean; summaryFallback: boolean } {
  const title = localizeText(chapter.title, language);
  const summary = localizeText(chapter.summary, language);
  return { title: title.text, summary: summary.text, titleFallback: title.fallback, summaryFallback: summary.fallback };
}
