import type {
  Area,
  CalendarEvent,
  CiRun,
  JiraIssue,
  NeedsYouItem,
  NoteMeta,
  Project,
  ProjectTask,
  PullRequest,
  Snapshot,
  SourceState,
  SourceStatus,
  Urgency,
} from "../shared/types";

// The "Needs you" rule engine (T06). Rules come from docs/ARCHITECTURE.md "Needs-you rules".
// server/snapshot.ts calls computeNeedsYou after every collect and on every GET /api/snapshot
// (with the request time as `now`). Both exports are pure: no I/O, no Date.now(), and they
// never throw on empty or partial data. All local-time logic uses Date methods on `now`,
// so it follows the system time zone.

/** Most items the strip shows. */
export const NEEDS_YOU_CAP = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const JIRA_RED_WITHIN = 24 * HOUR; // overdue or due within 24 h
const JIRA_AMBER_WITHIN = 72 * HOUR; // due within 72 h
const REVIEW_AMBER_AFTER = 24 * HOUR; // open more than 24 h
const REVIEW_RED_AFTER = 72 * HOUR; // open more than 72 h
const CI_WINDOW = 30 * DAY; // "this month": the same 30-day window the github collector uses
const CALENDAR_WITHIN = 2 * HOUR;
const CHECKIN_FROM_HOUR = 20;
const LEARNING_FROM_HOUR = 18;
const WORKDAYS = new Set([0, 1, 2, 3, 4]); // Sunday to Thursday
// v1.1 (docs/ARCHITECTURE.md "Needs-you additions")
const TASK_RED_WITHIN = 24 * HOUR; // open task of an active project, overdue or due within 24 h
const TASK_AMBER_WITHIN = 72 * HOUR; // open task of an active project due within 72 h
const DEADLINE_AMBER_WITHIN = 3 * DAY; // active project deadline within 3 days (red once passed)
const NOTE_ACTIONS_AFTER = 2 * DAY; // open "- [ ]" items in a meeting note older than 2 days
const MEETING_SECTION = "meeting notes"; // section path prefix, compared without case
const TEXT_IN_TITLE = 80;

/** Ranked items (red first, then by due time, then title), at most NEEDS_YOU_CAP. */
export function computeNeedsYou(snapshot: Snapshot, now: Date): NeedsYouItem[] {
  return allItems(snapshot, now).slice(0, NEEDS_YOU_CAP);
}

/** Full number of items before the cap, for the "+N more" link. */
export function countNeedsYou(snapshot: Snapshot, now: Date): number {
  return allItems(snapshot, now).length;
}

function allItems(snapshot: Snapshot, now: Date): NeedsYouItem[] {
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!snapshot || !Number.isFinite(t)) return [];

  const byId = new Map<string, NeedsYouItem>();
  const add = (next: NeedsYouItem | null): void => {
    if (!next) return;
    const existing = byId.get(next.id);
    // The same id twice (duplicate rows): keep one item at the higher urgency.
    if (!existing || (existing.urgency === "amber" && next.urgency === "red")) byId.set(next.id, next);
  };

  const sources = snapshot.sources;
  if (hasData(sources?.jira)) for (const issue of list(snapshot.work?.jira)) add(jiraItem(issue, t));
  if (hasData(sources?.github)) {
    for (const pr of prItems(list(snapshot.work?.prs), t)) add(pr);
    for (const run of ciItems(list(snapshot.work?.ci), t)) add(run);
  }
  if (hasData(sources?.calendar)) for (const event of list(snapshot.calendar)) add(calendarItem(event, t));
  add(checkinItem(snapshot, now));
  add(learningItem(snapshot, now));

  const projects = list(snapshot.projects?.projects);
  for (const project of projects) {
    if (!project?.id || project.status !== "active") continue;
    for (const task of list(project.tasks)) add(taskItem(project, task, t));
    add(deadlineItem(project, t));
  }
  if (hasNotes(snapshot.notes?.status)) for (const note of list(snapshot.notes?.recent)) add(noteItem(note, projects, t));

  return [...byId.values()].sort(compareItems);
}

// ---- rules ----

