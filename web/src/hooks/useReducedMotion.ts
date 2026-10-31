import { useSyncExternalStore } from "react";

// prefers-reduced-motion as a live boolean. CSS already zeroes durations under the media query
// (global.css), and <MotionConfig reducedMotion="user"> in App.tsx turns off transform and layout
// animations in `motion`. Use this hook for the rest: count-ups, SVG path draw-in, anything driven
// from JS, where "reduced" should mean "show the final state at once".

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(QUERY).matches;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Motion timing for JS animations, in seconds. Mirrors the --dur-* and --ease-* tokens in tokens.css.
 * Interactions stay at or under `slow` (300ms); `draw` and `count` are load-time reveals only.
 */
export const MOTION = {
  press: 0.14,
  fast: 0.18,
  base: 0.24,
  slow: 0.3,
  draw: 0.7,
  count: 0.8,
  stagger: 0.04,
  easeOut: [0.22, 1, 0.36, 1],
  easeIn: [0.55, 0, 1, 0.45],
  easeInOut: [0.455, 0.03, 0.515, 0.955],
} as const;
