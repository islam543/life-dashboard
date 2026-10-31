import type { Checkin } from "../../../shared/types";
import { dayKey, formatNumber } from "../lib/format";

// Pure logic for the daily check-in form: defaults, parsing, validation and the POST payload.
// No React, no DOM: unit tested in checkinForm.test.ts, including a parity check against the
// server's validateCheckin so the two never drift apart.

/** Same ranges as server/checkinValidate.ts CHECKIN_LIMITS. The test fails if they differ. */
export const CHECKIN_LIMITS = {
  sleepHours: { min: 0, max: 24 },
  energy: { min: 1, max: 5 },
  mood: { min: 1, max: 5 },
  workoutMinutes: { min: 0, max: 600 },
  spendQar: { min: 0, max: 1_000_000 },
  noteMaxLength: 500,
} as const;

/** How far back a check-in can be dated. Older days fall outside the snapshot's 365-day window. */
export const CHECKIN_WINDOW_DAYS = 365;

export const SLEEP_STEP = 0.5;
export const DEFAULT_SLEEP_HOURS = 7;
export const WORKOUT_PICKS = [0, 20, 30, 45, 60] as const;

export type Scale = 1 | 2 | 3 | 4 | 5;
export const SCALE: readonly Scale[] = [1, 2, 3, 4, 5];
export type WorkoutPick = (typeof WORKOUT_PICKS)[number] | "custom";

/** Words shown under each number. Text, never emoji only. */
export const ENERGY_WORDS: Record<Scale, string> = { 1: "Drained", 2: "Tired", 3: "Steady", 4: "Good", 5: "Charged" };
export const MOOD_WORDS: Record<Scale, string> = { 1: "Rough", 2: "Low", 3: "Okay", 4: "Good", 5: "Great" };

/** What the form holds. Number fields stay strings so the user's typing is never rewritten. */
export interface CheckinFormValues {
  date: string;
  sleepHours: string;
  energy: Scale | null;
  mood: Scale | null;
  workoutPick: WorkoutPick | null;
  workoutCustom: string;
  spendQar: string;
  note: string;
}

export type CheckinField = "date" | "sleepHours" | "energy" | "mood" | "workoutMinutes" | "spendQar" | "note";
export type CheckinErrors = Partial<Record<CheckinField, string>>;

/** Visual (and tab) order of the fields, for "focus the first error". */
export const FIELD_ORDER: readonly CheckinField[] = [
  "date",
  "sleepHours",
  "energy",
  "mood",
  "workoutMinutes",
  "spendQar",
  "note",
];

/** The POST body. Always carries its date, so a check-in for yesterday stays yesterday. */
export type CheckinPayload = Checkin;

export type CheckinFormResult = { ok: true; payload: CheckinPayload } | { ok: false; errors: CheckinErrors };

/* Dates ---------------------------------------------------------------------------------------- */

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" to a local Date at midnight, or null when it is not a real calendar day. */
export function parseDayKey(key: string): Date | null {
  const match = DAY_KEY.exec(key);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** Day key `n` days after `key` (negative for before). Returns `key` unchanged if it is not a date. */
export function addDays(key: string, n: number): string {
  const date = parseDayKey(key);
  if (!date) return key;
  return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + n));
}

/** Earliest day the form accepts: the first day of the 365-day window that ends today. */
export function earliestCheckinDate(today: string): string {
  return addDays(today, -(CHECKIN_WINDOW_DAYS - 1));
}

