import type { NoteMeta, ProjectsFile, ProjectsState, Snapshot, SourceState, SourceStatus } from "../shared/types";
import type {
  Collector,
  CollectorContext,
  CollectorRegistry,
  CollectorResult,
  CollectorSlices,
  SourceKey,
} from "./collectors/types";
import { SOURCE_KEYS } from "./collectors/types";
import type { Config } from "./config";
import { computeNeedsYou, countNeedsYou } from "./needsYou";
import { createNotesStore, type NotesStore } from "./notes";
import { computeProjectsState, loadProjectsFile, saveProjectsFile, seedProjectsFile } from "./projects";
import { FILES, type Store } from "./store";

/** Each collector gets this long before it is marked error and ignored. */
export const COLLECTOR_TIMEOUT_MS = 60_000;

const STATUSES: readonly SourceStatus[] = ["ok", "error", "not_connected", "stale", "never_run"];
const MESSAGE_MAX = 300;

/** Snapshot.notes.recent: notes updated in the last 14 days, newest first, at most 30. */
export const RECENT_NOTES_DAYS = 14;
export const RECENT_NOTES_MAX = 30;

export function emptyProjectsState(): ProjectsState {
  return { projects: [], stats: [], untracked: [], hidden: [] };
}

export function emptySlices(): CollectorSlices {
  return {
    github: { prs: [], ci: [], repoActivity: [] },
    jira: { jira: [] },
    claudeSessions: { sessionTime: [] },
    learning: { learning: { streak: { current: 0, best: 0, started: null }, cycle: null, agendaThisMonth: [] } },
    checkins: { checkins: [], checkedInToday: false },
    calendar: { calendar: [] },
    email: { email: [] },
  };
}

function neverRun(): SourceState {
  return { status: "never_run", updatedAt: null };
}

export function emptySnapshot(now: Date): Snapshot {
  const s = emptySlices();
  return {
    generatedAt: now.toISOString(),
    sources: {
      github: neverRun(),
      jira: neverRun(),
      claudeSessions: neverRun(),
      learning: neverRun(),
      checkins: neverRun(),
      calendar: neverRun(),
      email: neverRun(),
    },
    needsYou: [],
    needsYouTotal: 0,
    work: { jira: s.jira.jira, prs: s.github.prs, ci: s.github.ci, repoActivity: s.github.repoActivity, sessionTime: s.claudeSessions.sessionTime },
    learning: s.learning.learning,
    personal: { checkins: s.checkins.checkins, checkedInToday: s.checkins.checkedInToday },
    calendar: s.calendar.calendar,
    email: s.email.email,
    projects: emptyProjectsState(),
    notes: { recent: [], status: "never_run" },
  };
}

// Where each source's slice lives in the Snapshot.
const extract: { [K in SourceKey]: (s: Snapshot) => CollectorSlices[K] } = {
  github: (s) => ({ prs: s.work.prs, ci: s.work.ci, repoActivity: s.work.repoActivity }),
  jira: (s) => ({ jira: s.work.jira }),
  claudeSessions: (s) => ({ sessionTime: s.work.sessionTime }),
  learning: (s) => ({ learning: s.learning }),
  checkins: (s) => ({ checkins: s.personal.checkins, checkedInToday: s.personal.checkedInToday }),
  calendar: (s) => ({ calendar: s.calendar }),
  email: (s) => ({ email: s.email }),
};

