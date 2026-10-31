import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotesStore, DEFAULT_SECTIONS, slugify, TEMPLATES, type NotesStore } from "./notes";
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
