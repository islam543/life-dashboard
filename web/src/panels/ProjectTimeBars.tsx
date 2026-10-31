import { scaleLinear } from "d3";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { areaLabel, dayKey, formatMinutes, plural } from "../lib/format";
import { projectHash } from "../lib/route";
import {
  projectTotals,
  registryReady,
  registryRows,
  registryTotals,
  topWithOther,
  type BarRow,
  type TimeRange,
} from "../lib/timeAgg";
import linkStyles from "../projects/ProjectLink.module.css";
import { CountUp } from "../ui/CountUp";
import { Panel, panelFromSource } from "../ui/Panel";
import styles from "./ProjectTimeBars.module.css";

// Time by project: sorted horizontal bars of Claude Code session time, this week or this month.
// Bars are the tracked projects from the registry (name from the registry, each name a link to
// #/projects/<id>); untracked names and anything past the top 8 fold into "Other"; hidden names are
// left out. Until the server has a registry it groups by detected name. Bars grow in on first load
// and glide to their new length when the period changes. Labels left, values right-aligned in mono.
//
// This file also holds small chart helpers the week timeline and the year heatmap reuse:
// useElementWidth, useStoredChoice, Segmented (one-of-N toggle) and ChartTooltip. Candidates for ui/.

// ---------------------------------------------------------------------------------------------
// Shared chart helpers
// ---------------------------------------------------------------------------------------------

/** Content-box width of an element in CSS px, kept current with a ResizeObserver. 0 until measured. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Same box as ResizeObserver's contentRect: inside padding, without a scrollbar.
    const cs = getComputedStyle(el);
    setWidth(Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A choice remembered in this browser (per-viewer convenience). Falls back quietly when storage is blocked. */
export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved && (allowed as readonly string[]).includes(saved) ? (saved as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        // Private window or blocked storage: the choice is just not remembered.
      }
    },
    [key],
  );
  return [value, set];
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A one-of-N toggle for a panel header (Week | Month, the heatmap metric). Each option is a real
 * button with aria-pressed, so Tab and Enter/Space work with no extra key handling. A glowing thumb
 * slides to the pressed option.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [animated, setAnimated] = useState(false);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const measure = () => {
      const el = host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!el) return;
      const next = { x: el.offsetLeft, w: el.offsetWidth };
      setThumb((prev) => (prev && prev.x === next.x && prev.w === next.w ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure); // fonts loading, header wrapping
    ro.observe(host);
    return () => ro.disconnect();
  }, [value, options]);

  // Slide only after the first placement, so the thumb never flies in from the left on load.
  useEffect(() => {
    if (!thumb || animated) return;
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(id);
  }, [thumb, animated]);

  return (
    <div ref={ref} role="group" aria-label={label} className={styles.segmented}>
      {thumb ? (
        <span
          aria-hidden="true"
          className={[styles.thumb, animated ? styles.thumbAnimated : ""].join(" ")}
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      ) : null}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.segment}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface TipData {
  /** Anchor in the host's coordinates: horizontal centre, and the target's top and bottom edges. */
  x: number;
  top: number;
  bottom: number;
  title: ReactNode;
  value?: ReactNode;
  meta?: ReactNode;
  tone?: "default" | "danger" | "warn";
}

/**
 * Visual-only tooltip (aria-hidden): every target already carries the same text in its accessible
 * name. Render it inside a position: relative host and pass the host's width so it never spills
 * sideways. Sits above the target, or below it when there is no room above.
 */
