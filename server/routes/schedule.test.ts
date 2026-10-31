import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, NotesIndex, Project, ScheduleRange, SchedulePlan, Snapshot, TaskNote } from "../../shared/types";
import type { RunRequest, RunResult } from "../ai/nextMoves";
import { PLAN_FILE } from "../ai/schedulePlan";
import { createNotesStore } from "../notes";
import { emptySnapshot } from "../snapshot";
import { createStore, FILES, type Store } from "../store";
import { notesRoutes } from "./notes";
import { scheduleRoutes } from "./schedule";

// The schedule router mounted the way app.ts mounts it (next to /api/notes, same notes store),
// with app.ts's HTTPException -> ApiError mapping. Notes and data live in a temp folder; the plan
// run uses a fake runner, so the real claude CLI never runs.

const NOW = new Date("2026-11-01T06:00:00Z"); // Sunday 09:00 in Doha

let tmp: string;
let dir: string;
let store: Store;
let app: Hono;
let snapshot: Snapshot;
let refreshLocal: ReturnType<typeof vi.fn<() => Promise<Snapshot>>>;
let runs: RunRequest[];
let answer: RunResult;

const project = (id: string, deadline: string | null): Project => ({
  id, name: `Project ${id}`, area: "work", status: "active", deadline, description: "", goals: [], tasks: [],
  sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});
const ok = (result: string): RunResult => ({
  exitCode: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result }), stderr: "", timedOut: false,
});

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-schedule-api-"));
  dir = path.join(tmp, "vault", "notes");
  await mkdir(path.dirname(dir));
  store = createStore(path.join(tmp, "data"));
  snapshot = emptySnapshot(NOW);
  snapshot.calendar = [
    { id: "m1", title: "Sprint review", start: "2026-11-01T10:00:00+03:00", end: "2026-11-01T11:00:00+03:00" },
    { id: "m2", title: "Late call", start: "2026-11-01T21:30:00Z", end: "2026-11-01T22:00:00Z" }, // 00:30 on 11-02 in Doha
  ];
  snapshot.sources.calendar = { status: "ok", updatedAt: NOW.toISOString(), message: "Via Claude connector" };
  snapshot.projects.projects = [project("qic-fastbind", "2026-11-05")];
  refreshLocal = vi.fn(async () => snapshot);
  runs = [];
  answer = ok("[]");
  const notes = createNotesStore(dir, { now: () => NOW });
  const snapshots = { get: () => snapshot, refresh: async () => snapshot, refreshLocal };
  app = new Hono();
  app.route("/api/notes", notesRoutes({ notes, snapshots, now: () => NOW, log: () => undefined }));
  app.route(
    "/api/schedule",
    scheduleRoutes({
      notes, store, snapshots, now: () => NOW, log: () => undefined,
      planRunner: async (req) => {
        runs.push(req);
        return answer;
      },
    }),
  );
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status !== 500) return c.json({ error: err.message } satisfies ApiError, err.status);
    return c.json({ error: "Something went wrong on the server" } satisfies ApiError, 500);
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const q = (p: string) => `?path=${encodeURIComponent(p)}`;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function ok200<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

async function fails(res: Response, status: number, message?: RegExp): Promise<void> {
  expect(res.status, await res.clone().text()).toBe(status);
  const body = (await res.json()) as ApiError;
  expect(typeof body.error).toBe("string");
  if (message) expect(body.error).toMatch(message);
}

const fileText = (rel: string) => readFile(path.join(dir, ...rel.split("/")), "utf8");

