import { PERIOD_LABEL } from "../shared/periods.js";
import type { MatchFixture, MatchPeriod, MatchSnapshot } from "../shared/types.js";
import { LiveStats, Panel, Pitch } from "./components.js";
import { PeriodSelector, periodScopeMessage, scopedTitle } from "./PeriodSelector.js";

export type LiveBoardPanelProps = {
  fixture: MatchFixture | null | undefined;
  /** Snapshot already scoped to `period` (null while none matches). */
  snapshot: MatchSnapshot | null;
  period: MatchPeriod;
  onPeriodChange: (period: MatchPeriod) => void;
  halvesUnavailable: boolean;
  score: { home: number; away: number };
  /** Panel heading. Defaults to the fixture title. */
  title?: string;
  className?: string;
  /** Frozen match. The pitch keeps the last frame; the label says Paused. */
  paused?: boolean;
};

/** The pitch, period selector and live stats shared by the Studio Desk and Fan View. */
export function LiveBoardPanel({ fixture, snapshot, period, onPeriodChange, halvesUnavailable, score, title, className, paused = false }: LiveBoardPanelProps) {
  const scopeMessage = periodScopeMessage(snapshot?.scope);
  return (
    <Panel eyebrow={scopedTitle("Live board", period)} title={title ?? fixture?.title ?? "No match running"} className={className} aside={paused ? <span className="tag" role="status">Paused</span> : undefined}>
      {fixture ? (
        <>
          {paused && <p className="banner banner--warning" role="status">Paused. The clock and the board are frozen until the match resumes.</p>}
          <PeriodSelector value={period} onChange={onPeriodChange} halvesUnavailable={halvesUnavailable} className="period-toggle" />
          {halvesUnavailable && <p className="subtle-text">Halves are unavailable for this match: clip-derived footage has no reliable half-time marker.</p>}
          {scopeMessage ? (
            <div className="empty-state" role="status"><strong>{snapshot?.scope?.reason === "not_started" ? "Not started" : "Period unavailable"}</strong> · {scopeMessage}</div>
          ) : (
            <>
              <Pitch fixture={fixture} events={snapshot?.recentEvents ?? (period === "full" ? fixture.events : [])} />
              {period !== "full" && snapshot?.periodScore && <p className="subtle-text">Goals in the {PERIOD_LABEL[period]}: {fixture.home.shortName} {snapshot.periodScore.home}–{snapshot.periodScore.away} {fixture.away.shortName} · match score {score.home}–{score.away}</p>}
              <span className="eyebrow">{scopedTitle("Live stats", period)}</span>
              <LiveStats snapshot={snapshot} fixture={fixture} />
            </>
          )}
        </>
      ) : <div className="empty-state">The pitch and live stats appear once a match starts.</div>}
    </Panel>
  );
}
