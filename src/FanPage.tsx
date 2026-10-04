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
  Persona
} from "../shared/types.js";
import type { ArchivePlayerProfile, LiveStatus, Storyline, VerifiedFact } from "../shared/platform.js";
import { api } from "./api.js";
import {
  EvidenceDrawer,
  FactTicker,
  NarrativePanel,
  Pitch,
  PlayerBioCard,
  RecentEventsList,
  ReplayStoryRail,
  Scorebug
} from "./components.js";
import { useLiveStream } from "./hooks/useLiveStream.js";
import {
  buildPlayerMap,
  clamp,
  createAsyncState,
  defaultFixtureSecond,
  downloadJson,
  findFavoritePlayer,
  fixtureScore,
  formatClock,
  formatMinuteLabel,
  getErrorMessage,
  getPlayerById,
  latestSnapshotStories,
  liveTransportLabel,
  mergeById,
  PERSONAS,
  sortFanStorylines,
  storylineText,
  structuralLabel,
  summarizeLiveState,
  type AsyncState,
  type FanMode
} from "./utils.js";

const SIMULATION_SPEED = 30;
const ANALYSIS_DEBOUNCE_MS = 220;

type ReplayState = {
  fixtureId: string;
  atSecond: number;
  persona: Persona;
  language: Language;
  favoritePlayerId?: string;
  correction: boolean;
};

function makeInitialReplayState(): ReplayState {
  return { fixtureId: "", atSecond: 72 * 60 + 30, persona: "analyst", language: "en", favoritePlayerId: undefined, correction: false };
}

