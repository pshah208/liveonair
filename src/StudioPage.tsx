import { useEffect, useMemo, useRef, useState } from "react";
import type { AppHealth, FixtureSummary, Language, MatchFixture, MatchSnapshot, NarrativeResponse } from "../shared/types.js";
import type { ArchiveSummary, LiveStatus, RecapStoryboard, ReviewStorylineRequest, ScenarioKind, Storyline, VerifiedFact } from "../shared/platform.js";
import { api } from "./api.js";
import { BroadcastBar, EventFeed, FactTicker, LiveStats, MatchIntelligence, OverlayPreview, Panel, Pitch, RecapPanel, Storyboard, StorylineQueue } from "./components.js";
import { HighlightReelPanel } from "./HighlightReel.js";
import { useLiveStream } from "./hooks/useLiveStream.js";
import { InfrastructurePanel, type DeskHealth } from "./InfrastructurePanel.js";
import { VideoLab, type VideoFootage } from "./VideoLab.js";
import { LabHighlightReel, type LabHighlights } from "./LabHighlightReel.js";
import { PlayerAnalysisPage } from "./PlayerAnalysis.js";
import { PlayerCam } from "./PlayerCam.js";
import { LiveVideoPanel } from "./LiveVideoPanel.js";
import type { ProgressiveVideoSession } from "../shared/progressiveVideo.js";
import {
  clamp,
  computeScoreFromEvents,
  downloadJson,
  getErrorMessage,
  labelize,
  LANGUAGE_LABEL,
  LANGUAGES,
  liveTransportLabel,
  mergeById,
  SCENARIOS,
  sortFactsNewestFirst,
  sortStudioStorylines,
  type Theme
} from "./utils.js";

type Tab = "live" | "players" | "recap" | "video" | "player";
type StartMode = "fixture" | "matchlab";

type StudioPageProps = { theme: Theme; infraOpen: boolean; onToggleInfra: () => void };

