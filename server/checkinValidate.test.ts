import { describe, expect, it } from "vitest";
import { localDateKey, validateCheckin } from "./checkinValidate";

// 30 Oct 2026, 21:15 local time.
const NOW = new Date(2026, 9, 30, 21, 15);

const valid = {
  date: "2026-10-29",
  sleepHours: 7.5,
  energy: 4,
  mood: 3,
  workoutMinutes: 45,
  spendQar: 120.5,
  note: "  good day  ",
};

function errorFor(patch: Record<string, unknown>): string {
  const result = validateCheckin({ ...valid, ...patch }, NOW);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(patch)}`);
  return result.error;
}

describe("validateCheckin", () => {
  it("accepts a valid check-in, trims the note and drops unknown fields", () => {
    const result = validateCheckin({ ...valid, extra: "x" }, NOW);
    expect(result).toEqual({
      ok: true,
      value: { date: "2026-10-29", sleepHours: 7.5, energy: 4, mood: 3, workoutMinutes: 45, spendQar: 120.5, note: "good day" },
    });
  });

  it("defaults the date to today (local)", () => {
    for (const date of [undefined, null, ""]) {
      const result = validateCheckin({ ...valid, date }, NOW);
      expect(result.ok && result.value.date).toBe("2026-10-30");
    }
    expect(localDateKey(NOW)).toBe("2026-10-30");
  });

  it("accepts today and the range edges", () => {
    const edges = [
      { date: "2026-10-30", sleepHours: 0, energy: 1, mood: 1, workoutMinutes: 0, spendQar: 0 },
      { date: "2026-10-30", sleepHours: 24, energy: 5, mood: 5, workoutMinutes: 600, spendQar: 1_000_000, note: "x".repeat(500) },
    ];
    for (const body of edges) expect(validateCheckin(body, NOW).ok).toBe(true);
  });

  it("omits an empty or missing note", () => {
    const blank = validateCheckin({ ...valid, note: "   " }, NOW);
    expect(blank.ok && "note" in blank.value).toBe(false);
    const missing = validateCheckin({ ...valid, note: undefined }, NOW);
    expect(missing.ok && "note" in missing.value).toBe(false);
  });

  it("rejects a future date", () => {
    expect(errorFor({ date: "2026-10-31" })).toMatch(/future/);
    expect(errorFor({ date: "2027-01-01" })).toMatch(/future/);
  });

  it("rejects malformed or impossible dates", () => {
    for (const date of ["2026-02-30", "2026-13-01", "30-10-2026", "2026-1-5", "today", 20261030]) {
      expect(errorFor({ date })).toMatch(/YYYY-MM-DD/);
    }
  });

  it.each([
    ["sleepHours", -0.1],
    ["sleepHours", 24.5],
    ["sleepHours", "7"],
    ["sleepHours", undefined],
    ["energy", 0],
    ["energy", 6],
    ["energy", 3.5],
    ["energy", "3"],
    ["mood", 0],
    ["mood", 6],
    ["mood", 2.2],
    ["mood", null],
    ["workoutMinutes", -1],
    ["workoutMinutes", 601],
    ["workoutMinutes", "30"],
    ["spendQar", -5],
    ["spendQar", 1_000_001],
    ["spendQar", "100"],
    ["note", 42],
    ["note", "x".repeat(501)],
  ])("rejects %s = %j", (field, value) => {
    expect(errorFor({ [field]: value })).toContain(field);
  });

  it("rejects bodies that are not objects", () => {
    for (const body of [null, [], "text", 5, undefined]) {
      const result = validateCheckin(body, NOW);
      expect(result.ok).toBe(false);
    }
  });
});
