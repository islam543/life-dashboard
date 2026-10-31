import type {
  DetectedProject,
  NoteMeta,
  Project,
  ProjectArea,
  ProjectsState,
  ProjectStats,
  ProjectStatus,
  ProjectTask,
} from "../../../shared/types";
import { dayKey, formatMinutes, plural } from "./format";
import { addDays, parseDayKey, shortDay, startOfDay, weekDayKeys } from "./timeAgg";

// The project tracker's pure model: board grouping and sort, deadline countdowns, task progress,
// per-project time, curation helpers for untracked names and the new-project form rules.
// No React, no DOM: unit tested in projects.test.ts. Every function that depends on "now" takes it.

/** Validation limits, same as the server (docs/ARCHITECTURE.md "API additions"). */
export const LIMITS = {
  name: 80,
  description: 2000,
  goals: 10,
  goal: 200,
  task: 300,
} as const;

export const STATUS_ORDER: readonly ProjectStatus[] = ["active", "paused", "idea", "done"];
export const AREA_ORDER: readonly ProjectArea[] = ["work", "learning", "personal"];

/** The status as a value ("Idea") and as a board group heading ("Ideas"). */
export const STATUS_LABEL: Record<ProjectStatus, string> = { active: "Active", paused: "Paused", idea: "Idea", done: "Done" };
export const STATUS_GROUP_LABEL: Record<ProjectStatus, string> = { active: "Active", paused: "Paused", idea: "Ideas", done: "Done" };
export const AREA_LABEL: Record<ProjectArea, string> = { work: "Work", learning: "Learning", personal: "Personal" };

export type AreaFilter = "all" | ProjectArea;
export const AREA_FILTERS: readonly AreaFilter[] = ["all", "work", "learning", "personal"];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Deadlines

export type DeadlineTone = "danger" | "warn" | "calm";

export interface DeadlineInfo {
  /** Whole local days from today to the deadline: 0 today, 1 tomorrow, negative when passed. */
  days: number;
  /** "Due today", "Due tomorrow", "Due in 5 days", "Due 12 Dec", "2 days overdue". */
  label: string;
  /** danger under 3 days (and overdue), warn within the week, calm otherwise. Only active projects get a tone. */
  tone: DeadlineTone;
  overdue: boolean;
}

/** Whole local days from `now` to a "YYYY-MM-DD" key. NaN for a bad key. */
export function daysUntil(key: string, now: Date): number {
  const date = parseDayKey(key);
  if (!date) return Number.NaN;
  return Math.round((date.getTime() - startOfDay(now).getTime()) / DAY_MS);
}

function dateLabel(key: string, now: Date): string {
  const date = parseDayKey(key);
  if (!date) return key;
  return date.getFullYear() === now.getFullYear() ? shortDay(date) : `${shortDay(date)} ${date.getFullYear()}`;
}

/** Countdown for a project deadline. Null when there is none or it is unreadable. */
export function deadlineInfo(deadline: string | null, now: Date, status: ProjectStatus = "active"): DeadlineInfo | null {
  if (!deadline) return null;
  const days = daysUntil(deadline, now);
  if (!Number.isFinite(days)) return null;
  if (status === "done") return { days, label: `Deadline ${dateLabel(deadline, now)}`, tone: "calm", overdue: false };
  const overdue = days < 0;
  const label = overdue
    ? `${plural(-days, "day")} overdue`
    : days === 0
      ? "Due today"
      : days === 1
        ? "Due tomorrow"
        : days <= 13
          ? `Due in ${days} days`
          : `Due ${dateLabel(deadline, now)}`;
  const tone: DeadlineTone = status !== "active" ? "calm" : days < 3 ? "danger" : days < 7 ? "warn" : "calm";
  return { days, label, tone, overdue };
}

/** Countdown for a task due date, same words as a deadline but shorter: "Today", "Tomorrow", "In 4 days", "3 days late". */
export function taskDueInfo(due: string | null, now: Date, done = false): { label: string; tone: DeadlineTone } | null {
  if (!due) return null;
  const days = daysUntil(due, now);
  if (!Number.isFinite(days)) return null;
  if (done) return { label: dateLabel(due, now), tone: "calm" };
  const label =
    days < 0 ? `${plural(-days, "day")} late` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : days <= 6 ? `In ${days} days` : dateLabel(due, now);
  const tone: DeadlineTone = days <= 0 ? "danger" : days <= 2 ? "warn" : "calm";
  return { label, tone };
}

// ---------------------------------------------------------------------------------------------
// Tasks

