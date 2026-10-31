import { describe, expect, it } from "vitest";
import type { NeedsYouItem, Project, ProjectsState, Snapshot, SourceState } from "../../../shared/types";
import { dayKey } from "./format";
import {
  alertProjectKeys,
  areaRadius,
  buildLifeGraph,
  createSimulation,
  FIT_EXTENT,
  fitTransform,
  haloFor,
  lastActiveText,
  lastDays,
  MAX_PROJECTS,
  mergeProjects,
  orientationFor,
  placeLabels,
  projectKey,
  projectRadius,
  runToEnd,
  seedLayout,
  selectProjects,
  SETTLE_TICKS,
  simLinks,
  simNodes,
  SIZE,
  truncateLabel,
  type LifeGraph,
  type Orientation,
  type ProjectStat,
} from "./lifeGraph";

// Local-time constructor so the tests do not depend on the machine's timezone.
const now = new Date(2026, 9, 30, 14, 0, 0);
const day = (offset: number) => dayKey(new Date(2026, 9, 30 - offset));

const ok: SourceState = { status: "ok", updatedAt: "2026-10-30T10:00:00Z" };
const off = (message: string): SourceState => ({ status: "not_connected", updatedAt: null, message });

function snapshot(patch: Omit<Partial<Snapshot>, "work"> & { work?: Partial<Snapshot["work"]> } = {}): Snapshot {
  const base: Snapshot = {
    generatedAt: "2026-10-30T10:00:00Z",
    sources: {
      github: ok,
      jira: off("Add JIRA_EMAIL and JIRA_API_TOKEN to .env"),
      claudeSessions: ok,
      learning: ok,
      checkins: ok,
      calendar: off("Connect Google Calendar"),
      email: off("Connect Gmail"),
    },
    needsYou: [],
    needsYouTotal: 0,
    work: { jira: [], prs: [], ci: [], repoActivity: [], sessionTime: [] },
    learning: { streak: { current: 0, best: 0, started: null }, cycle: null, agendaThisMonth: [] },
    personal: { checkins: [], checkedInToday: false },
    calendar: [],
    email: [],
    projects: { projects: [], stats: [], untracked: [], hidden: [] },
    notes: { recent: [], status: "ok" },
  };
  const { work, ...rest } = patch;
  return { ...base, ...rest, work: { ...base.work, ...(work ?? {}) } };
}

const item = (id: string, urgency: "red" | "amber", area: NeedsYouItem["area"] = "work"): NeedsYouItem => ({
  id,
  area,
  urgency,
  title: `Item ${id}`,
  detail: "detail",
});

const stat = (name: string, minutes7d: number, extra: Partial<ProjectStat> = {}): ProjectStat => ({
  key: projectKey(name),
  name,
  aliases: [name],
  sources: ["Claude sessions"],
  minutes7d,
  commits7d: 0,
  lastActive: null,
  ...extra,
});

describe("days", () => {
  it("lists today and the six days before it", () => {
    const days = lastDays(now);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-10-30");
    expect(days[6]).toBe("2026-10-24");
  });

  it("describes the last active day", () => {
    expect(lastActiveText(day(0), now)).toBe("Last active today");
    expect(lastActiveText(day(1), now)).toBe("Last active yesterday");
    expect(lastActiveText(day(12), now)).toBe("Last active 12 days ago");
    expect(lastActiveText(null, now)).toBe("No activity in the last year");
  });
});

