import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RepoActivity } from "../../shared/types";
import { loadConfig } from "../config";
import type { Store } from "../store";
import {
  CACHE_FILE,
  classifyGhFailure,
  createGithubCollector,
  GH_MESSAGES,
  GhError,
  type GhRunner,
  mergePrs,
  parseCheckRollup,
  parseCommitActivity,
  parsePrSearch,
  parseRepoList,
  parseRunList,
  parseUserLogin,
  toGhError,
} from "./github";
import type { CollectorContext, CollectorSlices } from "./types";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/github/${name}`, import.meta.url), "utf8");
const stderr = JSON.parse(fixture("gh-stderr.json")) as Record<string, { code: number; stderr: string }>;

const NOW = new Date("2026-10-30T06:00:00.000Z");
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------
// Parsers

describe("parseUserLogin", () => {
  it("reads the login from gh api user", () => {
    expect(parseUserLogin(fixture("user.json"))).toBe("islam543");
  });

  it("rejects output without a login", () => {
    expect(() => parseUserLogin("{}")).toThrow(GhError);
    expect(() => parseUserLogin("not json")).toThrow(/Unexpected output/);
  });
});

describe("parsePrSearch", () => {
  it("drops PRs whose url is not https", () => {
    const item = { repository: { nameWithOwner: "me/repo" }, number: 1, title: "t", url: "javascript:alert(1)",
      createdAt: "2026-10-01T00:00:00Z", isDraft: false, author: { login: "me" } };
    expect(parsePrSearch(JSON.stringify([item]), "author")).toEqual([]);
  });

  it("maps authored PRs, keeping draft flag and author login", () => {
    const prs = parsePrSearch(fixture("search-prs-author.json"), "author");
    expect(prs).toHaveLength(3);
    expect(prs[0]).toEqual({
      repo: "islam543/risk-console",
      number: 4,
      title: "GitLab prep: UV package management, Python 3.12 requirement, network docs",
      url: "https://github.com/islam543/risk-console/pull/4",
      author: "islam543",
      role: "author",
      createdAt: "2026-08-25T08:53:42Z",
      isDraft: false,
      checks: "none",
    });
    expect(prs[1]).toMatchObject({ number: 3, isDraft: true });
    expect(prs[2]).toMatchObject({ repo: "islam543/pwa-demo", author: "Copilot", isDraft: true });
  });

  it("maps review requests with role reviewer", () => {
    const prs = parsePrSearch(fixture("search-prs-reviewer.json"), "reviewer");
    expect(prs.map((p) => [p.repo, p.number, p.role])).toEqual([
      ["islam543/pwa-demo", 2, "reviewer"],
      ["acme-org/team-app", 17, "reviewer"],
    ]);
  });

  it("handles 0 PRs and skips malformed entries", () => {
    expect(parsePrSearch("[]\n", "author")).toEqual([]);
    expect(parsePrSearch('[{"number":"x"},null,{"number":5,"repository":{"nameWithOwner":"a/b"}}]', "author")).toEqual([]);
    expect(() => parsePrSearch('{"message":"oops"}', "author")).toThrow(GhError);
  });
});

describe("mergePrs", () => {
  it("dedupes by url, review request wins, newest first", () => {
    const merged = mergePrs(
      parsePrSearch(fixture("search-prs-author.json"), "author"),
      parsePrSearch(fixture("search-prs-reviewer.json"), "reviewer"),
    );
    expect(merged.map((p) => `${p.repo}#${p.number}:${p.role}`)).toEqual([
      "acme-org/team-app#17:reviewer",
      "islam543/risk-console#4:author",
      "islam543/risk-console#3:author",
      "islam543/pwa-demo#2:reviewer",
    ]);
  });
});

describe("parseCheckRollup", () => {
  it("rolls up check runs and status contexts", () => {
    expect(parseCheckRollup(fixture("pr-checks-pass.json"))).toBe("pass");
    expect(parseCheckRollup(fixture("pr-checks-fail.json"))).toBe("fail");
    expect(parseCheckRollup(fixture("pr-checks-pending.json"))).toBe("pending");
    expect(parseCheckRollup(fixture("pr-checks-none.json"))).toBe("none");
  });

  it("only counts the newest run of a re-run check", () => {
    expect(parseCheckRollup(fixture("pr-checks-rerun-pass.json"))).toBe("pass");
  });

  it("rejects unexpected output", () => {
    expect(() => parseCheckRollup("[]")).toThrow(GhError);
  });
});

