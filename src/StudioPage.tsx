import { useEffect, useMemo, useRef, useState } from "react";
import type { FixtureSummary, Language, MatchFixture } from "../shared/types.js";
import type { ArchiveSummary, GenerateMatchRequest, LiveStatus, RecapStoryboard, ReviewStorylineRequest, ScenarioKind, Storyline, VerifiedFact } from "../shared/platform.js";
import { api } from "./api.js";
import { FactTicker, OverlayPreview, Pitch, RecentEventsList, Scorebug, Storyboard, StorylineQueue } from "./components.js";
import { useLiveStream } from "./hooks/useLiveStream.js";
import { clamp, computeScoreFromEvents, createAsyncState, downloadJson, formatClock, getErrorMessage, liveTransportLabel, mergeById, SCENARIOS, sortFactsNewestFirst, sortStudioStorylines, type AsyncState } from "./utils.js";

type DeskHealth = { mode: "foundry-agents" | "unconfigured"; agents: string[]; retrieval: string; };
type StartMode = "fixture" | "matchlab";

export function StudioPage() {
  const [fixtures, setFixtures] = useState<AsyncState<FixtureSummary[]>>(createAsyncState<FixtureSummary[]>(true));
  const [archiveSummary, setArchiveSummary] = useState<AsyncState<ArchiveSummary>>(createAsyncState<ArchiveSummary>(true));
  const [deskHealth, setDeskHealth] = useState<AsyncState<DeskHealth>>(createAsyncState<DeskHealth>(true));
  const [liveStatus, setLiveStatus] = useState<AsyncState<LiveStatus>>(createAsyncState<LiveStatus>(true));
  const [liveFixture, setLiveFixture] = useState<AsyncState<MatchFixture>>(createAsyncState<MatchFixture>(true));
  const [storylines, setStorylines] = useState<AsyncState<Storyline[]>>(createAsyncState<Storyline[]>(true));
  const [facts, setFacts] = useState<AsyncState<VerifiedFact[]>>(createAsyncState<VerifiedFact[]>(true));
  const [storyboard, setStoryboard] = useState<AsyncState<RecapStoryboard>>(createAsyncState<RecapStoryboard>());
  const [startMode, setStartMode] = useState<StartMode>("fixture");
  const [selectedFixtureId, setSelectedFixtureId] = useState("");
  const [scenario, setScenario] = useState<ScenarioKind>("comeback");
  const [seed, setSeed] = useState<number>(2025);
  const [homeClubId, setHomeClubId] = useState("");
  const [awayClubId, setAwayClubId] = useState("");
  const [speed, setSpeed] = useState<number>(20);
  const [stress, setStress] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedStorylineId, setSelectedStorylineId] = useState<string | null>(null);
  const [overlayLanguage, setOverlayLanguage] = useState<Language>("en");
  const [queueLoadingById, setQueueLoadingById] = useState<Record<string, boolean>>({});
  const [queueErrorById, setQueueErrorById] = useState<Record<string, string | undefined>>({});
  const storyboardAbortRef = useRef<AbortController | null>(null);
  const liveFixtureAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.getFixtures(controller.signal), api.getArchiveSummary(controller.signal), api.getStudioHealth(controller.signal), api.getLiveStatus(controller.signal), api.getLiveFixture(controller.signal), api.getStudioStorylines(controller.signal), api.getStudioFacts(controller.signal), api.getStudioStoryboard(controller.signal)
    ]).then(([fixtureList, archive, health, status, fixture, storylineList, factList, board]) => {
      setFixtures({ data: fixtureList ?? [], loading: false, error: null });
      if ((fixtureList ?? []).length > 0) setSelectedFixtureId((current) => current || fixtureList?.[0]?.id || "");
      setArchiveSummary({ data: archive, loading: false, error: null });
      setDeskHealth({ data: health, loading: false, error: null });
      setLiveStatus({ data: status, loading: false, error: null });
      currentMatchIdRef.current = status?.matchId;
      setLiveFixture({ data: fixture, loading: false, error: null });
      setStorylines({ data: sortStudioStorylines(storylineList ?? []), loading: false, error: null });
      setFacts({ data: sortFactsNewestFirst(factList ?? []), loading: false, error: null });
      setStoryboard({ data: board, loading: false, error: null });
    }).catch((error: unknown) => setPageError(getErrorMessage(error)));
    return () => controller.abort();
  }, []);

  const currentMatchIdRef = useRef<string | undefined>(undefined);
  const lastFixtureRefreshRef = useRef(0);

  // A match started from another console (or a new match after full time) must not inherit the previous match's desk state.
  function adoptStatus(status: LiveStatus) {
    if (status.matchId && currentMatchIdRef.current && status.matchId !== currentMatchIdRef.current) {
      setStorylines({ data: [], loading: false, error: null });
      setFacts({ data: [], loading: false, error: null });
      setStoryboard({ data: null, loading: false, error: null });
      setSelectedStorylineId(null);
    }
    if (status.matchId) currentMatchIdRef.current = status.matchId;
    setLiveStatus({ data: status, loading: false, error: null });
  }

  function refreshLiveFixtureThrottled() {
    const now = Date.now();
    if (now - lastFixtureRefreshRef.current < 2_000) return;
    lastFixtureRefreshRef.current = now;
    liveFixtureAbortRef.current?.abort();
    const controller = new AbortController();
    liveFixtureAbortRef.current = controller;
    void api.getLiveFixture(controller.signal)
      .then((data) => !controller.signal.aborted && setLiveFixture({ data, loading: false, error: null }))
      .catch((error: unknown) => !controller.signal.aborted && setLiveFixture((current) => ({ data: current.data, loading: false, error: getErrorMessage(error) })));
  }

  useLiveStream({ enabled: true, role: "studio", persona: "analyst", language: overlayLanguage, onMessage: (message) => {
    if (message.type === "status") { adoptStatus(message.status); if (message.status.state === "finished") void refreshStoryboard(); return; }
    if (message.type === "snapshot") { adoptStatus(message.status); refreshLiveFixtureThrottled(); return; }
    if (message.type === "storyline") {
      if (currentMatchIdRef.current && message.storyline.matchId !== currentMatchIdRef.current) return;
      setStorylines((current) => ({ data: sortStudioStorylines(mergeById(current.data ?? [], message.storyline)), loading: false, error: null }));
      return;
    }
    if (message.type === "fact") {
      if (currentMatchIdRef.current && message.fact.matchId !== currentMatchIdRef.current) return;
      setFacts((current) => ({ data: sortFactsNewestFirst(mergeById(current.data ?? [], message.fact)), loading: false, error: null }));
    }
  }});

  useEffect(() => {
    liveFixtureAbortRef.current?.abort();
    const controller = new AbortController();
    liveFixtureAbortRef.current = controller;
    void api.getLiveFixture(controller.signal).then((data) => !controller.signal.aborted && setLiveFixture({ data, loading: false, error: null })).catch((error: unknown) => !controller.signal.aborted && setLiveFixture({ data: null, loading: false, error: getErrorMessage(error) }));
    return () => controller.abort();
  }, [liveStatus.data?.matchId, liveStatus.data?.state]);

  useEffect(() => () => { storyboardAbortRef.current?.abort(); liveFixtureAbortRef.current?.abort(); }, []);

  const approvedStorylines = useMemo(() => (storylines.data ?? []).filter((storyline) => storyline.status === "approved"), [storylines.data]);
  const selectedStoryline = approvedStorylines.find((storyline) => storyline.id === selectedStorylineId) ?? approvedStorylines[0] ?? null;
  const score = computeScoreFromEvents(liveFixture.data);
  const activeGoals = liveFixture.data?.events.filter((event) => event.type === "goal" && !event.rescinded) ?? [];

  async function refreshStoryboard() {
    storyboardAbortRef.current?.abort();
    const controller = new AbortController();
    storyboardAbortRef.current = controller;
    setStoryboard((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await api.getStudioStoryboard(controller.signal);
      if (!controller.signal.aborted) setStoryboard({ data, loading: false, error: null });
    } catch (error: unknown) {
      if (!controller.signal.aborted) setStoryboard((current) => ({ data: current.data, loading: false, error: getErrorMessage(error) }));
    }
  }

  async function handleStart() {
    setSubmitting(true);
    setPageError(null);
    try {
      const generate: GenerateMatchRequest | undefined = startMode === "matchlab" ? { scenario, seed, homeClubId: homeClubId || undefined, awayClubId: awayClubId || undefined } : undefined;
      const status = await api.startLive({ fixtureId: startMode === "fixture" ? selectedFixtureId : undefined, generate, speed: clamp(speed, 1, 60), stress });
      currentMatchIdRef.current = status?.matchId;
      setLiveStatus({ data: status, loading: false, error: null });
      const fixture = await api.getLiveFixture();
      setLiveFixture({ data: fixture, loading: false, error: null });
      setStorylines({ data: [], loading: false, error: null });
      setFacts({ data: [], loading: false, error: null });
      setStoryboard({ data: null, loading: false, error: null });
    } catch (error: unknown) {
      setPageError(getErrorMessage(error));
    } finally { setSubmitting(false); }
  }

  async function handleStop() {
    setSubmitting(true);
    setPageError(null);
    try {
      const status = await api.stopLive();
      setLiveStatus({ data: status, loading: false, error: null });
      const fixture = await api.getLiveFixture();
      setLiveFixture({ data: fixture, loading: false, error: null });
      void refreshStoryboard();
    } catch (error: unknown) {
      setPageError(getErrorMessage(error));
    } finally { setSubmitting(false); }
  }

  async function handleCorrection(eventId: string) {
    try {
      const status = await api.sendCorrection(eventId);
      setLiveStatus({ data: status, loading: false, error: null });
      const fixture = await api.getLiveFixture();
      setLiveFixture({ data: fixture, loading: false, error: null });
    } catch (error: unknown) {
      setPageError(getErrorMessage(error));
    }
  }

  async function handleReview(storylineId: string, request: ReviewStorylineRequest) {
    setQueueLoadingById((current) => ({ ...current, [storylineId]: true }));
    setQueueErrorById((current) => ({ ...current, [storylineId]: undefined }));
    try {
      const storyline = await api.reviewStoryline(storylineId, request);
      if (storyline) {
        setStorylines((current) => ({ data: sortStudioStorylines(mergeById(current.data ?? [], storyline)), loading: false, error: null }));
        setSelectedStorylineId(storyline.id);
      }
    } catch (error: unknown) {
      setQueueErrorById((current) => ({ ...current, [storylineId]: getErrorMessage(error) }));
    } finally { setQueueLoadingById((current) => ({ ...current, [storylineId]: false })); }
  }

  return (
    <div className="page-shell">
      <section className="panel"><div className="panel__header"><div><span className="eyebrow">Studio console</span><h1>Broadcast producer desk</h1></div><div className="status-grid"><span className="tag tag--accent">Synthetic match feed</span>{liveStatus.data && <span className="tag">{liveTransportLabel(liveStatus.data)}</span>}</div></div><p className="lede">Start the live synthetic feed, review storyline drafts, and package approved lower-thirds for the studio desk.</p></section>
      {pageError && <div className="banner banner--danger">{pageError}</div>}
      <div className="page-grid"><section className="column"><div className="panel"><div className="panel__header"><div><span className="eyebrow">Control panel</span><h2>Start or stop live</h2></div><div className="segmented segmented--dual"><button type="button" className={`segmented__item${startMode === "fixture" ? " is-active" : ""}`} onClick={() => setStartMode("fixture")}>Fixture</button><button type="button" className={`segmented__item${startMode === "matchlab" ? " is-active" : ""}`} onClick={() => setStartMode("matchlab")}>MatchLab</button></div></div><div className="control-grid">{startMode === "fixture" ? <label className="field"><span>Fixture</span><select value={selectedFixtureId} onChange={(event) => setSelectedFixtureId(event.target.value)}>{(fixtures.data ?? []).map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.title}</option>)}</select></label> : <><label className="field"><span>Scenario</span><select value={scenario} onChange={(event) => setScenario(event.target.value as ScenarioKind)}>{SCENARIOS.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></label><label className="field"><span>Seed</span><input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label><label className="field"><span>Home club (optional)</span><select value={homeClubId} onChange={(event) => setHomeClubId(event.target.value)}><option value="">Auto</option>{(archiveSummary.data?.clubs ?? []).map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label><label className="field"><span>Away club (optional)</span><select value={awayClubId} onChange={(event) => setAwayClubId(event.target.value)}><option value="">Auto</option>{(archiveSummary.data?.clubs ?? []).map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select></label></>}<label className="field"><span>Speed (1–60)</span><input type="number" min={1} max={60} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label><label className="field field--checkbox"><span>Stress test feed</span><input type="checkbox" checked={stress} onChange={(event) => setStress(event.target.checked)} /></label></div><div className="control-row"><button type="button" className="button button--primary" onClick={() => void handleStart()} disabled={submitting}>Start live</button><button type="button" className="button" onClick={() => void handleStop()} disabled={submitting}>Stop</button></div>{liveStatus.data && <div className="status-grid"><span className="tag">state {liveStatus.data.state}</span><span className="tag">clock {formatClock(liveStatus.data.clockSecond)}</span><span className="tag">events {liveStatus.data.eventsReceived}</span><span className="tag">duplicates {liveStatus.data.duplicatesIgnored}</span>{liveStatus.data.lagMs !== undefined && <span className="tag">lag {liveStatus.data.lagMs} ms</span>}</div>}{deskHealth.data && <div className="desk-health"><h3>Desk health</h3><p>Mode: {deskHealth.data.mode}</p><p>Retrieval: {deskHealth.data.retrieval}</p><div className="chips">{deskHealth.data.agents.map((agent) => <span className="tag tag--ghost" key={agent}>{agent}</span>)}</div>{deskHealth.data.mode === "unconfigured" && <div className="banner banner--warning">Studio desk is unconfigured. Storyline agent outputs may be unavailable.</div>}</div>}</div>{liveFixture.data ? <><Pitch fixture={liveFixture.data} recentEvents={liveFixture.data.events.slice(-8)} title="Live board" subtitle="Current fixture" /><RecentEventsList fixture={liveFixture.data} events={liveFixture.data.events.slice(-12)} title="Recent events" subtitle="Correction desk" emptyMessage="No live events yet." /></> : <div className="panel"><div className="empty-state">No live fixture is active.</div></div>}<div className="panel"><div className="panel__header"><div><span className="eyebrow">Goal correction</span><h2>Active goals</h2></div>{liveFixture.data && <Scorebug compact home={liveFixture.data.home.shortName} away={liveFixture.data.away.shortName} score={score} clock={formatClock(liveStatus.data?.clockSecond ?? 0)} />}</div>{activeGoals.length > 0 ? <div className="feed">{activeGoals.map((goal) => <article className="feed-item" key={goal.id}><div className="feed-item__line"><strong>{goal.minute}' goal</strong><span>{goal.teamId}</span></div><button type="button" className="button" onClick={() => void handleCorrection(goal.id)}>Send correction</button></article>)}</div> : <div className="empty-state">No active goals are available for correction.</div>}</div></section><section className="column column--wide"><StorylineQueue storylines={storylines.data ?? []} selectedStorylineId={selectedStorylineId} onSelect={setSelectedStorylineId} onReview={handleReview} loadingById={queueLoadingById} errorById={queueErrorById} /><OverlayPreview storyline={selectedStoryline} language={overlayLanguage} onLanguageChange={setOverlayLanguage} onExport={() => selectedStoryline && downloadJson(`${selectedStoryline.matchId}-${selectedStoryline.id}-overlay.json`, { storylineId: selectedStoryline.id, matchId: selectedStoryline.matchId, minute: selectedStoryline.triggerMinute, headline: selectedStoryline.headline, overlay: selectedStoryline.overlay, claimSources: selectedStoryline.claims.flatMap((claim) => claim.sources), version: selectedStoryline.version })} /><FactTicker facts={facts.data ?? []} language={overlayLanguage} title="Verified facts feed" /></section><section className="column"><Storyboard storyboard={storyboard.data} fixture={liveFixture.data} storylines={approvedStorylines} language={overlayLanguage} loading={storyboard.loading} error={storyboard.error} onRefresh={() => void refreshStoryboard()} /></section></div>
    </div>
  );
}
