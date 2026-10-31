// Note file format (docs/ARCHITECTURE.md "v1.1: Project tracker and notes", Storage).
//
// A note is a markdown file with an optional YAML frontmatter block:
//
//   ---
//   title: Sprint review with underwriting
//   created: 2026-10-30T14:05:00+03:00
//   updated: 2026-10-30T14:40:00+03:00
//   project: qic-fastbind
//   tags: [meeting, fastbind]
//   ---
//
//   <body>
//
// Only a YAML subset is understood, parsed by hand (no dependency): `key: value` lines with plain,
// 'single' or "double" quoted scalars, `[a, b]` flow lists and `- item` block lists. Every other
// line of the block (keys this app does not own, comments, nested values) is kept verbatim, so a
// note edited in Obsidian keeps its own properties when the dashboard saves it. Pure functions only.
//
// v1.2 task notes (docs/ARCHITECTURE.md "Task notes") add flat keys next to these:
//
//   task_due: 2026-11-02
//   task_start: "09:30"
//   task_minutes: 45
//   task_done: false
//   task_source: me
//
// task_start is written quoted so a YAML 1.1 reader does not turn 09:30 into a number. Reading is
// forgiving: a value that does not fit (hand-edited in Obsidian) reads as unset, never an error.

import type { TaskInfo } from "../shared/types";

/** One top-level frontmatter entry: a `key:` line plus its indented or `- ` continuation lines. */
export interface FrontmatterEntry {
  /** The key, or "" for a line that is not a key (blank line, comment, stray text). */
  key: string;
  lines: string[];
}

export interface ParsedNoteFile {
  /** null when the file has no (closed) frontmatter block. */
  frontmatter: FrontmatterEntry[] | null;
  /** Everything after the block, LF line endings, one blank separator line dropped. */
  body: string;
}

/** The frontmatter fields the dashboard owns. null = key missing or empty. */
export interface NoteFields {
  title: string | null;
  created: string | null;
  updated: string | null;
  projectId: string | null;
  /** Valid tags only (see isValidTag); null when there is no tags key. */
  tags: string[] | null;
}

/** Tags: 1 to 30 letters, numbers or hyphens, with at least one letter or number. */
export const MAX_TAG_CHARS = 30;
const TAG = /^[\p{L}\p{N}-]+$/u;

export function isValidTag(tag: string): boolean {
  return TAG.test(tag) && [...tag].length <= MAX_TAG_CHARS && /[\p{L}\p{N}]/u.test(tag);
}

