import { describe, expect, it } from "vitest";
import type { CalendarEvent, JiraIssue, Project, ProjectsState, SessionTime } from "../../../shared/types";
import { dayKey } from "./format";
import {
  OTHER_KEY,
  addDays,
  bucketFor,
  buildHeatGrid,
  heatStats,
  monthDayKeys,
  parseDayKey,
  placeWeekItems,
  projectTotals,
  quantileThresholds,
  registryReady,
  registryRows,
  registryTotals,
  startOfWeek,
  sumByDay,
  topWithOther,
  weekDayKeys,
  weekMinutes,
  weekRangeLabel,
  type ProjectTotal,
} from "./timeAgg";

// Local-time constructors only, so the tests pass in any timezone.
// Friday 30 October 2026, 14:00 local. Its week runs Sunday 25 to Saturday 31 October.
const now = new Date(2026, 9, 30, 14, 0, 0);

function session(project: string, minutesByDay: Record<string, number>): SessionTime {
  return { project, minutesByDay };
}

function issue(key: string, dueDate: string | null, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `Summary ${key}`,
    status: "In Progress",
    statusCategory: "inprogress",
    priority: "Medium",
    dueDate,
    updated: "2026-10-29T10:00:00.000Z",
    project: "QIC",
    url: `https://example.test/browse/${key}`,
    blocked: false,
    ...extra,
  };
}

describe("parseDayKey", () => {
  it("reads a key as local midnight, not UTC", () => {
    const d = parseDayKey("2026-11-02")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 10, 2, 0]);
    expect(dayKey(d)).toBe("2026-11-02");
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseDayKey("2026-2-3")).toBeNull();
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2027-02-29")).toBeNull();
    expect(parseDayKey("2028-02-29")).not.toBeNull();
    expect(parseDayKey("2026-10-30T10:00:00Z")).toBeNull();
  });
});

describe("week bucketing from Sunday", () => {
  it("starts the week on Sunday for every weekday", () => {
    expect(dayKey(startOfWeek(now))).toBe("2026-10-25");
    expect(dayKey(startOfWeek(new Date(2026, 9, 25, 0, 0)))).toBe("2026-10-25"); // Sunday itself
    expect(dayKey(startOfWeek(new Date(2026, 9, 31, 23, 59)))).toBe("2026-10-25"); // Saturday night
    expect(dayKey(startOfWeek(new Date(2026, 10, 1, 0, 1)))).toBe("2026-11-01"); // next Sunday
  });

  it("lists the 7 days Sunday to Saturday across a month boundary", () => {
    expect(weekDayKeys(new Date(2026, 10, 3))).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
    expect(weekDayKeys(now)[0]).toBe("2026-10-25");
    expect(weekDayKeys(now)[6]).toBe("2026-10-31");
  });

  it("labels the week range", () => {
    expect(weekRangeLabel(now)).toBe("25 to 31 Oct");
    expect(weekRangeLabel(new Date(2026, 11, 1))).toBe("29 Nov to 5 Dec");
  });

  it("sums minutes per day of this week across projects", () => {
    const sessions = [
      session("A", { "2026-10-24": 999, "2026-10-25": 30, "2026-10-30": 60 }),
      session("B", { "2026-10-30": 15, "2026-11-01": 999 }),
    ];
    expect(weekMinutes(sessions, now)).toEqual([30, 0, 0, 0, 0, 75, 0]);
  });
});

describe("projectTotals", () => {
  const sessions = [
    session("FastBind", { "2026-10-24": 500, "2026-10-26": 90, "2026-10-28": 30 }),
    session("NPS", { "2026-10-01": 200, "2026-10-29": 45 }),
    session("Old", { "2026-09-30": 400 }),
    session("Next month", { "2026-11-01": 50 }),
  ];

  it("totals this week from Sunday, largest first, and counts active days", () => {
    expect(projectTotals(sessions, "week", now)).toEqual([
      { project: "FastBind", minutes: 120, activeDays: 2 },
      { project: "NPS", minutes: 45, activeDays: 1 },
    ]);
  });

  it("totals the calendar month, 1st to last day only", () => {
    expect(monthDayKeys(now)).toHaveLength(31);
    expect(projectTotals(sessions, "month", now)).toEqual([
      { project: "FastBind", minutes: 620, activeDays: 3 },
      { project: "NPS", minutes: 245, activeDays: 2 },
    ]);
  });

  it("ignores negative, NaN and non-numeric minutes", () => {
    const bad = [session("X", { "2026-10-26": -5, "2026-10-27": Number.NaN, "2026-10-28": 10 })];
    expect(projectTotals(bad, "week", now)).toEqual([{ project: "X", minutes: 10, activeDays: 1 }]);
  });

  it("returns nothing for an empty week", () => {
    expect(projectTotals([session("A", { "2026-01-01": 10 })], "week", now)).toEqual([]);
  });
});

