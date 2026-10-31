import type {
  DetectedAction,
  JiraCreated,
  JiraCreateResult,
  JiraDraft,
  JiraDraftIssue,
  JiraEpicRef,
  JiraParent,
  JiraStatusChoice,
} from "../../../shared/types";

// Pure helpers behind the Notes "Detected actions" section and the Jira review dialog (T30):
// links to Jira, which actions can still be drafted, the editable copy of an AI draft, grouping its
// Tasks under their epic, the checks that mirror the server's (docs/ARCHITECTURE.md "v1.2", T28), the
// payload sent to POST /api/jira/create, and reading its result back.
//
// Note text and AI output are untrusted: React renders them as text, and a link is only ever built
// for a key matching ^AN-\d+$ on the Jira site the server itself links to.

/** The one Jira project issues are created in (server config JIRA_PROJECT_KEY). */
export const JIRA_PROJECT = "AN";
/** Same default as server/config.ts DEFAULT_JIRA_SITE, used until a server-built link names the site. */
export const DEFAULT_JIRA_SITE = "qicbizdev.atlassian.net";
export const SUMMARY_MIN = 5;
export const SUMMARY_MAX = 120;
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 1500;
export const MAX_ISSUES = 15;
/** The `failed` entry the server adds when the keys could not be written back into the note. */
export const WRITE_BACK_ID = "write-back";

const KEY_RE = /^AN-\d+$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** True for a key of the AN project, e.g. "AN-4602". */
export function isJiraKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

/**
 * Host of the configured Jira site, read from links the server built (snapshot issues, create
 * results): the first https link of the form https://<host>/browse/<KEY-1>. Falls back to the default.
 */
export function jiraSiteFrom(urls: readonly (string | null | undefined)[]): string {
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && HOST_RE.test(u.hostname) && /^\/browse\/[A-Z][A-Z0-9]+-\d+$/.test(u.pathname)) {
        return u.hostname;
      }
    } catch {
      // Not a URL: try the next one.
    }
  }
  return DEFAULT_JIRA_SITE;
}

/** https://<site>/browse/<key>, or null when the key is not an AN key or the site is not a host name. */
export function jiraIssueUrl(key: string | null | undefined, site: string): string | null {
  if (!isJiraKey(key) || !HOST_RE.test(site)) return null;
  return `https://${site}/browse/${key}`;
}

/* Detected actions ------------------------------------------------------------------------------ */

export interface ActionCounts {
  total: number;
  done: number;
  filed: number;
  /** Not done and not filed yet: what a draft would cover. */
  draftable: number;
}

export function actionCounts(actions: readonly DetectedAction[]): ActionCounts {
  let done = 0;
  let filed = 0;
  let draftable = 0;
  for (const a of actions) {
    if (a.done) done += 1;
    if (a.jiraKey) filed += 1;
    if (!a.done && !a.jiraKey) draftable += 1;
  }
  return { total: actions.length, done, filed, draftable };
}

/** Why "Draft Jira tasks with AI" is off, or null when at least one action is open and unfiled. */
export function draftBlockedReason(actions: readonly DetectedAction[]): string | null {
  const c = actionCounts(actions);
  if (c.total === 0) return "No actions in this note to draft.";
  if (c.draftable > 0) return null;
  if (c.filed === c.total) return "Every action is already filed in Jira.";
  return "Every action is already filed in Jira or done.";
}

/* The editable draft ---------------------------------------------------------------------------- */

/** A drafted issue as Islam edits it. Epics have no switch of their own: see activeNewEpicIds. */
export interface ReviewIssue extends JiraDraftIssue {
  include: boolean;
}

export interface ReviewDraft {
  notePath: string;
  epics: JiraEpicRef[];
  issues: ReviewIssue[];
}

/**
 * Statuses an issue can be created in, as the picker lists them (mirrors the server). Epics use
 * another AN workflow and can only start in Backlog or In Progress.
 */
export const STATUS_OPTIONS: Readonly<Record<"Task" | "Epic", readonly { value: JiraStatusChoice; label: string }[]>> = {
  Task: [
    { value: "todo", label: "To Do" },
    { value: "inprogress", label: "In Progress" },
    { value: "onhold", label: "On hold" },
    { value: "done", label: "Done" },
    { value: "backlog", label: "Backlog" },
  ],
  Epic: [
    { value: "backlog", label: "Backlog" },
    { value: "inprogress", label: "In Progress" },
  ],
};

