import { useEffect, useMemo, useRef, useState } from "react";
import { analysePlayers, heatGrid, IMPACT_RATING_FORMULA, IMPACT_WEIGHTS, TRACKING_METRICS, type PlayerAnalysis } from "../shared/playerStats.js";
import { PASS_DIFFICULTY_FORMULA, PROGRESSIVE_PASS_HINT, PROGRESSIVE_PASS_LABEL } from "../shared/metrics.js";
import { PERIOD_LABEL, periodBoundary, periodScope } from "../shared/periods.js";
import type { Language, MatchFixture, MatchPeriod, TeamId } from "../shared/types.js";
import { api, type PlayerNote } from "./api.js";
import { PeriodSelector, periodScopeMessage } from "./PeriodSelector.js";
import { getErrorMessage, LANGUAGE_LABEL, LANGUAGES, teamTint } from "./utils.js";

type Props = {
  fixture: MatchFixture | null;
  clockSecond: number;
  aiReady: boolean;
  onOpenLiveDesk: () => void;
  period?: MatchPeriod;
  onPeriodChange?: (period: MatchPeriod) => void;
};
type MapMode = "heat" | "actions";
type SortMode = "impact" | "number";

const toY = (y: number) => (y / 100) * 68;

function ratingTone(rating: number): string {
  if (rating >= 7.5) return "excellent";
  if (rating >= 6.6) return "good";
  if (rating >= 5.8) return "neutral";
  return "poor";
}

function PitchLines() {
  return (
    <>
      <rect x="1" y="1" width="98" height="66" rx="3" fill="var(--cp-surface-soft)" stroke="var(--cp-border-strong)" strokeWidth="0.8" />
      <path d="M50 1v66" stroke="var(--cp-border)" strokeWidth="0.6" />
      <circle cx="50" cy="34" r="9" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
      <rect x="1" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
      <rect x="83" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
      <rect x="1" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
      <rect x="94" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
    </>
  );
}

