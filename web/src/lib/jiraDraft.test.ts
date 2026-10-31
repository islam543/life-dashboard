import { describe, expect, it } from "vitest";
import type { DetectedAction, JiraDraft, JiraDraftIssue } from "../../../shared/types";
import {
  actionCounts,
  activeNewEpicIds,
  bodyHasKey,
  checkReview,
  countsText,
  createPayload,
  DEFAULT_JIRA_SITE,
  draftBlockedReason,
  draftCounts,
  editIssue,
  elapsedText,
  groupByEpic,
  jiraErrorKind,
  jiraIssueUrl,
  jiraSiteFrom,
  outcomeText,
  parentOptions,
  parentValue,
  parseParentValue,
  readCreateResult,
  setEpicTasksIncluded,
  toReview,
  WRITE_BACK_ID,
} from "./jiraDraft";

const action = (id: string, over: Partial<DetectedAction> = {}): DetectedAction => ({
  id,
  text: `Action ${id}`,
  line: 1,
  done: false,
  jiraKey: null,
  ...over,
});

const task = (draftId: string, parent: JiraDraftIssue["parent"], actionIds = [`a-${draftId}`]): JiraDraftIssue => ({
  draftId,
  actionIds,
  type: "Task",
  summary: `Task ${draftId} summary`,
  description: `A description for ${draftId} that is long enough.`,
  parent,
});

const epic = (draftId: string): JiraDraftIssue => ({
  draftId,
  actionIds: [],
  type: "Epic",
  summary: `Epic ${draftId}`,
  description: `Epic ${draftId} description, long enough to pass.`,
  parent: null,
});

const DRAFT: JiraDraft = {
  notePath: "Meeting notes/2026-10-30-sync.md",
  createdAt: "2026-10-31T09:00:00Z",
  epics: [
    { key: "AN-3977", summary: "QIC FastBind" },
    { key: "AN-4373", summary: "MVHI Claims Copilot" },
  ],
  issues: [
    task("t1", { kind: "existing", key: "AN-3977" }),
    epic("e1"),
    task("t2", { kind: "new", draftId: "e1" }),
    task("t3", { kind: "new", draftId: "e1" }),
    task("t4", null),
    task("t5", { kind: "existing", key: "AN-3977" }),
  ],
};

describe("jira links", () => {
  it("builds links only for AN keys on a host name", () => {
    expect(jiraIssueUrl("AN-4602", "acme.atlassian.net")).toBe("https://acme.atlassian.net/browse/AN-4602");
    expect(jiraIssueUrl("FB-1", "acme.atlassian.net")).toBeNull();
    expect(jiraIssueUrl("AN-12 ", "acme.atlassian.net")).toBeNull();
    expect(jiraIssueUrl(null, "acme.atlassian.net")).toBeNull();
    expect(jiraIssueUrl("AN-1", "evil.com/x?")).toBeNull();
  });

  it("reads the site from server-built links and falls back to the default", () => {
    expect(jiraSiteFrom(["https://acme.atlassian.net/browse/AN-1"])).toBe("acme.atlassian.net");
    expect(jiraSiteFrom([undefined, "http://acme.atlassian.net/browse/AN-1", "nope"])).toBe(DEFAULT_JIRA_SITE);
    expect(jiraSiteFrom(["https://acme.atlassian.net/jira/AN-1"])).toBe(DEFAULT_JIRA_SITE);
    expect(jiraSiteFrom([])).toBe(DEFAULT_JIRA_SITE);
  });
});

describe("detected actions", () => {
  it("counts open, done, filed and draftable actions", () => {
    const list = [action("1"), action("2", { done: true }), action("3", { jiraKey: "AN-1" }), action("4")];
    expect(actionCounts(list)).toEqual({ total: 4, done: 1, filed: 1, draftable: 2 });
  });

  it("says why drafting is off", () => {
    expect(draftBlockedReason([])).toBe("No actions in this note to draft.");
    expect(draftBlockedReason([action("1", { jiraKey: "AN-1" })])).toBe("Every action is already filed in Jira.");
    expect(draftBlockedReason([action("1", { jiraKey: "AN-1" }), action("2", { done: true })])).toBe(
      "Every action is already filed in Jira or done.",
    );
    expect(draftBlockedReason([action("1", { jiraKey: "AN-1" }), action("2")])).toBeNull();
  });
});