describe("parseRepoList", () => {
  it("reads name, default branch, push time and archived flag", () => {
    const repos = parseRepoList(fixture("repos.json"));
    expect(repos).toHaveLength(6);
    expect(repos[0]).toEqual({ repo: "islam543/trades-recon", defaultBranch: "main", pushedAt: "2026-10-20T11:01:14Z", archived: false });
    expect(repos.find((r) => r.repo === "acme-org/team-app")?.defaultBranch).toBe("master");
    expect(repos.find((r) => r.repo === "islam543/old-course")?.archived).toBe(true);
    expect(repos.find((r) => r.repo === "islam543/empty-repo")?.pushedAt).toBeNull();
  });
});

describe("parseRunList", () => {
  it("maps the latest successful run to pass", () => {
    expect(parseRunList(fixture("runs-pass.json"), "islam543/fastbind-demo", "main")).toEqual({
      repo: "islam543/fastbind-demo",
      branch: "main",
      status: "pass",
      url: "https://github.com/islam543/fastbind-demo/actions/runs/36891048247",
      at: "2026-10-01T16:18:54Z",
    });
  });

  it("passes over a cancelled run to the failure before it", () => {
    expect(parseRunList(fixture("runs-cancelled-then-fail.json"), "acme-org/team-app", "master")).toMatchObject({
      status: "fail",
      branch: "master",
      url: "https://github.com/acme-org/team-app/actions/runs/36970000001",
    });
  });

  it("maps a run in progress to pending", () => {
    expect(parseRunList(fixture("runs-in-progress.json"), "islam543/fastbind-demo", "main")?.status).toBe("pending");
  });

  it("returns null for a repo with no Actions runs", () => {
    expect(parseRunList(fixture("runs-empty.json"), "islam543/trades-recon", "main")).toBeNull();
  });
});

describe("parseCommitActivity", () => {
  it("turns weekly stats into commits per day", () => {
    expect(parseCommitActivity(fixture("commit-activity.json"), "islam543/fastbind-demo", NOW)).toEqual({
      repo: "islam543/fastbind-demo",
      commitsByDay: { "2026-09-04": 5, "2026-09-06": 1, "2026-09-07": 7, "2026-09-09": 1 },
    });
  });

  it("keeps only the last 365 days, counting today", () => {
    const later = new Date("2027-09-06T12:00:00.000Z");
    expect(parseCommitActivity(fixture("commit-activity.json"), "r/x", later)).toEqual({
      repo: "r/x",
      commitsByDay: { "2026-09-07": 7, "2026-09-09": 1 },
    });
    expect(parseCommitActivity(fixture("commit-activity.json"), "r/x", new Date("2027-09-20T00:00:00.000Z"))).toBeNull();
  });

  it("rounds week starts that are an hour off midnight UTC", () => {
    const stats = JSON.stringify([{ days: [2, 0, 0, 0, 0, 0, 3], total: 5, week: 1762650000 }]); // 2025-11-09T01:00Z
    expect(parseCommitActivity(stats, "r/x", new Date("2025-11-20T00:00:00.000Z"))).toEqual({
      repo: "r/x",
      commitsByDay: { "2025-11-09": 2, "2025-11-15": 3 },
    });
  });

  it("reports 202 (still computing) and treats an empty repo as no data", () => {
    expect(parseCommitActivity(fixture("commit-activity-computing.json"), "r/x", NOW)).toBe("computing");
    expect(parseCommitActivity("", "r/x", NOW)).toBeNull();
  });
});

