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
import type { NoteSection } from "../../../shared/types";
import { formatNumber } from "../lib/format";
import {
  ALL_NOTES,
  baseName,
  deleteBlockedReason,
  findSection,
  MAX_SECTION_DEPTH,
  parentPath,
  sectionDepth,
  treeKeyAction,
  typeAhead,
  validateSectionName,
  visibleRows,
  type SectionCount,
  type TreeKey,
  type TreeRow,
} from "../lib/notes";
import { Button } from "../ui/Button";
import { CheckIcon, ChevronIcon, CopyIcon, PencilIcon, PlusIcon, StackIcon, TrashIcon } from "./icons";
import styles from "./SectionTree.module.css";

// Sections (folders) as a WAI-ARIA tree: one tab stop, arrows move, Right and Left open and close,
// Home and End jump, Enter or Space opens a section in the list, F2 renames it, typing a letter jumps
// to the next section starting with it. "All notes" sits on top and lists everything. Below the tree:
// New subsection, Rename and Delete for the open section (Delete only when it is empty, with the
// reason shown otherwise), then the notes folder path so the files can be found in Obsidian.

export interface SectionTreeHandle {
  /** Move focus to the open section's row (after coming back to this pane on a phone). */
  focusSelected: () => void;
}

export interface SectionTreeProps {
  sections: NoteSection[];
  counts: Map<string, SectionCount>;
  selected: string;
  expanded: ReadonlySet<string>;
  /** Absolute notes folder, shown as plain text. */
  notesDir: string;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
  /** Resolve with an error message, or null on success. */
  onCreate: (parent: string, name: string) => Promise<string | null>;
  onRename: (path: string, name: string) => Promise<string | null>;
  onDelete: (path: string) => Promise<string | null>;
}

type Editing = { kind: "create"; parent: string } | { kind: "rename"; path: string } | null;

const TREE_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

function siblingNames(sections: NoteSection[], parent: string, except?: string): string[] {
  const list = parent === ALL_NOTES ? sections : (findSection(sections, parent)?.children ?? []);
  return list.filter((s) => s.path !== except).map((s) => s.name);
}

