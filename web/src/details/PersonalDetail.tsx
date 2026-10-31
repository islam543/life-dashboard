import { area as d3area, curveMonotoneX, line as d3line, max as d3max, scaleLinear } from "d3";
import { motion } from "motion/react";
import { useId, useMemo, useState, type CSSProperties } from "react";
import type { Checkin } from "../../../shared/types";
import { useCheckin } from "../context/CheckinContext";
import type { DetailProps } from "../context/DetailContext";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import {
  average,
  checkinSeries,
  daysUntil,
  parseDay,
  recentCheckins,
  weeklyTotals,
  type CheckinField,
  type SeriesPoint,
} from "../lib/detailRows";
import { dayKey, formatCompact, formatNumber, formatQar, plural } from "../lib/format";
import { Button } from "../ui/Button";
import { CountUp } from "../ui/CountUp";
import { Panel, panelFromSource } from "../ui/Panel";
import { StatusDot } from "../ui/StatusDot";
import {
  BarChart,
  CHART_MARGIN,
  ChartFrame,
  DataTable,
  Stagger,
  StaggerItem,
  TipRow,
  TipTitle,
  TruncText,
  XDayAxis,
  YAxis,
  type BarDatum,
  type Column,
} from "./WorkDetail";
import styles from "./PersonalDetail.module.css";

// Personal explore view: sleep, energy and mood over 30 or 90 days (three synced line charts),
// workout minutes per day, spend per week, and the check-in log with an Edit per row.
// "Check in now" opens the shared check-in dialog when today is missing.

type Range = 30 | 90;

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");
const weekdayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const dayLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

interface Metric {
  key: Extract<CheckinField, "sleepHours" | "energy" | "mood">;
  name: string;
  color: string;
  /** Value as read in a tooltip or table: "7.5 h", "4 of 5". */
  format: (v: number) => string;
  tick: (v: number) => string;
  domain: (values: number[]) => [number, number];
}

const METRICS: Metric[] = [
  {
    key: "sleepHours",
    name: "Sleep",
    color: "var(--cat-1)",
    format: (v) => `${formatNumber(v, 1)} h`,
    tick: (v) => `${v}h`,
    domain: (values) => [0, Math.max(10, Math.ceil(d3max(values) ?? 0))],
  },
  { key: "energy", name: "Energy", color: "var(--cat-3)", format: (v) => `${formatNumber(v, 1)} of 5`, tick: (v) => String(v), domain: () => [1, 5] },
  { key: "mood", name: "Mood", color: "var(--cat-4)", format: (v) => `${formatNumber(v, 1)} of 5`, tick: (v) => String(v), domain: () => [1, 5] },
];

/* --------------------------------------------------------------- line chart */

interface Cursor {
  index: number | null;
  chart: string | null;
}

