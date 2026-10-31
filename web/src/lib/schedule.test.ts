import { describe, expect, it } from "vitest";
import type { CalendarEvent, PlanItem, ScheduleRange, SchedulePlan, TaskNote } from "../../../shared/types";
import {
  DAY_END,
  DAY_START,
  MAX_OFFSET_DAYS,
  buildDay,
  buildWeek,
  dayBounds,
  dayFreeGaps,
  dayLabel,
  eventOnDay,
  findTask,
  firstFit,
  formatHm,
  freeGaps,
  httpsUrl,
  itemSpan,
  layoutLanes,
  minutesToPx,
  notPlaced,
  parseHm,
  patchTask,
  planItems,
  rangeLabel,
  roundUp,
  stepOffset,
  totalMinutes,
  viewRange,
  whenText,
  withTask,
  withoutPlanItems,
} from "./schedule";

// Local-time constructors only, so the tests pass in any timezone.
// Saturday 31 October 2026, 10:07 local.
const now = new Date(2026, 9, 31, 10, 7);
const TODAY = "2026-10-31";

/** A local time on a day as an ISO string, the way the server sends timed events. */
function at(day: number, h: number, m = 0, month = 9): string {
  return new Date(2026, month, day, h, m).toISOString();
}

function event(id: string, start: string, end: string, title = id): CalendarEvent {
  return { id, title, start, end };
}

function task(path: string, due: string | null, start: string | null = null, minutes: number | null = null, done = false): TaskNote {
  return {
    path,
    section: "Tasks",
    title: path.replace(/^Tasks\//, "").replace(/\.md$/, ""),
    created: "2026-10-30T08:00:00.000Z",
    updated: "2026-10-30T08:00:00.000Z",
    projectId: null,
    tags: [],
    excerpt: "",
    openActions: 0,
    task: { due, start, minutes, done, source: "me" },
  };
}

function plan(id: string, date: string, start: string | null, minutes: number | null = 30): PlanItem {
  return { id, title: id, projectId: null, date, start, minutes, reason: "Fits before lunch." };
}

function range(from: string, to: string, days: ScheduleRange["days"], extra: Partial<ScheduleRange> = {}): ScheduleRange {
  return { from, to, days, unscheduled: [], overdue: [], calendar: { status: "ok" }, ...extra };
}

describe("times", () => {
  it("parses and formats HH:MM", () => {
    expect(parseHm("09:30")).toBe(570);
    expect(parseHm("00:00")).toBe(0);
    expect(parseHm("23:59")).toBe(1439);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("9:30")).toBeNull();
    expect(parseHm("12:60")).toBeNull();
    expect(parseHm(null)).toBeNull();
    expect(formatHm(570)).toBe("09:30");
    expect(formatHm(1440)).toBe("24:00");
    expect(formatHm(-20)).toBe("00:00");
  });

  it("rounds up to a step", () => {
    expect(roundUp(607, 15)).toBe(615);
    expect(roundUp(600, 15)).toBe(600);
  });

  it("turns minutes into pixels from the top of the timeline", () => {
    expect(minutesToPx(DAY_START, DAY_START, 48)).toBe(0);
    expect(minutesToPx(9 * 60 + 30, DAY_START, 48)).toBe(72);
    expect(minutesToPx(DAY_END, DAY_START, 48)).toBe(480);
    expect(minutesToPx(7 * 60, DAY_START, 48)).toBe(-48);
  });

  it("gives a task or plan item a span only with a valid start", () => {
    expect(itemSpan("10:00", 45)).toEqual({ start: 600, end: 645 });
    expect(itemSpan("10:00", null)).toEqual({ start: 600, end: 630 });
    expect(itemSpan("23:50", 60)).toEqual({ start: 1430, end: 1440 });
    expect(itemSpan(null, 45)).toBeNull();
    expect(itemSpan("soon", 45)).toBeNull();
  });
});

