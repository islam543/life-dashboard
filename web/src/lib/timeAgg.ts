import type { CalendarEvent, JiraIssue, ProjectArea, ProjectsState, SessionTime } from "../../../shared/types";
import { dayKey } from "./format";

// Pure time bucketing for the week timeline, project-time bars and the year heatmap.
// No React, no DOM: unit tested in timeAgg.test.ts. Every day is a LOCAL calendar day keyed
// "YYYY-MM-DD" (the same key the collectors write), and every function that depends on "now"
// takes it as a parameter. Date math goes through new Date(y, m, d + n), never "+ 86_400_000",
// so daylight-saving days and leap years come out right.

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "2026-11-02" -> local midnight of that day. Null for anything malformed or impossible ("2026-02-30").
 * Never `new Date("2026-11-02")`: that is UTC midnight and lands on the previous day west of UTC.
 */
export function parseDayKey(key: string): Date | null {
  const m = DATE_ONLY.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const date = new Date(y, mo, d);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date : null;
}

/** Local midnight of the same day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Local midnight `n` calendar days later (negative goes back). */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** Sunday, local midnight, of the week that contains `date`. Weeks run Sunday to Saturday. */
export function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -date.getDay());
}

/** The 7 day keys of this week, Sunday first. */
export function weekDayKeys(now: Date): string[] {
  const sunday = startOfWeek(now);
  return Array.from({ length: 7 }, (_, i) => dayKey(addDays(sunday, i)));
}

/** Every day key of the calendar month that contains `now`, the 1st first. */
export function monthDayKeys(now: Date): string[] {
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Array.from({ length: days }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), i + 1)));
}

/** The last `days` day keys ending today, oldest first (today is the last one). */
export function lastDayKeys(now: Date, days = 30): string[] {
  const today = startOfDay(now);
  return Array.from({ length: days }, (_, i) => dayKey(addDays(today, i - days + 1)));
}

