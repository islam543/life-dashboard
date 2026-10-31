import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Area } from "../../../shared/types";
import { MOTION } from "../hooks/useReducedMotion";

// Explore mode. A tile calls openDetail(area); shell/DetailOverlay renders details/<Area>Detail inside
// a `motion` card whose layoutId matches the tile, so the tile appears to expand into the view.
//
// layoutId convention: "tile-" + area, e.g. "tile-work" (build it with tileLayoutId).
//   - A tile that should grow into the view passes its id: openDetail("work", "tile-work").
//     Easiest path: useDetailTrigger(area, key?) returns the id, open() and the motion props.
//   - Exactly ONE mounted element may carry a given layoutId. `motion` hides every other element
//     sharing it (opacity 0), so two tiles both using "tile-work" would make one vanish.
//   - Several tiles that open the same area (KPI tiles: hours, Jira, PRs, commits all open "work")
//     each add a key: tileLayoutId("work", "jira") -> "tile-work-jira".
//   - openDetail(area) with no id (Life map nodes) opens the view with a plain fade and scale, so it
//     never morphs out of an unrelated panel. Work then starts on its first connected tab.

/** Props every details/* view receives. Calendar and email share CalendarDetail, hence `area`. */
export interface DetailProps {
  area: Area;
}

export interface DetailContextValue {
  /** Area whose detail view is open, or null. */
  openArea: Area | null;
  /** layoutId of the tile the open view grew from; null when closed or opened without a tile. */
  openLayoutId: string | null;
  /** Open an area's detail, growing out of the element with `layoutId` if given. Remembers the focused element. */
  openDetail: (area: Area, layoutId?: string) => void;
  /** Close the open detail. Focus returns to the element that opened it. */
  closeDetail: () => void;
  /** @internal DetailOverlay calls this after its exit animation to put focus back. */
  restoreFocus: () => void;
}

const DetailContext = createContext<DetailContextValue | null>(null);

/** "tile-" + area, plus "-" + key when several tiles open the same area. */
export function tileLayoutId(area: Area, key?: string): string {
  return key ? `tile-${area}-${key}` : `tile-${area}`;
}

/** Shared-layout timing used by the tile and the overlay card, so open and close feel the same. */
export const TILE_LAYOUT_TRANSITION = { layout: { duration: MOTION.slow, ease: MOTION.easeOut } } as const;

export function DetailProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ area: Area; layoutId: string | null } | null>(null);
  const opener = useRef<HTMLElement | SVGElement | null>(null);

  const openDetail = useCallback((area: Area, layoutId?: string) => {
    const active = document.activeElement;
    opener.current = (active instanceof HTMLElement || active instanceof SVGElement) && active !== document.body ? active : null;
    setCurrent({ area, layoutId: layoutId ?? null });
  }, []);

  const closeDetail = useCallback(() => setCurrent(null), []);

  const restoreFocus = useCallback(() => {
    const el = opener.current;
    opener.current = null;
    if (el && el.isConnected) el.focus({ preventScroll: true });
    else document.getElementById("main")?.focus({ preventScroll: true });
  }, []);

  const value = useMemo<DetailContextValue>(
    () => ({
      openArea: current?.area ?? null,
      openLayoutId: current?.layoutId ?? null,
      openDetail,
      closeDetail,
      restoreFocus,
    }),
    [current, openDetail, closeDetail, restoreFocus],
  );

  return <DetailContext.Provider value={value}>{children}</DetailContext.Provider>;
}

export function useDetail(): DetailContextValue {
  const ctx = useContext(DetailContext);
  if (!ctx) throw new Error("useDetail must be used inside <DetailProvider>");
  return ctx;
}

/**
 * Everything a clickable tile needs to expand into its detail view:
 *
 *   const t = useDetailTrigger("work", "jira");
 *   <motion.button {...t.motionProps} onClick={t.open} aria-label="Open Jira issues in Work">...</motion.button>
 *
 * `motionProps` sets the layoutId, limits layout measuring to open/close (no stray layout animations
 * when data changes), and shares the overlay's timing.
 */
export function useDetailTrigger(area: Area, key?: string) {
  const { openDetail, openLayoutId } = useDetail();
  const layoutId = tileLayoutId(area, key);
  const isOpen = openLayoutId === layoutId;
  const open = useCallback(() => openDetail(area, layoutId), [openDetail, area, layoutId]);
  return {
    layoutId,
    isOpen,
    open,
    motionProps: { layoutId, layoutDependency: isOpen, transition: TILE_LAYOUT_TRANSITION },
  };
}
