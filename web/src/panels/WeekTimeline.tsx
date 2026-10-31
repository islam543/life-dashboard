import { scaleBand, scaleLinear } from "d3";
import { motion } from "motion/react";
import { useId, useMemo, useState, type CSSProperties, type FocusEvent, type PointerEvent } from "react";
import type { Snapshot, SourceState } from "../../../shared/types";
import { useDetailTrigger } from "../context/DetailContext";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { dayKey, formatClock, formatMinutes, formatNumber, plural, sourceLabel, type SourceKey } from "../lib/format";
import {
  DAY_SHORT,
  addDays,
  longDay,
  parseDayKey,
  placeWeekItems,
  startOfWeek,
  weekMinutes,
  weekRangeLabel,
  type WeekItem,
  type WeekPlacement,
} from "../lib/timeAgg";
import { Panel, panelFromSource, type PanelStatus } from "../ui/Panel";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { ChartTooltip, useElementWidth, type TipData } from "./ProjectTimeBars";
import styles from "./WeekTimeline.module.css";

// This week, Sunday to Saturday. Each day column shows the hours worked in Claude Code (a bar that
// grows in), then the Jira issues due and calendar events that day. Overdue issues stack in a red
// lane on the left. Today is lit. Hover or focus an item for details; click opens it in its source.
// A source that is not connected gets one small line under the chart instead of emptying it.
// Narrow panels keep the 7 bar columns and list the items by day underneath.

const TITLE = "This week";
const DETAIL = { area: "work", key: "week" } as const;
const SOURCES = ["jira", "calendar", "claudeSessions"] as const satisfies readonly SourceKey[];
const MAX_CHIPS = 3;
const COMPACT_BELOW = 560;

const HEAD = 44; // day name + date
const LABEL_BAND = 20; // value labels above the bars

type Problem = { key: SourceKey; tone: StatusTone; text: string };

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** A source with data to draw (ok, out of date, or failed after an earlier success). */
function usable(s: SourceState): boolean {
  return s.status === "ok" || s.status === "stale" || s.status === "error";
}

function problemFor(key: SourceKey, s: SourceState): Problem | null {
  const name = sourceLabel(key);
  if (s.status === "not_connected") {
    return { key, tone: "off", text: `${name} not connected. ${sentence(s.message ?? `Connect ${name}`)}` };
  }
  if (s.status === "never_run") return { key, tone: "idle", text: `${name} not collected yet. It is collected on the next refresh.` };
  return null;
}

function dueText(item: Extract<WeekItem, { kind: "jira" }>): string {
  switch (item.urgency) {
    case "overdue":
      return item.daysLate === 1 ? "Due yesterday" : `${item.daysLate} days overdue`;
    case "today":
      return "Due today";
    default: {
      const due = parseDayKey(item.day);
      return due ? `Due ${longDay(due)}` : "Due this week";
    }
  }
}

function itemTone(item: WeekItem): StatusTone {
  if (item.kind === "event") return "ok";
  if (item.urgency === "overdue" || item.urgency === "today") return "danger";
  if (item.urgency === "soon" || item.issue.blocked) return "warn";
  return "ok";
}

function itemLabel(item: WeekItem): string {
  if (item.kind === "jira") {
    const i = item.issue;
    return `${i.key}: ${i.summary}. ${dueText(item)}. ${i.status}${i.blocked ? ", blocked" : ""}. Opens in Jira.`;
  }
  const when = item.allDay || !item.start ? "All day" : formatClock(item.start);
  return `${when} ${item.title}${item.url ? ". Opens in Google Calendar." : ""}`;
}

function itemTip(item: WeekItem): Pick<TipData, "title" | "value" | "meta" | "tone"> {
  if (item.kind === "jira") {
    const i = item.issue;
    return {
      title: `${i.key} ${i.summary}`,
      value: dueText(item),
      meta: [i.status, i.priority && `${i.priority} priority`, i.blocked ? "Blocked" : ""].filter(Boolean).join(", "),
      tone: itemTone(item) === "danger" ? "danger" : itemTone(item) === "warn" ? "warn" : "default",
    };
  }
  const start = item.start;
  const end = new Date(item.event.end);
  const time =
    item.allDay || !start ? "All day" : `${formatClock(start)}${Number.isNaN(end.getTime()) ? "" : ` to ${formatClock(end)}`}`;
  return { title: item.title, value: time, meta: item.url ? "Opens in Google Calendar" : undefined };
}

