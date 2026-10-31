import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import type { Area, Snapshot } from "../../../shared/types";
import { useDetailTrigger } from "../context/DetailContext";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { dayKey, formatMinutes, formatNumber, plural, type SourceKey } from "../lib/format";
import {
  DAY_SHORT,
  buildHeatGrid,
  heatStats,
  longDay,
  shortDay,
  sumByDay,
  type HeatCell,
  type HeatFill,
  type HeatGrid,
  type HeatStats,
} from "../lib/timeAgg";
import { CountUp } from "../ui/CountUp";
import { Panel, panelFromSource } from "../ui/Panel";
import { ChartTooltip, Segmented, useElementWidth, useStoredChoice, type SegmentedOption, type TipData } from "./ProjectTimeBars";
import styles from "./YearHeatmap.module.css";

// Last 52 weeks as a GitHub-style grid, one square per day, newest week on the right.
// A selector switches the metric. Five cyan steps (zero plus four quantiles of the days above zero);
// a hollow square is a day with no data, which is not the same as zero.
// Keyboard: one tab stop; arrows move a day (up/down) or a week (left/right), Home/End go to the
// ends of the row, Ctrl+Home/End to the first and last day; Enter opens the metric's detail view.
// Narrow screens: the grid scrolls inside its own box and starts scrolled to the newest weeks.

type Metric = "work" | "commits" | "sleep" | "workouts";

const METRICS: readonly SegmentedOption<Metric>[] = [
  { value: "work", label: "Work", tip: "Colours each day by time in Claude Code sessions." },
  { value: "commits", label: "Commits", tip: "Colours each day by commits across your repos." },
  { value: "sleep", label: "Sleep", tip: "Colours each night by hours slept, from your evening check-ins." },
  { value: "workouts", label: "Workouts", tip: "Colours each day by workout minutes, from your evening check-ins." },
];
const METRIC_VALUES = METRICS.map((m) => m.value);

interface StatSpec {
  label: string;
  value: number | null;
  format: (n: number) => string;
  sub: string;
}

interface MetricDef {
  source: SourceKey;
  area: Area;
  fill: HeatFill;
  /** Accessible name of the grid. */
  gridLabel: string;
  values: (s: Snapshot) => Map<string, number>;
  /** One day's value for the tooltip and the cell's accessible name. */
  describe: (v: number) => string;
  /** What a hollow day means for this metric. */
  noData: string;
  empty: string;
  emptyHint: string;
  stats: (s: HeatStats, days: number) => StatSpec[];
}

const hours1 = (n: number) => `${formatNumber(n, 1)} h`;
const count = (n: number) => formatNumber(n);
const days = (n: number) => plural(Math.round(n), "day");

function streakStats(s: HeatStats): StatSpec {
  return { label: "Current streak", value: s.currentStreak, format: days, sub: `Best ${days(s.bestStreak)}` };
}

