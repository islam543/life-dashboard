import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDateKey } from "../checkinValidate";
import { loadConfig } from "../config";
import { createStore } from "../store";
import {
  activeIntervals,
  claudeSessionsCollector,
  collectSessionTime,
  type FileCache,
  type Interval,
  lineTimestamp,
  mergeIntervals,
  minutesByLocalDay,
  projectName,
  windowStart,
} from "./claudeSessions";

// Fixtures are synthetic: folder names for user "test", timestamps only, no real session content.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude", "projects");
const FIXTURE_HOME = "C:\\Users\\test";
const NOW = new Date("2026-10-28T12:00:00.000Z");
const MIN = 60_000;
const day = (iso: string) => localDateKey(new Date(iso));
const json = (iso: string) => JSON.stringify({ type: "user", uuid: "x", timestamp: iso });

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-claude-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("projectName", () => {
  const home = "C:\\Users\\ialab";

  it.each([
    ["C--Users-ialab-Documents-GitHub-QIC-QIC-FastBind", "QIC-FastBind"],
    ["C--Users-ialab-Desktop-Trading-research", "Trading-research"],
    ["C--Users-ialab", "Home"],
    ["c--Users-ialab-Documents-GitHub-experiment", "experiment"],
    ["C--Users-ialab-Documents-GitHub-QIC-risk-console", "QIC-risk-console"],
    ["C--Users-ialab-Documents-GitHub-QIC", "QIC"],
    ["C--Users-ialab-Documents-GitHub", "GitHub"],
    ["C--Users-ialab-Documents-GitHub-QIC-QIC-FastBind-vercel", "QIC-FastBind-vercel"],
    ["C--Users-ialab-Desktop-MD-Files-Working-With-Claude", "Working-With-Claude"],
    ["C--Users-ialab-Desktop-personal", "personal"],
    ["D--work-tools", "work-tools"],
  ])("%s -> %s", (folder, expected) => {
    expect(projectName(folder, home)).toBe(expected);
  });

  it.each([
    ["C--Users-ialab-Documents-GitHub-QIC-QIC-FastBind--claude-worktrees-motor-desk-dashboard-metrics-e0570d", "QIC-FastBind"],
    ["C--Users-ialab-Documents-GitHub-trades-recon--claude-worktrees-fi-trade-email-format-ebe479", "trades-recon"],
    ["C--Users-ialab--claude-worktrees-quick-fix-123abc", "Home"],
  ])("folds worktree %s into %s", (folder, expected) => {
    expect(projectName(folder, home)).toBe(expected);
  });

  it.each([
    "C--Users-ialab-AppData-Local-Temp-remember-summarizer-cwd-6vatvcc8",
    "C--Users-ialab-AppData-Roaming-Claude-scratch-workspaces-b1f9e893-scratch-2026-10-13-e3b479",
    "c--users-ialab-appdata-local-temp-x",
  ])("skips %s", (folder) => {
    expect(projectName(folder, home)).toBeNull();
  });

  it("falls back to the drive and user pattern when home does not match", () => {
    expect(projectName("C--Users-ialab-Desktop-Trading-research", "/home/someone")).toBe("Trading-research");
    expect(projectName("C--Users-ialab", "/home/someone")).toBe("Home");
    expect(projectName("-home-someone-code-app", "/srv/other")).toBe("code-app");
  });
});

describe("lineTimestamp", () => {
  it("reads the top-level ISO timestamp", () => {
    expect(lineTimestamp(json("2026-10-20T11:30:00.000Z"))).toBe(Date.parse("2026-10-20T11:30:00.000Z"));
  });

  it.each([
    ["empty line", ""],
    ["not JSON", "this line is not json"],
    ["truncated JSON", '{"type":"user","timestamp":"2026-10-20T11:53:00.000Z"'],
    ["no timestamp", '{"type":"summary","summary":"synthetic"}'],
    ["nested timestamp only", '{"type":"file-history-snapshot","snapshot":{"timestamp":"2026-10-20T11:52:00.000Z"}}'],
    ["array", '[{"timestamp":"2026-10-20T11:54:00.000Z"}]'],
    ["not a date", '{"timestamp":"yesterday"}'],
    ["number", '{"timestamp":1792000000000}'],
    ["bad calendar date", '{"timestamp":"2026-13-45T99:00:00Z"}'],
  ])("ignores %s", (_label, line) => {
    expect(lineTimestamp(line)).toBeNull();
  });
});

