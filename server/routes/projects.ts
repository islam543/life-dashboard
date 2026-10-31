import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Project, ProjectArea, ProjectsFile, ProjectStatus, ProjectTask } from "../../shared/types";
import {
  isDateKey,
  isHiddenName,
  LIMITS,
  loadProjectsFile,
  newTaskId,
  PROJECT_AREAS,
  PROJECT_STATUSES,
  projectClaiming,
  sameRepo,
  sameSession,
  saveProjectsFile,
  seedProjectsFile,
  slugify,
  uniqueId,
  withProjectsLock,
} from "../projects";
import type { SnapshotService } from "../snapshot";
import type { Store } from "../store";

// /api/projects router (docs/ARCHITECTURE.md "API additions").
//
// How it is mounted: app.ts calls `app.route("/api/projects", projectsRoutes(deps))` after its
// guards, so every route here already has the Host check, the Origin and Sec-Fetch-Site check on
// writes, Cache-Control: no-store and the 16 KB body limit. No CORS, no onError here (errors
// must reach app.ts), and paths stay relative ("/", "/:id").
//
// Conventions:
// - Errors: `throw new HTTPException(400 | 404 | 409, { message })`; app.ts sends it as an ApiError.
// - Every write runs read, change, save inside withProjectsLock (one promise chain per file), then
//   answers `(await deps.snapshots.refreshLocal()).projects`, so the snapshot, needs-you and this
//   answer agree.
// - Timestamps come from deps.now().

export interface ProjectsRoutesDeps {
  /** The data/ store. projects.json (PROJECTS_FILE in projects.ts) lives here. */
  store: Store;
  /** get(): the current snapshot (sessionTime, repoActivity, projects). refreshLocal(): see above. */
  snapshots: Pick<SnapshotService, "get" | "refreshLocal">;
  now: () => Date;
  log: (line: string) => void;
}

type Body = Record<string, unknown>;
type Sources = Project["sources"];

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (message: string) => new HTTPException(400, { message });
const length = (s: string) => [...s].length;

// Control characters are never valid in one-line fields; descriptions may keep tabs and newlines.
const CONTROL = /\p{Cc}/u;
const CONTROL_EXCEPT_NEWLINES = /[^\P{Cc}\t\n\r]/u;

async function readBody(c: Context): Promise<Body> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw bad("Send the body as JSON with Content-Type: application/json");
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw bad("Body is not valid JSON");
  }
  if (!isObject(value)) throw bad("Send a JSON object");
  return value;
}

/** One line of text, trimmed, `min` to `max` characters. */
function line(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw bad(`${field} must be text`);
  const text = value.trim();
  if (length(text) < min || length(text) > max) throw bad(`${field} must be ${min} to ${max} characters`);
  if (CONTROL.test(text)) throw bad(`${field} must be one line without control characters`);
  return text;
}

function area(value: unknown): ProjectArea {
  if (!PROJECT_AREAS.includes(value as ProjectArea)) throw bad(`area must be one of ${PROJECT_AREAS.join(", ")}`);
  return value as ProjectArea;
}

function status(value: unknown): ProjectStatus {
  if (!PROJECT_STATUSES.includes(value as ProjectStatus)) throw bad(`status must be one of ${PROJECT_STATUSES.join(", ")}`);
  return value as ProjectStatus;
}

/** YYYY-MM-DD, or null (an empty string also clears it). */
function date(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (!isDateKey(value)) throw bad(`${field} must be a date like 2026-11-30, or null`);
  return value;
}

function description(value: unknown): string {
  if (typeof value !== "string") throw bad("description must be text");
  const text = value.trim();
  if (length(text) > LIMITS.description) throw bad(`description must be at most ${LIMITS.description} characters`);
  if (CONTROL_EXCEPT_NEWLINES.test(text)) throw bad("description has control characters");
  return text;
}

/** Blank goals are dropped; then at most 10 of at most 200 characters. */
function goals(value: unknown): string[] {
  if (!Array.isArray(value)) throw bad("goals must be a list of text");
  const out = value
    .map((g) => {
      if (typeof g !== "string") throw bad("goals must be a list of text");
      return g.trim();
    })
    .filter((g) => g !== "")
    .map((g) => line(g, "Each goal", 1, LIMITS.goal));
  if (out.length > LIMITS.goals) throw bad(`goals can hold at most ${LIMITS.goals} items`);
  return out;
}

