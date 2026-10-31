import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Note, NoteMeta, NotesIndex } from "../../../shared/types";
import { errorMessage } from "../api";
import { notesApi } from "../api/notes";
import { useSnapshot } from "../hooks/useSnapshot";
import { formatNumber } from "../lib/format";
import {
  ALL_NOTES,
  ancestorsOf,
  defaultNewNoteSection,
  findSection,
  isWithin,
  joinPath,
  noteSection,
  notesIn,
  parentPath,
  remapPath,
  sectionCounts,
  sectionLabel,
} from "../lib/notes";
import { noteHash, parseHash } from "../lib/route";
import { ConfirmDialog } from "../notes/ConfirmDialog";
import { BackIcon, PlusIcon } from "../notes/icons";
import { NewNoteDialog } from "../notes/NewNoteDialog";
import { NoteEditor, type EditorHandle } from "../notes/NoteEditor";
import { NoteList } from "../notes/NoteList";
import { SectionTree, type SectionTreeHandle } from "../notes/SectionTree";
import { useMediaQuery } from "../notes/useMediaQuery";
import { useNotesIndex } from "../notes/useNotesIndex";
import { useProjectOptions } from "../notes/useProjectOptions";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import styles from "./Notes.module.css";

export interface NotesProps {
  /** Note path (relative to NOTES_DIR) from #/notes/<path>, or null for the list (#/notes). */
  path: string | null;
}

// The #/notes view: sections tree, notes list and editor side by side on a desktop; on a phone one
// pane at a time (sections, then notes, then the note) with a back control on each. The note in the
// editor comes from the hash (#/notes/<path>), so links, Back and deep links all work.
//
// Never losing text: the editor saves as you type (see notes/useNoteDocument.ts). Leaving a note by
// any in-app link first saves what is pending; if that fails, a dialog asks before leaving. Closing
// the tab with unsaved text asks the browser to warn. After every write the shared snapshot is
// re-read so Needs you and project note counts catch up.

const PHONE_QUERY = "(max-width: 719px)";
const VIEW_KEY = "life-dashboard:notes-view";
const SNAPSHOT_DEBOUNCE_MS = 4_000;
const LEAVE_FLUSH_TIMEOUT_MS = 5_000;

interface ViewMemory {
  selected: string;
  expanded: string[];
}

function readViewMemory(): ViewMemory {
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const { selected, expanded } = parsed as Partial<ViewMemory>;
      return {
        selected: typeof selected === "string" ? selected : ALL_NOTES,
        expanded: Array.isArray(expanded) ? expanded.filter((x): x is string => typeof x === "string") : [],
      };
    }
  } catch {
    // No storage: start from All notes.
  }
  return { selected: ALL_NOTES, expanded: [] };
}

function writeViewMemory(memory: ViewMemory): void {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify(memory));
  } catch {
    // Only a convenience.
  }
}

