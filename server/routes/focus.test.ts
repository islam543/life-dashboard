import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, FocusItem, FocusState, Project, Snapshot } from "../../shared/types";
import type { RunRequest, RunResult } from "../ai/nextMoves";
import { STEPS_FILE } from "../ai/taskSteps";
import { CONNECTORS_FILE } from "../connectors/validate";
import { createNotesStore, type NotesStore } from "../notes";
import { createTask, patchTask } from "../schedule";
import { emptySnapshot } from "../snapshot";
import { createStore, type Store } from "../store";
import { focusRoutes } from "./focus";

// The focus router mounted the way app.ts mounts it, with app.ts's HTTPException -> ApiError
// mapping. Notes and data live in a temp folder; the steps run uses a fake runner, so the real
// claude CLI never runs.

const NOW = new Date("2026-11-01T11:30:00Z"); // Sunday 14:30 in Doha
const SUN = "2026-11-01";

let tmp: string;
let store: Store;
let notes: NotesStore;
let app: Hono;
let snapshot: Snapshot;
let clock: Date;
let runs: RunRequest[];
let answer: (req: RunRequest) => RunResult | Promise<RunResult>;

const PROJECT: Project = {
  id: "qic-fastbind", name: "QIC FastBind", area: "work", status: "active", deadline: "2026-11-05",
  description: "Quick bind for brokers.", goals: ["Ship UAT"], tasks: [],
  sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};
const ok = (result: string): RunResult => ({
  exitCode: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result }), stderr: "", timedOut: false,
});

