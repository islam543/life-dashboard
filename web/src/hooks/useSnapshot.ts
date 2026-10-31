import { useSyncExternalStore } from "react";
import type { Snapshot } from "../../../shared/types";
import { api, errorMessage, isOffline } from "../api";

// One shared snapshot for the whole page. Every component that calls useSnapshot() reads the same
// copy: one fetch on first use, one poll every 5 minutes while anything is mounted, and a re-read
// when the tab comes back after being hidden for longer than that. Responses can arrive out of
// order (a poll in flight while Refresh or a check-in POST answers), so a response older than the
// data on screen is dropped: see adopt() and dataVersion.

export const SNAPSHOT_POLL_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 20_000;

interface SnapshotState {
  /** Last good snapshot. Kept when a later request fails, so panels can show it with a notice. */
  data: Snapshot | null;
  /** True only until the first answer arrives (success or failure). */
  loading: boolean;
  /** Message of the last failed request, null after the next success. */
  error: string | null;
  /** True when that failure was "server unreachable" (show the offline banner). */
  offline: boolean;
  /** True while POST /api/refresh is running the collectors. */
  collecting: boolean;
  /** When `data` last arrived (ms since epoch). */
  fetchedAt: number | null;
}

export interface SnapshotResult extends SnapshotState {
  /** Re-read the saved snapshot (GET /api/snapshot). Cheap; call it after your own writes. Never rejects. */
  refresh: () => Promise<void>;
  /** Run every collector now (POST /api/refresh). Slow; this is the header's Refresh button. Never rejects. */
  collect: () => Promise<void>;
  /** Adopt a snapshot another call returned, e.g. the response of POST /api/checkin. */
  replace: (snapshot: Snapshot) => void;
}

let state: SnapshotState = {
  data: null,
  loading: true,
  error: null,
  offline: false,
  collecting: false,
  fetchedAt: null,
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Goes up by one every time `data` is adopted. A read remembers it when it starts; if it changed by
 * the time the read answers (a POST result landed meanwhile), the read is out of date.
 */
let dataVersion = 0;

function set(patch: Partial<SnapshotState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** generatedAt as ms, or null when missing or unreadable (then order cannot be judged). */
function generatedMs(snapshot: Snapshot | null): number | null {
  const ms = snapshot ? Date.parse(snapshot.generatedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** -1 when `next` was generated before `current`, 1 after, 0 same time or unknown. */
function compareAge(next: Snapshot, current: Snapshot | null): number {
  const a = generatedMs(next);
  const b = generatedMs(current);
  if (a === null || b === null || a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Shows `data` unless it is older than what is already shown, so a slow response never overwrites
 * newer data. The request itself succeeded either way, so any earlier error is cleared.
 */
function adopt(data: Snapshot, extra: Partial<SnapshotState> = {}): void {
  if (compareAge(data, state.data) < 0) {
    set({ loading: false, error: null, offline: false, ...extra });
    return;
  }
  dataVersion += 1;
  set({ data, loading: false, error: null, offline: false, fetchedAt: Date.now(), ...extra });
}

function refresh(): Promise<void> {
  if (inflight) return inflight;
  const startedAt = dataVersion;
  inflight = (async () => {
    try {
      const data = await api.getSnapshot(AbortSignal.timeout(READ_TIMEOUT_MS));
      // A POST (Refresh, check-in) answered while this read was in flight: keep its result unless
      // this read is strictly newer.
      if (dataVersion !== startedAt && compareAge(data, state.data) <= 0) {
        if (state.loading) set({ loading: false });
        return;
      }
      adopt(data);
    } catch (err) {
      // Newer data arrived after this read started, so the server answered since: not an outage.
      if (dataVersion !== startedAt) {
        if (state.loading) set({ loading: false });
        return;
      }
      set({ loading: false, error: errorMessage(err), offline: isOffline(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function collect(): Promise<void> {
  if (state.collecting) return;
  set({ collecting: true });
  try {
    const data = await api.refresh();
    adopt(data, { collecting: false });
  } catch (err) {
    set({ collecting: false, loading: false, error: errorMessage(err), offline: isOffline(err) });
  }
}

function replace(snapshot: Snapshot): void {
  adopt(snapshot);
}

function onVisible(): void {
  if (document.visibilityState !== "visible") return;
  if (state.fetchedAt === null || Date.now() - state.fetchedAt >= SNAPSHOT_POLL_MS) void refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    pollTimer = setInterval(() => void refresh(), SNAPSHOT_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    if (state.data === null) void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

const getState = () => state;

/** `{ data, loading, error, offline, collecting, fetchedAt, refresh, collect, replace }`. */
export function useSnapshot(): SnapshotResult {
  const s = useSyncExternalStore(subscribe, getState, getState);
  return { ...s, refresh, collect, replace };
}
