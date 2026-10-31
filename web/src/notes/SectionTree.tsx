import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { NoteSection, NoteTemplate, NoteVault } from "../../../shared/types";
import type { MenuAction, MenuSection } from "../lib/contextMenu";
import { formatNumber } from "../lib/format";
import {
  ALL_NOTES,
  baseName,
  deleteBlockedReason,
  findSection,
  folderDepth,
  holdsProtected,
  isReadOnlySection,
  isVaultRoot,
  joinPath,
  MAX_SECTION_DEPTH,
  parentPath,
  READ_ONLY_REASON,
  READ_ONLY_TIP,
  treeKeyAction,
  typeAhead,
  validateSectionName,
  vaultGroups,
  vaultOfPath,
  vaultRoot,
  vaultRows,
  visibleRows,
  type SectionCount,
  type TreeKey,
  type TreeRow,
} from "../lib/notes";
import { Button } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { copyText, placePath } from "./filePaths";
import { CheckIcon, ChevronIcon, CopyIcon, LockIcon, PencilIcon, PlusIcon, StackIcon, TrashIcon, VaultIcon } from "./icons";
import styles from "./SectionTree.module.css";

// Sections (folders) as a WAI-ARIA tree: one tab stop, arrows move, Right and Left open and close,
// Home and End jump, Enter or Space opens a section in the list, F2 renames it, typing a letter jumps
// to the next section starting with it. Below the tree: New subsection, Rename and Delete for the
// open section (Delete only when it is empty, with the reason shown otherwise), then the open
// section's folder path so the files can be found in Obsidian.
//
// v1.4 vaults: with `vaults`, the tree has one row per vault (open unless closed here) instead of
// All notes, and each vault's folders under it. Working-With-Claude keeps its sections (Tasks
// included); the other vaults' folders are called folders. A protected folder (the vault's own
// rules) shows a lock and takes no new notes, subfolders, renames or deletes; a folder holding one
// keeps its name and place. Without `vaults` (an older server) the tree is exactly as before.
//
// Right-click (or the menu key) on a row offers the same actions for that row without opening it
// first: New note here, New meeting note here, New subsection, Rename, Copy folder path and Delete.
// Each one calls the handler its visible control calls.

export interface SectionTreeHandle {
  /** Move focus to the open section's row (after coming back to this pane on a phone). */
  focusSelected: () => void;
}

export interface SectionTreeProps {
  sections: NoteSection[];
  /** v1.4 vaults, default first; null for an older server (one tree with All notes on top). */
  vaults: NoteVault[] | null;
  counts: Map<string, SectionCount>;
  selected: string;
  expanded: ReadonlySet<string>;
  /** Vault rows closed in this browser (vault rows start open). */
  collapsedVaults: ReadonlySet<string>;
  /** Absolute notes folder, shown as plain text. */
  notesDir: string;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
  /** Resolve with an error message, or null on success. */
  onCreate: (parent: string, name: string) => Promise<string | null>;
  onRename: (path: string, name: string) => Promise<string | null>;
  onDelete: (path: string) => Promise<string | null>;
  /**
   * Opens the New note form for a row (its default destination), with a template picked when one is
   * given. The same form the New note button opens.
   */
  onNewNote: (section: string, template: NoteTemplate | null) => void;
}

const NO_SECTIONS_REASON = "Notes live in sections; add one with New section first.";
const COPIED_MS = 2000;
/** Folder names longer than this may be cut off in the tree; their tip then starts with the name. */
const LONG_NAME = 22;

type Editing = { kind: "create"; parent: string } | { kind: "rename"; path: string } | null;

const TREE_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** What a row is and what may be done to it. */
interface Place {
  path: string;
  kind: TreeRow["kind"];
  section: NoteSection | null;
  vault: NoteVault | null;
  /** The row's own name: the vault's label, the folder's name, or All notes. */
  name: string;
  /** "section" in Working-With-Claude (and without vaults), "folder" in the other vaults. */
  word: "section" | "folder";
  readOnly: boolean;
  /** Why it can't hold a new subfolder, or null. */
  childBlocked: string | null;
  /** Folders only: why it can't be renamed, or null. */
  renameBlocked: string | null;
  /** Folders only: why it can't be deleted, or null. */
  deleteBlocked: string | null;
}

