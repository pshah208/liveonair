import { useEffect, useState } from "react";
import { AppHeader } from "./components.js";
import { StudioPage } from "./StudioPage.js";
import type { Theme } from "./utils.js";

const INFRA_KEY = "matchlens.infrastructure.open";

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

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    try { window.localStorage.setItem(INFRA_KEY, String(infraOpen)); } catch { /* storage unavailable */ }
  }, [infraOpen]);

  return (
    <div className="app-shell">
      <AppHeader theme={theme} onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))} infraOpen={infraOpen} onToggleInfra={() => setInfraOpen((current) => !current)} />
      <StudioPage theme={theme} infraOpen={infraOpen} onToggleInfra={() => setInfraOpen((current) => !current)} />
    </div>
  );
}
