// The contract between server and web, copied exactly from docs/ARCHITECTURE.md
// (v1 "The contract" plus v1.1 "Contract additions"). Only T01 and T15 may change this file.

export type SourceStatus = "ok" | "error" | "not_connected" | "stale" | "never_run";
export interface SourceState { status: SourceStatus; updatedAt: string | null; message?: string }

export type Area = "work" | "learning" | "personal" | "calendar" | "email";
export type Urgency = "red" | "amber";

export interface NeedsYouItem {
  id: string; area: Area; urgency: Urgency;
  title: string;            // "PR #42 waiting for your review"
  detail: string;           // "FastBind, opened 2 days ago"
  url?: string; dueAt?: string;
}

export interface JiraIssue { key: string; summary: string; status: string; statusCategory: "todo" | "inprogress" | "done";
  priority: string; dueDate: string | null; updated: string; project: string; url: string; blocked: boolean }
export interface PullRequest { repo: string; number: number; title: string; url: string; author: string;
  role: "author" | "reviewer"; createdAt: string; isDraft: boolean; checks: "pass" | "fail" | "pending" | "none" }
export interface CiRun { repo: string; branch: string; status: "pass" | "fail" | "pending"; url: string; at: string }
export interface RepoActivity { repo: string; commitsByDay: Record<string, number> } // YYYY-MM-DD -> count, last 365 days
export interface SessionTime { project: string; minutesByDay: Record<string, number> }  // last 365 days

export interface LearningState {
  streak: { current: number; best: number; started: string | null };
  cycle: { concept: string; steps: { label: string; done: boolean }[] } | null;
  agendaThisMonth: { text: string; done: boolean }[];
}

export interface Checkin { date: string; sleepHours: number; energy: 1|2|3|4|5; mood: 1|2|3|4|5;
  workoutMinutes: number; spendQar: number; note?: string }

export interface CalendarEvent { id: string; title: string; start: string; end: string; url?: string }
export interface EmailItem { id: string; from: string; subject: string; receivedAt: string; url?: string }

export interface Snapshot {
  generatedAt: string;
  sources: Record<"github" | "jira" | "claudeSessions" | "learning" | "checkins" | "calendar" | "email", SourceState>;
  needsYou: NeedsYouItem[];   // capped at 8
  needsYouTotal: number;       // full count, for "+N more"
  work: { jira: JiraIssue[]; prs: PullRequest[]; ci: CiRun[]; repoActivity: RepoActivity[]; sessionTime: SessionTime[] };
  learning: LearningState;
  personal: { checkins: Checkin[]; checkedInToday: boolean };
  calendar: CalendarEvent[];
  email: EmailItem[];
  projects: ProjectsState;
  notes: { recent: NoteMeta[]; status: SourceStatus; message?: string };   // recent: last 14 days, max 30
}

export interface NextMove { id: string; title: string; reason: string; area: Area;
  rank: number; sourceUrl?: string; state: "open" | "done" | "dismissed" }
export interface NextMovesFile { generatedAt: string | null; status: "ok" | "error" | "not_logged_in" | "running" | "never_run";
  message?: string; moves: NextMove[] }

/** Every API error response body. */
export interface ApiError { error: string }

// v1.1: project tracker and notes (docs/ARCHITECTURE.md "Contract additions").

export type ProjectArea = "work" | "learning" | "personal";
export type ProjectStatus = "active" | "paused" | "done" | "idea";
export interface ProjectTask { id: string; text: string; done: boolean; due: string | null; doneAt: string | null; createdAt: string }
export interface Project {
  id: string;                 // slug, stable
  name: string; area: ProjectArea; status: ProjectStatus;
  deadline: string | null;    // YYYY-MM-DD
  description: string; goals: string[]; tasks: ProjectTask[];
  sources: { sessions: string[]; repos: string[] };  // auto-detected names folded into this project
  createdAt: string; updatedAt: string;
}
export interface ProjectsFile { projects: Project[]; hidden: string[] }   // hidden = auto-detected names the user removed
export interface ProjectStats { id: string; minutesByDay: Record<string, number>; commitsByDay: Record<string, number>;
  openTasks: number; doneTasks: number; noteCount: number; lastNoteAt: string | null }
export interface DetectedProject { name: string; kind: "session" | "repo"; minutes7d: number; commits30d: number; lastSeen: string | null }
export interface ProjectsState { projects: Project[]; stats: ProjectStats[]; untracked: DetectedProject[]; hidden: string[] }

