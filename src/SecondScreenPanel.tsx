import type { MomentumMarker } from "../shared/momentum.js";
import { SIMULATED_ENGAGEMENT_LABEL, simulatedEngagement } from "./momentumView.js";
import "./momentum.css";

export interface SecondScreenPanelProps {
  matchKey: string;
  minute: number;
  goals: MomentumMarker[];
  homeName: string;
  awayName: string;
}

/** Studio-only demo of second-screen engagement. Every figure is synthetic and deterministic; there are no real users. */
export function SecondScreenEngagement({ matchKey, minute, goals, homeName, awayName }: SecondScreenPanelProps) {
  const data = simulatedEngagement(matchKey, minute, goals, (teamId) => (teamId === "home" ? homeName : awayName));
  return (
    <div className="engagement">
      <p className="engagement__notice"><span className="tag tag--muted">{SIMULATED_ENGAGEMENT_LABEL}</span></p>
      <dl className="control-card__stats">
        <div><dt>Opted-in viewers</dt><dd className="mono">{data.optIns.toLocaleString("en-GB")}</dd></div>
        <div><dt>Avg minutes engaged</dt><dd className="mono">{data.avgMinutesEngaged}</dd></div>
      </dl>
      {data.dropOffs.length > 0 ? (
        <ul className="engagement__drops" aria-label="Simulated drop-off at key moments">
          {data.dropOffs.map((drop) => (
            <li key={`${drop.minute}-${drop.moment}`}><span className="mono">{drop.minute}'</span> {drop.moment}: <strong>−{drop.dropPercent}%</strong> of opted-in viewers</li>
          ))}
        </ul>
      ) : <p className="subtle-text">No key moments yet, so no simulated drop-off to show.</p>}
    </div>
  );
}
