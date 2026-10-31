import { createHash, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  DetectedProject,
  NoteMeta,
  Project,
  ProjectArea,
  ProjectsFile,
  ProjectsState,
  ProjectStats,
  ProjectStatus,
  ProjectTask,
  Snapshot,
} from "../shared/types";
import type { Store } from "./store";

// Project registry (docs/ARCHITECTURE.md "v1.1: Project tracker and notes").
//
// The snapshot service (snapshot.ts) and the projects router (routes/projects.ts) call the four
// functions below as written:
// - snapshot.ts, on load, after every collector run and on refreshLocal():
//     file = await loadProjectsFile(store)
//     if file is null and the claudeSessions collector has run at least once:
//       file = seedProjectsFile(snapshot, now); await saveProjectsFile(store, file)
//     snapshot.projects = computeProjectsState(file ?? { projects: [], hidden: [] }, snapshot, allNotes, now)
//   It catches and logs anything these throw, so a bug here never breaks the snapshot.
// - routes/projects.ts changes the file inside withProjectsLock(), then calls snapshots.refreshLocal().
// Rules: this file never imports snapshot.ts or app.ts (snapshot.ts imports it), and the pure
// functions take `now` instead of reading the clock.

/** data/projects.json, read and written through the data store. */
export const PROJECTS_FILE = "projects.json";

export const PROJECT_AREAS: readonly ProjectArea[] = ["work", "learning", "personal"];
export const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "paused", "done", "idea"];

/** Input limits (docs/ARCHITECTURE.md "API additions", plus caps that keep the file small). */
export const LIMITS = {
  name: 80,
  taskText: 300,
  description: 2000,
  goals: 10,
  goal: 200,
  sourceName: 200,
  sourcesPerKind: 50,
  tasksPerProject: 500,
  projects: 500,
  hidden: 1000,
} as const;

/** Seeding: a session name needs more than this many minutes in the last SEED_WINDOW_DAYS days. */
export const SEED_MIN_MINUTES = 60;
export const SEED_WINDOW_DAYS = 30;
/** Untracked: detected names with activity in the last this many days. */
export const UNTRACKED_WINDOW_DAYS = 90;

const SLUG_MAX = 60;
const TASK_ID_LENGTH = 8;
const TASK_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const EPOCH = "1970-01-01T00:00:00.000Z";
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

// ---- ids ----

/** "QIC FastBind!" becomes "qic-fastbind". Letters of any script are kept; never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const cut = [...slug].slice(0, SLUG_MAX).join("").replace(/-+$/, "");
  return cut || "project";
}

/** `base`, or `base-2`, `base-3` and so on when taken. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Random 8-character task id, unique within `taken`. */
export function newTaskId(taken: ReadonlySet<string>): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < TASK_ID_LENGTH; i++) id += TASK_ID_CHARS[randomInt(TASK_ID_CHARS.length)];
    if (!taken.has(id)) return id;
  }
}

// ---- days ----

/** YYYY-MM-DD in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** First day key of the last `days` local days, today included. */
function windowStart(now: Date, days: number): string {
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
}

/** A real calendar date written YYYY-MM-DD. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Sum of the values on days from `from` (YYYY-MM-DD) on. */
function sumFrom(byDay: Record<string, number> | undefined, from: string): number {
  let sum = 0;
  if (!isObject(byDay)) return sum;
  for (const [day, value] of Object.entries(byDay)) if (DAY_KEY.test(day) && day >= from) sum += count(value);
  return sum;
}

/** Latest day with activity, or null. */
function lastActiveDay(byDay: Record<string, number> | undefined): string | null {
  let last: string | null = null;
  if (!isObject(byDay)) return last;
  for (const [day, value] of Object.entries(byDay)) if (DAY_KEY.test(day) && count(value) > 0 && (last === null || day > last)) last = day;
  return last;
}

function addInto(target: Record<string, number>, byDay: Record<string, number> | undefined): void {
  if (!isObject(byDay)) return;
  for (const [day, value] of Object.entries(byDay)) {
    const n = count(value);
    if (DAY_KEY.test(day) && n > 0) target[day] = (target[day] ?? 0) + n;
  }
}

// ---- source names ----

