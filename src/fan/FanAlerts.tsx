import type { FanAlert, FanAlertPrefs } from "../../shared/fan.js";
import { FAN_TEXT } from "./strings.js";

type FanAlertsProps = {
  alerts: FanAlert[];
  announcement: string;
  onDismiss: (key: string) => void;
  onDismissAll: () => void;
  onOpenPlayerCard: () => void;
};

const KIND_LABEL: Record<FanAlert["kind"], string> = {
  goal: "Goal",
  high_xg_shot: "High illustrative xG shot",
  card: "Card",
  story: "Approved moment",
  player: "Your player",
};

/**
 * Quiet in-page alerts: text only, dismissible, announced through one polite live region.
 * No sound, vibration, Notification API or permission prompt.
 */
export function FanAlerts({ alerts, announcement, onDismiss, onDismissAll, onOpenPlayerCard }: FanAlertsProps) {
  return (
    <>
      {/* Always mounted so screen readers pick up the next alert; it doubles as the caption for each alert. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {alerts.length > 0 && (
        <section className="fan-p2-alerts" aria-label={FAN_TEXT.alertsLabel}>
          <ul className="fan-p2-alerts__list">
            {alerts.map((alert) => (
              <li key={alert.key} className={`fan-p2-alert${alert.corrected ? " is-corrected" : ""}${alert.yourPlayer ? " is-yours" : ""}`}>
                <span className="mono fan-p2-alert__minute">{alert.minute}′</span>
                <span className={`fan-p2-pill${alert.corrected ? " fan-p2-pill--corrected" : ""}`}>{alert.corrected ? FAN_TEXT.correctedPill : KIND_LABEL[alert.kind]}</span>
                <span className="fan-p2-alert__text">
                  {alert.corrected || KIND_LABEL[alert.kind] !== alert.title
                    ? <><strong>{alert.corrected ? <s>{alert.title}</s> : alert.title}</strong><span>{alert.detail}</span></>
                    : <strong>{alert.detail}</strong>}
                  {alert.corrected && alert.correction && <span className="fan-p2-alert__correction">{alert.correction}</span>}
                </span>
                <span className="fan-p2-alert__actions">
                  {alert.yourPlayer && !alert.corrected && <button type="button" className="button button--ghost button--small" onClick={onOpenPlayerCard}>{FAN_TEXT.openPlayerCard}</button>}
                  <button type="button" className="button button--ghost button--small" aria-label={`${FAN_TEXT.dismiss}: ${alert.title} ${alert.minute}′`} onClick={() => onDismiss(alert.key)}>{FAN_TEXT.dismiss}</button>
                </span>
              </li>
            ))}
          </ul>
          {alerts.length > 1 && <button type="button" className="link-button fan-p2-alerts__all" onClick={onDismissAll}>{FAN_TEXT.dismissAll}</button>}
        </section>
      )}
    </>
  );
}

export function AlertPrefsFieldset({ prefs, onChange }: { prefs: FanAlertPrefs; onChange: (next: FanAlertPrefs) => void }) {
  const keys = Object.keys(FAN_TEXT.alertPrefLabels) as Array<keyof FanAlertPrefs>;
  return (
    <fieldset className="fan-p2-alertprefs">
      <legend>{FAN_TEXT.alertPrefs}</legend>
      {keys.map((key) => (
        <label key={key} className="fan-p2-check">
          <input type="checkbox" checked={prefs[key]} onChange={(event) => onChange({ ...prefs, [key]: event.target.checked })} />
          <span>{FAN_TEXT.alertPrefLabels[key]}</span>
        </label>
      ))}
      <p className="fan-p2-note">{FAN_TEXT.alertsHint}</p>
    </fieldset>
  );
}
