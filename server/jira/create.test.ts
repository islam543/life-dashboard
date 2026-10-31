import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JiraDraftIssue } from "../../shared/types";
import { NOT_LOGGED_IN_MESSAGE, type RunRequest, type RunResult } from "../ai/nextMoves";
import { signInMessage } from "../connectors/tools";
import { buildCreatePrompt, buildPayload, createIssues, createOrder, interpretCreateRun, type CreateSettings, type IssuePayload } from "./create";
import { CREATE_TOOL, validateDraftIssues } from "./draft";

const SETTINGS = { site: "qicbizdev.atlassian.net", accountId: "712020:test-account", projectKey: "AN" };

const envelope = (result: string) => JSON.stringify({ type: "result", result, is_error: false });
const ok = (result: string): RunResult => ({ exitCode: 0, stdout: envelope(result), stderr: "", timedOut: false });

const epic: JiraDraftIssue = {
  draftId: "e1",
  actionIds: [],
  type: "Epic",
  summary: "Claims export follow-up",
  description: "Work that came out of the claims sync meeting.",
  parent: null,
};
const underNew: JiraDraftIssue = {
  draftId: "t1",
  actionIds: ["act-a"],
  type: "Task",
  summary: "Ask Sara for the claims export",
  description: "Sara owns the export; we need it before Thursday.",
  parent: { kind: "new", draftId: "e1" },
};
const underExisting: JiraDraftIssue = {
  draftId: "t2",
  actionIds: ["act-b"],
  type: "Task",
  summary: "Send the signed slip to finance",
  description: "Finance needs the signed slip to close the claim.",
  parent: { kind: "existing", key: "AN-3977" },
};
const noParent: JiraDraftIssue = { ...underExisting, draftId: "t3", actionIds: ["act-c"], parent: null };

