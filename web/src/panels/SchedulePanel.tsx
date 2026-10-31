import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { CalendarEvent, PlanItem, ScheduleRange, SchedulePlan, SourceStatus, TaskNote } from "../../../shared/types";
import { errorMessage } from "../api";
import { notReady, onScheduleCommand, onTasksChanged, scheduleApi, tasksChanged, type ScheduleCommand } from "../api/schedule";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import type { MenuSection } from "../lib/contextMenu";
import { dayKey, formatMinutes, plural, relativeTime } from "../lib/format";
import { noteHash } from "../lib/route";
import {
  DAY_START,
  DEFAULT_TASK_MINUTES,
  SCHEDULE_VIEWS,
  TASK_LENGTHS,
  acceptCounts,
  acceptTarget,
  acceptedPaths,
  buildDay,
  buildWeek,
  dayBounds,
  dayFreeGaps,
  dayLabel,
  firstFit,
  formatHm,
  httpsUrl,
  layoutLanes,
  minuteOfDay,
  minutesToPx,
  movingPaths,
  notPlaced,
  patchTask,
  planFrom,
  planHeading,
  planItems,
  planItemsIn,
  planRequestDate,
  planTitle,
  daysBetween,
  rangeLabel,
  stepOffset,
  timeSpan,
  totalMinutes,
  viewRange,
  whenText,
  withTask,
  withoutPlanItems,
  type Block,
  type DayModel,
  type ScheduleView,
  type UnplacedTask,
  type WeekRow,
} from "../lib/schedule";
import { Button, Spinner } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { EmptyState } from "../ui/EmptyState";
import { Panel, type PanelState } from "../ui/Panel";
import { SkeletonRows } from "../ui/Skeleton";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { openItem, opensIn } from "./linkMenu";
import { Segmented, useStoredChoice, type SegmentedOption } from "./ProjectTimeBars";
import styles from "./SchedulePanel.module.css";

// Schedule: today's (or this week's) meetings from the calendar and task notes, under Next moves.
//   Day   a timeline from 08:00 to 18:00 (stretched to the earliest or latest item) with meetings and
//         timed tasks as blocks, overlapping ones side by side, a "now" line on today; tasks with no
//         start time are listed under it.
//   Week  seven columns from the first day, each a compact list.
// The Day/Week pick is kept in this browser; the arrows move a day or a week, up to 14 days away.
// Add task opens an inline form (POST); a task's checkbox marks it done (PATCH); its title opens its
// note. Overdue and unscheduled tasks wait in the "Not placed" strip with a quick Today.
// Plan my day / week asks Claude for a proposal for the day shown (POST { scope, date }, 30 to 60 s):
// ghost blocks on their own day only, plus a review list headed with the plan's real date. A proposal
// that moves an existing task reads "Move: <title>" and that task's current slot is drawn faded.
// Accepting creates task notes or moves the tasks, then switches to Day view on the plan's day and
// highlights the new blocks once (not with reduced motion). Every write shows at once and is put back
// if the server refuses. Before the schedule server exists (501) the panel says so and nothing else.
// Right-click the panel for Add task, Plan, Day/Week and Today; a task for Mark done, Open note and
// (when it has no place yet) Move to today; a meeting for Open in Google Calendar; the plan for its buttons.
// Do now (DoNowPanel) talks to this panel through api/schedule: either one says when it changed a
// task, and Do now's empty state can ask this panel to plan today or open Add task.

const TITLE = "Schedule";
/** How long accepted blocks stay highlighted (the CSS flash is shorter). */
const FLASH_MS = 1000;
const NO_PATHS: ReadonlySet<string> = new Set();
const PX_PER_HOUR = 48;
/** The shortest a block is drawn: one line of text. Shorter items are drawn this tall. */
const MIN_BLOCK_PX = 24;
const MIN_BLOCK_MINUTES = (MIN_BLOCK_PX / PX_PER_HOUR) * 60;
/** Below this height a block shows time and title on one line. */
const TWO_LINE_PX = 40;
const UNPLACED_FIRST = 4;
const STALE_AFTER_MS = 5 * 60_000;

const VIEW_OPTIONS: readonly SegmentedOption<ScheduleView>[] = [
  { value: "day", label: "Day", tip: "Shows one day as a timeline from 08:00 to 18:00; the pick is kept in this browser." },
  { value: "week", label: "Week", tip: "Shows 7 days as columns, starting from the day shown; the pick is kept in this browser." },
];

const TIP = {
  prev: { day: "Shows the day before; the arrows reach 14 days either way.", week: "Shows the 7 days before these; the arrows reach 14 days either way." },
  next: { day: "Shows the next day; the arrows reach 14 days either way.", week: "Shows the next 7 days; the arrows reach 14 days either way." },
  limit: "That is as far as the schedule goes: 14 days from today.",
  today: "Goes back to today.",
  add: "Opens a short form to add a task with a day, start time and length.",
  addOpen: "The form is open below; Cancel or Esc closes it.",
  planning: "Claude is planning now; this takes about 30 to 60 seconds.",
  moving: "Claude proposes moving this task; it moves only if you accept.",
  showPlanDay: "Shows the plan's first day as a timeline, with the proposals on it.",
  done: "Marks this task done in its note.",
  reopen: "Marks this task not done again.",
  openNote: "Opens the task's note in the Notes view, where you can edit its details.",
  moveToday: "Sets this task's day to today, so it shows on today's schedule.",
  include: "Proposed by Claude and included; click to leave it out when you accept.",
  exclude: "Proposed by Claude and left out; click to include it when you accept.",
  acceptSelected: "Adds the ticked items to your schedule (new task notes, or moves for existing tasks); the rest stay here to review.",
  acceptAll: "Adds every proposed item to your schedule: new tasks become notes, existing ones move.",
  dismiss: "Drops this proposal; no tasks are created.",
  tryAgain: "Runs Claude again for a new proposal.",
  showDay: "Shows this day as a timeline.",
  retry: "Asks the local server for this schedule again.",
  notReady: "Checks again whether the dashboard server serves the schedule yet.",
} as const;

/** A day in a sentence: "today", "tomorrow", else "Mon 2 Nov". */
function dayWords(key: string, todayKey: string): string {
  const label = dayLabel(key, todayKey);
  return label === "Today" || label === "Tomorrow" ? label.toLowerCase() : label;
}

/** What a plan request covers, in words: "today", "Mon 2 Nov", "the week from tomorrow". */
function planWhat(scope: ScheduleView, date: string, todayKey: string): string {
  return scope === "week" ? `the week from ${dayWords(date, todayKey)}` : dayWords(date, todayKey);
}