describe("topWithOther", () => {
  const totals = (n: number): ProjectTotal[] =>
    Array.from({ length: n }, (_, i) => ({ project: `P${String(i).padStart(2, "0")}`, minutes: 1000 - i * 10, activeDays: 1 }));

  it("shows one project as one row", () => {
    const rows = topWithOther(totals(1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "P00", isOther: false, members: [] });
  });

  it("shows a 9th project by name instead of an Other row of one", () => {
    const rows = topWithOther(totals(9));
    expect(rows).toHaveLength(9);
    expect(rows.some((r) => r.isOther)).toBe(false);
  });

  it("keeps the top 8 and folds 40 projects' remainder into Other", () => {
    const all = totals(40);
    const rows = topWithOther(all);
    expect(rows).toHaveLength(9);
    expect(rows.slice(0, 8).map((r) => r.key)).toEqual(["P00", "P01", "P02", "P03", "P04", "P05", "P06", "P07"]);
    const other = rows[8]!;
    expect(other.key).toBe(OTHER_KEY);
    expect(other.isOther).toBe(true);
    expect(other.activeDays).toBeNull();
    expect(other.members).toHaveLength(32);
    expect(other.minutes).toBe(all.slice(8).reduce((s, t) => s + t.minutes, 0));
  });

  it("sorts ties by name so the order never flickers", () => {
    const rows = topWithOther([
      { project: "b", minutes: 10, activeDays: 1 },
      { project: "a", minutes: 10, activeDays: 1 },
      { project: "c", minutes: 20, activeDays: 1 },
    ]);
    expect(rows.map((r) => r.key)).toEqual(["c", "a", "b"]);
  });
});

describe("bars from the project registry", () => {
  const tracked = (id: string, name: string, area: Project["area"], sessions: string[]): Project => ({
    id,
    name,
    area,
    status: "active",
    deadline: null,
    description: "",
    goals: [],
    tasks: [],
    sources: { sessions, repos: [] },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  const stat = (id: string, minutesByDay: Record<string, number>) => ({
    id,
    minutesByDay,
    commitsByDay: {},
    openTasks: 0,
    doneTasks: 0,
    noteCount: 0,
    lastNoteAt: null,
  });
  const sessions = [
    session("QIC-FastBind", { "2026-10-26": 60 }),
    session("fastbind-demo-video", { "2026-10-27": 30 }),
    session("Thesis", { "2026-10-28": 45 }),
    session("Scratch", { "2026-10-29": 20 }),
    session("Secret", { "2026-10-29": 500 }),
  ];
  const state: ProjectsState = {
    projects: [
      // FastBind folds two session names; its stats already sum them.
      tracked("qic-fastbind", "FastBind", "work", ["QIC-FastBind", "fastbind-demo-video"]),
      tracked("thesis", "Thesis", "learning", ["Thesis"]),
      tracked("idle", "Idle", "personal", []),
    ],
    stats: [stat("qic-fastbind", { "2026-10-26": 60, "2026-10-27": 30 }), stat("thesis", { "2026-10-28": 45 }), stat("idle", {})],
    untracked: [{ name: "Scratch", kind: "session", minutes7d: 20, commits30d: 0, lastSeen: "2026-10-29" }],
    hidden: ["Secret"],
  };

  it("knows when the server has a registry", () => {
    expect(registryReady(state)).toBe(true);
    expect(registryReady({ projects: [], stats: [], untracked: [], hidden: [] })).toBe(false);
    expect(registryReady({ projects: [], stats: [], untracked: [], hidden: ["x"] })).toBe(true);
    expect(registryReady(undefined)).toBe(false);
  });

  it("names bars after tracked projects, with their area, and leaves hidden names out", () => {
    const { tracked: t, untracked: u } = registryTotals(state, sessions, "week", now);
    expect(t).toEqual([
      { project: "FastBind", minutes: 90, activeDays: 2, id: "qic-fastbind", area: "work" },
      { project: "Thesis", minutes: 45, activeDays: 1, id: "thesis", area: "learning" },
    ]);
    expect(u).toEqual([{ project: "Scratch", minutes: 20, activeDays: 1 }]);
    expect([...t, ...u].some((r) => r.project === "Secret")).toBe(false);
  });

  it("folds untracked names into Other, even when there is only one", () => {
    const { tracked: t, untracked: u } = registryTotals(state, sessions, "week", now);
    const rows = registryRows(t, u);
    expect(rows.map((r) => r.label)).toEqual(["FastBind", "Thesis", "Other"]);
    expect(rows[0]).toMatchObject({ key: "qic-fastbind", projectId: "qic-fastbind", area: "work", isOther: false });
    expect(rows[2]).toMatchObject({ key: OTHER_KEY, isOther: true, minutes: 20, members: ["Scratch"], untracked: 1 });
  });

  it("puts tracked projects beyond the top 8 into Other with the untracked names", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ project: `P${i}`, minutes: 100 - i, activeDays: 1, id: `p${i}`, area: "work" as const }));
    const rows = registryRows(many, [{ project: "Loose", minutes: 1, activeDays: 1 }]);
    expect(rows).toHaveLength(9);
    expect(rows[8]).toMatchObject({ isOther: true, untracked: 1, members: ["P8", "P9", "P10", "P11", "Loose"] });
    // No untracked time and one leftover project: shown by name, like topWithOther.
    expect(registryRows(many.slice(0, 9), []).some((r) => r.isOther)).toBe(false);
  });
});

