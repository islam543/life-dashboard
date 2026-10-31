import type { Note, NoteMeta, NoteSection, NoteTemplate, NotesIndex, NoteVault } from "../../../shared/types";
import type { NotePatch } from "../api/notes";

// Pure helpers for the Notes view (T19): the sections tree, note order, template choice, task-line
// toggling in markdown, validation and the dirty-state logic behind autosave. No React, no DOM:
// unit tested in notes.test.ts. Anything that depends on "now" takes it as a parameter.
//
// Paths are relative to NOTES_DIR, posix, exactly as the server sent them. A note's section is the
// folder part of its path ("Meeting notes/FastBind/2026-10-30-review.md" -> "Meeting notes/FastBind").
//
// v1.4 vaults (T34): other Obsidian vaults sit next to the dashboard's notes folder, and their paths
// start with the vault's prefix ("@learning/wiki/x.md"). The default vault (prefix "") keeps today's
// paths. Helpers that care take the vault list, and null for an older server that sends none: the
// view then works exactly as before (one tree with All notes on top).

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

/* Vaults (v1.4) ---------------------------------------------------------------------------------- */

/** The dashboard's own notes folder: prefix "", today's paths. */
export const DEFAULT_VAULT_ID = "notes";
export const DEFAULT_VAULT_LABEL = "Working-With-Claude notes";
/** Hover help on every lock icon, as the ticket words it. */
export const READ_ONLY_TIP = "Protected by this vault's rules: read only";
/** Why a write control is off in a protected folder or note. */
export const READ_ONLY_REASON = "Protected by this vault's rules, so the dashboard only reads it.";

function normalizeVault(raw: unknown): NoteVault | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<NoteVault>;
  if (typeof v.id !== "string" || typeof v.prefix !== "string") return null;
  return {
    id: v.id,
    label: typeof v.label === "string" && v.label.trim() ? v.label : v.id,
    prefix: v.prefix,
    dir: typeof v.dir === "string" ? v.dir : "",
    readOnlyFolders: Array.isArray(v.readOnlyFolders) ? v.readOnlyFolders.filter((f): f is string => typeof f === "string") : [],
    noteCount: typeof v.noteCount === "number" ? v.noteCount : 0,
  };
}

/**
 * The vaults an index lists, the default vault first. Null for an older server that sends no
 * `vaults` (or nothing readable there): the view then keeps today's single tree. When the list has
 * no default vault, one is added for the dashboard's notes folder (`index.dir`).
 */
