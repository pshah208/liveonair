import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalysisRequest,
  AppHealth,
  FixtureSummary,
  Language,
  MatchEvent,
  MatchFixture,
  MatchSnapshot,
  NarrativeRequest,
  NarrativeResponse,
  Persona,
  Player,
  StoryCard,
  TeamId
} from "../shared/types.js";

type ReplayState = {
  fixtureId: string;
  atSecond: number;
  persona: Persona;
  language: Language;
  favoritePlayerId?: string;
  correction: boolean;
};

type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

type QueuedNarration = {
  format: "recap";
  atSecond: number;
};

const DEFAULT_PERSONA: Persona = "analyst";
const DEFAULT_LANGUAGE: Language = "en";
const DEFAULT_START_SECOND = 72 * 60 + 30;
const SIMULATION_SPEED = 30;
const ANALYSIS_DEBOUNCE_MS = 220;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minute = Math.floor(safeSeconds / 60);
  const second = safeSeconds % 60;
  return `${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")}`;
}

function formatMinuteLabel(totalSeconds: number): string {
  const minute = Math.floor(totalSeconds / 60);
  const second = Math.floor(totalSeconds % 60);
  return `${minute}'${second.toString().padStart(2, "0")}`;
}

function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function labelize(value: string): string {
  return value.replaceAll("_", " ");
}

function outcomeLabel(event: MatchEvent): string {
  if (event.type === "goal") {
    return "Goal";
  }
  if (event.type === "save") {
    return "Save";
  }
  if (event.outcome === "complete") {
    return "Complete";
  }
  if (event.outcome === "incomplete") {
    return "Incomplete";
  }
  if (event.outcome === "saved") {
    return "Saved";
  }
  if (event.outcome === "blocked") {
    return "Blocked";
  }
  if (event.outcome === "miss") {
    return "Miss";
  }
  if (event.outcome === "success") {
    return "Success";
  }
  return "Logged";
}

function teamTint(teamId: TeamId): string {
  return teamId === "home" ? "var(--cp-accent)" : "var(--cp-warning)";
}

function structuralLabel(card: StoryCard): string {
  return card.confidence === "observed" ? "Observed structure" : "Pattern-linked structure";
}

