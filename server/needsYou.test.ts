import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, CiRun, JiraIssue, NoteMeta, Project, ProjectTask, PullRequest, Snapshot, SourceStatus } from "../shared/types";
import { computeNeedsYou, countNeedsYou, NEEDS_YOU_CAP } from "./needsYou";

// Every `now` is built with the local Date constructor and every threshold is an exact
// millisecond offset from it, so these tests pass in any system time zone.

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** Local time on a day in October 2026. 25 = Sunday, 29 = Thursday, 30 = Friday, 31 = Saturday. */
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);
const NOW = local(29, 12); // Thursday 12:00 local
const at = (offset: number, now = NOW) => new Date(now.getTime() + offset).toISOString();
const endOfLocalDay = (day: number) => new Date(2026, 9, day, 23, 59, 59, 999).toISOString();

function base(): Snapshot {
  const ok = () => ({ status: "ok" as SourceStatus, updatedAt: "2026-10-29T06:00:00.000Z" });
  return {
    generatedAt: "2026-10-29T06:00:00.000Z",
    sources: { github: ok(), jira: ok(), claudeSessions: ok(), learning: ok(), checkins: ok(), calendar: ok(), email: ok() },
    needsYou: [],
    needsYouTotal: 0,
    work: { jira: [], prs: [], ci: [], repoActivity: [], sessionTime: [] },
    learning: { streak: { current: 5, best: 9, started: "2026-10-24" }, cycle: null, agendaThisMonth: [] },
    personal: { checkins: [], checkedInToday: true },
    calendar: [],
    email: [],
    projects: { projects: [], stats: [], untracked: [], hidden: [] },
    notes: { recent: [], status: "ok" },
  };
}

function snap(edit: (s: Snapshot) => void): Snapshot {
  const s = base();
  edit(s);
  return s;
}

const issue = (key: string, dueDate: string | null, extra: Partial<JiraIssue> = {}): JiraIssue => ({
  key, summary: `Summary ${key}`, status: "In Progress", statusCategory: "inprogress", priority: "Medium", dueDate,
  updated: "2026-10-28T09:00:00.000Z", project: "FB", url: `https://qicbizdev.atlassian.net/browse/${key}`, blocked: false,
  ...extra,
});

const pr = (number: number, role: PullRequest["role"], createdAt: string, extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: "islam543/fastbind", number, title: `PR ${number}`, url: `https://github.com/islam543/fastbind/pull/${number}`,
  author: role === "author" ? "islam543" : "someone", role, createdAt, isDraft: false, checks: "pass", ...extra,
});

const run = (status: CiRun["status"], when: string, extra: Partial<CiRun> = {}): CiRun => ({
  repo: "islam543/fastbind", branch: "main", status, url: "https://github.com/islam543/fastbind/actions/runs/1", at: when, ...extra,
});

const event = (id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: "Standup", start, end, ...extra,
});

