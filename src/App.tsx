import { useEffect, useState } from "react";
import { AppHeader } from "./components.js";
import { StudioPage } from "./StudioPage.js";
import { VarDeskPage } from "./VarDeskPage.js";
import type { Theme } from "./utils.js";

const INFRA_KEY = "matchlens.infrastructure.open";
const DESK_KEY = "matchlens.desk";

export type Desk = "studio" | "var";

function initialDesk(): Desk {
  if (window.location.hash === "#var") return "var";
  if (window.location.hash === "#studio") return "studio";
  try {
    return window.localStorage.getItem(DESK_KEY) === "var" ? "var" : "studio";
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

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"));
  const [infraOpen, setInfraOpen] = useState(initialInfraOpen);
  const [desk, setDesk] = useState<Desk>(initialDesk);

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
      <AppHeader theme={theme} onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))} infraOpen={infraOpen} onToggleInfra={() => setInfraOpen((current) => !current)} desk={desk} onDesk={setDesk} />
      {/* The Studio Desk stays mounted so the live stream and Video lab keep running while the VAR Desk is open. */}
      <div hidden={desk !== "studio"}>
        <StudioPage theme={theme} infraOpen={infraOpen} onToggleInfra={() => setInfraOpen((current) => !current)} />
      </div>
      {desk === "var" && <VarDeskPage onOpenStudio={() => setDesk("studio")} />}
    </div>
  );
}