describe("classifyGhFailure", () => {
  it("maps logged-out stderr to Run gh auth login", () => {
    const err = classifyGhFailure(stderr.loggedOut);
    expect(err.kind).toBe("auth");
    expect(err.message).toBe("Run gh auth login");
    expect(classifyGhFailure(stderr.badCredentials).message).toBe(GH_MESSAGES.auth);
  });

  it("maps an execFile error object the same way", () => {
    const execErr = Object.assign(new Error("Command failed: gh api user"), stderr.loggedOut);
    expect(toGhError(execErr)).toMatchObject({ kind: "auth", message: "Run gh auth login" });
  });

  it("detects gh missing, rate limits, not found and timeouts", () => {
    expect(toGhError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })).kind).toBe("missing");
    expect(classifyGhFailure(stderr.rateLimit)).toMatchObject({ kind: "rate_limit", message: GH_MESSAGES.rateLimit });
    expect(classifyGhFailure(stderr.secondaryRateLimit).kind).toBe("rate_limit");
    expect(classifyGhFailure(stderr.notFound).kind).toBe("not_found");
    expect(classifyGhFailure(stderr.forbidden)).toMatchObject({ kind: "other", message: "gh failed: Resource not accessible by integration (HTTP 403)" });
    expect(toGhError(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })).kind).toBe("aborted");
  });

  it("never echoes anything that looks like a token", () => {
    const err = classifyGhFailure({ code: 1, stderr: "gh: failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789 attached" });
    expect(err.message).not.toContain("ghp_");
    expect(err.message).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------------------------
// Collector, with a fake gh and an in-memory store (no network)

type MemoryStore = Store & { files: Map<string, unknown> };

function memoryStore(): MemoryStore {
  const files = new Map<string, unknown>();
  return {
    files,
    dir: "memory",
    pathOf: (name) => name,
    read: async <T>(name: string, fallback: T) => (files.has(name) ? (structuredClone(files.get(name)) as T) : fallback),
    write: async (name, value) => {
      files.set(name, structuredClone(value));
    },
    update: async <T>(name: string, fallback: T, change: (current: T) => T) => {
      const next = change(files.has(name) ? (files.get(name) as T) : fallback);
      files.set(name, next);
      return next;
    },
  };
}

type Reply = string | Error;

/** Fake gh: replies by the longest matching argument prefix. Unknown calls fail the test. */
function fakeGh(overrides: Record<string, Reply> = {}) {
  const routes: Record<string, Reply> = {
    "api user": fixture("user.json"),
    "search prs --author @me": fixture("search-prs-author.json"),
    "search prs --review-requested @me": fixture("search-prs-reviewer.json"),
    "pr view 4 --repo=islam543/risk-console": fixture("pr-checks-pass.json"),
    "pr view 3 --repo=islam543/risk-console": fixture("pr-checks-pending.json"),
    "pr view 2 --repo=islam543/pwa-demo": fixture("pr-checks-none.json"),
    "pr view 17 --repo=acme-org/team-app": fixture("pr-checks-fail.json"),
    "api user/repos": fixture("repos.json"),
    "run list --repo=islam543/trades-recon --branch=main": fixture("runs-empty.json"),
    "run list --repo=acme-org/team-app --branch=master": fixture("runs-cancelled-then-fail.json"),
    "run list --repo=islam543/fastbind-demo --branch=main": fixture("runs-pass.json"),
    "api repos/islam543/trades-recon/stats/commit_activity": fixture("commit-activity-computing.json"),
    "api repos/acme-org/team-app/stats/commit_activity": classifyGhFailure(stderr.notFound),
    "api repos/islam543/fastbind-demo/stats/commit_activity": fixture("commit-activity.json"),
    "api repos/islam543/risk-console/stats/commit_activity": "",
    ...overrides,
  };
  const calls: string[] = [];
  const unexpected: string[] = [];
  const run: GhRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(routes)
      .filter((k) => line === k || line.startsWith(`${k} `) || line.startsWith(`${k}?`))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) {
      unexpected.push(line);
      throw new Error(`unexpected gh call: ${line}`);
    }
    const reply = routes[key];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls, unexpected };
}

const empty = (): CollectorSlices["github"] => ({ prs: [], ci: [], repoActivity: [] });

function ctx(store: Store, now: Date = NOW, previous = empty()): CollectorContext<"github"> {
  return {
    config: loadConfig({}, { rootDir: "/tmp/life-dashboard-test", home: "/tmp/life-dashboard-test" }),
    store,
    now,
    signal: new AbortController().signal,
    previous,
  };
}