function defaultFixtureSecond(durationSeconds: number): number {
  return clamp(DEFAULT_START_SECOND, 0, durationSeconds);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const payload = (await response.clone().json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      const fallback = await response.text();
      if (fallback) {
        message = fallback;
      }
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

function makeInitialReplayState(): ReplayState {
  return {
    fixtureId: "",
    atSecond: DEFAULT_START_SECOND,
    persona: DEFAULT_PERSONA,
    language: DEFAULT_LANGUAGE,
    favoritePlayerId: undefined,
    correction: false
  };
}

function BrandMark() {
  return (
    <svg viewBox="0 0 420 80" className="brandmark" role="img" aria-label="MatchLens wordmark">
      <defs>
        <linearGradient id="brand-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--cp-accent)" />
          <stop offset="100%" stopColor="var(--cp-warning)" />
        </linearGradient>
      </defs>
      <rect x="6" y="14" width="52" height="52" rx="18" fill="var(--cp-surface)" stroke="url(#brand-stroke)" strokeWidth="4" />
      <path d="M20 48 31 30l11 18 8-12" fill="none" stroke="url(#brand-stroke)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" />
      <circle cx="47" cy="28" r="7" fill="var(--cp-warning)" opacity="0.88" />
      <text x="80" y="39" fill="var(--cp-text)" fontSize="32" fontWeight="800" letterSpacing="-1">
        MatchLens
      </text>
      <text x="81" y="60" fill="var(--cp-text-soft)" fontSize="14" fontWeight="600" letterSpacing="1.8">
        THE STORY BEHIND THE SCORE
      </text>
    </svg>
  );
}

type ScenarioCardProps = {
  fixture: FixtureSummary;
  selected: boolean;
  score?: { home: number; away: number };
  onSelect: () => void;
};

function ScenarioCard({ fixture, selected, score, onSelect }: ScenarioCardProps) {
  return (
    <button
      type="button"
      className={`scenario-card${selected ? " is-active" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="scenario-card__meta">
        <span className="eyebrow">Scenario</span>
        <span className="tag tag--ghost">{fixture.eventCount} events</span>
      </div>
      <h3>{fixture.title}</h3>
      <p>{fixture.description}</p>
      <div className="scenario-card__footer">
        <div className="mini-score">
          <span>{fixture.home.shortName}</span>
          <strong>{score ? `${score.home}–${score.away}` : "—"}</strong>
          <span>{fixture.away.shortName}</span>
        </div>
        <span className="tag">{formatMinuteLabel(fixture.correctionAvailableAt)} correction</span>
      </div>
    </button>
  );
}

type PitchProps = {
  fixture: MatchFixture;
  snapshot: MatchSnapshot | null;
  selectedStory: StoryCard | null;
};

function Pitch({ fixture, snapshot, selectedStory }: PitchProps) {
  const highlightedEvents = useMemo(() => {
    if (!snapshot) {
      return [] as MatchEvent[];
    }
    const selectedEvidence = selectedStory
      ? selectedStory.evidenceIds
          .map((id) => snapshot.evidence[id])
          .filter((event): event is MatchEvent => Boolean(event))
      : [];
    if (selectedEvidence.length > 0) {
      return selectedEvidence.slice(-8);
    }
    return snapshot.recentEvents.slice(-8);
  }, [selectedStory, snapshot]);

  const latestEvent = highlightedEvents[highlightedEvents.length - 1] ?? null;

  return (
    <div className="panel pitch-panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Live board</span>
          <h2>Animated evidence pitch</h2>
        </div>
        {latestEvent ? <span className="tag">{labelize(latestEvent.type)}</span> : <span className="tag">Awaiting feed</span>}
      </div>
      <svg viewBox="0 0 100 68" className="pitch" role="img" aria-label={`${fixture.title} pitch map`}>
        <rect x="1" y="1" width="98" height="66" rx="4" fill="var(--cp-surface-soft)" stroke="var(--cp-border-strong)" strokeWidth="1.5" />
        <path d="M50 1v66M1 34h98" stroke="var(--cp-border)" strokeWidth="1" />
        <circle cx="50" cy="34" r="9.5" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <circle cx="50" cy="34" r="0.85" fill="var(--cp-border-strong)" />
        <rect x="1" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <rect x="83" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <rect x="1" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <rect x="94" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <circle cx="12" cy="34" r="0.85" fill="var(--cp-border-strong)" />
        <circle cx="88" cy="34" r="0.85" fill="var(--cp-border-strong)" />
        <path d="M1 24a10 10 0 0 0 0 20M99 24a10 10 0 0 1 0 20" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        {highlightedEvents.map((event, index) => {
          const x = event.x;
          const y = (event.y / 100) * 68;
          const endX = event.endX ?? event.x;
          const endY = ((event.endY ?? event.y) / 100) * 68;
          const active = latestEvent?.id === event.id;
          return (
            <g key={event.id}>
              {(event.endX !== undefined || event.endY !== undefined) && (
                <line
                  x1={x}
                  y1={y}
                  x2={endX}
                  y2={endY}
                  stroke={teamTint(event.teamId)}
                  strokeWidth={active ? 1.4 : 0.9}
                  strokeDasharray={event.type === "pass" || event.type === "corner" ? "2.5 2" : undefined}
                  opacity={0.82 - index * 0.06}
                />
              )}
              <circle
                cx={x}
                cy={y}
                r={active ? 2.1 : 1.4}
                fill={teamTint(event.teamId)}
                className={active ? "pitch-pulse" : undefined}
                opacity={0.95 - index * 0.08}
              />
            </g>
          );
        })}
      </svg>
      <div className="pitch-panel__legend">
        <span><i className="swatch swatch--home" /> {fixture.home.shortName}</span>
        <span><i className="swatch swatch--away" /> {fixture.away.shortName}</span>
        <span><i className="swatch swatch--selected" /> selected story evidence</span>
      </div>
    </div>
  );
}

type StoryPreviewProps = {
  snapshot: MatchSnapshot | null;
  selectedStory: StoryCard | null;
  onNarrate: () => void;
  onExport: () => void;
  narrationDisabled: boolean;
};

function StoryPreview({ snapshot, selectedStory, onNarrate, onExport, narrationDisabled }: StoryPreviewProps) {
  if (!snapshot || !selectedStory) {
    return (
      <div className="panel">
        <div className="panel__header">
          <div>
            <span className="eyebrow">Pinned story</span>
            <h2>Choose a rail card to focus the editorial lens</h2>
          </div>
        </div>
        <div className="empty-state">The feed is live, but no story is pinned yet.</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Pinned story</span>
          <h2>{selectedStory.title}</h2>
        </div>
        <span className="tag">{structuralLabel(selectedStory)}</span>
      </div>
      <p className="lede">{selectedStory.summary}</p>
      <p className="story-matter">{selectedStory.whyItMatters}</p>
      <div className="story-preview__metrics">
        {selectedStory.metrics.map((metric) => (
          <div className="metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong>
              {metric.value}
              {metric.unit ?? ""}
            </strong>
          </div>
        ))}
      </div>
      <div className="story-preview__actions">
        <button type="button" className="button button--primary" onClick={onNarrate} disabled={narrationDisabled}>
          Narrate selected story
        </button>
        <button type="button" className="button" onClick={onExport}>
          Export JSON overlay
        </button>
      </div>
      <div className="story-preview__coverage">
        <span>Structural coverage</span>
        <strong>{Math.round(snapshot.evidenceCoverage)}%</strong>
        <p>{selectedStory.evidenceIds.length} linked events support this live slice.</p>
      </div>
    </div>
  );
}

type RollingStatsProps = {
  fixture: MatchFixture;
  snapshot: MatchSnapshot | null;
};

function RollingStats({ fixture, snapshot }: RollingStatsProps) {
  const rows = snapshot
    ? [
        { label: "Goals", home: snapshot.stats.home.goals, away: snapshot.stats.away.goals },
        { label: "Shots", home: snapshot.stats.home.shots, away: snapshot.stats.away.shots },
        { label: "Pass accuracy", home: snapshot.stats.home.passAccuracy, away: snapshot.stats.away.passAccuracy, suffix: "%" },
        { label: "Illustrative xG", home: snapshot.stats.home.illustrativeXg, away: snapshot.stats.away.illustrativeXg, fixed: 2 }
      ]
    : [];

  return (
    <div className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Rolling numbers</span>
          <h2>Live team split</h2>
        </div>
      </div>
      {snapshot ? (
        <div className="stat-rows">
          {rows.map((row) => {
            const homeValue = row.fixed !== undefined ? row.home.toFixed(row.fixed) : `${row.home}${row.suffix ?? ""}`;
            const awayValue = row.fixed !== undefined ? row.away.toFixed(row.fixed) : `${row.away}${row.suffix ?? ""}`;
            const total = row.home + row.away || 1;
            const homeShare = (row.home / total) * 100;
            const awayShare = (row.away / total) * 100;
            return (
              <div className="stat-row" key={row.label}>
                <div className="stat-row__head">
                  <span>{fixture.home.shortName} {homeValue}</span>
                  <strong>{row.label}</strong>
                  <span>{awayValue} {fixture.away.shortName}</span>
                </div>
                <div className="stat-row__bar" aria-hidden="true">
                  <div className="stat-row__bar-home" style={{ width: `${homeShare}%` }} />
                  <div className="stat-row__bar-away" style={{ width: `${awayShare}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="skeleton skeleton--medium" />
      )}
    </div>
  );
}

type EvidenceDrawerProps = {
  story: StoryCard | null;
  evidence: MatchEvent[];
  players: Map<string, Player>;
  coverage: number;
};

function EvidenceDrawer({ story, evidence, players, coverage }: EvidenceDrawerProps) {
  return (
    <div className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Evidence drawer</span>
          <h2>{story ? story.title : "Select a story card"}</h2>
        </div>
        <span className="tag">Structural coverage {Math.round(coverage)}%</span>
      </div>
      {story ? (
        <div className="evidence-drawer">
          {evidence.length > 0 ? (
            evidence
              .slice()
              .sort((a, b) => eventSecond(a) - eventSecond(b))
              .map((event) => {
                const player = players.get(event.playerId);
                return (
                  <article key={event.id} className="evidence-item">
                    <div className="evidence-item__meta">
                      <span>{formatClock(eventSecond(event))}</span>
                      <span>{labelize(event.type)}</span>
                      <span>rev {event.revision}</span>
                    </div>
                    <strong>{player?.name ?? "Unknown player"}</strong>
                    <p>{outcomeLabel(event)} · {event.teamId === "home" ? "home" : "away"} phase</p>
                    <div className="evidence-item__footer">
                      <span>({event.x.toFixed(1)}, {event.y.toFixed(1)})</span>
                      <span>{structuralLabel(story)}</span>
                    </div>
                  </article>
                );
              })
          ) : (
            <div className="empty-state">No linked evidence is available for this story window yet.</div>
          )}
        </div>
      ) : (
        <div className="empty-state">Click a story rail card to inspect its timestamps, players, revisions, and coordinates.</div>
      )}
    </div>
  );
}

type NarrativePanelProps = {
  narrative: NarrativeResponse | null;
  error: string | null;
  loading: boolean;
  onCurrentRecap: () => void;
  onFulltimeRecap: () => void;
  onCopy: () => void;
  copyMessage: string | null;
  aiReady: boolean;
};

function NarrativePanel({
  narrative,
  error,
  loading,
  onCurrentRecap,
  onFulltimeRecap,
  onCopy,
  copyMessage,
  aiReady
}: NarrativePanelProps) {
  return (
    <div className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Storytelling</span>
          <h2>Editorial narration</h2>
        </div>
      </div>
      <div className="story-preview__actions">
        <button type="button" className="button button--primary" onClick={onCurrentRecap} disabled={!aiReady || loading}>
          Generate recap now
        </button>
        <button type="button" className="button" onClick={onFulltimeRecap} disabled={!aiReady || loading}>
          Generate full-time recap
        </button>
      </div>
      {!aiReady && <div className="banner banner--info">AI narration is not configured on the server. Analysis remains available.</div>}
      {loading && <div className="skeleton skeleton--tall" />}
      {error && <div className="banner banner--danger">{error}</div>}
      {narrative && !loading && (
        <div className="narrative-panel">
          <div className="narrative-panel__top">
            <div>
              <h3>{narrative.title}</h3>
              <p>{narrative.script}</p>
            </div>
            <button type="button" className="button button--ghost" onClick={onCopy}>
              Copy recap
            </button>
          </div>
          {copyMessage && <div className="banner banner--info">{copyMessage}</div>}
          <div className="claim-list">
            {narrative.claims.map((claim, index) => (
              <article className="claim" key={`${claim.text}-${index}`}>
                <p>{claim.text}</p>
                <span>{claim.evidenceIds.length} linked evidence IDs</span>
              </article>
            ))}
          </div>
          <div className="trace-panel">
            <div className="trace-panel__summary">
              <span>Source {narrative.source}</span>
              <span>{narrative.model}</span>
              <span>{narrative.cached ? "cached" : "fresh"}</span>
              <span>{narrative.latencyMs} ms</span>
            </div>
            <div className="trace-grid">
              {narrative.trace.map((step, index) => (
                <div className="trace-step" key={`${step.role}-${index}`}>
                  <strong>{step.role}</strong>
                  <span>{step.durationMs} ms</span>
                  <p>{step.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light")
  );
  const [health, setHealth] = useState<AsyncState<AppHealth>>({ data: null, loading: true, error: null });
  const [fixtures, setFixtures] = useState<AsyncState<FixtureSummary[]>>({ data: null, loading: true, error: null });
  const [fixture, setFixture] = useState<AsyncState<MatchFixture>>({ data: null, loading: false, error: null });
  const [snapshot, setSnapshot] = useState<AsyncState<MatchSnapshot>>({ data: null, loading: false, error: null });
  const [narrative, setNarrative] = useState<AsyncState<NarrativeResponse>>({ data: null, loading: false, error: null });
  const [replay, setReplay] = useState<ReplayState>(() => makeInitialReplayState());
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [narrativeNotice, setNarrativeNotice] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queuedNarration, setQueuedNarration] = useState<QueuedNarration | null>(null);

  const analyzeAbortRef = useRef<AbortController | null>(null);
  const narrativeAbortRef = useRef<AbortController | null>(null);
  const fixtureAbortRef = useRef<AbortController | null>(null);
  const analyzeSequence = useRef(0);
  const narrativeSequence = useRef(0);
  const fixtureSequence = useRef(0);
  const replayKey = JSON.stringify(replay);
  const replayKeyRef = useRef(replayKey);
  replayKeyRef.current = replayKey;

  useEffect(() => {
    narrativeAbortRef.current?.abort();
    narrativeSequence.current += 1;
    setNarrative({ data: null, loading: false, error: null });
    setCopyMessage(null);
  }, [replayKey]);

  const activeFixture = fixture.data;
  const fixtureList = fixtures.data ?? [];
  const playerMap = useMemo(() => {
    const map = new Map<string, Player>();
    if (!activeFixture) {
      return map;
    }
    [...activeFixture.home.players, ...activeFixture.away.players].forEach((player) => {
      map.set(player.id, player);
    });
    return map;
  }, [activeFixture]);

  const selectedStory = useMemo(() => {
    if (!snapshot.data || !selectedStoryId) {
      return snapshot.data?.stories[0] ?? null;
    }
    return snapshot.data.stories.find((story) => story.id === selectedStoryId) ?? snapshot.data.stories[0] ?? null;
  }, [selectedStoryId, snapshot.data]);

  const selectedEvidence = useMemo(() => {
    if (!selectedStory || !snapshot.data) {
      return [] as MatchEvent[];
    }
    return selectedStory.evidenceIds
      .map((id) => snapshot.data?.evidence[id])
      .filter((event): event is MatchEvent => Boolean(event));
  }, [selectedStory, snapshot.data]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const abortController = new AbortController();
    setHealth({ data: null, loading: true, error: null });
    setFixtures({ data: null, loading: true, error: null });

    void requestJson<AppHealth>("/api/health", { signal: abortController.signal })
      .then((data) => setHealth({ data, loading: false, error: null }))
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }
        setHealth({ data: null, loading: false, error: getErrorMessage(error) });
      });

    void requestJson<FixtureSummary[]>("/api/fixtures", { signal: abortController.signal })
      .then((data) => {
        setFixtures({ data, loading: false, error: null });
        if (data.length > 0) {
          setReplay((current) => ({
            ...current,
            fixtureId: current.fixtureId || data[0].id
          }));
        }
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }
        setFixtures({ data: null, loading: false, error: getErrorMessage(error) });
      });

    return () => abortController.abort();
  }, []);

  useEffect(() => {
    if (!replay.fixtureId) {
      return;
    }
    fixtureAbortRef.current?.abort();
    const controller = new AbortController();
    fixtureAbortRef.current = controller;
    const sequence = ++fixtureSequence.current;
    setFixture({ data: null, loading: true, error: null });
    setSnapshot({ data: null, loading: false, error: null });
    setNarrative({ data: null, loading: false, error: null });
    setNarrativeNotice(null);
    setSelectedStoryId(null);
    setIsPlaying(false);

    void requestJson<MatchFixture>(`/api/fixtures/${replay.fixtureId}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted || sequence !== fixtureSequence.current) {
          return;
        }
        setFixture({ data, loading: false, error: null });
        setReplay((current) => {
          const allPlayers = [...data.home.players, ...data.away.players];
          const favoritePlayerId = current.favoritePlayerId && allPlayers.some((player) => player.id === current.favoritePlayerId)
            ? current.favoritePlayerId
            : (allPlayers.find((player) => player.position === "ST") ?? allPlayers[0])?.id;
          return {
            ...current,
            fixtureId: data.id,
            atSecond: defaultFixtureSecond(data.durationSeconds),
            correction: false,
            favoritePlayerId
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence !== fixtureSequence.current) {
          return;
        }
        setFixture({ data: null, loading: false, error: getErrorMessage(error) });
      });

    return () => controller.abort();
  }, [replay.fixtureId]);

  useEffect(() => {
    if (!activeFixture) {
      return;
    }
    if (replay.favoritePlayerId && playerMap.has(replay.favoritePlayerId)) {
      return;
    }
    const roster = [...activeFixture.home.players, ...activeFixture.away.players];
    const nextFavorite = (roster.find((player) => player.position === "ST") ?? roster[0])?.id;
    if (!nextFavorite) {
      return;
    }
    setReplay((current) => ({ ...current, favoritePlayerId: nextFavorite }));
  }, [activeFixture, playerMap, replay.favoritePlayerId]);

  useEffect(() => {
    if (!activeFixture) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      analyzeAbortRef.current?.abort();
      const controller = new AbortController();
      analyzeAbortRef.current = controller;
      const sequence = ++analyzeSequence.current;
      setSnapshot((current) => ({ ...current, loading: true, error: null }));

      const payload: AnalysisRequest = {
        fixtureId: activeFixture.id,
        atSecond: Math.round(clamp(replay.atSecond, 0, activeFixture.durationSeconds)),
        persona: replay.persona,
        language: replay.language,
        correction: replay.correction,
        favoritePlayerId: replay.persona === "player" ? replay.favoritePlayerId : undefined
      };

      void requestJson<MatchSnapshot>("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
        .then((data) => {
          if (controller.signal.aborted || sequence !== analyzeSequence.current) {
            return;
          }
          setSnapshot({ data, loading: false, error: null });
          setSelectedStoryId((current) =>
            current && data.stories.some((story) => story.id === current) ? current : (data.stories[0]?.id ?? null)
          );
          setNarrative((current) => {
            if (current.data && current.data.stateVersion !== data.stateVersion) {
              setNarrativeNotice("Narrative cleared because the live state changed.");
              return { data: null, loading: false, error: null };
            }
            return current;
          });
          if (queuedNarration && queuedNarration.atSecond === data.atSecond) {
            setQueuedNarration(null);
            void handleNarrationRequest("recap", undefined, data.atSecond);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || sequence !== analyzeSequence.current) {
            return;
          }
          setSnapshot((current) => ({ data: current.data, loading: false, error: getErrorMessage(error) }));
        });
    }, ANALYSIS_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
      analyzeAbortRef.current?.abort();
      analyzeSequence.current += 1;
    };
  }, [activeFixture, queuedNarration, replay.atSecond, replay.correction, replay.favoritePlayerId, replay.language, replay.persona]);

  useEffect(() => {
    if (!isPlaying || !activeFixture) {
      return;
    }
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const timestamp = performance.now();
      const elapsedSeconds = (timestamp - lastTick) / 1000;
      lastTick = timestamp;
      setReplay((current) => {
        const nextAtSecond = clamp(current.atSecond + elapsedSeconds * SIMULATION_SPEED, 0, activeFixture.durationSeconds);
        if (nextAtSecond >= activeFixture.durationSeconds) {
          setIsPlaying(false);
        }
        return { ...current, atSecond: nextAtSecond };
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [activeFixture, isPlaying]);

  useEffect(() => () => {
    analyzeAbortRef.current?.abort();
    narrativeAbortRef.current?.abort();
    fixtureAbortRef.current?.abort();
  }, []);

  async function handleNarrationRequest(format: "story" | "recap", storyId?: string, overrideSecond?: number) {
    if (!activeFixture) {
      return;
    }
    if (!health.data?.ai.configured) {
      setNarrative({ data: null, loading: false, error: "AI narration is unavailable for this environment." });
      return;
    }
    setIsPlaying(false);
    const requestReplayKey = replayKeyRef.current;

    narrativeAbortRef.current?.abort();
    const controller = new AbortController();
    narrativeAbortRef.current = controller;
    const sequence = ++narrativeSequence.current;
    setNarrative((current) => ({ data: current.data, loading: true, error: null }));
    setNarrativeNotice(null);

    const payload: NarrativeRequest = {
      fixtureId: activeFixture.id,
      atSecond: Math.round(overrideSecond ?? replay.atSecond),
      persona: replay.persona,
      language: replay.language,
      correction: replay.correction,
      favoritePlayerId: replay.persona === "player" ? replay.favoritePlayerId : undefined,
      format,
      storyId
    };

    try {
      const data = await requestJson<NarrativeResponse>("/api/narrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (controller.signal.aborted || sequence !== narrativeSequence.current || requestReplayKey !== replayKeyRef.current) {
        return;
      }
      setNarrative({ data, loading: false, error: null });
    } catch (error: unknown) {
      if (controller.signal.aborted || sequence !== narrativeSequence.current) {
        return;
      }
      setNarrative((current) => ({ data: current.data, loading: false, error: getErrorMessage(error) }));
    }
  }

  function handleFixtureSelect(fixtureId: string) {
    setReplay((current) => ({ ...current, fixtureId }));
  }

  function handleReset() {
    if (!activeFixture) {
      return;
    }
    setIsPlaying(false);
    narrativeAbortRef.current?.abort();
    narrativeSequence.current += 1;
    setQueuedNarration(null);
    setNarrative({ data: null, loading: false, error: null });
    setNarrativeNotice(null);
    setReplay((current) => ({
      ...current,
      atSecond: defaultFixtureSecond(activeFixture.durationSeconds),
      correction: false
    }));
  }

  function handleJumpToTurningPoint() {
    if (!snapshot.data) {
      return;
    }
    const turningPoint = snapshot.data.stories.find((story) => story.kind === "turning_point") ?? snapshot.data.stories[0];
    if (!turningPoint) {
      return;
    }
    setIsPlaying(false);
    setSelectedStoryId(turningPoint.id);
    const latestPivot = turningPoint.evidenceIds
      .map((id) => snapshot.data?.evidence[id])
      .filter((event): event is MatchEvent => Boolean(event && (event.type === "goal" || event.type === "red_card")))
      .sort((a, b) => eventSecond(b) - eventSecond(a))[0];
    setReplay((current) => ({ ...current, atSecond: latestPivot ? eventSecond(latestPivot) : turningPoint.windowEnd }));
  }

  function handleFullTime() {
    if (!activeFixture) {
      return;
    }
    setIsPlaying(false);
    setReplay((current) => ({ ...current, atSecond: activeFixture.durationSeconds }));
  }

  function handleCorrection() {
    setReplay((current) => {
      if (!activeFixture || current.atSecond < activeFixture.correctionAvailableAt) {
        return current;
      }
      const nextCorrection = !current.correction;
      setNarrative({ data: null, loading: false, error: null });
      setNarrativeNotice(nextCorrection ? "Narrative cleared after the correction altered the match record." : null);
      return { ...current, correction: nextCorrection };
    });
  }

  async function handleExportOverlay() {
    if (!selectedStory || !snapshot.data) {
      return;
    }
    const payload = {
      fixtureId: snapshot.data.fixtureId,
      storyId: selectedStory.id,
      title: selectedStory.title,
      summary: selectedStory.summary,
      whyItMatters: selectedStory.whyItMatters,
      language: snapshot.data.language,
      persona: snapshot.data.persona,
      stateVersion: snapshot.data.stateVersion,
      start: selectedStory.windowStart,
      end: selectedStory.windowEnd,
      evidenceIds: selectedStory.evidenceIds
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${snapshot.data.fixtureId}-${selectedStory.id}-overlay.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopyRecap() {
    if (!narrative.data) {
      return;
    }
    try {
      await navigator.clipboard.writeText(narrative.data.script);
      setCopyMessage("Recap copied to clipboard.");
    } catch (error: unknown) {
      setCopyMessage(`Clipboard copy failed: ${getErrorMessage(error)}`);
    }
  }

  const scoreByFixtureId = useMemo(() => {
    const map = new Map<string, { home: number; away: number }>();
    if (snapshot.data) {
      map.set(snapshot.data.fixtureId, snapshot.data.score);
    }
    return map;
  }, [snapshot.data]);

  const correctionAvailable = Boolean(activeFixture && replay.atSecond >= activeFixture.correctionAvailableAt);

  return (
    <div className="app-shell">
      <header className="hero panel">
        <div className="hero__content">
          <BrandMark />
          <div className="hero__copy">
            <span className="eyebrow">Synthetic editorial match intelligence</span>
            <h1>The story behind the score</h1>
            <p>
              MatchLens turns original synthetic event streams into broadcast-ready live context, evidence drawers,
              and adaptive narration without guessing beyond the feed.
            </p>
          </div>
        </div>
        <div className="hero__status">
          <span className="tag tag--accent">Synthetic match feed</span>
          {health.data ? <span className="tag">version {health.data.version}</span> : <span className="tag">connecting…</span>}
          <button type="button" className="button button--ghost" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
            Theme: {theme}
          </button>
        </div>
        <div className="scenario-grid">
          {fixtureList.map((item) => (
            <ScenarioCard
              key={item.id}
              fixture={item}
              selected={item.id === replay.fixtureId}
              score={scoreByFixtureId.get(item.id)}
              onSelect={() => handleFixtureSelect(item.id)}
            />
          ))}
        </div>
      </header>

      {health.error && <div className="banner banner--danger">{health.error}</div>}
      {fixtures.error && <div className="banner banner--danger">{fixtures.error}</div>}
      {health.data && !health.data.ai.configured && (
        <div className="banner banner--info">
          AI narration is turned off on the server. Live analysis, evidence, and replay controls remain available.
        </div>
      )}
      {narrativeNotice && <div className="banner banner--warning">{narrativeNotice}</div>}
      {snapshot.error && <div className="banner banner--danger">Analysis error: {snapshot.error}</div>}
      {fixture.error && <div className="banner banner--danger">Fixture error: {fixture.error}</div>}

      <main className="main-grid">
        <section className="column column--left">
          <div className="panel">
            <div className="panel__header">
              <div>
                <span className="eyebrow">Match control</span>
                <h2>{activeFixture?.title ?? "Loading scenarios"}</h2>
              </div>
              {snapshot.data ? (
                <div className="scorebug" aria-label="Live score">
                  <span>{activeFixture?.home.shortName}</span>
                  <strong>{snapshot.data.score.home}–{snapshot.data.score.away}</strong>
                  <span>{activeFixture?.away.shortName}</span>
                </div>
              ) : (
                <div className="scorebug scorebug--idle">score pending</div>
              )}
            </div>
            {activeFixture ? (
              <>
                <p className="lede">{activeFixture.description}</p>
                <div className="control-grid">
                  <label className="field">
                    <span>Persona</span>
                    <div className="segmented" role="tablist" aria-label="Persona">
                      {(["analyst", "casual", "player"] as const).map((persona) => (
                        <button
                          key={persona}
                          type="button"
                          className={`segmented__item${replay.persona === persona ? " is-active" : ""}`}
                          onClick={() => setReplay((current) => ({ ...current, persona }))}
                        >
                          {persona}
                        </button>
                      ))}
                    </div>
                  </label>
                  <label className="field">
                    <span>Story language</span>
                    <select
                      value={replay.language}
                      onChange={(event) =>
                        setReplay((current) => ({ ...current, language: event.target.value as Language }))
                      }
                    >
                      <option value="en">English</option>
                      <option value="es">Español</option>
                      <option value="fr">Français</option>
                    </select>
                  </label>
                  {replay.persona === "player" && (
                    <label className="field">
                      <span>Favorite player</span>
                      <select
                        value={replay.favoritePlayerId}
                        onChange={(event) =>
                          setReplay((current) => ({ ...current, favoritePlayerId: event.target.value }))
                        }
                      >
                        {[...activeFixture.home.players, ...activeFixture.away.players].map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.name} · {player.teamId === "home" ? activeFixture.home.shortName : activeFixture.away.shortName}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="timeline-card">
                  <div className="timeline-card__head">
                    <span className="eyebrow">Replay state</span>
                    <strong>{formatClock(replay.atSecond)}</strong>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={activeFixture.durationSeconds}
                    step={1}
                    value={Math.round(replay.atSecond)}
                    onChange={(event) => {
                      setIsPlaying(false);
                      setReplay((current) => ({ ...current, atSecond: Number(event.target.value) }));
                    }}
                    aria-label="Timeline scrubber"
                  />
                  <div className="timeline-card__labels">
                    <span>0'</span>
                    <span>{formatMinuteLabel(activeFixture.correctionAvailableAt)} correction unlock</span>
                    <span>90'</span>
                  </div>
                  <div className="control-row">
                    <button type="button" className="button button--primary" onClick={() => setIsPlaying((current) => !current)}>
                      {isPlaying ? "Pause" : `Play ${SIMULATION_SPEED}×`}
                    </button>
                    <button type="button" className="button" onClick={handleJumpToTurningPoint} disabled={!snapshot.data}>
                      Jump to turning point
                    </button>
                    <button type="button" className="button" onClick={handleFullTime} disabled={!activeFixture}>
                      Full time
                    </button>
                    <button type="button" className="button" onClick={handleReset} disabled={!activeFixture}>
                      Reset
                    </button>
                  </div>
                  <div className="control-row">
                    <button
                      type="button"
                      className="button"
                      onClick={handleCorrection}
                      disabled={!correctionAvailable}
                    >
                      {replay.correction ? "Retract correction" : "Apply goal correction"}
                    </button>
                    <span className={`tag${replay.correction ? " tag--accent" : ""}`}>
                      {replay.correction ? "Correction active" : correctionAvailable ? "Correction ready" : "Correction locked"}
                    </span>
                  </div>
                </div>
                {replay.correction && (
                  <div className="banner banner--warning">
                    Retraction notice active. Storytelling is cleared until a fresh live state is analyzed.
                  </div>
                )}
              </>
            ) : (
              <div className="skeleton skeleton--tall" />
            )}
          </div>

          <div className="panel">
            <div className="panel__header">
              <div>
                <span className="eyebrow">Live event feed</span>
                <h2>Recent ingested actions</h2>
              </div>
              {snapshot.loading && <span className="tag">refreshing…</span>}
            </div>
            {snapshot.data ? (
              <div className="feed" role="region" aria-label="Recent match events" tabIndex={0}>
                {snapshot.data.recentEvents
                  .slice()
                  .reverse()
                  .map((event) => {
                    const player = playerMap.get(event.playerId);
                    return (
                      <article className="feed-item" key={`${event.id}-${event.revision}`}>
                        <div className="feed-item__line">
                          <span className="feed-item__time">{formatClock(eventSecond(event))}</span>
                          <span className="feed-item__type">{labelize(event.type)}</span>
                        </div>
                        <strong>{player?.name ?? "Unknown player"}</strong>
                        <p>{outcomeLabel(event)} · {event.teamId === "home" ? activeFixture?.home.name : activeFixture?.away.name}</p>
                      </article>
                    );
                  })}
              </div>
            ) : snapshot.loading || fixture.loading || fixtures.loading ? (
              <div className="skeleton skeleton--feed" />
            ) : (
              <div className="empty-state">Select a scenario to begin the live feed.</div>
            )}
          </div>
        </section>

        <section className="column column--center">
          {activeFixture ? (
            <>
              <Pitch fixture={activeFixture} snapshot={snapshot.data} selectedStory={selectedStory} />
              <StoryPreview
                snapshot={snapshot.data}
                selectedStory={selectedStory}
                onNarrate={() => void handleNarrationRequest("story", selectedStory?.id)}
                onExport={() => void handleExportOverlay()}
                narrationDisabled={!selectedStory || snapshot.loading || narrative.loading || !health.data?.ai.configured}
              />
              <RollingStats fixture={activeFixture} snapshot={snapshot.data} />
              <NarrativePanel
                narrative={narrative.data}
                error={narrative.error}
                loading={narrative.loading}
                onCurrentRecap={() => void handleNarrationRequest("recap")}
                onFulltimeRecap={() => {
                  if (!activeFixture) {
                    return;
                  }
                  setIsPlaying(false);
                  setQueuedNarration({ format: "recap", atSecond: activeFixture.durationSeconds });
                  setReplay((current) => ({ ...current, atSecond: activeFixture.durationSeconds }));
                }}
                onCopy={() => void handleCopyRecap()}
                copyMessage={copyMessage}
                aiReady={Boolean(health.data?.ai.configured)}
              />
            </>
          ) : (
            <div className="panel">
              <div className="skeleton skeleton--tall" />
            </div>
          )}
        </section>

        <section className="column column--right">
          <div className="panel">
            <div className="panel__header">
              <div>
                <span className="eyebrow">Story rail</span>
                <h2>Clickable editorial angles</h2>
              </div>
              {snapshot.data && <span className="tag">{snapshot.data.stories.length} live angles</span>}
            </div>
            {snapshot.data ? (
              <div className="story-rail">
                {snapshot.data.stories.map((story) => (
                  <button
                    type="button"
                    key={story.id}
                    className={`story-card${selectedStory?.id === story.id ? " is-active" : ""}`}
                    onClick={() => setSelectedStoryId(story.id)}
                    aria-pressed={selectedStory?.id === story.id}
                  >
                    <div className="story-card__meta">
                      <span>{labelize(story.kind)}</span>
                      <span>{formatMinuteLabel(story.windowStart)}–{formatMinuteLabel(story.windowEnd)}</span>
                    </div>
                    <h3>{story.title}</h3>
                    <p>{story.summary}</p>
                    <div className="story-card__footer">
                      <span>{story.evidenceIds.length} evidence links</span>
                      <span>{structuralLabel(story)}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : snapshot.loading ? (
              <div className="skeleton skeleton--story-rail" />
            ) : (
              <div className="empty-state">Analysis stories will appear once the replay state resolves.</div>
            )}
          </div>
          <EvidenceDrawer
            story={selectedStory}
            evidence={selectedEvidence}
            players={playerMap}
            coverage={snapshot.data?.evidenceCoverage ?? 0}
          />
        </section>
      </main>
    </div>
  );
}
