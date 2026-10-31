import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CiRun, PullRequest, RepoActivity } from "../../shared/types";
import type { Store } from "../store";
import { childEnv } from "../ai/nextMoves";
import type { Collector, CollectorContext, CollectorSlices } from "./types";

/**
 * GitHub collector (T02). Everything goes through the `gh` CLI, already logged in on this PC.
 *
 * - prs:          `gh search prs --author @me` and `--review-requested @me` (open), plus
 *                 `gh pr view N --json statusCheckRollup` per PR for the checks rollup.
 * - ci:           repos pushed in the last 30 days, latest run on the default branch (`gh run list`).
 * - repoActivity: repos pushed in the last year, `/repos/{r}/stats/commit_activity` per repo
 *                 (all authors, per day, last 365 days).
 *
 * Every gh output has one pure exported parse function, tested against fixtures in
 * fixtures/github/. This file never reads, passes or logs a token: gh handles auth itself.
 */

type GithubData = CollectorSlices["github"];

/** Runs `gh` with an argument array (never a shell string) and resolves with stdout. Rejects with GhError. */
export type GhRunner = (args: readonly string[], signal: AbortSignal) => Promise<string>;

/** Cache of the last good result in data/, so restarts and refreshes do not hammer the GitHub API. */
export const CACHE_FILE = "cache/github.json";
export const CACHE_TTL_MS = 30 * 60_000;
// The scheduler also runs every 30 min. Without this slack, a scheduled run that starts a few ms
// "early" relative to the cached run would hit the cache, and data would only refresh every hour.
const CACHE_SLACK_MS = 60_000;

const DAY_MS = 86_400_000;
const CI_WINDOW_MS = 30 * DAY_MS;
const ACTIVITY_WINDOW_MS = 365 * DAY_MS;
/** Most gh processes running at once. */
const MAX_PARALLEL = 6;
const REPOS_PER_PAGE = 100;
const MAX_REPO_PAGES = 10;

const PR_FIELDS = "number,title,url,repository,author,createdAt,isDraft";
const RUN_FIELDS = "status,conclusion,url,createdAt,headBranch,workflowName";
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------------------------------------
// Errors

export type GhErrorKind = "missing" | "auth" | "rate_limit" | "not_found" | "aborted" | "bad_output" | "other";

export class GhError extends Error {
  readonly kind: GhErrorKind;
  constructor(kind: GhErrorKind, message: string) {
    super(message);
    this.name = "GhError";
    this.kind = kind;
  }
}

export const GH_MESSAGES = {
  missing: "GitHub CLI (gh) not found. Install it, then run gh auth login",
  auth: "Run gh auth login",
  rateLimit: "GitHub rate limit reached, showing the last data",
  aborted: "GitHub collection was stopped",
} as const;

/** These stop the whole run. Anything else only skips the one repo or PR it happened on. */
const FATAL: ReadonlySet<GhErrorKind> = new Set<GhErrorKind>(["missing", "auth", "rate_limit", "aborted"]);

const TOKEN_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const clean = line.replace(/^gh:\s*/, "").replace(TOKEN_LIKE, "[redacted]");
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

/**
 * Pure: maps a failed gh call to an error kind and a short UI message.
 * `code` is the exit code (gh exits 4 when not logged in) or a spawn error code like "ENOENT".
 */
export function classifyGhFailure(failure: { code?: unknown; stderr?: string; aborted?: boolean }): GhError {
  const stderr = failure.stderr ?? "";
  if (failure.aborted) return new GhError("aborted", GH_MESSAGES.aborted);
  if (failure.code === "ENOENT") return new GhError("missing", GH_MESSAGES.missing);
  if (/rate limit|HTTP 429|submitted too quickly/i.test(stderr)) return new GhError("rate_limit", GH_MESSAGES.rateLimit);
  if (failure.code === 4 || /gh auth login|Bad credentials|HTTP 401|not logged in/i.test(stderr)) {
    return new GhError("auth", GH_MESSAGES.auth);
  }
  const line = firstLine(stderr);
  if (/HTTP 404|Not Found|Could not resolve to a Repository/i.test(stderr)) return new GhError("not_found", `gh: ${line}`);
  return new GhError("other", line ? `gh failed: ${line}` : `gh failed (exit ${String(failure.code ?? "unknown")})`);
}

