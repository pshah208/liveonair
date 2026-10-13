import { useEffect, useMemo, useState } from "react";
import { analysePlayers, heatGrid, IMPACT_WEIGHTS, TRACKING_METRICS, type PlayerAnalysis } from "../shared/playerStats.js";
import type { Language, MatchFixture, TeamId } from "../shared/types.js";
import { api, type PlayerNote } from "./api.js";
import { getErrorMessage, LANGUAGE_LABEL, LANGUAGES, teamTint } from "./utils.js";

type Props = { fixture: MatchFixture | null; clockSecond: number; aiReady: boolean; onOpenLiveDesk: () => void };
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
  return <div className="pa-stat" title={hint}><span>{label}</span><strong>{value}</strong></div>;
}

export function PlayerAnalysisPage({ fixture, clockSecond, aiReady, onOpenLiveDesk }: Props) {
  const [team, setTeam] = useState<TeamId>("home");
  const [sort, setSort] = useState<SortMode>("impact");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("heat");
  const [language, setLanguage] = useState<Language>("en");
  const [note, setNote] = useState<PlayerNote | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const analyses = useMemo(() => (fixture ? analysePlayers(fixture, clockSecond) : []), [fixture, clockSecond]);
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
  useEffect(() => { setNote(null); setNoteError(null); }, [selectedId, language]);

  async function writeNote() {
    if (!selected) return;
    setNoteLoading(true);
    setNoteError(null);
    try { setNote(await api.analysePlayer(selected.player.id, language)); }
    catch (error) { setNoteError(getErrorMessage(error)); }
    finally { setNoteLoading(false); }
  }

  if (!fixture) {
    return (
      <div className="panel empty-hero">
        <h2>No match yet</h2>
        <p className="subtle-text">Start a match on the live desk. Every player's numbers, heat map and impact rating build up from the live feed.</p>
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
          <div><span className="eyebrow">Squads</span><h2 id="pa-squads-title">Players</h2></div>
          <label className="inline-select"><span className="sr-only">Sort players</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="impact">By impact</option><option value="number">By shirt number</option></select>
          </label>
        </header>
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
                <span className="pa-row__name">{entry.player.name}<small>{entry.player.position || "Player"} · {entry.involvements} actions</small></span>
                <span className={`pa-rating pa-rating--${ratingTone(entry.impact.rating)}`}>{entry.impact.rating.toFixed(1)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected ? (
        <section className="panel pa-detail" aria-labelledby="pa-player-title">
          <header className="pa-hero" style={{ borderColor: teamTint(selected.teamId) }}>
            <span className="pa-hero__number mono" style={{ background: teamTint(selected.teamId) }}>{selected.player.number || "–"}</span>
            <div className="pa-hero__name">
              <span className="eyebrow">{teams[selected.teamId].name} · {selected.player.position || "Player"}</span>
              <h2 id="pa-player-title">{selected.player.name}</h2>
              <p className="subtle-text">{selected.involvements} logged actions · {selected.involvementShare}% of the team's · {Math.floor(clockSecond / 60)}' played in the match</p>
            </div>
            <div className={`pa-hero__rating pa-rating--${ratingTone(selected.impact.rating)}`} title="Illustrative impact rating: 6.0 plus weighted contributions, kept within 3–10">
              <strong>{selected.impact.rating.toFixed(1)}</strong><span>Impact</span>
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
                <Stat label="xG" value={selected.xg.toFixed(2)} hint="Illustrative expected goals from shot quality" /><Stat label="xA" value={selected.xa.toFixed(2)} hint="xG of the shots this player set up" />
                <Stat label="Box touches" value={selected.touchesInBox ?? "—"} hint="Actions in the opposition penalty area" />
              </div></div>
              <div className="pa-group"><h3>Passing</h3><div className="pa-stats">
                <Stat label="Completed" value={`${selected.passesCompleted}/${selected.passes}`} /><Stat label="Accuracy" value={selected.passAccuracy === null ? "—" : `${selected.passAccuracy}%`} />
                <Stat label="Key passes" value={selected.keyPasses} hint="Passes or corners followed by a shot within 15 s" /><Stat label="Progressive" value={selected.progressivePasses} hint="Completed passes that moved the ball 15+ units towards goal" />
                <Stat label="Possession lost" value={selected.possessionLost} hint="Unsuccessful passes" />
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
              <h3>Impact on the game</h3>
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
              <details className="pa-model"><summary>How the impact rating works</summary>
                <p className="subtle-text">Rating = 6.0 + the sum above, kept within 3–10. Weights per action: goal +{IMPACT_WEIGHTS.goal}, assist +{IMPACT_WEIGHTS.assist}, chance created +{IMPACT_WEIGHTS.keyPass}, shot on target +{IMPACT_WEIGHTS.shotOnTarget}, completed pass +{IMPACT_WEIGHTS.passCompleted}, lost pass {IMPACT_WEIGHTS.passFailed}, progressive pass +{IMPACT_WEIGHTS.progressivePass}, tackle won +{IMPACT_WEIGHTS.tackleWon}, pressure +{IMPACT_WEIGHTS.pressure}, save +{IMPACT_WEIGHTS.save} (+{IMPACT_WEIGHTS.savedXg} × xG saved), foul {IMPACT_WEIGHTS.foul}, yellow {IMPACT_WEIGHTS.yellow}, red {IMPACT_WEIGHTS.red}; plus xG × {IMPACT_WEIGHTS.xg} and xA × {IMPACT_WEIGHTS.xa}. Illustrative, from logged events only.</p>
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
                  <span className={`tag${note.source === "foundry" ? " tag--accent" : ""}`} title={note.problem}>{note.source === "foundry" ? "Foundry player analyst · numbers checked" : "Rules-based note"}</span>
                </div>
              ) : (
                <p className="subtle-text">{aiReady ? "The Foundry player-analyst agent writes a short scouting note from these numbers; every figure is checked before it is shown." : "A rules-based note is written from these numbers."}</p>
              )}
            </div>
          </div>

          <div className="pa-tracking">
            <h3>Physical metrics</h3>
            <div className="pa-tracking__grid">
              {TRACKING_METRICS.map((metric) => (
                <div key={metric.key} className="pa-tracking__tile" title={metric.reason}>
                  <span>{metric.label}</span><strong>—</strong><small>Needs a tracking feed</small>
                </div>
              ))}
            </div>
            <p className="subtle-text">Event feeds record what happened on the ball, not how far players ran. Distance, sprints and speed need player tracking: positions for every player many times a second, from optical tracking or GPS vests.</p>
          </div>
        </section>
      ) : (
        <section className="panel empty-hero"><p className="subtle-text">Pick a player to see their analysis.</p></section>
      )}
    </div>
  );
}
