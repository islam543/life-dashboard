import { createHash } from "node:crypto";
import type { CalendarEvent, EmailItem, JiraIssue, SourceStatus } from "../../shared/types";
import { parseEnvelope } from "../ai/validate";
import { CONNECTOR_SERVICES, signInMessage, type ConnectorService } from "./tools";

// The security boundary of the connector run (ticket T26). Everything here is pure.
//
// Issue titles, event titles, mail subjects and senders come from other people and pass
// through an LLM, so every value is untrusted. This module:
// - takes the first JSON object out of the CLI's `result`, never throwing on bad input,
// - copies only known fields into fresh objects (extra keys, bodies and snippets are dropped),
// - trims, flattens and caps every string and strips control and bidi characters,
// - accepts only ISO dates, caps item counts, and keeps a URL only when it is https on an
//   allowed host. Text is never interpreted: "ignore previous instructions" stays a title.

export const MAX_JIRA = 50;
export const MAX_CALENDAR = 60;
export const MAX_EMAIL = 20;
export const TITLE_MAX = 300;
export const SENDER_MAX = 120;
const ID_MAX = 200;
const SHORT_MAX = 80;
const PROJECT_MAX = 120;
const LABELS_MAX = 20;
const URL_MAX = 2000;
/** Items looked at per service before giving up, so a huge answer cannot cost much. */
const SCAN_MAX = 500;

/** data/connectors.json */
export const CONNECTORS_FILE = "connectors.json";

/** Outcome of the last run for one service. */
export type ServiceRunStatus = "ok" | "unavailable" | "error" | "skipped";

export interface ServiceCache<T> {
  /** Last good data. Kept when a later run fails. */
  items: T[];
  /** When `items` were fetched; null before the first good fetch. */
  fetchedAt: string | null;
  lastStatus: ServiceRunStatus;
  /** Short message when the last run did not succeed for this service. */
  error?: string;
}

export interface ConnectorsCache {
  /** When the last run finished, good or bad; null before the first run. */
  fetchedAt: string | null;
  jira: ServiceCache<JiraIssue>;
  calendar: ServiceCache<CalendarEvent>;
  email: ServiceCache<EmailItem>;
}

export interface ServiceItems {
  jira: JiraIssue;
  calendar: CalendarEvent;
  email: EmailItem;
}

export function emptyConnectorsCache(): ConnectorsCache {
  const empty = () => ({ items: [], fetchedAt: null, lastStatus: "skipped" as const });
  return { fetchedAt: null, jira: empty(), calendar: empty(), email: empty() };
}

// ---------------------------------------------------------------------------------------
// Small cleaners

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// C0 and C1 controls, zero-width and bidi control characters. Rendering is plain text, but
// these can still hide or reorder text in a title.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const HAS_HIDDEN = new RegExp(HIDDEN_CHARS.source);

/** One line, no hidden characters, trimmed, capped at `max` ("..." when cut). Non-strings give "". */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const line = String(value).replace(HIDDEN_CHARS, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Date and time, optional seconds and fraction, optional zone (Z or +hh:mm / +hhmm).
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Qatar has no daylight saving time; a time without a zone is read as Asia/Qatar, as the prompt asks. */
export const QATAR_OFFSET = "+03:00";

function validDay(y: string, m: string, d: string): boolean {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
}

/** "YYYY-MM-DD" when it is a real date, else null. */
export function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = DATE_ONLY.exec(value.trim());
  return m && validDay(m[1]!, m[2]!, m[3]!) ? m[0] : null;
}

/** An ISO 8601 date-time as UTC ISO ("...Z"), else null. A missing zone means Asia/Qatar. */
export function isoDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const m = DATE_TIME.exec(text);
  if (!m || !validDay(m[1]!, m[2]!, m[3]!)) return null;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) return null;
  const zone = m[7];
  const withZone = zone ? text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : `${text}${QATAR_OFFSET}`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parses a URL and keeps it only when it is https, has no user info and `hostOk` accepts it. */
