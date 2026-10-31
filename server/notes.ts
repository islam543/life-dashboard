import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import type { Note, NoteMeta, NoteSection, NotesIndex, NoteTemplate, TaskInfo, TaskNote } from "../shared/types";
import {
  excerptOf,
  fieldLine,
  firstHeading,
  formatLocalIso,
  isValidTag,
  localDateKey,
  openActionLines,
  parseNoteFile,
  readFields,
  readTaskFields,
  serializeNoteFile,
  setEntry,
  setTaskEntries,
  withFirstHeading,
  type FrontmatterEntry,
  type ParsedNoteFile,
} from "./notesFrontmatter";

// Notes store: markdown files under NOTES_DIR (docs/ARCHITECTURE.md "v1.1: Project tracker and notes").
//
// NOTES_DIR is Islam's real Obsidian vault, so every rule below protects existing writing:
// - Paths in and out are relative to NOTES_DIR, posix ("Meeting notes/2026-10-30-review.md").
//   Every client path is checked twice: by its text (no "..", no absolute or drive paths, no
//   backslashes, no "%", no dot-names, names max 80 chars from [\p{L}\p{M}\p{N} _.,()&'-]) and by
//   the real path on disk (realpath of the target, or of its deepest existing folder, must sit
//   inside the realpath of NOTES_DIR, case-insensitive on Windows), so junctions and symlinks
//   pointing outside are refused. Both refusals are 400.
// - Nothing is ever hard-deleted: a deleted note moves to NOTES_DIR/.trash/<its relative path>;
//   a section is removed with rmdir, which only ever removes an empty folder.
// - Writes are atomic: a dot-named temp file in the same folder, fsync, then rename over the target.
// - Mutations (and index reads) run one at a time per store.
// - Errors the client should see are HTTPException 400, 404, 409 or 413 with a plain message;
//   app.ts turns them into an ApiError. Anything else becomes a logged 500.
// - index() status: "ok" when the folder was read. NOTES_DIR missing and its parent missing too
//   (vault not on this PC): create nothing, "not_connected" naming the folder. Only NOTES_DIR
//   missing, or NOTES_DIR empty: create it with the default sections. "error" when reading fails.
// - Clock: `opts.now` (default the real clock) for created/updated stamps and file names.
// - Creating the store does not touch the disk; work starts on the first method call.
// - v1.2 task notes: every note under the Tasks section carries `task: TaskInfo` (read from the
//   task_* keys) in its NoteMeta, so it is a TaskNote at runtime. Only the server writes task_*
//   keys, through the `opts` argument of create and update (server/schedule.ts); the /api/notes
//   routes never pass it, so a client body cannot set them. Other notes have no `task` key.

/** Body of POST /api/notes after validation. */
export interface NewNoteInput {
  /** Section folder path relative to NOTES_DIR, for example "Meeting notes" or "Meeting notes/FastBind". */
  section: string;
  title: string;
  /** Initial markdown. When missing, the template's body is used. */
  body?: string;
  projectId?: string | null;
  tags?: string[];
  /** Default "blank". */
  template?: NoteTemplate;
}

/** Body of PUT /api/notes/file?path= after validation. Only the given fields change. */
export interface NotePatch {
  title?: string;
  body?: string;
  projectId?: string | null;
  tags?: string[];
}

/** Server-only extras for create (task notes). Never built from a client body. */
export interface NoteCreateOptions {
  /** task_* keys to write. */
  task?: TaskInfo;
  /** "dated" (default): `YYYY-MM-DD-<slug>.md`. "slug": `<slug>.md`, then `<slug>-2.md` and so on. */
  naming?: "dated" | "slug";
  /** Create the section folder when it is missing (the Tasks section on first use). */
  ensureSection?: boolean;
}

/** Server-only extras for update (task notes). Never built from a client body. */
export interface NoteUpdateOptions {
  /** task_* keys to change; keys left out keep their lines. With this set, the patch may be empty. */
  task?: Partial<TaskInfo>;
  /** When the patch has a title, also set the body's first `# ` heading to it. */
  heading?: boolean;
}

