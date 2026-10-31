import { describe, expect, it } from "vitest";
import type { NoteMeta, Project, ProjectsState, ProjectStats, ProjectTask } from "../../../shared/types";
import {
  addedProject,
  areaCounts,
  boardSummary,
  buildCards,
  dailySeries,
  deadlineInfo,
  displayName,
  groupCards,
  meetingNoteTitle,
  projectInputFrom,
  rankProjectsFor,
  seenText,
  sortTasks,
  taskDueInfo,
  taskProgress,
  trackInput,
  validateProjectForm,
  weekTotal,
  withoutSource,
  withSource,
  emptyProjectForm,
  LIMITS,
} from "./projects";

// Friday 30 October 2026, 14:00 local. Its week runs Sunday 25 to Saturday 31 October.
const now = new Date(2026, 9, 30, 14, 0, 0);

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id.toUpperCase(),
    area: "work",
    status: "active",
    deadline: null,
    description: "",
    goals: [],
    tasks: [],
    sources: { sessions: [], repos: [] },
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...extra,
  };
}

function stats(id: string, minutesByDay: Record<string, number> = {}, extra: Partial<ProjectStats> = {}): ProjectStats {
  return { id, minutesByDay, commitsByDay: {}, openTasks: 0, doneTasks: 0, noteCount: 0, lastNoteAt: null, ...extra };
}

function task(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { id, text: `Task ${id}`, done: false, due: null, doneAt: null, createdAt: "2026-10-01T09:00:00.000Z", ...extra };
}

function note(path: string, projectId: string | null, openActions: number, updated = "2026-10-29T10:00:00.000Z"): NoteMeta {
  return { path, section: "Meeting notes", title: path, created: updated, updated, projectId, tags: [], excerpt: "", openActions, vault: "notes", readOnly: false };
}

function state(projects: Project[], allStats: ProjectStats[] = []): ProjectsState {
  return { projects, stats: allStats, untracked: [], hidden: [] };
}

describe("deadline countdown", () => {
  it("counts whole local days and words them", () => {
    expect(deadlineInfo("2026-10-30", now)).toMatchObject({ days: 0, label: "Due today", tone: "danger", overdue: false });
    expect(deadlineInfo("2026-10-31", now)).toMatchObject({ days: 1, label: "Due tomorrow", tone: "danger" });
    expect(deadlineInfo("2026-11-01", now)).toMatchObject({ days: 2, label: "Due in 2 days", tone: "danger" });
    expect(deadlineInfo("2026-11-12", now)).toMatchObject({ days: 13, label: "Due in 13 days", tone: "calm" });
    expect(deadlineInfo("2026-12-24", now)).toMatchObject({ label: "Due 24 Dec", tone: "calm" });
    expect(deadlineInfo("2027-01-05", now)?.label).toBe("Due 5 Jan 2027");
  });

  it("is red under 3 days, amber within the week", () => {
    expect(deadlineInfo("2026-11-02", now)?.tone).toBe("warn"); // 3 days
    expect(deadlineInfo("2026-11-05", now)?.tone).toBe("warn"); // 6 days
    expect(deadlineInfo("2026-11-06", now)?.tone).toBe("calm"); // 7 days
  });

  it("marks a passed deadline overdue and red", () => {
    expect(deadlineInfo("2026-10-29", now)).toMatchObject({ days: -1, label: "1 day overdue", tone: "danger", overdue: true });
    expect(deadlineInfo("2026-10-20", now)?.label).toBe("10 days overdue");
  });

  it("stays calm for paused, idea and done projects", () => {
    expect(deadlineInfo("2026-10-31", now, "paused")?.tone).toBe("calm");
    expect(deadlineInfo("2026-10-20", now, "idea")).toMatchObject({ tone: "calm", overdue: true });
    expect(deadlineInfo("2026-10-20", now, "done")).toMatchObject({ label: "Deadline 20 Oct", tone: "calm", overdue: false });
  });

  it("ignores a missing or broken date", () => {
    expect(deadlineInfo(null, now)).toBeNull();
    expect(deadlineInfo("2026-02-30", now)).toBeNull();
    expect(deadlineInfo("soon", now)).toBeNull();
  });

  it("words task due dates shorter", () => {
    expect(taskDueInfo("2026-10-28", now)).toEqual({ label: "2 days late", tone: "danger" });
    expect(taskDueInfo("2026-10-30", now)).toEqual({ label: "Today", tone: "danger" });
    expect(taskDueInfo("2026-10-31", now)).toEqual({ label: "Tomorrow", tone: "warn" });
    expect(taskDueInfo("2026-11-03", now)).toEqual({ label: "In 4 days", tone: "calm" });
    expect(taskDueInfo("2026-11-20", now)).toEqual({ label: "20 Nov", tone: "calm" });
    expect(taskDueInfo("2026-10-28", now, true)).toEqual({ label: "28 Oct", tone: "calm" });
  });
});