function safeUrl(value: unknown, hostOk: (url: URL) => boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "" || text.length > URL_MAX || HAS_HIDDEN.test(text) || /\s/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  return hostOk(url) ? url.href : undefined;
}

/** Google Calendar links: calendar.google.com, or www.google.com under /calendar. */
export function safeCalendarUrl(value: unknown): string | undefined {
  return safeUrl(
    value,
    (u) => u.hostname === "calendar.google.com" || (u.hostname === "www.google.com" && /^\/calendar(\/|$)/.test(u.pathname)),
  );
}

/** Gmail links: mail.google.com only. */
export function safeMailUrl(value: unknown): string | undefined {
  return safeUrl(value, (u) => u.hostname === "mail.google.com");
}

export const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const JIRA_KEY_MAX = 32;

/**
 * The issue link. Kept when it is https on an allowed Jira host and points at this very
 * issue; otherwise rebuilt from the key on `sites[0]`. Never undefined: a Jira issue
 * always has a link.
 */
export function jiraUrl(value: unknown, key: string, sites: readonly string[]): string {
  const given = safeUrl(value, (u) => sites.includes(u.hostname) && u.pathname === `/browse/${key}`);
  return given ?? `https://${sites[0]}/browse/${key}`;
}

/** Short stable id for an item the model sent without one. */
function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------------------
// Items

export interface JiraOptions {
  /** Allowed Jira hosts, the one used for rebuilt links first. */
  sites: readonly string[];
  /** Reading our own cache: trust a stored `blocked: true` (its labels are not kept). */
  fromCache?: boolean;
}

function statusCategory(raw: unknown): JiraIssue["statusCategory"] {
  const value = (typeof raw === "string" ? raw : isObject(raw) && typeof raw.key === "string" ? raw.key : "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (value === "done") return "done";
  if (value === "inprogress" || value === "indeterminate") return "inprogress";
  return "todo";
}

function nameOf(raw: unknown, max: number): string {
  if (isObject(raw)) return cleanText(raw.name, max) || cleanText(raw.key, max);
  return cleanText(raw, max);
}

/** One Jira issue, or null when it has no valid key or is done. */
export function cleanJiraIssue(raw: unknown, opts: JiraOptions): JiraIssue | null {
  if (!isObject(raw) || opts.sites.length === 0) return null;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  if (key.length > JIRA_KEY_MAX || !JIRA_KEY.test(key)) return null;
  const category = statusCategory(raw.statusCategory);
  if (category === "done") return null;

  const status = nameOf(raw.status, SHORT_MAX);
  const labels = Array.isArray(raw.labels)
    ? raw.labels.slice(0, LABELS_MAX).map((l) => cleanText(l, SHORT_MAX)).filter((l) => l !== "")
    : [];
  // Jira due dates are days; a full date-time is accepted and cut to its day.
  const due = isoDate(raw.dueDate) ?? (isoDateTime(raw.dueDate) ? String(raw.dueDate).trim().slice(0, 10) : null);
  return {
    key,
    summary: cleanText(raw.summary, TITLE_MAX),
    status,
    statusCategory: category,
    priority: nameOf(raw.priority, SHORT_MAX),
    dueDate: due,
    updated: isoDateTime(raw.updated) ?? "",
    project: nameOf(raw.project, PROJECT_MAX),
    url: jiraUrl(raw.url, key, opts.sites),
    // Same rule as the REST collector: the status name or a label mentions "block".
    blocked: [status, ...labels].some((t) => t.toLowerCase().includes("block")) || (opts.fromCache === true && raw.blocked === true),
  };
}

function isDeclined(raw: Record<string, unknown>): boolean {
  const rsvp = typeof raw.responseStatus === "string" ? raw.responseStatus.toLowerCase() : "";
  return raw.declined === true || rsvp === "declined";
}

/** A date-only value stays "YYYY-MM-DD" (all-day event); a date-time becomes UTC ISO. */
function eventTime(value: unknown): string | null {
  return isoDate(value) ?? isoDateTime(value);
}

/** One calendar event, or null when its times are missing, not ISO, out of order, or declined. */
export function cleanCalendarEvent(raw: unknown): CalendarEvent | null {
  if (!isObject(raw) || isDeclined(raw)) return null;
  const start = eventTime(raw.start);
  if (!start) return null;
  const end = raw.end === undefined || raw.end === null || raw.end === "" ? start : eventTime(raw.end);
  if (!end) return null;
  const sameKind = (start.length === 10) === (end.length === 10);
  if (sameKind && Date.parse(end) < Date.parse(start)) return null;
  const title = cleanText(raw.title, TITLE_MAX) || "(no title)";
  const event: CalendarEvent = { id: cleanText(raw.id, ID_MAX) || derivedId("cal", start, title), title, start, end };
  const url = safeCalendarUrl(raw.url);
  if (url) event.url = url;
  return event;
}

const GMAIL_ID = /^[0-9a-f]{16}$/;
const GMAIL_EPOCH_MIN = Date.UTC(2004, 0, 1);

/**
 * The time inside a Gmail message id: 16 hex digits whose first 11 are milliseconds since 1970.
 * The connector's summary view gives sender and subject but no date, so this fills it in. Null
 * for anything that is not such an id or whose time is before Gmail existed or in the future.
 */
export function gmailIdTime(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== "string" || !GMAIL_ID.test(value)) return null;
  const ms = parseInt(value.slice(0, 11), 16);
  if (!Number.isFinite(ms) || ms < GMAIL_EPOCH_MIN || ms > now + 60 * 60_000) return null;
  return new Date(ms).toISOString();
}

