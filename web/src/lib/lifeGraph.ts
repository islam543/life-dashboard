import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3";
import type {
  Area,
  JiraIssue,
  NeedsYouItem,
  NoteMeta,
  ProjectArea,
  ProjectsState,
  RepoActivity,
  SessionTime,
  Snapshot,
  SourceState,
  Urgency,
} from "../../../shared/types";
import { areaLabel, dayKey, formatMinutes, plural, sourceLabel, statusLabel, type SourceKey } from "./format";
import { registryReady } from "./timeAgg";

// The life map's data model and layout maths. Pure: no React, no DOM. Unit tested in lifeGraph.test.ts.
//
//   buildLifeGraph(snapshot, now)  nodes and links: "Islam" in the centre, five areas around, tracked
//                                  projects around their registry area (top 20 by attention; the rest
//                                  fold into a "+N more" node per area), untracked active names in one
//                                  "Other" node under Work, hidden names nowhere, and the current
//                                  learning concept beside Learning. Before the server has a registry
//                                  (snapshot.projects empty) it falls back to detected names under Work.
//   seedLayout / createSimulation  deterministic d3-force layout that settles in about 2 s, then stops.
//   fitTransform / placeLabels     framing the settled graph and labels that never overlap.

/** The person at the centre of the map. */
export const CENTER_NAME = "Islam";

/** Project nodes shown around Work; the rest fold into one "Other" node. */
export const MAX_PROJECTS = 20;

/** Area order: also the tab order of the area nodes. */
export const AREAS: readonly Area[] = ["work", "learning", "personal", "calendar", "email"];

/** Sources that feed each area. Work is connected while any of its three is. */
export const AREA_SOURCES: Record<Area, readonly SourceKey[]> = {
  work: ["claudeSessions", "github", "jira"],
  learning: ["learning"],
  personal: ["checkins"],
  calendar: ["calendar"],
  email: ["email"],
};

/** Node radii in world units (screen px at zoom 1). The minimums keep idle nodes visible. */
export const SIZE = {
  center: 34,
  areaMin: 14,
  areaMax: 28,
  projectMin: 7,
  projectMax: 22,
} as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Days

/** The last `count` local days as "YYYY-MM-DD", today first. */
export function lastDays(now: Date, count = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
}

/** Whole local days between a "YYYY-MM-DD" key and `now` (0 = today). NaN for a bad key. */
export function daysAgo(key: string, now: Date): number {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return Number.NaN;
  const then = new Date(y, m - 1, d).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((today - then) / DAY_MS);
}

/** "Last active today", "... yesterday", "... 12 days ago", or "No activity in the last year". */
export function lastActiveText(key: string | null, now: Date): string {
  if (!key) return "No activity in the last year";
  const n = daysAgo(key, now);
  if (!Number.isFinite(n)) return "Last active date unknown";
  if (n <= 0) return "Last active today";
  if (n === 1) return "Last active yesterday";
  return `Last active ${n} days ago`;
}

// ---------------------------------------------------------------------------------------------
// Projects

/**
 * Merge key for a project or repo name: the last path segment, trimmed, lower case.
 * "islam543/QIC-FastBind" and the Claude project "QIC-FastBind" both become "qic-fastbind".
 */
