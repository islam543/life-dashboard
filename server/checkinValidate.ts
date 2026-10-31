import type { Checkin } from "../shared/types";

/** Ranges for POST /api/checkin. The web form should use the same limits. */
export const CHECKIN_LIMITS = {
  sleepHours: { min: 0, max: 24 },
  energy: { min: 1, max: 5 },
  mood: { min: 1, max: 5 },
  workoutMinutes: { min: 0, max: 600 },
  spendQar: { min: 0, max: 1_000_000 },
  noteMaxLength: 500,
} as const;

export type CheckinValidation = { ok: true; value: Checkin } | { ok: false; error: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD for the given time in the server's local timezone. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function scale(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return Number.isInteger(value) && numberIn(value, 1, 5);
}

/**
 * Validates a check-in body. Unknown fields are dropped. `date` defaults to today (local).
 * Returns one plain-language error for the first bad field.
 */
export function validateCheckin(input: unknown, now: Date): CheckinValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Check-in must be a JSON object" };
  }
  const body = input as Record<string, unknown>;
  const today = localDateKey(now);

  let date = today;
  if (body.date !== undefined && body.date !== null && body.date !== "") {
    if (typeof body.date !== "string" || !isRealDate(body.date)) {
      return { ok: false, error: "date must be a real date written as YYYY-MM-DD" };
    }
    if (body.date > today) return { ok: false, error: "date cannot be in the future" };
    date = body.date;
  }

  const L = CHECKIN_LIMITS;
  if (!numberIn(body.sleepHours, L.sleepHours.min, L.sleepHours.max)) {
    return { ok: false, error: "sleepHours must be a number from 0 to 24" };
  }
  if (!scale(body.energy)) return { ok: false, error: "energy must be a whole number from 1 to 5" };
  if (!scale(body.mood)) return { ok: false, error: "mood must be a whole number from 1 to 5" };
  if (!numberIn(body.workoutMinutes, L.workoutMinutes.min, L.workoutMinutes.max)) {
    return { ok: false, error: "workoutMinutes must be a number from 0 to 600" };
  }
  if (!numberIn(body.spendQar, L.spendQar.min, L.spendQar.max)) {
    return { ok: false, error: "spendQar must be a number from 0 to 1000000" };
  }

  let note: string | undefined;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") return { ok: false, error: "note must be text" };
    const trimmed = body.note.trim();
    if (trimmed.length > L.noteMaxLength) {
      return { ok: false, error: `note must be at most ${L.noteMaxLength} characters` };
    }
    if (trimmed !== "") note = trimmed;
  }

  const value: Checkin = {
    date,
    sleepHours: body.sleepHours,
    energy: body.energy,
    mood: body.mood,
    workoutMinutes: body.workoutMinutes,
    spendQar: body.spendQar,
  };
  if (note !== undefined) value.note = note;
  return { ok: true, value };
}
