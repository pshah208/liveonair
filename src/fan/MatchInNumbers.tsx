import { useMemo } from "react";
import { buildMatchInNumbers, TEAM_KIT, type HeadToHeadRow } from "../../shared/fanCards.js";
import type { MatchFixture } from "../../shared/types.js";

/** Two-team head-to-head bars from team totals. Numbers sit beside the bars; empty rows show "—". */
export function MatchInNumbers({ fixture, uptoSecond }: { fixture: MatchFixture; uptoSecond: number }) {
  const rows = useMemo(() => buildMatchInNumbers(fixture, uptoSecond), [fixture, uptoSecond]);
  return (
    <section className="fan-card fan-card--numbers" aria-label="Match in numbers">
      <h3 className="fan-card__title fan-card__title--small">Match in numbers</h3>
      <div className="fan-h2h__teams" aria-hidden="true">
        <span style={{ color: TEAM_KIT.home }}>{fixture.home.shortName}</span>
        <span style={{ color: TEAM_KIT.away }}>{fixture.away.shortName}</span>
      </div>
      <ul className="fan-h2h">
        {rows.map((row) => <H2HRow key={row.key} row={row} home={fixture.home.name} away={fixture.away.name} />)}
      </ul>
      <p className="fan-card__foot">From logged events only. No possession figure: the feed can't measure it.</p>
    </section>
  );
}

function H2HRow({ row, home, away }: { row: HeadToHeadRow; home: string; away: string }) {
  const summary = `${row.label}: ${home} ${row.homeDisplay}, ${away} ${row.awayDisplay}${row.leader === "level" ? ", level" : ""}`;
  return (
    <li className="fan-h2h__row" aria-label={summary}>
      <span className="fan-h2h__label">{row.label}{row.leader === "level" && <small className="fan-card__note">Level</small>}</span>
      <span className="fan-h2h__num fan-h2h__num--home mono" aria-hidden="true">{row.homeDisplay}</span>
      <span className="fan-h2h__track fan-h2h__track--home" aria-hidden="true"><span style={{ width: `${Math.round(row.homeBar * 100)}%`, background: TEAM_KIT.home }} /></span>
      <span className="fan-h2h__track fan-h2h__track--away" aria-hidden="true"><span style={{ width: `${Math.round(row.awayBar * 100)}%`, background: TEAM_KIT.away }} /></span>
      <span className="fan-h2h__num fan-h2h__num--away mono" aria-hidden="true">{row.awayDisplay}</span>
    </li>
  );
}
