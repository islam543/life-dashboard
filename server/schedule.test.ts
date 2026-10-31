import { describe, expect, it } from "vitest";
import type { CalendarEvent, TaskInfo, TaskNote } from "../shared/types";
import {
  addDays,
  buildScheduleRange,
  eventDay,
  isWorkday,
  parseNewTaskInput,
  parseRangeQuery,
  parseTaskPatch,
  qatarDateKey,
  qatarTime,
  taskNotes,
} from "./schedule";

// Pure parts of the schedule: dates in Asia/Qatar, request validation and the range.

function task(name: string, t: Partial<TaskInfo> = {}, created = "2026-10-30T09:00:00+03:00"): TaskNote {
  return {
    path: `Tasks/${name}.md`, section: "Tasks", title: name, created, updated: created, projectId: null, tags: [],
    excerpt: "", openActions: 0,
    task: { due: null, start: null, minutes: null, done: false, source: "me", ...t },
  };
}
const event = (id: string, start: string, end = start): CalendarEvent => ({ id, title: `Meeting ${id}`, start, end });
const titles = (list: { title: string }[]) => list.map((x) => x.title);

describe("Asia/Qatar dates", () => {
  it("days and times follow UTC+3 around midnight", () => {
    expect(qatarDateKey(new Date("2026-10-31T20:59:00Z"))).toBe("2026-10-31");
    expect(qatarDateKey(new Date("2026-10-31T21:00:00Z"))).toBe("2026-11-01");
    expect(qatarTime(new Date("2026-10-31T21:05:00Z"))).toBe("00:05");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("an event belongs to the Qatar day its start falls on; all-day events to their date", () => {
    expect(eventDay("2026-11-01T23:30:00+03:00")).toBe("2026-11-01");
    expect(eventDay("2026-11-01T21:30:00Z")).toBe("2026-11-02"); // 00:30 in Doha
    expect(eventDay("2026-11-01")).toBe("2026-11-01");
    expect(eventDay("not a date")).toBeNull();
  });

  it("workdays are Sunday to Thursday", () => {
    // 2026-11-01 is a Sunday.
    expect(["2026-11-01", "2026-11-05", "2026-11-06", "2026-11-07"].map(isWorkday)).toEqual([true, true, false, false]);
  });
});

describe("parseRangeQuery", () => {
  it("accepts up to 14 days, from equal to to included", () => {
    expect(parseRangeQuery("2026-11-01", "2026-11-14")).toEqual({ from: "2026-11-01", to: "2026-11-14" });
    expect(parseRangeQuery("2026-11-01", "2026-11-01")).toEqual({ from: "2026-11-01", to: "2026-11-01" });
  });

  it.each([
    ["2026-11-01", "2026-11-15", /at most 14 days/],
    ["2026-11-10", "2026-11-01", /on or before/],
    ["2026-11-01", undefined, /YYYY-MM-DD/],
    ["2026-02-30", "2026-03-01", /YYYY-MM-DD/],
    ["2026-11-01T00:00", "2026-11-02", /YYYY-MM-DD/],
  ])("refuses %s .. %s", (from, to, message) => {
    expect(() => parseRangeQuery(from, to)).toThrow(message);
    try {
      parseRangeQuery(from, to);
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});

describe("parseNewTaskInput and parseTaskPatch", () => {
  it("reads a full body and fills missing nullable fields with null", () => {
    expect(parseNewTaskInput({ title: "  Send slip  ", projectId: "qic-fastbind", due: "2026-11-02", start: "09:30", minutes: 30, details: " a\r\nb " }))
      .toEqual({ title: "Send slip", projectId: "qic-fastbind", due: "2026-11-02", start: "09:30", minutes: 30, details: "a\nb" });
    expect(parseNewTaskInput({ title: "x" })).toEqual({ title: "x", projectId: null, due: null, start: null, minutes: null });
  });

  it.each([
    [[], /JSON object/],
    [{ title: "" }, /Title/],
    [{ title: "a\nb" }, /one line/],
    [{ title: "x", due: "2026-13-01" }, /due/],
    [{ title: "x", start: "7pm" }, /start/],
    [{ title: "x", start: "24:00" }, /start/],
    [{ title: "x", minutes: 0 }, /minutes/],
    [{ title: "x", minutes: 1.5 }, /minutes/],
    [{ title: "x", minutes: "30" }, /minutes/],
    [{ title: "x", projectId: "../etc" }, /projectId/],
    [{ title: "x", details: 5 }, /details/],
    [{ title: "x", details: "y".repeat(4001) }, /details/],
  ])("refuses a bad new task %#", (body, message) => {
    expect(() => parseNewTaskInput(body)).toThrow(message);
  });

  it("a patch keeps only the given fields and needs at least one", () => {
    expect(parseTaskPatch({ done: true })).toEqual({ done: true });
    expect(parseTaskPatch({ due: null, start: null, minutes: null, projectId: null })).toEqual({ due: null, start: null, minutes: null, projectId: null });
    expect(() => parseTaskPatch({})).toThrow(/at least one/);
    expect(() => parseTaskPatch({ done: "yes" })).toThrow(/done/);
    expect(() => parseTaskPatch({ title: 7 })).toThrow(/Title/);
  });
});

describe("buildScheduleRange", () => {
  const calendar = { status: "ok" as const, message: "Via Claude connector" };

  it("puts events and tasks on their days, sorted, with unscheduled and overdue lists", () => {
    const tasks = [
      task("late open", { due: "2026-10-29", start: "10:00" }),
      task("late done", { due: "2026-10-29", done: true }),
      task("later late", { due: "2026-10-30" }),
      task("no start", { due: "2026-11-01" }),
      task("at nine", { due: "2026-11-01", start: "09:00" }),
      task("at eight", { due: "2026-11-01", start: "08:00", done: true }),
      task("undated new", {}, "2026-10-31T09:00:00+03:00"),
      task("undated old", {}, "2026-10-20T09:00:00+03:00"),
      task("undated done", { done: true }),
      task("after range", { due: "2026-11-05" }),
    ];
    const events = [
      event("b", "2026-11-01T11:00:00+03:00", "2026-11-01T12:00:00+03:00"),
      event("a", "2026-11-01T08:00:00+03:00", "2026-11-01T08:30:00+03:00"),
      event("all-day", "2026-11-01", "2026-11-02"),
      event("late-night", "2026-11-02T21:30:00Z"), // 00:30 on 2026-11-03 in Doha: outside the range
      event("before", "2026-10-31T23:00:00+03:00"),
      event("broken", "soon"),
    ];
    const range = buildScheduleRange({ from: "2026-11-01", to: "2026-11-02", events, tasks, calendar });

    expect(range.from).toBe("2026-11-01");
    expect(range.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(range.days[0]!.events.map((e) => e.id)).toEqual(["all-day", "a", "b"]);
    expect(titles(range.days[0]!.tasks)).toEqual(["at eight", "at nine", "no start"]);
    expect(range.days[1]).toEqual({ date: "2026-11-02", events: [], tasks: [] });
    expect(titles(range.unscheduled)).toEqual(["undated old", "undated new"]);
    expect(titles(range.overdue)).toEqual(["late open", "later late"]);
    expect(range.calendar).toEqual(calendar);
  });

  it("a meeting at 00:30 Doha time lands on that day, not the UTC one", () => {
    const range = buildScheduleRange({
      from: "2026-11-02", to: "2026-11-03", events: [event("x", "2026-11-02T21:30:00Z")], tasks: [], calendar,
    });
    expect(range.days.map((d) => d.events.length)).toEqual([0, 1]);
  });

  it("mirrors a missing calendar connector and still lists tasks", () => {
    const range = buildScheduleRange({
      from: "2026-11-01", to: "2026-11-01", events: [], tasks: [task("t", { due: "2026-11-01" })],
      calendar: { status: "not_connected", message: "Connect Google Calendar" },
    });
    expect(range.calendar).toEqual({ status: "not_connected", message: "Connect Google Calendar" });
    expect(titles(range.days[0]!.tasks)).toEqual(["t"]);
  });

  it("two tasks with the same title both show, in path order", () => {
    const a = { ...task("same", { due: "2026-11-01" }), path: "Tasks/same.md" };
    const b = { ...task("same", { due: "2026-11-01" }), path: "Tasks/same-2.md" };
    const range = buildScheduleRange({ from: "2026-11-01", to: "2026-11-01", events: [], tasks: [a, b], calendar });
    expect(range.days[0]!.tasks.map((t) => t.path)).toEqual(["Tasks/same-2.md", "Tasks/same.md"]);
  });

  it("taskNotes keeps only notes that carry task fields", () => {
    const { task: _task, ...plain } = task("plain");
    expect(taskNotes([plain, task("real")]).map((t) => t.title)).toEqual(["real"]);
  });
});