describe("days and ranges", () => {
  it("builds the day or the seven days a view shows", () => {
    expect(viewRange("day", now, 0)).toEqual({ from: TODAY, to: TODAY, days: [TODAY] });
    const week = viewRange("week", now, 0);
    expect(week.from).toBe(TODAY);
    expect(week.to).toBe("2026-11-06");
    expect(week.days).toHaveLength(7);
    expect(viewRange("day", now, -1).from).toBe("2026-10-30");
  });

  it("steps by a day or a week and stops 14 days away", () => {
    expect(stepOffset(0, "day", 1)).toBe(1);
    expect(stepOffset(0, "week", -1)).toBe(-7);
    expect(stepOffset(7, "week", 1)).toBe(14);
    expect(stepOffset(14, "week", 1)).toBeNull();
    expect(stepOffset(MAX_OFFSET_DAYS, "day", 1)).toBeNull();
    expect(stepOffset(-MAX_OFFSET_DAYS, "day", -1)).toBeNull();
    expect(stepOffset(-MAX_OFFSET_DAYS, "day", 1)).toBe(-13);
  });

  it("names days and ranges", () => {
    expect(dayLabel(TODAY, TODAY)).toBe("Today");
    expect(dayLabel("2026-11-01", TODAY)).toBe("Tomorrow");
    expect(dayLabel("2026-10-30", TODAY)).toBe("Yesterday");
    expect(dayLabel("2026-11-02", TODAY)).toBe("Mon 2 Nov");
    expect(rangeLabel("day", TODAY, TODAY, TODAY)).toBe("Today, Sat 31 Oct");
    expect(rangeLabel("day", "2026-11-03", "2026-11-03", TODAY)).toBe("Tue 3 Nov");
    expect(rangeLabel("week", TODAY, "2026-11-06", TODAY)).toBe("31 Oct to 6 Nov");
    expect(whenText(TODAY, "10:00", 45, TODAY)).toBe("Today, 10:00, 45m");
    expect(whenText("2026-11-02", null, null, TODAY)).toBe("Mon 2 Nov, any time");
    expect(whenText(null, null, 30, TODAY)).toBe("No day yet, 30m");
  });
});

describe("calendar events", () => {
  it("places all-day and timed events on their day", () => {
    expect(eventOnDay(event("a", TODAY, "2026-11-01"), TODAY)).toEqual({ allDay: true });
    expect(eventOnDay(event("b", at(31, 9, 30), at(31, 10, 15)), TODAY)).toEqual({ allDay: false, start: 570, end: 615 });
  });

  it("clamps events that cross midnight and mends a broken end", () => {
    expect(eventOnDay(event("late", at(31, 23), at(1, 1, 0, 10)), TODAY)).toEqual({ allDay: false, start: 1380, end: 1440 });
    expect(eventOnDay(event("early", at(30, 23), at(31, 1)), TODAY)).toEqual({ allDay: false, start: 0, end: 60 });
    expect(eventOnDay(event("yesterday", at(30, 9), at(30, 10)), TODAY)).toBeNull();
    expect(eventOnDay(event("to-midnight", at(30, 22), at(31, 0)), TODAY)).toBeNull();
    expect(eventOnDay(event("bad", at(31, 9), "nope"), TODAY)).toEqual({ allDay: false, start: 540, end: 570 });
    expect(eventOnDay(event("backwards", at(31, 9), at(31, 8)), TODAY)).toEqual({ allDay: false, start: 540, end: 570 });
    expect(eventOnDay(event("junk", "soon", "later"), TODAY)).toBeNull();
    expect(eventOnDay(event("tomorrow", at(1, 9, 0, 10), at(1, 10, 0, 10)), TODAY)).toBeNull();
  });

  it("links only https addresses", () => {
    expect(httpsUrl("https://calendar.google.com/event?eid=1")).toBe("https://calendar.google.com/event?eid=1");
    expect(httpsUrl("http://calendar.google.com/")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("not a url")).toBeNull();
    expect(httpsUrl(undefined)).toBeNull();
  });
});