export interface NotesStore {
  /** Every section (tree) and every note's metadata. Never throws for a missing folder; see status. */
  index(): Promise<NotesIndex>;
  /** One note with its body. 404 HTTPException when it does not exist. */
  read(path: string): Promise<Note>;
  /** Writes a new `YYYY-MM-DD-<slug>.md` in `input.section` (or `<slug>.md`, see NoteCreateOptions). */
  create(input: NewNoteInput, opts?: NoteCreateOptions): Promise<Note>;
  /** Rewrites the note's frontmatter and body; `updated` is bumped. */
  update(path: string, patch: NotePatch, opts?: NoteUpdateOptions): Promise<Note>;
  /** Moves the note into NOTES_DIR/.trash (never a hard delete). */
  remove(path: string): Promise<NotesIndex>;
  /** New folder `name` inside `parent` ("" for top level). */
  createSection(parent: string, name: string): Promise<NotesIndex>;
  /** Renames the folder at `path` to `name` (same parent). */
  renameSection(path: string, name: string): Promise<NotesIndex>;
  /** Deletes an empty section folder; 409 HTTPException when it holds notes or subsections. */
  removeSection(path: string): Promise<NotesIndex>;
  /** Notes updated within the last `days` days before `now`, newest first. */
  recent(days: number, now: Date): Promise<NoteMeta[]>;
}

export interface NotesStoreOptions {
  /** Clock for created/updated stamps. Default: the real clock. */
  now?: () => Date;
}

/** The error an unbuilt method throws; app.ts answers it as 501 { error: "Not built yet" }. */
export function notBuilt(): HTTPException {
  return new HTTPException(501, { message: "Not built yet" });
}

// ---------- limits and templates ----------

export const MAX_NOTE_BODY_BYTES = 200 * 1024;
/** A file may hold a 200 KB body plus its frontmatter. */
const MAX_NOTE_FILE_BYTES = MAX_NOTE_BODY_BYTES + 16 * 1024;
export const MAX_SECTION_DEPTH = 4;
export const MAX_NAME_CHARS = 80;
export const MAX_TITLE_CHARS = 120;
export const MAX_TAGS = 10;
/** Keeps `YYYY-MM-DD-<slug>-NNN.md` within MAX_NAME_CHARS. */
const MAX_SLUG_CHARS = 60;
const MAX_PATH_CHARS = 1024;
export const DEFAULT_SECTIONS = ["Meeting notes", "Personal notes"] as const;
export const TRASH_DIR = ".trash";
/** The section holding task notes (docs/ARCHITECTURE.md "Task notes"); created on first use. */
export const TASKS_SECTION = "Tasks";

/** True for a note path under the Tasks section (any depth). Case-insensitive, like Windows folders. */
export function isTaskPath(rel: string): boolean {
  return rel.toLowerCase().startsWith(`${TASKS_SECTION.toLowerCase()}/`);
}
const DAY_MS = 24 * 60 * 60 * 1000;

export const TEMPLATES: Record<NoteTemplate, string> = {
  blank: "",
  meeting: "## Attendees\n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Action items\n\n- [ ] \n",
  personal: "## Notes\n",
};

// ---------- validation ----------

const badRequest = (message: string) => new HTTPException(400, { message });
const notFound = (message: string) => new HTTPException(404, { message });
const conflict = (message: string) => new HTTPException(409, { message });
const bodyTooLarge = () => new HTTPException(413, { message: "Note body is larger than 200 KB" });
const fileTooLarge = () =>
  new HTTPException(413, { message: "This note is larger than 200 KB, so the dashboard will not open it. Open it in Obsidian." });