describe("githubCollector", () => {
  it("collects PRs with checks, CI for recent repos and commit activity", async () => {
    const gh = fakeGh();
    const store = memoryStore();
    const result = await createGithubCollector({ run: gh.run }).collect(ctx(store));

    expect(gh.unexpected).toEqual([]);
    expect(result.status).toBe("ok");
    const data = result.data!;
    expect(data.prs.map((p) => `${p.repo}#${p.number}:${p.role}:${p.checks}`)).toEqual([
      "acme-org/team-app#17:reviewer:fail",
      "islam543/risk-console#4:author:pass",
      "islam543/risk-console#3:author:pending",
      "islam543/pwa-demo#2:reviewer:none",
    ]);
    // trades-recon has no Actions runs; risk-console was pushed more than 30 days ago.
    expect(data.ci.map((c) => `${c.repo}@${c.branch}:${c.status}`)).toEqual([
      "acme-org/team-app@master:fail",
      "islam543/fastbind-demo@main:pass",
    ]);
    // trades-recon is computing (202), team-app 404s, risk-console is empty: only fastbind-demo has data.
    expect(data.repoActivity).toEqual([
      { repo: "islam543/fastbind-demo", commitsByDay: { "2026-09-04": 5, "2026-09-06": 1, "2026-09-07": 7, "2026-09-09": 1 } },
    ]);
    // Repos pushed more than a year ago (or never) are not queried.
    expect(gh.calls.some((c) => c.includes("old-course") || c.includes("empty-repo"))).toBe(false);
    expect(gh.calls.some((c) => c.startsWith("run list --repo=islam543/risk-console"))).toBe(false);
    expect(store.files.get(CACHE_FILE)).toEqual({ fetchedAt: NOW.toISOString(), data });
  });

  it("serves the cache for 30 min, then fetches again", async () => {
    const gh = fakeGh();
    const store = memoryStore();
    const collector = createGithubCollector({ run: gh.run });
    const first = await collector.collect(ctx(store));
    const callsAfterFirst = gh.calls.length;

    const cached = await collector.collect(ctx(store, new Date(NOW.getTime() + 10 * MIN)));
    expect(cached).toEqual({ status: "ok", data: first.data });
    expect(gh.calls.length).toBe(callsAfterFirst);

    // The next scheduled run (30 min later) always refreshes.
    await collector.collect(ctx(store, new Date(NOW.getTime() + 30 * MIN)));
    expect(gh.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("keeps last round's activity for a repo whose stats are still computing", async () => {
    const gh = fakeGh();
    const previousTrades: RepoActivity = { repo: "islam543/trades-recon", commitsByDay: { "2026-10-20": 3 } };
    const result = await createGithubCollector({ run: gh.run }).collect(
      ctx(memoryStore(), NOW, { prs: [], ci: [], repoActivity: [previousTrades] }),
    );
    expect(result.data!.repoActivity.map((a) => a.repo)).toEqual(["islam543/fastbind-demo", "islam543/trades-recon"]);
    expect(result.data!.repoActivity[1]).toEqual(previousTrades);
  });

  it("handles 0 PRs", async () => {
    const gh = fakeGh({ "search prs --author @me": "[]\n", "search prs --review-requested @me": "[]\n" });
    const result = await createGithubCollector({ run: gh.run }).collect(ctx(memoryStore()));
    expect(result.status).toBe("ok");
    expect(result.data!.prs).toEqual([]);
    expect(gh.calls.some((c) => c.startsWith("pr view"))).toBe(false);
  });

  it("logged out: error with Run gh auth login, keeps last data, stops after one call", async () => {
    const loggedOut = Object.assign(new Error("Command failed: gh api user"), stderr.loggedOut);
    const gh = fakeGh({ "api user": loggedOut });
    const store = memoryStore();
    const result = await createGithubCollector({ run: gh.run }).collect(ctx(store));
    expect(result).toEqual({ status: "error", message: "Run gh auth login", data: null });
    expect(gh.calls).toEqual(["api user"]);
    expect(store.files.has(CACHE_FILE)).toBe(false);
  });

  it("gh missing: error with an install hint", async () => {
    const gh = fakeGh({ "api user": Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) });
    const result = await createGithubCollector({ run: gh.run }).collect(ctx(memoryStore()));
    expect(result).toEqual({ status: "error", message: GH_MESSAGES.missing, data: null });
  });

  it("rate limit: error message, keeps last data, no cache written", async () => {
    const gh = fakeGh({ "api repos/islam543/fastbind-demo/stats/commit_activity": classifyGhFailure(stderr.rateLimit) });
    const store = memoryStore();
    const result = await createGithubCollector({ run: gh.run }).collect(ctx(store));
    expect(result).toEqual({ status: "error", message: GH_MESSAGES.rateLimit, data: null });
    expect(store.files.has(CACHE_FILE)).toBe(false);
  });

  it("a failing check lookup on one PR falls back to its last known checks", async () => {
    const gh = fakeGh({ "pr view 17 --repo=acme-org/team-app": classifyGhFailure(stderr.forbidden) });
    const previous = empty();
    previous.prs = [{
      repo: "acme-org/team-app", number: 17, title: "Add claims export endpoint", url: "https://github.com/acme-org/team-app/pull/17",
      author: "teammate", role: "reviewer", createdAt: "2026-10-27T14:02:10Z", isDraft: false, checks: "pending",
    }];
    const result = await createGithubCollector({ run: gh.run }).collect(ctx(memoryStore(), NOW, previous));
    expect(result.status).toBe("ok");
    expect(result.data!.prs.find((p) => p.number === 17)?.checks).toBe("pending");
  });
});
