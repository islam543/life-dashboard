import {
  drag,
  easeCubicOut,
  select,
  zoom,
  zoomIdentity,
  type D3DragEvent,
  type D3ZoomEvent,
  type Simulation,
  type ZoomBehavior,
  type ZoomTransform,
} from "d3";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { Snapshot } from "../../../shared/types";
import { useDetail } from "../context/DetailContext";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { areaLabel, detailTitle } from "../lib/format";
import {
  buildLifeGraph,
  createSimulation,
  FIT_EXTENT,
  fitTransform,
  graphSignature,
  nodeScale,
  orientationFor,
  placeLabels,
  runToEnd,
  seedLayout,
  simLinks,
  simNodes,
  truncateLabel,
  ZOOM_EXTENT,
  type AreaStat,
  type LabelBox,
  type LabelInput,
  type LifeGraph,
  type LifeNode,
  type Orientation,
  type SimLink,
  type SimNode,
} from "../lib/lifeGraph";
import { ULTRAWIDE_QUERY, useMediaQuery } from "../notes/useMediaQuery";
import { Button } from "../ui/Button";
import { Panel, panelFromSource } from "../ui/Panel";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot, toneForUrgency } from "../ui/StatusDot";
import styles from "./LifeMap.module.css";

// The #/map view (explore mode): Islam in the centre, the five life areas around, projects around Work.
// Size = attention in the last 7 days, halo = needs you, dashed = not connected.
//
// Rendering: React draws the SVG from the simulation's node positions; d3-force moves them, d3-zoom owns
// pan and zoom (semantic zoom: positions scale, labels keep their size), d3-drag moves single nodes.
// The layout is deterministic, so a copy is run to the end off screen first to frame the view, then the
// visible simulation blooms into exactly that place and stops (about 2 s). Under reduced motion the
// settled layout is shown at once. Node clicks call openDetail(area) with no layoutId (plain fade).
//
// Ultrawide (1920px and up): the area readout and the legend become a rail on the left, the stage fills
// the rest of the width and the window's height (no page scroll), and on a stage at least twice as wide as
// tall the layout switches to "wide", which spreads the areas sideways (lib/lifeGraph orientationFor).

const LABEL_ALPHA = 0.12; // labels fade in once the bloom is mostly done
const ZOOM_STEP = 1.4;
const LABEL_HEIGHT = 14;
const RING_RADII = [110, 210, 340]; // decorative range rings, world units

interface SimState {
  sim: Simulation<SimNode, SimLink>;
  nodes: SimNode[];
  byId: Map<string, SimNode>;
  /** The visible simulation has moved at least once (StrictMode starts and stops effects once on mount). */
  ran: boolean;
}

interface DragSubject {
  id: string;
  x: number;
  y: number;
}

function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * The element's distance from the top of the page, as a `--map-top` style. Ultrawide CSS sizes the stage
 * to the rest of the window from it, whatever the header's height.
 */
