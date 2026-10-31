import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { SessionTime } from "../../shared/types";
import { localDateKey } from "../checkinValidate";
import type { Collector } from "./types";

// Active Claude Code time per project per local day, from ~/.claude/projects/<folder>/*.jsonl.
// Only the top-level `timestamp` of each line is read. Nothing else from a session file is kept,
// logged or returned: the cache and the output hold numbers and project names only.

/** A gap between two timestamps shorter than this counts as active time. */
export const GAP_LIMIT_MS = 15 * 60_000;
/** Local days of history returned, today included. */
export const WINDOW_DAYS = 365;
/** Display name for sessions started in the home folder itself. */
export const HOME_PROJECT = "Home";

/** Folder names containing one of these (any case) are throwaway sessions and are skipped. */
const SKIP_MARKERS = ["appdata-local-temp", "appdata-roaming-claude-scratch"];
/** `<project>\.claude\worktrees\<name>` encodes to `<project>--claude-worktrees-<name>`. */
const WORKTREE_MARKER = "--claude-worktrees-";
/** Folders that only hold projects. At most one is stripped from the front of a name, longest first. */
const CONTAINERS = ["Documents-GitHub", "Desktop-MD-Files", "Documents", "Desktop", "Downloads", "OneDrive"];
const ISO_START = /^\d{4}-\d{2}-\d{2}T/;
const READ_CONCURRENCY = 4;

/** [start, end] in epoch ms. A single timestamp is an interval of length 0. */
export type Interval = [start: number, end: number];

/** Claude Code names a project folder by replacing every character that is not a letter or digit with "-". */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

/** The part of `name` after the encoded home folder, "" for the home folder itself, null if not under home. */
function stripHome(name: string, home: string): string | null {
  const encoded = encodeProjectPath(home);
  if (encoded !== "" && name.toLowerCase().startsWith(encoded.toLowerCase())) {
    const after = name.slice(encoded.length);
    if (after === "") return "";
    if (after.startsWith("-")) return after.slice(1);
  }
  // Fallback when `home` differs from the machine that wrote the folders.
  const match = /^[A-Za-z]--Users-[^-]+(?:-|$)/i.exec(name) ?? /^-(?:home|Users)-[^-]+(?:-|$)/.exec(name);
  return match ? name.slice(match[0].length) : null;
}

/**
 * Display name for a project folder, or null when the folder is skipped (temp and scratch sessions).
 * `C--Users-ialab-Documents-GitHub-QIC-QIC-FastBind` -> `QIC-FastBind`,
 * `C--Users-ialab-Desktop-Trading-research` -> `Trading-research`, `C--Users-ialab` -> `Home`.
 * Worktree folders (`...--claude-worktrees-*`) get their parent project's name.
 */
export function projectName(folder: string, home: string): string | null {
  const lower = folder.toLowerCase();
  if (SKIP_MARKERS.some((marker) => lower.includes(marker))) return null;

  const worktree = lower.indexOf(WORKTREE_MARKER);
  const base = worktree >= 0 ? folder.slice(0, worktree) : folder;

  const underHome = stripHome(base, home);
  if (underHome === "") return HOME_PROJECT;
  let rest = underHome ?? base.replace(/^[A-Za-z]--/, "");

  for (const container of CONTAINERS) {
    const prefix = `${container.toLowerCase()}-`;
    if (rest.toLowerCase().startsWith(prefix) && rest.length > prefix.length) {
      rest = rest.slice(prefix.length);
      break;
    }
  }

  // An org folder named like the repo prefix: `QIC-QIC-FastBind` -> `QIC-FastBind`.
  const [first, second] = rest.split("-");
  if (first && second !== undefined && first.toLowerCase() === second.toLowerCase()) {
    rest = rest.slice(first.length + 1);
  }

  rest = rest.replace(/^-+|-+$/g, "");
  return rest === "" ? base : rest;
}