function LineChart({
  metric,
  points,
  range,
  cursor,
  onCursor,
}: {
  metric: Metric;
  points: SeriesPoint[];
  range: Range;
  cursor: Cursor;
  onCursor: (c: Cursor) => void;
}) {
  const reduced = useReducedMotion();
  const gradientId = `line-${useId().replace(/:/g, "")}`;
  const height = 132;
  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  const avg = average(points.map((p) => p.value));
  const [lo, hi] = metric.domain(values);
  const y = scaleLinear().domain([lo, hi]).range([height - CHART_MARGIN.bottom, CHART_MARGIN.top + 4]).clamp(true);
  const ticks = metric.key === "sleepHours" ? y.ticks(3).filter(Number.isInteger) : [1, 3, 5];
  const xFor = (width: number) =>
    scaleLinear()
      .domain([0, Math.max(1, points.length - 1)])
      .range([CHART_MARGIN.left, width - CHART_MARGIN.right]);
  const isDefined = (p: SeriesPoint) => p.value !== null;
  const lonely = (i: number) => points[i].value !== null && (points[i - 1]?.value ?? null) === null && (points[i + 1]?.value ?? null) === null;

  return (
    <ChartFrame
      height={height}
      count={points.length}
      label={`${metric.name} per day, last ${range} days${avg !== null ? `, average ${metric.format(avg)}` : ""}`}
      indexAt={(px, width) => Math.round(xFor(width).invert(px))}
      tipX={(i, width) => xFor(width)(i)}
      active={cursor.index}
      onActiveChange={(index) => onCursor({ index, chart: index === null ? null : metric.key })}
      hideTip={cursor.chart !== null && cursor.chart !== metric.key}
      describe={(i) => {
        const p = points[i];
        return `${weekdayLabel.format(parseDay(p.date))}: ${p.value === null ? "no check-in" : metric.format(p.value)}`;
      }}
      tip={(i) => {
        const v = points[i].value;
        return (
          <>
            <TipTitle>{weekdayLabel.format(parseDay(points[i].date))}</TipTitle>
            <TipRow name={metric.name} value={v === null ? "No check-in" : metric.format(v)} color={metric.color} muted={v === null} />
          </>
        );
      }}
    >
      {(width, active) => {
        const x = xFor(width);
        const line =
          d3line<SeriesPoint>()
            .defined(isDefined)
            .x((_, i) => x(i))
            .y((p) => y(p.value as number))
            .curve(curveMonotoneX)(points) ?? "";
        const fill =
          d3area<SeriesPoint>()
            .defined(isDefined)
            .x((_, i) => x(i))
            .y0(height - CHART_MARGIN.bottom)
            .y1((p) => y(p.value as number))
            .curve(curveMonotoneX)(points) ?? "";
        const activePoint = active !== null ? points[active] : null;
        return (
          <svg width={width} height={height} aria-hidden="true" focusable="false" style={{ ["--line" as string]: metric.color } as CSSProperties}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className={styles.areaTop} />
                <stop offset="100%" className={styles.areaBottom} />
              </linearGradient>
            </defs>
            <YAxis ticks={ticks} y={y} width={width} format={metric.tick} />
            <XDayAxis days={points.map((p) => p.date)} x={x} height={height} />
            <motion.path
              key={`area-${range}`}
              d={fill}
              fill={`url(#${gradientId})`}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: MOTION.draw, delay: reduced ? 0 : MOTION.draw * 0.4 }}
            />
            {avg !== null ? (
              <g className={styles.avg}>
                <line x1={CHART_MARGIN.left} x2={width - CHART_MARGIN.right} y1={y(avg)} y2={y(avg)} />
                <text x={width - CHART_MARGIN.right} y={y(avg) - 5} textAnchor="end">
                  avg {formatNumber(avg, 1)}
                </text>
              </g>
            ) : null}
            <motion.path
              key={`line-${range}`}
              d={line}
              className={styles.line}
              initial={reduced ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: MOTION.draw, ease: MOTION.easeOut }}
            />
            {points.map((p, i) =>
              p.value !== null && (range === 30 || lonely(i)) ? (
                <motion.circle
                  key={`${range}-${p.date}`}
                  className={styles.dot}
                  cx={x(i)}
                  cy={y(p.value)}
                  r={range === 30 ? 2.5 : 2}
                  initial={reduced ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: MOTION.base, delay: reduced ? 0 : (i / points.length) * MOTION.draw }}
                />
              ) : null,
            )}
            {active !== null ? (
              <g>
                <line className={styles.crosshair} x1={x(active)} x2={x(active)} y1={CHART_MARGIN.top} y2={height - CHART_MARGIN.bottom} />
                {activePoint && activePoint.value !== null ? <circle className={styles.cursorDot} cx={x(active)} cy={y(activePoint.value)} r={4.5} /> : null}
              </g>
            ) : null}
          </svg>
        );
      }}
    </ChartFrame>
  );
}

