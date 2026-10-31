import { describe, expect, it } from "vitest";
import type { NoteMeta, NoteSection } from "../../../shared/types";
import {
  addTag,
  ALL_NOTES,
  ancestorsOf,
  canDeleteSection,
  classifySaveError,
  countOpenTasks,
  defaultNewNoteSection,
  defaultTemplate,
  deleteBlockedReason,
  fieldsOf,
  findSection,
  formatNoteDate,
  initialCaret,
  isDirty,
  isRetryable,
  notePatch,
  notesIn,
  remapPath,
  retryDelayMs,
  sameContent,
  sectionCounts,
  sectionDepth,
  sortNotes,
  toggleTaskLine,
  treeKeyAction,
  typeAhead,
  validateBody,
  validateFields,
  validateSectionName,
  validateTitle,
  visibleRows,
  type NoteFields,
} from "./notes";

const section = (path: string, children: NoteSection[] = [], noteCount = 0): NoteSection => ({
  path,
  name: path.split("/").pop() ?? path,
  children,
  noteCount,
});

const SECTIONS: NoteSection[] = [
  section("Meeting notes", [section("Meeting notes/FastBind", [section("Meeting notes/FastBind/UAT")]), section("Meeting notes/Underwriting")]),
  section("Personal notes"),
  section("Empty"),
];

