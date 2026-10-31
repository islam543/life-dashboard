import { describe, expect, it } from "vitest";
import type { Project, TaskNote } from "../shared/types";
import { jiraKeyOf, MAX_FOCUS_ITEMS, pickFocus, projectNameOf, shortDate } from "./focus";

// Do now selection: pure, the clock is an argument.

const NOW = new Date("2026-11-01T11:30:00Z"); // Sunday 14:30 in Doha
const SUN = "2026-11-01";

const task = (
  title: string,
  due: string | null,
  opts: { start?: string; minutes?: number; done?: boolean; created?: string } = {},
): TaskNote => ({
  path: `Tasks/${title}.md`, section: "Tasks", title, created: opts.created ?? "2026-10-30T09:00:00+03:00", updated: "2026-10-30T09:00:00+03:00",
  projectId: null, tags: [], excerpt: "", openActions: 0, vault: "notes", readOnly: false,
  task: { due, start: opts.start ?? null, minutes: opts.minutes ?? null, done: opts.done ?? false, source: "me" },
});
const view = (picks: ReturnType<typeof pickFocus>) => picks.map((p) => [p.task.title, p.reason, p.label]);

describe("pickFocus", () => {
  const tasks = [
    task("No time", SUN),
    task("Later still", SUN, { start: "17:30", minutes: 30 }),
    task("Old overdue", "2026-10-29"),
    task("In block", SUN, { start: "14:00", minutes: 60 }),
    task("Missed", SUN, { start: "09:00", minutes: 30 }),
    task("Later", SUN, { start: "16:00" }),
    task("Older overdue", "2026-10-20", { start: "10:00" }),
    task("Done", SUN, { start: "14:00", done: true }),
    task("Undated", null),
    task("Tomorrow", "2026-11-02", { start: "09:00" }),
  ];

  it("orders now, next, overdue (oldest first, then blocks missed today), today without a time; at most 6", () => {
    expect(view(pickFocus(tasks, NOW))).toEqual([
      ["In block", "now", "Now until 15:00"],
      ["Later", "next", "Next at 16:00"],
      ["Later still", "next", "Next at 17:30"],
      ["Older overdue", "overdue", "Overdue since Tue 20 Oct"],
      ["Old overdue", "overdue", "Overdue since Thu 29 Oct"],
      ["Missed", "overdue", "Overdue since 09:30"],
    ]);
    expect(MAX_FOCUS_ITEMS).toBe(6);
  });

  it("labels today's untimed tasks, oldest first", () => {
    const picks = pickFocus([task("B", SUN, { created: "2026-10-31T10:00:00+03:00" }), task("A", SUN, { created: "2026-10-30T10:00:00+03:00" })], NOW);
    expect(view(picks)).toEqual([
      ["A", "today", "Today, no time set"],
      ["B", "today", "Today, no time set"],
    ]);
  });

  it("a block with no minutes lasts 30 minutes; its end is exclusive", () => {
    expect(view(pickFocus([task("Short", SUN, { start: "14:15" })], NOW))).toEqual([["Short", "now", "Now until 14:45"]]);
    expect(view(pickFocus([task("Ended", SUN, { start: "14:00" })], NOW))).toEqual([["Ended", "overdue", "Overdue since 14:30"]]);
  });

  it("is empty with no tasks, or only done, undated and future ones", () => {
    expect(pickFocus([], NOW)).toEqual([]);
    expect(pickFocus([task("Done", SUN, { done: true }), task("Undated", null), task("Next week", "2026-11-08")], NOW)).toEqual([]);
  });

  it("rolls over at midnight in Doha", () => {
    const late = task("Late block", SUN, { start: "23:30", minutes: 60 });
    const monday = task("Monday", "2026-11-02");
    expect(view(pickFocus([late, monday], new Date("2026-11-01T20:50:00Z")))).toEqual([["Late block", "now", "Now until 00:30"]]); // 23:50
    expect(view(pickFocus([late, monday], new Date("2026-11-01T21:05:00Z")))).toEqual([
      ["Late block", "overdue", "Overdue since Sun 1 Nov"],
      ["Monday", "today", "Today, no time set"],
    ]); // 00:05 Monday
  });
});

describe("helpers", () => {
  it("shortDate reads like Thu 29 Oct", () => {
    expect(shortDate("2026-10-29")).toBe("Thu 29 Oct");
    expect(shortDate("2026-11-01")).toBe("Sun 1 Nov");
  });

  it("jiraKeyOf takes the first AN key from the title, else the body", () => {
    expect(jiraKeyOf("Fix AN-4602 and AN-1", "AN-9")).toBe("AN-4602");
    expect(jiraKeyOf("Send slip", "See PLAN-12, SCAN-5 and AN-77 then AN-78")).toBe("AN-77");
    expect(jiraKeyOf("Send slip", "an-5 and XAN-6")).toBeNull();
    expect(jiraKeyOf("", "")).toBeNull();
  });

  it("projectNameOf reads the registry", () => {
    const projects = [{ id: "qic-fastbind", name: "QIC FastBind" }] as Project[];
    expect(projectNameOf(projects, "qic-fastbind")).toBe("QIC FastBind");
    expect(projectNameOf(projects, "gone")).toBeNull();
    expect(projectNameOf(projects, null)).toBeNull();
  });
});
