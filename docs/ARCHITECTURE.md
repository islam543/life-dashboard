# Life dashboard: architecture (v1)

Read `PLAN.md` first for the why. This file is the how. Every ticket builds against this.

## Shape

One local app. A Node server collects data into JSON files and serves an API plus the built web app. A React app renders it. Nothing listens on anything except `127.0.0.1`.

```
life-dashboard/
  PLAN.md                 product thinking (do not edit in tickets)
  docs/ARCHITECTURE.md    this file
  docs/WORKFLOW.md        the user's job, read before any UI work
  shared/types.ts         THE contract between server and web. Change only in T1.
  server/
    index.ts              Hono app on 127.0.0.1:4317, serves /api/* and web/dist
    store.ts              read/write JSON in data/, atomic write (tmp file + rename)
    scheduler.ts          runs collectors on start and every 30 min, next-moves every 3 h
    config.ts             loads .env, paths (HOME, LEARNING_DIR, CLAUDE_PROJECTS_DIR)
    collectors/
      github.ts           gh CLI
      jira.ts             Jira Cloud REST
      claudeSessions.ts   ~/.claude/projects/*/*.jsonl
      learning.ts         MD Files/Learning/Daily.md and Agenda/YYYY-MM.md
      checkins.ts         data/checkins.json
      calendar.ts         stub, status not_connected
      email.ts            stub, status not_connected
    needsYou.ts           rule engine over the snapshot
    ai/nextMoves.ts       runs `claude -p`, validates JSON, writes data/next-moves.json
    *.test.ts             vitest, next to the file
  web/                    Vite + React 18 + TypeScript
    src/styles/tokens.css design tokens (dark navy sci-fi)
    src/api.ts            typed fetch helpers using shared/types.ts
    src/...               components
  data/                   gitignored runtime JSON
  .env / .env.example     gitignored / committed
```

## Stack (fixed, do not swap)

- Node 24, TypeScript, `tsx` to run the server in dev, `hono` + `@hono/node-server`.
- Web: Vite, React 18, TypeScript, `motion` (Framer Motion) for transitions, `d3` (scales, shapes, force) for charts drawn as SVG. No chart library, no Tailwind, no UI kit.
- Fonts bundled with `@fontsource` (works offline): Space Grotesk for UI, JetBrains Mono for numbers.
- Tests: `vitest` for server logic.
- Scripts in root `package.json`: `dev` (server + vite together via `concurrently`), `build`, `start` (built server serving web/dist), `test`, `collect` (run all collectors once and exit), `typecheck`.

## Security rules

- Bind `127.0.0.1` only. No CORS for other origins.
- Run `gh`, `git` and `claude` with `execFile`/`spawn` and argument arrays, never a shell string.
- Secrets only from `.env` (`JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_SITE`). Never log them, never send them to the web app.
- Check-in POST bodies are validated (types and ranges) before saving.
- QIC data stays in `data/` on this PC. The only thing that leaves is the snapshot sent to Claude in `claude -p`, which is the same channel as normal Claude Code use.

## The contract (`shared/types.ts`)

```ts
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
}

export interface NextMove { id: string; title: string; reason: string; area: Area;
  rank: number; sourceUrl?: string; state: "open" | "done" | "dismissed" }
export interface NextMovesFile { generatedAt: string | null; status: "ok" | "error" | "not_logged_in" | "running" | "never_run";
  message?: string; moves: NextMove[] }
```

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/snapshot` | | `Snapshot` |
| POST | `/api/refresh` | | `Snapshot` after running all collectors |
| GET | `/api/next-moves` | | `NextMovesFile` |
| POST | `/api/next-moves/run` | | `202` and status `running`; poll GET |
| POST | `/api/next-moves/:id` | `{ state: "done" \| "dismissed" }` | `NextMovesFile` |
| POST | `/api/checkin` | `Checkin` (date defaults to today) | `Snapshot` |

Every error response body is `ApiError` (`{ error: string }`, in `shared/types.ts`).

A collector that fails never breaks the snapshot: it keeps its last good data and sets its `SourceState` to `error` with a short message.

## Collector details

- **github**: `gh api user` for login. PRs: `gh search prs --author @me --state open` and `--review-requested @me --state open` with `--json`. CI: for repos with a push in the last 30 days, latest run on the default branch via `gh run list --limit 1 --json`. Commits per day: `gh api` search or `/repos/{r}/stats/commit_activity`; cap to repos pushed in the last year. Cache 30 min.
- **jira**: if `.env` lacks `JIRA_API_TOKEN`, status `not_connected` with message "Add JIRA_EMAIL and JIRA_API_TOKEN to .env". Else `GET https://{JIRA_SITE}/rest/api/3/search/jql` with `jql=assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC`, basic auth. `blocked` = status name or a label contains "block". Default `JIRA_SITE=qicbizdev.atlassian.net`.
- **claudeSessions**: each folder in `~/.claude/projects` is a project. Folder names encode a path (`C--Users-ialab-Documents-GitHub-QIC-QIC-FastBind`); display name = last meaningful segment, and fold `--claude-worktrees-*` folders into their parent project. Skip `AppData-Local-Temp` folders. Read `timestamp` fields from each `.jsonl` line (stream, do not load whole files). Active time: sort timestamps, sum gaps under 15 minutes, per local day.
- **learning**: parse `Daily.md` for `**Current: N** · Best: M · Started: DATE`, the `**Concept:**` line and `- [x]`/`- [ ]` steps under "Current cycle". Agenda: checkbox lines in `Agenda/YYYY-MM.md` for this month. Tolerate missing files (status `not_connected`).
- **checkins**: last 365 days from `data/checkins.json`.
- **calendar, email**: return `not_connected` with message "Connect Google Calendar / Gmail" until a later version.