describe("layoutLanes", () => {
  it("keeps items that do not overlap full width", () => {
    const out = layoutLanes([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 600, end: 660 },
    ]);
    expect(out.map((o) => [o.id, o.lane, o.lanes])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });

  it("puts overlapping meetings side by side", () => {
    const out = layoutLanes([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 570, end: 630 },
      { id: "c", start: 700, end: 720 },
    ]);
    const byId = Object.fromEntries(out.map((o) => [o.id, o]));
    expect([byId.a!.lane, byId.a!.lanes]).toEqual([0, 2]);
    expect([byId.b!.lane, byId.b!.lanes]).toEqual([1, 2]);
    expect([byId.c!.lane, byId.c!.lanes]).toEqual([0, 1]);
  });

  it("reuses a freed lane inside a chained cluster", () => {
    // a overlaps b, b overlaps c, a and c do not: two lanes for all three.
    const out = layoutLanes([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 580, end: 660 },
      { id: "c", start: 610, end: 640 },
    ]);
    const byId = Object.fromEntries(out.map((o) => [o.id, o]));
    expect(byId.a!.lane).toBe(0);
    expect(byId.b!.lane).toBe(1);
    expect(byId.c!.lane).toBe(0);
    expect(out.every((o) => o.lanes === 2)).toBe(true);
  });

  it("uses three lanes when three overlap at once", () => {
    const out = layoutLanes([
      { id: "a", start: 540, end: 660 },
      { id: "b", start: 560, end: 620 },
      { id: "c", start: 580, end: 600 },
    ]);
    expect(out.map((o) => o.lane).sort()).toEqual([0, 1, 2]);
    expect(out.every((o) => o.lanes === 3)).toBe(true);
  });

  it("treats short items as their drawn length", () => {
    const short = [
      { id: "a", start: 540, end: 550 },
      { id: "b", start: 550, end: 560 },
    ];
    expect(layoutLanes(short).every((o) => o.lanes === 1)).toBe(true);
    expect(layoutLanes(short, 25).every((o) => o.lanes === 2)).toBe(true);
  });
});

describe("dayBounds and free gaps", () => {
  it("shows 08:00 to 18:00, stretched to the earliest and latest item", () => {
    expect(dayBounds([])).toEqual({ start: DAY_START, end: DAY_END });
    expect(dayBounds([{ start: 7 * 60 + 30, end: 8 * 60 + 30 }])).toEqual({ start: 420, end: DAY_END });
    expect(dayBounds([{ start: 18 * 60, end: 19 * 60 + 10 }])).toEqual({ start: DAY_START, end: 1200 });
    expect(dayBounds([{ start: 1380, end: 1440 }]).end).toBe(1440);
  });

  it("finds the free gaps around busy items", () => {
    const gaps = freeGaps(
      [
        { start: 540, end: 600 },
        { start: 570, end: 630 },
        { start: 900, end: 960 },
      ],
      DAY_START,
      DAY_END,
    );
    expect(gaps).toEqual([
      { start: 480, end: 540 },
      { start: 630, end: 900 },
      { start: 960, end: 1080 },
    ]);
    expect(totalMinutes(gaps)).toBe(60 + 270 + 120);
    expect(firstFit(gaps, 90)).toBe(630);
    expect(firstFit(gaps, 300)).toBeNull();
  });

  it("skips gaps shorter than the minimum and items outside the window", () => {
    expect(freeGaps([{ start: 490, end: 1070 }], DAY_START, DAY_END)).toEqual([]);
    expect(freeGaps([{ start: 300, end: 400 }], DAY_START, DAY_END)).toEqual([{ start: 480, end: 1080 }]);
    expect(freeGaps([], 1075, 1080)).toEqual([]);
  });
});