const withLearning = (s: Snapshot) => {
  s.learning.cycle = { concept: "Event loop", steps: [{ label: "Read", done: true }, { label: "Write the summary", done: false }] };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("test clock sanity", () => {
  it("uses the weekdays the tests assume", () => {
    expect([local(25, 0).getDay(), local(29, 0).getDay(), local(30, 0).getDay(), local(31, 0).getDay()]).toEqual([0, 4, 5, 6]);
  });
});

describe("empty and partial data", () => {
  it("returns nothing for an empty snapshot", () => {
    expect(computeNeedsYou(base(), NOW)).toEqual([]);
    expect(countNeedsYou(base(), NOW)).toBe(0);
  });

  it("never throws on missing slices or a bad date", () => {
    const partial = { sources: { jira: { status: "ok", updatedAt: null } }, work: {} } as unknown as Snapshot;
    expect(computeNeedsYou(partial, NOW)).toEqual([]);
    expect(countNeedsYou(partial, NOW)).toBe(0);
    expect(computeNeedsYou(base(), new Date(Number.NaN))).toEqual([]);
  });

  it("sources that are not connected or never ran contribute nothing", () => {
    for (const status of ["not_connected", "never_run"] as const) {
      const s = snap((x) => {
        x.work.jira = [issue("FB-1", at(-H))];
        x.work.prs = [pr(1, "author", at(-D), { checks: "fail" })];
        x.calendar = [event("e1", at(H), at(2 * H))];
        x.sources.jira.status = status;
        x.sources.github.status = status;
        x.sources.calendar.status = status;
      });
      expect(computeNeedsYou(s, NOW)).toEqual([]);
    }
  });

  it("a source in error still contributes its last good data", () => {
    const s = snap((x) => {
      x.work.jira = [issue("FB-1", at(-H))];
      x.sources.jira = { status: "error", updatedAt: "2026-10-28T06:00:00.000Z", message: "401" };
    });
    expect(computeNeedsYou(s, NOW).map((i) => i.id)).toEqual(["jira:FB-1"]);
  });
});

describe("jira", () => {
  const one = (dueDate: string | null, extra: Partial<JiraIssue> = {}) =>
    computeNeedsYou(snap((x) => { x.work.jira = [issue("FB-1", dueDate, extra)]; }), NOW);

  it("overdue is red", () => {
    expect(one(at(-MIN))).toEqual([{
      id: "jira:FB-1", area: "work", urgency: "red", title: "FB-1 is overdue", detail: "Summary FB-1, was due 1 minute ago",
      url: "https://qicbizdev.atlassian.net/browse/FB-1", dueAt: at(-MIN),
    }]);
  });

  it("due just inside 24 h is red, just outside is amber", () => {
    expect(one(at(24 * H - MIN))[0]).toMatchObject({ urgency: "red", title: "FB-1 due in 23 hours" });
    expect(one(at(24 * H + MIN))[0]).toMatchObject({ urgency: "amber", title: "FB-1 due in 1 day" });
  });

  it("due just inside 72 h is amber, just outside is nothing", () => {
    expect(one(at(72 * H - MIN))[0]).toMatchObject({ urgency: "amber", title: "FB-1 due in 2 days" });
    expect(one(at(72 * H + MIN))).toEqual([]);
  });

  it("blocked is amber even without a due date", () => {
    expect(one(null, { blocked: true })).toEqual([{
      id: "jira:FB-1", area: "work", urgency: "amber", title: "FB-1 is blocked", detail: "Summary FB-1, status In Progress",
      url: "https://qicbizdev.atlassian.net/browse/FB-1",
    }]);
    expect(one(null)).toEqual([]);
  });

  it("blocked and due within 24 h is one red item", () => {
    const items = one(at(2 * H), { blocked: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ urgency: "red", title: "FB-1 due in 2 hours", detail: "Summary FB-1, blocked" });
  });

  it("done issues are ignored", () => {
    expect(one(at(-H), { statusCategory: "done", blocked: true })).toEqual([]);
  });

  it("a due date without a time means the end of that local day", () => {
    expect(one("2026-10-29")[0]).toMatchObject({ urgency: "red", title: "FB-1 due in 11 hours", dueAt: endOfLocalDay(29) });
    expect(one("2026-10-28")[0]).toMatchObject({ urgency: "red", title: "FB-1 is overdue" });
    expect(one("2026-10-30")[0]).toMatchObject({ urgency: "amber", title: "FB-1 due in 1 day", dueAt: endOfLocalDay(30) });
    expect(one("2026-11-02")).toEqual([]);
  });
});

describe("pull requests", () => {
  const prsAt = (...prs: PullRequest[]) => snap((x) => { x.work.prs = prs; });

  it("review request open just under 24 h is nothing, just over is amber", () => {
    expect(computeNeedsYou(prsAt(pr(42, "reviewer", at(-(24 * H - MIN)))), NOW)).toEqual([]);
    expect(computeNeedsYou(prsAt(pr(42, "reviewer", at(-(24 * H + MIN)))), NOW)).toEqual([{
      id: "pr:islam543/fastbind#42", area: "work", urgency: "amber", title: "PR #42 waiting for your review",
      detail: "fastbind, opened 1 day ago", url: "https://github.com/islam543/fastbind/pull/42",
    }]);
  });

  it("review request open just under 72 h is amber, just over is red", () => {
    expect(computeNeedsYou(prsAt(pr(42, "reviewer", at(-(72 * H - MIN)))), NOW)[0]).toMatchObject({ urgency: "amber" });
    expect(computeNeedsYou(prsAt(pr(42, "reviewer", at(-(72 * H + MIN)))), NOW)[0])
      .toMatchObject({ urgency: "red", detail: "fastbind, opened 3 days ago" });
  });

  it("my PR with failing checks is red; passing or pending is nothing", () => {
    expect(computeNeedsYou(prsAt(pr(7, "author", at(-H), { checks: "fail" })), NOW)[0])
      .toMatchObject({ id: "pr:islam543/fastbind#7", urgency: "red", title: "PR #7 has failing checks", detail: "fastbind, opened 1 hour ago" });
    expect(computeNeedsYou(prsAt(pr(7, "author", at(-5 * D), { checks: "pass" })), NOW)).toEqual([]);
    expect(computeNeedsYou(prsAt(pr(7, "author", at(-5 * D), { checks: "pending" })), NOW)).toEqual([]);
  });

  it("failing checks on someone else's PR are not mine", () => {
    expect(computeNeedsYou(prsAt(pr(8, "reviewer", at(-H), { checks: "fail" })), NOW)).toEqual([]);
  });

  it("failing checks and a review request on the same PR merge into one item at the higher urgency", () => {
    const s = prsAt(pr(42, "author", at(-30 * H), { checks: "fail" }), pr(42, "reviewer", at(-30 * H), { checks: "fail" }));
    expect(computeNeedsYou(s, NOW)).toEqual([{
      id: "pr:islam543/fastbind#42", area: "work", urgency: "red",
      title: "PR #42 has failing checks and is waiting for your review",
      detail: "fastbind, opened 1 day ago", url: "https://github.com/islam543/fastbind/pull/42",
    }]);
    expect(countNeedsYou(s, NOW)).toBe(1);
  });

  it("draft PRs never need you: not an old review request, not failing checks", () => {
    const s = prsAt(
      pr(42, "reviewer", at(-5 * D), { isDraft: true }),
      pr(7, "author", at(-H), { isDraft: true, checks: "fail" }),
    );
    expect(computeNeedsYou(s, NOW)).toEqual([]);
    expect(countNeedsYou(s, NOW)).toBe(0);
  });

  it("the same PR number in another repo is a separate item", () => {
    const s = prsAt(pr(1, "author", at(-H), { checks: "fail" }), pr(1, "author", at(-H), { checks: "fail", repo: "islam543/other" }));
    expect(computeNeedsYou(s, NOW).map((i) => i.id).sort()).toEqual(["pr:islam543/fastbind#1", "pr:islam543/other#1"]);
  });
});

describe("ci", () => {
  const ciAt = (...runs: CiRun[]) => computeNeedsYou(snap((x) => { x.work.ci = runs; }), NOW);

  it("a failing run just inside 30 days is amber, just outside is nothing", () => {
    expect(ciAt(run("fail", at(-(30 * D - MIN))))).toEqual([{
      id: "ci:islam543/fastbind", area: "work", urgency: "amber", title: "CI failing on fastbind",
      detail: "main branch, failed 29 days ago", url: "https://github.com/islam543/fastbind/actions/runs/1",
    }]);
    expect(ciAt(run("fail", at(-(30 * D + MIN))))).toEqual([]);
  });

  it("passing or pending runs are nothing", () => {
    expect(ciAt(run("pass", at(-H)), run("pending", at(-H), { repo: "islam543/other" }))).toEqual([]);
  });

  it("only the latest run per repo counts", () => {
    expect(ciAt(run("fail", at(-2 * H)), run("pass", at(-H)))).toEqual([]);
    expect(ciAt(run("pass", at(-2 * H)), run("fail", at(-H)))[0]).toMatchObject({ detail: "main branch, failed 1 hour ago" });
  });
});

describe("calendar", () => {
  const calAt = (...events: CalendarEvent[]) => computeNeedsYou(snap((x) => { x.calendar = events; }), NOW);

  it("an event starting just inside 2 h is red, just outside is nothing", () => {
    expect(calAt(event("e1", at(2 * H - MIN), at(2 * H + 29 * MIN), { url: "https://calendar/e1" }))).toEqual([{
      id: "cal:e1", area: "calendar", urgency: "red", title: "Standup starts in 1 hour",
      detail: "Calendar, 13:59 to 14:29", url: "https://calendar/e1", dueAt: at(2 * H - MIN),
    }]);
    expect(calAt(event("e1", at(2 * H + MIN), at(3 * H)))).toEqual([]);
  });

  it("an event that already started, or an all-day event, is nothing", () => {
    expect(calAt(event("e1", at(-MIN), at(H)))).toEqual([]);
    expect(calAt(event("e2", "2026-10-29", "2026-10-30"))).toEqual([]);
  });

  it("an event starting right now says so", () => {
    expect(calAt(event("e1", at(0), at(H)))[0]).toMatchObject({ title: "Standup starts now" });
  });
});

describe("check-in", () => {
  const notCheckedIn = (edit: (s: Snapshot) => void = () => undefined) =>
    snap((x) => { x.personal.checkedInToday = false; edit(x); });

  it("nothing at 19:59, amber from 20:00 local", () => {
    expect(computeNeedsYou(notCheckedIn(), local(29, 19, 59))).toEqual([]);
    expect(computeNeedsYou(notCheckedIn(), local(29, 20))).toEqual([{
      id: "checkin:2026-10-29", area: "personal", urgency: "amber", title: "No check-in yet today",
      detail: "30 seconds: sleep, energy, mood, workout, spend", dueAt: endOfLocalDay(29),
    }]);
  });

  it("nothing when checked in today", () => {
    expect(computeNeedsYou(base(), local(29, 21))).toEqual([]);
    const listed = notCheckedIn((x) => {
      x.personal.checkins = [{ date: "2026-10-29", sleepHours: 7, energy: 3, mood: 4, workoutMinutes: 0, spendQar: 0 }];
    });
    expect(computeNeedsYou(listed, local(29, 21))).toEqual([]);
  });

  it("nothing unless the checkins source is ok", () => {
    for (const status of ["stale", "error", "not_connected", "never_run"] as const) {
      expect(computeNeedsYou(notCheckedIn((x) => { x.sources.checkins.status = status; }), local(29, 21))).toEqual([]);
    }
  });
});

describe("learning streak", () => {
  const atRisk = (edit: (s: Snapshot) => void = () => undefined) => snap((x) => { withLearning(x); edit(x); });

  it("nothing at 17:59 on a workday, amber from 18:00", () => {
    expect(computeNeedsYou(atRisk(), local(29, 17, 59))).toEqual([]);
    expect(computeNeedsYou(atRisk(), local(29, 18))).toEqual([{
      id: "learning:2026-10-29", area: "learning", urgency: "amber", title: "Learning streak at risk (5 days)",
      detail: "Event loop, next step: Write the summary", dueAt: endOfLocalDay(29),
    }]);
  });

  it("workdays are Sunday to Thursday", () => {
    expect(computeNeedsYou(atRisk(), local(25, 18))[0]).toMatchObject({ id: "learning:2026-10-25" });
    expect(computeNeedsYou(atRisk(), local(30, 18))).toEqual([]);
    expect(computeNeedsYou(atRisk(), local(31, 22))).toEqual([]);
  });

  it("nothing when every step is done or there is no cycle", () => {
    const done = atRisk((x) => { x.learning.cycle = { concept: "Event loop", steps: [{ label: "Read", done: true }] }; });
    expect(computeNeedsYou(done, local(29, 19))).toEqual([]);
    expect(computeNeedsYou(atRisk((x) => { x.learning.cycle = null; }), local(29, 19))).toEqual([]);
  });

  it("nothing unless the learning source is ok", () => {
    expect(computeNeedsYou(atRisk((x) => { x.sources.learning.status = "error"; }), local(29, 19))).toEqual([]);
    expect(computeNeedsYou(atRisk((x) => { x.sources.learning.status = "not_connected"; }), local(29, 19))).toEqual([]);
  });

  it("says 1 day for a streak of one", () => {
    const one = atRisk((x) => { x.learning.streak.current = 1; });
    expect(computeNeedsYou(one, local(29, 19))[0]).toMatchObject({ title: "Learning streak at risk (1 day)" });
  });
});

describe("ranking and cap", () => {
  it("red before amber, then by due time (none last), then title", () => {
    const s = snap((x) => {
      x.work.jira = [
        issue("FB-3", at(48 * H)),
        issue("FB-9", null, { blocked: true }),
        issue("FB-1", at(-D)),
        issue("FB-5", "2026-10-31"),
        issue("FB-4", "2026-10-31"),
      ];
      x.work.prs = [pr(42, "reviewer", at(-30 * H))];
      x.work.ci = [run("fail", at(-H))];
      x.calendar = [event("e1", at(H), at(2 * H))];
    });
    expect(computeNeedsYou(s, NOW).map((i) => i.id)).toEqual([
      "jira:FB-1", // red, overdue
      "cal:e1", // red, in 1 h
      "jira:FB-3", // amber, due in 48 h
      "jira:FB-4", // amber, same due time as FB-5, title first
      "jira:FB-5",
      "ci:islam543/fastbind", // amber, no due time, titles: "CI ..." < "FB-9 ..." < "PR ..."
      "jira:FB-9",
      "pr:islam543/fastbind#42",
    ]);
  });

  it("returns at most 8 and counts them all", () => {
    const s = snap((x) => {
      x.work.jira = Array.from({ length: 11 }, (_, i) => issue(`FB-${i + 1}`, null, { blocked: true }));
      x.work.jira.push(issue("FB-99", at(-H)));
    });
    const items = computeNeedsYou(s, NOW);
    expect(NEEDS_YOU_CAP).toBe(8);
    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({ id: "jira:FB-99", urgency: "red" });
    expect(countNeedsYou(s, NOW)).toBe(12);
  });
});

describe("time comes only from `now`", () => {
  it("ignores the system clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2031, 0, 1, 3, 0));
    const s = snap((x) => {
      x.work.prs = [pr(42, "reviewer", at(-30 * H))];
      x.calendar = [event("e1", at(H), at(2 * H))];
    });
    expect(computeNeedsYou(s, NOW).map((i) => [i.id, i.urgency])).toEqual([["cal:e1", "red"], ["pr:islam543/fastbind#42", "amber"]]);
  });
});

