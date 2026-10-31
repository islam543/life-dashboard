import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoteSection, NotesIndex } from "../shared/types";
import { loadConfig, presentVaults, type VaultConfig } from "./config";
import { detectActions } from "./jira/actions";
import { writeBack, writeBackFailure } from "./jira/writeBack";
import { createNotesStore, DEFAULT_SECTIONS, PROTECTED_MESSAGE, slugify, TEMPLATES, type NotesStore } from "./notes";
import { parseNoteFile, readFields } from "./notesFrontmatter";

// Every test works in its own temp folder. The real vault is never touched.

const NOW = new Date(2026, 9, 30, 9, 0, 0);
const KB = 1024;

let tmp: string;
let dir: string;
let clock: Date;
let store: NotesStore;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-notes-"));
  dir = path.join(tmp, "vault", "notes");
  await mkdir(path.dirname(dir));
  clock = NOW;
  store = createNotesStore(dir, { now: () => clock });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const at = (...parts: string[]) => path.join(dir, ...parts);
const status = (code: number) => expect.objectContaining({ status: code });

async function listAll(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(folder, { withFileTypes: true, recursive: true })) {
    out.push(path.relative(folder, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
  }
  return out.sort();
}

describe("first run and status", () => {
  it("does not touch the disk when created", async () => {
    createNotesStore(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("creates NOTES_DIR with the default sections when it is missing", async () => {
    const index = await store.index();
    expect(index.status).toBe("ok");
    expect(index.dir).toBe(path.resolve(dir));
    expect(index.sections.map((s) => s.path)).toEqual([...DEFAULT_SECTIONS]);
    expect(index.notes).toEqual([]);
  });

  it("creates the default sections when NOTES_DIR is empty, and not again once it holds something", async () => {
    await mkdir(dir);
    expect((await store.index()).sections.map((s) => s.name)).toEqual([...DEFAULT_SECTIONS]);
    await rm(at("Meeting notes"), { recursive: true });
    expect((await store.index()).sections.map((s) => s.name)).toEqual(["Personal notes"]);
  });

  it("is not_connected and creates nothing when NOTES_DIR and its parent are missing", async () => {
    const missing = path.join(tmp, "no-vault", "notes");
    const index = await createNotesStore(missing).index();
    expect(index.status).toBe("not_connected");
    expect(index.message).toContain(path.resolve(missing));
    await expect(stat(path.join(tmp, "no-vault"))).rejects.toThrow();
    expect(await createNotesStore(missing).recent(14, NOW)).toEqual([]);
  });

  it("is error when NOTES_DIR is a file", async () => {
    await writeFile(dir, "not a folder");
    expect((await store.index()).status).toBe("error");
  });
});

describe("create, read, update", () => {
  it("writes YYYY-MM-DD-<slug>.md with frontmatter that round-trips", async () => {
    await store.index();
    const note = await store.create({
      section: "Meeting notes",
      title: "Sprint review: Q4 #2",
      projectId: "qic-fastbind",
      tags: ["meeting", "#fastbind"],
      body: "Hello\r\nworld",
    });
    expect(note.path).toBe("Meeting notes/2026-10-30-sprint-review-q4-2.md");
    expect(note).toMatchObject({
      section: "Meeting notes",
      title: "Sprint review: Q4 #2",
      projectId: "qic-fastbind",
      tags: ["meeting", "fastbind"],
      body: "Hello\nworld",
      openActions: 0,
      excerpt: "Hello world",
    });
    expect(Date.parse(note.created)).toBe(NOW.getTime());
    expect(note.updated).toBe(note.created);

    const text = await readFile(at("Meeting notes", "2026-10-30-sprint-review-q4-2.md"), "utf8");
    expect(text.startsWith("---\ntitle: \"Sprint review: Q4 #2\"\ncreated: ")).toBe(true);
    const fields = readFields(parseNoteFile(text).frontmatter);
    expect(fields).toEqual({ title: note.title, created: note.created, updated: note.updated, projectId: "qic-fastbind", tags: ["meeting", "fastbind"] });

    expect(await store.read(note.path)).toEqual(note);
    expect((await store.index()).notes).toEqual([expect.objectContaining({ path: note.path, title: note.title })]);
  });

  it("adds -2, -3 on a file name clash", async () => {
    await store.index();
    const a = await store.create({ section: "Personal notes", title: "Idea" });
    const b = await store.create({ section: "Personal notes", title: "idea" });
    const c = await store.create({ section: "Personal notes", title: "IDEA!" });
    expect([a.path, b.path, c.path]).toEqual([
      "Personal notes/2026-10-30-idea.md",
      "Personal notes/2026-10-30-idea-2.md",
      "Personal notes/2026-10-30-idea-3.md",
    ]);
  });

  it("uses the templates when no body is given", async () => {
    await store.index();
    const meeting = await store.create({ section: "Meeting notes", title: "Standup", template: "meeting" });
    expect(meeting.body).toBe("## Attendees\n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Action items\n\n- [ ] \n");
    expect(meeting.body.match(/^- \[ \] $/gm)).toHaveLength(1);
    expect(meeting.openActions).toBe(0); // the empty placeholder is not an action yet
    expect((await store.create({ section: "Personal notes", title: "Diary", template: "personal" })).body).toBe("## Notes\n");
    expect((await store.create({ section: "Personal notes", title: "Blank" })).body).toBe("");
    expect(TEMPLATES.blank).toBe("");
    const custom = await store.create({ section: "Meeting notes", title: "Own body", template: "meeting", body: "mine" });
    expect(custom.body).toBe("mine");
  });

  it("keeps letters in slugs (Arabic too) and falls back to note", async () => {
    expect(slugify("اجتماع المراجعة")).toBe("اجتماع-المراجعة");
    expect(slugify("مُراجَعة")).toBe("مراجعة");
    expect(slugify("Café déjà vu")).toBe("café-déjà-vu");
    expect(slugify("!!! ???")).toBe("note");
    expect([...slugify("a".repeat(120))].length).toBe(60);
    await store.index();
    const note = await store.create({ section: "Personal notes", title: "اجتماع المراجعة" });
    expect(note.path).toBe("Personal notes/2026-10-30-اجتماع-المراجعة.md");
    expect((await store.read(note.path)).title).toBe("اجتماع المراجعة");
  });

  it("validates input: section, title, tags, project id, template, body size", async () => {
    await store.index();
    const base = { section: "Meeting notes", title: "x" };
    await expect(store.create({ ...base, section: "Nope" })).rejects.toEqual(status(404));
    await expect(store.create({ ...base, title: "  " })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, title: "x".repeat(121) })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, title: "two\nlines" })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, tags: ["has space"] })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, projectId: "../x" })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, template: "weekly" as never })).rejects.toEqual(status(400));
    await expect(store.create({ ...base, body: "x".repeat(200 * KB + 1) })).rejects.toEqual(status(413));
    expect((await store.create({ ...base, body: "x".repeat(200 * KB) })).body).toHaveLength(200 * KB);
  });

  it("update changes only the given fields and bumps updated", async () => {
    await store.index();
    const note = await store.create({ section: "Meeting notes", title: "Review", tags: ["a"], projectId: "p1", body: "first" });
    clock = new Date(2026, 9, 30, 11, 30, 0);
    const renamed = await store.update(note.path, { title: "Review (final)" });
    expect(renamed).toMatchObject({ path: note.path, title: "Review (final)", body: "first", tags: ["a"], projectId: "p1", created: note.created });
    expect(Date.parse(renamed.updated)).toBe(clock.getTime());

    const relinked = await store.update(note.path, { projectId: null, tags: [], body: "second\n- [ ] follow up" });
    expect(relinked).toMatchObject({ title: "Review (final)", projectId: null, tags: [], body: "second\n- [ ] follow up", openActions: 1 });
    expect(await store.read(note.path)).toEqual(relinked);
    await expect(store.update(note.path, {})).rejects.toEqual(status(400));
    await expect(store.update("Meeting notes/missing.md", { title: "x" })).rejects.toEqual(status(404));
  });

  it("keeps Obsidian edits made between read and save, and writes a new body in full", async () => {
    await store.index();
    const note = await store.create({ section: "Meeting notes", title: "Shared", body: "from dashboard" });
    const file = at(...note.path.split("/"));
    const edited = (await readFile(file, "utf8")).replace("from dashboard", "edited in Obsidian, much longer than before");
    await writeFile(file, edited.replace("tags: []", "tags: []\naliases: [Shared]"));

    const titled = await store.update(note.path, { title: "Shared notes" });
    expect(titled.body).toBe("edited in Obsidian, much longer than before");
    expect(await readFile(file, "utf8")).toContain("aliases: [Shared]");

    const saved = await store.update(note.path, { body: "short" });
    expect(saved.body).toBe("short");
    const text = await readFile(file, "utf8");
    expect(parseNoteFile(text).body).toBe("short");
    expect(text).toContain("aliases: [Shared]");
  });

  it("leaves no temp files behind", async () => {
    await store.index();
    const note = await store.create({ section: "Meeting notes", title: "Atomic" });
    await store.update(note.path, { body: "v2" });
    expect(await readdir(at("Meeting notes"))).toEqual(["2026-10-30-atomic.md"]);
  });
});

