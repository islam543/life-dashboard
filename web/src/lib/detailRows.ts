import type { CalendarEvent, Checkin, CiRun, JiraIssue, PullRequest, SessionTime, Snapshot } from "../../../shared/types";
import { dayKey } from "./format";

// Pure helpers for the explore views (details/*): sorting, filtering, pagination, and the series the
// charts draw. No React, no DOM: unit tested in detailRows.test.ts. Anything that depends on "now"
// takes it as a parameter so tests stay deterministic.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ---------------------------------------------------------------- sorting */

export type SortDir = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;

/** null, undefined, "" (after trim) and NaN count as empty: they always sort last. */
export function isEmptyValue(value: SortValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isNaN(value);
  if (typeof value === "string") return value.trim() === "";
  return false;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Compares two cell values. Empty values go last in both directions; strings compare naturally ("QIC-9" before "QIC-10"). */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  let result: number;
  if (typeof a === "number" && typeof b === "number") result = a - b;
  else if (typeof a === "boolean" && typeof b === "boolean") result = a === b ? 0 : a ? -1 : 1;
  else result = collator.compare(String(a), String(b));
  return dir === "asc" ? result : -result;
}

/** Stable sort by one value, with an optional tie-break that ignores the direction. Returns a new array. */
export function sortRows<T>(
  rows: readonly T[],
  value: (row: T) => SortValue,
  dir: SortDir,
  tieBreak?: (a: T, b: T) => number,
): T[] {
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => compareValues(a.key, b.key, dir) || (tieBreak ? tieBreak(a.row, b.row) : 0) || a.index - b.index)
    .map((entry) => entry.row);
}

/** Header click cycle: first direction, then the other, then back to the view's default (null). */
export function nextSort(
  current: { column: string; dir: SortDir } | null,
  column: string,
  firstDir: SortDir,
): { column: string; dir: SortDir } | null {
  if (!current || current.column !== column) return { column, dir: firstDir };
  if (current.dir === firstDir) return { column, dir: firstDir === "asc" ? "desc" : "asc" };
  return null;
}

/* -------------------------------------------------------------- filtering */

/** Selected values per filter category. OR inside a category, AND across categories. */
export type Filters = Readonly<Record<string, readonly string[]>>;

export function filterRows<T>(rows: readonly T[], filters: Filters, get: (row: T, category: string) => string): T[] {
  const active = Object.entries(filters).filter(([, values]) => values.length > 0);
  if (active.length === 0) return rows.slice();
  return rows.filter((row) => active.every(([category, values]) => values.includes(get(row, category))));
}

/** Adds the value to the category, or removes it if it is already selected. */
export function toggleFilter(filters: Filters, category: string, value: string): Filters {
  const current = filters[category] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...filters, [category]: next };
}

export function activeFilterCount(filters: Filters): number {
  return Object.values(filters).reduce((sum, values) => sum + values.length, 0);
}

export interface Facet {
  value: string;
  count: number;
}

/** Distinct values with their counts, most common first, then alphabetical. Empty values become "None". */
export function facetCounts<T>(rows: readonly T[], get: (row: T) => string): Facet[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = get(row).trim() || "None";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.value, b.value));
}

/* ------------------------------------------------------------- pagination */

export const PAGE_SIZE = 20;

export interface Page<T> {
  rows: T[];
  /** Zero-based page shown, clamped to the last page. */
  page: number;
  /** At least 1, even with no rows. */
  pageCount: number;
  total: number;
  /** One-based index of the first and last row shown; 0 and 0 when there are no rows. */
  from: number;
  to: number;
}

export function paginate<T>(rows: readonly T[], page: number, pageSize: number = PAGE_SIZE): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safe = Number.isFinite(page) ? Math.min(Math.max(0, Math.floor(page)), pageCount - 1) : 0;
  const start = safe * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: safe, pageCount, total, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

/* ------------------------------------------------------------------- dates */

