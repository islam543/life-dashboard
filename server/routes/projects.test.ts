import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteMeta, Project, ProjectsFile, ProjectsState, ProjectTask, RepoActivity, SessionTime } from "../../shared/types";
import { createApp } from "../app";
import type { CollectorRegistry } from "../collectors/types";
import { SOURCE_KEYS } from "../collectors/types";
import { loadConfig } from "../config";
import type { NotesStore } from "../notes";
import { PROJECTS_FILE } from "../projects";
import { createSnapshotService } from "../snapshot";
import { createStore, type Store } from "../store";

// The /api/projects router, mounted by the real app (guards, error mapping) on the real snapshot
// service. Collectors and the notes store are fakes; projects.json lives in a temp folder.

const NOW = new Date(2026, 9, 30, 9, 0);
const pad = (n: number) => String(n).padStart(2, "0");
const ago = (n: number) => {
  const d = new Date(2026, 9, 30 - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-projects-routes-"));
  store = createStore(path.join(tmp, "data"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

const SESSIONS: SessionTime[] = [
  { project: "QIC-FastBind", minutesByDay: { [ago(0)]: 90, [ago(1)]: 30 } },
  { project: "Trading-research", minutesByDay: { [ago(2)]: 61 } },
  { project: "NFC", minutesByDay: { [ago(0)]: 5 } },
];
const REPOS: RepoActivity[] = [{ repo: "islam543/QIC-FastBind", commitsByDay: { [ago(0)]: 3 } }];

function fakeNotes(notes: NoteMeta[] = []): NotesStore {
  const unused = async (): Promise<never> => {
    throw new Error("not used in this test");
  };
  return {
    index: async () => ({ status: "ok", dir: path.join(tmp, "notes"), sections: [], notes }),
    read: unused, create: unused, update: unused, remove: unused,
    createSection: unused, renameSection: unused, removeSection: unused,
    recent: async () => [],
  };
}

/** The app plus a clock. `sessions: false` keeps the sessions collector at never_run. */
async function setup(opts: { file?: ProjectsFile | null; sessions?: boolean; notes?: NoteMeta[] } = {}) {
  if (opts.file !== null) await store.write(PROJECTS_FILE, opts.file ?? { projects: [], hidden: [] });
  let clock = NOW;
  const base = Object.fromEntries(
    SOURCE_KEYS.map((k) => [k, { key: k, collect: async () => ({ status: "never_run", data: null }) }]),
  ) as unknown as CollectorRegistry;
  const collectors: CollectorRegistry = {
    ...base,
    claudeSessions: { key: "claudeSessions", collect: async () => ({ status: "ok", data: { sessionTime: SESSIONS } }) },
    github: { key: "github", collect: async () => ({ status: "ok", data: { prs: [], ci: [], repoActivity: REPOS } }) },
  };
  const notes = fakeNotes(opts.notes);
  const snapshots = createSnapshotService({
    collectors, config: loadConfig({}, { rootDir: tmp, home: tmp }), store, notes, now: () => clock, log: () => undefined,
  });
  await snapshots.load();
  if (opts.sessions !== false) await snapshots.refresh();
  const app = createApp({
    snapshots,
    nextMoves: { get: async () => ({ generatedAt: null, status: "never_run", moves: [] }), run: async () => ({ generatedAt: null, status: "never_run", moves: [] }), setState: async () => null },
    saveCheckin: async () => undefined,
    store,
    notes,
    now: () => clock,
    log: () => undefined,
  });
  return { app, snapshots, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

const send = (app: App, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function ok(res: Response): Promise<ProjectsState> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ProjectsState;
}

async function fails(res: Response, status: number, match?: RegExp): Promise<void> {
  const body = (await res.json()) as { error?: unknown };
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(typeof body.error).toBe("string");
  if (match) expect(body.error).toMatch(match);
}

const onDisk = async (): Promise<ProjectsFile> => JSON.parse(await readFile(store.pathOf(PROJECTS_FILE), "utf8"));
const find = (state: ProjectsState, id: string): Project => state.projects.find((p) => p.id === id)!;

function task(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { id, text: `Task ${id}`, done: false, due: null, doneAt: null, createdAt: NOW.toISOString(), ...extra };
}

function stored(id: string, extra: Partial<Project> = {}): Project {
  return {
    id, name: id, area: "work", status: "active", deadline: null, description: "", goals: [], tasks: [],
    sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
  };
}

describe("GET /api/projects and seeding", () => {
  it("answers an empty state and writes nothing before the sessions collector has run", async () => {
    const { app } = await setup({ file: null, sessions: false });
    expect(await ok(await app.request("/api/projects"))).toEqual({ projects: [], stats: [], untracked: [], hidden: [] });
    await expect(readFile(store.pathOf(PROJECTS_FILE), "utf8")).rejects.toThrow();
  });

  it("seeds projects.json once session time is known, only when the file is missing", async () => {
    const { app } = await setup({ file: null });
    const state = await ok(await app.request("/api/projects"));
    expect(state.projects.map((p) => [p.id, p.name, p.area, p.status, p.sources.sessions])).toEqual([
      ["qic-fastbind", "QIC-FastBind", "work", "active", ["QIC-FastBind"]],
      ["trading-research", "Trading-research", "work", "active", ["Trading-research"]],
    ]);
    expect(state.untracked.map((u) => u.name)).toEqual(["NFC", "islam543/QIC-FastBind"]);
    expect((await onDisk()).projects).toHaveLength(2);

    // An existing (even empty) registry is never re-seeded.
    await store.write(PROJECTS_FILE, { projects: [], hidden: [] });
    expect((await ok(await app.request("/api/projects"))).projects).toEqual([]);
  });

  it("a write while the file is missing seeds first, then applies the change", async () => {
    const { app } = await setup({ file: null });
    await rm(store.pathOf(PROJECTS_FILE));
    const state = await ok(await send(app, "POST", "/api/projects", { name: "Side thing", area: "personal" }));
    expect(state.projects.map((p) => p.id)).toEqual(["qic-fastbind", "trading-research", "side-thing"]);
    await fails(await send(app, "POST", "/api/projects", { name: "x", area: "work", sources: { sessions: ["qic-fastbind"] } }), 409);
  });

  it("stats sum every source", async () => {
    const { app } = await setup({
      file: { projects: [stored("fb", { sources: { sessions: ["QIC-FastBind", "NFC"], repos: ["QIC-FastBind"] } })], hidden: [] },
      notes: [{ path: "Meeting notes/a.md", section: "Meeting notes", title: "a", created: "2026-10-29T09:00:00.000Z",
        updated: "2026-10-29T10:00:00.000Z", projectId: "fb", tags: [], excerpt: "", openActions: 1 }],
    });
    const state = await ok(await app.request("/api/projects"));
    expect(state.stats).toEqual([{ id: "fb", minutesByDay: { [ago(0)]: 95, [ago(1)]: 30 }, commitsByDay: { [ago(0)]: 3 },
      openTasks: 0, doneTasks: 0, noteCount: 1, lastNoteAt: "2026-10-29T10:00:00.000Z" }]);
    expect(state.untracked.map((u) => u.name)).toEqual(["Trading-research"]);
  });
});

describe("POST /api/projects", () => {
  it("creates with defaults, a slug id, -2 on a clash, and the same createdAt and updatedAt", async () => {
    const { app } = await setup();
    let state = await ok(await send(app, "POST", "/api/projects", { name: "  QIC FastBind  ", area: "work" }));
    expect(find(state, "qic-fastbind")).toEqual({
      id: "qic-fastbind", name: "QIC FastBind", area: "work", status: "active", deadline: null, description: "", goals: [],
      tasks: [], sources: { sessions: [], repos: [] }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    state = await ok(await send(app, "POST", "/api/projects", {
      name: "qic-fastbind", area: "learning", status: "idea", deadline: "2026-12-01", description: "Line one\nLine two",
      goals: ["Ship v2", "  ", "Demo"], sources: { sessions: ["QIC-FastBind", "qic-fastbind"], repos: ["islam543/QIC-FastBind"] },
    }));
    expect(find(state, "qic-fastbind-2")).toMatchObject({
      name: "qic-fastbind", area: "learning", status: "idea", deadline: "2026-12-01", description: "Line one\nLine two",
      goals: ["Ship v2", "Demo"], sources: { sessions: ["QIC-FastBind"], repos: ["islam543/QIC-FastBind"] },
    });
    expect(state.untracked.map((u) => u.name)).toEqual(["Trading-research", "NFC"]);
    expect((await onDisk()).projects.map((p) => p.id)).toEqual(["qic-fastbind", "qic-fastbind-2"]);
  });

  it("keeps non-ASCII names and ids, and serves them through encoded paths", async () => {
    const { app } = await setup();
    const state = await ok(await send(app, "POST", "/api/projects", { name: "Café Ünïcode مشروع", area: "personal" }));
    expect(state.projects[0]).toMatchObject({ id: "café-ünïcode-مشروع", name: "Café Ünïcode مشروع" });
    const renamed = await ok(await send(app, "PATCH", `/api/projects/${encodeURIComponent("café-ünïcode-مشروع")}`, { name: "Café" }));
    expect(renamed.projects[0]).toMatchObject({ id: "café-ünïcode-مشروع", name: "Café" });
  });

  it("validates every field (400)", async () => {
    const { app } = await setup();
    const bad = async (body: unknown, match: RegExp) => fails(await send(app, "POST", "/api/projects", body), 400, match);
    await bad({ area: "work" }, /name/);
    await bad({ name: "   ", area: "work" }, /name must be 1 to 80/);
    await bad({ name: "x".repeat(81), area: "work" }, /name must be 1 to 80/);
    await bad({ name: "a\u0007b", area: "work" }, /control/);
    await bad({ name: "x" }, /area must be one of/);
    await bad({ name: "x", area: "calendar" }, /area must be one of/);
    await bad({ name: "x", area: "work", status: "doing" }, /status must be one of/);
    await bad({ name: "x", area: "work", deadline: "2026-02-30" }, /deadline/);
    await bad({ name: "x", area: "work", deadline: "30/11/2026" }, /deadline/);
    await bad({ name: "x", area: "work", description: "d".repeat(2001) }, /description/);
    await bad({ name: "x", area: "work", goals: "Ship" }, /goals/);
    await bad({ name: "x", area: "work", goals: Array.from({ length: 11 }, (_, i) => `g${i}`) }, /at most 10/);
    await bad({ name: "x", area: "work", goals: ["g".repeat(201)] }, /goal/);
    await bad({ name: "x", area: "work", sources: ["a"] }, /sources/);
    await bad({ name: "x", area: "work", sources: { sessions: "a" } }, /sources.sessions/);
    await bad({ name: "x", area: "work", sources: { repos: [""] } }, /sources.repos/);
    await bad([{ name: "x" }], /JSON object/);
    await fails(await app.request("/api/projects", { method: "POST", body: "{}" }), 400, /Content-Type: application\/json/);
    await fails(await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), 400, /not valid JSON/);
    expect((await onDisk()).projects).toEqual([]);
  });

  it("refuses a source name another project already holds (409), repos with or without owner", async () => {
    const { app } = await setup({ file: { projects: [stored("fb", { sources: { sessions: ["QIC-FastBind"], repos: ["islam543/QIC-FastBind"] } })], hidden: [] } });
    await fails(await send(app, "POST", "/api/projects", { name: "x", area: "work", sources: { sessions: ["qic-fastbind"] } }), 409, /already belongs to the project "fb"/);
    await fails(await send(app, "POST", "/api/projects", { name: "x", area: "work", sources: { repos: ["QIC-FastBind"] } }), 409);
    await ok(await send(app, "POST", "/api/projects", { name: "x", area: "work", sources: { repos: ["other/QIC-FastBind"] } }));
  });

  it("a name folded into a project leaves the hidden list", async () => {
    const { app } = await setup({ file: { projects: [], hidden: ["NFC", "islam543/QIC-FastBind", "keep"] } });
    const state = await ok(await send(app, "POST", "/api/projects", { name: "NFC", area: "personal", sources: { sessions: ["nfc"], repos: ["QIC-FastBind"] } }));
    expect(state.hidden).toEqual(["keep"]);
  });

  it("serialises concurrent writes: every project lands with a unique id", async () => {
    const { app } = await setup();
    const results = await Promise.all(Array.from({ length: 25 }, () => send(app, "POST", "/api/projects", { name: "Same", area: "work" })));
    for (const res of results) expect(res.status).toBe(200);
    const ids = (await onDisk()).projects.map((p) => p.id);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(ids).toContain("same");
    expect(ids).toContain("same-25");
  });
});

describe("PATCH and DELETE /api/projects/:id", () => {
  const file = (): ProjectsFile => ({
    projects: [
      stored("fb", { name: "FastBind", deadline: "2026-11-30", sources: { sessions: ["QIC-FastBind"], repos: ["islam543/QIC-FastBind"] } }),
      stored("tr", { name: "Trading", sources: { sessions: ["Trading-research"], repos: [] } }),
    ],
    hidden: [],
  });

  it("changes only the given fields, keeps the id on rename and bumps updatedAt", async () => {
    const { app, tick } = await setup({ file: file() });
    tick(60_000);
    const state = await ok(await send(app, "PATCH", "/api/projects/fb", { name: "FastBind v2", status: "paused", deadline: null, goals: [] }));
    expect(find(state, "fb")).toMatchObject({
      id: "fb", name: "FastBind v2", status: "paused", deadline: null, goals: [], area: "work",
      sources: { sessions: ["QIC-FastBind"], repos: ["islam543/QIC-FastBind"] },
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(find(state, "tr").updatedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("replaces only the source list it is given and checks it against other projects", async () => {
    const { app } = await setup({ file: file() });
    let state = await ok(await send(app, "PATCH", "/api/projects/fb", { sources: { sessions: ["QIC-FastBind", "NFC"] } }));
    expect(find(state, "fb").sources).toEqual({ sessions: ["QIC-FastBind", "NFC"], repos: ["islam543/QIC-FastBind"] });
    await fails(await send(app, "PATCH", "/api/projects/tr", { sources: { sessions: ["nfc"] } }), 409, /FastBind/);
    state = await ok(await send(app, "PATCH", "/api/projects/fb", { sources: { sessions: ["QIC-FastBind", "NFC"], repos: [] } }));
    expect(find(state, "fb").sources.repos).toEqual([]);
  });

  it("400 for bad or empty patches, 404 for an unknown id", async () => {
    const { app } = await setup({ file: file() });
    await fails(await send(app, "PATCH", "/api/projects/fb", {}), 400, /at least one of/);
    await fails(await send(app, "PATCH", "/api/projects/fb", { id: "other" }), 400, /at least one of/);
    await fails(await send(app, "PATCH", "/api/projects/fb", { area: "email" }), 400, /area/);
    await fails(await send(app, "PATCH", "/api/projects/fb", { name: "" }), 400, /name/);
    await fails(await send(app, "PATCH", "/api/projects/fb", { sources: { sessions: [1] } }), 400, /sources.sessions/);
    await fails(await send(app, "PATCH", "/api/projects/nope", { name: "x" }), 404, /No project/);
    await fails(await send(app, "DELETE", "/api/projects/nope"), 404, /No project/);
    expect(await onDisk()).toEqual(file());
  });

  it("delete: its sources go back to untracked, a hidden name stays hidden", async () => {
    const start = file();
    start.hidden = ["FastBind", "NFC"];
    const { app } = await setup({ file: start });
    const before = await ok(await app.request("/api/projects"));
    expect(before.untracked.map((u) => u.name)).toEqual([]);
    const state = await ok(await send(app, "DELETE", "/api/projects/fb"));
    expect(state.projects.map((p) => p.id)).toEqual(["tr"]);
    expect(state.hidden).toEqual(["FastBind", "NFC"]);
    expect(state.untracked.map((u) => u.name)).toEqual(["QIC-FastBind", "islam543/QIC-FastBind"]);
  });
});

describe("tasks", () => {
  it("add, edit, complete, reopen and delete; every change bumps the project's updatedAt", async () => {
    const { app, tick } = await setup({ file: { projects: [stored("fb")], hidden: [] } });
    let state = await ok(await send(app, "POST", "/api/projects/fb/tasks", { text: "  Write the UAT plan  ", due: "2026-11-02" }));
    const created = find(state, "fb").tasks[0]!;
    expect(created).toEqual({ id: created.id, text: "Write the UAT plan", done: false, due: "2026-11-02", doneAt: null, createdAt: NOW.toISOString() });
    expect(created.id).toMatch(/^[a-z0-9]{8}$/);
    expect(find(state, "fb").updatedAt).toBe(NOW.toISOString());

    tick(1000);
    const t1 = new Date(NOW.getTime() + 1000).toISOString();
    state = await ok(await send(app, "PATCH", `/api/projects/fb/tasks/${created.id}`, { done: true }));
    expect(find(state, "fb").tasks[0]).toMatchObject({ done: true, doneAt: t1 });
    expect(find(state, "fb").updatedAt).toBe(t1);
    expect(state.stats[0]).toMatchObject({ openTasks: 0, doneTasks: 1 });

    tick(1000);
    state = await ok(await send(app, "PATCH", `/api/projects/fb/tasks/${created.id}`, { done: true, text: "Write it", due: null }));
    expect(find(state, "fb").tasks[0]).toMatchObject({ text: "Write it", due: null, done: true, doneAt: t1 }); // still done: doneAt kept
    state = await ok(await send(app, "PATCH", `/api/projects/fb/tasks/${created.id}`, { done: false }));
    expect(find(state, "fb").tasks[0]).toMatchObject({ done: false, doneAt: null });

    tick(1000);
    state = await ok(await send(app, "DELETE", `/api/projects/fb/tasks/${created.id}`));
    expect(find(state, "fb").tasks).toEqual([]);
    expect(find(state, "fb").updatedAt).toBe(new Date(NOW.getTime() + 3000).toISOString());
  });

  it("400 for bad input, 404 for an unknown project or task", async () => {
    const { app } = await setup({ file: { projects: [stored("fb", { tasks: [task("t1")] })], hidden: [] } });
    await fails(await send(app, "POST", "/api/projects/fb/tasks", {}), 400, /text/);
    await fails(await send(app, "POST", "/api/projects/fb/tasks", { text: "x".repeat(301) }), 400, /1 to 300/);
    await fails(await send(app, "POST", "/api/projects/fb/tasks", { text: "x", due: "tomorrow" }), 400, /due/);
    await fails(await send(app, "PATCH", "/api/projects/fb/tasks/t1", {}), 400, /at least one of/);
    await fails(await send(app, "PATCH", "/api/projects/fb/tasks/t1", { done: "yes" }), 400, /done/);
    await fails(await send(app, "POST", "/api/projects/nope/tasks", { text: "x" }), 404, /No project/);
    await fails(await send(app, "PATCH", "/api/projects/fb/tasks/nope", { done: true }), 404, /No task/);
    await fails(await send(app, "DELETE", "/api/projects/fb/tasks/nope"), 404, /No task/);
    await fails(await send(app, "DELETE", "/api/projects/nope/tasks/t1"), 404, /No project/);
  });

  it("a project with 200 tasks still reads and writes", async () => {
    const tasks = Array.from({ length: 199 }, (_, i) => task(`t${String(i).padStart(3, "0")}`, { done: i % 2 === 0 }));
    const { app } = await setup({ file: { projects: [stored("fb", { tasks })], hidden: [] } });
    let state = await ok(await send(app, "POST", "/api/projects/fb/tasks", { text: "Number 200" }));
    expect(find(state, "fb").tasks).toHaveLength(200);
    expect(new Set(find(state, "fb").tasks.map((t) => t.id)).size).toBe(200);
    // 100 even-numbered tasks start done; 99 odd ones plus "Number 200" are open. t151 is open.
    expect(state.stats[0]).toMatchObject({ openTasks: 100, doneTasks: 100 });
    state = await ok(await send(app, "PATCH", "/api/projects/fb/tasks/t151", { done: true }));
    expect(state.stats[0]).toMatchObject({ openTasks: 99, doneTasks: 101 });
  });
});

describe("hide and unhide", () => {
  it("hides a detected name (idempotent), unhides it, and refuses names a project holds", async () => {
    const { app } = await setup({ file: { projects: [stored("fb", { sources: { sessions: ["QIC-FastBind"], repos: [] } })], hidden: [] } });
    let state = await ok(await send(app, "POST", "/api/projects/hide", { name: "NFC" }));
    expect(state.hidden).toEqual(["NFC"]);
    expect(state.untracked.map((u) => u.name)).not.toContain("NFC");
    state = await ok(await send(app, "POST", "/api/projects/hide", { name: "nfc" }));
    expect(state.hidden).toEqual(["NFC"]);
    await fails(await send(app, "POST", "/api/projects/hide", { name: "qic-fastbind" }), 409, /belongs to the project "fb"/);

    state = await ok(await send(app, "POST", "/api/projects/unhide", { name: "nfc" }));
    expect(state.hidden).toEqual([]);
    expect(state.untracked.map((u) => u.name)).toContain("NFC");
    await fails(await send(app, "POST", "/api/projects/unhide", { name: "NFC" }), 404, /not hidden/);
    await fails(await send(app, "POST", "/api/projects/hide", {}), 400, /name/);
    await fails(await send(app, "POST", "/api/projects/unhide", { name: "x".repeat(201) }), 400, /name/);
  });
});

describe("a corrupt projects.json", () => {
  it("is never overwritten by a write", async () => {
    const { app } = await setup();
    await writeFile(store.pathOf(PROJECTS_FILE), "{ broken");
    const res = await send(app, "POST", "/api/projects", { name: "x", area: "work" });
    expect(res.status).toBe(500);
    expect(await readFile(store.pathOf(PROJECTS_FILE), "utf8")).toBe("{ broken");
  });
});