/** "12 Oct" */
export function shortDay(date: Date): string {
  return `${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
}

/** "Tue 14 Oct 2026" */
export function longDay(date: Date): string {
  return `${DAY_SHORT[date.getDay()]} ${shortDay(date)} ${date.getFullYear()}`;
}

/** "25 to 31 Oct" or "29 Nov to 5 Dec" for the week that contains `now`. */
export function weekRangeLabel(now: Date): string {
  const first = startOfWeek(now);
  const last = addDays(first, 6);
  return first.getMonth() === last.getMonth()
    ? `${first.getDate()} to ${shortDay(last)}`
    : `${shortDay(first)} to ${shortDay(last)}`;
}

// ---------------------------------------------------------------------------------------------
// Project-time bars
// ---------------------------------------------------------------------------------------------

export type TimeRange = "week" | "month" | "last30";

/**
 * This week (Sunday to Saturday), this calendar month, or the rolling last 30 days ending today.
 * Future days add nothing, so they can stay in.
 */
export function rangeDayKeys(range: TimeRange, now: Date): string[] {
  if (range === "last30") return lastDayKeys(now, 30);
  return range === "week" ? weekDayKeys(now) : monthDayKeys(now);
}

/** Days of the range that have started, for "active N of M days": today counts. */
export function daysSoFar(range: TimeRange, now: Date): number {
  if (range === "last30") return 30;
  return range === "week" ? now.getDay() + 1 : now.getDate();
}

/** How the range reads inside a sentence: "this week", "this month", "the last 30 days". */
export function rangePhrase(range: TimeRange): string {
  if (range === "last30") return "the last 30 days";
  return range === "week" ? "this week" : "this month";
}

export interface ProjectTotal {
  project: string;
  minutes: number;
  /** Days in the range with more than zero minutes. */
  activeDays: number;
  /** Registry project id; absent for a detected (untracked) name or before the registry exists. */
  id?: string;
  /** Registry area; absent like `id`. */
  area?: ProjectArea;
}

function clean(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Minutes per project in the range, largest first (ties by name). Projects with no time are left out. */
export function projectTotals(sessions: readonly SessionTime[], range: TimeRange, now: Date): ProjectTotal[] {
  const keys = rangeDayKeys(range, now);
  const byProject = new Map<string, ProjectTotal>();
  for (const s of sessions) {
    let minutes = 0;
    let activeDays = 0;
    for (const k of keys) {
      const m = clean(s.minutesByDay[k]);
      if (m > 0) {
        minutes += m;
        activeDays += 1;
      }
    }
    if (minutes <= 0) continue;
    // Two entries with the same display name (should not happen) are merged, not shown twice.
    const prev = byProject.get(s.project);
    if (prev) {
      prev.minutes += minutes;
      prev.activeDays = Math.max(prev.activeDays, activeDays);
    } else {
      byProject.set(s.project, { project: s.project, minutes, activeDays });
    }
  }
  return [...byProject.values()].sort((a, b) => b.minutes - a.minutes || a.project.localeCompare(b.project));
}

export interface BarRow {
  /** Stable React key: the project id (or name before the registry exists), or "__other__". */
  key: string;
  label: string;
  minutes: number;
  /** Null for the "Other" row. */
  activeDays: number | null;
  isOther: boolean;
  /** Project names folded into "Other", largest first. Empty for a normal row. */
  members: string[];
  /** Registry project id of a tracked row (links to #/projects/<id>); absent for Other and before the registry. */
  projectId?: string;
  area?: ProjectArea;
  /** In "Other": how many of `members` are untracked detected names (the rest are smaller tracked projects). */
  untracked?: number;
}

export const OTHER_KEY = "__other__";

/**
 * The top `n` projects plus one "Other" row for the rest. Never more than n + 1 rows: when only one
 * project is left over it is shown by name, because "Other (1 project)" hides it for no reason.
 */
export function topWithOther(totals: readonly ProjectTotal[], n = 8): BarRow[] {
  const sorted = [...totals].sort((a, b) => b.minutes - a.minutes || a.project.localeCompare(b.project));
  const row = (t: ProjectTotal): BarRow => ({
    key: t.project,
    label: t.project,
    minutes: t.minutes,
    activeDays: t.activeDays,
    isOther: false,
    members: [],
  });
  if (sorted.length <= n + 1) return sorted.map(row);
  const rest = sorted.slice(n);
  return [
    ...sorted.slice(0, n).map(row),
    {
      key: OTHER_KEY,
      label: "Other",
      minutes: rest.reduce((sum, t) => sum + t.minutes, 0),
      activeDays: null,
      isOther: true,
      members: rest.map((t) => t.project),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Project-time bars from the registry (docs/ARCHITECTURE.md "Web additions")
// ---------------------------------------------------------------------------------------------

/**
 * True once the server has computed the project registry: it lists a project, a hidden name or an
 * untracked name. Before that (first start, or the registry failed to load) the charts fall back to
 * grouping by detected name, so they never collapse into one "Other" bar while the registry is missing.
 */
export function registryReady(state: ProjectsState | null | undefined): state is ProjectsState {
  return (
    !!state &&
    Array.isArray(state.projects) &&
    Array.isArray(state.untracked) &&
    Array.isArray(state.hidden) &&
    Array.isArray(state.stats) &&
    (state.projects.length > 0 || state.untracked.length > 0 || state.hidden.length > 0)
  );
}

/** Untracked session names: detected, active in the last 90 days, in no project and not hidden. */
export function untrackedSessionNames(state: ProjectsState): Set<string> {
  return new Set(state.untracked.filter((d) => d.kind === "session").map((d) => d.name));
}

/**
 * Minutes in the range per tracked project (name and area from the registry, minutes from its
 * stats, which sum every session folded into it) and per untracked session name. Hidden names are
 * in neither list. Both lists drop zero rows and sort largest first, ties by name.
 */
export function registryTotals(
  state: ProjectsState,
  sessions: readonly SessionTime[],
  range: TimeRange,
  now: Date,
): { tracked: ProjectTotal[]; untracked: ProjectTotal[] } {
  const keys = rangeDayKeys(range, now);
  const statsById = new Map(state.stats.map((s) => [s.id, s]));
  const tracked: ProjectTotal[] = [];
  for (const p of state.projects) {
    const byDay = statsById.get(p.id)?.minutesByDay ?? {};
    let minutes = 0;
    let activeDays = 0;
    for (const k of keys) {
      const m = clean(byDay[k]);
      if (m > 0) {
        minutes += m;
        activeDays += 1;
      }
    }
    if (minutes > 0) tracked.push({ project: p.name, minutes, activeDays, id: p.id, area: p.area });
  }
  const names = untrackedSessionNames(state);
  const untracked = projectTotals(
    sessions.filter((s) => names.has(s.project)),
    range,
    now,
  );
  const order = (a: ProjectTotal, b: ProjectTotal) => b.minutes - a.minutes || a.project.localeCompare(b.project);
  return { tracked: tracked.sort(order), untracked: untracked.sort(order) };
}

/**
 * Bars for the registry: the top `n` tracked projects by name, then one "Other" row holding every
 * untracked name plus any smaller tracked projects. Untracked names never get a bar of their own,
 * so a bar always means a project Islam chose to track. A single leftover tracked project with no
 * untracked time is shown by name, as in topWithOther.
 */
export function registryRows(tracked: readonly ProjectTotal[], untracked: readonly ProjectTotal[], n = 8): BarRow[] {
  const sorted = [...tracked].sort((a, b) => b.minutes - a.minutes || a.project.localeCompare(b.project));
  const row = (t: ProjectTotal): BarRow => ({
    key: t.id ?? t.project,
    label: t.project,
    minutes: t.minutes,
    activeDays: t.activeDays,
    isOther: false,
    members: [],
    projectId: t.id,
    area: t.area,
  });
  const keepAll = untracked.length === 0 && sorted.length <= n + 1;
  const head = keepAll ? sorted : sorted.slice(0, n);
  const overflow = keepAll ? [] : sorted.slice(n);
  const folded = [...overflow, ...untracked].sort((a, b) => b.minutes - a.minutes || a.project.localeCompare(b.project));
  const rows = head.map(row);
  if (folded.length === 0) return rows;
  return [
    ...rows,
    {
      key: OTHER_KEY,
      label: "Other",
      minutes: folded.reduce((sum, t) => sum + t.minutes, 0),
      activeDays: null,
      isOther: true,
      members: folded.map((t) => t.project),
      untracked: untracked.length,
    },
  ];
}

/** Sum several day series into one, e.g. all projects' minutes or all repos' commits. Bad values count as 0. */
export function sumByDay(series: ReadonlyArray<Record<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of series) {
    for (const [k, v] of Object.entries(s)) {
      if (!parseDayKey(k)) continue;
      out.set(k, (out.get(k) ?? 0) + clean(v));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Year heatmap
// ---------------------------------------------------------------------------------------------

/**
 * How days without an entry are read:
 *   "none"       a missing day is no data (check-ins: you did not check in)
 *   "fromFirst"  zero from the first recorded day on, no data before it (Claude sessions: older logs are gone)
 *   "all"        zero for the whole window when there is any entry (GitHub stats: the collector leaves out zero days)
 */
export type HeatFill = "none" | "fromFirst" | "all";

export interface HeatCell {
  key: string;
  date: Date;
  /** Column, 0 = oldest week. */
  week: number;
  /** Row, 0 = Sunday. */
  day: number;
  /** Null = no data (drawn hollow). 0 is a real zero. */
  value: number | null;
  /** -1 no data, 0 zero, 1 to 4 the quantile steps. */
  bucket: number;
  isToday: boolean;
}

export interface HeatGrid {
  weeks: number;
  /** Oldest first, up to and including today. Days after today are not in the grid. */
  cells: HeatCell[];
  /** Upper bounds between steps 1|2, 2|3, 3|4 (quantiles of the values above zero). */
  thresholds: number[];
  /** Largest value in the window, 0 when none. */
  max: number;
  /** Week columns where a new month starts, for the month labels. */
  months: { week: number; label: string }[];
}

/** Quartile cut points of the values above zero: 3 thresholds for 4 steps. Empty when there are none. */
export function quantileThresholds(values: readonly number[], steps = 4): number[] {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (positive.length === 0 || steps < 2) return [];
  const q = (p: number) => {
    // Same interpolation as d3.quantile (R-7).
    const i = (positive.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.min(positive.length - 1, lo + 1);
    return positive[lo]! + (positive[hi]! - positive[lo]!) * (i - lo);
  };
  return Array.from({ length: steps - 1 }, (_, i) => q((i + 1) / steps));
}

/**
 * Step for one value: -1 no data, 0 zero, else 1 + how many thresholds it reaches (d3.scaleQuantile
 * semantics, so a value equal to a threshold goes up a step and a year of identical days shows bright).
 */
export function bucketFor(value: number | null, thresholds: readonly number[]): number {
  if (value === null || !Number.isFinite(value)) return -1;
  if (value <= 0) return 0;
  let step = 1;
  for (const t of thresholds) if (value >= t) step += 1;
  return Math.min(step, thresholds.length + 1);
}

/** Last `weeks` weeks as a GitHub-style grid: columns are weeks (Sunday on top), the newest on the right. */
export function buildHeatGrid(
  values: ReadonlyMap<string, number>,
  now: Date,
  opts: { weeks?: number; fill: HeatFill },
): HeatGrid {
  const weeks = opts.weeks ?? 52;
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const start = addDays(startOfWeek(today), -(weeks - 1) * 7);

  let firstKey: string | null = null;
  for (const [k, v] of values) {
    if (!parseDayKey(k) || !Number.isFinite(v)) continue;
    if (firstKey === null || k < firstKey) firstKey = k;
  }
  const hasAny = firstKey !== null;

  const cells: HeatCell[] = [];
  const months: { week: number; label: string }[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const sunday = addDays(start, w * 7);
    // Label the first column of each month, and the very first column. Skip a label that would
    // crowd the previous one (fewer than 3 columns apart).
    if (sunday.getMonth() !== lastMonth || w === 0) {
      const label = MONTH_SHORT[sunday.getMonth()]!;
      const prev = months[months.length - 1];
      if (!prev || w - prev.week >= 3) months.push({ week: w, label });
      lastMonth = sunday.getMonth();
    }
    for (let d = 0; d < 7; d++) {
      const date = addDays(sunday, d);
      if (date > today) break;
      const key = dayKey(date);
      const raw = values.get(key);
      let value: number | null = raw === undefined || !Number.isFinite(raw) ? null : Math.max(0, raw);
      if (value === null && hasAny) {
        if (opts.fill === "all" || (opts.fill === "fromFirst" && firstKey !== null && key >= firstKey)) value = 0;
      }
      cells.push({ key, date, week: w, day: d, value, bucket: 0, isToday: key === todayKey });
    }
  }

  const present = cells.map((c) => c.value).filter((v): v is number => v !== null);
  const thresholds = quantileThresholds(present);
  for (const c of cells) c.bucket = bucketFor(c.value, thresholds);
  const max = present.reduce((m, v) => Math.max(m, v), 0);
  return { weeks, cells, thresholds, max, months };
}

export interface HeatStats {
  /** Sum of every value in the window. */
  total: number;
  /** Average over days that have data (zeros included), 0 when none. */
  mean: number;
  /** Days with any data, zeros included. */
  daysWithData: number;
  /** Days with a value above zero. */
  activeDays: number;
  /** Consecutive days above zero ending today, or ending yesterday while today has nothing yet. */
  currentStreak: number;
  bestStreak: number;
  max: { key: string; date: Date; value: number } | null;
  /** Smallest value above zero. */
  min: { key: string; date: Date; value: number } | null;
}

export function heatStats(grid: HeatGrid): HeatStats {
  let total = 0;
  let daysWithData = 0;
  let activeDays = 0;
  let bestStreak = 0;
  let run = 0;
  let max: HeatStats["max"] = null;
  let min: HeatStats["min"] = null;
  for (const c of grid.cells) {
    if (c.value !== null) {
      daysWithData += 1;
      total += c.value;
    }
    if (c.value !== null && c.value > 0) {
      activeDays += 1;
      run += 1;
      bestStreak = Math.max(bestStreak, run);
      if (!max || c.value > max.value) max = { key: c.key, date: c.date, value: c.value };
      if (!min || c.value < min.value) min = { key: c.key, date: c.date, value: c.value };
    } else {
      run = 0;
    }
  }

  let currentStreak = 0;
  const cells = grid.cells;
  let i = cells.length - 1;
  const last = cells[i];
  if (last && last.isToday && !(last.value !== null && last.value > 0)) i -= 1; // today is not over yet
  for (; i >= 0; i--) {
    const v = cells[i]!.value;
    if (v !== null && v > 0) currentStreak += 1;
    else break;
  }

  return { total, mean: daysWithData ? total / daysWithData : 0, daysWithData, activeDays, currentStreak, bestStreak, max, min };
}

// ---------------------------------------------------------------------------------------------
// Week timeline
// ---------------------------------------------------------------------------------------------

/** overdue: due before today. today: due today. soon: due in the next 2 days. later: any other day. */
export type DueUrgency = "overdue" | "today" | "soon" | "later";

export type WeekItem =
  | {
      kind: "jira";
      id: string;
      title: string;
      url: string;
      day: string;
      urgency: DueUrgency;
      /** Whole days late (overdue only), else 0. */
      daysLate: number;
      issue: JiraIssue;
    }
  | {
      kind: "event";
      id: string;
      title: string;
      url?: string;
      day: string;
      /** Start time, or null for an all-day event. */
      start: Date | null;
      allDay: boolean;
      event: CalendarEvent;
    };

export interface WeekPlacement {
  /** Overdue Jira issues, most overdue first. */
  overdue: WeekItem[];
  /** Seven lanes, Sunday first. Jira due items first, then events by start time. */
  days: WeekItem[][];
  /** Open issues due after Saturday. */
  dueLater: number;
  /** Open issues with no due date. */
  noDueDate: number;
}

/** Calendar start/end can be a date ("2026-11-02", all day) or a full ISO time. Null when unreadable. */
function eventStart(value: string): { day: string; start: Date | null } | null {
  const dateOnly = parseDayKey(value);
  if (dateOnly) return { day: value, start: null };
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : { day: dayKey(t), start: t };
}

export function placeWeekItems(jira: readonly JiraIssue[], events: readonly CalendarEvent[], now: Date): WeekPlacement {
  const keys = weekDayKeys(now);
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const lane = new Map(keys.map((k, i) => [k, i] as const));
  const days: WeekItem[][] = keys.map(() => []);
  const overdue: WeekItem[] = [];
  let dueLater = 0;
  let noDueDate = 0;

  for (const issue of jira) {
    if (issue.statusCategory === "done") continue;
    const due = issue.dueDate ? parseDayKey(issue.dueDate) : null;
    if (!due || !issue.dueDate) {
      noDueDate += 1;
      continue;
    }
    const daysAway = Math.round((due.getTime() - today.getTime()) / 86_400_000);
    const urgency: DueUrgency = daysAway < 0 ? "overdue" : daysAway === 0 ? "today" : daysAway <= 2 ? "soon" : "later";
    const item: WeekItem = {
      kind: "jira",
      id: `jira-${issue.key}`,
      title: issue.summary,
      url: issue.url,
      day: issue.dueDate,
      urgency,
      daysLate: daysAway < 0 ? -daysAway : 0,
      issue,
    };
    if (issue.dueDate < todayKey) {
      overdue.push(item);
      continue;
    }
    const i = lane.get(issue.dueDate);
    if (i === undefined) dueLater += 1;
    else days[i]!.push(item);
  }

  for (const event of events) {
    const at = eventStart(event.start);
    if (!at) continue;
    const i = lane.get(at.day);
    if (i === undefined) continue;
    days[i]!.push({
      kind: "event",
      id: `event-${event.id}`,
      title: event.title,
      url: event.url,
      day: at.day,
      start: at.start,
      allDay: at.start === null,
      event,
    });
  }

  const order = (a: WeekItem, b: WeekItem) => {
    if (a.kind !== b.kind) return a.kind === "jira" ? -1 : 1;
    if (a.kind === "event" && b.kind === "event") {
      const ta = a.start?.getTime() ?? -Infinity;
      const tb = b.start?.getTime() ?? -Infinity;
      return ta - tb || a.title.localeCompare(b.title);
    }
    return a.title.localeCompare(b.title);
  };
  for (const d of days) d.sort(order);
  overdue.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.title.localeCompare(b.title)));
  return { overdue, days, dueLater, noDueDate };
}

/** Minutes worked per day of this week (all projects), Sunday first. */
export function weekMinutes(sessions: readonly SessionTime[], now: Date): number[] {
  const totals = sumByDay(sessions.map((s) => s.minutesByDay));
  return weekDayKeys(now).map((k) => totals.get(k) ?? 0);
}