export interface TaskProgress {
  done: number;
  total: number;
  /** 0 to 1; 0 when there are no tasks. */
  fraction: number;
  /** "No tasks yet", "3 of 8 tasks done", "All 8 tasks done". */
  label: string;
}

export function taskProgress(tasks: readonly Pick<ProjectTask, "done">[]): TaskProgress {
  const total = tasks.length;
  const done = tasks.filter((t) => t.done).length;
  const fraction = total > 0 ? done / total : 0;
  const label =
    total === 0 ? "No tasks yet" : done === total ? `All ${plural(total, "task")} done` : `${done} of ${plural(total, "task")} done`;
  return { done, total, fraction, label };
}

/**
 * Open tasks first, by due date (overdue first, no date last), then by creation; done tasks after,
 * most recently ticked first.
 */
export function sortTasks(tasks: readonly ProjectTask[]): ProjectTask[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.doneAt ?? "").localeCompare(a.doneAt ?? "") || a.createdAt.localeCompare(b.createdAt);
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

// ---------------------------------------------------------------------------------------------
// Time

function clean(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Sum of a by-day record over this week, Sunday to Saturday (the same week as the time bars). */
export function weekTotal(byDay: Readonly<Record<string, number>> | undefined, now: Date): number {
  if (!byDay) return 0;
  return weekDayKeys(now).reduce((sum, k) => sum + clean(byDay[k]), 0);
}

/** The last `days` days of a by-day record, oldest first, ending today. Missing days are 0. */
export function dailySeries(byDay: Readonly<Record<string, number>> | undefined, now: Date, days = 14): number[] {
  const today = startOfDay(now);
  return Array.from({ length: days }, (_, i) => clean(byDay?.[dayKey(addDays(today, i - days + 1))]));
}

// ---------------------------------------------------------------------------------------------
// Board

export interface ProjectCardModel {
  project: Project;
  stats: ProjectStats | null;
  /** Minutes this week (Sunday to Saturday). */
  weekMinutes: number;
  /** Minutes per day, last 14 days, oldest first. */
  series: number[];
  deadline: DeadlineInfo | null;
  progress: TaskProgress;
  /** Unchecked "- [ ]" lines across linked notes; null when notes could not be read. */
  openActions: number | null;
  noteCount: number;
  lastNoteAt: string | null;
}

/** Note metadata by linked project id. */
export function notesByProject(notes: readonly NoteMeta[] | null): Map<string, NoteMeta[]> {
  const out = new Map<string, NoteMeta[]>();
  for (const n of notes ?? []) {
    if (!n?.projectId) continue;
    const list = out.get(n.projectId) ?? [];
    list.push(n);
    out.set(n.projectId, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.updated.localeCompare(a.updated));
  return out;
}

export function buildCards(state: ProjectsState, notes: readonly NoteMeta[] | null, now: Date): ProjectCardModel[] {
  const statsById = new Map(state.stats.map((s) => [s.id, s]));
  const linked = notesByProject(notes);
  return state.projects.map((project) => {
    const stats = statsById.get(project.id) ?? null;
    const projectNotes = linked.get(project.id) ?? [];
    return {
      project,
      stats,
      weekMinutes: weekTotal(stats?.minutesByDay, now),
      series: dailySeries(stats?.minutesByDay, now),
      deadline: deadlineInfo(project.deadline, now, project.status),
      progress: taskProgress(project.tasks),
      openActions: notes === null ? null : projectNotes.reduce((sum, n) => sum + Math.max(0, n.openActions || 0), 0),
      noteCount: stats?.noteCount ?? projectNotes.length,
      lastNoteAt: stats?.lastNoteAt ?? projectNotes[0]?.updated ?? null,
    };
  });
}

/** A deadline close enough to lead the Active group: overdue or within two weeks. */
const LEADING_DEADLINE_DAYS = 14;

const byName = (a: Project, b: Project) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/**
 * Order inside a status group.
 *   active: deadlines that are overdue or within 2 weeks first (soonest first), then most time this
 *           week, then name.
 *   paused, idea: most recently changed first.
 *   done: most recently changed first.
 */
export function compareCards(a: ProjectCardModel, b: ProjectCardModel): number {
  if (a.project.status === "active" && b.project.status === "active") {
    const da = a.deadline && a.deadline.days <= LEADING_DEADLINE_DAYS ? a.deadline.days : null;
    const db = b.deadline && b.deadline.days <= LEADING_DEADLINE_DAYS ? b.deadline.days : null;
    if (da !== null || db !== null) {
      if (da === null) return 1;
      if (db === null) return -1;
      if (da !== db) return da - db;
    }
    return b.weekMinutes - a.weekMinutes || byName(a.project, b.project);
  }
  return b.project.updatedAt.localeCompare(a.project.updatedAt) || byName(a.project, b.project);
}

export interface StatusGroup {
  status: ProjectStatus;
  label: string;
  cards: ProjectCardModel[];
}

/** The four status groups in board order, filtered by area, each sorted. Empty groups are kept. */
export function groupCards(cards: readonly ProjectCardModel[], area: AreaFilter = "all"): StatusGroup[] {
  const shown = area === "all" ? cards : cards.filter((c) => c.project.area === area);
  return STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_GROUP_LABEL[status],
    cards: shown.filter((c) => c.project.status === status).sort(compareCards),
  }));
}

