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
