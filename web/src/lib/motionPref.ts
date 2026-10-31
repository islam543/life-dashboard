import { useSyncExternalStore } from "react";

// Background motion on/off: the drifting page backdrop (ui/Backdrop.tsx) and the Life map radar.
// Saved per browser; on by default. Under the OS "reduce motion" setting both stay still anyway.

const KEY = "life-dashboard:backdrop-motion";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let enabled = read();

export function backdropMotionEnabled(): boolean {
  return enabled;
}

export function setBackdropMotion(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  if (typeof document !== "undefined") {
    if (next) delete document.documentElement.dataset.still;
    else document.documentElement.dataset.still = "true";
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useBackdropMotion(): boolean {
  return useSyncExternalStore(subscribe, backdropMotionEnabled, () => true);
}
