import type { Note, NoteMeta, NoteSection, NoteTemplate } from "../../../shared/types";
import type { NotePatch } from "../api/notes";

// Pure helpers for the Notes view (T19): the sections tree, note order, template choice, task-line
// toggling in markdown, validation and the dirty-state logic behind autosave. No React, no DOM:
// unit tested in notes.test.ts. Anything that depends on "now" takes it as a parameter.
//
// Paths are relative to NOTES_DIR, posix, exactly as the server sent them. A note's section is the
// folder part of its path ("Meeting notes/FastBind/2026-10-30-review.md" -> "Meeting notes/FastBind").

/** The "All notes" row at the top of the tree. Not a folder: it lists every note. */
export const ALL_NOTES = "";

/** Sections nest at most this deep (ARCHITECTURE: "any depth up to 4"). */
export const MAX_SECTION_DEPTH = 4;
export const MAX_NAME_LENGTH = 80;
export const MAX_TITLE_LENGTH = 120;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 30;
/** Note body limit on the server, in bytes of UTF-8. */
export const MAX_BODY_BYTES = 200 * 1024;
/** Autosave fires this long after typing stops. */
export const AUTOSAVE_DELAY_MS = 800;

/* Paths ------------------------------------------------------------------------------------------ */

/** "A/B/note.md" -> "A/B"; "note.md" -> "". */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Last segment: "A/B" -> "B". */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Number of folders in a section path: "" -> 0, "A" -> 1, "A/B" -> 2. */
export function sectionDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

/** The section a note lives in (the folder part of its path). */
export function noteSection(note: Pick<NoteMeta, "path">): string {
  return parentPath(note.path);
}

/** Every ancestor of a section, outermost first, without the section itself: "A/B/C" -> ["A", "A/B"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path ? path.split("/") : [];
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** True when `path` is `section` or sits anywhere inside it. ALL_NOTES contains everything. */
export function isWithin(path: string, section: string): boolean {
  if (section === ALL_NOTES) return true;
  return path === section || path.startsWith(`${section}/`);
}

/**
 * A path after the section `from` was renamed to `to`: "A/B/n.md" with A/B -> A/C gives "A/C/n.md".
 * Paths outside `from` come back unchanged.
 */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

/** " / " separated, for showing a section path in one line. "" reads "All notes". */
export function sectionLabel(path: string): string {
  return path === ALL_NOTES ? "All notes" : path.split("/").join(" / ");
}

/* Tree ------------------------------------------------------------------------------------------- */

export function findSection(sections: readonly NoteSection[], path: string): NoteSection | null {
  for (const section of sections) {
    if (section.path === path) return section;
    if (path.startsWith(`${section.path}/`)) {
      const inner = findSection(section.children, path);
      if (inner) return inner;
    }
  }
  return null;
}

