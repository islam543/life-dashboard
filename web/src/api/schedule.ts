import type { NewTaskInput, ScheduleRange, SchedulePlan, TaskNote, TaskPatch } from "../../../shared/types";
import { ApiRequestError } from "../api";
import { jsonRequest } from "./projects";

// Typed client for /api/schedule (docs/ARCHITECTURE.md "v1.2", Schedule API). Every call resolves
// with the parsed JSON or throws ApiRequestError (from ../api) carrying the server's ApiError message
// and HTTP status: 400 bad input (a range over 14 days, a bad time), 404 task note gone, 409 a plan
// run already going, 501 while the server has no schedule yet (ticket T27), status 0 with `offline`
// when the server is down. Use errorMessage() and isOffline() from ../api, and notReady() below.
//
// Task paths are note paths relative to NOTES_DIR exactly as the server sent them in TaskNote.path;
// pass them back unchanged (this client does the URL encoding).

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
  /** POST /api/schedule/plan: runs Claude and waits for it (about 30 to 60 s). */
  runPlan: (scope: "day" | "week", signal?: AbortSignal) =>
    jsonRequest<SchedulePlan>("POST", "/api/schedule/plan", { body: { scope }, signal }),
  /** POST /api/schedule/plan/accept: the chosen items become task notes and leave the plan. */
  acceptPlan: (ids: readonly string[]) =>
    jsonRequest<{ created: TaskNote[] }>("POST", "/api/schedule/plan/accept", { body: { ids } }),
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
