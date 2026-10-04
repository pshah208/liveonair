import type {
  Language,
  MatchEvent,
  MatchFixture,
  MatchSnapshot,
  NarrativeResponse,
  Persona,
  Player,
  StoryCard,
  TeamId
} from "../shared/types.js";
import type {
  ArchivePlayerProfile,
  ClaimSource,
  LiveStatus,
  Localized,
  RecapChapter,
  ScenarioKind,
  Storyline,
  StorylineClaim,
  StorylineStatus,
  VerifiedFact
} from "../shared/platform.js";

export type Theme = "light" | "dark";
export type AppRoute = "/" | "/studio";
export type FanMode = "replay" | "live";

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

export const PERSONAS: Persona[] = ["analyst", "casual", "player"];
export const LANGUAGES: Language[] = ["en", "es", "fr"];
export const SCENARIOS: ScenarioKind[] = ["comeback", "red_card", "set_piece", "late_winner", "goal_fest"];
export const STORYLINE_STATUS_ORDER: StorylineStatus[] = [
  "needs_review",
  "researching",
  "checking",
  "drafting",
  "approved",
  "failed",
  "rejected",
  "retracted"
];

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
  const minute = Math.floor(safeSeconds / 60);
  const second = safeSeconds % 60;
  return `${minute}'${second.toString().padStart(2, "0")}`;
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
  if (event.rescinded) return "Rescinded";
  if (event.type === "goal") return "Goal";
  if (event.type === "save") return "Save";
  if (event.outcome === "complete") return "Complete";
  if (event.outcome === "incomplete") return "Incomplete";
  if (event.outcome === "saved") return "Saved";
  if (event.outcome === "blocked") return "Blocked";
  if (event.outcome === "miss") return "Miss";
  if (event.outcome === "success") return "Success";
  return "Logged";
}

export function buildPlayerMap(fixture: MatchFixture | null | undefined): Map<string, Player> {
  const map = new Map<string, Player>();
  if (!fixture) return map;
  [...fixture.home.players, ...fixture.away.players].forEach((player) => map.set(player.id, player));
  return map;
}

export function localizeText(localized: Localized, language: Language): { text: string; fallback: boolean } {
  const preferred = localized[language]?.trim();
  if (preferred) return { text: preferred, fallback: false };
  const english = localized.en?.trim();
  if (english) return { text: english, fallback: language !== "en" };
  const backup = LANGUAGES.map((item) => localized[item]?.trim()).find(Boolean);
  return { text: backup ?? "", fallback: Boolean(backup) && language !== "en" };
}

export function structuralLabel(card: StoryCard): string {
  return card.confidence === "observed" ? "Observed structure" : "Pattern-linked structure";
}

export function defaultFixtureSecond(durationSeconds: number): number {
  return clamp(72 * 60 + 30, 0, durationSeconds);
}

export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function mergeById<T extends { id: string }>(items: T[], incoming: T): T[] {
  const map = new Map(items.map((item) => [item.id, item]));
  map.set(incoming.id, incoming);
  return [...map.values()];
}

export function sortFactsNewestFirst(facts: VerifiedFact[]): VerifiedFact[] {
  return facts.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function sortStudioStorylines(storylines: Storyline[]): Storyline[] {
  return storylines.slice().sort((a, b) => {
    const groupGap = STORYLINE_STATUS_ORDER.indexOf(a.status) - STORYLINE_STATUS_ORDER.indexOf(b.status);
    if (groupGap !== 0) return groupGap;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function sortFanStorylines(storylines: Storyline[]): Storyline[] {
  return storylines.slice().sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "approved") return -1;
      if (b.status === "approved") return 1;
    }
    return b.triggerMinute - a.triggerMinute;
  });
}

export function storyCardIsRadar(card: StoryCard): boolean {
  return card.kind === "set_piece";
}

export function computeScoreFromEvents(fixture: MatchFixture | null | undefined): { home: number; away: number } {
  if (!fixture) return { home: 0, away: 0 };
  return fixture.events.reduce(
    (score, event) => {
      if (event.type === "goal" && !event.rescinded) {
        score[event.teamId] += 1;
      }
      return score;
    },
    { home: 0, away: 0 }
  );
}

export function findFavoritePlayer(fixture: MatchFixture | null | undefined, currentId?: string): string | undefined {
  if (!fixture) return undefined;
  const players = [...fixture.home.players, ...fixture.away.players];
  if (currentId && players.some((player) => player.id === currentId)) return currentId;
  return (players.find((player) => player.position === "ST") ?? players[0])?.id;
}

export function getPlayerById(fixture: MatchFixture | null | undefined, playerId?: string): Player | undefined {
  if (!fixture || !playerId) return undefined;
  return [...fixture.home.players, ...fixture.away.players].find((player) => player.id === playerId);
}

export function liveTransportLabel(status: Pick<LiveStatus, "transport" | "transportConfigured">): string {
  return status.transport === "fabric-eventstream"
    ? "Fabric Eventstream"
    : status.transportConfigured
      ? "Local bus"
      : "Local bus (Fabric not configured)";
}

export function statusTone(status: StorylineStatus): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "approved": return "success";
    case "needs_review":
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

export function relationLabel(kind: ArchivePlayerProfile["person"]["relations"][number]["kind"]): string {
  return labelize(kind);
}

export function spellClubName(profile: ArchivePlayerProfile, clubId: string): string {
  return profile.clubs[clubId]?.name ?? clubId;
}

export function latestSnapshotStories(snapshot: MatchSnapshot | null): StoryCard[] {
  return snapshot?.stories ?? [];
}

export function fixtureScore(snapshot: MatchSnapshot | null, fixture: MatchFixture | null | undefined): { home: number; away: number } {
  return snapshot?.score ?? computeScoreFromEvents(fixture);
}

export function summarizeLiveState(status: LiveStatus | null): string {
  if (!status) return "Connecting to the synthetic live desk.";
  if (status.state === "idle") return "Idle. Start a synthetic live match from the Studio console.";
  if (status.state === "finished") return "Full time reached. Storyboard recap is ready to refresh.";
  return `Running at ${status.speed}× with ${status.eventsReceived} envelopes received.`;
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
