import { useCallback, useSyncExternalStore } from "react";

/** Ultrawide screens (21:9). Same width as the CSS rule in styles/tokens.css and the views. */
export const ULTRAWIDE_QUERY = "(min-width: 1920px)";

/** A CSS media query as a live boolean, e.g. useMediaQuery("(max-width: 719px)"). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const get = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, get, () => false);
}
