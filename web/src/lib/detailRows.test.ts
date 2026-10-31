import { describe, expect, it } from "vitest";
import type { CalendarEvent, Checkin, CiRun, JiraIssue, PullRequest, Snapshot, SourceState } from "../../../shared/types";
import {
  activeFilterCount,
  average,
  checkinSeries,
  ciCounts,
  compareValues,
  currentStepIndex,
  daysUntil,
  defaultWorkTab,
  dueLevel,
  dueText,
  facetCounts,
  filterRows,
  formatAge,
  groupEventsByDay,
  lastNDays,
  nextSort,
  OTHER_SERIES,
  paginate,
  prStatus,
  prUrgency,
  recentCheckins,
  sortCi,
  sortJiraByUrgency,
  sortPrsByUrgency,
  sortRows,
  stackProjectTime,
  sumByDay,
  toggleFilter,
  weeklyTotals,
  workTabFor,
} from "./detailRows";

// Local-time constructor so the tests do not depend on the machine's timezone. Thursday 30 Oct 2026.
const now = new Date(2026, 9, 30, 14, 0, 0);
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();

function issue(key: string, patch: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `Summary of ${key}`,
    status: "To Do",
    statusCategory: "todo",
    priority: "Medium",
    dueDate: null,
    updated: "2026-10-29T10:00:00.000Z",
    project: "QIC",
    url: `https://example.test/browse/${key}`,
    blocked: false,
    ...patch,
  };
}

function pr(number: number, patch: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: "QIC/FastBind",
    number,
    title: `PR ${number}`,
    url: `https://example.test/pull/${number}`,
    author: "someone",
    role: "author",
    createdAt: hoursAgo(10),
    isDraft: false,
    checks: "pass",
    ...patch,
  };
}

function checkin(date: string, patch: Partial<Checkin> = {}): Checkin {
  return { date, sleepHours: 7, energy: 3, mood: 4, workoutMinutes: 30, spendQar: 100, ...patch };
}

describe("compareValues and sortRows", () => {
  it("puts empty values last in both directions", () => {
    const rows = [{ v: "b" }, { v: null }, { v: "a" }, { v: "" }, { v: "c" }];
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.v)).toEqual(["a", "b", "c", null, ""]);
    expect(sortRows(rows, (r) => r.v, "desc").map((r) => r.v)).toEqual(["c", "b", "a", null, ""]);
  });

  it("treats NaN and undefined as empty and sorts numbers numerically", () => {
    const rows = [{ v: 10 }, { v: Number.NaN }, { v: 2 }, { v: undefined }, { v: 33 }];
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.v)).toEqual([2, 10, 33, Number.NaN, undefined]);
    expect(sortRows(rows, (r) => r.v, "desc").slice(0, 3).map((r) => r.v)).toEqual([33, 10, 2]);
  });

  it("compares strings naturally", () => {
    expect(compareValues("QIC-9", "QIC-10", "asc")).toBeLessThan(0);
    expect(compareValues("alpha", "Beta", "asc")).toBeLessThan(0);
  });

  it("is stable and applies the tie-break regardless of direction", () => {
    const rows = [
      { id: 1, g: "x", t: 2 },
      { id: 2, g: "x", t: 1 },
      { id: 3, g: "y", t: 0 },
      { id: 4, g: "x", t: 1 },
    ];
    const tie = (a: { t: number }, b: { t: number }) => a.t - b.t;
    expect(sortRows(rows, (r) => r.g, "asc", tie).map((r) => r.id)).toEqual([2, 4, 1, 3]);
    expect(sortRows(rows, (r) => r.g, "desc", tie).map((r) => r.id)).toEqual([3, 2, 4, 1]);
  });

  it("does not mutate the input", () => {
    const rows = [{ v: 2 }, { v: 1 }];
    sortRows(rows, (r) => r.v, "asc");
    expect(rows.map((r) => r.v)).toEqual([2, 1]);
  });

  it("cycles a header through first direction, other direction, then default", () => {
    let s = nextSort(null, "due", "asc");
    expect(s).toEqual({ column: "due", dir: "asc" });
    s = nextSort(s, "due", "asc");
    expect(s).toEqual({ column: "due", dir: "desc" });
    expect(nextSort(s, "due", "asc")).toBeNull();
    expect(nextSort({ column: "due", dir: "desc" }, "age", "desc")).toEqual({ column: "age", dir: "desc" });
  });
});