/** A link to the thread built from its id, since the summary view gives none. */
export function gmailThreadUrl(threadId: unknown): string | undefined {
  return typeof threadId === "string" && GMAIL_ID.test(threadId) ? `https://mail.google.com/mail/u/0/#all/${threadId}` : undefined;
}

/** One mail: sender and subject only. Null when the sender or a valid time is missing. */
export function cleanEmail(raw: unknown): EmailItem | null {
  if (!isObject(raw)) return null;
  const from = cleanText(raw.from, SENDER_MAX);
  const receivedAt = isoDateTime(raw.receivedAt) ?? gmailIdTime(raw.id) ?? gmailIdTime(raw.threadId);
  if (!from || !receivedAt) return null;
  const subject = cleanText(raw.subject, TITLE_MAX) || "(no subject)";
  const item: EmailItem = { id: cleanText(raw.id, ID_MAX) || derivedId("mail", from, receivedAt, subject), from, subject, receivedAt };
  const url = safeMailUrl(raw.url) ?? gmailThreadUrl(raw.threadId);
  if (url) item.url = url;
  return item;
}

export interface CleanedList<T> {
  items: T[];
  /** Items dropped as invalid or duplicate (not counting those past the cap). */
  dropped: number;
}

/** Cleans a list: drops bad items and duplicate ids, keeps at most `max`. Never throws. */
function cleanList<T>(raw: unknown, max: number, clean: (item: unknown) => T | null, idOf: (item: T) => string): CleanedList<T> {
  if (!Array.isArray(raw)) return { items: [], dropped: 0 };
  const items: T[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of raw.slice(0, SCAN_MAX)) {
    if (items.length >= max) break;
    let item: T | null;
    try {
      item = clean(entry);
    } catch {
      item = null;
    }
    if (item === null || seen.has(idOf(item))) {
      dropped++;
      continue;
    }
    seen.add(idOf(item));
    items.push(item);
  }
  return { items, dropped };
}

export function cleanJiraIssues(raw: unknown, opts: JiraOptions): CleanedList<JiraIssue> {
  return cleanList(raw, MAX_JIRA, (i) => cleanJiraIssue(i, opts), (i) => i.key);
}

