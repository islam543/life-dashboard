import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoteMeta, Project, ProjectsFile, Snapshot } from "../shared/types";
import {
  computeProjectsState,
  loadProjectsFile,
  newTaskId,
  PROJECTS_FILE,
  sameRepo,
  saveProjectsFile,
  seedProjectsFile,
  slugify,
  uniqueId,
  withProjectsLock,
} from "./projects";
import { emptySnapshot } from "./snapshot";
import { createStore, type Store } from "./store";

// Every day key is built from the local Date constructor, so these pass in any time zone.
const NOW = new Date(2026, 9, 30, 9, 0); // Friday 30 Oct 2026, 09:00 local
const pad = (n: number) => String(n).padStart(2, "0");
/** Local day key `n` days before NOW. */
const ago = (n: number) => {
  const d = new Date(2026, 9, 30 - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-projects-"));
  store = createStore(tmp);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function snapshotWith(edit: (s: Snapshot) => void = () => undefined): Snapshot {
  const s = emptySnapshot(NOW);
  s.sources.claudeSessions = { status: "ok", updatedAt: NOW.toISOString() };
  edit(s);
  return s;
}

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id, name: id, area: "work", status: "active", deadline: null, description: "", goals: [], tasks: [],
    sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

function note(pathName: string, projectId: string | null, updated: string): NoteMeta {
  return { path: pathName, section: "Meeting notes", title: pathName, created: updated, updated, projectId, tags: [], excerpt: "", openActions: 0, vault: "notes", readOnly: false };
}

describe("ids", () => {
  it("slugs keep letters of any script and are never empty", () => {
    expect(slugify("QIC FastBind!")).toBe("qic-fastbind");
    expect(slugify("  --QIC__MVHI  Claims--  ")).toBe("qic-mvhi-claims");
    expect(slugify("Café Ünïcode")).toBe("café-ünïcode");
    expect(slugify("مشروع جديد")).toBe("مشروع-جديد");
    expect(slugify("!!!")).toBe("project");
    expect(slugify("a".repeat(100))).toHaveLength(60);
  });

  it("suffixes -2, -3 on a clash", () => {
    expect(uniqueId("fastbind", new Set())).toBe("fastbind");
    expect(uniqueId("fastbind", new Set(["fastbind"]))).toBe("fastbind-2");
    expect(uniqueId("fastbind", new Set(["fastbind", "fastbind-2"]))).toBe("fastbind-3");
  });

  it("task ids are 8 random lowercase letters and digits", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTaskId(new Set())));
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(ids.size).toBe(50);
  });

  it("repo names match with or without the owner, without case", () => {
    expect(sameRepo("fastbind", "islam543/FastBind")).toBe(true);
    expect(sameRepo("islam543/fastbind", "islam543/fastbind")).toBe(true);
    expect(sameRepo("other/fastbind", "islam543/fastbind")).toBe(false);
    expect(sameRepo("fast", "islam543/fastbind")).toBe(false);
  });
});