describe("epic grouping", () => {
  it("groups tasks under existing epics, new epics, then no epic", () => {
    const groups = groupByEpic(toReview(DRAFT));
    expect(groups.map((g) => g.id)).toEqual(["existing:AN-3977", "new:e1", "none"]);
    expect(groups[0].tasks.map((t) => t.draftId)).toEqual(["t1", "t5"]);
    expect(groups[0].kind === "existing" && groups[0].summary).toBe("QIC FastBind");
    expect(groups[1].tasks.map((t) => t.draftId)).toEqual(["t2", "t3"]);
    expect(groups[2].tasks.map((t) => t.draftId)).toEqual(["t4"]);
  });

  it("leaves out epics with no tasks and moves a task with its picker", () => {
    let review = toReview(DRAFT);
    review = editIssue(review, "t2", { parent: { kind: "existing", key: "AN-4373" } });
    review = editIssue(review, "t3", { parent: null });
    const ids = groupByEpic(review).map((g) => g.id);
    expect(ids).toEqual(["existing:AN-3977", "existing:AN-4373", "none"]);
  });

  it("drops a new epic when all its tasks are left out or moved", () => {
    let review = toReview(DRAFT);
    review = editIssue(review, "t2", { include: false });
    expect(activeNewEpicIds(review)).toEqual(new Set(["e1"]));
    review = editIssue(review, "t3", { include: false });
    expect(activeNewEpicIds(review).size).toBe(0);
    const group = groupByEpic(review).find((g) => g.id === "new:e1");
    expect(group?.kind === "new" && group.dropped).toBe(true);
    expect(createPayload(review).some((i) => i.type === "Epic")).toBe(false);

    const moved = editIssue(editIssue(toReview(DRAFT), "t2", { parent: null }), "t3", { parent: null });
    expect(groupByEpic(moved).some((g) => g.id === "new:e1")).toBe(false);
    expect(draftCounts(moved)).toEqual({ tasks: 5, epics: 0 });
  });

  it("includes or leaves out every task of a new epic at once", () => {
    const off = setEpicTasksIncluded(toReview(DRAFT), "e1", false);
    expect(off.issues.filter((i) => !i.include).map((i) => i.draftId)).toEqual(["t2", "t3"]);
    expect(setEpicTasksIncluded(off, "e1", true).issues.every((i) => i.include)).toBe(true);
  });

  it("shows a task whose epic is unknown instead of hiding it", () => {
    const review = toReview({ ...DRAFT, issues: [task("t9", { kind: "existing", key: "AN-1" }), task("t8", { kind: "new", draftId: "gone" })] });
    const groups = groupByEpic(review);
    expect(groups.map((g) => g.id)).toEqual(["existing:AN-1", "none"]);
    expect(groups[0].kind === "existing" && groups[0].known).toBe(false);
  });
});

describe("epic picker", () => {
  it("round-trips parent values", () => {
    for (const p of [null, { kind: "existing", key: "AN-3977" }, { kind: "new", draftId: "e1" }] as const) {
      expect(parseParentValue(parentValue(p))).toEqual(p);
    }
  });

  it("lists existing epics, new epics, then No epic", () => {
    expect(parentOptions(toReview(DRAFT)).map((o) => o.label)).toEqual([
      "AN-3977: QIC FastBind",
      "AN-4373: MVHI Claims Copilot",
      "New epic: Epic e1",
      "No epic",
    ]);
  });
});

describe("create payload", () => {
  it("sends the active new epics first, then included tasks, trimmed and without the include flag", () => {
    let review = toReview(DRAFT);
    review = editIssue(review, "t1", { summary: "  Send the slip to finance  " });
    review = editIssue(review, "t4", { include: false });
    const payload = createPayload(review);
    expect(payload.map((i) => i.draftId)).toEqual(["e1", "t1", "t2", "t3", "t5"]);
    expect(payload[1].summary).toBe("Send the slip to finance");
    expect(payload.every((i) => !("include" in i))).toBe(true);
    expect(payload[0].parent).toBeNull();
    expect(payload[2].parent).toEqual({ kind: "new", draftId: "e1" });
  });
});

describe("counts text", () => {
  it("reads like the footer", () => {
    expect(countsText({ tasks: 3, epics: 1 })).toBe("Creates 3 tasks and 1 epic in AN, assigned to you");
    expect(countsText({ tasks: 1, epics: 2 })).toBe("Creates 1 task and 2 epics in AN, assigned to you");
    expect(countsText({ tasks: 4, epics: 0 })).toBe("Creates 4 tasks in AN, assigned to you");
    expect(countsText({ tasks: 0, epics: 0 })).toBe("Nothing to create: include at least one task.");
    expect(countsText(draftCounts(toReview(DRAFT)))).toBe("Creates 5 tasks and 1 epic in AN, assigned to you");
  });
});

