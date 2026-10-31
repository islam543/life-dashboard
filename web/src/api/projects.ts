import type { ApiError, Project, ProjectArea, ProjectsState, ProjectStatus, ProjectTask } from "../../../shared/types";
import { ApiRequestError, OFFLINE_MESSAGE } from "../api";

// Typed client for /api/projects (docs/ARCHITECTURE.md "API additions"). Every call resolves with
// the parsed JSON or throws ApiRequestError (from ../api) carrying the server's ApiError message
// and HTTP status: 400 bad input, 404 project or task gone (deleted elsewhere), 409 a source name
// already claimed by another project, status 0 with `offline` when the server is down. Use
// errorMessage() and isOffline() from ../api to show it. Every write answers the fresh
// ProjectsState; the snapshot (needs-you, charts) catches up on its next read, so call
// useSnapshot().refresh() after a write when a Home panel must reflect it right away.

/** Body of POST /api/projects. */
export interface NewProjectInput {
  name: string;
  area: ProjectArea;
  status?: ProjectStatus;
  /** YYYY-MM-DD or null. */
  deadline?: string | null;
  description?: string;
  goals?: string[];
  sources?: Project["sources"];
}

/** Body of PATCH /api/projects/:id. Only the given fields change. */
export type ProjectPatch = Partial<Pick<Project, "name" | "area" | "status" | "deadline" | "description" | "goals" | "sources">>;

/** Body of POST /api/projects/:id/tasks. */
export interface NewTaskInput {
  text: string;
  /** YYYY-MM-DD or null. */
  due?: string | null;
}

/** Body of PATCH /api/projects/:id/tasks/:taskId. Only the given fields change. */
export type TaskPatch = Partial<Pick<ProjectTask, "text" | "done" | "due">>;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && typeof (value as ApiError).error === "string";
}

/**
 * One JSON request, same rules as request() in ../api.ts: same origin, JSON in and out, the
 * server's ApiError message on failure, `offline` when the server (or the dev proxy) cannot reach
 * the API. Shared with ./notes.ts.
 */
export async function jsonRequest<T>(
  method: Method,
  path: string,
  opts: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(OFFLINE_MESSAGE, 0, true);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    if (isApiError(body)) throw new ApiRequestError(body.error, res.status, false);
    // No ApiError body: the dev proxy answered because the API server is down.
    const offline = res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
    throw new ApiRequestError(offline ? OFFLINE_MESSAGE : `The server answered ${res.status}.`, res.status, offline);
  }
  if (body === null) throw new ApiRequestError("The server sent an empty or unreadable answer.", res.status, false);
  return body as T;
}

const seg = encodeURIComponent;

export const projectsApi = {
  /** GET /api/projects */
  list: (signal?: AbortSignal) => jsonRequest<ProjectsState>("GET", "/api/projects", { signal }),
  /** POST /api/projects. The id is a slug of the name, suffixed -2 on a clash. */
  create: (input: NewProjectInput) => jsonRequest<ProjectsState>("POST", "/api/projects", { body: input }),
  /** PATCH /api/projects/:id */
  update: (id: string, patch: ProjectPatch) =>
    jsonRequest<ProjectsState>("PATCH", `/api/projects/${seg(id)}`, { body: patch }),
  /** DELETE /api/projects/:id. Its sources go back to untracked; linked notes keep their files. */
  remove: (id: string) => jsonRequest<ProjectsState>("DELETE", `/api/projects/${seg(id)}`),
  /** POST /api/projects/:id/tasks */
  addTask: (id: string, input: NewTaskInput) =>
    jsonRequest<ProjectsState>("POST", `/api/projects/${seg(id)}/tasks`, { body: input }),
  /** PATCH /api/projects/:id/tasks/:taskId */
  updateTask: (id: string, taskId: string, patch: TaskPatch) =>
    jsonRequest<ProjectsState>("PATCH", `/api/projects/${seg(id)}/tasks/${seg(taskId)}`, { body: patch }),
  /** DELETE /api/projects/:id/tasks/:taskId */
  removeTask: (id: string, taskId: string) =>
    jsonRequest<ProjectsState>("DELETE", `/api/projects/${seg(id)}/tasks/${seg(taskId)}`),
  /** POST /api/projects/hide: an auto-detected session or repo name leaves untracked and the charts. */
  hide: (name: string) => jsonRequest<ProjectsState>("POST", "/api/projects/hide", { body: { name } }),
  /** POST /api/projects/unhide */
  unhide: (name: string) => jsonRequest<ProjectsState>("POST", "/api/projects/unhide", { body: { name } }),
};