describe("name merging", () => {
  it("keys a repo by its name without the owner, ignoring case", () => {
    expect(projectKey("islam543/QIC-FastBind")).toBe("qic-fastbind");
    expect(projectKey("QIC-FastBind")).toBe("qic-fastbind");
    expect(projectKey("  Trading-research ")).toBe("trading-research");
  });

  it("merges a Claude project and a repo that match case-insensitively", () => {
    const merged = mergeProjects(
      [{ project: "QIC-FastBind", minutesByDay: { [day(0)]: 60, [day(2)]: 30, [day(9)]: 500 } }],
      [
        { repo: "islam543/qic-fastbind", commitsByDay: { [day(1)]: 3, [day(20)]: 4 } },
        { repo: "islam543/trades-recon", commitsByDay: { [day(40)]: 2 } },
      ],
      now,
    );
    expect(merged).toHaveLength(2);
    const fastbind = merged.find((p) => p.key === "qic-fastbind")!;
    expect(fastbind.name).toBe("QIC-FastBind"); // the Claude project name wins
    expect(fastbind.minutes7d).toBe(90); // day 9 is outside the 7 days
    expect(fastbind.commits7d).toBe(3);
    expect(fastbind.lastActive).toBe(day(0));
    expect(fastbind.sources).toEqual(["Claude sessions", "GitHub"]);
    expect(fastbind.aliases).toEqual(["QIC-FastBind", "islam543/qic-fastbind"]);

    const recon = merged.find((p) => p.key === "trades-recon")!;
    expect(recon.name).toBe("trades-recon");
    expect(recon.minutes7d).toBe(0);
    expect(recon.lastActive).toBe(day(40));
  });

  it("ignores future days and junk values", () => {
    const merged = mergeProjects(
      [{ project: "A", minutesByDay: { [dayKey(new Date(2026, 10, 2))]: 50, [day(0)]: Number.NaN, [day(1)]: -5 } }],
      [],
      now,
    );
    expect(merged[0].minutes7d).toBe(0);
    expect(merged[0].lastActive).toBeNull();
  });
});

describe("size scale", () => {
  it("keeps a floor so idle projects stay visible", () => {
    expect(projectRadius(0, 300)).toBe(SIZE.projectMin);
    expect(projectRadius(0, 0)).toBe(SIZE.projectMin);
    expect(projectRadius(Number.NaN, 300)).toBe(SIZE.projectMin);
    expect(projectRadius(300, 300)).toBe(SIZE.projectMax);
    expect(projectRadius(900, 300)).toBe(SIZE.projectMax);
  });

  it("grows with minutes on a square-root scale", () => {
    const a = projectRadius(25, 100);
    const b = projectRadius(100, 100);
    expect(a).toBeGreaterThan(SIZE.projectMin);
    expect(a).toBeLessThan(b);
    expect(a).toBeCloseTo(SIZE.projectMin + (SIZE.projectMax - SIZE.projectMin) * 0.5);
  });

  it("uses a fixed active-days scale for areas", () => {
    expect(areaRadius(0)).toBe(SIZE.areaMin);
    expect(areaRadius(7)).toBe(SIZE.areaMax);
    expect(areaRadius(12)).toBe(SIZE.areaMax);
    expect(areaRadius(-3)).toBe(SIZE.areaMin);
    expect(areaRadius(3.5)).toBeCloseTo((SIZE.areaMin + SIZE.areaMax) / 2);
  });
});

describe("halos", () => {
  it("is red when any item is red, amber when only amber", () => {
    expect(haloFor([])).toBeNull();
    expect(haloFor([{ urgency: "amber" }])).toBe("amber");
    expect(haloFor([{ urgency: "amber" }, { urgency: "red" }])).toBe("red");
  });

  it("finds the project of a PR, CI run or Jira item", () => {
    expect(alertProjectKeys({ id: "pr:islam543/AI-Risk-Console#3" }, [])).toEqual(["ai-risk-console"]);
    expect(alertProjectKeys({ id: "ci:islam543/QIC-FastBind" }, [])).toEqual(["qic-fastbind"]);
    const jira = [
      { key: "FB-12", summary: "", status: "", statusCategory: "todo" as const, priority: "", dueDate: null, updated: "", project: "FastBind", url: "", blocked: false },
    ];
    expect(alertProjectKeys({ id: "jira:FB-12" }, jira)).toEqual(["fastbind", "fb"]);
    expect(alertProjectKeys({ id: "checkin:2026-10-30" }, [])).toEqual([]);
  });

  it("puts halos on matching projects and on their area", () => {
    const g = buildLifeGraph(
      snapshot({
        needsYou: [item("pr:islam543/QIC-FastBind#4", "amber"), item("ci:islam543/qic-fastbind", "red"), item("learning:x", "amber", "learning")],
        needsYouTotal: 3,
        work: {
          sessionTime: [
            { project: "QIC-FastBind", minutesByDay: { [day(0)]: 30 } },
            { project: "NFC", minutesByDay: { [day(0)]: 10 } },
          ],
        },
      }),
      now,
    );
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node("project:qic-fastbind").halo).toBe("red");
    expect(node("project:qic-fastbind").alerts).toHaveLength(2);
    expect(node("project:nfc").halo).toBeNull();
    expect(node("area:work").halo).toBe("red");
    expect(node("area:learning").halo).toBe("amber");
    expect(node("area:personal").halo).toBeNull();
    expect(node("center").halo).toBeNull();
    expect(g.totals.needsYou).toBe(3);
  });
});