describe("tasks", () => {
  it("POST creates notes/Tasks/<slug>.md (section made on first use) that shows in /api/notes and links its project", async () => {
    const task = await ok200<TaskNote>(
      await send("POST", "/api/schedule/tasks", {
        title: "Write the UAT plan", projectId: "qic-fastbind", due: "2026-11-02", start: "09:30", minutes: 45, details: "Cover renewals.",
      }),
      201,
    );
    expect(task).toMatchObject({
      path: "Tasks/write-the-uat-plan.md", section: "Tasks", title: "Write the UAT plan", projectId: "qic-fastbind",
      task: { due: "2026-11-02", start: "09:30", minutes: 45, done: false, source: "me" },
    });
    expect(task).not.toHaveProperty("body");
    expect(refreshLocal).toHaveBeenCalledTimes(1);

    const text = await fileText(task.path);
    expect(text).toContain("project: qic-fastbind\n");
    expect(text).toContain('task_due: 2026-11-02\ntask_start: "09:30"\ntask_minutes: 45\ntask_done: false\ntask_source: me\n');
    expect(text.endsWith("---\n\n# Write the UAT plan\n\nCover renewals.\n")).toBe(true);

    const index = await ok200<NotesIndex>(await app.request("/api/notes"));
    expect(index.sections.map((s) => s.path)).toContain("Tasks");
    const listed = index.notes.find((n) => n.path === task.path) as TaskNote | undefined;
    expect(listed).toMatchObject({ projectId: "qic-fastbind", task: task.task });
    const note = await ok200<TaskNote>(await app.request(`/api/notes/file${q(task.path)}`));
    expect(note.task).toEqual(task.task);
  });

  it("two tasks with the same title get unique slugs", async () => {
    const a = await ok200<TaskNote>(await send("POST", "/api/schedule/tasks", { title: "Call Ahmed" }), 201);
    const b = await ok200<TaskNote>(await send("POST", "/api/schedule/tasks", { title: "Call Ahmed" }), 201);
    expect([a.path, b.path]).toEqual(["Tasks/call-ahmed.md", "Tasks/call-ahmed-2.md"]);
    expect(b.task).toEqual({ due: null, start: null, minutes: null, done: false, source: "me" });
  });

  it("POST refuses bad input with 400 and writes nothing", async () => {
    await fails(await send("POST", "/api/schedule/tasks", { title: "" }), 400);
    await fails(await send("POST", "/api/schedule/tasks", { title: "x", due: "2026-11-31" }), 400, /due/);
    await fails(await send("POST", "/api/schedule/tasks", { title: "x", start: "9am" }), 400, /start/);
    await fails(await send("POST", "/api/schedule/tasks", { title: "x", minutes: -1 }), 400, /minutes/);
    await fails(await app.request("/api/schedule/tasks", { method: "POST", body: "{}" }), 400, /Content-Type/);
    await fails(await app.request("/api/schedule/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400);
    expect(refreshLocal).not.toHaveBeenCalled();
  });

  it("PATCH changes only the given fields and keeps hand-written keys and body", async () => {
    const created = await ok200<TaskNote>(
      await send("POST", "/api/schedule/tasks", { title: "Send slip", projectId: "qic-fastbind", due: "2026-11-02", start: "10:00", minutes: 30 }),
      201,
    );
    // Edited in Obsidian: an extra property and more body text.
    const file = path.join(dir, "Tasks", "send-slip.md");
    const edited = (await readFile(file, "utf8")).replace("task_source: me\n", "task_source: me\naliases: [slip]\n") + "\nMore notes.\n";
    await writeFile(file, edited);

    const done = await ok200<TaskNote>(await send("PATCH", `/api/schedule/tasks${q(created.path)}`, { done: true }));
    expect(done.task).toEqual({ ...created.task, done: true });
    expect(done.projectId).toBe("qic-fastbind");
    let text = await readFile(file, "utf8");
    expect(text).toContain("task_done: true\n");
    expect(text).toContain("aliases: [slip]\n");
    expect(text).toContain("More notes.");

    const moved = await ok200<TaskNote>(
      await send("PATCH", `/api/schedule/tasks${q(created.path)}`, { title: "Send the signed slip", start: null, projectId: null }),
    );
    expect(moved).toMatchObject({ path: created.path, title: "Send the signed slip", projectId: null });
    expect(moved.task).toEqual({ due: "2026-11-02", start: null, minutes: 30, done: true, source: "me" });
    text = await readFile(file, "utf8");
    expect(text).toContain("title: Send the signed slip\n");
    expect(text).toContain("\n# Send the signed slip\n");
    expect(text).not.toContain("# Send slip");
    expect(refreshLocal).toHaveBeenCalledTimes(3);
  });

  it("PATCH refuses bad input, notes outside Tasks and missing notes", async () => {
    const created = await ok200<TaskNote>(await send("POST", "/api/schedule/tasks", { title: "x" }), 201);
    await fails(await send("PATCH", `/api/schedule/tasks${q(created.path)}`, {}), 400, /at least one/);
    await fails(await send("PATCH", `/api/schedule/tasks${q(created.path)}`, { done: "yes" }), 400, /done/);
    await fails(await send("PATCH", "/api/schedule/tasks", { done: true }), 400, /path/);
    await fails(await send("PATCH", `/api/schedule/tasks${q("Meeting notes/a.md")}`, { done: true }), 400, /Tasks section/);
    await fails(await send("PATCH", `/api/schedule/tasks${q("Tasks/../secret.md")}`, { done: true }), 400);
    await fails(await send("PATCH", `/api/schedule/tasks${q("Tasks/missing.md")}`, { done: true }), 404);
  });
});

describe("GET /api/schedule", () => {
  it("lists meetings and tasks per Doha day, unscheduled and overdue, and the calendar status", async () => {
    await send("POST", "/api/schedule/tasks", { title: "Late", due: "2026-10-30" });
    await send("POST", "/api/schedule/tasks", { title: "Undated" });
    await send("POST", "/api/schedule/tasks", { title: "No start", due: "2026-11-01" });
    await send("POST", "/api/schedule/tasks", { title: "At eight", due: "2026-11-01", start: "08:00" });
    // A task edited in Obsidian with values the dashboard cannot read: treated as unset.
    await mkdir(path.join(dir, "Tasks"), { recursive: true });
    await writeFile(path.join(dir, "Tasks", "hand-made.md"), "---\ntask_due: next week\ntask_start: noon\ntask_minutes: lots\ntask_done: perhaps\n---\n# Hand made\n");

    const range = await ok200<ScheduleRange>(await app.request("/api/schedule?from=2026-11-01&to=2026-11-02"));
    expect(range.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(range.days[0]!.events.map((e) => e.id)).toEqual(["m1"]);
    expect(range.days[1]!.events.map((e) => e.id)).toEqual(["m2"]);
    expect(range.days[0]!.tasks.map((t) => t.title)).toEqual(["At eight", "No start"]);
    expect(range.unscheduled.map((t) => t.title).sort()).toEqual(["Hand made", "Undated"]);
    expect(range.overdue.map((t) => t.title)).toEqual(["Late"]);
    expect(range.calendar).toEqual({ status: "ok", message: "Via Claude connector" });
  });

  it("without a calendar connector the status is not_connected and tasks still show", async () => {
    snapshot.calendar = [];
    snapshot.sources.calendar = { status: "not_connected", updatedAt: null, message: "Connect Google Calendar in Claude" };
    await send("POST", "/api/schedule/tasks", { title: "Still here", due: "2026-11-01" });
    const range = await ok200<ScheduleRange>(await app.request("/api/schedule?from=2026-11-01&to=2026-11-01"));
    expect(range.calendar).toEqual({ status: "not_connected", message: "Connect Google Calendar in Claude" });
    expect(range.days[0]!.tasks.map((t) => t.title)).toEqual(["Still here"]);
  });

  it("refuses a range over 14 days, in the wrong order, or without dates", async () => {
    await fails(await app.request("/api/schedule?from=2026-11-01&to=2026-11-15"), 400, /14 days/);
    await fails(await app.request("/api/schedule?from=2026-11-02&to=2026-11-01"), 400, /on or before/);
    await fails(await app.request("/api/schedule"), 400);
    await fails(await app.request("/api/schedule?from=yesterday&to=2026-11-01"), 400);
  });
});

describe("plan routes", () => {
  const ITEMS = [
    { title: "Write the UAT plan", date: "2026-11-01", start: "11:00", minutes: 90, projectId: "qic-fastbind", reason: "Deadline Thursday" },
    { title: "Clear the inbox", date: "2026-11-01", start: "14:00", minutes: 30, projectId: null, reason: "Next move" },
  ];

  it("GET is none at first; POST runs claude with the meetings and moves and answers the ready plan", async () => {
    await store.write(FILES.nextMoves, {
      generatedAt: NOW.toISOString(), status: "ok",
      moves: [{ id: "m", title: "Review PR #42", reason: "Waiting", area: "work", rank: 1, state: "open" }],
    });
    expect(await ok200<SchedulePlan>(await app.request("/api/schedule/plan"))).toEqual({ status: "none", scope: null, generatedAt: null, items: [] });
    answer = ok(JSON.stringify(ITEMS));
    const plan = await ok200<SchedulePlan>(await send("POST", "/api/schedule/plan", { scope: "day" }));
    expect(plan.status).toBe("ready");
    expect(plan.items.map((i) => i.title)).toEqual(["Write the UAT plan", "Clear the inbox"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cwd).toBe(store.pathOf("schedule-run"));
    expect(runs[0]!.args[1]).toContain("Sprint review");
    expect(runs[0]!.args[1]).toContain("Review PR #42");
    expect(runs[0]!.args[1]).toContain("qic-fastbind");
    expect(await readdir(store.pathOf("schedule-run"))).toEqual([]);
    expect(await ok200<SchedulePlan>(await app.request("/api/schedule/plan"))).toEqual(plan);
  });

  it("a junk answer is status error with a message and no task is written", async () => {
    answer = ok("Sure! Here is your plan: nothing.");
    const plan = await ok200<SchedulePlan>(await send("POST", "/api/schedule/plan", { scope: "week" }));
    expect(plan).toMatchObject({ status: "error", message: expect.stringMatching(/no JSON list/) });
    const index = await ok200<NotesIndex>(await app.request("/api/notes"));
    expect(index.notes.filter((n) => n.section === "Tasks")).toEqual([]);
  });

  it("accept creates ai task notes and removes them from the plan; dismiss clears it", async () => {
    answer = ok(JSON.stringify(ITEMS));
    const plan = await ok200<SchedulePlan>(await send("POST", "/api/schedule/plan", { scope: "day" }));
    const result = await ok200<{ created: TaskNote[] }>(await send("POST", "/api/schedule/plan/accept", { ids: [plan.items[0]!.id] }));
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      path: "Tasks/write-the-uat-plan.md", projectId: "qic-fastbind",
      task: { due: "2026-11-01", start: "11:00", minutes: 90, done: false, source: "ai" },
    });
    expect(await fileText(result.created[0]!.path)).toContain("task_source: ai\n");
    expect(await fileText(result.created[0]!.path)).toContain("# Write the UAT plan\n\nDeadline Thursday\n");
    expect(refreshLocal).toHaveBeenCalledTimes(1);
    const left = await ok200<SchedulePlan>(await app.request("/api/schedule/plan"));
    expect(left.items.map((i) => i.title)).toEqual(["Clear the inbox"]);

    const cleared = await ok200<SchedulePlan>(await send("DELETE", "/api/schedule/plan"));
    expect(cleared).toEqual({ status: "none", scope: null, generatedAt: null, items: [] });
    expect(await store.read(PLAN_FILE, null)).toEqual(cleared);
  });

  it("refuses a bad scope or bad ids with 400", async () => {
    await fails(await send("POST", "/api/schedule/plan", { scope: "month" }), 400, /scope/);
    await fails(await send("POST", "/api/schedule/plan", ["day"]), 400, /JSON object/);
    await fails(await send("POST", "/api/schedule/plan/accept", { ids: [] }), 400, /ids/);
    await fails(await send("POST", "/api/schedule/plan/accept", { ids: "plan-1" }), 400, /ids/);
    await fails(await send("POST", "/api/schedule/plan/accept", { ids: [5] }), 400, /id/);
    expect(runs).toHaveLength(0);
  });
});