/** Red when overdue or due within 24 h, amber when due within 72 h or blocked. */
function jiraItem(issue: JiraIssue, t: number): NeedsYouItem | null {
  if (!issue?.key || issue.statusCategory === "done") return null;
  const due = parseDue(issue.dueDate);
  const left = due === null ? Number.POSITIVE_INFINITY : due - t;
  const summary = issue.summary || issue.key;
  const blocked = issue.blocked === true ? ", blocked" : "";
  const base = { id: `jira:${issue.key}`, area: "work" as const, url: issue.url,
    dueAt: due === null ? undefined : new Date(due).toISOString() };

  if (left < 0) {
    return item({ ...base, urgency: "red", title: `${issue.key} is overdue`, detail: `${summary}, was due ${span(-left)} ago${blocked}` });
  }
  if (left <= JIRA_RED_WITHIN) return item({ ...base, urgency: "red", title: `${issue.key} due in ${span(left)}`, detail: summary + blocked });
  if (left <= JIRA_AMBER_WITHIN) return item({ ...base, urgency: "amber", title: `${issue.key} due in ${span(left)}`, detail: summary + blocked });
  if (issue.blocked === true) {
    return item({ ...base, urgency: "amber", title: `${issue.key} is blocked`, detail: issue.status ? `${summary}, status ${issue.status}` : summary });
  }
  return null;
}

/**
 * Review requests open over 24 h and my PRs with failing checks; one item per PR (rows for the same PR merge).
 * Drafts never count: they are still being written, so neither a review nor a failing check needs you yet.
 */
function prItems(prs: PullRequest[], t: number): NeedsYouItem[] {
  const groups = new Map<string, { pr: PullRequest; failing: boolean; reviewing: boolean }>();
  for (const pr of prs) {
    if (!pr?.repo || typeof pr.number !== "number" || pr.isDraft === true) continue;
    const id = `pr:${pr.repo}#${pr.number}`;
    const group = groups.get(id) ?? { pr, failing: false, reviewing: false };
    if (pr.role === "author" && pr.checks === "fail") group.failing = true;
    if (pr.role === "reviewer") group.reviewing = true;
    groups.set(id, group);
  }

  const out: NeedsYouItem[] = [];
  for (const [id, { pr, failing, reviewing }] of groups) {
    const age = t - Date.parse(pr.createdAt);
    const review: Urgency | null =
      reviewing && age > REVIEW_AMBER_AFTER ? (age > REVIEW_RED_AFTER ? "red" : "amber") : null;
    if (!failing && review === null) continue;

    const title = failing && review
      ? `PR #${pr.number} has failing checks and is waiting for your review`
      : failing
        ? `PR #${pr.number} has failing checks`
        : `PR #${pr.number} waiting for your review`;
    const repo = repoName(pr.repo);
    out.push(item({ id, area: "work", urgency: failing ? "red" : (review ?? "amber"), title,
      detail: Number.isFinite(age) ? `${repo}, opened ${span(age)} ago` : repo, url: pr.url }));
  }
  return out;
}

/** Latest run per repo; amber when it failed within the last 30 days. */
function ciItems(runs: CiRun[], t: number): NeedsYouItem[] {
  const latest = new Map<string, { run: CiRun; at: number }>();
  for (const run of runs) {
    if (!run?.repo) continue;
    const at = Date.parse(run.at);
    if (!Number.isFinite(at)) continue;
    const prev = latest.get(run.repo);
    if (!prev || at > prev.at) latest.set(run.repo, { run, at });
  }

  const out: NeedsYouItem[] = [];
  for (const { run, at } of latest.values()) {
    if (run.status !== "fail" || t - at > CI_WINDOW) continue;
    const branch = run.branch ? `${run.branch} branch` : "Default branch";
    out.push(item({ id: `ci:${run.repo}`, area: "work", urgency: "amber",
      title: `CI failing on ${repoName(run.repo)}`, detail: `${branch}, failed ${span(t - at)} ago`, url: run.url }));
  }
  return out;
}