export function vaultsOf(index: (Partial<Pick<NotesIndex, "vaults">> & { dir?: string }) | null | undefined): NoteVault[] | null {
  const raw: unknown = index?.vaults;
  if (!Array.isArray(raw)) return null;
  const list = raw.map(normalizeVault).filter((v): v is NoteVault => v !== null);
  if (!list.length) return null;
  const seen = new Set<string>();
  const unique = list.filter((v) => {
    const root = vaultRoot(v);
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
  const fallback: NoteVault = {
    id: DEFAULT_VAULT_ID,
    label: DEFAULT_VAULT_LABEL,
    prefix: "",
    dir: index?.dir ?? "",
    readOnlyFolders: [],
    noteCount: 0,
  };
  const main = unique.find((v) => vaultRoot(v) === "") ?? fallback;
  return [main, ...unique.filter((v) => vaultRoot(v) !== "")];
}

/** The tree path of a vault's own row: "" for the default vault, "@learning" for prefix "@learning/". */
export function vaultRoot(vault: Pick<NoteVault, "prefix">): string {
  return vault.prefix.replace(/\/+$/, "");
}

/** True when `path` is the row of a whole vault ("" is the default vault's row once vaults exist). */
export function isVaultRoot(path: string, vaults: readonly NoteVault[] | null): boolean {
  return !!vaults && vaults.some((v) => vaultRoot(v) === path);
}

/**
 * Prefix parsing: the vault a note or folder path belongs to (the one whose prefix it starts with,
 * else the default vault) and the path inside that vault. "@learning/wiki/x.md" gives Learning and
 * "wiki/x.md"; "Meeting notes/a.md" gives the default vault and the path unchanged. A folder named
 * "@something" that is no vault's prefix stays in the default vault. Vault null without vaults.
 */
export function splitVaultPath(path: string, vaults: readonly NoteVault[] | null): { vault: NoteVault | null; inner: string } {
  if (!vaults?.length) return { vault: null, inner: path };
  for (const vault of vaults) {
    const root = vaultRoot(vault);
    if (!root) continue;
    if (path === root) return { vault, inner: "" };
    if (path.startsWith(`${root}/`)) return { vault, inner: path.slice(root.length + 1) };
  }
  return { vault: vaults.find((v) => vaultRoot(v) === "") ?? null, inner: path };
}

export function vaultOfPath(path: string, vaults: readonly NoteVault[] | null): NoteVault | null {
  return splitVaultPath(path, vaults).vault;
}

/** The vault id of a note: what the server said, else what its path says. */
export function noteVaultId(note: Pick<NoteMeta, "path"> & { vault?: string }, vaults: readonly NoteVault[] | null): string {
  if (typeof note.vault === "string" && note.vault) return note.vault;
  return vaultOfPath(note.path, vaults)?.id ?? DEFAULT_VAULT_ID;
}

/** Depth of a folder inside its own vault (the "@learning" part does not count). */
export function folderDepth(path: string, vaults: readonly NoteVault[] | null): number {
  return sectionDepth(splitVaultPath(path, vaults).inner);
}

function cleanFolder(folder: string, root: string): string {
  let f = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (root && (f === root || f.startsWith(`${root}/`))) f = f.slice(root.length).replace(/^\/+/, "");
  return f.toLocaleLowerCase();
}

function protectedFolders(vault: NoteVault): string[] {
  const root = vaultRoot(vault);
  return vault.readOnlyFolders.map((f) => cleanFolder(f, root)).filter(Boolean);
}

/**
 * True when a folder or note path is one of its vault's read-only folders or sits inside one
 * ("@learning/raw", "@learning/raw/a/b.md"). Compared per segment, ignoring case like Windows does.
 */
export function isProtectedPath(path: string, vaults: readonly NoteVault[] | null): boolean {
  const { vault, inner } = splitVaultPath(path, vaults);
  if (!vault || !inner) return false;
  const p = inner.toLocaleLowerCase();
  return protectedFolders(vault).some((f) => p === f || p.startsWith(`${f}/`));
}

/** True when a read-only folder sits inside `path` (the server then refuses to rename or delete it). */
export function holdsProtected(path: string, vaults: readonly NoteVault[] | null): boolean {
  const { vault, inner } = splitVaultPath(path, vaults);
  if (!vault) return false;
  const p = inner.toLocaleLowerCase();
  return protectedFolders(vault).some((f) => !p || f.startsWith(`${p}/`));
}

/** A folder the dashboard may only read: the server marks it, or its vault's rules cover it. */
export function isReadOnlySection(section: Pick<NoteSection, "path" | "readOnly">, vaults: readonly NoteVault[] | null): boolean {
  return section.readOnly === true || isProtectedPath(section.path, vaults);
}

/** A note the dashboard may only read. */
export function isReadOnlyNote(note: Pick<NoteMeta, "path"> & { readOnly?: boolean }, vaults: readonly NoteVault[] | null): boolean {
  return note.readOnly === true || isProtectedPath(note.path, vaults);
}

/** One vault in the tree: its row path ("" or "@learning") and the folders under it. */
export interface VaultGroup {
  vault: NoteVault;
  root: string;
  children: NoteSection[];
}

/**
 * Grouping by vault, in `vaults` order. The default vault holds every top section that is not
 * another vault's row (so Tasks and the dashboard's sections stay where they are); each other vault
 * holds the children of its own top section, or nothing when the server sent none (an empty vault).
 */
export function vaultGroups(sections: readonly NoteSection[], vaults: readonly NoteVault[]): VaultGroup[] {
  const roots = new Set(vaults.map(vaultRoot).filter(Boolean));
  return vaults.map((vault) => {
    const root = vaultRoot(vault);
    if (!root) return { vault, root, children: sections.filter((s) => !roots.has(s.path)) };
    return { vault, root, children: sections.find((s) => s.path === root)?.children ?? [] };
  });
}

/** True when `path` is a folder in the tree or, with vaults, a vault's row. */
export function placeExists(sections: readonly NoteSection[], vaults: readonly NoteVault[] | null, path: string): boolean {
  if (path === ALL_NOTES) return true;
  return isVaultRoot(path, vaults) || findSection(sections, path) !== null;
}

/**
 * A folder path as people read it: "Meeting notes / FastBind", "Learning / wiki / ai". A vault's row
 * reads as its label. `withVault` also names the default vault ("Working-With-Claude notes / Tasks").
 * Without vaults, the same as sectionLabel.
 */
export function placeLabel(path: string, vaults: readonly NoteVault[] | null, withVault = false): string {
  if (!vaults) return sectionLabel(path);
  const { vault, inner } = splitVaultPath(path, vaults);
  if (!vault) return sectionLabel(path);
  if (!inner) return vault.label;
  const parts = inner.split("/");
  return vaultRoot(vault) || withVault ? [vault.label, ...parts].join(" / ") : parts.join(" / ");
}

/**
 * The tree rows to open so `section` shows: its vault's row (when vaults exist) and every ancestor
 * folder, outermost first.
 */
export function openTrail(section: string, vaults: readonly NoteVault[] | null): string[] {
  const trail = ancestorsOf(section);
  if (!vaults) return trail;
  const vault = vaultOfPath(section, vaults);
  const root = vault ? vaultRoot(vault) : ALL_NOTES;
  return [root, ...trail.filter((p) => p !== root)];
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

/**
 * sectionCounts plus, with vaults, one count per vault row: "" counts only the default vault's
 * notes (not every note), and a vault without a top section still gets its count.
 */
export function treeCounts(
  sections: readonly NoteSection[],
  notes: readonly (Pick<NoteMeta, "path"> & { vault?: string })[],
  vaults: readonly NoteVault[] | null,
): Map<string, SectionCount> {
  const counts = sectionCounts(sections, notes);
  if (!vaults) return counts;
  const byVault = new Map<string, number>();
  for (const note of notes) {
    const id = noteVaultId(note, vaults);
    byVault.set(id, (byVault.get(id) ?? 0) + 1);
  }
  for (const vault of vaults) {
    const root = vaultRoot(vault);
    counts.set(root, { direct: counts.get(root)?.direct ?? 0, total: byVault.get(vault.id) ?? 0 });
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
  /** "all": All notes (no vaults). "vault": a whole vault's row. "folder": a section or folder. */
  kind: "all" | "vault" | "folder";
  /** A protected folder: shown with a lock, never written to. */
  readOnly: boolean;
}

function walkRows(
  rows: TreeRow[],
  list: readonly NoteSection[],
  level: number,
  parent: string | null,
  offset: number,
  isOpen: (path: string) => boolean,
  readOnly: (s: NoteSection) => boolean,
): void {
  list.forEach((s, i) => {
    const hasChildren = s.children.length > 0;
    const open = hasChildren && isOpen(s.path);
    rows.push({
      path: s.path,
      name: s.name,
      level,
      posInSet: i + 1 + offset,
      setSize: list.length + offset,
      hasChildren,
      expanded: open,
      parent,
      kind: "folder",
      readOnly: readOnly(s),
    });
    if (open) walkRows(rows, s.children, level + 1, s.path, 0, isOpen, readOnly);
  });
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
      kind: "all",
      readOnly: false,
    },
  ];
  walkRows(rows, sections, 1, null, 1, (p) => expanded.has(p), (s) => s.readOnly === true);
  return rows;
}

/**
 * The rows of the tree grouped by vault: one row per vault (open unless its row path is in
 * `collapsedVaults`), then that vault's folders depth first, each open only when in `expanded`.
 * So a big vault starts with its first level of folders showing and everything deeper closed.
 */
export function vaultRows(
  groups: readonly VaultGroup[],
  expanded: ReadonlySet<string>,
  collapsedVaults: ReadonlySet<string>,
  vaults: readonly NoteVault[],
): TreeRow[] {
  const rows: TreeRow[] = [];
  groups.forEach((g, i) => {
    const hasChildren = g.children.length > 0;
    const open = hasChildren && !collapsedVaults.has(g.root);
    rows.push({
      path: g.root,
      name: g.vault.label,
      level: 1,
      posInSet: i + 1,
      setSize: groups.length,
      hasChildren,
      expanded: open,
      parent: null,
      kind: "vault",
      readOnly: false,
    });
    if (open) walkRows(rows, g.children, 2, g.root, 0, (p) => expanded.has(p), (s) => isReadOnlySection(s, vaults));
  });
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

/**
 * The notes the list shows for the open row, newest first. With vaults, the default vault's row ("")
 * lists only that vault's notes and another vault's row lists all of its notes; a folder lists itself
 * and its subfolders. Without vaults, "" is All notes, as before.
 */
export function notesInScope<T extends NoteMeta>(notes: readonly T[], scope: string, vaults: readonly NoteVault[] | null): T[] {
  if (!vaults || scope !== ALL_NOTES) return notesIn(notes, scope);
  const id = vaults.find((v) => vaultRoot(v) === "")?.id ?? DEFAULT_VAULT_ID;
  return sortNotes(notes.filter((n) => noteVaultId(n, vaults) === id));
}

function words(query: string): string[] {
  return query.toLocaleLowerCase().split(/[\s/]+/).filter(Boolean);
}

/** The list filter: notes whose title holds every typed word, in any order, ignoring case. Order kept. */
export function filterByTitle<T extends Pick<NoteMeta, "title">>(notes: readonly T[], query: string): T[] {
  const want = words(query);
  if (!want.length) return [...notes];
  return notes.filter((n) => {
    const title = (n.title || "Untitled note").toLocaleLowerCase();
    return want.every((w) => title.includes(w));
  });
}

/* Where a new note goes (v1.4) -------------------------------------------------------------------- */

/** One folder the New note form can write to. */
export interface FolderOption {
  /** Section path to send as `section`, prefix included ("@learning/wiki"). */
  path: string;
  /** Folder names inside the vault, outermost first; empty for a vault's top level. */
  parts: string[];
  /** The top level of a vault other than the default one. */
  root: boolean;
}

/**
 * Folder options for one vault: every folder in tree order, skipping protected folders and all
 * that is inside them. Another vault's own top level comes first; the default vault's top level is
 * not offered (notes there live in sections, as before). Without vaults, every writable section.
 */
export function folderOptions(
  sections: readonly NoteSection[],
  vaults: readonly NoteVault[] | null,
  vaultId: string | null,
): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (list: readonly NoteSection[], skip: string) => {
    for (const s of list) {
      if (isReadOnlySection(s, vaults)) continue;
      const inner = skip && s.path.startsWith(`${skip}/`) ? s.path.slice(skip.length + 1) : s.path;
      out.push({ path: s.path, parts: inner.split("/"), root: false });
      walk(s.children, skip);
    }
  };
  if (!vaults) {
    walk(sections, "");
    return out;
  }
  const group = vaultGroups(sections, vaults).find((g) => g.vault.id === vaultId);
  if (!group) return out;
  if (group.root) out.push({ path: group.root, parts: [], root: true });
  walk(group.children, group.root);
  return out;
}

/** The folder search in the New note form: options whose path holds every typed word. */
export function filterFolderOptions(options: readonly FolderOption[], query: string): FolderOption[] {
  const want = words(query);
  if (!want.length) return [...options];
  return options.filter((o) => {
    const hay = `${o.root ? "top level " : ""}${o.parts.join("/")}`.toLocaleLowerCase();
    return want.every((w) => hay.includes(w));
  });
}

/** Where the New note form points when it opens. `vault` is null without vaults. */
export interface Destination {
  vault: string | null;
  folder: string;
}

function preferredSection(options: readonly FolderOption[]): FolderOption | undefined {
  return options.find((o) => !o.root && o.parts.length === 1 && o.parts[0].toLocaleLowerCase() === "meeting notes") ?? options[0];
}

/**
 * The default destination for New note, from the open row `selected`:
 * - a folder that takes notes: that folder;
 * - a protected folder: its nearest writable parent, which for another vault ends at its top level;
 * - a vault's row: that vault's top level, or for the default vault Meeting notes, then its first section;
 * - anything else, or a vault with nowhere to write: the default vault (Working-With-Claude) the same way.
 * Null when no vault has anywhere to write.
 */
export function defaultDestination(
  sections: readonly NoteSection[],
  vaults: readonly NoteVault[] | null,
  selected: string,
): Destination | null {
  const pick = (vaultId: string | null, from: string | null): Destination | null => {
    const options = folderOptions(sections, vaults, vaultId);
    if (!options.length) return null;
    const writable = new Set(options.map((o) => o.path));
    for (let p = from; p; p = p.includes("/") ? parentPath(p) : null) {
      if (writable.has(p)) return { vault: vaultId, folder: p };
    }
    const fallback = preferredSection(options);
    return fallback ? { vault: vaultId, folder: fallback.path } : null;
  };
  if (!vaults) return pick(null, selected === ALL_NOTES ? null : selected);
  const own = vaultOfPath(selected, vaults);
  const main = vaults.find((v) => vaultRoot(v) === "") ?? vaults[0];
  return (own ? pick(own.id, selected) : null) ?? (own?.id === main.id ? null : pick(main.id, null));
}

/** The vault New note offers first: the one the destination is in, else the default vault. */
export function defaultVaultId(vaults: readonly NoteVault[] | null, destination: Destination | null): string | null {
  if (!vaults) return null;
  return destination?.vault ?? vaults[0]?.id ?? DEFAULT_VAULT_ID;
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
export type SaveFailure = "offline" | "gone" | "too_large" | "forbidden" | "rejected" | "server";

/** Sorts an ApiRequestError-like failure by its HTTP status (0 = offline). 403 = a protected folder (v1.4). */
export function classifySaveError(status: number, offline: boolean): SaveFailure {
  if (offline || status === 0) return "offline";
  if (status === 403) return "forbidden";
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