describe("sumByDay", () => {
  it("adds series and drops bad keys", () => {
    const m = sumByDay([{ "2026-10-01": 2, nonsense: 5 }, { "2026-10-01": 3, "2026-10-02": 1 }]);
    expect([...m.entries()]).toEqual([
      ["2026-10-01", 5],
      ["2026-10-02", 1],
    ]);
  });
});

describe("quantile thresholds and buckets", () => {
  it("cuts the positive values into quartiles and ignores zeros", () => {
    expect(quantileThresholds([0, 0, 5, 1, 4, 2, 3])).toEqual([2, 3, 4]);
    // Interpolates between neighbours like d3.quantile.
    expect(quantileThresholds([1, 2, 3, 4])).toEqual([1.75, 2.5, 3.25]);
  });

  it("returns no thresholds when nothing is above zero", () => {
    expect(quantileThresholds([])).toEqual([]);
    expect(quantileThresholds([0, 0, 0])).toEqual([]);
  });

  it("keeps no data, zero and the 4 steps apart", () => {
    const t = [10, 20, 30];
    expect(bucketFor(null, t)).toBe(-1);
    expect(bucketFor(0, t)).toBe(0);
    expect(bucketFor(5, t)).toBe(1);
    expect(bucketFor(10, t)).toBe(2);
    expect(bucketFor(25, t)).toBe(3);
    expect(bucketFor(30, t)).toBe(4);
    expect(bucketFor(999, t)).toBe(4);
  });

  it("puts a year of identical days on the top step", () => {
    const t = quantileThresholds([60, 60, 60]);
    expect(bucketFor(60, t)).toBe(4);
  });

  it("shows a single positive value with no thresholds on the top step", () => {
    expect(bucketFor(7, [])).toBe(1);
  });
});