/** The issue's status if its type allows it, else the default: To Do for Tasks, Backlog for Epics. */
export function statusOf(issue: Pick<JiraDraftIssue, "type" | "status">): JiraStatusChoice {
  const allowed = STATUS_OPTIONS[issue.type].map((o) => o.value);
  return issue.status && allowed.includes(issue.status) ? issue.status : issue.type === "Task" ? "todo" : "backlog";
}

export function toReview(draft: JiraDraft): ReviewDraft {
  return {
    notePath: draft.notePath,
    epics: draft.epics.map((e) => ({ key: e.key, summary: e.summary })),
    issues: draft.issues.map((i) => ({ ...i, actionIds: [...i.actionIds], status: statusOf(i), include: true })),
  };
}

export type IssueEdit = Partial<Pick<ReviewIssue, "summary" | "description" | "include" | "parent" | "status">>;

/** A copy of the draft with one issue changed. */
export function editIssue(review: ReviewDraft, draftId: string, edit: IssueEdit): ReviewDraft {
  return { ...review, issues: review.issues.map((i) => (i.draftId === draftId ? { ...i, ...edit } : i)) };
}

/** A copy of the draft with every Task under the new epic `epicId` included or left out. */
export function setEpicTasksIncluded(review: ReviewDraft, epicId: string, include: boolean): ReviewDraft {
  return {
    ...review,
    issues: review.issues.map((i) =>
      i.type === "Task" && i.parent?.kind === "new" && i.parent.draftId === epicId ? { ...i, include } : i,
    ),
  };
}

const tasksOf = (review: ReviewDraft) => review.issues.filter((i) => i.type === "Task");
const newEpicsOf = (review: ReviewDraft) => review.issues.filter((i) => i.type === "Epic");

/** New epics that still have at least one included Task. The others are dropped from the create. */
export function activeNewEpicIds(review: ReviewDraft): Set<string> {
  const ids = new Set<string>();
  const epicIds = new Set(newEpicsOf(review).map((e) => e.draftId));
  for (const t of tasksOf(review)) {
    if (t.include && t.parent?.kind === "new" && epicIds.has(t.parent.draftId)) ids.add(t.parent.draftId);
  }
  return ids;
}

/* Epic picker ----------------------------------------------------------------------------------- */

/** <select> value for a parent: "existing:AN-1", "new:<draftId>" or "none". */
export function parentValue(parent: JiraParent): string {
  if (!parent) return "none";
  return parent.kind === "existing" ? `existing:${parent.key}` : `new:${parent.draftId}`;
}

export function parseParentValue(value: string): JiraParent {
  if (value.startsWith("existing:")) return { kind: "existing", key: value.slice("existing:".length) };
  if (value.startsWith("new:")) return { kind: "new", draftId: value.slice("new:".length) };
  return null;
}

export interface ParentOption {
  value: string;
  label: string;
  group: "existing" | "new" | "none";
}

/** Your open epics from the draft, the new epics in the draft, then No epic. */
export function parentOptions(review: ReviewDraft): ParentOption[] {
  return [
    ...review.epics.map((e) => ({
      value: `existing:${e.key}`,
      label: `${e.key}: ${e.summary.trim() || "Untitled epic"}`,
      group: "existing" as const,
    })),
    ...newEpicsOf(review).map((e) => ({
      value: `new:${e.draftId}`,
      label: `New epic: ${e.summary.trim() || "Untitled"}`,
      group: "new" as const,
    })),
    { value: "none", label: "No epic", group: "none" },
  ];
}

/* Grouping -------------------------------------------------------------------------------------- */

export type EpicGroup =
  | { kind: "existing"; id: string; key: string; summary: string; known: boolean; tasks: ReviewIssue[] }
  | { kind: "new"; id: string; epic: ReviewIssue; tasks: ReviewIssue[]; dropped: boolean }
  | { kind: "none"; id: string; tasks: ReviewIssue[] };

/**
 * The draft's Tasks under their epic, in this order: your existing epics (as the draft listed them),
 * new epics (draft order), then Tasks with no epic. An epic with no Tasks under it is left out; a new
 * epic whose Tasks are all left out stays visible but is `dropped` (it will not be created). A Task
 * pointing at an epic the draft does not know shows under that key with `known: false`, or under No
 * epic for a missing new epic, so the checks can flag it instead of hiding it.
 */