describe("payload building", () => {
  it("orders new Epics before Tasks", () => {
    const { epics, tasks } = createOrder([underNew, underExisting, epic]);
    expect(epics.map((i) => i.draftId)).toEqual(["e1"]);
    expect(tasks.map((i) => i.draftId)).toEqual(["t1", "t2"]);
  });

  it("gives exact payloads: project and assignee from config, parent key for Tasks only", () => {
    expect(buildPayload(epic, SETTINGS, new Map())).toEqual({
      ok: true,
      payload: {
        draftId: "e1",
        cloudId: "qicbizdev.atlassian.net",
        projectKey: "AN",
        issueTypeName: "Epic",
        summary: "Claims export follow-up",
        description: "Work that came out of the claims sync meeting.",
        assignee_account_id: "712020:test-account",
      },
    });
    expect(buildPayload(underExisting, SETTINGS, new Map())).toMatchObject({ ok: true, payload: { issueTypeName: "Task", parent: "AN-3977" } });
    const none = buildPayload(noParent, SETTINGS, new Map());
    expect(none.ok && "parent" in none.payload).toBe(false);
  });

  it("fills a new Epic's created key into its Tasks, and refuses when the Epic was not created", () => {
    expect(buildPayload(underNew, SETTINGS, new Map([["e1", "AN-5001"]]))).toMatchObject({ ok: true, payload: { parent: "AN-5001" } });
    expect(buildPayload(underNew, SETTINGS, new Map())).toEqual({ ok: false, error: "Not created: its new epic was not created" });
  });

  it("never takes the assignee or project from the issue", () => {
    const check = validateDraftIssues([{ ...underExisting, assignee: "someone-else", projectKey: "EVIL", parent: null }], {
      epicKeys: new Set(),
      actionIds: new Set(["act-b"]),
      projectKey: "AN",
      orphanEpics: "reject",
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      const built = buildPayload(check.issues[0]!, SETTINGS, new Map());
      expect(built.ok && built.payload.assignee_account_id).toBe("712020:test-account");
      expect(built.ok && built.payload.projectKey).toBe("AN");
    }
  });

  it("puts the payloads in the prompt as JSON with the create tool", () => {
    const payload: IssuePayload = { draftId: "t1", cloudId: "s", projectKey: "AN", issueTypeName: "Task", summary: 'Do "it"\nnow', description: "d", assignee_account_id: "a" };
    const prompt = buildCreatePrompt([payload]);
    expect(prompt).toContain(`select:${CREATE_TOOL}`);
    expect(prompt).toContain('"summary": "Do \\"it\\"\\nnow"');
    expect(prompt).toContain('[{"draftId":"t1","key":"AN-123"}]');
  });
});

describe("interpretCreateRun", () => {
  it("accepts project keys for the batch", () => {
    const out = interpretCreateRun(ok('[{"draftId":"t1","key":"AN-5002"},{"draftId":"t2","key":"AN-5003"}]'), ["t1", "t2"], "AN");
    expect([...out.created]).toEqual([["t1", "AN-5002"], ["t2", "AN-5003"]]);
    expect(out.failed.size).toBe(0);
  });

  it("fails every key that is not ^AN-\\d+$", () => {
    for (const key of ["XX-5002", "an-5002", "AN-5002x", " AN-5002", "AN-", "https://evil/AN-1", 5002]) {
      const out = interpretCreateRun(ok(JSON.stringify([{ draftId: "t1", key }])), ["t1"], "AN");
      expect(out.created.size, String(key)).toBe(0);
      expect(out.failed.get("t1"), String(key)).toMatch(/not a AN issue key/);
    }
  });

  it("fails missing entries, keeps reported errors, ignores unknown or repeated draftIds and a key used twice", () => {
    const out = interpretCreateRun(
      ok(
        JSON.stringify([
          { draftId: "t1", key: "AN-1" },
          { draftId: "t1", key: "AN-9" },
          { draftId: "zzz", key: "AN-2" },
          { draftId: "t2", key: "AN-1" },
          { draftId: "t3", error: "Field 'parent' is invalid" },
          { draftId: "t4" },
        ]),
      ),
      ["t1", "t2", "t3", "t4", "t5"],
      "AN",
    );
    expect([...out.created]).toEqual([["t1", "AN-1"]]);
    expect(out.failed.get("t2")).toMatch(/returned AN-1 for two issues/);
    expect(out.failed.get("t3")).toBe("Jira refused it: Field 'parent' is invalid");
    expect(out.failed.get("t4")).toMatch(/did not return a key/);
    expect(out.failed.get("t5")).toMatch(/did not report on it/);
    expect(out.ignored).toBe(2);
  });

  it("fails the whole batch when the run fails, warning that issues may exist", () => {
    const timeout = interpretCreateRun({ exitCode: null, stdout: "", stderr: "", timedOut: true }, ["t1"], "AN");
    expect(timeout.runFailure?.reason).toBe("timeout");
    expect(timeout.failed.get("t1")).toMatch(/may have been created/);
    const prose = interpretCreateRun(ok("Done! Created both."), ["t1"], "AN");
    expect(prose.failed.get("t1")).toMatch(/no JSON list.*may have been created/);
    const login = interpretCreateRun({ exitCode: 1, stdout: "", stderr: "Not logged in", timedOut: false }, ["t1"], "AN");
    expect(login.runFailure?.kind).toBe("not_logged_in");
    expect(login.failed.get("t1")).toBe(NOT_LOGGED_IN_MESSAGE);
    const signIn = interpretCreateRun(ok('{"status":"unavailable"}'), ["t1"], "AN");
    expect(signIn.runFailure?.kind).toBe("unavailable");
    expect(signIn.failed.get("t1")).toBe(signInMessage("jira"));
  });
});

describe("createIssues", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-jira-create-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** A fake CLI: `answer` gets the payloads of each run. */
  function settings(answer: (payloads: IssuePayload[], run: number) => RunResult): CreateSettings & { calls: RunRequest[] } {
    const calls: RunRequest[] = [];
    return {
      ...SETTINGS,
      command: "claude-fake",
      env: { PATH: "x" },
      runDir: path.join(tmp, "jira-run"),
      timeoutMs: 1000,
      calls,
      runner: async (req) => {
        calls.push(req);
        const prompt = req.args[1]!;
        const json = prompt.slice(prompt.indexOf("Payloads (JSON):\n") + 17, prompt.indexOf("\n\nReply with"));
        return answer(JSON.parse(json) as IssuePayload[], calls.length);
      },
    };
  }

  it("creates new Epics in a first run, then Tasks with the Epic's key as parent", async () => {
    let next = 5000;
    const s = settings((payloads) => ok(JSON.stringify(payloads.map((p) => ({ draftId: p.draftId, key: `AN-${++next}` })))));
    const out = await createIssues([underNew, underExisting, epic, noParent], s);
    expect(s.calls).toHaveLength(2);
    for (const call of s.calls) {
      expect(call.command).toBe("claude-fake");
      expect(call.cwd).toBe(path.join(tmp, "jira-run"));
      expect(call.args[call.args.indexOf("--allowedTools") + 1]).toBe(CREATE_TOOL);
    }
    const firstPrompt = s.calls[0]!.args[1]!;
    expect(firstPrompt).toContain('"issueTypeName": "Epic"');
    expect(firstPrompt).not.toContain('"issueTypeName": "Task"');
    const secondPrompt = s.calls[1]!.args[1]!;
    expect(secondPrompt).toContain('"parent": "AN-5001"');
    expect(secondPrompt).toContain('"parent": "AN-3977"');
    expect(out.result).toEqual({
      created: [
        { draftId: "e1", key: "AN-5001", url: "https://qicbizdev.atlassian.net/browse/AN-5001", type: "Epic" },
        { draftId: "t1", key: "AN-5002", url: "https://qicbizdev.atlassian.net/browse/AN-5002", type: "Task" },
        { draftId: "t2", key: "AN-5003", url: "https://qicbizdev.atlassian.net/browse/AN-5003", type: "Task" },
        { draftId: "t3", key: "AN-5004", url: "https://qicbizdev.atlassian.net/browse/AN-5004", type: "Task" },
      ],
      failed: [],
    });
    expect(out.signIn).toBeUndefined();
  });

  it("skips the Epic run when there are no new Epics", async () => {
    const s = settings((payloads) => ok(JSON.stringify(payloads.map((p, i) => ({ draftId: p.draftId, key: `AN-${i + 1}` })))));
    const out = await createIssues([underExisting], s);
    expect(s.calls).toHaveLength(1);
    expect(out.result.created.map((c) => c.key)).toEqual(["AN-1"]);
  });

  it("half-done: the Epic fails, its Tasks are not created, the other Tasks are", async () => {
    const s = settings((payloads, run) =>
      run === 1
        ? ok(JSON.stringify([{ draftId: "e1", error: "Epic Name is required" }]))
        : ok(JSON.stringify(payloads.map((p) => ({ draftId: p.draftId, key: "AN-7001" })))),
    );
    const out = await createIssues([epic, underNew, underExisting], s);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.args[1]).not.toContain('"draftId": "t1"');
    expect(out.result.created).toEqual([{ draftId: "t2", key: "AN-7001", url: "https://qicbizdev.atlassian.net/browse/AN-7001", type: "Task" }]);
    expect(out.result.failed).toEqual([
      { draftId: "e1", error: "Jira refused it: Epic Name is required" },
      { draftId: "t1", error: "Not created: its new epic was not created" },
    ]);
  });

  it("stops after a sign-in failure and reports it when nothing was created", async () => {
    const s = settings(() => ok('{"status":"unavailable"}'));
    const out = await createIssues([epic, underNew, underExisting], s);
    expect(s.calls).toHaveLength(1);
    expect(out.signIn?.message).toBe(signInMessage("jira"));
    expect(out.result.created).toEqual([]);
    expect(out.result.failed.map((f) => f.draftId)).toEqual(["e1", "t1", "t2"]);
  });

  it("does not report sign-in when something was created before it failed", async () => {
    const s = settings((payloads, run) =>
      run === 1 ? ok(JSON.stringify([{ draftId: "e1", key: "AN-1" }])) : { exitCode: 1, stdout: "", stderr: "Please run /login", timedOut: false },
    );
    const out = await createIssues([epic, underNew], s);
    expect(out.signIn).toBeUndefined();
    expect(out.result.created.map((c) => c.key)).toEqual(["AN-1"]);
    expect(out.result.failed).toEqual([{ draftId: "t1", error: NOT_LOGGED_IN_MESSAGE }]);
  });

  it("treats a runner that throws as a failed run", async () => {
    const s = settings(() => {
      throw new Error("boom");
    });
    const out = await createIssues([underExisting], s);
    expect(out.result.failed).toEqual([{ draftId: "t2", error: "Could not start claude (RUN_FAILED)." }]);
  });
});

