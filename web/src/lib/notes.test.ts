import { describe, expect, it } from "vitest";
import type { NoteMeta, NoteSection, NoteVault } from "../../../shared/types";
import {
  addTag,
  ALL_NOTES,
  ancestorsOf,
  canDeleteSection,
  classifySaveError,
  countOpenTasks,
  defaultDestination,
  defaultVaultId,
  filterByTitle,
  filterFolderOptions,
  folderDepth,
  folderOptions,
  holdsProtected,
  isProtectedPath,
  isReadOnlyNote,
  isVaultRoot,
  noteVaultId,
  notesInScope,
  openTrail,
  placeExists,
  placeLabel,
  splitVaultPath,
  treeCounts,
  vaultGroups,
  vaultRows,
  vaultsOf,
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
  vault: "notes",
  readOnly: false,
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

/* v1.4 vaults ----------------------------------------------------------------------------------- */

const VAULTS: NoteVault[] = [
  { id: "notes", label: "Working-With-Claude notes", prefix: "", dir: "C:\\MD\\WWC\\notes", readOnlyFolders: [], noteCount: 3 },
  { id: "learning", label: "Learning", prefix: "@learning/", dir: "C:\\MD\\Learning", readOnlyFolders: ["raw/"], noteCount: 4 },
  {
    id: "qic-uw",
    label: "QIC Underwriting Agent",
    prefix: "@qic-uw/",
    dir: "C:\\MD\\QIC_Underwriting_Agent",
    readOnlyFolders: ["sources", "project/P&C/docs"],
    noteCount: 1,
  },
];

const V_SECTIONS: NoteSection[] = [
  section("Meeting notes", [section("Meeting notes/FastBind")]),
  section("Tasks"),
  {
    path: "@learning",
    name: "Learning",
    noteCount: 1,
    children: [
      { path: "@learning/raw", name: "raw", noteCount: 1, readOnly: true, children: [section("@learning/raw/papers")] },
      section("@learning/wiki", [section("@learning/wiki/ai engineering"), section("@learning/wiki/ذكاء")]),
    ],
  },
  {
    path: "@qic-uw",
    name: "QIC Underwriting Agent",
    noteCount: 0,
    children: [
      section("@qic-uw/sources"),
      section("@qic-uw/project", [section("@qic-uw/project/P&C", [section("@qic-uw/project/P&C/docs")])]),
    ],
  },
];

const V_NOTES: NoteMeta[] = [
  meta("Meeting notes/2026-10-01-kickoff.md", "2026-10-01T09:00:00+03:00", { title: "Kickoff" }),
  meta("Tasks/send-slip.md", "2026-10-20T09:00:00+03:00", { title: "Send slip" }),
  meta("loose.md", "2026-09-01T08:00:00+03:00", { title: "Loose" }),
  meta("@learning/index.md", "2026-10-10T09:00:00+03:00", { title: "Index", vault: "learning" }),
  meta("@learning/raw/paper one.md", "2026-10-11T09:00:00+03:00", { title: "Paper one", vault: "learning", readOnly: true }),
  meta("@learning/wiki/rag.md", "2026-10-30T09:00:00+03:00", { title: "RAG basics", vault: "learning" }),
  meta("@learning/wiki/ذكاء/مقدمة.md", "2026-10-29T09:00:00+03:00", { title: "مقدمة في الذكاء", vault: "learning" }),
  meta("@qic-uw/project/P&C/docs/spec.md", "2026-10-15T09:00:00+03:00", { title: "Spec", vault: "qic-uw", readOnly: true }),
];

describe("vaults: prefix parsing", () => {
  it("reads the vault list, default first, and null from an older server", () => {
    expect(vaultsOf({ vaults: VAULTS })?.map((v) => v.id)).toEqual(["notes", "learning", "qic-uw"]);
    expect(vaultsOf({ vaults: [VAULTS[1], VAULTS[0]] })?.map((v) => v.id)).toEqual(["notes", "learning"]);
    expect(vaultsOf({})).toBeNull();
    expect(vaultsOf({ vaults: "nope" as unknown as NoteVault[] })).toBeNull();
    expect(vaultsOf({ vaults: [] })).toBeNull();
    expect(vaultsOf(null)).toBeNull();
  });

  it("adds the default vault when a server lists only others, and tolerates missing fields", () => {
    const list = vaultsOf({ dir: "C:\\notes", vaults: [{ id: "learning", prefix: "@learning/" } as NoteVault] });
    expect(list?.map((v) => [v.id, v.prefix, v.dir])).toEqual([
      ["notes", "", "C:\\notes"],
      ["learning", "@learning/", ""],
    ]);
    expect(list?.[1].readOnlyFolders).toEqual([]);
  });

  it("splits a path into its vault and the path inside it", () => {
    expect(splitVaultPath("@learning/wiki/rag.md", VAULTS)).toMatchObject({ vault: { id: "learning" }, inner: "wiki/rag.md" });
    expect(splitVaultPath("@learning", VAULTS)).toMatchObject({ vault: { id: "learning" }, inner: "" });
    expect(splitVaultPath("Meeting notes/a.md", VAULTS)).toMatchObject({ vault: { id: "notes" }, inner: "Meeting notes/a.md" });
    // Not a prefix: a default-vault folder that happens to start with @, or a longer name.
    expect(splitVaultPath("@learning2/x.md", VAULTS).vault?.id).toBe("notes");
    expect(splitVaultPath("@home/x.md", VAULTS).vault?.id).toBe("notes");
    expect(splitVaultPath("a.md", null)).toEqual({ vault: null, inner: "a.md" });
  });

  it("knows vault rows, depth inside a vault and each note's vault", () => {
    expect(isVaultRoot("", VAULTS)).toBe(true);
    expect(isVaultRoot("@learning", VAULTS)).toBe(true);
    expect(isVaultRoot("@learning/wiki", VAULTS)).toBe(false);
    expect(isVaultRoot("", null)).toBe(false);
    expect(folderDepth("@learning/wiki/ai engineering", VAULTS)).toBe(2);
    expect(folderDepth("Meeting notes/FastBind", VAULTS)).toBe(2);
    expect(noteVaultId({ path: "@qic-uw/a.md" }, VAULTS)).toBe("qic-uw");
    expect(noteVaultId({ path: "@qic-uw/a.md", vault: "learning" }, VAULTS)).toBe("learning");
  });

  it("labels places with the vault name, and Arabic or spaced names as they are", () => {
    expect(placeLabel("@learning/wiki/ذكاء", VAULTS)).toBe("Learning / wiki / ذكاء");
    expect(placeLabel("@learning", VAULTS)).toBe("Learning");
    expect(placeLabel("", VAULTS)).toBe("Working-With-Claude notes");
    expect(placeLabel("Meeting notes/FastBind", VAULTS)).toBe("Meeting notes / FastBind");
    expect(placeLabel("Tasks", VAULTS, true)).toBe("Working-With-Claude notes / Tasks");
    expect(placeLabel("", null)).toBe("All notes");
  });

  it("opens the vault row and every ancestor so a deep-linked note shows", () => {
    expect(openTrail("@learning/wiki/ai engineering", VAULTS)).toEqual(["@learning", "@learning/wiki"]);
    expect(openTrail("Meeting notes/FastBind", VAULTS)).toEqual(["", "Meeting notes"]);
    expect(openTrail("Meeting notes/FastBind", null)).toEqual(["Meeting notes"]);
  });
});

describe("vaults: read-only folders", () => {
  it("protects the listed folders and everything inside, ignoring case and slashes", () => {
    expect(isProtectedPath("@learning/raw", VAULTS)).toBe(true);
    expect(isProtectedPath("@learning/RAW/papers/x.md", VAULTS)).toBe(true);
    expect(isProtectedPath("@learning/rawish", VAULTS)).toBe(false);
    expect(isProtectedPath("@learning", VAULTS)).toBe(false);
    expect(isProtectedPath("@qic-uw/project/P&C/docs/spec.md", VAULTS)).toBe(true);
    expect(isProtectedPath("@qic-uw/project/P&C", VAULTS)).toBe(false);
    expect(isProtectedPath("raw/x.md", VAULTS)).toBe(false);
    expect(isReadOnlyNote({ path: "Meeting notes/a.md", readOnly: true }, VAULTS)).toBe(true);
  });

  it("knows which folders hold a protected one, so their name and place stay", () => {
    expect(holdsProtected("@qic-uw/project", VAULTS)).toBe(true);
    expect(holdsProtected("@qic-uw/project/P&C", VAULTS)).toBe(true);
    expect(holdsProtected("@qic-uw/project/P&C/docs", VAULTS)).toBe(false);
    expect(holdsProtected("@learning/wiki", VAULTS)).toBe(false);
    expect(holdsProtected("Meeting notes", VAULTS)).toBe(false);
  });
});

describe("vaults: grouping and the tree", () => {
  it("groups sections by vault in vault order, with Tasks staying in the default vault", () => {
    const groups = vaultGroups(V_SECTIONS, VAULTS);
    expect(groups.map((g) => [g.vault.id, g.root, g.children.map((s) => s.name)])).toEqual([
      ["notes", "", ["Meeting notes", "Tasks"]],
      ["learning", "@learning", ["raw", "wiki"]],
      ["qic-uw", "@qic-uw", ["sources", "project"]],
    ]);
  });

  it("gives an empty vault an empty group, and a missing vault no group", () => {
    const empty = vaultGroups([section("Meeting notes")], VAULTS);
    expect(empty[1].children).toEqual([]);
    // Learning's folder is gone: the server leaves it out of vaults and sections.
    const two = vaultGroups(
      V_SECTIONS.filter((s) => s.path !== "@learning"),
      [VAULTS[0], VAULTS[2]],
    );
    expect(two.map((g) => g.vault.id)).toEqual(["notes", "qic-uw"]);
  });

  it("shows each vault open at its first level, with deeper folders closed until opened", () => {
    const groups = vaultGroups(V_SECTIONS, VAULTS);
    const rows = vaultRows(groups, new Set(), new Set(), VAULTS);
    expect(rows.map((r) => r.path)).toEqual([
      "",
      "Meeting notes",
      "Tasks",
      "@learning",
      "@learning/raw",
      "@learning/wiki",
      "@qic-uw",
      "@qic-uw/sources",
      "@qic-uw/project",
    ]);
    expect(rows[3]).toMatchObject({ kind: "vault", level: 1, posInSet: 2, setSize: 3, expanded: true, name: "Learning" });
    expect(rows[4]).toMatchObject({ kind: "folder", level: 2, readOnly: true, parent: "@learning" });
    expect(rows[7]).toMatchObject({ readOnly: true });
    expect(rows[8]).toMatchObject({ readOnly: false, hasChildren: true, expanded: false });

    const closed = vaultRows(groups, new Set(["@learning/wiki"]), new Set(["", "@qic-uw"]), VAULTS);
    expect(closed.map((r) => r.path)).toEqual([
      "",
      "@learning",
      "@learning/raw",
      "@learning/wiki",
      "@learning/wiki/ai engineering",
      "@learning/wiki/ذكاء",
      "@qic-uw",
    ]);
    expect(treeKeyAction(closed, "", "ArrowRight")).toEqual({ kind: "expand", path: "" });
    expect(treeKeyAction(closed, "@learning/wiki/ذكاء", "ArrowLeft")).toEqual({ kind: "focus", path: "@learning/wiki" });
  });

  it("counts each vault's own notes on its row", () => {
    const counts = treeCounts(V_SECTIONS, V_NOTES, VAULTS);
    expect(counts.get("")?.total).toBe(3);
    expect(counts.get("@learning")?.total).toBe(4);
    expect(counts.get("@learning/wiki")?.total).toBe(2);
    expect(counts.get("@qic-uw")?.total).toBe(1);
    // Without vaults, "" is still All notes.
    expect(treeCounts(V_SECTIONS, V_NOTES, null).get("")?.total).toBe(8);
  });

  it("knows which places exist, vault rows included", () => {
    expect(placeExists(V_SECTIONS, VAULTS, "@learning/wiki")).toBe(true);
    expect(placeExists(V_SECTIONS, VAULTS, "@qic-uw")).toBe(true);
    expect(placeExists(V_SECTIONS, VAULTS, "@learning/gone")).toBe(false);
    expect(placeExists(V_SECTIONS, null, "")).toBe(true);
  });
});

describe("vaults: the list", () => {
  it("lists a vault's own notes newest first on its row, and a folder with its subfolders", () => {
    expect(notesInScope(V_NOTES, "", VAULTS).map((x) => x.title)).toEqual(["Send slip", "Kickoff", "Loose"]);
    expect(notesInScope(V_NOTES, "@learning", VAULTS).map((x) => x.title)).toEqual([
      "RAG basics",
      "مقدمة في الذكاء",
      "Paper one",
      "Index",
    ]);
    expect(notesInScope(V_NOTES, "@learning/wiki", VAULTS)).toHaveLength(2);
    expect(notesInScope(V_NOTES, "", null)).toHaveLength(8);
  });

  it("filters by title words in any order, ignoring case", () => {
    expect(filterByTitle(V_NOTES, "rag").map((x) => x.title)).toEqual(["RAG basics"]);
    expect(filterByTitle(V_NOTES, "BASICS rag")).toHaveLength(1);
    expect(filterByTitle(V_NOTES, "الذكاء").map((x) => x.title)).toEqual(["مقدمة في الذكاء"]);
    expect(filterByTitle(V_NOTES, "   ")).toHaveLength(8);
    expect(filterByTitle(V_NOTES, "nothing like this")).toEqual([]);
    expect(filterByTitle([meta("x.md", "2026-10-01T09:00:00Z", { title: "" })], "untitled")).toHaveLength(1);
  });

  it("sorts and filters 1,300 notes quickly", () => {
    const many = Array.from({ length: 1300 }, (_, i) =>
      meta(`@learning/wiki/n${i}.md`, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), {
        title: `Topic ${i}`,
        vault: "learning",
      }),
    );
    const started = performance.now();
    const scoped = notesInScope(many, "@learning", VAULTS);
    const hits = filterByTitle(scoped, "1299 topic");
    expect(scoped[0].title).toBe("Topic 1299");
    expect(hits.map((x) => x.title)).toEqual(["Topic 1299"]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("vaults: where a new note goes", () => {
  it("offers a vault's folders without protected ones, its top level first, with full paths", () => {
    const learning = folderOptions(V_SECTIONS, VAULTS, "learning");
    expect(learning.map((o) => o.path)).toEqual([
      "@learning",
      "@learning/wiki",
      "@learning/wiki/ai engineering",
      "@learning/wiki/ذكاء",
    ]);
    expect(learning[0]).toMatchObject({ root: true, parts: [] });
    expect(learning[2].parts).toEqual(["wiki", "ai engineering"]);

    const qic = folderOptions(V_SECTIONS, VAULTS, "qic-uw");
    expect(qic.map((o) => o.path)).toEqual(["@qic-uw", "@qic-uw/project", "@qic-uw/project/P&C"]);

    const main = folderOptions(V_SECTIONS, VAULTS, "notes");
    expect(main.map((o) => o.path)).toEqual(["Meeting notes", "Meeting notes/FastBind", "Tasks"]);
    expect(folderOptions(V_SECTIONS, VAULTS, "gone")).toEqual([]);
  });

  it("offers every writable section without vaults", () => {
    const legacy = folderOptions([section("A", [section("A/B")]), { ...section("Locked"), readOnly: true }], null, null);
    expect(legacy.map((o) => o.path)).toEqual(["A", "A/B"]);
  });

  it("searches folders by every typed word", () => {
    const learning = folderOptions(V_SECTIONS, VAULTS, "learning");
    expect(filterFolderOptions(learning, "ai eng").map((o) => o.path)).toEqual(["@learning/wiki/ai engineering"]);
    expect(filterFolderOptions(learning, "WIKI/ذكاء").map((o) => o.path)).toEqual(["@learning/wiki/ذكاء"]);
    expect(filterFolderOptions(learning, "top")).toHaveLength(1);
    expect(filterFolderOptions(learning, "")).toHaveLength(4);
  });

  it("picks the open folder, else a writable parent, else the vault's top level", () => {
    expect(defaultDestination(V_SECTIONS, VAULTS, "@learning/wiki")).toEqual({ vault: "learning", folder: "@learning/wiki" });
    expect(defaultDestination(V_SECTIONS, VAULTS, "@learning/raw/papers")).toEqual({ vault: "learning", folder: "@learning" });
    expect(defaultDestination(V_SECTIONS, VAULTS, "@qic-uw/project/P&C/docs")).toEqual({
      vault: "qic-uw",
      folder: "@qic-uw/project/P&C",
    });
    expect(defaultDestination(V_SECTIONS, VAULTS, "@learning")).toEqual({ vault: "learning", folder: "@learning" });
  });

  it("uses Meeting notes in Working-With-Claude for its row, anything unknown, or nothing open", () => {
    expect(defaultDestination(V_SECTIONS, VAULTS, "")).toEqual({ vault: "notes", folder: "Meeting notes" });
    expect(defaultDestination(V_SECTIONS, VAULTS, "Tasks")).toEqual({ vault: "notes", folder: "Tasks" });
    expect(defaultDestination(V_SECTIONS, VAULTS, "Gone/away")).toEqual({ vault: "notes", folder: "Meeting notes" });
    expect(defaultVaultId(VAULTS, null)).toBe("notes");
    expect(defaultVaultId(VAULTS, { vault: "learning", folder: "@learning" })).toBe("learning");
    expect(defaultVaultId(null, null)).toBeNull();
  });

  it("falls back to the default vault, or null when there is nowhere to write", () => {
    expect(defaultDestination([section("Ideas")], [VAULTS[0]], "")).toEqual({ vault: "notes", folder: "Ideas" });
    expect(defaultDestination([], [VAULTS[0]], "")).toBeNull();
    expect(defaultDestination(SECTIONS, null, ALL_NOTES)).toEqual({ vault: null, folder: "Meeting notes" });
    expect(defaultDestination(SECTIONS, null, "Meeting notes/FastBind")).toEqual({
      vault: null,
      folder: "Meeting notes/FastBind",
    });
    expect(defaultDestination([], null, ALL_NOTES)).toBeNull();
  });
});

describe("vaults: saving into a protected folder", () => {
  it("sorts a 403 as forbidden, which retrying can't fix", () => {
    expect(classifySaveError(403, false)).toBe("forbidden");
    expect(isRetryable("forbidden")).toBe(false);
  });
});
