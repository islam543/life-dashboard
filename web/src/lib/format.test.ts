import { describe, expect, it } from "vitest";
import {
  dayKey,
  detailTitle,
  formatCompact,
  formatMinutes,
  formatNumber,
  formatQar,
  greeting,
  plural,
  relativeTime,
} from "./format";

// Local-time constructor so the tests do not depend on the machine's timezone.
const now = new Date(2026, 9, 30, 14, 0, 0);
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("says just now under 45 seconds", () => {
    expect(relativeTime(ago(10_000), now)).toBe("just now");
    expect(relativeTime(ago(44_000), now)).toBe("just now");
  });

  it("counts minutes and hours", () => {
    expect(relativeTime(ago(50_000), now)).toBe("1 min ago");
    expect(relativeTime(ago(5 * MIN), now)).toBe("5 min ago");
    expect(relativeTime(ago(59 * MIN), now)).toBe("59 min ago");
    expect(relativeTime(ago(3 * HOUR + 20 * MIN), now)).toBe("3 h ago");
  });

  it("says yesterday, then days ago", () => {
    expect(relativeTime(ago(DAY + HOUR), now)).toBe("yesterday");
    expect(relativeTime(ago(2 * DAY), now)).toBe("2 days ago");
    expect(relativeTime(ago(29 * DAY), now)).toBe("29 days ago");
  });

  it("falls back to a date after 30 days", () => {
    expect(relativeTime(new Date(2026, 2, 12, 9), now)).toBe("12 Mar");
    expect(relativeTime(new Date(2025, 2, 12, 9), now)).toBe("12 Mar 2025");
  });

  it("handles the future", () => {
    expect(relativeTime(new Date(now.getTime() + 10 * MIN), now)).toBe("in 10 min");
    expect(relativeTime(new Date(now.getTime() + 5 * HOUR), now)).toBe("in 5 h");
    expect(relativeTime(new Date(now.getTime() + DAY + HOUR), now)).toBe("tomorrow");
    expect(relativeTime(new Date(now.getTime() + 4 * DAY), now)).toBe("in 4 days");
  });

  it("accepts ISO strings and survives bad input", () => {
    expect(relativeTime(ago(2 * DAY).toISOString(), now)).toBe("2 days ago");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("not a date", now)).toBe("unknown time");
  });
});

describe("formatMinutes", () => {
  it("formats hours and minutes", () => {
    expect(formatMinutes(200)).toBe("3h 20m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(1500)).toBe("25h");
  });

  it("rounds and clamps", () => {
    expect(formatMinutes(59.6)).toBe("1h");
    expect(formatMinutes(-30)).toBe("0m");
    expect(formatMinutes(Number.NaN)).toBe("0m");
  });
});

describe("formatQar", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatQar(1250)).toBe("QAR 1,250");
    expect(formatQar(12.5)).toBe("QAR 12.50");
    expect(formatQar(0)).toBe("QAR 0");
    expect(formatQar(1_000_000)).toBe("QAR 1,000,000");
  });

  it("puts the sign before the currency", () => {
    expect(formatQar(-40)).toBe("-QAR 40");
  });
});

describe("greeting", () => {
  it("picks the greeting by local hour", () => {
    expect(greeting(5)).toBe("Good morning");
    expect(greeting(11)).toBe("Good morning");
    expect(greeting(12)).toBe("Good afternoon");
    expect(greeting(16)).toBe("Good afternoon");
    expect(greeting(17)).toBe("Good evening");
    expect(greeting(23)).toBe("Good evening");
    expect(greeting(0)).toBe("Good evening");
    expect(greeting(4)).toBe("Good evening");
  });
});

describe("numbers and labels", () => {
  it("groups thousands", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(7.25, 1)).toBe("7.3");
  });

  it("compacts large counts", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1234)).toBe("1.2k");
    expect(formatCompact(12_000)).toBe("12k");
    expect(formatCompact(2_400_000)).toBe("2.4M");
  });

  it("pluralizes", () => {
    expect(plural(1, "item")).toBe("1 item");
    expect(plural(3, "item")).toBe("3 items");
    expect(plural(1200, "commit")).toBe("1,200 commits");
  });

  it("builds local day keys", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("names detail views", () => {
    expect(detailTitle("work")).toBe("Work");
    expect(detailTitle("email")).toBe("Calendar and email");
  });
});