const OUTSIDE = "Path must stay inside the notes folder";
const NAME_CHARS = /^[\p{L}\p{M}\p{N} _.,()&'-]+$/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const PROJECT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u;
const NOTE_FILE = /\.md$/i;
const CONTROL = /\p{Cc}/u;
const charCount = (s: string) => [...s].length;

/** Why a file or folder name is not allowed (a sentence ending), or null when it is fine. */
export function nameProblem(name: string): string | null {
  if (name === "") return "is empty";
  if (charCount(name) > MAX_NAME_CHARS) return `is longer than ${MAX_NAME_CHARS} characters`;
  if (name.startsWith(".")) return "starts with a dot";
  if (!NAME_CHARS.test(name)) return "may only use letters, numbers, spaces and _ . , ( ) & ' -";
  if (/[. ]$/.test(name)) return "ends with a dot or a space";
  if (WINDOWS_DEVICE.test(name.split(".")[0]!.trim())) return "is a name Windows reserves";
  return null;
}

type PathKind = "note" | "section" | "parent";

/** Checks a client path by its text and returns its segments. Throws 400. */
export function parsePath(input: unknown, kind: PathKind): string[] {
  const what = kind === "note" ? "Note path" : "Section path";
  if (typeof input !== "string") throw badRequest(`${what} is required`);
  if (input === "") {
    if (kind === "parent") return [];
    throw badRequest(`${what} is required`);
  }
  if (input.length > MAX_PATH_CHARS) throw badRequest(`${what} is too long`);
  if (input.includes("\\")) throw badRequest("Use / in paths, not \\");
  if (CONTROL.test(input)) throw badRequest(`${what} has control characters`);
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) throw badRequest(OUTSIDE);
  if (input.includes("%")) throw badRequest(`${what} must not be URL-encoded twice`);
  const segs = input.split("/");
  if (segs.some((s) => s === "." || s === "..")) throw badRequest(OUTSIDE);
  for (const seg of segs) {
    const problem = nameProblem(seg);
    if (problem) throw badRequest(`A name in the path ${problem}`);
  }
  const folders = kind === "note" ? segs.length - 1 : segs.length;
  if (folders > MAX_SECTION_DEPTH) throw badRequest(`Sections can be nested at most ${MAX_SECTION_DEPTH} levels deep`);
  if (kind === "note" && !NOTE_FILE.test(segs.at(-1)!)) throw badRequest("Note path must end in .md");
  return segs;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Body must be a JSON object");
  return value as Record<string, unknown>;
}

/** A note title: one line, 1 to 120 characters after trimming. Throws 400. */
export function checkTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title === "" || charCount(title) > MAX_TITLE_CHARS) throw badRequest(`Title must be 1 to ${MAX_TITLE_CHARS} characters`);
  if (CONTROL.test(title)) throw badRequest("Title must be one line of text");
  return title;
}

function checkBody(value: unknown): string {
  if (typeof value !== "string") throw badRequest("body must be text");
  const body = value.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(body, "utf8") > MAX_NOTE_BODY_BYTES) throw bodyTooLarge();
  return body;
}

/** A project id (slug) or null; "" counts as null. Throws 400. */
export function checkProjectId(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !PROJECT_ID.test(value)) throw badRequest("projectId must be a project id or null");
  return value;
}

function checkTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest("tags must be a list of text");
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw badRequest("tags must be a list of text");
    const tag = item.trim().replace(/^#/, "");
    if (tag === "") continue;
    if (!isValidTag(tag)) throw badRequest("Each tag must be 1 to 30 letters, numbers or hyphens");
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) throw badRequest(`A note can have at most ${MAX_TAGS} tags`);
  return tags;
}

function checkTemplate(value: unknown): NoteTemplate {
  if (value === undefined || value === null) return "blank";
  if (value === "blank" || value === "meeting" || value === "personal") return value;
  throw badRequest('template must be "blank", "meeting" or "personal"');
}

function checkSectionName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") throw badRequest("Section name is required");
  const problem = nameProblem(name);
  if (problem) throw badRequest(`The section name ${problem}`);
  return name;
}

