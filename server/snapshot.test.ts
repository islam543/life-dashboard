import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteMeta, ProjectsFile, ProjectsState, PullRequest, Snapshot } from "../shared/types";
import { collectors as realRegistry } from "./collectors";
import type { Collector, CollectorRegistry, CollectorResult, SourceKey } from "./collectors/types";
import { SOURCE_KEYS } from "./collectors/types";
import { loadConfig } from "./config";
import { createNotesStore, type NotesStore } from "./notes";
import {
  assembleSnapshot,
  createSnapshotService,
  emptySlices,
  emptySnapshot,
  normaliseSnapshot,
  RECENT_NOTES_DAYS,
  RECENT_NOTES_MAX,
  runCollector,
} from "./snapshot";
import { createStore, FILES, type Store } from "./store";

// The project registry is mocked here so these tests check the snapshot wiring only, whatever
// projects.ts computes (its own tests live in projects.test.ts).
const projectsMock = vi.hoisted(() => ({
  PROJECTS_FILE: "projects.json",
  loadProjectsFile: vi.fn<(store: Store) => Promise<ProjectsFile | null>>(),
  saveProjectsFile: vi.fn<(store: Store, file: ProjectsFile) => Promise<void>>(),
  seedProjectsFile: vi.fn<(snapshot: Snapshot, now: Date) => ProjectsFile>(),
  computeProjectsState: vi.fn<(file: ProjectsFile, snapshot: Snapshot, notes: NoteMeta[], now: Date) => ProjectsState>(),
}));
vi.mock("./projects", () => projectsMock);

const emptyState = (): ProjectsState => ({ projects: [], stats: [], untracked: [], hidden: [] });

const T0 = new Date("2026-10-30T06:00:00.000Z");
const T1 = new Date("2026-10-30T06:30:00.000Z");

