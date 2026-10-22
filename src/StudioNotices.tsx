import { useState } from "react";
import { getStudioToken, setStudioToken } from "./api.js";

const NOTICE_KEY = "liveonair.studioMobileNotice.dismissed";

function readDismissed(): boolean {
  try { return window.sessionStorage.getItem(NOTICE_KEY) === "true"; } catch { return false; }
}

/** Below 768 px only (CSS hides it on wider screens): the Studio Desk is a desktop tool, so point phones to Fan View. */
export function StudioMobileNotice({ onOpenFan }: { onOpenFan?: () => void }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { window.sessionStorage.setItem(NOTICE_KEY, "true"); } catch { /* storage unavailable */ }
  };
  return (
    <div className="studio-mobile-notice banner banner--info" role="note">
      <span>The Studio Desk is best on larger screens.</span>
      <span className="studio-mobile-notice__actions">
        {onOpenFan && <button type="button" className="button button--primary button--small" onClick={onOpenFan}>Open Fan View →</button>}
        <button type="button" className="button button--ghost button--small" onClick={dismiss} aria-label="Dismiss larger-screen notice">Dismiss</button>
      </span>
    </div>
  );
}

type StudioTokenEntryProps = {
  /** True once a write returned 401: the stored token is missing or wrong. */
  rejected: boolean;
  onSaved: () => void;
};

/** Producer-token entry. Saving stores the token used as a bearer on studio fetches and as `?token=` on the studio EventSource. */
export function StudioTokenEntry({ rejected, onSaved }: StudioTokenEntryProps) {
  const [value, setValue] = useState(getStudioToken);
  const [saved, setSaved] = useState(() => Boolean(getStudioToken()));
  return (
    <form className="studio-token" aria-label="Producer token"
      onSubmit={(event) => {
        event.preventDefault();
        setStudioToken(value);
        setSaved(Boolean(value.trim()));
        onSaved();
      }}>
      <label className="studio-token__field">
        <span>Producer token</span>
        <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(event) => { setValue(event.target.value); setSaved(false); }} placeholder="Paste the producer token" />
      </label>
      <button type="submit" className="button button--small">Save token</button>
      <span className="subtle-text" role="status">
        {rejected ? "Producer token required: the server rejected this request. Check the token and try again." : saved ? "Token saved on this device. Studio reads and the live desk stream will use it." : "Studio reads, the live desk stream and studio actions need a producer token on this server."}
      </span>
    </form>
  );
}