const DEFS: Record<Metric, MetricDef> = {
  work: {
    source: "claudeSessions",
    area: "work",
    fill: "fromFirst",
    gridLabel: "Claude Code time per day",
    values: (s) => sumByDay(s.work.sessionTime.map((p) => p.minutesByDay)),
    describe: (v) => (v > 0 ? `${formatMinutes(v)} in Claude Code` : "No Claude Code time"),
    noData: "No session logs",
    empty: "No Claude Code sessions in the last year.",
    emptyHint: "Time per day shows here after your first session in any project.",
    stats: (s, n) => [
      { label: "Total", value: s.total, format: formatMinutes, sub: "Last 52 weeks" },
      { label: "Active days", value: s.activeDays, format: count, sub: `Of ${plural(s.daysWithData || n, "day")} logged` },
      streakStats(s),
      { label: "Best day", value: s.max?.value ?? null, format: formatMinutes, sub: s.max ? shortDay(s.max.date) : "None yet" },
    ],
  },
  commits: {
    source: "github",
    area: "work",
    fill: "all",
    gridLabel: "Commits per day",
    values: (s) => sumByDay(s.work.repoActivity.map((r) => r.commitsByDay)),
    describe: (v) => (v > 0 ? plural(v, "commit") : "No commits"),
    noData: "No commit stats",
    empty: "No commit stats yet.",
    emptyHint: "GitHub builds commit stats in the background. They fill in over the next few refreshes.",
    stats: (s) => [
      { label: "Commits", value: s.total, format: count, sub: "Last 52 weeks" },
      { label: "Active days", value: s.activeDays, format: count, sub: `Of ${plural(s.daysWithData, "day")}` },
      streakStats(s),
      { label: "Best day", value: s.max?.value ?? null, format: count, sub: s.max ? shortDay(s.max.date) : "None yet" },
    ],
  },
  sleep: {
    source: "checkins",
    area: "personal",
    fill: "none",
    gridLabel: "Sleep per night from check-ins",
    values: (s) => new Map(s.personal.checkins.map((c) => [c.date, c.sleepHours] as const)),
    describe: (v) => `${hours1(v)} of sleep`,
    noData: "No check-in",
    empty: "No check-ins yet.",
    emptyHint: "Do the evening check-in and each night's sleep lands here.",
    stats: (s) => [
      { label: "Average", value: s.daysWithData ? s.mean : null, format: hours1, sub: "Per logged night" },
      { label: "Nights logged", value: s.daysWithData, format: count, sub: "Last 52 weeks" },
      { label: "Shortest", value: s.min?.value ?? null, format: hours1, sub: s.min ? shortDay(s.min.date) : "None yet" },
      { label: "Longest", value: s.max?.value ?? null, format: hours1, sub: s.max ? shortDay(s.max.date) : "None yet" },
    ],
  },
  workouts: {
    source: "checkins",
    area: "personal",
    fill: "none",
    gridLabel: "Workout minutes per day from check-ins",
    values: (s) => new Map(s.personal.checkins.map((c) => [c.date, c.workoutMinutes] as const)),
    describe: (v) => (v > 0 ? `${formatMinutes(v)} workout` : "No workout"),
    noData: "No check-in",
    empty: "No check-ins yet.",
    emptyHint: "Do the evening check-in and each day's workout lands here.",
    stats: (s) => [
      { label: "Total", value: s.total, format: formatMinutes, sub: "Last 52 weeks" },
      { label: "Workout days", value: s.activeDays, format: count, sub: `Of ${plural(s.daysWithData, "check-in")}` },
      streakStats(s),
      { label: "Longest", value: s.max?.value ?? null, format: formatMinutes, sub: s.max ? shortDay(s.max.date) : "None yet" },
    ],
  },
};

const TOP = 20; // month label band
const LABEL_W = 30; // weekday label column
const MIN_STEP = 12;
const MAX_STEP = 20;

function geometry(available: number, weeks: number) {
  const step = Math.max(MIN_STEP, Math.min(MAX_STEP, Math.floor(available / weeks)));
  const gap = step >= 17 ? 4 : step >= 14 ? 3 : 2;
  const cell = step - gap;
  return { step, gap, cell, width: weeks * step - gap, height: TOP + 7 * step - gap };
}

function bucketClass(bucket: number): string {
  return styles[`b${bucket < 0 ? "None" : bucket}`] ?? "";
}

function rangeText(thresholds: readonly number[], max: number, describe: (v: number) => string): string[] {
  // Four steps: below t0, t0 to t1, t1 to t2, t2 and up. With fewer thresholds the top steps are unused.
  if (thresholds.length === 0) return max > 0 ? ["", "", "", `Up to ${describe(max)}`] : ["", "", "", ""];
  const [a, b, c] = thresholds as [number, number, number];
  return [`Under ${describe(a)}`, `${describe(a)} or more`, `${describe(b)} or more`, `${describe(c)} or more`];
}

