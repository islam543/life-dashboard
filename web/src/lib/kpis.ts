import type { Checkin, JiraIssue, LearningState, NeedsYouItem, NextMove, PullRequest, Snapshot, SourceState } from "../../../shared/types";
import { dayKey, formatCompact, formatNumber, plural, relativeTime, sourceLabel, type SourceKey } from "./format";

// Every number the Needs-you strip, the Next moves panel and the KPI tiles show, as pure functions.
// No React, no DOM, no Date.now(): "now" is always a parameter, so kpis.test.ts stays deterministic.
// Weeks start on Sunday (the Qatar work week runs Sunday to Thursday).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Days in every sparkline and in the PR age strip. */
export const SPARK_DAYS = 14;

/** Most cards the Needs-you strip shows; the rest are only counted ("+N more not shown"). Same cap as the server. */
export const NEEDS_YOU_CAP = 8;

// ---------------------------------------------------------------------------------------------
// Calendar days (local time)
// ---------------------------------------------------------------------------------------------

/** 00:00 local on the day `offset` days from `date` (negative = earlier). Safe across DST changes. */
export function addDays(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}

/** 00:00 local on the Sunday that starts the week containing `now`. */
export function weekStart(now: Date): Date {
  return addDays(now, -now.getDay());
}

/** `count` local day keys (YYYY-MM-DD) ending with today, oldest first. */
export function lastDayKeys(now: Date, count: number = SPARK_DAYS): string[] {
  return Array.from({ length: count }, (_, i) => dayKey(addDays(now, i - (count - 1))));
}

/** Index of this week's Sunday inside lastDayKeys(now, count); 0 when the week began before the window. */
export function weekStartIndex(now: Date, count: number = SPARK_DAYS): number {
  return Math.max(0, count - 1 - now.getDay());
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------
// Per-day records: hours, commits
// ---------------------------------------------------------------------------------------------

/** Adds several YYYY-MM-DD -> number records into one. Skips values that are not finite numbers. */
export function sumByDay(records: ReadonlyArray<Readonly<Record<string, number>> | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    if (!record) continue;
    for (const [day, value] of Object.entries(record)) {
      if (finite(value)) out[day] = (out[day] ?? 0) + value;
    }
  }
  return out;
}

/**
 * One value per day key, oldest first. `missing` fills days with no entry: 0 where "no entry" means
 * none happened (session minutes, commits), null where it means unknown (a skipped check-in), which
 * the Sparkline draws as a gap.
 */
export function seriesFor(
  byDay: Readonly<Record<string, number>>,
  keys: readonly string[],
  missing: number | null,
): (number | null)[] {
  return keys.map((k) => (finite(byDay[k]) ? byDay[k] : missing));
}

export interface WeekComparison {
  /** Total from this Sunday through today. */
  thisWeek: number;
  /** Total over the same days of last week (last Sunday through the same weekday). */
  lastWeek: number;
  /** thisWeek - lastWeek. */
  delta: number;
}

/** This week so far against the same stretch of last week, so a Monday is not compared with a full week. */
export function compareWeeks(byDay: Readonly<Record<string, number>>, now: Date): WeekComparison {
  const start = weekStart(now);
  const daysSoFar = now.getDay() + 1; // Sunday counts as day 1
  let thisWeek = 0;
  let lastWeek = 0;
  for (let i = 0; i < daysSoFar; i++) {
    const a = byDay[dayKey(addDays(start, i))];
    const b = byDay[dayKey(addDays(start, i - 7))];
    if (finite(a)) thisWeek += a;
    if (finite(b)) lastWeek += b;
  }
  return { thisWeek, lastWeek, delta: thisWeek - lastWeek };
}

// ---------------------------------------------------------------------------------------------
// Sleep (daily check-ins)
// ---------------------------------------------------------------------------------------------