/** The top-level `timestamp` of one JSONL line in epoch ms, or null for malformed lines and lines without one. */
export function lineTimestamp(line: string): number | null {
  if (!line.includes('"timestamp"')) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const ts = (value as { timestamp?: unknown }).timestamp;
  if (typeof ts !== "string" || !ISO_START.test(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** Streams a session file line by line and returns its timestamps, unsorted. */
export async function readTimestamps(file: string, signal?: AbortSignal): Promise<number[]> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let failure: unknown = null;
  // Close the line reader on a stream error so the loop below ends instead of waiting forever.
  stream.on("error", (err) => {
    failure ??= err;
    lines.close();
  });
  const out: number[] = [];
  try {
    for await (const line of lines) {
      const ts = lineTimestamp(line);
      if (ts !== null) out.push(ts);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (failure) throw failure;
  signal?.throwIfAborted();
  return out;
}

/** Sorts and joins intervals whose gap is under `gapMs`; overlapping intervals always join. */
export function mergeIntervals(list: readonly Interval[], gapMs = GAP_LIMIT_MS): Interval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Interval[] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start - last[1] < gapMs) {
      if (end > last[1]) last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** Sorts timestamps and chains every gap under `gapMs` into active intervals. */
export function activeIntervals(timestamps: readonly number[], gapMs = GAP_LIMIT_MS): Interval[] {
  const sorted = Float64Array.from(timestamps).sort();
  const out: Interval[] = [];
  for (const ts of sorted) {
    const last = out[out.length - 1];
    if (last && ts - last[1] < gapMs) last[1] = ts;
    else out.push([ts, ts]);
  }
  return out;
}

/** Whole minutes per local day (YYYY-MM-DD) inside [from, to). Intervals crossing midnight are split. */
export function minutesByLocalDay(intervals: readonly Interval[], from: number, to: number): Record<string, number> {
  const msByDay = new Map<string, number>();
  for (const [start, end] of intervals) {
    let cursor = Math.max(start, from);
    const stop = Math.min(end, to);
    while (cursor < stop) {
      const day = new Date(cursor);
      const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
      const sliceEnd = Math.min(stop, nextMidnight);
      const key = localDateKey(day);
      msByDay.set(key, (msByDay.get(key) ?? 0) + sliceEnd - cursor);
      cursor = sliceEnd;
    }
  }
  const out: Record<string, number> = {};
  for (const key of [...msByDay.keys()].sort()) {
    const minutes = Math.round(msByDay.get(key)! / 60_000);
    if (minutes > 0) out[key] = minutes;
  }
  return out;
}

/** Local midnight that opens the window of `WINDOW_DAYS` days ending today. */
export function windowStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (WINDOW_DAYS - 1)).getTime();
}

export interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  intervals: Interval[];
}
/** Active intervals per session file, keyed by full path. Reused while mtime and size are unchanged. */
export type FileCache = Map<string, FileCacheEntry>;

/** Kept for the life of the server process, so a 30 min refresh only rereads files that changed. */
const sharedCache: FileCache = new Map();

export interface SessionTimeOptions {
  projectsDir: string;
  home: string;
  now: Date;
  signal?: AbortSignal;
  /** Defaults to the process-wide cache. */
  cache?: FileCache;
}

export interface SessionTimeResult {
  sessionTime: SessionTime[];
  filesRead: number;
  filesCached: number;
  filesFailed: number;
}

async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Reads every project folder under `projectsDir` and returns active minutes per project per local day. */
export async function collectSessionTime(opts: SessionTimeOptions): Promise<SessionTimeResult> {
  const { projectsDir, home, now, signal } = opts;
  const cache = opts.cache ?? sharedCache;
  const from = windowStart(now);
  const to = now.getTime();

  const files: { project: string; file: string }[] = [];
  for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = projectName(entry.name, home);
    if (project === null) continue;
    const folder = path.join(projectsDir, entry.name);
    let children;
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isFile() && child.name.toLowerCase().endsWith(".jsonl")) {
        files.push({ project, file: path.join(folder, child.name) });
      }
    }
  }

  // Intervals from every file of a project (worktrees and same-name folders included) are merged
  // together, so parallel sessions in one project are not counted twice.
  const byProject = new Map<string, Interval[]>();
  const seen = new Set<string>();
  let filesRead = 0;
  let filesCached = 0;
  let filesFailed = 0;

  await eachLimit(files, READ_CONCURRENCY, async ({ project, file }) => {
    signal?.throwIfAborted();
    let intervals: Interval[];
    try {
      const info = await stat(file);
      if (info.mtimeMs < from) return; // last written before the window: nothing inside it
      seen.add(file);
      const cached = cache.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        intervals = cached.intervals;
        filesCached++;
      } else {
        intervals = activeIntervals(await readTimestamps(file, signal));
        cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, intervals });
        filesRead++;
      }
    } catch {
      signal?.throwIfAborted();
      cache.delete(file);
      filesFailed++;
      return;
    }
    const list = byProject.get(project) ?? [];
    for (const interval of intervals) list.push(interval);
    byProject.set(project, list);
  });

  for (const file of cache.keys()) {
    if (!seen.has(file)) cache.delete(file);
  }

  const totals = new Map<string, number>();
  const sessionTime: SessionTime[] = [];
  for (const [project, intervals] of byProject) {
    const minutesByDay = minutesByLocalDay(mergeIntervals(intervals), from, to);
    const total = Object.values(minutesByDay).reduce((sum, m) => sum + m, 0);
    if (total === 0) continue;
    totals.set(project, total);
    sessionTime.push({ project, minutesByDay });
  }
  sessionTime.sort((a, b) => totals.get(b.project)! - totals.get(a.project)! || a.project.localeCompare(b.project));

  return { sessionTime, filesRead, filesCached, filesFailed };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// Keep the export name and type: the registry in index.ts imports `claudeSessionsCollector`.
export const claudeSessionsCollector: Collector<"claudeSessions"> = {
  key: "claudeSessions",
  async collect(ctx) {
    const dir = ctx.config.claudeProjectsDir;
    if (!(await isDirectory(dir))) {
      return {
        status: "not_connected",
        message: "No Claude Code sessions folder found. Set CLAUDE_PROJECTS_DIR in .env",
        data: { sessionTime: [] },
      };
    }
    const result = await collectSessionTime({ projectsDir: dir, home: ctx.config.home, now: ctx.now, signal: ctx.signal });
    const data = { sessionTime: result.sessionTime };
    if (result.filesFailed > 0) {
      const files = result.filesFailed === 1 ? "file" : "files";
      return { status: "ok", message: `${result.filesFailed} session ${files} could not be read`, data };
    }
    return { status: "ok", data };
  },
};
