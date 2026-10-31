import { describe, expect, it } from "vitest";
import type { Checkin, JiraIssue, NeedsYouItem, NextMove, PullRequest, SourceState } from "../../../shared/types";
import {
  addDays,
  availability,
  compareWeeks,
  describeDelta,
  dueLabel,
  dueRemaining,
  formatCount,
  formatHours,
  isWaitingOnYou,
  jiraSummary,
  lastDayKeys,
  needsYouCoverage,
  needsYouOverflow,
  newSinceLastVisit,
  openMoves,
  parseSeenIds,
  prQueue,
  rankNeedsYou,
  seriesFor,
  share,
  shortDay,
  sleepAverage,
  sleepSeries,
  streakCaption,
  streakSummary,
  sumByDay,
  urgencyCounts,
  weekStart,
  weekStartIndex,
} from "./kpis";
import { dayKey } from "./format";

// Local-time constructors so the tests do not depend on the machine's timezone.
// 29 Oct 2026 is a Thursday; the week began on Sunday 25 Oct.
const thu = new Date(2026, 9, 29, 14, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const key = (y: number, m: number, d: number) => dayKey(new Date(y, m - 1, d));

function checkin(date: string, sleepHours: number): Checkin {
  return { date, sleepHours, energy: 3, mood: 3, workoutMinutes: 0, spendQar: 0 };
}

function need(id: string, urgency: "red" | "amber", dueAt?: string): NeedsYouItem {
  return { id, urgency, area: "work", title: id, detail: "", ...(dueAt ? { dueAt } : {}) };
}

describe("week boundary (weeks start on Sunday)", () => {
  it("finds this week's Sunday", () => {
    expect(dayKey(weekStart(thu))).toBe("2026-10-25");
  });

  it("treats Sunday as the first day and Saturday as the last", () => {
    expect(dayKey(weekStart(new Date(2026, 9, 25, 0, 0)))).toBe("2026-10-25");
    expect(dayKey(weekStart(new Date(2026, 9, 31, 23, 59)))).toBe("2026-10-25");
    expect(dayKey(weekStart(new Date(2026, 10, 1, 0, 1)))).toBe("2026-11-01");
  });

  it("crosses month and year boundaries", () => {
    expect(dayKey(weekStart(new Date(2026, 10, 3, 9)))).toBe("2026-11-01");
    expect(dayKey(weekStart(new Date(2027, 0, 1, 9)))).toBe("2026-12-27");
  });

  it("places the week start inside the 14-day window", () => {
    expect(weekStartIndex(thu)).toBe(9);
    expect(weekStartIndex(new Date(2026, 9, 25, 8))).toBe(13);
    expect(weekStartIndex(new Date(2026, 9, 31, 8))).toBe(7);
    expect(lastDayKeys(thu)[weekStartIndex(thu)]).toBe("2026-10-25");
  });

  it("lists 14 day keys ending today, oldest first", () => {
    const keys = lastDayKeys(thu);
    expect(keys).toHaveLength(14);
    expect(keys[0]).toBe("2026-10-16");
    expect(keys[13]).toBe("2026-10-29");
    expect(dayKey(addDays(new Date(2026, 1, 28), 1))).toBe("2026-03-01");
  });
});

describe("this week vs last week", () => {
  const byDay = {
    [key(2026, 10, 18)]: 60, // last Sunday
    [key(2026, 10, 22)]: 30, // last Thursday (same weekday as today)
    [key(2026, 10, 23)]: 500, // last Friday: after "the same point", excluded
    [key(2026, 10, 24)]: 500, // last Saturday: excluded
    [key(2026, 10, 25)]: 120, // this Sunday
    [key(2026, 10, 29)]: 45, // today
    [key(2026, 10, 30)]: 999, // tomorrow (bad data): excluded
  };

  it("compares Sunday-to-today with the same days of last week", () => {
    expect(compareWeeks(byDay, thu)).toEqual({ thisWeek: 165, lastWeek: 90, delta: 75 });
  });

  it("on a Sunday compares one day with last Sunday only", () => {
    expect(compareWeeks(byDay, new Date(2026, 9, 25, 10))).toEqual({ thisWeek: 120, lastWeek: 60, delta: 60 });
  });

  it("on Saturday counts the full week", () => {
    const sat = new Date(2026, 9, 24, 22);
    expect(compareWeeks(byDay, sat).thisWeek).toBe(60 + 30 + 500 + 500);
  });

  it("returns zeros, not NaN, for no data", () => {
    expect(compareWeeks({}, thu)).toEqual({ thisWeek: 0, lastWeek: 0, delta: 0 });
  });

  it("sums several repos or projects per day and skips bad values", () => {
    const merged = sumByDay([{ "2026-10-29": 3 }, { "2026-10-29": 4, "2026-10-28": 1 }, null, { "2026-10-27": Number.NaN }]);
    expect(merged).toEqual({ "2026-10-29": 7, "2026-10-28": 1 });
  });

  it("handles huge counts", () => {
    const merged = sumByDay(Array.from({ length: 40 }, () => ({ "2026-10-29": 250 })));
    expect(compareWeeks(merged, thu).thisWeek).toBe(10_000);
    expect(formatCount(10_000)).toBe("10k");
  });
});

describe("sleep average", () => {
  const checkins = [
    checkin("2026-10-29", 7), // today
    checkin("2026-10-27", 8),
    checkin("2026-10-23", 6), // 6 days ago: last day of the window
    checkin("2026-10-22", 5), // 7 days ago: previous window
    checkin("2026-10-16", 6), // 13 days ago: previous window
    checkin("2026-10-15", 1), // 14 days ago: outside both
  ];

  it("averages only the days that have a check-in", () => {
    const avg = sleepAverage(checkins, thu);
    expect(avg.current).toBeCloseTo(7, 5);
    expect(avg.currentDays).toBe(3);
    expect(avg.previous).toBeCloseTo(5.5, 5);
    expect(avg.previousDays).toBe(2);
    expect(avg.delta).toBeCloseTo(1.5, 5);
  });

  it("returns null, not 0, with no check-ins", () => {
    expect(sleepAverage([], thu)).toEqual({ current: null, previous: null, delta: null, currentDays: 0, previousDays: 0 });
    const onlyOld = sleepAverage([checkin("2026-10-20", 7)], thu);
    expect(onlyOld.current).toBeNull();
    expect(onlyOld.previous).toBe(7);
    expect(onlyOld.delta).toBeNull();
  });

  it("keeps the later entry for a day and skips invalid hours", () => {
    const avg = sleepAverage(
      [checkin("2026-10-29", 4), checkin("2026-10-29", 8), checkin("2026-10-28", Number.NaN), checkin("2026-10-27", -1)],
      thu,
    );
    expect(avg.current).toBe(8);
    expect(avg.currentDays).toBe(1);
  });
});

describe("sparkline series", () => {
  it("leaves gaps (null) for missing check-ins", () => {
    const series = sleepSeries([checkin("2026-10-29", 7.5), checkin("2026-10-26", 6), checkin("2026-10-16", 8)], thu);
    expect(series).toHaveLength(14);
    expect(series[0]).toBe(8);
    expect(series[13]).toBe(7.5);
    expect(series[10]).toBe(6);
    expect(series.filter((v) => v === null)).toHaveLength(11);
  });

  it("fills days without sessions or commits with 0", () => {
    const keys = lastDayKeys(thu, 3);
    expect(seriesFor({ "2026-10-28": 90 }, keys, 0)).toEqual([0, 90, 0]);
    expect(seriesFor({ "2026-10-28": 90 }, keys, null)).toEqual([null, 90, null]);
  });
});

describe("tile numbers", () => {
  it("formats hours and huge counts", () => {
    expect(formatHours(0)).toBe("0.0");
    expect(formatHours(12.46)).toBe("12.5");
    expect(formatHours(123.4)).toBe("123");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(9999)).toBe("9,999");
    expect(formatCount(12_345)).toBe("12.3k");
    expect(formatCount(2_400_000)).toBe("2.4M");
  });

  it("describes a change by direction and size", () => {
    expect(describeDelta(75 / 60, formatHours)).toEqual({ dir: "up", text: "1.3" });
    expect(describeDelta(-3, formatCount)).toEqual({ dir: "down", text: "3" });
    expect(describeDelta(0.01, formatHours)).toEqual({ dir: "flat", text: "0.0" });
    expect(describeDelta(Number.NaN, formatCount)).toEqual({ dir: "flat", text: "0" });
  });

  it("summarises open Jira issues", () => {
    const issue = (k: string, cat: JiraIssue["statusCategory"], due: string | null, blocked = false): JiraIssue => ({
      key: k, summary: k, status: "", statusCategory: cat, priority: "", dueDate: due, updated: "", project: "", url: "", blocked,
    });
    const s = jiraSummary(
      [
        issue("A-1", "inprogress", "2026-10-28", true),
        issue("A-2", "todo", "2026-10-29"),
        issue("A-3", "todo", null),
        issue("A-4", "done", "2026-01-01"),
      ],
      thu,
    );
    expect(s).toEqual({ open: 3, inProgress: 1, todo: 2, blocked: 1, overdue: 1 });
    expect(jiraSummary([], thu).open).toBe(0);
  });

  it("counts PRs waiting on your review with an age dot each", () => {
    const pr = (n: number, role: PullRequest["role"], ageH: number, isDraft = false): PullRequest => ({
      repo: "acme/widget", number: n, title: `PR ${n}`, url: "", author: "x", role,
      createdAt: new Date(thu.getTime() - ageH * HOUR).toISOString(), isDraft, checks: "none",
    });
    const q = prQueue(
      [pr(1, "reviewer", 2), pr(2, "reviewer", 30), pr(3, "reviewer", 24 * 20), pr(4, "author", 5), pr(5, "reviewer", 24 * 40, true)],
      thu,
    );
    expect(q.count).toBe(3); // your own PR is not waiting on you, and neither is a draft (same rule as Needs you)
    expect(q.dots.map((d) => d.key)).not.toContain("acme/widget#5");
    expect(q.oldestDays).toBe(20); // the 40-day-old draft does not count as the oldest
    expect(isWaitingOnYou(pr(6, "reviewer", 1, true))).toBe(false);
    expect(isWaitingOnYou(pr(7, "reviewer", 1))).toBe(true);
    const byKey = Object.fromEntries(q.dots.map((d) => [d.key, d]));
    expect(byKey["acme/widget#1"]!.tone).toBe("ok");
    expect(byKey["acme/widget#2"]!.tone).toBe("warn");
    expect(byKey["acme/widget#3"]!.tone).toBe("danger");
    expect(byKey["acme/widget#3"]!.x).toBe(0); // older than the window: pinned to the left edge
    expect(byKey["acme/widget#1"]!.x).toBeGreaterThan(0.99);
    expect(prQueue([], thu)).toEqual({ count: 0, oldestDays: null, dots: [] });
  });

  it("puts dots opened close together in different lanes", () => {
    const prs = Array.from({ length: 30 }, (_, i): PullRequest => ({
      repo: "r", number: i, title: "t", url: "", author: "x", role: "reviewer",
      createdAt: new Date(thu.getTime() - (i % 3) * HOUR).toISOString(), isDraft: false, checks: "none",
    }));
    const q = prQueue(prs, thu);
    expect(q.count).toBe(30);
    expect(new Set(q.dots.slice(0, 3).map((d) => d.row)).size).toBe(3);
    expect(q.dots.every((d) => d.row >= 0 && d.row <= 2)).toBe(true);
  });

  it("compares the streak with the best", () => {
    expect(streakSummary({ current: 4, best: 9, started: null })).toEqual({ current: 4, best: 9, ratio: 4 / 9, isBest: false });
    expect(streakSummary({ current: 12, best: 9, started: null })).toEqual({ current: 12, best: 12, ratio: 1, isBest: true });
    expect(streakSummary(undefined)).toEqual({ current: 0, best: 0, ratio: 0, isBest: false });
    // A first day ties a best of 1: not a record worth calling out.
    expect(streakSummary({ current: 1, best: 1, started: null }).isBest).toBe(false);
    expect(streakSummary({ current: 2, best: 2, started: null }).isBest).toBe(true);
    expect(share(3, 0)).toBe(0);
    expect(share(5, 4)).toBe(1);
  });

  it("words the streak as recorded, never as live", () => {
    const s = (current: number, best: number) => streakSummary({ current, best, started: null });
    expect(streakCaption(s(1, 1), "2026-08-18", thu)).toBe("Started 18 Aug, as recorded in Daily.md");
    expect(streakCaption(s(1, 1), null, thu)).toBe("As recorded in Daily.md");
    expect(streakCaption(s(12, 9), "2026-10-18", thu)).toBe("Your best yet, as recorded in Daily.md");
    expect(streakCaption(s(4, 9), "2025-12-30", thu)).toBe("Started 30 Dec 2025, as recorded in Daily.md");
    expect(streakCaption(s(0, 9), "2026-10-01", thu)).toBe("Best 9 days");
    expect(streakCaption(s(0, 0), null, thu)).toBe("No best yet");
    expect(streakCaption(s(3, 9), "2026-02-30", thu)).toBe("As recorded in Daily.md"); // impossible date: no date shown
    expect(shortDay("not a date", thu)).toBeNull();
  });
});

