import { useMemo } from "react";
import { playerTags, type PlayerTag } from "../shared/metrics.js";
import { filterByPeriod, periodBoundary } from "../shared/periods.js";
import { activePlayerEvents } from "../shared/playerStats.js";
import type { MatchFixture, MatchPeriod } from "../shared/types.js";
import { teamTint } from "./utils.js";

const METRIC_LABEL: Record<PlayerTag["metric"], string> = {
  shot_speed: "Shot speed",
  top_speed: "Top speed",
  distance: "Distance",
  pass_difficulty: "Pass difficulty",
};

/** Timed player-ID entries for the scope, from reconciled events and (synthetic) tracking up to the clock. */
export function computePlayerTags(fixture: MatchFixture, clockSecond: number, period: MatchPeriod = "full"): PlayerTag[] {
  const boundary = periodBoundary(fixture);
  const events = filterByPeriod(activePlayerEvents(fixture, clockSecond), period, boundary);
  return playerTags(fixture, events, clockSecond, period);
}

export function PlayerIdTags({ fixture, clockSecond, period = "full", limit = 6 }: { fixture: MatchFixture; clockSecond: number; period?: MatchPeriod; limit?: number }) {
  const tags = useMemo(() => computePlayerTags(fixture, clockSecond, period), [fixture, clockSecond, period]);
  const teamOf = useMemo(() => new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player.teamId])), [fixture]);
  if (tags.length === 0) return <p className="subtle-text">Player-ID tags appear when a player crosses a threshold (shot ≥ 100 km/h, pass difficulty ≥ 75, top speed ≥ 32 km/h, every 5 km).</p>;
  const shown = tags.slice(-limit).reverse();
  return (
    <ul className="player-id-tags" aria-label="Player ID tags">
      {shown.map((tag) => (
        <li key={`${tag.playerId}-${tag.metric}-${tag.atSecond}`} className="player-id-tag" style={{ borderColor: teamTint(teamOf.get(tag.playerId) ?? "home") }}>
          <span className="player-id-tag__minute mono">{Math.floor(tag.atSecond / 60)}'</span>
          <strong>{tag.name}</strong>
          <span>{METRIC_LABEL[tag.metric]} <b className="mono">{tag.value}{tag.unit === "/100" ? "/100" : ` ${tag.unit}`}</b></span>
          {(tag.metric === "top_speed" || tag.metric === "distance") && <small className="subtle-text">synthetic tracking</small>}
        </li>
      ))}
    </ul>
  );
}