function PlayerMap({ analysis, mode }: { analysis: PlayerAnalysis; mode: MapMode }) {
  const grid = useMemo(() => heatGrid(analysis.touches, 16, 10), [analysis]);
  const tint = teamTint(analysis.teamId);
  return (
    <svg viewBox="0 0 100 68" className="pa-map" role="img" aria-label={`${analysis.player.name} ${mode === "heat" ? "heat map" : "action map"}`}>
      <defs>
        <filter id="pa-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.6" /></filter>
        <clipPath id="pa-clip"><rect x="1" y="1" width="98" height="66" rx="3" /></clipPath>
      </defs>
      <PitchLines />
      {mode === "heat" ? (
        <g filter="url(#pa-blur)" clipPath="url(#pa-clip)">
          {grid.flatMap((row, r) => row.map((value, c) => value > 0 && (
            <rect key={`${r}-${c}`} x={(c / 16) * 100 - 1} y={(r / 10) * 68 - 1} width={100 / 16 + 2} height={68 / 10 + 2}
              fill={`hsl(${Math.round(110 - 110 * value)} 95% 50%)`} opacity={0.25 + 0.65 * value} />
          )))}
        </g>
      ) : (
        <g>
          {analysis.touches.map((touch, index) => {
            const failed = touch.outcome === "incomplete" || touch.outcome === "miss" || touch.outcome === "blocked";
            const shape = touch.type === "shot" || touch.type === "goal";
            return shape
              ? <path key={index} d={`M${touch.x} ${toY(touch.y) - 1.6} l1.6 2.8 h-3.2z`} fill={touch.type === "goal" ? "var(--cp-success)" : tint} stroke="var(--cp-bg)" strokeWidth="0.3" />
              : <circle key={index} cx={touch.x} cy={toY(touch.y)} r={1.05} fill={failed ? "none" : tint} stroke={tint} strokeWidth="0.45" opacity={0.85} />;
          })}
        </g>
      )}
      {analysis.averagePosition && (
        <g>
          <circle cx={analysis.averagePosition.x} cy={toY(analysis.averagePosition.y)} r="2.6" fill="var(--cp-bg)" stroke={tint} strokeWidth="0.7" />
          <text x={analysis.averagePosition.x} y={toY(analysis.averagePosition.y) + 1} textAnchor="middle" className="pa-map__number">{analysis.player.number || "•"}</text>
        </g>
      )}
    </svg>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  // Hints are inline text, not hover-only titles, so they work on touch screens.
  return <div className="pa-stat"><span>{label}</span><strong>{value}</strong>{hint && <small className="pa-stat__hint">{hint}</small>}</div>;
}

/** Sprint counts are hidden in the UI; the synthetic one-sample-per-minute feed cannot support them. */
const HIDDEN_TRACKING_KEYS = new Set(["sprints"]);

/** UI labels for the tracked physical tiles; the synthetic feed only supports minute aggregates and milestones. */
const TRACKING_LABEL: Record<string, string> = {
  distance: "Distance (synthetic minute aggregate)",
  top_speed: "Top speed (synthetic peak-speed milestone)"
};

/** A tracked physical figure for a TRACKING_METRICS tile, or null when this player has no tracking value. */
function physicalValue(analysis: PlayerAnalysis, key: string): string | null {
  if (key === "distance") return analysis.distanceCoveredM === null ? null : `${(analysis.distanceCoveredM / 1000).toFixed(2)} km`;
  if (key === "top_speed") return analysis.topSpeedKmh === null ? null : `${analysis.topSpeedKmh.toFixed(1)} km/h`;
  return null;
}

export function PlayerAnalysisPage({ fixture, clockSecond, aiReady, onOpenLiveDesk, period = "full", onPeriodChange }: Props) {
  const [team, setTeam] = useState<TeamId>("home");
  const [sort, setSort] = useState<SortMode>("impact");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("heat");
  const [language, setLanguage] = useState<Language>("en");
  const [note, setNote] = useState<PlayerNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteRequest = useRef(0);

  const analyses = useMemo(() => (fixture ? analysePlayers(fixture, clockSecond, period) : []), [fixture, clockSecond, period]);
  const halvesAvailable = useMemo(() => (fixture ? periodBoundary(fixture).available : true), [fixture]);
  const scope = fixture ? periodScope(fixture, period, clockSecond) : undefined;
  const scopeMessage = periodScopeMessage(scope);
  const squad = useMemo(() => analyses.filter((entry) => entry.teamId === team).sort((a, b) => sort === "impact"
    ? b.impact.rating - a.impact.rating || b.involvements - a.involvements
    : (a.player.number || 99) - (b.player.number || 99)), [analyses, team, sort]);
  const selected = analyses.find((entry) => entry.player.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId || !analyses.some((entry) => entry.player.id === selectedId)) {
      const best = [...analyses].sort((a, b) => b.impact.rating - a.impact.rating)[0];
      setSelectedId(best?.player.id ?? null);
      if (best) setTeam(best.teamId);
    }
  }, [analyses, selectedId]);
  // A note describes one player, language, period and match; any change makes it stale.
  useEffect(() => { noteRequest.current += 1; setNote(null); setNoteError(null); setNoteLoading(false); }, [selectedId, language, period, fixture?.id]);

  async function writeNote() {
    if (!selected) return;
    const token = ++noteRequest.current;
    setNoteLoading(true);
    setNoteError(null);
    try {
      const next = await api.analysePlayer(selected.player.id, language, period);
      if (token !== noteRequest.current || (next?.period ?? "full") !== period) return;
      setNote(next);
    } catch (error) {
      if (token === noteRequest.current) setNoteError(getErrorMessage(error));
    } finally {
      if (token === noteRequest.current) setNoteLoading(false);
    }
  }

  if (!fixture) {
    return (
      <div className="panel empty-hero">
        <h2>No match yet</h2>
        <p className="subtle-text">Start a match on the live desk. Every player's numbers, heat map and illustrative activity score build up from the live feed.</p>
        <button type="button" className="button button--primary" onClick={onOpenLiveDesk}>Go to live desk</button>
      </div>
    );
  }

  const teams = { home: fixture.home, away: fixture.away };
  const maxImpact = Math.max(0.5, ...(selected?.impact.components.map((component) => Math.abs(component.value)) ?? [0]));

  return (
    <div className="pa-grid">
      <section className="panel pa-squads" aria-labelledby="pa-squads-title">
        <header className="panel__header">
          <div><span className="eyebrow">Squads · {PERIOD_LABEL[period]}</span><h2 id="pa-squads-title">Players</h2></div>
          <label className="inline-select"><span className="sr-only">Sort players</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="impact">By illustrative activity score</option><option value="number">By shirt number</option></select>
          </label>
        </header>
        {onPeriodChange && <PeriodSelector value={period} onChange={onPeriodChange} halvesUnavailable={!halvesAvailable} className="pa-period-toggle" />}
        {!halvesAvailable && <p className="subtle-text">Halves are unavailable: this match has no reliable half-time marker (clip-derived footage uses a clip clock).</p>}
        <div className="segmented segmented--compact pa-team-toggle" role="tablist" aria-label="Team">
          {(["home", "away"] as TeamId[]).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={team === id} className={`segmented__item${team === id ? " is-active" : ""}`} onClick={() => setTeam(id)}>
              <i className={`swatch swatch--${id}`} />{teams[id].name}
            </button>
          ))}
        </div>
        <ul className="pa-squad">
          {squad.map((entry) => (
            <li key={entry.player.id}>
              <button type="button" className={`pa-row${entry.player.id === selectedId ? " is-active" : ""}`} onClick={() => setSelectedId(entry.player.id)} aria-pressed={entry.player.id === selectedId}>
                <span className="pa-row__number mono" style={{ borderColor: teamTint(entry.teamId) }}>{entry.player.number || "–"}</span>
                <span className="pa-row__name">{entry.player.name}<small>{entry.player.position || "Player"} · {scopeMessage ? "—" : `${entry.involvements} actions`}</small></span>
                <span className={`pa-rating pa-rating--${scopeMessage ? "neutral" : ratingTone(entry.impact.rating)}`}>{scopeMessage ? "—" : entry.impact.rating.toFixed(1)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {scopeMessage ? (
        <section className="panel empty-hero" aria-live="polite">
          <h2>{scope?.reason === "not_started" ? "Not started" : "Period unavailable"}</h2>
          <p className="subtle-text">{scopeMessage}</p>
          {onPeriodChange && <button type="button" className="button" onClick={() => onPeriodChange("full")}>Show the full match</button>}
        </section>
      ) : selected ? (
        <section className="panel pa-detail" aria-labelledby="pa-player-title">
          <header className="pa-hero" style={{ borderColor: teamTint(selected.teamId) }}>
            <span className="pa-hero__number mono" style={{ background: teamTint(selected.teamId) }}>{selected.player.number || "–"}</span>
            <div className="pa-hero__name">
              <span className="eyebrow">{teams[selected.teamId].name} · {selected.player.position || "Player"}</span>
              <h2 id="pa-player-title">{selected.player.name}</h2>
              <p className="subtle-text">{selected.involvements} logged actions{period === "full" ? "" : ` in the ${PERIOD_LABEL[period]}`} · {selected.involvementShare}% of the team's · match clock {Math.floor(clockSecond / 60)}'</p>
            </div>
            <div className={`pa-hero__rating pa-rating--${ratingTone(selected.impact.rating)}`}>
              <strong>{selected.impact.rating.toFixed(1)}</strong><span>Illustrative activity score</span>
            </div>
          </header>

          <div className="pa-body">
            <div className="pa-map-card">
              <div className="pitch-toolbar">
                <div className="segmented segmented--compact" role="radiogroup" aria-label="Player map">
                  {(["heat", "actions"] as MapMode[]).map((mode) => (
                    <button key={mode} type="button" role="radio" aria-checked={mapMode === mode} className={`segmented__item${mapMode === mode ? " is-active" : ""}`} onClick={() => setMapMode(mode)}>{mode === "heat" ? "Heat map" : "Action map"}</button>
                  ))}
                </div>
                <span className="subtle-text">{selected.teamId === "home" ? "Attacking →" : "← Attacking"}</span>
              </div>
              <PlayerMap analysis={selected} mode={mapMode} />
              <p className="subtle-text pa-caption">{mapMode === "heat" ? "Density of the player's logged actions. Ringed number: average action position." : "● completed · ○ unsuccessful · ▲ shot · green ▲ goal"}</p>
            </div>

            <div className="pa-kpis">
              <div className="pa-group"><h3>Attacking</h3><div className="pa-stats">
                <Stat label="Goals" value={selected.goals} /><Stat label="Assists" value={selected.assists} />
                <Stat label="Shots" value={selected.shots} /><Stat label="On target" value={selected.shotsOnTarget} />
                <Stat label="illustrative xG" value={selected.xg.toFixed(2)} hint="Illustrative, uncalibrated shot-quality heuristic" /><Stat label="xG assisted (inferred creator)" value={selected.xa.toFixed(2)} hint="illustrative xG of shots this player is inferred to have set up" />
                <Stat label="Box touches" value={selected.touchesInBox ?? "—"} hint="Actions in the opposition penalty area" />
                <Stat label="Top shot speed" value={selected.topShotSpeedKmh === null ? "—" : `${Math.round(selected.topShotSpeedKmh)} km/h`} hint="Fastest shot from its recorded speed or its own ball-flight time and distance" />
              </div></div>
              <div className="pa-group"><h3>Passing</h3><div className="pa-stats">
                <Stat label="Completed" value={`${selected.passesCompleted}/${selected.passes}`} /><Stat label="Accuracy" value={selected.passAccuracy === null ? "—" : `${selected.passAccuracy}%`} />
                <Stat label="Key passes" value={selected.keyPasses} hint="Passes or corners linked to a shot, or the last completed pass by another player within 15 s of a shot (same half)" /><Stat label={PROGRESSIVE_PASS_LABEL} value={selected.progressivePasses} hint={PROGRESSIVE_PASS_HINT} />
                <Stat label="Possession lost" value={selected.possessionLost} hint="Unsuccessful passes" />
                <Stat label="Avg length" value={selected.avgPassDistanceM === null ? "—" : `${selected.avgPassDistanceM.toFixed(1)} m`} hint="Mean pass length on a 105 × 68 m pitch" />
                <Stat label="Avg difficulty (illustrative, uncalibrated)" value={selected.avgPassDifficulty === null ? "—" : selected.avgPassDifficulty.toFixed(0)} hint={PASS_DIFFICULTY_FORMULA.join("; ")} />
                <Stat label="Completion vs heuristic (illustrative, uncalibrated)" value={selected.passCompletionOverExpected === null ? "—" : `${selected.passCompletionOverExpected > 0 ? "+" : ""}${selected.passCompletionOverExpected.toFixed(1)} pp`} hint="Completed passes minus an uncalibrated difficulty heuristic, percentage points of attempts" />
                <Stat label="Hardest completed (illustrative, uncalibrated)" value={selected.hardestCompletedPass ? `${selected.hardestCompletedPass.difficulty}/100 · ${Math.round(selected.hardestCompletedPass.distanceM)} m` : "—"} />
              </div></div>
              <div className="pa-group"><h3>Defending</h3><div className="pa-stats">
                <Stat label="Tackles won" value={`${selected.tacklesWon}/${selected.tackles}`} /><Stat label="Pressures" value={selected.pressures} />
                <Stat label="Saves" value={selected.saves} />
              </div></div>
              <div className="pa-group"><h3>Discipline</h3><div className="pa-stats">
                <Stat label="Fouls" value={selected.fouls} /><Stat label="Yellow" value={selected.yellowCards} /><Stat label="Red" value={selected.redCards} />
              </div></div>
            </div>
          </div>

          <div className="pa-body pa-body--split">
            <div className="pa-impact">
              <h3>Illustrative activity score breakdown</h3>
              <ul>
                {selected.impact.components.map((component) => (
                  <li key={component.key}>
                    <span>{component.label}</span>
                    <span className="pa-impact__track">
                      <span className={`pa-impact__bar${component.value < 0 ? " is-negative" : ""}`} style={{ width: `${(Math.abs(component.value) / maxImpact) * 50}%`, [component.value < 0 ? "right" : "left"]: "50%" }} />
                    </span>
                    <strong className="mono">{component.value > 0 ? "+" : ""}{component.value.toFixed(2)}</strong>
                  </li>
                ))}
              </ul>
              <details className="pa-model"><summary>How the illustrative activity score works</summary>
                <p className="subtle-text">{IMPACT_RATING_FORMULA} Weights per action: goal +{IMPACT_WEIGHTS.goal}, assist +{IMPACT_WEIGHTS.assist}, chance created +{IMPACT_WEIGHTS.keyPass}, shot on target +{IMPACT_WEIGHTS.shotOnTarget}, completed pass +{IMPACT_WEIGHTS.passCompleted}, lost pass {IMPACT_WEIGHTS.passFailed}, {PROGRESSIVE_PASS_LABEL.toLowerCase()} +{IMPACT_WEIGHTS.progressivePass}, tackle won +{IMPACT_WEIGHTS.tackleWon}, pressure +{IMPACT_WEIGHTS.pressure}, save +{IMPACT_WEIGHTS.save} (+{IMPACT_WEIGHTS.savedXg} × xG saved), foul {IMPACT_WEIGHTS.foul}, yellow {IMPACT_WEIGHTS.yellow}, red {IMPACT_WEIGHTS.red}; plus illustrative xG × {IMPACT_WEIGHTS.xg} and xG assisted × {IMPACT_WEIGHTS.xa}. Illustrative and uncalibrated, from logged events only; not a performance rating.</p>
              </details>
            </div>

            <div className="pa-note">
              <div className="pitch-toolbar">
                <h3>Analyst note</h3>
                <div className="chips">
                  <label className="inline-select"><span className="sr-only">Note language</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABEL[item]}</option>)}</select></label>
                  <button type="button" className="button button--primary" onClick={() => void writeNote()} disabled={noteLoading}>{noteLoading ? "Writing…" : note ? "Refresh" : "Write note"}</button>
                </div>
              </div>
              {noteError && <div className="banner banner--danger" role="alert">{noteError}</div>}
              {note ? (
                <div className="pa-note__body">
                  <strong className="pa-note__headline">{note.headline}</strong>
                  <p>{note.summary}</p>
                  {note.strengths.length > 0 && <><h4>Strengths</h4><ul>{note.strengths.map((item) => <li key={item}>{item}</li>)}</ul></>}
                  {note.concerns.length > 0 && <><h4>Watch</h4><ul>{note.concerns.map((item) => <li key={item}>{item}</li>)}</ul></>}
                  <span className={`tag${note.source === "foundry" ? " tag--accent" : ""}`}>{note.source === "foundry" ? "Foundry player analyst · numbers checked" : "Rules-based note"}</span>
                  <span className="tag">{PERIOD_LABEL[note.period ?? "full"]}{note.asOfSecond !== undefined ? ` · as of ${Math.floor(note.asOfSecond / 60)}'` : ""}</span>
                </div>
              ) : (
                <p className="subtle-text">{aiReady ? "The Foundry player-analyst agent writes a short scouting note from these numbers; every figure is checked before it is shown." : "A rules-based note is written from these numbers."}</p>
              )}
            </div>
          </div>

          <div className="pa-tracking">
            <h3>Physical metrics{fixture.tracking ? <span className="tag tag--muted pa-tracking__source">synthetic tracking</span> : null}</h3>
            <div className="pa-tracking__grid">
              {TRACKING_METRICS.filter((metric) => !HIDDEN_TRACKING_KEYS.has(metric.key)).map((metric) => {
                const tracked = fixture.tracking ? physicalValue(selected, metric.key) : null;
                return (
                  <div key={metric.key} className="pa-tracking__tile">
                    <span>{TRACKING_LABEL[metric.key] ?? metric.label}</span><strong>{tracked ?? "—"}</strong>
                    <small>{tracked ? "Seeded synthetic samples, one per minute" : fixture.tracking && metric.key !== "minutes" ? "Not tracked for this player" : metric.key === "minutes" ? "Needs line-up data" : metric.reason}</small>
                  </div>
                );
              })}
            </div>
            <p className="subtle-text">{fixture.tracking
              ? "Distance is a synthetic minute aggregate and top speed a synthetic peak-speed milestone, from seeded samples (one per outfield player per minute). They are illustrative, not measured; a real broadcast would use optical tracking or GPS vests."
              : "Event feeds record what happened on the ball, not how far players ran. Distance and speed need player tracking: positions for every player many times a second, from optical tracking or GPS vests."}</p>
          </div>
        </section>
      ) : (
        <section className="panel empty-hero"><p className="subtle-text">Pick a player to see their analysis.</p></section>
      )}
    </div>
  );
}