const apply: { [K in SourceKey]: (s: Snapshot, d: CollectorSlices[K]) => void } = {
  github: (s, d) => {
    s.work = { ...s.work, prs: d.prs, ci: d.ci, repoActivity: d.repoActivity };
  },
  jira: (s, d) => {
    s.work = { ...s.work, jira: d.jira };
  },
  claudeSessions: (s, d) => {
    s.work = { ...s.work, sessionTime: d.sessionTime };
  },
  learning: (s, d) => {
    s.learning = d.learning;
  },
  checkins: (s, d) => {
    s.personal = { checkins: d.checkins, checkedInToday: d.checkedInToday };
  },
  calendar: (s, d) => {
    s.calendar = d.calendar;
  },
  email: (s, d) => {
    s.email = d.email;
  },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arrays = (v: unknown, ...keys: string[]) => isObject(v) && keys.every((k) => Array.isArray(v[k]));

// Light shape checks so one buggy collector cannot break the snapshot for the web app.
const validSlice: { [K in SourceKey]: (d: unknown) => d is CollectorSlices[K] } = {
  github: (d): d is CollectorSlices["github"] => arrays(d, "prs", "ci", "repoActivity"),
  jira: (d): d is CollectorSlices["jira"] => arrays(d, "jira"),
  claudeSessions: (d): d is CollectorSlices["claudeSessions"] => arrays(d, "sessionTime"),
  learning: (d): d is CollectorSlices["learning"] =>
    isObject(d) && isObject(d.learning) && isObject(d.learning.streak) && Array.isArray(d.learning.agendaThisMonth) &&
    (d.learning.cycle === null || isObject(d.learning.cycle)),
  checkins: (d): d is CollectorSlices["checkins"] => arrays(d, "checkins") && typeof (d as { checkedInToday?: unknown }).checkedInToday === "boolean",
  calendar: (d): d is CollectorSlices["calendar"] => arrays(d, "calendar"),
  email: (d): d is CollectorSlices["email"] => arrays(d, "email"),
};

export function sliceOf<K extends SourceKey>(snapshot: Snapshot, key: K): CollectorSlices[K] {
  return extract[key](snapshot);
}

function applySlice<K extends SourceKey>(snapshot: Snapshot, key: K, data: CollectorSlices[K]): void {
  apply[key](snapshot, data);
}

export function cleanMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine === "") return undefined;
  return oneLine.length > MESSAGE_MAX ? `${oneLine.slice(0, MESSAGE_MAX - 3)}...` : oneLine;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return cleanMessage(err.message) ?? "Collection failed";
  return cleanMessage(String(err)) ?? "Collection failed";
}

/** Turns whatever a collector returned into a safe result. Bad shapes become errors. */
export function normaliseResult<K extends SourceKey>(key: K, raw: unknown): CollectorResult<K> {
  if (!isObject(raw) || !STATUSES.includes(raw.status as SourceStatus)) {
    return { status: "error", message: "Collector returned an invalid result", data: null };
  }
  const status = raw.status as SourceStatus;
  const message = cleanMessage(raw.message);
  const data = raw.data;
  if (data === undefined || data === null) {
    return { status, message: message ?? (status === "error" ? "Collection failed" : undefined), data: null };
  }
  if (!validSlice[key](data)) {
    return { status: "error", message: "Collector returned data in the wrong shape", data: null };
  }
  return { status, message: message ?? (status === "error" ? "Collection failed" : undefined), data };
}

export type CollectorResults = { [K in SourceKey]?: CollectorResult<K> };

/**
 * Pure: builds the next snapshot from the previous one and this round's results.
 * - A result with data replaces that source's slice.
 * - A result without data (error, timeout, "nothing new") keeps the previous slice.
 * - updatedAt becomes `now` on "ok", otherwise stays at the last ok time.
 * - Sources with no result this round are untouched.
 */
export function assembleSnapshot(prev: Snapshot, results: CollectorResults, now: Date): Snapshot {
  const next: Snapshot = { ...prev, sources: { ...prev.sources }, work: { ...prev.work }, personal: { ...prev.personal } };
  for (const key of SOURCE_KEYS) {
    const result = results[key];
    if (!result) continue;
    if (result.data) applySlice(next, key, result.data);
    const state: SourceState = {
      status: result.status,
      updatedAt: result.status === "ok" ? now.toISOString() : prev.sources[key].updatedAt,
    };
    if (result.message) state.message = result.message;
    next.sources[key] = state;
  }
  next.generatedAt = now.toISOString();
  return withNeedsYou(next, now);
}

function withNeedsYou(snapshot: Snapshot, now: Date): Snapshot {
  try {
    const items = computeNeedsYou(snapshot, now);
    const needsYou = Array.isArray(items) ? items : [];
    const total = countNeedsYou(snapshot, now);
    return { ...snapshot, needsYou, needsYouTotal: Number.isFinite(total) ? Math.max(total, needsYou.length) : needsYou.length };
  } catch (err) {
    console.error(`[needs-you] rule engine failed: ${errorMessage(err)}`);
    return { ...snapshot, needsYou: [], needsYouTotal: 0 };
  }
}

/**
 * Runs one collector with a timeout. Never throws: a throw, a hang or a bad result
 * becomes an "error" result with data null (so the last good data is kept).
 */