function Chip({
  item,
  index,
  animate,
  onTip,
}: {
  item: WeekItem;
  index: number;
  animate: boolean;
  onTip: (item: WeekItem | null, el?: HTMLElement) => void;
}) {
  const tone = itemTone(item);
  const cls = [
    styles.chip,
    item.kind === "event" ? styles.event : styles[`due-${item.urgency}`],
    animate ? styles.chipIn : "",
  ].join(" ");
  const style = animate ? ({ "--i": index } as CSSProperties) : undefined;
  const handlers = {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => onTip(item, e.currentTarget),
    onPointerLeave: () => onTip(null),
    onFocus: (e: FocusEvent<HTMLElement>) => onTip(item, e.currentTarget),
    onBlur: () => onTip(null),
  };
  const body =
    item.kind === "jira" ? (
      <>
        <span className={styles.chipHead}>
          <StatusDot tone={tone} size={8} glow={false} />
          <span className={styles.chipKey}>{item.issue.key}</span>
          {item.urgency === "overdue" ? <span className={styles.late}>{item.daysLate}d</span> : null}
        </span>
        <span className={styles.chipTitle}>{item.title}</span>
      </>
    ) : (
      <>
        <span className={styles.chipHead}>
          <span className={styles.chipTime}>{item.allDay || !item.start ? "All day" : formatClock(item.start)}</span>
        </span>
        <span className={styles.chipTitle}>{item.title}</span>
      </>
    );

  return item.url ? (
    <a className={cls} style={style} href={item.url} target="_blank" rel="noopener noreferrer" aria-label={itemLabel(item)} {...handlers}>
      {body}
    </a>
  ) : (
    // Nothing to open: plain text, hover still shows the details.
    <span className={cls} style={style} onPointerEnter={handlers.onPointerEnter} onPointerLeave={handlers.onPointerLeave}>
      {body}
    </span>
  );
}

