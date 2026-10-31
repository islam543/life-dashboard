import type { CalendarEvent, PlanItem, ScheduleDay, ScheduleRange, SchedulePlan, TaskInfo, TaskNote } from "../../../shared/types";
import { dayKey, formatMinutes } from "./format";
import { DAY_SHORT, addDays, parseDayKey, shortDay } from "./timeAgg";

// Pure helpers behind the Home Schedule panel (panels/SchedulePanel.tsx): which days a view shows,
// where each meeting, task and AI plan item sits on the day timeline (minutes to pixels, overlap
// lanes), the free gaps between them, the seven week columns, the "not placed" strip, and the local
// edits that make a new or ticked task show at once before the server answers.
// Times are minutes since local midnight (0 to 1440). Days are "YYYY-MM-DD" in local time.

export type ScheduleView = "day" | "week";
export const SCHEDULE_VIEWS: readonly ScheduleView[] = ["day", "week"];

/** The arrows move at most this many days away from today, either way. */
export const MAX_OFFSET_DAYS = 14;
/** The working window the timeline always shows: 08:00 to 18:00. */
export const DAY_START = 8 * 60;
export const DAY_END = 18 * 60;
/** Lengths offered when adding a task, in minutes. */
export const TASK_LENGTHS = [15, 30, 45, 60, 90, 120] as const;
export const DEFAULT_TASK_MINUTES = 30;
/** A timed task or plan item with no length is drawn this long. */
export const DEFAULT_BLOCK_MINUTES = 30;

const DAY_MINUTES = 24 * 60;

// ---------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------

