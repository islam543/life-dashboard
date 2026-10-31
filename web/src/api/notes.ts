import type { Note, NotesIndex, NoteTemplate } from "../../../shared/types";
import { jsonRequest } from "./projects";

// Typed client for /api/notes (docs/ARCHITECTURE.md "API additions"). Every call resolves with
// the parsed JSON or throws ApiRequestError (from ../api) carrying the server's ApiError message
// and HTTP status: 400 bad input or unsafe path, 404 note or section gone (deleted or renamed in
// Obsidian), 409 section not empty or name taken, 413 note body over 200 KB, status 0 with
// `offline` when the server is down. Use errorMessage() and isOffline() from ../api to show it.
//
// Note paths are relative to NOTES_DIR, posix, exactly as the server sent them in NoteMeta.path
// or NoteSection.path; pass them back unchanged (this client does the URL encoding).

/** Body of POST /api/notes. */
export interface NewNoteInput {
  /** Section path, e.g. "Meeting notes" or "Meeting notes/FastBind". */
  section: string;
  title: string;
  /** Initial markdown; when missing the server uses the template's body. */
  body?: string;
  projectId?: string | null;
  tags?: string[];
  /** Default "blank". */
  template?: NoteTemplate;
}

/** Body of PUT /api/notes/file?path=. Only the given fields change; `updated` is bumped. */
export type NotePatch = Partial<Pick<Note, "title" | "body" | "projectId" | "tags">>;

const query = (path: string) => `?path=${encodeURIComponent(path)}`;

export const notesApi = {
  /** GET /api/notes: sections tree and every note's metadata. Check `status` (not_connected names the folder). */
  index: (signal?: AbortSignal) => jsonRequest<NotesIndex>("GET", "/api/notes", { signal }),
  /** GET /api/notes/file?path= */
  read: (path: string, signal?: AbortSignal) => jsonRequest<Note>("GET", `/api/notes/file${query(path)}`, { signal }),
  /** POST /api/notes: writes YYYY-MM-DD-<slug>.md in the section and answers the new note. */
  create: (input: NewNoteInput) => jsonRequest<Note>("POST", "/api/notes", { body: input }),
  /** PUT /api/notes/file?path=: saves the note (the path never changes, the title lives in frontmatter). */
  update: (path: string, patch: NotePatch) => jsonRequest<Note>("PUT", `/api/notes/file${query(path)}`, { body: patch }),
  /** DELETE /api/notes/file?path=: moves the file to NOTES_DIR/.trash. */
  remove: (path: string) => jsonRequest<NotesIndex>("DELETE", `/api/notes/file${query(path)}`),
  /** POST /api/notes/sections: new folder `name` inside `parent` ("" for top level). */
  createSection: (parent: string, name: string) =>
    jsonRequest<NotesIndex>("POST", "/api/notes/sections", { body: { parent, name } }),
  /** PATCH /api/notes/sections: renames the section folder at `path` to `name`. */
  renameSection: (path: string, name: string) =>
    jsonRequest<NotesIndex>("PATCH", "/api/notes/sections", { body: { path, name } }),
  /** DELETE /api/notes/sections?path=: only an empty section (409 otherwise). */
  removeSection: (path: string) => jsonRequest<NotesIndex>("DELETE", `/api/notes/sections${query(path)}`),
};
