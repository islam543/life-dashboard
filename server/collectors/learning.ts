import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LearningState } from "../../shared/types";
import { localDateKey } from "../checkinValidate";
import type { Collector } from "./types";

/**
 * Learning collector. Reads two Markdown files in LEARNING_DIR, read-only:
 * - Daily.md: the streak line (`**Current: N** · Best: M · Started: YYYY-MM-DD`), the
 *   `**Concept:**` line and the checkbox steps under the "Current cycle" heading.
 * - Daily.md "Life Agenda" table: one agenda item per row whose first cell is `[ ]` or `[x]`.
 * - Agenda/YYYY-MM.md for the current local month, only when that table is missing: every checkbox line.
 *
 * Missing Daily.md gives `not_connected` with the expected path. Format drift gives a partial
 * parse: status `ok` with what was found and a message naming what was not.
 * Tolerates CRLF, a UTF-8 BOM and emoji in headings. Checkboxes inside code fences are ignored.
 */

type Streak = LearningState["streak"];
type Cycle = NonNullable<LearningState["cycle"]>;
type AgendaItem = LearningState["agendaThisMonth"][number];

export interface DailyParse {
  streak: Streak;
  cycle: LearningState["cycle"];
  /** Rows of the "Life Agenda" table, or null when Daily.md has no such table (then Agenda/YYYY-MM.md is used). */
  agenda: AgendaItem[] | null;
  /** Parts of Daily.md that were not found, in plain words. Empty when the parse is complete. */
  missing: string[];
}

interface MdLine {
  text: string;
  inFence: boolean;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s+(.*))?$/;
const CURRENT = /\bCurrent\s*:\s*(?:\*\*|__)?\s*(\d+)/i;
const BEST = /\bBest\s*:\s*(?:\*\*|__)?\s*(\d+)/i;
const STARTED = /\bStarted\s*:\s*(?:\*\*|__)?\s*(\d{4}-\d{2}-\d{2})/i;
const CONCEPT = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*Concept\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
/** "Inference mechanics -> `wiki/...md`": the name is the part before the arrow. */
const ARROW = /\s*(?:\u2192|\u27F6|->)\s*/;
/** What ends a step label written without bold: a spaced em dash, en dash or hyphen, or ": ". */
const LABEL_END = /\s+[\u2014\u2013-]\s+|\s*:\s+/;

export function emptyLearning(): LearningState {
  return { streak: { current: 0, best: 0, started: null }, cycle: null, agendaThisMonth: [] };
}

/** Splits on any line ending, drops a BOM and marks lines inside ``` or ~~~ fences. */
function toLines(text: string): MdLine[] {
  const lines: MdLine[] = [];
  let fence: string | null = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const marker = FENCE.exec(raw);
    if (marker) {
      const char = marker[1].charAt(0);
      if (fence === null) fence = char;
      else if (fence === char) fence = null;
      lines.push({ text: raw, inFence: true });
      continue;
    }
    lines.push({ text: raw, inFence: fence !== null });
  }
  return lines;
}

function headingOf(line: MdLine): { level: number; text: string } | null {
  if (line.inFence) return null;
  const match = HEADING.exec(line.text);
  return match ? { level: match[1].length, text: match[2] } : null;
}

/** Letters and digits only, lowercase, so a heading like "## (emoji) Current Cycle:" reads as "current cycle". */
function headingKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Lines under the first heading whose key contains `name`, up to the next heading of the same or a higher level. */
function section(lines: MdLine[], name: string): MdLine[] | null {
  const start = lines.findIndex((line) => {
    const h = headingOf(line);
    return h !== null && headingKey(h.text).includes(name);
  });
  if (start < 0) return null;
  const level = headingOf(lines[start])!.level;
  const body: MdLine[] = [];
  for (const line of lines.slice(start + 1)) {
    const h = headingOf(line);
    if (h && h.level <= level) break;
    body.push(line);
  }
  return body;
}

/** Strips the Markdown that matters for display: wiki links, links, bold, italic, inline code. */
export function plainText(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => target.split("/").pop() ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function checkbox(line: MdLine): { done: boolean; body: string } | null {
  if (line.inFence) return null;
  const match = CHECKBOX.exec(line.text);
  return match ? { done: match[1] !== " ", body: match[2] ?? "" } : null;
}

/** "**1. READ** - text" gives "READ". Without bold, the text before the first separator. */
function stepLabel(body: string): string {
  const bold = /(\*\*|__)(.+?)\1/.exec(body);
  const raw = bold ? plainText(bold[2]) : (plainText(body).split(LABEL_END)[0] ?? "");
  return raw.replace(/^\d+\s*[.)]\s*/, "").replace(/[\s:.]+$/, "").trim();
}

function conceptName(value: string): string {
  const beforeArrow = plainText(value.split(ARROW)[0] ?? "");
  return beforeArrow !== "" ? beforeArrow : plainText(value);
}

function parseStreak(lines: MdLine[], missing: string[]): Streak {
  for (const line of lines) {
    if (line.inFence) continue;
    const current = CURRENT.exec(line.text);
    if (!current) continue;
    const best = BEST.exec(line.text);
    const started = STARTED.exec(line.text);
    if (!best) missing.push("best streak");
    if (!started) missing.push("streak start date");
    const value = Number(current[1]);
    return { current: value, best: best ? Number(best[1]) : value, started: started ? started[1] : null };
  }
  missing.push("streak line");
  return { current: 0, best: 0, started: null };
}

