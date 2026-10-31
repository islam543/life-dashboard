import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, NoteMeta, NotesIndex } from "../../../shared/types";
import { errorMessage, isOffline } from "../api";
import { notesApi } from "../api/notes";
import { DEFAULT_VAULT_ID } from "../lib/notes";

// The notes index (sections tree plus every note's metadata) for the Notes view. One read on mount
// and a re-read when the window gets focus back (Islam may have added or moved files in Obsidian).
// Writes answer either a fresh NotesIndex (adopt it) or one Note (merge its metadata). A read that
// started before a write answered is dropped, so a slow read never undoes a write.

const FOCUS_THROTTLE_MS = 3_000;

export interface NotesIndexResult {
  data: NotesIndex | null;
  /** True until the first answer. */
  loading: boolean;
  error: string | null;
  offline: boolean;
  /** True while a read is in flight (first load or a retry). */
  reading: boolean;
  reload: () => Promise<void>;
  /** Show the NotesIndex a write answered. */
  adopt: (index: NotesIndex) => void;
  /** Merge one note's metadata (after create or save). */
  upsert: (note: Note | NoteMeta) => void;
}

function metaOf(note: Note | NoteMeta): NoteMeta {
  const { path, section, title, created, updated, projectId, tags, excerpt, openActions } = note;
  // vault and readOnly (v1.4) are missing from an older server; the default vault, writable, matches it.
  const vault = typeof note.vault === "string" && note.vault ? note.vault : DEFAULT_VAULT_ID;
  return { path, section, title, created, updated, projectId, tags, excerpt, openActions, vault, readOnly: note.readOnly === true };
}

export function useNotesIndex(): NotesIndexResult {
  const [data, setData] = useState<NotesIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const version = useRef(0);
  const lastRead = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);

  const reload = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const started = version.current;
    lastRead.current = Date.now();
    setReading(true);
    const run = (async () => {
      try {
        const next = await notesApi.index(AbortSignal.timeout(20_000));
        if (version.current !== started) return; // a write answered meanwhile: its data is newer
        version.current += 1;
        setData(next);
        setError(null);
        setOffline(false);
      } catch (err) {
        if (version.current !== started) return;
        setError(errorMessage(err));
        setOffline(isOffline(err));
      } finally {
        inflight.current = null;
        setLoading(false);
        setReading(false);
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  const adopt = useCallback((index: NotesIndex) => {
    version.current += 1;
    setData(index);
    setError(null);
    setOffline(false);
    setLoading(false);
  }, []);

  const upsert = useCallback((note: Note | NoteMeta) => {
    version.current += 1;
    const meta = metaOf(note);
    setData((prev) => {
      if (!prev) return prev;
      const at = prev.notes.findIndex((n) => n.path === meta.path);
      const notes = at === -1 ? [...prev.notes, meta] : prev.notes.map((n, i) => (i === at ? meta : n));
      return { ...prev, notes };
    });
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRead.current < FOCUS_THROTTLE_MS) return;
      void reload();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);

  return { data, loading, error, offline, reading, reload, adopt, upsert };
}
