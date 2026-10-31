import type { Checkin } from "../../shared/types";
import { localDateKey, validateCheckin } from "../checkinValidate";
import { FILES } from "../store";
import type { Collector } from "./types";

/** How many days of check-ins the snapshot carries, today included. */
export const CHECKIN_WINDOW_DAYS = 365;

export interface CheckinSelection {
  /** Valid check-ins inside the window, one per date, sorted by date ascending. */
  checkins: Checkin[];
  checkedInToday: boolean;
  /** Entries dropped because a field was missing or out of range. */
  skipped: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** First local date (YYYY-MM-DD) inside the window that ends today. */
export function windowStart(now: Date): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (CHECKIN_WINDOW_DAYS - 1)));
}

/**
 * Pure: picks the check-ins the snapshot shows from the raw checkins.json content.
 * Each entry is re-validated with the same rules as POST /api/checkin. Dates outside
 * [today - 364, today] are left out silently; a later duplicate of a date wins.
 */
export function selectCheckins(raw: unknown, now: Date): CheckinSelection {
  const today = localDateKey(now);
  const from = windowStart(now);
  const byDate = new Map<string, Checkin>();
  let skipped = 0;
  for (const entry of isArray(raw) ? raw : []) {
    const date = typeof entry === "object" && entry !== null ? (entry as { date?: unknown }).date : undefined;
    // validateCheckin treats a missing date as today, so a stored entry must carry its own.
    if (typeof date !== "string" || !DATE.test(date)) {
      skipped++;
      continue;
    }
    if (date < from || date > today) continue;
    const result = validateCheckin(entry, now);
    if (!result.ok) {
      skipped++;
      continue;
    }
    byDate.set(result.value.date, result.value);
  }
  const checkins = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { checkins, checkedInToday: byDate.has(today), skipped };
}

export const checkinsCollector: Collector<"checkins"> = {
  key: "checkins",
  async collect(ctx) {
    const raw = await ctx.store.read<unknown[]>(FILES.checkins, [], isArray);
    const { checkins, checkedInToday, skipped } = selectCheckins(raw, ctx.now);
    return {
      status: "ok",
      ...(skipped > 0
        ? { message: `Skipped ${skipped} check-in${skipped === 1 ? "" : "s"} with missing or invalid fields in ${FILES.checkins}` }
        : {}),
      data: { checkins, checkedInToday },
    };
  },
};
