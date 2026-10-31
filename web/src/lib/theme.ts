import { useSyncExternalStore } from "react";

// Light or dark theme. Dark is the default; the choice is saved per browser. public/theme-init.js applies
// it before first paint; this module keeps <html data-theme> and the header switch in step.

export type Theme = "dark" | "light";

const KEY = "life-dashboard:theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let theme: Theme = read();

export function currentTheme(): Theme {
  return theme;
}

export function setTheme(next: Theme): void {
  theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  if (typeof document !== "undefined") {
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "dark");
}