/* Numbers -------------------------------------------------------------------------------------- */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function toAsciiDigits(value: string): string {
  return value.replace(ARABIC_DIGITS, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

const THOUSANDS_COMMA = /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/;
const THOUSANDS_DOT = /^[+-]?\d{1,3}(\.\d{3})+(,\d*)?$/;
const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Forgiving number parser for typed amounts.
 * Returns null for an empty field and NaN for text that is not a number.
 * Accepts a decimal comma ("7,5", "12,50"), thousands separators ("1,250", "1,250.75", "1.250,75"),
 * spaces, Arabic-Indic digits and a "QAR" or "QR" prefix or suffix.
 * A lone comma before exactly three digits ("1,250") is read as thousands.
 */
export function parseDecimal(raw: string): number | null {
  let s = toAsciiDigits(raw)
    .replace(/٫/g, ".") // Arabic decimal separator
    .replace(/٬/g, ",") // Arabic thousands separator
    .replace(/\s+/g, "")
    .replace(/^(qar|qr)/i, "")
    .replace(/(qar|qr)$/i, "");
  if (s === "") return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") < s.lastIndexOf(".")) {
      if (!THOUSANDS_COMMA.test(s)) return Number.NaN;
      s = s.replace(/,/g, "");
    } else {
      if (!THOUSANDS_DOT.test(s)) return Number.NaN;
      s = s.replace(/\./g, "").replace(",", ".");
    }
  } else if (hasComma) {
    if (THOUSANDS_COMMA.test(s)) s = s.replace(/,/g, "");
    else if ((s.match(/,/g) ?? []).length === 1) s = s.replace(",", ".");
    else return Number.NaN;
  } else if (hasDot && (s.match(/\./g) ?? []).length > 1) {
    if (!THOUSANDS_DOT.test(s)) return Number.NaN;
    s = s.replace(/\./g, "");
  }

  return PLAIN.test(s) ? Number(s) : Number.NaN;
}

/** 7 -> "7", 7.5 -> "7.5", 6.25 -> "6.25". */
export function formatHours(hours: number): string {
  return String(Math.round(hours * 100) / 100);
}

/**
 * One stepper press on the sleep field: snaps to the next 0.5 h in that direction, clamped to 0..24.
 * An empty or unreadable field starts from `fallback`.
 */
export function stepSleep(raw: string, direction: 1 | -1, fallback = DEFAULT_SLEEP_HOURS): string {
  const parsed = parseDecimal(raw);
  const { min, max } = CHECKIN_LIMITS.sleepHours;
  if (parsed === null || Number.isNaN(parsed)) return formatHours(fallback);
  const halves = parsed / SLEEP_STEP;
  const next = direction > 0 ? (Math.floor(halves + 1e-9) + 1) * SLEEP_STEP : (Math.ceil(halves - 1e-9) - 1) * SLEEP_STEP;
  return formatHours(Math.min(max, Math.max(min, next)));
}

/** Length the server counts: the trimmed note. */
export function noteLength(note: string): number {
  return note.trim().length;
}

/* Defaults ------------------------------------------------------------------------------------- */

export function findCheckin(checkins: readonly Checkin[], date: string): Checkin | undefined {
  return checkins.find((c) => c.date === date);
}

/** The most recent check-in dated before `date`, whatever order the list is in. */
export function lastCheckinBefore(checkins: readonly Checkin[], date: string): Checkin | undefined {
  let best: Checkin | undefined;
  for (const c of checkins) {
    if (c.date < date && (!best || c.date > best.date)) best = c;
  }
  return best;
}

function workoutPickFor(minutes: number): WorkoutPick {
  return (WORKOUT_PICKS as readonly number[]).includes(minutes) ? (minutes as WorkoutPick) : "custom";
}

/** Form values for an existing check-in (editing). */
export function valuesFromCheckin(c: Checkin): CheckinFormValues {
  const pick = workoutPickFor(c.workoutMinutes);
  return {
    date: c.date,
    sleepHours: formatHours(c.sleepHours),
    energy: c.energy,
    mood: c.mood,
    workoutPick: pick,
    workoutCustom: pick === "custom" ? String(c.workoutMinutes) : "",
    spendQar: String(c.spendQar),
    note: c.note ?? "",
  };
}

/**
 * Starting values for `date`: that day's saved check-in when there is one (editing), otherwise a
 * blank form whose sleep starts at the last check-in's value, or 7 h. Energy, mood, workout and
 * spend start empty on a new day so yesterday's answers never get saved by accident.
 */
export function initialValues(checkins: readonly Checkin[], date: string): CheckinFormValues {
  const saved = findCheckin(checkins, date);
  if (saved) return valuesFromCheckin(saved);
  const last = lastCheckinBefore(checkins, date);
  return {
    date,
    sleepHours: formatHours(last ? last.sleepHours : DEFAULT_SLEEP_HOURS),
    energy: null,
    mood: null,
    workoutPick: null,
    workoutCustom: "",
    spendQar: "",
    note: "",
  };
}

