import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import type { Note, NoteMeta, NoteSection, NotesIndex, NoteTemplate, NoteVault, TaskInfo, TaskNote } from "../shared/types";
import type { VaultConfig } from "./config";
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
//
// v1.4 vaults (docs/ARCHITECTURE.md "v1.4"). NOTES_DIR is the default vault: its paths, first-run
// setup, task notes and messages are exactly as above. `opts.vaults` adds whole Obsidian vaults whose
// paths carry a prefix: "@learning/wiki/x.md". Every rule above holds per vault:
// - The prefix only picks the vault; the rest of the path gets the same text checks and must stay
//   inside that vault's own real folder, so a prefix can never be crossed ("@learning/../x" is 400).
//   An unknown prefix is 400. "@learning" alone (sections only) is the vault's top folder.
// - A vault whose folder is missing (or deleted while running) is left out of the index with one log
//   line; its paths answer 404. Never an error for the whole index.
// - Deleting moves the note to that vault's own .trash/<relative path> (Obsidian's trash folder).
// - Read-only folders (each vault's own CLAUDE.md rules, from config): their notes and subfolders are
//   listed and readable, but create, update, rename, move and delete there, and new folders, are 403
//   "This folder is protected by the vault's rules". Checked on the path text before any disk access
//   and again on the real path, so a junction inside the vault cannot reach them. A folder that holds
//   a protected folder cannot be renamed or deleted either. Every note carries `vault` and `readOnly`.
// - Never listed, in any vault: dot entries, Excalidraw/ folders, *.excalidraw.md, non-.md files,
//   symlinks and junctions. Existing names in extra vaults may also use dashes (en, em), [ ] ! + and up
//   to 200 characters, because people name Obsidian notes freely; names the dashboard creates (folders,
//   note files) keep the strict rule above, and so does everything in the default vault.
// - Tasks live only in the default vault's Tasks section.
// - The index reads a directory's entries in parallel (file reads capped), so ~1,500 notes stay cheap:
//   the mtime cache means a warm index only lstats each file.

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
  /** Every vault, section (tree) and note's metadata. Never throws for a missing folder; see status. */
  index(): Promise<NotesIndex>;
  /** One note with its body. 404 HTTPException when it does not exist. */
  read(path: string): Promise<Note>;
  /**
   * Writes a new `YYYY-MM-DD-<slug>.md` in `input.section` (or `<slug>.md`, see NoteCreateOptions).
   * `"@learning"` is the Learning vault's top folder. 403 in a read-only folder.
   */
  create(input: NewNoteInput, opts?: NoteCreateOptions): Promise<Note>;
  /** Rewrites the note's frontmatter and body; `updated` is bumped. 403 for a read-only note. */
  update(path: string, patch: NotePatch, opts?: NoteUpdateOptions): Promise<Note>;
  /** Moves the note into its vault's .trash (never a hard delete). 403 for a read-only note. */
  remove(path: string): Promise<NotesIndex>;
  /** New folder `name` inside `parent` ("" for the default top level, "@learning" for a vault's). */
  createSection(parent: string, name: string): Promise<NotesIndex>;
  /** Renames the folder at `path` to `name` (same parent). */
  renameSection(path: string, name: string): Promise<NotesIndex>;
  /** Deletes an empty section folder; 409 HTTPException when it holds notes or subsections. */
  removeSection(path: string): Promise<NotesIndex>;
  /** Notes updated within the last `days` days before `now`, newest first, from every vault. */
  recent(days: number, now: Date): Promise<NoteMeta[]>;
}