/** Hover help for Plan my day / week: which days Claude plans, and why it is today on a past day. */
function planTip(scope: ScheduleView, shownFrom: string, todayKey: string): string {
  const date = planRequestDate(shownFrom, todayKey);
  const when = dayWords(date, todayKey);
  if (date !== shownFrom) {
    const over = scope === "week" ? "These days start in the past" : "This day is over";
    return `${over}, so Claude plans ${scope === "week" ? `the 7 days from ${when}` : when}; nothing is added until you accept.`;
  }
  return scope === "week"
    ? `Asks Claude to spread your open tasks over the 7 days from ${when}; nothing is added until you accept.`
    : `Asks Claude to fit your open tasks into ${when}'s free time; nothing is added until you accept.`;
}

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6zM13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"
        fill="currentColor"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={dir === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg className={styles.extIcon} viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path
        d="M6.5 3.5H3.5v9h9v-3M9 3h4v4M13 3 7.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** Current time, re-read every `everyMs` (the now line, "Generated 2 min ago", midnight rollover). */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

interface RangeState {
  data: ScheduleRange | null;
  /** The `from|to` that `data` belongs to. */
  key: string | null;
  loading: boolean;
  error: string | null;
  /** The server has no schedule yet (501 before T27, 404 on an older build). */
  notReady: boolean;
}

/**
 * GET /api/schedule for the days shown. Keeps the last answer on screen while the next one loads,
 * and remembers each range so the arrows go back instantly. `edit` changes the shown range locally
 * (a new or ticked task) and forgets the other remembered ranges, which may now be out of date.
 */
function useScheduleRange(from: string, to: string) {
  const key = `${from}|${to}`;
  const [state, setState] = useState<RangeState>({ data: null, key: null, loading: true, error: null, notReady: false });
  const cache = useRef(new Map<string, ScheduleRange>());
  const loadedAt = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const cached = cache.current.get(key);
    setState((s) => ({ ...s, ...(cached ? { data: cached, key } : {}), loading: true }));
    scheduleApi
      .range(from, to, ctrl.signal)
      .then((data) => {
        cache.current.set(key, data);
        loadedAt.current = Date.now();
        setState({ data, key, loading: false, error: null, notReady: false });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: errorMessage(err), notReady: notReady(err) }));
      });
    return () => ctrl.abort();
  }, [from, to, key, tick]);

  // Back on the tab after a while: read again, so meetings and ticks from elsewhere show.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > STALE_AFTER_MS) setTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const edit = useCallback((fn: (r: ScheduleRange) => ScheduleRange) => {
    setState((s) => {
      if (!s.data) return s;
      const data = fn(s.data);
      cache.current.clear();
      if (s.key) cache.current.set(s.key, data);
      return { ...s, data };
    });
  }, []);

  return { ...state, current: state.key === key, reload, edit };
}

// ---------------------------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------------------------

/** A real checkbox over a drawn box, small enough for a timeline block (24 px target). */
function TaskCheck({ task, onToggle }: { task: TaskNote; onToggle: (task: TaskNote, done: boolean) => void }) {
  const done = task.task.done;
  return (
    <span className={styles.check}>
      <input
        type="checkbox"
        checked={done}
        onChange={() => onToggle(task, !done)}
        aria-label={`Done: ${task.title}`}
        data-tip={done ? TIP.reopen : TIP.done}
      />
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <rect className={styles.box} x="1.5" y="1.5" width="15" height="15" rx="4" />
        <path className={styles.tick} d="M5 9.4l2.7 2.6L13 6.4" pathLength={1} />
      </svg>
    </span>
  );
}

/** The task's title as a link to its note. */
function NoteLink({ task, className }: { task: TaskNote; className?: string }) {
  return (
    <a className={[styles.noteLink, className].filter(Boolean).join(" ")} href={noteHash(task.path)} data-tip={TIP.openNote}>
      {task.title}
    </a>
  );
}

/** A meeting's title: a link to Google Calendar when it has an https url, else plain text. */
function MeetingTitle({ event, className }: { event: CalendarEvent; className?: string }) {
  const url = httpsUrl(event.url);
  if (!url) return <span className={className}>{event.title}</span>;
  return (
    <a
      className={[styles.meetingLink, className].filter(Boolean).join(" ")}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-tip={`${opensIn(url)}.`}
    >
      {event.title}
      <span className="sr-only"> (opens in a new tab)</span>
      <ExternalIcon />
    </a>
  );
}

interface TaskActions {
  onToggle: (task: TaskNote, done: boolean) => void;
  onToday: (task: TaskNote) => void;
  /** Tasks an included proposal would move: their current slot is drawn faded. */
  moving: ReadonlySet<string>;
  /** Tasks just placed by Accept: scrolled into view, and highlighted once unless motion is reduced. */
  flash: ReadonlySet<string>;
  flashAnimate: boolean;
}

/** Class and hover help for a task's current slot when a proposal would move it, or when it just landed. */
function taskMarks(task: TaskNote, tasks: TaskActions): { className: string; tip?: string; flash?: true } {
  const moving = tasks.moving.has(task.path) && !task.task.done;
  const flash = tasks.flash.has(task.path);
  return {
    className: [moving ? styles.moving : "", flash && tasks.flashAnimate ? styles.flash : ""].filter(Boolean).join(" "),
    tip: moving ? TIP.moving : undefined,
    flash: flash || undefined,
  };
}

/** Screen reader words after a task that a proposal would move. */
function MovingNote({ task, tasks }: { task: TaskNote; tasks: TaskActions }) {
  return tasks.moving.has(task.path) && !task.task.done ? <span className="sr-only">, Claude proposes moving it</span> : null;
}

function taskMenu(task: TaskNote, actions: TaskActions, canMoveToday: boolean): MenuSection {
  return {
    title: task.title,
    items: [
      task.task.done
        ? { label: "Mark not done", onSelect: () => actions.onToggle(task, false), tip: TIP.reopen }
        : { label: "Mark done", onSelect: () => actions.onToggle(task, true), tip: TIP.done },
      openItem(noteHash(task.path), TIP.openNote),
      canMoveToday ? { label: "Move to today", onSelect: () => actions.onToday(task), tip: TIP.moveToday } : null,
    ],
  };
}

function meetingMenu(event: CalendarEvent): MenuSection | null {
  const item = openItem(httpsUrl(event.url));
  return item ? { title: event.title, items: [item] } : null;
}