let n = 0;
const meta = (path: string, created: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({
  path,
  section: path.split("/").slice(0, -1).join("/"),
  title: `Note ${++n}`,
  created,
  updated: created,
  projectId: null,
  tags: [],
  excerpt: "",
  openActions: 0,
  ...extra,
});

const NOTES: NoteMeta[] = [
  meta("Meeting notes/2026-10-01-kickoff.md", "2026-10-01T09:00:00+03:00", { title: "Kickoff" }),
  meta("Meeting notes/FastBind/2026-10-28-sprint.md", "2026-10-28T10:00:00+03:00", { title: "Sprint" }),
  meta("Meeting notes/FastBind/UAT/2026-10-29-uat.md", "2026-10-29T10:00:00+03:00", { title: "UAT" }),
  meta("Personal notes/2026-10-30-ideas.md", "2026-10-30T20:00:00+03:00", { title: "Ideas" }),
  meta("loose.md", "2026-09-01T08:00:00+03:00", { title: "Loose" }),
];

describe("paths", () => {
  it("lists ancestors outermost first and counts depth", () => {
    expect(ancestorsOf("A/B/C")).toEqual(["A", "A/B"]);
    expect(ancestorsOf("A")).toEqual([]);
    expect(sectionDepth("")).toBe(0);
    expect(sectionDepth("A/B/C/D")).toBe(4);
  });

  it("remaps paths under a renamed section and leaves others alone", () => {
    expect(remapPath("A/B/n.md", "A/B", "A/C")).toBe("A/C/n.md");
    expect(remapPath("A/B", "A/B", "A/C")).toBe("A/C");
    expect(remapPath("A/Bee/n.md", "A/B", "A/C")).toBe("A/Bee/n.md");
    expect(remapPath("ملاحظات/n.md", "ملاحظات", "اجتماعات")).toBe("اجتماعات/n.md");
  });
});

describe("tree helpers", () => {
  it("finds nested sections", () => {
    expect(findSection(SECTIONS, "Meeting notes/FastBind/UAT")?.name).toBe("UAT");
    expect(findSection(SECTIONS, "Meeting notes/Nope")).toBeNull();
  });

  it("counts notes per section, including subsections in the total", () => {
    const counts = sectionCounts(SECTIONS, NOTES);
    expect(counts.get(ALL_NOTES)).toEqual({ direct: 1, total: 5 });
    expect(counts.get("Meeting notes")).toEqual({ direct: 1, total: 3 });
    expect(counts.get("Meeting notes/FastBind")).toEqual({ direct: 1, total: 2 });
    expect(counts.get("Meeting notes/FastBind/UAT")).toEqual({ direct: 1, total: 1 });
    expect(counts.get("Empty")).toEqual({ direct: 0, total: 0 });
  });

  it("shows All notes first and hides children of collapsed sections", () => {
    const collapsed = visibleRows(SECTIONS, new Set());
    expect(collapsed.map((r) => r.path)).toEqual([ALL_NOTES, "Meeting notes", "Personal notes", "Empty"]);
    expect(collapsed[1]).toMatchObject({ level: 1, posInSet: 2, setSize: 4, hasChildren: true, expanded: false });

    const open = visibleRows(SECTIONS, new Set(["Meeting notes", "Meeting notes/FastBind"]));
    expect(open.map((r) => r.path)).toEqual([
      ALL_NOTES,
      "Meeting notes",
      "Meeting notes/FastBind",
      "Meeting notes/FastBind/UAT",
      "Meeting notes/Underwriting",
      "Personal notes",
      "Empty",
    ]);
    expect(open[3]).toMatchObject({ level: 3, posInSet: 1, setSize: 1, parent: "Meeting notes/FastBind" });
    expect(open[4]).toMatchObject({ level: 2, posInSet: 2, setSize: 2, parent: "Meeting notes" });
  });

  it("moves through the tree with arrows, Home and End", () => {
    const rows = visibleRows(SECTIONS, new Set(["Meeting notes"]));
    expect(treeKeyAction(rows, ALL_NOTES, "ArrowDown")).toEqual({ kind: "focus", path: "Meeting notes" });
    expect(treeKeyAction(rows, ALL_NOTES, "ArrowUp")).toEqual({ kind: "none" });
    expect(treeKeyAction(rows, "Meeting notes", "ArrowRight")).toEqual({ kind: "focus", path: "Meeting notes/FastBind" });
    expect(treeKeyAction(rows, "Meeting notes/FastBind", "ArrowRight")).toEqual({ kind: "expand", path: "Meeting notes/FastBind" });
    expect(treeKeyAction(rows, "Meeting notes/FastBind", "ArrowLeft")).toEqual({ kind: "focus", path: "Meeting notes" });
    expect(treeKeyAction(rows, "Meeting notes", "ArrowLeft")).toEqual({ kind: "collapse", path: "Meeting notes" });
    expect(treeKeyAction(rows, "Empty", "ArrowRight")).toEqual({ kind: "none" });
    expect(treeKeyAction(rows, "Meeting notes/FastBind", "Home")).toEqual({ kind: "focus", path: ALL_NOTES });
    expect(treeKeyAction(rows, ALL_NOTES, "End")).toEqual({ kind: "focus", path: "Empty" });
    expect(treeKeyAction(rows, "gone", "ArrowDown")).toEqual({ kind: "focus", path: ALL_NOTES });
  });

  it("jumps by first letter, wrapping around", () => {
    const rows = visibleRows(SECTIONS, new Set());
    expect(typeAhead(rows, ALL_NOTES, "p")).toBe("Personal notes");
    expect(typeAhead(rows, "Empty", "a")).toBe(ALL_NOTES);
    expect(typeAhead(rows, ALL_NOTES, "z")).toBeNull();
  });

  it("allows deleting only empty sections and says why not", () => {
    const counts = sectionCounts(SECTIONS, NOTES);
    const empty = findSection(SECTIONS, "Empty")!;
    const meeting = findSection(SECTIONS, "Meeting notes")!;
    expect(canDeleteSection(empty, counts.get("Empty"))).toBe(true);
    expect(deleteBlockedReason(empty, counts.get("Empty"))).toBeNull();
    expect(canDeleteSection(meeting, counts.get("Meeting notes"))).toBe(false);
    expect(deleteBlockedReason(meeting, counts.get("Meeting notes"))).toBe(
      "Only empty sections can be deleted. This one holds 3 notes and 2 subsections.",
    );
    // A file the server counts but the index could not list still blocks the delete.
    const serverOnly = section("X", [], 1);
    expect(deleteBlockedReason(serverOnly, { direct: 0, total: 0 })).toBe(
      "Only empty sections can be deleted. This one holds 1 note.",
    );
  });
});

describe("sorting and filtering", () => {
  it("sorts newest first by created, then updated, unreadable dates last", () => {
    const list = [
      meta("a.md", "2026-10-01T09:00:00Z", { title: "a", updated: "2026-10-02T09:00:00Z" }),
      meta("b.md", "2026-10-01T09:00:00Z", { title: "b", updated: "2026-10-05T09:00:00Z" }),
      meta("c.md", "not a date", { title: "c" }),
      meta("d.md", "2026-10-30T09:00:00Z", { title: "d" }),
    ];
    expect(sortNotes(list).map((x) => x.title)).toEqual(["d", "b", "a", "c"]);
  });

  it("lists a section with its subsections, and everything for All notes", () => {
    expect(notesIn(NOTES, "Meeting notes").map((x) => x.title)).toEqual(["UAT", "Sprint", "Kickoff"]);
    expect(notesIn(NOTES, "Meeting notes/FastBind").map((x) => x.title)).toEqual(["UAT", "Sprint"]);
    expect(notesIn(NOTES, ALL_NOTES)).toHaveLength(5);
    expect(notesIn(NOTES, "Empty")).toEqual([]);
  });

  it("keeps 200 notes in one section in order", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      meta(`Big/${i}.md`, new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString()),
    );
    const sorted = notesIn(many, "Big");
    expect(sorted).toHaveLength(200);
    expect(sorted[0].path).toBe("Big/199.md");
    expect(sorted[199].path).toBe("Big/0.md");
  });
});