function Lane({
  items,
  label,
  animate,
  offset,
  onTip,
  onMore,
}: {
  items: WeekItem[];
  label: string;
  animate: boolean;
  offset: number;
  onTip: (item: WeekItem | null, el?: HTMLElement) => void;
  onMore: () => void;
}) {
  const shown = items.slice(0, MAX_CHIPS);
  const more = items.length - shown.length;
  if (items.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label={label}>
      {shown.map((item, i) => (
        <li key={item.id}>
          <Chip item={item} index={offset + i} animate={animate} onTip={onTip} />
        </li>
      ))}
      {more > 0 ? (
        <li>
          <button
            type="button"
            className={styles.more}
            onClick={onMore}
            data-tip="Opens Work details on the Time tab; every open issue is on its Jira tab."
          >
            +{more} more<span className="sr-only"> on {label}, open details</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}

interface ChartProps {
  minutes: number[];
  showMinutes: boolean;
  placement: WeekPlacement;
  showOverdue: boolean;
  showItems: boolean;
  problems: Problem[];
  now: Date;
}

function WeekChart({ minutes, showMinutes, placement, showOverdue, showItems, problems, now }: ChartProps) {
  const reduced = useReducedMotion();
  const trigger = useDetailTrigger(DETAIL.area, DETAIL.key);
  const gradientId = `week-${useId().replace(/:/g, "")}`;
  const [hostRef, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipData | null>(null);
  const [animate] = useState(() => !reduced);

  const compact = width > 0 && width < COMPACT_BELOW;
  const sunday = startOfWeek(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(sunday, i));
  const todayIndex = now.getDay();

  const lane = showOverdue && !compact ? Math.round(Math.min(132, Math.max(88, width * 0.14))) : 0;
  // Lane first, then the 7 days. Starting the days one inner gap after the lane makes that gap equal
  // to the gap between days, so a CSS grid with the same column widths lines up to the pixel.
  const padding = 0.08;
  const start = lane ? lane + (padding * (width - lane)) / 7 : 0;
  const band = scaleBand<number>()
    .domain([0, 1, 2, 3, 4, 5, 6])
    .range([start, Math.max(start, width)])
    .paddingInner(padding);
  const bw = band.bandwidth();
  const gap = band.step() - bw;

  const chartH = compact ? 64 : 84;
  const baseY = HEAD + LABEL_BAND + chartH;
  const svgH = baseY + 8;
  const maxMinutes = Math.max(...minutes, 0);
  const y = scaleLinear()
    .domain([0, Math.max(120, maxMinutes)])
    .nice()
    .range([0, chartH]);
  const gridStep = (y.domain()[1] ?? 120) > 480 ? 240 : 120;
  const gridLines: number[] = [];
  for (let m = gridStep; m < (y.domain()[1] ?? 0); m += gridStep) gridLines.push(m);
  const barW = Math.max(6, Math.min(22, bw * 0.4));
  const draw = { duration: MOTION.draw, ease: MOTION.easeOut };
  const minuteLabel = (m: number) => (compact && m >= 60 ? `${formatNumber(m / 60, 1)}h` : formatMinutes(m));

  const onTip = (item: WeekItem | null, el?: HTMLElement) => {
    const host = hostRef.current;
    if (!item || !el || !host) {
      setTip(null);
      return;
    }
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTip({ x: r.left - h.left + r.width / 2, top: r.top - h.top, bottom: r.bottom - h.top, ...itemTip(item) });
  };

  const dayName = (i: number) => `${DAY_SHORT[i]} ${days[i]!.getDate()}`;
  const dayItems = placement.days;
  const anyItems = placement.overdue.length > 0 || dayItems.some((d) => d.length > 0);
  const footer: string[] = [];
  if (placement.dueLater > 0) footer.push(`${formatNumber(placement.dueLater)} more due after Saturday`);
  if (placement.noDueDate > 0) footer.push(`${plural(placement.noDueDate, "open issue")} with no due date`);
  const workedLabel = days
    .map((d, i) => (i > todayIndex ? null : `${DAY_SHORT[i]} ${formatMinutes(minutes[i] ?? 0)}`))
    .filter(Boolean)
    .join(", ");

  return (
    <div
      ref={hostRef}
      className={styles.host}
      onKeyDown={(e) => {
        if (e.key === "Escape" && tip) setTip(null);
      }}
    >
      {width > 0 ? (
        <>
          <div className={styles.board}>
            {/* Column backgrounds run the full height, so a day reads as one column from header to items. */}
            <div className={styles.cols} aria-hidden="true">
              {lane ? <div className={styles.laneBg} style={{ left: 0, width: lane }} /> : null}
              {days.map((_, i) => (
                <div
                  key={i}
                  className={[styles.col, i < todayIndex ? styles.past : i === todayIndex ? styles.todayCol : styles.future].join(" ")}
                  style={{ left: band(i), width: bw }}
                />
              ))}
            </div>

            <svg className={styles.svg} width={width} height={svgH} viewBox={`0 0 ${width} ${svgH}`} aria-hidden="true" focusable="false">
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" className={styles.barTop} />
                  <stop offset="100%" className={styles.barBottom} />
                </linearGradient>
              </defs>

              {lane ? (
                <g>
                  <text x={10} y={18} className={styles.laneLabel}>
                    OVERDUE
                  </text>
                  <text x={10} y={36} className={styles.laneCount}>
                    {formatNumber(placement.overdue.length)}
                  </text>
                </g>
              ) : null}

              {days.map((d, i) => {
                const cx = (band(i) ?? 0) + bw / 2;
                const isToday = i === todayIndex;
                return (
                  <g key={i}>
                    <text x={cx} y={18} textAnchor="middle" className={isToday ? styles.dayNameToday : styles.dayName}>
                      {DAY_SHORT[i]!.toUpperCase()}
                    </text>
                    <text x={cx} y={36} textAnchor="middle" className={isToday ? styles.dateToday : i < todayIndex ? styles.datePast : styles.date}>
                      {d.getDate()}
                    </text>
                  </g>
                );
              })}

              {showMinutes ? (
                <>
                  {gridLines.map((m) => (
                    <line
                      key={m}
                      className={styles.grid}
                      x1={band(0) ?? 0}
                      x2={width}
                      y1={baseY - y(m)}
                      y2={baseY - y(m)}
                    />
                  ))}
                  <motion.path
                    className={styles.baseline}
                    d={`M${band(0) ?? 0} ${baseY} H${width}`}
                    initial={animate ? { pathLength: 0 } : false}
                    animate={{ pathLength: 1 }}
                    transition={draw}
                  />
                  {days.map((_, i) => {
                    if (i > todayIndex) return null;
                    const m = minutes[i] ?? 0;
                    const h = y(m);
                    const cx = (band(i) ?? 0) + bw / 2;
                    const isToday = i === todayIndex;
                    const delay = animate ? 0.1 + i * MOTION.stagger : 0;
                    return (
                      <g key={i}>
                        {m > 0 ? (
                          <motion.rect
                            className={isToday ? styles.barToday : styles.bar}
                            x={cx - barW / 2}
                            width={barW}
                            rx={Math.min(3, barW / 2)}
                            fill={`url(#${gradientId})`}
                            initial={animate ? { y: baseY, height: 0 } : false}
                            animate={{ y: baseY - h, height: h }}
                            transition={{ ...draw, delay }}
                          />
                        ) : null}
                        <motion.text
                          x={cx}
                          y={baseY - h - 6}
                          textAnchor="middle"
                          className={m > 0 ? (isToday ? styles.valueToday : styles.value) : styles.valueZero}
                          initial={animate ? { opacity: 0 } : false}
                          animate={{ opacity: 1 }}
                          transition={{ duration: MOTION.base, delay: animate ? delay + MOTION.draw * 0.7 : 0 }}
                        >
                          {minuteLabel(m)}
                        </motion.text>
                        {isToday && animate ? (
                          <motion.circle
                            className={styles.pulse}
                            cx={cx}
                            cy={baseY - h}
                            r={3}
                            initial={{ scale: 1, opacity: 0 }}
                            animate={{ scale: [1, 3.4], opacity: [0.8, 0] }}
                            transition={{ duration: 0.9, delay: delay + MOTION.draw * 0.9, ease: MOTION.easeOut }}
                          />
                        ) : null}
                      </g>
                    );
                  })}
                </>
              ) : null}
            </svg>

            {showMinutes ? <p className="sr-only">Hours in Claude Code this week: {workedLabel}.</p> : null}

            {showItems && !compact ? (
              <div
                className={styles.lanes}
                style={{
                  gridTemplateColumns: `${lane ? `${lane}px ` : ""}repeat(7, ${bw}px)`,
                  columnGap: gap,
                }}
              >
                {lane ? (
                  <div className={styles.laneCell}>
                    <Lane
                      items={placement.overdue}
                      label="Overdue"
                      animate={animate}
                      offset={0}
                      onTip={onTip}
                      onMore={trigger.open}
                    />
                  </div>
                ) : null}
                {dayItems.map((items, i) => (
                  <div key={i} className={styles.laneCell}>
                    <Lane
                      items={items}
                      label={longDay(days[i]!)}
                      animate={animate}
                      offset={i + 1}
                      onTip={onTip}
                      onMore={trigger.open}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {showItems && compact && anyItems ? (
            <ul className={styles.agenda}>
              {placement.overdue.length > 0 ? (
                <li className={`${styles.agendaRow} ${styles.agendaOverdue}`}>
                  <span className={styles.agendaDay}>
                    Overdue <span className={styles.agendaCount}>{placement.overdue.length}</span>
                  </span>
                  <Lane items={placement.overdue} label="Overdue" animate={animate} offset={0} onTip={onTip} onMore={trigger.open} />
                </li>
              ) : null}
              {dayItems.map((items, i) =>
                items.length > 0 ? (
                  <li key={i} className={[styles.agendaRow, i === todayIndex ? styles.agendaToday : ""].join(" ")}>
                    <span className={styles.agendaDay}>
                      {dayName(i)}
                      {i === todayIndex ? <span className="sr-only"> (today)</span> : null}
                    </span>
                    <Lane items={items} label={longDay(days[i]!)} animate={animate} offset={i + 1} onTip={onTip} onMore={trigger.open} />
                  </li>
                ) : null,
              )}
            </ul>
          ) : null}

          {(showItems && !anyItems) || footer.length > 0 || problems.length > 0 ? (
            <ul className={styles.notes}>
              {showItems && !anyItems ? (
                <li className={styles.noteLine}>
                  <StatusDot tone="ok" size={8} glow={false} />
                  <span>Nothing due or scheduled this week.</span>
                </li>
              ) : null}
              {footer.length > 0 ? (
                <li className={styles.noteLine}>
                  <span className={styles.noteMuted}>{footer.join(". ")}.</span>
                </li>
              ) : null}
              {problems.map((p) => (
                <li key={p.key} className={styles.noteLine}>
                  <StatusDot tone={p.tone} size={8} glow={false} />
                  <span>{p.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <ChartTooltip tip={tip} hostWidth={width} />
    </div>
  );
}

/** Panel props for the timeline from three sources: Jira, Calendar and Claude sessions. */
function weekStatus(
  snap: ReturnType<typeof useSnapshot>,
  data: Snapshot | null,
  hasContent: boolean,
): PanelStatus & { problems: Problem[] } {
  const base = panelFromSource(snap, null, { isEmpty: () => false, empty: "" });
  if (base.state !== "ok" || !data) return { ...base, problems: [] };

  const states = SOURCES.map((k) => [k, data.sources[k]] as const);
  const problems = states.map(([k, s]) => problemFor(k, s)).filter((p): p is Problem => p !== null);

  if (!states.some(([, s]) => usable(s))) {
    if (states.every(([, s]) => s.status === "never_run")) {
      return {
        state: "empty",
        message: "Not collected yet.",
        hint: "Jira, Calendar and Claude sessions are collected on the next refresh.",
        problems: [],
      };
    }
    const first = problems.find((p) => p.tone === "off") ?? problems[0];
    return {
      state: "not_connected",
      message: first ? first.text : "Connect Jira or Google Calendar to see this week.",
      hint: problems
        .filter((p) => p !== first)
        .map((p) => p.text)
        .join(" "),
      problems: [],
    };
  }

  if (!hasContent && problems.length === 0) {
    return {
      state: "empty",
      message: "A clear week so far.",
      hint: "Due dates, meetings and hours worked show here as they come in.",
      problems: [],
    };
  }

  // Amber notice for a source whose last update failed or is out of date but still has data.
  const notices = states
    .filter(([, s]) => s.status === "error" || s.status === "stale")
    .map(([k]) => panelFromSource(snap, k, { isEmpty: () => false, empty: "" }).notice)
    .filter((n): n is string => Boolean(n));
  return { state: "ok", notice: notices.length ? notices.join(" ") : undefined, problems };
}

export function WeekTimeline() {
  const snap = useSnapshot();
  const now = new Date();
  const today = dayKey(now);
  const data = snap.data;

  const placement = useMemo(
    () => (data ? placeWeekItems(data.work.jira, data.calendar, new Date()) : null),
    // `today` moves items between lanes at midnight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, today],
  );
  const minutes = useMemo(
    () => (data ? weekMinutes(data.work.sessionTime, new Date()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, today],
  );

  const jiraOn = data ? usable(data.sources.jira) : false;
  const calendarOn = data ? usable(data.sources.calendar) : false;
  const sessionsOn = data ? usable(data.sources.claudeSessions) : false;
  const anyItems = !!placement && (placement.overdue.length > 0 || placement.days.some((d) => d.length > 0));
  const anyMinutes = minutes.some((m) => m > 0);
  const { problems, ...status } = weekStatus(snap, data, anyItems || anyMinutes);

  return (
    <Panel
      title={TITLE}
      {...status}
      fit
      skeleton="chart"
      detail={DETAIL}
      meta={status.state === "ok" ? weekRangeLabel(now) : undefined}
    >
      {placement ? (
        <WeekChart
          minutes={minutes}
          showMinutes={sessionsOn}
          placement={placement}
          showOverdue={jiraOn}
          showItems={jiraOn || calendarOn}
          problems={problems}
          now={now}
        />
      ) : null}
    </Panel>
  );
}