describe("v1.1: project tasks", () => {
  const proj = (extra: Partial<Project> = {}): Project => ({
    id: "fb", name: "FastBind", area: "work", status: "active", deadline: null, description: "", goals: [], tasks: [],
    sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
  });
  const task = (due: string | null, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id: "t1", text: "Write the UAT plan", done: false, due, doneAt: null, createdAt: "2026-10-01T00:00:00.000Z", ...extra,
  });
  const one = (due: string | null, extra: Partial<ProjectTask> = {}, project: Partial<Project> = {}) =>
    computeNeedsYou(snap((x) => { x.projects.projects = [proj({ tasks: [task(due, extra)], ...project })]; }), NOW);

  it("overdue is red, with the project's area and in-app link", () => {
    expect(one(at(-MIN))).toEqual([{
      id: "task:fb:t1", area: "work", urgency: "red", title: "Task overdue: Write the UAT plan",
      detail: "FastBind, was due 1 minute ago", url: "#/projects/fb", dueAt: at(-MIN),
    }]);
  });

  it("due just inside 24 h is red, just outside is amber", () => {
    expect(one(at(24 * H - MIN))[0]).toMatchObject({ urgency: "red", title: "Task due in 23 hours: Write the UAT plan", detail: "FastBind" });
    expect(one(at(24 * H + MIN))[0]).toMatchObject({ urgency: "amber", title: "Task due in 1 day: Write the UAT plan" });
  });

  it("due just inside 72 h is amber, just outside is nothing", () => {
    expect(one(at(72 * H - MIN))[0]).toMatchObject({ urgency: "amber", title: "Task due in 2 days: Write the UAT plan" });
    expect(one(at(72 * H + MIN))).toEqual([]);
  });

  it("a due date means the end of that local day", () => {
    expect(one("2026-10-29")[0]).toMatchObject({ urgency: "red", title: "Task due in 11 hours: Write the UAT plan", dueAt: endOfLocalDay(29) });
    expect(one("2026-10-28")[0]).toMatchObject({ urgency: "red", title: "Task overdue: Write the UAT plan" });
    expect(one("2026-10-31")[0]).toMatchObject({ urgency: "amber" });
    expect(one("2026-11-01")).toEqual([]);
  });

  it("done tasks, tasks without a due date and tasks of projects that are not active are nothing", () => {
    expect(one(at(-H), { done: true, doneAt: at(-H) })).toEqual([]);
    expect(one(null)).toEqual([]);
    for (const status of ["paused", "done", "idea"] as const) expect(one(at(-H), {}, { status })).toEqual([]);
  });

  it("uses the project's area and encodes its id in the link", () => {
    expect(one(at(H), {}, { id: "café 2", area: "learning" })[0]).toMatchObject({
      id: "task:café 2:t1", area: "learning", url: "#/projects/caf%C3%A9%202",
    });
  });

  it("never throws on partial project data", () => {
    const s = snap((x) => {
      x.projects = { projects: [null, { id: "x", status: "active", tasks: null }, { status: "active" }], stats: [], untracked: [], hidden: [] } as unknown as Snapshot["projects"];
    });
    expect(computeNeedsYou(s, NOW)).toEqual([]);
    expect(computeNeedsYou({ ...base(), projects: undefined } as unknown as Snapshot, NOW)).toEqual([]);
  });
});