describe("templates", () => {
  it("picks Meeting inside Meeting notes and its subsections", () => {
    expect(defaultTemplate("Meeting notes")).toBe("meeting");
    expect(defaultTemplate("Meeting notes/FastBind/UAT")).toBe("meeting");
    expect(defaultTemplate("meeting Notes")).toBe("meeting");
  });

  it("picks Personal inside Personal notes and Blank elsewhere", () => {
    expect(defaultTemplate("Personal notes/Health")).toBe("personal");
    expect(defaultTemplate("Ideas")).toBe("blank");
    expect(defaultTemplate(ALL_NOTES)).toBe("blank");
    expect(defaultTemplate("Meeting notes archive")).toBe("blank");
  });

  it("defaults new notes to the open section, else Meeting notes, else the first", () => {
    expect(defaultNewNoteSection(SECTIONS, "Meeting notes/FastBind")).toBe("Meeting notes/FastBind");
    expect(defaultNewNoteSection(SECTIONS, ALL_NOTES)).toBe("Meeting notes");
    expect(defaultNewNoteSection([section("Ideas")], ALL_NOTES)).toBe("Ideas");
    expect(defaultNewNoteSection([], ALL_NOTES)).toBeNull();
  });

  it("puts the caret under the first heading", () => {
    const meeting = "## Attendees\n\n## Agenda\n";
    expect(initialCaret(meeting)).toBe("## Attendees\n".length);
    expect(initialCaret("")).toBe(0);
    expect(initialCaret("Plain text")).toBe(10);
  });
});

describe("task lines", () => {
  const md = ["# Review", "", "- [ ] Send minutes", "- [x] Book room", "  * [ ] nested", "> - [ ] quoted", "1. [ ] numbered", "- not a task", "- [ ]no space ok"].join("\n");

  it("checks and unchecks the matching line only", () => {
    const once = toggleTaskLine(md, 3)!;
    expect(once.split("\n")[2]).toBe("- [x] Send minutes");
    expect(once.split("\n").filter((l, i) => i !== 2)).toEqual(md.split("\n").filter((l, i) => i !== 2));
    expect(toggleTaskLine(once, 3)).toBe(md);
    expect(toggleTaskLine(md, 4)!.split("\n")[3]).toBe("- [ ] Book room");
  });

  it("handles nested, quoted and numbered items", () => {
    expect(toggleTaskLine(md, 5)!.split("\n")[4]).toBe("  * [x] nested");
    expect(toggleTaskLine(md, 6)!.split("\n")[5]).toBe("> - [x] quoted");
    expect(toggleTaskLine(md, 7)!.split("\n")[6]).toBe("1. [x] numbered");
  });

  it("refuses lines that are not tasks or out of range", () => {
    expect(toggleTaskLine(md, 1)).toBeNull();
    expect(toggleTaskLine(md, 8)).toBeNull();
    expect(toggleTaskLine(md, 0)).toBeNull();
    expect(toggleTaskLine(md, 99)).toBeNull();
  });

  it("keeps CRLF line endings and Arabic text", () => {
    const crlf = "- [ ] أرسل المحضر\r\n- [ ] two\r\n";
    expect(toggleTaskLine(crlf, 1)).toBe("- [x] أرسل المحضر\r\n- [ ] two\r\n");
  });

  it("counts open tasks like the server's openActions", () => {
    expect(countOpenTasks(md)).toBe(5);
  });
});

