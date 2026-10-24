import type { MatchPeriod, PeriodScope } from "../shared/types.js";
import { MATCH_PERIODS, PERIOD_LABEL } from "../shared/periods.js";

type PeriodSelectorProps = {
  value: MatchPeriod;
  onChange: (period: MatchPeriod) => void;
  /** Disables the half options, e.g. for clip-derived video where halves are unknown. */
  halvesUnavailable?: boolean;
  label?: string;
  className?: string;
};

/** Accessible "Full match | 1st half | 2nd half" radio group, reusable by Studio and Fan views. */
export function PeriodSelector({ value, onChange, halvesUnavailable = false, label = "Stats period", className }: PeriodSelectorProps) {
  const move = (from: MatchPeriod, step: number) => {
    const enabled = MATCH_PERIODS.filter((period) => period === "full" || !halvesUnavailable);
    const index = enabled.indexOf(from);
    return enabled[(index + step + enabled.length) % enabled.length]!;
  };
  return (
    <div className={`segmented segmented--compact${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label}
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = move(value, step);
        onChange(next);
        (event.currentTarget.querySelector(`[data-period="${next}"]`) as HTMLButtonElement | null)?.focus();
      }}>
      {MATCH_PERIODS.map((period) => {
        const disabled = period !== "full" && halvesUnavailable;
        return (
          <button key={period} type="button" role="radio" data-period={period} aria-checked={value === period} tabIndex={value === period ? 0 : -1}
            disabled={disabled} aria-label={disabled ? `${PERIOD_LABEL[period]} (unavailable for clip-derived footage)` : undefined}
            className={`segmented__item${value === period ? " is-active" : ""}`} onClick={() => onChange(period)}>
            {PERIOD_LABEL[period]}
          </button>
        );
      })}
    </div>
  );
}

/** Message for a scope that has nothing to show, distinct from a period with zero actions. */
export function periodScopeMessage(scope: PeriodScope | undefined): string | null {
  if (!scope || scope.available) return null;
  return scope.reason === "not_started" ? `Not started — the ${PERIOD_LABEL[scope.period]} has not kicked off yet.` : "Period unavailable — this match has no reliable half-time marker.";
}

/** "Live stats · 1st half"; full match keeps the plain title. */
export function scopedTitle(title: string, period: MatchPeriod): string {
  return period === "full" ? title : `${title} · ${PERIOD_LABEL[period]}`;
}
