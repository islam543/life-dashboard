import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Checkin } from "../shared/types";

/**
 * File names inside data/. Shapes:
 * - snapshot.json   : Snapshot (last assembled, so last good data survives a restart)
 * - checkins.json   : Checkin[] sorted by date ascending, one entry per date
 * - next-moves.json : NextMovesFile
 * Collectors may add their own cache files, for example "cache/github.json".
 */
export const FILES = {
  snapshot: "snapshot.json",
  checkins: "checkins.json",
  nextMoves: "next-moves.json",
} as const;

export type Validator<T> = (value: unknown) => value is T;

/** JSON files in one folder. Reads never throw; writes are atomic and serialized per file. */
export interface Store {
  readonly dir: string;
  /** Absolute path for a file name like "checkins.json" or "cache/github.json". */
  pathOf(name: string): string;
  /**
   * Missing, empty or corrupt file (bad JSON, or `isValid` says no) gives `fallback`.
   * A corrupt file is first copied to `<name>.corrupt-<timestamp>` so nothing is lost.
   */
  read<T>(name: string, fallback: T, isValid?: Validator<T>): Promise<T>;
  /** Atomic write: temp file, fsync, rename. Creates folders as needed. */
  write(name: string, value: unknown): Promise<void>;
  /** Read-modify-write under the same per-file lock as `write`. Returns the written value. */
  update<T>(name: string, fallback: T, change: (current: T) => T, isValid?: Validator<T>): Promise<T>;
}

const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

function resolveName(dir: string, name: string): string {
  if (!SAFE_NAME.test(name) || name.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid data file name: ${name}`);
  }
  return path.join(dir, ...name.split("/"));
}

// Per-file promise chain, so writes and read-modify-writes to one file never interleave.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  locks.set(file, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      if (locks.get(file) === run) locks.delete(file);
    });
  return run;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows can briefly refuse a rename while another process (antivirus, indexer) holds the target.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      await sleep(25 * (attempt + 1));
    }
  }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new Error("Refusing to write a value that is not JSON");
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(json + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readSafe<T>(file: string, fallback: T, isValid?: Validator<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) !== "ENOENT") console.warn(`[store] could not read ${path.basename(file)} (${errorCode(err) ?? "unknown error"}), using empty data`);
    return fallback;
  }
  text = text.replace(/^﻿/, "");
  if (text.trim() === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    await keepCorruptCopy(file);
    return fallback;
  }
  if (isValid && !isValid(parsed)) {
    await keepCorruptCopy(file);
    return fallback;
  }
  return parsed as T;
}

async function keepCorruptCopy(file: string): Promise<void> {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await copyFile(file, backup);
    console.warn(`[store] ${path.basename(file)} was not valid; kept a copy as ${path.basename(backup)} and used empty data`);
  } catch {
    console.warn(`[store] ${path.basename(file)} was not valid and could not be copied; used empty data`);
  }
}

export function createStore(dir: string): Store {
  const root = path.resolve(dir);
  return {
    dir: root,
    pathOf: (name) => resolveName(root, name),
    read: (name, fallback, isValid) => readSafe(resolveName(root, name), fallback, isValid),
    write: (name, value) => {
      const file = resolveName(root, name);
      return withLock(file, () => writeAtomic(file, value));
    },
    update: (name, fallback, change, isValid) => {
      const file = resolveName(root, name);
      return withLock(file, async () => {
        const next = change(await readSafe(file, fallback, isValid));
        await writeAtomic(file, next);
        return next;
      });
    },
  };
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

function isCheckinLike(value: unknown): value is Checkin {
  return typeof value === "object" && value !== null && typeof (value as { date?: unknown }).date === "string";
}

/**
 * Saves a validated check-in into checkins.json, replacing any entry with the same date.
 * Keeps the file sorted by date ascending. Returns the full list.
 */
export async function upsertCheckin(store: Store, checkin: Checkin): Promise<Checkin[]> {
  const list = await store.update<unknown[]>(FILES.checkins, [], (current) => {
    const others = current.filter(isCheckinLike).filter((c) => c.date !== checkin.date);
    return [...others, checkin].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, isArray);
  return list as Checkin[];
}
