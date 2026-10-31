import { HTTPException } from "hono/http-exception";
import type {
  CalendarEvent,
  NewTaskInput,
  Note,
  NoteMeta,
  ScheduleDay,
  ScheduleRange,
  SourceState,
  TaskInfo,
  TaskNote,
  TaskPatch,
} from "../shared/types";
import { checkProjectId, checkTitle, isTaskPath, TASKS_SECTION, type NotePatch, type NotesStore } from "./notes";
import { isTaskDate, isTaskMinutes, isTaskTime, MAX_TASK_MINUTES } from "./notesFrontmatter";

// Schedule (docs/ARCHITECTURE.md "v1.2", ticket T27): task notes plus meetings, per day.
//
// - A task is a note under the Tasks section (notes/Tasks/<slug>.md). The notes store reads its
//   task_* keys into `task` and writes them; this module validates request bodies and builds the
//   ScheduleRange. Task titles and details are Islam's own text; they are stored, never run.
// - Days are Asia/Qatar days (UTC+3, no DST), the same clock the connector calendar window uses.
//   An event belongs to the day its start falls on there; an all-day event (start YYYY-MM-DD) to
//   that date. A task belongs to its task_due date.

export const MAX_RANGE_DAYS = 14;
export const MAX_DETAILS_CHARS = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;
const QATAR_OFFSET_MS = 3 * 60 * 60 * 1000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const badRequest = (message: string) => new HTTPException(400, { message });

// ---------- Asia/Qatar dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
/** A Date whose UTC fields are Qatar wall time. */
const qatarWall = (d: Date) => new Date(d.getTime() + QATAR_OFFSET_MS);

/** YYYY-MM-DD in Asia/Qatar. */
export function qatarDateKey(d: Date): string {
  const q = qatarWall(d);
  return `${q.getUTCFullYear()}-${pad(q.getUTCMonth() + 1)}-${pad(q.getUTCDate())}`;
}

/** HH:MM in Asia/Qatar. */
export function qatarTime(d: Date): string {
  const q = qatarWall(d);
  return `${pad(q.getUTCHours())}:${pad(q.getUTCMinutes())}`;
}

function utcOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** `dateKey` plus `days` calendar days. */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(utcOf(dateKey) + days * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Weekday name of a date ("Sunday"). */
export function weekdayName(dateKey: string): string {
  return WEEKDAYS[new Date(utcOf(dateKey)).getUTCDay()]!;
}

/** Islam's workdays: Sunday to Thursday. */
export function isWorkday(dateKey: string): boolean {
  const day = new Date(utcOf(dateKey)).getUTCDay();
  return day >= 0 && day <= 4;
}

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The Qatar day an event starts on, or null when its start is not a date. */
export function eventDay(start: string): string | null {
  if (isTaskDate(start)) return start;
  const ms = Date.parse(start);
  return Number.isFinite(ms) ? qatarDateKey(new Date(ms)) : null;
}

// ---------- request validation ----------

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Body must be a JSON object");
  return value as Record<string, unknown>;
}

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD`: real dates, in order, at most 14 days. Throws 400. */
export function parseRangeQuery(from: unknown, to: unknown): { from: string; to: string } {
  if (!isTaskDate(from) || !isTaskDate(to)) throw badRequest("Add ?from= and ?to= as dates written YYYY-MM-DD");
  if (from > to) throw badRequest("from must be on or before to");
  const days = Math.round((utcOf(to) - utcOf(from)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw badRequest(`The range can span at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

function dueOf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isTaskDate(value)) throw badRequest("due must be a date written YYYY-MM-DD, or null");
  return value;
}

function startOf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isTaskTime(value)) throw badRequest("start must be a time written HH:MM (00:00 to 23:59), or null");
  return value;
}

function minutesOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!isTaskMinutes(value)) throw badRequest(`minutes must be a whole number from 1 to ${MAX_TASK_MINUTES}, or null`);
  return value;
}

function detailsOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest("details must be text");
  const text = value.replace(/\r\n?/g, "\n").trim();
  if ([...text].length > MAX_DETAILS_CHARS) throw badRequest(`details can be at most ${MAX_DETAILS_CHARS} characters`);
  return text === "" ? undefined : text;
}

/** Validates a POST /api/schedule/tasks body. Missing nullable fields read as null. Throws 400. */
export function parseNewTaskInput(value: unknown): NewTaskInput {
  const o = asObject(value);
  const input: NewTaskInput = {
    title: checkTitle(o.title),
    projectId: o.projectId === undefined ? null : checkProjectId(o.projectId),
    due: dueOf(o.due),
    start: startOf(o.start),
    minutes: minutesOf(o.minutes),
  };
  const details = detailsOf(o.details);
  if (details !== undefined) input.details = details;
  return input;
}