/** Sleep hours per day key. A day checked in twice keeps the later entry. Invalid entries are skipped. */
export function sleepByDay(checkins: readonly Checkin[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of checkins ?? []) {
    if (!c || typeof c.date !== "string" || !finite(c.sleepHours) || c.sleepHours < 0) continue;
    out[c.date.slice(0, 10)] = c.sleepHours;
  }
  return out;
}

export interface AverageComparison {
  /** Mean over the days that have a check-in in the last 7 days (today included), or null if none. */
  current: number | null;
  /** Same for the 7 days before that, or null if none. */
  previous: number | null;
  /** current - previous, or null when either side has no check-ins. */
  delta: number | null;
  currentDays: number;
  previousDays: number;
}

/** 7-day average sleep against the 7 days before. Missing days are skipped, never counted as 0. */
export function sleepAverage(checkins: readonly Checkin[], now: Date): AverageComparison {
  const byDay = sleepByDay(checkins);
  const window = (fromOffset: number) => {
    let sum = 0;
    let days = 0;
    for (let i = 0; i < 7; i++) {
      const v = byDay[dayKey(addDays(now, fromOffset - i))];
      if (finite(v)) {
        sum += v;
        days += 1;
      }
    }
    return { mean: days > 0 ? sum / days : null, days };
  };
  const cur = window(0);
  const prev = window(-7);
  return {
    current: cur.mean,
    previous: prev.mean,
    delta: cur.mean !== null && prev.mean !== null ? cur.mean - prev.mean : null,
    currentDays: cur.days,
    previousDays: prev.days,
  };
}

/** Sleep per night for the last `count` days, null where there is no check-in (a gap, not zero). */
export function sleepSeries(checkins: readonly Checkin[], now: Date, count: number = SPARK_DAYS): (number | null)[] {
  return seriesFor(sleepByDay(checkins), lastDayKeys(now, count), null);
}

// ---------------------------------------------------------------------------------------------
// Jira, pull requests, learning streak
// ---------------------------------------------------------------------------------------------

export interface JiraSummary {
  open: number;
  inProgress: number;
  todo: number;
  blocked: number;
  /** Due date before today. */
  overdue: number;
}

/** Counts of the issues that are not done. Due dates are compared as local calendar days. */
export function jiraSummary(issues: readonly JiraIssue[], now: Date): JiraSummary {
  const today = dayKey(now);
  const out: JiraSummary = { open: 0, inProgress: 0, todo: 0, blocked: 0, overdue: 0 };
  for (const issue of issues ?? []) {
    if (!issue || issue.statusCategory === "done") continue;
    out.open += 1;
    if (issue.statusCategory === "inprogress") out.inProgress += 1;
    else out.todo += 1;
    if (issue.blocked) out.blocked += 1;
    if (typeof issue.dueDate === "string" && issue.dueDate.length >= 10 && issue.dueDate.slice(0, 10) < today) {
      out.overdue += 1;
    }
  }
  return out;
}

export type AgeTone = "ok" | "warn" | "danger";

export interface PrDot {
  key: string;
  title: string;
  /** Position on the age strip: 0 = `windowDays` or more ago (left edge), 1 = now (right edge). */
  x: number;
  /** Lane 0 to 2, so dots opened close together do not cover each other. */
  row: number;
  ageDays: number;
  /** Same thresholds as the Needs-you rule: amber after 1 day, red after 3. */
  tone: AgeTone;
}

export interface PrQueue {
  /**
   * Open PRs where your review is requested, drafts left out. Same rule as the server's Needs-you
   * engine, so the tile and the "PR waiting for your review" cards always agree.
   */
  count: number;
  /** Age in whole days of the oldest one, or null when there are none (or no readable dates). */
  oldestDays: number | null;
  dots: PrDot[];
}

