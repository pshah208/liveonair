import type { ChanceInsight } from "../shared/chanceSequence.js";
import type { Language } from "../shared/types.js";

export type ChanceInsightCardProps = {
  insight: ChanceInsight;
  /** Player id to display name. Missing ids fall back to the id. */
  players: Record<string, string>;
  teams?: { home: string; away: string };
  language?: Language;
  variant?: "studio" | "fan";
};

const STATUS_LABEL = {
  issued: "Issued",
  revised: "Revised",
  withdrawn: "Withdrawn",
} as const;

function formatCount(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function deltaLabel(value: number | null): string {
  if (value === null) return "n/a";
  if (value > 0) return `+${value}`;
  return String(value);
}

/**
 * Presentational chance card. Studio and Fan View share it. Copy stays descriptive:
 * event-derived territory, never possession or pressure.
 */
export function ChanceInsightCard({ insight, players, teams, language = "en", variant = "studio" }: ChanceInsightCardProps) {
  const sequence = insight.sequence;
  const territory = insight.territory;
  const evidence = insight.evidenceEventIds.map((ref) => `${ref.eventId}@${ref.revision}`).join(", ");
  const progression = sequence?.progressionM === null || sequence === null
    ? "Progression n/a"
    : `${sequence.progressionM.toFixed(1)} m progression`;
  return (
    <article
      className={`chance-card chance-card--${variant} chance-card--${insight.status}`}
      data-language={language ?? "en"}
      title={evidence ? `Evidence: ${evidence}` : undefined}
    >
      <header className="chance-card__head">
        <span className={`tag chance-card__status chance-card__status--${insight.status}`}>{STATUS_LABEL[insight.status]}</span>
        <span className="chance-card__meta">rev {insight.revision} · {insight.metricVersion}</span>
      </header>
      {sequence ? (
        <ol className="chance-card__chips">
          {sequence.steps.map((step) => (
            <li key={step.eventId} className="chance-chip" title={`${step.eventId} · ${step.minute}:${String(step.second).padStart(2, "0")}`}>
              <span>{players[step.playerId] ?? (step.playerId || "Unknown")}</span>
              <span className="chance-chip__action">{step.type.replaceAll("_", " ")}</span>
            </li>
          ))}
        </ol>
      ) : <p className="chance-card__empty">Sequence withdrawn.</p>}
      <p className="chance-card__facts">
        {sequence ? `${sequence.origin.zone} third origin · ${progression} · ${sequence.passes} passes · ${sequence.playerIds.length} players · ${sequence.matchClockSpanSeconds}s match clock · ${sequence.boundary}` : insight.withdrawalReason}
      </p>
      {territory && (
        <div className="chance-card__territory">
          <span className="eyebrow">Event-derived territory</span>
          {(["home", "away"] as const).map((teamId) => {
            const side = territory[teamId];
            const change = territory.change[teamId];
            const label = teams?.[teamId] ?? teamId;
            return (
              <p key={teamId} className="chance-card__row">
                <strong>{label}</strong>
                {" "}
                {formatCount(side.current.finalThirdEntries)} entries
                {" "}({deltaLabel(change.finalThirdEntries)} vs previous),
                {" "}
                {formatCount(side.current.completedPassesEndingInFinalThird)} final-third passes,
                {" "}
                {side.current.attackingActionsInFinalThird} of {side.current.attackingActions} attacking actions in the final third
              </p>
            );
          })}
        </div>
      )}
      {insight.withdrawalReason && <p className="chance-card__note">{insight.withdrawalReason}</p>}
      {insight.status === "revised" && insight.revisionReason && <p className="chance-card__note">{insight.revisionReason}</p>}
      {variant === "studio" && insight.coverageNotes.length > 0 && (
        <p className="chance-card__note">{insight.coverageNotes[0]}</p>
      )}
    </article>
  );
}