/** "YYYY-MM-DD" as a local Date at midnight. Invalid input gives an invalid Date. */
export function parseDay(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return new Date(Number.NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole local days from today to `key`: 0 today, 1 tomorrow, -2 two days ago. NaN for a bad key. */
export function daysUntil(key: string, now: Date): number {
  const target = parseDay(key);
  if (Number.isNaN(target.getTime())) return Number.NaN;
  return Math.round((target.getTime() - startOfDay(now).getTime()) / DAY);
}

/** The last `n` local days ending today, oldest first, as "YYYY-MM-DD". */
export function lastNDays(n: number, now: Date): string[] {
  const today = startOfDay(now);
  const out: string[] = [];
  for (let i = Math.max(0, Math.floor(n)) - 1; i >= 0; i--) {
    out.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  }
  return out;
}

/** "45m", "5h", "3d": how long ago something started, for tight table cells. */
export function formatAge(fromIso: string, now: Date): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** Hours since an ISO time; NaN for a bad value. */
export function hoursSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / HOUR;
}

/* -------------------------------------------------------------------- Jira */

const PRIORITY_RANK: Record<string, number> = { highest: 0, blocker: 0, critical: 0, high: 1, medium: 2, low: 3, lowest: 4, trivial: 4 };

/** Lower is more urgent. Unknown names sit with "Medium". */
export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority.trim().toLowerCase()] ?? 2;
}

export type DueLevel = "overdue" | "today" | "soon" | "later" | "none";

/** overdue (past), today, soon (within 3 days), later, none (no due date). Matches the Needs-you rules. */
export function dueLevel(due: string | null, now: Date): DueLevel {
  if (!due) return "none";
  const days = daysUntil(due, now);
  if (Number.isNaN(days)) return "none";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 3) return "soon";
  return "later";
}

