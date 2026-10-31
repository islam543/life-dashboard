import { createHash } from "node:crypto";
import type { DetectedAction } from "../../shared/types";

// Ticket T28: the actions in a note (docs/ARCHITECTURE.md "v1.2", "Detected actions"). Pure, no AI.
//
// An action is:
// - any checkbox line, `- [ ] text` or `- [x] text` (also `*`, `+`, `1.` and `1)` markers), at any depth;
// - a plain top-level bullet under a heading named like Action items, Actions, Next steps, To do or
//   Follow-ups, until the next heading of the same or a higher level.
// Lines inside fenced code blocks never count. A line holding a Jira key is already filed.
// Line numbers are 1-based lines of the note body, so they match the editor and the write-back.

/** Any Jira-shaped key. Kept for reference; detection uses the project key (see jiraKeyOnLine). */
export const LINE_JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

/**
 * The first key of this Jira project on a line ("AN-4602" for project AN). Only the configured
 * project counts, so text like COVID-19 or SHA-256 never marks an action as already filed.
 */
export function jiraKeyOnLine(text: string, projectKey: string): string | null {
  const key = projectKey.replace(/[^A-Z0-9]/g, "");
  if (!key) return null;
  return new RegExp(`\\b${key}-\\d+\\b`).exec(text)?.[0] ?? null;
}
/** At most this many actions are read from one note. */
export const MAX_ACTIONS = 200;
/** DetectedAction.text is cut to this many characters. */
export const ACTION_TEXT_MAX = 500;

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const CHECKBOX = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\](?:\s+(.*))?$/;
const BULLET = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const ACTION_HEADING =
  /^(?:action items?|action points?|actions?|next steps?|to ?dos?|to-dos?|follow ?ups?|follow-ups?|followups?)$/;

/** The body split into lines, with the separators kept so a rebuilt body keeps its line endings. */
export interface BodyLines {
  lines: string[];
  /** seps[i] follows lines[i]; the last line has "". */
  seps: string[];
}

export function splitBody(body: string): BodyLines {
  const parts = body.split(/(\r?\n)/);
  const lines: string[] = [];
  const seps: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i] ?? "");
    seps.push(parts[i + 1] ?? "");
  }
  return { lines, seps };
}

export function joinBody({ lines, seps }: BodyLines): string {
  return lines.map((line, i) => line + (seps[i] ?? "")).join("");
}

/** "## Action items:" -> true. Emphasis, a trailing colon, emoji and a "(...)" note are ignored. */
export function isActionHeading(text: string): boolean {
  const name = text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[*_`~:]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ACTION_HEADING.test(name);
}

function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? 4 : 1;
  return width;
}

/** Stable for the same text on the same line. */
export function actionId(text: string, line: number): string {
  return `act-${createHash("sha256").update(`${line}\n${text}`).digest("hex").slice(0, 16)}`;
}

function capText(text: string): string {
  const chars = [...text];
  return chars.length > ACTION_TEXT_MAX ? `${chars.slice(0, ACTION_TEXT_MAX - 3).join("")}...` : text;
}

/** Every action in a note body, in line order. */
export function detectActions(body: string, projectKey = "AN"): DetectedAction[] {
  const { lines } = splitBody(body);
  const out: DetectedAction[] = [];
  let inFence: string | null = null;
  /** Level of the action heading we are under, or null. */
  let actionLevel: number | null = null;

  for (let i = 0; i < lines.length && out.length < MAX_ACTIONS; i++) {
    const raw = lines[i] ?? "";
    const fence = FENCE.exec(raw);
    if (fence) {
      const mark = fence[1]!;
      if (inFence === null) inFence = mark;
      else if (inFence === mark) inFence = null;
      continue;
    }
    if (inFence !== null) continue;

    const heading = HEADING.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      if (isActionHeading(heading[2] ?? "")) actionLevel = level;
      else if (actionLevel !== null && level <= actionLevel) actionLevel = null;
      continue;
    }

    let text: string | null = null;
    let done = false;
    const box = CHECKBOX.exec(raw);
    if (box) {
      text = (box[3] ?? "").trim();
      done = box[2] !== " ";
    } else if (actionLevel !== null) {
      const bullet = BULLET.exec(raw);
      if (bullet && indentWidth(bullet[1] ?? "") < 2) text = (bullet[2] ?? "").trim();
    }
    // An empty checkbox (the meeting template's "- [ ] ") or a "* * *" rule is not an action.
    if (!text || /^[-*_\s]+$/.test(text)) continue;

    const line = i + 1;
    out.push({
      id: actionId(text, line),
      text: capText(text),
      line,
      done,
      jiraKey: jiraKeyOnLine(text, projectKey),
    });
  }
  return out;
}

/** Actions that still need a Jira issue: not done and not filed. */
export function openActions(actions: readonly DetectedAction[]): DetectedAction[] {
  return actions.filter((a) => !a.done && a.jiraKey === null);
}

/**
 * The note text around an action for the draft prompt: the nearest heading above it plus up to
 * `before` lines before and `after` lines after (blank lines skipped), at most `max` characters.
 */
export function actionContext(body: string, line: number, opts: { before?: number; after?: number; max?: number } = {}): string {
  const { lines } = splitBody(body);
  const before = opts.before ?? 3;
  const after = opts.after ?? 2;
  const max = opts.max ?? 600;
  const index = line - 1;
  let heading = "";
  for (let i = index - 1; i >= 0; i--) {
    if (HEADING.test(lines[i] ?? "")) {
      heading = (lines[i] ?? "").trim();
      break;
    }
  }
  const pick = (from: number, to: number) =>
    lines.slice(Math.max(0, from), Math.max(0, to)).map((l) => l.trim()).filter((l) => l !== "");
  const above = pick(index - before, index);
  const below = pick(index + 1, index + 1 + after);
  const parts = [...(heading && !above.includes(heading) ? [heading] : []), ...above, ">> (this action)", ...below];
  const text = parts.join("\n");
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : text;
}