/** "HH:MM" (00:00 to 23:59) to minutes since midnight. Null for anything else. */
export function parseHm(value: string | null | undefined): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Minutes since midnight to "HH:MM", clamped to 00:00 and 24:00. */
export function formatHm(minutes: number): string {
  const t = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** "09:30 to 10:15". */
export function timeSpan(start: number, end: number): string {
  return `${formatHm(start)} to ${formatHm(end)}`;
}

/** Minutes since midnight of a local Date. */
export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Rounds up to the next multiple of `step` (10:07 with 15 is 10:15). */
export function roundUp(minutes: number, step: number): number {
  return Math.ceil(minutes / step) * step;
}

/** Position on the timeline: pixels below the top edge, which is `startMin`. */
export function minutesToPx(minutes: number, startMin: number, pxPerHour: number): number {
  return ((minutes - startMin) / 60) * pxPerHour;
}

// ---------------------------------------------------------------------------------------------
// Days and ranges
// ---------------------------------------------------------------------------------------------

/** Days moved by one arrow press. */
export function stepDays(view: ScheduleView): number {
  return view === "week" ? 7 : 1;
}

/**
 * The next offset (days from today) after one arrow press, or null when it would pass the limit.
 * Past the limit (after accepting a plan for a far day) the arrows still step back towards today.
 */
export function stepOffset(offset: number, view: ScheduleView, dir: 1 | -1): number | null {
  const next = offset + dir * stepDays(view);
  return Math.abs(next) > MAX_OFFSET_DAYS && Math.abs(next) >= Math.abs(offset) ? null : next;
}

/** The days a view shows: one day, or seven from the start day. `from`/`to` go to GET /api/schedule. */
export function viewRange(view: ScheduleView, today: Date, offset: number): { from: string; to: string; days: string[] } {
  const start = addDays(today, offset);
  const count = view === "week" ? 7 : 1;
  const days = Array.from({ length: count }, (_, i) => dayKey(addDays(start, i)));
  return { from: days[0]!, to: days[days.length - 1]!, days };
}

/** Whole days from `fromKey` to `toKey` (negative when `toKey` is earlier). NaN for a bad key. */
export function daysBetween(fromKey: string, toKey: string): number {
  const a = parseDayKey(fromKey);
  const b = parseDayKey(toKey);
  if (!a || !b) return Number.NaN;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** "Sat 31 Oct". */
export function shortDate(key: string): string {
  const d = parseDayKey(key);
  return d ? `${DAY_SHORT[d.getDay()]} ${shortDay(d)}` : key;
}

/** "Today", "Tomorrow", "Yesterday", else "Mon 2 Nov". */
export function dayLabel(key: string, todayKey: string): string {
  const diff = daysBetween(todayKey, key);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return shortDate(key);
}

/** Header line for the view: "Today, Sat 31 Oct", or "31 Oct to 6 Nov" for a week. */
export function rangeLabel(view: ScheduleView, from: string, to: string, todayKey: string): string {
  if (view === "day") {
    const named = dayLabel(from, todayKey);
    return named === shortDate(from) ? named : `${named}, ${shortDate(from)}`;
  }
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  return a && b ? `${shortDay(a)} to ${shortDay(b)}` : `${from} to ${to}`;
}

/** Where a task or plan item sits in words: "Today, 10:00, 45m", "Mon 2 Nov, any time". */
export function whenText(date: string | null, start: string | null, minutes: number | null, todayKey: string): string {
  const parts = [date ? dayLabel(date, todayKey) : "No day yet", start ?? (date ? "any time" : "")];
  if (minutes) parts.push(formatMinutes(minutes));
  return parts.filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------------------------

export type EventPlacement = { allDay: true } | { allDay: false; start: number; end: number };

/**
 * Where an event sits on `day`. Calendar values are a date ("2026-11-02", all day) or a full ISO time.
 * A timed event that started earlier starts at 00:00; one running past midnight ends at 24:00; a
 * missing or broken end gets the default length. Null when the start is unreadable.
 */
export function eventOnDay(event: Pick<CalendarEvent, "start" | "end">, day: string): EventPlacement | null {
  if (parseDayKey(event.start)) return { allDay: true };
  const s = new Date(event.start);
  if (Number.isNaN(s.getTime())) return null;
  const startKey = dayKey(s);
  const e = new Date(event.end);
  if (startKey > day) return null;
  if (startKey < day) {
    // Started on an earlier day: shown from 00:00 only while it is still running on this day.
    if (Number.isNaN(e.getTime()) || dayKey(e) < day || (dayKey(e) === day && minuteOfDay(e) === 0)) return null;
  }
  const start = startKey === day ? minuteOfDay(s) : 0;
  let end: number;
  if (Number.isNaN(e.getTime()) || e.getTime() <= s.getTime()) end = start + DEFAULT_BLOCK_MINUTES;
  else {
    const endKey = dayKey(e);
    end = endKey === day ? minuteOfDay(e) : endKey > day ? DAY_MINUTES : start + DEFAULT_BLOCK_MINUTES;
  }
  return { allDay: false, start, end: Math.min(DAY_MINUTES, Math.max(end, start + 1)) };
}

/** Only https links from the server become links (ticket T29, security). */
export function httpsUrl(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Day timeline
// ---------------------------------------------------------------------------------------------

export type BlockKind = "event" | "task" | "plan";

export type Block =
  | { kind: "event"; id: string; start: number; end: number; title: string; event: CalendarEvent }
  | { kind: "task"; id: string; start: number; end: number; title: string; task: TaskNote }
  | { kind: "plan"; id: string; start: number; end: number; title: string; plan: PlanItem };

export type Laned<T> = T & { lane: number; lanes: number };

/**
 * Side-by-side lanes for overlapping items, like a calendar app. Items that overlap (directly or
 * through a chain) form a cluster; each takes the first free lane in its cluster and every item in
 * the cluster splits the width by the cluster's lane count. `minMinutes` is the shortest an item is
 * drawn, so two short items that would touch on screen also go side by side.
 */
export function layoutLanes<T extends { id: string; start: number; end: number }>(
  items: readonly T[],
  minMinutes = 0,
): Laned<T>[] {
  const visualEnd = (t: T) => Math.max(t.end, t.start + minMinutes, t.start + 1);
  const sorted = [...items].sort((a, b) => a.start - b.start || visualEnd(b) - visualEnd(a) || a.id.localeCompare(b.id));
  const out: Laned<T>[] = [];
  let cluster: Laned<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    for (const item of cluster) item.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (item.start >= clusterEnd) close();
    const end = visualEnd(item);
    let lane = laneEnds.findIndex((e) => e <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    cluster.push({ ...item, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  close();
  return out;
}

/**
 * The hours the timeline shows: 08:00 to 18:00, stretched to the whole hour around the earliest
 * and latest item.
 */
export function dayBounds(items: readonly { start: number; end: number }[]): { start: number; end: number } {
  let start = DAY_START;
  let end = DAY_END;
  for (const it of items) {
    start = Math.min(start, Math.floor(it.start / 60) * 60);
    end = Math.max(end, Math.ceil(it.end / 60) * 60);
  }
  return { start: Math.max(0, start), end: Math.min(DAY_MINUTES, end) };
}

/** Free stretches of at least `minGap` minutes between `from` and `to`, around the busy items. */
export function freeGaps(
  busy: readonly { start: number; end: number }[],
  from: number,
  to: number,
  minGap = 15,
): { start: number; end: number }[] {
  if (to - from < minGap) return [];
  const clipped = busy
    .map((b) => ({ start: Math.max(from, b.start), end: Math.min(to, b.end) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const gaps: { start: number; end: number }[] = [];
  let cursor = from;
  for (const b of clipped) {
    if (b.start - cursor >= minGap) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= minGap) gaps.push({ start: cursor, end: to });
  return gaps;
}

export function totalMinutes(spans: readonly { start: number; end: number }[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** Start of the first gap that fits `minutes`, or null when none does. */
export function firstFit(gaps: readonly { start: number; end: number }[], minutes: number): number | null {
  return gaps.find((g) => g.end - g.start >= minutes)?.start ?? null;
}

/** A task's or plan item's span on its day, or null without a valid start time. */
export function itemSpan(start: string | null, minutes: number | null): { start: number; end: number } | null {
  const s = parseHm(start);
  if (s === null) return null;
  const length = minutes && minutes > 0 ? minutes : DEFAULT_BLOCK_MINUTES;
  return { start: s, end: Math.min(DAY_MINUTES, s + length) };
}

export interface DayModel {
  date: string;
  allDay: CalendarEvent[];
  /** Timed meetings, timed tasks and timed plan items, for the timeline. */
  blocks: Block[];
  /** Tasks with no start time, listed under the timeline. */
  anytime: TaskNote[];
  /** Plan items with no start time. */
  anytimePlan: PlanItem[];
  meetings: number;
  tasks: number;
}

/** Everything one day shows. `plan` is every proposed item; only this day's are kept. */
export function buildDay(day: ScheduleDay | undefined, date: string, plan: readonly PlanItem[]): DayModel {
  const allDay: CalendarEvent[] = [];
  const blocks: Block[] = [];
  const anytime: TaskNote[] = [];
  const anytimePlan: PlanItem[] = [];
  for (const event of day?.events ?? []) {
    const at = eventOnDay(event, date);
    if (!at) continue;
    if (at.allDay) allDay.push(event);
    else blocks.push({ kind: "event", id: `event:${event.id}`, start: at.start, end: at.end, title: event.title, event });
  }
  for (const task of day?.tasks ?? []) {
    const span = itemSpan(task.task.start, task.task.minutes);
    if (span) blocks.push({ kind: "task", id: `task:${task.path}`, ...span, title: task.title, task });
    else anytime.push(task);
  }
  for (const item of plan) {
    if (item.date !== date) continue;
    const span = itemSpan(item.start, item.minutes);
    if (span) blocks.push({ kind: "plan", id: `plan:${item.id}`, ...span, title: planTitle(item), plan: item });
    else anytimePlan.push(item);
  }
  blocks.sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
  return {
    date,
    allDay,
    blocks,
    anytime,
    anytimePlan,
    meetings: allDay.length + blocks.filter((b) => b.kind === "event").length,
    tasks: day?.tasks.length ?? 0,
  };
}

/**
 * Free time left in the working window: from 08:00 (or now, rounded up to 15 minutes, on today) to
 * 18:00, around meetings and open timed tasks. Empty for a past day.
 */
export function dayFreeGaps(model: DayModel, todayKey: string, nowMinutes: number): { start: number; end: number }[] {
  if (model.date < todayKey) return [];
  const from = model.date === todayKey ? Math.max(DAY_START, roundUp(nowMinutes, 15)) : DAY_START;
  const busy = model.blocks.filter((b) => b.kind === "event" || (b.kind === "task" && !b.task.task.done));
  return freeGaps(busy, from, DAY_END);
}

// ---------------------------------------------------------------------------------------------
// Week columns
// ---------------------------------------------------------------------------------------------

export type WeekRow =
  | { kind: "event"; id: string; start: number | null; end: number | null; title: string; event: CalendarEvent }
  | { kind: "task"; id: string; start: number | null; end: number | null; title: string; task: TaskNote }
  | { kind: "plan"; id: string; start: number | null; end: number | null; title: string; plan: PlanItem };

export interface WeekColumn {
  date: string;
  /** "Sun" */
  weekday: string;
  /** Day of the month. */
  dayNum: number;
  isToday: boolean;
  isPast: boolean;
  rows: WeekRow[];
}

const KIND_ORDER: Record<BlockKind, number> = { event: 0, task: 1, plan: 2 };

/** Seven columns from `startKey`: all-day meetings first, then by time, untimed tasks and items last. */
export function buildWeek(
  range: Pick<ScheduleRange, "days"> | null,
  startKey: string,
  todayKey: string,
  plan: readonly PlanItem[],
): WeekColumn[] {
  const start = parseDayKey(startKey);
  if (!start) return [];
  const byDate = new Map((range?.days ?? []).map((d) => [d.date, d] as const));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    const key = dayKey(date);
    const day = byDate.get(key);
    const rows: WeekRow[] = [];
    for (const event of day?.events ?? []) {
      const at = eventOnDay(event, key);
      if (!at) continue;
      rows.push({
        kind: "event",
        id: `event:${event.id}`,
        start: at.allDay ? null : at.start,
        end: at.allDay ? null : at.end,
        title: event.title,
        event,
      });
    }
    for (const task of day?.tasks ?? []) {
      const span = itemSpan(task.task.start, task.task.minutes);
      rows.push({ kind: "task", id: `task:${task.path}`, start: span?.start ?? null, end: span?.end ?? null, title: task.title, task });
    }
    for (const item of plan) {
      if (item.date !== key) continue;
      const span = itemSpan(item.start, item.minutes);
      rows.push({ kind: "plan", id: `plan:${item.id}`, start: span?.start ?? null, end: span?.end ?? null, title: planTitle(item), plan: item });
    }
    // All-day meetings first, then by time, then tasks and plan items with no time.
    const rank = (r: WeekRow) => (r.start !== null ? 1 : r.kind === "event" ? 0 : 2);
    rows.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.start ?? 0) - (b.start ?? 0) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.title.localeCompare(b.title),
    );
    return {
      date: key,
      weekday: DAY_SHORT[date.getDay()]!,
      dayNum: date.getDate(),
      isToday: key === todayKey,
      isPast: key < todayKey,
      rows,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Not placed: overdue and unscheduled open tasks
// ---------------------------------------------------------------------------------------------

export interface UnplacedTask {
  task: TaskNote;
  reason: "overdue" | "unscheduled";
}

/**
 * Open tasks that need a day: overdue first (oldest due date first), then those with no day.
 * Overdue means due before today, whatever day the panel shows: the server's `overdue` is relative
 * to the range start, so on a future day it would also hold today's tasks.
 */
export function notPlaced(range: Pick<ScheduleRange, "days" | "overdue" | "unscheduled"> | null, todayKey: string): UnplacedTask[] {
  if (!range) return [];
  const seen = new Set<string>();
  const overdue: TaskNote[] = [];
  const pastDays = range.days.flatMap((d) => d.tasks);
  for (const t of [...range.overdue, ...pastDays]) {
    if (t.task.done || !t.task.due || t.task.due >= todayKey || seen.has(t.path)) continue;
    seen.add(t.path);
    overdue.push(t);
  }
  overdue.sort((a, b) => (a.task.due! < b.task.due! ? -1 : a.task.due! > b.task.due! ? 1 : a.title.localeCompare(b.title)));
  const unscheduled = range.unscheduled
    .filter((t) => !t.task.done && !t.task.due && !seen.has(t.path))
    .sort((a, b) => a.title.localeCompare(b.title));
  return [
    ...overdue.map((task) => ({ task, reason: "overdue" as const })),
    ...unscheduled.map((task) => ({ task, reason: "unscheduled" as const })),
  ];
}

// ---------------------------------------------------------------------------------------------
// Local edits: a new or changed task shows at once, before the range is re-read
// ---------------------------------------------------------------------------------------------

function byStartThenTitle(a: TaskNote, b: TaskNote): number {
  const sa = parseHm(a.task.start);
  const sb = parseHm(b.task.start);
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sa - sb;
  }
  return a.title.localeCompare(b.title);
}

/** Every task in the range, once, wherever it sits. */
export function findTask(range: ScheduleRange | null, path: string): TaskNote | null {
  if (!range) return null;
  for (const d of range.days) {
    const hit = d.tasks.find((t) => t.path === path);
    if (hit) return hit;
  }
  return range.overdue.find((t) => t.path === path) ?? range.unscheduled.find((t) => t.path === path) ?? null;
}

/**
 * The range with `task` in the right place: its day when inside the range, `unscheduled` when it has
 * no day (and is open), `overdue` when due before the range (and open). Any older copy is removed.
 */
export function withTask(range: ScheduleRange, task: TaskNote): ScheduleRange {
  const drop = (list: TaskNote[]) => list.filter((t) => t.path !== task.path);
  const due = task.task.due;
  const open = !task.task.done;
  return {
    ...range,
    days: range.days.map((d) =>
      d.date === due ? { ...d, tasks: [...drop(d.tasks), task].sort(byStartThenTitle) } : { ...d, tasks: drop(d.tasks) },
    ),
    unscheduled: !due && open ? [...drop(range.unscheduled), task] : drop(range.unscheduled),
    overdue: due && due < range.from && open ? [...drop(range.overdue), task] : drop(range.overdue),
  };
}

/** The range with one task's fields changed (an optimistic tick or a new day). Unchanged when the task is not in it. */
export function patchTask(range: ScheduleRange, path: string, patch: Partial<TaskInfo>): ScheduleRange {
  const task = findTask(range, path);
  return task ? withTask(range, { ...task, task: { ...task.task, ...patch } }) : range;
}

// ---------------------------------------------------------------------------------------------
// AI plan
// ---------------------------------------------------------------------------------------------

/** The proposal's items when there is one to review, else []. */
export function planItems(plan: SchedulePlan | null): PlanItem[] {
  return plan && plan.status === "ready" ? plan.items : [];
}

/** The plan without the given item ids (accepted ones leave the proposal). */
export function withoutPlanItems(plan: SchedulePlan, ids: readonly string[]): SchedulePlan {
  const gone = new Set(ids);
  return { ...plan, items: plan.items.filter((i) => !gone.has(i.id)) };
}

/** A proposal's title as shown: "Move: <title>" when it moves an existing task, else the title. */
export function planTitle(item: Pick<PlanItem, "title" | "taskPath">): string {
  return item.taskPath ? `Move: ${item.title}` : item.title;
}

/** The proposals on days from `from` to `to` (inclusive): the ghost blocks a view can show. */
export function planItemsIn(items: readonly PlanItem[], from: string, to: string): PlanItem[] {
  return items.filter((i) => i.date >= from && i.date <= to);
}

/** Paths of existing tasks that included proposals would move: their current slot is drawn faded. */
export function movingPaths(items: readonly PlanItem[], selected: ReadonlySet<string>): Set<string> {
  const paths = new Set<string>();
  for (const i of items) if (i.taskPath && selected.has(i.id)) paths.add(i.taskPath);
  return paths;
}

/**
 * The day a plan request names (POST /api/schedule/plan `date`): the first day the panel shows, or
 * today when that day is already past (Claude never plans the past).
 */
export function planRequestDate(shownFrom: string, todayKey: string): string {
  return shownFrom < todayKey ? todayKey : shownFrom;
}

/** The plan's first day: `from`, else the earliest item date (a plan saved before v1.3), else null. */
export function planFrom(plan: Pick<SchedulePlan, "from" | "items"> | null): string | null {
  if (!plan) return null;
  if (plan.from && parseDayKey(plan.from)) return plan.from;
  const dates = plan.items.map((i) => i.date).filter((d) => !!parseDayKey(d)).sort();
  return dates[0] ?? null;
}

/**
 * Plan review heading, from the plan's own first day so it never claims "today" for another day:
 * "AI plan for today, Sat 31 Oct", "AI plan for tomorrow, Sun 1 Nov", "AI plan for Mon 2 Nov",
 * "AI plan for the week from Mon 2 Nov". Just "AI plan" when the day is unknown.
 */
export function planHeading(plan: Pick<SchedulePlan, "scope" | "from" | "items">, todayKey: string): string {
  const from = planFrom(plan);
  if (!from) return "AI plan";
  const diff = daysBetween(todayKey, from);
  const named = diff === 0 ? `today, ${shortDate(from)}` : diff === 1 ? `tomorrow, ${shortDate(from)}` : shortDate(from);
  return plan.scope === "week" ? `AI plan for the week from ${named}` : `AI plan for ${named}`;
}

/**
 * The day the panel shows after Accept: the plan's first day when an accepted item is on it, else the
 * earliest day among the accepted items. Null when none of the ids is in the plan.
 */
export function acceptTarget(plan: Pick<SchedulePlan, "from" | "items">, ids: readonly string[]): string | null {
  const chosen = new Set(ids);
  const dates = plan.items
    .filter((i) => chosen.has(i.id) && !!parseDayKey(i.date))
    .map((i) => i.date)
    .sort();
  if (!dates.length) return null;
  const from = planFrom(plan);
  return from && dates.includes(from) ? from : dates[0]!;
}

/** How many accepted items create a new task and how many move an existing one. */
export function acceptCounts(items: readonly PlanItem[], ids: readonly string[]): { added: number; moved: number } {
  const chosen = new Set(ids);
  let added = 0;
  let moved = 0;
  for (const i of items) {
    if (!chosen.has(i.id)) continue;
    if (i.taskPath) moved += 1;
    else added += 1;
  }
  return { added, moved };
}

/** Task paths to highlight once after Accept: every task the server answered, plus the moved ones. */
export function acceptedPaths(created: readonly Pick<TaskNote, "path">[], items: readonly PlanItem[], ids: readonly string[]): Set<string> {
  const chosen = new Set(ids);
  const paths = new Set(created.map((t) => t.path));
  for (const i of items) if (i.taskPath && chosen.has(i.id)) paths.add(i.taskPath);
  return paths;
}
