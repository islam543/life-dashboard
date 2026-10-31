import type { JiraIssue } from "../../shared/types";
import type { Collector, CollectorContext, CollectorResult } from "./types";

/**
 * Jira Cloud collector: open issues assigned to the current user.
 *
 * Security (ticket T05): the email and API token come only from `ctx.config.jira`, are sent
 * only to the normalised JIRA_SITE over https, and never appear in a message, in the
 * returned data or in a log line. Every error message below is a fixed string; raw errors
 * from fetch are never passed through.
 */

export const JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC";
export const FIELDS = ["summary", "status", "priority", "duedate", "updated", "project", "labels"] as const;
/** Most issues kept per run. */
export const MAX_ISSUES = 200;
/** Page size asked for; Jira may return fewer per page. */
export const PAGE_SIZE = 100;
/** Guard against a server that keeps handing out tokens. */
const MAX_PAGES = 20;
/** Per request. The snapshot service also aborts everything after 60 s through ctx.signal. */
export const REQUEST_TIMEOUT_MS = 20_000;

export const MESSAGES = {
  notConnected: "Add JIRA_EMAIL and JIRA_API_TOKEN to .env",
  badSite: "JIRA_SITE in .env is not a valid host name",
  rejected: "Jira token rejected",
  rateLimited: "Jira rate limit reached, showing last data",
  redirected: "Jira site redirected, check JIRA_SITE in .env",
  timeout: `Jira did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`,
  unreachable: "Could not reach Jira",
  badResponse: "Jira sent an unexpected response",
} as const;

/** An error whose message is safe to show (fixed text, no secrets). */
class JiraError extends Error {}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "https://qicbizdev.atlassian.net/" -> "qicbizdev.atlassian.net".
 * Drops an http(s) scheme, any path, query or trailing slash. Returns null for anything that
 * is not a plain host name (user info, other schemes, spaces), so the token goes nowhere else.
 */
export function normaliseSite(raw: string): string | null {
  const withoutScheme = raw.trim().replace(/^https?:\/\//i, "");
  const host = (withoutScheme.split(/[/?#]/, 1)[0] ?? "").toLowerCase();
  return HOST.test(host) ? host : null;
}

export function searchUrl(site: string, nextPageToken: string | undefined, maxResults: number): string {
  const params = new URLSearchParams({ jql: JQL, fields: FIELDS.join(","), maxResults: String(maxResults) });
  if (nextPageToken) params.set("nextPageToken", nextPageToken);
  return `https://${site}/rest/api/3/search/jql?${params.toString()}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function category(statusCategoryKey: unknown): JiraIssue["statusCategory"] {
  if (statusCategoryKey === "done") return "done";
  if (statusCategoryKey === "indeterminate") return "inprogress";
  return "todo"; // "new", and Jira's "undefined" (No Category)
}

/** Jira sends "2026-10-28T09:15:22.123+0300"; returns ISO UTC, or the raw text if unparseable. */
function isoTime(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  const ms = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? raw : new Date(ms).toISOString();
}

/** Maps one issue from /rest/api/3/search/jql. Returns null when the issue has no usable key. */
export function mapIssue(raw: unknown, site: string): JiraIssue | null {
  if (!isObject(raw)) return null;
  const key = str(raw.key);
  if (!key || !ISSUE_KEY.test(key)) return null;
  const fields = isObject(raw.fields) ? raw.fields : {};
  const status = isObject(fields.status) ? fields.status : {};
  const statusCategory = isObject(status.statusCategory) ? status.statusCategory : {};
  const priority = isObject(fields.priority) ? fields.priority : {};
  const project = isObject(fields.project) ? fields.project : {};
  const labels = Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === "string") : [];
  const statusName = str(status.name) ?? "";
  const dueDate = str(fields.duedate);

  return {
    key,
    summary: str(fields.summary) ?? "",
    status: statusName,
    statusCategory: category(statusCategory.key),
    priority: str(priority.name) ?? "",
    dueDate: dueDate && DATE_ONLY.test(dueDate) ? dueDate : null,
    updated: isoTime(fields.updated),
    project: str(project.name) ?? str(project.key) ?? "",
    url: `https://${site}/browse/${encodeURIComponent(key)}`,
    blocked: [statusName, ...labels].some((text) => text.toLowerCase().includes("block")),
  };
}

interface SearchPage {
  issues: unknown[];
  nextPageToken?: string | null;
  isLast?: boolean;
}

function isSearchPage(value: unknown): value is SearchPage {
  return (
    isObject(value) &&
    Array.isArray(value.issues) &&
    (value.nextPageToken === undefined || value.nextPageToken === null || typeof value.nextPageToken === "string") &&
    (value.isLast === undefined || typeof value.isLast === "boolean")
  );
}

async function fetchPage(url: string, authorization: string, signal: AbortSignal): Promise<SearchPage> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: authorization },
    // Never follow a redirect: the credentials must reach JIRA_SITE and nothing else.
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (response.status === 401 || response.status === 403) throw new JiraError(MESSAGES.rejected);
  if (response.status === 429) throw new JiraError(MESSAGES.rateLimited);
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new JiraError(MESSAGES.redirected);
  }
  if (!response.ok) throw new JiraError(`Jira returned HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JiraError(MESSAGES.badResponse);
  }
  if (!isSearchPage(body)) throw new JiraError(MESSAGES.badResponse);
  return body;
}

/** Follows nextPageToken until Jira says isLast, or MAX_ISSUES are collected. */
export async function fetchIssues(
  site: string,
  credentials: { email: string; apiToken: string },
  signal: AbortSignal,
): Promise<JiraIssue[]> {
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`, "utf8").toString("base64")}`;
  const issues: JiraIssue[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;

  for (let page = 0; page < MAX_PAGES && issues.length < MAX_ISSUES; page++) {
    const body = await fetchPage(searchUrl(site, token, Math.min(PAGE_SIZE, MAX_ISSUES - issues.length)), authorization, signal);
    for (const raw of body.issues) {
      const issue = mapIssue(raw, site);
      if (issue && issue.statusCategory !== "done") issues.push(issue);
    }
    const next = body.nextPageToken ?? undefined;
    if (body.isLast === true || !next || body.issues.length === 0 || seenTokens.has(next)) break;
    seenTokens.add(next);
    token = next;
  }
  return issues.slice(0, MAX_ISSUES);
}

function safeMessage(err: unknown): string {
  if (err instanceof JiraError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") return MESSAGES.timeout;
  return MESSAGES.unreachable;
}

export const jiraCollector: Collector<"jira"> = {
  key: "jira",
  async collect(ctx: CollectorContext<"jira">): Promise<CollectorResult<"jira">> {
    const { email, apiToken } = ctx.config.jira;
    if (!email || !apiToken) {
      return { status: "not_connected", message: MESSAGES.notConnected, data: { jira: [] } };
    }
    const site = normaliseSite(ctx.config.jira.site);
    if (!site) return { status: "error", message: MESSAGES.badSite, data: null };

    try {
      const jira = await fetchIssues(site, { email, apiToken }, ctx.signal);
      return { status: "ok", data: { jira } };
    } catch (err) {
      // data: null keeps the last good issues (token rejected, rate limit, network).
      return { status: "error", message: safeMessage(err), data: null };
    }
  },
};