export function toGhError(err: unknown): GhError {
  if (err instanceof GhError) return err;
  if (typeof err !== "object" || err === null) return new GhError("other", `gh failed: ${String(err)}`);
  const e = err as { code?: unknown; stderr?: unknown; name?: unknown; message?: unknown };
  const aborted = e.name === "AbortError" || e.code === "ABORT_ERR";
  if (!aborted && e.code === undefined && e.stderr === undefined) {
    // Not a gh process failure (a bug in this file, for example). Keep its message.
    return new GhError("other", typeof e.message === "string" ? e.message : "GitHub collection failed");
  }
  return classifyGhFailure({ code: e.code, stderr: typeof e.stderr === "string" ? e.stderr : "", aborted });
}

// ---------------------------------------------------------------------------------------------
// Running gh

const execFileAsync = promisify(execFile);

// No prompts, no update checks, no colour codes in output.
/** Links from gh end up as hrefs in the UI, so only https URLs are kept. */
function isHttps(url: string): boolean {
  return /^https:\/\//i.test(url);
}

const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" };

export const runGh: GhRunner = async (args, signal) => {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      signal,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...childEnv(), ...GH_ENV },
    });
    return stdout;
  } catch (err) {
    throw toGhError(err);
  }
};

// ---------------------------------------------------------------------------------------------
// Pure parsers, one per gh output

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const upper = (v: unknown): string => (typeof v === "string" ? v.toUpperCase() : "");
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GhError("bad_output", `Unexpected output from gh (${what})`);
  }
}

/** `gh api user` -> login. */
export function parseUserLogin(stdout: string): string {
  const v = parseJson(stdout, "user");
  const login = isObj(v) ? str(v.login) : null;
  if (!login) throw new GhError("bad_output", "Unexpected output from gh (user)");
  return login;
}