describe("filtering", () => {
  const rows = [
    { id: 1, project: "QIC", status: "To Do" },
    { id: 2, project: "QIC", status: "In Progress" },
    { id: 3, project: "NPS", status: "To Do" },
    { id: 4, project: "RISK", status: "Blocked" },
  ];
  const get = (r: (typeof rows)[number], category: string) => (category === "project" ? r.project : r.status);

  it("returns every row with no active filter", () => {
    expect(filterRows(rows, {}, get)).toHaveLength(4);
    expect(filterRows(rows, { project: [] }, get)).toHaveLength(4);
  });

  it("ORs values inside a category and ANDs across categories", () => {
    expect(filterRows(rows, { project: ["QIC", "NPS"] }, get).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(filterRows(rows, { project: ["QIC", "NPS"], status: ["To Do"] }, get).map((r) => r.id)).toEqual([1, 3]);
    expect(filterRows(rows, { project: ["RISK"], status: ["To Do"] }, get)).toEqual([]);
  });

  it("toggles values on and off and counts active filters", () => {
    let f = toggleFilter({}, "project", "QIC");
    f = toggleFilter(f, "status", "To Do");
    f = toggleFilter(f, "project", "NPS");
    expect(f).toEqual({ project: ["QIC", "NPS"], status: ["To Do"] });
    expect(activeFilterCount(f)).toBe(3);
    f = toggleFilter(f, "project", "QIC");
    expect(f.project).toEqual(["NPS"]);
    expect(activeFilterCount({})).toBe(0);
  });

  it("counts facets, most common first, empty values as None", () => {
    const facets = facetCounts([...rows, { id: 5, project: " ", status: "x" }], (r) => r.project);
    expect(facets).toEqual([
      { value: "QIC", count: 2 },
      { value: "None", count: 1 },
      { value: "NPS", count: 1 },
      { value: "RISK", count: 1 },
    ]);
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 200 }, (_, i) => i + 1);

  it("slices 20 rows per page with one-based from and to", () => {
    const p = paginate(rows, 2);
    expect(p.rows[0]).toBe(41);
    expect(p.rows).toHaveLength(20);
    expect(p).toMatchObject({ page: 2, pageCount: 10, total: 200, from: 41, to: 60 });
  });

  it("clamps out-of-range pages", () => {
    expect(paginate(rows, 99).page).toBe(9);
    expect(paginate(rows, -3).page).toBe(0);
    expect(paginate(rows, Number.NaN).page).toBe(0);
  });

  it("handles a short last page and no rows", () => {
    expect(paginate(rows.slice(0, 45), 2)).toMatchObject({ from: 41, to: 45, pageCount: 3 });
    expect(paginate([], 0)).toEqual({ rows: [], page: 0, pageCount: 1, total: 0, from: 0, to: 0 });
  });
});

describe("dates", () => {
  it("lists the last N days ending today, oldest first", () => {
    expect(lastNDays(3, now)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(lastNDays(0, now)).toEqual([]);
    expect(lastNDays(30, now)).toHaveLength(30);
  });

  it("counts whole days to a due date", () => {
    expect(daysUntil("2026-10-30", now)).toBe(0);
    expect(daysUntil("2026-11-02", now)).toBe(3);
    expect(daysUntil("2026-10-27", now)).toBe(-3);
    expect(daysUntil("not a date", now)).toBeNaN();
  });

  it("formats ages for table cells", () => {
    expect(formatAge(hoursAgo(0.5), now)).toBe("30m");
    expect(formatAge(hoursAgo(5), now)).toBe("5h");
    expect(formatAge(hoursAgo(80), now)).toBe("3d");
    expect(formatAge("garbage", now)).toBe("");
  });
});

describe("Jira urgency", () => {
  it("labels due levels and text", () => {
    expect(dueLevel("2026-10-28", now)).toBe("overdue");
    expect(dueText("2026-10-28", now)).toBe("2 days late");
    expect(dueText("2026-10-29", now)).toBe("1 day late");
    expect(dueLevel("2026-10-30", now)).toBe("today");
    expect(dueText("2026-10-31", now)).toBe("Tomorrow");
    expect(dueLevel("2026-11-02", now)).toBe("soon");
    expect(dueLevel("2026-11-20", now)).toBe("later");
    expect(dueText("2026-11-20", now)).toBe("In 21 days");
    expect(dueLevel(null, now)).toBe("none");
    expect(dueText(null, now)).toBe("No due date");
  });

  it("sorts most urgent first: earliest due, blocked and priority break ties, no due date last", () => {
    const sorted = sortJiraByUrgency([
      issue("QIC-1"),
      issue("QIC-2", { dueDate: "2026-11-10" }),
      issue("QIC-3", { dueDate: "2026-10-25" }),
      issue("QIC-4", { dueDate: "2026-11-10", blocked: true }),
      issue("QIC-5", { dueDate: "2026-11-10", priority: "Highest" }),
      issue("QIC-6", { blocked: true }),
    ]);
    expect(sorted.map((i) => i.key)).toEqual(["QIC-3", "QIC-4", "QIC-5", "QIC-2", "QIC-6", "QIC-1"]);
  });
});

describe("pull requests", () => {
  it("derives one status label", () => {
    expect(prStatus(pr(1, { role: "reviewer" }))).toBe("Needs your review");
    expect(prStatus(pr(8, { role: "reviewer", isDraft: true }))).toBe("Draft"); // a draft is not waiting on you
    expect(prStatus(pr(2, { isDraft: true, checks: "fail" }))).toBe("Checks failing");
    expect(prStatus(pr(7, { isDraft: true, checks: "pass" }))).toBe("Draft");
    expect(prStatus(pr(3, { checks: "fail" }))).toBe("Checks failing");
    expect(prStatus(pr(4, { checks: "pending" }))).toBe("Checks running");
    expect(prStatus(pr(5))).toBe("Open");
  });

  it("ranks urgency like the Needs-you rules", () => {
    expect(prUrgency(pr(1, { role: "reviewer", createdAt: hoursAgo(80) }), now)).toBe(0);
    expect(prUrgency(pr(2, { role: "reviewer", createdAt: hoursAgo(30) }), now)).toBe(1);
    expect(prUrgency(pr(3, { role: "reviewer", createdAt: hoursAgo(2) }), now)).toBe(2);
    expect(prUrgency(pr(4, { checks: "fail" }), now)).toBe(0);
    expect(prUrgency(pr(5), now)).toBe(3);
    expect(prUrgency(pr(6, { isDraft: true }), now)).toBe(4);
    // Drafts are never urgent, as in Needs you: not with failing checks, not as an old review request.
    expect(prUrgency(pr(7, { isDraft: true, checks: "fail" }), now)).toBe(4);
    expect(prUrgency(pr(8, { role: "reviewer", isDraft: true, createdAt: hoursAgo(200) }), now)).toBe(4);
  });

  it("sorts most urgent first, then the one waiting longest", () => {
    const sorted = sortPrsByUrgency(
      [
        pr(1),
        pr(2, { role: "reviewer", createdAt: hoursAgo(100) }),
        pr(3, { checks: "fail", createdAt: hoursAgo(200) }),
        pr(4, { isDraft: true }),
        pr(5, { role: "reviewer", createdAt: hoursAgo(30) }),
      ],
      now,
    );
    expect(sorted.map((p) => p.number)).toEqual([3, 2, 5, 1, 4]);
  });
});

describe("CI", () => {
  const run = (repo: string, status: CiRun["status"]): CiRun => ({ repo, branch: "main", status, url: "u", at: hoursAgo(1) });

  it("puts failing first, then running, then passing, by repo", () => {
    const sorted = sortCi([run("b", "pass"), run("z", "fail"), run("a", "pass"), run("m", "pending"), run("c", "fail")]);
    expect(sorted.map((r) => r.repo)).toEqual(["c", "z", "m", "a", "b"]);
    expect(ciCounts(sorted)).toEqual({ fail: 2, pending: 1, pass: 2 });
  });
});

describe("stackProjectTime", () => {
  it("builds one row per day with the biggest projects first", () => {
    const s = stackProjectTime(
      [
        { project: "Small", minutesByDay: { "2026-10-30": 10 } },
        { project: "Big", minutesByDay: { "2026-10-29": 60, "2026-10-30": 30 } },
        { project: "Old", minutesByDay: { "2025-01-01": 500 } },
      ],
      3,
      now,
    );
    expect(s.keys).toEqual(["Big", "Small"]);
    expect(s.days).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(s.values).toEqual([
      [0, 0],
      [60, 0],
      [30, 10],
    ]);
    expect(s.totals).toEqual([90, 10]);
    expect(s.dayTotals).toEqual([0, 60, 40]);
  });

  it("folds projects past the limit into Other", () => {
    const sessions = Array.from({ length: 7 }, (_, i) => ({ project: `P${i}`, minutesByDay: { "2026-10-30": 70 - i * 10 } }));
    const s = stackProjectTime(sessions, 1, now, 5);
    expect(s.keys).toEqual(["P0", "P1", "P2", "P3", OTHER_SERIES]);
    expect(s.totals).toEqual([70, 60, 50, 40, 30 + 20 + 10]);
  });

  it("returns no series when nothing was tracked", () => {
    expect(stackProjectTime([], 30, now).keys).toEqual([]);
  });

  it("sums commits across repos per day", () => {
    expect(sumByDay([{ "2026-10-30": 2 }, { "2026-10-30": 3, "2026-10-29": 1 }], ["2026-10-29", "2026-10-30", "2026-10-31"])).toEqual([1, 5, 0]);
  });
});

describe("check-in series", () => {
  it("keeps one check-in per date, newest first", () => {
    const list = recentCheckins([checkin("2026-10-28"), checkin("2026-10-30"), checkin("2026-10-28", { mood: 1 })]);
    expect(list.map((c) => c.date)).toEqual(["2026-10-30", "2026-10-28"]);
    expect(list[1].mood).toBe(1);
  });

  it("builds a daily series with null gaps for missing days", () => {
    const series = checkinSeries([checkin("2026-10-28", { sleepHours: 6.5 }), checkin("2026-10-30", { sleepHours: 8 })], "sleepHours", 4, now);
    expect(series).toEqual([
      { date: "2026-10-27", value: null },
      { date: "2026-10-28", value: 6.5 },
      { date: "2026-10-29", value: null },
      { date: "2026-10-30", value: 8 },
    ]);
  });

  it("handles a single check-in and none at all", () => {
    expect(checkinSeries([checkin("2026-10-30")], "mood", 30, now).filter((p) => p.value !== null)).toHaveLength(1);
    expect(checkinSeries([], "mood", 30, now).every((p) => p.value === null)).toBe(true);
  });

  it("averages defined values only", () => {
    expect(average([1, null, 3])).toBe(2);
    expect(average([null, null])).toBeNull();
    expect(average([])).toBeNull();
  });

  it("sums per week starting Sunday, with null for weeks without a check-in", () => {
    // 30 Oct 2026 is a Thursday, so the current week runs Sun 25 Oct to today.
    const weeks = weeklyTotals(
      [checkin("2026-10-25", { spendQar: 40 }), checkin("2026-10-30", { spendQar: 60 }), checkin("2026-10-20", { spendQar: 15 })],
      "spendQar",
      3,
      now,
    );
    expect(weeks).toEqual([
      { start: "2026-10-11", end: "2026-10-17", total: null, logged: 0, daysInWeek: 7 },
      { start: "2026-10-18", end: "2026-10-24", total: 15, logged: 1, daysInWeek: 7 },
      { start: "2026-10-25", end: "2026-10-30", total: 100, logged: 2, daysInWeek: 6 },
    ]);
  });

  it("counts a logged zero as zero, not a gap", () => {
    const [week] = weeklyTotals([checkin("2026-10-26", { workoutMinutes: 0 })], "workoutMinutes", 1, now);
    expect(week.total).toBe(0);
    expect(week.logged).toBe(1);
  });
});

describe("calendar agenda", () => {
  const ev = (id: string, start: string, end = start): CalendarEvent => ({ id, title: id, start, end });

  it("groups upcoming events by day, all-day first, past days dropped", () => {
    const days = groupEventsByDay(
      [
        ev("late", new Date(2026, 9, 30, 16).toISOString()),
        ev("early", new Date(2026, 9, 30, 9).toISOString()),
        ev("allday", "2026-10-30"),
        ev("tomorrow", new Date(2026, 9, 31, 10).toISOString()),
        ev("past", new Date(2026, 9, 28, 10).toISOString()),
        ev("broken", "nope"),
      ],
      now,
    );
    expect(days.map((d) => d.day)).toEqual(["2026-10-30", "2026-10-31"]);
    expect(days[0].items.map((e) => e.id)).toEqual(["allday", "early", "late"]);
  });

  it("returns nothing for no events", () => {
    expect(groupEventsByDay([], now)).toEqual([]);
  });
});

describe("workTabFor and steps", () => {
  it("maps the opening tile to a tab", () => {
    expect(workTabFor(null)).toBe("jira");
    expect(workTabFor("tile-work")).toBe("jira");
    expect(workTabFor("tile-work-jira")).toBe("jira");
    expect(workTabFor("tile-work-prs")).toBe("prs");
    expect(workTabFor("tile-work-ci")).toBe("ci");
    expect(workTabFor("tile-work-time")).toBe("time");
    expect(workTabFor("tile-work-hours")).toBe("time");
    expect(workTabFor("tile-work-commits")).toBe("time");
    expect(workTabFor("tile-work-week")).toBe("time"); // the week timeline shows hours, so it opens Time
  });

  it("opens on the first connected tab when the opener names none", () => {
    const st = (status: SourceState["status"]): SourceState => ({ status, updatedAt: null });
    const sources = (jira: SourceState["status"], github: SourceState["status"], sessions: SourceState["status"]) =>
      ({ jira: st(jira), github: st(github), claudeSessions: st(sessions) }) as Partial<Snapshot["sources"]>;
    const noJira = sources("not_connected", "ok", "ok");
    expect(workTabFor(null, noJira)).toBe("prs"); // Life map node, Jira not set up
    expect(workTabFor("tile-work", noJira)).toBe("prs");
    expect(workTabFor("tile-work-unknown", noJira)).toBe("prs");
    expect(workTabFor("tile-work-jira", noJira)).toBe("jira"); // an explicit ask still wins
    expect(defaultWorkTab(sources("not_connected", "not_connected", "ok"))).toBe("time");
    expect(defaultWorkTab(sources("ok", "ok", "ok"))).toBe("jira");
    expect(defaultWorkTab(sources("not_connected", "error", "ok"))).toBe("prs"); // failing is still connected
    expect(defaultWorkTab(sources("not_connected", "not_connected", "not_connected"))).toBe("jira");
    expect(defaultWorkTab(null)).toBe("jira"); // snapshot not loaded yet
  });

  it("finds the current step", () => {
    expect(currentStepIndex([{ done: true }, { done: false }, { done: false }])).toBe(1);
    expect(currentStepIndex([{ done: true }])).toBe(-1);
    expect(currentStepIndex([])).toBe(-1);
  });
});