function NameForm({
  label,
  initial,
  level,
  siblings,
  submitLabel,
  submitTip,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  level: number;
  siblings: string[];
  submitLabel: string;
  /** Hover help on the check button. */
  submitTip: string;
  onSubmit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `section-name-error-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const name = value.trim();
    if (name === initial.trim() && initial) {
      onCancel();
      return;
    }
    const problem = validateSectionName(name, siblings);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    const failed = await onSubmit(name);
    setBusy(false);
    if (failed) {
      setError(failed);
      inputRef.current?.focus();
    }
  };

  return (
    <li role="none" className={styles.formRow} style={{ "--level": level } as CSSProperties}>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={value}
          dir="auto"
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(validateSectionName(e.target.value, siblings));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          onBlur={(e) => {
            // Leaving the field: an empty or unchanged name cancels, anything else is saved.
            if (e.currentTarget.form?.contains(e.relatedTarget as Node | null)) return;
            if (!value.trim() || value.trim() === initial.trim()) onCancel();
            else void submit();
          }}
        />
        <button type="submit" className={styles.formSubmit} disabled={busy} aria-label={submitLabel} data-tip={submitTip}>
          <CheckIcon />
        </button>
      </form>
      {error ? (
        <p id={errorId} className={styles.formError} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.formHint}>Enter to save, Esc to cancel</p>
      )}
    </li>
  );
}

export const SectionTree = forwardRef<SectionTreeHandle, SectionTreeProps>(function SectionTree(
  {
    sections,
    vaults,
    counts,
    selected,
    expanded,
    collapsedVaults,
    notesDir,
    onToggle,
    onSelect,
    onCreate,
    onRename,
    onDelete,
    onNewNote,
  },
  ref,
) {
  const groups = useMemo(() => (vaults ? vaultGroups(sections, vaults) : null), [sections, vaults]);
  const rows = useMemo(
    () => (groups && vaults ? vaultRows(groups, expanded, collapsedVaults, vaults) : visibleRows(sections, expanded)),
    [groups, vaults, sections, expanded, collapsedVaults],
  );
  /** The row everything falls back to: All notes, or Working-With-Claude's vault row. */
  const home = ALL_NOTES;
  const [focusPath, setFocusPath] = useState(selected);
  const [editing, setEditing] = useState<Editing>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Path of the section being deleted, so only its own Delete control shows the spinner. */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Path whose folder was just copied; the Copy path button reads Copied while it is the open one. */
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The row a right-click landed on (its path; "" for All notes or Working-With-Claude), or null for the pane around the tree. */
  const menuRow = useRef<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const wantFocus = useRef<string | null>(null);
  const uid = useId().replace(/:/g, "");
  const reasonId = `section-reason-${uid}`;
  const labelId = `sections-label-${uid}`;

  // Keep the roving tab stop on a row that exists (after a delete, a rename or a collapse).
  const tabStop = rows.some((r) => r.path === focusPath) ? focusPath : rows.some((r) => r.path === selected) ? selected : home;

  useEffect(() => {
    const target = wantFocus.current;
    if (target === null) return;
    const el = itemRefs.current.get(target);
    if (el) {
      wantFocus.current = null;
      el.focus();
    }
  });

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // A note opened by a link can select a folder deep in a big vault: bring its row into view.
  useEffect(() => {
    itemRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    focusSelected: () => {
      setFocusPath(selected);
      wantFocus.current = selected;
      itemRefs.current.get(selected)?.focus();
    },
  }));

  const focusRow = (path: string) => {
    setFocusPath(path);
    wantFocus.current = path;
  };

  /** What a row is and what it allows. Null for a path that is no row (gone). */
  const placeOf = (path: string): Place | null => {
    const vault = vaultOfPath(path, vaults);
    const word = vault && vaultRoot(vault) ? "folder" : "section";
    const words = word === "folder" ? "Folders" : "Sections";
    const depth = folderDepth(path, vaults);
    const tooDeep = depth >= MAX_SECTION_DEPTH ? `${words} nest ${MAX_SECTION_DEPTH} levels deep at most, so this one can't hold sub${word}s.` : null;
    if (!vaults && path === ALL_NOTES) {
      return { path, kind: "all", section: null, vault: null, name: "All notes", word, readOnly: false, childBlocked: null, renameBlocked: null, deleteBlocked: null };
    }
    if (vaults && vault && isVaultRoot(path, vaults)) {
      return { path, kind: "vault", section: null, vault, name: vault.label, word, readOnly: false, childBlocked: null, renameBlocked: null, deleteBlocked: null };
    }
    const section = findSection(sections, path);
    if (!section) return null;
    const readOnly = isReadOnlySection(section, vaults);
    const holds = !readOnly && holdsProtected(path, vaults) ? "It holds a protected folder, so the vault's rules keep its name and place." : null;
    const notEmpty = deleteBlockedReason(section, counts.get(path));
    return {
      path,
      kind: "folder",
      section,
      vault,
      name: section.name,
      word,
      readOnly,
      childBlocked: readOnly ? READ_ONLY_REASON : tooDeep,
      renameBlocked: readOnly ? READ_ONLY_REASON : holds,
      deleteBlocked: readOnly ? READ_ONLY_REASON : (holds ?? (notEmpty && word === "folder" ? notEmpty.replace(/section/g, "folder") : notEmpty)),
    };
  };

  /** The rows directly under `parent`, for duplicate-name checks. */
  const childrenOf = (parent: string): NoteSection[] => {
    if (groups && isVaultRoot(parent, vaults)) return groups.find((g) => g.root === parent)?.children ?? [];
    if (parent === ALL_NOTES) return sections;
    return findSection(sections, parent)?.children ?? [];
  };

  const siblingNames = (parent: string, except?: string): string[] =>
    childrenOf(parent)
      .filter((s) => s.path !== except)
      .map((s) => s.name);

  const current = placeOf(selected) ?? placeOf(home);
  /** The folder shown and copied under the tree: the open row's. */
  const folder = current?.path ?? home;

  /** Shows the inline name field for a new folder inside `parent` (legacy ALL_NOTES: a top-level section). */
  const startCreate = (parent: string) => {
    const place = placeOf(parent);
    if (!place || place.childBlocked) return;
    setDeleteError(null);
    const row = rows.find((r) => r.path === parent);
    if (row && row.kind !== "all" && row.hasChildren && !row.expanded) onToggle(parent, true);
    setEditing({ kind: "create", parent });
  };

  const startRename = (path: string) => {
    const place = placeOf(path);
    if (!place || place.kind !== "folder" || place.renameBlocked) return;
    setDeleteError(null);
    setEditing({ kind: "rename", path });
  };

  const stopEditing = (focusTo: string) => {
    setEditing(null);
    focusRow(focusTo);
  };

  /** Deletes an empty folder (the open one from the toolbar, any one from its right-click menu). */
  const remove = async (place: Place | null) => {
    if (!place || place.kind !== "folder" || deleting !== null || place.deleteBlocked) return;
    setDeleting(place.path);
    setDeleteError(null);
    const { name, path, word } = place;
    const failed = await onDelete(path);
    setDeleting(null);
    if (failed) {
      setDeleteError(path === selected ? failed : `Couldn't delete ${name}. ${failed}`);
      return;
    }
    setStatus(`Deleted ${word} ${name}.`);
    // Focus moves to the parent row when it was in the tree (or lost with the row), never out of the editor.
    const active = document.activeElement;
    if (!active || active === document.body || wrapRef.current?.contains(active)) focusRow(parentPath(path));
    else setFocusPath(parentPath(path));
  };

  /** Copies a row's full folder path (All notes and Working-With-Claude: the notes folder). */
  const copyFolder = (path: string) => {
    const place = placeOf(path);
    void copyText(placePath(path, vaults, notesDir)).then((ok) => {
      if (!ok) return;
      setCopied(path);
      setStatus(
        place?.kind === "all" ? "Copied the notes folder path." : `Copied the folder path of ${place?.name ?? baseName(path)}.`,
      );
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
    });
  };

  /* Right-click menu ----------------------------------------------------------------------------- */

  const defaultGroup = groups?.find((g) => g.root === ALL_NOTES);
  /** Working-With-Claude takes notes only in sections; the other vaults also at their top level. */
  const noSections = (defaultGroup ? defaultGroup.children : sections).length === 0;

  const newSectionItem: MenuAction = {
    label: "New section",
    icon: <PlusIcon />,
    onSelect: () => startCreate(home),
    tip: vaults
      ? `Adds a top-level section to ${defaultGroup?.vault.label ?? "your notes folder"}; type its name, then press Enter.`
      : "Adds a top-level folder to your notes folder; type its name, then press Enter.",
  };

  const copyItem = (place: Place): MenuAction => ({
    label: "Copy folder path",
    icon: <CopyIcon />,
    onSelect: () => copyFolder(place.path),
    tip:
      place.kind === "folder"
        ? `Copies this ${place.word}'s full folder path, so you can open it in File Explorer or Obsidian.`
        : place.kind === "vault" && place.vault && vaultRoot(place.vault)
          ? "Copies this vault's folder path, so you can open it in File Explorer or Obsidian."
          : "Copies the notes folder path, so you can open it in File Explorer or Obsidian.",
  });

  const menu = useMenuRegion((): MenuSection | null => {
    const path = menuRow.current;
    if (path === null) return { title: vaults ? "Vaults" : "Sections", items: [newSectionItem] };
    const place = placeOf(path);
    if (!place) return null;

    if (place.kind === "all") {
      return {
        title: "All notes",
        items: [
          {
            label: "New note",
            icon: <PlusIcon />,
            onSelect: () => onNewNote(ALL_NOTES, null),
            disabled: noSections ? NO_SECTIONS_REASON : false,
            tip: "Opens the new note form; pick its section and template there.",
          },
          {
            label: "New meeting note",
            onSelect: () => onNewNote(ALL_NOTES, "meeting"),
            disabled: noSections ? NO_SECTIONS_REASON : false,
            tip: "Opens the new note form with the Meeting template picked.",
          },
          newSectionItem,
          copyItem(place),
        ],
      };
    }

    if (place.kind === "vault") {
      const other = !!place.vault && vaultRoot(place.vault) !== "";
      const blocked = other ? false : noSections ? NO_SECTIONS_REASON : false;
      return {
        title: place.name,
        items: [
          {
            label: other ? "New note here" : "New note",
            icon: <PlusIcon />,
            onSelect: () => onNewNote(path, null),
            disabled: blocked,
            tip: other
              ? "Opens the new note form at this vault's top level; you can pick another folder there."
              : "Opens the new note form in this vault; pick its section and template there.",
          },
          {
            label: other ? "New meeting note here" : "New meeting note",
            onSelect: () => onNewNote(path, "meeting"),
            disabled: blocked,
            tip: "Opens the new note form in this vault with the Meeting template picked.",
          },
          other
            ? {
                label: "New folder",
                onSelect: () => startCreate(path),
                tip: "Adds a top-level folder to this vault; type its name, then press Enter.",
              }
            : newSectionItem,
          copyItem(place),
        ],
      };
    }

    const { word, readOnly } = place;
    return {
      title: place.name,
      items: [
        {
          label: "New note here",
          icon: <PlusIcon />,
          onSelect: () => onNewNote(path, null),
          disabled: readOnly ? READ_ONLY_REASON : false,
          tip: `Opens the new note form with this ${word} picked; the template follows the ${word}.`,
        },
        {
          label: "New meeting note here",
          onSelect: () => onNewNote(path, "meeting"),
          disabled: readOnly ? READ_ONLY_REASON : false,
          tip: `Opens the new note form with this ${word} and the Meeting template picked.`,
        },
        {
          label: `New sub${word}`,
          onSelect: () => startCreate(path),
          disabled: place.childBlocked ?? false,
          tip: `Adds a folder inside this ${word}; type its name, then press Enter.`,
        },
        {
          label: "Rename",
          icon: <PencilIcon />,
          hint: "F2",
          onSelect: () => startRename(path),
          disabled: place.renameBlocked ?? false,
          tip: `Renames this ${word}'s folder on disk, and its notes move with it.`,
        },
        copyItem(place),
        {
          label: `Delete ${word}`,
          icon: <TrashIcon />,
          danger: true,
          onSelect: () => void remove(place),
          disabled: place.deleteBlocked ?? (deleting !== null ? `Another ${word} is being deleted; try again in a moment.` : false),
          tip: `Removes this empty ${word}'s folder right away; no notes are affected.`,
        },
      ],
    };
  });

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!(e.target instanceof HTMLLIElement) || e.target.getAttribute("role") !== "treeitem") return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const focused = tabStop;
    if (TREE_KEYS.has(e.key)) {
      e.preventDefault();
      const move = treeKeyAction(rows, focused, e.key as TreeKey);
      if (move.kind === "focus") focusRow(move.path);
      else if (move.kind === "expand") onToggle(move.path, true);
      else if (move.kind === "collapse") onToggle(move.path, false);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(focused);
      return;
    }
    if (e.key === "F2") {
      e.preventDefault();
      startRename(focused);
      return;
    }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const next = typeAhead(rows, focused, e.key);
      if (next !== null) {
        e.preventDefault();
        focusRow(next);
      }
    }
  };

  // Where the inline "new folder" field goes: after the parent's last visible descendant.
  let createAfter = -1;
  let createLevel = 1;
  if (editing?.kind === "create") {
    const start = rows.findIndex((r) => r.path === editing.parent);
    const parentRow = rows[start];
    if (!parentRow || parentRow.kind === "all") {
      createAfter = rows.length - 1;
      createLevel = 1;
    } else {
      createAfter = start;
      createLevel = parentRow.level + 1;
      for (let i = start + 1; i < rows.length && rows[i].level > parentRow.level; i++) createAfter = i;
    }
  }

  const rowTip = (row: TreeRow, place: Place | null): string => {
    if (row.kind === "all") return "Lists every note from every section, newest first.";
    if (row.kind === "vault") {
      const dir = place?.vault?.dir;
      return `Lists every note in ${row.name}, newest first.${dir ? ` Folder: ${dir}` : ""}`;
    }
    const word = place?.word ?? "section";
    const subs = row.hasChildren ? `, sub${word}s included,` : "";
    // A long name may be cut off in the narrow tree, so the tip starts with it.
    const named = row.name.length > LONG_NAME ? `${row.name}: ` : "";
    if (row.readOnly) return `${named}Lists this ${word}'s notes${subs} newest first; they open read only.`;
    const f2 = place?.renameBlocked ? "" : "; F2 renames it";
    return `${named}Lists this ${word}'s notes${subs} newest first${f2}.`;
  };

  const twistyTip = (row: TreeRow, place: Place | null): string | undefined => {
    if (!row.hasChildren) return undefined;
    const what = row.kind === "vault" ? "this vault's folders" : `the sub${place?.word ?? "section"}s`;
    return row.expanded
      ? `Hides ${what}; the Left arrow key does the same.`
      : `Shows ${what}; the Right arrow key does the same.`;
  };

  const renderRow = (row: TreeRow) => {
    if (editing?.kind === "rename" && editing.path === row.path) {
      const word = placeOf(row.path)?.word ?? "section";
      return (
        <NameForm
          key={`rename-${row.path}`}
          label={`New name for ${row.name}`}
          initial={row.name}
          level={row.level}
          siblings={siblingNames(parentPath(row.path), row.path)}
          submitLabel="Save name"
          submitTip={`Renames the ${word}'s folder on disk, and the notes inside move with it; Esc cancels.`}
          onCancel={() => stopEditing(row.path)}
          onSubmit={async (name) => {
            const failed = await onRename(row.path, name);
            if (!failed) {
              setStatus(`Renamed to ${name}.`);
              stopEditing(joinPath(parentPath(row.path), name));
            }
            return failed;
          }}
        />
      );
    }
    const place = placeOf(row.path);
    const count = counts.get(row.path)?.total ?? 0;
    return (
      <li
        key={row.path || "__all"}
        ref={(el) => {
          if (el) itemRefs.current.set(row.path, el);
          else itemRefs.current.delete(row.path);
        }}
        role="treeitem"
        aria-level={row.level}
        aria-posinset={row.posInSet}
        aria-setsize={row.setSize}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={row.path === selected}
        tabIndex={row.path === tabStop ? 0 : -1}
        className={styles.item}
        style={{ "--level": row.level } as CSSProperties}
        data-section={row.path}
        data-kind={row.kind}
        data-all={row.kind === "all" ? "" : undefined}
        data-tip={rowTip(row, place)}
        onClick={() => {
          setFocusPath(row.path);
          onSelect(row.path);
        }}
        onFocus={() => setFocusPath(row.path)}
      >
        <span
          className={styles.twisty}
          data-open={row.expanded ? "" : undefined}
          aria-hidden="true"
          data-tip={twistyTip(row, place)}
          onClick={(e) => {
            if (!row.hasChildren) return;
            e.stopPropagation();
            onToggle(row.path, !row.expanded);
          }}
        >
          {row.hasChildren ? <ChevronIcon /> : row.kind === "all" ? <StackIcon /> : null}
        </span>
        {row.kind === "vault" ? (
          <span className={styles.vaultIcon} aria-hidden="true">
            <VaultIcon />
          </span>
        ) : null}
        <span className={styles.name} dir="auto">
          {row.name}
        </span>
        {row.readOnly ? (
          <span className={styles.lock} data-tip={READ_ONLY_TIP}>
            <LockIcon size={13} />
            <span className="sr-only">, read only</span>
          </span>
        ) : null}
        <span className={`${styles.count} num`} aria-hidden="true">
          {formatNumber(count)}
        </span>
        <span className="sr-only">, {count === 1 ? "1 note" : `${formatNumber(count)} notes`}</span>
      </li>
    );
  };

  const items: JSX.Element[] = [];
  rows.forEach((row, i) => {
    items.push(renderRow(row));
    if (editing?.kind === "create" && i === createAfter) {
      const parent = editing.parent;
      const place = placeOf(parent);
      const word = place?.word ?? "section";
      const top = !place || place.kind !== "folder";
      items.push(
        <NameForm
          key="create"
          label={top ? `Name of the new ${word}${place?.kind === "vault" && word === "folder" ? ` in ${place.name}` : ""}` : `Name of the new sub${word} in ${baseName(parent)}`}
          initial=""
          level={createLevel}
          siblings={siblingNames(parent)}
          submitLabel={`Create ${word}`}
          submitTip={
            word === "folder"
              ? "Creates the folder in this vault, where Obsidian sees it too; Esc cancels."
              : "Creates the folder in your notes folder, where Obsidian sees it too; Esc cancels."
          }
          onCancel={() => stopEditing(parent)}
          onSubmit={async (name) => {
            const failed = await onCreate(parent, name);
            if (!failed) {
              setStatus(`Created ${word} ${name}.`);
              stopEditing(joinPath(parent, name));
            }
            return failed;
          }}
        />,
      );
    }
  });

  /* Toolbar for the open row ---------------------------------------------------------------------- */

  const isFolder = current?.kind === "folder";
  const word = current?.word ?? "section";
  const otherVault = current?.kind === "vault" && !!current.vault && vaultRoot(current.vault) !== "";
  const newLabel = isFolder ? `New sub${word}` : otherVault ? "New folder" : "New section";
  const childBlocked = current?.childBlocked ?? null;
  const reasons = [...new Set([childBlocked, current?.renameBlocked ?? null, current?.deleteBlocked ?? null].filter(Boolean))];
  const reason = reasons.join(" ") || null;
  const vaultLabel = current?.vault?.label;
  const newTip = childBlocked
    ? current?.readOnly
      ? "Does nothing here because this folder is protected by the vault's rules."
      : `Does nothing here because ${word}s nest ${MAX_SECTION_DEPTH} levels deep at most.`
    : isFolder
      ? `Adds a folder inside this ${word}; type its name, then press Enter.`
      : otherVault
        ? "Adds a top-level folder to this vault; type its name, then press Enter."
        : vaults
          ? `Adds a top-level section to ${vaultLabel ?? "your notes folder"}; type its name, then press Enter.`
          : "Adds a top-level folder to your notes folder; type its name, then press Enter.";

  const folderLabel = isFolder
    ? word === "folder"
      ? "Folder"
      : "Section folder"
    : otherVault
      ? "Vault folder"
      : "Notes folder";
  const folderTip = isFolder
    ? `Copies this ${word}'s full folder path, so you can open it in File Explorer or Obsidian.`
    : otherVault
      ? "Copies this vault's folder path, so you can open it in File Explorer or Obsidian."
      : "Copies the notes folder path, so you can open it in File Explorer or Obsidian.";

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onContextMenu={(e) => {
        const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-section]") : null;
        menuRow.current = row ? (row.dataset.section ?? null) : null;
        menu.onContextMenu(e);
      }}
    >
      <span id={labelId} className="sr-only">
        {vaults ? "Vaults and folders" : "Sections"}
      </span>
      <ul role="tree" aria-labelledby={labelId} className={styles.tree} onKeyDown={onKeyDown}>
        {items}
      </ul>

      <div className={styles.toolbar} role="group" aria-label={vaults ? "Folder actions" : "Section actions"}>
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon />}
          onClick={() => startCreate(folder)}
          aria-disabled={childBlocked ? true : undefined}
          aria-describedby={childBlocked ? reasonId : undefined}
          className={childBlocked ? styles.inactive : undefined}
          tip={newTip}
        >
          {newLabel}
        </Button>
        {isFolder && current ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={<PencilIcon />}
              onClick={() => startRename(folder)}
              aria-disabled={current.renameBlocked ? true : undefined}
              aria-describedby={current.renameBlocked ? reasonId : undefined}
              className={current.renameBlocked ? styles.inactive : undefined}
              tip={
                current.renameBlocked
                  ? "Does nothing here because the vault's rules keep this folder's name."
                  : `Renames this ${word}'s folder on disk, and its notes move with it; F2 does the same.`
              }
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<TrashIcon />}
              onClick={() => void remove(current)}
              loading={deleting === folder}
              loadingLabel="Deleting"
              aria-disabled={current.deleteBlocked ? true : undefined}
              aria-describedby={current.deleteBlocked ? reasonId : undefined}
              className={current.deleteBlocked ? styles.inactive : styles.danger}
              tip={
                current.readOnly || current.renameBlocked
                  ? "Does nothing here because the vault's rules keep this folder in place."
                  : current.deleteBlocked
                    ? `Does nothing because only empty ${word}s can be deleted; empty this one first.`
                    : `Removes this empty ${word}'s folder right away; no notes are affected.`
              }
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
      {reason ? (
        <p id={reasonId} className={styles.reason}>
          {current?.readOnly ? (
            <span className={styles.reasonLock} aria-hidden="true">
              <LockIcon size={12} />
            </span>
          ) : null}
          {reason}
        </p>
      ) : null}
      {deleteError ? (
        <p className={styles.error} role="alert">
          {deleteError}
        </p>
      ) : null}
      <p className="sr-only" role="status">
        {status ?? ""}
      </p>

      <div className={styles.folder}>
        <p className={styles.folderLabel}>{folderLabel}</p>
        <p className={styles.folderPath} dir="ltr">
          {placePath(folder, vaults, notesDir)}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={copied === folder ? <CheckIcon /> : <CopyIcon />}
          onClick={() => copyFolder(folder)}
          tip={folderTip}
        >
          {copied === folder ? "Copied" : "Copy path"}
        </Button>
      </div>
    </div>
  );
});
