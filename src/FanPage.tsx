import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Language, MatchEvent, MatchFixture, MatchSnapshot, NarrativeResponse, Persona, StoryCard, TeamId } from "../shared/types.js";
import type { LiveMessage, Storyline, VerifiedFact } from "../shared/platform.js";
import { analysePlayers } from "../shared/playerStats.js";
import { filterByPeriod, PERIOD_LABEL, periodBoundary } from "../shared/periods.js";
import { latestRevisions, type HighlightFocus } from "../shared/highlights.js";
import {
  alertKey,
  changesSince,
  clubPreferenceFor,
  createFanCursor,
  FAN_CURSOR_KEY,
  favoritePlayerOf,
  loadFanPrefs,
  newPlayerAlerts,
  parseFanCursor,
  playerTimeline,
  prioritiseFanFeed,
  resolveFavoritePlayer,
  resolveFavoriteTeam,
  saveFanPrefs,
  type FanChange,
  type FanCursor,
  type FanFocus,
  type FanPrefs,
  type StorageLike
} from "../shared/fan.js";
import { api } from "./api.js";
import { FactTicker, LiveStats, Panel, Pitch } from "./components.js";
import { HighlightReelPanel } from "./HighlightReel.js";
import { useLiveStream, type LiveStreamState } from "./hooks/useLiveStream.js";
import type { ActiveMatchContext } from "./liveContext.js";
import { PeriodSelector, periodScopeMessage, scopedTitle } from "./PeriodSelector.js";
import {
  computeScoreFromEvents,
  eventSecond,
  formatClock,
  formatMinuteLabel,
  getErrorMessage,
  labelize,
  LANGUAGE_LABEL,
  LANGUAGES,
  liveTransportLabel,
  mergeById,
  outcomeLabel,
  sortFactsNewestFirst,
  storylineText,
  teamTint,
  type Theme
} from "./utils.js";

type FanPageProps = { context: ActiveMatchContext; theme: Theme; onOpenStudio: () => void };

const PERSONA_LABEL: Record<Persona, string> = { casual: "Casual fan", analyst: "Analyst", player: "Player focus" };
const PERSONAS: Persona[] = ["casual", "analyst", "player"];

