import { useSyncExternalStore } from "react";
import type { NextMove, NextMovesFile } from "../../../shared/types";
import { api, errorMessage, isOffline, type MoveStateUpdate } from "../api";

// One shared copy of data/next-moves.json for the page. Loads on first use and polls every 3 s
// only while `data.status` is "running"; otherwise it stays still (re-read when the tab returns
// after 5 minutes away).

export const NEXT_MOVES_POLL_MS = 3_000;
const STALE_AFTER_MS = 5 * 60_000;

interface NextMovesState {
  data: NextMovesFile | null;
  /** True only until the first answer arrives. */
  loading: boolean;
  /** Last failed read (GET), null after the next success. */
  error: string | null;
  offline: boolean;
  /** Last failed action (run, done, dismiss), shown near the buttons. Cleared by the next action. */
  actionError: string | null;
  /** True while POST /api/next-moves/run is in flight (before the server reports "running"). */
  starting: boolean;
  fetchedAt: number | null;
}

export interface NextMovesResult extends NextMovesState {
  /** Ask Claude for fresh moves (POST /api/next-moves/run), then poll until done. Never rejects. */
  run: () => Promise<void>;
  /**
   * Mark a move done or dismissed. Optimistic: the move's `state` changes at once (so the panel can
   * animate it out) and is put back if the server refuses. Never rejects; failures set `actionError`.
   */
  setState: (id: string, next: MoveStateUpdate) => Promise<void>;
  /** Re-read the file (GET /api/next-moves). Never rejects. */
  refresh: () => Promise<void>;
  clearActionError: () => void;
}

let state: NextMovesState = {
  data: null,
  loading: true,
  error: null,
  offline: false,
  actionError: null,
  starting: false,
  fetchedAt: null,
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<NextMovesState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
  schedulePoll();
}

function schedulePoll(): void {
  const running = state.data?.status === "running";
  if (!running || listeners.size === 0) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    return;
  }
  if (pollTimer || inflight) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refresh();
  }, NEXT_MOVES_POLL_MS);
}

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await api.getNextMoves(AbortSignal.timeout(20_000));
      inflight = null;
      set({ data, loading: false, error: null, offline: false, fetchedAt: Date.now() });
    } catch (err) {
      inflight = null;
      set({ loading: false, error: errorMessage(err), offline: isOffline(err) });
    }
  })();
  return inflight;
}

async function run(): Promise<void> {
  if (state.starting || state.data?.status === "running") return;
  set({ starting: true, actionError: null });
  try {
    const data = await api.runNextMoves();
    set({ data, starting: false, error: null, offline: false, fetchedAt: Date.now() });
  } catch (err) {
    set({ starting: false, actionError: errorMessage(err) });
  }
}

function withMoveState(file: NextMovesFile, id: string, next: NextMove["state"]): NextMovesFile {
  return { ...file, moves: file.moves.map((m) => (m.id === id ? { ...m, state: next } : m)) };
}

async function setMoveState(id: string, next: MoveStateUpdate): Promise<void> {
  const before = state.data?.moves.find((m) => m.id === id);
  if (!state.data || !before) return;
  set({ data: withMoveState(state.data, id, next), actionError: null });
  try {
    const data = await api.setMoveState(id, next);
    set({ data, fetchedAt: Date.now() });
  } catch (err) {
    const current = state.data;
    set({
      data: current ? withMoveState(current, id, before.state) : current,
      actionError: errorMessage(err),
    });
  }
}

function clearActionError(): void {
  if (state.actionError !== null) set({ actionError: null });
}

function onVisible(): void {
  if (document.visibilityState !== "visible") return;
  if (state.fetchedAt === null || Date.now() - state.fetchedAt >= STALE_AFTER_MS) void refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisible);
    if (state.data === null) void refresh();
    else schedulePoll();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisible);
      schedulePoll();
    }
  };
}

const getState = () => state;

/** `{ data, loading, error, offline, actionError, starting, fetchedAt, run, setState, refresh, clearActionError }`. */
export function useNextMoves(): NextMovesResult {
  const s = useSyncExternalStore(subscribe, getState, getState);
  return { ...s, run, setState: setMoveState, refresh, clearActionError };
}