function names(value: unknown, field: string, same: (a: string, b: string) => boolean): string[] {
  if (!Array.isArray(value)) throw bad(`${field} must be a list of names`);
  const out: string[] = [];
  for (const item of value) {
    const name = line(item, `Each name in ${field}`, 1, LIMITS.sourceName);
    if (!out.some((o) => same(o, name))) out.push(name);
  }
  if (out.length > LIMITS.sourcesPerKind) throw bad(`${field} can hold at most ${LIMITS.sourcesPerKind} names`);
  return out;
}

/** `{ sessions?, repos? }`; a missing list keeps `current`. */
function sources(value: unknown, current: Sources): Sources {
  if (!isObject(value)) throw bad("sources must be an object like { sessions: [], repos: [] }");
  return {
    sessions: value.sessions === undefined ? current.sessions : names(value.sessions, "sources.sessions", sameSession),
    repos: value.repos === undefined ? current.repos : names(value.repos, "sources.repos", (a, b) => a.toLowerCase() === b.toLowerCase()),
  };
}

function requireSomeOf(body: Body, keys: readonly string[]): void {
  if (!keys.some((k) => body[k] !== undefined)) throw bad(`Send at least one of: ${keys.join(", ")}`);
}

// ---- registry changes (run inside the lock; throw 404 or 409) ----

function findProject(file: ProjectsFile, id: string): Project {
  const project = file.projects.find((p) => p.id === id);
  if (!project) throw new HTTPException(404, { message: "No project with that id" });
  return project;
}

function findTask(project: Project, taskId: string): ProjectTask {
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) throw new HTTPException(404, { message: "No task with that id in this project" });
  return task;
}

/** 409 when another project already holds one of these session or repo names. */
function assertSourcesFree(file: ProjectsFile, next: Sources, selfId: string | null): void {
  for (const [kind, list] of [["session", next.sessions], ["repo", next.repos]] as const) {
    for (const name of list) {
      const owner = projectClaiming(file, kind, name, selfId);
      if (owner) throw new HTTPException(409, { message: `"${name}" already belongs to the project "${owner.name}"` });
    }
  }
}

/** A name folded into a project is tracked now, so it leaves the hidden list. */
function unhideSources(file: ProjectsFile, next: Sources): void {
  file.hidden = file.hidden.filter(
    (h) => !next.sessions.some((s) => sameSession(s, h)) && !next.repos.some((r) => sameRepo(r, h)),
  );
}