function Stats({ items, metric }: { items: StatSpec[]; metric: Metric }) {
  return (
    <dl className={styles.stats}>
      {items.map((s) => (
        <div key={`${metric}-${s.label}`} className={styles.stat}>
          <dt className={styles.statLabel}>{s.label}</dt>
          <dd className={styles.statValue}>
            {s.value === null ? <span className={styles.statNone}>None</span> : <CountUp value={s.value} format={s.format} flash={false} />}
          </dd>
          <dd className={styles.statSub}>{s.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function Heatmap({ grid, def, metric, note }: { grid: HeatGrid; def: MetricDef; metric: Metric; note?: string }) {
  const reduced = useReducedMotion();
  const trigger = useDetailTrigger(def.area, "year");
  const [hostRef, hostWidth] = useElementWidth<HTMLDivElement>();
  const [scrollRef, scrollWidth] = useElementWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState(() => grid.cells.length - 1);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ i: number; visible: boolean } | null>(null);
  const [tip, setTip] = useState<TipData | null>(null);
  const [reveal] = useState(() => !reduced);

  const g = geometry(scrollWidth || 600, grid.weeks);
  const cells = grid.cells;
  const last = cells.length - 1;
  const activeIndex = Math.min(active, last);
  const stats = useMemo(() => heatStats(grid), [grid]);

  // Newest weeks first: start scrolled to the right edge once the size is known.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollWidth === 0 || scrolled.current) return;
    el.scrollLeft = el.scrollWidth;
    scrolled.current = true;
  }, [scrollRef, scrollWidth]);

  const rows = useMemo(() => {
    const byDay: HeatCell[][] = Array.from({ length: 7 }, () => []);
    cells.forEach((c) => byDay[c.day]!.push(c));
    return byDay;
  }, [cells]);
  const indexOf = useMemo(() => new Map(cells.map((c, i) => [c.key, i] as const)), [cells]);

  const label = (c: HeatCell) =>
    `${longDay(c.date)}${c.isToday ? " (today)" : ""}: ${c.value === null ? def.noData : def.describe(c.value)}`;

  const tipFor = (i: number, el: Element): TipData | null => {
    const host = hostRef.current;
    const c = cells[i];
    if (!host || !c) return null;
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      x: r.left - h.left + r.width / 2,
      top: r.top - h.top,
      bottom: r.bottom - h.top,
      title: `${longDay(c.date)}${c.isToday ? ", today so far" : ""}`,
      value: c.value === null ? def.noData : def.describe(c.value),
    };
  };

  const cellIndex = (target: EventTarget | null): number | null => {
    if (!(target instanceof Element)) return null;
    const v = target.getAttribute("data-i");
    return v === null ? null : Number(v);
  };

  // DetailContext only remembers an HTML opener, and cells are SVG. So the scroller (HTML, not in the
  // tab order) stands in as the opener, and hands focus back to the active cell when the view closes.
  const restoring = useRef(false);
  const openFromCell = () => {
    scrollRef.current?.focus({ preventScroll: true });
    restoring.current = true; // after the focus above, so that focus is not bounced straight back
    trigger.open();
  };
  const onScrollerFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !restoring.current) return;
    restoring.current = false;
    svgRef.current?.querySelector<SVGRectElement>(`[data-i="${activeIndex}"]`)?.focus({ preventScroll: true });
  };

  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(last, i));
    setActive(next);
    svgRef.current?.querySelector<SVGRectElement>(`[data-i="${next}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const i = cellIndex(e.target);
    if (i === null) return;
    const rowCells = rows[cells[i]!.day]!;
    const rowStart = indexOf.get(rowCells[0]!.key) ?? 0;
    const rowEnd = indexOf.get(rowCells[rowCells.length - 1]!.key) ?? last;
    switch (e.key) {
      case "ArrowRight":
        moveTo(i + 7 > last ? last : i + 7);
        break;
      case "ArrowLeft":
        moveTo(i - 7 < 0 ? i : i - 7);
        break;
      case "ArrowDown":
        moveTo(i + 1);
        break;
      case "ArrowUp":
        moveTo(i - 1);
        break;
      case "Home":
        moveTo(e.ctrlKey ? 0 : rowStart);
        break;
      case "End":
        moveTo(e.ctrlKey ? last : rowEnd);
        break;
      case "Enter":
      case " ":
        openFromCell();
        break;
      case "Escape":
        setTip(null);
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  const ringIndex = focus?.visible ? focus.i : null;
  const cellX = (c: HeatCell) => c.week * g.step;
  const cellY = (c: HeatCell) => TOP + c.day * g.step;
  const ranges = rangeText(grid.thresholds, grid.max, def.describe);
  const todayCell = cells[last];

  return (
    <div className={styles.root}>
      <div className={styles.layout}>
        <div ref={hostRef} className={styles.chart}>
          <div className={styles.gridRow}>
            <svg
              className={styles.days}
              width={LABEL_W}
              height={g.height}
              viewBox={`0 0 ${LABEL_W} ${g.height}`}
              aria-hidden="true"
              focusable="false"
            >
              {[1, 3, 5].map((d) => (
                <text key={d} x={0} y={TOP + d * g.step + g.cell / 2} dominantBaseline="central" className={styles.axisText}>
                  {DAY_SHORT[d]}
                </text>
              ))}
            </svg>
            <div ref={scrollRef} className={styles.scroller} tabIndex={-1} onFocus={onScrollerFocus}>
              <svg
                ref={svgRef}
                role="grid"
                aria-label={`${def.gridLabel}, last 52 weeks. Arrow keys move between days. Enter opens details.`}
                className={[styles.grid, reveal ? styles.reveal : ""].join(" ")}
                width={g.width}
                height={g.height}
                viewBox={`0 0 ${g.width} ${g.height}`}
                onKeyDown={onKeyDown}
                onPointerMove={(e) => {
                  const i = cellIndex(e.target);
                  if (i === null || i === hover) return;
                  setHover(i);
                  setTip(tipFor(i, e.target as Element));
                }}
                onPointerLeave={() => {
                  setHover(null);
                  if (!focus) setTip(null);
                }}
                onFocus={(e) => {
                  const i = cellIndex(e.target);
                  if (i === null) return;
                  setActive(i);
                  setFocus({ i, visible: (e.target as Element).matches(":focus-visible") });
                  setTip(tipFor(i, e.target as Element));
                }}
                onBlur={(e) => {
                  if (e.relatedTarget instanceof Node && svgRef.current?.contains(e.relatedTarget)) return;
                  setFocus(null);
                  setTip(null);
                }}
              >
                <g aria-hidden="true">
                  {grid.months.map((m) => (
                    <text key={`${m.week}-${m.label}`} x={m.week * g.step} y={TOP - 8} className={styles.axisText}>
                      {m.label}
                    </text>
                  ))}
                </g>
                {rows.map((row, d) => (
                  <g key={d} role="row">
                    {row.map((c) => {
                      const i = indexOf.get(c.key)!;
                      const style = reveal ? ({ "--d": `${c.week * 7 + c.day * 5}ms` } as CSSProperties) : undefined;
                      return (
                        <rect
                          key={c.key}
                          role="gridcell"
                          data-i={i}
                          tabIndex={i === activeIndex ? 0 : -1}
                          aria-label={label(c)}
                          className={[styles.cell, bucketClass(c.bucket), c.isToday ? styles.today : "", hover === i ? styles.hover : ""].join(" ")}
                          x={cellX(c) + (c.bucket < 0 ? 0.5 : 0)}
                          y={cellY(c) + (c.bucket < 0 ? 0.5 : 0)}
                          width={g.cell - (c.bucket < 0 ? 1 : 0)}
                          height={g.cell - (c.bucket < 0 ? 1 : 0)}
                          rx={g.cell > 12 ? 3 : 2}
                          style={style}
                        />
                      );
                    })}
                  </g>
                ))}
                {todayCell && reveal ? (
                  <rect
                    aria-hidden="true"
                    className={styles.pulse}
                    x={cellX(todayCell)}
                    y={cellY(todayCell)}
                    width={g.cell}
                    height={g.cell}
                    rx={3}
                  />
                ) : null}
                {ringIndex !== null && cells[ringIndex] ? (
                  <rect
                    aria-hidden="true"
                    className={styles.ring}
                    x={cellX(cells[ringIndex]!) - 2.5}
                    y={cellY(cells[ringIndex]!) - 2.5}
                    width={g.cell + 5}
                    height={g.cell + 5}
                    rx={4}
                  />
                ) : null}
              </svg>
            </div>
          </div>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={`${styles.swatch} ${styles.swatchNone}`} aria-hidden="true" />
              {def.noData}
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.swatch} ${styles.swatch0}`} aria-hidden="true" />
              Zero
            </span>
            <span className={styles.legendItem}>
              <span aria-hidden="true">Less</span>
              <span className={styles.scale}>
                {[1, 2, 3, 4].map((b, k) => (
                  <span key={b} className={`${styles.swatch} ${styles[`swatch${b}`]}`} data-tip={ranges[k] || undefined} aria-hidden="true" />
                ))}
              </span>
              <span aria-hidden="true">More</span>
              <span className="sr-only">Color steps: {ranges.filter(Boolean).join("; ")}.</span>
            </span>
            {note ? <span className={styles.note}>{note}</span> : null}
          </div>
          <ChartTooltip tip={tip} hostWidth={hostWidth} />
        </div>
        <Stats items={def.stats(stats, cells.length)} metric={metric} />
      </div>
    </div>
  );
}