/** Every section path in the tree, depth first. */
export function allSectionPaths(sections: readonly NoteSection[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly NoteSection[]) => {
    for (const s of list) {
      out.push(s.path);
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

export interface SectionCount {
  /** Notes directly in this folder. */
  direct: number;
  /** Notes in this folder and every subsection: what the list shows when the section is open. */
  total: number;
}

/**
 * Note counts per section path, computed from the notes themselves so the tree always matches the
 * list. ALL_NOTES gets every note (its `direct` = notes sitting at the top of the notes folder).
 */
export function sectionCounts(
  sections: readonly NoteSection[],
  notes: readonly Pick<NoteMeta, "path">[],
): Map<string, SectionCount> {
  const counts = new Map<string, SectionCount>();
  for (const path of allSectionPaths(sections)) counts.set(path, { direct: 0, total: 0 });
  const all: SectionCount = { direct: 0, total: notes.length };
  counts.set(ALL_NOTES, all);
  for (const note of notes) {
    const section = noteSection(note);
    if (section === ALL_NOTES) {
      all.direct += 1;
      continue;
    }
    const own = counts.get(section);
    if (own) own.direct += 1;
    for (const path of [...ancestorsOf(section), section]) {
      const c = counts.get(path);
      if (c) c.total += 1;
    }
  }
  return counts;
}

/** One visible row of the sections tree, ready for role="treeitem". */
export interface TreeRow {
  path: string;
  name: string;
  /** aria-level, 1 for top level ("All notes" and the top sections). */
  level: number;
  /** aria-posinset and aria-setsize among its siblings. */
  posInSet: number;
  setSize: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Parent row path, or null at the top level. */
  parent: string | null;
}

/**
 * The rows a tree shows: "All notes" first, then sections depth first, skipping the children of
 * collapsed sections.
 */
export function visibleRows(sections: readonly NoteSection[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [
    {
      path: ALL_NOTES,
      name: "All notes",
      level: 1,
      posInSet: 1,
      setSize: sections.length + 1,
      hasChildren: false,
      expanded: false,
      parent: null,
    },
  ];
  const walk = (list: readonly NoteSection[], level: number, parent: string | null, offset: number) => {
    list.forEach((s, i) => {
      const hasChildren = s.children.length > 0;
      const open = hasChildren && expanded.has(s.path);
      rows.push({
        path: s.path,
        name: s.name,
        level,
        posInSet: i + 1 + offset,
        setSize: list.length + offset,
        hasChildren,
        expanded: open,
        parent,
      });
      if (open) walk(s.children, level + 1, s.path, 0);
    });
  };
  walk(sections, 1, null, 1);
  return rows;
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export type TreeMove =
  | { kind: "focus"; path: string }
  | { kind: "expand"; path: string }
  | { kind: "collapse"; path: string }
  | { kind: "none" };

/** What an arrow, Home or End key does on the focused row (WAI-ARIA tree pattern). */
export function treeKeyAction(rows: readonly TreeRow[], focused: string, key: TreeKey): TreeMove {
  const i = rows.findIndex((r) => r.path === focused);
  if (i === -1) return rows.length ? { kind: "focus", path: rows[0].path } : { kind: "none" };
  const row = rows[i];
  switch (key) {
    case "ArrowDown":
      return i < rows.length - 1 ? { kind: "focus", path: rows[i + 1].path } : { kind: "none" };
    case "ArrowUp":
      return i > 0 ? { kind: "focus", path: rows[i - 1].path } : { kind: "none" };
    case "Home":
      return { kind: "focus", path: rows[0].path };
    case "End":
      return { kind: "focus", path: rows[rows.length - 1].path };
    case "ArrowRight":
      if (!row.hasChildren) return { kind: "none" };
      if (!row.expanded) return { kind: "expand", path: row.path };
      return { kind: "focus", path: rows[i + 1].path };
    case "ArrowLeft":
      if (row.hasChildren && row.expanded) return { kind: "collapse", path: row.path };
      return row.parent !== null ? { kind: "focus", path: row.parent } : { kind: "none" };
  }
}

/** Type-ahead: the next row after `focused` whose name starts with `char`, wrapping around. */
export function typeAhead(rows: readonly TreeRow[], focused: string, char: string): string | null {
  const c = char.toLocaleLowerCase();
  const start = rows.findIndex((r) => r.path === focused);
  for (let k = 1; k <= rows.length; k++) {
    const row = rows[(start + k + rows.length) % rows.length];
    if (row.name.toLocaleLowerCase().startsWith(c)) return row.path;
  }
  return null;
}

/* Notes list ------------------------------------------------------------------------------------- */

function timeOf(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Newest first: by created, then updated, then title. Unreadable dates go last. */
export function sortNotes<T extends Pick<NoteMeta, "created" | "updated" | "title" | "path">>(notes: readonly T[]): T[] {
  return [...notes].sort(
    (a, b) =>
      timeOf(b.created) - timeOf(a.created) ||
      timeOf(b.updated) - timeOf(a.updated) ||
      a.title.localeCompare(b.title) ||
      a.path.localeCompare(b.path),
  );
}

/** The notes the list shows for a section (itself and its subsections), newest first. */
export function notesIn<T extends NoteMeta>(notes: readonly T[], section: string): T[] {
  return sortNotes(notes.filter((n) => isWithin(noteSection(n), section)));
}

/** True when the section holds no notes and no subsections, so the server will let it go. */
export function canDeleteSection(section: NoteSection, count: SectionCount | undefined): boolean {
  return section.children.length === 0 && section.noteCount === 0 && (count?.total ?? 0) === 0;
}

/** Why a section can't be deleted, or null when it can. */
export function deleteBlockedReason(section: NoteSection, count: SectionCount | undefined): string | null {
  if (canDeleteSection(section, count)) return null;
  const notes = Math.max(count?.total ?? 0, section.noteCount);
  const subs = section.children.length;
  const parts: string[] = [];
  if (notes > 0) parts.push(`${notes} ${notes === 1 ? "note" : "notes"}`);
  if (subs > 0) parts.push(`${subs} ${subs === 1 ? "subsection" : "subsections"}`);
  return `Only empty sections can be deleted. This one holds ${parts.join(" and ")}.`;
}

/* Templates -------------------------------------------------------------------------------------- */

export const TEMPLATES: readonly { id: NoteTemplate; label: string; hint: string }[] = [
  { id: "meeting", label: "Meeting", hint: "Attendees, agenda, notes, decisions, action items" },
  { id: "personal", label: "Personal", hint: "One Notes heading" },
  { id: "blank", label: "Blank", hint: "An empty page" },
];

/** Meeting inside "Meeting notes" and its subsections, Personal inside "Personal notes", else Blank. */
export function defaultTemplate(section: string): NoteTemplate {
  const top = section.split("/")[0].trim().toLocaleLowerCase();
  if (top === "meeting notes") return "meeting";
  if (top === "personal notes") return "personal";
  return "blank";
}

/**
 * The section a new note goes to by default: the open one, or "Meeting notes" (then the first
 * section) when "All notes" is open. Null when there are no sections at all.
 */
export function defaultNewNoteSection(sections: readonly NoteSection[], selected: string): string | null {
  if (selected !== ALL_NOTES && findSection(sections, selected)) return selected;
  const meeting = sections.find((s) => s.name.toLocaleLowerCase() === "meeting notes");
  return meeting?.path ?? sections[0]?.path ?? null;
}

/**
 * Where the caret goes in a new note: on the blank line after the first heading, so typing starts
 * under "## Attendees". At the end for anything else.
 */
export function initialCaret(body: string): number {
  const m = /^#{1,6} [^\n]*\n/.exec(body);
  if (!m) return body.length;
  return m[0].length;
}

/* Validation ------------------------------------------------------------------------------------- */

const NAME_CHARS = /^[\p{L}\p{N} _.,()&'-]+$/u;
const TAG_CHARS = /^[\p{L}\p{N}-]+$/u;

/** Error for a section name, or null. `siblings` are the other names in the same parent. */
export function validateSectionName(raw: string, siblings: readonly string[] = []): string | null {
  const name = raw.trim();
  if (!name) return "Enter a name.";
  if (name.length > MAX_NAME_LENGTH) return `Use ${MAX_NAME_LENGTH} characters or fewer.`;
  if (name.startsWith(".")) return "Names can't start with a dot.";
  if (!NAME_CHARS.test(name)) return "Use letters, numbers, spaces and _ . , ( ) & ' - only.";
  const lower = name.toLocaleLowerCase();
  if (siblings.some((s) => s.toLocaleLowerCase() === lower)) return `There's already a section called ${name} here.`;
  return null;
}

/** Error for a note title, or null. */
export function validateTitle(raw: string): string | null {
  const title = raw.trim();
  if (!title) return "Add a title to save this note.";
  if (title.length > MAX_TITLE_LENGTH) return `Titles can be up to ${MAX_TITLE_LENGTH} characters.`;
  return null;
}

/** UTF-8 size of a string in bytes. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Error for a note body, or null. */
export function validateBody(body: string): string | null {
  return byteLength(body) > MAX_BODY_BYTES
    ? "This note is over 200 KB, so it can't be saved. Move part of it into a new note."
    : null;
}

/** "#Meeting " -> "Meeting". Leading "#" is how Obsidian writes tags, so it is dropped. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "");
}

/** Adds one typed tag. Returns the new list, or an error and the list unchanged. Duplicates are ignored. */
export function addTag(tags: readonly string[], raw: string): { tags: string[]; error: string | null } {
  const tag = normalizeTag(raw);
  if (!tag) return { tags: [...tags], error: null };
  if (tag.length > MAX_TAG_LENGTH) return { tags: [...tags], error: `Tags can be up to ${MAX_TAG_LENGTH} characters.` };
  if (!TAG_CHARS.test(tag)) return { tags: [...tags], error: "Tags use letters, numbers and hyphens only." };
  if (tags.some((t) => t.toLocaleLowerCase() === tag.toLocaleLowerCase())) return { tags: [...tags], error: null };
  if (tags.length >= MAX_TAGS) return { tags: [...tags], error: `Up to ${MAX_TAGS} tags per note.` };
  return { tags: [...tags, tag], error: null };
}

/* Task lines ------------------------------------------------------------------------------------- */

// A list item that starts a task: optional blockquote markers, indent, a bullet or number, then [ ] or [x].
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/;

/**
 * Flips the task checkbox on `line` (1-based, as react-markdown positions report it).
 * "- [ ] x" <-> "- [x] x". Line endings are kept. Returns null when that line is not a task item.
 */
export function toggleTaskLine(markdown: string, line: number): string | null {
  if (!Number.isInteger(line) || line < 1) return null;
  const lines = markdown.split("\n");
  if (line > lines.length) return null;
  const text = lines[line - 1];
  const m = TASK_LINE.exec(text);
  if (!m) return null;
  const next = m[2] === " " ? "x" : " ";
  lines[line - 1] = `${m[1]}[${next}]${text.slice(m[0].length)}`;
  return lines.join("\n");
}

/** Unchecked task lines, the same count the server reports as openActions. */
export function countOpenTasks(markdown: string): number {
  let n = 0;
  for (const line of markdown.split("\n")) {
    const m = TASK_LINE.exec(line);
    if (m && m[2] === " ") n += 1;
  }
  return n;
}

/* Dirty state ------------------------------------------------------------------------------------ */

/** The parts of a note the editor changes. */
export interface NoteFields {
  title: string;
  body: string;
  projectId: string | null;
  tags: string[];
}

export function fieldsOf(note: Pick<Note, "title" | "body" | "projectId" | "tags">): NoteFields {
  return { title: note.title, body: note.body, projectId: note.projectId ?? null, tags: [...note.tags] };
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Only the fields that differ from what the server last accepted. Empty when nothing changed. */
export function notePatch(current: NoteFields, saved: NoteFields): NotePatch {
  const patch: NotePatch = {};
  if (current.title !== saved.title) patch.title = current.title;
  if (current.body !== saved.body) patch.body = current.body;
  if ((current.projectId ?? null) !== (saved.projectId ?? null)) patch.projectId = current.projectId ?? null;
  if (!sameTags(current.tags, saved.tags)) patch.tags = [...current.tags];
  return patch;
}

/** True when the editor holds changes the server has not accepted yet. */
export function isDirty(current: NoteFields, saved: NoteFields): boolean {
  return Object.keys(notePatch(current, saved)).length > 0;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/**
 * True when two versions say the same thing, ignoring what a save round trip may change: CRLF vs LF,
 * trailing whitespace, title padding and tag order. Used to tell "the file changed in Obsidian"
 * from "the server normalised my save".
 */
export function sameContent(a: NoteFields, b: NoteFields): boolean {
  return (
    a.title.trim() === b.title.trim() &&
    normalizeBody(a.body) === normalizeBody(b.body) &&
    (a.projectId ?? null) === (b.projectId ?? null) &&
    sameTags([...a.tags].sort(), [...b.tags].sort())
  );
}

/** Error that stops a save before it is sent, or null. */
export function validateFields(fields: NoteFields): string | null {
  return validateTitle(fields.title) ?? validateBody(fields.body);
}

/** A failed save, sorted by what the person can do about it. */
export type SaveFailure = "offline" | "gone" | "too_large" | "rejected" | "server";

/** Sorts an ApiRequestError-like failure by its HTTP status (0 = offline). */
export function classifySaveError(status: number, offline: boolean): SaveFailure {
  if (offline || status === 0) return "offline";
  if (status === 404) return "gone";
  if (status === 413) return "too_large";
  if (status >= 400 && status < 500) return "rejected";
  return "server";
}

/** Offline and server faults clear up on their own, so autosave tries again. The rest need a change. */
export function isRetryable(failure: SaveFailure): boolean {
  return failure === "offline" || failure === "server";
}

/** Milliseconds before autosave retries after the n-th failure in a row (1-based): 5 s, 15 s, 30 s, then every 60 s. */
export function retryDelayMs(attempt: number): number {
  const steps = [5_000, 15_000, 30_000, 60_000];
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1];
}

/* Dates ------------------------------------------------------------------------------------------ */

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayMonth = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 14:05", "Yesterday 09:30", "Thu 30 Oct", or "30 Oct 2025" in another year. "" if unreadable. */
export function formatNoteDate(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (sameDay(date, now)) return `Today ${clock.format(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday ${clock.format(date)}`;
  if (date.getFullYear() === now.getFullYear()) return dayMonth.format(date).replace(",", "");
  return dayMonthYear.format(date);
}