describe("checks", () => {
  it("passes a valid draft", () => {
    const ids = new Set(DRAFT.issues.flatMap((i) => i.actionIds));
    expect(checkReview(toReview(DRAFT), ids)).toEqual({ issues: {}, form: null, ok: true });
  });

  it("flags short and long fields, unknown epics and stale actions", () => {
    let review = toReview(DRAFT);
    review = editIssue(review, "t1", { summary: "abc", description: "x".repeat(1501) });
    review = editIssue(review, "t5", { parent: { kind: "existing", key: "AN-9999" } });
    review = editIssue(review, "e1", { summary: "    " });
    const check = checkReview(review, new Set(["a-t1", "a-t2", "a-t3", "a-t4"]));
    expect(check.ok).toBe(false);
    expect(check.issues.t1.summary).toMatch(/at least 5/);
    expect(check.issues.t1.description).toMatch(/1501 characters/);
    expect(check.issues.t5.parent).toMatch(/open epics/);
    expect(check.issues.t5.actions).toMatch(/no longer in the note/);
    expect(check.issues.e1.summary).toMatch(/at least 5/);
  });

  it("ignores left-out tasks and a dropped epic", () => {
    let review = editIssue(toReview(DRAFT), "e1", { summary: "" });
    review = setEpicTasksIncluded(review, "e1", false);
    review = editIssue(review, "t4", { include: false, summary: "" });
    expect(checkReview(review, null).ok).toBe(true);
  });

  it("needs one task and at most 15 issues", () => {
    const none = toReview({ ...DRAFT, issues: DRAFT.issues.map((i) => i) });
    const allOff = { ...none, issues: none.issues.map((i) => ({ ...i, include: false })) };
    expect(checkReview(allOff, null).form).toBe("Include at least one task to create.");
    const many = toReview({ ...DRAFT, issues: Array.from({ length: 16 }, (_, n) => task(`m${n}`, null)) });
    expect(checkReview(many, null).form).toMatch(/16 issues.*at most 15.*Leave out 1/);
  });
});

describe("create result", () => {
  const review = toReview(DRAFT);

  it("adds summaries and keeps the server's write-back warning", () => {
    const outcome = readCreateResult(
      {
        created: [
          { draftId: "e1", key: "AN-5000", url: "https://x.atlassian.net/browse/AN-5000", type: "Epic" },
          { draftId: "t2", key: "AN-5001", url: "https://x.atlassian.net/browse/AN-5001", type: "Task" },
        ],
        failed: [
          { draftId: "t3", error: "Jira said no" },
          { draftId: WRITE_BACK_ID, error: "Created in Jira, but the note changed; add the keys by hand: AN-5001" },
        ],
      },
      review,
      null,
    );
    expect(outcome.created.map((c) => c.summary)).toEqual(["Epic e1", "Task t2 summary"]);
    expect(outcome.failed).toEqual([{ draftId: "t3", summary: "Task t3 summary", error: "Jira said no" }]);
    expect(outcome.writeBack).toMatch(/add the keys by hand: AN-5001/);
    expect(outcomeText(outcome)).toBe("Created 2 issues in Jira; 1 failed.");
  });

  it("finds keys missing from the re-read note", () => {
    const result = {
      created: [
        { draftId: "t1", key: "AN-12", url: "", type: "Task" as const },
        { draftId: "t5", key: "AN-13", url: "", type: "Task" as const },
      ],
      failed: [],
    };
    const outcome = readCreateResult(result, review, "- [ ] One (AN-123)\n- [ ] Two (AN-13)\n");
    expect(outcome.writeBack).toBe("Created in Jira, but the note changed; add the keys by hand: AN-12");
    expect(readCreateResult(result, review, "- [ ] One (AN-12)\n- [ ] Two (AN-13)").writeBack).toBeNull();
  });

  it("drops created keys that are not AN keys", () => {
    const outcome = readCreateResult({ created: [{ draftId: "t1", key: "<b>x</b>", url: "", type: "Task" }], failed: [] }, review, null);
    expect(outcome.created).toEqual([]);
    expect(outcomeText(outcome)).toBe("Nothing was created in Jira.");
  });

  it("matches whole keys only", () => {
    expect(bodyHasKey("Send slip (AN-4602)", "AN-4602")).toBe(true);
    expect(bodyHasKey("Send slip (AN-46021)", "AN-4602")).toBe(false);
    expect(bodyHasKey("XAN-4602", "AN-4602")).toBe(false);
  });
});

describe("errors and timing", () => {
  it("maps statuses to what the section says", () => {
    expect(jiraErrorKind(501, false)).toBe("not_ready");
    expect(jiraErrorKind(503, false)).toBe("sign_in");
    expect(jiraErrorKind(409, false)).toBe("busy");
    expect(jiraErrorKind(400, false)).toBe("invalid");
    expect(jiraErrorKind(502, false)).toBe("failed");
    expect(jiraErrorKind(0, true)).toBe("offline");
  });

  it("formats elapsed time", () => {
    expect(elapsedText(0)).toBe("0 s");
    expect(elapsedText(42_900)).toBe("42 s");
    expect(elapsedText(65_000)).toBe("1 min 05 s");
  });
});
