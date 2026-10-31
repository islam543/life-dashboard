import { HTTPException } from "hono/http-exception";
import type { DetectedAction, JiraCreated, JiraDraftIssue } from "../../shared/types";
import type { NotesStore } from "../notes";
import { detectActions, joinBody, splitBody } from "./actions";
import { WRITE_BACK_ID } from "./draft";

// Ticket T28: after a create, each created Task's key is appended to its action lines
// ("- [ ] Send slip (AN-4602)"), so the same action is never filed twice. Only through the notes
// store. The note must be exactly as it was when the create started: if it changed during the run
// (in Obsidian or the editor), nothing is written and the result tells Islam to add the keys by hand.

export interface WriteBackEdit {
  actionId: string;
  /** 1-based body line of the action. */
  line: number;
  key: string;
}

/** The lines to change: every action of every created Task. Epics are not written back. */
export function writeBackEdits(
  created: readonly JiraCreated[],
  issues: readonly JiraDraftIssue[],
  actions: readonly DetectedAction[],
): WriteBackEdit[] {
  const byDraft = new Map(issues.map((i) => [i.draftId, i] as const));
  const byId = new Map(actions.map((a) => [a.id, a] as const));
  const edits: WriteBackEdit[] = [];
  for (const c of created) {
    if (c.type !== "Task") continue;
    for (const actionId of byDraft.get(c.draftId)?.actionIds ?? []) {
      const action = byId.get(actionId);
      if (action) edits.push({ actionId, line: action.line, key: c.key });
    }
  }
  return edits.sort((a, b) => a.line - b.line);
}

/**
 * Pure: the body with " (KEY)" appended to each edited line, trailing spaces trimmed first.
 * Refuses when a line no longer holds the action it was detected as. Line endings are kept.
 */
export function appendKeys(body: string, edits: readonly WriteBackEdit[]): { ok: true; body: string } | { ok: false; error: string } {
  const parts = splitBody(body);
  const idAt = new Map(detectActions(body).map((a) => [a.line, a.id] as const));
  const keysByLine = new Map<number, string[]>();
  for (const edit of edits) {
    if (idAt.get(edit.line) !== edit.actionId) return { ok: false, error: `line ${edit.line} no longer holds its action` };
    const keys = keysByLine.get(edit.line) ?? [];
    if (!keys.includes(edit.key)) keys.push(edit.key);
    keysByLine.set(edit.line, keys);
  }
  for (const [line, keys] of keysByLine) {
    const i = line - 1;
    parts.lines[i] = `${(parts.lines[i] ?? "").trimEnd()} (${keys.join(", ")})`;
  }
  return { ok: true, body: joinBody(parts) };
}

export type WriteBackResult =
  | { status: "none" }
  | { status: "written"; lines: number }
  | { status: "conflict" }
  /** `reason` is shown to Islam and logged: a fixed label or a notes store message, never note text. */
  | { status: "error"; reason: string };

function reasonOf(err: unknown): string {
  return err instanceof HTTPException ? err.message : "the note could not be saved";
}

/**
 * Writes the keys into the note when its body still equals `baseBody` (read when the create
 * started). The notes store bumps `updated`, the mtime and its cache as on any save.
 */
export async function writeBack(
  notes: Pick<NotesStore, "read" | "update">,
  notePath: string,
  baseBody: string,
  edits: readonly WriteBackEdit[],
): Promise<WriteBackResult> {
  if (edits.length === 0) return { status: "none" };
  let current: string;
  try {
    current = (await notes.read(notePath)).body;
  } catch (err) {
    return { status: "error", reason: reasonOf(err) };
  }
  if (current !== baseBody) return { status: "conflict" };
  const next = appendKeys(baseBody, edits);
  if (!next.ok) return { status: "error", reason: next.error };
  try {
    await notes.update(notePath, { body: next.body });
  } catch (err) {
    return { status: "error", reason: reasonOf(err) };
  }
  return { status: "written", lines: new Set(edits.map((e) => e.line)).size };
}

/** The `failed` entry that tells Islam the keys are not in the note, or null when they are. */
export function writeBackFailure(result: WriteBackResult, edits: readonly WriteBackEdit[]): { draftId: string; error: string } | null {
  const keys = [...new Set(edits.map((e) => e.key))].join(", ");
  if (result.status === "conflict") {
    return { draftId: WRITE_BACK_ID, error: `Created in Jira, but the note changed; add the keys by hand: ${keys}` };
  }
  if (result.status === "error") {
    return { draftId: WRITE_BACK_ID, error: `Created in Jira, but the keys could not be added to the note (${result.reason}); add them by hand: ${keys}` };
  }
  return null;
}