/** Position of an age on a strip that runs from `windowDays` ago (0) to now (1). Older ages pin to 0. */
export function ageToX(ageDays: number, windowDays: number = SPARK_DAYS): number {
  if (!finite(ageDays) || windowDays <= 0) return 1;
  return 1 - Math.min(Math.max(ageDays, 0), windowDays) / windowDays;
}

const DOT_GAP = 0.07;
const DOT_ROWS = 3;

/** A review request that is waiting on you. A draft is still being written, so it is not. */
export function isWaitingOnYou(pr: PullRequest | null | undefined): boolean {
  return !!pr && pr.role === "reviewer" && pr.isDraft !== true;
}

/** PRs waiting on your review (drafts left out), with an age dot per PR for the last `windowDays`. */
export function prQueue(prs: readonly PullRequest[], now: Date, windowDays: number = SPARK_DAYS): PrQueue {
  const waiting = (prs ?? []).filter(isWaitingOnYou);
  const raw: Omit<PrDot, "row">[] = [];
  for (const p of waiting) {
    const created = Date.parse(p.createdAt);
    if (!Number.isFinite(created)) continue;
    const ageDays = Math.max(0, (now.getTime() - created) / DAY);
    raw.push({
      key: `${p.repo}#${p.number}`,
      title: p.title,
      x: ageToX(ageDays, windowDays),
      ageDays,
      tone: ageDays > 3 ? "danger" : ageDays > 1 ? "warn" : "ok",
    });
  }
  raw.sort((a, b) => a.x - b.x);
  const lastX = Array.from({ length: DOT_ROWS }, () => Number.NEGATIVE_INFINITY);
  const dots = raw.map((d) => {
    let row = lastX.findIndex((x) => d.x - x >= DOT_GAP);
    if (row === -1) row = lastX.indexOf(Math.min(...lastX));
    lastX[row] = d.x;
    return { ...d, row };
  });
  const oldest = raw.length ? Math.floor(Math.max(...raw.map((d) => d.ageDays))) : null;
  return { count: waiting.length, oldestDays: oldest, dots };
}

export interface StreakSummary {
  current: number;
  best: number;
  /** current / best, 0 to 1 (0 when there is no best yet). */
  ratio: number;
  /**
   * True when the current streak is the best so far and longer than 1 day. A 1-day streak tying a
   * best of 1 is every first day, not a record.
   */
  isBest: boolean;
}

export function streakSummary(streak: LearningState["streak"] | null | undefined): StreakSummary {
  const rawCurrent = streak?.current;
  const rawBest = streak?.best;
  const current = finite(rawCurrent) ? Math.max(0, Math.floor(rawCurrent)) : 0;
  const best = Math.max(current, finite(rawBest) ? Math.floor(rawBest) : 0);
  return { current, best, ratio: best > 0 ? current / best : 0, isBest: current > 1 && current >= best };
}

/** Where the streak count comes from. Daily.md has no last-studied date, so the count is never "live". */
export const STREAK_SOURCE = "as recorded in Daily.md";

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const SHORT_DAY_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "18 Aug" for a YYYY-MM-DD key in the year of `now`, "18 Aug 2025" otherwise. Null for a bad key. */
export function shortDay(key: string | null | undefined, now: Date): string | null {
  const m = typeof key === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (date.getMonth() !== Number(m[2]) - 1 || date.getDate() !== Number(m[3])) return null;
  return (date.getFullYear() === now.getFullYear() ? SHORT_DAY : SHORT_DAY_YEAR).format(date);
}

/**
 * The line under the streak number. The snapshot has no last-studied date, so it never claims the
 * streak is alive: it names Daily.md as the source and shows the recorded start date instead.
 *   "Your best yet, as recorded in Daily.md" / "Started 18 Aug, as recorded in Daily.md" / "Best 9 days"
 */
