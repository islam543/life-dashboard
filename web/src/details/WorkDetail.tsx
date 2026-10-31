import { area as d3area, curveMonotoneX, max as d3max, scaleBand, scaleLinear, stack as d3stack, type SeriesPoint } from "d3";
import { AnimatePresence, motion, type Variants } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { CiRun, JiraIssue, PullRequest, Snapshot } from "../../../shared/types";
import { useDetail, type DetailProps } from "../context/DetailContext";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot, type SnapshotResult } from "../hooks/useSnapshot";
import {
  activeFilterCount,
  ciCounts,
  dueLevel,
  dueText,
  facetCounts,
  filterRows,
  formatAge,
  hoursSince,
  lastNDays,
  paginate,
  parseDay,
  priorityRank,
  prStatus,
  prUrgency,
  sortCi,
  sortJiraByUrgency,
  sortPrsByUrgency,
  sortRows,
  stackProjectTime,
  sumByDay,
  toggleFilter,
  defaultWorkTab,
  workTabFromLayoutId,
  type Filters,
  type SortDir,
  type SortValue,
  type WorkTab,
} from "../lib/detailRows";
import { formatMinutes, formatNumber, plural, relativeTime } from "../lib/format";
import { isWaitingOnYou } from "../lib/kpis";
import { Button } from "../ui/Button";
import { CountUp } from "../ui/CountUp";
import { Panel, panelFromSource } from "../ui/Panel";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import styles from "./WorkDetail.module.css";

// Work explore view: tabs Jira, Pull requests, CI, Time. Opens on the tab that matches the tile
// it grew from (tile-work-prs opens Pull requests, the week timeline opens Time). Opened without a
// tile (Life map node), it starts on the first tab whose source is connected.
//
// T11 may not add files, so the parts every detail view shares also live here and are exported:
// Stagger, TruncText, FilterBar, DataTable, ChartFrame, YAxis, XDayAxis, BarChart.
// PersonalDetail and CalendarDetail import them. Candidates for details/parts.tsx later.

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

const dayLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const weekdayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/* =================================================================== motion */

const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: MOTION.stagger } },
};

const staggerChild: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: MOTION.base, ease: MOTION.easeOut } },
};

/** Reveals its StaggerItem children one after another, 40 ms apart. */
export function Stagger({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol" }) {
  const props = { className, variants: staggerParent, initial: "hidden", animate: "show" } as const;
  if (as === "ul") return <motion.ul {...props}>{children}</motion.ul>;
  if (as === "ol") return <motion.ol {...props}>{children}</motion.ol>;
  return <motion.div {...props}>{children}</motion.div>;
}

export function StaggerItem({
  children,
  className,
  as = "div",
  style,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li";
  style?: CSSProperties;
}) {
  if (as === "li") {
    return (
      <motion.li className={className} variants={staggerChild} style={style}>
        {children}
      </motion.li>
    );
  }
  return (
    <motion.div className={className} variants={staggerChild} style={style}>
      {children}
    </motion.div>
  );
}

/* ============================================================ small glyphs */

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" className={styles.extIcon}>
      <path
        d="M6 3h7v7M13 3 6.5 9.5M11 9.5V13H3V5h3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SortIcon({ dir }: { dir: SortDir | null }) {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false" className={cx(styles.sortIcon, dir && styles.sortActive)}>
      {dir === "asc" ? <path d="M6 2.5 10 8H2Z" fill="currentColor" /> : null}
      {dir === "desc" ? <path d="M6 9.5 2 4h8Z" fill="currentColor" /> : null}
      {dir === null ? <path d="M6 1.5 9 5H3Zm0 9L3 7h6Z" fill="currentColor" /> : null}
    </svg>
  );
}

/* ================================================================ TruncText */

interface TipBox {
  left: number;
  top: number;
  above: boolean;
  maxWidth: number;
}

/**
 * One line of text cut with an ellipsis. When it is cut, hovering or focusing it shows the full text
 * in a tooltip (Escape hides it without closing the view). With `href` it is an external link that
 * opens in a new tab. Screen readers already get the full text, so the tooltip is aria-hidden.
 */
