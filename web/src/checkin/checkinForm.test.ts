import { describe, expect, it } from "vitest";
import type { Checkin } from "../../../shared/types";
import { CHECKIN_LIMITS as SERVER_LIMITS, validateCheckin } from "../../../server/checkinValidate";
import { dayKey } from "../lib/format";
import {
  addDays,
  buildPayload,
  CHECKIN_LIMITS,
  checkinErrors,
  earliestCheckinDate,
  firstErrorField,
  initialValues,
  lastCheckinBefore,
  noteLength,
  parseDayKey,
  parseDecimal,
  stepSleep,
  validateCheckinForm,
  valuesFromCheckin,
  type CheckinFormValues,
} from "./checkinForm";

// Local-time constructor so the tests do not depend on the machine's timezone.
const now = new Date(2026, 9, 30, 21, 0, 0);
const today = dayKey(now); // 2026-10-30

const check = (date: string, patch: Partial<Checkin> = {}): Checkin => ({
  date,
  sleepHours: 7,
  energy: 3,
  mood: 3,
  workoutMinutes: 0,
  spendQar: 0,
  ...patch,
});

const filled = (patch: Partial<CheckinFormValues> = {}): CheckinFormValues => ({
  date: today,
  sleepHours: "7.5",
  energy: 4,
  mood: 3,
  workoutPick: 30,
  workoutCustom: "",
  spendQar: "45",
  note: "",
  ...patch,
});

describe("CHECKIN_LIMITS", () => {
  it("matches the server ranges exactly", () => {
    expect(CHECKIN_LIMITS).toEqual(SERVER_LIMITS);
  });
});

describe("parseDecimal", () => {
  it("returns null for an empty field and NaN for text", () => {
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("   ")).toBeNull();
    expect(Number.isNaN(parseDecimal("abc"))).toBe(true);
    expect(Number.isNaN(parseDecimal("7h"))).toBe(true);
    expect(Number.isNaN(parseDecimal("1,2,3"))).toBe(true);
    expect(Number.isNaN(parseDecimal("1.2.3"))).toBe(true);
  });

  it("reads plain numbers", () => {
    expect(parseDecimal("7")).toBe(7);
    expect(parseDecimal("7.5")).toBe(7.5);
    expect(parseDecimal(".5")).toBe(0.5);
    expect(parseDecimal(" 45 ")).toBe(45);
    expect(parseDecimal("-5")).toBe(-5);
  });

  it("reads a decimal comma", () => {
    expect(parseDecimal("7,5")).toBe(7.5);
    expect(parseDecimal("12,50")).toBe(12.5);
    expect(parseDecimal("0,25")).toBe(0.25);
    expect(parseDecimal("1,2345")).toBe(1.2345);
  });

  it("reads thousands separators", () => {
    expect(parseDecimal("1,250")).toBe(1250);
    expect(parseDecimal("1,000,000")).toBe(1_000_000);
    expect(parseDecimal("1,250.75")).toBe(1250.75);
    expect(parseDecimal("1.250,75")).toBe(1250.75);
    expect(parseDecimal("1 250")).toBe(1250);
  });

  it("accepts a currency prefix or suffix and Arabic-Indic digits", () => {
    expect(parseDecimal("QAR 45")).toBe(45);
    expect(parseDecimal("45 qar")).toBe(45);
    expect(parseDecimal("QR45.5")).toBe(45.5);
    expect(parseDecimal("٤٥٫٥")).toBe(45.5);
  });
});

describe("stepSleep", () => {
  it("steps by half an hour", () => {
    expect(stepSleep("7", 1)).toBe("7.5");
    expect(stepSleep("7.5", 1)).toBe("8");
    expect(stepSleep("7", -1)).toBe("6.5");
  });

  it("snaps an off-step value to the next half hour", () => {
    expect(stepSleep("7.25", 1)).toBe("7.5");
    expect(stepSleep("7.25", -1)).toBe("7");
    expect(stepSleep("7,2", 1)).toBe("7.5");
  });

  it("clamps to 0 and 24", () => {
    expect(stepSleep("24", 1)).toBe("24");
    expect(stepSleep("0", -1)).toBe("0");
    expect(stepSleep("30", -1)).toBe("24");
  });

  it("starts from the fallback when the field is empty or unreadable", () => {
    expect(stepSleep("", 1)).toBe("7");
    expect(stepSleep("abc", -1, 6.5)).toBe("6.5");
  });
});