describe("tile availability", () => {
  const st = (status: SourceState["status"], updatedAt: string | null = null, message?: string): SourceState => ({
    status, updatedAt, ...(message ? { message } : {}),
  });

  it("never turns a missing source into a number", () => {
    expect(availability(st("not_connected", null, "Add JIRA_API_TOKEN to .env"), "jira", thu)).toEqual({
      kind: "off",
      message: "Add JIRA_API_TOKEN to .env",
    });
    expect(availability(st("never_run"), "github", thu).kind).toBe("idle");
    expect(availability(undefined, "github", thu).kind).toBe("idle");
    expect(availability(st("error", null, "gh is not logged in"), "github", thu)).toEqual({ kind: "failed", message: "gh is not logged in" });
  });

  it("keeps showing old data with a caveat", () => {
    const old = new Date(thu.getTime() - 3 * HOUR).toISOString();
    expect(availability(st("ok", old), "jira", thu)).toEqual({ kind: "ok", caveat: null });
    expect(availability(st("stale", old), "jira", thu)).toEqual({ kind: "ok", caveat: "Jira data is from 3 h ago." });
    expect(availability(st("error", old, "timeout"), "jira", thu)).toEqual({
      kind: "ok",
      caveat: "Last Jira update failed. Showing data from 3 h ago.",
    });
  });
});