export interface NotesStoreOptions {
  /** Clock for created/updated stamps. Default: the real clock. */
  now?: () => Date;
  /**
   * v1.4: the vaults (config.vaults). Entries with prefix "" stand for the default vault, which is
   * always `notesDir`: only their label is used. Default: no extra vaults (tests use temp folders).
   */
  vaults?: readonly VaultConfig[];
  /** Log lines (a vault left out or back). Default: console.log. Never note text. */
  log?: (line: string) => void;
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

const forbidden = (message: string) => new HTTPException(403, { message });

const OUTSIDE = "Path must stay inside the notes folder";
/** The 403 message for any write in a read-only folder (docs/ARCHITECTURE.md "v1.4"). */
export const PROTECTED_MESSAGE = "This folder is protected by the vault's rules";
const NAME_CHARS = /^[\p{L}\p{M}\p{N} _.,()&'-]+$/u;
/** Existing names in extra vaults: also dashes (\p{Pd}: en, em and others), [ ] ! and +. Never @, %, #, :, / or \. */
const VAULT_NAME_CHARS = /^[\p{L}\p{M}\p{N}\p{Pd} _.,()&'[\]!+]+$/u;
/** Longest existing name accepted in an extra vault (Windows allows 255). */
export const MAX_VAULT_NAME_CHARS = 200;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const PROJECT_ID = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u;
const NOTE_FILE = /\.md$/i;
/** Excalidraw drawings saved as markdown, and the plugin's folder: never listed. */
const EXCALIDRAW_FILE = /\.excalidraw\.md$/i;
const EXCALIDRAW_DIR = "excalidraw";
const CONTROL = /\p{Cc}/u;
const charCount = (s: string) => [...s].length;

/**
 * "strict": names the dashboard creates, and every name in the default vault.
 * "vault": existing file and folder names in an extra vault (hand-made in Obsidian).
 */
export type NameRules = "strict" | "vault";

/** Why a file or folder name is not allowed (a sentence ending), or null when it is fine. */
export function nameProblem(name: string, rules: NameRules = "strict"): string | null {
  const max = rules === "vault" ? MAX_VAULT_NAME_CHARS : MAX_NAME_CHARS;
  if (name === "") return "is empty";
  if (charCount(name) > max) return `is longer than ${max} characters`;
  if (name.startsWith(".")) return "starts with a dot";
  if (rules === "vault" ? !VAULT_NAME_CHARS.test(name) : !NAME_CHARS.test(name)) {
    return rules === "vault"
      ? "may only use letters, numbers, spaces, dashes and _ . , ( ) & ' [ ] ! +"
      : "may only use letters, numbers, spaces and _ . , ( ) & ' -";
  }
  if (/[. ]$/.test(name)) return "ends with a dot or a space";
  if (WINDOWS_DEVICE.test(name.split(".")[0]!.trim())) return "is a name Windows reserves";
  return null;
}

type PathKind = "note" | "section" | "parent";

/** Checks a client path by its text and returns its segments. Throws 400. */
export function parsePath(input: unknown, kind: PathKind, rules: NameRules = "strict"): string[] {
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
    const problem = nameProblem(seg, rules);
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

// ---------- vaults ----------

const DEFAULT_VAULT_ID = "notes"; // same as DEFAULT_VAULT_ID in config.ts (not imported: config reads .env on load)
const DEFAULT_VAULT_LABEL = "Working-With-Claude notes";
const VAULT_ID = /^[a-z][a-z0-9-]{0,30}$/;

/** A vault as the store uses it. */
interface Vault {
  id: string;
  label: string;
  /** "" for the default vault, else "@<id>/". */
  prefix: string;
  /** Lexical absolute folder. */
  dir: string;
  readOnlyFolders: string[];
  /** readOnlyFolders as compare keys: one list of segment keys per folder. */
  protectedKeys: string[][];
  rules: NameRules;
  isDefault: boolean;
}

/** Folder names compare like Windows does: case-insensitive, and NFC so composed and decomposed letters match. */
const segKey = (seg: string) => seg.normalize("NFC").toLowerCase();

/** True when the folder `segs` (relative to the vault) is a protected folder or inside one. */
function isProtected(v: Vault, segs: readonly string[]): boolean {
  return v.protectedKeys.some((p) => p.length <= segs.length && p.every((k, i) => k === segKey(segs[i]!)));
}

/** True when the folder `segs` holds a protected folder deeper down, so renaming or deleting it would move that folder. */
function holdsProtected(v: Vault, segs: readonly string[]): boolean {
  return v.protectedKeys.some((p) => p.length > segs.length && segs.every((s, i) => segKey(s) === p[i]));
}

/** 403 when the folder is protected by its path text, or by where it really is (`realSegs`). */
function assertWritable(v: Vault, segs: readonly string[], realSegs: readonly string[] = segs): void {
  if (isProtected(v, segs) || isProtected(v, realSegs)) throw forbidden(PROTECTED_MESSAGE);
}

/** The client path of a folder: "" or "Meeting notes/FastBind" in the default vault, "@learning" or "@learning/wiki" elsewhere. */
function folderPath(v: Vault, segs: readonly string[]): string {
  if (segs.length > 0) return v.prefix + segs.join("/");
  return v.isDefault ? "" : v.prefix.slice(0, -1);
}

/** The client path of a note. */
const notePath = (v: Vault, segs: readonly string[]) => v.prefix + segs.join("/");

/** The default vault plus the valid extra vaults from `specs`. Invalid or overlapping ones are left out with a log line. */
function buildVaults(notesDir: string, specs: readonly VaultConfig[], log: (line: string) => void): Vault[] {
  const defaultSpec = specs.find((s) => s.prefix === "");
  const vaults: Vault[] = [
    {
      id: DEFAULT_VAULT_ID,
      label: defaultSpec?.label || DEFAULT_VAULT_LABEL,
      prefix: "",
      dir: notesDir,
      readOnlyFolders: [],
      protectedKeys: [],
      rules: "strict",
      isDefault: true,
    },
  ];
  for (const spec of specs) {
    if (spec.prefix === "") continue;
    const dir = path.resolve(spec.dir);
    const why =
      !VAULT_ID.test(spec.id) || spec.id === DEFAULT_VAULT_ID
        ? "its id must be a short lower-case name other than notes"
        : spec.prefix !== `@${spec.id}/`
          ? `its prefix must be @${spec.id}/`
          : vaults.some((v) => v.id === spec.id)
            ? "its id is used twice"
            : vaults.some((v) => isInside(v.dir, dir) || isInside(dir, v.dir))
              ? "its folder overlaps another vault's folder"
              : null;
    if (why) {
      log(`[notes] vault ${JSON.stringify(spec.id)} left out: ${why}`);
      continue;
    }
    // Kept as given (only split and trimmed), never dropped: a folder that is not there protects nothing,
    // but dropping a rule could make a protected folder writable.
    const folders = spec.readOnlyFolders
      .map((f) => f.split(/[\\/]+/).filter((s) => s !== "" && s !== "."))
      .filter((segs) => segs.length > 0);
    vaults.push({
      id: spec.id,
      label: spec.label,
      prefix: spec.prefix,
      dir,
      readOnlyFolders: folders.map((segs) => segs.join("/")),
      protectedKeys: folders.map((segs) => segs.map(segKey)),
      rules: "vault",
      isDefault: false,
    });
  }
  return vaults;
}

/** At most `max` tasks at a time (file reads during an index). */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // the slot is handed over on release
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// ---------- note metadata ----------

const validDate = (s: string | null): string | null => (s !== null && !Number.isNaN(Date.parse(s)) ? s : null);
const createdTime = (st: Stats) => (st.birthtimeMs > 0 ? st.birthtime : st.mtime);
const fileTitle = (rel: string) => path.posix.basename(rel).replace(NOTE_FILE, "");

/**
 * NoteMeta from a parsed file; hand-made notes fall back to the first heading, the file name and file times.
 * `segs` is the note's path inside its vault. A note under the default vault's Tasks section also gets
 * `task` (a TaskNote). `readOnly` defaults to the protection of the note's folder.
 */
function metaOf(v: Vault, segs: readonly string[], parsed: ParsedNoteFile, st: Stats, readOnly?: boolean): NoteMeta {
  const rel = notePath(v, segs);
  const folder = segs.slice(0, -1);
  const f = readFields(parsed.frontmatter);
  const meta: NoteMeta = {
    path: rel,
    section: folderPath(v, folder),
    title: f.title ?? firstHeading(parsed.body) ?? fileTitle(rel),
    created: validDate(f.created) ?? formatLocalIso(createdTime(st)),
    updated: validDate(f.updated) ?? formatLocalIso(st.mtime),
    projectId: f.projectId !== null && PROJECT_ID.test(f.projectId) ? f.projectId : null,
    tags: f.tags ?? [],
    excerpt: excerptOf(parsed.body),
    openActions: openActionLines(parsed.body).length,
    vault: v.id,
    readOnly: readOnly ?? isProtected(v, folder),
  };
  if (!v.isDefault || !isTaskPath(rel)) return meta;
  const task: TaskNote = { ...meta, task: readTaskFields(parsed.frontmatter) };
  return task;
}

/** For files the dashboard will not parse (over 200 KB, not UTF-8): listed by name and file times only. */
function fallbackMeta(v: Vault, segs: readonly string[], st: Stats): NoteMeta {
  return metaOf(v, segs, { frontmatter: null, body: "" }, st);
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

/** A client path checked by its text: the vault it names and the segments inside that vault. */
interface Target {
  vault: Vault;
  segs: string[];
}

interface Located extends Target {
  /** Lexical absolute path (writes and renames go here). */
  abs: string;
  /** Real path, checked to be inside the vault's real folder (reads come from here). */
  real: string;
  /** Where the note really is, as segments inside the vault (differs from `segs` only through a link). */
  realSegs: string[];
  /** The client path. */
  rel: string;
  /** In a protected folder, by its path or by where it really is. */
  readOnly: boolean;
  st: Stats;
}

interface LocatedDir {
  abs: string;
  realSegs: string[];
}

/** Concurrent file reads while indexing. */
const INDEX_READS = 32;

// ---------- the store ----------

export function createNotesStore(notesDir: string, opts: NotesStoreOptions = {}): NotesStore {
  const dir = path.resolve(notesDir);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.log(line));
  const vaults = buildVaults(dir, opts.vaults ?? [], log);
  const main = vaults[0]!;
  const extras = new Map(vaults.filter((v) => !v.isDefault).map((v) => [v.id, v] as const));
  /** Parsed metadata by client path; a file is re-read only when its mtime or size changed. */
  const cache = new Map<string, CachedNote>();
  /** Extra vaults currently left out because their folder is missing (logged once each time). */
  const missing = new Set<string>();

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
    vaults: [],
    sections: [],
    notes: [],
  });
  const errorIndex = (message: string): NotesIndex => ({ status: "error", message, dir, vaults: [], sections: [], notes: [] });
  const ignoreExists = (err: unknown) => {
    if (errorCode(err) !== "EEXIST") throw err;
  };

  /** First-run setup of the default vault. Returns the index to answer with when the folder cannot be used, else null. */
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

  async function realRoot(v: Vault): Promise<string> {
    try {
      return await realpath(v.dir);
    } catch (err) {
      if (isMissing(err)) throw notFound(v.isDefault ? `Notes folder not found: ${v.dir}` : `${v.label} vault folder not found: ${v.dir}`);
      throw err;
    }
  }

  /** Checks a client path by its text: an "@<id>" prefix picks that vault, anything else is the default vault. Throws 400. */
  function resolveTarget(input: unknown, kind: PathKind): Target {
    if (typeof input !== "string" || !input.startsWith("@")) return { vault: main, segs: parsePath(input, kind) };
    const what = kind === "note" ? "Note path" : "Section path";
    const slash = input.indexOf("/");
    const vault = extras.get(slash === -1 ? input.slice(1) : input.slice(1, slash));
    if (!vault) throw badRequest("Unknown vault in the path");
    if (slash === -1) {
      if (kind === "note") throw badRequest("Note path must end in .md");
      return { vault, segs: [] }; // the vault's top folder
    }
    const rest = input.slice(slash + 1);
    if (rest === "") throw badRequest(`${what} must not end with /`);
    return { vault, segs: parsePath(rest, kind, vault.rules) };
  }

  /** Lexical join of checked segments; refuses anything that would leave the vault folder. */
  function lexical(v: Vault, segs: readonly string[]): string {
    const abs = path.resolve(v.dir, ...segs);
    if (abs === v.dir || !isInside(v.dir, abs)) throw badRequest(OUTSIDE);
    return abs;
  }

  /**
   * The real path of `abs` (or of its deepest existing ancestor) must be inside the vault's real
   * folder, so a junction or symlink pointing outside is refused with 400. Returns the real path
   * (null when `abs` does not exist) and where `abs` really is, as segments inside the vault.
   */
  async function confine(v: Vault, abs: string): Promise<{ real: string | null; realSegs: string[] }> {
    const root = await realRoot(v);
    let probe = abs;
    const rest: string[] = [];
    for (;;) {
      let real: string | null = null;
      try {
        real = await realpath(probe);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
      if (real !== null) {
        if (!isInside(root, real)) throw badRequest(OUTSIDE);
        const inside = path.relative(root, real);
        const realSegs = [...(inside === "" ? [] : inside.split(path.sep)), ...rest];
        return { real: rest.length === 0 ? real : null, realSegs };
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw badRequest(OUTSIDE);
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }

  /** An existing folder of the vault ([] = its top folder). 404 `missing` when it is not there. */
  async function locateDir(v: Vault, segs: readonly string[], missing: string): Promise<LocatedDir> {
    if (segs.length === 0) {
      const root = await realRoot(v);
      if (!(await isDirectory(root))) throw notFound(missing);
      return { abs: v.dir, realSegs: [] };
    }
    const abs = lexical(v, segs);
    const { real, realSegs } = await confine(v, abs);
    if (real === null || !(await isDirectory(real))) throw notFound(missing);
    return { abs, realSegs };
  }

  async function locateNote(t: Target): Promise<Located> {
    const abs = lexical(t.vault, t.segs);
    const { real, realSegs } = await confine(t.vault, abs);
    if (real === null) throw notFound("Note not found");
    const st = await stat(real);
    if (!st.isFile()) throw notFound("Note not found");
    const readOnly = isProtected(t.vault, t.segs.slice(0, -1)) || isProtected(t.vault, realSegs.slice(0, -1));
    return { ...t, abs, real, realSegs, rel: notePath(t.vault, t.segs), readOnly, st };
  }

  /** A note to change: 403 in a protected folder (checked by text first, then where it really is). */
  async function locateWritableNote(input: unknown): Promise<Located> {
    const t = resolveTarget(input, "note");
    assertWritable(t.vault, t.segs.slice(0, -1));
    const loc = await locateNote(t);
    if (loc.readOnly) throw forbidden(PROTECTED_MESSAGE);
    return loc;
  }

  async function loadNote(loc: Located): Promise<ParsedNoteFile> {
    if (loc.st.size > MAX_NOTE_FILE_BYTES) throw fileTooLarge();
    const text = await readText(loc.real);
    if (text === null) throw badRequest("This note is not UTF-8 text, so the dashboard will not open it. Open it in Obsidian.");
    const parsed = parseNoteFile(text);
    if (Buffer.byteLength(parsed.body, "utf8") > MAX_NOTE_BODY_BYTES) throw fileTooLarge();
    return parsed;
  }

  /** Creates each folder under the vault's real folder one level at a time, checking each stays inside. */
  async function ensureDirInside(v: Vault, segs: readonly string[], refused: () => HTTPException): Promise<string> {
    const root = await realRoot(v);
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

  async function loadMeta(v: Vault, abs: string, segs: readonly string[]): Promise<NoteMeta | null> {
    const rel = notePath(v, segs);
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
      meta = fallbackMeta(v, segs, st);
    } else {
      let text: string | null;
      try {
        text = await readText(abs);
      } catch {
        return cached?.meta ?? fallbackMeta(v, segs, st); // busy or locked: read it again next time
      }
      meta = text === null ? fallbackMeta(v, segs, st) : metaOf(v, segs, parseNoteFile(text), st);
    }
    cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  }

  /** The real folder of an extra vault, or null when it is missing (logged once, and again when it is back). */
  async function presentRoot(v: Vault): Promise<string | null> {
    try {
      if ((await stat(v.dir)).isDirectory()) {
        const root = await realpath(v.dir);
        if (missing.delete(v.id)) log(`[notes] ${v.label} vault found again: ${v.dir}`);
        return root;
      }
    } catch {
      // missing or unreadable: left out below
    }
    if (!missing.has(v.id)) {
      missing.add(v.id);
      log(`[notes] ${v.label} vault left out: folder not found: ${v.dir}`);
    }
    return null;
  }

  async function buildIndex(): Promise<NotesIndex> {
    const problem = await prepare();
    if (problem) return problem;
    const notes: NoteMeta[] = [];
    const sections: NoteSection[] = [];
    const vaultViews: NoteVault[] = [];
    const seen = new Set<string>();
    const read = limiter(INDEX_READS);
    let skipped = 0;

    async function walkVault(v: Vault, root: string) {
      const found: NoteMeta[] = [];

      async function walk(abs: string, segs: string[]): Promise<{ sections: NoteSection[]; count: number }> {
        const entries = await readdir(abs, { withFileTypes: true });
        const folders: Promise<NoteSection | null>[] = [];
        const files: Promise<NoteMeta | null>[] = [];
        for (const entry of entries) {
          const name = entry.name;
          // Dot entries (.trash, .obsidian, temp files) and links are never listed.
          if (name.startsWith(".") || entry.isSymbolicLink()) continue;
          const isDir = entry.isDirectory();
          if (!isDir && !(entry.isFile() && NOTE_FILE.test(name))) continue;
          // Excalidraw drawings are not notes.
          if (isDir ? name.toLowerCase() === EXCALIDRAW_DIR : EXCALIDRAW_FILE.test(name)) continue;
          if (nameProblem(name, v.rules) !== null || (isDir && segs.length >= MAX_SECTION_DEPTH)) {
            skipped++;
            continue;
          }
          const childAbs = path.join(abs, name);
          const childSegs = [...segs, name];
          if (isDir) {
            folders.push(
              (async () => {
                try {
                  if (!isInside(root, await realpath(childAbs))) return null;
                  const sub = await walk(childAbs, childSegs);
                  const section: NoteSection = { path: folderPath(v, childSegs), name, children: sub.sections, noteCount: sub.count };
                  if (isProtected(v, childSegs)) section.readOnly = true;
                  return section;
                } catch {
                  skipped++;
                  return null;
                }
              })(),
            );
          } else {
            files.push(read(() => loadMeta(v, childAbs, childSegs)));
          }
        }
        const metas = (await Promise.all(files)).filter((m): m is NoteMeta => m !== null);
        found.push(...metas);
        const subs = (await Promise.all(folders)).filter((s): s is NoteSection => s !== null);
        subs.sort(byName);
        return { sections: subs, count: metas.length };
      }

      const top = await walk(v.dir, []);
      return { top, found };
    }

    for (const v of vaults) {
      let walked: Awaited<ReturnType<typeof walkVault>>;
      if (v.isDefault) {
        walked = await walkVault(v, await realRoot(v)); // errors here make the whole index "error", as before v1.4
        sections.push(...walked.top.sections);
      } else {
        const root = await presentRoot(v);
        if (root === null) continue;
        try {
          walked = await walkVault(v, root);
        } catch (err) {
          // Deleted or locked mid-read: leave this vault out, keep the others.
          log(`[notes] ${v.label} vault left out: could not read it (${errorCode(err) ?? "unknown error"})`);
          continue;
        }
        sections.push({ path: folderPath(v, []), name: v.label, children: walked.top.sections, noteCount: walked.top.count });
      }
      for (const meta of walked.found) {
        notes.push(meta);
        seen.add(meta.path);
      }
      vaultViews.push({
        id: v.id,
        label: v.label,
        prefix: v.prefix,
        dir: v.dir,
        readOnlyFolders: [...v.readOnlyFolders],
        noteCount: walked.found.length,
      });
    }

    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    notes.sort(newestFirst);
    const index: NotesIndex = { status: "ok", dir, vaults: vaultViews, sections, notes };
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

  function noteFrom(v: Vault, segs: readonly string[], content: string, st: Stats): Note {
    const parsed = parseNoteFile(content);
    return { ...metaOf(v, segs, parsed, st), body: parsed.body };
  }

  /** The vault's own words for errors: "the notes folder" for the default vault. */
  const placeOf = (v: Vault) => (v.isDefault ? "the notes folder" : `the ${v.label} vault`);

  const store: NotesStore = {
    index() {
      return serial(safeIndex);
    },

    async read(p) {
      const loc = await locateNote(resolveTarget(p, "note"));
      const parsed = await loadNote(loc);
      return { ...metaOf(loc.vault, loc.segs, parsed, loc.st, loc.readOnly), body: parsed.body };
    },

    async create(raw, opts = {}) {
      const input = parseNewNoteInput(raw);
      return serial(async () => {
        if (!input.section.startsWith("@")) await requireReady();
        const { vault: v, segs: sectionSegs } = resolveTarget(input.section, "section");
        assertWritable(v, sectionSegs);
        if (opts.ensureSection) {
          await ensureDirInside(v, sectionSegs, () => conflict(`The ${input.section} section is not a plain folder inside ${placeOf(v)}`));
        }
        const section = await locateDir(v, sectionSegs, "Section not found");
        assertWritable(v, sectionSegs, section.realSegs);
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
          const abs = path.join(section.abs, name);
          if (await exists(abs)) continue;
          await writeFileAtomic(abs, content);
          return noteFrom(v, [...sectionSegs, name], content, await stat(abs));
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
        const loc = await locateWritableNote(p);
        const parsed = await loadNote(loc);
        const current = metaOf(loc.vault, loc.segs, parsed, loc.st);
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
        return noteFrom(loc.vault, loc.segs, content, await stat(loc.abs));
      });
    },

    async remove(p) {
      return serial(async () => {
        const loc = await locateWritableNote(p);
        const v = loc.vault;
        const name = loc.segs.at(-1)!;
        const trashDir = await ensureDirInside(v, [TRASH_DIR, ...loc.segs.slice(0, -1)], () =>
          conflict(`${path.join(v.dir, TRASH_DIR)} is not a plain folder inside ${placeOf(v)}, so nothing was deleted`),
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
        if (typeof parent !== "string" || !parent.startsWith("@")) await requireReady();
        const { vault: v, segs: parentSegs } = resolveTarget(parent, "parent");
        if (parentSegs.length >= MAX_SECTION_DEPTH) {
          throw badRequest(`Sections can be nested at most ${MAX_SECTION_DEPTH} levels deep`);
        }
        assertWritable(v, [...parentSegs, name]);
        const parentDir =
          parentSegs.length === 0 && v.isDefault ? { abs: dir, realSegs: [] } : await locateDir(v, parentSegs, "Parent section not found");
        assertWritable(v, [...parentSegs, name], [...parentDir.realSegs, name]);
        const target = path.join(parentDir.abs, name);
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
        const { vault: v, segs } = resolveTarget(p, "section");
        if (segs.length === 0) throw badRequest("A vault's own folder cannot be renamed here");
        const renamed = [...segs.slice(0, -1), name];
        const refused = (at: readonly string[]) => isProtected(v, at) || holdsProtected(v, at);
        if (refused(segs) || isProtected(v, renamed)) throw forbidden(PROTECTED_MESSAGE);
        const located = await locateDir(v, segs, "Section not found");
        if (refused(located.realSegs) || isProtected(v, [...located.realSegs.slice(0, -1), name])) throw forbidden(PROTECTED_MESSAGE);
        const abs = located.abs;
        const target = path.join(path.dirname(abs), name);
        if (target === abs) return safeIndex();
        // A case-only rename on Windows finds the folder itself at the target; anything else is a clash.
        if ((await exists(target)) && (await realpath(target)) !== (await realpath(abs))) {
          throw conflict(`A section or note named "${name}" already exists there`);
        }
        await renameWithRetry(abs, target);
        const prefix = `${folderPath(v, segs)}/`;
        for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
        return safeIndex();
      });
    },

    async removeSection(p) {
      return serial(async () => {
        const { vault: v, segs } = resolveTarget(p, "section");
        if (segs.length === 0) throw badRequest("A vault's own folder cannot be deleted here");
        if (isProtected(v, segs) || holdsProtected(v, segs)) throw forbidden(PROTECTED_MESSAGE);
        const { abs, realSegs } = await locateDir(v, segs, "Section not found");
        if (isProtected(v, realSegs) || holdsProtected(v, realSegs)) throw forbidden(PROTECTED_MESSAGE);
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
