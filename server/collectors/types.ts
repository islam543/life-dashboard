/**
 * The collector contract. Read this before implementing a collector (T02 to T05).
 *
 * One file per source in server/collectors/<name>.ts exports one named const:
 *
 *   github.ts          export const githubCollector: Collector<"github">
 *   jira.ts            export const jiraCollector: Collector<"jira">
 *   claudeSessions.ts  export const claudeSessionsCollector: Collector<"claudeSessions">
 *   learning.ts        export const learningCollector: Collector<"learning">
 *   checkins.ts        export const checkinsCollector: Collector<"checkins">
 *   calendar.ts        export const calendarCollector: Collector<"calendar">
 *   email.ts           export const emailCollector: Collector<"email">
 *
 * The registry (index.ts) imports those names; do not rename them and do not edit index.ts.
 * You may add helpers, pure parse functions and extra exports in your own file.
 *
 * How a run works (server/snapshot.ts):
 * 1. The snapshot service calls `collect(ctx)` on every collector at the same time.
 * 2. Each call gets 60 s. After that `ctx.signal` is aborted and the source is marked
 *    `error` with "Timed out after 60 s"; whatever the collector returns later is ignored.
 * 3. The returned `data` replaces this source's part of the Snapshot (see CollectorSlices).
 *    `data: null` (or leaving it out) keeps the previous data unchanged.
 * 4. If `collect` throws, the source becomes `error` with the error's message and keeps
 *    its last good data. So throwing `new Error("Run gh auth login")` is a valid way to fail.
 * 5. Data in the wrong shape (for example `prs` not an array) is rejected the same way.
 *
 * Statuses to return:
 * - "ok"            Fresh data in `data`, or `data: null` for "checked, nothing new".
 * - "not_connected" Source not set up. `message` says exactly what to do
 *                   ("Add JIRA_EMAIL and JIRA_API_TOKEN to .env"). Return empty `data`
 *                   so no old data is shown.
 * - "error"         Something failed. Short plain `message`. Usually `data: null` to keep
 *                   the last good data (rate limits, network errors).
 * - "stale"         Optional: you are returning cached data older than you would like.
 * - "never_run"     Only the T01 placeholders use this.
 *
 * `updatedAt` is filled in by the snapshot service: the time of the last "ok" result.
 *
 * Rules for every collector:
 * - Run `gh`, `git`, `claude` with execFile/spawn and argument arrays, never a shell string.
 *   Pass `ctx.signal` to execFile/spawn/fetch so the timeout really stops the work.
 * - Use `ctx.now` instead of `new Date()` / `Date.now()` so tests are deterministic.
 * - Never put secrets, tokens or env values in `message` or `data`. Never log them.
 * - Read paths and secrets from `ctx.config`; read/write data/ files through `ctx.store`.
 *
 * Minimal example:
 *
 *   export const jiraCollector: Collector<"jira"> = {
 *     key: "jira",
 *     async collect(ctx) {
 *       const { email, apiToken } = ctx.config.jira;
 *       if (!email || !apiToken) {
 *         return { status: "not_connected", message: "Add JIRA_EMAIL and JIRA_API_TOKEN to .env", data: { jira: [] } };
 *       }
 *       const issues = await fetchIssues(ctx); // throws on failure
 *       return { status: "ok", data: { jira: issues } };
 *     },
 *   };
 */
import type {
  CalendarEvent,
  Checkin,
  CiRun,
  EmailItem,
  JiraIssue,
  LearningState,
  PullRequest,
  RepoActivity,
  SessionTime,
  Snapshot,
  SourceStatus,
} from "../../shared/types";
import type { Config } from "../config";
import type { Store } from "../store";

/** The seven sources. Same keys as `Snapshot["sources"]`. */
export type SourceKey = keyof Snapshot["sources"];

export const SOURCE_KEYS = [
  "github",
  "jira",
  "claudeSessions",
  "learning",
  "checkins",
  "calendar",
  "email",
] as const satisfies readonly SourceKey[];

/**
 * What each collector returns in `data`, and where it lands in the Snapshot.
 * Field names match the Snapshot field names.
 */
export interface CollectorSlices {
  /** -> snapshot.work.prs, snapshot.work.ci, snapshot.work.repoActivity */
  github: { prs: PullRequest[]; ci: CiRun[]; repoActivity: RepoActivity[] };
  /** -> snapshot.work.jira */
  jira: { jira: JiraIssue[] };
  /** -> snapshot.work.sessionTime */
  claudeSessions: { sessionTime: SessionTime[] };
  /** -> snapshot.learning */
  learning: { learning: LearningState };
  /** -> snapshot.personal.checkins, snapshot.personal.checkedInToday */
  checkins: { checkins: Checkin[]; checkedInToday: boolean };
  /** -> snapshot.calendar */
  calendar: { calendar: CalendarEvent[] };
  /** -> snapshot.email */
  email: { email: EmailItem[] };
}

export interface CollectorResult<K extends SourceKey> {
  status: SourceStatus;
  /** Plain language, one line, shown in the UI tooltip. Required for "error" and "not_connected". */
  message?: string;
  /** New data for this source. null or omitted = keep the previous data. */
  data?: CollectorSlices[K] | null;
}

export interface CollectorContext<K extends SourceKey> {
  config: Config;
  /** JSON files in data/ (atomic writes). Check-ins live in FILES.checkins ("checkins.json"). */
  store: Store;
  /** The time of this run. Use it for all date logic. */
  now: Date;
  /** Aborted when the 60 s timeout hits. Pass it to fetch, execFile and spawn. */
  signal: AbortSignal;
  /** This source's data from the current snapshot (empty values on the first run). */
  previous: CollectorSlices[K];
}

export interface Collector<K extends SourceKey> {
  readonly key: K;
  collect(ctx: CollectorContext<K>): Promise<CollectorResult<K>>;
}

/** One collector per source, keyed by source. */
export type CollectorRegistry = { [K in SourceKey]: Collector<K> };