describe("top projects plus Other", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    project: `p${String(i).padStart(2, "0")}`,
    minutesByDay: { [day(0)]: 600 - i * 10 },
  }));

  it("shows the top 20 by attention and folds the rest into one Other node", () => {
    const g = buildLifeGraph(snapshot({ work: { sessionTime: many } }), now);
    const projects = g.nodes.filter((n) => n.kind === "project");
    expect(projects).toHaveLength(MAX_PROJECTS);
    expect(projects[0].label).toBe("p00");
    expect(projects[MAX_PROJECTS - 1].label).toBe("p19");
    const other = g.nodes.find((n) => n.kind === "other")!;
    expect(other.shortLabel).toBe("+40 more");
    expect(other.parent).toBe("area:work");
    expect(other.area).toBe("work");
    expect(other.radius).toBeLessThanOrEqual(SIZE.projectMax);
    expect(g.otherCount).toBe(40);
    expect(g.projects).toHaveLength(60);
  });

  it("has no Other node at 20 projects or fewer", () => {
    const g = buildLifeGraph(snapshot({ work: { sessionTime: many.slice(0, 20) } }), now);
    expect(g.nodes.some((n) => n.kind === "other")).toBe(false);
    expect(g.otherCount).toBe(0);
  });

  it("keeps a project with a needs-you item out of Other", () => {
    const g = buildLifeGraph(
      snapshot({ needsYou: [item("pr:me/p55#1", "red")], needsYouTotal: 1, work: { sessionTime: many } }),
      now,
    );
    const shown = g.nodes.filter((n) => n.kind === "project");
    expect(shown).toHaveLength(MAX_PROJECTS);
    expect(shown.some((n) => n.label === "p55" && n.halo === "red")).toBe(true);
    expect(shown.some((n) => n.label === "p19")).toBe(false);
  });

  it("ranks by minutes, then commits, then the most recent day", () => {
    const ranked = [stat("a", 0, { lastActive: day(3) }), stat("b", 0, { commits7d: 2 }), stat("c", 5)];
    const { shown, rest } = selectProjects(
      [...ranked].sort((x, y) => (y.minutes7d - x.minutes7d) || (y.commits7d - x.commits7d)),
      () => null,
      2,
    );
    expect(shown.map((p) => p.name)).toEqual(["c", "b"]);
    expect(rest.map((p) => p.name)).toEqual(["a"]);
  });
});