describe("buildHeatGrid", () => {
  it("spans 52 weeks from a Sunday to today, with no future days", () => {
    const grid = buildHeatGrid(new Map(), now, { fill: "none" });
    const first = grid.cells[0]!;
    const last = grid.cells[grid.cells.length - 1]!;
    expect(first.date.getDay()).toBe(0);
    expect(first.week).toBe(0);
    expect(last.key).toBe("2026-10-30");
    expect(last.isToday).toBe(true);
    expect(last.week).toBe(51);
    expect(last.day).toBe(5);
    expect(grid.cells).toHaveLength(51 * 7 + 6);
    expect(grid.cells.filter((c) => c.isToday)).toHaveLength(1);
  });

  it("leaves gaps as no data for check-in style metrics", () => {
    const values = new Map([
      ["2026-10-28", 7],
      ["2026-10-29", 0],
    ]);
    const grid = buildHeatGrid(values, now, { fill: "none" });
    const byKey = new Map(grid.cells.map((c) => [c.key, c]));
    expect(byKey.get("2026-10-27")!.value).toBeNull();
    expect(byKey.get("2026-10-27")!.bucket).toBe(-1);
    expect(byKey.get("2026-10-29")!.value).toBe(0);
    expect(byKey.get("2026-10-29")!.bucket).toBe(0);
    expect(byKey.get("2026-10-28")!.bucket).toBe(4);
  });

  it("fills zeros from the first recorded day only", () => {
    const grid = buildHeatGrid(new Map([["2026-10-20", 30]]), now, { fill: "fromFirst" });
    const byKey = new Map(grid.cells.map((c) => [c.key, c]));
    expect(byKey.get("2026-10-19")!.value).toBeNull();
    expect(byKey.get("2026-10-21")!.value).toBe(0);
    expect(byKey.get("2026-10-30")!.value).toBe(0);
  });

  it("fills zeros across the window when any value exists, and nothing when none does", () => {
    const some = buildHeatGrid(new Map([["2026-10-20", 3]]), now, { fill: "all" });
    expect(some.cells.every((c) => c.value !== null)).toBe(true);
    const none = buildHeatGrid(new Map(), now, { fill: "all" });
    expect(none.cells.every((c) => c.value === null)).toBe(true);
  });

  it("keeps an all-zero year at the zero step with no thresholds", () => {
    const values = new Map(weekDayKeys(now).map((k) => [k, 0] as const));
    const grid = buildHeatGrid(values, now, { fill: "all" });
    expect(grid.thresholds).toEqual([]);
    expect(grid.max).toBe(0);
    expect(grid.cells.every((c) => c.bucket === 0)).toBe(true);
  });

  it("includes 29 February in a leap year", () => {
    const leapNow = new Date(2028, 2, 10, 9);
    const grid = buildHeatGrid(new Map([["2028-02-29", 5]]), leapNow, { fill: "none" });
    const leap = grid.cells.find((c) => c.key === "2028-02-29");
    expect(leap?.value).toBe(5);
    // Consecutive cells are consecutive days, so nothing is skipped or doubled.
    for (let i = 1; i < grid.cells.length; i++) {
      expect(dayKey(addDays(grid.cells[i - 1]!.date, 1))).toBe(grid.cells[i]!.key);
    }
  });

  it("labels months without crowding", () => {
    const grid = buildHeatGrid(new Map(), now, { fill: "none" });
    expect(grid.months.length).toBeGreaterThanOrEqual(11);
    for (let i = 1; i < grid.months.length; i++) {
      expect(grid.months[i]!.week - grid.months[i - 1]!.week).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("heatStats", () => {
  it("counts totals, active days, streaks and the best day", () => {
    const values = new Map([
      ["2026-10-20", 10],
      ["2026-10-21", 20],
      ["2026-10-22", 30],
      ["2026-10-27", 5],
      ["2026-10-28", 40],
      ["2026-10-29", 15],
    ]);
    const stats = heatStats(buildHeatGrid(values, now, { fill: "all" }));
    expect(stats.total).toBe(120);
    expect(stats.activeDays).toBe(6);
    expect(stats.bestStreak).toBe(3);
    // Today (30 Oct) has nothing yet, so the streak ending yesterday still counts.
    expect(stats.currentStreak).toBe(3);
    expect(stats.max).toMatchObject({ key: "2026-10-28", value: 40 });
    expect(stats.min).toMatchObject({ key: "2026-10-27", value: 5 });
  });

  it("breaks the current streak on a zero before yesterday", () => {
    const values = new Map([["2026-10-28", 40]]);
    expect(heatStats(buildHeatGrid(values, now, { fill: "all" })).currentStreak).toBe(0);
  });

  it("averages over days with data only", () => {
    const values = new Map([
      ["2026-10-28", 6],
      ["2026-10-29", 8],
    ]);
    const stats = heatStats(buildHeatGrid(values, now, { fill: "none" }));
    expect(stats.daysWithData).toBe(2);
    expect(stats.mean).toBe(7);
  });
});

describe("placeWeekItems", () => {
  it("puts overdue issues in the overdue lane, most overdue first, and this week's by day", () => {
    const placed = placeWeekItems(
      [
        issue("A-1", "2026-10-29"),
        issue("A-2", "2026-10-10"),
        issue("A-3", "2026-10-30"),
        issue("A-4", "2026-10-31"),
        issue("A-5", "2026-11-04"),
        issue("A-6", null),
        issue("A-7", "2026-10-26", { statusCategory: "done" }),
      ],
      [],
      now,
    );
    expect(placed.overdue.map((i) => i.id)).toEqual(["jira-A-2", "jira-A-1"]);
    expect(placed.overdue[0]).toMatchObject({ urgency: "overdue", daysLate: 20 });
    expect(placed.days[5]!.map((i) => i.id)).toEqual(["jira-A-3"]);
    expect(placed.days[5]![0]).toMatchObject({ urgency: "today" });
    expect(placed.days[6]![0]).toMatchObject({ urgency: "soon" });
    expect(placed.dueLater).toBe(1);
    expect(placed.noDueDate).toBe(1);
  });

  it("places calendar events on their local day, sorted by time, after due items", () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
    const events: CalendarEvent[] = [
      { id: "late", title: "Late call", start: at(30, 23, 30), end: at(30, 23, 59) },
      { id: "early", title: "Standup", start: at(30, 9), end: at(30, 9, 15) },
      { id: "allday", title: "Holiday", start: "2026-10-27", end: "2026-10-28" },
      { id: "next", title: "Next week", start: at(32, 9), end: at(32, 10) },
      { id: "bad", title: "Broken", start: "soon", end: "later" },
    ];
    const placed = placeWeekItems([issue("B-1", "2026-10-30")], events, now);
    expect(placed.days[5]!.map((i) => i.id)).toEqual(["jira-B-1", "event-early", "event-late"]);
    expect(placed.days[2]![0]).toMatchObject({ id: "event-allday", allDay: true });
    expect(placed.days.flat()).toHaveLength(4);
  });
});