/** Session names compare without case (they are folder names on Windows). */
export function sameSession(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Repo names compare without case, with or without the owner ("fastbind" matches "islam543/fastbind"). */
export function sameRepo(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  if (x.includes("/") && y.includes("/")) return false;
  return x.slice(x.lastIndexOf("/") + 1) === y.slice(y.lastIndexOf("/") + 1);
}

/** Hidden names are the exact detected names (session name or owner/repo), without case. */
export function isHiddenName(name: string, hidden: readonly string[]): boolean {
  return hidden.some((h) => sameSession(h, name));
}

/** The project whose sources already hold this session or repo name, if any. */
export function projectClaiming(
  file: ProjectsFile,
  kind: "session" | "repo",
  name: string,
  exceptId: string | null = null,
): Project | undefined {
  return file.projects.find(
    (p) =>
      p.id !== exceptId &&
      (kind === "session" ? p.sources.sessions.some((s) => sameSession(s, name)) : p.sources.repos.some((r) => sameRepo(r, name))),
  );
}

// ---- file ----

/**
 * Reads data/projects.json. Resolves null only when the file does not exist yet (that triggers
 * first-run seeding, so a corrupt file must not look missing). Never returns a partial shape:
 * bad entries are repaired or dropped. A file that is not JSON, or holds no project list, throws
 * (callers log it and keep the last good registry; nothing overwrites the file meanwhile).
 */
export async function loadProjectsFile(store: Store): Promise<ProjectsFile | null> {
  let text: string;
  try {
    text = await readFile(store.pathOf(PROJECTS_FILE), "utf8");
  } catch (err) {
    const code = isObject(err) && typeof err.code === "string" ? err.code : "unknown error";
    if (code === "ENOENT") return null;
    throw new Error(`Could not read data/${PROJECTS_FILE} (${code})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`data/${PROJECTS_FILE} is not valid JSON. Fix it, or delete it to seed a new one.`);
  }
  if (!isObject(raw) || !Array.isArray(raw.projects)) {
    throw new Error(`data/${PROJECTS_FILE} has no "projects" list. Fix it, or delete it to seed a new one.`);
  }
  return normaliseProjectsFile(raw);
}

/** Writes data/projects.json atomically (store.write). */
export async function saveProjectsFile(store: Store, file: ProjectsFile): Promise<void> {
  await store.write(PROJECTS_FILE, file);
}

// Per-file promise chain, so read-change-write cycles from the router never interleave.
const chains = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task for the same store's projects.json has settled. */
export function withProjectsLock<T>(store: Store, task: () => Promise<T>): Promise<T> {
  const key = store.pathOf(PROJECTS_FILE);
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  chains.set(key, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      if (chains.get(key) === run) chains.delete(key);
    });
  return run;
}

// ---- normalising a file read from disk (Islam may edit it by hand) ----

function str(value: unknown, max: number): string {
  return typeof value === "string" ? [...value.trim()].slice(0, max).join("") : "";
}

function strings(value: unknown, maxItems: number, maxLength: number, sameName: (a: string, b: string) => boolean): string[] {
  const out: string[] = [];
  for (const item of list(value as unknown[])) {
    const s = str(item, maxLength);
    if (s !== "" && !out.some((o) => sameName(o, s))) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function stamp(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

/** Same input, same id: a task without one keeps a stable id until the next write saves it. */
function derivedTaskId(projectId: string, index: number, text: string, taken: ReadonlySet<string>): string {
  for (let salt = 0; ; salt++) {
    const id = createHash("sha256").update(`${projectId}\n${index}\n${salt}\n${text}`).digest("hex").slice(0, TASK_ID_LENGTH);
    if (!taken.has(id)) return id;
  }
}

function normaliseTask(raw: unknown, index: number, projectId: string, projectCreated: string, taken: Set<string>): ProjectTask | null {
  if (!isObject(raw)) return null;
  const text = str(raw.text, LIMITS.taskText);
  if (text === "") return null;
  let id = typeof raw.id === "string" ? raw.id.trim().slice(0, 64) : "";
  if (id === "" || taken.has(id)) id = derivedTaskId(projectId, index, text, taken);
  taken.add(id);
  const done = raw.done === true;
  const createdAt = stamp(raw.createdAt, projectCreated);
  return {
    id,
    text,
    done,
    due: isDateKey(raw.due) ? raw.due : null,
    doneAt: done ? stamp(raw.doneAt, createdAt) : null,
    createdAt,
  };
}

function normaliseProject(raw: unknown, taken: Set<string>): Project | null {
  if (!isObject(raw)) return null;
  const rawId = typeof raw.id === "string" ? raw.id.trim().slice(0, 200) : "";
  const name = str(raw.name, LIMITS.name) || rawId.slice(0, LIMITS.name);
  if (name === "") return null;
  const id = uniqueId(rawId || slugify(name), taken);
  taken.add(id);
  const area = typeof raw.area === "string" ? raw.area.trim().toLowerCase() : "";
  const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  const createdAt = stamp(raw.createdAt, stamp(raw.updatedAt, EPOCH));
  const sources = isObject(raw.sources) ? raw.sources : {};
  const taskIds = new Set<string>();
  const tasks: ProjectTask[] = [];
  list(raw.tasks as unknown[]).forEach((t, i) => {
    if (tasks.length >= LIMITS.tasksPerProject) return;
    const task = normaliseTask(t, i, id, createdAt, taskIds);
    if (task) tasks.push(task);
  });
  return {
    id,
    name,
    area: PROJECT_AREAS.includes(area as ProjectArea) ? (area as ProjectArea) : "work",
    status: PROJECT_STATUSES.includes(status as ProjectStatus) ? (status as ProjectStatus) : "active",
    deadline: isDateKey(raw.deadline) ? raw.deadline : null,
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, LIMITS.description) : "",
    goals: strings(raw.goals, LIMITS.goals, LIMITS.goal, (a, b) => a === b),
    tasks,
    sources: {
      sessions: strings(sources.sessions, LIMITS.sourcesPerKind, LIMITS.sourceName, sameSession),
      repos: strings(sources.repos, LIMITS.sourcesPerKind, LIMITS.sourceName, (a, b) => a.toLowerCase() === b.toLowerCase()),
    },
    createdAt,
    updatedAt: stamp(raw.updatedAt, createdAt),
  };
}

/** Repairs a parsed projects.json: drops unusable entries, fills defaults, makes ids unique. */
export function normaliseProjectsFile(raw: unknown): ProjectsFile {
  const source = isObject(raw) ? raw : {};
  const taken = new Set<string>();
  const projects: Project[] = [];
  for (const p of list(source.projects as unknown[])) {
    if (projects.length >= LIMITS.projects) break;
    const project = normaliseProject(p, taken);
    if (project) projects.push(project);
  }
  return { projects, hidden: strings(source.hidden, LIMITS.hidden, LIMITS.sourceName, sameSession) };
}

// ---- seeding and state ----

/**
 * First-run registry: one active project per Claude session name with more than 60 minutes in the
 * last 30 days (area work, sources.sessions = [name]); everything else stays untracked. Pure.
 * Busiest first, so the busiest name gets the plain slug when two names slug the same.
 */
export function seedProjectsFile(snapshot: Snapshot, now: Date): ProjectsFile {
  const from = windowStart(now, SEED_WINDOW_DAYS);
  const at = now.toISOString();
  const candidates: { name: string; minutes: number }[] = [];
  for (const s of list(snapshot?.work?.sessionTime)) {
    const name = typeof s?.project === "string" ? s.project.trim() : "";
    if (name === "" || name.length > LIMITS.sourceName) continue;
    const minutes = sumFrom(s.minutesByDay, from);
    const existing = candidates.find((c) => sameSession(c.name, name));
    if (existing) existing.minutes += minutes;
    else candidates.push({ name, minutes });
  }
  const taken = new Set<string>();
  const projects: Project[] = candidates
    .filter((c) => c.minutes > SEED_MIN_MINUTES)
    .sort((a, b) => b.minutes - a.minutes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, LIMITS.projects)
    .map((c) => {
      const id = uniqueId(slugify(c.name), taken);
      taken.add(id);
      return {
        id,
        name: [...c.name].slice(0, LIMITS.name).join(""),
        area: "work",
        status: "active",
        deadline: null,
        description: "",
        goals: [],
        tasks: [],
        sources: { sessions: [c.name], repos: [] },
        createdAt: at,
        updatedAt: at,
      };
    });
  return { projects, hidden: [] };
}

function noteTime(note: NoteMeta): number {
  const updated = Date.parse(note.updated);
  return Number.isFinite(updated) ? updated : Date.parse(note.created);
}

function statsFor(project: Project, snapshot: Snapshot, notes: readonly NoteMeta[]): ProjectStats {
  const minutesByDay: Record<string, number> = {};
  const commitsByDay: Record<string, number> = {};
  for (const s of list(snapshot?.work?.sessionTime)) {
    if (typeof s?.project === "string" && project.sources.sessions.some((src) => sameSession(src, s.project))) {
      addInto(minutesByDay, s.minutesByDay);
    }
  }
  for (const r of list(snapshot?.work?.repoActivity)) {
    if (typeof r?.repo === "string" && project.sources.repos.some((src) => sameRepo(src, r.repo))) {
      addInto(commitsByDay, r.commitsByDay);
    }
  }
  let noteCount = 0;
  let lastNote: NoteMeta | null = null;
  for (const note of notes) {
    if (note?.projectId !== project.id) continue;
    noteCount++;
    const t = noteTime(note);
    if (Number.isFinite(t) && (lastNote === null || t > noteTime(lastNote))) lastNote = note;
  }
  const doneTasks = project.tasks.filter((t) => t.done).length;
  return {
    id: project.id,
    minutesByDay,
    commitsByDay,
    openTasks: project.tasks.length - doneTasks,
    doneTasks,
    noteCount,
    lastNoteAt: lastNote ? (Number.isFinite(Date.parse(lastNote.updated)) ? lastNote.updated : lastNote.created) : null,
  };
}

function compareDetected(a: DetectedProject, b: DetectedProject): number {
  if (a.minutes7d !== b.minutes7d) return b.minutes7d - a.minutes7d;
  if (a.commits30d !== b.commits30d) return b.commits30d - a.commits30d;
  const la = a.lastSeen ?? "";
  const lb = b.lastSeen ?? "";
  if (la !== lb) return la < lb ? 1 : -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function untrackedFor(file: ProjectsFile, snapshot: Snapshot, now: Date): DetectedProject[] {
  const from90 = windowStart(now, UNTRACKED_WINDOW_DAYS);
  const from30 = windowStart(now, 30);
  const from7 = windowStart(now, 7);
  const out: DetectedProject[] = [];
  const keep = (name: string, kind: DetectedProject["kind"]) =>
    name !== "" && !isHiddenName(name, file.hidden) && !projectClaiming(file, kind, name) &&
    !out.some((d) => d.kind === kind && sameSession(d.name, name));

  for (const s of list(snapshot?.work?.sessionTime)) {
    const name = typeof s?.project === "string" ? s.project.trim() : "";
    if (!keep(name, "session") || sumFrom(s.minutesByDay, from90) <= 0) continue;
    out.push({ name, kind: "session", minutes7d: Math.round(sumFrom(s.minutesByDay, from7)), commits30d: 0, lastSeen: lastActiveDay(s.minutesByDay) });
  }
  for (const r of list(snapshot?.work?.repoActivity)) {
    const name = typeof r?.repo === "string" ? r.repo.trim() : "";
    if (!keep(name, "repo") || sumFrom(r.commitsByDay, from90) <= 0) continue;
    out.push({ name, kind: "repo", minutes7d: 0, commits30d: Math.round(sumFrom(r.commitsByDay, from30)), lastSeen: lastActiveDay(r.commitsByDay) });
  }
  return out.sort(compareDetected);
}

/**
 * The ProjectsState sent to the web app (Snapshot.projects and every /api/projects answer). Pure.
 * stats: per project, summed over its sources (sessionTime and repoActivity from `snapshot`) plus
 * task counts and note stats from `notes` (every note, not only recent ones, matched by projectId).
 * untracked: detected names active in the last 90 days, in no project's sources and not hidden,
 * sorted by minutes7d, then commits30d (then most recent, then name).
 */
export function computeProjectsState(file: ProjectsFile, snapshot: Snapshot, notes: NoteMeta[], now: Date): ProjectsState {
  const projects = list(file?.projects);
  const safe: ProjectsFile = { projects, hidden: list(file?.hidden) };
  const allNotes = list(notes);
  return {
    projects,
    stats: projects.map((p) => statsFor(p, snapshot, allNotes)),
    untracked: untrackedFor(safe, snapshot, now),
    hidden: [...safe.hidden],
  };
}
