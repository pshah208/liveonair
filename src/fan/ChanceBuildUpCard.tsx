import { useMemo } from "react";
import { buildChanceCard, TEAM_KIT } from "../../shared/fanCards.js";
import type { ChanceInsight } from "../../shared/chanceSequence.js";
import type { MatchFixture, TeamId } from "../../shared/types.js";

/** "How the chance was built": casual-friendly view of the latest non-withdrawn chance insight. */
export function ChanceBuildUpCard({ fixture, insights, matchId, focus }: { fixture: MatchFixture; insights: ChanceInsight[]; matchId?: string; focus: { teamId?: TeamId; playerId?: string } }) {
  const card = useMemo(() => buildChanceCard(fixture, insights, focus, matchId), [fixture, insights, focus, matchId]);
  const team = card.teamId ? fixture[card.teamId] : undefined;
  return (
    <section className="fan-card fan-card--chance" aria-label="How the chance was built">
      <h3 className="fan-card__title fan-card__title--small">How the chance was built</h3>
      {card.state === "empty" ? <p className="fan-card__empty">No chance to break down yet. We'll show the next shot or goal here.</p> : (
        <>
          <div className="fan-moment__meta">
            {card.insight && <span className="fan-moment__minute mono">{Math.floor(card.insight.effectiveSecond / 60)}′</span>}
            {card.isGoal && <span className="fan-card__pill fan-card__pill--1">Goal</span>}
            {card.revised && <span className="fan-card__pill fan-card__pill--n">Updated</span>}
            {team && card.teamId && <span className="fan-card__chip" style={{ borderColor: TEAM_KIT[card.teamId] }}>{team.shortName}</span>}
          </div>
          <p className="fan-moment__headline">{card.headline}</p>
          <ol className="fan-chance__chips">
            {card.chips.map((chip, index) => (
              <li key={`${index}-${chip.player}`} className="fan-chance__chip"><strong>{chip.player}</strong> · {chip.action}</li>
            ))}
          </ol>
          {card.territory && <p className="fan-card__hint">{card.territory}</p>}
        </>
      )}
      {card.withdrawnNote && <p className="fan-card__hint" role="status">This chance was updated after a correction.</p>}
      <p className="fan-card__foot">Chains are inferred from event order, not provider possessions.</p>
    </section>
  );
}