export function TruncText({ text, href, className, children }: { text: string; href?: string; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [tip, setTip] = useState<TipBox | null>(null);
  const setRef = useCallback((el: HTMLElement | null) => {
    ref.current = el;
  }, []);

  const open = () => {
    window.clearTimeout(hideTimer.current);
    const el = ref.current;
    const cut = !!el && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    if (!el || !cut) return;
    const r = el.getBoundingClientRect();
    const maxWidth = Math.min(440, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left - 8, window.innerWidth - 16 - maxWidth));
    const above = r.bottom + 140 > window.innerHeight;
    setTip({ left, top: above ? r.top - 6 : r.bottom + 6, above, maxWidth });
  };
  const close = (delay = 0) => {
    window.clearTimeout(hideTimer.current);
    if (delay > 0) hideTimer.current = window.setTimeout(() => setTip(null), delay);
    else setTip(null);
  };

  useEffect(() => {
    if (!tip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // the detail overlay ignores a handled Escape, so only the tooltip closes
      setTip(null);
    };
    const onMove = () => setTip(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [tip]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // Plain text that is cut becomes focusable, so keyboard users can reach the full text too.
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (href || !el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [href, text]);

  const handlers = {
    ref: setRef,
    className: cx(styles.trunc, className),
    onMouseEnter: open,
    onMouseLeave: () => close(120),
    onFocus: open,
    onBlur: () => close(),
  };

  return (
    <>
      {href ? (
        <a {...handlers} href={href} target="_blank" rel="noopener noreferrer">
          {children ?? text}
        </a>
      ) : (
        <span {...handlers} tabIndex={cut ? 0 : undefined}>
          {children ?? text}
        </span>
      )}
      {tip
        ? createPortal(
            <span
              className={styles.tooltip}
              aria-hidden="true"
              style={{ left: tip.left, top: tip.top, maxWidth: tip.maxWidth, transform: tip.above ? "translateY(-100%)" : undefined }}
              onMouseEnter={() => window.clearTimeout(hideTimer.current)}
              onMouseLeave={() => close()}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/* ================================================================ FilterBar */

export interface FilterGroup {
  id: string;
  label: string;
  /** Every value in the full list, with its count under the other active filters. */
  facets: { value: string; count: number }[];
}

const CHIPS_SHOWN = 6;

function ChipGroup({ group, selected, onToggle }: { group: FilterGroup; selected: readonly string[]; onToggle: (value: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const labelId = `chips-${useId().replace(/:/g, "")}`;
  const overflow = group.facets.length > CHIPS_SHOWN;
  const visible = expanded || !overflow ? group.facets : group.facets.filter((f, i) => i < CHIPS_SHOWN || selected.includes(f.value));
  const hidden = group.facets.length - visible.length;

  return (
    <div className={styles.chipGroup} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={styles.chipLabel}>
        {group.label}
      </span>
      <div className={styles.chips}>
        {visible.map((f) => {
          const on = selected.includes(f.value);
          return (
            <button
              key={f.value}
              type="button"
              className={cx(styles.chip, on && styles.chipOn, f.count === 0 && !on && styles.chipZero)}
              aria-pressed={on}
              onClick={() => onToggle(f.value)}
            >
              {on ? (
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
                  <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
              <span className={styles.chipText}>{f.value}</span>
              <span className={cx(styles.chipCount, "num")}>{f.count}</span>
            </button>
          );
        })}
        {overflow && (expanded || hidden > 0) ? (
          <button type="button" className={styles.chipMore} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `${hidden} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Filter chips per category with counts, Clear all, and the live result count. */
export function FilterBar({
  groups,
  filters,
  onChange,
  resultText,
}: {
  groups: FilterGroup[];
  filters: Filters;
  onChange: (next: Filters) => void;
  resultText: string;
}) {
  const active = activeFilterCount(filters);
  return (
    <div className={styles.filterBar}>
      {groups.map((g) => (
        <ChipGroup key={g.id} group={g} selected={filters[g.id] ?? []} onToggle={(v) => onChange(toggleFilter(filters, g.id, v))} />
      ))}
      <div className={styles.filterFoot}>
        <span className={cx(styles.resultCount, "num")} aria-live="polite">
          {resultText}
        </span>
        {active > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            Clear all filters ({active})
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Facets for one category, counted under the other categories' active filters. */
function facetsFor<T>(rows: readonly T[], filters: Filters, category: string, get: (row: T, category: string) => string) {
  const all = facetCounts(rows, (r) => get(r, category));
  const others = filterRows(rows, { ...filters, [category]: [] }, get);
  const counts = new Map(facetCounts(others, (r) => get(r, category)).map((f) => [f.value, f.count]));
  return all.map((f) => ({ value: f.value, count: counts.get(f.value) ?? 0 }));
}

/* ================================================================ DataTable */

export interface Column<T> {
  id: string;
  header: string;
  align?: "start" | "end";
  /** CSS width, e.g. "44%". */
  width?: string;
  sort?: { value: (row: T) => SortValue; firstDir: SortDir; tieBreak?: (a: T, b: T) => number };
  cell: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  /** Screen-reader caption. */
  caption: string;
  columns: Column<T>[];
  /** Already filtered; the table sorts and paginates. */
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Column and direction shown when the user has not picked a sort. */
  defaultSort: { column: string; dir: SortDir };
  /** Order for the default sort when it is richer than one column (urgency). */
  defaultOrder?: (rows: readonly T[]) => T[];
  /** Left edge accent for rows that need attention (a second cue; cells carry glyph and text). */
  rowTone?: (row: T) => "danger" | "warn" | null;
  /** Changing it returns to page 1 (pass the filters). */
  resetKey?: string;
  /** Shown in place of rows when filters leave nothing. */
  empty?: ReactNode;
  /** Below this width the table scrolls sideways inside its frame; the first column stays put. */
  minWidth?: number;
  /** Plural noun for the pager, e.g. "issues". */
  noun: string;
}

/**
 * Sortable, paginated table: sticky header, sticky first column, visible sort arrow (three states:
 * first direction, other direction, back to the default), right-aligned mono numbers, 20 rows a page.
 * Rows slide to their new place when the sort changes.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  defaultSort,
  defaultOrder,
  rowTone,
  resetKey,
  empty,
  minWidth = 640,
  noun,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ column: string; dir: SortDir } | null>(null);
  const [page, setPage] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => setPage(0), [resetKey]);

  const effective = sort ?? defaultSort;
  const sorted = useMemo(() => {
    if (!sort && defaultOrder) return defaultOrder(rows);
    const col = columns.find((c) => c.id === effective.column);
    if (!col?.sort) return rows.slice();
    return sortRows(rows, col.sort.value, effective.dir, col.sort.tieBreak);
  }, [rows, sort, defaultOrder, columns, effective.column, effective.dir]);

  const view = paginate(sorted, page);
  const orderKey = `${effective.column}:${effective.dir}:${view.page}`;
  const sortedHeader = columns.find((c) => c.id === effective.column)?.header ?? "";

  const onSort = (col: Column<T>) => {
    if (!col.sort) return;
    const flip: SortDir = col.sort.firstDir === "asc" ? "desc" : "asc";
    let next: { column: string; dir: SortDir } | null;
    if (effective.column !== col.id) next = { column: col.id, dir: col.sort.firstDir };
    else if (effective.dir === col.sort.firstDir) next = { column: col.id, dir: flip };
    else next = null;
    if (next && next.column === defaultSort.column && next.dir === defaultSort.dir) next = null;
    setSort(next);
    setPage(0); // a new order starts at its top
  };

  const goTo = (p: number) => {
    setPage(p);
    wrapRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className={styles.tableBlock}>
      <div ref={wrapRef} className={styles.tableWrap}>
        <table className={styles.table} style={{ minWidth }}>
          <caption className="sr-only">
            {caption}, sorted by {sortedHeader} {effective.dir === "asc" ? "ascending" : "descending"}
          </caption>
          <colgroup>
            {columns.map((c) => (
              <col key={c.id} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = !!c.sort && effective.column === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    className={cx(c.align === "end" && styles.end)}
                    aria-sort={active ? (effective.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {c.sort ? (
                      <button type="button" className={cx(styles.sortButton, active && styles.sortButtonOn)} onClick={() => onSort(c)}>
                        <span>{c.header}</span>
                        <SortIcon dir={active ? effective.dir : null} />
                      </button>
                    ) : (
                      <span className={styles.thText}>{c.header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={styles.emptyCell}>
                  {empty ?? `No ${noun} to show.`}
                </td>
              </tr>
            ) : (
              view.rows.map((row, i) => {
                const tone = rowTone?.(row) ?? null;
                return (
                  <motion.tr
                    key={rowKey(row)}
                    layout={reduced ? false : "position"}
                    layoutDependency={orderKey}
                    initial={reduced ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      opacity: { duration: MOTION.base, delay: Math.min(i, 15) * 0.025 },
                      layout: { duration: MOTION.base, ease: MOTION.easeOut },
                    }}
                    className={cx(tone === "danger" && styles.rowDanger, tone === "warn" && styles.rowWarn)}
                  >
                    {columns.map((c) => (
                      <td key={c.id} className={cx(c.align === "end" && styles.end)}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </motion.tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {view.pageCount > 1 ? (
        <nav className={styles.pager} aria-label={`${caption}, pages`}>
          <span className={cx(styles.pagerText, "num")} aria-live="polite">
            {view.from} to {view.to} of {formatNumber(view.total)} {noun}
          </span>
          <div className={styles.pagerButtons}>
            <Button variant="secondary" size="sm" disabled={view.page === 0} onClick={() => goTo(view.page - 1)}>
              Previous
            </Button>
            <span className={cx(styles.pagerPage, "num")}>
              {view.page + 1} / {view.pageCount}
            </span>
            <Button variant="secondary" size="sm" disabled={view.page >= view.pageCount - 1} onClick={() => goTo(view.page + 1)}>
              Next
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

/* =============================================================== ChartFrame */

export const CHART_MARGIN = { top: 10, right: 12, bottom: 24, left: 44 } as const;

export interface ChartFrameProps {
  height: number;
  /** Number of points the cursor steps through. */
  count: number;
  /** Accessible name: what the chart shows and over which period. */
  label: string;
  /** Pointer x (px inside the frame) to a point index. */
  indexAt: (x: number, width: number) => number;
  /** Point index to the x (px) of its mark; the tooltip sits beside it. */
  tipX: (index: number, width: number) => number;
  tip: (index: number) => ReactNode;
  /** One line read out when the keyboard cursor lands on a point. */
  describe: (index: number) => string;
  /** Controlled cursor, to sync several charts. */
  active?: number | null;
  onActiveChange?: (index: number | null) => void;
  /** Hide the tooltip (a synced sibling shows it instead). */
  hideTip?: boolean;
  children: (width: number, active: number | null) => ReactNode;
  className?: string;
}

/**
 * Measures its width, hosts an SVG chart, and adds the reading cursor: pointer hover, or focus plus
 * Left, Right, Home and End, shows a tooltip and reads the value out. Escape hides the cursor.
 */
export function ChartFrame({
  height,
  count,
  label,
  indexAt,
  tipX,
  tip,
  describe,
  active: controlled,
  onActiveChange,
  hideTip = false,
  children,
  className,
}: ChartFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [own, setOwn] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const active = controlled !== undefined ? controlled : own;
  const set = (i: number | null) => {
    if (controlled === undefined) setOwn(i);
    onActiveChange?.(i);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (count === 0 || width === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const next = clamp(indexAt(e.clientX - rect.left, width));
    if (next !== active) set(next);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    if (e.key === "Escape") {
      if (active === null) return;
      e.preventDefault(); // keeps the detail view open
      set(null);
      return;
    }
    const from = active ?? count - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = clamp(from - 1);
    else if (e.key === "ArrowRight") next = clamp(from + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    if (next === null) return;
    e.preventDefault();
    set(next);
    setAnnounce(describe(next));
  };

  const x = active !== null && width > 0 ? tipX(active, width) : 0;
  const tipStyle: CSSProperties = x > width / 2 ? { right: width - x + 12 } : { left: x + 12 };

  return (
    <div
      ref={ref}
      className={cx(styles.chartFrame, className)}
      style={{ height }}
      role="group"
      aria-roledescription="chart"
      aria-label={`${label}. Use the left and right arrow keys to read each value.`}
      tabIndex={count > 0 ? 0 : -1}
      onPointerMove={onPointerMove}
      onPointerLeave={() => set(null)}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        const start = active ?? count - 1;
        set(start);
        setAnnounce(describe(start));
      }}
      onBlur={() => set(null)}
      onKeyDown={onKeyDown}
    >
      {width > 0 ? children(width, active) : null}
      {active !== null && width > 0 && !hideTip ? (
        <div className={styles.chartTip} style={tipStyle} aria-hidden="true">
          {tip(active)}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

/** Horizontal gridlines with labels on the left. */
export function YAxis({ ticks, y, width, format }: { ticks: number[]; y: (v: number) => number; width: number; format: (v: number) => string }) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t} transform={`translate(0 ${y(t)})`}>
          <line className={styles.grid} x1={CHART_MARGIN.left} x2={width - CHART_MARGIN.right} />
          <text className={styles.axisText} x={CHART_MARGIN.left - 8} dy="0.32em" textAnchor="end">
            {format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Smallest label step (1, or a whole number of weeks for daily series) that keeps labels apart. */
function labelEvery(count: number, spacing: number, minGap = 54): number {
  const raw = Math.max(1, Math.ceil(minGap / Math.max(1, spacing)));
  if (count <= 20) return raw;
  return [7, 14, 21, 28, 35, 42].find((k) => k >= raw) ?? Math.ceil(raw / 7) * 7;
}

/** Day labels along the bottom: "Today", then every `every` days back (default: whole weeks that fit). */
export function XDayAxis({ days, x, height, every: fixed }: { days: readonly string[]; x: (i: number) => number; height: number; every?: number }) {
  const n = days.length;
  // 66 px: room for a centred "16 Oct" next to the end-anchored "Today".
  const every = fixed ?? labelEvery(n, n > 1 ? Math.abs(x(1) - x(0)) : 100, 66);
  return (
    <g aria-hidden="true">
      {days.map((d, i) =>
        (n - 1 - i) % every === 0 ? (
          <text key={d} className={styles.axisText} x={x(i)} y={height - 6} textAnchor={i === n - 1 ? "end" : "middle"}>
            {i === n - 1 ? "Today" : dayLabel.format(parseDay(d))}
          </text>
        ) : null,
      )}
    </g>
  );
}

/** Tooltip body pieces, shared by every chart. */
export function TipTitle({ children }: { children: ReactNode }) {
  return <p className={styles.tipTitle}>{children}</p>;
}

export function TipRow({ name, value, color, muted }: { name: ReactNode; value?: ReactNode; color?: string; muted?: boolean }) {
  return (
    <p className={cx(styles.tipRow, muted && styles.tipMuted)}>
      {color ? <span className={styles.swatch} style={{ background: color }} /> : null}
      <span className={styles.tipName}>{name}</span>
      {value !== undefined ? <span className="num">{value}</span> : null}
    </p>
  );
}

/* ================================================================ BarChart */

export interface BarDatum {
  key: string;
  /** Short axis label; empty to skip. */
  axis: string;
  /** null = nothing logged: a faint dot or a dashed ghost bar, never drawn as zero. */
  value: number | null;
  tip: ReactNode;
  /** Read out by the keyboard cursor. */
  describe: string;
}

export interface BarChartProps {
  data: BarDatum[];
  label: string;
  height?: number;
  formatTick: (v: number) => string;
  /** Value labels above the bars (for a few bars only). */
  formatValue?: (v: number) => string;
  /** How a null value looks: a dot on the baseline (daily) or a dashed ghost bar (weekly). */
  nullStyle?: "dot" | "ghost";
  /** Label every n-th bar from the newest; default picks by count. */
  axisEvery?: number;
}

/** Vertical bars that grow from the baseline on first render, with a reading cursor. */
export function BarChart({ data, label, height = 180, formatTick, formatValue, nullStyle = "dot", axisEvery }: BarChartProps) {
  const reduced = useReducedMotion();
  const top = formatValue ? CHART_MARGIN.top + 16 : CHART_MARGIN.top;
  const maxValue = d3max(data, (d) => d.value ?? 0) ?? 0;

  const band = (width: number) =>
    scaleBand<number>()
      .domain(data.map((_, i) => i))
      .range([CHART_MARGIN.left, width - CHART_MARGIN.right])
      .paddingInner(data.length > 40 ? 0.2 : 0.3)
      .paddingOuter(0.1);
  const y = scaleLinear()
    .domain([0, maxValue > 0 ? maxValue : 1])
    .nice(4)
    .range([height - CHART_MARGIN.bottom, top]);
  const ticks = y.ticks(4).filter((t) => Number.isInteger(t));
  const step = Math.min(MOTION.stagger, 0.5 / Math.max(1, data.length));

  return (
    <ChartFrame
      height={height}
      count={data.length}
      label={label}
      indexAt={(px, width) => Math.floor((px - CHART_MARGIN.left) / Math.max(1, band(width).step()))}
      tipX={(i, width) => {
        const b = band(width);
        return (b(i) ?? 0) + b.bandwidth() / 2;
      }}
      tip={(i) => data[i].tip}
      describe={(i) => data[i].describe}
    >
      {(width, active) => {
        const b = band(width);
        const base = y(0);
        const longest = d3max(data, (d) => d.axis.length) ?? 6;
        const every = axisEvery ?? labelEvery(data.length, b.step(), longest * 7 + 12);
        return (
          <svg width={width} height={height} aria-hidden="true" focusable="false">
            <YAxis ticks={ticks} y={y} width={width} format={formatTick} />
            {active !== null ? (
              <rect className={styles.barHover} x={(b(active) ?? 0) - (b.step() - b.bandwidth()) / 2} width={b.step()} y={top - 6} height={base - top + 6} rx={4} />
            ) : null}
            {data.map((d, i) => {
              const bx = b(i) ?? 0;
              const bw = Math.max(1, b.bandwidth());
              if (d.value === null) {
                return nullStyle === "ghost" ? (
                  <rect key={d.key} className={styles.ghostBar} x={bx + 0.5} width={Math.max(1, bw - 1)} y={base - 18} height={17.5} rx={3} />
                ) : (
                  <circle key={d.key} className={styles.nullDot} cx={bx + bw / 2} cy={base - 1} r={1.25} />
                );
              }
              const h = d.value > 0 ? Math.max(2, base - y(d.value)) : 1.5;
              return (
                <g key={d.key}>
                  <motion.rect
                    className={cx(styles.bar, d.value === 0 && styles.barZero, active === i && styles.barActive)}
                    x={bx}
                    width={bw}
                    y={base - h}
                    height={h}
                    rx={Math.min(3, bw / 2)}
                    style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
                    initial={reduced ? false : { scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ duration: MOTION.slow + 0.15, delay: reduced ? 0 : i * step, ease: MOTION.easeOut }}
                  />
                  {formatValue && d.value > 0 ? (
                    <motion.text
                      className={styles.barValue}
                      x={bx + bw / 2}
                      y={base - h - 6}
                      textAnchor="middle"
                      initial={reduced ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: MOTION.base, delay: reduced ? 0 : 0.3 + i * step }}
                    >
                      {formatValue(d.value)}
                    </motion.text>
                  ) : null}
                </g>
              );
            })}
            {data.map((d, i) =>
              d.axis && (data.length - 1 - i) % every === 0 ? (
                <text
                  key={`x-${d.key}`}
                  className={styles.axisText}
                  x={(b(i) ?? 0) + b.bandwidth() / 2}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {d.axis}
                </text>
              ) : null,
            )}
          </svg>
        );
      }}
    </ChartFrame>
  );
}

/* ============================================================== Work view */

const TABS: { id: WorkTab; label: string; short?: string }[] = [
  { id: "jira", label: "Jira" },
  { id: "prs", label: "Pull requests", short: "PRs" },
  { id: "ci", label: "CI" },
  { id: "time", label: "Time" },
];

function TabBadge({ snap, tab }: { snap: SnapshotResult; tab: WorkTab }) {
  const data = snap.data;
  if (!data) return null;
  const source = tab === "jira" ? data.sources.jira : tab === "time" ? data.sources.claudeSessions : data.sources.github;
  if (source.status === "not_connected") return <StatusDot tone="off" size={9} glow={false} label="not connected" />;
  if (source.status === "never_run") return null;
  const list = tab === "jira" ? data.work.jira : tab === "prs" ? data.work.prs : tab === "ci" ? data.work.ci : null;
  if (source.status === "error" && list !== null && list.length === 0) return <StatusDot tone="danger" size={9} label="update failed" />;
  if (tab === "jira" || tab === "prs") return <span className={cx(styles.tabCount, "num")}>{list?.length ?? 0}</span>;
  if (tab === "ci") {
    const fails = ciCounts(data.work.ci).fail;
    return fails > 0 ? (
      <span className={cx(styles.tabCount, styles.tabCountDanger, "num")}>
        <StatusDot tone="danger" size={8} glow={false} />
        {fails}
        <span className="sr-only"> failing</span>
      </span>
    ) : null;
  }
  return null;
}

export function WorkDetail(_props: DetailProps) {
  const snap = useSnapshot();
  const { openLayoutId } = useDetail();
  // The tab the opener asked for, or the one the user picked. Until then the first connected tab is
  // shown, read from the live sources so it is right even when the snapshot arrives after opening.
  const [picked, setTab] = useState<WorkTab | null>(() => workTabFromLayoutId(openLayoutId));
  const tab = picked ?? defaultWorkTab(snap.data?.sources);
  const tabRefs = useRef<Partial<Record<WorkTab, HTMLButtonElement | null>>>({});
  const baseId = `work-${useId().replace(/:/g, "")}`;
  const generatedAt = snap.data?.generatedAt;
  const now = useMemo(() => new Date(), [generatedAt]);

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div className={styles.view}>
      <div className={styles.tabs} role="tablist" aria-label="Work views">
        {TABS.map((t, i) => {
          const selected = tab === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              className={cx(styles.tab, selected && styles.tabOn)}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t.short ? (
                <>
                  <span className={styles.tabLong}>{t.label}</span>
                  <span className={styles.tabShort} aria-hidden="true">
                    {t.short}
                  </span>
                </>
              ) : (
                <span>{t.label}</span>
              )}
              <TabBadge snap={snap} tab={t.id} />
              {selected ? (
                <motion.span
                  layoutId={`${baseId}-indicator`}
                  className={styles.tabIndicator}
                  transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className={styles.tabPanel}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: MOTION.fast, ease: MOTION.easeOut }}
          >
            {tab === "jira" ? <JiraTab snap={snap} now={now} /> : null}
            {tab === "prs" ? <PrTab snap={snap} now={now} /> : null}
            {tab === "ci" ? <CiTab snap={snap} now={now} /> : null}
            {tab === "time" ? <TimeTab snap={snap} now={now} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Jira tab */

const DUE_TONE: Record<ReturnType<typeof dueLevel>, StatusTone | null> = {
  overdue: "danger",
  today: "danger",
  soon: "warn",
  later: null,
  none: null,
};

const CATEGORY_ORDER: Record<JiraIssue["statusCategory"], number> = { todo: 0, inprogress: 1, done: 2 };

function jiraField(issue: JiraIssue, category: string): string {
  return category === "project" ? issue.project : issue.status;
}

function ClearFiltersRow({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <span className={styles.emptyRow}>
      <span>{text}</span>
      <Button variant="secondary" size="sm" onClick={onClear}>
        Clear all filters
      </Button>
    </span>
  );
}

function JiraTab({ snap, now }: { snap: SnapshotResult; now: Date }) {
  const [filters, setFilters] = useState<Filters>({});
  const status = panelFromSource(snap, "jira", {
    isEmpty: (s) => s.work.jira.length === 0,
    empty: "No open Jira issues assigned to you.",
    emptyHint: "Issues assigned to you show up here after the next refresh.",
  });
  const hint = status.state === "not_connected" ? "Then restart the dashboard server so it reads the new values." : status.hint;
  const issues = useMemo(() => snap.data?.work.jira ?? [], [snap.data]);
  const shown = useMemo(() => filterRows(issues, filters, jiraField), [issues, filters]);

  const columns: Column<JiraIssue>[] = [
    {
      id: "issue",
      header: "Issue",
      width: "44%",
      sort: { value: (r) => r.key, firstDir: "asc" },
      cell: (r) => (
        <TruncText href={r.url} text={`${r.key} ${r.summary}`} className={styles.issueLink}>
          <span className={cx(styles.issueKey, "num")}>{r.key}</span>
          {r.summary}
        </TruncText>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "19%",
      sort: { value: (r) => `${CATEGORY_ORDER[r.statusCategory]} ${r.status}`, firstDir: "asc" },
      cell: (r) => (
        <span className={styles.statusCell}>
          <span className={styles.glyphText}>
            <StatusDot tone={r.statusCategory === "inprogress" ? "ok" : "idle"} size={9} glow={false} />
            <TruncText text={r.status} />
          </span>
          {r.blocked ? (
            <span className={styles.blocked}>
              <StatusDot tone="danger" size={8} glow={false} />
              Blocked
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "priority",
      header: "Priority",
      width: "11%",
      sort: { value: (r) => priorityRank(r.priority), firstDir: "asc" },
      cell: (r) => <span className={styles.muted}>{r.priority || "None"}</span>,
    },
    {
      id: "due",
      header: "Due",
      width: "14%",
      sort: { value: (r) => r.dueDate, firstDir: "asc", tieBreak: (a, b) => Number(b.blocked) - Number(a.blocked) },
      cell: (r) => {
        const level = dueLevel(r.dueDate, now);
        const tone = DUE_TONE[level];
        return (
          <span
            className={cx(styles.glyphText, styles.nowrap, level === "none" && styles.muted, tone === "danger" && styles.dangerText, tone === "warn" && styles.warnText)}
            title={r.dueDate ? dayLabel.format(parseDay(r.dueDate)) : undefined}
          >
            {tone ? <StatusDot tone={tone} size={9} glow={false} /> : null}
            {dueText(r.dueDate, now)}
          </span>
        );
      },
    },
    {
      id: "updated",
      header: "Updated",
      width: "12%",
      align: "end",
      sort: { value: (r) => r.updated, firstDir: "desc" },
      cell: (r) => <span className={cx(styles.muted, "num")}>{relativeTime(r.updated, now)}</span>,
    },
  ];

  const groups: FilterGroup[] = [
    { id: "project", label: "Project", facets: facetsFor(issues, filters, "project", jiraField) },
    { id: "status", label: "Status", facets: facetsFor(issues, filters, "status", jiraField) },
  ];

  return (
    <Stagger>
      <StaggerItem>
        <Panel title="Jira issues" {...status} hint={hint} meta={issues.length > 0 ? `${issues.length} open` : undefined} skeleton="rows">
          <FilterBar
            groups={groups}
            filters={filters}
            onChange={setFilters}
            resultText={shown.length === issues.length ? plural(issues.length, "issue") : `${shown.length} of ${plural(issues.length, "issue")}`}
          />
          <DataTable
            caption="Open Jira issues"
            noun="issues"
            columns={columns}
            rows={shown}
            rowKey={(r) => r.key}
            defaultSort={{ column: "due", dir: "asc" }}
            defaultOrder={sortJiraByUrgency}
            resetKey={JSON.stringify(filters)}
            minWidth={760}
            rowTone={(r) => {
              const level = dueLevel(r.dueDate, now);
              if (level === "overdue" || level === "today") return "danger";
              return level === "soon" || r.blocked ? "warn" : null;
            }}
            empty={<ClearFiltersRow text="No issues match these filters." onClear={() => setFilters({})} />}
          />
        </Panel>
      </StaggerItem>
    </Stagger>
  );
}

/* ------------------------------------------------------------------ PR tab */

const CHECKS: Record<PullRequest["checks"], { tone: StatusTone; text: string; order: number }> = {
  fail: { tone: "danger", text: "Failing", order: 0 },
  pending: { tone: "idle", text: "Running", order: 1 },
  pass: { tone: "ok", text: "Passing", order: 2 },
  none: { tone: "off", text: "No checks", order: 3 },
};

function prTone(pr: PullRequest, now: Date): StatusTone {
  // Drafts are never urgent (same rule as Needs you): no red or amber row, even with failing checks.
  // The Checks column still says "Failing".
  if (pr.isDraft) return "idle";
  const status = prStatus(pr);
  const urgency = prUrgency(pr, now);
  if (status === "Needs your review") return urgency === 0 ? "danger" : urgency === 1 ? "warn" : "ok";
  if (status === "Checks failing") return "danger";
  if (status === "Open") return "ok";
  return "idle";
}

function repoName(repo: string): string {
  return repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;
}

function prField(pr: PullRequest, category: string): string {
  return category === "repo" ? repoName(pr.repo) : prStatus(pr);
}

function PrTab({ snap, now }: { snap: SnapshotResult; now: Date }) {
  const [filters, setFilters] = useState<Filters>({});
  const status = panelFromSource(snap, "github", {
    isEmpty: (s) => s.work.prs.length === 0,
    empty: "No open pull requests.",
    emptyHint: "Your open PRs and reviews requested from you show up here.",
  });
  const prs = useMemo(() => snap.data?.work.prs ?? [], [snap.data]);
  const shown = useMemo(() => filterRows(prs, filters, prField), [prs, filters]);
  const byUrgency = useCallback((rows: readonly PullRequest[]) => sortPrsByUrgency(rows, now), [now]);
  const waiting = prs.filter(isWaitingOnYou).length;

  const columns: Column<PullRequest>[] = [
    {
      id: "pr",
      header: "Pull request",
      width: "42%",
      sort: { value: (r) => `${repoName(r.repo)} ${String(r.number).padStart(6, "0")}`, firstDir: "asc" },
      cell: (r) => (
        <span className={styles.prCell}>
          <span className={cx(styles.prMeta, "num")}>
            {repoName(r.repo)} #{r.number}
            {r.isDraft ? <span className={styles.draftTag}>Draft</span> : null}
          </span>
          <TruncText href={r.url} text={r.title} className={styles.prTitle} />
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "20%",
      sort: { value: (r) => prUrgency(r, now), firstDir: "asc", tieBreak: (a, b) => a.createdAt.localeCompare(b.createdAt) },
      cell: (r) => {
        const tone = prTone(r, now);
        return (
          <span className={cx(styles.glyphText, tone === "danger" && styles.dangerText, tone === "warn" && styles.warnText)}>
            <StatusDot tone={tone} size={9} glow={false} />
            {prStatus(r)}
          </span>
        );
      },
    },
    {
      id: "checks",
      header: "Checks",
      width: "13%",
      sort: { value: (r) => CHECKS[r.checks].order, firstDir: "asc" },
      cell: (r) => (
        <span className={styles.glyphText}>
          <StatusDot tone={CHECKS[r.checks].tone} size={9} glow={false} />
          <span className={r.checks === "none" ? styles.muted : undefined}>{CHECKS[r.checks].text}</span>
        </span>
      ),
    },
    {
      id: "author",
      header: "Author",
      width: "15%",
      sort: { value: (r) => (r.role === "author" ? "" : r.author), firstDir: "asc" },
      cell: (r) => (r.role === "author" ? <span className={styles.muted}>You</span> : <TruncText text={r.author} />),
    },
    {
      id: "age",
      header: "Open for",
      width: "10%",
      align: "end",
      sort: { value: (r) => hoursSince(r.createdAt, now), firstDir: "desc" },
      cell: (r) => (
        <span className="num" title={`Opened ${relativeTime(r.createdAt, now)}`}>
          {formatAge(r.createdAt, now)}
        </span>
      ),
    },
  ];

  const groups: FilterGroup[] = [
    { id: "repo", label: "Repo", facets: facetsFor(prs, filters, "repo", prField) },
    { id: "status", label: "Status", facets: facetsFor(prs, filters, "status", prField) },
  ];

  return (
    <Stagger>
      <StaggerItem>
        <Panel
          title="Pull requests"
          {...status}
          meta={prs.length > 0 ? `${prs.length} open${waiting > 0 ? `, ${waiting} waiting on you` : ""}` : undefined}
          skeleton="rows"
        >
          <FilterBar
            groups={groups}
            filters={filters}
            onChange={setFilters}
            resultText={shown.length === prs.length ? plural(prs.length, "pull request") : `${shown.length} of ${plural(prs.length, "pull request")}`}
          />
          <DataTable
            caption="Open pull requests"
            noun="pull requests"
            columns={columns}
            rows={shown}
            rowKey={(r) => `${r.repo}#${r.number}`}
            defaultSort={{ column: "status", dir: "asc" }}
            defaultOrder={byUrgency}
            resetKey={JSON.stringify(filters)}
            minWidth={720}
            rowTone={(r) => {
              const tone = prTone(r, now);
              return tone === "danger" ? "danger" : tone === "warn" ? "warn" : null;
            }}
            empty={<ClearFiltersRow text="No pull requests match these filters." onClear={() => setFilters({})} />}
          />
        </Panel>
      </StaggerItem>
    </Stagger>
  );
}

/* ------------------------------------------------------------------ CI tab */

const CI_LOOK: Record<CiRun["status"], { tone: StatusTone; text: string; label: string }> = {
  fail: { tone: "danger", text: "Failing", label: "failing" },
  pending: { tone: "idle", text: "Running", label: "running" },
  pass: { tone: "ok", text: "Passing", label: "passing" },
};

const CI_SEGMENTS: CiRun["status"][] = ["fail", "pending", "pass"];

function CiTab({ snap, now }: { snap: SnapshotResult; now: Date }) {
  const reduced = useReducedMotion();
  const status = panelFromSource(snap, "github", {
    isEmpty: (s) => s.work.ci.length === 0,
    empty: "No CI runs to show.",
    emptyHint: "Repos you pushed to in the last 30 days show their latest default-branch run here.",
  });
  const runs = useMemo(() => sortCi(snap.data?.work.ci ?? []), [snap.data]);
  const counts = ciCounts(runs);
  const total = runs.length || 1;

  return (
    <Stagger>
      <StaggerItem>
        <Panel title="CI on default branches" {...status} meta={runs.length > 0 ? plural(runs.length, "repo") : undefined} skeleton="cards">
          <div className={styles.ciSummary}>
            <div className={styles.ciMeter} role="img" aria-label={CI_SEGMENTS.map((k) => `${counts[k]} ${CI_LOOK[k].label}`).join(", ")}>
              {CI_SEGMENTS.map((k, i) =>
                counts[k] > 0 ? (
                  <motion.span
                    key={k}
                    className={cx(styles.ciSegment, styles[`seg_${k}`])}
                    initial={reduced ? false : { width: 0 }}
                    animate={{ width: `${(counts[k] / total) * 100}%` }}
                    transition={{ duration: MOTION.draw, delay: i * 0.08, ease: MOTION.easeOut }}
                  />
                ) : null,
              )}
            </div>
            <ul className={styles.ciLegend}>
              {CI_SEGMENTS.map((k) => (
                <li key={k}>
                  <StatusDot tone={CI_LOOK[k].tone} size={9} glow={false} />
                  <CountUp value={counts[k]} className={styles.ciLegendNum} />
                  <span>{CI_LOOK[k].label}</span>
                </li>
              ))}
            </ul>
          </div>
          <Stagger as="ul" className={styles.ciGrid}>
            {runs.map((r) => {
              const look = CI_LOOK[r.status];
              return (
                <StaggerItem as="li" key={`${r.repo}:${r.branch}`} className={cx(styles.ciCard, styles[`card_${r.status}`])}>
                  <div className={styles.ciHead}>
                    <StatusDot tone={look.tone} size={11} pulse={r.status === "fail"} />
                    <TruncText text={repoName(r.repo)} className={styles.ciRepo} />
                  </div>
                  <p className={styles.ciLine}>
                    <span className={cx(styles.ciState, r.status === "fail" && styles.dangerText)}>{look.text}</span>
                    <span className={cx(styles.muted, styles.ciBranch, "num")}>{r.branch}</span>
                  </p>
                  <p className={styles.ciLine}>
                    <span className={cx(styles.muted, "num")}>{relativeTime(r.at, now)}</span>
                    <a className={styles.ciLink} href={r.url} target="_blank" rel="noopener noreferrer">
                      Open run
                      <span className="sr-only"> for {repoName(r.repo)} (opens in a new tab)</span>
                      <ExternalIcon />
                    </a>
                  </p>
                </StaggerItem>
              );
            })}
          </Stagger>
        </Panel>
      </StaggerItem>
    </Stagger>
  );
}

/* ---------------------------------------------------------------- Time tab */

export const SERIES_COLORS = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)", "var(--cat-6)"];

function TimeTab({ snap, now }: { snap: SnapshotResult; now: Date }) {
  const timeStatus = panelFromSource(snap, "claudeSessions", {
    isEmpty: (s) => stackProjectTime(s.work.sessionTime, 30, now).keys.length === 0,
    empty: "No Claude Code sessions in the last 30 days.",
    emptyHint: "Time shows up here once you work in a project with Claude Code.",
  });
  const commitStatus = panelFromSource(snap, "github", {
    isEmpty: (s) => sumByDay(s.work.repoActivity.map((r) => r.commitsByDay), lastNDays(30, now)).every((v) => v === 0),
    empty: "No commits in the last 30 days.",
    emptyHint: "Commits to repos you pushed to this year show up here.",
  });

  return (
    <Stagger className={styles.stack}>
      <StaggerItem>
        <Panel title="Time by project, last 30 days" {...timeStatus} skeleton="chart">
          {snap.data ? <ProjectTime data={snap.data} now={now} /> : null}
        </Panel>
      </StaggerItem>
      <StaggerItem>
        <Panel title="Commits per day, last 30 days" {...commitStatus} skeleton="chart">
          {snap.data ? <Commits data={snap.data} now={now} /> : null}
        </Panel>
      </StaggerItem>
    </Stagger>
  );
}

function ProjectTime({ data, now }: { data: Snapshot; now: Date }) {
  const reduced = useReducedMotion();
  const clipId = `clip-${useId().replace(/:/g, "")}`;
  const [pinned, setPinned] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const focusSeries = hovered ?? pinned;
  const s = useMemo(() => stackProjectTime(data.work.sessionTime, 30, now), [data, now]);
  const total = s.totals.reduce((a, b) => a + b, 0);
  const busiest = s.dayTotals.reduce((best, v, i) => (v > s.dayTotals[best] ? i : best), 0);
  const activeDays = s.dayTotals.filter((v) => v > 0).length;
  const height = 260;
  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

  const layers = useMemo(
    () =>
      d3stack<number[], number>()
        .keys(s.keys.map((_, i) => i))
        .value((row, k) => row[k] / 60)(s.values),
    [s],
  );
  const maxHours = (d3max(s.dayTotals) ?? 0) / 60;
  const y = scaleLinear()
    .domain([0, Math.max(maxHours, 0.5)])
    .nice(4)
    .range([height - CHART_MARGIN.bottom, CHART_MARGIN.top]);
  const xFor = (width: number) =>
    scaleLinear()
      .domain([0, Math.max(1, s.days.length - 1)])
      .range([CHART_MARGIN.left, width - CHART_MARGIN.right]);

  const describeDay = (i: number) => {
    const when = weekdayLabel.format(parseDay(s.days[i]));
    if (s.dayTotals[i] === 0) return `${when}: no sessions`;
    const parts = s.keys.flatMap((k, j) => (s.values[i][j] > 0 ? [`${k} ${formatMinutes(s.values[i][j])}`] : []));
    return `${when}: ${formatMinutes(s.dayTotals[i])} in total. ${parts.join(", ")}`;
  };

  return (
    <div className={styles.chartBody}>
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Total</dt>
          <dd>
            <CountUp value={total} format={formatMinutes} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Per active day</dt>
          <dd>
            <CountUp value={activeDays > 0 ? total / activeDays : 0} format={formatMinutes} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Busiest day</dt>
          <dd>
            <CountUp value={s.dayTotals[busiest] ?? 0} format={formatMinutes} />
            <span className={styles.statNote}>{dayLabel.format(parseDay(s.days[busiest]))}</span>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Active days</dt>
          <dd>
            <CountUp value={activeDays} />
            <span className={styles.statNote}>of 30</span>
          </dd>
        </div>
      </dl>

      <ul className={styles.legend} aria-label="Projects, select one to highlight it">
        {s.keys.map((k, i) => (
          <li key={k}>
            <button
              type="button"
              className={cx(styles.legendItem, focusSeries === i && styles.legendOn, focusSeries !== null && focusSeries !== i && styles.legendDim)}
              aria-pressed={pinned === i}
              onClick={() => setPinned((cur) => (cur === i ? null : i))}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
            >
              <span className={styles.swatch} style={{ background: color(i) }} />
              <span className={styles.legendName}>{k}</span>
              <span className={cx(styles.legendValue, "num")}>{formatMinutes(s.totals[i])}</span>
            </button>
          </li>
        ))}
      </ul>

      <ChartFrame
        height={height}
        count={s.days.length}
        label={`Claude Code time per project per day, last 30 days, ${formatMinutes(total)} in total`}
        indexAt={(px, width) => Math.round(xFor(width).invert(px))}
        tipX={(i, width) => xFor(width)(i)}
        describe={describeDay}
        tip={(i) => (
          <>
            <TipTitle>{weekdayLabel.format(parseDay(s.days[i]))}</TipTitle>
            {s.dayTotals[i] === 0 ? (
              <TipRow name="No sessions" muted />
            ) : (
              <>
                {s.keys.map((k, j) => (s.values[i][j] > 0 ? <TipRow key={k} name={k} value={formatMinutes(s.values[i][j])} color={color(j)} /> : null))}
                {s.keys.length > 1 ? <TipRow name="Total" value={formatMinutes(s.dayTotals[i])} /> : null}
              </>
            )}
          </>
        )}
      >
        {(width, active) => {
          const x = xFor(width);
          const areaGen = d3area<SeriesPoint<number[]>>()
            .x((_, i) => x(i))
            .y0((d) => y(d[0]))
            .y1((d) => y(d[1]))
            .curve(curveMonotoneX);
          const plotW = width - CHART_MARGIN.left - CHART_MARGIN.right;
          return (
            <svg width={width} height={height} aria-hidden="true" focusable="false">
              <defs>
                <clipPath id={clipId}>
                  <motion.rect
                    x={CHART_MARGIN.left - 2}
                    y={0}
                    height={height}
                    initial={reduced ? false : { width: 0 }}
                    animate={{ width: plotW + 4 }}
                    transition={{ duration: MOTION.draw, ease: MOTION.easeOut }}
                  />
                </clipPath>
                {s.keys.map((k, i) => (
                  <linearGradient key={k} id={`${clipId}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: color(i), stopOpacity: 0.7 }} />
                    <stop offset="100%" style={{ stopColor: color(i), stopOpacity: 0.22 }} />
                  </linearGradient>
                ))}
              </defs>
              <YAxis ticks={y.ticks(4)} y={y} width={width} format={(h) => (h === 0 ? "0" : formatMinutes(h * 60))} />
              <XDayAxis days={s.days} x={x} height={height} />
              <g clipPath={`url(#${clipId})`}>
                {layers.map((layer, i) => (
                  <path
                    key={s.keys[i]}
                    d={areaGen(layer) ?? ""}
                    fill={`url(#${clipId}-g${i})`}
                    className={cx(styles.layer, focusSeries !== null && focusSeries !== i && styles.layerDim, focusSeries === i && styles.layerOn)}
                    style={{ stroke: color(i) }}
                  />
                ))}
              </g>
              {active !== null ? (
                <g>
                  <line className={styles.crosshair} x1={x(active)} x2={x(active)} y1={CHART_MARGIN.top} y2={height - CHART_MARGIN.bottom} />
                  {layers.map((layer, i) =>
                    s.values[active][i] > 0 ? (
                      <circle key={s.keys[i]} className={styles.cursorDot} cx={x(active)} cy={y(layer[active][1])} r={3.5} style={{ fill: color(i) }} />
                    ) : null,
                  )}
                </g>
              ) : null}
            </svg>
          );
        }}
      </ChartFrame>
    </div>
  );
}

function Commits({ data, now }: { data: Snapshot; now: Date }) {
  const days = useMemo(() => lastNDays(30, now), [now]);
  const values = useMemo(() => sumByDay(data.work.repoActivity.map((r) => r.commitsByDay), days), [data, days]);
  const total = values.reduce((a, b) => a + b, 0);
  const repos = data.work.repoActivity.filter((r) => days.some((d) => (r.commitsByDay[d] ?? 0) > 0)).length;
  const bars: BarDatum[] = days.map((d, i) => {
    const when = weekdayLabel.format(parseDay(d));
    return {
      key: d,
      axis: i === days.length - 1 ? "Today" : dayLabel.format(parseDay(d)),
      value: values[i],
      tip: (
        <>
          <TipTitle>{when}</TipTitle>
          <TipRow name="Commits" value={formatNumber(values[i])} />
        </>
      ),
      describe: `${when}: ${plural(values[i], "commit")}`,
    };
  });
  return (
    <div className={styles.chartBody}>
      <p className={styles.chartLead}>
        <CountUp value={total} className={styles.leadNum} /> {total === 1 ? "commit" : "commits"} in {plural(repos, "repo")}
      </p>
      <BarChart data={bars} label={`Commits per day across repos, last 30 days, ${plural(total, "commit")} in total`} height={170} formatTick={(v) => formatNumber(v)} />
    </div>
  );
}