export async function runCollector<K extends SourceKey>(
  collector: Collector<K>,
  ctx: Omit<CollectorContext<K>, "signal">,
  timeoutMs: number = COLLECTOR_TIMEOUT_MS,
): Promise<CollectorResult<K>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CollectorResult<K>>((resolve) => {
    timer = setTimeout(() => {
      const message = `Timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
      controller.abort(new Error(message));
      resolve({ status: "error", message, data: null });
    }, timeoutMs);
  });
  const work = (async () => collector.collect({ ...ctx, signal: controller.signal }))().then(
    (raw) => normaliseResult(collector.key, raw),
    (err: unknown) => ({ status: "error", message: errorMessage(err), data: null }) as CollectorResult<K>,
  );
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fills in anything missing from a snapshot read from disk (older or partial files). */
export function normaliseSnapshot(raw: unknown, now: Date): Snapshot {
  const base = emptySnapshot(now);
  if (!isObject(raw)) return base;
  const snap = base;
  if (typeof raw.generatedAt === "string") snap.generatedAt = raw.generatedAt;
  const rawSources = isObject(raw.sources) ? raw.sources : {};
  const loaded = raw as unknown as Snapshot;
  for (const key of SOURCE_KEYS) {
    const st = rawSources[key];
    if (isObject(st) && STATUSES.includes(st.status as SourceStatus)) {
      const state: SourceState = {
        status: st.status as SourceStatus,
        updatedAt: typeof st.updatedAt === "string" ? st.updatedAt : null,
      };
      const message = cleanMessage(st.message);
      if (message) state.message = message;
      snap.sources[key] = state;
    }
    let slice: unknown;
    try {
      slice = extract[key](loaded);
    } catch {
      slice = undefined;
    }
    if (validSlice[key](slice)) applySlice(snap, key, slice);
  }
  if (Array.isArray(raw.needsYou)) snap.needsYou = raw.needsYou as Snapshot["needsYou"];
  if (typeof raw.needsYouTotal === "number") snap.needsYouTotal = raw.needsYouTotal;
  // Kept so readers of data/snapshot.json (the AI run) see projects and recent notes too.
  if (isObject(raw.projects) && Array.isArray(raw.projects.projects) && Array.isArray(raw.projects.stats)) {
    snap.projects = raw.projects as unknown as Snapshot["projects"];
  }
  if (isObject(raw.notes) && Array.isArray(raw.notes.recent)) {
    const notes = raw.notes as unknown as Snapshot["notes"];
    // v1.4: notes saved before vaults existed are default-vault notes that were never read-only.
    const recent = (notes.recent as unknown[]).map((n) =>
      isObject(n) ? { ...n, vault: typeof n.vault === "string" ? n.vault : "notes", readOnly: n.readOnly === true } : n,
    );
    snap.notes = { ...notes, recent: recent as NoteMeta[] };
  }
  return snap;
}

export interface SnapshotService {
  /** Loads the last snapshot from data/snapshot.json (or an empty one). Call once at start. */
  load(): Promise<Snapshot>;
  /** Current snapshot with needs-you recomputed for `now`. */
  get(now?: Date): Snapshot;
  /**
   * Runs the given collectors (all when omitted), merges, saves and returns the snapshot.
   * A full refresh while one is running returns the running one. Results from an older run
   * never overwrite a newer run's results for the same source.
   */
  refresh(keys?: readonly SourceKey[]): Promise<Snapshot>;
  /**
   * Re-reads data/projects.json and the notes folder and recomputes snapshot.projects and
   * snapshot.notes (no collectors run). The projects and notes routers call it after every
   * write. Returns the snapshot like get(). Never rejects.
   */
  refreshLocal(): Promise<Snapshot>;
}

export interface SnapshotServiceDeps {
  collectors: CollectorRegistry;
  config: Config;
  /** data/ store; also holds projects.json. */
  store: Store;
  /** Notes store for snapshot.notes and per-project note stats, over every vault. Default: createNotesStore(config.notesDir, { vaults: config.vaults }). */
  notes?: NotesStore;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export function createSnapshotService(deps: SnapshotServiceDeps): SnapshotService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const notesStore = deps.notes ?? createNotesStore(deps.config.notesDir, { vaults: deps.config.vaults, log });
  let current = emptySnapshot(now());
  let runCounter = 0;
  let local: LocalData = { file: null, allNotes: [], notes: { recent: [], status: "never_run" } };
  let localCounter = 0;
  let localApplied = 0;

  async function readProjectsFile(snapshot: Snapshot, at: Date): Promise<ProjectsFile | null> {
    try {
      const file = await loadProjectsFile(deps.store);
      if (file !== null) return file;
      // First run: seed from session time, but only once the sessions collector has reported,
      // so an empty first snapshot never writes an empty registry.
      if (snapshot.sources.claudeSessions.status === "never_run") return null;
      const seeded = seedProjectsFile(snapshot, at);
      await saveProjectsFile(deps.store, seeded);
      return seeded;
    } catch (err) {
      log(`[projects] could not read the project registry: ${errorMessage(err)}`);
      return local.file;
    }
  }

  async function readNotes(at: Date): Promise<Pick<LocalData, "allNotes" | "notes">> {
    const failed = (message: string) => ({
      allNotes: local.allNotes,
      notes: { recent: local.notes.recent, status: "error" as const, message },
    });
    let index: unknown;
    try {
      index = await notesStore.index();
    } catch (err) {
      return failed(errorMessage(err));
    }
    if (!isObject(index) || !STATUSES.includes(index.status as SourceStatus) || !Array.isArray(index.notes)) {
      return failed("Notes store returned an invalid index");
    }
    const status = index.status as SourceStatus;
    const allNotes = index.notes as NoteMeta[];
    const message = cleanMessage(index.message);
    let recent: NoteMeta[] = [];
    if (status !== "not_connected") {
      try {
        const list = await notesStore.recent(RECENT_NOTES_DAYS, at);
        recent = Array.isArray(list) ? list.slice(0, RECENT_NOTES_MAX) : [];
      } catch (err) {
        return { ...failed(errorMessage(err)), allNotes };
      }
    }
    return { allNotes, notes: message ? { recent, status, message } : { recent, status } };
  }

  /** Reads projects.json and the notes folder into `local`. An older read never overwrites a newer one. */
  async function readLocal(at: Date): Promise<void> {
    const id = ++localCounter;
    const [file, notes] = await Promise.all([readProjectsFile(current, at), readNotes(at)]);
    if (id < localApplied) return;
    localApplied = id;
    local = { file, ...notes };
  }

  /** Puts `local` into a snapshot: notes as read, projects computed against this snapshot's data. */
  function withLocal(snapshot: Snapshot, at: Date): Snapshot {
    let projects: ProjectsState;
    try {
      projects = computeProjectsState(local.file ?? { projects: [], hidden: [] }, snapshot, local.allNotes, at);
    } catch (err) {
      log(`[projects] could not compute project stats: ${errorMessage(err)}`);
      projects = emptyProjectsState();
    }
    return { ...snapshot, projects, notes: local.notes };
  }
  const appliedRun = Object.fromEntries(SOURCE_KEYS.map((k) => [k, 0])) as Record<SourceKey, number>;
  let fullRefresh: Promise<Snapshot> | null = null;

  async function collectOne<K extends SourceKey>(key: K, startedAt: Date): Promise<CollectorResult<K>> {
    const collector = deps.collectors[key];
    return runCollector(
      collector,
      { config: deps.config, store: deps.store, now: startedAt, previous: sliceOf(current, key) },
      deps.timeoutMs ?? COLLECTOR_TIMEOUT_MS,
    );
  }

  async function run(keys: readonly SourceKey[]): Promise<Snapshot> {
    const runId = ++runCounter;
    const startedAt = now();
    const settled = await Promise.all(keys.map(async (key) => [key, await collectOne(key, startedAt)] as const));
    const fresh: Record<string, CollectorResult<SourceKey>> = {};
    for (const [key, result] of settled) {
      if (runId < appliedRun[key]) continue; // a newer run already reported this source
      appliedRun[key] = runId;
      fresh[key] = result;
      log(`[collect] ${key}: ${result.status}${result.message ? ` (${result.message})` : ""}`);
    }
    current = assembleSnapshot(current, fresh as CollectorResults, now());
    // Session time and repo activity may have changed, and notes may have been edited in Obsidian.
    await readLocal(now());
    const at = now();
    current = withNeedsYou(withLocal(current, at), at);
    try {
      await deps.store.write(FILES.snapshot, current);
    } catch (err) {
      log(`[collect] could not save ${FILES.snapshot}: ${errorMessage(err)}`);
    }
    return current;
  }

  return {
    async load() {
      const raw = await deps.store.read<unknown>(FILES.snapshot, null);
      current = normaliseSnapshot(raw, now());
      await readLocal(now());
      current = withLocal(current, now());
      return current;
    },
    get(at) {
      const t = at ?? now();
      return withNeedsYou(current, t);
    },
    refresh(keys) {
      if (keys) return run([...new Set(keys)].filter((k) => SOURCE_KEYS.includes(k)));
      if (fullRefresh) return fullRefresh;
      const p = run(SOURCE_KEYS).finally(() => {
        if (fullRefresh === p) fullRefresh = null;
      });
      fullRefresh = p;
      return p;
    },
    async refreshLocal() {
      await readLocal(now());
      const at = now();
      current = withLocal(current, at);
      return withNeedsYou(current, at);
    },
  };
}

/** What the snapshot service last read from projects.json and the notes folder. */
interface LocalData {
  /** null while projects.json does not exist (and has not been seeded yet). */
  file: ProjectsFile | null;
  /** Every note, for per-project note stats. */
  allNotes: NoteMeta[];
  notes: Snapshot["notes"];
}