describe("buildDay", () => {
  const day = {
    date: TODAY,
    events: [
      event("standup", at(31, 9), at(31, 9, 30), "Standup"),
      event("offsite", TODAY, "2026-11-01", "Offsite"),
    ],
    tasks: [task("Tasks/write.md", TODAY, "10:00", 60), task("Tasks/call.md", TODAY), task("Tasks/old.md", TODAY, "08:00", 30, true)],
  };

  it("splits all-day meetings, timed blocks and any-time tasks", () => {
    const model = buildDay(day, TODAY, [plan("p1", TODAY, "09:15", 45), plan("p2", TODAY, null), plan("p3", "2026-11-01", "09:00")]);
    expect(model.allDay.map((e) => e.id)).toEqual(["offsite"]);
    expect(model.blocks.map((b) => b.id)).toEqual(["task:Tasks/old.md", "event:standup", "plan:p1", "task:Tasks/write.md"]);
    expect(model.anytime.map((t) => t.path)).toEqual(["Tasks/call.md"]);
    expect(model.anytimePlan.map((p) => p.id)).toEqual(["p2"]);
    expect(model.meetings).toBe(2);
    expect(model.tasks).toBe(3);
  });

  it("shows a plan item that collides with a meeting", () => {
    const model = buildDay(day, TODAY, [plan("clash", TODAY, "09:00", 30)]);
    const laned = layoutLanes(model.blocks);
    const clash = laned.find((b) => b.id === "plan:clash")!;
    expect(clash.lanes).toBe(2);
  });

  it("handles a day the range does not have", () => {
    const model = buildDay(undefined, TODAY, []);
    expect(model.blocks).toEqual([]);
    expect(model.meetings).toBe(0);
  });

  it("counts free time from now on today, nothing on a past day", () => {
    const model = buildDay(day, TODAY, []);
    // now 10:07 rounds to 10:15; the write task runs 10:00 to 11:00; done tasks do not count.
    expect(dayFreeGaps(model, TODAY, 607)).toEqual([{ start: 660, end: DAY_END }]);
    // A later day counts from 08:00. The standup ended on the 31st, so it is not busy time on the 1st.
    const tomorrow = buildDay({ ...day, date: "2026-11-01" }, "2026-11-01", []);
    expect(tomorrow.blocks.some((b) => b.kind === "event")).toBe(false);
    expect(dayFreeGaps(tomorrow, TODAY, 607)).toEqual([
      { start: DAY_START, end: 600 },
      { start: 660, end: DAY_END },
    ]);
    expect(dayFreeGaps(buildDay(undefined, "2026-11-01", []), TODAY, 607)).toEqual([{ start: DAY_START, end: DAY_END }]);
    expect(dayFreeGaps(buildDay(undefined, "2026-10-30", []), TODAY, 607)).toEqual([]);
  });
});

describe("buildWeek", () => {
  it("builds seven columns from the start day, sorted inside each", () => {
    const r = range(TODAY, "2026-11-06", [
      {
        date: TODAY,
        events: [event("late", at(31, 15), at(31, 16), "Review"), event("all", TODAY, "2026-11-01", "Holiday")],
        tasks: [task("Tasks/any.md", TODAY), task("Tasks/early.md", TODAY, "09:00", 30)],
      },
      { date: "2026-11-02", events: [], tasks: [task("Tasks/mon.md", "2026-11-02", "11:00", 60)] },
    ]);
    const cols = buildWeek(r, TODAY, TODAY, [plan("p", TODAY, "15:00"), plan("q", "2026-11-03", null)]);
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.date)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(cols[0]!.weekday).toBe("Sat");
    expect(cols[0]!.dayNum).toBe(31);
    expect(cols[0]!.isToday).toBe(true);
    expect(cols[1]!.isToday).toBe(false);
    expect(cols[0]!.rows.map((x) => x.id)).toEqual(["event:all", "task:Tasks/early.md", "event:late", "plan:p", "task:Tasks/any.md"]);
    expect(cols[1]!.rows).toEqual([]);
    expect(cols[2]!.rows.map((x) => x.id)).toEqual(["task:Tasks/mon.md"]);
    expect(cols[3]!.rows.map((x) => x.id)).toEqual(["plan:q"]);
  });

  it("marks past days and copes with no data", () => {
    const cols = buildWeek(null, "2026-10-28", TODAY, []);
    expect(cols.map((c) => c.isPast)).toEqual([true, true, true, false, false, false, false]);
    expect(cols[3]!.isToday).toBe(true);
    expect(buildWeek(null, "bad", TODAY, [])).toEqual([]);
  });
});