function safeStorage(kind: "local" | "session"): StorageLike | undefined {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function phaseLabel(stream: LiveStreamState): string {
  switch (stream.phase) {
    case "open": return "Connected";
    case "connecting": return "Connecting…";
    case "reconnecting": return `Reconnecting (attempt ${stream.reconnectAttempt})…`;
    case "error": return "Stream error";
    case "closed": return "Disconnected";
    default: return "Idle";
  }
}

const CHANGE_LABEL: Record<FanChange["kind"], string> = {
  goal: "Goal",
  ruled_out: "Goal ruled out",
  red_card: "Red card",
  booking: "Booking",
  correction: "Correction",
  story: "Approved story",
  story_retracted: "Story withdrawn"
};

export function FanPage({ context, theme, onOpenStudio }: FanPageProps) {
  const { fixture, status } = context;
  const matchId = status?.matchId;
  const hasMatch = Boolean(fixture && matchId && status && status.state !== "idle" && status.fixtureId === fixture.id);

  // ---------------------------------------------------------------- preferences (browser-local, versioned)
  const [{ prefs, storageOk }, setPrefState] = useState(() => {
    const loaded = loadFanPrefs(safeStorage("local"));
    return { prefs: loaded.prefs, storageOk: loaded.persisted };
  });
  const updatePrefs = useCallback((patch: Partial<FanPrefs>) => {
    setPrefState((current) => {
      const next: FanPrefs = { ...current.prefs, ...patch };
      if (!next.favoritePlayer) next.followPlayer = false;
      return { prefs: next, storageOk: saveFanPrefs(safeStorage("local"), next) };
    });
  }, []);

  const favoriteTeam = useMemo(() => (fixture ? resolveFavoriteTeam(fixture, prefs.favoriteClubId) : { inMatch: false }), [fixture, prefs.favoriteClubId]);
  const favoritePlayer = useMemo(() => (fixture ? resolveFavoritePlayer(fixture, prefs.favoritePlayer) : { inMatch: false }), [fixture, prefs.favoritePlayer]);
  const focus: FanFocus = useMemo(() => ({ teamId: favoriteTeam.teamId, playerId: favoritePlayer.player?.id }), [favoriteTeam.teamId, favoritePlayer.player?.id]);
  const streamClubId = favoriteTeam.inMatch ? prefs.favoriteClubId : undefined;
  const streamPlayerId = favoritePlayer.player?.id;
  const halvesUnavailable = fixture ? !periodBoundary(fixture).available : false;
  const period = halvesUnavailable ? "full" : prefs.period;

  // ---------------------------------------------------------------- fan stream (only while Fan View is mounted)
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [storylines, setStorylines] = useState<Storyline[]>([]);
  const [facts, setFacts] = useState<VerifiedFact[]>([]);
  const matchRef = useRef<string | undefined>(matchId);
  matchRef.current = matchId;

  const onMessage = useCallback((message: LiveMessage) => {
    const current = matchRef.current;
    if (message.type === "snapshot") {
      if (message.status.matchId && current && message.status.matchId !== current) return;
      setSnapshot(message.snapshot);
    } else if (message.type === "storyline") {
      if (current && message.storyline.matchId !== current) return;
      setStorylines((list) => mergeById(list, message.storyline));
    } else if (message.type === "fact") {
      if (current && message.fact.matchId !== current) return;
      setFacts((list) => sortFactsNewestFirst(mergeById(list, message.fact)));
    }
  }, []);

  const stream = useLiveStream({
    enabled: true,
    role: "fan",
    persona: prefs.persona,
    language: prefs.language,
    favoritePlayerId: streamPlayerId,
    favoriteClubId: streamClubId,
    period,
    onMessage
  });

  // ---------------------------------------------------------------- AI summary (on demand, stale replies dropped)
  const [summary, setSummary] = useState<NarrativeResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const summaryToken = useRef(0);
  const summaryIdentity = `${matchId ?? "-"}|${prefs.persona}|${prefs.language}|${streamClubId ?? "-"}|${streamPlayerId ?? "-"}`;

  useEffect(() => {
    summaryToken.current += 1;
    setSummary(null);
    setSummaryError(null);
    setSummaryLoading(false);
  }, [summaryIdentity]);

  async function requestSummary() {
    const token = ++summaryToken.current;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const result = await api.narrateLive({
        persona: prefs.persona === "analyst" ? "analyst" : "casual",
        language: prefs.language,
        ...(streamPlayerId ? { favoritePlayerId: streamPlayerId } : {}),
        ...(streamClubId ? { favoriteClubId: streamClubId } : {})
      });
      if (token === summaryToken.current) setSummary(result);
    } catch (error: unknown) {
      if (token === summaryToken.current) setSummaryError(getErrorMessage(error));
    } finally {
      if (token === summaryToken.current) setSummaryLoading(false);
    }
  }

  // ---------------------------------------------------------------- match change: clear everything tied to the old match
  const [alerts, setAlerts] = useState<MatchEvent[]>([]);
  const seenAlerts = useRef<Set<string>>(new Set());
  const alertsPrimedFor = useRef<string | null>(null);
  const [cursor, setCursor] = useState<FanCursor | null>(() => {
    try { return parseFanCursor(safeStorage("session")?.getItem(FAN_CURSOR_KEY) ?? null); } catch { return null; }
  });
  const previousMatch = useRef<string | undefined>(matchId);

  useEffect(() => {
    if (previousMatch.current === matchId) return;
    previousMatch.current = matchId;
    setSnapshot(null);
    setStorylines([]);
    setFacts([]);
    setAlerts([]);
    seenAlerts.current = new Set();
    alertsPrimedFor.current = null;
    setCursor((current) => (current && current.matchId === matchId ? current : null));
  }, [matchId]);

  // In-app favourite-player alerts; existing moments are primed silently so opening the view does not flood alerts.
  useEffect(() => {
    if (!fixture || !matchId) return;
    const primeKey = `${matchId}|${streamPlayerId ?? "-"}`;
    const fresh = newPlayerAlerts(fixture.events, streamPlayerId, seenAlerts.current);
    for (const event of fresh) seenAlerts.current.add(alertKey(event));
    if (alertsPrimedFor.current !== primeKey) {
      alertsPrimedFor.current = primeKey;
      return;
    }
    if (fresh.length > 0) setAlerts((current) => [...fresh.reverse(), ...current].slice(0, 5));
  }, [fixture, matchId, streamPlayerId]);

  // "What changed since you last looked": remember what was on screen when the fan leaves the view.
  const latest = useRef<{ matchId?: string; events: MatchEvent[]; storylines: Storyline[] }>({ events: [], storylines: [] });
  latest.current = { matchId, events: fixture?.events ?? [], storylines };
  useEffect(() => {
    const save = () => {
      const { matchId: id, events, storylines: seen } = latest.current;
      if (!id) return;
      try { safeStorage("session")?.setItem(FAN_CURSOR_KEY, JSON.stringify(createFanCursor(id, events, seen))); } catch { /* session storage unavailable */ }
    };
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("pagehide", save); save(); };
  }, []);

  // ---------------------------------------------------------------- derived view
  const scopedSnapshot = snapshot && fixture && snapshot.fixtureId === fixture.id && (snapshot.scope?.period ?? "full") === period ? snapshot : null;
  const score = (snapshot && fixture && snapshot.fixtureId === fixture.id ? snapshot.score : null) ?? computeScoreFromEvents(fixture);
  const clockSecond = context.analyzedThrough ?? status?.clockSecond ?? 0;
  const uptoSecond = context.analyzedThrough ?? (status?.state === "running" ? status.clockSecond : fixture?.durationSeconds ?? 0);
  const approved = useMemo(() => storylines.filter((item) => item.status === "approved").sort((a, b) => b.triggerMinute - a.triggerMinute), [storylines]);
  const retractedCount = storylines.filter((item) => item.status === "retracted").length;
  const changes = useMemo(() => (matchId && fixture ? changesSince(cursor, matchId, fixture.events, storylines) : []), [cursor, matchId, fixture, storylines]);
  const players = useMemo(() => new Map(fixture ? [...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]) : []), [fixture]);
  // A favourite player gets their own reel; otherwise a favourite club's; otherwise the match reel.
  const reelFocus = useMemo<HighlightFocus>(() => (focus.playerId ? { playerId: focus.playerId } : focus.teamId ? { teamId: focus.teamId } : {}), [focus.playerId, focus.teamId]);

  if (!hasMatch || !fixture || !status) {
    return (
      <main className="page fan-page">
        <section className="panel empty-hero" aria-labelledby="fan-empty-title">
          <span className="eyebrow">Fan View</span>
          <h2 id="fan-empty-title">No match is live right now</h2>
          <p className="subtle-text">Fan View follows the match running on the Studio Desk. The producer starts the match there; this view never starts or stops one. Your preferences are kept for when it kicks off.</p>
          <button type="button" className="button button--primary" onClick={onOpenStudio}>Open Studio Desk</button>
        </section>
      </main>
    );
  }

  const finishedLabel = context.analysisStoppedEarly ? "Analysis stopped" : "Full time";
  const teamName = (teamId: TeamId) => (teamId === "home" ? fixture.home.name : fixture.away.name);
  const scopeMessage = periodScopeMessage(scopedSnapshot?.scope);

  return (
    <main className="page fan-page">
      <FanPreferences fixture={fixture} prefs={prefs} storageOk={storageOk} favoriteTeamInMatch={favoriteTeam.inMatch} favoritePlayerInMatch={favoritePlayer.inMatch}
        halvesUnavailable={halvesUnavailable} period={period} onChange={updatePrefs} />

      <section className="broadcast-bar fan-header" aria-label="Match status">
        <div className="broadcast-bar__score">
          <span className={`broadcast-bar__team${focus.teamId === "home" ? " is-favorite" : ""}`}>{fixture.home.name}</span>
          <strong className="broadcast-bar__digits" aria-live="polite">{score.home} – {score.away}</strong>
          <span className={`broadcast-bar__team${focus.teamId === "away" ? " is-favorite" : ""}`}>{fixture.away.name}</span>
        </div>
        <div className="broadcast-bar__meta">
          <span className={`live-pill live-pill--${status.state}`}>{status.state === "running" ? "Live" : status.state === "finished" ? finishedLabel : "Idle"}</span>
          <span className="mono broadcast-bar__clock">{formatClock(clockSecond)}</span>
          <span className="tag">{liveTransportLabel(status)}</span>
          <span className={`tag${stream.phase === "open" ? " tag--success" : stream.phase === "reconnecting" || stream.phase === "error" ? " tag--danger" : ""}`} role="status">{phaseLabel(stream)}</span>
        </div>
      </section>
      {context.analyzedThrough !== undefined && (
        <p className="banner banner--warning">Video analysis has reached {formatClock(context.analyzedThrough)}. Score and events are AI-detected and provisional; they reflect analysed footage, not your local playback.{context.analysisStoppedEarly ? " Analysis stopped early — this is not full time." : ""}</p>
      )}
      {period !== "full" && scopedSnapshot?.periodScore && (
        <p className="subtle-text">Goals in the {PERIOD_LABEL[period]}: {fixture.home.shortName} {scopedSnapshot.periodScore.home}–{scopedSnapshot.periodScore.away} {fixture.away.shortName} · match score {score.home}–{score.away}</p>
      )}

      {alerts.length > 0 && (
        <section className="fan-alerts" aria-label="Favourite player alerts" aria-live="polite">
          {alerts.map((event) => (
            <div key={alertKey(event)} className="banner banner--info fan-alert">
              <strong>{players.get(event.playerId)?.name ?? "Your player"}</strong> · {labelize(event.type)} ({outcomeLabel(event)}) at {formatMinuteLabel(eventSecond(event))}
              <button type="button" className="link-button" onClick={() => setAlerts((current) => current.filter((item) => alertKey(item) !== alertKey(event)))}>Dismiss</button>
            </div>
          ))}
        </section>
      )}

      {cursor && cursor.matchId === matchId && (
        <Panel eyebrow="Since you last looked" title="What changed" className="fan-changes" aside={<button type="button" className="button button--ghost button--small" onClick={() => setCursor(createFanCursor(matchId!, fixture.events, storylines))}>Mark as seen</button>}>
          {changes.length === 0 ? <div className="empty-state">Nothing significant since you last looked.</div> : (
            <ul className="fan-list">
              {changes.map((change) => (
                <li key={`${change.kind}-${change.id}`} className="fan-list__item">
                  <span className="mono">{change.minute}'</span>
                  <span className={`tag${change.kind === "ruled_out" || change.kind === "red_card" || change.kind === "story_retracted" ? " tag--danger" : change.kind === "goal" || change.kind === "story" ? " tag--accent" : ""}`}>{CHANGE_LABEL[change.kind]}</span>
                  <span>{change.storylineId
                    ? storylineText((storylines.find((item) => item.id === change.storylineId)?.headline) ?? { en: "", es: "", fr: "", pt: "" }, prefs.language).text
                    : `${change.playerId ? players.get(change.playerId)?.name ?? "" : ""}${change.teamId ? ` · ${teamName(change.teamId)}` : ""}`}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <div className="fan-grid">
        <div className="desk-col">
          <Panel eyebrow={scopedTitle("My match", period)} title={focus.playerId || focus.teamId ? "Your moments first" : "Key moments"}>
            <FanFeed fixture={fixture} focus={focus} period={period} players={players} />
          </Panel>

          {prefs.followPlayer && (
            <FollowPlayerPanel fixture={fixture} prefs={prefs} playerId={favoritePlayer.player?.id} period={period} uptoSecond={uptoSecond} />
          )}

          <Panel eyebrow="Producer-approved" title="Approved stories" aside={<span className="tag">{approved.length}</span>}>
            {retractedCount > 0 && <p className="subtle-text">{retractedCount} {retractedCount === 1 ? "story was" : "stories were"} withdrawn after a correction and removed.</p>}
            {approved.length === 0 ? <div className="empty-state">Stories appear here once the producer approves them in the studio.</div> : (
              <ul className="fan-list">
                {approved.map((storyline) => {
                  const headline = storylineText(storyline.headline, prefs.language);
                  const line = storylineText(storyline.onAirLine, prefs.language);
                  return (
                    <li key={storyline.id} className="fan-story">
                      <span className="fan-story__meta"><span className="mono">{storyline.triggerMinute}'</span>{(headline.fallback || line.fallback) && <span className="tag" title="No translation is available yet; showing the approved English copy">English fallback</span>}</span>
                      <strong>{headline.text}</strong>
                      <span>{line.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {facts.some((fact) => !fact.retracted) && (
              <details className="disclosure disclosure--compact">
                <summary>Verified facts behind these stories</summary>
                <FactTicker facts={facts.filter((fact) => !fact.retracted)} language={prefs.language} />
              </details>
            )}
          </Panel>
        </div>

        <div className="desk-col">
          <Panel eyebrow={scopedTitle("Why it matters", period)} title={PERSONA_LABEL[prefs.persona]} aside={scopedSnapshot && <span className="tag">{scopedSnapshot.stories.length} insights</span>}>
            {scopeMessage ? <div className="empty-state" role="status">{scopeMessage}</div> : !scopedSnapshot ? <div className="skeleton" aria-label="Loading insights" /> : (
              <>
                {prefs.persona === "analyst" ? <LiveStats snapshot={scopedSnapshot} fixture={fixture} /> : <CasualStats snapshot={scopedSnapshot} fixture={fixture} />}
                <WhyItMatters stories={scopedSnapshot.stories} snapshot={scopedSnapshot} persona={prefs.persona} players={players} />
              </>
            )}
            {scopedSnapshot?.focus?.favoriteClubInMatch === false && <p className="subtle-text">Your favourite club is not in this match; coverage is neutral.</p>}
          </Panel>

          <Panel eyebrow="AI summary" title="My match summary" aside={summary && <span className="tag">{summary.claims.length} grounded claims</span>}>
            <p className="subtle-text">Written on demand by the Foundry narrator for your persona, language and favourites from the verified feed. An AI summary, not producer-approved broadcast copy. Always covers the full match.</p>
            <div className="recap-controls">
              <button type="button" className="button button--primary" onClick={() => void requestSummary()} disabled={!context.aiReady || summaryLoading}>{summaryLoading ? "Writing…" : summary ? "Refresh my summary" : "My match summary"}</button>
            </div>
            {!context.aiReady && <div className="banner banner--info">AI narration isn't configured on this server, so personal summaries are unavailable.</div>}
            {summaryError && <div className="banner banner--danger" role="alert">{summaryError}</div>}
            {summary && (
              <article className={`recap${summaryLoading ? " is-stale" : ""}`}>
                <div className="recap__head"><h3>{summary.title}</h3><span className="tag tag--accent">AI summary</span></div>
                <p className="recap__script">{summary.script}</p>
                {summary.audioUrl && <audio className="recap__audio" controls preload="none" src={summary.audioUrl} aria-label="Listen to my match summary" />}
              </article>
            )}
          </Panel>
        </div>
      </div>

      <HighlightReelPanel key={`${fixture.id}-${prefs.language}`} fixture={fixture} storylines={approved} uptoSecond={uptoSecond} theme={theme} footage={context.footage}
        onOpenVideoLab={onOpenStudio} focus={reelFocus} period={period} title="My moments" initialLanguage={prefs.language}
        intro={<p>{reelFocus.playerId
          ? `${favoritePlayer.player?.name ?? "Your player"}'s own reel: their goals, shots, chances created, saves, tackles won and hardest passes${period === "full" ? "" : ` in the ${PERIOD_LABEL[period].toLowerCase()}`}.`
          : reelFocus.teamId
            ? `${teamName(reelFocus.teamId)}'s biggest moments, plus every goal and red card in the match${period === "full" ? "" : ` in the ${PERIOD_LABEL[period].toLowerCase()}`}.`
            : `Every goal, red card, ruled-out goal and big moment${period === "full" ? "" : ` in the ${PERIOD_LABEL[period].toLowerCase()}`}, chosen by the same rules as the studio reel.`}{" "}
          {context.footage ? "Cut from footage that is on this device only." : "Rendered from the event data; no footage is shared with Fan View."}</p>} />

      <p className="subtle-text fan-footnote">Fan View is a read-only view of the match on the Studio Desk. It only shows producer-approved stories; the agents' drafts and traces stay in the studio.</p>
    </main>
  );
}

// ------------------------------------------------------------------ preferences bar

type FanPreferencesProps = {
  fixture: MatchFixture;
  prefs: FanPrefs;
  storageOk: boolean;
  favoriteTeamInMatch: boolean;
  favoritePlayerInMatch: boolean;
  halvesUnavailable: boolean;
  period: FanPrefs["period"];
  onChange: (patch: Partial<FanPrefs>) => void;
};

function FanPreferences({ fixture, prefs, storageOk, favoriteTeamInMatch, favoritePlayerInMatch, halvesUnavailable, period, onChange }: FanPreferencesProps) {
  const team = resolveFavoriteTeam(fixture, prefs.favoriteClubId).teamId;
  const clubValue = !prefs.favoriteClubId ? "none" : team ?? "saved";
  const player = resolveFavoritePlayer(fixture, prefs.favoritePlayer).player;
  const playerValue = !prefs.favoritePlayer ? "" : player?.id ?? "__saved";
  return (
    <section className="panel fan-prefs" aria-label="Your preferences">
      <div className="fan-prefs__row">
        <div className="field">
          <span id="fan-persona-label">View as</span>
          <div className="segmented segmented--compact" role="group" aria-labelledby="fan-persona-label">
            {PERSONAS.map((persona) => (
              <button key={persona} type="button" className={`segmented__item${prefs.persona === persona ? " is-active" : ""}`} aria-pressed={prefs.persona === persona} onClick={() => onChange({ persona })}>{PERSONA_LABEL[persona]}</button>
            ))}
          </div>
        </div>
        <label className="field"><span>Language</span>
          <select value={prefs.language} onChange={(event) => onChange({ language: event.target.value as Language })}>
            {LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABEL[item]}</option>)}
          </select>
        </label>
        <label className="field"><span>Favourite club</span>
          <select value={clubValue} onChange={(event) => {
            const value = event.target.value;
            if (value === "saved") return;
            // Choosing a club never clears a favourite player from the other side.
            onChange({ favoriteClubId: value === "home" || value === "away" ? clubPreferenceFor(fixture, value) : undefined });
          }}>
            <option value="none">No favourite (neutral)</option>
            <option value="home">{fixture.home.name}</option>
            <option value="away">{fixture.away.name}</option>
            {clubValue === "saved" && <option value="saved">Saved club (not in this match)</option>}
          </select>
        </label>
        <label className="field"><span>Favourite player</span>
          <select value={playerValue} onChange={(event) => {
            const value = event.target.value;
            if (value === "__saved") return;
            const picked = [...fixture.home.players, ...fixture.away.players].find((item) => item.id === value);
            onChange({ favoritePlayer: picked ? favoritePlayerOf(picked) : undefined });
          }}>
            <option value="">No favourite player</option>
            {playerValue === "__saved" && prefs.favoritePlayer && <option value="__saved">{prefs.favoritePlayer.name} (not in this match)</option>}
            {(["home", "away"] as const).map((side) => (
              <optgroup key={side} label={fixture[side].name}>
                {fixture[side].players.slice().sort((a, b) => a.number - b.number).map((item) => <option key={item.id} value={item.id}>{item.number}. {item.name} · {item.position}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="switch fan-prefs__follow">
          <input type="checkbox" checked={prefs.followPlayer} disabled={!prefs.favoritePlayer} onChange={(event) => onChange({ followPlayer: event.target.checked })} aria-describedby="fan-follow-hint" />
          <span>Follow one player</span>
        </label>
        <PeriodSelector value={period} onChange={(next) => onChange({ period: next })} halvesUnavailable={halvesUnavailable} label="Fan View period" className="fan-prefs__period" />
      </div>
      <p id="fan-follow-hint" className="subtle-text">
        {!prefs.favoritePlayer ? "Pick a favourite player to follow them." : favoritePlayerInMatch ? "Follow mode shows your player's logged actions." : `${prefs.favoritePlayer.name} is not in this match; coverage is neutral and no other player is substituted.`}
        {prefs.favoriteClubId && !favoriteTeamInMatch ? " Your saved club is not in this match." : ""}
        {halvesUnavailable ? " Halves are unavailable for clip-derived footage." : ""}
      </p>
      {!storageOk && <p className="banner banner--warning" role="status">Preferences can't be saved in this browser; they apply for this session only.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ feed

function FanFeed({ fixture, focus, period, players }: { fixture: MatchFixture; focus: FanFocus; period: FanPrefs["period"]; players: Map<string, { name: string }> }) {
  const items = useMemo(() => {
    const boundary = periodBoundary(fixture);
    const latestEvents = latestRevisions(fixture.events);
    const scoped = period === "full" || !boundary.available ? latestEvents : filterByPeriod(latestEvents, period, boundary);
    return prioritiseFanFeed(scoped, focus, 24);
  }, [fixture, focus, period]);
  if (items.length === 0) return <div className="empty-state">Moments appear here as the match plays.</div>;
  return (
    <ol className="event-list" aria-live="polite">
      {items.map(({ event, relevance }) => (
        <li key={`${event.id}-${event.revision}`} className={`event-row event-row--${event.type}${event.rescinded ? " is-rescinded" : ""}${relevance === "player" || relevance === "club" ? " is-favorite" : ""}`}>
          <span className="event-row__time mono">{formatClock(eventSecond(event))}</span>
          <span className="event-row__team" style={{ background: teamTint(event.teamId) }} aria-hidden="true" />
          <span className="event-row__body">
            <strong>{event.type === "goal" && event.rescinded ? "Goal ruled out" : labelize(event.type)}</strong>
            <span>{players.get(event.playerId)?.name ?? "Unknown player"} · {outcomeLabel(event)}</span>
          </span>
          {relevance === "player" && <span className="tag tag--accent">Your player</span>}
          {relevance === "club" && <span className="tag">Your club</span>}
          {event.rescinded && <span className="tag tag--danger">Ruled out</span>}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ why it matters

function CasualStats({ snapshot, fixture }: { snapshot: MatchSnapshot; fixture: MatchFixture }) {
  const rows = [
    { label: "Shots", home: snapshot.stats.home.shots, away: snapshot.stats.away.shots },
    { label: "Corners", home: snapshot.stats.home.corners, away: snapshot.stats.away.corners },
    { label: "Cards", home: snapshot.stats.home.yellowCards + snapshot.stats.home.redCards, away: snapshot.stats.away.yellowCards + snapshot.stats.away.redCards }
  ];
  return (
    <dl className="fan-spotlight" aria-label="Match at a glance">
      {rows.map((row) => (
        <div key={row.label}><dt>{row.label}</dt><dd><span className="mono">{row.home}</span> {fixture.home.shortName} · {fixture.away.shortName} <span className="mono">{row.away}</span></dd></div>
      ))}
    </dl>
  );
}

function WhyItMatters({ stories, snapshot, persona, players }: { stories: StoryCard[]; snapshot: MatchSnapshot; persona: Persona; players: Map<string, { name: string }> }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (stories.length === 0) return <div className="empty-state">Insights appear once the feed has enough evidence.</div>;
  return (
    <ul className="fan-list">
      {stories.map((story) => {
        const showEvidence = persona === "analyst" || expanded === story.id;
        return (
          <li key={story.id} className={`fan-insight${story.favorite ? " is-favorite" : ""}`}>
            <span className="fan-story__meta">
              <span className={`tag${story.confidence === "observed" ? " tag--success" : ""}`}>{story.confidence === "observed" ? "Observed" : "Inferred"}</span>
              {story.favorite && <span className="tag tag--accent">Your club</span>}
              {persona === "analyst" && <span className="mono">{formatMinuteLabel(story.windowStart)}–{formatMinuteLabel(story.windowEnd)}</span>}
            </span>
            <strong>{story.title}</strong>
            <span>{story.summary}</span>
            <span className="subtle-text">Why it matters: {story.whyItMatters}</span>
            {persona !== "casual" && story.metrics.length > 0 && (
              <span className="chips chips--start">{story.metrics.map((metric) => <span key={metric.label} className="tag tag--ghost">{metric.label}: <span className="mono">{metric.value}{metric.unit && metric.unit !== "events" ? ` ${metric.unit}` : ""}</span></span>)}</span>
            )}
            {persona !== "analyst" && story.evidenceIds.length > 0 && (
              <button type="button" className="link-button" aria-expanded={expanded === story.id} onClick={() => setExpanded(expanded === story.id ? null : story.id)}>{expanded === story.id ? "Hide evidence" : `Show evidence (${story.evidenceIds.length})`}</button>
            )}
            {showEvidence && story.evidenceIds.length > 0 && (
              <ul className="fan-evidence">
                {story.evidenceIds.slice(0, 8).map((id) => {
                  const event = snapshot.evidence[id];
                  return <li key={id}>{event ? `${formatMinuteLabel(eventSecond(event))} ${labelize(event.type)} · ${players.get(event.playerId)?.name ?? "Unknown"}` : id}</li>;
                })}
                {story.evidenceIds.length > 8 && <li>+{story.evidenceIds.length - 8} more</li>}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ follow one player

function FollowPlayerPanel({ fixture, prefs, playerId, period, uptoSecond }: { fixture: MatchFixture; prefs: FanPrefs; playerId?: string; period: FanPrefs["period"]; uptoSecond: number }) {
  const timeline = useMemo(() => (playerId ? playerTimeline(fixture, playerId, period, uptoSecond) : []), [fixture, playerId, period, uptoSecond]);
  const analysis = useMemo(() => (playerId ? analysePlayers(fixture, uptoSecond, period).find((entry) => entry.player.id === playerId) : undefined), [fixture, playerId, period, uptoSecond]);
  const name = analysis?.player.name ?? prefs.favoritePlayer?.name ?? "Your player";
  return (
    <Panel eyebrow={scopedTitle("Follow one player", period)} title={name}>
      <p className="subtle-text">Logged involvement from the event feed, not continuous tracking: off-ball movement is not recorded.</p>
      {!playerId ? <div className="empty-state">{prefs.favoritePlayer?.name ?? "Your player"} is not in this match.</div> : timeline.length === 0 ? (
        <div className="empty-state">No logged actions for {name} in the {PERIOD_LABEL[period].toLowerCase()} yet.</div>
      ) : (
        <>
          {analysis && (
            <dl className="fan-spotlight" aria-label={`${name} key stats`}>
              <div><dt>Actions</dt><dd className="mono">{analysis.involvements}</dd></div>
              <div><dt>Goals</dt><dd className="mono">{analysis.goals}</dd></div>
              <div><dt>Shots</dt><dd className="mono">{analysis.shots}</dd></div>
              <div><dt>Passes</dt><dd className="mono">{analysis.passesCompleted}/{analysis.passes}</dd></div>
              <div><dt>Tackles won</dt><dd className="mono">{analysis.tacklesWon}</dd></div>
              <div><dt>Cards</dt><dd className="mono">{analysis.yellowCards + analysis.redCards}</dd></div>
            </dl>
          )}
          <div className="fan-follow__map">
            <Pitch fixture={fixture} events={timeline} highlightIds={timeline.map((event) => event.id)} />
          </div>
          <ol className="event-list">
            {timeline.slice().reverse().slice(0, 15).map((event) => (
              <li key={`${event.id}-${event.revision}`} className={`event-row event-row--${event.type}${event.rescinded ? " is-rescinded" : ""}`}>
                <span className="event-row__time mono">{formatClock(eventSecond(event))}</span>
                <span className="event-row__team" style={{ background: teamTint(event.teamId) }} aria-hidden="true" />
                <span className="event-row__body"><strong>{labelize(event.type)}</strong><span>{outcomeLabel(event)}</span></span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}