describe("task progress", () => {
  it("counts done tasks", () => {
    expect(taskProgress([])).toEqual({ done: 0, total: 0, fraction: 0, label: "No tasks yet" });
    expect(taskProgress([{ done: true }, { done: false }, { done: false }, { done: true }])).toMatchObject({
      done: 2,
      total: 4,
      fraction: 0.5,
      label: "2 of 4 tasks done",
    });
    expect(taskProgress([{ done: true }]).label).toBe("All 1 task done");
  });

  it("handles 200 tasks", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ done: i < 150 }));
    expect(taskProgress(many)).toMatchObject({ done: 150, total: 200, fraction: 0.75 });
  });

  it("sorts open tasks by due date, no date last, then done tasks newest first", () => {
    const sorted = sortTasks([
      task("done-old", { done: true, doneAt: "2026-10-20T10:00:00Z" }),
      task("no-date", { createdAt: "2026-09-01T00:00:00Z" }),
      task("later", { due: "2026-11-10" }),
      task("done-new", { done: true, doneAt: "2026-10-29T10:00:00Z" }),
      task("overdue", { due: "2026-10-01" }),
      task("no-date-2", { createdAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["overdue", "later", "no-date", "no-date-2", "done-new", "done-old"]);
  });
});

describe("time per project", () => {
  it("totals this week from Sunday and draws 14 days ending today", () => {
    const byDay = { "2026-10-24": 500, "2026-10-25": 30, "2026-10-30": 45, "2026-10-31": 999, "2026-10-17": 20 };
    expect(weekTotal(byDay, now)).toBe(30 + 45 + 999); // future days of this week add whatever the server sent
    const series = dailySeries(byDay, now);
    expect(series).toHaveLength(14);
    expect(series[0]).toBe(20); // 17 Oct
    expect(series[13]).toBe(45); // today
    expect(series[7]).toBe(500); // 24 Oct
    expect(dailySeries(undefined, now, 3)).toEqual([0, 0, 0]);
  });

  it("ignores junk values", () => {
    expect(weekTotal({ "2026-10-26": -5, "2026-10-27": Number.NaN, "2026-10-28": 10 }, now)).toBe(10);
  });
});

describe("board grouping and sort", () => {
  const projects = [
    project("busy", { updatedAt: "2026-10-28T00:00:00Z" }),
    project("quiet"),
    project("deadline-far", { deadline: "2027-03-01" }),
    project("deadline-soon", { deadline: "2026-11-03" }),
    project("overdue", { deadline: "2026-10-25" }),
    project("paused-old", { status: "paused", updatedAt: "2026-09-01T00:00:00Z" }),
    project("paused-new", { status: "paused", updatedAt: "2026-10-29T00:00:00Z" }),
    project("someday", { status: "idea", area: "personal" }),
    project("shipped", { status: "done", area: "learning" }),
  ];
  const allStats = [stats("busy", { "2026-10-29": 120 }), stats("quiet", { "2026-10-29": 10 }), stats("deadline-far", { "2026-10-29": 300 })];
  const cards = buildCards(state(projects, allStats), [], now);

  it("groups by status in board order and keeps empty groups", () => {
    const groups = groupCards(cards);
    expect(groups.map((g) => g.label)).toEqual(["Active", "Paused", "Ideas", "Done"]);
    expect(groups.map((g) => g.cards.length)).toEqual([5, 2, 1, 1]);
    expect(groupCards([]).every((g) => g.cards.length === 0)).toBe(true);
  });

  it("leads Active with near deadlines, then the most time this week", () => {
    const active = groupCards(cards)[0]!.cards.map((c) => c.project.id);
    expect(active).toEqual(["overdue", "deadline-soon", "deadline-far", "busy", "quiet"]);
  });

  it("orders paused, idea and done by last change", () => {
    expect(groupCards(cards)[1]!.cards.map((c) => c.project.id)).toEqual(["paused-new", "paused-old"]);
  });

  it("filters by area and counts each area", () => {
    const personal = groupCards(cards, "personal");
    expect(personal.flatMap((g) => g.cards.map((c) => c.project.id))).toEqual(["someday"]);
    expect(areaCounts(projects)).toEqual({ all: 9, work: 7, learning: 1, personal: 1 });
  });

  it("sums open actions from linked notes, or null when notes could not be read", () => {
    const withNotes = buildCards(
      state([project("a"), project("b")]),
      [note("n1.md", "a", 2), note("n2.md", "a", 1, "2026-10-30T09:00:00Z"), note("n3.md", null, 5), note("n4.md", "b", 0)],
      now,
    );
    expect(withNotes[0]).toMatchObject({ openActions: 3, noteCount: 2, lastNoteAt: "2026-10-30T09:00:00Z" });
    expect(withNotes[1]).toMatchObject({ openActions: 0 });
    expect(buildCards(state([project("a")]), null, now)[0]!.openActions).toBeNull();
  });

  it("summarises the board", () => {
    const summary = boardSummary(cards);
    expect(summary).toMatchObject({ active: 5, dueSoon: 2, overdue: 1, weekMinutes: 430 });
  });

  it("keeps 40 projects in a stable order", () => {
    const forty = Array.from({ length: 40 }, (_, i) => project(`p${i}`, { name: `Project ${i}` }));
    const first = groupCards(buildCards(state(forty), [], now))[0]!.cards.map((c) => c.project.id);
    const again = groupCards(buildCards(state([...forty].reverse()), [], now))[0]!.cards.map((c) => c.project.id);
    expect(first).toHaveLength(40);
    expect(again).toEqual(first);
    expect(first.slice(0, 3)).toEqual(["p0", "p1", "p2"]); // numeric-aware name order
  });
});

describe("sources and untracked names", () => {
  it("says when a detected name was last seen, in local days", () => {
    expect(seenText("2026-10-30", now)).toBe("today");
    expect(seenText("2026-10-29", now)).toBe("yesterday");
    expect(seenText("2026-10-17", now)).toBe("13 days ago");
    expect(seenText(null, now)).toBe("never");
  });

  it("drops the owner from repo names", () => {
    expect(displayName("islam543/QIC-FastBind")).toBe("QIC-FastBind");
    expect(displayName("Working-With-Claude")).toBe("Working-With-Claude");
  });

  it("adds and removes a source without duplicates", () => {
    const base = { sessions: ["A"], repos: [] };
    const added = withSource(withSource(base, { name: "me/a", kind: "repo" }), { name: "me/a", kind: "repo" });
    expect(added).toEqual({ sessions: ["A"], repos: ["me/a"] });
    expect(base.repos).toEqual([]); // not mutated
    expect(withoutSource(added, "session", "A")).toEqual({ sessions: [], repos: ["me/a"] });
  });

  it("tracks a detected name as an active work project", () => {
    expect(trackInput({ name: "islam543/TeaNJuice", kind: "repo" })).toEqual({
      name: "TeaNJuice",
      area: "work",
      status: "active",
      sources: { sessions: [], repos: ["islam543/TeaNJuice"] },
    });
  });

  it("suggests the project with the same name first", () => {
    const ranked = rankProjectsFor("islam543/QIC-FastBind", [
      project("nps", { name: "NPS" }),
      project("idea", { name: "Alpha", status: "idea" }),
      project("fb", { name: "FastBind", sources: { sessions: ["QIC-FastBind"], repos: [] }, status: "paused" }),
    ]);
    expect(ranked.map((r) => [r.project.id, r.suggested])).toEqual([
      ["fb", true],
      ["nps", false],
      ["idea", false],
    ]);
  });
});

describe("new project form", () => {
  it("asks for a name and keeps within the limits", () => {
    const v = emptyProjectForm();
    expect(validateProjectForm(v)).toEqual({ name: "Enter a project name." });
    expect(validateProjectForm({ ...v, name: "   " }).name).toBe("Enter a project name.");
    expect(validateProjectForm({ ...v, name: "x".repeat(LIMITS.name + 1) }).name).toContain("80 characters");
    expect(validateProjectForm({ ...v, name: "ok", deadline: "2026-02-30" }).deadline).toBeDefined();
    expect(validateProjectForm({ ...v, name: "ok", description: "d".repeat(2001) }).description).toBeDefined();
    expect(validateProjectForm({ ...v, name: "مشروع جديد" })).toEqual({});
  });

  it("builds the request body", () => {
    const body = projectInputFrom({
      ...emptyProjectForm(),
      name: "  Thesis ",
      area: "learning",
      deadline: "",
      sources: [
        { name: "Thesis", kind: "session" },
        { name: "me/thesis", kind: "repo" },
      ],
    });
    expect(body).toEqual({
      name: "Thesis",
      area: "learning",
      status: "active",
      deadline: null,
      description: "",
      sources: { sessions: ["Thesis"], repos: ["me/thesis"] },
    });
  });

  it("finds the project a create added", () => {
    expect(addedProject([{ id: "a" }], [project("a"), project("b")])?.id).toBe("b");
    expect(addedProject([{ id: "a" }], [project("a")])).toBeNull();
  });

  it("titles a meeting note within the note title limit", () => {
    expect(meetingNoteTitle("FastBind", now)).toBe("FastBind meeting, 30 Oct");
    const long = meetingNoteTitle("x".repeat(200), now);
    expect([...long].length).toBeLessThanOrEqual(120);
    expect(long.endsWith(" meeting, 30 Oct")).toBe(true);
  });
});