/** Red when a timed event starts within the next 2 h. All-day events (date only) have no start time and are skipped. */
function calendarItem(event: CalendarEvent, t: number): NeedsYouItem | null {
  if (!event?.id || typeof event.start !== "string" || isDateOnly(event.start)) return null;
  const start = Date.parse(event.start);
  if (!Number.isFinite(start)) return null;
  const left = start - t;
  if (left < 0 || left > CALENDAR_WITHIN) return null;

  const name = event.title || "Event";
  const end = Date.parse(event.end);
  const when = Number.isFinite(end) ? `${clock(start)} to ${clock(end)}` : `starts ${clock(start)}`;
  return item({ id: `cal:${event.id}`, area: "calendar", urgency: "red",
    title: left < MINUTE ? `${name} starts now` : `${name} starts in ${span(left)}`,
    detail: `Calendar, ${when}`, url: event.url, dueAt: new Date(start).toISOString() });
}

/** Amber from 20:00 local when today has no check-in. */
function checkinItem(snapshot: Snapshot, now: Date): NeedsYouItem | null {
  if (!isOk(snapshot.sources?.checkins) || now.getHours() < CHECKIN_FROM_HOUR) return null;
  const today = dayKey(now);
  const personal = snapshot.personal;
  const checkedIn = personal?.checkedInToday === true || list(personal?.checkins).some((c) => c?.date === today);
  if (checkedIn) return null;
  return item({ id: `checkin:${today}`, area: "personal", urgency: "amber", title: "No check-in yet today",
    detail: "30 seconds: sleep, energy, mood, workout, spend", dueAt: endOfDay(now).toISOString() });
}

/** Amber from 18:00 local on a workday (Sunday to Thursday) while the current cycle has an undone step. */
function learningItem(snapshot: Snapshot, now: Date): NeedsYouItem | null {
  if (!isOk(snapshot.sources?.learning)) return null;
  if (!WORKDAYS.has(now.getDay()) || now.getHours() < LEARNING_FROM_HOUR) return null;
  const learning = snapshot.learning;
  const next = list(learning?.cycle?.steps).find((s) => s && s.done !== true);
  if (!next) return null;

  const current = learning.streak?.current;
  const days = typeof current === "number" && Number.isFinite(current) ? current : 0;
  const concept = learning.cycle?.concept;
  const step = next.label || "next step";
  return item({ id: `learning:${dayKey(now)}`, area: "learning", urgency: "amber",
    title: `Learning streak at risk (${plural(days, "day")})`,
    detail: concept ? `${concept}, next step: ${step}` : `Next step: ${step}`, dueAt: endOfDay(now).toISOString() });
}

/** Open task of an active project: red when overdue or due within 24 h, amber within 72 h. */
function taskItem(project: Project, task: ProjectTask, t: number): NeedsYouItem | null {
  if (!task?.id || task.done === true) return null;
  const due = parseDue(task.due);
  if (due === null) return null;
  const left = due - t;
  if (left > TASK_AMBER_WITHIN) return null;
  const text = shorten(task.text || "Task", TEXT_IN_TITLE);
  const name = project.name || project.id;
  const base = { id: `task:${project.id}:${task.id}`, area: projectArea(project), url: projectUrl(project.id),
    dueAt: new Date(due).toISOString() };
  if (left < 0) return item({ ...base, urgency: "red", title: `Task overdue: ${text}`, detail: `${name}, was due ${span(-left)} ago` });
  return item({ ...base, urgency: left <= TASK_RED_WITHIN ? "red" : "amber", title: `Task due in ${span(left)}: ${text}`, detail: name });
}

/** Active project deadline (end of that local day): red once passed, amber within 3 days. */
function deadlineItem(project: Project, t: number): NeedsYouItem | null {
  const due = parseDue(project.deadline);
  if (due === null) return null;
  const left = due - t;
  if (left > DEADLINE_AMBER_WITHIN) return null;
  const name = shorten(project.name || project.id, TEXT_IN_TITLE);
  const open = list(project.tasks).filter((task) => task && task.done !== true).length;
  const tasks = open > 0 ? `, ${plural(open, "open task")}` : "";
  const base = { id: `deadline:${project.id}`, area: projectArea(project), url: projectUrl(project.id),
    dueAt: new Date(due).toISOString() };
  if (left < 0) {
    return item({ ...base, urgency: "red", title: `${name} deadline passed`, detail: `Was due ${span(-left)} ago${tasks}` });
  }
  return item({ ...base, urgency: "amber", title: `${name} deadline in ${span(left)}`, detail: `Due ${dayKey(new Date(due))}${tasks}` });
}