function parseCycle(lines: MdLine[], missing: string[]): LearningState["cycle"] {
  const body = section(lines, "current cycle");
  if (body === null) {
    missing.push("Current cycle heading");
    return null;
  }
  let concept: string | null = null;
  const steps: Cycle["steps"] = [];
  for (const line of body) {
    if (line.inFence) continue;
    const box = checkbox(line);
    if (box) {
      const label = stepLabel(box.body);
      if (label !== "") steps.push({ label, done: box.done });
      continue;
    }
    if (concept === null) {
      const match = CONCEPT.exec(line.text);
      if (match) concept = conceptName(match[1]);
    }
  }
  if (concept === null) missing.push("Concept line");
  if (steps.length === 0) missing.push("cycle steps");
  if (concept === null && steps.length === 0) return null;
  return { concept: concept ?? "", steps };
}

/** Table cells of a `| a | b |` line, trimmed. Escaped pipes (`\|`) stay inside their cell. */
function tableCells(line: MdLine): string[] | null {
  if (line.inFence) return null;
  const trimmed = line.text.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed.replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * Rows of the table under the "Life Agenda" heading whose first cell is `[ ]` or `[x]`.
 * Text is the Task (second) cell with `**` removed and whitespace collapsed, so a
 * "(due YYYY-MM-DD ...)" note stays. Header and separator rows have no checkbox and are skipped.
 * Null when there is no such heading or no checkbox row under it.
 */
function parseLifeAgenda(lines: MdLine[]): AgendaItem[] | null {
  const body = section(lines, "life agenda");
  if (body === null) return null;
  const items: AgendaItem[] = [];
  for (const line of body) {
    const cells = tableCells(line);
    if (!cells || cells.length < 2) continue;
    const box = /^\[([ xX])\]$/.exec(cells[0]);
    if (!box) continue;
    const text = cells[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (text !== "") items.push({ text, done: box[1] !== " " });
  }
  return items.length > 0 ? items : null;
}

/** Pure parse of Daily.md. Never throws; whatever is not found is listed in `missing`. */
export function parseDaily(text: string): DailyParse {
  const lines = toLines(text);
  const missing: string[] = [];
  const streak = parseStreak(lines, missing);
  const cycle = parseCycle(lines, missing);
  const agenda = parseLifeAgenda(lines);
  return { streak, cycle, agenda, missing };
}

/** Pure parse of an Agenda/YYYY-MM.md file: every checkbox line outside code fences. */
export function parseAgenda(text: string): AgendaItem[] {
  const items: AgendaItem[] = [];
  for (const line of toLines(text)) {
    const box = checkbox(line);
    if (!box) continue;
    const itemText = plainText(box.body);
    if (itemText !== "") items.push({ text: itemText, done: box.done });
  }
  return items;
}

/** "Agenda/2026-10.md" (with the platform separator) for the local month of `now`. */
export function agendaFileFor(now: Date): string {
  return path.join("Agenda", `${localDateKey(now).slice(0, 7)}.md`);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

/** File text, or null when the file or its folder does not exist. Other failures throw. */
async function readOptional(file: string, signal: AbortSignal): Promise<string | null> {
  try {
    return await readFile(file, { encoding: "utf8", signal });
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ABORT_ERR") throw err;
    throw new Error(`Could not read ${path.basename(file)} (${code ?? "unknown error"})`);
  }
}

export const learningCollector: Collector<"learning"> = {
  key: "learning",
  async collect(ctx) {
    const dir = ctx.config.learningDir;
    const dailyPath = path.join(dir, "Daily.md");
    const dailyText = await readOptional(dailyPath, ctx.signal);
    if (dailyText === null) {
      return {
        status: "not_connected",
        message: `Daily.md not found at ${dailyPath}. Set LEARNING_DIR in .env to the folder that holds it.`,
        data: { learning: emptyLearning() },
      };
    }

    const { streak, cycle, agenda, missing } = parseDaily(dailyText);
    const notes: string[] = [];
    if (missing.length > 0) notes.push(`Daily.md: no ${missing.join(", no ")} found`);

    // The Life Agenda table in Daily.md is the real agenda; the monthly file is only a fallback.
    let agendaThisMonth: AgendaItem[] = agenda ?? [];
    if (agenda === null) {
      const agendaName = agendaFileFor(ctx.now);
      const agendaPath = path.join(dir, agendaName);
      const agendaText = await readOptional(agendaPath, ctx.signal);
      if (agendaText === null) {
        notes.push(`No Life Agenda table in Daily.md and no agenda file at ${agendaPath}`);
      } else {
        agendaThisMonth = parseAgenda(agendaText);
        if (agendaThisMonth.length === 0) {
          notes.push(`No Life Agenda table in Daily.md and no checkbox items in ${agendaName.replace(/\\/g, "/")}`);
        }
      }
    }

    return {
      status: "ok",
      ...(notes.length > 0 ? { message: notes.join(". ") } : {}),
      data: { learning: { streak, cycle, agendaThisMonth } },
    };
  },
};