function useTopStyle(ref: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const next = Math.round(el.getBoundingClientRect().top + window.scrollY);
      setTop((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return top === null ? undefined : ({ "--map-top": `${top}px` } as CSSProperties);
}

type LabelFont = "area" | "node";

/** Text width in px for map labels, measured with the token fonts. Re-measures once web fonts load. */
function useTextMeasure(): (text: string, font: LabelFont) => number {
  const [fontsVersion, setFontsVersion] = useState(0);
  const state = useRef<{
    ctx: CanvasRenderingContext2D | null;
    cache: Map<string, number>;
    fonts: Record<LabelFont, { font: string; tracking: number }>;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    document.fonts?.ready.then(() => {
      if (!alive) return;
      state.current?.cache.clear();
      setFontsVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  // fontsVersion is a dependency on purpose: a new function after fonts load makes labels re-measure.
  return useCallback(
    (text: string, font: LabelFont) => {
      if (!state.current) {
        const css = getComputedStyle(document.documentElement);
        const family = css.getPropertyValue("--font-ui").trim() || "sans-serif";
        const px = Number.parseFloat(css.getPropertyValue("--fs-xs")) || 11;
        const tracking = Number.parseFloat(css.getPropertyValue("--tracking-label")) || 0;
        const medium = css.getPropertyValue("--fw-medium").trim() || "500";
        const regular = css.getPropertyValue("--fw-regular").trim() || "400";
        state.current = {
          ctx: document.createElement("canvas").getContext("2d"),
          cache: new Map(),
          fonts: {
            area: { font: `${medium} ${px}px ${family}`, tracking: tracking * px },
            node: { font: `${regular} ${px}px ${family}`, tracking: 0 },
          },
        };
      }
      const s = state.current;
      const key = `${font}|${text}`;
      const hit = s.cache.get(key);
      if (hit !== undefined) return hit;
      const spec = s.fonts[font];
      let width = text.length * 6.6;
      if (s.ctx) {
        s.ctx.font = spec.font;
        width = s.ctx.measureText(text).width + spec.tracking * text.length;
      }
      s.cache.set(key, width);
      return width;
    },
    [fontsVersion],
  );
}

// ---------------------------------------------------------------------------------------------
// Small SVG pieces

function hexPath(r: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = ((-90 + i * 60) * Math.PI) / 180;
    return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  });
  return `M${pts.join(" L")} Z`;
}

/** Red: diamond. Amber: triangle. Same shapes as StatusDot, so the halo never relies on colour alone. */
function badgePath(urgency: "red" | "amber", s: number): string {
  return urgency === "red" ? `M0 ${-s} L${s} 0 L0 ${s} L${-s} 0 Z` : `M0 ${-s} L${s} ${s * 0.8} L${-s} ${s * 0.8} Z`;
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RecenterIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// The view

export function LifeMap() {
  const snap = useSnapshot();
  const status = panelFromSource(snap, null, { isEmpty: () => false, empty: "" });

  if (status.state !== "ok" || !snap.data) {
    return <Panel title="Life map" {...status} skeleton={<MapSkeleton />} />;
  }
  return (
    <Panel title="Life map" state="ok" meta="Last 7 days" bodyClassName={styles.body}>
      <MapBody data={snap.data} />
    </Panel>
  );
}

function MapSkeleton() {
  const ref = useRef<HTMLDivElement>(null);
  const top = useTopStyle(ref);
  return (
    <div ref={ref} className={styles.skeleton} style={top} aria-hidden="true">
      <div className={styles.skeletonReadout}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={styles.skeletonCell}>
            <Skeleton width="40%" height={10} />
            <Skeleton width="60%" height={18} />
          </div>
        ))}
      </div>
      <div className={styles.skeletonStage}>
        <Skeleton height="100%" radius={10} />
      </div>
    </div>
  );
}

function MapBody({ data }: { data: Snapshot }) {
  const reduced = useReducedMotion();
  // Rebuilt when a new snapshot arrives; the layout only re-runs when what it draws changes.
  const graph = useMemo(() => buildLifeGraph(data, new Date()), [data]);
  const ref = useRef<HTMLDivElement>(null);
  const top = useTopStyle(ref);
  return (
    <div ref={ref} className={styles.layout} style={top}>
      <AreaReadout areas={graph.areas} />
      <MapStage graph={graph} reduced={reduced} />
      <HiddenList graph={graph} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Readout: the answer to "am I neglecting an area?" in words, above the map.

const AreaReadout = memo(function AreaReadout({ areas }: { areas: AreaStat[] }) {
  return (
    <ul className={styles.readout} aria-label="Areas in the last 7 days">
      {areas.map((a) => (
        <li
          key={a.area}
          className={styles.reading}
          data-off={!a.connected || undefined}
          data-idle={(a.connected && a.activeDays === 0) || undefined}
        >
          <span className={styles.readName}>{areaLabel(a.area)}</span>
          <span className={a.numeric ? `${styles.readValue} num` : styles.readText}>{a.headline}</span>
          <span className={styles.readSub}>{a.sub}</span>
          {a.halo ? (
            <span className={styles.readAlert} data-urgency={a.halo}>
              <StatusDot tone={toneForUrgency(a.halo)} size={9} glow={false} />
              {a.alerts.length === 1 ? "1 needs you" : `${a.alerts.length} need you`}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
});

// ---------------------------------------------------------------------------------------------
// Accessible fallback: the whole map as a nested list, read by screen readers only.

const HiddenList = memo(function HiddenList({ graph }: { graph: LifeGraph }) {
  const headingId = `map-list-${useId().replace(/:/g, "")}`;
  const center = graph.nodes.find((n) => n.kind === "center");
  const areas = graph.nodes.filter((n) => n.kind === "area");
  return (
    <div className="sr-only">
      <h3 id={headingId}>Life map as a list</h3>
      <ul aria-labelledby={headingId}>
        {center ? <li>{center.description}</li> : null}
        {areas.map((area) => {
          const children = graph.nodes.filter((n) => n.parent === area.id);
          return (
            <li key={area.id}>
              {area.description}
              {children.length > 0 ? (
                <ul>
                  {children.map((c) => (
                    <li key={c.id}>{c.description}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// The graph

type LayoutMode = "bloom" | "keep" | "reset";

function labelText(n: LifeNode, k: number): string {
  if (n.kind === "area") return n.shortLabel;
  return truncateLabel(n.shortLabel, k < 0.6 ? 12 : 18);
}

function labelPriority(n: LifeNode, index: number): number {
  const base = n.kind === "area" ? 0 : n.kind === "concept" ? 1 : n.kind === "other" ? 3 : n.idle ? 4 : 2;
  return base * 1000 + index;
}

function actionText(n: LifeNode): string {
  return n.area ? `Opens ${detailTitle(n.area)} details.` : "Resets the map view.";
}

function MapStage({ graph, reduced }: { graph: LifeGraph; reduced: boolean }) {
  const { openDetail, openArea } = useDetail();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(stageRef);
  const sizeRef = useLatest(size);
  const reducedRef = useLatest(reduced);
  const graphRef = useLatest(graph);
  const measure = useTextMeasure();
  const ultrawide = useMediaQuery(ULTRAWIDE_QUERY);

  const orientation: Orientation = size ? orientationFor(size.width, size.height, ultrawide) : "landscape";
  const orientationRef = useLatest(orientation);
  const signature = useMemo(() => graphSignature(graph), [graph]);
  const idsKey = useMemo(() => graph.nodes.map((n) => n.id).join("|"), [graph]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  const [view, setView] = useState<ZoomTransform>(zoomIdentity);
  const viewRef = useLatest(view);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  /** The person zoomed, panned or dragged: stop re-framing on resize until Reset view. */
  const userMoved = useRef(false);

  const simRef = useRef<SimState | null>(null);
  /** Where the current layout settles; null after a drag (then current positions are the truth). */
  const finalRef = useRef<SimNode[] | null>(null);
  const lastLayout = useRef<{ orientation: Orientation; resets: number } | null>(null);
  const [, setFrame] = useState(0);
  const redraw = useCallback(() => setFrame((f) => (f + 1) % 1_000_000), []);
  const [labelsOn, setLabelsOn] = useState(false);
  const [resets, setResets] = useState(0);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [tipSize, setTipSize] = useState({ w: 0, h: 0 });
  const hideTimer = useRef<number | null>(null);

  // ---- framing ----

  const fitView = useCallback(
    (nodes: readonly SimNode[]): ZoomTransform | null => {
      const s = sizeRef.current;
      if (!s || s.width === 0 || s.height === 0) return null;
      const narrow = s.width < 560;
      const side = narrow ? 16 : 56;
      const pad = { top: 56, right: side, bottom: narrow ? 20 : 28, left: side };
      const extent = FIT_EXTENT[orientationRef.current];
      let t = fitTransform(nodes, s.width, s.height, pad, extent);
      // Keep the graph clear of the legend card when it floats in the corner (wide screens).
      const legend = legendRef.current;
      if (legend && getComputedStyle(legend).position === "absolute") {
        const right = legend.offsetLeft + legend.offsetWidth + 8;
        const top = legend.offsetTop - 8;
        const overlaps = (v: { k: number; x: number; y: number }) =>
          nodes.some((n) => {
            const r = n.r * nodeScale(v.k) + 16;
            return v.x + v.k * (n.x ?? 0) - r < right && v.y + v.k * (n.y ?? 0) + r > top;
          });
        if (overlaps(t)) {
          // Make room beside the legend or above it, whichever keeps the map bigger.
          const beside = fitTransform(nodes, s.width, s.height, { ...pad, left: Math.max(pad.left, right + 8) }, extent);
          const above = fitTransform(nodes, s.width, s.height, { ...pad, bottom: s.height - top + 4 }, extent);
          t = beside.k >= above.k ? beside : above;
        }
      }
      return zoomIdentity.translate(t.x, t.y).scale(t.k);
    },
    [sizeRef, orientationRef],
  );

  const applyView = useCallback(
    (t: ZoomTransform, animate: boolean) => {
      const svg = svgRef.current;
      const z = zoomRef.current;
      if (!svg || !z) {
        setView(t);
        return;
      }
      const sel = select(svg);
      sel.interrupt();
      if (animate && !reducedRef.current) {
        sel.transition().duration(MOTION.slow * 1000).ease(easeCubicOut).call(z.transform, t);
      } else {
        sel.call(z.transform, t);
      }
    },
    [reducedRef],
  );

  // ---- zoom and pan (wheel, background drag, two-finger touch) ----

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent(ZOOM_EXTENT)
      .filter((event: Event) => {
        if (event.type === "wheel") return true;
        const target = event.target as Element | null;
        if (target?.closest?.("[data-node]")) return false; // nodes drag instead
        // One finger scrolls the page; two fingers pan and pinch the map.
        if (event.type === "touchstart") return (event as TouchEvent).touches.length >= 2;
        const mouse = event as MouseEvent;
        return !mouse.ctrlKey && !mouse.button;
      })
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setView(event.transform);
        if (event.sourceEvent) userMoved.current = true;
      });
    const sel = select(svg);
    sel.call(z);
    zoomRef.current = z;
    return () => {
      sel.interrupt();
      sel.on(".zoom", null);
      zoomRef.current = null;
    };
  }, []);

  useEffect(() => {
    zoomRef.current?.duration(reduced ? 0 : MOTION.base * 1000);
  }, [reduced]);

  // ---- layout: bloom on first show, gentle re-flow on new data, flow back on Reset view ----

  const hasSize = size !== null && size.width > 0 && size.height > 0;
  useEffect(() => {
    if (!hasSize) return;
    const prev = simRef.current;
    const last = lastLayout.current;
    const mode: LayoutMode =
      !prev || !prev.ran || !last || last.orientation !== orientation ? "bloom" : last.resets !== resets ? "reset" : "keep";
    lastLayout.current = { orientation, resets };
    prev?.sim.stop();

    const g = graphRef.current;
    const seeds = seedLayout(g, orientation);
    const from =
      mode === "bloom" || !prev
        ? null
        : new Map(
            prev.nodes.map((n) => [
              n.id,
              { x: n.x ?? 0, y: n.y ?? 0, fx: n.fx, fy: n.fy, pinned: mode === "keep" && !!n.pinned },
            ]),
          );
    const alpha = mode === "bloom" ? 1 : mode === "reset" ? 0.8 : 0.3;
    const build = () => {
      const nodes = simNodes(g, seeds, from);
      return { nodes, sim: createSimulation(nodes, simLinks(g, seeds), alpha) };
    };
    const stateOf = (b: ReturnType<typeof build>, ran: boolean): SimState => ({
      sim: b.sim,
      nodes: b.nodes,
      byId: new Map(b.nodes.map((n) => [n.id, n])),
      ran,
    });

    // Off screen: run a copy to the end to learn where everything settles, and frame that.
    const preview = build();
    runToEnd(preview.sim);
    finalRef.current = preview.nodes;
    if (mode !== "keep" || !userMoved.current) {
      userMoved.current = false;
      const t = fitView(preview.nodes);
      if (t) applyView(t, mode !== "bloom");
    }

    if (reducedRef.current) {
      simRef.current = stateOf(preview, true);
      setLabelsOn(true);
      redraw();
      return;
    }

    const live = build();
    const state = stateOf(live, false);
    simRef.current = state;
    if (mode === "bloom") setLabelsOn(false);
    live.sim.on("tick", () => {
      state.ran = true;
      if (live.sim.alpha() < LABEL_ALPHA) setLabelsOn(true);
      redraw();
    });
    live.sim.on("end", () => {
      state.ran = true;
      setLabelsOn(true);
      redraw();
    });
    live.sim.restart();
    redraw();
    return () => {
      live.sim.on("tick", null).on("end", null);
      live.sim.stop();
    };
  }, [signature, orientation, resets, hasSize, reduced, graphRef, reducedRef, fitView, applyView, redraw]);

  // Areas labels stay out of: the controls, and the legend while it floats over the stage.
  // Measured once per stage size, not every frame.
  const blockedRef = useRef<{ x0: number; y0: number; x1: number; y1: number }[]>([]);
  useLayoutEffect(() => {
    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const add = (el: HTMLElement | null) => {
      if (el) rects.push({ x0: el.offsetLeft - 4, y0: el.offsetTop - 4, x1: el.offsetLeft + el.offsetWidth + 4, y1: el.offsetTop + el.offsetHeight + 4 });
    };
    add(controlsRef.current);
    if (legendRef.current && getComputedStyle(legendRef.current).position === "absolute") add(legendRef.current);
    blockedRef.current = rects;
  }, [size]);

  // Re-frame on resize unless the person has moved the view.
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  useEffect(() => {
    if (!hasSize || userMoved.current || !simRef.current) return;
    const t = fitView(finalRef.current ?? simRef.current.nodes);
    if (t) applyView(t, false);
  }, [width, height, hasSize, fitView, applyView]);

  // ---- drag single nodes (the centre stays put) ----

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let moved = false;
    const behavior = drag<SVGGElement, unknown, DragSubject>()
      .container(svg)
      .clickDistance(4)
      .subject(function () {
        const id = this.getAttribute("data-node") ?? "";
        const n = simRef.current?.byId.get(id);
        const t = viewRef.current;
        return { id, x: t.applyX(n?.x ?? 0), y: t.applyY(n?.y ?? 0) };
      })
      .on("start", () => {
        moved = false;
      })
      .on("drag", (event: D3DragEvent<SVGGElement, unknown, DragSubject>) => {
        const state = simRef.current;
        const n = state?.byId.get(event.subject.id);
        if (!state || !n) return;
        const t = viewRef.current;
        if (!moved) {
          moved = true;
          setDragId(n.id);
          n.pinned = true;
          if (!reducedRef.current) state.sim.alphaTarget(0.25).restart();
        }
        n.fx = t.invertX(event.x);
        n.fy = t.invertY(event.y);
        if (reducedRef.current) {
          n.x = n.fx;
          n.y = n.fy;
          redraw();
        }
      })
      .on("end", () => {
        if (!moved) return;
        moved = false;
        setDragId(null);
        finalRef.current = null;
        userMoved.current = true;
        const state = simRef.current;
        if (!state) return;
        if (reducedRef.current) {
          state.sim.alpha(0.3);
          runToEnd(state.sim);
          redraw();
        } else {
          state.sim.alphaTarget(0); // decays and stops on its own
        }
      });
    const nodes = select(svg).selectAll<SVGGElement, unknown>("[data-node]:not([data-kind='center'])");
    nodes.call(behavior);
    return () => {
      nodes.on(".drag", null);
    };
  }, [idsKey, viewRef, reducedRef, redraw]);

  // Stop everything when the view unmounts.
  useEffect(
    () => () => {
      simRef.current?.sim.stop();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  // ---- controls ----

  const zoomBy = (factor: number) => {
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!svg || !z) return;
    userMoved.current = true;
    const sel = select(svg);
    sel.interrupt();
    if (reduced) sel.call(z.scaleBy, factor);
    else sel.transition().duration(MOTION.base * 1000).ease(easeCubicOut).call(z.scaleBy, factor);
  };

  const resetView = useCallback(() => {
    userMoved.current = false;
    setResets((r) => r + 1);
  }, []);

  const ensureVisible = (id: string) => {
    const n = simRef.current?.byId.get(id);
    const s = sizeRef.current;
    const svg = svgRef.current;
    const z = zoomRef.current;
    if (!n || !s || !svg || !z) return;
    const t = viewRef.current;
    const x = t.applyX(n.x ?? 0);
    const y = t.applyY(n.y ?? 0);
    const m = 40;
    if (x >= m && x <= s.width - m && y >= 56 && y <= s.height - m) return;
    userMoved.current = true;
    const sel = select(svg);
    sel.interrupt();
    if (reduced) sel.call(z.translateTo, n.x ?? 0, n.y ?? 0);
    else sel.transition().duration(MOTION.base * 1000).ease(easeCubicOut).call(z.translateTo, n.x ?? 0, n.y ?? 0);
  };

  // ---- tooltip ----

  const clearHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hover = (id: string) => {
    clearHide();
    setHoverId(id);
    setTipDismissed(false);
  };
  const unhoverSoon = () => {
    clearHide();
    hideTimer.current = window.setTimeout(() => setHoverId(null), 140);
  };

  const activeId = dragId ?? hoverId ?? focusId;
  const tipId = !dragId && !tipDismissed ? (hoverId ?? focusId) : null;
  const tipNode = tipId ? (nodeById.get(tipId) ?? null) : null;

  // Escape hides the tooltip (WCAG 1.4.13), also when it came from hovering.
  useEffect(() => {
    if (!tipId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTipDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tipId]);

  const activate = (n: LifeNode) => {
    clearHide();
    setHoverId(null);
    if (!n.area) {
      resetView();
      return;
    }
    refocusId.current = n.id;
    openDetail(n.area);
  };

  // DetailContext only remembers HTML openers, so closing the detail view sends focus to <main>.
  // Put it back on the node that opened it.
  const refocusId = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusId.current;
    if (openArea !== null || !id) return;
    refocusId.current = null;
    // The overlay hands focus to <main> after its exit animation; wait for that, then move it on.
    const started = Date.now();
    let timer = 0;
    const check = () => {
      if (document.activeElement?.id === "main") {
        svgRef.current?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
        return;
      }
      if (Date.now() - started < 2500) timer = window.setTimeout(check, 40);
    };
    timer = window.setTimeout(check, 40);
    return () => window.clearTimeout(timer);
  }, [openArea]);

  const onNodeKey = (e: ReactKeyboardEvent<SVGGElement>, n: LifeNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(n);
    }
  };

  // ---- geometry for this frame ----

  const state = simRef.current;
  const k = view.k;
  const ns = nodeScale(k);
  const screen = (id: string): { x: number; y: number } => {
    const n = state?.byId.get(id);
    return n ? { x: view.applyX(n.x ?? 0), y: view.applyY(n.y ?? 0) } : { x: width / 2, y: height / 2 };
  };
  const ready = !!state && hasSize;
  const outer = (n: LifeNode) => n.radius * ns + (n.halo ? 6 : 0);

  const related = useMemo(() => {
    if (!activeId || activeId === "center") return null;
    const n = nodeById.get(activeId);
    if (!n) return null;
    const set = new Set<string>([activeId, "center"]);
    if (n.parent) set.add(n.parent);
    for (const m of graph.nodes) if (m.parent === activeId) set.add(m.id);
    return set;
  }, [activeId, nodeById, graph]);

  let labels: Map<string, LabelBox> | null = null;
  if (ready && labelsOn) {
    const inputs: LabelInput[] = [];
    const circles: { id: string; x: number; y: number; r: number }[] = [];
    graph.nodes.forEach((n, index) => {
      const p = screen(n.id);
      circles.push({ id: n.id, x: p.x, y: p.y, r: outer(n) });
      if (n.kind === "center") return;
      const parent = n.parent ? screen(n.parent) : { x: p.x, y: p.y - 1 };
      const len = Math.hypot(p.x - parent.x, p.y - parent.y) || 1;
      inputs.push({
        id: n.id,
        x: p.x,
        y: p.y,
        r: outer(n),
        width: measure(labelText(n, k), n.kind === "area" ? "area" : "node"),
        height: LABEL_HEIGHT,
        dx: (p.x - parent.x) / len,
        dy: (p.y - parent.y) / len,
        priority: labelPriority(n, index),
        force: n.id === activeId,
      });
    });
    labels = placeLabels(inputs, circles, { width, height }, blockedRef.current);
  }

  // Tooltip placement: beside the node, flipped and clamped to stay inside the stage.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== tipSize.w || h !== tipSize.h) setTipSize({ w, h });
  });
  let tipStyle: CSSProperties | undefined;
  if (tipNode && ready) {
    const p = screen(tipNode.id);
    const r = outer(tipNode) + 12;
    let left = p.x + r;
    if (left + tipSize.w > width - 8) left = p.x - r - tipSize.w;
    left = Math.max(8, Math.min(left, width - tipSize.w - 8));
    const top = Math.max(8, Math.min(p.y - tipSize.h / 2, height - tipSize.h - 8));
    tipStyle = { left, top };
  }

  const minZoom = k <= ZOOM_EXTENT[0] + 0.001;
  const maxZoom = k >= ZOOM_EXTENT[1] - 0.001;
  const center = screen("center");
  const noProjects = !graph.nodes.some((n) => n.kind === "project" || n.kind === "other");
  const workArea = graph.areas.find((a) => a.area === "work");

  return (
    <div className={styles.frame}>
      <div ref={stageRef} className={styles.stage} data-ready={ready || undefined}>
        {/* Controls come first in the DOM so Tab reaches them before the graph's many nodes. */}
        <div ref={controlsRef} className={styles.controls} role="group" aria-label="Map view">
          {/* aria-disabled, not disabled: the button stays hoverable and focusable so its tip can say why. */}
          <Button
            size="sm"
            icon={<MinusIcon />}
            aria-label="Zoom out"
            aria-disabled={minZoom || undefined}
            className={minZoom ? styles.inactive : undefined}
            tip={
              minZoom
                ? "Does nothing now because the map is at its widest view; zoom in or use Reset view."
                : "Zooms out to show more of the map; scrolling over the map does the same."
            }
            onClick={() => {
              if (!minZoom) zoomBy(1 / ZOOM_STEP);
            }}
          />
          <Button
            size="sm"
            icon={<PlusIcon />}
            aria-label="Zoom in"
            aria-disabled={maxZoom || undefined}
            className={maxZoom ? styles.inactive : undefined}
            tip={
              maxZoom
                ? "Does nothing now because the map is at its closest view; zoom out or use Reset view."
                : "Zooms in to spread nodes apart; labels keep their size."
            }
            onClick={() => {
              if (!maxZoom) zoomBy(ZOOM_STEP);
            }}
          />
          <Button
            size="sm"
            icon={<RecenterIcon />}
            onClick={resetView}
            tip="Fits the whole map in view and puts nodes you dragged back in place."
          >
            Reset view
          </Button>
        </div>
        <svg
          ref={svgRef}
          className={styles.svg}
          width={width}
          height={height}
          role="group"
          aria-label={`Life map graph: ${graph.nodes.length} nodes. Tab moves between them.`}
          data-dragging={dragId ? true : undefined}
        >
          <g className={styles.rings} aria-hidden="true">
            {RING_RADII.map((r) => (
              <circle key={r} cx={center.x} cy={center.y} r={r * k} />
            ))}
          </g>

          <g className={styles.links} aria-hidden="true">
            {ready
              ? graph.links.map((l) => {
                  const a = nodeById.get(l.source);
                  const b = nodeById.get(l.target);
                  if (!a || !b) return null;
                  const pa = screen(a.id);
                  const pb = screen(b.id);
                  const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
                  const ra = outer(a) + 2;
                  const rb = outer(b) + 2;
                  if (dist <= ra + rb) return null;
                  const ux = (pb.x - pa.x) / dist;
                  const uy = (pb.y - pa.y) / dist;
                  const hot = !!related && related.has(l.source) && related.has(l.target);
                  return (
                    <line
                      key={l.id}
                      className={styles.link}
                      x1={pa.x + ux * ra}
                      y1={pa.y + uy * ra}
                      x2={pb.x - ux * rb}
                      y2={pb.y - uy * rb}
                      data-dashed={l.dashed || undefined}
                      data-idle={l.idle || undefined}
                      data-hot={hot || undefined}
                      data-dim={(related && !hot) || undefined}
                    />
                  );
                })
              : null}
          </g>

          <g className={styles.nodes} data-hidden={!ready || undefined}>
            {graph.nodes.map((n) => {
              const p = screen(n.id);
              const r = n.radius * ns;
              const isActive = n.id === activeId;
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  data-kind={n.kind}
                  data-idle={n.idle || undefined}
                  data-off={!n.connected || undefined}
                  data-halo={n.halo ?? undefined}
                  data-hot={isActive || undefined}
                  data-dim={(related && !related.has(n.id)) || undefined}
                  className={styles.node}
                  transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${n.description} ${actionText(n)}`}
                  style={{ "--enter": n.kind === "center" ? 0 : n.kind === "area" ? 1 : 2 } as CSSProperties}
                  onClick={(e) => {
                    // A pointer click does not focus an SVG node; focus it so closing the detail view
                    // returns focus here instead of to the page.
                    if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
                    activate(n);
                  }}
                  onKeyDown={(e) => onNodeKey(e, n)}
                  onMouseEnter={() => hover(n.id)}
                  onMouseLeave={unhoverSoon}
                  onFocus={() => {
                    setFocusId(n.id);
                    setTipDismissed(false);
                    ensureVisible(n.id);
                  }}
                  onBlur={() => setFocusId((f) => (f === n.id ? null : f))}
                >
                  <circle className={styles.hit} r={Math.max(r + 4, 12)} />
                  {n.halo ? (
                    <>
                      <circle className={styles.haloGlow} r={r + 6} />
                      <circle className={styles.halo} r={r + 6} />
                    </>
                  ) : null}
                  {n.kind === "center" ? <circle className={styles.centerRing} r={r + 9} /> : null}
                  {n.kind === "concept" ? (
                    <path className={styles.shape} d={hexPath(r * 1.08)} />
                  ) : (
                    <circle className={styles.shape} r={r} />
                  )}
                  {n.kind === "project" || n.kind === "center" ? <circle className={styles.fill} r={r * 0.8} /> : null}
                  {n.kind === "concept" ? <path className={styles.fill} d={hexPath(r * 0.82)} /> : null}
                  {n.kind === "other" ? <circle className={styles.inner} r={r * 0.6} /> : null}
                  {n.kind === "area" && n.connected ? <circle className={styles.core} r={Math.max(2.5, r * 0.3)} /> : null}
                  {n.kind === "center" ? (
                    <text className={styles.centerText} textAnchor="middle" dominantBaseline="central">
                      {n.label}
                    </text>
                  ) : null}
                  {n.halo ? (
                    <path
                      className={styles.badge}
                      d={badgePath(n.halo, 4.5)}
                      transform={`translate(${((r + 6) * Math.SQRT1_2).toFixed(2)} ${(-(r + 6) * Math.SQRT1_2).toFixed(2)})`}
                    />
                  ) : null}
                  <circle className={styles.focusRing} r={r + (n.halo ? 11 : 6)} />
                </g>
              );
            })}
          </g>

          <g className={styles.labels} aria-hidden="true" data-on={(ready && labelsOn) || undefined}>
            {labels
              ? graph.nodes.map((n) => {
                  const box = labels?.get(n.id);
                  if (!box || !box.visible) return null;
                  return (
                    <text
                      key={n.id}
                      className={styles.label}
                      x={box.cx.toFixed(1)}
                      y={box.cy.toFixed(1)}
                      textAnchor="middle"
                      dominantBaseline="central"
                      data-kind={n.kind}
                      data-idle={n.idle || undefined}
                      data-off={!n.connected || undefined}
                      data-hot={n.id === activeId || undefined}
                      data-dim={(related && !related.has(n.id)) || undefined}
                    >
                      {labelText(n, k)}
                    </text>
                  );
                })
              : null}
          </g>
        </svg>

        {noProjects ? (
          <p className={styles.note}>
            {workArea && !workArea.collected
              ? "Projects appear after the first collection. Use Refresh at the top."
              : "No projects yet. Time from Claude sessions and GitHub commits shows up here."}
          </p>
        ) : null}

        {tipNode && tipStyle ? (
          <div
            ref={tipRef}
            className={styles.tip}
            style={tipStyle}
            aria-hidden="true"
            onMouseEnter={clearHide}
            onMouseLeave={unhoverSoon}
          >
            <p className={styles.tipKind}>{tipNode.kindText}</p>
            <p className={styles.tipTitle}>{tipNode.label}</p>
            <ul className={styles.tipFacts}>
              {tipNode.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {tipNode.alerts.length > 0 ? (
              <ul className={styles.tipAlerts}>
                {tipNode.alerts.slice(0, 3).map((a) => (
                  <li key={a.id}>
                    <StatusDot tone={toneForUrgency(a.urgency)} size={9} glow={false} />
                    <span>{a.title}</span>
                  </li>
                ))}
                {tipNode.alerts.length > 3 ? <li className={styles.tipMore}>+{tipNode.alerts.length - 3} more</li> : null}
              </ul>
            ) : null}
            <p className={styles.tipHint}>
              {tipNode.area ? `Select to open ${detailTitle(tipNode.area)}` : "Select to reset the view"}
            </p>
          </div>
        ) : null}
      </div>
      <Legend legendRef={legendRef} />
    </div>
  );
}

function Legend({ legendRef }: { legendRef: RefObject<HTMLDivElement> }) {
  return (
    <div ref={legendRef} className={styles.legend}>
      <p className={styles.legendTitle}>Legend</p>
      <ul className={styles.legendList}>
        <li>
          <svg className={styles.legendIcon} viewBox="0 0 28 18" aria-hidden="true" focusable="false">
            <g className={styles.node} data-kind="project" transform="translate(9 9)">
              <circle className={styles.shape} r="7.5" />
              <circle className={styles.fill} r="6" />
            </g>
            <g className={styles.node} data-kind="project" data-idle="true" transform="translate(23 11)">
              <circle className={styles.shape} r="3.5" />
            </g>
          </svg>
          <span>
            <strong>Size</strong> attention in the last 7 days. Dim means none.
          </span>
        </li>
        <li>
          <svg className={styles.legendIcon} viewBox="0 0 28 18" aria-hidden="true" focusable="false">
            <g className={styles.node} data-kind="project" data-halo="red" transform="translate(12 9)">
              <circle className={styles.halo} r="7" />
              <circle className={styles.shape} r="4" />
              <path className={styles.badge} d={badgePath("red", 2.6)} transform="translate(5 -5)" />
            </g>
          </svg>
          <span>
            <strong>Halo</strong> needs you. Red today, amber this week.
          </span>
        </li>
        <li>
          <svg className={styles.legendIcon} viewBox="0 0 28 18" aria-hidden="true" focusable="false">
            <g className={styles.node} data-kind="area" data-off="true" transform="translate(12 9)">
              <circle className={styles.shape} r="7" />
            </g>
          </svg>
          <span>
            <strong>Dashed</strong> not connected yet.
          </span>
        </li>
      </ul>
      <p className={styles.legendHint}>
        <span className={styles.hintFine}>Drag a node to move it. Scroll to zoom, drag the background to pan.</span>
        <span className={styles.hintCoarse}>Tap a node to open it. Pinch with two fingers to zoom.</span>
      </p>
    </div>
  );
}