/* Validation ----------------------------------------------------------------------------------- */

function inRange(n: number, range: { min: number; max: number }): boolean {
  return n >= range.min && n <= range.max;
}

function isScale(value: unknown): value is Scale {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Minutes the workout fields stand for: null when nothing is chosen or typed, NaN when unreadable. */
export function workoutMinutesOf(values: Pick<CheckinFormValues, "workoutPick" | "workoutCustom">): number | null {
  if (values.workoutPick === null) return null;
  if (values.workoutPick === "custom") return parseDecimal(values.workoutCustom);
  return values.workoutPick;
}

/** Every field's error for the current values. Same ranges as the server; wording for people. */
export function checkinErrors(values: CheckinFormValues, today: string): CheckinErrors {
  const L = CHECKIN_LIMITS;
  const errors: CheckinErrors = {};

  if (values.date === "") errors.date = "Enter the day this check-in is for";
  else if (!parseDayKey(values.date)) errors.date = "Enter a real date";
  else if (values.date > today) errors.date = "Choose today or an earlier day";
  else if (values.date < earliestCheckinDate(today)) errors.date = "Choose a day within the last year";

  const sleep = parseDecimal(values.sleepHours);
  if (sleep === null) errors.sleepHours = "Enter how many hours you slept";
  else if (Number.isNaN(sleep)) errors.sleepHours = "Enter sleep as a number of hours, like 7.5";
  else if (!inRange(sleep, L.sleepHours)) errors.sleepHours = "Sleep must be between 0 and 24 hours";

  if (!isScale(values.energy)) errors.energy = "Choose your energy from 1 to 5";
  if (!isScale(values.mood)) errors.mood = "Choose your mood from 1 to 5";

  if (values.workoutPick === null) {
    errors.workoutMinutes = "Choose your workout minutes, 0 if you did not train";
  } else {
    const minutes = workoutMinutesOf(values);
    if (minutes === null) errors.workoutMinutes = "Enter your workout minutes";
    else if (Number.isNaN(minutes)) errors.workoutMinutes = "Enter workout minutes as a number, like 25";
    else if (!inRange(minutes, L.workoutMinutes)) errors.workoutMinutes = "Workout must be between 0 and 600 minutes";
  }

  const spend = parseDecimal(values.spendQar);
  if (spend === null) errors.spendQar = "Enter what you spent in QAR, 0 if nothing";
  else if (Number.isNaN(spend)) errors.spendQar = "Enter an amount like 45 or 45.50";
  else if (!inRange(spend, L.spendQar)) {
    errors.spendQar = `Spend must be between 0 and ${formatNumber(L.spendQar.max)} QAR`;
  }

  if (noteLength(values.note) > L.noteMaxLength) {
    errors.note = `Note must be ${L.noteMaxLength} characters or fewer`;
  }

  return errors;
}

/** The POST body for values that passed `checkinErrors`. The note is trimmed and left out when blank. */
export function buildPayload(values: CheckinFormValues): CheckinPayload {
  const payload: CheckinPayload = {
    date: values.date,
    sleepHours: parseDecimal(values.sleepHours) ?? Number.NaN,
    energy: values.energy as Scale,
    mood: values.mood as Scale,
    workoutMinutes: workoutMinutesOf(values) ?? Number.NaN,
    spendQar: parseDecimal(values.spendQar) ?? Number.NaN,
  };
  const note = values.note.trim();
  if (note !== "") payload.note = note;
  return payload;
}

/** Validate, then build the payload. `today` is the local day key ("YYYY-MM-DD"). */
export function validateCheckinForm(values: CheckinFormValues, today: string): CheckinFormResult {
  const errors = checkinErrors(values, today);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, payload: buildPayload(values) };
}

/** First field with an error, in visual order. */
export function firstErrorField(errors: CheckinErrors): CheckinField | null {
  return FIELD_ORDER.find((f) => errors[f] !== undefined) ?? null;
}