function Trends({ checkins, range, now }: { checkins: Checkin[]; range: Range; now: Date }) {
  const [cursor, setCursor] = useState<Cursor>({ index: null, chart: null });
  const series = useMemo(() => METRICS.map((m) => checkinSeries(checkins, m.key, range, now)), [checkins, range, now]);
  const logged = series[0].filter((p) => p.value !== null).length;

  return (
    <div className={styles.trends}>
      {logged < 3 ? (
        <p className={styles.sparseNote}>
          {logged === 0
            ? `No check-ins in the last ${range} days.`
            : `${plural(logged, "check-in")} in the last ${range} days. The lines fill in as you check in each day.`}
        </p>
      ) : null}
      {METRICS.map((m, i) => {
        const avg = average(series[i].map((p) => p.value));
        return (
          <section key={m.key} className={styles.metric} aria-label={m.name}>
            <header className={styles.metricHead}>
              <span className={styles.metricName}>
                <span className={styles.metricSwatch} style={{ background: m.color }} aria-hidden="true" />
                {m.name}
              </span>
              <span className={styles.metricAvg}>
                {avg !== null ? (
                  <>
                    <CountUp value={avg} decimals={1} className={styles.metricNum} />
                    <span>{m.key === "sleepHours" ? "h average" : "of 5 average"}</span>
                  </>
                ) : (
                  <span>No data</span>
                )}
              </span>
            </header>
            <LineChart metric={m} points={series[i]} range={range} cursor={cursor} onCursor={setCursor} />
          </section>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- workouts */

function Workouts({ checkins, range, now }: { checkins: Checkin[]; range: Range; now: Date }) {
  const points = useMemo(() => checkinSeries(checkins, "workoutMinutes", range, now), [checkins, range, now]);
  const total = points.reduce((sum, p) => sum + (p.value ?? 0), 0);
  const sessions = points.filter((p) => (p.value ?? 0) > 0).length;
  const bars: BarDatum[] = points.map((p, i) => {
    const when = weekdayLabel.format(parseDay(p.date));
    const text = p.value === null ? "No check-in" : p.value === 0 ? "Rest day" : `${formatNumber(p.value)} min`;
    return {
      key: p.date,
      axis: i === points.length - 1 ? "Today" : dayLabel.format(parseDay(p.date)),
      value: p.value,
      tip: (
        <>
          <TipTitle>{when}</TipTitle>
          <TipRow name="Workout" value={text} muted={p.value === null} />
        </>
      ),
      describe: `${when}: ${text}`,
    };
  });

  return (
    <div className={styles.chartBody}>
      <p className={styles.lead}>
        <CountUp value={total} className={styles.leadNum} />
        <span>
          min across {plural(sessions, "workout")}, last {range} days
        </span>
      </p>
      <BarChart data={bars} label={`Workout minutes per day, last ${range} days, ${formatNumber(total)} minutes in total`} height={170} formatTick={(v) => `${v}`} />
    </div>
  );
}

/* ------------------------------------------------------------------- spend */

function Spend({ checkins, range, now }: { checkins: Checkin[]; range: Range; now: Date }) {
  const weeks = useMemo(() => weeklyTotals(checkins, "spendQar", range === 30 ? 5 : 13, now), [checkins, range, now]);
  const loggedWeeks = weeks.filter((w) => w.total !== null);
  const total = loggedWeeks.reduce((sum, w) => sum + (w.total ?? 0), 0);
  const avg = loggedWeeks.length > 0 ? total / loggedWeeks.length : 0;
  const bars: BarDatum[] = weeks.map((w, i) => {
    const label = `Week of ${dayLabel.format(parseDay(w.start))}`;
    const days = `${w.logged} of ${w.daysInWeek} ${w.daysInWeek === 1 ? "day" : "days"} logged`;
    return {
      key: w.start,
      axis: i === weeks.length - 1 ? "This week" : dayLabel.format(parseDay(w.start)),
      value: w.total,
      tip: (
        <>
          <TipTitle>{label}</TipTitle>
          <TipRow name="Spent" value={w.total === null ? "No check-ins" : formatQar(w.total)} muted={w.total === null} />
          <TipRow name={days} muted />
        </>
      ),
      describe: `${label}: ${w.total === null ? "no check-ins" : `${formatQar(w.total)}, ${days}`}`,
    };
  });

  return (
    <div className={styles.chartBody}>
      <p className={styles.lead}>
        <CountUp value={avg} format={formatQar} className={styles.leadNum} />
        <span>per week on average, over {plural(loggedWeeks.length, "logged week")}</span>
      </p>
      <BarChart
        data={bars}
        label={`Spend per week in Qatari riyal, last ${weeks.length} weeks`}
        height={170}
        formatTick={(v) => formatCompact(v)}
        formatValue={(v) => formatCompact(v)}
        nullStyle="ghost"
      />
    </div>
  );
}

/* ------------------------------------------------------------------- table */

function Pips({ value }: { value: number }) {
  return (
    <span className={styles.pips}>
      <span className="num">{value}</span>
      <span className={styles.pipRow} aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={cx(styles.pip, n <= value && styles.pipOn)} />
        ))}
      </span>
      <span className="sr-only"> of 5</span>
    </span>
  );
}

const EDIT_TIP = "Opens this day's check-in to change it; saving replaces the old answers.";

function CheckinTable({ checkins, onEdit, today }: { checkins: Checkin[]; onEdit: (date: string) => void; today: string }) {
  const rows = useMemo(() => recentCheckins(checkins), [checkins]);
  const columns: Column<Checkin>[] = [
    {
      id: "date",
      header: "Date",
      width: "15%",
      sort: { value: (r) => r.date, firstDir: "desc" },
      cell: (r) => (
        <span className={styles.dateCell}>
          {weekdayLabel.format(parseDay(r.date))}
          {r.date === today ? <span className={styles.todayTag}>Today</span> : null}
        </span>
      ),
    },
    {
      id: "sleep",
      header: "Sleep",
      width: "9%",
      align: "end",
      sort: { value: (r) => r.sleepHours, firstDir: "desc" },
      cell: (r) => <span className="num">{formatNumber(r.sleepHours, 1)} h</span>,
    },
    { id: "energy", header: "Energy", width: "12%", sort: { value: (r) => r.energy, firstDir: "desc" }, cell: (r) => <Pips value={r.energy} /> },
    { id: "mood", header: "Mood", width: "12%", sort: { value: (r) => r.mood, firstDir: "desc" }, cell: (r) => <Pips value={r.mood} /> },
    {
      id: "workout",
      header: "Workout",
      width: "10%",
      align: "end",
      sort: { value: (r) => r.workoutMinutes, firstDir: "desc" },
      cell: (r) => <span className={cx("num", r.workoutMinutes === 0 && styles.muted)}>{formatNumber(r.workoutMinutes)} min</span>,
    },
    {
      id: "spend",
      header: "Spend",
      width: "12%",
      align: "end",
      sort: { value: (r) => r.spendQar, firstDir: "desc" },
      cell: (r) => <span className="num">{formatQar(r.spendQar)}</span>,
    },
    {
      id: "note",
      header: "Note",
      width: "20%",
      sort: { value: (r) => r.note ?? null, firstDir: "asc" },
      cell: (r) => (r.note && r.note.trim() ? <TruncText text={r.note} /> : <span className={styles.faint}>No note</span>),
    },
    {
      id: "edit",
      header: "Actions",
      width: "10%",
      align: "end",
      cell: (r) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEdit(r.date)}
          className={styles.editButton}
          tip={EDIT_TIP}
        >
          Edit<span className="sr-only"> check-in for {weekdayLabel.format(parseDay(r.date))}</span>
        </Button>
      ),
    },
  ];

  return (
    <DataTable
      caption="Check-ins"
      noun="check-ins"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.date}
      defaultSort={{ column: "date", dir: "desc" }}
      minWidth={840}
      rowMenu={(r) => ({
        title: weekdayLabel.format(parseDay(r.date)),
        items: [{ label: "Edit check-in", onSelect: () => onEdit(r.date), tip: EDIT_TIP }],
      })}
    />
  );
}