describe("v1.1: project deadlines", () => {
  const proj = (deadline: string | null, extra: Partial<Project> = {}): Project => ({
    id: "fb", name: "FastBind", area: "work", status: "active", deadline, description: "", goals: [], tasks: [],
    sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
  });
  const one = (deadline: string | null, extra: Partial<Project> = {}) =>
    computeNeedsYou(snap((x) => { x.projects.projects = [proj(deadline, extra)]; }), NOW);
  const openTask: ProjectTask = { id: "t1", text: "x", done: false, due: null, doneAt: null, createdAt: "2026-10-01T00:00:00.000Z" };

  it("passed is red once the deadline day has ended", () => {
    expect(one("2026-10-28", { tasks: [openTask] })).toEqual([{
      id: "deadline:fb", area: "work", urgency: "red", title: "FastBind deadline passed",
      detail: "Was due 12 hours ago, 1 open task", url: "#/projects/fb", dueAt: endOfLocalDay(28),
    }]);
    expect(one("2026-10-29")[0]).toMatchObject({ urgency: "amber", title: "FastBind deadline in 11 hours", detail: "Due 2026-10-29" });
  });

  it("just inside 3 days is amber, just outside is nothing", () => {
    expect(one(at(72 * H - MIN))[0]).toMatchObject({ id: "deadline:fb", urgency: "amber", title: "FastBind deadline in 2 days" });
    expect(one(at(72 * H + MIN))).toEqual([]);
    expect(one("2026-10-31")[0]).toMatchObject({ urgency: "amber", title: "FastBind deadline in 2 days", detail: "Due 2026-10-31" });
    expect(one("2026-11-01")).toEqual([]);
  });

  it("a past deadline on a done, paused or idea project raises nothing", () => {
    for (const status of ["done", "paused", "idea"] as const) expect(one("2026-10-01", { status })).toEqual([]);
    expect(one(null)).toEqual([]);
  });
});