describe("Product field (AN requires customfield_11461)", () => {
  const product = { field: "customfield_11461", workspaceId: "141cbb86-962b-4bb8-8f49-676bb76f7433", objectId: "948" };
  const task = { draftId: "t1", actionIds: ["a1"], type: "Task" as const, summary: "Collect the treaty files", description: "Ask the reinsurance team for the files.", parent: { kind: "existing" as const, key: "AN-3977" } };
  const epic = { draftId: "e1", actionIds: [], type: "Epic" as const, summary: "Reinsurance ledger", description: "Everything about the reinsurance ledger export.", parent: null };

  it("puts the Assets reference on every Task and Epic, in the shape Jira stores it", () => {
    for (const issue of [task, epic]) {
      const built = buildPayload(issue, { site: "s", accountId: "a", projectKey: "AN", product }, new Map());
      expect(built.ok && built.payload.additional_fields).toEqual({
        customfield_11461: [{ workspaceId: product.workspaceId, id: `${product.workspaceId}:948`, objectId: "948" }],
      });
    }
  });

  it("the create prompt passes it through as payload data", () => {
    const built = buildPayload(task, { site: "s", accountId: "a", projectKey: "AN", product }, new Map());
    const prompt = buildCreatePrompt(built.ok ? [built.payload] : []);
    expect(prompt).toContain('"customfield_11461"');
    expect(prompt).toContain(`"id": "${product.workspaceId}:948"`);
  });
});