export function StudioPage({ theme, infraOpen, onToggleInfra }: StudioPageProps) {
  const [tab, setTab] = useState<Tab>("live");
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [desk, setDesk] = useState<DeskHealth | null>(null);
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [archive, setArchive] = useState<ArchiveSummary | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [fixture, setFixture] = useState<MatchFixture | null>(null);
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [storylines, setStorylines] = useState<Storyline[]>([]);
  const [facts, setFacts] = useState<VerifiedFact[]>([]);
  const [storyboard, setStoryboard] = useState<RecapStoryboard | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const [startMode, setStartMode] = useState<StartMode>("fixture");
  const [fixtureId, setFixtureId] = useState("");
  const [scenario, setScenario] = useState<ScenarioKind>("comeback");
  const [seed, setSeed] = useState(2025);
  const [homeClubId, setHomeClubId] = useState("");
  const [awayClubId, setAwayClubId] = useState("");
  const [speed, setSpeed] = useState(30);
  const [submitting, setSubmitting] = useState(false);
  const [labHighlights, setLabHighlights] = useState<LabHighlights | null>(null);
  const [progressiveFootage, setProgressiveFootage] = useState<VideoFootage | null>(null);
  const [progressiveSession, setProgressiveSession] = useState<ProgressiveVideoSession | null>(null);

  const [deskLanguage, setDeskLanguage] = useState<Language>("en");
  const [selectedStorylineId, setSelectedStorylineId] = useState<string | null>(null);
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [pendingById, setPendingById] = useState<Record<string, boolean>>({});
  const [reviewErrorById, setReviewErrorById] = useState<Record<string, string | undefined>>({});

  const [recapLanguage, setRecapLanguage] = useState<Language>("en");
  const [narrative, setNarrative] = useState<NarrativeResponse | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [narrativeError, setNarrativeError] = useState<string | null>(null);

  const matchIdRef = useRef<string | undefined>(undefined);
  const lastFixtureFetch = useRef(0);
  const fixtureTimer = useRef<number | null>(null);

  // ---------------------------------------------------------------- data loading

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.allSettled([
      api.getHealth(signal).then(setHealth),
      api.getStudioHealth(signal).then(setDesk),
      api.getFixtures(signal).then((list) => { setFixtures(list ?? []); setFixtureId((current) => current || list?.[0]?.id || ""); }),
      api.getArchiveSummary(signal).then(setArchive),
      api.getLiveStatus(signal).then((data) => { if (data) { matchIdRef.current = data.matchId; setStatus(data); } }),
      api.getLiveFixture(signal).then(setFixture),
      api.getStudioStorylines(signal).then((list) => setStorylines(sortStudioStorylines(list ?? []))),
      api.getStudioFacts(signal).then((list) => setFacts(sortFactsNewestFirst(list ?? []))),
      api.getStudioStoryboard(signal).then(setStoryboard)
    ]).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed && failed.status === "rejected" && !signal.aborted) setPageError(getErrorMessage(failed.reason));
    });
    return () => controller.abort();
  }, []);

  function resetMatchState() {
    setStorylines([]);
    setFacts([]);
    setStoryboard(null);
    setSnapshot(null);
    setNarrative(null);
    setSelectedStorylineId(null);
    setSelectedInsightId(null);
  }

  function adoptStatus(next: LiveStatus) {
    if (next.matchId && matchIdRef.current && next.matchId !== matchIdRef.current) resetMatchState();
    if (next.matchId) matchIdRef.current = next.matchId;
    setStatus(next);
  }

  // Snapshots arrive several times a second; fetch the full fixture at most every 1.5 s.
  function refreshFixture() {
    const wait = 1_500 - (Date.now() - lastFixtureFetch.current);
    if (fixtureTimer.current !== null) return;
    fixtureTimer.current = window.setTimeout(() => {
      fixtureTimer.current = null;
      lastFixtureFetch.current = Date.now();
      void api.getLiveFixture().then(setFixture).catch(() => undefined);
    }, Math.max(0, wait));
  }

  async function refreshStoryboard() {
    try { setStoryboard(await api.getStudioStoryboard()); } catch { /* storyboard is optional */ }
  }

  useLiveStream({
    enabled: true,
    role: "studio",
    persona: "analyst",
    language: "en",
    onMessage: (message) => {
      if (message.type === "status") {
        adoptStatus(message.status);
        refreshFixture();
        if (message.status.state === "finished") void refreshStoryboard();
        return;
      }
      if (message.type === "snapshot") {
        adoptStatus(message.status);
        setSnapshot(message.snapshot);
        refreshFixture();
        return;
      }
      if (message.type === "storyline") {
        if (matchIdRef.current && message.storyline.matchId !== matchIdRef.current) return;
        setStorylines((current) => sortStudioStorylines(mergeById(current, message.storyline)));
        return;
      }
      if (message.type === "fact") {
        if (matchIdRef.current && message.fact.matchId !== matchIdRef.current) return;
        setFacts((current) => sortFactsNewestFirst(mergeById(current, message.fact)));
      }
    }
  });

  useEffect(() => () => { if (fixtureTimer.current !== null) window.clearTimeout(fixtureTimer.current); }, []);

  useEffect(() => {
    if (tab === "recap") void refreshStoryboard();
  }, [tab]);

  // ---------------------------------------------------------------- actions

  async function handleStart() {
    setSubmitting(true);
    setPageError(null);
    try {
      const next = await api.startLive({
        fixtureId: startMode === "fixture" ? fixtureId : undefined,
        generate: startMode === "matchlab" ? { scenario, seed, homeClubId: homeClubId || undefined, awayClubId: awayClubId || undefined } : undefined,
        speed: clamp(speed, 1, 60)
      });
      resetMatchState();
      if (next) { matchIdRef.current = next.matchId; setStatus(next); }
      setFixture(await api.getLiveFixture());
      setTab("live");
    } catch (error: unknown) {
      setPageError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVideoStreamed(next: LiveStatus) {
    resetMatchState();
    matchIdRef.current = next.matchId;
    setStatus(next);
    try { setFixture(await api.getLiveFixture()); } catch { /* the stream refreshes it */ }
  }

  async function handleStop() {
    setSubmitting(true);
    try {
      const ownProgressive = progressiveSession && status?.fixtureId === progressiveSession.fixtureId;
      const stopped = ownProgressive ? await api.stopProgressiveVideo(progressiveSession.id) : null;
      if (stopped) setProgressiveSession(stopped);
      const next = ownProgressive ? stopped?.live : await api.stopLive();
      if (next && next.matchId === matchIdRef.current) setStatus(next);
      setFixture(await api.getLiveFixture());
      void refreshStoryboard();
    } catch (error: unknown) {
      setPageError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCorrection(eventId: string) {
    setCorrectingId(eventId);
    try {
      const next = await api.sendCorrection(eventId);
      if (next) setStatus(next);
      setFixture(await api.getLiveFixture());
    } catch (error: unknown) {
      setPageError(getErrorMessage(error));
    } finally {
      setCorrectingId(null);
    }
  }

  async function handleReview(id: string, request: ReviewStorylineRequest) {
    setPendingById((current) => ({ ...current, [id]: true }));
    setReviewErrorById((current) => ({ ...current, [id]: undefined }));
    try {
      const updated = await api.reviewStoryline(id, request);
      if (updated) {
        setStorylines((current) => sortStudioStorylines(mergeById(current, updated)));
        if (updated.status === "approved") setSelectedStorylineId(updated.id);
      }
    } catch (error: unknown) {
      setReviewErrorById((current) => ({ ...current, [id]: getErrorMessage(error) }));
    } finally {
      setPendingById((current) => ({ ...current, [id]: false }));
    }
  }

  async function handleNarrate() {
    setNarrativeLoading(true);
    setNarrativeError(null);
    try {
      setNarrative(await api.narrateLive({ persona: "analyst", language: recapLanguage }));
    } catch (error: unknown) {
      setNarrativeError(getErrorMessage(error));
    } finally {
      setNarrativeLoading(false);
    }
  }

  // ---------------------------------------------------------------- derived

  const progressiveForMatch = progressiveSession?.fixtureId === status?.fixtureId ? progressiveSession : null;
  const state = progressiveForMatch && progressiveForMatch.stage !== "complete" && status?.state === "finished" ? "idle" : status?.state ?? "idle";
  const analyzedSecond = progressiveForMatch?.analyzedThrough ?? status?.clockSecond ?? 0;
  const recapFootage = progressiveFootage?.fixtureId === fixture?.id ? progressiveFootage : null;
  const score = snapshot?.score ?? computeScoreFromEvents(fixture);
  const approved = useMemo(() => storylines.filter((storyline) => storyline.status === "approved"), [storylines]);
  const onAir = approved.find((storyline) => storyline.id === selectedStorylineId) ?? approved[0] ?? null;
  const counts = {
    review: storylines.filter((storyline) => storyline.status === "needs_review").length,
    onAir: approved.length
  };
  const selectedInsight = snapshot?.stories.find((story) => story.id === selectedInsightId) ?? null;
  const transport = status ? liveTransportLabel(status) : "Connecting";

  return (
    <main className="page">
      <InfrastructurePanel open={infraOpen} onToggle={onToggleInfra} health={health} desk={desk} live={status} />

      {tab !== "video" && <BroadcastBar fixture={fixture} score={score} clockSecond={analyzedSecond} state={state} transport={transport} lagMs={status?.lagMs} eventsReceived={status?.eventsReceived ?? 0} />}
      {tab !== "video" && progressiveForMatch && <p className="banner banner--warning">Video analysis watermark · Clock, score and Live Desk stats reflect analyzed footage, not local playback. AI-detected / provisional, verify goals; replay filtering is not guaranteed.{progressiveForMatch.stage === "stopped" || progressiveForMatch.stage === "failed" ? " Analysis stopped early — not full time." : ""}</p>}

      <nav className="tabs" aria-label="Studio views">
        <button type="button" className={`tabs__item${tab === "live" ? " is-active" : ""}`} onClick={() => setTab("live")} aria-current={tab === "live" ? "page" : undefined}>
          Live desk {counts.review > 0 && <span className="count count--accent">{counts.review}</span>}
        </button>
        <button type="button" className={`tabs__item${tab === "players" ? " is-active" : ""}`} onClick={() => setTab("players")} aria-current={tab === "players" ? "page" : undefined}>
          Player analysis
        </button>
        <button type="button" className={`tabs__item${tab === "recap" ? " is-active" : ""}`} onClick={() => setTab("recap")} aria-current={tab === "recap" ? "page" : undefined}>
          Recap and highlights {labHighlights && <span className="count">Lab</span>}
        </button>
        <button type="button" className={`tabs__item${tab === "video" ? " is-active" : ""}`} onClick={() => setTab("video")} aria-current={tab === "video" ? "page" : undefined}>
          Video lab
        </button>
        <button type="button" className={`tabs__item${tab === "player" ? " is-active" : ""}`} onClick={() => setTab("player")} aria-current={tab === "player" ? "page" : undefined}>
          Player cam
        </button>
      </nav>

      {pageError && <div className="banner banner--danger" role="alert">{pageError} <button type="button" className="link-button" onClick={() => setPageError(null)}>Dismiss</button></div>}

      <div hidden={tab !== "live"}>
        <LiveVideoPanel status={status} onStreamed={(next) => void handleVideoStreamed(next)} onFootage={setProgressiveFootage}
          onSession={(next) => { if (next) setProgressiveSession(next); }}
          onFullUpload={() => {
            setTab("video");
            window.requestAnimationFrame(() => {
              const upload = document.getElementById("full-upload-video-lab");
              upload?.scrollIntoView({ behavior: "smooth" });
              upload?.focus({ preventScroll: true });
            });
          }} />
      </div>
      {/* Kept mounted so an uploaded clip and its job survive switching tabs. */}
      <div id="full-upload-video-lab" tabIndex={-1} hidden={tab !== "video"}>
        <VideoLab active={tab === "video"} onHighlights={(next) => { setLabHighlights(next); if (next) setTab("recap"); }} />
      </div>
      <div hidden={tab !== "player"}>
        <PlayerCam />
      </div>

      {tab === "players" && <PlayerAnalysisPage fixture={fixture} clockSecond={progressiveForMatch ? analyzedSecond : state === "running" ? status?.clockSecond ?? 0 : fixture?.durationSeconds ?? 0} aiReady={desk?.mode === "foundry-agents"} onOpenLiveDesk={() => setTab("live")} />}
      {tab === "recap" && labHighlights && <LabHighlightReel lab={labHighlights} theme={theme} onEdit={() => setTab("video")} onClose={() => setLabHighlights(null)} />}

      {tab === "video" || tab === "player" || tab === "players" ? null : tab === "live" ? (
        <div className="desk-grid">
          <div className="desk-col">
            <Panel eyebrow="Match feed" title={state === "running" ? "Match in progress" : "Start a match"}>
              {state === "running" ? (
                <div className="running-summary">
                  <p className="subtle-text">{fixture?.title} · {progressiveForMatch ? "Progressive video: analysis runs independently of local playback." : `${status?.speed}× speed.`} Events flow through {transport}; the agents pick up goals and big moments automatically.</p>
                  <button type="button" className="button" onClick={() => void handleStop()} disabled={submitting}>Stop match</button>
                </div>
              ) : (
                <div className="setup">
                  <div className="segmented" role="tablist" aria-label="Match source">
                    <button type="button" role="tab" aria-selected={startMode === "fixture"} className={`segmented__item${startMode === "fixture" ? " is-active" : ""}`} onClick={() => setStartMode("fixture")}>Scripted fixture</button>
                    <button type="button" role="tab" aria-selected={startMode === "matchlab"} className={`segmented__item${startMode === "matchlab" ? " is-active" : ""}`} onClick={() => setStartMode("matchlab")}>Generate with MatchLab</button>
                  </div>
                  {startMode === "fixture" ? (
                    <label className="field"><span>Fixture</span>
                      <select value={fixtureId} onChange={(event) => setFixtureId(event.target.value)}>{fixtures.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
                    </label>
                  ) : (
                    <div className="field-grid">
                      <label className="field"><span>Scenario</span><select value={scenario} onChange={(event) => setScenario(event.target.value as ScenarioKind)}>{SCENARIOS.map((item) => <option key={item} value={item}>{labelize(item)}</option>)}</select></label>
                      <label className="field"><span>Seed</span><input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
                      <label className="field"><span>Home club</span><select value={homeClubId} onChange={(event) => setHomeClubId(event.target.value)}><option value="">Auto</option>{(archive?.clubs ?? []).map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>
                      <label className="field"><span>Away club</span><select value={awayClubId} onChange={(event) => setAwayClubId(event.target.value)}><option value="">Auto</option>{(archive?.clubs ?? []).map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label>
                    </div>
                  )}
                  <label className="field"><span>Playback speed <span className="mono">{speed}×</span></span><input type="range" min={1} max={60} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
                  <button type="button" className="button button--primary button--block" onClick={() => void handleStart()} disabled={submitting || (startMode === "fixture" && !fixtureId)}>{state === "finished" ? "Start a new match" : "Start live match"}</button>
                  {state === "finished" && <button type="button" className="link-button" onClick={() => setTab("recap")}>Full time. Open the recap and highlights →</button>}
                </div>
              )}
            </Panel>
            <Panel eyebrow="Correction desk" title="Match events">
              {fixture ? <EventFeed fixture={fixture} onCorrect={state === "running" ? (id) => void handleCorrection(id) : undefined} correctingId={correctingId} /> : <div className="empty-state">Start a match to see the feed.</div>}
            </Panel>
          </div>

          <div className="desk-col">
            <Panel eyebrow="Live board" title={fixture?.title ?? "No match running"} aside={selectedInsight && <button type="button" className="link-button" onClick={() => setSelectedInsightId(null)}>Clear evidence</button>}>
              {fixture ? (
                <>
                  <Pitch fixture={fixture} events={snapshot?.recentEvents ?? fixture.events} highlightIds={selectedInsight?.evidenceIds} />
                  <LiveStats snapshot={snapshot} fixture={fixture} />
                </>
              ) : <div className="empty-state">The pitch, live stats and story cards appear once a match starts.</div>}
            </Panel>
            <Panel eyebrow="Deterministic engine" title="Match intelligence" aside={snapshot && <span className="tag">{Math.round(snapshot.evidenceCoverage)}% evidence coverage</span>}>
              <MatchIntelligence stories={snapshot?.stories ?? []} selectedId={selectedInsightId} onSelect={setSelectedInsightId} />
            </Panel>
          </div>

          <div className="desk-col">
            <Panel eyebrow="On air" title="Lower-third" aside={<label className="inline-select"><span className="sr-only">Desk language</span><select value={deskLanguage} onChange={(event) => setDeskLanguage(event.target.value as Language)}>{LANGUAGES.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>}>
              <OverlayPreview storyline={onAir} language={deskLanguage} onExport={() => onAir && downloadJson(`${onAir.matchId}-${onAir.id}-overlay.json`, { storylineId: onAir.id, matchId: onAir.matchId, minute: onAir.triggerMinute, headline: onAir.headline, overlay: onAir.overlay, onAirLine: onAir.onAirLine, claimSources: onAir.claims.flatMap((claim) => claim.sources), version: onAir.version })} />
            </Panel>
            <Panel eyebrow="Foundry agents" title="Storyline queue" aside={<>{counts.review > 0 && <span className="tag tag--accent">{counts.review} to review</span>}<span className="tag">{counts.onAir} on air</span></>}>
              {desk?.mode === "unconfigured" && <div className="banner banner--warning">Storyline agents aren't configured on this server.</div>}
              <StorylineQueue storylines={storylines} selectedId={onAir?.id ?? null} onSelect={setSelectedStorylineId} onReview={handleReview} pendingById={pendingById} errorById={reviewErrorById} language={deskLanguage} />
            </Panel>
            <Panel eyebrow="Fact desk" title="Verified facts" aside={<span className="tag">{facts.length}</span>}>
              <FactTicker facts={facts} language={deskLanguage} />
            </Panel>
          </div>
        </div>
      ) : fixture ? (
        <div className="recap-grid">
          <HighlightReelPanel fixture={fixture} storylines={storylines} uptoSecond={progressiveForMatch ? analyzedSecond : state === "running" ? status?.clockSecond ?? 0 : fixture.durationSeconds} theme={theme} footage={recapFootage} onOpenVideoLab={() => setTab("video")} />
          <div className="desk-col">
            <RecapPanel
              narrative={narrative}
              loading={narrativeLoading}
              error={narrativeError}
              aiReady={Boolean(health?.ai.configured)}
              disabled={!fixture}
              onGenerate={() => void handleNarrate()}
              controls={(
                <label className="inline-select"><span className="sr-only">Recap language</span><select value={recapLanguage} onChange={(event) => setRecapLanguage(event.target.value as Language)}>{LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABEL[item]}</option>)}</select></label>
              )}
            />
            <Panel eyebrow="Storyboard" title="Match chapters">
              <Storyboard storyboard={storyboard} fixture={fixture} storylines={storylines} language={recapLanguage} />
            </Panel>
          </div>
        </div>
      ) : labHighlights ? null : (
        <div className="panel empty-hero">
          <h2>No match yet</h2>
          <p className="subtle-text">Start a match on the live desk. The highlight reel, written recap and chapters build themselves from the verified feed.</p>
          <button type="button" className="button button--primary" onClick={() => setTab("live")}>Go to live desk</button>
        </div>
      )}
    </main>
  );
}