/** Validates a PATCH /api/schedule/tasks body: only the given fields, at least one. Throws 400. */
export function parseTaskPatch(value: unknown): TaskPatch {
  const o = asObject(value);
  const patch: TaskPatch = {};
  if (o.title !== undefined) patch.title = checkTitle(o.title);
  if (o.projectId !== undefined) patch.projectId = checkProjectId(o.projectId);
  if (o.due !== undefined) patch.due = dueOf(o.due);
  if (o.start !== undefined) patch.start = startOf(o.start);
  if (o.minutes !== undefined) patch.minutes = minutesOf(o.minutes);
  if (o.done !== undefined) {
    if (typeof o.done !== "boolean") throw badRequest("done must be true or false");
    patch.done = o.done;
  }
  if (Object.keys(patch).length === 0) throw badRequest("Send at least one of title, projectId, due, start, minutes, done");
  return patch;
}

// ---------- task notes ----------

/** True when a NoteMeta carries task fields (the notes store adds them under the Tasks section). */
export function isTaskNote(meta: NoteMeta): meta is TaskNote {
  const task = (meta as Partial<TaskNote>).task;
  return typeof task === "object" && task !== null;
}

/** Every task note in a list of notes. */
export function taskNotes(notes: readonly NoteMeta[]): TaskNote[] {
  return notes.filter(isTaskNote);
}

/** The TaskNote of a note the store returned: metadata plus task, without the body. */
function toTaskNote(note: Note): TaskNote {
  if (!isTaskNote(note)) throw new Error("The notes store returned a task without task fields");
  const { body: _body, ...meta } = note;
  return meta;
}

/** Writes notes/Tasks/<slug>.md (Tasks created on first use, slug made unique). Body: `# title` then details. */
export async function createTask(notes: NotesStore, input: NewTaskInput, source: TaskInfo["source"]): Promise<TaskNote> {
  const body = input.details ? `# ${input.title}\n\n${input.details}\n` : `# ${input.title}\n`;
  const note = await notes.create(
    { section: TASKS_SECTION, title: input.title, body, projectId: input.projectId },
    {
      task: { due: input.due, start: input.start, minutes: input.minutes, done: false, source },
      naming: "slug",
      ensureSection: true,
    },
  );
  return toTaskNote(note);
}

/** Changes only the given fields of the task note at `path`. A new title also renames the first heading. */
export async function patchTask(notes: NotesStore, path: string, patch: TaskPatch): Promise<TaskNote> {
  if (!isTaskPath(path)) throw badRequest(`Only notes in the ${TASKS_SECTION} section are tasks`);
  const notePatch: NotePatch = {};
  if (patch.title !== undefined) notePatch.title = patch.title;
  if (patch.projectId !== undefined) notePatch.projectId = patch.projectId;
  const task: Partial<TaskInfo> = {};
  if (patch.due !== undefined) task.due = patch.due;
  if (patch.start !== undefined) task.start = patch.start;
  if (patch.minutes !== undefined) task.minutes = patch.minutes;
  if (patch.done !== undefined) task.done = patch.done;
  return toTaskNote(await notes.update(path, notePatch, { task, heading: true }));
}

// ---------- the range ----------

const isAllDay = (e: CalendarEvent) => isTaskDate(e.start);

function byEventStart(a: CalendarEvent, b: CalendarEvent): number {
  if (isAllDay(a) !== isAllDay(b)) return isAllDay(a) ? -1 : 1;
  return Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title);
}

/** Start time first (no start last), then title, then path. */
export function byTaskStart(a: TaskNote, b: TaskNote): number {
  const sa = a.task.start;
  const sb = b.task.start;
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sa < sb ? -1 : 1;
  }
  return a.title.localeCompare(b.title) || a.path.localeCompare(b.path);
}

export interface RangeInput {
  from: string;
  to: string;
  /** Calendar events from the connector cache (snapshot.calendar). */
  events: readonly CalendarEvent[];
  /** Every task note. */
  tasks: readonly TaskNote[];
  /** The calendar source state (snapshot.sources.calendar). */
  calendar: Pick<SourceState, "status" | "message">;
}

/** Pure: the ScheduleRange for `from`..`to` (validated by parseRangeQuery). */
export function buildScheduleRange(input: RangeInput): ScheduleRange {
  const days = new Map<string, ScheduleDay>();
  for (const date of datesBetween(input.from, input.to)) days.set(date, { date, events: [], tasks: [] });
  for (const event of input.events) {
    const day = eventDay(event.start);
    if (day !== null) days.get(day)?.events.push(event);
  }
  for (const task of input.tasks) {
    if (task.task.due !== null) days.get(task.task.due)?.tasks.push(task);
  }
  for (const day of days.values()) {
    day.events.sort(byEventStart);
    day.tasks.sort(byTaskStart);
  }
  const open = input.tasks.filter((t) => !t.task.done);
  const unscheduled = open
    .filter((t) => t.task.due === null)
    .sort((a, b) => a.created.localeCompare(b.created) || a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
  const overdue = open
    .filter((t) => t.task.due !== null && t.task.due < input.from)
    .sort((a, b) => a.task.due!.localeCompare(b.task.due!) || byTaskStart(a, b));
  const calendar: ScheduleRange["calendar"] = { status: input.calendar.status };
  if (input.calendar.message) calendar.message = input.calendar.message;
  return { from: input.from, to: input.to, days: [...days.values()], unscheduled, overdue, calendar };
}
