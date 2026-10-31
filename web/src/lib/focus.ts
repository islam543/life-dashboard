import type { FocusItem, FocusReason, FocusState } from "../../../shared/types";
import { jiraIssueUrl } from "./jiraDraft";
import { formatHm, itemSpan, shortDate } from "./schedule";

// Pure helpers behind the Home Do now panel (panels/DoNowPanel.tsx): the order items show in, the
// words for each one, the state of its AI steps, which item is open, when to poll for steps still
// being written, and the local edits that make Mark done and Regenerate show at once.
// Task, project and AI text is untrusted: the panel renders it as text, and the only outside link is
// a Jira key matching ^AN-\d+$ on the configured site (lib/jiraDraft.ts).

/** The server sends at most this many items. */
export const MAX_FOCUS_ITEMS = 6;
/** Re-read GET /api/focus this often while steps are being written. */
export const FOCUS_POLL_MS = 5_000;
/** Stop polling for steps after this long and offer a manual check instead. */
export const FOCUS_POLL_LIMIT_MS = 2 * 60_000;
/** Steps shown at most per task (the server sends 3 to 7). */
export const MAX_STEPS = 10;

const REASON_ORDER: Record<FocusReason, number> = { now: 0, next: 1, overdue: 2, today: 3 };

/**
 * Most urgent first: the task in progress now, then the next timed ones today, then overdue, then
 * today's untimed ones. The server's order is kept within each group (it already sorts by time and
 * oldest due date). One row per task, at most 6.
 */
export function orderFocusItems(items: readonly FocusItem[]): FocusItem[] {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.task.path)) return false;
    seen.add(item.task.path);
    return true;
  });
  return unique
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (REASON_ORDER[a.item.reason] ?? 9) - (REASON_ORDER[b.item.reason] ?? 9) || a.index - b.index)
    .slice(0, MAX_FOCUS_ITEMS)
    .map((x) => x.item);
}

/**
 * When the item is: the server's label ("Now until 15:30", "Overdue since Thu 29 Oct", "Overdue
 * since 09:30" for a block that ended earlier today), or the same words built from the task when the
 * label is missing. `todayKey` (YYYY-MM-DD) tells a block that ended today from an older due day.
 */
export function focusLabel(item: FocusItem, todayKey?: string): string {
  const label = item.label?.trim();
  if (label) return label;
  const span = itemSpan(item.task.task.start, item.task.task.minutes);
  switch (item.reason) {
    case "now":
      return span ? `Now until ${formatHm(span.end)}` : "Now";
    case "next":
      return span ? `Next at ${formatHm(span.start)}` : "Next";
    case "overdue":
      if (span && todayKey && item.task.task.due === todayKey) return `Overdue since ${formatHm(span.end)}`;
      return item.task.task.due ? `Overdue since ${shortDate(item.task.task.due)}` : "Overdue";
    default:
      return "Today, no time set";
  }
}

/** A collapsed row's second line: "Next at 16:00, Life dashboard". */
export function focusRowMeta(item: FocusItem, todayKey?: string): string {
  return [focusLabel(item, todayKey), item.projectName?.trim()].filter(Boolean).join(", ");
}

/**
 * Steps as plain lines for a numbered list: trimmed, leading list markers ("1.", "2)", "-", "*")
 * removed, blank ones dropped, at most MAX_STEPS.
 */
export function cleanSteps(steps: readonly string[] | null | undefined): string[] {
  if (!steps) return [];
  return steps
    .map((s) => (typeof s === "string" ? s.replace(/^\s*(?:\d{1,2}[.)]|[-*•])\s+/, "").trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_STEPS);
}

export type StepsView =
  | { kind: "ready"; steps: string[] }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  /** Ready but with no usable steps (none written yet): offer to write them. */
  | { kind: "missing" };

/** What the steps area shows for one item. */
export function stepsView(item: Pick<FocusItem, "steps" | "stepsStatus" | "stepsMessage">): StepsView {
  if (item.stepsStatus === "pending") return { kind: "pending" };
  if (item.stepsStatus === "error") {
    const why = item.stepsMessage?.trim();
    return { kind: "error", message: why ? why.replace(/\.?$/, ".") : "Claude couldn't write steps for this task." };
  }
  const steps = cleanSteps(item.steps);
  return steps.length ? { kind: "ready", steps } : { kind: "missing" };
}

/** True when any item's steps are still being written. */
export function hasPendingSteps(items: readonly FocusItem[]): boolean {
  return items.some((i) => i.stepsStatus === "pending");
}

/**
 * Polling for steps: "poll" while some are pending and polling began under 2 minutes ago, "timeout"
 * once that passes, "idle" when nothing is pending.
 */
export function pollState(items: readonly FocusItem[], since: number | null, now: number): "idle" | "poll" | "timeout" {
  if (!hasPendingSteps(items)) return "idle";
  if (since !== null && now - since >= FOCUS_POLL_LIMIT_MS) return "timeout";
  return "poll";
}

/** The item that is open after the list changes: the same task while it is listed, else the first. */
export function openPath(items: readonly FocusItem[], current: string | null): string | null {
  if (current && items.some((i) => i.task.path === current)) return current;
  return items[0]?.task.path ?? null;
}

/** The state without one task (Mark done shows at once). */
export function withoutFocusItem(state: FocusState, path: string): FocusState {
  return { ...state, items: state.items.filter((i) => i.task.path !== path) };
}

/** The state with `item` back at `index` (Mark done failed). Unchanged when it is already listed. */
export function restoreFocusItem(state: FocusState, item: FocusItem, index: number): FocusState {
  if (state.items.some((i) => i.task.path === item.task.path)) return state;
  const items = [...state.items];
  items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
  return { ...state, items };
}

/** The state with one item replaced by the server's newer copy (new steps). Unchanged when it is gone. */
export function withFocusItem(state: FocusState, item: FocusItem): FocusState {
  return { ...state, items: state.items.map((i) => (i.task.path === item.task.path ? item : i)) };
}

/** The state with one item's steps marked as being written (Regenerate, or a run already going). */
export function withStepsPending(state: FocusState, path: string): FocusState {
  return {
    ...state,
    items: state.items.map((i) => (i.task.path === path ? { ...i, stepsStatus: "pending" as const, stepsMessage: undefined } : i)),
  };
}

/** The Jira link for an item: only an AN key, only on the configured site. */
export function focusJiraUrl(item: Pick<FocusItem, "jiraKey">, site: string): string | null {
  return jiraIssueUrl(item.jiraKey, site);
}