describe("v1.1: open action items in meeting notes", () => {
  const PATH = "Meeting notes/FastBind/2026-10-26-review.md";
  const meeting = (extra: Partial<NoteMeta> = {}): NoteMeta => ({
    path: PATH, section: "Meeting notes/FastBind", title: "Sprint review", created: at(-(2 * D + MIN)), updated: at(-H),
    projectId: null, tags: [], excerpt: "", openActions: 2, ...extra,
  });
  const run = (note: NoteMeta, edit: (s: Snapshot) => void = () => undefined) =>
    computeNeedsYou(snap((x) => { x.notes.recent = [note]; edit(x); }), NOW);

  it("older than 2 days is amber, one item per note", () => {
    expect(run(meeting())).toEqual([{
      id: `note:${PATH}`, area: "personal", urgency: "amber", title: "2 open action items in Sprint review",
      detail: "Meeting notes/FastBind, written 2 days ago", url: "#/notes/Meeting%20notes%2FFastBind%2F2026-10-26-review.md",
    }]);
    expect(run(meeting({ created: at(-(2 * D - MIN)) }))).toEqual([]);
    expect(run(meeting({ openActions: 1 }))[0]).toMatchObject({ title: "1 open action item in Sprint review" });
  });

  it("only meeting-notes sections with open actions count", () => {
    expect(run(meeting({ openActions: 0 }))).toEqual([]);
    expect(run(meeting({ section: "Personal notes", path: "Personal notes/a.md" }))).toEqual([]);
    expect(run(meeting({ section: "Meeting notes", path: "Meeting notes/a.md" }))[0]).toMatchObject({ id: "note:Meeting notes/a.md" });
  });

  it("area is the linked project's area, else personal", () => {
    const linked = run(meeting({ projectId: "fb" }), (x) => {
      x.projects.projects = [{ id: "fb", name: "FastBind", area: "learning", status: "done", deadline: null, description: "", goals: [],
        tasks: [], sources: { sessions: [], repos: [] }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }];
    });
    expect(linked[0]).toMatchObject({ area: "learning", detail: "FastBind, written 2 days ago" });
    expect(run(meeting({ projectId: "gone" }))[0]).toMatchObject({ area: "personal" });
  });

  it("nothing when the notes folder is not connected; last good data on error", () => {
    expect(run(meeting(), (x) => { x.notes.status = "not_connected"; })).toEqual([]);
    expect(run(meeting(), (x) => { x.notes.status = "error"; })).toHaveLength(1);
  });
});