/** Validates a POST /api/notes body. Throws 400, or 413 for a body over 200 KB. */
export function parseNewNoteInput(value: unknown): NewNoteInput {
  const o = asObject(value);
  if (typeof o.section !== "string") throw badRequest("section is required");
  const input: NewNoteInput = { section: o.section, title: checkTitle(o.title), template: checkTemplate(o.template) };
  if (o.body !== undefined) input.body = checkBody(o.body);
  if (o.projectId !== undefined) input.projectId = checkProjectId(o.projectId);
  if (o.tags !== undefined) input.tags = checkTags(o.tags);
  return input;
}

/**
 * Validates a PUT /api/notes/file body. Throws 400, or 413 for a body over 200 KB.
 * `allowEmpty` (server use only: a task patch that changes only task_* keys) accepts `{}`.
 */
export function parseNotePatch(value: unknown, opts: { allowEmpty?: boolean } = {}): NotePatch {
  const o = asObject(value);
  const patch: NotePatch = {};
  if (o.title !== undefined) patch.title = checkTitle(o.title);
  if (o.body !== undefined) patch.body = checkBody(o.body);
  if (o.projectId !== undefined) patch.projectId = checkProjectId(o.projectId);
  if (o.tags !== undefined) patch.tags = checkTags(o.tags);
  if (Object.keys(patch).length === 0 && !opts.allowEmpty) throw badRequest("Send at least one of title, body, projectId, tags");
  return patch;
}

/** File-name slug: lower case letters and numbers joined by "-", at most 60 characters, "note" when empty. */
export function slugify(title: string): string {
  const chars = [
    ...title
      .normalize("NFC")
      .toLowerCase()
      .replace(/\p{M}+/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  ];
  const slug = chars.slice(0, MAX_SLUG_CHARS).join("").replace(/-+$/, "");
  return slug === "" ? "note" : slug;
}

// ---------- filesystem helpers ----------

const IS_WINDOWS = process.platform === "win32";

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

const isMissing = (err: unknown) => {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
};

/** True when `target` is `root` or inside it. Case-insensitive on Windows. */
function isInside(root: string, target: string): boolean {
  const r = IS_WINDOWS ? root.toLowerCase() : root;
  const t = IS_WINDOWS ? target.toLowerCase() : target;
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** lstat-based: a dangling link or a file counts as taken. */
async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows can briefly refuse a rename while another process (Obsidian, antivirus, indexer) holds the target.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      await sleep(25 * (attempt + 1));
    }
  }
}

/** Temp file in the same folder (dot-named, so neither the index nor Obsidian lists it), fsync, rename. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined); // only ever our own temp file
    throw err;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** File text, or null when the bytes are not valid UTF-8 (saving such a file would corrupt it). */
async function readText(file: string): Promise<string | null> {
  const bytes = await readFile(file);
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 20261030-141500, for trash names. */
function compactStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------- note metadata ----------

const validDate = (s: string | null): string | null => (s !== null && !Number.isNaN(Date.parse(s)) ? s : null);
const createdTime = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtime : st.mtime);
const fileTitle = (rel: string) => path.posix.basename(rel).replace(NOTE_FILE, "");

/**
 * NoteMeta from a parsed file; hand-made notes fall back to the first heading, the file name and file times.
 * A note under the Tasks section also gets `task` (a TaskNote).
 */
function metaOf(rel: string, parsed: ParsedNoteFile, st: Stats): NoteMeta {
  const f = readFields(parsed.frontmatter);
  const section = path.posix.dirname(rel);
  const meta: NoteMeta = {
    path: rel,
    section: section === "." ? "" : section,
    title: f.title ?? firstHeading(parsed.body) ?? fileTitle(rel),
    created: validDate(f.created) ?? formatLocalIso(createdTime(st)),
    updated: validDate(f.updated) ?? formatLocalIso(st.mtime),
    projectId: f.projectId !== null && PROJECT_ID.test(f.projectId) ? f.projectId : null,
    tags: f.tags ?? [],
    excerpt: excerptOf(parsed.body),
    openActions: openActionLines(parsed.body).length,
  };
  if (!isTaskPath(rel)) return meta;
  const task: TaskNote = { ...meta, task: readTaskFields(parsed.frontmatter) };
  return task;
}

