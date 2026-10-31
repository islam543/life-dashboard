import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { NextMove, PlanItem } from "../../shared/types";
import { emptyNextMovesFile, resolveClaudeCommand, type ProcessRunner } from "../ai/nextMoves";
import { isNextMovesFile } from "../ai/validate";
import { createSchedulePlan, PLAN_RUN_DIR, type PlanData, type SchedulePlanService } from "../ai/schedulePlan";
import { config } from "../config";
import type { NotesStore } from "../notes";
import { buildScheduleRange, createTask, parseNewTaskInput, parseRangeQuery, parseTaskPatch, patchTask, taskNotes } from "../schedule";
import type { SnapshotService } from "../snapshot";
import { FILES, type Store } from "../store";

// /api/schedule: tasks (notes in the Tasks section), meetings from the calendar connector, and the
// AI day or week plan. Contract: shared/types.ts "v1.2", API table in docs/ARCHITECTURE.md "v1.2".
//
// Mounted by app.ts after its guards (Host, Origin, Sec-Fetch-Site, no-store, 16 KB bodies). Errors
// are HTTPException 400, 404, 409 or 413 with a plain message; app.ts answers them as ApiError.
// After every write that touches notes: `await deps.snapshots.refreshLocal()` (never rejects).
//
// GET    /?from=YYYY-MM-DD&to=YYYY-MM-DD   ScheduleRange (at most 14 days)
// POST   /tasks                            NewTaskInput -> TaskNote (201)
// PATCH  /tasks?path=<note path>           TaskPatch -> TaskNote
// GET    /plan                             SchedulePlan
// POST   /plan                             { scope: "day" | "week" } -> SchedulePlan (waits for the run)
// POST   /plan/accept                      { ids: string[] } -> { created: TaskNote[] }
// DELETE /plan                             SchedulePlan (status none)

export interface ScheduleRoutesDeps {
  notes: NotesStore;
  store: Store;
  snapshots: Pick<SnapshotService, "get" | "refresh" | "refreshLocal">;
  now: () => Date;
  log: (line: string) => void;
  /** Starts `claude` for the plan run. Default: spawnRunner. Tests pass a fake so the real CLI never runs. */
  planRunner?: ProcessRunner;
}

const MAX_ACCEPT_IDS = 50;
const badRequest = (message: string) => new HTTPException(400, { message });

async function readJson(c: Context): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw badRequest("Send the body as JSON with Content-Type: application/json");
  try {
    return await c.req.json();
  } catch {
    throw badRequest("Body is not valid JSON");
  }
}

async function readObject(c: Context): Promise<Record<string, unknown>> {
  const value = await readJson(c);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Body must be a JSON object");
  return value as Record<string, unknown>;
}

function pathQuery(c: Context): string {
  const value = c.req.query("path");
  if (value === undefined || value === "") throw badRequest("Add ?path= with the task note path");
  return value;
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACCEPT_IDS) {
    throw badRequest(`ids must be a list of 1 to ${MAX_ACCEPT_IDS} plan item ids`);
  }
  if (!value.every((id) => typeof id === "string" && id !== "" && id.length <= 200)) throw badRequest("Each id must be a plan item id");
  return value as string[];
}

/** The plan service wired to the app's stores: snapshot meetings and projects, task notes, next moves. */
function defaultPlan(deps: ScheduleRoutesDeps): SchedulePlanService {
  const loadData = async (at: Date): Promise<PlanData> => {
    const snapshot = deps.snapshots.get(at);
    const index = await deps.notes.index();
    // Read without a guard so a bad file is only skipped here, never copied aside.
    const raw = await deps.store.read<unknown>(FILES.nextMoves, null);
    const moves: NextMove[] = isNextMovesFile(raw) ? raw.moves : emptyNextMovesFile().moves;
    return { events: snapshot.calendar, tasks: taskNotes(index.notes), projects: snapshot.projects.projects, moves };
  };
  const toTask = (item: PlanItem) =>
    createTask(
      deps.notes,
      { title: item.title, projectId: item.projectId, due: item.date, start: item.start, minutes: item.minutes, details: item.reason },
      "ai",
    );
  return createSchedulePlan({
    store: deps.store,
    runDir: deps.store.pathOf(PLAN_RUN_DIR),
    loadData,
    createTask: toTask,
    runner: deps.planRunner,
    command: resolveClaudeCommand(config.home),
    now: deps.now,
    log: deps.log,
  });
}

/** Routes, relative to /api/schedule. */
export function scheduleRoutes(deps: ScheduleRoutesDeps): Hono {
  const { notes, snapshots, now } = deps;
  const plan = defaultPlan(deps);
  const router = new Hono();

  router.get("/", async (c) => {
    const { from, to } = parseRangeQuery(c.req.query("from"), c.req.query("to"));
    const snapshot = snapshots.get(now());
    const index = await notes.index();
    return c.json(
      buildScheduleRange({ from, to, events: snapshot.calendar, tasks: taskNotes(index.notes), calendar: snapshot.sources.calendar }),
    );
  });

  router.post("/tasks", async (c) => {
    const input = parseNewTaskInput(await readJson(c));
    const task = await createTask(notes, input, "me");
    await snapshots.refreshLocal();
    return c.json(task, 201);
  });

  router.patch("/tasks", async (c) => {
    const path = pathQuery(c);
    const patch = parseTaskPatch(await readJson(c));
    const task = await patchTask(notes, path, patch);
    await snapshots.refreshLocal();
    return c.json(task);
  });

  router.get("/plan", async (c) => c.json(await plan.get()));

  router.post("/plan", async (c) => {
    const scope = (await readObject(c)).scope;
    if (scope !== "day" && scope !== "week") throw badRequest('scope must be "day" or "week"');
    return c.json(await plan.run(scope));
  });

  router.post("/plan/accept", async (c) => {
    const ids = parseIds((await readObject(c)).ids);
    const result = await plan.accept(ids);
    if (result.created.length > 0) await snapshots.refreshLocal();
    return c.json(result);
  });

  router.delete("/plan", async (c) => c.json(await plan.dismiss()));

  return router;
}
