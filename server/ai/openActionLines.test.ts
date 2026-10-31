import { describe, expect, it } from "vitest";
import { normaliseSnapshot } from "../snapshot";
import { openActionLines } from "./nextMoves";

describe("openActionLines", () => {
  it("keeps unchecked, non-empty action lines and skips unreadable notes", async () => {
    const files: Record<string, string> = {
      "Meeting notes/a.md": "## Action items\r\n- [ ] Send the slip to Ahmed\n- [x] Done thing\n- [ ] \n* [ ] Book UAT slot",
      "Meeting notes/b.md": "No actions here",
    };
    const notes = {
      read: async (p: string) => {
        if (!(p in files)) throw new Error("gone");
        return { body: files[p] };
      },
    };
    const out = await openActionLines(notes, ["Meeting notes/a.md", "Meeting notes/b.md", "Meeting notes/missing.md"]);
    expect(out).toEqual({ "Meeting notes/a.md": ["Send the slip to Ahmed", "Book UAT slot"] });
  });
});

describe("normaliseSnapshot keeps v1.1 fields", () => {
  it("restores projects and recent notes from the saved file", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const projects = { projects: [], stats: [], untracked: [], hidden: ["x"] };
    const notes = { recent: [], status: "ok" };
    const snap = normaliseSnapshot({ projects, notes }, now);
    expect(snap.projects.hidden).toEqual(["x"]);
    expect(snap.notes.status).toBe("ok");
  });
});