/** "today", "yesterday", "3 days ago", or a date past 30 days. Check-ins are whole days, not times. */
function lastSeen(date: string, now: Date): string {
  const days = -daysUntil(date, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${dayLabel.format(parseDay(date))}`;
}

/* -------------------------------------------------------------------- view */

export function PersonalDetail(_props: DetailProps) {
  const snap = useSnapshot();
  const { openCheckin } = useCheckin();
  const [range, setRange] = useState<Range>(30);
  const generatedAt = snap.data?.generatedAt;
  const now = useMemo(() => new Date(), [generatedAt]);
  const today = dayKey(now);
  const checkins = useMemo(() => snap.data?.personal.checkins ?? [], [snap.data]);
  const latest = useMemo(() => recentCheckins(checkins)[0] ?? null, [checkins]);
  const checkedInToday = (snap.data?.personal.checkedInToday ?? false) || latest?.date === today;

  const status = panelFromSource(snap, "checkins", {
    isEmpty: (s) => s.personal.checkins.length === 0,
    empty: "No check-ins yet.",
    emptyHint: "Check in once a day with sleep, energy, mood, workout and spend. It takes about 30 seconds.",
  });

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <div className={styles.range} role="group" aria-label="Time range">
          {([30, 90] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={cx(styles.rangeButton, range === r && styles.rangeOn)}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              data-tip={`Shows the last ${r} days in the charts above the log.`}
            >
              {range === r ? <motion.span layoutId="personal-range" className={styles.rangeThumb} transition={{ duration: MOTION.base, ease: MOTION.easeOut }} /> : null}
              <span className={styles.rangeText}>{r} days</span>
            </button>
          ))}
        </div>
        {snap.data ? (
          <div className={styles.checkinStatus}>
            {checkedInToday ? (
              <>
                <span className={styles.statusText}>
                  <StatusDot tone="ok" size={9} />
                  Checked in today
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openCheckin(today)}
                  tip="Opens today's saved check-in to change it; saving again replaces it."
                >
                  Edit today
                </Button>
              </>
            ) : (
              <>
                <span className={styles.statusText}>
                  <StatusDot tone="idle" size={10} glow={false} />
                  {latest ? `No check-in today. Last one ${lastSeen(latest.date, now)}.` : "No check-in today."}
                </span>
                <Button
                  variant="primary"
                  onClick={() => openCheckin()}
                  tip="Logs today's sleep, energy, mood, workout and spend in about 30 seconds."
                >
                  Check in now
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <Stagger className={styles.grid}>
        <StaggerItem className={styles.trendsCell}>
          <Panel title="Sleep, energy and mood" {...status} menu meta={`Last ${range} days`} skeleton="chart">
            <Trends checkins={checkins} range={range} now={now} />
          </Panel>
        </StaggerItem>
        <StaggerItem className={styles.cell}>
          <Panel title="Workouts" {...status} menu skeleton="chart">
            <Workouts checkins={checkins} range={range} now={now} />
          </Panel>
        </StaggerItem>
        <StaggerItem className={styles.cell}>
          <Panel title="Spend per week" {...status} menu meta="QAR" skeleton="chart">
            <Spend checkins={checkins} range={range} now={now} />
          </Panel>
        </StaggerItem>
        <StaggerItem className={styles.tableCell}>
          <Panel title="Check-in log" {...status} menu meta={checkins.length > 0 ? plural(recentCheckins(checkins).length, "day") : undefined} skeleton="rows">
            <CheckinTable checkins={checkins} onEdit={(date) => openCheckin(date)} today={today} />
          </Panel>
        </StaggerItem>
      </Stagger>
    </div>
  );
}