/** Amber, one per note: unchecked action items in a meeting note written more than 2 days ago. */
function noteItem(note: NoteMeta, projects: Project[], t: number): NeedsYouItem | null {
  if (typeof note?.path !== "string" || note.path === "") return null;
  if (typeof note.section !== "string" || !note.section.toLowerCase().startsWith(MEETING_SECTION)) return null;
  const open = typeof note.openActions === "number" && Number.isFinite(note.openActions) ? Math.floor(note.openActions) : 0;
  if (open <= 0) return null;
  const created = Date.parse(note.created);
  const written = Number.isFinite(created) ? created : Date.parse(note.updated);
  if (!Number.isFinite(written) || t - written <= NOTE_ACTIONS_AFTER) return null;

  const project = note.projectId ? projects.find((p) => p?.id === note.projectId) : undefined;
  const where = project ? project.name || project.id : note.section;
  return item({ id: `note:${note.path}`, area: project ? projectArea(project) : "personal", urgency: "amber",
    title: `${plural(open, "open action item")} in ${shorten(note.title || note.path, TEXT_IN_TITLE)}`,
    detail: `${where}, written ${span(t - written)} ago`, url: `#/notes/${encodeURIComponent(note.path)}` });
}

// ---- sorting ----

/** Red first, then by due time (none last), then title, then id so the order is stable. */
function compareItems(a: NeedsYouItem, b: NeedsYouItem): number {
  if (a.urgency !== b.urgency) return a.urgency === "red" ? -1 : 1;
  const da = dueTime(a);
  const db = dueTime(b);
  if (da !== db) return da < db ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function dueTime(entry: NeedsYouItem): number {
  const ms = entry.dueAt ? Date.parse(entry.dueAt) : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

// ---- helpers ----

/** Sources that are not connected (or never ran) contribute nothing. Error and stale keep their last good data. */
function hasData(state: SourceState | undefined): boolean {
  return state?.status === "ok" || state?.status === "stale" || state?.status === "error";
}

/** Rules that fire on something missing need fresh data, or they raise false alarms. */
function isOk(state: SourceState | undefined): boolean {
  return state?.status === "ok";
}

/** Notes keep their last good list on error, like the other sources. */
function hasNotes(status: SourceStatus | undefined): boolean {
  return status === "ok" || status === "stale" || status === "error";
}

function projectArea(project: Project): Area {
  return project.area === "work" || project.area === "learning" || project.area === "personal" ? project.area : "work";
}

/** The web app's route for a project (docs/ARCHITECTURE.md "Web additions"). */
function projectUrl(id: string): string {
  return `#/projects/${encodeURIComponent(id)}`;
}

/** One line, at most `max` characters ("..." when cut). */
function shorten(text: string, max: number): string {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** Builds the item without empty optional fields. */
function item(fields: NeedsYouItem): NeedsYouItem {
  const out: NeedsYouItem = { id: fields.id, area: fields.area, urgency: fields.urgency, title: fields.title, detail: fields.detail };
  if (fields.url) out.url = fields.url;
  if (fields.dueAt) out.dueAt = fields.dueAt;
  return out;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Due moment in ms. A date without a time means the end of that local day. */
function parseDue(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value === "") return null;
  if (isDateOnly(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const end = new Date(y, m - 1, d, 23, 59, 59, 999);
    return end.getMonth() === m - 1 && end.getDate() === d ? end.getTime() : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function endOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "45 minutes", "5 hours", "2 days" (rounded down, at least 1 minute). */
function span(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < HOUR) return plural(Math.max(1, Math.floor(abs / MINUTE)), "minute");
  if (abs < DAY) return plural(Math.floor(abs / HOUR), "hour");
  return plural(Math.floor(abs / DAY), "day");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "islam543/fastbind" becomes "fastbind". */
function repoName(repo: string): string {
  const parts = repo.split("/");
  return parts[parts.length - 1] || repo;
}
