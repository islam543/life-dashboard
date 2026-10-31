import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import type { Note, NotesIndex, Project, ProjectStatus } from "../../../shared/types";
import { notesApi } from "../api/notes";
import type { MenuSection } from "../lib/contextMenu";
import {
  byteLength,
  formatNoteDate,
  initialCaret,
  MAX_BODY_BYTES,
  noteSection,
  sectionLabel,
  toggleTaskLine,
  validateTitle,
} from "../lib/notes";
import { Button, Spinner } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot } from "../ui/StatusDot";
import { ActionsSection, useNoteJira } from "./ActionsSection";
import { ConfirmDialog } from "./ConfirmDialog";
import { copyText, fullPath } from "./filePaths";
import { CheckIcon, CopyIcon, TrashIcon, WarnIcon } from "./icons";
import { JiraReviewDialog } from "./JiraReviewDialog";
import { MarkdownPreview } from "./MarkdownPreview";
import { TagInput } from "./TagInput";
import { isTaskPath, TaskBar, taskOf } from "./TaskBar";
import { ULTRAWIDE_QUERY, useMediaQuery } from "./useMediaQuery";
import { useNoteDocument, type NoteDocumentApi, type SaveState } from "./useNoteDocument";
import type { ProjectOptions } from "./useProjectOptions";
import styles from "./NoteEditor.module.css";

// The note editor: title, project, tags, and the markdown body with Write and Preview tabs.
// Saving is automatic (see useNoteDocument): 800 ms after typing stops, on blur and on Ctrl+S.
// The status in the header always says where the text is: Saving, Saved 14:05, or Not saved and why.
// Ultrawide screens (1920px and up) drop the tabs: the editor and a live Preview panel sit side by side
// (two panels, so the Notes view shows four panes), each text column kept to 75 characters or less.
// Right-click outside the text fields offers Show preview or Edit (when there are tabs), Copy path and
// Delete note; the text fields keep the browser's own menu for spelling and paste.
// A note in the Tasks section gets a task bar under its title (day, start, length, Done). Under the
// preview (the Preview tab, or the live Preview panel on ultrawide) every note lists its detected
// actions, with "Draft Jira tasks with AI" and the review dialog (ActionsSection, JiraReviewDialog).

/** Something the Notes view asks the editor to do once the note has loaded (from the notes list menu). */
export type EditorAsk = "project" | "delete";

/** What the Notes view needs from the open editor (leave guard, section rename). */
export interface EditorHandle {
  flush: () => Promise<boolean>;
  hasUnsaved: () => boolean;
  /** Why the last save failed, for the leave warning. Null when nothing failed. */
  failure: () => string | null;
}

export interface NoteEditorProps {
  path: string;
  projects: ProjectOptions;
  /** Absolute notes folder, for the delete message. */
  notesDir: string;
  /** Put the caret in the body once loaded (a note just created). */
  autoFocusBody: boolean;
  onSaved: (note: Note) => void;
  onDeleted: (index: NotesIndex) => void;
  /** The text was saved as a new note (the old file was gone). */
  onRecreated: (note: Note) => void;
  handleRef: Ref<EditorHandle>;
  /** Move to the Project field, or ask to delete, once loaded. Done (or dropped) calls onAskDone. */
  ask?: EditorAsk | null;
  onAskDone?: () => void;
}

const STATUS_ORDER: readonly ProjectStatus[] = ["active", "paused", "idea", "done"];
const STATUS_GROUP: Record<ProjectStatus, string> = { active: "Active", paused: "Paused", idea: "Ideas", done: "Done" };
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const SIZE_WARN_BYTES = 150 * 1024;
const COPIED_MS = 2000;

function SaveStatus({ save }: { save: SaveState }) {
  switch (save.kind) {
    case "saving":
      return (
        <span className={styles.status} data-kind="saving">
          <Spinner size={12} />
          Saving
        </span>
      );
    case "invalid":
    case "failed":
      return (
        <span className={styles.status} data-kind="failed">
          <StatusDot tone="danger" size={9} glow={false} />
          Not saved
        </span>
      );
    case "paused":
      return (
        <span className={styles.status} data-kind="paused">
          <StatusDot tone="warn" size={9} glow={false} />
          Autosave paused
        </span>
      );
    default:
      return (
        <span className={styles.status} data-kind="saved">
          <span className={styles.statusIcon}>
            <CheckIcon />
          </span>
          {save.at ? `Saved ${clock.format(save.at)}` : "Saved"}
        </span>
      );
  }
}

function EditorSkeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      <Skeleton width="62%" height={28} radius={6} />
      <div className={styles.skeletonRow}>
        <Skeleton width={180} height={32} radius={6} />
        <Skeleton width={220} height={32} radius={6} />
      </div>
      <Skeleton width={160} height={30} radius={6} />
      <Skeleton width="100%" height={220} radius={8} />
    </div>
  );
}

function ProjectSelect({
  value,
  options,
  onChange,
  selectRef,
}: {
  value: string | null;
  options: ProjectOptions;
  onChange: (id: string | null) => void;
  selectRef: RefObject<HTMLSelectElement>;
}) {
  const id = `project-${useId().replace(/:/g, "")}`;
  const list: readonly Project[] = options.projects ?? [];
  const known = value === null || list.some((p) => p.id === value);
  const groups = STATUS_ORDER.map((status) => ({
    status,
    projects: list.filter((p) => p.status === status).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.projects.length > 0);

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        Project
      </label>
      <select
        ref={selectRef}
        id={id}
        className={styles.select}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-describedby={options.error ? `${id}-error` : undefined}
        data-tip="Links the note to a project, so it is listed on that project's page; saves at once."
      >
        <option value="">No project</option>
        {!known && value ? (
          <option value={value}>{options.projects ? `${value} (no longer a project)` : value}</option>
        ) : null}
        {groups.map((g) => (
          <optgroup key={g.status} label={STATUS_GROUP[g.status]}>
            {g.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {options.error ? (
        <p id={`${id}-error`} className={styles.fieldHint}>
          Couldn't load projects, so only the current link is listed.{" "}
          <button
            type="button"
            className={styles.inlineButton}
            onClick={options.reload}
            data-tip="Asks the dashboard server for the project list again."
          >
            Try again
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The note title: a one-row textarea that grows with the text, so a long title wraps instead of
 * scrolling out of sight. Enter moves to the body; pasted line breaks become spaces.
 */
function TitleField({
  id,
  value,
  onChange,
  onEnter,
  onBlur,
  readOnly,
  ...aria
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onBlur: () => void;
  readOnly: boolean;
  placeholder: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      className={styles.title}
      value={value}
      dir="auto"
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      {...aria}
    />
  );
}

function FailureBanner({
  doc,
  onRecreated,
  focusBody,
}: {
  doc: NoteDocumentApi;
  onRecreated: (note: Note) => void;
  focusBody: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { save } = doc;
  // A missing title is shown under the title field. A body over the size limit and every failed
  // save show here, and the banner stays while a retry runs so its buttons don't move under the pointer.
  const tooLarge = save.kind === "invalid" && validateTitle(doc.fields.title) === null ? save.message : null;
  const problem = doc.failure ?? (tooLarge ? { kind: "too_large" as const, message: tooLarge } : null);
  if (!problem) return null;

  const retryable = problem.kind === "offline" || problem.kind === "server";
  const retrying = save.kind === "saving";

  const saveAsNew = async () => {
    setBusy(true);
    setError(null);
    try {
      onRecreated(await doc.saveAsNew());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the new note.");
      setBusy(false);
    }
  };

  return (
    <div className={styles.banner} data-tone="danger" role="alert">
      <p className={styles.bannerText}>
        <span>
          <strong>Not saved.</strong> {problem.message}{" "}
          {retryable ? "Your text is kept in this browser and saving retries by itself." : null}
          {problem.kind === "gone" ? "Your text is still here and kept in this browser." : null}
        </span>
      </p>
      {error ? <p className={styles.bannerText}>Couldn't create the new note. {error}</p> : null}
      <div className={styles.bannerActions}>
        {problem.kind === "gone" ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void saveAsNew()}
            loading={busy}
            loadingLabel="Saving"
            tip="Writes your text to a new note file in this section, since the old file is gone."
          >
            Save as a new note
          </Button>
        ) : problem.kind !== "too_large" ? (
          <Button
            size="sm"
            loading={retrying}
            loadingLabel="Saving"
            onClick={() => void doc.flush().then((ok) => ok && focusBody())}
            tip={
              retryable
                ? "Saves now instead of waiting for the next automatic retry."
                : "Sends your current text to the file again."
            }
          >
            {retryable ? "Retry now" : "Try again"}
          </Button>
        ) : null}
        {problem.kind === "gone" || problem.kind === "too_large" ? (
          <Button
            size="sm"
            variant="ghost"
            icon={copied ? <CheckIcon /> : <CopyIcon />}
            onClick={() => void copyText(doc.fields.body).then(setCopied)}
            tip="Copies the whole note text to the clipboard, so you can keep it somewhere safe."
          >
            {copied ? "Copied" : "Copy text"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function NoteEditor({
  path,
  projects,
  notesDir,
  autoFocusBody,
  onSaved,
  onDeleted,
  onRecreated,
  handleRef,
  ask = null,
  onAskDone,
}: NoteEditorProps) {
  const doc = useNoteDocument(path, onSaved);
  /** Ultrawide: editor and live preview side by side instead of tabs. */
  const split = useMediaQuery(ULTRAWIDE_QUERY);
  /** The live preview re-renders behind the typing, so a long note never slows the keyboard down. */
  const previewBody = useDeferredValue(doc.fields.body);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const projectRef = useRef<HTMLSelectElement>(null);
  const writeTabRef = useRef<HTMLButtonElement>(null);
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const uid = useId().replace(/:/g, "");
  const ids = {
    title: `note-title-${uid}`,
    titleError: `note-title-error-${uid}`,
    write: `note-write-${uid}`,
    preview: `note-preview-${uid}`,
    writeTab: `note-write-tab-${uid}`,
    previewTab: `note-preview-tab-${uid}`,
  };

  const { flush, hasUnsaved, problem, save } = doc;
  useImperativeHandle(handleRef, () => ({ flush, hasUnsaved, failure: problem }), [flush, hasUnsaved, problem]);

  const jira = useNoteJira({
    path,
    ready: doc.load === "ready",
    version: doc.note?.updated ?? null,
    editorBlocked: doc.conflict ? "Settle the outside change first: Keep mine or Load theirs." : null,
    flush,
    refresh: doc.refresh,
  });

  // A note just created: put the caret under its first heading so typing starts right away.
  useEffect(() => {
    if (!autoFocusBody || focused.current || doc.load !== "ready") return;
    focused.current = true;
    const el = bodyRef.current;
    if (!el) return;
    const at = initialCaret(el.value);
    el.focus();
    el.setSelectionRange(at, at);
  }, [autoFocusBody, doc.load]);

  // A request from the notes list menu: run it once the note is on screen. A note that failed to
  // load drops it, so it never fires later by surprise.
  useEffect(() => {
    if (!ask || doc.load === "loading") return;
    onAskDone?.();
    if (doc.load !== "ready") return;
    if (ask === "delete") {
      setConfirmDelete(true);
      return;
    }
    const select = projectRef.current;
    if (!select) return;
    select.focus();
    select.scrollIntoView({ block: "nearest" });
    try {
      // Opens the project list right away where the browser allows it; focus alone is enough otherwise.
      (select as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      // Not allowed without a recent click: the field has focus, and Alt+Down opens it.
    }
  }, [ask, doc.load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  /** Copies the note's full file path (footer button and right-click menu). */
  const copyPath = () => {
    void copyText(fullPath(notesDir, path)).then((ok) => {
      if (!ok) return;
      setPathCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setPathCopied(false), COPIED_MS);
    });
  };

  const showPreview = () => {
    void doc.flush();
    setMode("preview");
  };

  const showWrite = () => {
    setMode("write");
    setTimeout(() => bodyRef.current?.focus(), 0);
  };

  const menu = useMenuRegion((): MenuSection | null => {
    if (doc.load !== "ready") return null;
    return {
      title: doc.fields.title.trim() || "Untitled note",
      items: [
        !split && mode === "write"
          ? {
              label: "Show preview",
              onSelect: showPreview,
              tip: "Saves, then shows the note formatted; tick task boxes there to update the file.",
            }
          : null,
        !split && mode === "preview"
          ? { label: "Edit", onSelect: showWrite, tip: "Shows the markdown text again and puts the caret in it." }
          : null,
        {
          label: "Copy path",
          icon: <CopyIcon />,
          onSelect: copyPath,
          tip: "Copies the note's full file path, so you can find it in File Explorer or Obsidian.",
        },
        {
          label: "Delete note",
          icon: <TrashIcon />,
          danger: true,
          onSelect: () => setConfirmDelete(true),
          tip: "Asks first, then moves the file to .trash in your notes folder; nothing is erased.",
        },
      ],
    };
  });

  const toggleTask = useCallback(
    (line: number) => {
      const next = toggleTaskLine(doc.fields.body, line);
      if (next !== null) doc.edit({ body: next }, true);
    },
    [doc.fields.body, doc.edit],
  );

  /** A banner's buttons vanish once used: keep focus in the writing area instead of losing it. */
  const thenFocusBody = (action: () => void) => () => {
    action();
    setTimeout(() => bodyRef.current?.focus(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doc.flush();
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = mode === "write" ? "preview" : "write";
    const target = e.key === "Home" ? "write" : e.key === "End" ? "preview" : next;
    setMode(target);
    (target === "write" ? writeTabRef : previewTabRef).current?.focus();
  };

  const sectionTitle = doc.note ? sectionLabel(noteSection(doc.note)) : "Note";

  if (doc.load === "loading") {
    return <Panel title="Note" state="loading" skeleton={<EditorSkeleton />} className={styles.panel} />;
  }
  if (doc.load === "error") {
    return (
      <Panel
        title="Note"
        state="error"
        message="Couldn't open this note."
        hint={doc.loadError ?? undefined}
        onRetry={doc.reload}
        className={styles.panel}
      />
    );
  }
  if (doc.load === "missing") {
    const draft = doc.draft;
    return (
      <Panel title="Note" state="ok" className={styles.panel}>
        <EmptyState
          title="This note isn't in the notes folder any more."
          body={
            draft
              ? `It may have been renamed, moved or deleted in Obsidian. Text you wrote here at ${clock.format(draft.at)} never reached the file and is still in this browser.`
              : "It may have been renamed, moved or deleted in Obsidian. Pick another note from the list."
          }
          action={
            draft ? <RecoverDraft onSave={() => doc.saveAsNew(draft.fields)} onRecreated={onRecreated} /> : undefined
          }
        />
      </Panel>
    );
  }

  const { fields, note } = doc;
  const titleError = save.kind === "invalid" ? validateTitle(fields.title) : null;
  const bytes = fields.body.length * 3 > SIZE_WARN_BYTES ? byteLength(fields.body) : 0;
  const disabled = doc.conflict !== null;

  const textarea = (
    <textarea
      ref={bodyRef}
      className={styles.body}
      value={fields.body}
      dir="auto"
      aria-label="Note text, markdown"
      spellCheck
      readOnly={disabled}
      onChange={(e) => doc.edit({ body: e.target.value })}
      onBlur={() => void doc.flush()}
    />
  );

  const hint = (
    <span className={styles.tabsHint}>
      {bytes > 0 ? (
        <span className="num" data-warn={bytes > MAX_BODY_BYTES ? "" : undefined}>
          {Math.ceil(bytes / 1024)} KB of 200 KB
        </span>
      ) : (
        <>
          Markdown <span aria-hidden="true">·</span> <kbd>Ctrl</kbd>+<kbd>S</kbd> saves now
        </>
      )}
    </span>
  );

  const editorPanel = (
    <Panel
      title={sectionTitle}
      state="ok"
      className={styles.panel}
      bodyClassName={styles.panelBody}
      action={<SaveStatus save={save} />}
    >
      <div className={styles.editor} data-split={split || undefined} onKeyDown={onKeyDown} {...menu}>
        {doc.draft ? (
          <div className={styles.banner} data-tone="warn" role="status">
            <p className={styles.bannerText}>
              <span>
                <strong>Unsaved text found.</strong> You wrote text here at {clock.format(doc.draft.at)} that never
                reached the file. Restoring it replaces what is shown now.
              </span>
            </p>
            <div className={styles.bannerActions}>
              <Button
                size="sm"
                variant="primary"
                onClick={thenFocusBody(doc.restoreDraft)}
                tip="Replaces the shown text with the copy kept in this browser and saves it to the file."
              >
                Restore my text
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={thenFocusBody(doc.discardDraft)}
                tip="Deletes the copy kept in this browser; the note stays as the file has it."
              >
                Discard it
              </Button>
            </div>
          </div>
        ) : null}

        {doc.conflict ? (
          <div className={styles.banner} data-tone="warn" role="alert">
            <p className={styles.bannerText}>
              <span className={styles.bannerIcon}>
                <WarnIcon />
              </span>
              <span>
                <strong>This note changed outside the dashboard</strong> (in Obsidian or another tab) while you were
                editing, so autosave is paused. Keep mine writes your version over the file. Load theirs shows the
                file's version and drops your unsaved changes.
              </span>
            </p>
            <div className={styles.bannerActions}>
              <Button
                size="sm"
                variant="primary"
                onClick={thenFocusBody(doc.keepMine)}
                tip="Saves your version over the file, replacing the change made outside the dashboard."
              >
                Keep mine
              </Button>
              <Button
                size="sm"
                onClick={thenFocusBody(doc.loadTheirs)}
                tip="Shows the file's newer version here and drops your unsaved changes."
              >
                Load theirs
              </Button>
            </div>
          </div>
        ) : null}

        <FailureBanner doc={doc} onRecreated={onRecreated} focusBody={() => bodyRef.current?.focus()} />

        {doc.notice ? (
          <p className={styles.notice} role="status">
            <span>{doc.notice}</span>
            <button
              type="button"
              className={styles.inlineButton}
              onClick={thenFocusBody(doc.dismissNotice)}
              data-tip="Hides this message; the note itself does not change."
            >
              Dismiss
            </button>
          </p>
        ) : null}

        <div className={styles.titleRow}>
          <label htmlFor={ids.title} className="sr-only">
            Title
          </label>
          <TitleField
            id={ids.title}
            value={fields.title}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? ids.titleError : undefined}
            placeholder="Untitled note"
            readOnly={disabled}
            onChange={(title) => doc.edit({ title })}
            onBlur={() => void doc.flush()}
            onEnter={() => {
              setMode("write");
              setTimeout(() => bodyRef.current?.focus(), 0);
            }}
          />
          {titleError ? (
            <p id={ids.titleError} className={styles.fieldError}>
              {titleError}
            </p>
          ) : null}
        </div>

        {isTaskPath(path) ? (
          <TaskBar path={path} task={taskOf(note)} disabled={disabled} onChanged={() => void doc.refresh(null)} />
        ) : null}

        <div className={styles.metaRow}>
          <ProjectSelect
            value={fields.projectId}
            options={projects}
            onChange={(id) => doc.edit({ projectId: id }, true)}
            selectRef={projectRef}
          />
          <TagInput tags={fields.tags} onChange={(tags) => doc.edit({ tags }, true)} onBlur={() => void doc.flush()} />
        </div>

        {split ? (
          <>
            <div className={styles.tabsRow} data-split="">
              {hint}
            </div>
            <div className={styles.writePanel}>{textarea}</div>
          </>
        ) : (
          <>
            <div className={styles.tabsRow}>
              <div role="tablist" aria-label="Note body" className={styles.tabs}>
                <button
                  ref={writeTabRef}
                  id={ids.writeTab}
                  type="button"
                  role="tab"
                  className={styles.tab}
                  aria-selected={mode === "write"}
                  aria-controls={ids.write}
                  tabIndex={mode === "write" ? 0 : -1}
                  onClick={() => setMode("write")}
                  onKeyDown={onTabKey}
                  data-tip="Shows the markdown text so you can edit it."
                >
                  Write
                </button>
                <button
                  ref={previewTabRef}
                  id={ids.previewTab}
                  type="button"
                  role="tab"
                  className={styles.tab}
                  aria-selected={mode === "preview"}
                  aria-controls={ids.preview}
                  tabIndex={mode === "preview" ? 0 : -1}
                  onClick={() => {
                    void doc.flush();
                    setMode("preview");
                  }}
                  onKeyDown={onTabKey}
                  data-tip="Saves, then shows the note formatted; tick task boxes there to update the file."
                >
                  Preview
                </button>
              </div>
              {hint}
            </div>

            <div
              id={ids.write}
              role="tabpanel"
              aria-labelledby={ids.writeTab}
              className={styles.writePanel}
              hidden={mode !== "write"}
            >
              {textarea}
            </div>
            <div
              id={ids.preview}
              role="tabpanel"
              aria-labelledby={ids.previewTab}
              className={styles.previewPanel}
              hidden={mode !== "preview"}
              tabIndex={0}
            >
              {mode === "preview" ? (
                <>
                  <MarkdownPreview markdown={fields.body} onToggleTask={toggleTask} />
                  <ActionsSection jira={jira} layout="tab" />
                </>
              ) : null}
            </div>
          </>
        )}

        <footer className={styles.foot}>
          <p className={styles.fileInfo}>
            <span className={styles.fileLabel}>File</span>{" "}
            <span className={styles.filePath} dir="ltr">
              {path}
            </span>
            {note?.created ? (
              <>
                {" "}
                <span aria-hidden="true">·</span> Created {formatNoteDate(note.created)}
              </>
            ) : null}
          </p>
          <Button
            size="sm"
            variant="ghost"
            icon={pathCopied ? <CheckIcon /> : <CopyIcon />}
            onClick={copyPath}
            tip="Copies the note's full file path, so you can find it in File Explorer or Obsidian."
          >
            {pathCopied ? "Copied" : "Copy path"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={styles.deleteButton}
            icon={<TrashIcon />}
            onClick={() => setConfirmDelete(true)}
            tip="Asks first, then moves the file to .trash in your notes folder; nothing is erased."
          >
            Delete note
          </Button>
        </footer>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title={`Delete "${fields.title.trim() || "Untitled note"}"?`}
        confirmLabel="Move to trash"
        confirmingLabel="Moving to trash"
        cancelLabel="Keep note"
        confirmTip="Moves the file to .trash in your notes folder; restore it from there in Obsidian."
        cancelTip="Closes this question and leaves the note where it is."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await doc.settle();
          const index = await notesApi.remove(path);
          doc.stop();
          setConfirmDelete(false);
          onDeleted(index);
        }}
      >
        <p>
          The file moves to the <code>.trash</code> folder inside your notes folder, so you can still restore it from
          Obsidian or File Explorer.
        </p>
        <p className={styles.dialogPath} dir="auto">
          {notesDir}
        </p>
      </ConfirmDialog>

      <JiraReviewDialog jira={jira} noteTitle={fields.title.trim() || "Untitled note"} />
    </Panel>
  );

  if (!split) return editorPanel;

  return (
    <>
      {editorPanel}
      <Panel title="Preview" state="ok" className={styles.panel} bodyClassName={styles.livePreviewBody}>
        {/* Focusable so the keyboard can scroll a long note. */}
        <div className={styles.livePreview} role="region" aria-label="Formatted note" tabIndex={0} {...menu}>
          <MarkdownPreview
            markdown={previewBody}
            onToggleTask={toggleTask}
            empty="Nothing to preview yet. What you write in the note shows here, formatted, as you type."
          />
        </div>
        <ActionsSection jira={jira} layout="panel" />
      </Panel>
    </>
  );
}

function RecoverDraft({ onSave, onRecreated }: { onSave: () => Promise<Note>; onRecreated: (note: Note) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="primary"
        loading={busy}
        loadingLabel="Saving"
        tip="Creates a new note in the same section from the text kept in this browser."
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onRecreated(await onSave());
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't create the new note.");
            setBusy(false);
          }
        }}
      >
        Save it as a new note
      </Button>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