/** For files the dashboard will not parse (over 200 KB, not UTF-8): listed by name and file times only. */
function fallbackMeta(rel: string, st: Stats): NoteMeta {
  return metaOf(rel, { frontmatter: null, body: "" }, st);
}

const newestFirst = (a: NoteMeta, b: NoteMeta) =>
  Date.parse(b.updated) - Date.parse(a.updated) || a.path.localeCompare(b.path);
const byName = (a: NoteSection, b: NoteSection) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

interface CachedNote {
  mtimeMs: number;
  size: number;
  meta: NoteMeta;
}

interface Located {
  /** Lexical absolute path (writes and renames go here). */
  abs: string;
  /** Real path, checked to be inside the real NOTES_DIR (reads come from here). */
  real: string;
  rel: string;
  st: Stats;
}

// ---------- the store ----------

export function createNotesStore(notesDir: string, opts: NotesStoreOptions = {}): NotesStore {
  const dir = path.resolve(notesDir);
  const now = opts.now ?? (() => new Date());
  /** Parsed metadata by relative path; a file is re-read only when its mtime or size changed. */
  const cache = new Map<string, CachedNote>();

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(() => task());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const notConnected = (): NotesIndex => ({
    status: "not_connected",
    message: `Notes folder not found: ${dir}. Set NOTES_DIR in .env to the folder for your notes.`,
    dir,
    sections: [],
    notes: [],
  });
  const errorIndex = (message: string): NotesIndex => ({ status: "error", message, dir, sections: [], notes: [] });
  const ignoreExists = (err: unknown) => {
    if (errorCode(err) !== "EEXIST") throw err;
  };

  /** First-run setup. Returns the index to answer with when the folder cannot be used, else null. */
  async function prepare(): Promise<NotesIndex | null> {
    let st: Stats | null = null;
    try {
      st = await stat(dir);
    } catch (err) {
      if (!isMissing(err)) return errorIndex(`Could not read the notes folder ${dir} (${errorCode(err) ?? "unknown error"})`);
    }
    if (st && !st.isDirectory()) return errorIndex(`The notes path is a file, not a folder: ${dir}`);
    let createDefaults = false;
    if (!st) {
      if (!(await isDirectory(path.dirname(dir)))) return notConnected();
      await mkdir(dir).catch(ignoreExists);
      createDefaults = true;
    } else {
      createDefaults = (await readdir(dir)).length === 0;
    }
    if (createDefaults) {
      for (const name of DEFAULT_SECTIONS) await mkdir(path.join(dir, name)).catch(ignoreExists);
    }
    return null;
  }

  async function requireReady(): Promise<void> {
    const problem = await prepare();
    if (problem) throw notFound(problem.message ?? `Notes folder not found: ${dir}`);
  }

  async function realRoot(): Promise<string> {
    try {
      return await realpath(dir);
    } catch (err) {
      if (isMissing(err)) throw notFound(`Notes folder not found: ${dir}`);
      throw err;
    }
  }

  /** Lexical join of checked segments; refuses anything that would leave NOTES_DIR. */
  function lexical(segs: string[]): string {
    const abs = path.resolve(dir, ...segs);
    if (abs === dir || !isInside(dir, abs)) throw badRequest(OUTSIDE);
    return abs;
  }

  /**
   * The real path of `abs` (or of its deepest existing ancestor) must be inside the real NOTES_DIR,
   * so a junction or symlink pointing outside is refused with 400. Returns the real path, or null
   * when `abs` does not exist.
   */
  async function confine(abs: string): Promise<string | null> {
    const root = await realRoot();
    let probe = abs;
    let found = true;
    for (;;) {
      let real: string | null = null;
      try {
        real = await realpath(probe);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      if (real !== null) {
        if (!isInside(root, real)) throw badRequest(OUTSIDE);
        return found ? real : null;
      }
      found = false;
      const parent = path.dirname(probe);
      if (parent === probe) throw badRequest(OUTSIDE);
      probe = parent;
    }
  }

  async function locateDir(segs: string[], missing: string): Promise<string> {
    const abs = lexical(segs);
    const real = await confine(abs);
    if (real === null || !(await isDirectory(real))) throw notFound(missing);
    return abs;
  }

  async function locateNote(input: unknown): Promise<Located> {
    const segs = parsePath(input, "note");
    const abs = lexical(segs);
    const real = await confine(abs);
    if (real === null) throw notFound("Note not found");
    const st = await stat(real);
    if (!st.isFile()) throw notFound("Note not found");
    return { abs, real, rel: segs.join("/"), st };
  }

  async function loadNote(loc: Located): Promise<ParsedNoteFile> {
    if (loc.st.size > MAX_NOTE_FILE_BYTES) throw fileTooLarge();
    const text = await readText(loc.real);
    if (text === null) throw badRequest("This note is not UTF-8 text, so the dashboard will not open it. Open it in Obsidian.");
    const parsed = parseNoteFile(text);
    if (Buffer.byteLength(parsed.body, "utf8") > MAX_NOTE_BODY_BYTES) throw fileTooLarge();
    return parsed;
  }

  /** Creates each folder under the real NOTES_DIR one level at a time, checking each stays inside. */
  async function ensureDirInside(segs: string[], refused: () => HTTPException): Promise<string> {
    const root = await realRoot();
    let current = root;
    for (const seg of segs) {
      const next = path.join(current, seg);
      await mkdir(next).catch(ignoreExists);
      const real = await realpath(next);
      if (!isInside(root, real) || !(await isDirectory(real))) throw refused();
      current = real;
    }
    return current;
  }

  async function loadMeta(abs: string, rel: string): Promise<NoteMeta | null> {
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null; // symlinks and junctions are not listed
    const cached = cache.get(rel);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta;
    let meta: NoteMeta;
    if (st.size > MAX_NOTE_FILE_BYTES) {
      meta = fallbackMeta(rel, st);
    } else {
      let text: string | null;
      try {
        text = await readText(abs);
      } catch {
        return cached?.meta ?? fallbackMeta(rel, st); // busy or locked: read it again next time
      }
      meta = text === null ? fallbackMeta(rel, st) : metaOf(rel, parseNoteFile(text), st);
    }
    cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  }

  async function buildIndex(): Promise<NotesIndex> {
    const problem = await prepare();
    if (problem) return problem;
    const root = await realRoot();
    const notes: NoteMeta[] = [];
    const seen = new Set<string>();
    let skipped = 0;

    async function walk(abs: string, segs: string[]): Promise<{ sections: NoteSection[]; count: number }> {
      const entries = await readdir(abs, { withFileTypes: true });
      const sections: NoteSection[] = [];
      let count = 0;
      for (const entry of entries) {
        const name = entry.name;
        // Dot entries (.trash, .obsidian, temp files) and links are never listed.
        if (name.startsWith(".") || entry.isSymbolicLink()) continue;
        const isDir = entry.isDirectory();
        if (!isDir && !(entry.isFile() && NOTE_FILE.test(name))) continue;
        if (nameProblem(name) !== null || (isDir && segs.length >= MAX_SECTION_DEPTH)) {
          skipped++;
          continue;
        }
        const childAbs = path.join(abs, name);
        const childSegs = [...segs, name];
        const rel = childSegs.join("/");
        if (isDir) {
          try {
            if (!isInside(root, await realpath(childAbs))) continue;
            const sub = await walk(childAbs, childSegs);
            sections.push({ path: rel, name, children: sub.sections, noteCount: sub.count });
          } catch {
            skipped++;
          }
        } else {
          const meta = await loadMeta(childAbs, rel);
          if (meta) {
            notes.push(meta);
            seen.add(rel);
            count++;
          }
        }
      }
      sections.sort(byName);
      return { sections, count };
    }

    const top = await walk(dir, []);
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    notes.sort(newestFirst);
    const index: NotesIndex = { status: "ok", dir, sections: top.sections, notes };
    if (skipped > 0) {
      index.message = `${skipped} ${skipped === 1 ? "item is" : "items are"} not shown: names the dashboard cannot open, or folders nested deeper than ${MAX_SECTION_DEPTH} levels.`;
    }
    return index;
  }

  async function safeIndex(): Promise<NotesIndex> {
    try {
      return await buildIndex();
    } catch (err) {
      return errorIndex(`Could not read the notes folder (${errorCode(err) ?? "unknown error"})`);
    }
  }

  function noteFrom(rel: string, content: string, st: Stats): Note {
    const parsed = parseNoteFile(content);
    return { ...metaOf(rel, parsed, st), body: parsed.body };
  }

  const store: NotesStore = {
    index() {
      return serial(safeIndex);
    },

    async read(p) {
      const loc = await locateNote(p);
      const parsed = await loadNote(loc);
      return { ...metaOf(loc.rel, parsed, loc.st), body: parsed.body };
    },

    async create(raw, opts = {}) {
      const input = parseNewNoteInput(raw);
      return serial(async () => {
        await requireReady();
        const sectionSegs = parsePath(input.section, "section");
        if (opts.ensureSection) {
          await ensureDirInside(sectionSegs, () => conflict(`The ${input.section} section is not a plain folder inside the notes folder`));
        }
        const sectionAbs = await locateDir(sectionSegs, "Section not found");
        const at = now();
        const stamp = formatLocalIso(at);
        let entries: FrontmatterEntry[] = [];
        entries = setEntry(entries, "title", fieldLine.title(input.title));
        entries = setEntry(entries, "created", fieldLine.created(stamp));
        entries = setEntry(entries, "updated", fieldLine.updated(stamp));
        entries = setEntry(entries, "project", fieldLine.project(input.projectId ?? null));
        entries = setEntry(entries, "tags", fieldLine.tags(input.tags ?? []));
        if (opts.task) entries = setTaskEntries(entries, opts.task);
        const content = serializeNoteFile(entries, input.body ?? TEMPLATES[input.template ?? "blank"]);
        const base = opts.naming === "slug" ? slugify(input.title) : `${localDateKey(at)}-${slugify(input.title)}`;
        for (let n = 1; n <= 999; n++) {
          const name = n === 1 ? `${base}.md` : `${base}-${n}.md`;
          const abs = path.join(sectionAbs, name);
          if (await exists(abs)) continue;
          await writeFileAtomic(abs, content);
          return noteFrom([...sectionSegs, name].join("/"), content, await stat(abs));
        }
        throw conflict(
          opts.naming === "slug" ? "Too many notes with this title. Choose another title." : "Too many notes with this title today. Choose another title.",
        );
      });
    },

    async update(p, raw, opts = {}) {
      const patch = parseNotePatch(raw, { allowEmpty: opts.task !== undefined });
      return serial(async () => {
        // Re-read the file now, so edits made in Obsidian since the client loaded it are kept
        // for every field the patch does not replace. A new body replaces the whole body.
        const loc = await locateNote(p);
        const parsed = await loadNote(loc);
        const current = metaOf(loc.rel, parsed, loc.st);
        const fields = readFields(parsed.frontmatter);
        const has = (key: string) => (parsed.frontmatter ?? []).some((e) => e.key === key);
        let entries = parsed.frontmatter ?? [];
        if (patch.title !== undefined || fields.title === null) {
          entries = setEntry(entries, "title", fieldLine.title(patch.title ?? current.title));
        }
        if (fields.created === null) entries = setEntry(entries, "created", fieldLine.created(current.created));
        entries = setEntry(entries, "updated", fieldLine.updated(formatLocalIso(now())));
        if (patch.projectId !== undefined || !has("project")) {
          entries = setEntry(entries, "project", fieldLine.project(patch.projectId !== undefined ? patch.projectId : current.projectId));
        }
        if (patch.tags !== undefined || !has("tags")) entries = setEntry(entries, "tags", fieldLine.tags(patch.tags ?? current.tags));
        if (opts.task) entries = setTaskEntries(entries, opts.task);
        let body = patch.body ?? parsed.body;
        if (opts.heading && patch.title !== undefined) body = withFirstHeading(body, patch.title);
        const content = serializeNoteFile(entries, body);
        await writeFileAtomic(loc.abs, content);
        return noteFrom(loc.rel, content, await stat(loc.abs));
      });
    },

    async remove(p) {
      return serial(async () => {
        const loc = await locateNote(p);
        const segs = loc.rel.split("/");
        const name = segs.at(-1)!;
        const trashDir = await ensureDirInside([TRASH_DIR, ...segs.slice(0, -1)], () =>
          conflict(`${path.join(dir, TRASH_DIR)} is not a plain folder inside the notes folder, so nothing was deleted`),
        );
        let target = path.join(trashDir, name);
        if (await exists(target)) {
          const base = name.replace(NOTE_FILE, "");
          const ext = name.slice(base.length);
          const stamp = compactStamp(now());
          target = path.join(trashDir, `${base}.${stamp}${ext}`);
          for (let n = 2; await exists(target); n++) {
            if (n > 999) throw conflict("The trash already holds too many copies of this note");
            target = path.join(trashDir, `${base}.${stamp}-${n}${ext}`);
          }
        }
        await renameWithRetry(loc.abs, target);
        cache.delete(loc.rel);
        return safeIndex();
      });
    },

    async createSection(parent, rawName) {
      const name = checkSectionName(rawName);
      return serial(async () => {
        await requireReady();
        const parentSegs = parsePath(parent, "parent");
        if (parentSegs.length >= MAX_SECTION_DEPTH) {
          throw badRequest(`Sections can be nested at most ${MAX_SECTION_DEPTH} levels deep`);
        }
        const parentAbs = parentSegs.length === 0 ? dir : await locateDir(parentSegs, "Parent section not found");
        const target = path.join(parentAbs, name);
        const taken = conflict(`A section or note named "${name}" already exists there`);
        if (await exists(target)) throw taken;
        await mkdir(target).catch((err: unknown) => {
          throw errorCode(err) === "EEXIST" ? taken : err;
        });
        return safeIndex();
      });
    },

    async renameSection(p, rawName) {
      const name = checkSectionName(rawName);
      return serial(async () => {
        const segs = parsePath(p, "section");
        const abs = await locateDir(segs, "Section not found");
        const target = path.join(path.dirname(abs), name);
        if (target === abs) return safeIndex();
        // A case-only rename on Windows finds the folder itself at the target; anything else is a clash.
        if ((await exists(target)) && (await realpath(target)) !== (await realpath(abs))) {
          throw conflict(`A section or note named "${name}" already exists there`);
        }
        await renameWithRetry(abs, target);
        const prefix = `${segs.join("/")}/`;
        for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
        return safeIndex();
      });
    },

    async removeSection(p) {
      return serial(async () => {
        const segs = parsePath(p, "section");
        const abs = await locateDir(segs, "Section not found");
        const entries = await readdir(abs, { withFileTypes: true });
        if (entries.length > 0) {
          const visible = entries.filter((e) => !e.name.startsWith("."));
          const notes = visible.filter((e) => e.isFile() && NOTE_FILE.test(e.name)).length;
          const subsections = visible.filter((e) => e.isDirectory()).length;
          if (notes + subsections > 0) {
            const parts = [
              notes > 0 ? `${notes} ${notes === 1 ? "note" : "notes"}` : "",
              subsections > 0 ? `${subsections} ${subsections === 1 ? "section" : "sections"}` : "",
            ].filter(Boolean);
            throw conflict(`This section still holds ${parts.join(" and ")}. Move or delete them first.`);
          }
          throw conflict("This section still holds other files (some may be hidden). Remove them in Obsidian or File Explorer first.");
        }
        await rmdir(abs); // removes an empty folder only, never its contents
        return safeIndex();
      });
    },

    async recent(days, at) {
      const index = await store.index();
      if (index.status !== "ok") return [];
      const cutoff = at.getTime() - days * DAY_MS;
      return index.notes.filter((n) => Date.parse(n.updated) >= cutoff);
    },
  };
  return store;
}