describe("notPlaced", () => {
  it("lists overdue tasks oldest first, then tasks with no day", () => {
    const r = range(TODAY, TODAY, [{ date: TODAY, events: [], tasks: [] }], {
      overdue: [task("Tasks/b.md", "2026-10-29"), task("Tasks/a.md", "2026-10-20"), task("Tasks/done.md", "2026-10-20", null, null, true)],
      unscheduled: [task("Tasks/z.md", null), task("Tasks/m.md", null)],
    });
    expect(notPlaced(r, TODAY).map((u) => [u.task.path, u.reason])).toEqual([
      ["Tasks/a.md", "overdue"],
      ["Tasks/b.md", "overdue"],
      ["Tasks/m.md", "unscheduled"],
      ["Tasks/z.md", "unscheduled"],
    ]);
  });

  it("does not call today's tasks overdue when a later day is shown", () => {
    const r = range("2026-11-01", "2026-11-01", [{ date: "2026-11-01", events: [], tasks: [] }], {
      overdue: [task("Tasks/today.md", TODAY), task("Tasks/old.md", "2026-10-25")],
    });
    expect(notPlaced(r, TODAY).map((u) => u.task.path)).toEqual(["Tasks/old.md"]);
  });

  it("includes open tasks of a past day being shown", () => {
    const r = range("2026-10-28", "2026-10-28", [{ date: "2026-10-28", events: [], tasks: [task("Tasks/past.md", "2026-10-28")] }]);
    expect(notPlaced(r, TODAY).map((u) => u.task.path)).toEqual(["Tasks/past.md"]);
    expect(notPlaced(null, TODAY)).toEqual([]);
  });
});

describe("local edits", () => {
  const base = range(TODAY, "2026-11-01", [
    { date: TODAY, events: [], tasks: [task("Tasks/a.md", TODAY, "11:00", 30)] },
    { date: "2026-11-01", events: [], tasks: [] },
  ], { unscheduled: [task("Tasks/u.md", null)], overdue: [task("Tasks/o.md", "2026-10-20")] });

  it("adds a new task to its day, sorted by start with no-start last", () => {
    const next = withTask(withTask(base, task("Tasks/n.md", TODAY, "09:00", 30)), task("Tasks/x.md", TODAY));
    expect(next.days[0]!.tasks.map((t) => t.path)).toEqual(["Tasks/n.md", "Tasks/a.md", "Tasks/x.md"]);
  });

  it("files tasks with no day and earlier days", () => {
    expect(withTask(base, task("Tasks/new.md", null)).unscheduled.map((t) => t.path)).toEqual(["Tasks/u.md", "Tasks/new.md"]);
    expect(withTask(base, task("Tasks/late.md", "2026-10-25")).overdue.map((t) => t.path)).toEqual(["Tasks/o.md", "Tasks/late.md"]);
    const outside = withTask(base, task("Tasks/far.md", "2026-11-20"));
    expect(findTask(outside, "Tasks/far.md")).toBeNull();
  });

  it("moves a task to today and ticks it done", () => {
    const moved = patchTask(base, "Tasks/u.md", { due: TODAY });
    expect(moved.unscheduled).toEqual([]);
    expect(moved.days[0]!.tasks.map((t) => t.path)).toEqual(["Tasks/a.md", "Tasks/u.md"]);
    const done = patchTask(base, "Tasks/a.md", { done: true });
    expect(findTask(done, "Tasks/a.md")!.task.done).toBe(true);
    const doneOverdue = patchTask(base, "Tasks/o.md", { done: true });
    expect(doneOverdue.overdue).toEqual([]);
    expect(patchTask(base, "Tasks/none.md", { done: true })).toBe(base);
  });
});

describe("plan", () => {
  const ready: SchedulePlan = {
    status: "ready",
    scope: "day",
    generatedAt: "2026-10-31T06:00:00.000Z",
    items: [plan("a", TODAY, "10:00"), plan("b", TODAY, "11:00")],
  };

  it("has items to review only when ready", () => {
    expect(planItems(ready)).toHaveLength(2);
    expect(planItems({ ...ready, status: "error" })).toEqual([]);
    expect(planItems(null)).toEqual([]);
  });

  it("drops accepted items", () => {
    expect(withoutPlanItems(ready, ["a"]).items.map((i) => i.id)).toEqual(["b"]);
  });
});