export function YearHeatmap() {
  const snap = useSnapshot();
  const [metric, setMetric] = useStoredChoice<Metric>("life-dashboard:heatmap-metric", METRIC_VALUES, "work");
  const def = DEFS[metric];
  const today = dayKey(new Date());

  const values = useMemo(() => (snap.data ? def.values(snap.data) : new Map<string, number>()), [snap.data, def]);
  const grid = useMemo(
    () => buildHeatGrid(values, new Date(), { fill: def.fill }),
    // `today` rolls the grid over at midnight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, def, today],
  );

  const status = panelFromSource(snap, def.source, {
    isEmpty: () => values.size === 0,
    empty: def.empty,
    emptyHint: def.emptyHint,
  });

  let note: string | undefined;
  if (metric === "commits" && snap.data) {
    const repos = snap.data.work.repoActivity.length;
    note = `Across ${plural(repos, "repo")} with stats so far.`;
  } else if (metric === "work") {
    const first = grid.cells.find((c) => c.value !== null);
    if (first && first !== grid.cells[0]) note = `Session logs start ${shortDay(first.date)}.`;
  }

  return (
    <Panel
      title="Last 52 weeks"
      {...status}
      skeleton="chart"
      detail={{ area: def.area, key: "year" }}
      action={<Segmented label="Metric" options={METRICS} value={metric} onChange={setMetric} />}
    >
      <Heatmap grid={grid} def={def} metric={metric} note={note} />
    </Panel>
  );
}