export interface NoteMeta { path: string; section: string; title: string; created: string; updated: string;
  projectId: string | null; tags: string[]; excerpt: string; openActions: number }   // openActions = unchecked "- [ ]" lines
export interface Note extends NoteMeta { body: string }
export interface NoteSection { path: string; name: string; children: NoteSection[]; noteCount: number }
export interface NotesIndex { status: SourceStatus; message?: string; dir: string; sections: NoteSection[]; notes: NoteMeta[] }  // dir = absolute notes folder, shown so the files can be found in Obsidian
export type NoteTemplate = "blank" | "meeting" | "personal";

// v1.2: schedule, task notes, note actions and Jira drafts (docs/ARCHITECTURE.md "v1.2").
// A task is a note in the "Tasks" section whose frontmatter carries the task fields below.
export interface TaskInfo { due: string | null;   // YYYY-MM-DD, null = no day yet
  start: string | null;                            // HH:MM local, null = any time that day
  minutes: number | null;                          // planned length
  done: boolean; source: "me" | "ai" }
export interface TaskNote extends NoteMeta { task: TaskInfo }
export interface ScheduleDay { date: string; events: CalendarEvent[]; tasks: TaskNote[] }   // date YYYY-MM-DD, local
export interface ScheduleRange { from: string; to: string; days: ScheduleDay[];
  unscheduled: TaskNote[];                         // open tasks with no due date
  overdue: TaskNote[];                             // open tasks due before `from`
  calendar: { status: SourceStatus; message?: string } }
export interface NewTaskInput { title: string; projectId: string | null; due: string | null; start: string | null;
  minutes: number | null; details?: string }
export interface TaskPatch { title?: string; projectId?: string | null; due?: string | null; start?: string | null;
  minutes?: number | null; done?: boolean }
export interface PlanItem { id: string; title: string; projectId: string | null; date: string;
  start: string;                                   // v1.3: always set; the server places items the model left untimed
  minutes: number; reason: string;
  taskPath: string | null }                        // v1.3: an existing task to move; null = a new task
export interface SchedulePlan { status: "none" | "ready" | "error"; scope: "day" | "week" | null;
  from: string | null;                             // v1.3: first planned date (the day the panel showed)
  generatedAt: string | null; message?: string; items: PlanItem[] }
export interface PlanRequest { scope: "day" | "week"; date: string }   // v1.3: date = the day the panel shows, YYYY-MM-DD

// v1.3: Do now (Home, bottom right): the tasks that need doing now, each with AI how-to steps.
export type FocusReason = "now" | "next" | "overdue" | "today";   // in this block / later today / past due / today, no time
export interface FocusItem { task: TaskNote; reason: FocusReason;
  label: string;                                   // "Now until 15:30", "Next at 16:00", "Overdue since Thu 29 Oct", "Today, no time set"
  projectName: string | null; jiraKey: string | null;
  steps: string[] | null;                          // null = not generated yet
  stepsStatus: "ready" | "pending" | "error"; stepsMessage?: string }
export interface FocusState { generatedAt: string; items: FocusItem[] }   // at most 6, most urgent first

export interface DetectedAction { id: string; text: string; line: number;   // line = 1-based line in the note body
  done: boolean; jiraKey: string | null }                                     // jiraKey = an AN-123 already on the line
export interface JiraEpicRef { key: string; summary: string }
export type JiraParent = { kind: "existing"; key: string } | { kind: "new"; draftId: string } | null;
export interface JiraDraftIssue { draftId: string; actionIds: string[]; type: "Task" | "Epic";
  summary: string; description: string; parent: JiraParent;    // Tasks only: an existing epic of mine, or a new Epic in this draft
  status?: JiraStatusChoice }   // v1.3: status at creation. Tasks: any; Epics: backlog or inprogress. Missing: Task todo, Epic backlog
export type JiraStatusChoice = "backlog" | "todo" | "inprogress" | "onhold" | "done";
export interface JiraDraft { notePath: string; createdAt: string; epics: JiraEpicRef[]; issues: JiraDraftIssue[] }
export interface JiraCreated { draftId: string; key: string; url: string; type: "Task" | "Epic" }
export interface JiraCreateResult { created: JiraCreated[]; failed: { draftId: string; error: string }[] }
