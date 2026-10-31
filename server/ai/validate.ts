import type { Area, NextMove, NextMovesFile } from "../../shared/types";

// Hand-written guards for everything that crosses a trust boundary in the next-moves run:
// the `claude -p --output-format json` envelope, the model's answer, and the files in data/.

/** A move as Claude returns it: NextMove without `state`. */
export type ProposedMove = Omit<NextMove, "state">;

export const AREAS: readonly Area[] = ["work", "learning", "personal", "calendar", "email"];
const FILE_STATUSES: readonly NextMovesFile["status"][] = ["ok", "error", "not_logged_in", "running", "never_run"];
const MOVE_STATES: readonly NextMove["state"][] = ["open", "done", "dismissed"];

export const TITLE_MAX = 160;
export const REASON_MAX = 300;
export const ID_MAX = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One line, trimmed, capped at `max` characters ("..." when cut). */
export function oneLine(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** The parts of the CLI's JSON envelope we use. */
export interface ClaudeEnvelope {
  result: string;
  isError: boolean;
}

/**
 * Reads the `--output-format json` envelope: one JSON object with a string `result`.
 * Tolerates log lines around it by trying the whole text, then each line from the end.
 */
export function parseEnvelope(stdout: string): ClaudeEnvelope | null {
  const text = stdout.replace(/^﻿/, "").trim();
  if (text === "") return null;
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isObject(parsed) && typeof parsed.result === "string") {
      return { result: parsed.result, isError: parsed.is_error === true || parsed.subtype === "error" };
    }
  }
  return null;
}

const AUTH_MARKERS = [/failed to authenticate/i, /oauth/i, /please run \/login/i, /not logged in/i, /invalid api key/i];

/** True when CLI output says the login is missing or expired. Only check this on a failed run. */
export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_MARKERS.some((re) => re.test(text));
}

/** End index of the bracketed value starting at `start` (a "[" ), or -1 when it never closes. */
function closingIndex(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

const MAX_ARRAY_TRIES = 50;

/**
 * Finds the JSON array in a model answer that may carry prose or code fences around it.
 * Returns the first array whose items are all objects (an empty array counts). When no
 * array has that shape, returns the first array that parses (so the guard can reject it),
 * or null when there is no JSON array at all.
 */
export function extractFirstJsonArray(text: string): unknown[] | null {
  let firstParsed: unknown[] | null = null;
  let tries = 0;
  for (let start = text.indexOf("["); start !== -1 && tries < MAX_ARRAY_TRIES; start = text.indexOf("[", start + 1)) {
    const end = closingIndex(text, start);
    if (end === -1) continue;
    tries++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    if (parsed.every(isObject)) return parsed;
    firstParsed ??= parsed;
  }
  return firstParsed;
}

export type MovesCheck = { ok: true; moves: ProposedMove[] } | { ok: false; error: string };

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Guard for the model's answer: an array of NextMove without `state`.
 * Any bad item rejects the whole answer. Extra keys are dropped; text is cleaned to one line.
 */
export function validateProposedMoves(value: unknown): MovesCheck {
  if (!Array.isArray(value)) return { ok: false, error: "Answer is not a JSON array" };
  const moves: ProposedMove[] = [];
  for (const [i, item] of value.entries()) {
    const where = `Move ${i + 1}`;
    if (!isObject(item)) return { ok: false, error: `${where} is not an object` };
    if (!nonEmptyString(item.id)) return { ok: false, error: `${where} has no id` };
    if (!nonEmptyString(item.title)) return { ok: false, error: `${where} has no title` };
    if (!nonEmptyString(item.reason)) return { ok: false, error: `${where} has no reason` };
    if (typeof item.area !== "string" || !AREAS.includes(item.area as Area)) {
      return { ok: false, error: `${where} has an unknown area` };
    }
    if (typeof item.rank !== "number" || !Number.isFinite(item.rank)) return { ok: false, error: `${where} has no numeric rank` };
    if (item.sourceUrl !== undefined && item.sourceUrl !== null && typeof item.sourceUrl !== "string") {
      return { ok: false, error: `${where} has a sourceUrl that is not a string` };
    }
    const move: ProposedMove = {
      id: oneLine(item.id, ID_MAX),
      title: oneLine(item.title, TITLE_MAX),
      reason: oneLine(item.reason, REASON_MAX),
      area: item.area as Area,
      rank: item.rank,
    };
    if (typeof item.sourceUrl === "string" && item.sourceUrl.trim() !== "") move.sourceUrl = item.sourceUrl.trim();
    moves.push(move);
  }
  return { ok: true, moves };
}

function isStoredMove(v: unknown): v is NextMove {
  return (
    isObject(v) &&
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.reason === "string" &&
    AREAS.includes(v.area as Area) &&
    typeof v.rank === "number" &&
    (v.sourceUrl === undefined || typeof v.sourceUrl === "string") &&
    MOVE_STATES.includes(v.state as NextMove["state"])
  );
}

/** Guard for data/next-moves.json. */
export function isNextMovesFile(v: unknown): v is NextMovesFile {
  return (
    isObject(v) &&
    (v.generatedAt === null || typeof v.generatedAt === "string") &&
    FILE_STATUSES.includes(v.status as NextMovesFile["status"]) &&
    (v.message === undefined || typeof v.message === "string") &&
    Array.isArray(v.moves) &&
    v.moves.every(isStoredMove)
  );
}

/** One done or dismissed move, kept so new runs can skip it. */
export interface MoveHistoryEntry {
  title: string;
  at: string;
}

/** data/next-moves-history.json */
export interface MoveHistory {
  dismissed: MoveHistoryEntry[];
  done: MoveHistoryEntry[];
}

const isHistoryEntry = (v: unknown): v is MoveHistoryEntry => isObject(v) && typeof v.title === "string" && typeof v.at === "string";

export function isMoveHistory(v: unknown): v is MoveHistory {
  return (
    isObject(v) &&
    Array.isArray(v.dismissed) &&
    v.dismissed.every(isHistoryEntry) &&
    Array.isArray(v.done) &&
    v.done.every(isHistoryEntry)
  );
}

/** Comparison key for titles: case, spacing and punctuation do not matter. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim();
}