describe("validation", () => {
  it("checks section names like the server", () => {
    expect(validateSectionName("  ")).toBe("Enter a name.");
    expect(validateSectionName("a".repeat(81))).toBe("Use 80 characters or fewer.");
    expect(validateSectionName(".hidden")).toBe("Names can't start with a dot.");
    expect(validateSectionName("a/b")).toMatch(/^Use letters/);
    expect(validateSectionName("..")).toBe("Names can't start with a dot.");
    expect(validateSectionName("FastBind (2026) & Co.'s - v1, ok")).toBeNull();
    expect(validateSectionName("اجتماعات")).toBeNull();
    expect(validateSectionName("fastbind", ["FastBind"])).toBe("There's already a section called fastbind here.");
  });

  it("checks titles and body size", () => {
    expect(validateTitle(" ")).toBe("Add a title to save this note.");
    expect(validateTitle("x".repeat(121))).toMatch(/120/);
    expect(validateTitle("مراجعة السباق")).toBeNull();
    expect(validateBody("a".repeat(200 * 1024))).toBeNull();
    expect(validateBody("a".repeat(200 * 1024 + 1))).toMatch(/200 KB/);
    // Arabic letters are 2 bytes each in UTF-8.
    expect(validateBody("ب".repeat(110 * 1024))).toMatch(/200 KB/);
  });

  it("adds tags, dropping a leading # and duplicates", () => {
    expect(addTag(["meeting"], "#FastBind")).toEqual({ tags: ["meeting", "FastBind"], error: null });
    expect(addTag(["meeting"], "Meeting").tags).toEqual(["meeting"]);
    expect(addTag([], "two words").error).toBe("Tags use letters, numbers and hyphens only.");
    expect(addTag([], "x".repeat(31)).error).toMatch(/30/);
    expect(addTag(Array.from({ length: 10 }, (_, i) => `t${i}`), "eleven").error).toBe("Up to 10 tags per note.");
    expect(addTag([], "عمل").tags).toEqual(["عمل"]);
  });
});

describe("dirty state", () => {
  const saved: NoteFields = { title: "Review", body: "## Notes\n", projectId: null, tags: ["meeting"] };

  it("is clean when nothing changed", () => {
    expect(isDirty({ ...saved, tags: [...saved.tags] }, saved)).toBe(false);
    expect(notePatch(saved, saved)).toEqual({});
  });

  it("patches only the changed fields", () => {
    expect(notePatch({ ...saved, body: "## Notes\nhi" }, saved)).toEqual({ body: "## Notes\nhi" });
    expect(notePatch({ ...saved, projectId: "qic-fastbind" }, saved)).toEqual({ projectId: "qic-fastbind" });
    expect(notePatch({ ...saved, tags: ["meeting", "fastbind"] }, saved)).toEqual({ tags: ["meeting", "fastbind"] });
    expect(notePatch({ ...saved, title: "Review 2", projectId: null }, saved)).toEqual({ title: "Review 2" });
    expect(isDirty({ ...saved, tags: [] }, saved)).toBe(true);
  });

  it("treats a save round trip's normalising as the same content, a real edit as different", () => {
    expect(sameContent({ ...saved, body: "## Notes\r\n\r\n", title: " Review " }, saved)).toBe(true);
    expect(sameContent({ ...saved, tags: ["meeting"] }, { ...saved, tags: ["meeting"] })).toBe(true);
    expect(sameContent({ ...saved, body: "## Notes\nedited in Obsidian\n" }, saved)).toBe(false);
    expect(sameContent({ ...saved, projectId: "x" }, saved)).toBe(false);
  });

  it("reads the editable fields from a note", () => {
    expect(fieldsOf({ title: "T", body: "B", projectId: null, tags: ["a"] })).toEqual({
      title: "T",
      body: "B",
      projectId: null,
      tags: ["a"],
    });
  });

  it("blocks a save without a title or over the size limit", () => {
    expect(validateFields({ ...saved, title: "" })).toBe("Add a title to save this note.");
    expect(validateFields(saved)).toBeNull();
  });

  it("sorts save failures and retries only what clears up by itself", () => {
    expect(classifySaveError(0, true)).toBe("offline");
    expect(classifySaveError(404, false)).toBe("gone");
    expect(classifySaveError(413, false)).toBe("too_large");
    expect(classifySaveError(400, false)).toBe("rejected");
    expect(classifySaveError(500, false)).toBe("server");
    expect(isRetryable("offline")).toBe(true);
    expect(isRetryable("server")).toBe(true);
    expect(isRetryable("gone")).toBe(false);
    expect(isRetryable("rejected")).toBe(false);
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([5_000, 15_000, 30_000, 60_000, 60_000]);
  });
});

describe("formatNoteDate", () => {
  const now = new Date(2026, 9, 30, 15, 0);

  it("says Today and Yesterday with the time", () => {
    expect(formatNoteDate(new Date(2026, 9, 30, 9, 5).toISOString(), now)).toBe("Today 09:05");
    expect(formatNoteDate(new Date(2026, 9, 29, 22, 40).toISOString(), now)).toBe("Yesterday 22:40");
  });

  it("uses weekday and date this year, and the year otherwise", () => {
    expect(formatNoteDate(new Date(2026, 9, 27, 10, 0).toISOString(), now)).toBe("Tue 27 Oct");
    expect(formatNoteDate(new Date(2025, 2, 12, 10, 0).toISOString(), now)).toBe("12 Mar 2025");
    expect(formatNoteDate("nope", now)).toBe("");
  });
});
