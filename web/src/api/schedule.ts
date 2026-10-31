import type { NewTaskInput, PlanRequest, ScheduleRange, SchedulePlan, TaskNote, TaskPatch } from "../../../shared/types";
import { ApiRequestError } from "../api";
import { jsonRequest } from "./projects";

// Typed client for /api/schedule (docs/ARCHITECTURE.md "v1.2", Schedule API, and "v1.3"). Every call
// resolves with the parsed JSON or throws ApiRequestError (from ../api) carrying the server's ApiError
// message and HTTP status: 400 bad input (a range over 14 days, a bad time), 404 task note gone, 409 a
// plan run already going, 501 while the server has no schedule yet (ticket T27), status 0 with
// `offline` when the server is down. Use errorMessage() and isOffline() from ../api, and notReady() below.
//
// Task paths are note paths relative to NOTES_DIR exactly as the server sent them in TaskNote.path;
// pass them back unchanged (this client does the URL encoding).
//
// The end of this file is a tiny in-page channel between the Home panels that show tasks (Schedule
// and Do now): one says when it changed a task so the other re-reads, and Do now can ask Schedule to
// plan the day or open its Add task form.

const q = encodeURIComponent;

export const scheduleApi = {
  /** GET /api/schedule?from=&to= (YYYY-MM-DD, at most 14 days): meetings and tasks per day. */
  range: (from: string, to: string, signal?: AbortSignal) =>
    jsonRequest<ScheduleRange>("GET", `/api/schedule?from=${q(from)}&to=${q(to)}`, { signal }),
  /** POST /api/schedule/tasks: writes a task note in the Tasks section and answers it (201). */
  createTask: (input: NewTaskInput) => jsonRequest<TaskNote>("POST", "/api/schedule/tasks", { body: input }),
  /** PATCH /api/schedule/tasks?path=: only the given fields change (done, due, start, ...). */
  updateTask: (path: string, patch: TaskPatch) =>
    jsonRequest<TaskNote>("PATCH", `/api/schedule/tasks?path=${q(path)}`, { body: patch }),
  /** GET /api/schedule/plan: the last AI proposal (status none when there is nothing to review). */
  plan: (signal?: AbortSignal) => jsonRequest<SchedulePlan>("GET", "/api/schedule/plan", { signal }),
  /**
   * POST /api/schedule/plan: runs Claude and waits for it (about 30 to 60 s). `date` is the day the
   * panel shows: "day" plans that date, "week" the 7 days from it.
   */
  runPlan: (request: PlanRequest, signal?: AbortSignal) =>
    jsonRequest<SchedulePlan>("POST", "/api/schedule/plan", { body: request, signal }),
  /**
   * POST /api/schedule/plan/accept: items without a taskPath become task notes, items with one move
   * that task (due, start, minutes). Both leave the plan; `created` holds every task the server wrote,
   * new and moved. `message` says what was skipped (a moved task's note that no longer exists).
   */
  acceptPlan: (ids: readonly string[]) =>
    jsonRequest<{ created: TaskNote[]; message?: string }>("POST", "/api/schedule/plan/accept", { body: { ids } }),
  /** DELETE /api/schedule/plan: drops the proposal (answers status none). */
  dismissPlan: () => jsonRequest<SchedulePlan>("DELETE", "/api/schedule/plan"),
};

/**
 * True when the dashboard server has no schedule yet: 501 from the stub before T27 lands, or 404
 * from a server build older than v1.2. The panel then shows "Schedule server not ready".
 */
export function notReady(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 501 || err.status === 404);
}

// ---------------------------------------------------------------------------------------------
// Between panels
// ---------------------------------------------------------------------------------------------

/** Which panel changed a task, so it can skip its own notice. */
export type TaskSource = "schedule" | "focus";

const changeListeners = new Set<(source: TaskSource) => void>();

/** Tell the other task panels that a task was written (done, moved, added, a plan accepted). */
export function tasksChanged(source: TaskSource): void {
  for (const listener of [...changeListeners]) listener(source);
}

/** Listen for task writes from any panel. Returns the unsubscribe function. */
export function onTasksChanged(listener: (source: TaskSource) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** What Do now can ask the Schedule panel to do: plan today, or open Add task on today. */
export type ScheduleCommand = "plan-day" | "add-task";

const commandListeners = new Set<(command: ScheduleCommand) => void>();

/** Ask the Schedule panel to act. False when no Schedule panel is listening (another view, not loaded). */
export function sendScheduleCommand(command: ScheduleCommand): boolean {
  if (commandListeners.size === 0) return false;
  for (const listener of [...commandListeners]) listener(command);
  return true;
}

/** The Schedule panel's side of sendScheduleCommand. Returns the unsubscribe function. */
export function onScheduleCommand(listener: (command: ScheduleCommand) => void): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}
