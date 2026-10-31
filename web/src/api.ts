import type { ApiError, Checkin, NextMovesFile, Snapshot } from "../../shared/types";

// Typed fetch helpers for every route in server/app.ts. Same origin only: in dev, Vite proxies /api
// to 127.0.0.1:4317; in production the API server serves the built app itself.
// Panels should not call these directly for reads; use hooks/useSnapshot and hooks/useNextMoves,
// which share one copy of the data across the page.

/** A failed API call. `message` is the server's ApiError text when there is one. */
export class ApiRequestError extends Error {
  /** HTTP status, or 0 when the server could not be reached at all. */
  readonly status: number;
  /** True when the dashboard server is down or unreachable (not a validation or server bug). */
  readonly offline: boolean;

  constructor(message: string, status: number, offline: boolean) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.offline = offline;
  }
}

export const OFFLINE_MESSAGE = "Can't reach the dashboard server.";

/** A check-in as posted. `date` defaults to today on the server. */
export type CheckinInput = Omit<Checkin, "date"> & { date?: string };

/** Body of POST /api/next-moves/:id. */
export type MoveStateUpdate = "done" | "dismissed";

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && typeof (value as ApiError).error === "string";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", ...init.headers } });
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

function postJson<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    ...(payload === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  });
}

export const api = {
  /** GET /api/snapshot: the last saved snapshot. Cheap. */
  getSnapshot: (signal?: AbortSignal) => request<Snapshot>("/api/snapshot", { signal }),
  /** POST /api/refresh: runs every collector, then returns the new snapshot. Can take a while. */
  refresh: () => postJson<Snapshot>("/api/refresh"),
  /** GET /api/next-moves */
  getNextMoves: (signal?: AbortSignal) => request<NextMovesFile>("/api/next-moves", { signal }),
  /** POST /api/next-moves/run: answers 202 with status "running"; poll getNextMoves until it changes. */
  runNextMoves: () => postJson<NextMovesFile>("/api/next-moves/run"),
  /** POST /api/next-moves/:id with { state }. 404 when the id is unknown. */
  setMoveState: (id: string, state: MoveStateUpdate) =>
    postJson<NextMovesFile>(`/api/next-moves/${encodeURIComponent(id)}`, { state }),
  /** POST /api/checkin: validated on the server (400 with a message), returns the refreshed snapshot. */
  postCheckin: (checkin: CheckinInput) => postJson<Snapshot>("/api/checkin", checkin),
};

/** Plain message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

export function isOffline(err: unknown): boolean {
  return err instanceof ApiRequestError && err.offline;
}