/** `gh search prs ... --json number,title,url,repository,author,createdAt,isDraft` -> PRs with checks "none". */
export function parsePrSearch(stdout: string, role: PullRequest["role"]): PullRequest[] {
  const v = parseJson(stdout, "search prs");
  if (!Array.isArray(v)) throw new GhError("bad_output", "Unexpected output from gh (search prs)");
  const prs: PullRequest[] = [];
  for (const item of v) {
    if (!isObj(item)) continue;
    const repo = isObj(item.repository) ? str(item.repository.nameWithOwner) : null;
    const number = item.number;
    const url = str(item.url);
    const createdAt = str(item.createdAt);
    if (!repo || !REPO_NAME.test(repo) || typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (!url || !isHttps(url) || !createdAt) continue;
    prs.push({
      repo,
      number,
      title: typeof item.title === "string" ? item.title : "",
      url,
      author: (isObj(item.author) ? str(item.author.login) : null) ?? "unknown",
      role,
      createdAt,
      isDraft: item.isDraft === true,
      checks: "none",
    });
  }
  return prs;
}

/**
 * Pure: one list from both searches, newest first. A PR in both lists (for example a Copilot PR
 * I started that asks for my review) counts as "reviewer": it is waiting on me.
 */
export function mergePrs(authored: PullRequest[], reviewing: PullRequest[]): PullRequest[] {
  const byUrl = new Map<string, PullRequest>();
  for (const pr of authored) byUrl.set(pr.url, pr);
  for (const pr of reviewing) byUrl.set(pr.url, pr);
  return [...byUrl.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

const CHECK_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const CHECK_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const STATE_FAIL = new Set(["FAILURE", "ERROR"]);
const STATE_PENDING = new Set(["PENDING", "EXPECTED"]);

type CheckState = "pass" | "fail" | "pending" | null;

/** `gh pr view N --json statusCheckRollup` -> pass, fail, pending or none (no checks at all). */
export function parseCheckRollup(stdout: string): PullRequest["checks"] {
  const v = parseJson(stdout, "pr checks");
  const list = isObj(v) && Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : null;
  if (!list) throw new GhError("bad_output", "Unexpected output from gh (pr checks)");

  // A re-run adds a second check run with the same name. Only the newest one counts, as in `gh pr checks`.
  const latest = new Map<string, { startedAt: string; state: CheckState }>();
  for (const c of list) {
    if (!isObj(c)) continue;
    let key: string;
    let state: CheckState;
    if (c.__typename === "StatusContext") {
      key = `status:${String(c.context ?? "")}`;
      const s = upper(c.state);
      state = STATE_FAIL.has(s) ? "fail" : STATE_PENDING.has(s) ? "pending" : s === "SUCCESS" ? "pass" : null;
    } else {
      key = `check:${String(c.workflowName ?? "")}/${String(c.name ?? "")}`;
      const conclusion = upper(c.conclusion);
      state = upper(c.status) !== "COMPLETED" ? "pending" : CHECK_FAIL.has(conclusion) ? "fail" : CHECK_PASS.has(conclusion) ? "pass" : null;
    }
    const startedAt = typeof c.startedAt === "string" ? c.startedAt : "";
    const seen = latest.get(key);
    if (!seen || startedAt >= seen.startedAt) latest.set(key, { startedAt, state });
  }

  const states = [...latest.values()].map((x) => x.state);
  if (states.includes("fail")) return "fail";
  if (states.includes("pending")) return "pending";
  if (states.includes("pass")) return "pass";
  return "none";
}

export interface RepoInfo {
  repo: string;
  defaultBranch: string;
  pushedAt: string | null;
  archived: boolean;
}

/** `gh api user/repos?...` (one page) -> repos. */
export function parseRepoList(stdout: string): RepoInfo[] {
  const v = parseJson(stdout, "repos");
  if (!Array.isArray(v)) throw new GhError("bad_output", "Unexpected output from gh (repos)");
  const repos: RepoInfo[] = [];
  for (const item of v) {
    if (!isObj(item)) continue;
    const repo = str(item.full_name);
    const defaultBranch = str(item.default_branch);
    if (!repo || !REPO_NAME.test(repo) || !defaultBranch) continue;
    repos.push({ repo, defaultBranch, pushedAt: str(item.pushed_at), archived: item.archived === true });
  }
  return repos;
}

const RUN_FAIL = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const RUN_PASS = new Set(["success", "neutral"]);

/**
 * `gh run list --branch <default> --limit 5 --json ...` (newest first) -> the latest run that says
 * something about the branch, or null when the repo has no runs (no Actions).
 * Cancelled, skipped and stale runs are passed over: they say nothing about the branch's health.
 */
export function parseRunList(stdout: string, repo: string, branch: string): CiRun | null {
  const v = parseJson(stdout, "run list");
  if (!Array.isArray(v)) throw new GhError("bad_output", "Unexpected output from gh (run list)");
  for (const run of v) {
    if (!isObj(run)) continue;
    const url = str(run.url);
    const at = str(run.createdAt);
    if (!url || !isHttps(url) || !at) continue;
    const conclusion = typeof run.conclusion === "string" ? run.conclusion.toLowerCase() : "";
    let status: CiRun["status"];
    if (run.status !== "completed") status = "pending";
    else if (RUN_FAIL.has(conclusion)) status = "fail";
    else if (RUN_PASS.has(conclusion)) status = "pass";
    else continue;
    return { repo, branch: str(run.headBranch) ?? branch, status, url, at };
  }
  return null;
}

/**
 * `gh api repos/{r}/stats/commit_activity` -> commits per day (all authors) for the last 365 days,
 * counting today. Days with no commits are left out.
 * - "computing": GitHub answered 202 (gh prints `{}`) while it builds the stats. Try next round.
 * - null: empty repo (204, no output) or no commits in the window.
 */
export function parseCommitActivity(stdout: string, repo: string, now: Date): RepoActivity | "computing" | null {
  if (stdout.trim() === "") return null;
  const v = parseJson(stdout, "commit activity");
  if (isObj(v)) return "computing";
  if (!Array.isArray(v)) throw new GhError("bad_output", "Unexpected output from gh (commit activity)");

  const today = isoDay(now.getTime());
  const oldest = isoDay(now.getTime() - 364 * DAY_MS);
  const commitsByDay: Record<string, number> = {};
  for (const week of v) {
    if (!isObj(week) || typeof week.week !== "number" || !Array.isArray(week.days)) continue;
    // `week` is the Sunday that starts the week, sometimes an hour off midnight UTC; round to the day.
    const sunday = Math.round((week.week * 1000) / DAY_MS) * DAY_MS;
    week.days.forEach((count: unknown, i: number) => {
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0 || i > 6) return;
      const day = isoDay(sunday + i * DAY_MS);
      if (day < oldest || day > today) return;
      commitsByDay[day] = (commitsByDay[day] ?? 0) + Math.round(count);
    });
  }
  return Object.keys(commitsByDay).length > 0 ? { repo, commitsByDay } : null;
}

// ---------------------------------------------------------------------------------------------
// Fetching

type Gh = (args: string[]) => Promise<string>;

/**
 * Wraps the runner: at most MAX_PARALLEL gh processes at once, and after the first fatal error
 * (logged out, rate limit, timeout) every queued call fails at once instead of spawning gh.
 */
function boundedGh(run: GhRunner, signal: AbortSignal): Gh {
  let active = 0;
  const queue: (() => void)[] = [];
  let fatal: GhError | null = null;
  return async (args) => {
    if (active < MAX_PARALLEL) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      if (fatal) throw fatal;
      try {
        return await run(args, signal);
      } catch (err) {
        const e = toGhError(err);
        if (FATAL.has(e.kind)) fatal ??= e;
        throw e;
      }
    } finally {
      // Hand the slot straight to the next waiter so the limit is never exceeded.
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Runs a per-repo or per-PR task. Fatal errors stop the run; others give `fallback` for this item. */
async function soft<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch (err) {
    const e = toGhError(err);
    if (FATAL.has(e.kind)) throw e;
    return fallback;
  }
}

async function fetchPrs(gh: Gh, previous: PullRequest[]): Promise<PullRequest[]> {
  const search = (flag: string) => ["search", "prs", flag, "@me", "--state", "open", "--limit", "100", "--json", PR_FIELDS];
  const [authored, reviewing] = await Promise.all([gh(search("--author")), gh(search("--review-requested"))]);
  const prs = mergePrs(parsePrSearch(authored, "author"), parsePrSearch(reviewing, "reviewer"));
  const lastChecks = new Map(previous.map((p) => [p.url, p.checks]));
  return Promise.all(
    prs.map(async (pr) => ({
      ...pr,
      checks: await soft(
        async () => parseCheckRollup(await gh(["pr", "view", String(pr.number), `--repo=${pr.repo}`, "--json", "statusCheckRollup"])),
        lastChecks.get(pr.url) ?? "none",
      ),
    })),
  );
}

/** Owned and org repos, most recently pushed first. Stops paging once repos are older than a year. */
async function fetchRepos(gh: Gh, now: Date): Promise<RepoInfo[]> {
  const cutoff = now.getTime() - ACTIVITY_WINDOW_MS;
  const repos: RepoInfo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const path = `user/repos?affiliation=owner,organization_member&sort=pushed&direction=desc&per_page=${REPOS_PER_PAGE}&page=${page}`;
    const batch = parseRepoList(await gh(["api", path]));
    repos.push(...batch);
    const last = batch.at(-1)?.pushedAt;
    if (batch.length < REPOS_PER_PAGE || !last || Date.parse(last) < cutoff) break;
  }
  return repos;
}

async function fetchCi(gh: Gh, repos: RepoInfo[]): Promise<CiRun[]> {
  const runs = await Promise.all(
    repos.map((r) =>
      soft(async () => {
        const out = await gh(["run", "list", `--repo=${r.repo}`, `--branch=${r.defaultBranch}`, "--limit", "5", "--json", RUN_FIELDS]);
        return parseRunList(out, r.repo, r.defaultBranch);
      }, null),
    ),
  );
  return runs.filter((r): r is CiRun => r !== null).sort((a, b) => a.repo.localeCompare(b.repo));
}

async function fetchActivity(gh: Gh, repos: RepoInfo[], now: Date, previous: RepoActivity[]): Promise<RepoActivity[]> {
  const last = new Map(previous.map((a) => [a.repo, a]));
  const results = await Promise.all(
    repos.map((r) =>
      soft(async () => {
        const parsed = parseCommitActivity(await gh(["api", `repos/${r.repo}/stats/commit_activity`]), r.repo, now);
        // Still computing: skip the repo this round, keeping last round's numbers if there are any.
        return parsed === "computing" ? (last.get(r.repo) ?? null) : parsed;
      }, last.get(r.repo) ?? null),
    ),
  );
  return results.filter((a): a is RepoActivity => a !== null).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Fetches everything. Throws GhError on fatal problems (logged out, rate limit, gh missing). */
export async function fetchGithubData(
  run: GhRunner,
  ctx: Pick<CollectorContext<"github">, "now" | "signal" | "previous">,
): Promise<GithubData> {
  const gh = boundedGh(run, ctx.signal);
  // Cheap login check first, so a logged-out gh fails with one clear message.
  parseUserLogin(await gh(["api", "user"]));

  const nowMs = ctx.now.getTime();
  const pushedWithin = (r: RepoInfo, ms: number) => r.pushedAt !== null && nowMs - Date.parse(r.pushedAt) <= ms;

  const [prs, repos] = await Promise.all([fetchPrs(gh, ctx.previous.prs), fetchRepos(gh, ctx.now)]);
  const [ci, repoActivity] = await Promise.all([
    fetchCi(gh, repos.filter((r) => !r.archived && pushedWithin(r, CI_WINDOW_MS))),
    fetchActivity(gh, repos.filter((r) => pushedWithin(r, ACTIVITY_WINDOW_MS)), ctx.now, ctx.previous.repoActivity),
  ]);
  return { prs, ci, repoActivity };
}

// ---------------------------------------------------------------------------------------------
// Cache and collector

interface GithubCache {
  fetchedAt: string;
  data: GithubData;
}

function isCache(v: unknown): v is GithubCache {
  return (
    isObj(v) && typeof v.fetchedAt === "string" && isObj(v.data) &&
    Array.isArray(v.data.prs) && Array.isArray(v.data.ci) && Array.isArray(v.data.repoActivity)
  );
}

async function readFreshCache(store: Store, now: Date, ttlMs: number): Promise<GithubData | null> {
  const cache = await store.read<unknown>(CACHE_FILE, null);
  if (!isCache(cache)) return null;
  const age = now.getTime() - Date.parse(cache.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < ttlMs - CACHE_SLACK_MS ? cache.data : null;
}

async function writeCache(store: Store, now: Date, data: GithubData): Promise<void> {
  try {
    await store.write(CACHE_FILE, { fetchedAt: now.toISOString(), data } satisfies GithubCache);
  } catch (err) {
    console.warn(`[github] could not save the cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface GithubCollectorOptions {
  /** Defaults to the real gh CLI. Tests pass a fake. */
  run?: GhRunner;
  cacheTtlMs?: number;
}

export function createGithubCollector(opts: GithubCollectorOptions = {}): Collector<"github"> {
  const run = opts.run ?? runGh;
  const ttlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
  return {
    key: "github",
    async collect(ctx) {
      const cached = await readFreshCache(ctx.store, ctx.now, ttlMs);
      if (cached) return { status: "ok", data: cached };
      try {
        const data = await fetchGithubData(run, ctx);
        await writeCache(ctx.store, ctx.now, data);
        return { status: "ok", data };
      } catch (err) {
        // data: null keeps the last good data in the snapshot (logged out, rate limit, timeout).
        return { status: "error", message: toGhError(err).message, data: null };
      }
    },
  };
}

// The registry in index.ts imports this name.
export const githubCollector: Collector<"github"> = createGithubCollector();