describe("status at creation", () => {
  const settings = { site: "s", accountId: "a", projectKey: "AN" };
  const base = { draftId: "t1", actionIds: ["a1"], summary: "Collect the treaty files", description: "Ask the reinsurance team for the files.", parent: null };

  it("maps each Task status to its AN workflow transition", () => {
    const want = { todo: "61", inprogress: "31", onhold: "81", done: "41", backlog: "11" } as const;
    for (const [status, id] of Object.entries(want)) {
      const built = buildPayload({ ...base, type: "Task", status: status as keyof typeof want }, settings, new Map());
      expect(built.ok && built.payload.transition).toEqual({ id });
    }
  });

  it("defaults a Task to To Do and an Epic to Backlog (no transition)", () => {
    const task = buildPayload({ ...base, type: "Task" }, settings, new Map());
    expect(task.ok && task.payload.transition).toEqual({ id: "61" });
    const epic = buildPayload({ ...base, draftId: "e1", actionIds: [], type: "Epic" }, settings, new Map());
    expect(epic.ok && epic.payload.transition).toBeUndefined();
  });

  it("lets an Epic start In Progress, and ignores statuses an Epic cannot take", () => {
    const go = buildPayload({ ...base, draftId: "e1", actionIds: [], type: "Epic", status: "inprogress" }, settings, new Map());
    expect(go.ok && go.payload.transition).toEqual({ id: "21" });
    const done = buildPayload({ ...base, draftId: "e1", actionIds: [], type: "Epic", status: "done" }, settings, new Map());
    expect(done.ok && done.payload.transition).toBeUndefined();
  });
});