export function groupByEpic(review: ReviewDraft): EpicGroup[] {
  const tasks = tasksOf(review);
  const newEpics = newEpicsOf(review);
  const newIds = new Set(newEpics.map((e) => e.draftId));
  const active = activeNewEpicIds(review);
  const groups: EpicGroup[] = [];

  const existingKeys: string[] = review.epics.map((e) => e.key);
  for (const t of tasks) {
    if (t.parent?.kind === "existing" && !existingKeys.includes(t.parent.key)) existingKeys.push(t.parent.key);
  }
  for (const key of existingKeys) {
    const under = tasks.filter((t) => t.parent?.kind === "existing" && t.parent.key === key);
    if (!under.length) continue;
    const ref = review.epics.find((e) => e.key === key);
    groups.push({ kind: "existing", id: `existing:${key}`, key, summary: ref?.summary ?? "", known: !!ref, tasks: under });
  }

  for (const epic of newEpics) {
    const under = tasks.filter((t) => t.parent?.kind === "new" && t.parent.draftId === epic.draftId);
    if (!under.length) continue;
    groups.push({ kind: "new", id: `new:${epic.draftId}`, epic, tasks: under, dropped: !active.has(epic.draftId) });
  }

  const loose = tasks.filter((t) => !t.parent || (t.parent.kind === "new" && !newIds.has(t.parent.draftId)));
  if (loose.length) groups.push({ kind: "none", id: "none", tasks: loose });
  return groups;
}

/* Counts and payload ---------------------------------------------------------------------------- */

export interface DraftCounts {
  tasks: number;
  epics: number;
}