describe("hand-made notes", () => {
  it("reads notes without frontmatter: title from the first heading, else the file name", async () => {
    await store.index();
    await writeFile(at("Personal notes", "Ideas.md"), "\uFEFF# Big ideas\r\n\r\n- [ ] Try it\r\n- [x] Done\r\n");
    await writeFile(at("Personal notes", "Untitled.md"), "just text");
    const index = await store.index();
    const byPath = Object.fromEntries(index.notes.map((n) => [n.path, n]));
    expect(byPath["Personal notes/Ideas.md"]).toMatchObject({ title: "Big ideas", openActions: 1, projectId: null, tags: [] });
    expect(byPath["Personal notes/Untitled.md"]).toMatchObject({ title: "Untitled", excerpt: "just text" });
    const ideas = await store.read("Personal notes/Ideas.md");
    expect(ideas.body).toBe("# Big ideas\n\n- [ ] Try it\n- [x] Done\n");
    expect(Number.isNaN(Date.parse(ideas.updated))).toBe(false);
  });

  it("gains frontmatter only when saved through the dashboard", async () => {
    await store.index();
    const file = at("Personal notes", "Ideas.md");
    const original = "# Big ideas\n\nkeep me\n";
    await writeFile(file, original);
    await store.index();
    await store.read("Personal notes/Ideas.md");
    expect(await readFile(file, "utf8")).toBe(original);

    const saved = await store.update("Personal notes/Ideas.md", { tags: ["idea"] });
    expect(saved).toMatchObject({ title: "Big ideas", tags: ["idea"], body: original });
    const fields = readFields(parseNoteFile(await readFile(file, "utf8")).frontmatter);
    expect(fields).toMatchObject({ title: "Big ideas", projectId: null, tags: ["idea"] });
    expect(fields.created).not.toBeNull();
  });

  it("refuses files over 200 KB and files that are not UTF-8, but still lists them", async () => {
    await store.index();
    await writeFile(at("Personal notes", "Huge.md"), "x".repeat(300 * KB));
    await writeFile(at("Personal notes", "Latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1
    const index = await store.index();
    expect(index.notes.map((n) => n.title).sort()).toEqual(["Huge", "Latin1"]);
    await expect(store.read("Personal notes/Huge.md")).rejects.toEqual(status(413));
    await expect(store.update("Personal notes/Huge.md", { title: "x" })).rejects.toEqual(status(413));
    await expect(store.read("Personal notes/Latin1.md")).rejects.toEqual(status(400));
    await expect(store.update("Personal notes/Latin1.md", { title: "x" })).rejects.toEqual(status(400));
    expect((await readFile(at("Personal notes", "Latin1.md"))).length).toBe(4);
  });

  it("never lists dot folders, links or other files, and reports names it cannot open", async () => {
    await store.index();
    await mkdir(at(".obsidian"));
    await writeFile(at(".obsidian", "workspace.md"), "x");
    await mkdir(at(".trash"));
    await writeFile(at(".trash", "old.md"), "x");
    await writeFile(at("Personal notes", ".hidden.md"), "x");
    await writeFile(at("Personal notes", "photo.png"), "x");
    await writeFile(at("Personal notes", "Notes #1.md"), "x");
    const index = await store.index();
    expect(index.notes).toEqual([]);
    expect(index.sections.map((s) => s.name)).toEqual([...DEFAULT_SECTIONS]);
    expect(index.message).toMatch(/^1 item is not shown/);
  });

  it("re-parses a file only when its mtime or size changed", async () => {
    await store.index();
    const file = at("Personal notes", "cache.md");
    const t1 = new Date(2026, 0, 1);
    await writeFile(file, "# Alpha\n");
    await utimes(file, t1, t1);
    const title = async () => (await store.index()).notes.find((n) => n.path === "Personal notes/cache.md")?.title;
    expect(await title()).toBe("Alpha");
    await writeFile(file, "# Gamma\n"); // same size
    await utimes(file, t1, t1);
    expect(await title()).toBe("Alpha"); // unchanged mtime and size: served from the cache
    const t2 = new Date(2026, 0, 2);
    await utimes(file, t2, t2);
    expect(await title()).toBe("Gamma");
  });
});

describe("remove (trash)", () => {
  it("moves the note to .trash/<relative path>, with a timestamp suffix on a clash", async () => {
    await store.index();
    await store.createSection("Meeting notes", "FastBind");
    const first = await store.create({ section: "Meeting notes/FastBind", title: "Kickoff", body: "one" });
    const index = await store.remove(first.path);
    expect(index.notes).toEqual([]);
    expect(await readFile(at(".trash", "Meeting notes", "FastBind", "2026-10-30-kickoff.md"), "utf8")).toContain("one");

    const second = await store.create({ section: "Meeting notes/FastBind", title: "Kickoff", body: "two" });
    expect(second.path).toBe(first.path);
    clock = new Date(2026, 9, 30, 14, 15, 0);
    await store.remove(second.path);
    const trash = await readdir(at(".trash", "Meeting notes", "FastBind"));
    expect(trash.sort()).toEqual(["2026-10-30-kickoff.20261030-141500.md", "2026-10-30-kickoff.md"]);
    expect(await readFile(at(".trash", "Meeting notes", "FastBind", "2026-10-30-kickoff.20261030-141500.md"), "utf8")).toContain("two");
    await expect(store.remove(second.path)).rejects.toEqual(status(404));
  });
});

describe("sections", () => {
  it("creates top-level and nested sections up to 4 levels", async () => {
    await store.index();
    let index = await store.createSection("", "Work");
    expect(index.sections.map((s) => s.name)).toEqual(["Meeting notes", "Personal notes", "Work"]);
    await store.createSection("Work", "A");
    await store.createSection("Work/A", "B");
    index = await store.createSection("Work/A/B", "C");
    const work = index.sections.find((s) => s.name === "Work")!;
    expect(work.children[0]!.children[0]!.children[0]!.path).toBe("Work/A/B/C");
    await expect(store.createSection("Work/A/B/C", "D")).rejects.toEqual(status(400));
    await expect(store.createSection("Nope", "x")).rejects.toEqual(status(404));
    const deep = await store.create({ section: "Work/A/B/C", title: "Deep" });
    expect(deep.section).toBe("Work/A/B/C");
  });

  it("counts notes per section and refuses a name that is taken by a section or a file (409)", async () => {
    await store.index();
    await store.create({ section: "Meeting notes", title: "One" });
    const index = await store.create({ section: "Meeting notes", title: "Two" }).then(() => store.index());
    expect(index.sections.find((s) => s.name === "Meeting notes")!.noteCount).toBe(2);
    await expect(store.createSection("", "Meeting notes")).rejects.toEqual(status(409));
    await expect(store.createSection("", "meeting NOTES")).rejects.toEqual(process.platform === "win32" ? status(409) : expect.anything());
    await expect(store.createSection("Meeting notes", "2026-10-30-one.md")).rejects.toEqual(status(409));
    for (const name of ["", ".hidden", "a/b", "a\\b", "..", "CON", "trailing.", "x".repeat(81), "bad:name"]) {
      await expect(store.createSection("", name), name).rejects.toEqual(status(400));
    }
  });

  it("renames a section, moving its notes, and refuses a taken name", async () => {
    await store.index();
    await store.create({ section: "Meeting notes", title: "Kickoff" });
    const index = await store.renameSection("Meeting notes", "Meetings");
    expect(index.sections.map((s) => s.name)).toEqual(["Meetings", "Personal notes"]);
    expect(index.notes.map((n) => n.path)).toEqual(["Meetings/2026-10-30-kickoff.md"]);
    await expect(store.renameSection("Meetings", "Personal notes")).rejects.toEqual(status(409));
    await writeFile(at("Taken.md"), "a top-level note");
    await expect(store.renameSection("Meetings", "Taken.md")).rejects.toEqual(status(409));
    await expect(store.renameSection("Gone", "x")).rejects.toEqual(status(404));
    await expect(store.renameSection("", "x")).rejects.toEqual(status(400));
  });

  it("renames by case only on Windows", async () => {
    await store.index();
    const index = await store.renameSection("Personal notes", "Personal Notes");
    expect(index.sections.map((s) => s.name)).toContain("Personal Notes");
  });

  it("deletes only empty sections (409 otherwise) and never their contents", async () => {
    await store.index();
    await store.create({ section: "Meeting notes", title: "Keep" });
    await expect(store.removeSection("Meeting notes")).rejects.toEqual(status(409));
    await store.createSection("Personal notes", "Sub");
    await expect(store.removeSection("Personal notes")).rejects.toEqual(status(409));
    await writeFile(at("Personal notes", "Sub", "photo.png"), "x");
    await expect(store.removeSection("Personal notes/Sub")).rejects.toEqual(status(409));
    expect(await readFile(at("Personal notes", "Sub", "photo.png"), "utf8")).toBe("x");
    await store.createSection("", "Empty");
    const index = await store.removeSection("Empty");
    expect(index.sections.map((s) => s.name)).toEqual(["Meeting notes", "Personal notes"]);
    await expect(store.removeSection("Empty")).rejects.toEqual(status(404));
    expect(await readdir(at("Meeting notes"))).toEqual(["2026-10-30-keep.md"]);
  });
});

describe("recent", () => {
  it("returns notes updated within the window, newest first", async () => {
    await store.index();
    clock = new Date(2026, 9, 1, 9, 0);
    await store.create({ section: "Personal notes", title: "Old" });
    clock = new Date(2026, 9, 20, 9, 0);
    await store.create({ section: "Personal notes", title: "Middle" });
    clock = new Date(2026, 9, 29, 9, 0);
    const newest = await store.create({ section: "Meeting notes", title: "Newest" });
    const recent = await store.recent(14, NOW);
    expect(recent.map((n) => n.title)).toEqual(["Newest", "Middle"]);
    expect((await store.index()).notes.map((n) => n.title)).toEqual(["Newest", "Middle", "Old"]);
    clock = NOW;
    await store.update("Personal notes/2026-10-01-old.md", { body: "touched" });
    expect((await store.recent(14, NOW)).map((n) => n.title)).toEqual(["Old", "Newest", "Middle"]);
    expect(newest.openActions).toBe(0);
  });
});

describe("path confinement", () => {
  it("refuses traversal by text before touching the disk", async () => {
    await store.index();
    await writeFile(path.join(tmp, "vault", "outside.md"), "secret");
    const attempts = [
      "../outside.md",
      "Meeting notes/../../outside.md",
      "./Meeting notes/x.md",
      "Meeting notes/./x.md",
      "/etc/passwd.md",
      "//server/share/x.md",
      "C:/Windows/x.md",
      "c:x.md",
      "C:\\Windows\\x.md",
      "\\\\server\\share\\x.md",
      "Meeting notes\\..\\..\\outside.md",
      "%2e%2e/outside.md",
      "..%2foutside.md",
      "%252e%252e/outside.md",
      ".trash/x.md",
      ".obsidian/x.md",
      "Meeting notes/x.md\u0000.md",
      "Meeting notes/x.md:stream.md",
      "\uff0e\uff0e/outside.md",
      "CON/x.md",
      "Meeting notes/nul.md",
      "Meeting notes//x.md",
      "a/b/c/d/e/x.md",
      "Meeting notes/x.txt",
      "",
    ];
    for (const p of attempts) {
      await expect(store.read(p), p).rejects.toEqual(status(400));
      await expect(store.update(p, { title: "x" }), p).rejects.toEqual(status(400));
      await expect(store.remove(p), p).rejects.toEqual(status(400));
    }
    for (const p of ["..", "../vault", "Meeting notes/..", "/", "C:\\", ".trash", "%2e%2e"]) {
      await expect(store.renameSection(p, "x"), p).rejects.toEqual(status(400));
      await expect(store.removeSection(p), p).rejects.toEqual(status(400));
      await expect(store.createSection(p, "x"), p).rejects.toEqual(status(400));
      await expect(store.create({ section: p, title: "x" }), p).rejects.toEqual(status(400));
    }
    expect(await readFile(path.join(tmp, "vault", "outside.md"), "utf8")).toBe("secret");
    expect(await listAll(path.join(tmp, "vault"))).toEqual(["notes", "notes/Meeting notes", "notes/Personal notes", "outside.md"]);
  });

  it("refuses junctions and symlinks that point outside, by real path", async () => {
    await store.index();
    const outside = path.join(tmp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, at("Escape"), "junction");
    await symlink(outside, at("Personal notes", "Inner"), "junction");

    const index = await store.index();
    expect(index.sections.map((s) => s.name)).toEqual([...DEFAULT_SECTIONS]);
    expect(index.sections.find((s) => s.name === "Personal notes")!.children).toEqual([]);
    for (const p of ["Escape/secret.md", "Personal notes/Inner/secret.md", "Escape/new.md"]) {
      await expect(store.read(p), p).rejects.toEqual(status(400));
      await expect(store.update(p, { body: "pwned" }), p).rejects.toEqual(status(400));
      await expect(store.remove(p), p).rejects.toEqual(status(400));
    }
    await expect(store.create({ section: "Escape", title: "x" })).rejects.toEqual(status(400));
    await expect(store.createSection("Escape", "x")).rejects.toEqual(status(400));
    await expect(store.renameSection("Escape", "x")).rejects.toEqual(status(400));
    await expect(store.removeSection("Escape")).rejects.toEqual(status(400));
    expect(await readdir(outside)).toEqual(["secret.md"]);
    expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe("secret");
  });

  it("refuses to trash into a .trash that points outside", async () => {
    await store.index();
    const outside = path.join(tmp, "outside-trash");
    await mkdir(outside);
    await symlink(outside, at(".trash"), "junction");
    const note = await store.create({ section: "Meeting notes", title: "Stay" });
    await expect(store.remove(note.path)).rejects.toEqual(status(409));
    expect(await readdir(outside)).toEqual([]);
    expect((await store.read(note.path)).title).toBe("Stay");
  });

  it("does not list or follow a file symlink to outside", async (ctx) => {
    await store.index();
    const target = path.join(tmp, "secret.md");
    await writeFile(target, "# Secret");
    try {
      await symlink(target, at("Personal notes", "link.md"), "file");
    } catch {
      ctx.skip(); // file symlinks need Developer Mode or admin on Windows
    }
    expect((await store.index()).notes).toEqual([]);
    await expect(store.read("Personal notes/link.md")).rejects.toEqual(status(400));
    await expect(store.update("Personal notes/link.md", { body: "x" })).rejects.toEqual(status(400));
    expect(await readFile(target, "utf8")).toBe("# Secret");
  });
});

describe("task notes (v1.2)", () => {
  it("only notes under Tasks carry task fields, and a plain update keeps the task_* keys", async () => {
    await mkdir(at("Tasks"), { recursive: true });
    await mkdir(at("Meeting notes"), { recursive: true });
    const keys = "---\ntask_due: 2026-11-02\ntask_done: true\n---\n";
    await writeFile(at("Tasks", "a.md"), `${keys}# A\n`);
    await writeFile(at("Meeting notes", "b.md"), `${keys}# B\n`);
    const index = await store.index();
    const byPath = Object.fromEntries(index.notes.map((n) => [n.path, n as unknown as Record<string, unknown>]));
    expect(byPath["Tasks/a.md"]!.task).toEqual({ due: "2026-11-02", start: null, minutes: null, done: true, source: "me" });
    expect(byPath["Meeting notes/b.md"]).not.toHaveProperty("task");

    // A client patch (no opts) cannot set task fields, and keeps the ones on file.
    const updated = await store.update("Tasks/a.md", { body: "# A\n\nmore", task: { done: false } } as never);
    expect((updated as unknown as { task: unknown }).task).toEqual({ due: "2026-11-02", start: null, minutes: null, done: true, source: "me" });
    expect(await readFile(at("Tasks", "a.md"), "utf8")).toContain("task_due: 2026-11-02\ntask_done: true\n");
  });

  it("creates the Tasks section on first use and names task files by slug only", async () => {
    const note = await store.create(
      { section: "Tasks", title: "Call Ahmed", body: "# Call Ahmed\n" },
      { task: { due: null, start: "09:00", minutes: 15, done: false, source: "ai" }, naming: "slug", ensureSection: true },
    );
    expect(note.path).toBe("Tasks/call-ahmed.md");
    expect(await readFile(at("Tasks", "call-ahmed.md"), "utf8")).toContain('task_start: "09:00"\ntask_minutes: 15\ntask_done: false\ntask_source: ai\n');
    await expect(store.create({ section: "Missing", title: "x" }, { naming: "slug" })).rejects.toMatchObject({ status: 404 });
  });
});

// ---------- v1.4: vaults ----------
// Temp folders stand in for the Learning and QIC Underwriting Agent vaults. The real vaults are never touched.

describe("v1.4 vaults", () => {
  let learning: string;
  let qic: string;
  let logs: string[];
  let vs: NotesStore;
  const L = (...parts: string[]) => path.join(learning, ...parts);
  const Q = (...parts: string[]) => path.join(qic, ...parts);
  const SOURCE = "# Source\n\nVerbatim.\n- [ ] Follow up (keep)\n";
  const refused = expect.objectContaining({ status: 403, message: "This folder is protected by the vault's rules" });
  const specs = (): VaultConfig[] => [
    { id: "notes", label: "Working-With-Claude notes", prefix: "", dir, readOnlyFolders: [] },
    { id: "learning", label: "Learning", prefix: "@learning/", dir: learning, readOnlyFolders: ["raw"] },
    { id: "qic-uw", label: "QIC Underwriting Agent", prefix: "@qic-uw/", dir: qic, readOnlyFolders: ["sources/", "project/P&C/docs"] },
  ];
  const put = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  /** Every section path with its readOnly flag, depth first. */
  const flat = (list: NoteSection[]): [string, boolean][] =>
    list.flatMap((s) => [[s.path, s.readOnly === true] as [string, boolean], ...flat(s.children)]);
  const pathsOf = (index: NotesIndex, vault: string) =>
    index.notes
      .filter((n) => n.vault === vault)
      .map((n) => n.path)
      .sort();

  beforeEach(async () => {
    learning = path.join(tmp, "Learning");
    qic = path.join(tmp, "QIC_Underwriting_Agent");
    await put(L("index.md"), "# Learning index\n");
    await put(L("wiki", "ai-engineering", "rag.md"), "---\ntitle: RAG notes\nupdated: 2026-10-29T09:00:00+03:00\n---\nRetrieval first.\n- [ ] Read the eval paper\n");
    await put(L("raw", "notes", "source.md"), SOURCE);
    await put(Q("sources", "policy.md"), "# Policy\n");
    await put(Q("project", "P&C", "docs", "spec.md"), "# Spec\n");
    await put(Q("project", "P&C", "plan.md"), "# Plan\n");
    await put(Q("wiki", "glossary.md"), "# Glossary\n");
    logs = [];
    vs = createNotesStore(dir, { now: () => clock, vaults: specs(), log: (line) => logs.push(line) });
  });

  it("config builds the three vaults, default first, with env overrides, and presentVaults keeps existing folders", () => {
    const home = path.join(tmp, "home");
    const mdFiles = path.join(home, "Desktop", "MD Files");
    const c = loadConfig({}, { rootDir: tmp, home });
    expect(c.vaults).toEqual([
      { id: "notes", label: "Working-With-Claude notes", prefix: "", dir: path.join(mdFiles, "Working-With-Claude", "notes"), readOnlyFolders: [] },
      { id: "learning", label: "Learning", prefix: "@learning/", dir: path.join(mdFiles, "Learning"), readOnlyFolders: ["raw"] },
      {
        id: "qic-uw",
        label: "QIC Underwriting Agent",
        prefix: "@qic-uw/",
        dir: path.join(mdFiles, "QIC_Underwriting_Agent"),
        readOnlyFolders: ["sources", "project/P&C/docs"],
      },
    ]);
    expect(c.vaults[0]!.dir).toBe(c.notesDir);
    expect(c.vaults[1]!.dir).toBe(c.learningDir);
    const o = loadConfig({ NOTES_DIR: path.join(tmp, "n"), LEARNING_DIR: learning, QIC_UW_DIR: "~/qic" }, { rootDir: tmp, home });
    expect(o.vaults.map((v) => v.dir)).toEqual([path.join(tmp, "n"), learning, path.join(home, "qic")]);
    expect(presentVaults(o.vaults).map((v) => v.id)).toEqual(["learning"]);
  });

  it("indexes every vault: default first, one top section per extra vault, vault and readOnly on every note", async () => {
    await store.index(); // first run creates the default sections
    await vs.create({ section: "Meeting notes", title: "Standup" });
    const index = await vs.index();
    expect(index.status).toBe("ok");
    expect(index.message).toBeUndefined();
    expect(index.dir).toBe(path.resolve(dir));
    expect(index.vaults).toEqual([
      { id: "notes", label: "Working-With-Claude notes", prefix: "", dir: path.resolve(dir), readOnlyFolders: [], noteCount: 1 },
      { id: "learning", label: "Learning", prefix: "@learning/", dir: learning, readOnlyFolders: ["raw"], noteCount: 3 },
      { id: "qic-uw", label: "QIC Underwriting Agent", prefix: "@qic-uw/", dir: qic, readOnlyFolders: ["sources", "project/P&C/docs"], noteCount: 4 },
    ]);
    expect(index.sections.map((s) => [s.path, s.name, s.noteCount])).toEqual([
      ["Meeting notes", "Meeting notes", 1],
      ["Personal notes", "Personal notes", 0],
      ["@learning", "Learning", 1],
      ["@qic-uw", "QIC Underwriting Agent", 0],
    ]);
    expect(index.sections[0]).not.toHaveProperty("readOnly");
    expect(flat(index.sections.slice(2))).toEqual([
      ["@learning", false],
      ["@learning/raw", true],
      ["@learning/raw/notes", true],
      ["@learning/wiki", false],
      ["@learning/wiki/ai-engineering", false],
      ["@qic-uw", false],
      ["@qic-uw/project", false],
      ["@qic-uw/project/P&C", false],
      ["@qic-uw/project/P&C/docs", true],
      ["@qic-uw/sources", true],
      ["@qic-uw/wiki", false],
    ]);
    const byPath = new Map(index.notes.map((n) => [n.path, n]));
    expect(byPath.get("Meeting notes/2026-10-30-standup.md")).toMatchObject({ section: "Meeting notes", vault: "notes", readOnly: false });
    expect(byPath.get("@learning/index.md")).toMatchObject({ section: "@learning", title: "Learning index", vault: "learning", readOnly: false });
    expect(byPath.get("@learning/wiki/ai-engineering/rag.md")).toMatchObject({
      section: "@learning/wiki/ai-engineering",
      title: "RAG notes",
      openActions: 1,
      vault: "learning",
      readOnly: false,
    });
    expect(byPath.get("@learning/raw/notes/source.md")).toMatchObject({ section: "@learning/raw/notes", vault: "learning", readOnly: true });
    expect(byPath.get("@qic-uw/sources/policy.md")).toMatchObject({ vault: "qic-uw", readOnly: true });
    expect(byPath.get("@qic-uw/project/P&C/docs/spec.md")).toMatchObject({ readOnly: true });
    expect(byPath.get("@qic-uw/project/P&C/plan.md")).toMatchObject({ readOnly: false });
    expect(index.notes).toHaveLength(8);
    for (const n of index.notes) expect(typeof n.vault === "string" && typeof n.readOnly === "boolean").toBe(true);
  });

  it("never lists dot folders, Excalidraw, *.excalidraw.md, other files or links; extra vaults accept dashes and brackets", async () => {
    await put(L(".obsidian", "workspace.md"), "x");
    await put(L(".claude", "agent.md"), "x");
    await put(L(".trash", "old.md"), "x");
    await put(L("Excalidraw", "drawing.md"), "x");
    await put(L("wiki", "diagram.excalidraw.md"), "x");
    await put(L("wiki", "Brain.canvas"), "{}");
    await put(L("wiki", "photo.png"), "x");
    await put(L("wiki", "a@b", "x.md"), "x"); // "@" is never part of a name
    await put(L("wiki", "assemble.py \u2014 the pricing path.md"), "# Pricing\n");
    await put(L("wiki", "Course [2025] Labs!.md"), "# Course\n");
    await put(path.join(tmp, "outside", "secret.md"), "secret");
    await symlink(path.join(tmp, "outside"), L("wiki", "linked"), "junction");
    await put(at("Personal notes", "dash \u2014 note.md"), "x"); // the default vault keeps the strict names
    const index = await vs.index();
    expect(pathsOf(index, "learning")).toEqual(
      [
        "@learning/index.md",
        "@learning/raw/notes/source.md",
        "@learning/wiki/ai-engineering/rag.md",
        "@learning/wiki/assemble.py \u2014 the pricing path.md",
        "@learning/wiki/Course [2025] Labs!.md",
      ].sort(),
    );
    expect(pathsOf(index, "notes")).toEqual([]);
    const wiki = index.sections.find((s) => s.path === "@learning")!.children.find((s) => s.name === "wiki")!;
    expect(wiki.children.map((s) => s.name)).toEqual(["ai-engineering"]);
    expect(index.message).toMatch(/^2 items are not shown/); // a@b and the default vault's dash note
    expect((await vs.read("@learning/wiki/assemble.py \u2014 the pricing path.md")).title).toBe("Pricing");
    await expect(vs.read("Personal notes/dash \u2014 note.md")).rejects.toEqual(status(400));
  });

  it("routes @<id>/ to its vault, refuses unknown prefixes and never crosses a vault by text", async () => {
    await vs.index();
    expect((await vs.read("@learning/wiki/ai-engineering/rag.md")).title).toBe("RAG notes");
    expect((await vs.read("@qic-uw/wiki/glossary.md")).vault).toBe("qic-uw");
    const attempts = [
      "@nope/x.md",
      "@/x.md",
      "@Learning/index.md",
      "@learning",
      "@learning/",
      "@learning//index.md",
      "@learning/../vault/notes/Meeting notes/x.md",
      "@learning/wiki/../../QIC_Underwriting_Agent/wiki/glossary.md",
      "@qic-uw/../Learning/index.md",
      "@learning/./index.md",
      "@learning/C:/x.md",
      "@learning/\\..\\index.md",
      "@learning/%2e%2e/index.md",
      "@learning/.obsidian/x.md",
      "@learning/.trash/x.md",
      "@learning/wiki/x.md:stream.md",
      "@learning@qic-uw/index.md",
      "@@learning/index.md",
      "@learning/a/b/c/d/e/x.md",
      "Meeting notes/@learning/x.md",
      "../Learning/index.md",
    ];
    for (const p of attempts) {
      await expect(vs.read(p), p).rejects.toEqual(status(400));
      await expect(vs.update(p, { title: "x" }), p).rejects.toEqual(status(400));
      await expect(vs.remove(p), p).rejects.toEqual(status(400));
    }
    for (const p of ["@nope", "@learning/", "@learning/..", "@learning/../QIC_Underwriting_Agent", "@qic-uw/.trash", "@learning/wiki/a@b"]) {
      await expect(vs.createSection(p, "x"), p).rejects.toEqual(status(400));
      await expect(vs.renameSection(p, "x"), p).rejects.toEqual(status(400));
      await expect(vs.removeSection(p), p).rejects.toEqual(status(400));
      await expect(vs.create({ section: p, title: "x" }), p).rejects.toEqual(status(400));
    }
    await expect(vs.renameSection("@learning", "x")).rejects.toEqual(status(400));
    await expect(vs.removeSection("@qic-uw")).rejects.toEqual(status(400));
    await expect(vs.read("@learning/wiki/missing.md")).rejects.toEqual(status(404));
    expect(await listAll(qic)).toEqual([
      "project",
      "project/P&C",
      "project/P&C/docs",
      "project/P&C/docs/spec.md",
      "project/P&C/plan.md",
      "sources",
      "sources/policy.md",
      "wiki",
      "wiki/glossary.md",
    ]);
  });

  it("confines each vault to its own real folder: links into another vault or outside are refused", async () => {
    await vs.index();
    await symlink(qic, L("wiki", "to-qic"), "junction");
    await symlink(dir, L("wiki", "to-notes"), "junction");
    for (const p of ["@learning/wiki/to-qic/wiki/glossary.md", "@learning/wiki/to-notes/Meeting notes/x.md", "@learning/wiki/to-qic/new.md"]) {
      await expect(vs.read(p), p).rejects.toEqual(status(400));
      await expect(vs.update(p, { body: "pwned" }), p).rejects.toEqual(status(400));
      await expect(vs.remove(p), p).rejects.toEqual(status(400));
    }
    await expect(vs.create({ section: "@learning/wiki/to-qic", title: "x" })).rejects.toEqual(status(400));
    await expect(vs.createSection("@learning/wiki/to-qic", "x")).rejects.toEqual(status(400));
    await expect(vs.renameSection("@learning/wiki/to-qic", "x")).rejects.toEqual(status(400));
    expect(await readFile(Q("wiki", "glossary.md"), "utf8")).toBe("# Glossary\n");
    expect(await listAll(Q("wiki"))).toEqual(["glossary.md"]);
  });

  it("refuses every write in a read-only folder with 403 and the vault's rule, but reads it", async () => {
    await vs.index();
    const src = "@learning/raw/notes/source.md";
    expect(await vs.read(src)).toMatchObject({ readOnly: true, vault: "learning", body: SOURCE });
    await expect(vs.create({ section: "@learning/raw", title: "x" })).rejects.toEqual(refused);
    await expect(vs.create({ section: "@learning/raw/notes", title: "x", template: "meeting" })).rejects.toEqual(refused);
    await expect(vs.update(src, { body: "changed" })).rejects.toEqual(refused);
    await expect(vs.update("@learning/RAW/notes/source.md", { title: "x" })).rejects.toEqual(refused);
    await expect(vs.update(src, {}, { task: { done: true } })).rejects.toEqual(refused);
    await expect(vs.remove(src)).rejects.toEqual(refused);
    await expect(vs.createSection("@learning/raw", "new")).rejects.toEqual(refused);
    await expect(vs.createSection("@learning", "raw")).rejects.toEqual(refused);
    await expect(vs.renameSection("@learning/raw/notes", "moved")).rejects.toEqual(refused);
    await expect(vs.renameSection("@learning/raw", "old-raw")).rejects.toEqual(refused);
    await expect(vs.renameSection("@learning/wiki", "raw")).rejects.toEqual(refused);
    await mkdir(L("raw", "empty"));
    await expect(vs.removeSection("@learning/raw/empty")).rejects.toEqual(refused);
    // QIC: sources/ and project/P&C/docs/ are protected; their parent folders only against rename and delete.
    await expect(vs.update("@qic-uw/sources/policy.md", { body: "x" })).rejects.toEqual(refused);
    await expect(vs.update("@qic-uw/project/P&C/docs/spec.md", { body: "x" })).rejects.toEqual(refused);
    await expect(vs.create({ section: "@qic-uw/project/P&C/docs", title: "x" })).rejects.toEqual(refused);
    await expect(vs.renameSection("@qic-uw/project", "proj")).rejects.toEqual(refused);
    await expect(vs.renameSection("@qic-uw/project/P&C", "PC")).rejects.toEqual(refused);
    await expect(vs.removeSection("@qic-uw/project/P&C")).rejects.toEqual(refused);
    expect((await vs.update("@qic-uw/project/P&C/plan.md", { body: "# Plan\n\nUpdated.\n" })).readOnly).toBe(false);
    expect(await vs.create({ section: "@qic-uw/project", title: "Next steps" })).toMatchObject({
      path: "@qic-uw/project/2026-10-30-next-steps.md",
      section: "@qic-uw/project",
      vault: "qic-uw",
      readOnly: false,
    });
    // Nothing under the protected folders changed, and nothing went to a trash.
    expect(await readFile(L("raw", "notes", "source.md"), "utf8")).toBe(SOURCE);
    expect(await listAll(L("raw"))).toEqual(["empty", "notes", "notes/source.md"]);
    expect(await listAll(Q("sources"))).toEqual(["policy.md"]);
    expect(await listAll(Q("project", "P&C", "docs"))).toEqual(["spec.md"]);
    expect(await readFile(Q("project", "P&C", "docs", "spec.md"), "utf8")).toBe("# Spec\n");
    await expect(stat(L(".trash"))).rejects.toThrow();
    await expect(stat(Q(".trash"))).rejects.toThrow();
    expect(PROTECTED_MESSAGE).toBe("This folder is protected by the vault's rules");
  });

  it("a link inside the vault cannot reach a read-only folder", async () => {
    await vs.index();
    await symlink(L("raw"), L("wiki", "raw-link"), "junction");
    expect(pathsOf(await vs.index(), "learning")).not.toContain("@learning/wiki/raw-link/notes/source.md");
    const p = "@learning/wiki/raw-link/notes/source.md";
    expect((await vs.read(p)).readOnly).toBe(true);
    await expect(vs.update(p, { body: "changed" })).rejects.toEqual(refused);
    await expect(vs.remove(p)).rejects.toEqual(refused);
    await expect(vs.create({ section: "@learning/wiki/raw-link/notes", title: "x" })).rejects.toEqual(refused);
    await expect(vs.createSection("@learning/wiki/raw-link", "x")).rejects.toEqual(refused);
    await expect(vs.renameSection("@learning/wiki/raw-link/notes", "x")).rejects.toEqual(refused);
    await expect(vs.removeSection("@learning/wiki/raw-link/notes")).rejects.toEqual(refused);
    expect(await readFile(L("raw", "notes", "source.md"), "utf8")).toBe(SOURCE);
    expect(await listAll(L("raw"))).toEqual(["notes", "notes/source.md"]);
  });

  it("deleting moves the note to its own vault's .trash, keeping its relative path", async () => {
    await vs.index();
    await vs.remove("@learning/wiki/ai-engineering/rag.md");
    await vs.remove("@qic-uw/wiki/glossary.md");
    expect(await readFile(L(".trash", "wiki", "ai-engineering", "rag.md"), "utf8")).toContain("Retrieval first.");
    expect(await readFile(Q(".trash", "wiki", "glossary.md"), "utf8")).toBe("# Glossary\n");
    await expect(stat(at(".trash"))).rejects.toThrow();
    const index = await vs.index();
    expect(pathsOf(index, "learning")).toEqual(["@learning/index.md", "@learning/raw/notes/source.md"]);
    expect(index.vaults.find((v) => v.id === "qic-uw")!.noteCount).toBe(3);
    // A clash in the trash gets a timestamp suffix, as in the default vault.
    await put(L("wiki", "ai-engineering", "rag.md"), "second");
    clock = new Date(2026, 9, 30, 14, 15, 0);
    await vs.remove("@learning/wiki/ai-engineering/rag.md");
    expect((await readdir(L(".trash", "wiki", "ai-engineering"))).sort()).toEqual(["rag.20261030-141500.md", "rag.md"]);
    await expect(vs.remove("@learning/wiki/ai-engineering/rag.md")).rejects.toEqual(status(404));
  });

  it("creates, edits, renames and deletes notes and folders in a vault, at its top folder too, with templates", async () => {
    await vs.index();
    const top = await vs.create({ section: "@learning", title: "Weekly review", template: "meeting" });
    expect(top).toMatchObject({ path: "@learning/2026-10-30-weekly-review.md", section: "@learning", vault: "learning", readOnly: false });
    expect(top.body).toBe(TEMPLATES.meeting);
    expect(await readFile(L("2026-10-30-weekly-review.md"), "utf8")).toContain("title: Weekly review");
    let index = await vs.createSection("@learning", "Projects");
    expect(index.sections.find((s) => s.path === "@learning")!.children.map((s) => s.path)).toContain("@learning/Projects");
    await vs.createSection("@learning/Projects", "Dashboard");
    const inner = await vs.create({ section: "@learning/Projects/Dashboard", title: "Ideas", body: "one" });
    expect(inner.path).toBe("@learning/Projects/Dashboard/2026-10-30-ideas.md");
    const edited = await vs.update(inner.path, { title: "Better ideas", projectId: "life-dashboard", tags: ["ideas"] });
    expect(edited).toMatchObject({ title: "Better ideas", projectId: "life-dashboard", tags: ["ideas"], body: "one", vault: "learning" });
    index = await vs.renameSection("@learning/Projects/Dashboard", "Board");
    expect(pathsOf(index, "learning")).toContain("@learning/Projects/Board/2026-10-30-ideas.md");
    await vs.remove("@learning/Projects/Board/2026-10-30-ideas.md");
    index = await vs.removeSection("@learning/Projects/Board");
    expect(flat(index.sections).map(([p]) => p)).not.toContain("@learning/Projects/Board");
    await expect(vs.create({ section: "@qic-uw/missing", title: "x" })).rejects.toEqual(status(404));
    await expect(vs.createSection("@learning", "Bad \u2014 name")).rejects.toEqual(status(400)); // new names stay strict
  });

  it("keeps same-named notes in different vaults apart, reads Arabic names, caps huge notes, and keeps tasks in the default vault", async () => {
    await vs.index();
    const arabicName = "\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0627\u0644\u0623\u0633\u0628\u0648\u0639";
    const arabicTitle = "\u0645\u0644\u0627\u062d\u0638\u0627\u062a";
    const arabicText = "\u0646\u0635 \u0639\u0631\u0628\u064a";
    await put(at("Meeting notes", "same.md"), "# Default copy\n");
    await put(L("Meeting notes", "same.md"), "# Learning copy\n");
    await put(L("wiki", `${arabicName}.md`), `# ${arabicTitle}\n\n${arabicText}.\n`);
    await put(L("wiki", "huge.md"), `# Huge\n\n${"x".repeat(300 * KB)}\n`);
    await put(L("Tasks", "t.md"), "---\ntask_due: 2026-11-02\n---\n# T\n");
    const index = await vs.index();
    const byPath = new Map(index.notes.map((n) => [n.path, n]));
    expect(byPath.get("Meeting notes/same.md")).toMatchObject({ title: "Default copy", vault: "notes" });
    expect(byPath.get("@learning/Meeting notes/same.md")).toMatchObject({ title: "Learning copy", vault: "learning", section: "@learning/Meeting notes" });
    await vs.update("@learning/Meeting notes/same.md", { body: "# Learning copy\n\nchanged\n" });
    expect(await readFile(at("Meeting notes", "same.md"), "utf8")).toBe("# Default copy\n");
    expect((await vs.index()).notes.find((n) => n.path === "Meeting notes/same.md")!.title).toBe("Default copy");
    const arabic = `@learning/wiki/${arabicName}.md`;
    expect(byPath.get(arabic)).toMatchObject({ title: arabicTitle, vault: "learning" });
    expect(byPath.get(arabic)!.excerpt).toContain(arabicText);
    expect((await vs.read(arabic)).body).toContain(arabicText);
    expect(byPath.get("@learning/wiki/huge.md")).toMatchObject({ title: "huge", excerpt: "", vault: "learning" });
    await expect(vs.read("@learning/wiki/huge.md")).rejects.toEqual(status(413));
    expect(byPath.get("@learning/Tasks/t.md")).not.toHaveProperty("task");
  });

  it("leaves out a vault whose folder is missing or deleted while running, logs it once, and takes it back", async () => {
    expect((await vs.index()).vaults.map((v) => v.id)).toEqual(["notes", "learning", "qic-uw"]);
    await rm(learning, { recursive: true, force: true });
    const gone = await vs.index();
    expect(gone.status).toBe("ok");
    expect(gone.vaults.map((v) => v.id)).toEqual(["notes", "qic-uw"]);
    expect(gone.sections.map((s) => s.path)).toEqual(["Meeting notes", "Personal notes", "@qic-uw"]);
    expect(gone.notes.some((n) => n.vault === "learning")).toBe(false);
    await vs.index();
    expect(logs).toEqual([`[notes] Learning vault left out: folder not found: ${learning}`]);
    await expect(vs.read("@learning/index.md")).rejects.toEqual(status(404));
    await expect(vs.create({ section: "@learning", title: "x" })).rejects.toEqual(status(404));
    await expect(vs.createSection("@learning", "x")).rejects.toEqual(status(404));
    await expect(stat(learning)).rejects.toThrow(); // nothing recreated it
    await put(L("back.md"), "# Back\n");
    expect(pathsOf(await vs.index(), "learning")).toEqual(["@learning/back.md"]);
    expect(logs.at(-1)).toBe(`[notes] Learning vault found again: ${learning}`);
  });

  it("leaves out vaults with a bad id or prefix, a repeated id or an overlapping folder, with a log line", async () => {
    const lines: string[] = [];
    const s = createNotesStore(dir, {
      log: (line) => lines.push(line),
      vaults: [
        { id: "Bad", label: "Bad", prefix: "@Bad/", dir: learning, readOnlyFolders: [] },
        { id: "learning", label: "Learning", prefix: "@learn/", dir: learning, readOnlyFolders: [] },
        { id: "inner", label: "Inner", prefix: "@inner/", dir: path.join(dir, "Meeting notes"), readOnlyFolders: [] },
        { id: "qic-uw", label: "QIC", prefix: "@qic-uw/", dir: qic, readOnlyFolders: [] },
        { id: "qic-uw", label: "QIC again", prefix: "@qic-uw/", dir: path.join(tmp, "other"), readOnlyFolders: [] },
      ],
    });
    expect((await s.index()).vaults.map((v) => v.id)).toEqual(["notes", "qic-uw"]);
    expect(lines).toHaveLength(4);
    await expect(s.read("@learning/index.md")).rejects.toEqual(status(400));
    await expect(s.read("@learn/index.md")).rejects.toEqual(status(400));
  });

  it("Jira write-back into a read-only note fails with the vault's rule and still names the keys", async () => {
    await vs.index();
    const src = "@learning/raw/notes/source.md";
    const body = (await vs.read(src)).body;
    const action = detectActions(body)[0]!;
    const edits = [{ actionId: action.id, line: action.line, key: "AN-4602" }];
    const result = await writeBack(vs, src, body, edits);
    expect(result).toEqual({ status: "error", reason: "This folder is protected by the vault's rules" });
    expect(writeBackFailure(result, edits)).toEqual({
      draftId: "write-back",
      error: "Created in Jira: AN-4602. This note is in a protected folder, so the keys were not written into it.",
    });
    expect(await readFile(L("raw", "notes", "source.md"), "utf8")).toBe(SOURCE);
  });

  it("indexes about 1,500 notes across vaults in under 2 s cold and 200 ms warm (mtime cache)", async () => {
    const files: [string, string][] = [];
    const text = (i: number) =>
      `---\ntitle: Note ${i}\ntags: [ai, notes]\n---\n# Note ${i}\n\nSome text about topic ${i % 25}, with a [[link]].\n- [ ] Action ${i}\n`;
    for (let i = 0; i < 1000; i++) files.push([L("wiki", `topic-${i % 25}`, `note-${i}.md`), text(i)]);
    for (let i = 0; i < 400; i++) files.push([Q("wiki", `area-${i % 10}`, `note-${i}.md`), text(i)]);
    for (let i = 0; i < 100; i++) files.push([at("Meeting notes", `note-${i}.md`), text(i)]);
    for (let i = 0; i < files.length; i += 100) await Promise.all(files.slice(i, i + 100).map(([f, t]) => put(f, t)));
    // Cold = a new store (empty mtime cache); warm = the same store again. Alone this takes about 0.2 s
    // cold and 0.05 s warm, but the full suite runs ~57 test files in parallel and antivirus scans the
    // just-written files, so a busy machine gets up to 4 attempts, 1 s apart, and the best one counts.
    let best = { coldMs: Infinity, warmMs: Infinity };
    for (let attempt = 0; attempt < 4 && (best.coldMs >= 2000 || best.warmMs >= 200); attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      const fresh = createNotesStore(dir, { vaults: specs(), log: () => undefined });
      let started = performance.now();
      const cold = await fresh.index();
      const coldMs = performance.now() - started;
      expect(cold.notes.length).toBe(1507);
      let warmMs = Infinity;
      for (let run = 0; run < 5; run++) {
        started = performance.now();
        const warm = await fresh.index();
        warmMs = Math.min(warmMs, performance.now() - started);
        expect(warm.notes).toEqual(cold.notes);
      }
      console.log(`[T33 timing] attempt ${attempt + 1}: ${cold.notes.length} notes in 3 vaults, cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);
      best = { coldMs: Math.min(best.coldMs, coldMs), warmMs: Math.min(best.warmMs, warmMs) };
    }
    expect(best.coldMs).toBeLessThan(2000);
    expect(best.warmMs).toBeLessThan(200);
  }, 60_000);
});
