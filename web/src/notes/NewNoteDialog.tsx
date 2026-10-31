import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Note, NoteSection, NoteTemplate, NoteVault } from "../../../shared/types";
import { errorMessage } from "../api";
import { notesApi } from "../api/notes";
import {
  defaultDestination,
  defaultTemplate,
  filterFolderOptions,
  findSection,
  folderDepth,
  folderOptions,
  isVaultRoot,
  joinPath,
  MAX_SECTION_DEPTH,
  placeLabel,
  splitVaultPath,
  TEMPLATES,
  validateSectionName,
  validateTitle,
  vaultGroups,
  vaultRoot,
  type Destination,
  type FolderOption,
} from "../lib/notes";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { CloseIcon, PlusIcon, SearchIcon } from "./icons";
import styles from "./NewNoteDialog.module.css";

// New note: title (focused on open), where it goes, and template. Where it goes (v1.4): a Vault
// picker (when there is more than one vault) and a searchable Folder list of that vault's folders,
// protected folders left out, each with its full path; "New folder..." names a subfolder of the
// picked folder, created together with the note. The template follows the folder (Meeting inside
// Meeting notes, Personal inside Personal notes, else Blank) until you pick one yourself.
//
// Keys: Enter in the title creates. In the folder search, arrows pick a folder, Enter keeps the
// highlighted match and clears the search (Enter again creates), Esc clears the search first and
// closes the form after. The server writes the file with the template's headings and the editor
// opens with the caret under the first heading.

/** Hover help for each template: what the new file starts with. */
const TEMPLATE_TIPS: Record<NoteTemplate, string> = {
  meeting: "Starts with five meeting headings and an empty task under Action items.",
  personal: "Starts with a single Notes heading, with the caret under it.",
  blank: "Starts with an empty page and no headings.",
};

export interface NewNoteDialogProps {
  open: boolean;
  sections: NoteSection[];
  /** v1.4 vaults, default first; null for an older server (one notes folder). */
  vaults: NoteVault[] | null;
  /** Where the form points when it opens. Null: nowhere yet (the first vault, no folder). */
  initial: Destination | null;
  /**
   * Template picked when the dialog opens ("New meeting note here" in the right-click menu). It then
   * stays when the folder changes, as if picked by hand. Null or absent: the template follows the folder.
   */
  initialTemplate?: NoteTemplate | null;
  /** Creates the folder for "New folder..."; resolves an error message, or null when it worked. */
  onCreateFolder: (parent: string, name: string) => Promise<string | null>;
  onCancel: () => void;
  onCreated: (note: Note) => void;
}

/** The template a folder suggests, read inside its vault ("@learning/Meeting notes" counts too). */
function templateFor(folder: string, vaults: NoteVault[] | null): NoteTemplate {
  return defaultTemplate(splitVaultPath(folder, vaults).inner);
}

function OptionLabel({ option, vaultLabel }: { option: FolderOption; vaultLabel: string }) {
  if (option.root) {
    return (
      <>
        <span className={styles.optionName}>Top level</span>
        <span className={styles.optionPath} dir="auto">
          {" "}
          of {vaultLabel}
        </span>
      </>
    );
  }
  const parents = option.parts.slice(0, -1);
  return (
    <>
      {parents.length ? (
        <span className={styles.optionPath} dir="auto">
          {parents.join(" / ")} /{" "}
        </span>
      ) : null}
      <span className={styles.optionName} dir="auto">
        {option.parts[option.parts.length - 1]}
      </span>
    </>
  );
}

