import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import type { JiraCreated, JiraDraftIssue, Note } from "../../shared/types";
import type { NotePatch } from "../notes";
import { detectActions } from "./actions";
import { appendKeys, writeBack, writeBackEdits, writeBackFailure, type WriteBackEdit } from "./writeBack";

const BODY = ["## Action items", "- [ ] Send the slip   ", "- Ask Sara for the export", "- [ ] Call the broker"].join("\n");
const actions = detectActions(BODY);
const [slip, sara, broker] = actions as [(typeof actions)[0], (typeof actions)[0], (typeof actions)[0]];

const created = (draftId: string, key: string, type: "Task" | "Epic" = "Task"): JiraCreated => ({ draftId, key, type, url: `https://x/browse/${key}` });
const issue = (draftId: string, actionIds: string[], type: "Task" | "Epic" = "Task"): JiraDraftIssue => ({
  draftId,
  actionIds,
  type,
  summary: "Summary text",
  description: "A description that is long enough.",
  parent: null,
});

describe("writeBackEdits", () => {
  it("takes every action of every created Task, never an Epic's", () => {
    const edits = writeBackEdits(
      [created("t1", "AN-1"), created("e1", "AN-2", "Epic"), created("t2", "AN-3")],
      [issue("t1", [broker.id, slip.id]), issue("e1", [sara.id], "Epic"), issue("t2", [sara.id]), issue("t9", [sara.id])],
      actions,
    );
    expect(edits).toEqual([
      { actionId: slip.id, line: 2, key: "AN-1" },
      { actionId: sara.id, line: 3, key: "AN-3" },
      { actionId: broker.id, line: 4, key: "AN-1" },
    ]);
  });
});

describe("appendKeys", () => {
  it("appends ' (KEY)' after trimming trailing spaces, other lines untouched", () => {
    const out = appendKeys(BODY, [
      { actionId: slip.id, line: 2, key: "AN-4602" },
      { actionId: sara.id, line: 3, key: "AN-4603" },
    ]);
    expect(out).toEqual({
      ok: true,
      body: ["## Action items", "- [ ] Send the slip (AN-4602)", "- Ask Sara for the export (AN-4603)", "- [ ] Call the broker"].join("\n"),
    });
    // The written lines are now filed, so they are never drafted again.
    if (out.ok) expect(detectActions(out.body).map((a) => a.jiraKey)).toEqual(["AN-4602", "AN-4603", null]);
  });

  it("keeps CRLF line endings", () => {
    const crlf = BODY.replace(/\n/g, "\r\n");
    const id = detectActions(crlf)[2]!.id;
    const out = appendKeys(crlf, [{ actionId: id, line: 4, key: "AN-1" }]);
    expect(out.ok && out.body).toBe(`${crlf} (AN-1)`);
  });

  it("refuses when a line no longer holds its action", () => {
    expect(appendKeys(BODY, [{ actionId: slip.id, line: 3, key: "AN-1" }])).toEqual({ ok: false, error: "line 3 no longer holds its action" });
    expect(appendKeys(BODY, [{ actionId: "act-gone", line: 2, key: "AN-1" }]).ok).toBe(false);
  });
});

function fakeNotes(body: string, opts: { update?: (path: string, patch: NotePatch) => Promise<Note>; read?: () => Promise<Note> } = {}) {
  const note = { path: "Meeting notes/n.md", body } as Note;
  const read = vi.fn(opts.read ?? (async () => ({ ...note })));
  const update = vi.fn(opts.update ?? (async (_p: string, patch: NotePatch) => ({ ...note, body: patch.body ?? note.body })));
  return { read, update };
}

const EDITS: WriteBackEdit[] = [{ actionId: slip.id, line: 2, key: "AN-4602" }];

describe("writeBack", () => {
  it("writes the keys through the notes store when the note is unchanged", async () => {
    const notes = fakeNotes(BODY);
    const out = await writeBack(notes, "Meeting notes/n.md", BODY, EDITS);
    expect(out).toEqual({ status: "written", lines: 1 });
    expect(notes.update).toHaveBeenCalledTimes(1);
    expect(notes.update.mock.calls[0]![0]).toBe("Meeting notes/n.md");
    expect(notes.update.mock.calls[0]![1]).toEqual({ body: BODY.replace("Send the slip   ", "Send the slip (AN-4602)") });
  });

  it("refuses on a version conflict and never writes", async () => {
    const notes = fakeNotes(`${BODY}\n- [ ] added in Obsidian during the run`);
    expect(await writeBack(notes, "Meeting notes/n.md", BODY, EDITS)).toEqual({ status: "conflict" });
    expect(notes.update).not.toHaveBeenCalled();
  });

  it("does nothing when no Task was created", async () => {
    const notes = fakeNotes(BODY);
    expect(await writeBack(notes, "Meeting notes/n.md", BODY, [])).toEqual({ status: "none" });
    expect(notes.read).not.toHaveBeenCalled();
  });

  it("reports a note that was deleted or could not be saved", async () => {
    const gone = fakeNotes(BODY, {
      read: async () => {
        throw new HTTPException(404, { message: "Note not found" });
      },
    });
    expect(await writeBack(gone, "Meeting notes/n.md", BODY, EDITS)).toEqual({ status: "error", reason: "Note not found" });
    const broken = fakeNotes(BODY, {
      update: async () => {
        throw new Error("EPERM C:\\secret\\path");
      },
    });
    expect(await writeBack(broken, "Meeting notes/n.md", BODY, EDITS)).toEqual({ status: "error", reason: "the note could not be saved" });
  });
});

describe("writeBackFailure", () => {
  it("tells Islam which keys to add by hand", () => {
    const edits = [...EDITS, { actionId: sara.id, line: 3, key: "AN-4603" }, { actionId: broker.id, line: 4, key: "AN-4602" }];
    expect(writeBackFailure({ status: "conflict" }, edits)).toEqual({
      draftId: "write-back",
      error: "Created in Jira, but the note changed; add the keys by hand: AN-4602, AN-4603",
    });
    expect(writeBackFailure({ status: "error", reason: "Note not found" }, edits)?.error).toMatch(/could not be added to the note \(Note not found\)/);
    expect(writeBackFailure({ status: "written", lines: 1 }, edits)).toBeNull();
    expect(writeBackFailure({ status: "none" }, [])).toBeNull();
  });
});