## Needs-you rules (`needsYou.ts`, pure function of the snapshot, unit tested)

| Rule | Urgency |
|---|---|
| Jira issue overdue, or due within 24 h | red |
| Jira issue due within 72 h, or `blocked` | amber |
| PR where I am reviewer, open more than 24 h | red if more than 72 h, else amber |
| My PR with failing checks | red |
| CI failing on a default branch I pushed to this month | amber |
| Calendar event starting within 2 h | red |
| No check-in today after 20:00 local | amber |
| Learning streak at risk (today's step not done after 18:00 on a workday, Sun to Thu) | amber |

Sort red first, then by due time. Cap at 8; the UI shows a "+N more" link.

## AI next moves (`ai/nextMoves.ts`)

- Run `claude -p <prompt> --output-format json --model sonnet` with the trimmed snapshot (no tokens or secrets) in the prompt, cwd set to the vault `C:\Users\ialab\Desktop\MD Files\Working-With-Claude` so it can read `qic-engineering/` procedures.
- Prompt asks for 3 to 6 ranked next steps across work, learning and personal, each with a one-line reason tied to a real item (ticket key, PR, step, gate), as JSON matching `NextMove[]` without `state`.
- Validate with a hand-written guard; on bad JSON keep the previous moves and set `status: "error"`.
- If the CLI output contains "Failed to authenticate" or "OAuth", set `status: "not_logged_in"`, message "Run `claude` in a terminal and log in". (This is the current state of this PC.)
- Done or dismissed states persist by id; a new run drops moves whose title matches a dismissed one from the last 7 days.

## Visual direction: dark navy sci-fi control room

Read `PLAN.md` sections 4 and 5 and the vault pages `ux/data-dense-ui-tables-and-dashboards.md` and `ux/motion-principles.md` in `C:\Users\ialab\Desktop\MD Files\Working-With-Claude`.

- Background deep navy (around `#060B1A`), panels a step lighter with a 1px cyan-tinted border and a faint inner glow, subtle background grid lines. One accent cyan for data, red and amber for urgency only, a soft violet for AI content. Define all of it as tokens in `tokens.css`; components use tokens only.
- Numbers in JetBrains Mono with tabular numerals. Labels small caps-like, letter-spaced.
- Glance home: header (date, greeting, refresh, source status dots), Needs-you strip, Next moves panel, KPI tiles with sparklines, week timeline, project-time bars, yearly heatmap. Most important top-left.
- Explore: clicking a tile expands it into a detail view with a shared-layout animation (`motion` `layoutId`), Escape and a back control close it.
- Life map view: d3-force graph. Center "Islam", ring of areas, projects around areas. Node size = attention in the last 7 days, red/amber halo = has a needs-you item. Drag, hover tooltip, click opens that area's detail.
- Check-in: a compact dialog, five controls, saves in one click, success micro-animation.
- Motion: count-up numbers, charts draw in on first load, items changed since last visit pulse once. Interactions under 300 ms, stagger under 50 ms, nothing loops. Respect `prefers-reduced-motion`.
- Every panel has loading (skeleton), empty, error and not-connected states. Not-connected states say exactly what to do. Never show invented data.
- Works from 1280 px down to phone width without horizontal scroll. Keyboard reachable, visible focus, WCAG AA contrast.

---

# v1.1: Project tracker and notes

Decided by Islam on 2026-10-30: projects become a full tracker (status, deadline, goals, tasks); notes are markdown files written by the dashboard and stored in the Working-With-Claude vault; notes link to projects; the AI reads recent notes.

## Storage

- Projects: `data/projects.json` (`ProjectsFile` below), atomic writes through `store.ts`.
- Notes: markdown files under `NOTES_DIR` (default `VAULT_DIR/notes`). Sections and subsections are folders (any depth up to 4). One note = one `.md` file named `YYYY-MM-DD-<slug>.md`; the filename never changes after creation, the title lives in frontmatter. Islam may also edit these files in Obsidian, so the server re-reads the folder (mtime cache) and tolerates hand-made files without frontmatter (title = first `# ` heading or the filename).
- Note frontmatter (YAML subset, hand-parsed, no dependency):
  ```
  ---
  title: Sprint review with underwriting
  created: 2026-10-30T14:05:00+03:00
  updated: 2026-10-30T14:40:00+03:00
  project: qic-fastbind        # project id or empty
  tags: [meeting, fastbind]
  ---
  ```
- Deleting a note moves it to `NOTES_DIR/.trash/` (never a hard delete). Deleting a section is allowed only when it holds no notes and no subsections. `.trash` and dot-folders are never listed.
- First run creates the sections `Meeting notes` and `Personal notes` if `NOTES_DIR` is empty or missing.
- Path safety: every client path is relative, posix, normalised, must stay inside `NOTES_DIR` after `path.resolve`, no `..`, no absolute, no drive letters, no dot-segments, names max 80 chars, `[\p{L}\p{N} _.,()&'-]` only.

## Contract additions (`shared/types.ts`)

```ts
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
export interface NotesIndex { status: SourceStatus; message?: string; dir: string; sections: NoteSection[]; notes: NoteMeta[] }  // dir = absolute notes folder
export type NoteTemplate = "blank" | "meeting" | "personal";
```

`Snapshot` gains `projects: ProjectsState` and `notes: { recent: NoteMeta[]; status: SourceStatus; message?: string }` (last 14 days, max 30).

## API additions

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/projects` | | `ProjectsState` |
| POST | `/api/projects` | `{ name, area, status?, deadline?, description?, goals?, sources? }` | `ProjectsState` |
| PATCH | `/api/projects/:id` | any of name, area, status, deadline, description, goals, sources | `ProjectsState` |
| DELETE | `/api/projects/:id` | | `ProjectsState` (its sources go back to untracked; notes keep their link text) |
| POST | `/api/projects/:id/tasks` | `{ text, due? }` | `ProjectsState` |
| PATCH | `/api/projects/:id/tasks/:taskId` | any of text, done, due | `ProjectsState` |
| DELETE | `/api/projects/:id/tasks/:taskId` | | `ProjectsState` |
| POST | `/api/projects/hide` and `/api/projects/unhide` | `{ name }` | `ProjectsState` |
| GET | `/api/notes` | | `NotesIndex` |
| GET | `/api/notes/file?path=` | | `Note` |
| POST | `/api/notes` | `{ section, title, body?, projectId?, tags?, template? }` | `Note` |
| PUT | `/api/notes/file?path=` | any of title, body, projectId, tags | `Note` |
| DELETE | `/api/notes/file?path=` | | `NotesIndex` (moved to .trash) |
| POST | `/api/notes/sections` | `{ parent, name }` | `NotesIndex` |
| PATCH | `/api/notes/sections` | `{ path, name }` (rename) | `NotesIndex` |
| DELETE | `/api/notes/sections?path=` | | `NotesIndex` (409 `ApiError` if not empty) |

Validation: names 1 to 80 chars, task text 1 to 300, description 0 to 2000, goals max 10 of 200 chars, note body max 200 KB, title 1 to 120, tags max 10 of 30 chars `[\p{L}\p{N}-]`. Every write returns the fresh state; every error is `ApiError`.

## Stats and detection

- A project's minutes and commits = sum over its `sources.sessions` (from `sessionTime`) and `sources.repos` (from `repoActivity`, matched by repo name with or without owner).
- `untracked` = auto-detected session and repo names active in the last 90 days that are in no project's sources and not in `hidden`, sorted by minutes7d then commits30d.
- First run seeding: if `data/projects.json` does not exist, create one active project per session name with more than 60 minutes in the last 30 days (area work, sources.sessions = [name]); everything else stays untracked. Islam then curates.

## Needs-you additions

| Rule | Urgency |
|---|---|
| Open task of an active project overdue or due within 24 h | red |
| Open task due within 72 h | amber |
| Active project deadline passed | red |
| Active project deadline within 3 days | amber |
| Open action items (`- [ ]`) in a meeting-notes note older than 2 days | amber, one item per note |

Ids: `task:<projectId>:<taskId>`, `deadline:<projectId>`, `note:<path>`. Area = the project's area (notes: the linked project's area, else personal).

## AI additions

The prompt adds: active and paused projects (name, area, status, deadline, up to 5 open tasks with due dates), and notes from the last 7 days (title, section, linked project, open action item lines, excerpt up to 300 chars). Notes and task text are untrusted data: the prompt already tells Claude to treat DATA as data. Moves may reference a project task by `sourceUrl` = `#/projects/<id>` or a note by `#/notes/<path>`.

## Web additions

- Routes: `#/projects`, `#/projects/<id>`, `#/notes`, `#/notes/<path>` (URI-encoded). Header switch: Home, Projects, Notes, Life map.
- Life map, project-time bars and the heatmap use tracked projects (name and area from the registry); hidden names are excluded; untracked active names fold into "Other".