interface PlanActions {
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

function planMenu(item: PlanItem, plan: PlanActions): MenuSection {
  const on = plan.selected.has(item.id);
  return {
    title: planTitle(item),
    items: [{ label: on ? "Leave out of plan" : "Include in plan", onSelect: () => plan.onToggle(item.id), tip: on ? TIP.include : TIP.exclude }],
  };
}

function AiTag() {
  return (
    <span className={styles.aiTag} aria-hidden="true">
      AI
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Day timeline
// ---------------------------------------------------------------------------------------------

/** The panel body (or another scroller inside the panel) that holds `el`, or null when the page scrolls. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node.tagName !== "SECTION") {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** A block's time: short blocks show only the start, screen readers always get the whole span. */
function BlockTime({ what, span, shown }: { what: string; span: string; shown: string }) {
  return (
    <span className={styles.blockTime}>
      <span className="sr-only">
        {what}, {span}
      </span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

function TimelineBlock({
  block,
  bounds,
  past,
  tasks,
  plan,
}: {
  block: Block & { lane: number; lanes: number };
  bounds: { start: number };
  past: boolean;
  tasks: TaskActions;
  plan: PlanActions;
}) {
  const top = minutesToPx(block.start, bounds.start, PX_PER_HOUR);
  const height = Math.max(MIN_BLOCK_PX, minutesToPx(block.end, block.start, PX_PER_HOUR));
  const compact = height < TWO_LINE_PX;
  const style = { top, height, "--lane": block.lane, "--lanes": block.lanes } as CSSProperties;
  const span = timeSpan(block.start, block.end);
  const menu = useMenuRegion(() =>
    block.kind === "task" ? taskMenu(block.task, tasks, false) : block.kind === "event" ? meetingMenu(block.event) : planMenu(block.plan, plan),
  );
  const cls = [styles.block, styles[block.kind], compact ? styles.compact : "", past ? styles.pastBlock : ""];

  if (block.kind === "plan") {
    const on = plan.selected.has(block.plan.id);
    return (
      <li {...menu} className={[...cls, on ? "" : styles.off].join(" ")} style={style}>
        <button
          type="button"
          className={styles.ghostButton}
          aria-pressed={on}
          onClick={() => plan.onToggle(block.plan.id)}
          data-tip={on ? TIP.include : TIP.exclude}
        >
          <span className="sr-only">Proposed by Claude, {on ? "included" : "left out"}: </span>
          <AiTag />
          <span className={styles.blockTime}>{formatHm(block.start)}</span>
          <span className={styles.blockTitle}>{block.title}</span>
        </button>
      </li>
    );
  }

  if (block.kind === "task") {
    const t = block.task;
    const marks = taskMarks(t, tasks);
    return (
      <li
        {...menu}
        className={[...cls, t.task.done ? styles.isDone : "", marks.className].join(" ")}
        style={style}
        data-tip={marks.tip}
        data-flash={marks.flash}
      >
        <TaskCheck task={t} onToggle={tasks.onToggle} />
        <span className={styles.blockText}>
          <BlockTime what="Task" span={span} shown={compact ? formatHm(block.start) : span} />
          <NoteLink task={t} className={styles.blockTitle} />
          <MovingNote task={t} tasks={tasks} />
        </span>
      </li>
    );
  }

  return (
    <li {...menu} className={cls.join(" ")} style={style} data-tip={httpsUrl(block.event.url) ? undefined : `${span}: ${block.title}`}>
      <span className={styles.blockText}>
        <BlockTime what="Meeting" span={span} shown={compact ? formatHm(block.start) : span} />
        <MeetingTitle event={block.event} className={styles.blockTitle} />
      </span>
    </li>
  );
}

function DayTimeline({
  model,
  todayKey,
  now,
  tasks,
  plan,
}: {
  model: DayModel;
  todayKey: string;
  now: Date;
  tasks: TaskActions;
  plan: PlanActions;
}) {
  const laned = useMemo(() => layoutLanes(model.blocks, MIN_BLOCK_MINUTES), [model.blocks]);
  const bounds = dayBounds(model.blocks);
  const height = minutesToPx(bounds.end, bounds.start, PX_PER_HOUR);
  const isToday = model.date === todayKey;
  const isPast = model.date < todayKey;
  const nowMin = minuteOfDay(now);
  const showNow = isToday && nowMin >= bounds.start && nowMin <= bounds.end;
  const hours: number[] = [];
  for (let m = bounds.start; m <= bounds.end; m += 60) hours.push(m);
  const ref = useRef<HTMLDivElement>(null);

  // On arrival at a day: bring "now" (today) or the first block into view inside the panel's own
  // scroller. Never scrolls the page itself.
  const firstStart = model.blocks[0]?.start ?? DAY_START;
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const scroller = scrollerOf(host);
    if (!scroller) return;
    const target = minutesToPx(isToday ? nowMin : firstStart, bounds.start, PX_PER_HOUR);
    const hostTop = host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, hostTop + target - scroller.clientHeight / 3);
    // Only when the day changes, not every minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.date]);

  // Just after Accept: bring the first block that landed into view instead (runs after the one above).
  const landed = tasks.flash.size ? [...tasks.flash].sort().join("\n") : "";
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !landed) return;
    const el = host.querySelector<HTMLElement>("[data-flash]");
    const scroller = scrollerOf(host);
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
  }, [landed, model.date]);

  return (
    <div ref={ref} className={styles.timeline} style={{ height }}>
      <div className={styles.hours} aria-hidden="true">
        {hours.map((m) => (
          <span key={m} className={styles.hour} style={{ top: minutesToPx(m, bounds.start, PX_PER_HOUR) }}>
            <span className={styles.hourLabel}>{formatHm(m)}</span>
          </span>
        ))}
      </div>
      {showNow ? (
        <>
          <div className={styles.elapsed} style={{ height: minutesToPx(nowMin, bounds.start, PX_PER_HOUR) }} aria-hidden="true" />
          <div className={styles.now} style={{ top: minutesToPx(nowMin, bounds.start, PX_PER_HOUR) }} aria-hidden="true">
            <span className={styles.nowLabel}>{formatHm(nowMin)}</span>
          </div>
        </>
      ) : null}
      <ol className={styles.track} aria-label={`Timeline, ${dayLabel(model.date, todayKey)}`}>
        {laned.map((b) => (
          <TimelineBlock
            key={b.id}
            block={b}
            bounds={bounds}
            past={isPast || (isToday && b.end <= nowMin)}
            tasks={tasks}
            plan={plan}
          />
        ))}
      </ol>
    </div>
  );
}

function AllDayRow({ events }: { events: CalendarEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className={styles.allDay}>
      <span className={styles.kicker}>All day</span>
      <ul className={styles.allDayList}>
        {events.map((e) => (
          <AllDayChip key={e.id} event={e} />
        ))}
      </ul>
    </div>
  );
}

function AllDayChip({ event }: { event: CalendarEvent }) {
  const menu = useMenuRegion(() => meetingMenu(event));
  return (
    <li {...menu} className={styles.allDayChip}>
      <span className="sr-only">All-day meeting: </span>
      <MeetingTitle event={event} />
    </li>
  );
}

function TaskRow({ task, tasks, todayKey, meta, unplaced }: { task: TaskNote; tasks: TaskActions; todayKey: string; meta?: ReactNode; unplaced?: UnplacedTask["reason"] }) {
  const menu = useMenuRegion(() => taskMenu(task, tasks, !!unplaced));
  const marks = taskMarks(task, tasks);
  return (
    <li
      {...menu}
      className={[styles.taskRow, task.task.done ? styles.isDone : "", marks.className].join(" ")}
      data-task-path={task.path}
      data-tip={marks.tip}
      data-flash={marks.flash}
    >
      <TaskCheck task={task} onToggle={tasks.onToggle} />
      <span className={styles.taskText}>
        <NoteLink task={task} className={styles.taskTitle} />
        <MovingNote task={task} tasks={tasks} />
        <span className={styles.taskMeta}>
          {unplaced === "overdue" && task.task.due ? (
            <span className={styles.overdue}>
              <StatusDot tone="warn" size={8} glow={false} />
              Due {dayLabel(task.task.due, todayKey)}
            </span>
          ) : unplaced === "unscheduled" ? (
            <span>No day yet</span>
          ) : task.task.minutes ? (
            <span>{formatMinutes(task.task.minutes)}</span>
          ) : null}
          {meta}
        </span>
      </span>
      {unplaced ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.todayButton}
          onClick={() => tasks.onToday(task)}
          aria-label={`Move to today: ${task.title}`}
          tip={TIP.moveToday}
          data-today-for={task.path}
        >
          Today
        </Button>
      ) : null}
    </li>
  );
}

