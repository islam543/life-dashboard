import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedAction, JiraCreateResult, JiraDraft, NextMovesFile, Snapshot } from "../../shared/types";
import { BLOCKED_TOOLS, NOT_LOGGED_IN_MESSAGE, type RunRequest, type RunResult } from "../ai/nextMoves";
import { createApp } from "../app";
import { signInMessage } from "../connectors/tools";
import { CREATE_TOOL, SEARCH_TOOL, epicJql } from "../jira/draft";
import { createNotesStore, type NotesStore } from "../notes";
import { PROJECTS_FILE } from "../projects";
import { createStore, type Store } from "../store";
import { jiraRoutes, type JiraRunSettings } from "./jira";

// /api/jira with a temp notes folder and a fake claude. The real CLI never starts, no real Jira
// issue is created, and the real vault and data folder are never touched.

const NOW = new Date(2026, 9, 31, 10, 0);
const ACCOUNT = "712020:test-account";

let tmp: string;
let notes: NotesStore;
let store: Store;
let logs: string[];
let refreshes: number;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-jira-routes-"));
  await mkdir(path.join(tmp, "vault"));
  notes = createNotesStore(path.join(tmp, "vault", "notes"), { now: () => NOW });
  store = createStore(path.join(tmp, "data"));
  logs = [];
  refreshes = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

type Answer = (req: RunRequest, run: number) => RunResult | Promise<RunResult>;
const envelope = (result: string): RunResult => ({ exitCode: 0, stdout: JSON.stringify({ type: "result", result, is_error: false }), stderr: "", timedOut: false });

/** The router mounted like app.ts mounts it, with app.ts's error mapping. */
/** v1.4: two temp vault folders that exist and one that does not. */
function testVaults(): JiraRunSettings["vaults"] {
  return [
    { id: "notes", label: "Working-With-Claude notes", prefix: "", dir: path.join(tmp, "vault", "notes"), readOnlyFolders: [] },
    { id: "learning", label: "Learning", prefix: "@learning/", dir: path.join(tmp, "Learning"), readOnlyFolders: ["raw"] },
    { id: "qic-uw", label: "QIC Underwriting Agent", prefix: "@qic-uw/", dir: path.join(tmp, "missing-qic"), readOnlyFolders: [] },
  ];
}

function build(answer: Answer) {
  const calls: RunRequest[] = [];
  const run: Partial<JiraRunSettings> = {
    runner: async (req) => {
      calls.push(req);
      return answer(req, calls.length);
    },
    command: "claude-fake",
    env: { PATH: "fake" },
    runDir: path.join(tmp, "data", "jira-run"),
    site: "qicbizdev.atlassian.net",
    accountId: ACCOUNT,
    projectKey: "AN",
    draftTimeoutMs: 1000,
    createTimeoutMs: 1000,
    vaults: testVaults(),
  };
  const app = new Hono();
  app.route(
    "/api/jira",
    jiraRoutes({
      notes,
      store,
      snapshots: {
        get: () => ({}) as Snapshot,
        refresh: async () => ({}) as Snapshot,
        refreshLocal: async () => {
          refreshes++;
          return {} as Snapshot;
        },
      },
      now: () => NOW,
      log: (line) => logs.push(line),
      run,
    }),
  );
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: `500: ${err.message}` }, 500);
  });
  const post = (url: string, body: unknown) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, calls, post };
}

const MEETING = [
  "## Attendees",
  "- Sara",
  "",
  "## Notes",
  "The claims export is late again.",
  "",
  "## Action items",
  "- [ ] Ask Sara for the claims export",
  "- [ ] Send the signed slip to finance",
  "- [x] Book the review room",
  "- [ ] Chase the broker (AN-4100)",
  "- متابعة المطالبات مع أحمد",
].join("\n");

async function meetingNote(body = MEETING, projectId: string | null = null): Promise<string> {
  const note = await notes.create({ section: "Meeting notes", title: "Claims sync", body, projectId });
  return note.path;
}

