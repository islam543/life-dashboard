import { describe, expect, it } from "vitest";
import type { FocusItem, FocusReason, FocusState, TaskNote } from "../../../shared/types";
import {
  FOCUS_POLL_LIMIT_MS,
  MAX_STEPS,
  cleanSteps,
  focusJiraUrl,
  focusLabel,
  focusRowMeta,
  hasPendingSteps,
  openPath,
  orderFocusItems,
  pollState,
  restoreFocusItem,
  stepsView,
  withFocusItem,
  withStepsPending,
  withoutFocusItem,
} from "./focus";

const TODAY = "2026-10-31";

function task(path: string, extra: Partial<TaskNote["task"]> = {}): TaskNote {
  return {
    path,
    section: "Tasks",
    title: path.replace(/^Tasks\/|\.md$/g, ""),
    created: "2026-10-30T08:00:00.000Z",
    updated: "2026-10-30T08:00:00.000Z",
    projectId: null,
    tags: [],
    excerpt: "",
    openActions: 0,
    task: { due: TODAY, start: null, minutes: null, done: false, source: "me", ...extra },
  };
}

function item(path: string, reason: FocusReason, extra: Partial<FocusItem> = {}, taskExtra: Partial<TaskNote["task"]> = {}): FocusItem {
  return {
    task: task(path, taskExtra),
    reason,
    label: "",
    projectName: null,
    jiraKey: null,
    steps: ["Open the file", "Write the test"],
    stepsStatus: "ready",
    ...extra,
  };
}

const state = (items: FocusItem[]): FocusState => ({ generatedAt: "2026-10-31T10:00:00.000Z", items });
const paths = (items: readonly FocusItem[]) => items.map((i) => i.task.path);

describe("order", () => {
  it("puts now, then next, overdue and today, keeping the server's order inside each", () => {
    const items = [
      item("Tasks/today.md", "today"),
      item("Tasks/old.md", "overdue"),
      item("Tasks/next-2.md", "next"),
      item("Tasks/now.md", "now"),
      item("Tasks/older.md", "overdue"),
      item("Tasks/next-1.md", "next"),
    ];
    expect(paths(orderFocusItems(items))).toEqual([
      "Tasks/now.md",
      "Tasks/next-2.md",
      "Tasks/next-1.md",
      "Tasks/old.md",
      "Tasks/older.md",
      "Tasks/today.md",
    ]);
  });

  it("keeps at most 6 items, one per task", () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`Tasks/t${i}.md`, "today"));
    expect(orderFocusItems(many)).toHaveLength(6);
    expect(paths(orderFocusItems([item("Tasks/a.md", "now"), item("Tasks/a.md", "today")]))).toEqual(["Tasks/a.md"]);
    expect(orderFocusItems([])).toEqual([]);
  });
});

describe("display text", () => {
  it("uses the server's label", () => {
    expect(focusLabel(item("Tasks/a.md", "now", { label: "Now until 15:30" }))).toBe("Now until 15:30");
    expect(focusLabel(item("Tasks/a.md", "now", { label: "   " }, { start: "15:00", minutes: 30 }))).toBe("Now until 15:30");
  });

  it("builds the same words when the label is missing", () => {
    expect(focusLabel(item("Tasks/a.md", "now", {}, { start: "15:00", minutes: 30 }))).toBe("Now until 15:30");
    expect(focusLabel(item("Tasks/a.md", "now"))).toBe("Now");
    expect(focusLabel(item("Tasks/a.md", "next", {}, { start: "16:00", minutes: 45 }))).toBe("Next at 16:00");
    expect(focusLabel(item("Tasks/a.md", "overdue", {}, { due: "2026-10-29" }))).toBe("Overdue since Thu 29 Oct");
    expect(focusLabel(item("Tasks/a.md", "overdue", {}, { due: null }))).toBe("Overdue");
    // A block that ended earlier today is overdue since its end time.
    expect(focusLabel(item("Tasks/a.md", "overdue", {}, { due: TODAY, start: "09:00", minutes: 30 }), TODAY)).toBe("Overdue since 09:30");
    expect(focusLabel(item("Tasks/a.md", "overdue", {}, { due: "2026-10-29", start: "09:00" }), TODAY)).toBe("Overdue since Thu 29 Oct");
    expect(focusLabel(item("Tasks/a.md", "overdue", { label: "Overdue since 09:30" }))).toBe("Overdue since 09:30");
    expect(focusLabel(item("Tasks/a.md", "today"))).toBe("Today, no time set");
  });

  it("joins the label and project for a closed row", () => {
    expect(focusRowMeta(item("Tasks/a.md", "next", { label: "Next at 16:00", projectName: "Life dashboard" }))).toBe("Next at 16:00, Life dashboard");
    expect(focusRowMeta(item("Tasks/a.md", "today", { label: "Today, no time set", projectName: "  " }))).toBe("Today, no time set");
  });

  it("links only AN keys on the configured site", () => {
    expect(focusJiraUrl({ jiraKey: "AN-4602" }, "qicbizdev.atlassian.net")).toBe("https://qicbizdev.atlassian.net/browse/AN-4602");
    expect(focusJiraUrl({ jiraKey: "FB-12" }, "qicbizdev.atlassian.net")).toBeNull();
    expect(focusJiraUrl({ jiraKey: "AN-12 extra" }, "qicbizdev.atlassian.net")).toBeNull();
    expect(focusJiraUrl({ jiraKey: null }, "qicbizdev.atlassian.net")).toBeNull();
    expect(focusJiraUrl({ jiraKey: "AN-1" }, "evil.example/x")).toBeNull();
  });
});