/** Routes, relative to /api/projects. */
export function projectsRoutes(deps: ProjectsRoutesDeps): Hono {
  const router = new Hono();

  /** Missing file: seed it like snapshot.ts would once session time is known, else start empty. */
  function initialFile(at: Date): ProjectsFile {
    const snapshot = deps.snapshots.get(at);
    if (snapshot.sources.claudeSessions.status === "never_run") return { projects: [], hidden: [] };
    return seedProjectsFile(snapshot, at);
  }

  /** Read, change and save projects.json under the lock, then answer the fresh ProjectsState. */
  async function write(c: Context, change: (file: ProjectsFile, at: Date) => void | "unchanged") {
    await withProjectsLock(deps.store, async () => {
      const at = deps.now();
      const file = (await loadProjectsFile(deps.store)) ?? initialFile(at);
      if (change(file, at) !== "unchanged") await saveProjectsFile(deps.store, file);
    });
    const snap = await deps.snapshots.refreshLocal();
    return c.json(snap.projects);
  }

  router.get("/", async (c) => {
    // A fresh read, so hand edits to projects.json show up without waiting for a collector run.
    const snap = await deps.snapshots.refreshLocal();
    return c.json(snap.projects);
  });

  router.post("/", async (c) => {
    const body = await readBody(c);
    const name = line(body.name, "name", 1, LIMITS.name);
    const fields = {
      area: area(body.area),
      status: body.status === undefined ? ("active" as const) : status(body.status),
      deadline: body.deadline === undefined ? null : date(body.deadline, "deadline"),
      description: body.description === undefined ? "" : description(body.description),
      goals: body.goals === undefined ? [] : goals(body.goals),
      sources: body.sources === undefined ? { sessions: [], repos: [] } : sources(body.sources, { sessions: [], repos: [] }),
    };
    return write(c, (file, at) => {
      if (file.projects.length >= LIMITS.projects) throw bad(`There can be at most ${LIMITS.projects} projects`);
      assertSourcesFree(file, fields.sources, null);
      const id = uniqueId(slugify(name), new Set(file.projects.map((p) => p.id)));
      const stamp = at.toISOString();
      file.projects.push({ id, name, ...fields, tasks: [], createdAt: stamp, updatedAt: stamp });
      unhideSources(file, fields.sources);
    });
  });

  // "/hide" and "/unhide" are POST; "/:id" has no POST, so they never clash.
  router.post("/hide", async (c) => {
    const name = line((await readBody(c)).name, "name", 1, LIMITS.sourceName);
    return write(c, (file) => {
      const owner = projectClaiming(file, "session", name) ?? projectClaiming(file, "repo", name);
      if (owner) throw new HTTPException(409, { message: `"${name}" belongs to the project "${owner.name}". Remove it there first.` });
      if (isHiddenName(name, file.hidden)) return "unchanged";
      if (file.hidden.length >= LIMITS.hidden) throw bad(`At most ${LIMITS.hidden} names can be hidden`);
      file.hidden.push(name);
    });
  });

  router.post("/unhide", async (c) => {
    const name = line((await readBody(c)).name, "name", 1, LIMITS.sourceName);
    return write(c, (file) => {
      if (!isHiddenName(name, file.hidden)) throw new HTTPException(404, { message: `"${name}" is not hidden` });
      file.hidden = file.hidden.filter((h) => !sameSession(h, name));
    });
  });

  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c);
    requireSomeOf(body, ["name", "area", "status", "deadline", "description", "goals", "sources"]);
    const patch = {
      name: body.name === undefined ? undefined : line(body.name, "name", 1, LIMITS.name),
      area: body.area === undefined ? undefined : area(body.area),
      status: body.status === undefined ? undefined : status(body.status),
      deadline: body.deadline === undefined ? undefined : date(body.deadline, "deadline"),
      description: body.description === undefined ? undefined : description(body.description),
      goals: body.goals === undefined ? undefined : goals(body.goals),
    };
    // Shape check now (400 before 404); the merge with the stored lists happens under the lock.
    if (body.sources !== undefined) sources(body.sources, { sessions: [], repos: [] });
    return write(c, (file, at) => {
      const project = findProject(file, id);
      if (body.sources !== undefined) {
        const next = sources(body.sources, project.sources);
        assertSourcesFree(file, next, project.id);
        project.sources = next;
        unhideSources(file, next);
      }
      if (patch.name !== undefined) project.name = patch.name;
      if (patch.area !== undefined) project.area = patch.area;
      if (patch.status !== undefined) project.status = patch.status;
      if (patch.deadline !== undefined) project.deadline = patch.deadline;
      if (patch.description !== undefined) project.description = patch.description;
      if (patch.goals !== undefined) project.goals = patch.goals;
      project.updatedAt = at.toISOString();
    });
  });

  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    // Its sources stop being claimed, so they show up in untracked again (unless hidden).
    // Notes that link to it keep their projectId text.
    return write(c, (file) => {
      findProject(file, id);
      file.projects = file.projects.filter((p) => p.id !== id);
    });
  });

  router.post("/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const body = await readBody(c);
    const text = line(body.text, "text", 1, LIMITS.taskText);
    const due = body.due === undefined ? null : date(body.due, "due");
    return write(c, (file, at) => {
      const project = findProject(file, id);
      if (project.tasks.length >= LIMITS.tasksPerProject) throw bad(`A project can hold at most ${LIMITS.tasksPerProject} tasks`);
      const stamp = at.toISOString();
      const taskId = newTaskId(new Set(project.tasks.map((t) => t.id)));
      project.tasks.push({ id: taskId, text, done: false, due, doneAt: null, createdAt: stamp });
      project.updatedAt = stamp;
    });
  });

  router.patch("/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    const body = await readBody(c);
    requireSomeOf(body, ["text", "done", "due"]);
    const text = body.text === undefined ? undefined : line(body.text, "text", 1, LIMITS.taskText);
    if (body.done !== undefined && typeof body.done !== "boolean") throw bad("done must be true or false");
    const done = body.done as boolean | undefined;
    const due = body.due === undefined ? undefined : date(body.due, "due");
    return write(c, (file, at) => {
      const project = findProject(file, id);
      const task = findTask(project, taskId);
      const stamp = at.toISOString();
      if (text !== undefined) task.text = text;
      if (due !== undefined) task.due = due;
      if (done !== undefined && done !== task.done) {
        task.done = done;
        task.doneAt = done ? stamp : null;
      }
      project.updatedAt = stamp;
    });
  });

  router.delete("/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    return write(c, (file, at) => {
      const project = findProject(file, id);
      findTask(project, taskId);
      project.tasks = project.tasks.filter((t) => t.id !== taskId);
      project.updatedAt = at.toISOString();
    });
  });

  return router;
}