const pr = (n: number): PullRequest => ({
  repo: "islam543/fastbind",
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/islam543/fastbind/pull/${n}`,
  author: "someone",
  role: "reviewer",
  createdAt: "2026-10-28T10:00:00.000Z",
  isDraft: false,
  checks: "pass",
});

const githubData = (...numbers: number[]) => ({ prs: numbers.map(pr), ci: [], repoActivity: [] });

function stub<K extends SourceKey>(key: K, result: CollectorResult<K> | (() => Promise<CollectorResult<K>>)): Collector<K> {
  return { key, collect: typeof result === "function" ? result : async () => result };
}

function registry(overrides: Partial<CollectorRegistry> = {}): CollectorRegistry {
  const base = Object.fromEntries(
    SOURCE_KEYS.map((k) => [k, stub(k, { status: "never_run", data: null })]),
  ) as unknown as CollectorRegistry;
  return { ...base, ...overrides };
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-snapshot-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  projectsMock.loadProjectsFile.mockReset().mockResolvedValue(null);
  projectsMock.saveProjectsFile.mockReset().mockResolvedValue(undefined);
  projectsMock.seedProjectsFile.mockReset().mockReturnValue({ projects: [], hidden: [] });
  projectsMock.computeProjectsState.mockReset().mockImplementation(emptyState);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("assembleSnapshot", () => {
  it("replaces a slice on ok and stamps updatedAt", () => {
    const next = assembleSnapshot(emptySnapshot(T0), { github: { status: "ok", data: githubData(1, 2) } }, T1);
    expect(next.work.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(next.sources.github).toEqual({ status: "ok", updatedAt: T1.toISOString() });
    expect(next.generatedAt).toBe(T1.toISOString());
    expect(next.sources.jira.status).toBe("never_run");
  });

  it("keeps the last good data of a failing collector and marks it error with the message", () => {
    const good = assembleSnapshot(emptySnapshot(T0), { github: { status: "ok", data: githubData(7) } }, T0);
    const next = assembleSnapshot(good, { github: { status: "error", message: "Run gh auth login", data: null } }, T1);
    expect(next.work.prs.map((p) => p.number)).toEqual([7]);
    expect(next.sources.github).toEqual({ status: "error", updatedAt: T0.toISOString(), message: "Run gh auth login" });
  });

  it("keeps data on an ok result without data (nothing new)", () => {
    const good = assembleSnapshot(emptySnapshot(T0), { github: { status: "ok", data: githubData(3) } }, T0);
    const next = assembleSnapshot(good, { github: { status: "ok", data: null } }, T1);
    expect(next.work.prs).toHaveLength(1);
    expect(next.sources.github.updatedAt).toBe(T1.toISOString());
  });

  it("maps every source slice to its snapshot field", () => {
    const s = emptySlices();
    s.jira.jira = [{ key: "QIC-1", summary: "x", status: "To Do", statusCategory: "todo", priority: "High", dueDate: null, updated: T0.toISOString(), project: "QIC", url: "u", blocked: false }];
    s.claudeSessions.sessionTime = [{ project: "FastBind", minutesByDay: { "2026-10-30": 30 } }];
    s.learning.learning = { streak: { current: 3, best: 9, started: "2026-10-01" }, cycle: null, agendaThisMonth: [] };
    s.checkins = { checkins: [], checkedInToday: true };
    s.calendar.calendar = [{ id: "e1", title: "Standup", start: T1.toISOString(), end: T1.toISOString() }];
    s.email.email = [{ id: "m1", from: "a", subject: "b", receivedAt: T0.toISOString() }];
    const next = assembleSnapshot(
      emptySnapshot(T0),
      Object.fromEntries(SOURCE_KEYS.map((k) => [k, { status: "ok", data: s[k] }])),
      T1,
    );
    expect(next.work.jira[0]?.key).toBe("QIC-1");
    expect(next.work.sessionTime[0]?.project).toBe("FastBind");
    expect(next.learning.streak.current).toBe(3);
    expect(next.personal.checkedInToday).toBe(true);
    expect(next.calendar[0]?.id).toBe("e1");
    expect(next.email[0]?.id).toBe("m1");
  });
});

describe("runCollector", () => {
  const ctx = () => ({ config: loadConfig({}, { rootDir: tmp, home: tmp }), store: createStore(tmp), now: T0, previous: emptySlices().github });

  it("turns a throw into an error result", async () => {
    const c = stub("github", async () => {
      throw new Error("Run gh auth login");
    });
    expect(await runCollector(c, ctx())).toEqual({ status: "error", message: "Run gh auth login", data: null });
  });

  it("times out a hanging collector and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const c: Collector<"github"> = {
      key: "github",
      collect: (context) => {
        signal = context.signal;
        return new Promise(() => undefined);
      },
    };
    const result = await runCollector(c, ctx(), 50);
    expect(result).toEqual({ status: "error", message: "Timed out after 50 ms", data: null });
    expect(signal?.aborted).toBe(true);
  });

  it("rejects results in the wrong shape", async () => {
    const bad = { key: "github", collect: async () => ({ status: "ok", data: { prs: "nope" } }) } as unknown as Collector<"github">;
    expect((await runCollector(bad, ctx())).status).toBe("error");
    const worse = { key: "github", collect: async () => "hello" } as unknown as Collector<"github">;
    expect((await runCollector(worse, ctx())).message).toBe("Collector returned an invalid result");
  });
});

describe("snapshot service", () => {
  const config = () => loadConfig({}, { rootDir: tmp, home: tmp });

  it("keeps last good data across refreshes when a collector starts failing, and saves to disk", async () => {
    let fail = false;
    const github = stub("github", async () => {
      if (fail) throw new Error("API rate limit");
      return { status: "ok", data: githubData(42) };
    });
    const store = createStore(tmp);
    const service = createSnapshotService({ collectors: registry({ github }), config: config(), store, log: () => undefined });
    await service.load();
    await service.refresh();
    fail = true;
    const snap = await service.refresh();
    expect(snap.work.prs.map((p) => p.number)).toEqual([42]);
    expect(snap.sources.github.status).toBe("error");
    expect(snap.sources.github.message).toBe("API rate limit");

    const reloaded = createSnapshotService({ collectors: registry(), config: config(), store, log: () => undefined });
    const fromDisk = await reloaded.load();
    expect(fromDisk.work.prs.map((p) => p.number)).toEqual([42]);
    expect(fromDisk.sources.github.status).toBe("error");
  });

  it("loads an empty snapshot from a missing or corrupt file", async () => {
    const store = createStore(tmp);
    await writeFile(store.pathOf(FILES.snapshot), "{{{");
    const service = createSnapshotService({ collectors: registry(), config: config(), store, log: () => undefined });
    const snap = await service.load();
    expect(Object.keys(snap.sources).sort()).toEqual([...SOURCE_KEYS].sort());
    expect(snap.work.prs).toEqual([]);
  });

  it("runs only the requested collectors on a partial refresh", async () => {
    const github = vi.fn(async () => ({ status: "ok" as const, data: githubData(1) }));
    const checkins = vi.fn(async () => ({ status: "ok" as const, data: { checkins: [], checkedInToday: true } }));
    const service = createSnapshotService({
      collectors: registry({ github: { key: "github", collect: github }, checkins: { key: "checkins", collect: checkins } }),
      config: config(),
      store: createStore(tmp),
      log: () => undefined,
    });
    const snap = await service.refresh(["checkins"]);
    expect(checkins).toHaveBeenCalledTimes(1);
    expect(github).not.toHaveBeenCalled();
    expect(snap.personal.checkedInToday).toBe(true);
    expect(snap.sources.github.status).toBe("never_run");
  });

  it("joins a full refresh that is already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const github = vi.fn(async () => {
      await gate;
      return { status: "ok" as const, data: githubData(1) };
    });
    const service = createSnapshotService({
      collectors: registry({ github: { key: "github", collect: github } }),
      config: config(),
      store: createStore(tmp),
      log: () => undefined,
    });
    const a = service.refresh();
    const b = service.refresh();
    release();
    await Promise.all([a, b]);
    expect(github).toHaveBeenCalledTimes(1);
  });

  it("does not let an older slow run overwrite a newer result for the same source", async () => {
    let call = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const checkins = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await firstGate;
        return { status: "ok" as const, data: { checkins: [], checkedInToday: false } };
      }
      return { status: "ok" as const, data: { checkins: [], checkedInToday: true } };
    });
    const service = createSnapshotService({
      collectors: registry({ checkins: { key: "checkins", collect: checkins } }),
      config: config(),
      store: createStore(tmp),
      log: () => undefined,
    });
    const slow = service.refresh();
    const fast = await service.refresh(["checkins"]);
    expect(fast.personal.checkedInToday).toBe(true);
    releaseFirst();
    const after = await slow;
    expect(after.personal.checkedInToday).toBe(true);
  });

  it("recovers a partial snapshot file", () => {
    const snap = normaliseSnapshot({ sources: { jira: { status: "not_connected", updatedAt: null, message: "Add token" } }, work: { prs: "bad" } }, T0);
    expect(snap.sources.jira).toEqual({ status: "not_connected", updatedAt: null, message: "Add token" });
    expect(snap.work.prs).toEqual([]);
    expect(snap.learning.agendaThisMonth).toEqual([]);
  });
});

describe("collector registry", () => {
  it("has one collector per source, under its own key", () => {
    expect(Object.keys(realRegistry).sort()).toEqual([...SOURCE_KEYS].sort());
    for (const key of SOURCE_KEYS) expect(realRegistry[key].key).toBe(key);
  });
});

describe("snapshot v1.1: projects and notes", () => {
  const config = () => loadConfig({}, { rootDir: tmp, home: tmp });
  const note = (i: number): NoteMeta => ({
    path: `Meeting notes/2026-10-${String(i).padStart(2, "0")}-note-${i}.md`,
    section: "Meeting notes",
    title: `Note ${i}`,
    created: "2026-10-20T09:00:00.000Z",
    updated: "2026-10-20T09:00:00.000Z",
    projectId: null,
    tags: [],
    excerpt: "",
    openActions: 0,
    vault: "notes",
    readOnly: false,
  });
  function fakeNotes(over: Partial<NotesStore> = {}): NotesStore {
    const unused = async (): Promise<never> => {
      throw new Error("not used in this test");
    };
    return {
      index: async () => ({ status: "ok", dir: "notes", vaults: [], sections: [], notes: [] }),
      read: unused,
      create: unused,
      update: unused,
      remove: unused,
      createSection: unused,
      renameSection: unused,
      removeSection: unused,
      recent: async () => [],
      ...over,
    };
  }
  const service = (notes?: NotesStore, collectors = registry()) =>
    createSnapshotService({ collectors, config: config(), store: createStore(tmp), notes, now: () => T0, log: () => undefined });

  it("always carries projects and notes, empty by default", () => {
    const empty = emptySnapshot(T0);
    expect(empty.projects).toEqual(emptyState());
    expect(empty.notes).toEqual({ recent: [], status: "never_run" });
    expect(normaliseSnapshot({}, T0).projects).toEqual(emptyState());
    expect(assembleSnapshot(empty, {}, T1).notes).toEqual({ recent: [], status: "never_run" });
  });

  it("fills notes from the notes store and projects from the registry on load", async () => {
    const file: ProjectsFile = { projects: [], hidden: ["old-repo"] };
    const state: ProjectsState = { ...emptyState(), hidden: ["old-repo"] };
    projectsMock.loadProjectsFile.mockResolvedValue(file);
    projectsMock.computeProjectsState.mockReturnValue(state);
    const recentDays = vi.fn(async () => [note(2)]);
    const svc = service(fakeNotes({ index: async () => ({ status: "ok", dir: "notes", vaults: [], sections: [], notes: [note(1), note(2)] }), recent: recentDays }));
    await svc.load();
    const snap = svc.get(T0);
    expect(snap.notes).toEqual({ recent: [note(2)], status: "ok" });
    expect(snap.projects).toEqual(state);
    expect(recentDays).toHaveBeenCalledWith(RECENT_NOTES_DAYS, T0);
    // Project note stats see every note, not only the recent ones.
    const [gotFile, gotSnapshot, gotNotes, gotNow] = projectsMock.computeProjectsState.mock.calls.at(-1)!;
    expect(gotFile).toEqual(file);
    expect(gotSnapshot.work).toEqual(emptySnapshot(T0).work);
    expect(gotNotes).toEqual([note(1), note(2)]);
    expect(gotNow).toEqual(T0);
  });

  it("v1.4: recent notes come from every vault: last 14 days, newest first, at most 30", async () => {
    const notesDir = path.join(tmp, "vault", "notes");
    const learning = path.join(tmp, "Learning");
    const qic = path.join(tmp, "QIC");
    const put = async (file: string, updated: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `---\nupdated: ${updated}\n---\n# ${path.basename(file, ".md")}\n`);
    };
    await put(path.join(notesDir, "Meeting notes", "default.md"), "2026-10-29T09:00:00.000Z");
    await put(path.join(learning, "wiki", "learn.md"), "2026-10-28T09:00:00.000Z");
    await put(path.join(learning, "raw", "source.md"), "2026-10-27T09:00:00.000Z");
    await put(path.join(qic, "wiki", "old.md"), "2026-10-01T09:00:00.000Z"); // older than 14 days
    for (let i = 0; i < 30; i++) await put(path.join(qic, "bulk", `b${i}.md`), `2026-10-2${i % 6}T08:00:00.000Z`);
    const notes = createNotesStore(notesDir, {
      log: () => undefined,
      vaults: [
        { id: "learning", label: "Learning", prefix: "@learning/", dir: learning, readOnlyFolders: ["raw"] },
        { id: "qic-uw", label: "QIC Underwriting Agent", prefix: "@qic-uw/", dir: qic, readOnlyFolders: ["sources"] },
      ],
    });
    const svc = service(notes);
    await svc.load();
    const { recent, status } = svc.get(T0).notes;
    expect(status).toBe("ok");
    expect(recent).toHaveLength(RECENT_NOTES_MAX);
    expect(recent.slice(0, 3).map((n) => [n.path, n.vault, n.readOnly])).toEqual([
      ["Meeting notes/default.md", "notes", false],
      ["@learning/wiki/learn.md", "learning", false],
      ["@learning/raw/source.md", "learning", true],
    ]);
    expect(new Set(recent.map((n) => n.vault))).toEqual(new Set(["notes", "learning", "qic-uw"]));
    expect(recent.map((n) => n.path)).not.toContain("@qic-uw/wiki/old.md");
    // Project note stats still see every note, old ones included.
    const allNotes = projectsMock.computeProjectsState.mock.calls.at(-1)![2];
    expect(allNotes.map((n) => n.path)).toContain("@qic-uw/wiki/old.md");
  });

  it("v1.4: recent notes in a snapshot saved before vaults are default-vault notes", () => {
    const old = { path: "Meeting notes/a.md", section: "Meeting notes", title: "a", created: "", updated: "", projectId: null, tags: [], excerpt: "", openActions: 0 };
    const snap = normaliseSnapshot({ notes: { recent: [old, { ...old, path: "@learning/x.md", vault: "learning", readOnly: true }], status: "ok" } }, T0);
    expect(snap.notes.recent.map((n) => [n.path, n.vault, n.readOnly])).toEqual([
      ["Meeting notes/a.md", "notes", false],
      ["@learning/x.md", "learning", true],
    ]);
  });

  it("caps recent notes at 30", async () => {
    const many = Array.from({ length: 40 }, (_, i) => note(i + 1));
    const svc = service(fakeNotes({ index: async () => ({ status: "ok", dir: "notes", vaults: [], sections: [], notes: many }), recent: async () => many }));
    await svc.load();
    expect(svc.get(T0).notes.recent).toHaveLength(RECENT_NOTES_MAX);
  });

  it("marks notes not_connected, naming the folder, when NOTES_DIR and its parent are missing", async () => {
    const svc = service(); // default store on config.notesDir, which does not exist under tmp
    await svc.load();
    const { notes } = svc.get(T0);
    expect(notes.status).toBe("not_connected");
    expect(notes.recent).toEqual([]);
    expect(notes.message).toContain(config().notesDir);
  });

  it("marks notes error and keeps the rest of the snapshot when the notes store fails", async () => {
    const svc = service(fakeNotes({ index: () => Promise.reject(new Error("EACCES: permission denied")) }));
    await svc.load();
    const snap = await svc.refresh();
    expect(snap.notes).toEqual({ recent: [], status: "error", message: "EACCES: permission denied" });
    expect(snap.projects).toEqual(emptyState());
    expect(snap.sources.github.status).toBe("never_run");
  });

  it("refreshLocal re-reads the registry and the notes folder without running collectors", async () => {
    const github = vi.fn(async () => ({ status: "ok" as const, data: githubData(1) }));
    let notesNow = [note(1)];
    const svc = service(
      fakeNotes({ index: async () => ({ status: "ok", dir: "notes", vaults: [], sections: [], notes: notesNow }), recent: async () => notesNow }),
      registry({ github: { key: "github", collect: github } }),
    );
    await svc.load();
    notesNow = [note(1), note(2)];
    const changed: ProjectsState = { ...emptyState(), hidden: ["x"] };
    projectsMock.computeProjectsState.mockReturnValue(changed);
    const snap = await svc.refreshLocal();
    expect(github).not.toHaveBeenCalled();
    expect(snap.notes.recent).toEqual([note(1), note(2)]);
    expect(snap.projects).toEqual(changed);
    expect(svc.get(T0).projects).toEqual(changed);
  });

  it("seeds projects.json only once the sessions collector has reported", async () => {
    const seeded: ProjectsFile = { projects: [], hidden: ["seeded"] };
    projectsMock.seedProjectsFile.mockReturnValue(seeded);
    const sessions = stub("claudeSessions", { status: "ok", data: { sessionTime: [{ project: "fastbind", minutesByDay: { "2026-10-29": 90 } }] } });
    const svc = service(fakeNotes(), registry({ claudeSessions: sessions }));
    await svc.load();
    expect(projectsMock.seedProjectsFile).not.toHaveBeenCalled();
    expect(projectsMock.saveProjectsFile).not.toHaveBeenCalled();

    await svc.refresh();
    expect(projectsMock.seedProjectsFile).toHaveBeenCalledTimes(1);
    const [seedSnapshot] = projectsMock.seedProjectsFile.mock.calls[0]!;
    expect(seedSnapshot.work.sessionTime.map((s) => s.project)).toEqual(["fastbind"]);
    expect(projectsMock.saveProjectsFile).toHaveBeenCalledWith(expect.anything(), seeded);
    expect(projectsMock.computeProjectsState.mock.calls.at(-1)![0]).toEqual(seeded);
  });

  it("never lets a registry bug break the snapshot", async () => {
    projectsMock.loadProjectsFile.mockRejectedValue(new Error("projects.json is not valid"));
    projectsMock.computeProjectsState.mockImplementation(() => {
      throw new Error("boom");
    });
    const svc = service(fakeNotes());
    await svc.load();
    const snap = await svc.refresh();
    expect(snap.projects).toEqual(emptyState());
    expect(snap.notes.status).toBe("ok");
  });
});