describe("buildLifeGraph", () => {
  it("draws the centre, five areas and links even with no data", () => {
    const g = buildLifeGraph(snapshot(), now, { centerName: "Islam" });
    expect(g.nodes[0]).toMatchObject({ id: "center", label: "Islam", kind: "center" });
    expect(g.nodes.filter((n) => n.kind === "area").map((n) => n.id)).toEqual([
      "area:work",
      "area:learning",
      "area:personal",
      "area:calendar",
      "area:email",
    ]);
    expect(g.nodes.some((n) => n.kind === "project")).toBe(false);
    expect(g.links.filter((l) => l.source === "center")).toHaveLength(5);
  });

  it("draws not-connected areas dashed with what to connect", () => {
    const g = buildLifeGraph(snapshot(), now);
    const cal = g.nodes.find((n) => n.id === "area:calendar")!;
    expect(cal.connected).toBe(false);
    expect(cal.radius).toBe(SIZE.areaMin);
    expect(cal.facts.join(" ")).toContain("Connect Google Calendar");
    expect(g.links.find((l) => l.target === "area:calendar")!.dashed).toBe(true);
    // Work stays connected while GitHub or Claude sessions are, and notes the missing Jira.
    const work = g.nodes.find((n) => n.id === "area:work")!;
    expect(work.connected).toBe(true);
    expect(work.facts.join(" ")).toContain("Add JIRA_EMAIL and JIRA_API_TOKEN to .env");
  });

  it("sizes areas by active days and dims idle nodes", () => {
    const g = buildLifeGraph(
      snapshot({
        work: {
          sessionTime: [{ project: "A", minutesByDay: { [day(0)]: 60, [day(1)]: 60 } }, { project: "B", minutesByDay: { [day(30)]: 60 } }],
          repoActivity: [{ repo: "me/c", commitsByDay: { [day(2)]: 1 } }],
        },
        personal: {
          checkins: [
            { date: day(0), sleepHours: 7, energy: 3, mood: 3, workoutMinutes: 0, spendQar: 0 },
            { date: day(10), sleepHours: 7, energy: 3, mood: 3, workoutMinutes: 0, spendQar: 0 },
          ],
          checkedInToday: true,
        },
      }),
      now,
    );
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node("area:work").radius).toBeCloseTo(areaRadius(3));
    expect(node("area:personal").radius).toBeCloseTo(areaRadius(1));
    expect(node("area:learning").idle).toBe(true);
    expect(node("project:a").idle).toBe(false);
    expect(node("project:b").idle).toBe(true);
    expect(node("project:b").radius).toBe(SIZE.projectMin);
    expect(node("project:c").idle).toBe(false); // commits count as attention
    expect(g.areas.find((a) => a.area === "work")!.headline).toBe("2h");
  });

  it("gives Learning the current concept node", () => {
    const g = buildLifeGraph(
      snapshot({
        learning: {
          streak: { current: 3, best: 9, started: null },
          cycle: { concept: "Inference mechanics", steps: [{ label: "READ", done: true }, { label: "BUILD", done: false }] },
          agendaThisMonth: [],
        },
      }),
      now,
    );
    const concept = g.nodes.find((n) => n.kind === "concept")!;
    expect(concept).toMatchObject({ label: "Inference mechanics", parent: "area:learning", area: "learning" });
    expect(concept.facts).toContain("Next step: BUILD");
    expect(g.areas.find((a) => a.area === "learning")!.headline).toBe("3-day streak");
  });

  it("orders nodes for tabbing: centre, Work and its projects, then the other areas", () => {
    const g = buildLifeGraph(snapshot({ work: { sessionTime: [{ project: "A", minutesByDay: { [day(0)]: 5 } }] } }), now);
    expect(g.nodes.map((n) => n.id).slice(0, 4)).toEqual(["center", "area:work", "project:a", "area:learning"]);
  });

  it("describes every node in one sentence for screen readers", () => {
    const g = buildLifeGraph(
      snapshot({ needsYou: [item("pr:me/A#1", "red")], needsYouTotal: 1, work: { sessionTime: [{ project: "A", minutesByDay: { [day(0)]: 75 } }] } }),
      now,
    );
    const a = g.nodes.find((n) => n.id === "project:a")!;
    expect(a.description).toContain("Work project A.");
    expect(a.description).toContain("1h 15m in the last 7 days.");
    expect(a.description).toContain("1 item needs you: Item pr:me/A#1 (red, act today).");
  });
});