describe("dates", () => {
  it("parses only real days", () => {
    expect(parseDayKey("2026-10-30")?.getDate()).toBe(30);
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("30/10/2026")).toBeNull();
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("keeps the earliest day inside the 365-day window", () => {
    expect(earliestCheckinDate("2026-10-30")).toBe("2025-10-31");
  });
});

describe("defaults", () => {
  it("starts a first-ever check-in at 7 h with everything else empty", () => {
    expect(initialValues([], today)).toEqual({
      date: today,
      sleepHours: "7",
      energy: null,
      mood: null,
      workoutPick: null,
      workoutCustom: "",
      spendQar: "",
      note: "",
    });
  });

  it("takes sleep from the most recent earlier check-in only", () => {
    const list = [check("2026-10-27", { sleepHours: 8 }), check("2026-10-29", { sleepHours: 6.5, mood: 5 })];
    const values = initialValues(list, today);
    expect(values.sleepHours).toBe("6.5");
    expect(values.mood).toBeNull();
    expect(values.spendQar).toBe("");
    // Backfilling the 28th looks at the 27th, not the later 29th.
    expect(initialValues(list, "2026-10-28").sleepHours).toBe("8");
  });

  it("finds the latest earlier check-in whatever the list order", () => {
    const list = [check("2026-10-29"), check("2026-10-25"), check("2026-10-28")];
    expect(lastCheckinBefore(list, today)?.date).toBe("2026-10-29");
    expect(lastCheckinBefore(list, "2026-10-25")).toBeUndefined();
  });

  it("prefills every field when the day already has a check-in", () => {
    const saved = check(today, { sleepHours: 6.5, energy: 2, mood: 4, workoutMinutes: 45, spendQar: 120.5, note: "Long day" });
    expect(initialValues([check("2026-10-29"), saved], today)).toEqual({
      date: today,
      sleepHours: "6.5",
      energy: 2,
      mood: 4,
      workoutPick: 45,
      workoutCustom: "",
      spendQar: "120.5",
      note: "Long day",
    });
  });

  it("maps workout minutes outside the quick picks to custom", () => {
    expect(valuesFromCheckin(check(today, { workoutMinutes: 25 }))).toMatchObject({
      workoutPick: "custom",
      workoutCustom: "25",
    });
    expect(valuesFromCheckin(check(today, { workoutMinutes: 0 }))).toMatchObject({ workoutPick: 0, workoutCustom: "" });
  });
});

describe("validation", () => {
  it("accepts a complete form", () => {
    expect(checkinErrors(filled(), today)).toEqual({});
  });

  it("asks for every required answer on a blank form, in visual order", () => {
    const errors = checkinErrors(initialValues([], today), today);
    expect(Object.keys(errors).sort()).toEqual(["energy", "mood", "spendQar", "workoutMinutes"]);
    expect(firstErrorField(errors)).toBe("energy");
    expect(errors.spendQar).toBe("Enter what you spent in QAR, 0 if nothing");
  });

  it("checks the date", () => {
    expect(checkinErrors(filled({ date: "" }), today).date).toBe("Enter the day this check-in is for");
    expect(checkinErrors(filled({ date: "2026-02-30" }), today).date).toBe("Enter a real date");
    expect(checkinErrors(filled({ date: "2026-10-31" }), today).date).toBe("Choose today or an earlier day");
    expect(checkinErrors(filled({ date: "2025-10-30" }), today).date).toBe("Choose a day within the last year");
    expect(checkinErrors(filled({ date: "2025-10-31" }), today).date).toBeUndefined();
    expect(checkinErrors(filled({ date: "2026-10-29" }), today)).toEqual({});
  });

  it("checks sleep", () => {
    expect(checkinErrors(filled({ sleepHours: "" }), today).sleepHours).toBe("Enter how many hours you slept");
    expect(checkinErrors(filled({ sleepHours: "seven" }), today).sleepHours).toBe(
      "Enter sleep as a number of hours, like 7.5",
    );
    expect(checkinErrors(filled({ sleepHours: "25" }), today).sleepHours).toBe("Sleep must be between 0 and 24 hours");
    expect(checkinErrors(filled({ sleepHours: "0" }), today).sleepHours).toBeUndefined();
    expect(checkinErrors(filled({ sleepHours: "24" }), today).sleepHours).toBeUndefined();
  });

  it("checks workout picks and custom minutes", () => {
    expect(checkinErrors(filled({ workoutPick: null }), today).workoutMinutes).toBe(
      "Choose your workout minutes, 0 if you did not train",
    );
    expect(checkinErrors(filled({ workoutPick: 0 }), today).workoutMinutes).toBeUndefined();
    expect(checkinErrors(filled({ workoutPick: "custom", workoutCustom: "" }), today).workoutMinutes).toBe(
      "Enter your workout minutes",
    );
    expect(checkinErrors(filled({ workoutPick: "custom", workoutCustom: "a lot" }), today).workoutMinutes).toBe(
      "Enter workout minutes as a number, like 25",
    );
    expect(checkinErrors(filled({ workoutPick: "custom", workoutCustom: "601" }), today).workoutMinutes).toBe(
      "Workout must be between 0 and 600 minutes",
    );
  });

  it("checks spend", () => {
    expect(checkinErrors(filled({ spendQar: "lots" }), today).spendQar).toBe("Enter an amount like 45 or 45.50");
    expect(checkinErrors(filled({ spendQar: "-5" }), today).spendQar).toBe("Spend must be between 0 and 1,000,000 QAR");
    expect(checkinErrors(filled({ spendQar: "0" }), today).spendQar).toBeUndefined();
    expect(checkinErrors(filled({ spendQar: "12,5" }), today).spendQar).toBeUndefined();
  });

  it("checks the note length on the trimmed text", () => {
    expect(checkinErrors(filled({ note: "x".repeat(500) }), today).note).toBeUndefined();
    expect(checkinErrors(filled({ note: `  ${"x".repeat(500)}  ` }), today).note).toBeUndefined();
    expect(checkinErrors(filled({ note: "x".repeat(501) }), today).note).toBe("Note must be 500 characters or fewer");
    expect(noteLength("  hi  ")).toBe(2);
  });
});

describe("payload", () => {
  it("builds numbers from the typed text, decimal comma included", () => {
    const result = validateCheckinForm(filled({ sleepHours: "6,5", spendQar: "1,250.75", note: "  Gym and groceries " }), today);
    expect(result).toEqual({
      ok: true,
      payload: {
        date: today,
        sleepHours: 6.5,
        energy: 4,
        mood: 3,
        workoutMinutes: 30,
        spendQar: 1250.75,
        note: "Gym and groceries",
      },
    });
  });

  it("reads a decimal comma in spend as cents", () => {
    expect(buildPayload(filled({ spendQar: "12,5" })).spendQar).toBe(12.5);
  });

  it("uses custom workout minutes and leaves a blank note out", () => {
    const payload = buildPayload(filled({ workoutPick: "custom", workoutCustom: "25", note: "   " }));
    expect(payload.workoutMinutes).toBe(25);
    expect("note" in payload).toBe(false);
  });

  it("keeps the chosen day so a backfill stays on that day", () => {
    expect(buildPayload(filled({ date: "2026-10-29" })).date).toBe("2026-10-29");
  });

  it("returns errors instead of a payload when anything is wrong", () => {
    const result = validateCheckinForm(filled({ mood: null }), today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["mood"]);
  });
});

describe("parity with the server", () => {
  // The form must never send something the server rejects, nor block something it accepts
  // (inside the 365-day window the snapshot shows).
  const cases: [string, Partial<CheckinFormValues>][] = [
    ["complete", {}],
    ["yesterday", { date: addDays(today, -1) }],
    ["future", { date: addDays(today, 1) }],
    ["sleep 0", { sleepHours: "0" }],
    ["sleep 24", { sleepHours: "24" }],
    ["sleep 24.5", { sleepHours: "24.5" }],
    ["sleep negative", { sleepHours: "-0.5" }],
    ["workout 0", { workoutPick: 0 }],
    ["workout 600", { workoutPick: "custom", workoutCustom: "600" }],
    ["workout 600.5", { workoutPick: "custom", workoutCustom: "600,5" }],
    ["spend 0", { spendQar: "0" }],
    ["spend max", { spendQar: "1,000,000" }],
    ["spend over max", { spendQar: "1000000.01" }],
    ["note 500", { note: "y".repeat(500) }],
    ["note 501", { note: "y".repeat(501) }],
  ];

  for (const [name, patch] of cases) {
    it(`agrees on: ${name}`, () => {
      const values = filled(patch);
      const client = validateCheckinForm(values, today);
      const server = validateCheckin(buildPayload(values), now);
      expect(client.ok).toBe(server.ok);
      if (client.ok && server.ok) expect(server.value).toEqual(client.payload);
    });
  }
});