export function areaCounts(projects: readonly Pick<Project, "area">[]): Record<AreaFilter, number> {
  const counts: Record<AreaFilter, number> = { all: projects.length, work: 0, learning: 0, personal: 0 };
  for (const p of projects) if (p.area in counts) counts[p.area] += 1;
  return counts;
}

export interface BoardSummary {
  active: number;
  /** Active projects with a deadline in the next 7 days or overdue. */
  dueSoon: number;
  overdue: number;
  openTasks: number;
  /** Minutes this week across shown projects. */
  weekMinutes: number;
}

export function boardSummary(cards: readonly ProjectCardModel[]): BoardSummary {
  const active = cards.filter((c) => c.project.status === "active");
  return {
    active: active.length,
    dueSoon: active.filter((c) => c.deadline && c.deadline.days < 7).length,
    overdue: active.filter((c) => c.deadline?.overdue).length,
    openTasks: cards.filter((c) => c.project.status !== "done").reduce((s, c) => s + c.progress.total - c.progress.done, 0),
    weekMinutes: cards.reduce((s, c) => s + c.weekMinutes, 0),
  };
}

/** Accessible one-line summary of a card, read as the card link's description. */
export function cardDescription(card: ProjectCardModel): string {
  const parts = [`${AREA_LABEL[card.project.area]} project, ${STATUS_LABEL[card.project.status].toLowerCase()}`];
  if (card.deadline) parts.push(card.deadline.label);
  parts.push(card.progress.label);
  parts.push(card.weekMinutes > 0 ? `${formatMinutes(card.weekMinutes)} this week` : "No time this week");
  if (card.openActions) parts.push(`${plural(card.openActions, "open action")} in notes`);
  return `${parts.join(". ")}.`;
}

// ---------------------------------------------------------------------------------------------
// Sources and untracked names

/** "islam543/QIC-FastBind" -> "QIC-FastBind"; session names stay as they are. */
export function displayName(name: string): string {
  const parts = String(name ?? "").trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? String(name ?? "").trim();
}

/** Merge key: the last path segment, lower case. Same rule as the life map's projectKey. */
export function nameKey(name: string): string {
  return displayName(name).toLowerCase();
}

/** The project's sources with one detected name added under its kind. No duplicates. */
export function withSource(sources: Project["sources"], d: Pick<DetectedProject, "name" | "kind">): Project["sources"] {
  const sessions = [...sources.sessions];
  const repos = [...sources.repos];
  const list = d.kind === "session" ? sessions : repos;
  if (!list.includes(d.name)) list.push(d.name);
  return { sessions, repos };
}

/** The project's sources without one name. */
export function withoutSource(sources: Project["sources"], kind: DetectedProject["kind"], name: string): Project["sources"] {
  return {
    sessions: kind === "session" ? sources.sessions.filter((s) => s !== name) : [...sources.sessions],
    repos: kind === "repo" ? sources.repos.filter((r) => r !== name) : [...sources.repos],
  };
}

export function sourceCount(sources: Project["sources"]): number {
  return sources.sessions.length + sources.repos.length;
}

/** Body for "Track": a new active work project named after the detected name, with it as the only source. */
export function trackInput(d: Pick<DetectedProject, "name" | "kind">): {
  name: string;
  area: ProjectArea;
  status: ProjectStatus;
  sources: Project["sources"];
} {
  return {
    name: displayName(d.name).slice(0, LIMITS.name),
    area: "work",
    status: "active",
    sources: withSource({ sessions: [], repos: [] }, d),
  };
}

/**
 * Projects to offer for "Add to project", the likely match first: a project whose name or one of
 * whose sources has the same merge key ("islam543/QIC-FastBind" suggests the project "QIC-FastBind").
 * Then active, paused, idea and done, each by name.
 */