describe("buildLifeGraph with the project registry", () => {
  const project = (
    id: string,
    name: string,
    area: Project["area"],
    sources: Project["sources"],
    status: Project["status"] = "active",
  ): Project => ({
    id,
    name,
    area,
    status,
    deadline: null,
    description: "",
    goals: [],
    tasks: [],
    sources,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  const stats = (id: string, minutesByDay: Record<string, number>, commitsByDay: Record<string, number> = {}) => ({
    id,
    minutesByDay,
    commitsByDay,
    openTasks: 0,
    doneTasks: 0,
    noteCount: 0,
    lastNoteAt: null,
  });
  const registry: ProjectsState = {
    projects: [
      project("fastbind", "FastBind", "work", { sessions: ["QIC-FastBind"], repos: ["islam543/QIC-FastBind"] }),
      project("thesis", "Thesis", "learning", { sessions: ["Thesis"], repos: [] }),
      project("garden", "Garden", "personal", { sessions: [], repos: [] }, "idea"),
      project("old", "Old launch", "work", { sessions: ["Old"], repos: [] }, "done"),
    ],
    stats: [
      stats("fastbind", { [day(0)]: 90, [day(9)]: 400 }, { [day(1)]: 3 }),
      stats("thesis", { [day(2)]: 30 }),
      stats("garden", {}),
      stats("old", { [day(20)]: 50 }),
    ],
    untracked: [
      { name: "Scratch", kind: "session", minutes7d: 20, commits30d: 0, lastSeen: day(1) },
      { name: "islam543/toy", kind: "repo", minutes7d: 0, commits30d: 2, lastSeen: day(3) },
    ],
    hidden: ["Secret"],
  };
  const snap = (patch: Omit<Partial<Snapshot>, "work"> = {}) =>
    snapshot({
      projects: registry,
      work: {
        sessionTime: [
          { project: "QIC-FastBind", minutesByDay: { [day(0)]: 90 } },
          { project: "Thesis", minutesByDay: { [day(2)]: 30 } },
          { project: "Scratch", minutesByDay: { [day(1)]: 20 } },
          { project: "Secret", minutesByDay: { [day(0)]: 999, [day(4)]: 999 } },
        ],
        repoActivity: [
          { repo: "islam543/QIC-FastBind", commitsByDay: { [day(1)]: 3 } },
          { repo: "islam543/toy", commitsByDay: { [day(3)]: 2 } },
        ],
      },
      ...patch,
    });

  it("hangs tracked projects from their registry area, by registry name", () => {
    const g = buildLifeGraph(snap(), now);
    const node = (id: string) => g.nodes.find((n) => n.id === id);
    expect(node("project:fastbind")).toMatchObject({ label: "FastBind", parent: "area:work", area: "work", kindText: "Work project" });
    expect(node("project:thesis")).toMatchObject({ parent: "area:learning", area: "learning", kindText: "Learning project" });
    expect(node("project:garden")).toMatchObject({ parent: "area:personal", idle: true });
    expect(node("project:garden")!.facts).toContain("Idea, not started");
    // FastBind's time comes from its stats (7 days only); its commits count as attention.
    expect(node("project:fastbind")!.facts[0]).toBe("1h 30m in the last 7 days");
    expect(node("project:fastbind")!.facts).toContain("3 commits in the last 7 days");
  });

  it("leaves done projects without recent activity off the map", () => {
    const g = buildLifeGraph(snap(), now);
    expect(g.nodes.some((n) => n.id === "project:old")).toBe(false);
  });

  it("folds untracked names into one Other node under Work and leaves hidden names out", () => {
    const g = buildLifeGraph(snap(), now);
    const other = g.nodes.find((n) => n.id === "other")!;
    expect(other).toMatchObject({ kind: "other", parent: "area:work", shortLabel: "Other (2)", kindText: "Untracked" });
    expect(other.facts).toContain("20m combined in the last 7 days");
    expect(g.nodes.some((n) => n.label.includes("Secret"))).toBe(false);
    expect(g.nodes.some((n) => n.label === "Scratch" || n.label === "toy")).toBe(false);
    // Totals and Work's active days ignore the hidden name's 999 minutes.
    expect(g.totals.minutes7d).toBe(90 + 30 + 20);
    const work = g.areas.find((a) => a.area === "work")!;
    expect(work.headline).toBe("1h 50m"); // FastBind and Other; Thesis is a learning project
    expect(work.activeDays).toBe(3); // today, yesterday (commits, Scratch) and day 3 (toy commits)
    expect(g.areas.find((a) => a.area === "learning")!.facts).toContain("1 project, 30m in the last 7 days");
  });

  it("puts halos on tracked projects by task, deadline, note and repo, and on Other for untracked repos", () => {
    const g = buildLifeGraph(
      snap({
        needsYou: [
          item("task:thesis:ab12cd34", "red", "learning"),
          item("deadline:garden", "amber", "personal"),
          item("note:Meeting notes/2026-10-28-sync.md", "amber", "work"),
          item("pr:islam543/QIC-FastBind#4", "amber"),
          item("ci:islam543/toy", "red"),
        ],
        needsYouTotal: 5,
        notes: {
          recent: [
            {
              path: "Meeting notes/2026-10-28-sync.md",
              section: "Meeting notes",
              title: "Sync",
              created: day(2),
              updated: day(2),
              projectId: "fastbind",
              tags: [],
              excerpt: "",
              openActions: 1,
            },
          ],
          status: "ok",
        },
      }),
      now,
    );
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node("project:thesis").halo).toBe("red");
    expect(node("project:garden").halo).toBe("amber");
    expect(node("project:fastbind").alerts).toHaveLength(2);
    expect(node("other").halo).toBe("red");
  });

  it("folds tracked projects beyond the cap into a +N more node in their area", () => {
    const many: ProjectsState = {
      projects: Array.from({ length: 40 }, (_, i) =>
        project(`p${i}`, `Project ${i}`, i % 2 === 0 ? "work" : "learning", { sessions: [`s${i}`], repos: [] }),
      ),
      stats: Array.from({ length: 40 }, (_, i) => stats(`p${i}`, { [day(0)]: 400 - i })),
      untracked: [],
      hidden: [],
    };
    const g = buildLifeGraph(snapshot({ projects: many }), now);
    expect(g.nodes.filter((n) => n.kind === "project")).toHaveLength(MAX_PROJECTS);
    expect(g.nodes.find((n) => n.id === "more:work")).toMatchObject({ kind: "other", parent: "area:work", shortLabel: "+10 more" });
    expect(g.nodes.find((n) => n.id === "more:learning")).toMatchObject({ parent: "area:learning", shortLabel: "+10 more" });
    expect(g.nodes.some((n) => n.id === "other")).toBe(false);
    expect(g.otherCount).toBe(20);
  });

  it("falls back to detected names while the registry is empty", () => {
    const g = buildLifeGraph(snapshot({ work: { sessionTime: [{ project: "QIC-FastBind", minutesByDay: { [day(0)]: 30 } }] } }), now);
    expect(g.nodes.find((n) => n.id === "project:qic-fastbind")).toMatchObject({ label: "QIC-FastBind", kindText: "Work project" });
  });
});

describe("layout", () => {
  const graph = buildLifeGraph(
    snapshot({
      work: {
        sessionTime: Array.from({ length: 24 }, (_, i) => ({ project: `project-${i}`, minutesByDay: { [day(i % 7)]: 300 - i * 12 } })),
      },
    }),
    now,
  );

  it("settles in about 2 seconds of frames and then stops", () => {
    const seeds = seedLayout(graph, "landscape");
    const sim = createSimulation(simNodes(graph, seeds), simLinks(graph, seeds));
    const ticks = runToEnd(sim);
    expect(ticks).toBeLessThanOrEqual(SETTLE_TICKS + 2);
    expect(sim.alpha()).toBeLessThan(sim.alphaMin());
    for (const n of sim.nodes()) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("is deterministic, so an off-screen run predicts the visible one", () => {
    const seeds = seedLayout(graph, "portrait");
    const a = createSimulation(simNodes(graph, seeds), simLinks(graph, seeds));
    const b = createSimulation(simNodes(graph, seeds), simLinks(graph, seeds));
    runToEnd(a);
    runToEnd(b);
    expect(a.nodes().map((n) => [n.x, n.y])).toEqual(b.nodes().map((n) => [n.x, n.y]));
  });

  it("picks the wide layout only on an ultrawide screen with a stage at least twice as wide as tall", () => {
    expect(orientationFor(600, 800)).toBe("portrait");
    expect(orientationFor(1400, 600)).toBe("landscape");
    expect(orientationFor(2200, 730)).toBe("landscape"); // under 1920px nothing changes
    expect(orientationFor(2200, 730, true)).toBe("wide");
    expect(orientationFor(1500, 800, true)).toBe("landscape"); // ultrawide window, squarer stage
    expect(orientationFor(600, 800, true)).toBe("portrait");
  });

  const settled = (orientation: Orientation, g: LifeGraph = graph) => {
    const seeds = seedLayout(g, orientation);
    const nodes = simNodes(g, seeds);
    const sim = createSimulation(nodes, simLinks(g, seeds));
    const ticks = runToEnd(sim);
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const box = { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    return { nodes, ticks, box };
  };

  it("spreads the wide layout sideways, so the map uses a 21:9 stage", () => {
    const land = settled("landscape");
    const wide = settled("wide");
    expect(wide.box.w / wide.box.h).toBeGreaterThan(land.box.w / land.box.h);
    expect(wide.ticks).toBeLessThanOrEqual(SETTLE_TICKS + 2);
    for (const n of wide.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("keeps nodes apart in the wide layout with one project and with sixteen", () => {
    for (const count of [1, 16]) {
      const g = buildLifeGraph(
        snapshot({
          work: { sessionTime: Array.from({ length: count }, (_, i) => ({ project: `p-${i}`, minutesByDay: { [day(0)]: 200 - i } })) },
        }),
        now,
      );
      const { nodes } = settled("wide", g);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const gap = Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0)) - a.r - b.r;
          expect(gap).toBeGreaterThan(0);
        }
      }
    }
  });

  it("lets the wide layout frame closer than the others", () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    const small = [{ x: 0, y: 0, r: 40 }];
    expect(fitTransform(small, 3000, 1100, none).k).toBe(FIT_EXTENT.landscape[1]);
    expect(fitTransform(small, 3000, 1100, none, FIT_EXTENT.wide).k).toBe(FIT_EXTENT.wide[1]);
    expect(FIT_EXTENT.wide[1]).toBeGreaterThan(FIT_EXTENT.landscape[1]);
  });

  it("frames every node inside the padded box", () => {
    const nodes = [
      { x: -200, y: -50, r: 10 },
      { x: 300, y: 120, r: 20 },
    ];
    const pad = { top: 40, right: 20, bottom: 20, left: 20 };
    const t = fitTransform(nodes, 800, 400, pad);
    for (const n of nodes) {
      expect(t.x + t.k * (n.x - n.r)).toBeGreaterThanOrEqual(pad.left - 0.01);
      expect(t.x + t.k * (n.x + n.r)).toBeLessThanOrEqual(800 - pad.right + 0.01);
      expect(t.y + t.k * (n.y - n.r)).toBeGreaterThanOrEqual(pad.top - 0.01);
      expect(t.y + t.k * (n.y + n.r)).toBeLessThanOrEqual(400 - pad.bottom + 0.01);
    }
  });
});

describe("labels", () => {
  it("keeps labels out of blocked areas such as the map controls", () => {
    const label = { id: "a", x: 100, y: 60, r: 8, width: 60, height: 14, dx: 0, dy: -1, priority: 0 };
    const free = placeLabels([label], [], { width: 400, height: 300 }).get("a")!;
    expect(free.cy).toBeLessThan(60); // prefers the side facing away from its parent: above
    const blocked = placeLabels([label], [], { width: 400, height: 300 }, [{ x0: 0, y0: 0, x1: 400, y1: 50 }]).get("a")!;
    expect(blocked.visible).toBe(true);
    expect(blocked.y0).toBeGreaterThanOrEqual(50);
  });


  it("truncates long names with an ellipsis", () => {
    expect(truncateLabel("qic-presentation-system", 12)).toBe("qic-present…");
    expect(truncateLabel("NFC", 12)).toBe("NFC");
  });

  it("never overlaps two visible labels and always shows a forced one", () => {
    const labels = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      x: 100 + i * 4,
      y: 100,
      r: 6,
      width: 60,
      height: 14,
      dx: 1,
      dy: 0,
      priority: i,
      force: i === 5,
    }));
    const circles = labels.map((l) => ({ id: l.id, x: l.x, y: l.y, r: l.r }));
    const placed = [...placeLabels(labels, circles, { width: 400, height: 300 }).values()];
    const visible = placed.filter((p) => p.visible);
    expect(visible.some((p) => p.id === "n5")).toBe(true);
    expect(visible.length).toBeLessThan(6);
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i];
        const b = visible[j];
        const overlap = a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
        expect(overlap).toBe(false);
      }
    }
  });
});