export function streakCaption(s: StreakSummary, started: string | null | undefined, now: Date): string {
  if (s.current === 0) return s.best > 0 ? `Best ${plural(s.best, "day")}` : "No best yet";
  const startedText = shortDay(started, now);
  const lead = s.isBest ? "Your best yet" : startedText ? `Started ${startedText}` : null;
  return lead ? `${lead}, ${STREAK_SOURCE}` : `${STREAK_SOURCE.charAt(0).toUpperCase()}${STREAK_SOURCE.slice(1)}`;
}

/** part / whole as 0 to 1; 0 when whole is 0. */
export function share(part: number, whole: number): number {
  if (!finite(part) || !finite(whole) || whole <= 0) return 0;
  return Math.min(1, Math.max(0, part / whole));
}

// ---------------------------------------------------------------------------------------------
// Number formats for tiles
// ---------------------------------------------------------------------------------------------

/** Minutes to hours: one decimal under 100 h ("12.5"), whole hours above ("120"). */
export function formatHours(hours: number): string {
  if (!finite(hours)) return "0.0";
  return Math.abs(hours) >= 100 ? formatNumber(hours, 0) : formatNumber(hours, 1);
}

/** Counts for a tile: grouped under 10,000 ("9,876"), compact above ("12.3k", "2.4M"). */
export function formatCount(n: number): string {
  if (!finite(n)) return "0";
  return Math.abs(n) < 10_000 ? formatNumber(n) : formatCompact(n);
}

export type Direction = "up" | "down" | "flat";

/** Direction and absolute size of a change, printed with `format`. "flat" when it prints as zero. */
export function describeDelta(delta: number, format: (abs: number) => string): { dir: Direction; text: string } {
  if (!finite(delta)) return { dir: "flat", text: format(0) };
  const text = format(Math.abs(delta));
  const zero = format(0);
  if (text === zero) return { dir: "flat", text };
  return { dir: delta > 0 ? "up" : "down", text };
}

// ---------------------------------------------------------------------------------------------
// Source availability for one tile
// ---------------------------------------------------------------------------------------------

export type Availability =
  /** Show the number. `caveat` is set when the data is stale or the last update failed. */
  | { kind: "ok"; caveat: string | null }
  | { kind: "off"; message: string }
  | { kind: "idle"; message: string }
  | { kind: "failed"; message: string };

/**
 * Whether a tile can show its number. A source that is not connected, never collected, or has
 * never succeeded shows that state instead of a 0.
 */
export function availability(state: SourceState | null | undefined, source: SourceKey, now: Date): Availability {
  const name = sourceLabel(source);
  switch (state?.status) {
    case "ok":
      return { kind: "ok", caveat: null };
    case "stale":
      return { kind: "ok", caveat: `${name} data is from ${relativeTime(state.updatedAt, now)}.` };
    case "error":
      if (state.updatedAt) {
        return { kind: "ok", caveat: `Last ${name} update failed. Showing data from ${relativeTime(state.updatedAt, now)}.` };
      }
      return { kind: "failed", message: state.message?.trim() || `${name} update failed.` };
    case "not_connected":
      return { kind: "off", message: state.message?.trim() || `Connect ${name} to see this.` };
    default:
      return { kind: "idle", message: `${name} is collected on the next refresh.` };
  }
}

// ---------------------------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------------------------

