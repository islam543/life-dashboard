import type { FocusReason, Project, TaskNote } from "../shared/types";
import { byTaskStart, qatarDateKey, qatarTime } from "./schedule";
import { DEFAULT_ITEM_MINUTES, fromMinutes, toMinutes } from "./schedulePlacer";

// Do now selection (docs/ARCHITECTURE.md "v1.3", ticket T31). Pure: the clock is an argument.
//
// From the open task notes, in this order and at most MAX_FOCUS_ITEMS:
// 1. "now":     due today, timed, and now falls inside its block ("Now until 15:30")
// 2. "next":    due today, starting later today ("Next at 16:00")
// 3. "overdue": due before today, oldest first ("Overdue since Thu 29 Oct"), then blocks today
//               that already ended ("Overdue since 09:30")
// 4. "today":   due today with no time ("Today, no time set")
// Undated tasks and tasks due later are not listed. Days and times are Asia/Qatar.

export const MAX_FOCUS_ITEMS = 6;
/** The first Jira key of the AN project in a text. */
const JIRA_KEY = /\bAN-\d+\b/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface FocusPick {
  task: TaskNote;
  reason: FocusReason;
  label: string;
}

/** "2026-10-29" -> "Thu 29 Oct". */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!));
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

/** The first `AN-123` in the title, else in the body, else null. */
export function jiraKeyOf(title: string, body: string): string | null {
  return JIRA_KEY.exec(title)?.[0] ?? JIRA_KEY.exec(body)?.[0] ?? null;
}

/** The registry name of the task's project, or null. */
export function projectNameOf(projects: readonly Project[], projectId: string | null): string | null {
  if (projectId === null) return null;
  return projects.find((p) => p.id === projectId)?.name ?? null;
}

const blockEnd = (t: TaskNote) => toMinutes(t.task.start!) + (t.task.minutes ?? DEFAULT_ITEM_MINUTES);

/** The Do now picks for `now`, most urgent first. */
export function pickFocus(tasks: readonly TaskNote[], now: Date): FocusPick[] {
  const today = qatarDateKey(now);
  const minute = toMinutes(qatarTime(now));
  const open = tasks.filter((t) => !t.task.done && t.task.due !== null && t.task.due <= today);
  const timedToday = open.filter((t) => t.task.due === today && t.task.start !== null).sort(byTaskStart);

  const current = timedToday
    .filter((t) => toMinutes(t.task.start!) <= minute && minute < blockEnd(t))
    .map((task): FocusPick => ({ task, reason: "now", label: `Now until ${fromMinutes(blockEnd(task))}` }));
  const next = timedToday
    .filter((t) => toMinutes(t.task.start!) > minute)
    .map((task): FocusPick => ({ task, reason: "next", label: `Next at ${task.task.start}` }));
  const pastDays = open
    .filter((t) => t.task.due! < today)
    .sort((a, b) => a.task.due!.localeCompare(b.task.due!) || byTaskStart(a, b))
    .map((task): FocusPick => ({ task, reason: "overdue", label: `Overdue since ${shortDate(task.task.due!)}` }));
  const missedToday = timedToday
    .filter((t) => blockEnd(t) <= minute)
    .map((task): FocusPick => ({ task, reason: "overdue", label: `Overdue since ${fromMinutes(blockEnd(task))}` }));
  const untimed = open
    .filter((t) => t.task.due === today && t.task.start === null)
    .sort((a, b) => a.created.localeCompare(b.created) || byTaskStart(a, b))
    .map((task): FocusPick => ({ task, reason: "today", label: "Today, no time set" }));

  return [...current, ...next, ...pastDays, ...missedToday, ...untimed].slice(0, MAX_FOCUS_ITEMS);
}
