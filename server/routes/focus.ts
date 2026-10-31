import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { FocusItem, FocusState, JiraIssue, Snapshot } from "../../shared/types";
import { resolveClaudeCommand, type ProcessRunner } from "../ai/nextMoves";
import { createTaskSteps, STEPS_RUN_DIR, type StepsTaskInput, type StepsView, type TaskStepsService } from "../ai/taskSteps";
import { jiraSites } from "../collectors/jira";
import { config } from "../config";
import { CONNECTORS_FILE, normaliseConnectorsCache } from "../connectors/validate";
import { jiraKeyOf, pickFocus, projectNameOf, type FocusPick } from "../focus";
import type { NotesStore } from "../notes";
import { taskNotes } from "../schedule";
import type { SnapshotService } from "../snapshot";
import type { Store } from "../store";

// /api/focus: the Do now panel (docs/ARCHITECTURE.md "v1.3", ticket T31).
//
// Mounted by app.ts after its guards (Host, Origin, Sec-Fetch-Site, no-store, 16 KB bodies). Errors
// are HTTPException 400, 404 or 409 with a plain message; app.ts answers them as ApiError.
//
// GET  /         FocusState: at most 6 open tasks to do now (server/focus.ts) with cached steps. Never
//                waits for AI: missing steps read "pending", and one background run (single-flight)
//                starts for the first 3 tasks that are missing them.
// POST /steps    { path, force? } -> FocusItem: runs for that task and waits. Cached steps are
//                returned without a run unless force. 404 when the path is not a Do now task, 409
//                while a run is going.

export interface FocusRoutesDeps {
  notes: NotesStore;
  store: Store;
  snapshots: Pick<SnapshotService, "get" | "refresh" | "refreshLocal">;
  now: () => Date;
  log: (line: string) => void;
  /** Starts `claude` for the steps run. Default: spawnRunner. Tests pass a fake so the real CLI never runs. */
  stepsRunner?: ProcessRunner;
}

const MAX_PATH_CHARS = 1024;
const badRequest = (message: string) => new HTTPException(400, { message });

async function readObject(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw badRequest("Send the body as JSON with Content-Type: application/json");
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw badRequest("Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Body must be a JSON object");
  return value as Record<string, unknown>;
}

type FocusInput = StepsTaskInput & { projectName: string | null; jiraKey: string | null };

interface Focus {
  at: Date;
  picks: FocusPick[];
  /** Per task path: what the steps prompt needs, plus the project name and Jira key shown. */
  inputs: Map<string, FocusInput>;
}

function toItem(pick: FocusPick, input: FocusInput, view: StepsView): FocusItem {
  const item: FocusItem = {
    task: pick.task,
    reason: pick.reason,
    label: pick.label,
    projectName: input.projectName,
    jiraKey: input.jiraKey,
    steps: view.steps,
    stepsStatus: view.status,
  };
  if (view.message) item.stepsMessage = view.message;
  return item;
}

/** Routes, relative to /api/focus. */
export function focusRoutes(deps: FocusRoutesDeps): Hono {
  const { notes, store, snapshots, now, log } = deps;
  const steps: TaskStepsService = createTaskSteps({
    store,
    runDir: store.pathOf(STEPS_RUN_DIR),
    runner: deps.stepsRunner,
    command: resolveClaudeCommand(config.home),
    now,
    log,
  });
  const router = new Hono();

  /** Jira issues from the connector cache, then the snapshot (the REST collector when it is set up). */
  async function jiraIssues(snapshot: Snapshot): Promise<JiraIssue[]> {
    const raw = await store.read<unknown>(CONNECTORS_FILE, null);
    const cache = normaliseConnectorsCache(raw, { sites: jiraSites(config.jira.site) });
    return [...cache.jira.items, ...snapshot.work.jira];
  }

  async function bodyOf(path: string): Promise<string> {
    try {
      return (await notes.read(path)).body;
    } catch {
      // Deleted or moved since the index was read: no body, no Jira key from it.
      return "";
    }
  }

  async function load(): Promise<Focus> {
    const at = now();
    const snapshot = snapshots.get(at);
    const index = await notes.index();
    const picks = pickFocus(taskNotes(index.notes), at);
    const inputs: Focus["inputs"] = new Map();
    if (picks.length === 0) return { at, picks, inputs };
    const projects = snapshot.projects.projects;
    const issues = await jiraIssues(snapshot);
    for (const pick of picks) {
      const body = await bodyOf(pick.task.path);
      const jiraKey = jiraKeyOf(pick.task.title, body);
      inputs.set(pick.task.path, {
        task: pick.task,
        body,
        project: projects.find((p) => p.id === pick.task.projectId) ?? null,
        projectName: projectNameOf(projects, pick.task.projectId),
        jira: jiraKey === null ? null : (issues.find((i) => i.key === jiraKey) ?? null),
        jiraKey,
      });
    }
    return { at, picks, inputs };
  }

  router.get("/", async (c) => {
    const focus = await load();
    const views = await steps.views([...focus.inputs.values()]);
    const missing = focus.picks.filter((p) => views.get(p.task.path)?.status === "pending").map((p) => focus.inputs.get(p.task.path)!);
    steps.fill(missing);
    const items = focus.picks.map((p) => toItem(p, focus.inputs.get(p.task.path)!, views.get(p.task.path)!));
    return c.json({ generatedAt: focus.at.toISOString(), items } satisfies FocusState);
  });

  router.post("/steps", async (c) => {
    const body = await readObject(c);
    const path = body.path;
    if (typeof path !== "string" || path === "" || path.length > MAX_PATH_CHARS) throw badRequest("path must be the task note path");
    if (body.force !== undefined && typeof body.force !== "boolean") throw badRequest("force must be true or false");
    const focus = await load();
    const pick = focus.picks.find((p) => p.task.path === path);
    if (!pick) throw new HTTPException(404, { message: "That task is not in Do now" });
    const input = focus.inputs.get(path)!;
    if (body.force !== true) {
      const cached = (await steps.views([input])).get(path)!;
      if (cached.status === "ready") return c.json(toItem(pick, input, cached));
    }
    // generate() refuses with 409 while a run (a background fill or another POST) is going.
    const view = await steps.generate(input);
    return c.json(toItem(pick, input, view));
  });

  return router;
}