describe("steps", () => {
  it("cleans list markers and blanks, and caps very long lists", () => {
    expect(cleanSteps(["1. Open the file", "2) Run the test", "- Fix it", "* Push", "   ", "• Done"])).toEqual([
      "Open the file",
      "Run the test",
      "Fix it",
      "Push",
      "Done",
    ]);
    expect(cleanSteps(["2026 plan review"])).toEqual(["2026 plan review"]);
    expect(cleanSteps(null)).toEqual([]);
    expect(cleanSteps(Array.from({ length: 20 }, (_, i) => `Step ${i}`))).toHaveLength(MAX_STEPS);
  });

  it("keeps a very long step whole", () => {
    const long = "Read ".repeat(60).trim();
    expect(cleanSteps([long])).toEqual([long]);
  });

  it("names the state of the steps area", () => {
    expect(stepsView(item("Tasks/a.md", "now"))).toEqual({ kind: "ready", steps: ["Open the file", "Write the test"] });
    expect(stepsView(item("Tasks/a.md", "now", { steps: null, stepsStatus: "pending" }))).toEqual({ kind: "pending" });
    expect(stepsView(item("Tasks/a.md", "now", { steps: null, stepsStatus: "error", stepsMessage: "Claude is not logged in" }))).toEqual({
      kind: "error",
      message: "Claude is not logged in.",
    });
    expect(stepsView(item("Tasks/a.md", "now", { steps: null, stepsStatus: "error" }))).toEqual({
      kind: "error",
      message: "Claude couldn't write steps for this task.",
    });
    expect(stepsView(item("Tasks/a.md", "now", { steps: null }))).toEqual({ kind: "missing" });
    expect(stepsView(item("Tasks/a.md", "now", { steps: ["  "] }))).toEqual({ kind: "missing" });
  });

  it("polls while steps are pending, for up to 2 minutes", () => {
    const pending = [item("Tasks/a.md", "now", { steps: null, stepsStatus: "pending" }), item("Tasks/b.md", "next")];
    expect(hasPendingSteps(pending)).toBe(true);
    expect(hasPendingSteps([item("Tasks/b.md", "next")])).toBe(false);
    expect(pollState(pending, null, 0)).toBe("poll");
    expect(pollState(pending, 1_000, 1_000 + FOCUS_POLL_LIMIT_MS - 1)).toBe("poll");
    expect(pollState(pending, 1_000, 1_000 + FOCUS_POLL_LIMIT_MS)).toBe("timeout");
    expect(pollState([item("Tasks/b.md", "next")], 1_000, 999_999)).toBe("idle");
  });
});

describe("open item and local edits", () => {
  const items = [item("Tasks/a.md", "now"), item("Tasks/b.md", "next"), item("Tasks/c.md", "today")];

  it("opens the first item, and keeps the chosen one while it is listed", () => {
    expect(openPath(items, null)).toBe("Tasks/a.md");
    expect(openPath(items, "Tasks/c.md")).toBe("Tasks/c.md");
    // The chosen task disappeared (marked done elsewhere): back to the first.
    expect(openPath(items, "Tasks/gone.md")).toBe("Tasks/a.md");
    expect(openPath([], "Tasks/a.md")).toBeNull();
  });

  it("removes an item on Mark done and puts it back in place when that fails", () => {
    const before = state(items);
    const after = withoutFocusItem(before, "Tasks/b.md");
    expect(paths(after.items)).toEqual(["Tasks/a.md", "Tasks/c.md"]);
    expect(openPath(after.items, "Tasks/b.md")).toBe("Tasks/a.md");
    const back = restoreFocusItem(after, items[1]!, 1);
    expect(paths(back.items)).toEqual(["Tasks/a.md", "Tasks/b.md", "Tasks/c.md"]);
    expect(restoreFocusItem(back, items[1]!, 0)).toBe(back);
    expect(paths(restoreFocusItem(state([]), items[2]!, 5).items)).toEqual(["Tasks/c.md"]);
  });

  it("replaces an item with new steps, and marks steps pending", () => {
    const fresh = item("Tasks/b.md", "next", { steps: ["New step"] });
    const next = withFocusItem(state(items), fresh);
    expect(next.items[1]!.steps).toEqual(["New step"]);
    expect(withFocusItem(state(items), item("Tasks/zz.md", "now")).items).toEqual(items);
    const waiting = withStepsPending(state(items), "Tasks/a.md");
    expect(waiting.items[0]!.stepsStatus).toBe("pending");
    expect(waiting.items[1]!.stepsStatus).toBe("ready");
  });
});