export function cleanCalendarEvents(raw: unknown): CleanedList<CalendarEvent> {
  return cleanList(raw, MAX_CALENDAR, cleanCalendarEvent, (e) => e.id);
}

export function cleanEmails(raw: unknown): CleanedList<EmailItem> {
  return cleanList(raw, MAX_EMAIL, cleanEmail, (m) => m.id);
}

// ---------------------------------------------------------------------------------------
// The model's answer

/** End index of the object starting at `start` (a "{"), or -1 when it never closes. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

const MAX_OBJECT_TRIES = 50;

/**
 * The first JSON object in a model answer that may carry prose or code fences around it.
 * Only an object with at least one service key ("jira", "calendar", "email") counts, so a
 * nested service object is never mistaken for the answer. Null when there is none.
 */
export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  let tries = 0;
  for (let start = text.indexOf("{"); start !== -1 && tries < MAX_OBJECT_TRIES; start = text.indexOf("{", start + 1)) {
    const end = closingBrace(text, start);
    if (end === -1) continue;
    tries++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (isObject(parsed) && CONNECTOR_SERVICES.some((s) => Object.hasOwn(parsed as object, s))) return parsed;
  }
  return null;
}

export type ServiceOutcome<T> =
  | { kind: "ok"; items: T[]; dropped: number }
  /** The model said it could not reach this service (tool missing or not signed in). */
  | { kind: "unavailable" }
  /** Missing or malformed in the answer. */
  | { kind: "invalid" };

export type ConnectorAnswer = { [S in ConnectorService]: ServiceOutcome<ServiceItems[S]> };

const LIST_KEY: Record<ConnectorService, string> = { jira: "issues", calendar: "events", email: "messages" };

function serviceOutcome<T>(raw: unknown, listKey: string, clean: (list: unknown) => CleanedList<T>): ServiceOutcome<T> {
  if (!isObject(raw)) return { kind: "invalid" };
  const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  if (status === "unavailable" || status === "error") return { kind: "unavailable" };
  if (!Array.isArray(raw[listKey])) return { kind: "invalid" };
  return { kind: "ok", ...clean(raw[listKey]) };
}

/** Pure: the answer object to one outcome per service. */
export function validateAnswer(answer: Record<string, unknown>, jira: JiraOptions): ConnectorAnswer {
  return {
    jira: serviceOutcome(answer.jira, LIST_KEY.jira, (l) => cleanJiraIssues(l, { sites: jira.sites })),
    calendar: serviceOutcome(answer.calendar, LIST_KEY.calendar, cleanCalendarEvents),
    email: serviceOutcome(answer.email, LIST_KEY.email, cleanEmails),
  };
}

export type ParsedOutput =
  | { ok: true; answer: ConnectorAnswer }
  | { ok: false; reason: "no_envelope" | "cli_error" | "no_object"; result?: string };

/** Pure: CLI stdout (the `--output-format json` envelope) to per-service outcomes. Never throws. */
export function parseConnectorOutput(stdout: string, jira: JiraOptions): ParsedOutput {
  const envelope = parseEnvelope(stdout);
  if (envelope === null) return { ok: false, reason: "no_envelope" };
  if (envelope.isError) return { ok: false, reason: "cli_error", result: envelope.result };
  const object = extractFirstJsonObject(envelope.result);
  if (object === null) return { ok: false, reason: "no_object", result: envelope.result };
  return { ok: true, answer: validateAnswer(object, jira) };
}

// ---------------------------------------------------------------------------------------
// The cache file (data/connectors.json): re-checked on every read, a corrupt file is empty.

const RUN_STATUSES: readonly ServiceRunStatus[] = ["ok", "unavailable", "error", "skipped"];

function cleanServiceCache<T>(raw: unknown, clean: (list: unknown) => CleanedList<T>): ServiceCache<T> {
  if (!isObject(raw)) return { items: [], fetchedAt: null, lastStatus: "skipped" };
  const fetchedAt = isoDateTime(raw.fetchedAt);
  const entry: ServiceCache<T> = {
    items: fetchedAt ? clean(raw.items).items : [],
    fetchedAt,
    lastStatus: RUN_STATUSES.includes(raw.lastStatus as ServiceRunStatus) ? (raw.lastStatus as ServiceRunStatus) : "error",
  };
  const error = cleanText(raw.error, 300);
  if (error) entry.error = error;
  return entry;
}