/** The prompt's DATA tasks. */
function promptTasks(req: RunRequest): { id: string; title: string; jira: { summary: string; status: string } | null }[] {
  const prompt = req.args[1]!;
  return (JSON.parse(prompt.slice(prompt.indexOf("DATA (JSON):\n") + "DATA (JSON):\n".length)) as { tasks: [] }).tasks;
}
/** Answers every task in the prompt with three steps naming its title. */
const stepsFor = (req: RunRequest) =>
  ok(JSON.stringify(promptTasks(req).map((t) => ({ id: t.id, steps: [`Open ${t.title} notes`, `Work on ${t.title} now`, `Finish ${t.title} today`] }))));

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-focus-api-"));
  const dir = path.join(tmp, "vault", "notes");
  await mkdir(path.dirname(dir));
  store = createStore(path.join(tmp, "data"));
  clock = NOW;
  notes = createNotesStore(dir, { now: () => clock });
  snapshot = emptySnapshot(NOW);
  snapshot.projects.projects = [PROJECT];
  runs = [];
  answer = stepsFor;
  const snapshots = { get: () => snapshot, refresh: async () => snapshot, refreshLocal: async () => snapshot };
  app = new Hono();
  app.route(
    "/api/focus",
    focusRoutes({
      notes, store, snapshots, now: () => NOW, log: () => undefined,
      stepsRunner: async (req) => {
        runs.push(req);
        return answer(req);
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

const post = (body: unknown) =>
  app.request("/api/focus/steps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}
const getFocus = async () => json<FocusState>(await app.request("/api/focus"));

async function addTasks() {
  const add = (title: string, due: string | null, start: string | null, minutes: number | null, details?: string, projectId: string | null = null) =>
    createTask(notes, { title, projectId, due, start, minutes, details }, "me");
  await add("In block", SUN, "14:00", 60, "Ticket AN-4602 needs the UAT sheet.", "qic-fastbind");
  await add("Later", SUN, "16:00", 30);
  await add("Old", "2026-10-29", null, null);
  await add("No time", SUN, null, null);
  await add("Undated", null, null, null);
}

describe("GET /api/focus", () => {
  it("is an empty list with no tasks and starts no run", async () => {
    const state = await getFocus();
    expect(state).toEqual({ generatedAt: NOW.toISOString(), items: [] });
    expect(runs).toHaveLength(0);
  });

  it("lists items with labels, project and Jira key, never waits for AI, and fills the top 3 missing in one background run", async () => {
    await addTasks();
    snapshot.work.jira = [
      { key: "AN-4602", summary: "UAT sign-off", status: "In Progress", statusCategory: "inprogress", priority: "High", dueDate: null,
        updated: "", project: "AN", url: "https://qicbizdev.atlassian.net/browse/AN-4602", blocked: false },
    ];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answer = async (req) => {
      await gate;
      return stepsFor(req);
    };

    const first = await getFocus();
    expect(first.items.map((i) => [i.task.title, i.reason, i.label, i.projectName, i.jiraKey, i.steps, i.stepsStatus])).toEqual([
      ["In block", "now", "Now until 15:00", "QIC FastBind", "AN-4602", null, "pending"],
      ["Later", "next", "Next at 16:00", null, null, null, "pending"],
      ["Old", "overdue", "Overdue since Thu 29 Oct", null, null, null, "pending"],
      ["No time", "today", "Today, no time set", null, null, null, "pending"],
    ]);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(promptTasks(runs[0]!).map((t) => t.title)).toEqual(["In block", "Later", "Old"]);
    expect(promptTasks(runs[0]!)[0]!.jira).toEqual({ key: "AN-4602", summary: "UAT sign-off", status: "In Progress" });
    expect(runs[0]!.cwd).toBe(store.pathOf("steps-run"));

    // While the run is going: still pending, and no second run.
    expect((await getFocus()).items.every((i) => i.stepsStatus === "pending")).toBe(true);
    expect(runs).toHaveLength(1);

    release();
    await vi.waitFor(async () => expect((await getFocus()).items[0]!.stepsStatus).toBe("ready"));
    const after = await getFocus();
    expect(after.items[0]!.steps).toEqual(["Open In block notes", "Work on In block now", "Finish In block today"]);
    expect(after.items.slice(0, 3).map((i) => i.stepsStatus)).toEqual(["ready", "ready", "ready"]);
    // That GET started the next batch for the one still missing.
    await vi.waitFor(async () => expect((await getFocus()).items[3]!.stepsStatus).toBe("ready"));
    expect(runs).toHaveLength(2);
    expect(promptTasks(runs[1]!).map((t) => t.title)).toEqual(["No time"]);
  });

  it("takes the Jira summary from the connector cache", async () => {
    await createTask(notes, { title: "Fix AN-77 login", projectId: null, due: SUN, start: null, minutes: null }, "me");
    await store.write(CONNECTORS_FILE, {
      fetchedAt: NOW.toISOString(),
      jira: {
        fetchedAt: NOW.toISOString(), lastStatus: "ok",
        items: [{ key: "AN-77", summary: "Login fails on Safari", status: "To Do", statusCategory: "todo", priority: "Medium", project: "AN",
          url: "https://qicbizdev.atlassian.net/browse/AN-77" }],
      },
    });
    const state = await getFocus();
    expect(state.items[0]!.jiraKey).toBe("AN-77");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(promptTasks(runs[0]!)[0]!.jira).toEqual({ key: "AN-77", summary: "Login fails on Safari", status: "To Do" });
  });

  it("a task edited since its steps were written is pending again and regenerated", async () => {
    const task = await createTask(notes, { title: "No time", projectId: null, due: SUN, start: null, minutes: null }, "me");
    await getFocus();
    await vi.waitFor(async () => expect((await getFocus()).items[0]!.stepsStatus).toBe("ready"));
    clock = new Date("2026-11-01T11:00:00Z");
    await patchTask(notes, task.path, { minutes: 45 });
    const edited = await getFocus();
    expect(edited.items[0]).toMatchObject({ stepsStatus: "pending", steps: null });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
  });

  it("a failed run is an error with a message for its tasks; cached tasks are unaffected and errors are not retried", async () => {
    await createTask(notes, { title: "Cached", projectId: null, due: SUN, start: "16:00", minutes: 30 }, "me");
    await getFocus();
    await vi.waitFor(async () => expect((await getFocus()).items[0]!.stepsStatus).toBe("ready"));
    await createTask(notes, { title: "Broken", projectId: null, due: SUN, start: null, minutes: null }, "me");
    answer = () => ({ exitCode: 1, stdout: "", stderr: "Please run /login", timedOut: false });
    await getFocus();
    await vi.waitFor(async () => expect((await getFocus()).items[1]!.stepsStatus).toBe("error"));
    const state = await getFocus();
    expect(state.items[0]).toMatchObject({ task: { title: "Cached" }, stepsStatus: "ready" });
    expect(state.items[1]).toMatchObject({ task: { title: "Broken" }, stepsStatus: "error", steps: null, stepsMessage: "Run claude in a terminal and log in" });
    expect(runs).toHaveLength(2);
  });
});

describe("POST /api/focus/steps", () => {
  it("runs for one task and returns the FocusItem; cached steps come back without a run unless force", async () => {
    await createTask(notes, { title: "Write UAT plan", projectId: "qic-fastbind", due: SUN, start: null, minutes: null }, "me");
    const path = "Tasks/write-uat-plan.md";
    const item = await json<FocusItem>(await post({ path }));
    expect(item).toMatchObject({ reason: "today", label: "Today, no time set", projectName: "QIC FastBind", stepsStatus: "ready" });
    expect(item.steps).toEqual(["Open Write UAT plan notes", "Work on Write UAT plan now", "Finish Write UAT plan today"]);
    expect(runs).toHaveLength(1);
    expect(promptTasks(runs[0]!).map((t) => t.title)).toEqual(["Write UAT plan"]);

    expect((await json<FocusItem>(await post({ path }))).steps).toEqual(item.steps);
    expect(runs).toHaveLength(1);
    answer = () => ok(JSON.stringify([{ id: "task1", steps: ["Open the plan", "Add the renewal cases", "Send it to Ahmed"] }]));
    expect((await json<FocusItem>(await post({ path, force: true }))).steps).toEqual(["Open the plan", "Add the renewal cases", "Send it to Ahmed"]);
    expect(runs).toHaveLength(2);
    expect((await getFocus()).items[0]!.steps).toEqual(["Open the plan", "Add the renewal cases", "Send it to Ahmed"]);
  });

  it("answers junk steps as stepsStatus error with a message", async () => {
    await createTask(notes, { title: "Junk", projectId: null, due: SUN, start: null, minutes: null }, "me");
    answer = () => ok(JSON.stringify([{ id: "task1", steps: ["See https://evil.example.com", "**", "ok"] }]));
    const item = await json<FocusItem>(await post({ path: "Tasks/junk.md" }));
    expect(item).toMatchObject({ stepsStatus: "error", steps: null, stepsMessage: expect.stringMatching(/fewer than 3 usable steps/) });
  });

  it("is 404 for a path that is not a Do now task, 400 for a bad body", async () => {
    await createTask(notes, { title: "Undated", projectId: null, due: null, start: null, minutes: null }, "me");
    const fail = async (res: Response, status: number, message: RegExp) => {
      const body = await json<ApiError>(res, status);
      expect(body.error).toMatch(message);
    };
    await fail(await post({ path: "Tasks/undated.md" }), 404, /not in Do now/);
    await fail(await post({ path: "Tasks/nope.md" }), 404, /not in Do now/);
    await fail(await post({ path: "" }), 400, /path/);
    await fail(await post({ path: 5 }), 400, /path/);
    await fail(await post({ path: "Tasks/undated.md", force: "yes" }), 400, /force/);
    await fail(await post(["Tasks/undated.md"]), 400, /JSON object/);
    await fail(await app.request("/api/focus/steps", { method: "POST", body: "{}" }), 400, /Content-Type/);
    expect(runs).toHaveLength(0);
  });

  it("is 409 while a run is going", async () => {
    await createTask(notes, { title: "Slow", projectId: null, due: SUN, start: null, minutes: null }, "me");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answer = async (req) => {
      await gate;
      return stepsFor(req);
    };
    await getFocus(); // starts the background run
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const busy = await json<ApiError>(await post({ path: "Tasks/slow.md", force: true }), 409);
    expect(busy.error).toMatch(/being written/);
    release();
    await vi.waitFor(async () => expect((await getFocus()).items[0]!.stepsStatus).toBe("ready"));
    expect(await store.read(STEPS_FILE, null)).toMatchObject({ entries: { "Tasks/slow.md": { steps: expect.any(Array) } } });
  });
});
