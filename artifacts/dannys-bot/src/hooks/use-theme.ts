import { useState, useCallback } from "react";

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

export function useTheme() {
  const [themeColor, setThemeColorState] = useState<ThemeColor>(
    () => (localStorage.getItem("equinox-theme-color") as ThemeColor) ?? "blue"
  );
  const [themeMode, setThemeModeState] = useState<ThemeMode>(
    () => (localStorage.getItem("equinox-theme-mode") as ThemeMode) ?? "dark"
  );

  const setThemeColor = useCallback((color: ThemeColor) => {
    localStorage.setItem("equinox-theme-color", color);
    setThemeColorState(color);
    const mode = (localStorage.getItem("equinox-theme-mode") as ThemeMode) ?? "dark";
    applyTheme(color, mode);
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    localStorage.setItem("equinox-theme-mode", mode);
    setThemeModeState(mode);
    const color = (localStorage.getItem("equinox-theme-color") as ThemeColor) ?? "blue";
    applyTheme(color, mode);
  }, []);

  return { themeColor, themeMode, setThemeColor, setThemeMode };
}