const dueTime = (item: NeedsYouItem): number => {
  const t = item.dueAt ? Date.parse(item.dueAt) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/** Red first, then amber; inside each, soonest due first, undated last; otherwise the server's order. */
export function rankNeedsYou(items: readonly NeedsYouItem[] | null | undefined): NeedsYouItem[] {
  return (items ?? [])
    .filter((i): i is NeedsYouItem => !!i && typeof i.id === "string")
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.urgency === "red" ? 0 : 1) - (b.item.urgency === "red" ? 0 : 1) ||
        dueTime(a.item) - dueTime(b.item) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

/**
 * How many items are left out of the strip. The server sends at most 8, so the rest exist only as a
 * count: the strip says "+N more not shown" as plain text, never as a link to items it cannot show.
 * `total` is snapshot.needsYouTotal (the full count before the server's cap); when it is missing or
 * smaller than the list, the list length is used.
 */
export function needsYouOverflow(shown: number, total: number | null | undefined, listLength: number): number {
  const full = Math.max(finite(total) ? total : 0, listLength);
  return Math.max(0, full - shown);
}

export function urgencyCounts(items: readonly NeedsYouItem[]): { red: number; amber: number } {
  let red = 0;
  let amber = 0;
  for (const i of items) {
    if (i.urgency === "red") red += 1;
    else amber += 1;
  }
  return { red, amber };
}

/** Reads the remembered ids (JSON array of strings). Anything else counts as "no previous visit". */
export function parseSeenIds(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/** Ids not seen on the last visit. On the first visit ever (`seen` null) nothing counts as new. */
export function newSinceLastVisit(ids: readonly string[], seen: readonly string[] | null): Set<string> {
  if (seen === null) return new Set();
  const before = new Set(seen);
  return new Set(ids.filter((id) => !before.has(id)));
}

/** "Due in 5 h", "Due tomorrow", "Due in 4 days", "Due now", "Overdue by 2 days". Null for a bad date. */
export function dueLabel(dueAt: string | null | undefined, now: Date): string | null {
  const t = dueAt ? Date.parse(dueAt) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const diff = t - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "Due now";
  let span: string;
  if (abs < HOUR) span = `${Math.round(abs / MINUTE)} min`;
  else if (abs < DAY) span = `${Math.floor(abs / HOUR)} h`;
  else {
    const days = Math.floor(abs / DAY);
    span = days === 1 ? "1 day" : `${days} days`;
  }
  if (diff < 0) return `Overdue by ${span}`;
  if (abs >= DAY && abs < 2 * DAY) return "Due tomorrow";
  return `Due in ${span}`;
}

/** Share of a `windowMs` countdown still left before `dueAt`: 1 = a full window away, 0 = due or overdue. */
export function dueRemaining(dueAt: string | null | undefined, now: Date, windowMs: number = 72 * HOUR): number | null {
  const t = dueAt ? Date.parse(dueAt) : Number.NaN;
  if (!Number.isFinite(t) || windowMs <= 0) return null;
  return Math.min(1, Math.max(0, (t - now.getTime()) / windowMs));
}

/** Sources the Needs-you rules read. Calendar feeds meetings; check-ins and learning feed the evening nudges. */
export const NEEDS_YOU_SOURCES: readonly SourceKey[] = ["jira", "github", "calendar", "checkins", "learning"];

/**
 * Which Needs-you sources actually have data to check. "Nothing urgent" is only true for these;
 * the rest are named so an all-clear is never claimed for a source nobody looked at.
 */
export function needsYouCoverage(sources: Partial<Snapshot["sources"]> | null | undefined): {
  checked: SourceKey[];
  unchecked: SourceKey[];
} {
  const checked: SourceKey[] = [];
  const unchecked: SourceKey[] = [];
  for (const key of NEEDS_YOU_SOURCES) {
    const s = sources?.[key];
    const hasData = s?.status === "ok" || s?.status === "stale" || (s?.status === "error" && !!s.updatedAt);
    (hasData ? checked : unchecked).push(key);
  }
  return { checked, unchecked };
}

// ---------------------------------------------------------------------------------------------
// Next moves
// ---------------------------------------------------------------------------------------------

/** Moves still open, best rank first (ties keep the file's order). */
export function openMoves(moves: readonly NextMove[] | null | undefined): NextMove[] {
  return (moves ?? [])
    .map((move, index) => ({ move, index }))
    .filter(({ move }) => move && move.state === "open")
    .sort((a, b) => (finite(a.move.rank) ? a.move.rank : 1e9) - (finite(b.move.rank) ? b.move.rank : 1e9) || a.index - b.index)
    .map(({ move }) => move);
}