async function actionsOf(app: Hono, notePath: string): Promise<DetectedAction[]> {
  const res = await app.request(`/api/jira/actions?path=${encodeURIComponent(notePath)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DetectedAction[];
}

function draftAnswer(actions: DetectedAction[]) {
  const open = actions.filter((a) => !a.done && !a.jiraKey);
  return JSON.stringify({
    epics: [
      { key: "AN-3977", summary: "QIC FastBind" },
      { key: "AN-4373", summary: "MVHI Claims Copilot" },
    ],
    issues: [
      { draftId: "e1", actionIds: [], type: "Epic", summary: "Finance follow-ups", description: "Finance work that came out of the claims sync.", parent: null },
      { draftId: "t1", actionIds: [open[0]!.id], type: "Task", summary: "Get the claims export from Sara", description: "The export is late again; Sara owns it and we need it this week.", parent: { kind: "existing", key: "AN-4373" } },
      { draftId: "t2", actionIds: [open[1]!.id], type: "Task", summary: "Send the signed slip to finance", description: "Finance needs the signed slip to close the claim this week.", parent: { kind: "new", draftId: "e1" } },
      { draftId: "t3", actionIds: [open[2]!.id], type: "Task", summary: "Follow up on claims with Ahmed", description: "Follow up the open claims with Ahmed and agree next steps.", parent: null },
    ],
  });
}

/** Answers a create run from its payloads with consecutive AN keys. */
function createAnswer(start: number) {
  let next = start;
  return (req: RunRequest) => {
    const prompt = req.args[1]!;
    const payloads = JSON.parse(prompt.slice(prompt.indexOf("Payloads (JSON):\n") + 17, prompt.indexOf("\n\nReply with"))) as { draftId: string }[];
    return envelope(JSON.stringify(payloads.map((p) => ({ draftId: p.draftId, key: `AN-${next++}` }))));
  };
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(flag) + 1; i > 0 && i < args.length && !args[i]!.startsWith("--"); i++) out.push(args[i]!);
  return out;
}

describe("GET /api/jira/actions", () => {
  it("returns the detected actions with stable ids and filed keys", async () => {
    const { app } = build(() => envelope("{}"));
    const notePath = await meetingNote();
    const actions = await actionsOf(app, notePath);
    expect(actions.map((a) => [a.line, a.text, a.done, a.jiraKey])).toEqual([
      [8, "Ask Sara for the claims export", false, null],
      [9, "Send the signed slip to finance", false, null],
      [10, "Book the review room", true, null],
      [11, "Chase the broker (AN-4100)", false, "AN-4100"],
      [12, "متابعة المطالبات مع أحمد", false, null],
    ]);
    expect(await actionsOf(app, notePath)).toEqual(actions);
  });

  it("answers 400 without a path and 404 for a missing note, and refuses paths outside the notes folder", async () => {
    const { app } = build(() => envelope("{}"));
    expect((await app.request("/api/jira/actions")).status).toBe(400);
    await notes.index();
    expect((await app.request("/api/jira/actions?path=Meeting%20notes%2Fnope.md")).status).toBe(404);
    expect((await app.request("/api/jira/actions?path=..%2F..%2Fsecret.md")).status).toBe(400);
  });
});

describe("POST /api/jira/draft", () => {
  it("runs claude with the search tool plus read-only vault access and returns a validated draft", async () => {
    await mkdir(path.join(tmp, "Learning"), { recursive: true });
    await store.write(PROJECTS_FILE, { projects: [{ id: "mvhi", name: "MVHI Claims Copilot", area: "work", status: "active", deadline: null, description: "", goals: [], tasks: [], sources: { sessions: [], repos: [] }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }], hidden: [] });
    const notePath = await meetingNote(MEETING, "mvhi");
    let actions: DetectedAction[] = [];
    const { app, calls, post } = build(() => envelope(`Here is the draft:\n${draftAnswer(actions)}`));
    actions = await actionsOf(app, notePath);

    const res = await post("/api/jira/draft", { path: notePath });
    expect(res.status).toBe(200);
    const draft = (await res.json()) as JiraDraft;
    expect(draft.notePath).toBe(notePath);
    expect(draft.createdAt).toBe(NOW.toISOString());
    expect(draft.epics.map((e) => e.key)).toEqual(["AN-3977", "AN-4373"]);
    expect(draft.issues.map((i) => [i.draftId, i.type])).toEqual([["e1", "Epic"], ["t1", "Task"], ["t2", "Task"], ["t3", "Task"]]);

    expect(calls).toHaveLength(1);
    const { args, cwd, env, command } = calls[0]!;
    expect(command).toBe("claude-fake");
    expect(cwd).toBe(path.join(tmp, "data", "jira-run"));
    expect(env).toEqual({ PATH: "fake" });
    expect(flagValues(args, "--tools")).toEqual(["ToolSearch", "Read", "Glob", "Grep"]);
    expect(flagValues(args, "--allowedTools")).toEqual([SEARCH_TOOL, "Read", "Glob", "Grep"]);
    // Only vault folders that exist: the missing QIC folder is left out.
    expect(flagValues(args, "--add-dir")).toEqual([path.join(tmp, "vault", "notes"), path.join(tmp, "Learning")]);
    for (const tool of BLOCKED_TOOLS) expect(flagValues(args, "--disallowedTools")).toContain(tool);
    expect(flagValues(args, "--disallowedTools")).toContain(CREATE_TOOL);
    expect(args).not.toContain("--strict-mcp-config");
    const prompt = args[1]!;
    expect(prompt).toContain(`  Learning: ${path.join(tmp, "Learning")}`);
    expect(prompt).not.toContain("QIC Underwriting Agent");
    expect(prompt).toContain('Note title: "Claims sync"');
    expect(prompt).toContain('Project: "MVHI Claims Copilot"');
    expect(prompt).toContain(epicJql("AN"));
    const marker = "Actions (JSON; context is the note text around the action):\n";
    const sent = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length, prompt.indexOf("\n\nReply with"))) as { id: string; text: string; context: string }[];
    // Done and already-filed actions are not drafted; each open one comes with its note context.
    expect(sent.map((a) => a.text)).toEqual(["Ask Sara for the claims export", "Send the signed slip to finance", "متابعة المطالبات مع أحمد"]);
    expect(sent.map((a) => a.id)).toEqual(actions.filter((a) => !a.done && !a.jiraKey).map((a) => a.id));
    expect(sent[0]!.context).toContain("The claims export is late again.");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[jira\] draft done in \d+\.\d s: 3 open actions, 2 epics found, 3 tasks, 1 new epics$/);
    // Nothing was written to the note.
    expect((await notes.read(notePath)).body).toBe(MEETING);
  });

  it("answers 400 'No open actions to file' for a note with no actions, or only filed and done ones", async () => {
    const { calls, post } = build(() => envelope("{}"));
    const empty = await meetingNote("Just some notes.\n- [ ] ");
    const filed = await meetingNote("- [ ] Send slip (AN-1)\n- [x] Done already");
    for (const notePath of [empty, filed]) {
      const res = await post("/api/jira/draft", { path: notePath });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "No open actions to file" });
    }
    expect(calls).toHaveLength(0);
  });

  it("answers 503 with the sign-in message when the CLI or the connector is not signed in", async () => {
    const notePath = await meetingNote();
    const loggedOut = build(() => ({ exitCode: 1, stdout: "", stderr: "Invalid API key. Please run /login", timedOut: false }));
    const res1 = await loggedOut.post("/api/jira/draft", { path: notePath });
    expect(res1.status).toBe(503);
    expect(await res1.json()).toEqual({ error: NOT_LOGGED_IN_MESSAGE });
    const noConnector = build(() => envelope('{"status":"unavailable"}'));
    const res2 = await noConnector.post("/api/jira/draft", { path: notePath });
    expect(res2.status).toBe(503);
    expect(await res2.json()).toEqual({ error: signInMessage("jira") });
  });

  it("answers 502 when the model invents an epic, returns a Story or goes over the caps", async () => {
    const notePath = await meetingNote();
    const { app } = build(() => envelope("{}"));
    const actions = (await actionsOf(app, notePath)).filter((a) => !a.done && !a.jiraKey);
    const base = { draftId: "t1", actionIds: [actions[0]!.id], type: "Task", summary: "Get the export", description: "A description long enough to pass the check.", parent: null };
    const bad = [
      { epics: [], issues: [{ ...base, parent: { kind: "existing", key: "AN-9999" } }] },
      { epics: [], issues: [{ ...base, type: "Story" }] },
      { epics: [], issues: [{ ...base, type: "Sub-task" }] },
      { epics: [], issues: [{ ...base, summary: "x".repeat(121) }] },
      { epics: [], issues: Array.from({ length: 16 }, (_, i) => ({ ...base, draftId: `t${i}` })) },
      { epics: [], issues: [{ ...base, actionIds: ["act-invented"] }] },
    ];
    for (const answer of bad) {
      const { post } = build(() => envelope(JSON.stringify(answer)));
      const res = await post("/api/jira/draft", { path: notePath });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(/^Claude's draft did not pass the checks/);
    }
    expect(logs.every((l) => l.includes("draft failed (invalid_draft)"))).toBe(true);
  });

  it("answers 409 for a second draft while one is running", async () => {
    const notePath = await meetingNote();
    let release: (r: RunResult) => void = () => undefined;
    let started = false;
    const { post } = build(
      () =>
        new Promise<RunResult>((resolve) => {
          started = true;
          release = resolve;
        }),
    );
    const first = post("/api/jira/draft", { path: notePath });
    await vi.waitFor(() => expect(started).toBe(true));
    const second = await post("/api/jira/draft", { path: notePath });
    expect(second.status).toBe(409);
    release(envelope('{"status":"unavailable"}'));
    expect((await first).status).toBe(503);
  });

  it("refuses bodies that are not a JSON object with a path", async () => {
    const { app, post } = build(() => envelope("{}"));
    expect((await post("/api/jira/draft", [])).status).toBe(400);
    expect((await post("/api/jira/draft", { path: 3 })).status).toBe(400);
    const res = await app.request("/api/jira/draft", { method: "POST", body: "path=x" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jira/create", () => {
  /** Drafts the meeting note, then returns what create needs. */
  async function drafted(answer: Answer) {
    const notePath = await meetingNote();
    let actions: DetectedAction[] = [];
    const t = build((req, n) => (n === 1 ? envelope(draftAnswer(actions)) : answer(req, n - 1)));
    actions = await actionsOf(t.app, notePath);
    const draft = (await (await t.post("/api/jira/draft", { path: notePath })).json()) as JiraDraft;
    logs.length = 0;
    return { ...t, notePath, draft };
  }

  it("creates the Epic first, fills its key into its Task, and writes the Task keys back into the note", async () => {
    const { calls, post, notePath, draft } = await drafted(createAnswer(5001));
    const res = await post("/api/jira/create", { path: notePath, issues: draft.issues });
    expect(res.status).toBe(200);
    const result = (await res.json()) as JiraCreateResult;
    expect(result).toEqual({
      created: [
        { draftId: "e1", key: "AN-5001", url: "https://qicbizdev.atlassian.net/browse/AN-5001", type: "Epic" },
        { draftId: "t1", key: "AN-5002", url: "https://qicbizdev.atlassian.net/browse/AN-5002", type: "Task" },
        { draftId: "t2", key: "AN-5003", url: "https://qicbizdev.atlassian.net/browse/AN-5003", type: "Task" },
        { draftId: "t3", key: "AN-5004", url: "https://qicbizdev.atlassian.net/browse/AN-5004", type: "Task" },
      ],
      failed: [],
    });

    // Run 1 is the draft; runs 2 and 3 are the epic run and the task run.
    expect(calls).toHaveLength(3);
    for (const call of calls.slice(1)) {
      expect(flagValues(call.args, "--allowedTools")).toEqual([CREATE_TOOL]);
      expect(flagValues(call.args, "--tools")).toEqual(["ToolSearch"]);
      expect(call.args).not.toContain("--strict-mcp-config");
      expect(call.args).not.toContain("--add-dir"); // v1.4: the create run never reads the vaults
    }
    const epicPrompt = calls[1]!.args[1]!;
    expect(epicPrompt).toContain('"issueTypeName": "Epic"');
    expect(epicPrompt).toContain(`"assignee_account_id": "${ACCOUNT}"`);
    expect(epicPrompt).toContain('"projectKey": "AN"');
    const taskPrompt = calls[2]!.args[1]!;
    expect(taskPrompt).toContain('"parent": "AN-4373"');
    expect(taskPrompt).toContain('"parent": "AN-5001"');
    expect(taskPrompt).not.toContain('"issueTypeName": "Epic"');

    const body = (await notes.read(notePath)).body;
    expect(body).toContain("- [ ] Ask Sara for the claims export (AN-5002)");
    expect(body).toContain("- [ ] Send the signed slip to finance (AN-5003)");
    expect(body).toContain("- متابعة المطالبات مع أحمد (AN-5004)");
    expect(body).toContain("- [x] Book the review room\n");
    expect(body).not.toContain("AN-5001");
    expect(refreshes).toBe(1);

    expect(logs).toEqual([expect.stringMatching(/^\[jira\] create done in \d+\.\d s: 2 runs, 1 epics and 3 tasks created, 0 failed, write-back written \(3 lines\)$/)]);
    for (const text of ["Sara", "slip", "Claims", "متابعة"]) expect(logs.join("\n")).not.toContain(text);

    // Every action is filed now, so a second draft has nothing to do.
    const again = await post("/api/jira/draft", { path: notePath });
    expect(again.status).toBe(400);
  });

  it("re-validates edited issues: invented epics, foreign actions, Stories and empty new epics are refused before any run", async () => {
    const { calls, post, notePath, draft } = await drafted(createAnswer(1));
    const [e1, t1, t2] = draft.issues as [typeof draft.issues[0], typeof draft.issues[0], typeof draft.issues[0]];
    const cases: [unknown, RegExp][] = [
      [[{ ...t1, parent: { kind: "existing", key: "AN-1234" } }], /not one of your open epics/],
      [[{ ...t1, actionIds: ["act-0000000000000000"] }], /not an open action/],
      [[{ ...t1, type: "Story" }], /only Task or Epic/],
      [[e1, t1], /New epic e1 has no Tasks/],
      [[t2], /not a new Epic in this draft/],
      ["not a list", /must be a list/],
    ];
    for (const [issues, error] of cases) {
      const res = await post("/api/jira/create", { path: notePath, issues });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(error);
    }
    expect(calls).toHaveLength(1); // only the draft run
    expect((await notes.read(notePath)).body).toBe(MEETING);
  });

  it("refuses an existing parent when no draft for this note was made", async () => {
    const notePath = await meetingNote();
    const { app, calls, post } = build(createAnswer(1));
    const [first] = (await actionsOf(app, notePath)).filter((a) => !a.done && !a.jiraKey);
    const issue = { draftId: "t1", actionIds: [first!.id], type: "Task", summary: "Get the export", description: "A description long enough to pass.", parent: { kind: "existing", key: "AN-3977" } };
    const res = await post("/api/jira/create", { path: notePath, issues: [issue] });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    // Without a parent it goes through.
    const ok = await post("/api/jira/create", { path: notePath, issues: [{ ...issue, parent: null }] });
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("half-done create: returns both lists and writes back only what was created", async () => {
    const { post, notePath, draft } = await drafted((req, n) => {
      if (n === 1) return envelope(JSON.stringify([{ draftId: "e1", error: "Epic Name is required" }]));
      return createAnswer(7001)(req);
    });
    const res = await post("/api/jira/create", { path: notePath, issues: draft.issues });
    expect(res.status).toBe(200);
    const result = (await res.json()) as JiraCreateResult;
    expect(result.created.map((c) => [c.draftId, c.key])).toEqual([["t1", "AN-7001"], ["t3", "AN-7002"]]);
    expect(result.failed).toEqual([
      { draftId: "e1", error: "Jira refused it: Epic Name is required" },
      { draftId: "t2", error: "Not created: its new epic was not created" },
    ]);
    const body = (await notes.read(notePath)).body;
    expect(body).toContain("Ask Sara for the claims export (AN-7001)");
    expect(body).toContain("- [ ] Send the signed slip to finance\n");
    expect(body).toContain("مع أحمد (AN-7002)");
  });

  it("a run that returns a non-AN key is a failure, and nothing is written for it", async () => {
    const { post, notePath, draft } = await drafted((req) => {
      const out = createAnswer(1)(req);
      return { ...out, stdout: out.stdout.replace(/AN-(\d+)/g, "XX-$1") };
    });
    const tasksOnly = draft.issues.filter((i) => i.draftId === "t1");
    const result = (await (await post("/api/jira/create", { path: notePath, issues: tasksOnly })).json()) as JiraCreateResult;
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([{ draftId: "t1", error: expect.stringMatching(/not a AN issue key/) }]);
    expect((await notes.read(notePath)).body).toBe(MEETING);
  });

  it("reports a write-back conflict when the note changed during the run, and still returns the keys", async () => {
    let notePathForEdit = "";
    const { post, notePath, draft } = await drafted(async (req) => {
      // Islam edits the note in Obsidian while Jira is being written to.
      const current = await notes.read(notePathForEdit);
      await notes.update(notePathForEdit, { body: `${current.body}\n- [ ] A new line typed during the run` });
      return createAnswer(8001)(req);
    });
    notePathForEdit = notePath;
    const tasksOnly = draft.issues.filter((i) => i.draftId === "t1" || i.draftId === "t3");
    const res = await post("/api/jira/create", { path: notePath, issues: tasksOnly });
    expect(res.status).toBe(200);
    const result = (await res.json()) as JiraCreateResult;
    expect(result.created.map((c) => c.key)).toEqual(["AN-8001", "AN-8002"]);
    expect(result.failed).toEqual([{ draftId: "write-back", error: "Created in Jira, but the note changed; add the keys by hand: AN-8001, AN-8002" }]);
    const body = (await notes.read(notePath)).body;
    expect(body).toContain("A new line typed during the run");
    expect(body).not.toContain("AN-8001");
    expect(refreshes).toBe(0);
    expect(logs[0]).toMatch(/write-back conflict$/);
  });

  it("answers 503 when the connector is not signed in and nothing was created", async () => {
    const { post, notePath, draft } = await drafted(() => envelope('{"status":"unavailable"}'));
    const res = await post("/api/jira/create", { path: notePath, issues: draft.issues });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: signInMessage("jira") });
    expect((await notes.read(notePath)).body).toBe(MEETING);
  });

  it("is single-flight: a second create while one runs gets 409", async () => {
    let release: (r: RunResult) => void = () => undefined;
    let started = false;
    const { post, notePath, draft } = await drafted(
      () =>
        new Promise<RunResult>((resolve) => {
          started = true;
          release = resolve;
        }),
    );
    const tasksOnly = draft.issues.filter((i) => i.draftId === "t1");
    const first = post("/api/jira/create", { path: notePath, issues: tasksOnly });
    await vi.waitFor(() => expect(started).toBe(true));
    const second = await post("/api/jira/create", { path: notePath, issues: tasksOnly });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "A Jira create is already running" });
    release(envelope('[{"draftId":"t1","key":"AN-1"}]'));
    expect((await first).status).toBe(200);
    // Free again afterwards.
    const third = await post("/api/jira/create", { path: notePath, issues: tasksOnly });
    expect(third.status).toBe(400); // t1's action is filed now
  });
});

describe("mounted in the app", () => {
  it("sits behind the app's guards: a cross-site create is refused before the router", async () => {
    const nextMoves = {
      get: async () => ({ generatedAt: null, status: "never_run", moves: [] }) as NextMovesFile,
      run: async () => ({ generatedAt: null, status: "never_run", moves: [] }) as NextMovesFile,
      setState: async () => null,
    };
    const app = createApp({
      snapshots: { get: () => ({}) as Snapshot, refresh: async () => ({}) as Snapshot, refreshLocal: async () => ({}) as Snapshot },
      nextMoves,
      saveCheckin: async () => undefined,
      store,
      notes,
      now: () => NOW,
      log: () => undefined,
    });
    // issues: [] can never reach a run, even if a guard failed.
    const body = JSON.stringify({ path: "Meeting notes/x.md", issues: [] });
    const headers = { "content-type": "application/json" };
    const crossOrigin = await app.request("/api/jira/create", { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await app.request("/api/jira/create", { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body });
    expect(crossSite.status).toBe(403);
    const rebinding = await app.request("http://evil.example/api/jira/actions?path=x.md", { headers: { host: "evil.example" } });
    expect(rebinding.status).toBe(403);
    await notes.index();
    const missing = await app.request("/api/jira/actions?path=Meeting%20notes%2Fnope.md");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: expect.any(String) });
  });
});