describe("needs you", () => {
  it("orders red before amber, soonest due first, undated last", () => {
    const ranked = rankNeedsYou([
      need("a1", "amber", "2026-10-29T16:00:00Z"),
      need("r-undated", "red"),
      need("r2", "red", "2026-10-30T09:00:00Z"),
      need("r1", "red", "2026-10-29T09:00:00Z"),
      need("a0", "amber"),
    ]);
    expect(ranked.map((i) => i.id)).toEqual(["r1", "r2", "r-undated", "a1", "a0"]);
    expect(urgencyCounts(ranked)).toEqual({ red: 3, amber: 2 });
    expect(rankNeedsYou(null)).toEqual([]);
  });

  it("counts '+N more' from needsYouTotal, even with 30 items", () => {
    expect(needsYouOverflow(8, 30, 8)).toBe(22);
    expect(needsYouOverflow(8, undefined, 30)).toBe(22); // server did not cap: the list is the truth
    expect(needsYouOverflow(3, undefined, 3)).toBe(0); // older server without needsYouTotal
    expect(needsYouOverflow(3, 2, 3)).toBe(0); // total smaller than the list: never negative
    expect(needsYouOverflow(0, 0, 0)).toBe(0);
  });

  it("finds items new since the last visit", () => {
    expect(newSinceLastVisit(["a", "b", "c"], ["a"])).toEqual(new Set(["b", "c"]));
    expect(newSinceLastVisit(["a"], null).size).toBe(0); // first visit ever: nothing pulses
    expect(newSinceLastVisit([], ["a"]).size).toBe(0);
    expect(parseSeenIds('["a",1,"b"]')).toEqual(["a", "b"]);
    expect(parseSeenIds("{bad json")).toBeNull();
    expect(parseSeenIds('{"a":1}')).toBeNull();
    expect(parseSeenIds(null)).toBeNull();
  });

  it("labels due times", () => {
    const at = (ms: number) => new Date(thu.getTime() + ms).toISOString();
    expect(dueLabel(at(5 * HOUR + 10 * 60_000), thu)).toBe("Due in 5 h");
    expect(dueLabel(at(30 * 60_000), thu)).toBe("Due in 30 min");
    expect(dueLabel(at(DAY + HOUR), thu)).toBe("Due tomorrow");
    expect(dueLabel(at(4 * DAY), thu)).toBe("Due in 4 days");
    expect(dueLabel(at(-2 * DAY - HOUR), thu)).toBe("Overdue by 2 days");
    expect(dueLabel(at(-DAY), thu)).toBe("Overdue by 1 day");
    expect(dueLabel(at(-3 * HOUR), thu)).toBe("Overdue by 3 h");
    expect(dueLabel(at(20_000), thu)).toBe("Due now");
    expect(dueLabel("not a date", thu)).toBeNull();
    expect(dueLabel(undefined, thu)).toBeNull();
  });

  it("measures the time left in a 72 h window", () => {
    const at = (ms: number) => new Date(thu.getTime() + ms).toISOString();
    expect(dueRemaining(at(36 * HOUR), thu)).toBeCloseTo(0.5, 5);
    expect(dueRemaining(at(-HOUR), thu)).toBe(0);
    expect(dueRemaining(at(10 * DAY), thu)).toBe(1);
    expect(dueRemaining("nope", thu)).toBeNull();
  });

  it("names the sources an all-clear did not check", () => {
    const ok: SourceState = { status: "ok", updatedAt: "2026-10-29T10:00:00Z" };
    const never: SourceState = { status: "never_run", updatedAt: null };
    const off: SourceState = { status: "not_connected", updatedAt: null };
    expect(needsYouCoverage({ jira: ok, github: { status: "error", updatedAt: null }, calendar: off, checkins: ok, learning: never })).toEqual({
      checked: ["jira", "checkins"],
      unchecked: ["github", "calendar", "learning"],
    });
    expect(needsYouCoverage(undefined).checked).toEqual([]);
  });
});

describe("next moves", () => {
  it("keeps open moves, best rank first", () => {
    const move = (id: string, rank: number, state: NextMove["state"] = "open"): NextMove => ({
      id, rank, state, title: id, reason: "", area: "work",
    });
    expect(openMoves([move("c", 3), move("a", 1), move("x", 2, "done"), move("b", 2), move("y", 0, "dismissed")]).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(openMoves(undefined)).toEqual([]);
  });
});
