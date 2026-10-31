import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NoteMeta, ProjectsState, SourceStatus } from "../../../shared/types";
import { ApiRequestError, errorMessage, isOffline } from "../api";
import { notesApi } from "../api/notes";
import { projectsApi } from "../api/projects";
import { useSnapshot } from "../hooks/useSnapshot";
import { registryReady } from "../lib/timeAgg";

// The Projects view's data: the registry from GET /api/projects (shown at once from the snapshot's
// copy while that loads), every note's metadata from GET /api/notes (for linked notes and open
// actions), and one write helper.
//
// Writes: write(call, optimistic?) applies `optimistic` to what is shown at once, adopts the
// server's ProjectsState when it answers (every write answers the fresh state), then re-reads the
// snapshot so Home, the charts and Needs you catch up. On failure the optimistic change is dropped
// and the error is thrown for the caller to show; a 404 (project deleted elsewhere) also re-reads
// the list so the view can say the project is gone.

export interface LoadProblem {
  message: string;
  offline: boolean;
  status: number;
}

export interface NotesState {
  /** "loading" until the first answer; "failed" when the request failed; else the index's own status. */
  status: "loading" | "failed" | SourceStatus;
  message?: string;
  /** Every note's metadata, or null while unknown (loading, failed, not connected). */
  notes: NoteMeta[] | null;
}

export interface ProjectsStore {
  /** What to show: the server's state with any optimistic changes on top. Null until there is any copy. */
  state: ProjectsState | null;
  /** True until the first GET answers. */
  loading: boolean;
  /** The last GET failed. `state` may still hold the snapshot's copy or an earlier answer. */
  problem: LoadProblem | null;
  /** True when `state` is the snapshot's copy because GET /api/projects has not answered (or failed). */
  fromSnapshot: boolean;
  reload: () => Promise<void>;
  notes: NotesState;
  reloadNotes: () => Promise<void>;
  write: (call: () => Promise<ProjectsState>, optimistic?: (s: ProjectsState) => ProjectsState) => Promise<ProjectsState>;
}

function toProblem(err: unknown): LoadProblem {
  return {
    message: errorMessage(err),
    offline: isOffline(err),
    status: err instanceof ApiRequestError ? err.status : 0,
  };
}

/** Re-read on window focus at most this often, so edits made in another tab or in Obsidian show up. */
const FOCUS_RELOAD_MS = 30_000;

export function useProjectsStore(): ProjectsStore {
  const snap = useSnapshot();
  const refreshSnapshot = snap.refresh;
  const [server, setServer] = useState<ProjectsState | null>(null);
  const [ops, setOps] = useState<{ id: number; fn: (s: ProjectsState) => ProjectsState }[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<LoadProblem | null>(null);
  const [notes, setNotes] = useState<NotesState>({ status: "loading", notes: null });
  /** Goes up whenever a write's answer is adopted, so an older GET never overwrites it. */
  const version = useRef(0);
  const opSeq = useRef(0);
  const lastLoad = useRef(0);

  const reload = useCallback(async () => {
    const started = version.current;
    lastLoad.current = Date.now();
    try {
      const next = await projectsApi.list();
      if (version.current === started) {
        version.current += 1;
        setServer(next);
      }
      setProblem(null);
    } catch (err) {
      setProblem(toProblem(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadNotes = useCallback(async () => {
    try {
      const index = await notesApi.index();
      const usable = index.status === "ok" || index.status === "stale";
      setNotes({ status: index.status, message: index.message, notes: usable ? index.notes : null });
    } catch (err) {
      setNotes((prev) => ({ status: "failed", message: errorMessage(err), notes: prev.notes }));
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadNotes();
    const onFocus = () => {
      if (Date.now() - lastLoad.current < FOCUS_RELOAD_MS) return;
      void reload();
      void reloadNotes();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload, reloadNotes]);

  const write = useCallback(
    async (call: () => Promise<ProjectsState>, optimistic?: (s: ProjectsState) => ProjectsState) => {
      const id = ++opSeq.current;
      if (optimistic) setOps((list) => [...list, { id, fn: optimistic }]);
      try {
        const next = await call();
        version.current += 1;
        setServer(next);
        setProblem(null);
        void refreshSnapshot();
        return next;
      } catch (err) {
        // Gone elsewhere: re-read the list (the view then says so) and the snapshot (charts drop it too).
        if (err instanceof ApiRequestError && err.status === 404) {
          void reload();
          void refreshSnapshot();
        }
        throw err;
      } finally {
        if (optimistic) setOps((list) => list.filter((op) => op.id !== id));
      }
    },
    [refreshSnapshot, reload],
  );

  const snapshotCopy = registryReady(snap.data?.projects) ? (snap.data?.projects ?? null) : null;
  const base = server ?? snapshotCopy;
  const state = useMemo(() => (base ? ops.reduce((s, op) => op.fn(s), base) : null), [base, ops]);

  return {
    state,
    loading: loading && base === null,
    problem,
    fromSnapshot: server === null && base !== null,
    reload,
    notes,
    reloadNotes,
    write,
  };
}