function NameForm({
  label,
  initial,
  level,
  siblings,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  level: number;
  siblings: string[];
  submitLabel: string;
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
        <button type="submit" className={styles.formSubmit} disabled={busy} aria-label={submitLabel}>
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
  { sections, counts, selected, expanded, notesDir, onToggle, onSelect, onCreate, onRename, onDelete },
  ref,
) {
  const rows = useMemo(() => visibleRows(sections, expanded), [sections, expanded]);
  const [focusPath, setFocusPath] = useState(selected);
  const [editing, setEditing] = useState<Editing>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const wantFocus = useRef<string | null>(null);
  const uid = useId().replace(/:/g, "");
  const reasonId = `section-reason-${uid}`;
  const labelId = `sections-label-${uid}`;

  // Keep the roving tab stop on a row that exists (after a delete, a rename or a collapse).
  const tabStop = rows.some((r) => r.path === focusPath) ? focusPath : rows.some((r) => r.path === selected) ? selected : ALL_NOTES;

  useEffect(() => {
    const target = wantFocus.current;
    if (target === null) return;
    const el = itemRefs.current.get(target);
    if (el) {
      wantFocus.current = null;
      el.focus();
    }
  });

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

  const selectedSection = selected === ALL_NOTES ? null : findSection(sections, selected);
  const depth = sectionDepth(selected);
  const tooDeep = depth >= MAX_SECTION_DEPTH;
  const blocked = selectedSection ? deleteBlockedReason(selectedSection, counts.get(selected)) : null;
  const newLabel = selected === ALL_NOTES ? "New section" : "New subsection";
  const reason =
    [tooDeep ? `Sections nest ${MAX_SECTION_DEPTH} levels deep at most, so this one can't hold subsections.` : null, blocked]
      .filter(Boolean)
      .join(" ") || null;

  const startCreate = () => {
    if (tooDeep) return;
    setDeleteError(null);
    if (selected !== ALL_NOTES && !expanded.has(selected)) onToggle(selected, true);
    setEditing({ kind: "create", parent: selected });
  };

  const startRename = (path: string) => {
    if (path === ALL_NOTES) return;
    setDeleteError(null);
    setEditing({ kind: "rename", path });
  };

  const stopEditing = (focusTo: string) => {
    setEditing(null);
    focusRow(focusTo);
  };

  const remove = async () => {
    if (!selectedSection || blocked) return;
    setDeleting(true);
    setDeleteError(null);
    const name = selectedSection.name;
    const failed = await onDelete(selectedSection.path);
    setDeleting(false);
    if (failed) setDeleteError(failed);
    else {
      setStatus(`Deleted section ${name}.`);
      focusRow(parentPath(selectedSection.path));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!(e.target instanceof HTMLLIElement) || e.target.getAttribute("role") !== "treeitem") return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const current = tabStop;
    if (TREE_KEYS.has(e.key)) {
      e.preventDefault();
      const move = treeKeyAction(rows, current, e.key as TreeKey);
      if (move.kind === "focus") focusRow(move.path);
      else if (move.kind === "expand") onToggle(move.path, true);
      else if (move.kind === "collapse") onToggle(move.path, false);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(current);
      return;
    }
    if (e.key === "F2") {
      e.preventDefault();
      startRename(current);
      return;
    }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const next = typeAhead(rows, current, e.key);
      if (next !== null) {
        e.preventDefault();
        focusRow(next);
      }
    }
  };

  // Where the inline "new subsection" field goes: after the parent's last visible descendant.
  let createAfter = -1;
  if (editing?.kind === "create") {
    if (editing.parent === ALL_NOTES) createAfter = rows.length - 1;
    else {
      const start = rows.findIndex((r) => r.path === editing.parent);
      createAfter = start;
      for (let i = start + 1; i < rows.length && rows[i].path.startsWith(`${editing.parent}/`); i++) createAfter = i;
    }
  }

  const renderRow = (row: TreeRow) => {
    if (editing?.kind === "rename" && editing.path === row.path) {
      return (
        <NameForm
          key={`rename-${row.path}`}
          label={`New name for ${row.name}`}
          initial={row.name}
          level={row.level}
          siblings={siblingNames(sections, parentPath(row.path), row.path)}
          submitLabel="Save name"
          onCancel={() => stopEditing(row.path)}
          onSubmit={async (name) => {
            const failed = await onRename(row.path, name);
            if (!failed) {
              const next = parentPath(row.path) ? `${parentPath(row.path)}/${name}` : name;
              setStatus(`Renamed to ${name}.`);
              stopEditing(next);
            }
            return failed;
          }}
        />
      );
    }
    const count = counts.get(row.path)?.total ?? 0;
    const isAll = row.path === ALL_NOTES;
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
        data-all={isAll ? "" : undefined}
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
          onClick={(e) => {
            if (!row.hasChildren) return;
            e.stopPropagation();
            onToggle(row.path, !row.expanded);
          }}
        >
          {row.hasChildren ? <ChevronIcon /> : isAll ? <StackIcon /> : null}
        </span>
        <span className={styles.name} dir="auto">
          {row.name}
        </span>
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
      items.push(
        <NameForm
          key="create"
          label={parent === ALL_NOTES ? "Name of the new section" : `Name of the new subsection in ${baseName(parent)}`}
          initial=""
          level={sectionDepth(parent) + 1}
          siblings={siblingNames(sections, parent)}
          submitLabel="Create section"
          onCancel={() => stopEditing(parent)}
          onSubmit={async (name) => {
            const failed = await onCreate(parent, name);
            if (!failed) {
              setStatus(`Created section ${name}.`);
              stopEditing(parent ? `${parent}/${name}` : name);
            }
            return failed;
          }}
        />,
      );
    }
  });

  return (
    <div className={styles.wrap}>
      <span id={labelId} className="sr-only">
        Sections
      </span>
      <ul role="tree" aria-labelledby={labelId} className={styles.tree} onKeyDown={onKeyDown}>
        {items}
      </ul>

      <div className={styles.toolbar} role="group" aria-label="Section actions">
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon />}
          onClick={startCreate}
          aria-disabled={tooDeep || undefined}
          aria-describedby={tooDeep ? reasonId : undefined}
          className={tooDeep ? styles.inactive : undefined}
        >
          {newLabel}
        </Button>
        {selectedSection ? (
          <>
            <Button size="sm" variant="ghost" icon={<PencilIcon />} onClick={() => startRename(selected)}>
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<TrashIcon />}
              onClick={() => void remove()}
              loading={deleting}
              loadingLabel="Deleting"
              aria-disabled={blocked ? true : undefined}
              aria-describedby={blocked ? reasonId : undefined}
              className={blocked ? styles.inactive : styles.danger}
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
      {reason ? (
        <p id={reasonId} className={styles.reason}>
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
        <p className={styles.folderLabel}>Notes folder</p>
        <p className={styles.folderPath} dir="ltr">
          {notesDir}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? <CheckIcon /> : <CopyIcon />}
          onClick={() => {
            if (!navigator.clipboard) return;
            void navigator.clipboard.writeText(notesDir).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              },
              () => undefined,
            );
          }}
        >
          {copied ? "Copied" : "Copy path"}
        </Button>
      </div>
    </div>
  );
});