describe("active time", () => {
  const t = (minutes: number) => Date.UTC(2026, 9, 20, 9, 0) + minutes * MIN;
  const total = (list: Interval[]) => list.reduce((sum, [s, e]) => sum + (e - s), 0) / MIN;

  it("sums gaps under 15 minutes only, in any input order", () => {
    // gaps: 5, 5, 30 (no), 14 (yes), 15 (no, not under 15)
    const intervals = activeIntervals([t(40), t(0), t(10), t(54), t(5), t(69)]);
    expect(intervals).toEqual([
      [t(0), t(10)],
      [t(40), t(54)],
      [t(69), t(69)],
    ]);
    expect(total(intervals)).toBe(24);
  });

  it("counts overlapping sessions once and joins sessions less than 15 minutes apart", () => {
    const merged = mergeIntervals([
      [t(0), t(10)],
      [t(5), t(15)], // overlaps the first
      [t(25), t(30)], // 10 minute gap: joined
      [t(50), t(60)], // 20 minute gap: separate
    ]);
    expect(merged).toEqual([
      [t(0), t(30)],
      [t(50), t(60)],
    ]);
    expect(total(merged)).toBe(40);
  });

  it("splits a session crossing local midnight across both days", () => {
    const start = new Date(2026, 9, 25, 23, 50).getTime();
    const end = new Date(2026, 9, 26, 0, 10).getTime();
    expect(minutesByLocalDay([[start, end]], 0, Number.MAX_SAFE_INTEGER)).toEqual({ "2026-10-25": 10, "2026-10-26": 10 });
  });

  it("clips to the window", () => {
    const from = new Date(2026, 9, 20).getTime();
    const to = new Date(2026, 9, 20, 12, 0).getTime();
    const intervals: Interval[] = [
      [new Date(2026, 9, 19, 23, 0).getTime(), new Date(2026, 9, 20, 0, 30).getTime()],
      [new Date(2026, 9, 20, 11, 50).getTime(), new Date(2026, 9, 20, 12, 40).getTime()],
    ];
    expect(minutesByLocalDay(intervals, from, to)).toEqual({ "2026-10-20": 40 });
  });

  it("drops days that round to zero minutes", () => {
    const start = new Date(2026, 9, 21, 9, 0).getTime();
    expect(minutesByLocalDay([[start, start + 20_000]], 0, Number.MAX_SAFE_INTEGER)).toEqual({});
  });

  it("opens the window 364 days before today at local midnight", () => {
    const now = new Date(2026, 9, 28, 15, 0);
    expect(windowStart(now)).toBe(new Date(2025, 9, 29).getTime());
  });
});