/** CRLF and lone CR become LF; a leading BOM is dropped. */
export function normalizeText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
const KEY_LINE = /^([^\s#\-][^:]*?):(?:[ \t]+(.*))?$/;

/** Splits a note file into frontmatter entries and body. Never throws. */
export function parseNoteFile(text: string): ParsedNoteFile {
  const t = normalizeText(text);
  const lines = t.split("\n");
  if (!OPEN_FENCE.test(lines[0] ?? "")) return { frontmatter: null, body: t };
  const close = lines.findIndex((line, i) => i > 0 && CLOSE_FENCE.test(line));
  if (close < 0) return { frontmatter: null, body: t };

  const entries: FrontmatterEntry[] = [];
  for (const line of lines.slice(1, close)) {
    const key = KEY_LINE.exec(line);
    const last = entries.at(-1);
    if (key) {
      entries.push({ key: key[1]!.trim(), lines: [line] });
    } else if (last && last.key !== "" && line.trim() !== "" && /^[ \t-]/.test(line)) {
      last.lines.push(line); // indented value or block list item of the key above
    } else {
      entries.push({ key: "", lines: [line] });
    }
  }
  const rest = lines.slice(close + 1).join("\n");
  return { frontmatter: entries, body: rest.startsWith("\n") ? rest.slice(1) : rest };
}

/** The file text for frontmatter entries plus body; the inverse of parseNoteFile. */
export function serializeNoteFile(entries: FrontmatterEntry[], body: string): string {
  const block = entries.flatMap((e) => e.lines).join("\n");
  return `---\n${block}${block === "" ? "" : "\n"}---\n${body === "" ? "" : `\n${body}`}`;
}

/** Replaces the first entry with `key` (dropping duplicates of it) or appends one. Returns a new list. */
export function setEntry(entries: FrontmatterEntry[], key: string, line: string): FrontmatterEntry[] {
  const next: FrontmatterEntry[] = [];
  let placed = false;
  for (const entry of entries) {
    if (entry.key !== key) {
      next.push(entry);
    } else if (!placed) {
      next.push({ key, lines: [line] });
      placed = true;
    }
  }
  if (!placed) next.push({ key, lines: [line] });
  return next;
}

/** A YAML scalar as text: quotes removed, escapes read, a trailing ` # comment` dropped. */
export function parseScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (!m) return s.slice(1);
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1]!;
    }
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    return m ? m[1]!.replace(/''/g, "'") : s.slice(1);
  }
  const hash = s.search(/\s#/);
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

/** Splits `[a, "b, c", 'd']` into items, respecting quotes. */
function parseFlowList(raw: string): string[] {
  const s = raw.trim();
  const end = s.lastIndexOf("]");
  const inner = s.slice(1, end > 0 ? end : undefined);
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) current += inner[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map(parseScalar).filter((item) => item !== "");
}

/** The value text of an entry: inline value, or a block scalar (`|` / `>`) joined. */
function entryValue(entry: FrontmatterEntry): string {
  const inline = KEY_LINE.exec(entry.lines[0] ?? "")?.[2] ?? "";
  if (/^[|>][-+0-9]*\s*$/.test(inline.trim())) {
    const parts = entry.lines.slice(1).map((l) => l.trim());
    return parts.join(inline.trim().startsWith("|") ? "\n" : " ").trim();
  }
  return parseScalar(inline);
}

function entryList(entry: FrontmatterEntry): string[] {
  const inline = (KEY_LINE.exec(entry.lines[0] ?? "")?.[2] ?? "").trim();
  if (inline.startsWith("[")) return parseFlowList(inline);
  if (inline !== "") return parseScalar(inline).split(/[,\s]+/).filter((t) => t !== "");
  return entry.lines
    .slice(1)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(parseScalar)
    .filter((v) => v !== "");
}

const NULLISH = new Set(["", "~", "null", "Null", "NULL"]);

/** Reads the fields the dashboard owns. Tags are cleaned: leading # dropped, invalid ones skipped, max 10. */
export function readFields(entries: FrontmatterEntry[] | null): NoteFields {
  const fields: NoteFields = { title: null, created: null, updated: null, projectId: null, tags: null };
  if (!entries) return fields;
  const find = (key: string) => entries.find((e) => e.key === key);
  const text = (key: string): string | null => {
    const entry = find(key);
    if (!entry) return null;
    const value = entryValue(entry);
    return NULLISH.has(value) ? null : value;
  };
  fields.title = text("title");
  fields.created = text("created");
  fields.updated = text("updated");
  fields.projectId = text("project");
  const tags = find("tags");
  if (tags) {
    const seen = new Set<string>();
    fields.tags = [];
    for (const raw of entryList(tags)) {
      const tag = raw.replace(/^#/, "").trim();
      if (!isValidTag(tag) || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      fields.tags.push(tag);
    }
    fields.tags = fields.tags.slice(0, 10);
  }
  return fields;
}

const RESERVED = /^(?:true|false|yes|no|on|off|null|y|n)$/i;
const PLAIN = /^\p{L}[\p{L}\p{M}\p{N} _.,()&'!?-]*$/u;

/** A string as a YAML scalar: plain when that is unambiguous, otherwise double quoted. */
export function yamlString(value: string): string {
  if (PLAIN.test(value) && !/\s$/.test(value) && !RESERVED.test(value)) return value;
  return JSON.stringify(value);
}

/** Lines for the fields the dashboard writes. */
export const fieldLine = {
  title: (title: string) => `title: ${yamlString(title)}`,
  created: (iso: string) => `created: ${iso}`,
  updated: (iso: string) => `updated: ${iso}`,
  project: (id: string | null) => (id ? `project: ${yamlString(id)}` : "project:"),
  tags: (tags: string[]) => `tags: [${tags.map(yamlString).join(", ")}]`,
  // Task fields: callers pass values already checked by the readers below (isTaskDate, ...).
  taskDue: (due: string | null) => (due ? `task_due: ${due}` : "task_due:"),
  taskStart: (start: string | null) => (start ? `task_start: "${start}"` : "task_start:"),
  taskMinutes: (minutes: number | null) => (minutes !== null ? `task_minutes: ${minutes}` : "task_minutes:"),
  taskDone: (done: boolean) => `task_done: ${done ? "true" : "false"}`,
  taskSource: (source: TaskInfo["source"]) => `task_source: ${source}`,
};

/** Frontmatter key for each TaskInfo field. */
export const TASK_KEYS = {
  due: "task_due",
  start: "task_start",
  minutes: "task_minutes",
  done: "task_done",
  source: "task_source",
} as const satisfies Record<keyof TaskInfo, string>;

/** Longest planned length a task may carry: one day. */
export const MAX_TASK_MINUTES = 24 * 60;

/** A real calendar date written YYYY-MM-DD. */
export function isTaskDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

/** A 24-hour time written HH:MM, 00:00 to 23:59. */
export function isTaskTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** A whole number of minutes, 1 to MAX_TASK_MINUTES. */
export function isTaskMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TASK_MINUTES;
}

/**
 * Reads the task_* keys. Anything missing or malformed reads as unset: due, start and minutes
 * null, done false, source "me". "9:30" is read as 09:30; done is true only for true or yes.
 */
export function readTaskFields(entries: FrontmatterEntry[] | null): TaskInfo {
  const task: TaskInfo = { due: null, start: null, minutes: null, done: false, source: "me" };
  if (!entries) return task;
  const text = (key: string): string | null => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return null;
    const value = entryValue(entry).trim();
    return NULLISH.has(value) ? null : value;
  };
  const due = text(TASK_KEYS.due);
  if (isTaskDate(due)) task.due = due;
  const start = text(TASK_KEYS.start);
  const time = start !== null ? /^(\d{1,2}):(\d{2})$/.exec(start) : null;
  if (time) {
    const padded = `${time[1]!.padStart(2, "0")}:${time[2]}`;
    if (isTaskTime(padded)) task.start = padded;
  }
  const minutes = text(TASK_KEYS.minutes);
  if (minutes !== null && /^\d{1,5}$/.test(minutes) && isTaskMinutes(Number(minutes))) task.minutes = Number(minutes);
  const done = text(TASK_KEYS.done);
  task.done = done !== null && /^(?:true|yes)$/i.test(done);
  if (text(TASK_KEYS.source) === "ai") task.source = "ai";
  return task;
}

/** Sets the given task fields on a frontmatter list; fields left out keep their lines. Returns a new list. */
export function setTaskEntries(entries: FrontmatterEntry[], task: Partial<TaskInfo>): FrontmatterEntry[] {
  let next = entries;
  if (task.due !== undefined) next = setEntry(next, TASK_KEYS.due, fieldLine.taskDue(task.due));
  if (task.start !== undefined) next = setEntry(next, TASK_KEYS.start, fieldLine.taskStart(task.start));
  if (task.minutes !== undefined) next = setEntry(next, TASK_KEYS.minutes, fieldLine.taskMinutes(task.minutes));
  if (task.done !== undefined) next = setEntry(next, TASK_KEYS.done, fieldLine.taskDone(task.done));
  if (task.source !== undefined) next = setEntry(next, TASK_KEYS.source, fieldLine.taskSource(task.source));
  return next;
}

/**
 * The body with its first `# ` heading (outside code blocks) set to `title`. A body without one
 * gets `# title` on top, so the heading always names the task.
 */
export function withFirstHeading(body: string, title: string): string {
  const lines = normalizeText(body).split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence === null && /^#[ \t]+\S/.test(line)) {
      lines[i] = `# ${title}`;
      return lines.join("\n");
    }
  }
  const rest = normalizeText(body);
  return rest.trim() === "" ? `# ${title}\n` : `# ${title}\n\n${rest}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Local time with its UTC offset, second precision: 2026-10-30T14:05:00+03:00. */
export function formatLocalIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Local calendar date YYYY-MM-DD. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calls `visit` for every body line outside fenced code blocks. */
function eachProseLine(body: string, visit: (line: string) => void): void {
  let fence: string | null = null;
  for (const line of normalizeText(body).split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence === null) visit(line);
  }
}

/** Text of the first `# ` heading, or null. */
export function firstHeading(body: string): string | null {
  let found: string | null = null;
  eachProseLine(body, (line) => {
    if (found !== null) return;
    const m = /^#[ \t]+(.+)$/.exec(line);
    const text = m?.[1]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (text) found = text;
  });
  return found;
}

const OPEN_ACTION = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(\S.*)$/;

/**
 * Unchecked task lines with text ("- [ ] Send the minutes"), outside code blocks. An empty
 * "- [ ] " placeholder (the meeting template has one) is not an action yet and is not counted.
 */
export function openActionLines(body: string): string[] {
  const found: string[] = [];
  eachProseLine(body, (line) => {
    const m = OPEN_ACTION.exec(line);
    if (m) found.push(m[1]!.trim());
  });
  return found;
}

export const EXCERPT_CHARS = 300;

/** Plain text from the body (headings and list or task markers dropped), at most 300 characters. */
export function excerptOf(body: string, max = EXCERPT_CHARS): string {
  const parts: string[] = [];
  eachProseLine(body, (line) => {
    if (/^\s*#/.test(line)) return;
    const text = line
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s*/, "")
      .trim();
    if (text) parts.push(text);
  });
  const chars = [...parts.join(" ").replace(/\s+/g, " ")];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 3).join("").trimEnd()}...`;
}