/** What Create would make: included Tasks and new epics that still have one. */
export function draftCounts(review: ReviewDraft): DraftCounts {
  return { tasks: tasksOf(review).filter((t) => t.include).length, epics: activeNewEpicIds(review).size };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Footer line: "Creates 3 tasks and 1 epic in AN, assigned to you". */
export function countsText(counts: DraftCounts, project: string = JIRA_PROJECT): string {
  if (counts.tasks === 0) return "Nothing to create: include at least one task.";
  const epics = counts.epics > 0 ? ` and ${plural(counts.epics, "epic")}` : "";
  return `Creates ${plural(counts.tasks, "task")}${epics} in ${project}, assigned to you`;
}

function toPayload(i: ReviewIssue): JiraDraftIssue {
  return {
    draftId: i.draftId,
    actionIds: [...i.actionIds],
    type: i.type,
    summary: i.summary.trim(),
    description: i.description.trim(),
    parent: i.type === "Epic" ? null : i.parent,
    status: statusOf(i),
  };
}

/** Body `issues` for POST /api/jira/create: the new epics still in use first, then the included Tasks. */
export function createPayload(review: ReviewDraft): JiraDraftIssue[] {
  const active = activeNewEpicIds(review);
  const epics = newEpicsOf(review).filter((e) => active.has(e.draftId));
  const tasks = tasksOf(review).filter((t) => t.include);
  return [...epics, ...tasks].map(toPayload);
}

/* Checks (mirror the server's) ------------------------------------------------------------------ */

export interface IssueProblems {
  summary?: string;
  description?: string;
  parent?: string;
  actions?: string;
}

export interface ReviewCheck {
  /** Problems by draftId, only for issues that would be sent. */
  issues: Record<string, IssueProblems>;
  /** A problem with the draft as a whole (too many issues, nothing included). */
  form: string | null;
  ok: boolean;
}

function lengthProblem(value: string, min: number, max: number, field: string): string | undefined {
  const n = value.trim().length;
  if (n < min) return `${field} needs at least ${min} characters.`;
  if (n > max) return `${field} is ${n} characters; the most Jira takes here is ${max}.`;
  return undefined;
}

/**
 * The server's draft rules, checked as Islam edits: summary 5 to 120 characters, description 20 to
 * 1500, every Task covers at least one action of the note, an existing parent is one of the draft's
 * epics (an AN key), a new parent is an epic in this draft, and at most 15 issues. `actionIds` is the
 * note's current action ids, or null when they are not known (then only "at least one" is checked).
 */
export function checkReview(review: ReviewDraft, actionIds: ReadonlySet<string> | null): ReviewCheck {
  const issues: Record<string, IssueProblems> = {};
  const payload = createPayload(review);
  const epicKeys = new Set(review.epics.map((e) => e.key));
  const newEpicIds = new Set(newEpicsOf(review).map((e) => e.draftId));

  for (const issue of payload) {
    const p: IssueProblems = {};
    const summary = lengthProblem(issue.summary, SUMMARY_MIN, SUMMARY_MAX, "Summary");
    if (summary) p.summary = summary;
    const description = lengthProblem(issue.description, DESCRIPTION_MIN, DESCRIPTION_MAX, "Description");
    if (description) p.description = description;
    if (issue.type === "Task") {
      if (issue.actionIds.length === 0) p.actions = "Covers no action from the note.";
      else if (actionIds && issue.actionIds.some((id) => !actionIds.has(id))) {
        p.actions = "An action it covers is no longer in the note. Draft again to pick up the change.";
      }
      const parent = issue.parent;
      if (parent?.kind === "existing" && !(isJiraKey(parent.key) && epicKeys.has(parent.key))) {
        p.parent = "That epic isn't one of your open epics. Pick another epic or No epic.";
      }
      if (parent?.kind === "new" && !newEpicIds.has(parent.draftId)) {
        p.parent = "That new epic isn't in this draft any more. Pick another epic or No epic.";
      }
    }
    if (Object.keys(p).length) issues[issue.draftId] = p;
  }

  const counts = draftCounts(review);
  let form: string | null = null;
  if (counts.tasks === 0) form = "Include at least one task to create.";
  else if (payload.length > MAX_ISSUES) {
    form = `That is ${payload.length} issues; one run creates at most ${MAX_ISSUES}. Leave out ${payload.length - MAX_ISSUES}.`;
  }
  return { issues, form, ok: form === null && Object.keys(issues).length === 0 };
}

/* Create result --------------------------------------------------------------------------------- */

export interface CreatedRow extends JiraCreated {
  summary: string;
}

export interface FailedRow {
  draftId: string;
  summary: string;
  error: string;
}

export interface CreateOutcome {
  created: CreatedRow[];
  failed: FailedRow[];
  /** Keys made in Jira that did not reach the note, as a sentence; null when every key was written back. */
  writeBack: string | null;
}

/** True when `body` holds `key` as a whole key (AN-12 is not found inside AN-123). */
export function bodyHasKey(body: string, key: string): boolean {
  if (!isJiraKey(key)) return false;
  return new RegExp(`(^|[^A-Za-z0-9-])${key}(?![0-9])`).test(body);
}

/**
 * Reads a create result for display. Summaries come from the reviewed draft. The write-back warning
 * is the server's own "write-back" entry when it sent one; otherwise, when the re-read note `body` is
 * known, any created Task key missing from it gives the same sentence.
 */
export function readCreateResult(result: JiraCreateResult, review: ReviewDraft, body: string | null): CreateOutcome {
  const summaryOf = (id: string) => review.issues.find((i) => i.draftId === id)?.summary.trim() ?? "";
  const created = result.created
    .filter((c) => isJiraKey(c.key))
    .map((c) => ({ ...c, summary: summaryOf(c.draftId) }));
  const failed = result.failed
    .filter((f) => f.draftId !== WRITE_BACK_ID)
    .map((f) => ({ draftId: f.draftId, summary: summaryOf(f.draftId), error: f.error }));

  let writeBack = result.failed.find((f) => f.draftId === WRITE_BACK_ID)?.error ?? null;
  if (!writeBack && body !== null) {
    const missing = created.filter((c) => c.type === "Task" && !bodyHasKey(body, c.key)).map((c) => c.key);
    if (missing.length) writeBack = `Created in Jira, but the note changed; add the keys by hand: ${missing.join(", ")}`;
  }
  return { created, failed, writeBack };
}

/** One line for the section once a create finished: "Created 3 issues in Jira; 1 failed." */
export function outcomeText(outcome: CreateOutcome): string {
  const made = outcome.created.length;
  const failed = outcome.failed.length;
  if (made === 0 && failed === 0) return "Nothing was created in Jira.";
  if (made === 0) return `Nothing was created in Jira; ${plural(failed, "issue")} failed.`;
  return `Created ${plural(made, "issue")} in Jira${failed ? `; ${failed} failed` : ""}.`;
}

/* Errors ---------------------------------------------------------------------------------------- */

export type JiraErrorKind = "not_ready" | "sign_in" | "busy" | "invalid" | "offline" | "failed";

/**
 * What a failed /api/jira call means: 501 the server part is not built yet, 503 the Atlassian
 * connector or the claude CLI is not signed in, 409 a draft or create is already running, 400 bad or
 * stale input (the message says which), status 0 offline, anything else a failed run.
 */
export function jiraErrorKind(status: number, offline: boolean): JiraErrorKind {
  if (offline) return "offline";
  if (status === 501) return "not_ready";
  if (status === 503) return "sign_in";
  if (status === 409) return "busy";
  if (status === 400) return "invalid";
  return "failed";
}

/** "1 min 05 s" style elapsed time for a running AI step. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