describe("collectSessionTime on fixtures", () => {
  it("merges worktrees and same-name folders, skips temp and scratch, ignores malformed lines", async () => {
    const result = await collectSessionTime({ projectsDir: FIXTURES, home: FIXTURE_HOME, now: NOW, cache: new Map() });
    expect(result.sessionTime).toEqual([
      // c1 ends 11:45, c2 starts 11:55: one 60 minute block
      { project: "Trading-research", minutesByDay: { [day("2026-10-25T11:00:00Z")]: 60 } },
      {
        project: "Acme-Widget",
        minutesByDay: {
          // repo 11:30-11:40 plus worktree 11:35-11:45 (counted once) plus 12:05-12:10
          [day("2026-10-20T11:30:00Z")]: 20,
          [day("2026-10-22T11:30:00Z")]: 20,
          [day("2026-10-27T11:30:00Z")]: 8,
        },
      },
      { project: "Home", minutesByDay: { [day("2026-10-26T11:30:00Z")]: 12 } },
    ]);
    // a1, b1, c1, c2, d1, e1. Subagent files, notes.txt, temp and scratch folders are not read.
    expect(result).toMatchObject({ filesRead: 6, filesCached: 0, filesFailed: 0 });
  });

  it("does not reread unchanged files and rereads a file whose mtime changed", async () => {
    const dir = path.join(tmp, "projects");
    await cp(FIXTURES, dir, { recursive: true });
    const cache: FileCache = new Map();
    const opts = { projectsDir: dir, home: FIXTURE_HOME, now: NOW, cache };

    const first = await collectSessionTime(opts);
    const second = await collectSessionTime(opts);
    expect(second).toMatchObject({ filesRead: 0, filesCached: 6 });
    expect(second.sessionTime).toEqual(first.sessionTime);

    const home = path.join(dir, "C--Users-test", "fixture-d1.jsonl");
    await writeFile(home, [json("2026-10-26T11:30:00.000Z"), json("2026-10-26T11:44:00.000Z")].join("\n"));
    const later = new Date(Date.now() + 5_000);
    await utimes(home, later, later);
    const third = await collectSessionTime(opts);
    expect(third).toMatchObject({ filesRead: 1, filesCached: 5 });
    expect(third.sessionTime.find((p) => p.project === "Home")?.minutesByDay).toEqual({ [day("2026-10-26T11:30:00Z")]: 14 });

    await rm(home);
    const fourth = await collectSessionTime(opts);
    expect(fourth.sessionTime.find((p) => p.project === "Home")).toBeUndefined();
    expect(cache.has(home)).toBe(false);
  });

  it("handles empty folders, a session over midnight and a very long line", async () => {
    const dir = path.join(tmp, "projects");
    await mkdir(path.join(dir, "C--Users-test-Documents-GitHub-empty"), { recursive: true });
    const night = path.join(dir, "C--Users-test-Desktop-night-owl");
    await mkdir(night);
    const stamps = [50, 55, 60, 65, 70].map((m) => new Date(2026, 9, 25, 23, m).toISOString());
    const longLine = JSON.stringify({ type: "user", message: { content: "x".repeat(3_000_000) }, timestamp: stamps[0] });
    await writeFile(path.join(night, "s.jsonl"), [longLine, ...stamps.slice(1).map(json)].join("\r\n") + "\r\n");

    const result = await collectSessionTime({ projectsDir: dir, home: FIXTURE_HOME, now: NOW, cache: new Map() });
    expect(result.sessionTime).toEqual([{ project: "night-owl", minutesByDay: { "2026-10-25": 10, "2026-10-26": 10 } }]);
    expect(result.filesFailed).toBe(0);
  });

  it("stops when the signal is aborted", async () => {
    await expect(
      collectSessionTime({ projectsDir: FIXTURES, home: FIXTURE_HOME, now: NOW, cache: new Map(), signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe("claudeSessionsCollector", () => {
  const context = (projectsDir: string) => ({
    config: loadConfig({ CLAUDE_PROJECTS_DIR: projectsDir }, { rootDir: tmp, home: FIXTURE_HOME }),
    store: createStore(path.join(tmp, "data")),
    now: NOW,
    signal: new AbortController().signal,
    previous: { sessionTime: [] },
  });

  it("returns ok with session time from the projects folder", async () => {
    const result = await claudeSessionsCollector.collect(context(FIXTURES));
    expect(result.status).toBe("ok");
    expect(result.message).toBeUndefined();
    expect(result.data?.sessionTime.map((p) => p.project)).toEqual(["Trading-research", "Acme-Widget", "Home"]);
  });

  it("returns not_connected with empty data when the folder is missing", async () => {
    const result = await claudeSessionsCollector.collect(context(path.join(tmp, "missing")));
    expect(result).toEqual({
      status: "not_connected",
      message: "No Claude Code sessions folder found. Set CLAUDE_PROJECTS_DIR in .env",
      data: { sessionTime: [] },
    });
  });
});