export function rankProjectsFor(name: string, projects: readonly Project[]): { project: Project; suggested: boolean }[] {
  const key = nameKey(name);
  const matches = (p: Project) =>
    nameKey(p.name) === key || p.sources.sessions.some((s) => nameKey(s) === key) || p.sources.repos.some((r) => nameKey(r) === key);
  return projects
    .map((project) => ({ project, suggested: key !== "" && matches(project) }))
    .sort(
      (a, b) =>
        Number(b.suggested) - Number(a.suggested) ||
        STATUS_ORDER.indexOf(a.project.status) - STATUS_ORDER.indexOf(b.project.status) ||
        byName(a.project, b.project),
    );
}

/** Case-insensitive "contains" for picker filters. An empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return q === "" || text.toLocaleLowerCase().includes(q);
}

/**
 * "today", "yesterday", "12 days ago" for a "YYYY-MM-DD" day (a detected name's lastSeen), counted in
 * local days so a day key is never read as UTC midnight. Full ISO times use relative wording too.
 */
export function seenText(value: string | null, now: Date): string {
  if (!value) return "never";
  const days = parseDayKey(value) ? -daysUntil(value, now) : Math.floor((now.getTime() - Date.parse(value)) / DAY_MS);
  if (!Number.isFinite(days)) return "at an unknown time";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** "12h this week, 4 commits in 30 days" style facts for one untracked name. */
export function detectedFacts(d: DetectedProject): string {
  const parts: string[] = [];
  if (d.minutes7d > 0) parts.push(`${formatMinutes(d.minutes7d)} in 7 days`);
  if (d.commits30d > 0) parts.push(`${plural(d.commits30d, "commit")} in 30 days`);
  return parts.length > 0 ? parts.join(", ") : "No recent activity";
}

// ---------------------------------------------------------------------------------------------
// New project form

export interface ProjectFormValues {
  name: string;
  area: ProjectArea;
  status: ProjectStatus;
  /** "YYYY-MM-DD" or "". */
  deadline: string;
  description: string;
  /** Untracked names to fold in. */
  sources: Pick<DetectedProject, "name" | "kind">[];
}

export type ProjectFormField = "name" | "deadline" | "description";
export type ProjectFormErrors = Partial<Record<ProjectFormField, string>>;

export function emptyProjectForm(): ProjectFormValues {
  return { name: "", area: "work", status: "active", deadline: "", description: "", sources: [] };
}

/** Field errors in the server's limits, worded as what to do. Empty object when valid. */
export function validateProjectForm(v: ProjectFormValues): ProjectFormErrors {
  const errors: ProjectFormErrors = {};
  const name = v.name.trim();
  if (name === "") errors.name = "Enter a project name.";
  else if ([...name].length > LIMITS.name) errors.name = `Name must be ${LIMITS.name} characters or fewer.`;
  if (v.deadline !== "" && !parseDayKey(v.deadline)) errors.deadline = "Enter a real date, or leave the deadline empty.";
  if ([...v.description].length > LIMITS.description) errors.description = `Description must be ${LIMITS.description} characters or fewer.`;
  return errors;
}

/** The POST /api/projects body for valid form values. */
export function projectInputFrom(v: ProjectFormValues): {
  name: string;
  area: ProjectArea;
  status: ProjectStatus;
  deadline: string | null;
  description: string;
  sources: Project["sources"];
} {
  let sources: Project["sources"] = { sessions: [], repos: [] };
  for (const s of v.sources) sources = withSource(sources, s);
  return {
    name: v.name.trim(),
    area: v.area,
    status: v.status,
    deadline: v.deadline === "" ? null : v.deadline,
    description: v.description.trim(),
    sources,
  };
}

/** The project in `next` that was not in `prev` (the one a create added), or null. */
export function addedProject(prev: readonly Pick<Project, "id">[], next: readonly Project[]): Project | null {
  const known = new Set(prev.map((p) => p.id));
  return next.find((p) => !known.has(p.id)) ?? null;
}

/** "QIC-FastBind meeting, 30 Oct": title for a new meeting note, within the 120-character note title limit. */
export function meetingNoteTitle(projectName: string, now: Date): string {
  const suffix = ` meeting, ${shortDay(now)}`;
  const room = 120 - suffix.length;
  const chars = [...projectName.trim()];
  const name = chars.length > room ? `${chars.slice(0, room - 1).join("").trimEnd()}…` : chars.join("");
  return `${name}${suffix}`;
}