/** "3 days late", "1 day late", "Today", "Tomorrow", "In 4 days", "No due date". */
export function dueText(due: string | null, now: Date): string {
  if (!due) return "No due date";
  const days = daysUntil(due, now);
  if (Number.isNaN(days)) return "No due date";
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} late`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

/** Tie-break inside the same due date: blocked first, then higher priority, then key. */
export function jiraTieBreak(a: JiraIssue, b: JiraIssue): number {
  if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
  return priorityRank(a.priority) - priorityRank(b.priority) || collator.compare(a.key, b.key);
}

/** Default Jira order, most urgent first: earliest due date (overdue first), no due date last. */
export function sortJiraByUrgency(issues: readonly JiraIssue[]): JiraIssue[] {
  return sortRows(issues, (i) => i.dueDate, "asc", jiraTieBreak);
}

/* --------------------------------------------------------------------- PRs */

export type PrStatus = "Needs your review" | "Checks failing" | "Checks running" | "Draft" | "Open";

/**
 * One label per PR. A draft is never "Needs your review" (the Needs-you rule skips drafts), but its
 * failing checks are still named, because that is a fact about the PR.
 */
export function prStatus(pr: PullRequest): PrStatus {
  if (pr.role === "reviewer" && !pr.isDraft) return "Needs your review";
  if (pr.checks === "fail") return "Checks failing";
  if (pr.isDraft) return "Draft";
  if (pr.checks === "pending") return "Checks running";
  return "Open";
}

/**
 * 0 act today (review waiting over 72 h, or my PR with failing checks), 1 this week (review waiting
 * over 24 h), 2 other reviews, 3 my open PRs, 4 drafts (never urgent). Mirrors the Needs-you rules.
 */
export function prUrgency(pr: PullRequest, now: Date): number {
  if (pr.isDraft) return 4;
  const age = hoursSince(pr.createdAt, now);
  if (pr.role === "reviewer") return age > 72 ? 0 : age > 24 ? 1 : 2;
  if (pr.checks === "fail") return 0;
  return 3;
}

/** Default PR order, most urgent first, then the one waiting longest. */
export function sortPrsByUrgency(prs: readonly PullRequest[], now: Date): PullRequest[] {
  return sortRows(prs, (p) => prUrgency(p, now), "asc", (a, b) => a.createdAt.localeCompare(b.createdAt));
}

/* ---------------------------------------------------------------------- CI */

const CI_ORDER: Record<CiRun["status"], number> = { fail: 0, pending: 1, pass: 2 };

/** Failing first, then running, then passing; alphabetical by repo inside each. */
export function sortCi(runs: readonly CiRun[]): CiRun[] {
  return sortRows(runs, (r) => CI_ORDER[r.status], "asc", (a, b) => collator.compare(a.repo, b.repo));
}

export function ciCounts(runs: readonly CiRun[]): Record<CiRun["status"], number> {
  const counts = { fail: 0, pending: 0, pass: 0 };
  for (const run of runs) counts[run.status] += 1;
  return counts;
}

/* -------------------------------------------------------- time and commits */

export interface StackedTime {
  /** Series names, biggest total first; "Other" last when projects were folded. */
  keys: string[];
  /** Day keys, oldest first. */
  days: string[];
  /** values[day][series], minutes. */
  values: number[][];
  /** Minutes per series over the window, same order as keys. */
  totals: number[];
  /** Minutes per day over all series. */
  dayTotals: number[];
}

export const OTHER_SERIES = "Other";

/**
 * Minutes per project per day for the last `days` days, ready for a stacked area. The `maxSeries`
 * biggest projects keep their own series; the rest fold into "Other". Projects with no time in the
 * window are dropped.
 */
export function stackProjectTime(sessions: readonly SessionTime[], days: number, now: Date, maxSeries = 5): StackedTime {
  const dayKeys = lastNDays(days, now);
  const projects = sessions
    .map((s) => ({ name: s.project, perDay: dayKeys.map((d) => Math.max(0, s.minutesByDay[d] ?? 0)) }))
    .map((p) => ({ ...p, total: p.perDay.reduce((a, b) => a + b, 0) }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total || collator.compare(a.name, b.name));

  const fold = projects.length > maxSeries;
  const kept = fold ? projects.slice(0, Math.max(1, maxSeries - 1)) : projects;
  const rest = fold ? projects.slice(kept.length) : [];
  const series = kept.map((p) => ({ name: p.name, perDay: p.perDay, total: p.total }));
  if (rest.length > 0) {
    const perDay = dayKeys.map((_, i) => rest.reduce((sum, p) => sum + p.perDay[i], 0));
    series.push({ name: OTHER_SERIES, perDay, total: perDay.reduce((a, b) => a + b, 0) });
  }

  const values = dayKeys.map((_, d) => series.map((s) => s.perDay[d]));
  return {
    keys: series.map((s) => s.name),
    days: dayKeys,
    values,
    totals: series.map((s) => s.total),
    dayTotals: values.map((row) => row.reduce((a, b) => a + b, 0)),
  };
}

/** Sums several day-keyed records over the given days (commits across repos). Missing days count 0. */
export function sumByDay(records: ReadonlyArray<Record<string, number>>, days: readonly string[]): number[] {
  return days.map((d) => records.reduce((sum, r) => sum + Math.max(0, r[d] ?? 0), 0));
}

/* --------------------------------------------------------------- check-ins */

export type CheckinField = "sleepHours" | "energy" | "mood" | "workoutMinutes" | "spendQar";

/** One check-in per date (the last one wins), newest first. */
export function recentCheckins(checkins: readonly Checkin[]): Checkin[] {
  const byDate = new Map<string, Checkin>();
  for (const c of checkins) byDate.set(c.date, c);
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export interface SeriesPoint {
  date: string;
  /** null = no check-in that day (a gap, not zero). */
  value: number | null;
}

/** One point per day for the last `days` days, oldest first. Days without a check-in are null. */
export function checkinSeries(checkins: readonly Checkin[], field: CheckinField, days: number, now: Date): SeriesPoint[] {
  const byDate = new Map<string, number>();
  for (const c of checkins) {
    const v = c[field];
    if (typeof v === "number" && Number.isFinite(v)) byDate.set(c.date, v);
  }
  return lastNDays(days, now).map((date) => ({ date, value: byDate.get(date) ?? null }));
}

/** Mean of the defined values, or null when there are none. */
export function average(values: ReadonlyArray<number | null>): number | null {
  const defined = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return defined.length === 0 ? null : defined.reduce((a, b) => a + b, 0) / defined.length;
}

export interface WeekTotal {
  /** First and last day of the week, "YYYY-MM-DD". The last week ends today. */
  start: string;
  end: string;
  /** Sum over the days logged; null when no day of the week was logged (not zero). */
  total: number | null;
  /** Days with a check-in that week. */
  logged: number;
  /** Days of the week that have happened (7, or fewer for the current week). */
  daysInWeek: number;
}

/**
 * Weekly sums of a field for the last `weeks` weeks, oldest first. Weeks start on `weekStartsOn`
 * (0 Sunday, the Qatar work week). The current week is partial and ends today.
 */
export function weeklyTotals(
  checkins: readonly Checkin[],
  field: CheckinField,
  weeks: number,
  now: Date,
  weekStartsOn = 0,
): WeekTotal[] {
  const today = startOfDay(now);
  const back = (today.getDay() - weekStartsOn + 7) % 7;
  const currentStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
  const byDate = new Map<string, number>();
  for (const c of checkins) {
    const v = c[field];
    if (typeof v === "number" && Number.isFinite(v)) byDate.set(c.date, v);
  }

  const out: WeekTotal[] = [];
  for (let w = Math.max(0, Math.floor(weeks)) - 1; w >= 0; w--) {
    const start = new Date(currentStart.getFullYear(), currentStart.getMonth(), currentStart.getDate() - 7 * w);
    let total = 0;
    let logged = 0;
    let daysInWeek = 0;
    let end = start;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
      if (day.getTime() > today.getTime()) break;
      daysInWeek += 1;
      end = day;
      const v = byDate.get(dayKey(day));
      if (v !== undefined) {
        total += v;
        logged += 1;
      }
    }
    out.push({ start: dayKey(start), end: dayKey(end), total: logged > 0 ? total : null, logged, daysInWeek });
  }
  return out;
}

/* ---------------------------------------------------------------- calendar */

/** True for an all-day event ("YYYY-MM-DD" start with no time). */
export function isAllDay(event: Pick<CalendarEvent, "start">): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(event.start);
}

function eventStart(event: Pick<CalendarEvent, "start">): Date {
  return isAllDay(event) ? parseDay(event.start) : new Date(event.start);
}

export interface AgendaDay<T> {
  day: string;
  items: T[];
}

/**
 * Events from today on, grouped by local day, days in order and all-day events first inside a day.
 * Events that already ended before today are left out; unparseable starts are dropped.
 */
export function groupEventsByDay<T extends CalendarEvent>(events: readonly T[], now: Date): AgendaDay<T>[] {
  const todayKey = dayKey(now);
  const groups = new Map<string, T[]>();
  const sorted = events
    .filter((e) => !Number.isNaN(eventStart(e).getTime()))
    .slice()
    .sort((a, b) => {
      const allDay = Number(isAllDay(b)) - Number(isAllDay(a));
      const da = dayKey(eventStart(a)).localeCompare(dayKey(eventStart(b)));
      return da || allDay || eventStart(a).getTime() - eventStart(b).getTime();
    });
  for (const event of sorted) {
    const key = dayKey(eventStart(event));
    if (key < todayKey) continue;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([day, items]) => ({ day, items }));
}

/* -------------------------------------------------------------- work tabs */

export type WorkTab = "jira" | "prs" | "ci" | "time";

/** Work tabs in display order, each with the source that feeds it. */
export const WORK_TABS: ReadonlyArray<{ id: WorkTab; source: "jira" | "github" | "claudeSessions" }> = [
  { id: "jira", source: "jira" },
  { id: "prs", source: "github" },
  { id: "ci", source: "github" },
  { id: "time", source: "claudeSessions" },
];

/**
 * The Work tab a tile asks for, from its layoutId ("tile-work-prs"), or null when the opener named
 * none (Life map node, a plain "work" id) or an unknown key. The week timeline ("week") opens Time.
 */
export function workTabFromLayoutId(layoutId: string | null | undefined): WorkTab | null {
  const key = (layoutId ?? "").replace(/^tile-work-?/, "").toLowerCase();
  if (!key) return null;
  if (key === "jira" || key.includes("issue")) return "jira";
  if (key === "ci" || key.startsWith("ci-") || key.includes("build")) return "ci";
  if (key === "pr" || key === "prs" || key.includes("pull") || key.includes("review")) return "prs";
  if (["time", "hours", "sessions", "commits", "year", "bars", "week"].some((k) => key.includes(k))) return "time";
  return null;
}

/**
 * The tab to show when the opener did not ask for one: the first whose source is connected, so the
 * view never opens on a "Not connected" tab while another has data. Jira when nothing is connected
 * or the sources are not loaded yet.
 */
export function defaultWorkTab(sources: Partial<Snapshot["sources"]> | null | undefined): WorkTab {
  const connected = WORK_TABS.find((t) => {
    const status = sources?.[t.source]?.status;
    return status !== undefined && status !== "not_connected";
  });
  return connected?.id ?? "jira";
}

/** The tab the Work view opens on: the one the opener asked for, otherwise the first connected one. */
export function workTabFor(layoutId: string | null | undefined, sources?: Partial<Snapshot["sources"]> | null): WorkTab {
  return workTabFromLayoutId(layoutId) ?? defaultWorkTab(sources);
}

/** The current step in a learning cycle: the first one not done, or -1 when all are done. */
export function currentStepIndex(steps: ReadonlyArray<{ done: boolean }>): number {
  return steps.findIndex((s) => !s.done);
}
