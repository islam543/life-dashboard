import type { CalendarEvent, PlanItem, TaskNote } from "../shared/types";
import { isTaskDate, isTaskTime } from "./notesFrontmatter";
import { qatarDateKey } from "./schedule";

// Plan placement (docs/ARCHITECTURE.md "v1.3", ticket T31). Pure: no clock, no disk.
//
// Every plan item leaves the server with a start and minutes. An item keeps the start the model
// gave when it lies inside the window, after the day's earliest start, and overlaps no busy block
// (meetings, timed tasks) and no item placed before it. Any other item (untimed, overlapping, or
// past the window) moves to the first free gap of its own day that fits, else of a later day in
// scope. An item that fits nowhere is dropped and returned in `dropped`.
//
// Times are minutes from 00:00 Asia/Qatar on that date. Blocks are half-open: [start, end).

/** Planned length when the model gave none. */
export const DEFAULT_ITEM_MINUTES = 30;
const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const QATAR_OFFSET_MS = 3 * 60 * MINUTE_MS;

/** A plan item before placement: the model may leave start and minutes out. */
export type DraftPlanItem = Omit<PlanItem, "start" | "minutes"> & { start: string | null; minutes: number | null };

export interface Block {
  start: number;
  end: number;
}

/** "HH:MM" to minutes from midnight. */
export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

/** Minutes from midnight to "HH:MM" (wraps at 24:00, so 1440 is "00:00"). */
export function fromMinutes(minutes: number): string {
  const m = ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Milliseconds of 00:00 Asia/Qatar on `date`. */
function qatarMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) - QATAR_OFFSET_MS;
}

/** Minutes from 00:00 Asia/Qatar on today's date to `now`, rounded up to the next `step` minutes. */
export function roundedNowMinutes(now: Date, step = 15): number {
  const exact = (now.getTime() - qatarMidnight(qatarDateKey(now))) / MINUTE_MS;
  return Math.ceil(exact / step - 1e-9) * step;
}

/**
 * The busy blocks of each date: timed meetings (clipped to that day, so one crossing midnight
 * blocks both days) and every timed task note due that day. All-day events do not block time.
 */
export function busyBlocks(dates: readonly string[], events: readonly CalendarEvent[], tasks: readonly TaskNote[]): Record<string, Block[]> {
  const out: Record<string, Block[]> = {};
  for (const date of dates) {
    const dayStart = qatarMidnight(date);
    const dayEnd = dayStart + DAY_MINUTES * MINUTE_MS;
    const blocks: Block[] = [];
    for (const e of events) {
      if (isTaskDate(e.start)) continue;
      const s = Date.parse(e.start);
      let end = Date.parse(e.end);
      if (!Number.isFinite(s)) continue;
      if (!Number.isFinite(end) || end <= s) end = s + DEFAULT_ITEM_MINUTES * MINUTE_MS;
      if (end <= dayStart || s >= dayEnd) continue;
      blocks.push({
        start: Math.max(0, (s - dayStart) / MINUTE_MS),
        end: Math.min(DAY_MINUTES, (end - dayStart) / MINUTE_MS),
      });
    }
    for (const t of tasks) {
      if (t.task.due !== date || t.task.start === null || !isTaskTime(t.task.start)) continue;
      const start = toMinutes(t.task.start);
      blocks.push({ start, end: Math.min(DAY_MINUTES, start + (t.task.minutes ?? DEFAULT_ITEM_MINUTES)) });
    }
    out[date] = blocks.sort((a, b) => a.start - b.start);
  }
  return out;
}

export interface PlacerInput {
  /** The dates in scope, in order. */
  dates: readonly string[];
  /** Busy blocks per date (busyBlocks). A date left out has none. */
  busy: Readonly<Record<string, readonly Block[]>>;
  /** Planning window, minutes from midnight (07:00 to 22:00 is { start: 420, end: 1320 }). */
  window: Block;
  /** Earliest start per date (today: now rounded up). A date left out starts at window.start. */
  earliest?: Readonly<Record<string, number>>;
  items: readonly DraftPlanItem[];
}

export interface PlacerResult {
  /** Placed items, sorted by date and start. */
  items: PlanItem[];
  /** Items that fit nowhere in scope. */
  dropped: DraftPlanItem[];
}

export function placeItems(input: PlacerInput): PlacerResult {
  const { dates, window } = input;
  const occupied = new Map<string, Block[]>(dates.map((d) => [d, [...(input.busy[d] ?? [])]]));
  const lowest = (date: string) => Math.max(window.start, input.earliest?.[date] ?? window.start);
  const fits = (date: string, start: number, length: number): boolean =>
    start >= lowest(date) &&
    start + length <= window.end &&
    !(occupied.get(date) ?? []).some((b) => start < b.end && b.start < start + length);
  const firstGap = (date: string, length: number): number | null => {
    const candidates = [lowest(date), ...(occupied.get(date) ?? []).map((b) => b.end)].sort((a, b) => a - b);
    for (const c of candidates) if (fits(date, c, length)) return c;
    return null;
  };

  const placed: PlanItem[] = [];
  const place = (item: DraftPlanItem, date: string, start: number, length: number) => {
    occupied.get(date)?.push({ start, end: start + length });
    placed.push({ ...item, date, start: fromMinutes(start), minutes: length });
  };

  // Timed items first, by date and start, so the model's own times win where they are free.
  const order = input.items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        a.item.date.localeCompare(b.item.date) ||
        (a.item.start ?? "99:99").localeCompare(b.item.start ?? "99:99") ||
        a.i - b.i,
    )
    .map(({ item }) => item);
  const later: DraftPlanItem[] = [];
  for (const item of order) {
    const length = item.minutes ?? DEFAULT_ITEM_MINUTES;
    if (item.start !== null && isTaskTime(item.start) && occupied.has(item.date) && fits(item.date, toMinutes(item.start), length)) {
      place(item, item.date, toMinutes(item.start), length);
    } else {
      later.push(item);
    }
  }

  const dropped: DraftPlanItem[] = [];
  for (const item of later) {
    const length = item.minutes ?? DEFAULT_ITEM_MINUTES;
    const from = Math.max(0, dates.indexOf(item.date));
    let done = false;
    for (const date of dates.slice(from)) {
      const start = firstGap(date, length);
      if (start === null) continue;
      place(item, date, start, length);
      done = true;
      break;
    }
    if (!done) dropped.push(item);
  }

  placed.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return { items: placed, dropped };
}
