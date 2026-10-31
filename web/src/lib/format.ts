import type { Area, Snapshot, SourceStatus } from "../../../shared/types";

// Pure formatting helpers shared by every panel. No React, no DOM: unit tested in format.test.ts.
// Every function that depends on "now" takes it as a parameter so tests stay deterministic.

/** Keys of Snapshot["sources"]: "github" | "jira" | "claudeSessions" | ... */
export type SourceKey = keyof Snapshot["sources"];

export const SOURCE_KEYS: readonly SourceKey[] = [
  "github",
  "jira",
  "claudeSessions",
  "learning",
  "checkins",
  "calendar",
  "email",
];

const SOURCE_LABEL: Record<SourceKey, string> = {
  github: "GitHub",
  jira: "Jira",
  claudeSessions: "Claude sessions",
  learning: "Learning",
  checkins: "Check-ins",
  calendar: "Calendar",
  email: "Email",
};

const AREA_LABEL: Record<Area, string> = {
  work: "Work",
  learning: "Learning",
  personal: "Personal",
  calendar: "Calendar",
  email: "Email",
};

const STATUS_LABEL: Record<SourceStatus, string> = {
  ok: "Up to date",
  stale: "Out of date",
  error: "Last update failed",
  not_connected: "Not connected",
  never_run: "Not collected yet",
};

export const sourceLabel = (key: SourceKey): string => SOURCE_LABEL[key];
export const areaLabel = (area: Area): string => AREA_LABEL[area];
export const statusLabel = (status: SourceStatus): string => STATUS_LABEL[status];

/** Title of the detail view for an area. Calendar and email share one view. */
export function detailTitle(area: Area): string {
  return area === "calendar" || area === "email" ? "Calendar and email" : AREA_LABEL[area];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const shortDateYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const longDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "2 days ago", "in 3 h", "tomorrow", "in 4 days".
 * Past 30 days it falls back to a date ("12 Mar", or "12 Mar 2025" in another year).
 * Returns "never" for null and "unknown time" for an unparseable string.
 */
export function relativeTime(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (value === null || value === undefined) return "never";
  const date = toDate(value);
  const t = date.getTime();
  if (Number.isNaN(t)) return "unknown time";
  const diff = now.getTime() - t;
  const future = diff < 0;
  const abs = Math.abs(diff);

  if (abs < 45_000) return "just now";
  if (abs < HOUR) {
    const m = Math.max(1, Math.round(abs / MINUTE));
    return future ? `in ${m} min` : `${m} min ago`;
  }
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    return future ? `in ${h} h` : `${h} h ago`;
  }
  const days = Math.floor(abs / DAY);
  if (days === 1) return future ? "tomorrow" : "yesterday";
  if (days < 30) return future ? `in ${days} days` : `${days} days ago`;
  return date.getFullYear() === now.getFullYear() ? shortDate.format(date) : shortDateYear.format(date);
}

/** Minutes to "3h 20m", "45m", "2h", "0m". Rounds to whole minutes; negatives and NaN become "0m". */
export function formatMinutes(minutes: number): string {
  const total = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 1234 -> "1,234". `decimals` fixes the fraction digits (7.25 with 1 -> "7.3"). */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "0";
  if (decimals === 0) return grouped.format(Math.round(value));
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(
    value,
  );
}

/** Large counts for tight tiles: 999 -> "999", 1234 -> "1.2k", 12500 -> "12.5k", 2_400_000 -> "2.4M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${trim(abs / 1000)}k`;
  return `${sign}${trim(abs / 1_000_000)}M`;
}

/** Money in Qatari riyal: 1250 -> "QAR 1,250", 12.5 -> "QAR 12.50", -40 -> "-QAR 40". */
export function formatQar(amount: number): string {
  if (!Number.isFinite(amount)) return "QAR 0";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const whole = Math.abs(abs - Math.round(abs)) < 0.005;
  const body = whole ? formatNumber(abs, 0) : formatNumber(abs, 2);
  return `${sign}QAR ${body}`;
}

/** Greeting by local hour (0 to 23): morning 5 to 11, afternoon 12 to 16, evening otherwise. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/** "Thursday 30 October" in local time. */
export function formatLongDate(date: Date): string {
  return longDate.format(date);
}

/** "14:05" in local time. Returns "" for an unparseable value. */
export function formatClock(value: string | number | Date): string {
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? "" : clock.format(date);
}

/** Local calendar day as "YYYY-MM-DD", the key used by check-ins and *ByDay records. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "1 item", "3 items". Pass `plural` for irregular words. */
export function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralWord}`;
}
