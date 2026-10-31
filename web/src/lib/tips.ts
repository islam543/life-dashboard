import { useSyncExternalStore } from "react";

// Hover help on/off. Saved per browser; on by default. Read by ui/TipLayer.tsx, switched in the header.

const KEY = "life-dashboard:tips";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let enabled = read();

export function tipsEnabled(): boolean {
  return enabled;
}

export function setTipsEnabled(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTipsEnabled(): boolean {
  return useSyncExternalStore(subscribe, tipsEnabled, () => true);
}
