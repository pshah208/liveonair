import { useEffect, useState } from "react";
import { FanPage } from "./FanPage.js";
import { NavHeader } from "./components.js";
import { StudioPage } from "./StudioPage.js";
import type { AppRoute, Theme } from "./utils.js";

function currentRoute(): AppRoute {
  return window.location.pathname === "/studio" ? "/studio" : "/";
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const [route, setRoute] = useState<AppRoute>(() => currentRoute());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(nextRoute: AppRoute) {
    if (nextRoute === route) return;
    window.history.pushState({}, "", nextRoute);
    setRoute(nextRoute);
  }

  return (
    <div className="app-shell">
      <NavHeader route={route} theme={theme} onNavigate={navigate} onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} />
      {route === "/studio" ? <StudioPage /> : <FanPage />}
    </div>
  );
}