describe("seedProjectsFile", () => {
  it("creates one active work project per session name with more than 60 minutes in the last 30 days", () => {
    const s = snapshotWith((x) => {
      x.work.sessionTime = [
        { project: "Small", minutesByDay: { [ago(0)]: 30, [ago(1)]: 30 } }, // exactly 60: not seeded
        { project: "QIC-FastBind", minutesByDay: { [ago(0)]: 50, [ago(29)]: 11 } }, // 61 inside the window
        { project: "Old", minutesByDay: { [ago(30)]: 500, [ago(0)]: 10 } }, // the big day is 31 days back
        { project: "Busy", minutesByDay: { [ago(3)]: 300 } },
        { project: "qic fastbind", minutesByDay: { [ago(2)]: 90 } }, // slugs like QIC-FastBind
      ];
    });
    const file = seedProjectsFile(s, NOW);
    expect(file.hidden).toEqual([]);
    expect(file.projects.map((p) => [p.id, p.name])).toEqual([
      ["busy", "Busy"],
      ["qic-fastbind", "qic fastbind"],
      ["qic-fastbind-2", "QIC-FastBind"],
    ]);
    expect(file.projects[2]).toEqual({
      id: "qic-fastbind-2", name: "QIC-FastBind", area: "work", status: "active", deadline: null, description: "", goals: [],
      tasks: [], sources: { sessions: ["QIC-FastBind"], repos: [] }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
  });

  it("seeds nothing from an empty or partial snapshot", () => {
    expect(seedProjectsFile(emptySnapshot(NOW), NOW)).toEqual({ projects: [], hidden: [] });
    expect(seedProjectsFile({ work: {} } as unknown as Snapshot, NOW)).toEqual({ projects: [], hidden: [] });
  });
});

describe("computeProjectsState", () => {
  const s = snapshotWith((x) => {
    x.work.sessionTime = [
      { project: "FastBind", minutesByDay: { [ago(0)]: 30, [ago(1)]: 10 } },
      { project: "fastbind-demo", minutesByDay: { [ago(0)]: 15 } },
      { project: "Learning", minutesByDay: { [ago(2)]: 40, [ago(8)]: 100 } },
      { project: "Ancient", minutesByDay: { [ago(90)]: 500 } }, // 91 days back: not active
      { project: "Edge", minutesByDay: { [ago(89)]: 5 } }, // 90 days back, today included: active
      { project: "Secret", minutesByDay: { [ago(0)]: 5 } },
    ];
    x.work.repoActivity = [
      { repo: "islam543/QIC-FastBind", commitsByDay: { [ago(0)]: 2, [ago(1)]: 3 } },
      { repo: "islam543/trades-recon", commitsByDay: { [ago(5)]: 4, [ago(40)]: 9 } },
      { repo: "islam543/busy-repo", commitsByDay: { [ago(1)]: 12 } },
    ];
  });

  it("sums time and commits over every source, with repos matched with or without the owner", () => {
    const file: ProjectsFile = {
      projects: [
        project("qic-fastbind", {
          sources: { sessions: ["FastBind", "FASTBIND-demo"], repos: ["QIC-FastBind", "islam543/QIC-FastBind"] },
          tasks: [
            { id: "t1", text: "a", done: false, due: null, doneAt: null, createdAt: NOW.toISOString() },
            { id: "t2", text: "b", done: true, due: null, doneAt: NOW.toISOString(), createdAt: NOW.toISOString() },
            { id: "t3", text: "c", done: false, due: null, doneAt: null, createdAt: NOW.toISOString() },
          ],
        }),
        project("empty"),
      ],
      hidden: [],
    };
    const notes = [
      note("a.md", "qic-fastbind", "2026-10-20T09:00:00.000Z"),
      note("b.md", "qic-fastbind", "2026-10-28T09:00:00+03:00"),
      note("c.md", "other", "2026-10-29T09:00:00.000Z"),
    ];
    const state = computeProjectsState(file, s, notes, NOW);
    expect(state.projects).toEqual(file.projects);
    expect(state.stats).toEqual([
      {
        id: "qic-fastbind",
        minutesByDay: { [ago(0)]: 45, [ago(1)]: 10 },
        commitsByDay: { [ago(0)]: 2, [ago(1)]: 3 }, // one repo, listed twice, counted once
        openTasks: 2, doneTasks: 1, noteCount: 2, lastNoteAt: "2026-10-28T09:00:00+03:00",
      },
      { id: "empty", minutesByDay: {}, commitsByDay: {}, openTasks: 0, doneTasks: 0, noteCount: 0, lastNoteAt: null },
    ]);
  });

  it("untracked: active in 90 days, in no project, not hidden; sorted by minutes7d then commits30d", () => {
    const file: ProjectsFile = {
      projects: [project("fb", { sources: { sessions: ["fastbind"], repos: ["qic-fastbind"] } })],
      hidden: ["SECRET", "islam543/busy-repo"],
    };
    const state = computeProjectsState(file, s, [], NOW);
    expect(state.hidden).toEqual(["SECRET", "islam543/busy-repo"]);
    expect(state.untracked).toEqual([
      { name: "Learning", kind: "session", minutes7d: 40, commits30d: 0, lastSeen: ago(2) },
      { name: "fastbind-demo", kind: "session", minutes7d: 15, commits30d: 0, lastSeen: ago(0) },
      { name: "islam543/trades-recon", kind: "repo", minutes7d: 0, commits30d: 4, lastSeen: ago(5) },
      { name: "Edge", kind: "session", minutes7d: 0, commits30d: 0, lastSeen: ago(89) },
    ]);
  });

  it("never throws on empty or partial data", () => {
    const partial = { work: {} } as unknown as Snapshot;
    expect(computeProjectsState({ projects: [], hidden: [] }, partial, [], NOW)).toEqual({ projects: [], stats: [], untracked: [], hidden: [] });
    expect(computeProjectsState({} as ProjectsFile, emptySnapshot(NOW), null as unknown as NoteMeta[], NOW).projects).toEqual([]);
  });
});

describe("projects.json", () => {
  it("is null only while missing, and round-trips through save", async () => {
    expect(await loadProjectsFile(store)).toBeNull();
    const file: ProjectsFile = { projects: [project("fb", { goals: ["Ship"], deadline: "2026-11-30" })], hidden: ["x"] };
    await saveProjectsFile(store, file);
    expect(await loadProjectsFile(store)).toEqual(file);
  });

  it("throws on a corrupt file instead of looking missing, and leaves it untouched", async () => {
    await writeFile(store.pathOf(PROJECTS_FILE), "{ not json");
    await expect(loadProjectsFile(store)).rejects.toThrow(/not valid JSON/);
    await writeFile(store.pathOf(PROJECTS_FILE), JSON.stringify({ hidden: [] }));
    await expect(loadProjectsFile(store)).rejects.toThrow(/no "projects" list/);
    expect(await readFile(store.pathOf(PROJECTS_FILE), "utf8")).toBe('{"hidden":[]}');
  });

  it("repairs a hand-edited file: defaults, unique ids, stable task ids, BOM", async () => {
    const raw = {
      projects: [
        { id: "fb", name: "FastBind", area: "Work", status: "nonsense", deadline: "2026-02-30", tasks: [{ text: "No id" }, { id: "t1", text: "" }], goals: ["a", 5] },
        { id: "fb", name: "Duplicate id" },
        { name: "No id here" },
        { area: "work" },
        "garbage",
      ],
    };
    await writeFile(store.pathOf(PROJECTS_FILE), "\uFEFF" + JSON.stringify(raw));
    const file = (await loadProjectsFile(store))!;
    expect(file.hidden).toEqual([]);
    expect(file.projects.map((p) => [p.id, p.name, p.area, p.status, p.deadline])).toEqual([
      ["fb", "FastBind", "work", "active", null],
      ["fb-2", "Duplicate id", "work", "active", null],
      ["no-id-here", "No id here", "work", "active", null],
    ]);
    const first = file.projects[0]!;
    expect(first.goals).toEqual(["a"]);
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]).toMatchObject({ text: "No id", done: false, due: null, doneAt: null });
    expect(first.tasks[0]!.id).toMatch(/^[0-9a-f]{8}$/);
    expect((await loadProjectsFile(store))!.projects[0]!.tasks[0]!.id).toBe(first.tasks[0]!.id);
  });
});

describe("withProjectsLock", () => {
  it("runs tasks for one file one at a time, in order, even after a failure", async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
      return name;
    };
    const a = withProjectsLock(store, slow("a", 20));
    const b = withProjectsLock(store, async () => {
      throw new Error("boom");
    });
    const c = withProjectsLock(store, slow("c", 1));
    await expect(b).rejects.toThrow("boom");
    expect(await Promise.all([a, c])).toEqual(["a", "c"]);
    expect(order).toEqual(["start a", "end a", "start c", "end c"]);
  });
});