export function NewNoteDialog({
  open,
  sections,
  vaults,
  initial,
  initialTemplate,
  onCreateFolder,
  onCancel,
  onCreated,
}: NewNoteDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [title, setTitle] = useState("");
  const [vaultId, setVaultId] = useState<string | null>(initial?.vault ?? vaults?.[0]?.id ?? null);
  const [folder, setFolder] = useState(initial?.folder ?? "");
  const [query, setQuery] = useState("");
  /** The name typed for "New folder...", or null when not adding one. */
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [template, setTemplate] = useState<NoteTemplate>(templateFor(initial?.folder ?? "", vaults));
  const [templateTouched, setTemplateTouched] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = useId().replace(/:/g, "");
  const ids = {
    heading: `new-note-${uid}`,
    title: `new-note-title-${uid}`,
    titleError: `new-note-title-error-${uid}`,
    vault: `new-note-vault-${uid}`,
    search: `new-note-folder-${uid}`,
    list: `new-note-folders-${uid}`,
    dest: `new-note-dest-${uid}`,
    newFolder: `new-note-new-folder-${uid}`,
    folderError: `new-note-folder-error-${uid}`,
    template: `new-note-template-${uid}`,
  };

  const vault = vaults?.find((v) => v.id === vaultId) ?? null;
  const vaultLabel = vault?.label ?? "your notes folder";
  const options = useMemo(() => folderOptions(sections, vaults, vaultId), [sections, vaults, vaultId]);
  const filtered = useMemo(() => filterFolderOptions(options, query), [options, query]);
  const optionId = (o: FolderOption) => `${ids.list}-${options.indexOf(o)}`;
  const picked = filtered.find((o) => o.path === folder) ?? null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const start = initial?.folder ?? "";
      setTitle("");
      setVaultId(initial?.vault ?? vaults?.[0]?.id ?? null);
      setFolder(start);
      setQuery("");
      setNewFolder(null);
      setTemplate(initialTemplate ?? templateFor(start, vaults));
      setTemplateTouched(!!initialTemplate);
      setTitleError(null);
      setFolderError(null);
      setFailure(null);
      setBusy(false);
      dialog.showModal();
      titleRef.current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
    // Only the open flag reopens the form; where it points and the template are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the picked folder in view in the list (on open, after arrow keys, after a vault change).
  useEffect(() => {
    if (!open || !picked) return;
    document.getElementById(optionId(picked))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, picked]);

  useEffect(() => {
    if (newFolder !== null && document.activeElement !== newFolderRef.current) newFolderRef.current?.focus();
    // Only when the field appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFolder !== null]);

  const pickFolder = (path: string) => {
    setFolder(path);
    setFailure(null);
    setFolderError(null);
    if (!templateTouched) setTemplate(templateFor(path, vaults));
  };

  const pickVault = (id: string) => {
    setVaultId(id);
    setQuery("");
    setNewFolder(null);
    const target = vaults?.find((v) => v.id === id);
    const dest = target ? defaultDestination(sections, vaults, vaultRoot(target)) : null;
    pickFolder(dest && dest.vault === id ? dest.folder : "");
  };

  /** The folders directly inside `parent`, for the new folder's duplicate check. */
  const childNames = (parent: string): string[] => {
    if (vaults && isVaultRoot(parent, vaults)) {
      return (vaultGroups(sections, vaults).find((g) => g.root === parent)?.children ?? []).map((s) => s.name);
    }
    if (!parent) return sections.map((s) => s.name);
    return (findSection(sections, parent)?.children ?? []).map((s) => s.name);
  };

  const word = vault && vaultRoot(vault) ? "folder" : "section";
  const tooDeep = folderDepth(folder, vaults) >= MAX_SECTION_DEPTH;
  const newFolderBlocked = tooDeep ? `Folders nest ${MAX_SECTION_DEPTH} levels deep at most; pick a folder higher up first.` : null;

  const destination =
    newFolder !== null
      ? `${folder ? placeLabel(folder, vaults, true) : vaultLabel} / ${newFolder.trim() || "new folder"}`
      : folder
        ? `${placeLabel(folder, vaults, true)}${isVaultRoot(folder, vaults) ? " (top level)" : ""}`
        : null;

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!filtered.length) return;
      const at = picked ? filtered.indexOf(picked) : -1;
      const next = e.key === "ArrowDown" ? Math.min(filtered.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
      pickFolder(filtered[next].path);
      return;
    }
    if (e.key === "Enter" && query.trim()) {
      // Keep the highlighted match (or the first one) and show the whole list again.
      e.preventDefault();
      const target = picked ?? filtered[0];
      if (target) pickFolder(target.path);
      setQuery("");
      return;
    }
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = validateTitle(title);
    setTitleError(problem);
    const name = newFolder?.trim() ?? "";
    const nameProblem = newFolder === null ? null : (newFolderBlocked ?? validateSectionName(name, childNames(folder)));
    setFolderError(nameProblem);
    if (problem) {
      titleRef.current?.focus();
      return;
    }
    if (nameProblem) {
      newFolderRef.current?.focus();
      return;
    }
    if (!folder && newFolder === null) {
      setFailure(`Pick a ${word} for the note, or add one with New folder.`);
      searchRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    let target = folder;
    if (newFolder !== null) {
      const failed = await onCreateFolder(folder, name);
      if (failed) {
        setFailure(`Couldn't create the folder ${name}. ${failed}`);
        setBusy(false);
        return;
      }
      target = joinPath(folder, name);
      setFolder(target);
      setNewFolder(null);
    }
    try {
      const note = await notesApi.create({ section: target, title: title.trim(), template });
      onCreated(note);
    } catch (err) {
      setFailure(`Couldn't create the note. ${errorMessage(err)}`);
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={ids.heading}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
        <div className={styles.head}>
          <h2 id={ids.heading} className={styles.heading}>
            New note
          </h2>
          <Button
            variant="ghost"
            size="sm"
            icon={<CloseIcon />}
            aria-label="Close"
            onClick={onCancel}
            disabled={busy}
            className={styles.close}
            tip="Closes the form without creating a note; Esc does the same."
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.title} className={styles.label}>
            Title
          </label>
          <input
            ref={titleRef}
            id={ids.title}
            className={styles.input}
            value={title}
            dir="auto"
            autoComplete="off"
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? ids.titleError : undefined}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError(validateTitle(e.target.value));
            }}
          />
          {titleError ? (
            <p id={ids.titleError} className={styles.error}>
              {titleError}
            </p>
          ) : null}
        </div>

        {vaults && vaults.length > 1 ? (
          <div className={styles.field}>
            <label htmlFor={ids.vault} className={styles.label}>
              Vault
            </label>
            <select
              id={ids.vault}
              className={styles.input}
              value={vaultId ?? ""}
              data-tip="Picks the vault the note goes in; the folder list below shows that vault's folders."
              onChange={(e) => pickVault(e.target.value)}
            >
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className={styles.field}>
          <label htmlFor={ids.search} className={styles.label}>
            {vaults ? "Folder" : "Section"}
          </label>
          <div className={styles.picker}>
            <div className={styles.search}>
              <SearchIcon />
              <input
                ref={searchRef}
                id={ids.search}
                className={styles.searchInput}
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls={ids.list}
                aria-autocomplete="list"
                aria-activedescendant={picked && newFolder === null ? optionId(picked) : undefined}
                aria-describedby={ids.dest}
                value={query}
                dir="auto"
                autoComplete="off"
                spellCheck={false}
                placeholder={`Search ${options.length > 1 ? `${options.length} ` : ""}${word}s`}
                data-tip="Narrows the list as you type; arrow keys pick a folder and Enter keeps it."
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
              />
            </div>
            <ul
              id={ids.list}
              role="listbox"
              aria-label={`Folders in ${vaultLabel}`}
              className={styles.folders}
              data-tip="Lists the folders that take new notes; folders protected by the vault's rules are left out."
            >
              {filtered.map((o) => (
                <li
                  key={o.path}
                  id={optionId(o)}
                  role="option"
                  aria-selected={o.path === folder && newFolder === null}
                  data-parent={newFolder !== null && o.path === folder ? "" : undefined}
                  className={styles.option}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    pickFolder(o.path);
                    searchRef.current?.focus();
                  }}
                >
                  <OptionLabel option={o} vaultLabel={vaultLabel} />
                </li>
              ))}
              {!filtered.length ? (
                <li role="presentation" className={styles.noMatch}>
                  {options.length
                    ? `No ${word}s match "${query.trim()}". Clear the search to see them all.`
                    : `${vaultLabel} has no ${word}s that take notes yet. Add one with New folder.`}
                </li>
              ) : null}
            </ul>
          </div>

          {newFolder === null ? (
            <button
              type="button"
              className={styles.newFolder}
              aria-disabled={newFolderBlocked ? true : undefined}
              data-inactive={newFolderBlocked ? "" : undefined}
              onClick={() => {
                if (newFolderBlocked) return;
                setNewFolder("");
                setFolderError(null);
              }}
              data-tip={
                newFolderBlocked ??
                "Adds a folder inside the picked one; it is created with the note when you press Create note."
              }
            >
              <PlusIcon />
              New folder...
            </button>
          ) : (
            <div className={styles.newFolderRow}>
              <label htmlFor={ids.newFolder} className={styles.newFolderLabel} dir="auto">
                New folder in {folder ? placeLabel(folder, vaults, true) : vaultLabel}
              </label>
              <div className={styles.newFolderInputs}>
                <input
                  ref={newFolderRef}
                  id={ids.newFolder}
                  className={styles.input}
                  value={newFolder}
                  dir="auto"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={folderError ? true : undefined}
                  aria-describedby={folderError ? ids.folderError : undefined}
                  data-tip="Names the new folder; it is created when you press Create note."
                  onChange={(e) => {
                    setNewFolder(e.target.value);
                    if (folderError) setFolderError(validateSectionName(e.target.value, childNames(folder)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setNewFolder(null);
                      setFolderError(null);
                      searchRef.current?.focus();
                    }
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<CloseIcon />}
                  aria-label="Cancel new folder"
                  onClick={() => {
                    setNewFolder(null);
                    setFolderError(null);
                    searchRef.current?.focus();
                  }}
                  disabled={busy}
                  tip="Drops the new folder; the note goes in the picked folder instead."
                />
              </div>
              {folderError ? (
                <p id={ids.folderError} className={styles.error}>
                  {folderError}
                </p>
              ) : null}
            </div>
          )}

          <p id={ids.dest} className={styles.dest} dir="auto">
            {destination ? (
              <>
                Saves in <span className={styles.destPath}>{destination}</span>
                {newFolder !== null ? " (new folder)" : null}
              </>
            ) : (
              `No ${word} picked yet.`
            )}
          </p>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Template</legend>
          <div className={styles.templates}>
            {TEMPLATES.map((t) => (
              <label key={t.id} className={styles.template} data-tip={TEMPLATE_TIPS[t.id]}>
                <input
                  type="radio"
                  name={ids.template}
                  value={t.id}
                  checked={template === t.id}
                  onChange={() => {
                    setTemplate(t.id);
                    setTemplateTouched(true);
                  }}
                />
                <span className={styles.templateName}>{t.label}</span>
                <span className={styles.templateHint}>{t.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {failure ? (
          <p className={styles.failure} role="alert">
            <StatusDot tone="danger" size={9} glow={false} />
            <span>{failure}</span>
          </p>
        ) : null}

        <div className={styles.actions}>
          <Button variant="ghost" onClick={onCancel} disabled={busy} tip="Closes the form; no note is created.">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel="Creating"
            tip={
              newFolder !== null
                ? "Creates the new folder, writes the note in it as markdown and opens it."
                : "Writes the markdown file in the chosen folder and opens it, ready to type."
            }
          >
            Create note
          </Button>
        </div>
      </form>
    </dialog>
  );
}