export function projectKey(name: string): string {
  const parts = String(name ?? "")
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export type ProjectSource = "Claude sessions" | "GitHub";

export interface ProjectStat {
  /** Merge key of a detected name, or the registry id of a tracked project. */
  key: string;
  /** Display name: the registry name; before the registry, the Claude project name, else the repo name without its owner. */
  name: string;
  /** Every source name merged into this project, as received. */
  aliases: string[];
  sources: ProjectSource[];
  minutes7d: number;
  commits7d: number;
  /** Last day with session time or commits, "YYYY-MM-DD", or null. */
  lastActive: string | null;
  /** Registry id when the project is tracked. */
  id?: string;
  /** Registry area when tracked; detected names count as Work. */
  area?: ProjectArea;
  /** Registry status when tracked. */
  status?: "active" | "paused" | "done" | "idea";
}

function touch(stat: ProjectStat, day: string) {
  if (!stat.lastActive || day > stat.lastActive) stat.lastActive = day;
}

/** Projects from Claude session time and GitHub commits, merged by name ignoring case. */
export function mergeProjects(
  sessionTime: readonly SessionTime[] | undefined,
  repoActivity: readonly RepoActivity[] | undefined,
  now: Date,
): ProjectStat[] {
  const week = new Set(lastDays(now));
  const today = dayKey(now);
  const byKey = new Map<string, ProjectStat>();

  const statFor = (raw: string, source: ProjectSource): ProjectStat | null => {
    const key = projectKey(raw);
    if (!key) return null;
    let stat = byKey.get(key);
    if (!stat) {
      const segments = raw.trim().split(/[\\/]+/).filter(Boolean);
      stat = {
        key,
        name: segments[segments.length - 1] ?? raw.trim(),
        aliases: [],
        sources: [],
        minutes7d: 0,
        commits7d: 0,
        lastActive: null,
      };
      byKey.set(key, stat);
    }
    if (!stat.aliases.includes(raw)) stat.aliases.push(raw);
    if (!stat.sources.includes(source)) stat.sources.push(source);
    return stat;
  };

  for (const p of sessionTime ?? []) {
    if (!p || typeof p.project !== "string") continue;
    const stat = statFor(p.project, "Claude sessions");
    if (!stat) continue;
    for (const [day, minutes] of Object.entries(p.minutesByDay ?? {})) {
      if (!(typeof minutes === "number" && minutes > 0) || day > today) continue;
      if (week.has(day)) stat.minutes7d += minutes;
      touch(stat, day);
    }
  }

  for (const r of repoActivity ?? []) {
    if (!r || typeof r.repo !== "string") continue;
    const stat = statFor(r.repo, "GitHub");
    if (!stat) continue;
    for (const [day, commits] of Object.entries(r.commitsByDay ?? {})) {
      if (!(typeof commits === "number" && commits > 0) || day > today) continue;
      if (week.has(day)) stat.commits7d += commits;
      touch(stat, day);
    }
  }

  return [...byKey.values()];
}

/** Most attention first: minutes, then commits, then most recently active, then name. */
export function compareProjects(a: ProjectStat, b: ProjectStat): number {
  return (
    b.minutes7d - a.minutes7d ||
    b.commits7d - a.commits7d ||
    (b.lastActive ?? "").localeCompare(a.lastActive ?? "") ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}

const URGENCY_RANK: Record<Urgency, number> = { red: 0, amber: 1 };

/**
 * Which projects get their own node. Up to `max` by attention, but a project with a needs-you item is
 * always shown (a halo hidden inside "Other" would defeat the point). Order follows `ranked`.
 */
export function selectProjects(
  ranked: readonly ProjectStat[],
  haloOf: (key: string) => Urgency | null,
  max = MAX_PROJECTS,
): { shown: ProjectStat[]; rest: ProjectStat[] } {
  if (ranked.length <= max) return { shown: [...ranked], rest: [] };
  const chosen = new Set<string>();
  const urgent = ranked
    .map((p, i) => ({ p, i, halo: haloOf(p.key) }))
    .filter((x) => x.halo !== null)
    .sort((a, b) => URGENCY_RANK[a.halo as Urgency] - URGENCY_RANK[b.halo as Urgency] || a.i - b.i);
  for (const { p } of urgent) {
    if (chosen.size >= max) break;
    chosen.add(p.key);
  }
  for (const p of ranked) {
    if (chosen.size >= max) break;
    chosen.add(p.key);
  }
  return { shown: ranked.filter((p) => chosen.has(p.key)), rest: ranked.filter((p) => !chosen.has(p.key)) };
}

// ---------------------------------------------------------------------------------------------
// Needs-you halos

/** Red when any item is red, amber when there are only amber items, null when none. */
export function haloFor(items: readonly Pick<NeedsYouItem, "urgency">[]): Urgency | null {
  if (items.some((i) => i.urgency === "red")) return "red";
  return items.length > 0 ? "amber" : null;
}

/**
 * Project keys a needs-you item points at, from its id:
 *   "pr:owner/repo#12" and "ci:owner/repo"  -> the repo
 *   "jira:KEY-12"                            -> the issue's Jira project name and its key prefix
 * Other items (calendar, check-in, learning) belong to an area only.
 */
export function alertProjectKeys(item: Pick<NeedsYouItem, "id">, jira: readonly JiraIssue[]): string[] {
  const id = typeof item.id === "string" ? item.id : "";
  if (id.startsWith("pr:")) {
    const body = id.slice(3);
    const hash = body.lastIndexOf("#");
    return [projectKey(hash >= 0 ? body.slice(0, hash) : body)].filter(Boolean);
  }
  if (id.startsWith("ci:")) return [projectKey(id.slice(3))].filter(Boolean);
  if (id.startsWith("jira:")) {
    const issueKey = id.slice(5);
    const keys = new Set<string>();
    const issue = jira.find((i) => i?.key === issueKey);
    if (issue?.project) keys.add(projectKey(issue.project));
    const prefix = issueKey.split("-")[0];
    if (prefix) keys.add(prefix.toLowerCase());
    return [...keys].filter(Boolean);
  }
  return [];
}

/** Needs-you items per project key, for the keys in `known` only. */
export function alertsByProject(
  needsYou: readonly NeedsYouItem[],
  jira: readonly JiraIssue[],
  known: ReadonlySet<string>,
): Map<string, NeedsYouItem[]> {
  const out = new Map<string, NeedsYouItem[]>();
  for (const item of needsYou) {
    if (!item || item.area !== "work") continue;
    for (const key of alertProjectKeys(item, jira)) {
      if (!known.has(key)) continue;
      const list = out.get(key) ?? [];
      if (!list.includes(item)) list.push(item);
      out.set(key, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Projects from the registry

/** Latest day with a value above zero, not after today. */
function lastPositiveDay(byDay: Readonly<Record<string, number>> | undefined, today: string): string | null {
  let last: string | null = null;
  for (const [day, v] of Object.entries(byDay ?? {})) {
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0) || day > today) continue;
    if (!last || day > last) last = day;
  }
  return last;
}

function sumWeek(byDay: Readonly<Record<string, number>> | undefined, week: ReadonlySet<string>): number {
  let sum = 0;
  for (const [day, v] of Object.entries(byDay ?? {})) {
    if (week.has(day) && typeof v === "number" && Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

/**
 * Tracked projects with their 7-day attention (from the server's per-project stats, which already sum
 * every session and repo folded into them), and the untracked detected names merged by name.
 * Done projects stay off the map unless they had activity in the last 7 days. Hidden names are in
 * neither list: the server leaves them out of `untracked` and they belong to no project.
 */
export function registryProjects(
  state: ProjectsState,
  sessionTime: readonly SessionTime[] | undefined,
  repoActivity: readonly RepoActivity[] | undefined,
  now: Date,
): { tracked: ProjectStat[]; untracked: ProjectStat[] } {
  const week = new Set(lastDays(now));
  const today = dayKey(now);
  const statsById = new Map((state.stats ?? []).map((s) => [s.id, s]));
  const tracked: ProjectStat[] = [];
  for (const p of state.projects ?? []) {
    if (!p || typeof p.id !== "string") continue;
    const stats = statsById.get(p.id);
    const sessions = p.sources?.sessions ?? [];
    const repos = p.sources?.repos ?? [];
    const minutes7d = sumWeek(stats?.minutesByDay, week);
    const commits7d = sumWeek(stats?.commitsByDay, week);
    if (p.status === "done" && minutes7d <= 0 && commits7d <= 0) continue;
    const lastMinute = lastPositiveDay(stats?.minutesByDay, today);
    const lastCommit = lastPositiveDay(stats?.commitsByDay, today);
    const sources: ProjectSource[] = [];
    if (sessions.length > 0) sources.push("Claude sessions");
    if (repos.length > 0) sources.push("GitHub");
    tracked.push({
      key: p.id,
      id: p.id,
      name: p.name,
      area: p.area,
      status: p.status,
      aliases: [...sessions, ...repos],
      sources,
      minutes7d,
      commits7d,
      lastActive: lastMinute && lastCommit ? (lastMinute > lastCommit ? lastMinute : lastCommit) : (lastMinute ?? lastCommit),
    });
  }

  const sessionNames = new Set((state.untracked ?? []).filter((d) => d.kind === "session").map((d) => d.name));
  const repoNames = new Set((state.untracked ?? []).filter((d) => d.kind === "repo").map((d) => d.name));
  const untracked = mergeProjects(
    (sessionTime ?? []).filter((s) => s && sessionNames.has(s.project)),
    (repoActivity ?? []).filter((r) => r && repoNames.has(r.repo)),
    now,
  );
  return { tracked, untracked };
}

/** The node key "other" collects needs-you items about untracked names. */
export const OTHER_NODE_KEY = "other";

/**
 * Needs-you items per tracked project id (or OTHER_NODE_KEY for untracked names):
 *   task:<projectId>:<taskId>, deadline:<projectId>     -> that project
 *   note:<path>                                         -> the note's linked project (from recent notes)
 *   pr:, ci:, jira: (Work items)                        -> the project whose name or a source has the same key
 */
export function registryAlerts(
  needsYou: readonly NeedsYouItem[],
  jira: readonly JiraIssue[],
  recentNotes: readonly NoteMeta[],
  tracked: readonly ProjectStat[],
  untracked: readonly ProjectStat[],
): Map<string, NeedsYouItem[]> {
  const ids = new Set(tracked.map((p) => p.key));
  const byKey = new Map<string, string>();
  for (const p of tracked) {
    for (const name of [p.name, ...p.aliases]) {
      const k = projectKey(name);
      if (k && !byKey.has(k)) byKey.set(k, p.key);
    }
  }
  const untrackedKeys = new Set(untracked.map((p) => p.key));
  const notePaths = new Map(recentNotes.filter((n) => n?.projectId).map((n) => [n.path, n.projectId as string]));
  const out = new Map<string, NeedsYouItem[]>();
  const add = (key: string, item: NeedsYouItem) => {
    const list = out.get(key) ?? [];
    if (!list.includes(item)) list.push(item);
    out.set(key, list);
  };

  for (const item of needsYou) {
    if (!item || typeof item.id !== "string") continue;
    const id = item.id;
    if (id.startsWith("task:")) {
      const rest = id.slice(5);
      const cut = rest.lastIndexOf(":");
      const projectId = cut > 0 ? rest.slice(0, cut) : rest;
      if (ids.has(projectId)) add(projectId, item);
      continue;
    }
    if (id.startsWith("deadline:")) {
      const projectId = id.slice(9);
      if (ids.has(projectId)) add(projectId, item);
      continue;
    }
    if (id.startsWith("note:")) {
      const projectId = notePaths.get(id.slice(5));
      if (projectId && ids.has(projectId)) add(projectId, item);
      continue;
    }
    if (item.area !== "work") continue;
    for (const key of alertProjectKeys(item, jira)) {
      const projectId = byKey.get(key);
      if (projectId) add(projectId, item);
      else if (untrackedKeys.has(key)) add(OTHER_NODE_KEY, item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sizes

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Square-root scale (area follows minutes) from projectMin at 0 to projectMax at the busiest project. */
export function projectRadius(minutes: number, maxMinutes: number): number {
  if (!(minutes > 0) || !(maxMinutes > 0)) return SIZE.projectMin;
  const t = clamp(Math.sqrt(minutes / maxMinutes), 0, 1);
  return SIZE.projectMin + (SIZE.projectMax - SIZE.projectMin) * t;
}

/** Fixed scale for areas: active days out of the last 7, from areaMin (0) to areaMax (7). */
export function areaRadius(activeDays: number): number {
  const t = clamp((Number.isFinite(activeDays) ? activeDays : 0) / 7, 0, 1);
  return SIZE.areaMin + (SIZE.areaMax - SIZE.areaMin) * t;
}

// ---------------------------------------------------------------------------------------------
// Areas

export interface AreaStat {
  area: Area;
  /** False when every source of the area is not connected: drawn dashed. */
  connected: boolean;
  /** False until a source of the area has been collected at least once. */
  collected: boolean;
  /** Days with activity in the last 7 (Learning: the current streak, up to 7). Drives the node size. */
  activeDays: number;
  /** Short value for the readout row, e.g. "14h 46m", "3-day streak", "Not connected". */
  headline: string;
  /** True when `headline` is a number (mono type). */
  numeric: boolean;
  /** One line under the headline. */
  sub: string;
  /** Tooltip lines. */
  facts: string[];
  alerts: NeedsYouItem[];
  halo: Urgency | null;
}

function sentence(text: string): string {
  const t = text.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
}

function sourceNotes(sources: Snapshot["sources"] | undefined, keys: readonly SourceKey[]): string[] {
  const notes: string[] = [];
  for (const key of keys) {
    const s: SourceState | undefined = sources?.[key];
    if (!s || s.status === "ok") continue;
    const showMessage = (s.status === "not_connected" || s.status === "error") && s.message;
    notes.push(`${sourceLabel(key)}: ${statusLabel(s.status).toLowerCase()}${showMessage ? `. ${sentence(s.message as string)}` : ""}`);
  }
  return notes;
}

function countDays(dates: Iterable<string>, week: ReadonlySet<string>): number {
  const seen = new Set<string>();
  for (const d of dates) if (week.has(d)) seen.add(d);
  return seen.size;
}

function localDayOf(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dayKey(new Date(t)) : null;
}

function needYouText(n: number): string {
  return n === 1 ? "1 item needs you" : `${n} items need you`;
}

interface AreaInputs {
  snapshot: Snapshot;
  week: ReadonlySet<string>;
  /** Projects counted in this area's numbers (Work: also the untracked names in Other). */
  projects: readonly ProjectStat[];
  /**
   * Work only: days with session time or commits. With a registry, only tracked and untracked series
   * count, so hidden names stay out. Default: every session and repo in the snapshot.
   */
  workDays?: Iterable<string>;
}

/** "2 projects, 3h 10m in the last 7 days" for an area that has tracked projects; null when none. */
function areaProjectsFact(projects: readonly ProjectStat[]): string | null {
  if (projects.length === 0) return null;
  const minutes = projects.reduce((s, p) => s + p.minutes7d, 0);
  return `${plural(projects.length, "project")}, ${minutes > 0 ? `${formatMinutes(minutes)} in the last 7 days` : "no time in the last 7 days"}`;
}

export function areaStat(area: Area, { snapshot, week, projects, workDays }: AreaInputs): AreaStat {
  const keys = AREA_SOURCES[area];
  const states = keys.map((k) => snapshot.sources?.[k]).filter((s): s is SourceState => !!s);
  const connected = states.length === 0 || states.some((s) => s.status !== "not_connected");
  const collected = states.some((s) => s.status !== "not_connected" && s.status !== "never_run");
  const alerts = (snapshot.needsYou ?? []).filter((i) => i?.area === area);
  const notes = sourceNotes(snapshot.sources, keys);
  const label = areaLabel(area);

  const base = { area, connected, collected, alerts, halo: haloFor(alerts) };

  if (!connected) {
    const message = states.find((s) => s.message)?.message;
    const what = message ? sentence(message) : `Connect ${label} to see it here.`;
    return { ...base, activeDays: 0, headline: "Not connected", numeric: false, sub: what, facts: [`Not connected. ${what}`] };
  }
  if (!collected) {
    return {
      ...base,
      activeDays: 0,
      headline: "Not collected yet",
      numeric: false,
      sub: "Collected on the next refresh.",
      facts: ["Not collected yet. Use Refresh at the top to collect now."],
    };
  }

  switch (area) {
    case "work": {
      const days = new Set<string>(workDays ?? []);
      if (!workDays) {
        for (const p of snapshot.work?.sessionTime ?? []) {
          for (const [d, m] of Object.entries(p?.minutesByDay ?? {})) if (typeof m === "number" && m > 0) days.add(d);
        }
        for (const r of snapshot.work?.repoActivity ?? []) {
          for (const [d, c] of Object.entries(r?.commitsByDay ?? {})) if (typeof c === "number" && c > 0) days.add(d);
        }
      }
      const activeDays = countDays(days, week);
      const minutes = projects.reduce((sum, p) => sum + p.minutes7d, 0);
      const active = projects.filter((p) => p.minutes7d > 0 || p.commits7d > 0).length;
      const timeLine =
        minutes > 0
          ? `${formatMinutes(minutes)} across ${plural(active, "active project")}`
          : active > 0
            ? `${plural(active, "project")} with commits, no tracked time`
            : "No tracked time in the last 7 days";
      return {
        ...base,
        activeDays,
        headline: formatMinutes(minutes),
        numeric: true,
        sub: `${plural(active, "active project")}, ${activeDays} of 7 days`,
        facts: [timeLine, `Active ${activeDays} of 7 days`, ...notes],
      };
    }
    case "learning": {
      const learning = snapshot.learning;
      const current = Math.max(0, Math.floor(learning?.streak?.current ?? 0));
      const best = Math.max(0, Math.floor(learning?.streak?.best ?? 0));
      const cycle = learning?.cycle ?? null;
      const done = cycle ? cycle.steps.filter((s) => s.done).length : 0;
      const total = cycle ? cycle.steps.length : 0;
      const conceptLine = cycle ? `${cycle.concept}, ${done} of ${total} steps` : "No current concept";
      const projectLine = areaProjectsFact(projects);
      return {
        ...base,
        activeDays: Math.min(current, 7),
        headline: current > 0 ? `${current}-day streak` : "No streak",
        numeric: current > 0,
        sub: conceptLine,
        facts: [
          current > 0 ? `Streak: ${plural(current, "day")} (best ${plural(best, "day")})` : `No streak right now (best ${plural(best, "day")})`,
          cycle ? `Concept: ${conceptLine}` : "No current concept",
          ...(projectLine ? [projectLine] : []),
          ...notes,
        ],
      };
    }
    case "personal": {
      const checkins = snapshot.personal?.checkins ?? [];
      const activeDays = countDays(
        checkins.map((c) => c?.date).filter((d): d is string => typeof d === "string"),
        week,
      );
      const today = snapshot.personal?.checkedInToday ? "Checked in today" : "No check-in yet today";
      const projectLine = areaProjectsFact(projects);
      return {
        ...base,
        activeDays,
        headline: plural(activeDays, "check-in"),
        numeric: true,
        sub: activeDays > 0 ? `${activeDays} of the last 7 days` : "None in the last 7 days",
        facts: [`Checked in ${activeDays} of the last 7 days`, today, ...(projectLine ? [projectLine] : []), ...notes],
      };
    }
    case "calendar":
    case "email": {
      const isCal = area === "calendar";
      const stamps = isCal
        ? (snapshot.calendar ?? []).map((e) => e?.start)
        : (snapshot.email ?? []).map((e) => e?.receivedAt);
      const inWeek = stamps
        .map((s) => (typeof s === "string" ? localDayOf(s) : null))
        .filter((d): d is string => d !== null && week.has(d));
      const activeDays = new Set(inWeek).size;
      const count = plural(inWeek.length, isCal ? "event" : "email");
      return {
        ...base,
        activeDays,
        headline: count,
        numeric: true,
        sub: isCal ? "In the last 7 days" : "Received in the last 7 days",
        facts: [`${count} in the last 7 days, on ${plural(activeDays, "day")}`, ...notes],
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The graph

export type NodeKind = "center" | "area" | "project" | "concept" | "other";

export interface LifeNode {
  /** "center", "area:work", "project:<key>", "concept", "other". */
  id: string;
  kind: NodeKind;
  /** Full name. Labels on the map truncate it; the tooltip shows it whole. */
  label: string;
  /** Short label drawn on the map (before truncation): "WORK", "+43 more". */
  shortLabel: string;
  /** Area whose detail view a click opens; null for the centre (which resets the view). */
  area: Area | null;
  parent: string | null;
  radius: number;
  /** No activity in the last 7 days: drawn small and dim. */
  idle: boolean;
  /** False for an area whose sources are not connected: drawn dashed. */
  connected: boolean;
  halo: Urgency | null;
  alerts: NeedsYouItem[];
  /** Small caps line above the tooltip title: "Area", "Work project". */
  kindText: string;
  /** Tooltip lines. */
  facts: string[];
  /** One paragraph for the accessible name and the hidden list. */
  description: string;
  /** Attention used for label priority: minutes for projects, active days for areas. */
  weight: number;
}

export interface LifeLink {
  id: string;
  source: string;
  target: string;
  dashed: boolean;
  idle: boolean;
}

export interface LifeGraph {
  nodes: LifeNode[];
  links: LifeLink[];
  areas: AreaStat[];
  /** Every merged project, ranked, including those folded into "Other". */
  projects: ProjectStat[];
  /** Projects inside "Other" (0 when there is no Other node). */
  otherCount: number;
  totals: { minutes7d: number; activeAreas: number; needsYou: number };
}

function alertsSentence(alerts: readonly NeedsYouItem[]): string {
  if (alerts.length === 0) return "";
  const list = alerts.map((a) => `${a.title} (${a.urgency === "red" ? "red, act today" : "amber, this week"})`).join("; ");
  return ` ${needYouText(alerts.length)}: ${list}.`;
}

function describe(name: string, facts: readonly string[], alerts: readonly NeedsYouItem[]): string {
  return `${name}. ${facts.map(sentence).join(" ")}${alertsSentence(alerts)}`.trim();
}

const STATUS_WORD: Record<NonNullable<ProjectStat["status"]>, string> = {
  active: "Active",
  paused: "Paused",
  idea: "Idea, not started",
  done: "Done",
};

function projectFacts(p: ProjectStat, now: Date): string[] {
  const facts = [p.minutes7d > 0 ? `${formatMinutes(p.minutes7d)} in the last 7 days` : "No time in the last 7 days"];
  if (p.commits7d > 0) facts.push(`${plural(p.commits7d, "commit")} in the last 7 days`);
  facts.push(lastActiveText(p.lastActive, now));
  facts.push(p.sources.length > 0 ? `From ${p.sources.join(" and ")}` : "No sessions or repos linked yet");
  if (p.status && p.status !== "active") facts.push(STATUS_WORD[p.status]);
  return facts;
}

function addActiveDays(days: Set<string>, byDay: Readonly<Record<string, number>> | undefined): void {
  for (const [d, v] of Object.entries(byDay ?? {})) if (typeof v === "number" && v > 0) days.add(d);
}

export interface BuildOptions {
  maxProjects?: number;
  centerName?: string;
}

/** Areas a project node can hang from. */
const PROJECT_AREAS: readonly Area[] = ["work", "learning", "personal"];

/**
 * Nodes and links for the life map. Node order is the tab order: centre, then each area followed by
 * its projects (Work first).
 */
export function buildLifeGraph(snapshot: Snapshot, now: Date, opts: BuildOptions = {}): LifeGraph {
  const maxProjects = opts.maxProjects ?? MAX_PROJECTS;
  const centerName = opts.centerName ?? CENTER_NAME;
  const week = new Set(lastDays(now));
  const jira = snapshot.work?.jira ?? [];
  const needsYou = (snapshot.needsYou ?? []).filter(Boolean);
  const registry = registryReady(snapshot.projects) ? snapshot.projects : null;

  let ranked: ProjectStat[];
  let untracked: ProjectStat[] = [];
  let projectAlerts: Map<string, NeedsYouItem[]>;
  let workDays: Set<string> | undefined;
  if (registry) {
    const found = registryProjects(registry, snapshot.work?.sessionTime, snapshot.work?.repoActivity, now);
    ranked = found.tracked.sort(compareProjects);
    untracked = found.untracked.sort(compareProjects);
    projectAlerts = registryAlerts(needsYou, jira, snapshot.notes?.recent ?? [], ranked, untracked);
    // Work's active days: its tracked projects and the untracked names only, so hidden names never count.
    workDays = new Set<string>();
    const statsById = new Map(registry.stats.map((s) => [s.id, s]));
    for (const p of ranked) {
      if ((p.area ?? "work") !== "work") continue;
      addActiveDays(workDays, statsById.get(p.key)?.minutesByDay);
      addActiveDays(workDays, statsById.get(p.key)?.commitsByDay);
    }
    const sessionNames = new Set(registry.untracked.filter((d) => d.kind === "session").map((d) => d.name));
    const repoNames = new Set(registry.untracked.filter((d) => d.kind === "repo").map((d) => d.name));
    for (const s of snapshot.work?.sessionTime ?? []) if (s && sessionNames.has(s.project)) addActiveDays(workDays, s.minutesByDay);
    for (const r of snapshot.work?.repoActivity ?? []) if (r && repoNames.has(r.repo)) addActiveDays(workDays, r.commitsByDay);
  } else {
    ranked = mergeProjects(snapshot.work?.sessionTime, snapshot.work?.repoActivity, now).sort(compareProjects);
    projectAlerts = alertsByProject(needsYou, jira, new Set(ranked.map((p) => p.key)));
  }

  const haloOf = (key: string) => haloFor(projectAlerts.get(key) ?? []);
  const { shown, rest } = selectProjects(ranked, haloOf, maxProjects);
  const everything = [...ranked, ...untracked];
  const maxMinutes = everything.reduce((m, p) => Math.max(m, p.minutes7d), 0);
  const areaOf = (p: ProjectStat): Area => p.area ?? "work";

  const projectsFor = (area: Area): ProjectStat[] => {
    if (!registry) return area === "work" ? ranked : [];
    const own = ranked.filter((p) => areaOf(p) === area);
    return area === "work" ? [...own, ...untracked] : own;
  };
  const areas = AREAS.map((area) =>
    areaStat(area, { snapshot, week, projects: projectsFor(area), workDays: area === "work" ? workDays : undefined }),
  );
  const minutes7d = everything.reduce((s, p) => s + p.minutes7d, 0);
  const activeAreas = areas.filter((a) => a.activeDays > 0).length;
  const needsYouTotal = Math.max(snapshot.needsYouTotal ?? 0, needsYou.length);

  const nodes: LifeNode[] = [];
  const links: LifeLink[] = [];

  const centerFacts = [
    minutes7d > 0 ? `${formatMinutes(minutes7d)} of tracked work in the last 7 days` : "No tracked work time in the last 7 days",
    `${activeAreas} of ${AREAS.length} areas active`,
    needsYouTotal > 0 ? needYouText(needsYouTotal) : "Nothing needs you right now",
  ];
  nodes.push({
    id: "center",
    kind: "center",
    label: centerName,
    shortLabel: centerName,
    area: null,
    parent: null,
    radius: SIZE.center,
    idle: false,
    connected: true,
    halo: null,
    alerts: [],
    kindText: "You",
    facts: centerFacts,
    description: describe(`${centerName}, centre of the map`, centerFacts, []),
    weight: Number.POSITIVE_INFINITY,
  });

  /** A node that stands for several projects or names: "+N more" or "Other". */
  const groupNode = (
    id: string,
    group: readonly ProjectStat[],
    area: Area,
    parent: string,
    text: { label: string; shortLabel: string; kindText: string; lead: string; what: string; trailing?: string },
  ) => {
    const minutes = group.reduce((s, p) => s + p.minutes7d, 0);
    const active = group.filter((p) => p.minutes7d > 0 || p.commits7d > 0).length;
    const alerts = group.flatMap((p) => projectAlerts.get(p.key) ?? []);
    if (id === OTHER_NODE_KEY && registry) {
      for (const a of projectAlerts.get(OTHER_NODE_KEY) ?? []) if (!alerts.includes(a)) alerts.push(a);
    }
    const names = group.slice(0, 3).map((p) => p.name);
    const facts = [
      text.lead,
      minutes > 0 ? `${formatMinutes(minutes)} combined in the last 7 days` : "No time in the last 7 days",
      active > 0 ? `${active} of them active` : "None active in the last 7 days",
      `Includes ${names.join(", ")}${group.length > names.length ? " and more" : ""}`,
      ...(text.trailing ? [text.trailing] : []),
    ];
    nodes.push({
      id,
      kind: "other",
      label: text.label,
      shortLabel: text.shortLabel,
      area,
      parent,
      radius: Math.min(SIZE.projectMax, projectRadius(minutes, maxMinutes)),
      idle: active === 0,
      connected: true,
      halo: haloFor(alerts),
      alerts,
      kindText: text.kindText,
      facts,
      description: describe(text.what, facts, alerts),
      weight: minutes,
    });
    links.push({ id: `${parent}>${id}`, source: parent, target: id, dashed: false, idle: active === 0 });
  };

  for (const stat of areas) {
    const areaId = `area:${stat.area}`;
    const label = areaLabel(stat.area);
    nodes.push({
      id: areaId,
      kind: "area",
      label,
      shortLabel: label.toUpperCase(),
      area: stat.area,
      parent: "center",
      radius: stat.connected ? areaRadius(stat.activeDays) : SIZE.areaMin,
      idle: stat.connected && stat.activeDays === 0,
      connected: stat.connected,
      halo: stat.halo,
      alerts: stat.alerts,
      kindText: "Area",
      facts: stat.facts,
      description: describe(`${label} area`, stat.facts, stat.alerts),
      weight: stat.activeDays,
    });
    links.push({ id: `center>${areaId}`, source: "center", target: areaId, dashed: !stat.connected, idle: stat.activeDays === 0 });

    if (PROJECT_AREAS.includes(stat.area)) {
      for (const p of shown.filter((x) => areaOf(x) === stat.area)) {
        const alerts = projectAlerts.get(p.key) ?? [];
        const facts = projectFacts(p, now);
        const id = `project:${p.key}`;
        const kindText = `${label} project`;
        nodes.push({
          id,
          kind: "project",
          label: p.name,
          shortLabel: p.name,
          area: stat.area,
          parent: areaId,
          radius: projectRadius(p.minutes7d, maxMinutes),
          idle: p.minutes7d <= 0 && p.commits7d <= 0,
          connected: true,
          halo: haloFor(alerts),
          alerts,
          kindText,
          facts,
          description: describe(`${kindText} ${p.name}`, facts, alerts),
          weight: p.minutes7d + p.commits7d / 1000,
        });
        links.push({ id: `${areaId}>${id}`, source: areaId, target: id, dashed: false, idle: p.minutes7d <= 0 && p.commits7d <= 0 });
      }

      const overflow = rest.filter((x) => areaOf(x) === stat.area);
      if (overflow.length > 0) {
        if (registry) {
          groupNode(`more:${stat.area}`, overflow, stat.area, areaId, {
            label: `More ${label.toLowerCase()} projects (${overflow.length})`,
            shortLabel: `+${overflow.length} more`,
            kindText: `${label} projects`,
            lead: `${plural(overflow.length, "more project")}, grouped`,
            what: `More ${label.toLowerCase()} projects`,
          });
        } else {
          groupNode(OTHER_NODE_KEY, overflow, stat.area, areaId, {
            label: `Other projects (${overflow.length})`,
            shortLabel: `+${overflow.length} more`,
            kindText: "Work projects",
            lead: `${plural(overflow.length, "more project")}, grouped`,
            what: "Other work projects",
          });
        }
      }

      if (registry && stat.area === "work" && untracked.length > 0) {
        groupNode(OTHER_NODE_KEY, untracked, "work", areaId, {
          label: `Other (${plural(untracked.length, "untracked name")})`,
          shortLabel: `Other (${untracked.length})`,
          kindText: "Untracked",
          lead: `${plural(untracked.length, "detected name")} in no project`,
          what: "Other, untracked work",
          trailing: "Track or hide them on the Projects page",
        });
      }
    }

    if (stat.area === "learning" && stat.collected && snapshot.learning?.cycle) {
      const cycle = snapshot.learning.cycle;
      const steps = Array.isArray(cycle.steps) ? cycle.steps : [];
      const done = steps.filter((s) => s.done).length;
      const next = steps.find((s) => !s.done);
      const facts = [
        `${done} of ${steps.length} steps done`,
        next ? `Next step: ${next.label}` : "Every step done",
      ];
      const ratio = steps.length > 0 ? done / steps.length : 0;
      nodes.push({
        id: "concept",
        kind: "concept",
        label: cycle.concept,
        shortLabel: cycle.concept,
        area: "learning",
        parent: areaId,
        radius: SIZE.projectMin + (SIZE.projectMax - SIZE.projectMin) * Math.sqrt(ratio),
        idle: done === 0,
        connected: true,
        halo: null,
        alerts: [],
        kindText: "Current concept",
        facts,
        description: describe(`Current learning concept ${cycle.concept}`, facts, []),
        weight: ratio,
      });
      links.push({ id: `${areaId}>concept`, source: areaId, target: "concept", dashed: false, idle: done === 0 });
    }
  }

  return {
    nodes,
    links,
    areas,
    projects: everything,
    otherCount: rest.length + untracked.length,
    totals: { minutes7d, activeAreas, needsYou: needsYouTotal },
  };
}

/** Changes whenever something the map draws changes (used to decide when to re-run the layout). */
export function graphSignature(graph: LifeGraph): string {
  return graph.nodes
    .map((n) => `${n.id}:${n.radius.toFixed(1)}:${n.halo ?? "-"}:${n.idle ? 1 : 0}:${n.connected ? 1 : 0}:${n.label}`)
    .join("|");
}

/** "qic-presentation-system" -> "qic-presentati..." (with a real ellipsis) when longer than `max`. */
export function truncateLabel(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------
// Layout: seeds and the force simulation

export type Orientation = "landscape" | "portrait";

export interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
  r: number;
  parent: string | null;
  seedX: number;
  seedY: number;
  /** Dropped here by a drag; stays until Reset view. */
  pinned?: boolean;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  distance: number;
  strength: number;
}

const DEG = Math.PI / 180;

/** Work gets the biggest open side, the other areas share the opposite side. Degrees, y points down. */
const AREA_ANGLE: Record<Orientation, Record<Area, number>> = {
  landscape: { work: 180, learning: -62, personal: -18, calendar: 26, email: 70 },
  portrait: { work: -90, learning: 150, personal: 115, calendar: 65, email: 30 },
};

const AREA_DISTANCE = 190;

/** Seeds sit on an ellipse stretched along the stage's long side, so the settled map fills a wide screen. */
const STRETCH: Record<Orientation, { x: number; y: number }> = {
  landscape: { x: 1.45, y: 1 },
  portrait: { x: 1, y: 1.3 },
};

/** Where each node wants to sit. Deterministic, so the map looks the same on every visit. */
export function seedLayout(graph: LifeGraph, orientation: Orientation): Map<string, { x: number; y: number }> {
  const seeds = new Map<string, { x: number; y: number }>();
  const stretch = STRETCH[orientation];
  seeds.set("center", { x: 0, y: 0 });
  const children = new Map<string, LifeNode[]>();
  for (const n of graph.nodes) {
    if (!n.parent || n.parent === "center") continue;
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }

  for (const area of graph.nodes.filter((n) => n.kind === "area")) {
    const angle = AREA_ANGLE[orientation][area.area as Area] * DEG;
    const kids = children.get(area.id) ?? [];
    const dist = AREA_DISTANCE + Math.min(110, kids.length * 5);
    const ax = Math.cos(angle) * dist * stretch.x;
    const ay = Math.sin(angle) * dist * stretch.y;
    seeds.set(area.id, { x: ax, y: ay });

    // Children fan out away from the centre: biggest in the middle of the arc, inner ring first.
    const n = kids.length;
    if (n === 0) continue;
    const innerCount = Math.min(n, 9);
    const rings = [kids.slice(0, innerCount), kids.slice(innerCount)];
    rings.forEach((ring, ringIndex) => {
      const m = ring.length;
      if (m === 0) return;
      const span = Math.min(300, 50 + m * (ringIndex === 0 ? 26 : 22)) * DEG;
      const step = m > 1 ? span / (m - 1) : 0;
      const dist2 = area.radius + (ringIndex === 0 ? 78 : 150);
      ring.forEach((kid, i) => {
        const slot = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
        const offset = m > 1 ? slot * step + (m % 2 === 0 ? step / 2 : 0) : 0;
        const a = angle + offset + (ringIndex === 1 ? step / 2 : 0);
        seeds.set(kid.id, { x: ax + Math.cos(a) * dist2 * stretch.x, y: ay + Math.sin(a) * dist2 * stretch.y });
      });
    });
  }
  return seeds;
}

/** Simulation nodes, starting compressed toward their parent so the map blooms outward. */
export function simNodes(
  graph: LifeGraph,
  seeds: ReadonlyMap<string, { x: number; y: number }>,
  from: ReadonlyMap<string, { x: number; y: number; fx?: number | null; fy?: number | null; pinned?: boolean }> | null = null,
  bloom = 0.35,
): SimNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const start = new Map<string, { x: number; y: number }>();
  const startOf = (id: string): { x: number; y: number } => {
    const known = start.get(id);
    if (known) return known;
    const seed = seeds.get(id) ?? { x: 0, y: 0 };
    const node = byId.get(id);
    const parentStart = node?.parent ? startOf(node.parent) : { x: 0, y: 0 };
    const parentSeed = node?.parent ? (seeds.get(node.parent) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    const p = { x: parentStart.x + (seed.x - parentSeed.x) * bloom, y: parentStart.y + (seed.y - parentSeed.y) * bloom };
    start.set(id, p);
    return p;
  };

  return graph.nodes.map((n) => {
    const seed = seeds.get(n.id) ?? { x: 0, y: 0 };
    const prev = from?.get(n.id);
    const p = prev ?? startOf(n.id);
    const node: SimNode = { id: n.id, kind: n.kind, r: n.radius, parent: n.parent, seedX: seed.x, seedY: seed.y, x: p.x, y: p.y };
    if (n.kind === "center") {
      node.x = 0;
      node.y = 0;
      node.fx = 0;
      node.fy = 0;
    } else if (prev?.pinned) {
      node.fx = prev.fx ?? prev.x;
      node.fy = prev.fy ?? prev.y;
      node.pinned = true;
    }
    return node;
  });
}

/** Links with a rest length equal to the seeded distance, so forces refine the seed instead of fighting it. */
export function simLinks(graph: LifeGraph, seeds: ReadonlyMap<string, { x: number; y: number }>): SimLink[] {
  return graph.links.map((l) => {
    const a = seeds.get(l.source) ?? { x: 0, y: 0 };
    const b = seeds.get(l.target) ?? { x: 0, y: 0 };
    const distance = Math.max(40, Math.hypot(b.x - a.x, b.y - a.y));
    return { source: l.source, target: l.target, distance, strength: l.source === "center" ? 0.6 : 0.45 };
  });
}

/** Alpha falls from 1 to ALPHA_MIN in about 120 ticks: about 2 s at 60 frames a second. */
export const ALPHA_MIN = 0.001;
export const SETTLE_TICKS = 120;
export const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / SETTLE_TICKS);

const CHARGE: Record<NodeKind, number> = { center: -420, area: -260, project: -46, concept: -60, other: -60 };
const COLLIDE_PAD: Record<NodeKind, number> = { center: 26, area: 22, project: 11, concept: 14, other: 14 };

/**
 * A stopped simulation. Same inputs give the same result (d3 seeds its own random source), so a copy can
 * be run to the end off screen to frame the view before the visible one animates to the same place.
 */
export function createSimulation(nodes: SimNode[], links: SimLink[], alpha = 1): Simulation<SimNode, SimLink> {
  return forceSimulation<SimNode, SimLink>(nodes)
    .stop()
    .alpha(alpha)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(0.45)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((l) => l.distance)
        .strength((l) => l.strength),
    )
    .force(
      "charge",
      forceManyBody<SimNode>()
        .strength((d) => CHARGE[d.kind] - d.r * 2)
        .distanceMax(360),
    )
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => d.r + COLLIDE_PAD[d.kind])
        .strength(0.9)
        .iterations(2),
    )
    .force("x", forceX<SimNode>((d) => d.seedX).strength((d) => (d.kind === "area" ? 0.09 : 0.03)))
    .force("y", forceY<SimNode>((d) => d.seedY).strength((d) => (d.kind === "area" ? 0.09 : 0.03)));
}

/** Runs a stopped simulation until it settles. Returns the number of ticks. */
export function runToEnd(sim: Simulation<SimNode, SimLink>, maxTicks = 600): number {
  let ticks = 0;
  while (sim.alpha() >= sim.alphaMin() && ticks < maxTicks) {
    sim.tick();
    ticks++;
  }
  return ticks;
}

// ---------------------------------------------------------------------------------------------
// Framing and labels

export interface View {
  k: number;
  x: number;
  y: number;
}

export interface Pad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Zoom limits for wheel and buttons, and the narrower range the automatic framing may pick. */
export const ZOOM_EXTENT: [number, number] = [0.25, 3];
const FIT_EXTENT: [number, number] = [0.3, 1.25];

/** Node radius on screen grows with the square root of the zoom, so zooming out keeps nodes visible. */
export function nodeScale(k: number): number {
  return clamp(Math.sqrt(k), 0.7, 1.5);
}

/** Translate and scale that fit every node (with its radius) inside `width` x `height` minus `pad`. */
export function fitTransform(
  nodes: readonly { x?: number; y?: number; r: number }[],
  width: number,
  height: number,
  pad: Pad,
): View {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    x0 = Math.min(x0, x - n.r);
    y0 = Math.min(y0, y - n.r);
    x1 = Math.max(x1, x + n.r);
    y1 = Math.max(y1, y + n.r);
  }
  if (!Number.isFinite(x0)) return { k: 1, x: width / 2, y: height / 2 };
  const availW = Math.max(1, width - pad.left - pad.right);
  const availH = Math.max(1, height - pad.top - pad.bottom);
  const k = clamp(Math.min(availW / Math.max(1, x1 - x0), availH / Math.max(1, y1 - y0)), FIT_EXTENT[0], FIT_EXTENT[1]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { k, x: pad.left + availW / 2 - k * cx, y: pad.top + availH / 2 - k * cy };
}

export interface LabelInput {
  id: string;
  /** Node centre and radius on screen. */
  x: number;
  y: number;
  r: number;
  width: number;
  height: number;
  /** Unit-ish vector pointing away from the node's parent: labels prefer that side. */
  dx: number;
  dy: number;
  /** Lower is placed first. */
  priority: number;
  /** Always shown (the hovered or focused node), even when it overlaps. */
  force?: boolean;
}

export interface LabelBox {
  id: string;
  /** Centre of the label box: draw with text-anchor middle and a central baseline. */
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  visible: boolean;
}

type Side = "below" | "above" | "right" | "left";

function sidesFor(dx: number, dy: number): Side[] {
  if (Math.abs(dx) > Math.abs(dy) * 0.6) {
    return dx >= 0 ? ["right", "below", "above", "left"] : ["left", "below", "above", "right"];
  }
  return dy >= 0 ? ["below", "right", "left", "above"] : ["above", "right", "left", "below"];
}

function boxAt(l: LabelInput, side: Side, gap: number): Omit<LabelBox, "id" | "visible"> {
  const { x, y, r, width: w, height: h } = l;
  const c =
    side === "below"
      ? { cx: x, cy: y + r + gap + h / 2 }
      : side === "above"
        ? { cx: x, cy: y - r - gap - h / 2 }
        : side === "right"
          ? { cx: x + r + gap + w / 2, cy: y }
          : { cx: x - r - gap - w / 2, cy: y };
  return { ...c, x0: c.cx - w / 2, y0: c.cy - h / 2, x1: c.cx + w / 2, y1: c.cy + h / 2 };
}

function hitsCircle(b: { x0: number; y0: number; x1: number; y1: number }, c: { x: number; y: number; r: number }) {
  const nx = clamp(c.x, b.x0, b.x1);
  const ny = clamp(c.y, b.y0, b.y1);
  return (c.x - nx) ** 2 + (c.y - ny) ** 2 < c.r * c.r;
}

/**
 * Greedy label placement: each label tries the side facing away from its parent first, then the
 * others, and is hidden when every side would overlap another label, another node, a blocked area
 * (the map's controls) or the edge. Hidden labels stay available in the tooltip and the accessible list.
 */
export function placeLabels(
  labels: readonly LabelInput[],
  circles: readonly { id: string; x: number; y: number; r: number }[],
  bounds: { width: number; height: number },
  blocked: readonly { x0: number; y0: number; x1: number; y1: number }[] = [],
  gap = 4,
): Map<string, LabelBox> {
  const placed: LabelBox[] = [];
  const out = new Map<string, LabelBox>();
  const order = [...labels].sort((a, b) => (b.force ? 1 : 0) - (a.force ? 1 : 0) || a.priority - b.priority);
  const margin = 2;

  for (const l of order) {
    let chosen: Omit<LabelBox, "id" | "visible"> | null = null;
    const sides = sidesFor(l.dx, l.dy);
    for (const side of sides) {
      const b = boxAt(l, side, gap);
      if (b.x0 < margin || b.y0 < margin || b.x1 > bounds.width - margin || b.y1 > bounds.height - margin) continue;
      if (placed.some((p) => p.visible && b.x0 < p.x1 + margin && b.x1 > p.x0 - margin && b.y0 < p.y1 + margin && b.y1 > p.y0 - margin)) continue;
      if (circles.some((c) => c.id !== l.id && hitsCircle(b, { x: c.x, y: c.y, r: c.r + 1 }))) continue;
      if (blocked.some((k) => b.x0 < k.x1 && b.x1 > k.x0 && b.y0 < k.y1 && b.y1 > k.y0)) continue;
      chosen = b;
      break;
    }
    const box: LabelBox = chosen
      ? { id: l.id, ...chosen, visible: true }
      : { id: l.id, ...boxAt(l, sides[0], gap), visible: !!l.force };
    placed.push(box);
    out.set(l.id, box);
  }
  return out;
}
