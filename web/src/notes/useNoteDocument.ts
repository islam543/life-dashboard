import { useCallback, useEffect, useRef, useState } from "react";
import type { Note } from "../../../shared/types";
import { ApiRequestError, errorMessage, isOffline } from "../api";
import { notesApi } from "../api/notes";
import {
  AUTOSAVE_DELAY_MS,
  classifySaveError,
  fieldsOf,
  isDirty,
  isRetryable,
  notePatch,
  noteSection,
  retryDelayMs,
  sameContent,
  validateFields,
  type NoteFields,
  type SaveFailure,
} from "../lib/notes";
import { readDraft, removeDraft, writeDraft, type Draft } from "./drafts";

// Load and save one note. The editor is keyed by path, so one hook instance = one note.
//
// Saving: every edit updates the fields at once and schedules a save AUTOSAVE_DELAY_MS after the
// last keystroke (discrete edits like the project select or a preview checkbox save right away).
// flush() saves now (Ctrl+S, blur, before leaving). One PUT at a time; edits made while it is in
// flight go in the next one. Only changed fields are sent.
//
// Never losing text: while there are unsaved changes a copy sits in localStorage (drafts.ts). A
// failed save keeps the text on screen, says why, and retries by itself when the cause can clear
// (server down). A copy left over from an earlier visit is offered back when the note opens.
//
// Outside changes: when the window gets focus back the file is re-read. If it changed (Obsidian,
// another tab) and nothing is pending here, the new version is shown with a notice. If both sides
// changed, autosave pauses and the editor offers Keep mine or Load theirs.

export type SaveState =
  | { kind: "saved"; at: number | null }
  | { kind: "saving" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; failure: SaveFailure; message: string; retryAt: number | null }
  | { kind: "paused" };

export type LoadState = "loading" | "ready" | "missing" | "error";

export interface NoteDocument {
  load: LoadState;
  loadError: string | null;
  /** The server's last copy (path, section, dates, openActions). */
  note: Note | null;
  fields: NoteFields;
  save: SaveState;
  /** The newer server copy when the file changed outside while there were edits here. */
  conflict: Note | null;
  /** Unsaved text from an earlier visit, offered back. */
  draft: Draft | null;
  /** One-line notice, e.g. the note was reloaded with outside changes. */
  notice: string | null;
  /** The last failed save, kept while a retry runs so its banner and buttons stay put. Null once saved. */
  failure: { kind: SaveFailure; message: string } | null;
}

export interface NoteDocumentApi extends NoteDocument {
  /** Replace some fields. `immediate` saves without waiting for typing to stop. */
  edit: (patch: Partial<NoteFields>, immediate?: boolean) => void;
  /** Save now. Resolves true when everything on screen is on disk. */
  flush: () => Promise<boolean>;
  /** True when something on screen has not reached the file. */
  hasUnsaved: () => boolean;
  /** Why the text is not on disk right now (failed, invalid or paused), read at call time. */
  problem: () => string | null;
  /** Cancel scheduled saves and wait for one in flight (before a delete). */
  settle: () => Promise<void>;
  /** Stop saving (after a delete), so no write follows the file into the trash. */
  stop: () => void;
  keepMine: () => void;
  loadTheirs: () => void;
  restoreDraft: () => void;
  discardDraft: () => void;
  dismissNotice: () => void;
  reload: () => void;
  /**
   * Re-read the file now, after the server changed it (task fields, Jira keys written back), without
   * the loading state. Same rules as the focus check; `notice` is shown when the text changed. Resolves
   * the server's copy, or null when it could not be read.
   */
  refresh: (notice?: string | null) => Promise<Note | null>;
  /** Write the text (or `from`, e.g. a leftover draft) as a new note in the same section. */
  saveAsNew: (from?: NoteFields) => Promise<Note>;
}

const EMPTY_FIELDS: NoteFields = { title: "", body: "", projectId: null, tags: [] };
const DRAFT_DELAY_MS = 300;
const FOCUS_CHECK_THROTTLE_MS = 2_000;
const OUTSIDE_NOTICE = "This note changed outside the dashboard, so it now shows the file's latest version.";

/** Same file metadata the editor shows: dates and, for a task note, its task fields (sent at runtime by the server). */
function sameMeta(a: Note, b: Note): boolean {
  const task = (n: Note) => JSON.stringify((n as Note & { task?: unknown }).task ?? null);
  return a.updated === b.updated && a.openActions === b.openActions && task(a) === task(b);
}

