import type { NoteFields } from "../lib/notes";

// A copy of unsaved editor text in this browser, so a failed save, a closed tab or a crash never
// loses writing. One entry per note path. Written while the editor has changes the server has not
// accepted; removed once a save lands. Storage can be missing or full (private window, quota), so
// every call is wrapped and failure only means there is no backup, never a broken editor.

const PREFIX = "life-dashboard:note-draft:";

export interface Draft {
  fields: NoteFields;
  /** When the copy was written (ms since epoch). */
  at: number;
}

function isFields(value: unknown): value is NoteFields {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    (v.projectId === null || typeof v.projectId === "string") &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === "string")
  );
}

export function readDraft(path: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + path);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { fields, at } = parsed as { fields?: unknown; at?: unknown };
    if (!isFields(fields) || typeof at !== "number") return null;
    return { fields, at };
  } catch {
    return null;
  }
}

export function writeDraft(path: string, fields: NoteFields): void {
  try {
    window.localStorage.setItem(PREFIX + path, JSON.stringify({ fields, at: Date.now() } satisfies Draft));
  } catch {
    // No storage: the editor still works, there is just no local copy.
  }
}

export function removeDraft(path: string): void {
  try {
    window.localStorage.removeItem(PREFIX + path);
  } catch {
    // Nothing to clean up.
  }
}