function PlanRow({ item, plan }: { item: PlanItem; plan: PlanActions }) {
  const on = plan.selected.has(item.id);
  const menu = useMenuRegion(() => planMenu(item, plan));
  return (
    <li {...menu} className={[styles.ghostRow, on ? "" : styles.off].join(" ")}>
      <button type="button" className={styles.ghostButton} aria-pressed={on} onClick={() => plan.onToggle(item.id)} data-tip={on ? TIP.include : TIP.exclude}>
        <span className="sr-only">Proposed by Claude, {on ? "included" : "left out"}: </span>
        <AiTag />
        <span className={styles.blockTitle}>{planTitle(item)}</span>
        {item.minutes ? <span className={styles.ghostWhen}>{formatMinutes(item.minutes)}</span> : null}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Week columns
// ---------------------------------------------------------------------------------------------

function WeekItem({ row, tasks, plan }: { row: WeekRow; tasks: TaskActions; plan: PlanActions }) {
  const menu = useMenuRegion(() =>
    row.kind === "task" ? taskMenu(row.task, tasks, false) : row.kind === "event" ? meetingMenu(row.event) : planMenu(row.plan, plan),
  );
  const time = row.start === null ? (row.kind === "event" ? "All day" : "Any time") : formatHm(row.start);
  if (row.kind === "plan") {
    const on = plan.selected.has(row.plan.id);
    return (
      <li {...menu} className={[styles.weekRow, styles.plan, on ? "" : styles.off].join(" ")}>
        <button type="button" className={styles.ghostButton} aria-pressed={on} onClick={() => plan.onToggle(row.plan.id)} data-tip={on ? TIP.include : TIP.exclude}>
          <span className="sr-only">Proposed by Claude, {on ? "included" : "left out"}: </span>
          <span className={styles.weekTime}>
            <AiTag /> {time}
          </span>
          <span className={styles.weekTitle}>{row.title}</span>
        </button>
      </li>
    );
  }
  if (row.kind === "task") {
    const marks = taskMarks(row.task, tasks);
    return (
      <li
        {...menu}
        className={[styles.weekRow, styles.task, row.task.task.done ? styles.isDone : "", marks.className].join(" ")}
        data-tip={marks.tip}
        data-flash={marks.flash}
      >
        <TaskCheck task={row.task} onToggle={tasks.onToggle} />
        <span className={styles.weekText}>
          <span className={styles.weekTime}>
            <span className="sr-only">Task, </span>
            {time}
          </span>
          <NoteLink task={row.task} className={styles.weekTitle} />
          <MovingNote task={row.task} tasks={tasks} />
        </span>
      </li>
    );
  }
  return (
    <li {...menu} className={[styles.weekRow, styles.event].join(" ")}>
      <span className={styles.weekText}>
        <span className={styles.weekTime}>
          <span className="sr-only">Meeting, </span>
          {time}
        </span>
        <MeetingTitle event={row.event} className={styles.weekTitle} />
      </span>
    </li>
  );
}

function WeekGrid({
  columns,
  tasks,
  plan,
  onShowDay,
}: {
  columns: ReturnType<typeof buildWeek>;
  tasks: TaskActions;
  plan: PlanActions;
  onShowDay: (date: string) => void;
}) {
  return (
    <div className={styles.weekHost}>
      <ol className={styles.week}>
        {columns.map((col) => (
          <li key={col.date} className={styles.col} data-today={col.isToday || undefined} data-past={col.isPast || undefined}>
            <h3 className={styles.colHead}>
              <button type="button" className={styles.colButton} onClick={() => onShowDay(col.date)} data-tip={TIP.showDay}>
                <span className={styles.colDay}>{col.weekday}</span>
                <span className={styles.colNum}>{col.dayNum}</span>
                {col.isToday ? <span className="sr-only">, today</span> : null}
                <span className="sr-only">, {plural(col.rows.length, "item")}. Show as a timeline</span>
              </button>
            </h3>
            {col.rows.length ? (
              <ul className={styles.colList}>
                {col.rows.map((row) => (
                  <WeekItem key={row.id} row={row} tasks={tasks} plan={plan} />
                ))}
              </ul>
            ) : (
              <p className={styles.colEmpty}>Free</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Add task form
// ---------------------------------------------------------------------------------------------

interface ProjectOption {
  id: string;
  name: string;
}

function AddTaskForm({
  projects,
  defaultDay,
  defaultStart,
  todayKey,
  onAdd,
  onClose,
}: {
  projects: ProjectOption[];
  defaultDay: string;
  defaultStart: (day: string, minutes: number) => string;
  todayKey: string;
  onAdd: (input: { title: string; projectId: string | null; due: string | null; start: string | null; minutes: number | null }) => Promise<string | null>;
  onClose: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [day, setDay] = useState(defaultDay);
  const [minutes, setMinutes] = useState<number>(DEFAULT_TASK_MINUTES);
  const [start, setStart] = useState(() => defaultStart(defaultDay, DEFAULT_TASK_MINUTES));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = title.trim();
    if (!value) {
      setError("Give the task a title.");
      titleRef.current?.focus();
      return;
    }
    setError(null);
    setSaving(true);
    const failed = await onAdd({
      title: value,
      projectId: projectId || null,
      due: day || null,
      start: day && start ? start : null,
      minutes,
    });
    setSaving(false);
    if (failed) {
      setError(failed);
      titleRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} onKeyDown={onKeyDown} noValidate aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`} className={styles.kicker}>
        New task
      </h3>
      <div className={styles.fields}>
        <label className={[styles.field, styles.fieldWide].join(" ")}>
          <span className={styles.fieldLabel}>Title</span>
          <input
            ref={titleRef}
            className={styles.input}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (error) setError(null);
            }}
            maxLength={200}
            required
            aria-invalid={error === "Give the task a title." || undefined}
            aria-describedby={error ? `${uid}-err` : undefined}
            placeholder="What needs doing?"
            data-tip="Required. Becomes the title of a new note in the Tasks section."
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Project</span>
          <select
            className={styles.input}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            data-tip="Links the task to a project, so it also shows on that project's page."
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Day</span>
          <input
            type="date"
            className={styles.input}
            value={day}
            min={todayKey}
            onChange={(e) => {
              setDay(e.target.value);
              if (!e.target.value) setStart("");
            }}
            data-tip="The day the task is for; leave it empty for no day yet."
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Start</span>
          <input
            type="time"
            className={styles.input}
            value={start}
            step={300}
            disabled={!day}
            onChange={(e) => setStart(e.target.value)}
            data-tip={day ? "Optional. With a start time the task is a block on the timeline." : "Pick a day first; a start time needs a day."}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Length</span>
          <select
            className={styles.input}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            data-tip="How long you plan to spend on it."
          >
            {TASK_LENGTHS.map((m) => (
              <option key={m} value={m}>
                {formatMinutes(m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p id={`${uid}-err`} className={styles.fieldError} role="alert">
          <StatusDot tone="danger" size={8} glow={false} />
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button type="submit" variant="primary" size="sm" icon={<PlusIcon />} loading={saving} loadingLabel="Adding" tip="Saves the task as a note and shows it here.">
          Add task
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} tip="Closes the form without adding anything.">
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// AI plan review
// ---------------------------------------------------------------------------------------------

function PlanRunning({ what, startedAt, now }: { what: string; startedAt: number; now: number }) {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className={styles.planRunning}>
      <p className={styles.planRunningLine}>
        <Spinner size={14} />
        <span>Claude is planning {what}</span>
      </p>
      <p className={styles.planHint}>
        This takes about 30 to 60 seconds. <span className={styles.mono}>{seconds} s</span> so far.
      </p>
    </div>
  );
}

function PlanReview({
  plan,
  items,
  selected,
  todayKey,
  now,
  busy,
  projectName,
  jump,
  onToggle,
  onAccept,
  onDismiss,
}: {
  plan: SchedulePlan;
  items: PlanItem[];
  selected: ReadonlySet<string>;
  todayKey: string;
  now: Date;
  busy: "accept" | "acceptAll" | "dismiss" | null;
  projectName: (id: string | null) => string | null;
  /** When the plan's first day is not on screen: a button that shows it. */
  jump: { label: string; onShow: () => void } | null;
  onToggle: (id: string) => void;
  onAccept: (ids: string[], all: boolean) => void;
  onDismiss: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const chosen = items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const heading = planHeading(plan, todayKey);
  const menu = useMenuRegion(() => ({
    title: heading,
    items: [
      { label: `Accept selected (${chosen.length})`, onSelect: () => onAccept(chosen, false), disabled: chosen.length === 0 ? "Tick at least one item first." : !!busy, tip: TIP.acceptSelected },
      { label: "Accept all", onSelect: () => onAccept(items.map((i) => i.id), true), disabled: !!busy, tip: TIP.acceptAll },
      { label: "Dismiss plan", onSelect: onDismiss, disabled: !!busy, tip: TIP.dismiss },
      jump ? { label: jump.label, onSelect: jump.onShow, tip: TIP.showPlanDay } : null,
    ],
  }));
  return (
    <section {...menu} className={styles.review} aria-labelledby={`${uid}-h`}>
      <header className={styles.reviewHead}>
        <h3 id={`${uid}-h`} className={styles.reviewTitle}>
          <StatusDot tone="ai" size={8} glow={false} />
          {heading}
        </h3>
        {plan.generatedAt ? (
          <time className={styles.reviewMeta} dateTime={plan.generatedAt}>
            {relativeTime(plan.generatedAt, now)}
          </time>
        ) : null}
      </header>
      <p className={styles.planHint}>Tick what you want, then accept. Nothing is added or moved until you do.</p>
      {jump ? (
        <p className={styles.planJump}>
          <span>The proposals show on their own day.</span>
          <Button variant="ghost" size="sm" onClick={jump.onShow} tip={TIP.showPlanDay}>
            {jump.label}
          </Button>
        </p>
      ) : null}
      <ul className={styles.reviewList}>
        {items.map((item) => {
          const project = projectName(item.projectId);
          return (
            <li key={item.id} className={styles.reviewItem}>
              <label className={styles.reviewLabel}>
                <span className={[styles.check, styles.checkAi].join(" ")}>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => onToggle(item.id)}
                    data-tip={selected.has(item.id) ? TIP.include : TIP.exclude}
                  />
                  <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                    <rect className={styles.box} x="1.5" y="1.5" width="15" height="15" rx="4" />
                    <path className={styles.tick} d="M5 9.4l2.7 2.6L13 6.4" pathLength={1} />
                  </svg>
                </span>
                <span className={styles.reviewText}>
                  <span className={styles.reviewItemTitle}>{planTitle(item)}</span>
                  <span className={styles.reviewWhen}>
                    {whenText(item.date, item.start, item.minutes, todayKey)}
                    {project ? `, ${project}` : ""}
                  </span>
                </span>
              </label>
              {item.reason ? <p className={styles.reviewReason}>{item.reason}</p> : null}
            </li>
          );
        })}
      </ul>
      <div className={styles.reviewActions}>
        <Button
          variant="ai"
          size="sm"
          onClick={() => onAccept(chosen, false)}
          disabled={chosen.length === 0}
          loading={busy === "accept"}
          loadingLabel="Accepting"
          tip={chosen.length === 0 ? "Tick at least one item first." : TIP.acceptSelected}
        >
          Accept selected ({chosen.length})
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onAccept(items.map((i) => i.id), true)} loading={busy === "acceptAll"} loadingLabel="Accepting" tip={TIP.acceptAll}>
          Accept all
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss} loading={busy === "dismiss"} loadingLabel="Dismissing" tip={TIP.dismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}

function PlanProblem({ message, onRetry, onDismiss, canDismiss }: { message: string; onRetry: () => void; onDismiss: () => void; canDismiss: boolean }) {
  return (
    <div className={styles.planProblem} role="alert">
      <p className={styles.planProblemLine}>
        <StatusDot tone="danger" size={9} glow={false} />
        <span>{message}</span>
      </p>
      <div className={styles.reviewActions}>
        <Button variant="ai" size="sm" icon={<SparkIcon />} onClick={onRetry} tip={TIP.tryAgain}>
          Try again
        </Button>
        {canDismiss ? (
          <Button variant="ghost" size="sm" onClick={onDismiss} tip="Clears this message and the failed plan.">
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Calendar status line
// ---------------------------------------------------------------------------------------------

function calendarLine(status: SourceStatus, message?: string): { tone: StatusTone; text: string; hint?: string } | null {
  const why = message?.trim() ? message.trim().replace(/\.?$/, ".") : "";
  switch (status) {
    case "not_connected":
      return { tone: "off", text: "Calendar not connected, so meetings don't show here. Tasks still work.", hint: why || undefined };
    case "never_run":
      return { tone: "idle", text: "Calendar not read yet. Meetings show after the next connector run." };
    case "error":
      return { tone: "warn", text: `Last calendar update failed.${why ? ` ${why}` : ""} Meetings may be out of date.` };
    case "stale":
      return { tone: "warn", text: "Calendar data is out of date, so meetings may be missing." };
    default:
      return null;
  }
}

function ActionError({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className={styles.actionError} role="alert">
      <StatusDot tone="danger" size={9} glow={false} />
      <p>{message}</p>
      <Button variant="ghost" size="sm" icon={<CloseIcon />} onClick={onClose} aria-label="Hide this message" tip="Hides this message; the schedule stays as it is." />
    </div>
  );
}

/** The server's note after Accept, e.g. a moved task whose note no longer exists was skipped. */
function AcceptNote({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className={styles.acceptNote} role="status">
      <StatusDot tone="warn" size={9} glow={false} />
      <p>{message}</p>
      <Button variant="ghost" size="sm" icon={<CloseIcon />} onClick={onClose} aria-label="Hide this note" tip="Hides this note; the schedule stays as it is." />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

export function SchedulePanel() {
  const snap = useSnapshot();
  const now = useNow(30_000);
  const todayKey = dayKey(now);
  const nowMin = minuteOfDay(now);
  const [view, setView] = useStoredChoice<ScheduleView>("life-dashboard:schedule-view", SCHEDULE_VIEWS, "day");
  const [offset, setOffset] = useState(0);
  // `todayKey` keeps the range right across midnight without recomputing it on every tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { from, to } = useMemo(() => viewRange(view, new Date(), offset), [view, offset, todayKey]);
  const sched = useScheduleRange(from, to);
  const range = sched.current ? sched.data : null;

  const [formOpen, setFormOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showAllUnplaced, setShowAllUnplaced] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const planRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);

  // ----- projects for the picker and labels
  const projectList = snap.data?.projects.projects;
  const projects = useMemo(
    () =>
      (projectList ?? [])
        .filter((p) => p.status !== "done")
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projectList],
  );
  const projectName = useCallback((id: string | null) => (id ? (projectList?.find((p) => p.id === id)?.name ?? null) : null), [projectList]);

  // ----- AI plan
  const reduced = useReducedMotion();
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [running, setRunning] = useState<{ what: string; startedAt: number } | null>(null);
  const [planBusy, setPlanBusy] = useState<"accept" | "acceptAll" | "dismiss" | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [tickNow, setTickNow] = useState(Date.now());

  useEffect(() => {
    const ctrl = new AbortController();
    scheduleApi
      .plan(ctrl.signal)
      .then(setPlan)
      .catch(() => {
        // No plan to show: before T27 this is 501, which the range already reports.
      });
    return () => ctrl.abort();
  }, []);

  // A new proposal starts with every item ticked.
  const generatedAt = plan?.generatedAt ?? null;
  useEffect(() => {
    setSelected(new Set(planItems(plan).map((i) => i.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedAt]);

  // One-second clock for the running line only.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const items = planItems(plan);
  const planDay = items.length ? planFrom(plan) : null;
  const toggleSelected = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const planActions: PlanActions = { selected, onToggle: toggleSelected };
  const moving = useMemo(() => movingPaths(items, selected), [items, selected]);

  // Tasks that just landed from Accept: highlighted once, then cleared a second after they show.
  const [landed, setLanded] = useState<ReadonlySet<string>>(NO_PATHS);
  const shownReady = !!range && !sched.loading;
  useEffect(() => {
    if (!landed.size || !shownReady) return;
    const id = setTimeout(() => setLanded(NO_PATHS), FLASH_MS);
    return () => clearTimeout(id);
  }, [landed, shownReady]);

  /** What the server skipped on the last Accept (a moved task's note gone), shown until hidden. */
  const [acceptNote, setAcceptNote] = useState<string | null>(null);

  /** The last plan request, so Try again repeats it even after moving to another day. */
  const lastRequest = useRef<{ scope: ScheduleView; date: string } | null>(null);

  /** Plan the given days: by default the ones the panel shows (today instead of a past day). */
  const runPlan = async (scope: ScheduleView = view, date: string = planRequestDate(from, todayKey)) => {
    if (running) return;
    lastRequest.current = { scope, date };
    const what = planWhat(scope, date, todayKey);
    setPlanError(null);
    setAcceptNote(null);
    setRunning({ what, startedAt: Date.now() });
    setTickNow(Date.now());
    setAnnouncement(`Planning ${what}. This takes about 30 to 60 seconds.`);
    try {
      const next = await scheduleApi.runPlan({ scope, date });
      setPlan(next);
      if (next.status === "ready") {
        setAnnouncement(
          next.items.length
            ? `${planHeading(next, todayKey)} ready: ${plural(next.items.length, "item")} to review.`
            : `Claude found nothing to add for ${what}.${next.message ? ` ${next.message}` : ""}`,
        );
      } else if (next.status === "error") {
        setAnnouncement("Planning failed.");
      }
    } catch (err) {
      setPlanError(`Couldn't plan ${what}. ${errorMessage(err)}`);
      setAnnouncement("Planning failed.");
    } finally {
      setRunning(null);
    }
  };

  /** Day view on `date`, at any distance (a plan may sit past the arrows' 14 days). */
  const showDay = (date: string) => {
    const days = daysBetween(todayKey, date);
    if (Number.isFinite(days)) setOffset(days);
    setView("day");
  };

  const acceptPlan = async (ids: string[], all: boolean) => {
    if (planBusy || ids.length === 0 || !plan) return;
    const before = plan;
    const target = acceptTarget(before, ids);
    const counts = acceptCounts(before.items, ids);
    setPlanBusy(all ? "acceptAll" : "accept");
    setPlanError(null);
    setAcceptNote(null);
    try {
      const { created, message: skipped } = await scheduleApi.acceptPlan(ids);
      sched.edit((r) => created.reduce(withTask, r));
      setPlan((p) => (p ? withoutPlanItems(p, ids) : p));
      // Show the day the tasks landed on, read it fresh, and highlight them once.
      if (target) showDay(target);
      sched.reload();
      setLanded(acceptedPaths(created, before.items, ids));
      const parts = [counts.added ? `Added ${plural(counts.added, "task")}` : "", counts.moved ? `moved ${plural(counts.moved, "task")}` : ""].filter(Boolean);
      const done = parts.length ? parts.join(" and ") : `Added ${plural(created.length, "task")}`;
      const note = skipped?.trim() ? skipped.trim().replace(/\.?$/, ".") : null;
      setAcceptNote(note);
      setAnnouncement(
        `${done[0]!.toUpperCase()}${done.slice(1)} from the plan.${target ? ` Showing ${dayWords(target, todayKey)}.` : ""}${note ? ` ${note}` : ""}`,
      );
      tasksChanged("schedule");
      planRef.current?.focus({ preventScroll: true });
    } catch (err) {
      setPlanError(`Couldn't accept the plan. ${errorMessage(err)}`);
    } finally {
      setPlanBusy(null);
    }
  };

  const dismissPlan = async () => {
    if (planBusy) return;
    setPlanBusy("dismiss");
    setPlanError(null);
    try {
      setPlan(await scheduleApi.dismissPlan());
      setAnnouncement("Plan dismissed.");
      planRef.current?.focus({ preventScroll: true });
    } catch (err) {
      setPlanError(`Couldn't dismiss the plan. ${errorMessage(err)}`);
    } finally {
      setPlanBusy(null);
    }
  };

  // ----- task writes: shown at once, put back when the server refuses
  const unplaced = useMemo(() => notPlaced(range, todayKey), [range, todayKey]);

  /** After a row leaves the Not placed strip, keep focus there: the next row's Today, or Add task. */
  const leaveUnplaced = (path: string) => {
    const at = unplaced.findIndex((u) => u.task.path === path);
    if (at === -1) return;
    const next = unplaced[at + 1] ?? unplaced[at - 1];
    pendingFocus.current = next ? next.task.path : "";
  };
  const unplacedIds = unplaced.map((u) => u.task.path).join("\n");
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = target
      ? bodyRef.current?.querySelector<HTMLElement>(`[data-today-for="${CSS.escape(target)}"]`)
      : addRef.current;
    el?.focus({ preventScroll: true });
  }, [unplacedIds]);

  const toggleDone = async (task: TaskNote, done: boolean) => {
    if (done && unplaced.some((u) => u.task.path === task.path)) leaveUnplaced(task.path);
    setActionError(null);
    sched.edit((r) => patchTask(r, task.path, { done }));
    setAnnouncement(done ? `Done: ${task.title}.` : `Not done: ${task.title}.`);
    try {
      const saved = await scheduleApi.updateTask(task.path, { done });
      sched.edit((r) => withTask(r, saved));
      tasksChanged("schedule");
    } catch (err) {
      sched.edit((r) => patchTask(r, task.path, { done: !done }));
      setActionError(`Couldn't update "${task.title}". ${errorMessage(err)}`);
    }
  };

  const moveToday = async (task: TaskNote) => {
    const before = task.task.due;
    leaveUnplaced(task.path);
    setActionError(null);
    sched.edit((r) => patchTask(r, task.path, { due: todayKey }));
    setAnnouncement(`Moved to today: ${task.title}.`);
    try {
      const saved = await scheduleApi.updateTask(task.path, { due: todayKey });
      sched.edit((r) => withTask(r, saved));
      tasksChanged("schedule");
    } catch (err) {
      sched.edit((r) => patchTask(r, task.path, { due: before }));
      setActionError(`Couldn't move "${task.title}" to today. ${errorMessage(err)}`);
    }
  };

  const taskActions: TaskActions = {
    onToggle: (t, d) => void toggleDone(t, d),
    onToday: (t) => void moveToday(t),
    moving,
    flash: landed,
    flashAnimate: !reduced,
  };

  // ----- add task
  // The form starts on the day shown (never a past one); moving days while it is open keeps what was typed.
  const formDay = view === "day" && from >= todayKey ? from : todayKey;
  const defaultStart = (day: string, minutes: number): string => {
    if (!range || day < todayKey) return "";
    const d = range.days.find((x) => x.date === day);
    const start = firstFit(dayFreeGaps(buildDay(d, day, []), todayKey, nowMin), minutes);
    return start === null ? "" : formatHm(start);
  };

  const closeForm = () => {
    setFormOpen(false);
    addRef.current?.focus({ preventScroll: true });
  };

  const addTask = async (input: { title: string; projectId: string | null; due: string | null; start: string | null; minutes: number | null }) => {
    try {
      const created = await scheduleApi.createTask(input);
      sched.edit((r) => withTask(r, created));
      setAnnouncement(`Added: ${created.title}, ${whenText(created.task.due, created.task.start, null, todayKey)}.`);
      tasksChanged("schedule");
      closeForm();
      return null;
    } catch (err) {
      return `Couldn't add the task. ${errorMessage(err)}`;
    }
  };

  // ----- navigation
  const prev = stepOffset(offset, view, -1);
  const next = stepOffset(offset, view, 1);

  // ----- what to show
  const ready = !!sched.data && !sched.notReady;

  // ----- the other task panel: Do now's writes re-read this range; its empty state can ask for a plan
  // of today or the Add task form (only once this panel can act on it).
  const reloadRange = sched.reload;
  useEffect(
    () =>
      onTasksChanged((source) => {
        if (source !== "schedule") reloadRange();
      }),
    [reloadRange],
  );
  const commandRef = useRef<(command: ScheduleCommand) => void>(() => undefined);
  commandRef.current = (command) => {
    planRef.current?.closest("section")?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    setOffset(0);
    setView("day");
    if (command === "plan-day") {
      planRef.current?.focus({ preventScroll: true });
      void runPlan("day", todayKey);
    } else {
      setFormOpen(true);
    }
  };
  useEffect(() => (ready ? onScheduleCommand((command) => commandRef.current(command)) : undefined), [ready]);
  const isEmptyRange =
    !!range && range.days.every((d) => d.events.length === 0 && d.tasks.length === 0) && planItemsIn(items, from, to).length === 0;
  const dayModel = useMemo(() => (range && view === "day" ? buildDay(range.days.find((d) => d.date === from), from, items) : null), [range, view, from, items]);
  const weekColumns = useMemo(() => (view === "week" ? buildWeek(range, from, todayKey, items) : []), [range, view, from, todayKey, items]);
  const cal = range ? calendarLine(range.calendar.status, range.calendar.message) : null;

  let state: PanelState = "ok";
  let message: string | undefined;
  let hint: string | undefined;
  let onRetry: (() => void) | undefined;
  let body: ReactNode = null;

  if (!sched.data) {
    if (sched.notReady) {
      body = (
        <EmptyState
          tone="off"
          title="Schedule server not ready."
          body="This dashboard's server doesn't serve the schedule yet. Restart it once it is updated, then check again."
          action={
            <Button size="sm" onClick={sched.reload} loading={sched.loading} loadingLabel="Checking" tip={TIP.notReady}>
              Check again
            </Button>
          }
        />
      );
    } else if (sched.error && !sched.loading) {
      state = "error";
      message = "Couldn't load your schedule.";
      hint = sched.error;
      onRetry = sched.reload;
    } else {
      state = "loading";
    }
  } else if (sched.notReady) {
    body = (
      <EmptyState
        tone="off"
        title="Schedule server not ready."
        body="The dashboard server stopped serving the schedule. Restart it, then check again."
        action={
          <Button size="sm" onClick={sched.reload} loading={sched.loading} loadingLabel="Checking" tip={TIP.notReady}>
            Check again
          </Button>
        }
      />
    );
  } else {
    let main: ReactNode;
    if (!range) {
      main =
        sched.error && !sched.loading ? (
          <div className={styles.inlineProblem} role="alert">
            <p className={styles.planProblemLine}>
              <StatusDot tone="danger" size={9} glow={false} />
              <span>Couldn't load {view === "day" ? "this day" : "these days"}. {sched.error}</span>
            </p>
            <Button size="sm" onClick={sched.reload} tip={TIP.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <span className="sr-only">Loading</span>
            <SkeletonRows count={3} />
          </>
        );
    } else if (isEmptyRange) {
      main = (
        <EmptyState title="Nothing scheduled." body={`Add a task or let AI plan your ${view === "week" ? "week" : "day"}.`} />
      );
    } else if (dayModel) {
      const gaps = dayFreeGaps(dayModel, todayKey, nowMin);
      const past = dayModel.date < todayKey;
      main = (
        <>
          <p className={styles.summary}>
            {past ? <span className={styles.pastTag}>Past day</span> : null}
            <span>{plural(dayModel.meetings, "meeting")}</span>
            <span>{plural(dayModel.tasks, "task")}</span>
            {past ? null : <span className={styles.free}>{formatMinutes(totalMinutes(gaps))} free</span>}
          </p>
          <AllDayRow events={dayModel.allDay} />
          {dayModel.blocks.length ? (
            <DayTimeline model={dayModel} todayKey={todayKey} now={now} tasks={taskActions} plan={planActions} />
          ) : (
            <p className={styles.noTimed}>No meetings or timed tasks.</p>
          )}
        </>
      );
    } else {
      main = <WeekGrid columns={weekColumns} tasks={taskActions} plan={planActions} onShowDay={showDay} />;
    }

    const anytime = dayModel && (dayModel.anytime.length || dayModel.anytimePlan.length) ? (
      <section className={styles.side} aria-labelledby="schedule-anytime">
        <h3 id="schedule-anytime" className={styles.kicker}>
          Any time
        </h3>
        <ul className={styles.rows}>
          {dayModel.anytime.map((t) => (
            <TaskRow key={t.path} task={t} tasks={taskActions} todayKey={todayKey} meta={projectName(t.projectId)} />
          ))}
          {dayModel.anytimePlan.map((p) => (
            <PlanRow key={p.id} item={p} plan={planActions} />
          ))}
        </ul>
      </section>
    ) : null;

    const unplacedShown = showAllUnplaced ? unplaced : unplaced.slice(0, UNPLACED_FIRST);
    const unplacedBlock = unplaced.length ? (
      <section className={[styles.side, styles.unplaced].join(" ")} aria-labelledby="schedule-unplaced">
        <h3 id="schedule-unplaced" className={styles.kicker}>
          Not placed <span className={styles.count}>{unplaced.length}</span>
        </h3>
        <ul className={styles.rows}>
          {unplacedShown.map((u) => (
            <TaskRow key={u.task.path} task={u.task} tasks={taskActions} todayKey={todayKey} unplaced={u.reason} meta={projectName(u.task.projectId)} />
          ))}
        </ul>
        {unplaced.length > UNPLACED_FIRST ? (
          <button
            type="button"
            className={styles.more}
            aria-expanded={showAllUnplaced}
            onClick={() => setShowAllUnplaced((v) => !v)}
            data-tip={showAllUnplaced ? "Shows only the first few again." : "Shows every task that still needs a day."}
          >
            {showAllUnplaced ? "Show fewer" : `Show ${unplaced.length - UNPLACED_FIRST} more`}
          </button>
        ) : null}
      </section>
    ) : null;

    const review = running ? (
      <PlanRunning what={running.what} startedAt={running.startedAt} now={tickNow} />
    ) : planError ? (
      <PlanProblem
        message={planError}
        onRetry={() => void (lastRequest.current ? runPlan(lastRequest.current.scope, planRequestDate(lastRequest.current.date, todayKey)) : runPlan())}
        onDismiss={() => setPlanError(null)}
        canDismiss
      />
    ) : plan?.status === "error" ? (
      <PlanProblem
        message={`Claude couldn't make a plan.${plan.message ? ` ${plan.message.trim().replace(/\.?$/, ".")}` : ""}`}
        onRetry={() => void runPlan()}
        onDismiss={() => void dismissPlan()}
        canDismiss
      />
    ) : plan && items.length ? (
      <PlanReview
        plan={plan}
        items={items}
        selected={selected}
        todayKey={todayKey}
        now={now}
        busy={planBusy}
        projectName={projectName}
        jump={planDay && !(view === "day" ? from === planDay : planDay >= from && planDay <= to) ? { label: `Show ${dayWords(planDay, todayKey)}`, onShow: () => showDay(planDay) } : null}
        onToggle={toggleSelected}
        onAccept={(ids, all) => void acceptPlan(ids, all)}
        onDismiss={() => void dismissPlan()}
      />
    ) : null;

    body = (
      <div ref={bodyRef} className={styles.content}>
        {actionError ? <ActionError message={actionError} onClose={() => setActionError(null)} /> : null}
        {acceptNote ? <AcceptNote message={acceptNote} onClose={() => setAcceptNote(null)} /> : null}
        {cal ? (
          <p className={styles.calendarNote}>
            <StatusDot tone={cal.tone} size={9} glow={false} />
            <span>
              {cal.text}
              {cal.hint ? <span className={styles.calendarHint}> {cal.hint}</span> : null}
            </span>
          </p>
        ) : null}
        {formOpen ? (
          <AddTaskForm
            projects={projects}
            defaultDay={formDay}
            defaultStart={defaultStart}
            todayKey={todayKey}
            onAdd={addTask}
            onClose={closeForm}
          />
        ) : null}
        <div className={styles.layout} data-has-side={review || anytime || unplacedBlock ? "" : undefined}>
          {review ? <div className={styles.reviewArea}>{review}</div> : null}
          <div className={styles.main} aria-busy={sched.loading || undefined}>
            {main}
          </div>
          {anytime || unplacedBlock ? (
            <div className={styles.aside}>
              {anytime}
              {unplacedBlock}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const label = rangeLabel(view, from, to, todayKey);
  const planLabel = view === "day" ? "Plan my day" : "Plan my week";
  const action = ready ? (
    <div className={styles.controls}>
      <div className={styles.nav} role="group" aria-label={view === "day" ? "Change day" : "Change week"}>
        <Button
          variant="ghost"
          size="sm"
          icon={<ChevronIcon dir="left" />}
          onClick={() => prev !== null && setOffset(prev)}
          disabled={prev === null}
          aria-label={view === "day" ? "Previous day" : "Previous 7 days"}
          tip={prev === null ? TIP.limit : TIP.prev[view]}
        />
        {offset !== 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setOffset(0)} tip={TIP.today}>
            Today
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          icon={<ChevronIcon dir="right" />}
          onClick={() => next !== null && setOffset(next)}
          disabled={next === null}
          aria-label={view === "day" ? "Next day" : "Next 7 days"}
          tip={next === null ? TIP.limit : TIP.next[view]}
        />
      </div>
      <Segmented label="View" options={VIEW_OPTIONS} value={view} onChange={setView} />
      <Button
        ref={addRef}
        size="sm"
        icon={<PlusIcon />}
        onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
        aria-expanded={formOpen}
        tip={formOpen ? TIP.addOpen : TIP.add}
      >
        Add task
      </Button>
      <Button
        ref={planRef}
        variant="ai"
        size="sm"
        icon={<SparkIcon />}
        onClick={() => void runPlan()}
        loading={!!running}
        loadingLabel="Planning"
        tip={running ? TIP.planning : planTip(view, from, todayKey)}
      >
        {planLabel}
      </Button>
    </div>
  ) : undefined;

  const menu: MenuSection["items"] = ready
    ? [
        { label: "Add task", onSelect: () => setFormOpen(true), disabled: formOpen ? "The form is already open." : false, tip: TIP.add },
        { label: running ? "Planning" : planLabel, onSelect: () => void runPlan(), disabled: running ? TIP.planning : false, tip: planTip(view, from, todayKey) },
        { label: view === "day" ? "Show week" : "Show day", onSelect: () => setView(view === "day" ? "week" : "day"), tip: VIEW_OPTIONS.find((o) => o.value !== view)?.tip },
        offset !== 0 ? { label: "Go to today", onSelect: () => setOffset(0), tip: TIP.today } : null,
      ]
    : sched.notReady
      ? [{ label: "Check again", onSelect: sched.reload, tip: TIP.notReady }]
      : [];

  return (
    <>
      <Panel
        title={TITLE}
        fit
        state={state}
        message={message}
        hint={hint}
        onRetry={onRetry}
        retrying={sched.loading}
        retryTip="Asks the local server for your schedule again."
        skeleton="rows"
        meta={ready ? <span className={styles.meta}>{label}</span> : undefined}
        action={action}
        menu={menu}
      >
        {body}
      </Panel>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