/** Pure: whatever was read from data/connectors.json to a safe cache. Anything unusable becomes empty. */
export function normaliseConnectorsCache(raw: unknown, jira: Pick<JiraOptions, "sites">): ConnectorsCache {
  if (!isObject(raw)) return emptyConnectorsCache();
  return {
    fetchedAt: isoDateTime(raw.fetchedAt),
    jira: cleanServiceCache(raw.jira, (l) => cleanJiraIssues(l, { sites: jira.sites, fromCache: true })),
    calendar: cleanServiceCache(raw.calendar, cleanCalendarEvents),
    email: cleanServiceCache(raw.email, cleanEmails),
  };
}

// ---------------------------------------------------------------------------------------
// Cache to collector result (used by the jira, calendar and email collectors)

export const CONNECTOR_TIME_ZONE = "Asia/Qatar";
export const NEVER_RUN_MESSAGE = "Waiting for the first Claude connector run";

const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: CONNECTOR_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: CONNECTOR_TIME_ZONE, day: "numeric", month: "short" });
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: CONNECTOR_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** "14:05" today, "30 Oct 14:05" on another day (Asia/Qatar). */
export function fetchedLabel(at: Date, now: Date): string {
  const clock = clockFormat.format(at);
  return dayKeyFormat.format(at) === dayKeyFormat.format(now) ? clock : `${dayFormat.format(at)} ${clock}`;
}

export interface SourceView<T> {
  status: SourceStatus;
  message: string;
  /** What the panel shows: the cached items, or [] when there are none. Never invented. */
  items: T[];
}

export interface SourceViewOptions {
  now: Date;
  /** The run interval; data younger than twice this is fresh. */
  everyMs: number;
  /** Whether tools.ts lists any tool for this service. */
  hasTools: boolean;
  /** Allowed Jira hosts. Needed only for "jira"; without them cached issues are dropped. */
  jiraSites?: readonly string[];
}

/**
 * Pure status mapping for one service, from whatever was read from data/connectors.json:
 * - no tools: not_connected with the sign-in message, no data
 * - no run yet (or a corrupt file): never_run
 * - data younger than 2 x the run interval: ok; older: stale (data kept)
 * - the last run failed and there is no data: error with a short message
 */
export function connectorSourceView<S extends ConnectorService>(
  service: S,
  rawCache: unknown,
  opts: SourceViewOptions,
): SourceView<ServiceItems[S]> {
  if (!opts.hasTools) return { status: "not_connected", message: signInMessage(service), items: [] };
  const cache = normaliseConnectorsCache(rawCache, { sites: opts.jiraSites ?? [] });
  const entry = cache[service] as ServiceCache<ServiceItems[S]>;
  if (cache.fetchedAt === null || (entry.fetchedAt === null && entry.lastStatus === "skipped")) {
    return { status: "never_run", message: NEVER_RUN_MESSAGE, items: [] };
  }
  const lastError = entry.lastStatus !== "ok" && entry.error ? entry.error : null;
  if (entry.fetchedAt === null) {
    return { status: "error", message: `${lastError ?? "No data from Claude yet"} (via Claude connector)`, items: [] };
  }
  const at = new Date(entry.fetchedAt);
  const fresh = opts.now.getTime() - at.getTime() < 2 * opts.everyMs;
  const base = fresh
    ? `Via Claude connector, fetched ${fetchedLabel(at, opts.now)}`
    : `Via Claude connector, last fetched ${fetchedLabel(at, opts.now)}`;
  return { status: fresh ? "ok" : "stale", message: lastError ? `${base}. Last run: ${lastError}` : base, items: entry.items };
}
