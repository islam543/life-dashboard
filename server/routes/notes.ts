import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseNewNoteInput, parseNotePatch, type NotesStore } from "../notes";
import type { SnapshotService } from "../snapshot";

// /api/notes router (docs/ARCHITECTURE.md "API additions").
//
// How it is mounted: app.ts calls `app.route("/api/notes", notesRoutes(deps))` after its guards,
// so every route here already has the Host check, the Origin and Sec-Fetch-Site check on writes and
// Cache-Control: no-store. The body limit on /api/notes* is 512 KB (not 16 KB) so a 200 KB note
// fits after JSON escaping; the 200 KB note body limit is enforced by parseNewNoteInput and
// parseNotePatch (413). No CORS, no onError here (errors must reach app.ts), paths stay relative.
//
// Conventions:
// - Errors: `throw new HTTPException(400 | 404 | 409 | 413, { message })` from here or from the
//   store; app.ts sends it as an ApiError with that status. Any other thrown error is a logged 500.
// - JSON bodies: Content-Type application/json required, same error words as app.ts.
// - The note or section path comes from the `path` query parameter, already percent-decoded once
//   by Hono and never decoded again; the store checks it (text and real path) before any disk access.
// - After every successful write: `await deps.snapshots.refreshLocal()` so snapshot.notes,
//   project note stats and needs-you pick up the change. It never rejects.

export interface NotesRoutesDeps {
  /** The one notes store (createNotesStore(config.notesDir) in production, a temp dir in tests). */
  notes: NotesStore;
  snapshots: Pick<SnapshotService, "refreshLocal">;
  now: () => Date;
  log: (line: string) => void;
}

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

function text(body: Record<string, unknown>, key: string, fallback?: string): string {
  const value = body[key] ?? fallback;
  if (typeof value !== "string") throw badRequest(`${key} must be text`);
  return value;
}

function pathQuery(c: Context): string {
  const value = c.req.query("path");
  if (value === undefined || value === "") throw badRequest("Add ?path= with the note or section path");
  return value;
}

/** Routes, relative to /api/notes. */
export function notesRoutes(deps: NotesRoutesDeps): Hono {
  const { notes, snapshots } = deps;
  const router = new Hono();

  /** Refreshes snapshot.notes after a successful write, then answers with the write's result. */
  async function written<T>(result: T): Promise<T> {
    await snapshots.refreshLocal();
    return result;
  }

  // NotesIndex
  router.get("/", async (c) => c.json(await notes.index()));

  // { section, title, body?, projectId?, tags?, template? } -> Note
  router.post("/", async (c) => {
    const input = parseNewNoteInput(await readJson(c));
    return c.json(await written(await notes.create(input)));
  });

  // ?path= -> Note
  router.get("/file", async (c) => c.json(await notes.read(pathQuery(c))));

  // ?path=, any of title, body, projectId, tags -> Note
  router.put("/file", async (c) => {
    const path = pathQuery(c);
    const patch = parseNotePatch(await readJson(c));
    return c.json(await written(await notes.update(path, patch)));
  });

  // ?path= -> NotesIndex (the note is moved to .trash)
  router.delete("/file", async (c) => c.json(await written(await notes.remove(pathQuery(c)))));

  // { parent, name } -> NotesIndex ("" or a missing parent means top level)
  router.post("/sections", async (c) => {
    const body = await readObject(c);
    return c.json(await written(await notes.createSection(text(body, "parent", ""), text(body, "name"))));
  });

  // { path, name } -> NotesIndex (rename in place)
  router.patch("/sections", async (c) => {
    const body = await readObject(c);
    return c.json(await written(await notes.renameSection(text(body, "path"), text(body, "name"))));
  });

  // ?path= -> NotesIndex (409 when the section is not empty)
  router.delete("/sections", async (c) => c.json(await written(await notes.removeSection(pathQuery(c)))));

  return router;
}
