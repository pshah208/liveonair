import type { ControlChaosWindow } from "../shared/momentum.js";
import { CONTROL_INSUFFICIENT_MESSAGE, CONTROL_LABEL, pressureChangeText } from "./momentumView.js";
import { WhyItMatters } from "./WhyItMatters.js";
import "./momentum.css";

export interface ControlChaosCardProps {
  /** Latest completed five-minute window, or null before the first window closes. */
  window: ControlChaosWindow | null;
  explanation?: string;
}

/** Control vs chaos: how the game rhythm felt over the latest five-minute window. */
export function ControlChaosCard({ window, explanation }: ControlChaosCardProps) {
  if (!window || window.insufficientCoverage) {
    return (
      <div className="control-card">
        <p className="control-card__intro">Control vs chaos reads the game rhythm in five-minute windows.</p>
        <p className="momentum__empty" role="status">{CONTROL_INSUFFICIENT_MESSAGE}</p>
      </div>
    );
  }
  const share = window.completedPassShare === null ? "No passes" : `${Math.round(window.completedPassShare * 100)}%`;
  return (
    <div className={`control-card control-card--${window.label}`}>
      <p className="control-card__verdict" aria-live="polite">
        <span className="control-card__badge">{CONTROL_LABEL[window.label]}</span>
        <span className="control-card__window mono">{window.startMinute}'–{window.endMinute}'</span>
      </p>
      <dl className="control-card__stats">
        <div><dt>Completed passes</dt><dd className="mono">{share}</dd></div>
        <div><dt>Possession changes</dt><dd className="mono">{window.possessionChanges}</dd></div>
        <div><dt>Shots</dt><dd className="mono">{window.shots}</dd></div>
      </dl>
      <p className="control-card__pressure">Pressing: {pressureChangeText(window.pressureDeltaFromPrevious)}.</p>
      <p className="control-card__rule subtle-text">Controlled when at least 60% of passes complete; chaotic at 8+ possession changes or 3+ shots in the window. Illustrative, from synthetic events.</p>
      {explanation && <WhyItMatters text={explanation} />}
    </div>
  );
}
