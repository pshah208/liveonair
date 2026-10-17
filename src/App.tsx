import { memo, useCallback, useEffect, useState } from "react";
import { AppHeader } from "./components.js";
import { FanPage } from "./FanPage.js";
import { EMPTY_MATCH_CONTEXT, type ActiveMatchContext } from "./liveContext.js";
import { StudioPage } from "./StudioPage.js";
import { VarDeskPage } from "./VarDeskPage.js";
import type { Theme } from "./utils.js";

const INFRA_KEY = "matchlens.infrastructure.open";
const DESK_KEY = "matchlens.desk";

export type Desk = "studio" | "fan" | "var";
const DESKS: readonly Desk[] = ["studio", "fan", "var"];

function isDesk(value: unknown): value is Desk {
  return typeof value === "string" && (DESKS as readonly string[]).includes(value);
}

function initialDesk(): Desk {
  const fromHash = window.location.hash.slice(1);
  if (isDesk(fromHash)) return fromHash;
  try {
    const stored = window.localStorage.getItem(DESK_KEY);
    return isDesk(stored) ? stored : "studio";
  } catch {
    return "studio";
  }
}

function initialInfraOpen(): boolean {
  try {
    return window.localStorage.getItem(INFRA_KEY) !== "false";
  } catch {
    return true;
  }
}

// Memoised so Fan View context updates do not re-render the whole Studio Desk.
const StudioDesk = memo(StudioPage);

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"));
  const [infraOpen, setInfraOpen] = useState(initialInfraOpen);
  const [desk, setDesk] = useState<Desk>(initialDesk);
  const [matchContext, setMatchContext] = useState<ActiveMatchContext>(EMPTY_MATCH_CONTEXT);
  const toggleInfra = useCallback(() => setInfraOpen((current) => !current), []);

  useEffect(() => {
    try { window.localStorage.setItem(DESK_KEY, desk); } catch { /* storage unavailable */ }
    window.history.replaceState(null, "", `#${desk}`);
    window.scrollTo({ top: 0 });
  }, [desk]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { window.localStorage.setItem("matchlens.theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);

  useEffect(() => {
    try { window.localStorage.setItem(INFRA_KEY, String(infraOpen)); } catch { /* storage unavailable */ }
  }, [infraOpen]);

  return (
    <div className="app-shell" data-desk={desk}>
      <AppHeader theme={theme} onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))} infraOpen={infraOpen} onToggleInfra={toggleInfra} desk={desk} onDesk={setDesk} />
      {/* The Studio Desk stays mounted so the live stream and Video lab keep running while another desk is open. */}
      <div hidden={desk !== "studio"}>
        <StudioDesk theme={theme} infraOpen={infraOpen} onToggleInfra={toggleInfra} onLiveContext={setMatchContext} />
      </div>
      {desk === "fan" && <FanPage context={matchContext} theme={theme} onOpenStudio={() => setDesk("studio")} />}
      {desk === "var" && <VarDeskPage onOpenStudio={() => setDesk("studio")} />}
    </div>
  );
}