export function ChartTooltip({ tip, hostWidth }: { tip: TipData | null; hostWidth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, [tip]);

  if (!tip) return null;
  const gap = 8;
  const left = Math.max(0, Math.min(tip.x - size.w / 2, Math.max(0, hostWidth - size.w)));
  const above = tip.top - size.h - gap >= -40; // may rise into the panel header, not past it
  const top = above ? tip.top - size.h - gap : tip.bottom + gap;
  const tone = tip.tone === "danger" ? styles.tipDanger : tip.tone === "warn" ? styles.tipWarn : "";
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={[styles.tip, tone].join(" ")}
      style={{ left, top, visibility: size.w ? "visible" : "hidden" }}
    >
      <span className={styles.tipTitle}>{tip.title}</span>
      {tip.value ? <span className={styles.tipValue}>{tip.value}</span> : null}
      {tip.meta ? <span className={styles.tipMeta}>{tip.meta}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Time by project
// ---------------------------------------------------------------------------------------------

const RANGES: readonly SegmentedOption<TimeRange>[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];
const RANGE_VALUES = RANGES.map((r) => r.value);

const BAR_H = 14;

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "under 1%" : `${Math.round(p)}%`;
}

/** "Other (5 projects)", or with a registry "Other (3 untracked, 2 projects)". */
function otherTitle(row: BarRow): string {
  if (row.untracked === undefined) return `Other (${row.members.length} projects)`;
  const projects = row.members.length - row.untracked;
  const parts = [row.untracked > 0 ? `${row.untracked} untracked` : "", projects > 0 ? plural(projects, "project") : ""];
  return `Other (${parts.filter(Boolean).join(", ")})`;
}

/** Screen reader words for the Other row. */
function otherWhat(row: BarRow): string {
  if (row.untracked === undefined) return `combined total of ${row.members.length} projects`;
  const projects = row.members.length - row.untracked;
  const parts = [row.untracked > 0 ? plural(row.untracked, "untracked name") : "", projects > 0 ? plural(projects, "smaller project") : ""];
  return `combined total of ${parts.filter(Boolean).join(" and ")}`;
}

function listNames(names: readonly string[], shown = 3): string {
  if (names.length <= shown) return names.join(", ");
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

interface BarProps {
  fraction: number;
  index: number;
  firstDraw: boolean;
  /** The "Other" aggregate: striped, so it never reads as one more project. */
  other: boolean;
  /** Longer than the scale (Other beyond the top project): drawn full length with a break mark at the end. */
  capped: boolean;
}

/** One bar: d3 gives the length, a motion value draws it in and glides it on change; resizing is instant. */
function Bar({ fraction, index, firstDraw, other, capped }: BarProps) {
  const reduced = useReducedMotion();
  const gradientId = `bar-${useId().replace(/:/g, "")}`;
  const [hostRef, width] = useElementWidth<HTMLDivElement>();
  const frac = useMotionValue(reduced ? fraction : 0);
  const track = useMotionValue(width);
  const mounted = useRef(false);

  useEffect(() => {
    track.set(width);
  }, [track, width]);

  useEffect(() => {
    if (reduced) {
      frac.set(fraction);
      mounted.current = true;
      return;
    }
    const first = !mounted.current;
    mounted.current = true;
    const controls = animate(frac, fraction, {
      duration: first && firstDraw ? MOTION.draw : MOTION.slow,
      delay: first && firstDraw ? index * MOTION.stagger : 0,
      ease: MOTION.easeOut,
    });
    return () => controls.stop();
  }, [frac, fraction, reduced, firstDraw, index]);

  const barWidth = useTransform(() => Math.max(0, frac.get() * track.get()));
  const capX = useTransform(() => Math.max(0, frac.get() * track.get() - 2));
  const capOpacity = useTransform(() => (frac.get() > 0.002 ? 1 : 0));
  // The break mark shows once a capped bar has reached the end of the track.
  const breakOpacity = useTransform(() => (frac.get() > 0.97 ? 1 : 0));

  return (
    <div ref={hostRef} className={styles.track}>
      {width > 0 ? (
        <svg width={width} height={BAR_H} viewBox={`0 0 ${width} ${BAR_H}`} aria-hidden="true" focusable="false">
          <defs>
            {other ? (
              <pattern id={gradientId} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={5} height={5} className={styles.otherFill} />
                <rect width={2} height={5} className={styles.otherStripe} />
              </pattern>
            ) : (
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" className={styles.barStart} />
                <stop offset="100%" className={styles.barEnd} />
              </linearGradient>
            )}
          </defs>
          <line className={styles.trackLine} x1={0} x2={width} y1={BAR_H / 2} y2={BAR_H / 2} />
          <motion.rect
            className={[styles.bar, other ? styles.otherBar : ""].join(" ")}
            x={0}
            y={3}
            height={BAR_H - 6}
            rx={2}
            width={barWidth}
            fill={`url(#${gradientId})`}
          />
          {capped ? (
            <motion.g className={styles.barBreak} style={{ opacity: breakOpacity }}>
              <line x1={width - 13} y1={BAR_H - 1} x2={width - 9} y2={1} />
              <line x1={width - 8} y1={BAR_H - 1} x2={width - 4} y2={1} />
            </motion.g>
          ) : (
            <motion.rect
              className={other ? styles.otherCap : styles.cap}
              y={1}
              width={2}
              height={BAR_H - 2}
              rx={1}
              x={capX}
              style={{ opacity: capOpacity }}
            />
          )}
        </svg>
      ) : null}
    </div>
  );
}

function Bars({ rows, total, range, daysSoFar }: { rows: BarRow[]; total: number; range: TimeRange; daysSoFar: number }) {
  const [hostRef, hostWidth] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipData | null>(null);
  const [firstDraw, setFirstDraw] = useState(true);

  // After the first reveal, rows that appear on a period switch grow without the load-time stagger.
  useEffect(() => {
    const id = window.setTimeout(() => setFirstDraw(false), (MOTION.draw + 9 * MOTION.stagger) * 1000);
    return () => window.clearTimeout(id);
  }, []);

  // The scale is set by the named projects only. "Other" adds up many projects, so in Month view it can
  // be longer than #1; its bar then stops at the end of the track (clamped) with a break mark.
  const max = rows.reduce((m, r) => (r.isOther ? m : Math.max(m, r.minutes)), 0);
  const x = scaleLinear().domain([0, max || 1]).range([0, 1]).clamp(true);
  const isCapped = (row: BarRow) => row.isOther && max > 0 && row.minutes > max;
  const period = range === "week" ? "this week" : "this month";

  const showTip = (row: BarRow, li: HTMLLIElement) => {
    const host = hostRef.current;
    const trackEl = li.querySelector<HTMLElement>(`.${styles.track}`);
    if (!host || !trackEl) return;
    const h = host.getBoundingClientRect();
    const t = trackEl.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    setTip({
      x: t.left - h.left + x(row.minutes) * t.width,
      top: r.top - h.top,
      bottom: r.bottom - h.top,
      title: row.isOther ? otherTitle(row) : row.label,
      value: `${formatMinutes(row.minutes)}, ${percent(row.minutes, total)} of ${period}`,
      meta: row.isOther
        ? `${isCapped(row) ? "Combined total, longer than the scale. " : "Combined total. "}${listNames(row.members)}`
        : `${row.area ? `${areaLabel(row.area)} project. ` : ""}Active ${row.activeDays} of ${daysSoFar} ${daysSoFar === 1 ? "day" : "days"} so far`,
    });
  };

  return (
    <div ref={hostRef} className={styles.host} onPointerLeave={() => setTip(null)}>
      <ol className={styles.list} aria-label={`Claude Code time per project, ${period}`}>
        {rows.map((row, i) => (
          <li
            key={row.key}
            className={[styles.row, row.isOther ? styles.other : ""].join(" ")}
            onPointerEnter={(e) => showTip(row, e.currentTarget)}
          >
            <span className={styles.rank} aria-hidden="true">
              {row.isOther ? "+" : String(i + 1).padStart(2, "0")}
            </span>
            {row.projectId ? (
              <a className={[styles.label, linkStyles.link].join(" ")} href={projectHash(row.projectId)} title={row.label}>
                {row.label}
              </a>
            ) : (
              <span className={styles.label} title={row.isOther ? listNames(row.members, 12) : row.label}>
                {row.isOther ? (
                  <>
                    Other <span className={styles.count}>({row.members.length})</span>
                  </>
                ) : (
                  row.label
                )}
              </span>
            )}
            <Bar fraction={x(row.minutes)} index={i} firstDraw={firstDraw} other={row.isOther} capped={isCapped(row)} />
            <span className={styles.value}>
              <CountUp value={row.minutes} format={formatMinutes} flash={false} />
            </span>
            <span className="sr-only">
              , {percent(row.minutes, total)} of {period}
              {row.isOther ? `, ${otherWhat(row)}: ${listNames(row.members, 12)}` : ""}
            </span>
          </li>
        ))}
      </ol>
      <ChartTooltip tip={tip} hostWidth={hostWidth} />
    </div>
  );
}

export function ProjectTimeBars() {
  const snap = useSnapshot();
  const [range, setRange] = useStoredChoice<TimeRange>("life-dashboard:time-range", RANGE_VALUES, "week");
  const now = new Date();
  const today = dayKey(now);
  const sessions = snap.data?.work.sessionTime;

  // `today` keeps the totals right across midnight without recomputing on every render.
  const registry = snap.data?.projects;
  // `today` keeps the totals right across midnight without recomputing on every render.
  const { rows, total } = useMemo(() => {
    if (!sessions) return { rows: [] as BarRow[], total: 0 };
    if (registryReady(registry)) {
      const { tracked, untracked } = registryTotals(registry, sessions, range, new Date());
      const sum = [...tracked, ...untracked].reduce((s, t) => s + t.minutes, 0);
      return { rows: registryRows(tracked, untracked), total: sum };
    }
    const totals = projectTotals(sessions, range, new Date());
    return { rows: topWithOther(totals), total: totals.reduce((s, t) => s + t.minutes, 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, registry, range, today]);
  const daysSoFar = range === "week" ? now.getDay() + 1 : now.getDate();

  const status = panelFromSource(snap, "claudeSessions", {
    isEmpty: () => rows.length === 0,
    empty: range === "week" ? "No Claude Code time this week yet." : "No Claude Code time this month yet.",
    emptyHint:
      range === "week"
        ? "Switch to Month to see earlier work, or start a session in any project."
        : "Time shows here after your first Claude Code session of the month.",
  });
  const showToggle = status.state === "ok" || status.state === "empty";

  return (
    <Panel
      title="Time by project"
      {...status}
      skeleton="chart"
      detail={{ area: "work", key: "time" }}
      meta={status.state === "ok" ? `${formatMinutes(total)} total` : undefined}
      action={showToggle ? <Segmented label="Period" options={RANGES} value={range} onChange={setRange} /> : undefined}
    >
      <Bars rows={rows} total={total} range={range} daysSoFar={daysSoFar} />
    </Panel>
  );
}