export function FanPage() {
  const [mode, setMode] = useState<FanMode>("replay");
  const [health, setHealth] = useState<AsyncState<AppHealth>>(createAsyncState<AppHealth>(true));
  const [fixtures, setFixtures] = useState<AsyncState<FixtureSummary[]>>(createAsyncState<FixtureSummary[]>(true));
  const [fixture, setFixture] = useState<AsyncState<MatchFixture>>(createAsyncState<MatchFixture>());
  const [snapshot, setSnapshot] = useState<AsyncState<MatchSnapshot>>(createAsyncState<MatchSnapshot>());
  const [narrative, setNarrative] = useState<AsyncState<NarrativeResponse>>(createAsyncState<NarrativeResponse>());
  const [replay, setReplay] = useState<ReplayState>(makeInitialReplayState);
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [narrativeNotice, setNarrativeNotice] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [liveFixture, setLiveFixture] = useState<AsyncState<MatchFixture>>(createAsyncState<MatchFixture>());
  const [liveSnapshot, setLiveSnapshot] = useState<MatchSnapshot | null>(null);
  const [liveStorylines, setLiveStorylines] = useState<Storyline[]>([]);
  const [liveFacts, setLiveFacts] = useState<VerifiedFact[]>([]);
  const [playerBio, setPlayerBio] = useState<AsyncState<ArchivePlayerProfile>>(createAsyncState<ArchivePlayerProfile>());

  const analyzeAbortRef = useRef<AbortController | null>(null);
  const narrativeAbortRef = useRef<AbortController | null>(null);
  const fixtureAbortRef = useRef<AbortController | null>(null);
  const liveFixtureAbortRef = useRef<AbortController | null>(null);
  const analysisSequence = useRef(0);
  const narrativeSequence = useRef(0);

  const replayFixture = fixture.data;
  const currentFixture = mode === "live" ? liveFixture.data : replayFixture;
  const fixtureList = fixtures.data ?? [];
  const selectedReplayStory = useMemo(() => snapshot.data?.stories.find((story) => story.id === selectedStoryId) ?? snapshot.data?.stories[0] ?? null, [selectedStoryId, snapshot.data]);
  const replayEvidence = useMemo(() => selectedReplayStory && snapshot.data ? selectedReplayStory.evidenceIds.map((id) => snapshot.data?.evidence[id]).filter((event): event is MatchEvent => Boolean(event)) : [], [selectedReplayStory, snapshot.data]);
  const activeFavoritePlayer = getPlayerById(currentFixture, replay.favoritePlayerId);

  useEffect(() => {
    const controller = new AbortController();
    void api.getHealth(controller.signal).then((data) => data && setHealth({ data, loading: false, error: null })).catch((error: unknown) => setHealth({ data: null, loading: false, error: getErrorMessage(error) }));
    void api.getFixtures(controller.signal).then((data) => {
      const nextFixtures = data ?? [];
      setFixtures({ data: nextFixtures, loading: false, error: null });
      if (nextFixtures.length > 0) {
        setReplay((current) => ({ ...current, fixtureId: current.fixtureId || nextFixtures[0].id }));
      }
    }).catch((error: unknown) => setFixtures({ data: null, loading: false, error: getErrorMessage(error) }));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!replay.fixtureId) return;
    fixtureAbortRef.current?.abort();
    const controller = new AbortController();
    fixtureAbortRef.current = controller;
    setFixture(createAsyncState<MatchFixture>(true));
    setSnapshot(createAsyncState<MatchSnapshot>());
    setNarrative(createAsyncState<NarrativeResponse>());
    setSelectedStoryId(null);
    setIsPlaying(false);
    void api.getFixture(replay.fixtureId, controller.signal).then((data) => {
      if (!data) return;
      setFixture({ data, loading: false, error: null });
      setReplay((current) => ({ ...current, atSecond: defaultFixtureSecond(data.durationSeconds), correction: false, favoritePlayerId: findFavoritePlayer(data, current.favoritePlayerId) }));
    }).catch((error: unknown) => !controller.signal.aborted && setFixture({ data: null, loading: false, error: getErrorMessage(error) }));
    return () => controller.abort();
  }, [replay.fixtureId]);

  useEffect(() => {
    if (mode !== "replay" || !replayFixture) return;
    const timeoutId = window.setTimeout(() => {
      analyzeAbortRef.current?.abort();
      const controller = new AbortController();
      analyzeAbortRef.current = controller;
      const sequence = ++analysisSequence.current;
      setSnapshot((current) => ({ ...current, loading: true, error: null }));
      const payload: AnalysisRequest = { fixtureId: replayFixture.id, atSecond: Math.round(clamp(replay.atSecond, 0, replayFixture.durationSeconds)), persona: replay.persona, language: replay.language, correction: replay.correction, favoritePlayerId: replay.persona === "player" ? replay.favoritePlayerId : undefined };
      void api.analyze(payload, controller.signal).then((data) => {
        if (!data || controller.signal.aborted || sequence !== analysisSequence.current) return;
        setSnapshot({ data, loading: false, error: null });
        setSelectedStoryId((current) => current && data.stories.some((story) => story.id === current) ? current : data.stories[0]?.id ?? null);
        setNarrative((current) => current.data && current.data.stateVersion !== data.stateVersion ? (setNarrativeNotice("Narrative cleared because the replay state changed."), { data: null, loading: false, error: null }) : current);
      }).catch((error: unknown) => !controller.signal.aborted && sequence === analysisSequence.current && setSnapshot((current) => ({ data: current.data, loading: false, error: getErrorMessage(error) })));
    }, ANALYSIS_DEBOUNCE_MS);
    return () => { window.clearTimeout(timeoutId); analyzeAbortRef.current?.abort(); analysisSequence.current += 1; };
  }, [mode, replay.atSecond, replay.correction, replay.favoritePlayerId, replay.language, replay.persona, replayFixture]);

  useEffect(() => {
    if (mode !== "replay" || !isPlaying || !replayFixture) return;
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = (now - lastTick) / 1000;
      lastTick = now;
      setReplay((current) => {
        const nextAtSecond = clamp(current.atSecond + elapsed * SIMULATION_SPEED, 0, replayFixture.durationSeconds);
        if (nextAtSecond >= replayFixture.durationSeconds) setIsPlaying(false);
        return { ...current, atSecond: nextAtSecond };
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [isPlaying, mode, replayFixture]);

  useEffect(() => {
    if (mode !== "live") return;
    const controller = new AbortController();
    void api.getLiveStatus(controller.signal).then((data) => data && setLiveStatus(data)).catch(() => undefined);
    return () => controller.abort();
  }, [mode]);

  useEffect(() => {
    if (mode !== "live") return;
    liveFixtureAbortRef.current?.abort();
    const controller = new AbortController();
    liveFixtureAbortRef.current = controller;
    setLiveFixture((current) => ({ ...current, loading: true, error: null }));
    void api.getLiveFixture(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setLiveFixture({ data, loading: false, error: null });
      if (data) setReplay((current) => ({ ...current, favoritePlayerId: findFavoritePlayer(data, current.favoritePlayerId) }));
      else { setLiveSnapshot(null); setLiveStorylines([]); setLiveFacts([]); }
    }).catch((error: unknown) => !controller.signal.aborted && setLiveFixture({ data: null, loading: false, error: getErrorMessage(error) }));
    return () => controller.abort();
  }, [mode, liveStatus?.matchId, liveStatus?.state]);

  const liveMatchIdRef = useRef<string | undefined>(undefined);
  useLiveStream({ enabled: mode === "live", role: "fan", persona: replay.persona, language: replay.language, favoritePlayerId: replay.favoritePlayerId, onMessage: (message) => {
    if (message.type === "status" || message.type === "snapshot") {
      // Reset per-match fan state when a new live match begins.
      if (message.status.matchId && liveMatchIdRef.current && message.status.matchId !== liveMatchIdRef.current) {
        setLiveStorylines([]);
        setLiveFacts([]);
      }
      if (message.status.matchId) liveMatchIdRef.current = message.status.matchId;
    }
    if (message.type === "status") { setLiveStatus(message.status); if (message.status.state === "idle") setLiveSnapshot(null); return; }
    if (message.type === "snapshot") { setLiveStatus(message.status); setLiveSnapshot(message.snapshot); return; }
    if (message.type === "storyline") { if (liveMatchIdRef.current && message.storyline.matchId !== liveMatchIdRef.current) return; setLiveStorylines((current) => sortFanStorylines(mergeById(current, message.storyline))); return; }
    if (message.type === "fact" && (!liveMatchIdRef.current || message.fact.matchId === liveMatchIdRef.current)) setLiveFacts((current) => mergeById(current, message.fact));
  }});

  useEffect(() => {
    const favoritePlayer = getPlayerById(currentFixture, replay.favoritePlayerId);
    if (replay.persona !== "player" || !favoritePlayer?.archiveId) { setPlayerBio(createAsyncState<ArchivePlayerProfile>()); return; }
    const controller = new AbortController();
    setPlayerBio(createAsyncState<ArchivePlayerProfile>(true));
    void api.getArchivePlayerProfile(favoritePlayer.archiveId, controller.signal).then((data) => setPlayerBio({ data, loading: false, error: null })).catch((error: unknown) => !controller.signal.aborted && setPlayerBio({ data: null, loading: false, error: getErrorMessage(error) }));
    return () => controller.abort();
  }, [currentFixture, replay.favoritePlayerId, replay.persona]);

  useEffect(() => () => { analyzeAbortRef.current?.abort(); narrativeAbortRef.current?.abort(); fixtureAbortRef.current?.abort(); liveFixtureAbortRef.current?.abort(); }, []);

  async function handleNarrationRequest(format: "story" | "recap", storyId?: string, overrideSecond?: number) {
    if (!replayFixture) return;
    if (!health.data?.ai.configured) { setNarrative({ data: null, loading: false, error: "AI narration is unavailable for this environment." }); return; }
    narrativeAbortRef.current?.abort();
    const controller = new AbortController();
    narrativeAbortRef.current = controller;
    const sequence = ++narrativeSequence.current;
    setNarrative((current) => ({ data: current.data, loading: true, error: null }));
    const payload: NarrativeRequest = { fixtureId: replayFixture.id, atSecond: Math.round(overrideSecond ?? replay.atSecond), persona: replay.persona, language: replay.language, correction: replay.correction, favoritePlayerId: replay.persona === "player" ? replay.favoritePlayerId : undefined, format, storyId };
    try {
      const data = await api.narrate(payload, controller.signal);
      if (!data || controller.signal.aborted || sequence !== narrativeSequence.current) return;
      setNarrative({ data, loading: false, error: null });
      setNarrativeNotice(null);
    } catch (error: unknown) {
      if (!controller.signal.aborted && sequence === narrativeSequence.current) setNarrative((current) => ({ data: current.data, loading: false, error: getErrorMessage(error) }));
    }
  }

  async function handleCopyRecap() {
    if (!narrative.data) return;
    try { await navigator.clipboard.writeText(narrative.data.script); setCopyMessage("Recap copied to clipboard."); }
    catch (error: unknown) { setCopyMessage(`Clipboard copy failed: ${getErrorMessage(error)}`); }
  }

  const liveScore = fixtureScore(liveSnapshot, liveFixture.data);
  const liveApprovedStorylines = sortFanStorylines(liveStorylines);
  const liveFactsOrdered = liveFacts.slice().sort((a, b) => Number(Boolean(a.retracted)) - Number(Boolean(b.retracted)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return (
    <div className="page-shell">
      <section className="panel"><div className="panel__header"><div><span className="eyebrow">Fan experience</span><h1>Explainable synthetic match intelligence</h1></div><div className="segmented segmented--dual"><button type="button" className={`segmented__item${mode === "replay" ? " is-active" : ""}`} onClick={() => setMode("replay")}>Replay</button><button type="button" className={`segmented__item${mode === "live" ? " is-active" : ""}`} onClick={() => setMode("live")}>Live</button></div></div><p className="lede">From studio rehearsals to fan replay moments, MatchLens keeps synthetic labelling visible and evidence attached.</p><div className="status-grid"><span className="tag tag--accent">Synthetic match feed</span>{health.data ? <span className="tag">version {health.data.version}</span> : <span className="tag">connecting…</span>}</div></section>
      {health.error && <div className="banner banner--danger">{health.error}</div>}
      {fixtures.error && <div className="banner banner--danger">{fixtures.error}</div>}
      {fixture.error && mode === "replay" && <div className="banner banner--danger">{fixture.error}</div>}
      {snapshot.error && mode === "replay" && <div className="banner banner--danger">Analysis error: {snapshot.error}</div>}
      {narrative.error && mode === "replay" && <div className="banner banner--danger">Narration error: {narrative.error}</div>}
      {narrativeNotice && <div className="banner banner--warning">{narrativeNotice}</div>}
      {mode === "replay" ? <div className="page-grid"><section className="column"><div className="panel"><div className="panel__header"><div><span className="eyebrow">Replay control</span><h2>{replayFixture?.title ?? "Loading replay fixtures"}</h2></div>{replayFixture ? <Scorebug home={replayFixture.home.shortName} away={replayFixture.away.shortName} score={snapshot.data?.score ?? { home: 0, away: 0 }} clock={formatClock(replay.atSecond)} /> : <div className="scorebug scorebug--idle">Score pending</div>}</div>{fixtureList.length > 0 && <label className="field"><span>Fixture</span><select value={replay.fixtureId} onChange={(event) => setReplay((current) => ({ ...current, fixtureId: event.target.value }))}>{fixtureList.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}{replayFixture ? <><p className="lede">{replayFixture.description}</p><div className="control-grid"><label className="field"><span>Persona</span><div className="segmented">{PERSONAS.map((persona) => <button type="button" key={persona} className={`segmented__item${replay.persona === persona ? " is-active" : ""}`} onClick={() => setReplay((current) => ({ ...current, persona }))}>{persona}</button>)}</div></label><label className="field"><span>Language</span><select value={replay.language} onChange={(event) => setReplay((current) => ({ ...current, language: event.target.value as Language }))}><option value="en">English</option><option value="es">Español</option><option value="fr">Français</option></select></label>{replay.persona === "player" && <label className="field"><span>Favorite player</span><select value={replay.favoritePlayerId} onChange={(event) => setReplay((current) => ({ ...current, favoritePlayerId: event.target.value }))}>{[...replayFixture.home.players, ...replayFixture.away.players].map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>}</div><div className="timeline-card"><div className="timeline-card__head"><span className="eyebrow">Replay state</span><strong>{formatClock(replay.atSecond)}</strong></div><input type="range" min={0} max={replayFixture.durationSeconds} step={1} value={Math.round(replay.atSecond)} onChange={(event) => { setIsPlaying(false); setReplay((current) => ({ ...current, atSecond: Number(event.target.value) })); }} aria-label="Replay scrubber" /><div className="timeline-card__labels"><span>0'</span><span>{formatMinuteLabel(replayFixture.correctionAvailableAt)} correction unlock</span><span>90'</span></div><div className="control-row"><button type="button" className="button button--primary" onClick={() => setIsPlaying((current) => !current)}>{isPlaying ? "Pause" : `Play ${SIMULATION_SPEED}×`}</button><button type="button" className="button" onClick={() => setReplay((current) => ({ ...current, atSecond: replayFixture.durationSeconds }))}>Full time</button><button type="button" className="button" onClick={() => { setIsPlaying(false); setReplay((current) => ({ ...current, atSecond: defaultFixtureSecond(replayFixture.durationSeconds), correction: false })); }}>Reset</button><button type="button" className="button" onClick={() => setReplay((current) => ({ ...current, correction: !current.correction }))} disabled={replay.atSecond < replayFixture.correctionAvailableAt}>{replay.correction ? "Retract correction" : "Apply goal correction"}</button></div></div></> : <div className="skeleton skeleton--tall" />}</div>{replayFixture && <RecentEventsList fixture={replayFixture} events={snapshot.data?.recentEvents ?? []} title="Recent replay events" subtitle="Live event feed" emptyMessage="Replay events will appear after analysis runs." />}<PlayerBioCard loading={playerBio.loading} error={playerBio.error} profile={playerBio.data} favoritePlayerName={activeFavoritePlayer?.name} /></section><section className="column">{replayFixture ? <Pitch fixture={replayFixture} recentEvents={snapshot.data?.recentEvents ?? []} selectedStory={selectedReplayStory} snapshotEvidence={snapshot.data?.evidence} title="Animated evidence pitch" subtitle="Replay board" /> : <div className="panel"><div className="skeleton skeleton--tall" /></div>}<div className="panel"><div className="panel__header"><div><span className="eyebrow">Pinned story</span><h2>{selectedReplayStory?.title ?? "Choose a replay story"}</h2></div></div>{selectedReplayStory && snapshot.data ? <><p className="lede">{selectedReplayStory.summary}</p><p className="story-matter">{selectedReplayStory.whyItMatters}</p><div className="story-preview__metrics">{selectedReplayStory.metrics.map((metric) => <div className="metric-card" key={metric.label}><span>{metric.label}</span><strong>{metric.value}{metric.unit ?? ""}</strong></div>)}</div><div className="control-row"><button type="button" className="button button--primary" onClick={() => void handleNarrationRequest("story", selectedReplayStory.id)} disabled={!health.data?.ai.configured || snapshot.loading || narrative.loading}>Narrate selected story</button><button type="button" className="button" onClick={() => snapshot.data && selectedReplayStory && downloadJson(`${snapshot.data.fixtureId}-${selectedReplayStory.id}-overlay.json`, { fixtureId: snapshot.data.fixtureId, storyId: selectedReplayStory.id, title: selectedReplayStory.title, summary: selectedReplayStory.summary, whyItMatters: selectedReplayStory.whyItMatters, stateVersion: snapshot.data.stateVersion, language: snapshot.data.language, persona: snapshot.data.persona, evidenceIds: selectedReplayStory.evidenceIds })}>Export JSON overlay</button></div><div className="story-preview__coverage"><span>Structural coverage</span><strong>{Math.round(snapshot.data.evidenceCoverage)}%</strong><p>{selectedReplayStory.evidenceIds.length} linked events support this live slice.</p></div></> : <div className="empty-state">Select a story rail card to focus the replay editorial lens.</div>}</div><NarrativePanel narrative={narrative.data} loading={narrative.loading} error={narrative.error} aiReady={Boolean(health.data?.ai.configured)} onCurrentRecap={() => void handleNarrationRequest("recap")} onFulltimeRecap={() => replayFixture && void handleNarrationRequest("recap", undefined, replayFixture.durationSeconds)} onCopy={() => void handleCopyRecap()} copyMessage={copyMessage} /></section><section className="column"><ReplayStoryRail snapshot={snapshot.data} selectedStoryId={selectedReplayStory?.id ?? null} onSelect={setSelectedStoryId} />{replayFixture && <EvidenceDrawer fixture={replayFixture} story={selectedReplayStory} evidence={replayEvidence} coverage={snapshot.data?.evidenceCoverage ?? 0} />}</section></div> : <div className="page-grid"><section className="column"><div className="panel"><div className="panel__header"><div><span className="eyebrow">Live control</span><h2>Fan stream</h2></div>{liveFixture.data ? <Scorebug home={liveFixture.data.home.shortName} away={liveFixture.data.away.shortName} score={liveScore} clock={formatClock(liveStatus?.clockSecond ?? 0)} secondary={liveStatus?.state ?? "idle"} /> : <div className="scorebug scorebug--idle">Waiting for studio</div>}</div><div className="control-grid"><label className="field"><span>Persona</span><div className="segmented">{PERSONAS.map((persona) => <button type="button" key={persona} className={`segmented__item${replay.persona === persona ? " is-active" : ""}`} onClick={() => setReplay((current) => ({ ...current, persona }))}>{persona}</button>)}</div></label><label className="field"><span>Language</span><select value={replay.language} onChange={(event) => setReplay((current) => ({ ...current, language: event.target.value as Language }))}><option value="en">English</option><option value="es">Español</option><option value="fr">Français</option></select></label>{liveFixture.data && <label className="field"><span>Favorite player</span><select value={replay.favoritePlayerId} onChange={(event) => setReplay((current) => ({ ...current, favoritePlayerId: event.target.value }))}>{[...liveFixture.data.home.players, ...liveFixture.data.away.players].map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>}</div><div className="status-grid"><span className="tag">{liveStatus ? liveTransportLabel(liveStatus) : "Connecting"}</span>{liveStatus?.lagMs !== undefined && <span className="tag">lag {liveStatus.lagMs} ms</span>}<span className="tag">events {liveStatus?.eventsReceived ?? 0}</span><span className="tag">duplicates {liveStatus?.duplicatesIgnored ?? 0}</span></div><p className="lede">{summarizeLiveState(liveStatus)}</p>{liveStatus && !liveStatus.transportConfigured && <div className="banner banner--warning">Fabric Eventstream is not configured. This fan stream is using the local bus.</div>}{liveStatus?.state === "idle" && <div className="empty-state">A live match is not running yet. Open the Studio route to start a synthetic live feed.</div>}{liveFixture.error && <div className="banner banner--danger">{liveFixture.error}</div>}</div>{liveFixture.data && <RecentEventsList fixture={liveFixture.data} events={liveSnapshot?.recentEvents ?? liveFixture.data.events.slice(-12)} title="Recent live events" subtitle="Live board" emptyMessage="Events will appear as the live feed advances." />}<PlayerBioCard loading={playerBio.loading} error={playerBio.error} profile={playerBio.data} favoritePlayerName={activeFavoritePlayer?.name} /></section><section className="column">{liveFixture.data ? <Pitch fixture={liveFixture.data} recentEvents={liveSnapshot?.recentEvents ?? liveFixture.data.events.slice(-8)} selectedStory={latestSnapshotStories(liveSnapshot)[0] ?? null} snapshotEvidence={liveSnapshot?.evidence} title="Live pitch" subtitle="On air" /> : <div className="panel"><div className="empty-state">No live fixture is active yet.</div></div>}<div className="panel"><div className="panel__header"><div><span className="eyebrow">Snapshot story rail</span><h2>Live explainers</h2></div><span className="tag">{latestSnapshotStories(liveSnapshot).length} cards</span></div>{latestSnapshotStories(liveSnapshot).length > 0 ? <div className="story-rail">{latestSnapshotStories(liveSnapshot).map((story) => <article className={`story-card${story.kind === "set_piece" ? " story-card--radar" : ""}`} key={story.id}><div className="story-card__meta"><span>{story.kind.replaceAll("_", " ")}</span><span>{formatMinuteLabel(story.windowStart)}–{formatMinuteLabel(story.windowEnd)}</span></div><h3>{story.title}</h3><p>{story.summary}</p>{story.kind === "set_piece" && <div className="radar-cue">Watch next corner · {story.summary}</div>}<div className="story-card__footer"><span>{story.evidenceIds.length} evidence links</span><span>{structuralLabel(story)}</span></div></article>)}</div> : <div className="empty-state">Snapshot stories will appear once live snapshots start arriving.</div>}</div><FactTicker facts={liveFactsOrdered} language={replay.language} title="Verified facts ticker" /></section><section className="column"><div className="panel"><div className="panel__header"><div><span className="eyebrow">On air</span><h2>Approved storyline cards</h2></div><span className="tag">{liveApprovedStorylines.length} storylines</span></div>{liveApprovedStorylines.length > 0 ? <div className="story-rail" role="log" aria-live="polite">{liveApprovedStorylines.map((storyline) => { const headline = storylineText(storyline.headline, replay.language); const onAirLine = storylineText(storyline.onAirLine, replay.language); return <article className={`story-card${storyline.status === "retracted" ? " is-retracted" : ""}`} key={storyline.id}><div className="story-card__meta"><span>{storyline.triggerMinute}'</span><span>{storyline.status}</span></div><h3>{headline.text}</h3>{headline.fallback && <span className="tag tag--ghost">translation unavailable</span>}<p>{onAirLine.text}</p>{onAirLine.fallback && <span className="tag tag--ghost">translation unavailable</span>}{storyline.status === "retracted" && <div className="banner banner--warning">{storyline.retractionReason ?? "Retracted by the studio desk."}</div>}<div className="control-row"><button type="button" className="button" onClick={() => downloadJson(`${storyline.matchId}-${storyline.id}-overlay.json`, { storylineId: storyline.id, matchId: storyline.matchId, minute: storyline.triggerMinute, headline: storyline.headline, overlay: storyline.overlay, onAirLine: storyline.onAirLine, claimSources: storyline.claims.flatMap((claim) => claim.sources), version: storyline.version })}>Export overlay JSON</button></div></article>; })}</div> : <div className="empty-state">Approved studio storylines will appear here once the producer desk sends them on air.</div>}</div></section></div>}
    </div>
  );
}