function withTimeout(promise: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      (ok) => {
        clearTimeout(timer);
        resolve(ok);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function focusNoteLink(root: HTMLElement | null, path: string): boolean {
  const link = root?.querySelector<HTMLAnchorElement>(`a[data-path="${CSS.escape(path)}"]`);
  if (!link) return false;
  link.focus();
  return true;
}

export function Notes({ path }: NotesProps) {
  const index = useNotesIndex();
  const projects = useProjectOptions();
  const { refresh: refreshSnapshot } = useSnapshot();
  const isPhone = useMediaQuery(PHONE_QUERY);

  const [memory] = useState(readViewMemory);
  const [selected, setSelected] = useState(memory.selected);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(memory.expanded));
  const [phonePane, setPhonePane] = useState<"sections" | "notes">("notes");
  const [newOpen, setNewOpen] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [leave, setLeave] = useState<{ href: string; reason: string | null; title: string } | null>(null);
  const [top, setTop] = useState<number | null>(null);
  /** Bumped to reopen the same path from scratch (a note re-created under its old file name). */
  const [editorEpoch, setEditorEpoch] = useState(0);

  const editorRef = useRef<EditorHandle>(null);
  const treeRef = useRef<SectionTreeHandle>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const sectionsBackRef = useRef<HTMLButtonElement>(null);
  const notesBackRef = useRef<HTMLAnchorElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<string | null>(null);
  const prevPath = useRef<string | null>(path);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Focus to move once the next render is on screen (a pane that was hidden is shown by then). */
  const pendingFocus = useRef<(() => void) | null>(null);

  const data = index.data;
  const sections = useMemo(() => data?.sections ?? [], [data]);
  const notes = useMemo(() => data?.notes ?? [], [data]);
  const counts = useMemo(() => sectionCounts(sections, notes), [sections, notes]);

  // A section deleted or renamed in Obsidian falls back to All notes.
  const current = selected !== ALL_NOTES && data && !findSection(sections, selected) ? ALL_NOTES : selected;
  const listNotes = useMemo(() => notesIn(notes, current), [notes, current]);

  useEffect(() => writeViewMemory({ selected: current, expanded: [...expanded] }), [current, expanded]);

  /* Snapshot: re-read after writes so Needs you and project stats catch up. Saves are frequent, so
     those wait until typing has paused for a few seconds. */
  const refreshSnapshotSoon = useCallback(() => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => {
      snapTimer.current = null;
      void refreshSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }, [refreshSnapshot]);

  const refreshSnapshotNow = useCallback(() => {
    if (snapTimer.current) clearTimeout(snapTimer.current);
    snapTimer.current = null;
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(
    () => () => {
      // Leaving the view with a refresh still waiting: run it now.
      if (!snapTimer.current) return;
      clearTimeout(snapTimer.current);
      snapTimer.current = null;
      void refreshSnapshot();
    },
    [refreshSnapshot],
  );

  // The open note's section becomes the open section (deep links, links from Home), and its
  // ancestors open in the tree.
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!path || !data || syncedFor.current === path) return;
    syncedFor.current = path;
    const section = noteSection({ path });
    if (!findSection(sections, section)) return;
    if (!isWithin(section, current)) setSelected(section);
    const open = ancestorsOf(section);
    if (open.some((p) => !expanded.has(p))) setExpanded((prev) => new Set([...prev, ...open]));
  }, [path, data, sections, current, expanded]);

  // Desktop: the three panes fill the window under the header and scroll inside.
  useLayoutEffect(() => {
    const measure = () => {
      const el = layoutRef.current;
      if (!el) return;
      const next = Math.round(el.getBoundingClientRect().top + window.scrollY);
      setTop((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [data === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus after a pane change: a phone hides the pane that had focus, and a delete removes the row.
  useEffect(() => {
    const before = prevPath.current;
    prevPath.current = path;
    if (focusAfter.current) {
      const target = focusAfter.current;
      focusAfter.current = null;
      if (focusNoteLink(listPaneRef.current, target)) return;
    }
    if (!isPhone || before === path) return;
    if (path) notesBackRef.current?.focus();
    else if (!before || !focusNoteLink(listPaneRef.current, before)) sectionsBackRef.current?.focus();
  }, [path, isPhone]);

  useEffect(() => {
    const run = pendingFocus.current;
    if (!run) return;
    pendingFocus.current = null;
    run();
  });

  // Ctrl+S anywhere in the view saves the open note instead of opening the browser's save dialog.
  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void editorRef.current?.flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);

  // Leaving the open note by any in-app link (list, header, Needs you): save first; if that fails, ask.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useEffect(() => {
    if (!path) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      const href = link?.getAttribute("href");
      if (!link || !href || !href.startsWith("#/") || link.getAttribute("target") === "_blank") return;
      const route = parseHash(href);
      if (route.view === "notes" && route.path === path) return;
      const editor = editorRef.current;
      if (!editor || !editor.hasUnsaved()) return;
      e.preventDefault();
      void withTimeout(editor.flush(), LEAVE_FLUSH_TIMEOUT_MS).then((ok) => {
        if (ok) {
          window.location.hash = href;
          return;
        }
        const title = notesRef.current.find((n) => n.path === path)?.title;
        setLeave({ href, reason: editor.failure(), title: title || "this note" });
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [path]);

  /* Section actions ------------------------------------------------------------------------------ */

  const toggle = useCallback((p: string, open: boolean) => {
    setExpanded((prev) => {
      if (prev.has(p) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(p);
      else next.delete(p);
      return next;
    });
  }, []);

  const selectSection = useCallback(
    (p: string) => {
      setSelected(p);
      if (isPhone) {
        setPhonePane("notes");
        pendingFocus.current = () => sectionsBackRef.current?.focus();
      }
    },
    [isPhone],
  );

  const afterSectionWrite = (next: NotesIndex) => {
    index.adopt(next);
    refreshSnapshotNow();
  };

  const createSection = async (parent: string, name: string): Promise<string | null> => {
    try {
      afterSectionWrite(await notesApi.createSection(parent, name));
    } catch (err) {
      return errorMessage(err);
    }
    if (parent) toggle(parent, true);
    setSelected(joinPath(parent, name));
    return null;
  };

  const renameSection = async (from: string, name: string): Promise<string | null> => {
    const openInside = path !== null && isWithin(noteSection({ path }), from);
    if (openInside && editorRef.current?.hasUnsaved()) {
      const ok = await withTimeout(editorRef.current.flush(), LEAVE_FLUSH_TIMEOUT_MS);
      if (!ok) return "The open note in this section isn't saved yet. Fix that first, then rename.";
    }
    try {
      afterSectionWrite(await notesApi.renameSection(from, name));
    } catch (err) {
      return errorMessage(err);
    }
    const to = joinPath(parentPath(from), name);
    setSelected((s) => remapPath(s, from, to));
    setExpanded((prev) => new Set([...prev].map((p) => remapPath(p, from, to))));
    if (openInside && path) window.location.replace(noteHash(remapPath(path, from, to)));
    return null;
  };

  const deleteSection = async (p: string): Promise<string | null> => {
    try {
      afterSectionWrite(await notesApi.removeSection(p));
    } catch (err) {
      return errorMessage(err);
    }
    setSelected(parentPath(p));
    return null;
  };

  /* Note events ---------------------------------------------------------------------------------- */

  const { upsert, adopt, reload } = index;

  const onSaved = useCallback(
    (note: Note) => {
      upsert(note);
      refreshSnapshotSoon();
    },
    [upsert, refreshSnapshotSoon],
  );

  const onCreated = (note: Note) => {
    upsert(note);
    setNewOpen(false);
    setJustCreated(note.path);
    const section = noteSection(note);
    if (!isWithin(section, current)) setSelected(section);
    refreshSnapshotNow();
    window.location.hash = noteHash(note.path);
  };

  const onDeleted = (next: NotesIndex) => {
    const at = listNotes.findIndex((n) => n.path === path);
    const neighbour: NoteMeta | undefined = at === -1 ? undefined : (listNotes[at + 1] ?? listNotes[at - 1]);
    focusAfter.current = neighbour?.path ?? null;
    adopt(next);
    refreshSnapshotNow();
    window.location.hash = noteHash(null);
    if (!neighbour) pendingFocus.current = () => newButtonRef.current?.focus();
  };

  const onRecreated = (note: Note) => {
    upsert(note);
    void reload();
    refreshSnapshotNow();
    if (note.path === path) setEditorEpoch((n) => n + 1);
    else window.location.replace(noteHash(note.path));
  };

  /* Render --------------------------------------------------------------------------------------- */

  if (!data) {
    if (index.error && !index.loading) {
      return (
        <Panel
          title="Notes"
          state="error"
          message={index.offline ? "Can't reach the dashboard server." : "Couldn't load your notes."}
          hint={index.offline ? "Check that npm run dev is still running, then retry." : index.error}
          onRetry={() => void reload()}
          retrying={index.reading}
        />
      );
    }
    return (
      <div className={styles.layout} ref={layoutRef} data-pane={path ? "editor" : "notes"}>
        <div className={styles.treePane}>
          <Panel title="Sections" state="loading" className={styles.fill} />
        </div>
        <div className={styles.listPane}>
          <Panel title="Notes" state="loading" className={styles.fill} />
        </div>
        <div className={styles.editorPane}>
          <Panel title="Note" state="loading" skeleton="chart" className={styles.fill} />
        </div>
      </div>
    );
  }

  if (data.status === "not_connected") {
    return (
      <Panel
        title="Notes"
        state="not_connected"
        message={data.message ?? `The notes folder ${data.dir} isn't on this PC.`}
        hint="Create the folder, or set NOTES_DIR in .env to your vault's notes folder, then reload this page."
      />
    );
  }
  if (data.status === "error") {
    return (
      <Panel
        title="Notes"
        state="error"
        message="Couldn't read the notes folder."
        hint={data.message ? `${data.message} (${data.dir})` : data.dir}
        onRetry={() => void reload()}
        retrying={index.reading}
      />
    );
  }

  const pane = path ? "editor" : phonePane;
  const newSection = defaultNewNoteSection(sections, current);
  const total = counts.get(current)?.total ?? listNotes.length;
  const refreshNotice = index.error
    ? `Couldn't refresh the notes list${index.offline ? " because the server isn't reachable" : ""}. Showing what loaded earlier.`
    : undefined;

  const newNoteButton = (
    <Button
      ref={newButtonRef}
      variant="primary"
      size="sm"
      icon={<PlusIcon />}
      onClick={() => {
        if (!newSection) return;
        void editorRef.current?.flush();
        setNewOpen(true);
      }}
      aria-disabled={newSection ? undefined : true}
      aria-describedby={newSection ? undefined : "notes-new-reason"}
      className={newSection ? undefined : styles.inactive}
    >
      New note
    </Button>
  );

  let listBody;
  if (sections.length === 0 && notes.length === 0) {
    listBody = (
      <EmptyState
        title="No sections yet."
        body={
          <span id="notes-new-reason">
            Notes live in sections, which are folders in your notes folder. Add one with New section under the tree,
            then write your first note in it.
          </span>
        }
      />
    );
  } else if (listNotes.length === 0) {
    listBody = (
      <EmptyState
        title={current === ALL_NOTES ? "No notes yet." : `No notes in ${findSection(sections, current)?.name ?? "this section"} yet.`}
        body={
          current === ALL_NOTES
            ? "Start one with New note. Each note is saved as a markdown file in your notes folder, so Obsidian sees it too."
            : "Start one with New note. Each note is saved as a markdown file in this section's folder, so Obsidian sees it too."
        }
      />
    );
  } else {
    listBody = <NoteList notes={listNotes} section={current} openPath={path} projects={projects.projects} />;
  }

  return (
    <>
      <div
        className={styles.layout}
        ref={layoutRef}
        data-pane={pane}
        style={top !== null ? ({ "--notes-top": `${top}px` } as CSSProperties) : undefined}
      >
        <div className={styles.treePane}>
          <Panel title="Sections" state="ok" className={styles.fill} bodyClassName={styles.fillBody}>
            <SectionTree
              ref={treeRef}
              sections={sections}
              counts={counts}
              selected={current}
              expanded={expanded}
              notesDir={data.dir}
              onToggle={toggle}
              onSelect={selectSection}
              onCreate={createSection}
              onRename={renameSection}
              onDelete={deleteSection}
            />
          </Panel>
        </div>

        <div className={styles.listPane} ref={listPaneRef}>
          {isPhone ? (
            <div className={styles.phoneBar}>
              <button
                ref={sectionsBackRef}
                type="button"
                className={styles.back}
                onClick={() => {
                  setPhonePane("sections");
                  pendingFocus.current = () => treeRef.current?.focusSelected();
                }}
              >
                <BackIcon />
                Sections
              </button>
            </div>
          ) : null}
          <Panel
            title={sectionLabel(current)}
            state="ok"
            meta={formatNumber(total)}
            action={newNoteButton}
            notice={refreshNotice}
            className={styles.fill}
            bodyClassName={styles.scrollBody}
          >
            {listBody}
          </Panel>
        </div>

        <div className={styles.editorPane}>
          {isPhone && path ? (
            <div className={styles.phoneBar}>
              <a ref={notesBackRef} href={noteHash(null)} className={styles.back}>
                <BackIcon />
                <span dir="auto">{sectionLabel(current)}</span>
              </a>
            </div>
          ) : null}
          {path ? (
            <NoteEditor
              key={`${editorEpoch}:${path}`}
              path={path}
              projects={projects}
              notesDir={data.dir}
              autoFocusBody={justCreated === path}
              onSaved={onSaved}
              onDeleted={onDeleted}
              onRecreated={onRecreated}
              handleRef={editorRef}
            />
          ) : (
            <Panel title="Note" state="ok" className={styles.fill}>
              <EmptyState
                title={notes.length ? "No note open." : "Your notes open here."}
                body={
                  notes.length
                    ? "Pick one from the list, or start a new note. Notes save as you type, as markdown files Obsidian can open."
                    : "Start a new note with New note. It saves as you type, as a markdown file Obsidian can open."
                }
              />
            </Panel>
          )}
        </div>
      </div>

      <NewNoteDialog
        open={newOpen}
        sections={sections}
        initialSection={newSection ?? ""}
        onCancel={() => setNewOpen(false)}
        onCreated={onCreated}
      />

      <ConfirmDialog
        open={leave !== null}
        tone="danger"
        title="Leave without saving?"
        confirmLabel="Leave anyway"
        cancelLabel="Stay on note"
        onCancel={() => setLeave(null)}
        onConfirm={() => {
          const href = leave?.href;
          setLeave(null);
          if (href) window.location.hash = href;
        }}
      >
        <p dir="auto">
          Your latest changes to "{leave?.title}" haven't reached the file.{leave?.reason ? ` ${leave.reason}` : ""}
        </p>
        <p>A copy stays in this browser, and the note offers it back when you open it again.</p>
      </ConfirmDialog>
    </>
  );
}
