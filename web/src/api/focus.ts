import type { FocusItem, FocusState } from "../../../shared/types";
import { jsonRequest } from "./projects";

// Typed client for /api/focus (docs/ARCHITECTURE.md "v1.3", Do now). Every call resolves with the
// parsed JSON or throws ApiRequestError (from ../api) carrying the server's ApiError message and HTTP
// status: 404 an unknown task path (or the whole route on a server older than v1.3), 409 a steps run
// already going, 501 while the server has no Do now yet (ticket T31), status 0 with `offline` when the
// server is down. Use errorMessage() from ../api, and notReady() from ./schedule for 501 and 404.
//
// Task paths are note paths exactly as the server sent them in FocusItem.task.path; pass them back
// unchanged.

export const focusApi = {
  /**
   * GET /api/focus: at most 6 items, most urgent first, with cached steps only. Never waits for AI:
   * missing steps come back as stepsStatus "pending" while the server writes them in the background.
   */
  get: (signal?: AbortSignal) => jsonRequest<FocusState>("GET", "/api/focus", { signal }),
  /** POST /api/focus/steps: writes the steps for one task and waits for the AI run. `force` rewrites cached ones. */
  steps: (path: string, force = false, signal?: AbortSignal) =>
    jsonRequest<FocusItem>("POST", "/api/focus/steps", { body: force ? { path, force: true } : { path }, signal }),
};
