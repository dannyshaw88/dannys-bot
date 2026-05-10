import { useState, useCallback, useEffect } from "react";

export type ThemeColor =
  | "blue" | "purple" | "emerald" | "orange" | "rose"
  | "teal" | "red" | "violet" | "gold" | "pink" | "slate";
export type ThemeMode = "light" | "dark";

export const THEME_COLORS: { key: ThemeColor; label: string; primary: string }[] = [
  { key: "blue",    label: "Ocean Blue",    primary: "hsl(221 83% 53%)"  },
  { key: "purple",  label: "Royal Purple",  primary: "hsl(262 60% 52%)"  },
  { key: "emerald", label: "Emerald",       primary: "hsl(142 71% 38%)"  },
  { key: "orange",  label: "Sunset",        primary: "hsl(25 95% 48%)"   },
  { key: "rose",    label: "Rose",          primary: "hsl(350 89% 53%)"  },
  { key: "teal",    label: "Teal",          primary: "hsl(180 62% 36%)"  },
  { key: "red",     label: "Crimson",       primary: "hsl(0 72% 46%)"    },
  { key: "violet",  label: "Violet",        primary: "hsl(250 83% 55%)"  },
  { key: "gold",    label: "Gold",          primary: "hsl(43 96% 40%)"   },
  { key: "pink",    label: "Bubblegum",     primary: "hsl(328 73% 52%)"  },
  { key: "slate",   label: "Slate",         primary: "hsl(215 25% 48%)"  },
];

export function applyTheme(color: ThemeColor, mode: ThemeMode): void {
  const html = document.documentElement;
  const toRemove: string[] = [];
  html.classList.forEach((c) => {
    if (c.startsWith("theme-") || c === "dark") toRemove.push(c);
  });
  toRemove.forEach((c) => html.classList.remove(c));
  if (mode === "dark") html.classList.add("dark");
  if (color !== "blue") html.classList.add(`theme-${color}`);
}

function saveToBackend(color: ThemeColor, mode: ThemeMode): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ themeColor: color, themeMode: mode }),
  }).catch(() => {});
}

export function useTheme() {
  const [themeColor, setThemeColorState] = useState<ThemeColor>(
    () => (localStorage.getItem("equinox-theme-color") as ThemeColor) ?? "blue"
  );
  const [themeMode, setThemeModeState] = useState<ThemeMode>(
    () => (localStorage.getItem("equinox-theme-mode") as ThemeMode) ?? "dark"
  );

  // On mount: fetch from backend it is the single source of truth because
  // Electron uses a random port each launch, so localStorage lives on a new
  // origin every time and cannot be relied on across restarts/updates.
  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        const color = (data.themeColor as ThemeColor) ?? "blue";
        const mode  = (data.themeMode  as ThemeMode)  ?? "dark";
        // Always apply + sync don't skip even if localStorage looks the same.
        // The localStorage at a fresh port is empty, so defaults would mask
        // the real saved value.
        localStorage.setItem("equinox-theme-color", color);
        localStorage.setItem("equinox-theme-mode", mode);
        setThemeColorState(color);
        setThemeModeState(mode);
        applyTheme(color, mode);
      })
      .catch(() => {});
  }, []);

  const setThemeColor = useCallback((color: ThemeColor) => {
    localStorage.setItem("equinox-theme-color", color);
    setThemeColorState(color);
    const mode = (localStorage.getItem("equinox-theme-mode") as ThemeMode) ?? "dark";
    applyTheme(color, mode);
    saveToBackend(color, mode);
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    localStorage.setItem("equinox-theme-mode", mode);
    setThemeModeState(mode);
    const color = (localStorage.getItem("equinox-theme-color") as ThemeColor) ?? "blue";
    applyTheme(color, mode);
    saveToBackend(color, mode);
  }, []);

  return { themeColor, themeMode, setThemeColor, setThemeMode };
}