function failureMessage(failure: SaveFailure, err: unknown): string {
  switch (failure) {
    case "offline":
      return "The dashboard server isn't reachable.";
    case "gone":
      return "The file isn't in the notes folder any more. It may have been moved, renamed or deleted in Obsidian.";
    case "too_large":
      return "This note is over 200 KB, so it can't be saved. Move part of it into a new note.";
    case "forbidden":
      return `${errorMessage(err).replace(/\.?$/, ".")} The dashboard can't change this note.`;
    default:
      return errorMessage(err);
  }
}

export function useNoteDocument(path: string, onSaved: (note: Note) => void): NoteDocumentApi {
  const [load, setLoad] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [fields, setFieldsState] = useState<NoteFields>(EMPTY_FIELDS);
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: null });
  const [conflict, setConflict] = useState<Note | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ kind: SaveFailure; message: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const noteRef = useRef<Note | null>(null);
  noteRef.current = note;
  const fieldsRef = useRef<NoteFields>(EMPTY_FIELDS);
  /** What the server last accepted (or sent on load). Dirty = fields differ from this. */
  const savedRef = useRef<NoteFields | null>(null);
  /** The server's own copy after the last load or save, to spot changes made outside. */
  const serverRef = useRef<NoteFields | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  const failures = useRef(0);
  const lastFailure = useRef<SaveFailure | null>(null);
  const problemRef = useRef<string | null>(null);
  const paused = useRef(false);
  const stopped = useRef(false);
  const mounted = useRef(false);
  const saveSeq = useRef(0);
  const lastCheck = useRef(0);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const clearTimer = (ref: { current: ReturnType<typeof setTimeout> | null }) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = null;
  };

  const dirtyNow = () => savedRef.current !== null && isDirty(fieldsRef.current, savedRef.current);

  const hasUnsaved = useCallback(
    () => !stopped.current && (dirtyNow() || inflight.current !== null || paused.current),
    [],
  );

  const problem = useCallback(() => problemRef.current, []);

  /** One PUT with the current changes. Resolves true on success. */
  const send = useCallback(
    (sent: NoteFields): Promise<boolean> => {
      const saved = savedRef.current!;
      const patch = notePatch(sent, saved);
      saveSeq.current += 1;
      return notesApi.update(path, patch).then(
        (next) => {
          savedRef.current = sent;
          serverRef.current = fieldsOf(next);
          failures.current = 0;
          lastFailure.current = null;
          problemRef.current = null;
          clearTimer(retryTimer);
          onSavedRef.current(next);
          if (!isDirty(fieldsRef.current, sent)) removeDraft(path);
          if (mounted.current) {
            setFailure(null);
            setNote(next);
            if (!isDirty(fieldsRef.current, sent)) setSave({ kind: "saved", at: Date.now() });
          }
          return true;
        },
        (err: unknown) => {
          const status = err instanceof ApiRequestError ? err.status : 0;
          const failure = classifySaveError(status, isOffline(err));
          failures.current += 1;
          lastFailure.current = failure;
          writeDraft(path, fieldsRef.current);
          let retryAt: number | null = null;
          if (isRetryable(failure) && mounted.current && !stopped.current) {
            const wait = retryDelayMs(failures.current);
            retryAt = Date.now() + wait;
            clearTimer(retryTimer);
            retryTimer.current = setTimeout(() => void runSaveRef.current(), wait);
          }
          problemRef.current = failureMessage(failure, err);
          if (mounted.current) {
            setFailure({ kind: failure, message: problemRef.current });
            setSave({ kind: "failed", failure, message: problemRef.current, retryAt });
          }
          return false;
        },
      );
    },
    [path],
  );

  /** Save until nothing is pending, one request at a time. */
  const runSave = useCallback(async (): Promise<boolean> => {
    clearTimer(saveTimer);
    for (;;) {
      if (stopped.current) return true;
      if (inflight.current) {
        const ok = await inflight.current;
        if (!ok) return false;
        continue;
      }
      if (paused.current) return false;
      const saved = savedRef.current;
      if (!saved) return false;
      const current = fieldsRef.current;
      if (!isDirty(current, saved)) {
        removeDraft(path);
        problemRef.current = null;
        if (mounted.current) {
          setFailure(null);
          setSave((s) => (s.kind === "saved" ? s : { kind: "saved", at: Date.now() }));
        }
        return true;
      }
      const invalid = validateFields(current);
      if (invalid) {
        writeDraft(path, current);
        problemRef.current = invalid;
        if (mounted.current) setSave({ kind: "invalid", message: invalid });
        return false;
      }
      clearTimer(retryTimer);
      if (mounted.current) setSave({ kind: "saving" });
      const request = send(current);
      inflight.current = request;
      const ok = await request;
      if (inflight.current === request) inflight.current = null;
      if (!ok) return false;
    }
  }, [path, send]);

  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;

  const flush = useCallback(() => runSave(), [runSave]);

  const edit = useCallback(
    (patch: Partial<NoteFields>, immediate = false) => {
      if (stopped.current) return;
      const next = { ...fieldsRef.current, ...patch };
      fieldsRef.current = next;
      setFieldsState(next);
      setNotice(null);
      clearTimer(draftTimer);
      draftTimer.current = setTimeout(() => {
        if (dirtyNow()) writeDraft(path, fieldsRef.current);
      }, DRAFT_DELAY_MS);
      if (paused.current || !savedRef.current) return;
      // Server down: the retry timer is already running. File gone or protected (403): every save
      // would fail the same way. Either way, don't fire a request on every pause in typing; blur and
      // Ctrl+S still try.
      const failed = lastFailure.current;
      const waiting =
        failed !== null && (isRetryable(failed) ? retryTimer.current !== null : failed === "gone" || failed === "forbidden");
      if (waiting && !immediate) return;
      clearTimer(saveTimer);
      setSave((s) => (s.kind === "failed" && isRetryable(s.failure) ? s : { kind: "saving" }));
      saveTimer.current = setTimeout(() => void runSaveRef.current(), immediate ? 0 : AUTOSAVE_DELAY_MS);
    },
    [path],
  );

  const settle = useCallback(async () => {
    clearTimer(saveTimer);
    clearTimer(retryTimer);
    if (inflight.current) await inflight.current;
  }, []);

  const stop = useCallback(() => {
    stopped.current = true;
    clearTimer(saveTimer);
    clearTimer(retryTimer);
    clearTimer(draftTimer);
    removeDraft(path);
  }, [path]);

  const adoptServer = useCallback((next: Note) => {
    const f = fieldsOf(next);
    fieldsRef.current = f;
    savedRef.current = f;
    serverRef.current = f;
    setFieldsState(f);
    setNote(next);
    setFailure(null);
  }, []);

  // Load (and reload) the note.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoad("loading");
    setLoadError(null);
    notesApi.read(path, ctrl.signal).then(
      (next) => {
        adoptServer(next);
        paused.current = false;
        setConflict(null);
        setSave({ kind: "saved", at: null });
        const saved = readDraft(path);
        if (saved && sameContent(saved.fields, fieldsOf(next))) removeDraft(path);
        setDraft(saved && !sameContent(saved.fields, fieldsOf(next)) ? saved : null);
        setLoad("ready");
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setLoad("missing");
          setDraft(readDraft(path));
        } else {
          setLoad("error");
          setLoadError(errorMessage(err));
        }
      },
    );
    return () => ctrl.abort();
  }, [path, reloadKey, adoptServer]);

  // Unmount: save what is pending without waiting (the page is still alive, so the request lands).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer(saveTimer);
      clearTimer(retryTimer);
      clearTimer(draftTimer);
      if (stopped.current || paused.current || !savedRef.current) return;
      if (!dirtyNow() || validateFields(fieldsRef.current)) {
        if (dirtyNow()) writeDraft(path, fieldsRef.current);
        return;
      }
      writeDraft(path, fieldsRef.current);
      const run = async () => {
        if (inflight.current) await inflight.current;
        if (dirtyNow()) await send(fieldsRef.current);
      };
      void run();
    };
  }, [path, send]);

  /**
   * A copy of the file read outside a save (focus check, refresh). Same text: only the metadata may
   * differ (dates, task fields), so just that updates. Changed text with nothing pending here: show it.
   * Both sides changed: pause autosave and offer Keep mine or Load theirs.
   */
  const adoptOutside = useCallback(
    (theirs: Note, seq: number, notice: string | null) => {
      if (!mounted.current || stopped.current || seq !== saveSeq.current || inflight.current) return;
      const server = serverRef.current;
      if (server && sameContent(fieldsOf(theirs), server)) {
        if (noteRef.current && sameMeta(noteRef.current, theirs)) return;
        setNote(theirs);
        onSavedRef.current(theirs);
        return;
      }
      if (!dirtyNow()) {
        adoptServer(theirs);
        onSavedRef.current(theirs);
        setNotice(notice);
        return;
      }
      paused.current = true;
      clearTimer(saveTimer);
      clearTimer(retryTimer);
      writeDraft(path, fieldsRef.current);
      problemRef.current = "The file changed outside the dashboard, so autosave is paused.";
      setConflict(theirs);
      setSave({ kind: "paused" });
    },
    [path, adoptServer],
  );

  const markGone = useCallback(
    (err: unknown) => {
      if (!mounted.current || !(err instanceof ApiRequestError) || err.status !== 404) return;
      lastFailure.current = "gone";
      problemRef.current = failureMessage("gone", err);
      if (dirtyNow()) writeDraft(path, fieldsRef.current);
      setFailure({ kind: "gone", message: problemRef.current });
      setSave({ kind: "failed", failure: "gone", message: problemRef.current, retryAt: null });
    },
    [path],
  );

  const refresh = useCallback(
    async (notice: string | null = null): Promise<Note | null> => {
      if (stopped.current) return null;
      if (inflight.current) await inflight.current;
      const seq = saveSeq.current;
      try {
        const theirs = await notesApi.read(path);
        adoptOutside(theirs, seq, notice);
        return theirs;
      } catch (err) {
        markGone(err);
        return null;
      }
    },
    [path, adoptOutside, markGone],
  );

  // The file may have changed in Obsidian while the window was elsewhere: re-read it on focus.
  useEffect(() => {
    if (load !== "ready") return;
    const check = () => {
      if (document.visibilityState !== "visible" || stopped.current || paused.current) return;
      if (inflight.current || Date.now() - lastCheck.current < FOCUS_CHECK_THROTTLE_MS) return;
      lastCheck.current = Date.now();
      const seq = saveSeq.current;
      notesApi.read(path).then(
        (theirs) => adoptOutside(theirs, seq, OUTSIDE_NOTICE),
        markGone,
      );
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [load, path, adoptOutside, markGone]);

  // Warn before the tab closes or reloads with text that hasn't reached the file.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsaved()) return;
      writeDraft(path, fieldsRef.current);
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [path, hasUnsaved]);

  const keepMine = useCallback(() => {
    if (!conflict) return;
    const theirs = fieldsOf(conflict);
    savedRef.current = theirs;
    serverRef.current = theirs;
    paused.current = false;
    setNote(conflict);
    setConflict(null);
    void runSave();
  }, [conflict, runSave]);

  const loadTheirs = useCallback(() => {
    if (!conflict) return;
    paused.current = false;
    adoptServer(conflict);
    removeDraft(path);
    problemRef.current = null;
    setConflict(null);
    setSave({ kind: "saved", at: null });
  }, [conflict, path, adoptServer]);

  const restoreDraft = useCallback(() => {
    if (!draft) return;
    setDraft(null);
    edit(draft.fields, true);
  }, [draft, edit]);

  const discardDraft = useCallback(() => {
    removeDraft(path);
    setDraft(null);
  }, [path]);

  const saveAsNew = useCallback(async (from?: NoteFields): Promise<Note> => {
    const f = from ?? fieldsRef.current;
    const created = await notesApi.create({
      section: noteSection({ path }),
      title: f.title.trim() || "Recovered note",
      body: f.body,
      projectId: f.projectId,
      tags: f.tags,
    });
    stop();
    return created;
  }, [path, stop]);

  return {
    load,
    loadError,
    note,
    fields,
    save,
    conflict,
    draft,
    notice,
    failure,
    edit,
    flush,
    hasUnsaved,
    problem,
    settle,
    stop,
    keepMine,
    loadTheirs,
    restoreDraft,
    discardDraft,
    dismissNotice: () => setNotice(null),
    reload: () => setReloadKey((k) => k + 1),
    refresh,
    saveAsNew,
  };
}
