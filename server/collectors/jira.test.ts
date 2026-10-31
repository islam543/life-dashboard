import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvSource } from "../config";
import { loadConfig } from "../config";
import { CONNECTORS_FILE, emptyConnectorsCache, type ConnectorsCache } from "../connectors/validate";
import { createStore, type Store } from "../store";
import { FIELDS, JQL, MAX_ISSUES, MESSAGES, jiraCollector, jiraSites, normaliseSite } from "./jira";
import type { CollectorContext } from "./types";

type RawIssue = Record<string, unknown> & { key: string; id: string };
type RawPage = { issues: RawIssue[]; nextPageToken?: string; isLast?: boolean };

const fixture = (name: string): RawPage =>
  JSON.parse(readFileSync(new URL(`./fixtures/jira/${name}`, import.meta.url), "utf8")) as RawPage;

const EMAIL = "me@example.com";
const TOKEN = "test-jira-token-not-real-0001";
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`, "utf8").toString("base64");
const NOW = new Date("2026-10-30T06:00:00.000Z");
const CONNECTED: EnvSource = { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN, JIRA_SITE: "acme.atlassian.net" };

function ctx(env: EnvSource): CollectorContext<"jira"> {
  const dir = os.tmpdir();
  return {
    config: loadConfig(env, { rootDir: dir, home: dir }),
    store: {} as Store, // the Jira collector keeps no files
    now: NOW,
    signal: new AbortController().signal,
    previous: { jira: [] },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: Mock<typeof fetch>;

function respondWith(...responses: Array<() => Response>): void {
  for (const make of responses) fetchMock.mockImplementationOnce(async () => make());
}

const urlOf = (call: number): URL => new URL(String(fetchMock.mock.calls[call]?.[0]));
const initOf = (call: number): RequestInit => fetchMock.mock.calls[call]?.[1] ?? {};

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(async () => {
    throw new Error("unexpected fetch");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("missing credentials", () => {
  it("a token without an email is a half-done REST setup: not_connected, no request", async () => {
    const result = await jiraCollector.collect(ctx({ JIRA_API_TOKEN: TOKEN }));
    expect(result).toEqual({ status: "not_connected", message: "Add JIRA_EMAIL and JIRA_API_TOKEN to .env", data: { jira: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("without JIRA_API_TOKEN: the Claude connector cache (T26)", () => {
  let tmp: string;
  let store: Store;
  const MIN = 60_000;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-jira-connector-"));
    store = createStore(tmp);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const connectorCtx = (env: EnvSource): CollectorContext<"jira"> => ({ ...ctx(env), store });
  const issue = (key: string, extra: Record<string, unknown> = {}) => ({
    key, summary: `Summary ${key}`, status: "In Progress", statusCategory: "inprogress" as const, priority: "High",
    dueDate: "2026-11-02", updated: "2026-10-29T10:00:00.000Z", project: "FastBind",
    url: `https://qicbizdev.atlassian.net/browse/${key}`, blocked: false, ...extra,
  });
  function cache(ageMin: number | null, patch: Partial<ConnectorsCache["jira"]> = {}): ConnectorsCache {
    const at = ageMin === null ? null : new Date(NOW.getTime() - ageMin * MIN).toISOString();
    return {
      ...emptyConnectorsCache(),
      fetchedAt: new Date(NOW.getTime() - 5 * MIN).toISOString(),
      jira: { items: at ? [issue("FB-12"), issue("FB-13", { blocked: true })] : [], fetchedAt: at, lastStatus: "ok", ...patch },
    };
  }
  const save = (value: unknown) => store.write(CONNECTORS_FILE, value);

  it("before the first run: never_run with an empty list, and no Jira request", async () => {
    const result = await jiraCollector.collect(connectorCtx({}));
    expect(result).toEqual({ status: "never_run", message: "Waiting for the first Claude connector run", data: { jira: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing set", {}],
    ["blank values", { JIRA_EMAIL: "  ", JIRA_API_TOKEN: "" }],
    ["email only", { JIRA_EMAIL: EMAIL }],
  ])("fresh data is ok and says its source (%s)", async (_label, env: EnvSource) => {
    await save(cache(30));
    const result = await jiraCollector.collect(connectorCtx(env));
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/^Via Claude connector, fetched \d{2}:\d{2}$/);
    expect(result.data?.jira.map((i) => [i.key, i.blocked])).toEqual([["FB-12", false], ["FB-13", true]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("data older than twice the interval is stale but still shown", async () => {
    await save(cache(121));
    const result = await jiraCollector.collect(connectorCtx({}));
    expect(result.status).toBe("stale");
    expect(result.message).toMatch(/^Via Claude connector, last fetched /);
    expect(result.data?.jira).toHaveLength(2);
  });

  it("the freshness window follows CONNECTORS_EVERY_MIN (floored at 15)", async () => {
    await save(cache(40));
    expect((await jiraCollector.collect(connectorCtx({ CONNECTORS_EVERY_MIN: "15" }))).status).toBe("stale");
    expect((await jiraCollector.collect(connectorCtx({ CONNECTORS_EVERY_MIN: "5" }))).status).toBe("stale");
    expect((await jiraCollector.collect(connectorCtx({ CONNECTORS_EVERY_MIN: "30" }))).status).toBe("ok");
  });

  it("a failed last run with no data is an error with a short message", async () => {
    await save(cache(null, { lastStatus: "error", error: "Claude did not answer within 180 seconds." }));
    const result = await jiraCollector.collect(connectorCtx({}));
    expect(result).toEqual({
      status: "error",
      message: "Claude did not answer within 180 seconds. (via Claude connector)",
      data: { jira: [] },
    });
  });

  it("a failed last run keeps the previous good data and mentions the failure", async () => {
    await save(cache(30, { lastStatus: "error", error: "Run claude in a terminal and log in" }));
    const result = await jiraCollector.collect(connectorCtx({}));
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/Last run: Run claude in a terminal and log in$/);
    expect(result.data?.jira).toHaveLength(2);
  });

  it("a corrupt cache reads as missing", async () => {
    await writeFile(store.pathOf(CONNECTORS_FILE), "{ not json", "utf8");
    expect((await jiraCollector.collect(connectorCtx({}))).status).toBe("never_run");
    await save({ fetchedAt: 42, jira: "nope" });
    expect((await jiraCollector.collect(connectorCtx({}))).status).toBe("never_run");
  });

  it("cached links are re-checked: a foreign host is replaced by the issue link on the Jira site", async () => {
    const bad = cache(10);
    bad.jira.items = [issue("FB-12", { url: "https://evil.example.com/browse/FB-12" }), issue("bad key")];
    await save(bad);
    const result = await jiraCollector.collect(connectorCtx({}));
    expect(result.data?.jira).toEqual([expect.objectContaining({ key: "FB-12", url: "https://qicbizdev.atlassian.net/browse/FB-12" })]);
  });

  it("the token path still wins: with JIRA_EMAIL and JIRA_API_TOKEN it calls REST and ignores the cache", async () => {
    await save(cache(10));
    respondWith(() => json({ issues: [], isLast: true }));
    const result = await jiraCollector.collect(connectorCtx(CONNECTED));
    expect(result).toEqual({ status: "ok", data: { jira: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("jiraSites puts the configured site first and always allows the default", () => {
    expect(jiraSites("https://acme.atlassian.net/")).toEqual(["acme.atlassian.net", "qicbizdev.atlassian.net"]);
    expect(jiraSites("qicbizdev.atlassian.net")).toEqual(["qicbizdev.atlassian.net"]);
    expect(jiraSites("not a host")).toEqual(["qicbizdev.atlassian.net"]);
  });
});

describe("mapping and request", () => {
  it("maps the documented search/jql response and follows nextPageToken", async () => {
    respondWith(() => json(fixture("search-page1.json")), () => json(fixture("search-page2.json")));

    const result = await jiraCollector.collect(ctx(CONNECTED));

    expect(result.status).toBe("ok");
    const issues = result.data?.jira ?? [];
    // SMP-121 is statusCategory "done" and is dropped.
    expect(issues.map((i) => i.key)).toEqual(["SMP-101", "SMP-102", "OPS-7", "SMP-110", "SMP-120"]);

    expect(issues[0]).toEqual({
      key: "SMP-101",
      summary: "Fix premium rounding in quote API",
      status: "In Progress",
      statusCategory: "inprogress",
      priority: "High",
      dueDate: "2026-11-02",
      updated: "2026-10-28T06:15:22.123Z",
      project: "Sample Project",
      url: "https://acme.atlassian.net/browse/SMP-101",
      blocked: false,
    });
    // No due date, no priority.
    expect(issues[1]).toMatchObject({ key: "SMP-102", statusCategory: "todo", dueDate: null, priority: "", blocked: false });
    // Non-English status name: category comes from statusCategory.key. Blocked through a label.
    expect(issues[2]).toMatchObject({
      key: "OPS-7",
      status: "قيد المراجعة",
      statusCategory: "inprogress",
      project: "Ops Board",
      updated: "2026-10-27T13:00:00.000Z",
      blocked: true,
    });
    // Blocked through the status name.
    expect(issues[3]).toMatchObject({ key: "SMP-110", status: "Blocked", statusCategory: "todo", blocked: true });
    expect(issues[4]).toMatchObject({ key: "SMP-120", status: "En cours", statusCategory: "inprogress" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = urlOf(0);
    expect(first.protocol).toBe("https:");
    expect(first.host).toBe("acme.atlassian.net");
    expect(first.pathname).toBe("/rest/api/3/search/jql");
    expect(first.searchParams.get("jql")).toBe(JQL);
    expect(first.searchParams.get("jql")).toBe("assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC");
    expect(first.searchParams.get("fields")).toBe(FIELDS.join(","));
    expect(first.searchParams.get("fields")).toBe("summary,status,priority,duedate,updated,project,labels");
    expect(first.searchParams.has("nextPageToken")).toBe(false);
    expect(urlOf(1).searchParams.get("nextPageToken")).toBe("CAEaAggD");

    const init = initOf(0);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${BASIC}`);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the default site when JIRA_SITE is not set", async () => {
    respondWith(() => json({ issues: [], isLast: true }));
    const result = await jiraCollector.collect(ctx({ JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN }));
    expect(result).toEqual({ status: "ok", data: { jira: [] } });
    expect(urlOf(0).host).toBe("qicbizdev.atlassian.net");
  });

  it("skips issues without a usable key", async () => {
    const page = fixture("search-page1.json");
    page.issues[0] = { ...page.issues[0], key: "../evil" };
    respondWith(() => json({ ...page, isLast: true }));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result.data?.jira.map((i) => i.key)).toEqual(["SMP-102", "OPS-7", "SMP-110"]);
  });
});

describe("pagination cap", () => {
  const template = fixture("search-page1.json").issues[0];
  let counter = 0;
  const page = (size: number, token: string): RawPage => ({
    issues: Array.from({ length: size }, () => {
      counter += 1;
      return { ...structuredClone(template), id: String(counter), key: `GEN-${counter}` };
    }),
    nextPageToken: token,
    isLast: false,
  });

  beforeEach(() => {
    counter = 0;
  });

  it("stops at 200 issues even when Jira says there are more", async () => {
    fetchMock.mockImplementation(async () => json(page(100, `t${counter}`)));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result.data?.jira).toHaveLength(MAX_ISSUES);
    expect(MAX_ISSUES).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks only for what is left and trims an oversized last page", async () => {
    fetchMock.mockImplementation(async () => json(page(60, `t${counter}`)));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result.data?.jira).toHaveLength(200);
    expect(result.data?.jira.at(-1)?.key).toBe("GEN-200");
    const asked = fetchMock.mock.calls.map((_c, i) => urlOf(i).searchParams.get("maxResults"));
    expect(asked).toEqual(["100", "100", "80", "20"]);
  });

  it("stops when Jira repeats a page token", async () => {
    fetchMock.mockImplementation(async () => json(page(5, "same")));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data?.jira).toHaveLength(10);
  });

  it("stops on an empty page", async () => {
    respondWith(() => json({ issues: [], nextPageToken: "more", isLast: false }));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "ok", data: { jira: [] } });
  });
});

describe("errors keep the last data", () => {
  it.each([401, 403])("HTTP %i is a rejected token", async (status) => {
    respondWith(() => json({ errorMessages: ["Unauthorized"] }, status));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result).toEqual({ status: "error", message: "Jira token rejected", data: null });
  });

  it("429 keeps the last data", async () => {
    respondWith(() => json({ errorMessages: ["Rate limit exceeded"] }, 429));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result).toEqual({ status: "error", message: MESSAGES.rateLimited, data: null });
  });

  it("a failure on page 2 drops the partial result", async () => {
    respondWith(() => json(fixture("search-page1.json")), () => json({}, 429));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result.data).toBeNull();
  });

  it("other HTTP errors give the status code only", async () => {
    respondWith(() => new Response("<html>oops</html>", { status: 503 }));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result).toEqual({ status: "error", message: "Jira returned HTTP 503", data: null });
  });

  it("does not follow redirects", async () => {
    respondWith(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result).toEqual({ status: "error", message: MESSAGES.redirected, data: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a body that is not a search page", async () => {
    respondWith(() => new Response("<html>login</html>", { status: 200 }));
    expect(await jiraCollector.collect(ctx(CONNECTED))).toEqual({ status: "error", message: MESSAGES.badResponse, data: null });
    respondWith(() => json({ values: [] }));
    expect(await jiraCollector.collect(ctx(CONNECTED))).toEqual({ status: "error", message: MESSAGES.badResponse, data: null });
  });

  it("maps the 20 s timeout to a plain message", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result).toEqual({ status: "error", message: "Jira did not answer within 20 s", data: null });
  });
});

describe("site normalisation", () => {
  it.each([
    ["acme.atlassian.net", "acme.atlassian.net"],
    ["https://acme.atlassian.net", "acme.atlassian.net"],
    ["https://acme.atlassian.net/", "acme.atlassian.net"],
    ["acme.atlassian.net///", "acme.atlassian.net"],
    ["HTTPS://ACME.Atlassian.net/", "acme.atlassian.net"],
    ["http://acme.atlassian.net", "acme.atlassian.net"],
    ["  https://acme.atlassian.net/jira/your-work?x=1  ", "acme.atlassian.net"],
  ])("%s -> %s", (input, expected) => {
    expect(normaliseSite(input)).toBe(expected);
  });

  it.each(["", "   ", "https://", "user:pw@evil.example.com", "evil.example.com@acme.atlassian.net", "ftp://acme.atlassian.net", "acme atlassian net", "localhost"])(
    "rejects %j",
    (input) => {
      expect(normaliseSite(input)).toBeNull();
    },
  );

  it("always calls https on the normalised host", async () => {
    respondWith(() => json({ issues: [], isLast: true }));
    await jiraCollector.collect(ctx({ ...CONNECTED, JIRA_SITE: "http://Acme.atlassian.net/" }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/search\/jql\?/);
  });

  it("does not call anything for an invalid site", async () => {
    const result = await jiraCollector.collect(ctx({ ...CONNECTED, JIRA_SITE: "me:pw@evil.example.com" }));
    expect(result).toEqual({ status: "error", message: MESSAGES.badSite, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the token never leaks", () => {
  const secrets = [TOKEN, BASIC, EMAIL];
  const expectClean = (text: string) => {
    for (const secret of secrets) expect(text).not.toContain(secret);
  };

  it("error messages never contain the token, even when the underlying error does", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const failures: Array<() => Promise<Response>> = [
      async () => json({ errorMessages: [`Bad credentials for ${EMAIL}:${TOKEN}`] }, 401),
      async () => json({ message: TOKEN }, 500),
      async () => {
        throw new TypeError(`fetch failed: Authorization Basic ${BASIC} token ${TOKEN}`);
      },
      async () => {
        throw new Error(TOKEN);
      },
    ];
    for (const fail of failures) {
      fetchMock.mockImplementationOnce(fail);
      const result = await jiraCollector.collect(ctx(CONNECTED));
      expect(result.status).toBe("error");
      expect(result.message).toBeTruthy();
      expectClean(result.message ?? "");
      expectClean(JSON.stringify(result));
    }
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("returned data never contains the token", async () => {
    respondWith(() => json(fixture("search-page1.json")), () => json(fixture("search-page2.json")));
    const result = await jiraCollector.collect(ctx(CONNECTED));
    expect(result.status).toBe("ok");
    expectClean(JSON.stringify(result));
  });

  it("sends the credentials only to the configured host", async () => {
    respondWith(() => json(fixture("search-page1.json")), () => json(fixture("search-page2.json")));
    await jiraCollector.collect(ctx(CONNECTED));
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      expect(urlOf(i).origin).toBe("https://acme.atlassian.net");
      expectClean(urlOf(i).toString());
    }
  });
});
