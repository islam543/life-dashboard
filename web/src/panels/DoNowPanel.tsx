import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FocusItem, FocusReason, FocusState } from "../../../shared/types";
import { ApiRequestError, errorMessage } from "../api";
import { focusApi } from "../api/focus";
import { notReady, onTasksChanged, scheduleApi, sendScheduleCommand, tasksChanged, type ScheduleCommand } from "../api/schedule";
import { useNextMoves } from "../hooks/useNextMoves";
import { useSnapshot } from "../hooks/useSnapshot";
import type { MenuSection } from "../lib/contextMenu";
import {
  FOCUS_POLL_LIMIT_MS,
  FOCUS_POLL_MS,
  focusJiraUrl,
  focusLabel,
  focusRowMeta,
  hasPendingSteps,
  openPath,
  orderFocusItems,
  restoreFocusItem,
  stepsView,
  withFocusItem,
  withStepsPending,
  withoutFocusItem,
} from "../lib/focus";
import { dayKey, plural } from "../lib/format";
import { jiraSiteFrom } from "../lib/jiraDraft";
import { openMoves } from "../lib/kpis";
import { noteHash, projectHash } from "../lib/route";
import { Button, ButtonLink, Spinner } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { EmptyState } from "../ui/EmptyState";
import { Panel, type PanelState } from "../ui/Panel";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot, type StatusTone } from "../ui/StatusDot";
import { followLink, opensIn } from "./linkMenu";
import styles from "./DoNowPanel.module.css";

// Do now (Home, bottom right): the tasks to do now, each with a short how-to Claude wrote for it.
// Data is GET /api/focus (at most 6 items, most urgent first: the task whose block holds now, the next
// timed ones today, overdue ones, today's untimed ones). It never waits for AI: steps not written yet
// come back "pending" and the panel re-reads every 5 s for up to 2 minutes.
//   First item open: when, title (opens the note), project and Jira chips, the numbered steps, and
//   Mark done (PATCH the task, then re-read), Regenerate steps (POST force) and Open note.
//   Other items are one-line rows; clicking one opens it and closes the open one.
//   Empty: "Nothing due right now." with the top Next move, Plan my day and Add task, which ask the
//   Schedule panel to act (api/schedule's in-page channel); writes on either side re-read the other.
// Before the server has /api/focus (501 or 404) the panel says so and offers Check again.
// Right-click an item for Mark done, Regenerate steps, Open note and Open in Jira.

const TITLE = "Do now";
const STALE_AFTER_MS = 5 * 60_000;

const TIP = {
  expand: "Opens this task's steps and buttons; the open task closes.",
  title: "Opens the task's note in the Notes view, where you can edit its details.",
  project: "Opens this project's page with its tasks, notes and time.",
  done: "Marks this task done in its note and takes it off this list.",
  regenerate: "Asks Claude to write new steps for this task; takes up to a minute.",
  regenerating: "Claude is writing new steps for this task.",
  write: "Asks Claude to write steps for this task; takes up to a minute.",
  tryAgain: "Asks Claude again to write steps for this task.",
  openNote: "Opens the task's note in the Notes view.",
  checkSteps: "Reads the list again to see whether the steps are ready.",
  planDay: "Shows the Schedule and asks Claude to fit your open tasks into today's free time; nothing is added until you accept.",
  addTask: "Shows the Schedule with its Add task form open on today.",
  notReady: "Checks again whether the dashboard server serves Do now yet.",
  retry: "Asks the local server for the tasks to do now again.",
} as const;

const TONE: Record<FocusReason, StatusTone> = { now: "ok", next: "idle", overdue: "warn", today: "idle" };

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6zM13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"
        fill="currentColor"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4 2.5h5.5L12.5 5.5v8h-8.5zM9.5 2.5v3h3M6 8.5h4.5M6 11h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className={styles.chevron} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg className={styles.extIcon} viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path
        d="M6.5 3.5H3.5v9h9v-3M9 3h4v4M13 3 7.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

interface FocusLoad {
  data: FocusState | null;
  loading: boolean;
  error: string | null;
  /** The server has no Do now yet (501 before T31, 404 on an older build). */
  notReady: boolean;
  /** Counts finished reads, so polling re-arms after each one, failed or not. */
  settled: number;
}

/** GET /api/focus, kept on screen while the next read runs. `edit` changes the list locally. */
function useFocus() {
  const [state, setState] = useState<FocusLoad>({ data: null, loading: true, error: null, notReady: false, settled: 0 });
  const [tick, setTick] = useState(0);
  const loadedAt = useRef(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    focusApi
      .get(ctrl.signal)
      .then((data) => {
        loadedAt.current = Date.now();
        setState((s) => ({ data, loading: false, error: null, notReady: false, settled: s.settled + 1 }));
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: errorMessage(err), notReady: notReady(err), settled: s.settled + 1 }));
      });
    return () => ctrl.abort();
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Labels like "Now until 15:30" go stale: re-read every 5 minutes while the tab is in view, and on
  // coming back to the tab after a while.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, STALE_AFTER_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > STALE_AFTER_MS) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  // A task changed in the Schedule panel (done, moved, a plan accepted): read again.
  useEffect(
    () =>
      onTasksChanged((source) => {
        if (source !== "focus") reload();
      }),
    [reload],
  );

  const edit = useCallback((fn: (s: FocusState) => FocusState) => {
    setState((s) => (s.data ? { ...s, data: fn(s.data) } : s));
  }, []);

  return { ...state, reload, edit };
}

// ---------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------

interface ItemActions {
  site: string;
  /** YYYY-MM-DD, for labels built locally when the server sent none. */
  todayKey: string;
  /** Path -> what is running for it: "steps" while Claude writes new steps. */
  busy: Readonly<Record<string, "steps">>;
  /** Path -> why writing steps failed (from this page; the server's own errors come in the item). */
  stepErrors: Readonly<Record<string, string>>;
  onDone: (item: FocusItem) => void;
  onSteps: (item: FocusItem, force: boolean) => void;
  onExpand: (item: FocusItem) => void;
}

function itemMenu(item: FocusItem, actions: ItemActions): MenuSection {
  const jira = focusJiraUrl(item, actions.site);
  const writing = actions.busy[item.task.path] === "steps" || item.stepsStatus === "pending";
  return {
    title: item.task.title,
    items: [
      { label: "Mark done", onSelect: () => actions.onDone(item), tip: TIP.done },
      {
        label: "Regenerate steps",
        onSelect: () => actions.onSteps(item, true),
        disabled: writing ? TIP.regenerating : false,
        tip: TIP.regenerate,
      },
      { label: "Open note", onSelect: () => followLink(noteHash(item.task.path)), tip: TIP.openNote },
      jira ? { label: "Open in Jira", onSelect: () => followLink(jira), tip: `${opensIn(jira)}.` } : null,
    ],
  };
}

function Steps({ item, actions }: { item: FocusItem; actions: ItemActions }) {
  const id = `steps-${useId().replace(/:/g, "")}`;
  const path = item.task.path;
  const writing = actions.busy[path] === "steps";
  const localError = actions.stepErrors[path];
  const view = writing ? ({ kind: "pending" } as const) : localError ? ({ kind: "error", message: localError } as const) : stepsView(item);

  let content: ReactNode;
  if (view.kind === "ready") {
    content = (
      <ol className={styles.stepList}>
        {view.steps.map((step, i) => (
          <li key={i} className={styles.step}>
            {step}
          </li>
        ))}
      </ol>
    );
  } else if (view.kind === "pending") {
    content = (
      <div className={styles.stepsPending}>
        <p className={styles.stepsLine}>
          <Spinner size={12} />
          <span>{writing ? "Writing new steps..." : "Writing steps..."}</span>
        </p>
        <div className={styles.stepsSkeleton} aria-hidden="true">
          <Skeleton width="88%" height={10} />
          <Skeleton width="72%" height={10} />
          <Skeleton width="80%" height={10} />
        </div>
      </div>
    );
  } else if (view.kind === "error") {
    content = (
      <div className={styles.stepsError} role="alert">
        <p className={styles.stepsLine}>
          <StatusDot tone="danger" size={8} glow={false} />
          <span>{view.message}</span>
        </p>
        <Button variant="ai" size="sm" icon={<SparkIcon />} onClick={() => actions.onSteps(item, false)} tip={TIP.tryAgain}>
          Try again
        </Button>
      </div>
    );
  } else {
    content = (
      <div className={styles.stepsMissing}>
        <p className={styles.stepsLine}>No steps for this task yet.</p>
        <Button variant="ai" size="sm" icon={<SparkIcon />} onClick={() => actions.onSteps(item, false)} tip={TIP.write}>
          Write steps
        </Button>
      </div>
    );
  }

  return (
    <section className={styles.steps} aria-labelledby={id} aria-busy={view.kind === "pending" || undefined}>
      <h4 id={id} className={styles.kicker}>
        How to do it
        <span className={styles.aiTag}>
          <span aria-hidden="true">AI</span>
          <span className="sr-only">, written by Claude</span>
        </span>
      </h4>
      {content}
    </section>
  );
}

function OpenItem({ item, actions }: { item: FocusItem; actions: ItemActions }) {
  const menu = useMenuRegion(() => itemMenu(item, actions));
  const jira = focusJiraUrl(item, actions.site);
  const project = item.projectName?.trim() || null;
  const writing = actions.busy[item.task.path] === "steps" || item.stepsStatus === "pending";

  return (
    <li {...menu} className={[styles.item, styles.open].join(" ")} data-reason={item.reason}>
      <p className={styles.when}>
        <StatusDot tone={TONE[item.reason] ?? "idle"} size={8} glow={item.reason === "now"} />
        <span>{focusLabel(item, actions.todayKey)}</span>
      </p>
      <h3 className={styles.title}>
        <a className={styles.titleLink} href={noteHash(item.task.path)} data-tip={TIP.title} data-title-for={item.task.path}>
          {item.task.title}
        </a>
      </h3>
      {project || jira ? (
        <p className={styles.chips}>
          {project ? (
            item.task.projectId ? (
              <a className={styles.chip} href={projectHash(item.task.projectId)} data-tip={TIP.project}>
                <span className="sr-only">Project: </span>
                {project}
              </a>
            ) : (
              <span className={styles.chip}>
                <span className="sr-only">Project: </span>
                {project}
              </span>
            )
          ) : null}
          {jira ? (
            <a
              className={[styles.chip, styles.jiraChip].join(" ")}
              href={jira}
              target="_blank"
              rel="noopener noreferrer"
              data-tip={`${opensIn(jira)}.`}
            >
              <span className="sr-only">Jira issue </span>
              {item.jiraKey}
              <span className="sr-only"> (opens in a new tab)</span>
              <ExternalIcon />
            </a>
          ) : null}
        </p>
      ) : null}
      <Steps item={item} actions={actions} />
      <div className={styles.actions}>
        <Button variant="primary" size="sm" icon={<CheckIcon />} onClick={() => actions.onDone(item)} tip={TIP.done}>
          Mark done
        </Button>
        <Button
          variant="ai"
          size="sm"
          icon={<SparkIcon />}
          onClick={() => actions.onSteps(item, true)}
          loading={actions.busy[item.task.path] === "steps"}
          loadingLabel="Writing"
          disabled={writing && actions.busy[item.task.path] !== "steps"}
          tip={writing ? TIP.regenerating : TIP.regenerate}
        >
          Regenerate steps
        </Button>
        <ButtonLink variant="ghost" size="sm" icon={<NoteIcon />} href={noteHash(item.task.path)} tip={TIP.openNote}>
          Open note
        </ButtonLink>
      </div>
    </li>
  );
}

function ClosedItem({ item, actions }: { item: FocusItem; actions: ItemActions }) {
  const menu = useMenuRegion(() => itemMenu(item, actions));
  return (
    <li {...menu} className={styles.item} data-reason={item.reason}>
      <button type="button" className={styles.row} aria-expanded={false} onClick={() => actions.onExpand(item)} data-tip={TIP.expand}>
        <StatusDot tone={TONE[item.reason] ?? "idle"} size={8} glow={false} className={styles.rowDot} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{item.task.title}</span>
          <span className={styles.rowMeta}>{focusRowMeta(item, actions.todayKey)}</span>
        </span>
        <ChevronIcon />
      </button>
    </li>
  );
}

function ActionError({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className={styles.actionError} role="alert">
      <StatusDot tone="danger" size={9} glow={false} />
      <p>{message}</p>
      <Button variant="ghost" size="sm" onClick={onClose} tip="Hides this message; the list stays as it is.">
        Hide
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

export function DoNowPanel() {
  const snap = useSnapshot();
  const nm = useNextMoves();
  const focus = useFocus();
  const items = useMemo(() => orderFocusItems(focus.data?.items ?? []), [focus.data]);
  const site = useMemo(() => jiraSiteFrom((snap.data?.work.jira ?? []).map((i) => i.url)), [snap.data]);
  const topMove = openMoves(nm.data?.moves)[0] ?? null;

  const [chosen, setChosen] = useState<string | null>(null);
  const openNow = openPath(items, chosen);
  const [busy, setBusy] = useState<Record<string, "steps">>({});
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLButtonElement>(null);
  /** After the list changes: the task whose title gets focus, "" for Plan my day, null for none. */
  const pendingFocus = useRef<string | null>(null);

  // ----- polling while steps are being written: every 5 s, for up to 2 minutes
  const pending = hasPendingSteps(items);
  const [pollSince, setPollSince] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (pending) setPollSince((s) => s ?? Date.now());
    else {
      setPollSince(null);
      setTimedOut(false);
    }
  }, [pending]);
  const { reload, settled } = focus;
  useEffect(() => {
    if (!pending || pollSince === null || timedOut) return;
    if (Date.now() - pollSince >= FOCUS_POLL_LIMIT_MS) {
      setTimedOut(true);
      return;
    }
    const id = setTimeout(reload, FOCUS_POLL_MS);
    return () => clearTimeout(id);
  }, [pending, pollSince, timedOut, settled, reload]);

  const checkSteps = () => {
    setTimedOut(false);
    setPollSince(Date.now());
    reload();
  };

  // ----- focus after the list changes (an item opened, or one left after Mark done)
  const shownKey = `${items.map((i) => i.task.path).join("\n")}|${openNow ?? ""}`;
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = target
      ? bodyRef.current?.querySelector<HTMLElement>(`[data-title-for="${CSS.escape(target)}"]`)
      : planRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.closest("li")?.scrollIntoView({ block: "nearest" });
  }, [shownKey]);

  // ----- actions
  const expand = (item: FocusItem) => {
    pendingFocus.current = item.task.path;
    setChosen(item.task.path);
  };

  const markDone = async (item: FocusItem) => {
    const path = item.task.path;
    const at = items.findIndex((i) => i.task.path === path);
    const rest = items.filter((i) => i.task.path !== path);
    const nextOpen = openNow === path ? (rest[at] ?? rest[at - 1] ?? null) : null;
    if (openNow === path) {
      setChosen(nextOpen?.task.path ?? null);
      pendingFocus.current = nextOpen ? nextOpen.task.path : "";
    }
    setActionError(null);
    focus.edit((s) => withoutFocusItem(s, path));
    setAnnouncement(`Done: ${item.task.title}.`);
    try {
      await scheduleApi.updateTask(path, { done: true });
      tasksChanged("focus");
      reload();
    } catch (err) {
      focus.edit((s) => restoreFocusItem(s, item, at));
      if (openNow === path) setChosen(path);
      setActionError(`Couldn't mark "${item.task.title}" done. ${errorMessage(err)}`);
      setAnnouncement(`Couldn't mark ${item.task.title} done.`);
    }
  };

  const writeSteps = async (item: FocusItem, force: boolean) => {
    const path = item.task.path;
    if (busy[path]) return;
    setBusy((b) => ({ ...b, [path]: "steps" }));
    setStepErrors(({ [path]: _gone, ...restErrors }) => restErrors);
    setAnnouncement(`Writing steps for ${item.task.title}. This takes up to a minute.`);
    try {
      const next = await focusApi.steps(path, force);
      focus.edit((s) => withFocusItem(s, next));
      const view = stepsView(next);
      setAnnouncement(view.kind === "ready" ? `Steps ready for ${item.task.title}.` : `Steps for ${item.task.title} are still being written.`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // A run is already writing steps: show it as pending and let polling pick them up.
        focus.edit((s) => withStepsPending(s, path));
        setAnnouncement("Claude is already writing steps; they show here when ready.");
      } else if (err instanceof ApiRequestError && err.status === 404) {
        setActionError(`"${item.task.title}" is no longer an open task, so the list was read again.`);
        reload();
      } else {
        setStepErrors((e) => ({ ...e, [path]: `Couldn't write steps. ${errorMessage(err)}` }));
        setAnnouncement(`Couldn't write steps for ${item.task.title}.`);
      }
    } finally {
      setBusy(({ [path]: _done, ...restBusy }) => restBusy);
    }
  };

  const askSchedule = (command: ScheduleCommand) => {
    setActionError(null);
    if (!sendScheduleCommand(command)) {
      setActionError(
        command === "plan-day"
          ? "The Schedule panel isn't ready, so it can't plan yet. Try again once it has loaded."
          : "The Schedule panel isn't ready, so tasks can't be added yet. Try again once it has loaded.",
      );
    }
  };

  const actions: ItemActions = {
    site,
    todayKey: dayKey(new Date()),
    busy,
    stepErrors,
    onDone: (item) => void markDone(item),
    onSteps: (item, force) => void writeSteps(item, force),
    onExpand: expand,
  };

  // ----- what to show
  let state: PanelState = "ok";
  let message: string | undefined;
  let hint: string | undefined;
  let onRetry: (() => void) | undefined;
  let notice: string | undefined;
  let body: ReactNode = null;
  let menu: MenuSection["items"] = [];

  const notReadyBody = (
    <EmptyState
      tone="off"
      title="Do now isn't ready yet."
      body="This dashboard's server doesn't serve Do now yet. Restart it once it is updated, then check again."
      action={
        <Button size="sm" onClick={reload} loading={focus.loading} loadingLabel="Checking" tip={TIP.notReady}>
          Check again
        </Button>
      }
    />
  );

  if (focus.notReady) {
    body = notReadyBody;
    menu = [{ label: "Check again", onSelect: reload, tip: TIP.notReady }];
  } else if (!focus.data) {
    if (focus.error && !focus.loading) {
      state = "error";
      message = "Couldn't load Do now.";
      hint = focus.error;
      onRetry = reload;
    } else {
      state = "loading";
    }
  } else {
    if (focus.error) notice = `Couldn't refresh this list: ${focus.error.replace(/\.?$/, ".")} Showing the last one.`;
    if (items.length === 0) {
      menu = [
        { label: "Plan my day", onSelect: () => askSchedule("plan-day"), tip: TIP.planDay },
        { label: "Add task", onSelect: () => askSchedule("add-task"), tip: TIP.addTask },
      ];
      body = (
        <div ref={bodyRef} className={styles.content}>
          {actionError ? <ActionError message={actionError} onClose={() => setActionError(null)} /> : null}
          <EmptyState
            tone="ok"
            title="Nothing due right now."
            body={
              <>
                No task is timed for now, and nothing is overdue or due today.
                {topMove ? (
                  <span className={styles.topMove}>
                    <span className={styles.topMoveLabel}>Top next move:</span> {topMove.title}
                  </span>
                ) : null}
              </>
            }
            action={
              <span className={styles.emptyActions}>
                <Button ref={planRef} variant="ai" size="sm" icon={<SparkIcon />} onClick={() => askSchedule("plan-day")} tip={TIP.planDay}>
                  Plan my day
                </Button>
                <Button size="sm" icon={<PlusIcon />} onClick={() => askSchedule("add-task")} tip={TIP.addTask}>
                  Add task
                </Button>
              </span>
            }
          />
        </div>
      );
    } else {
      body = (
        <div ref={bodyRef} className={styles.content}>
          {actionError ? <ActionError message={actionError} onClose={() => setActionError(null)} /> : null}
          {timedOut ? (
            <div className={styles.slow} role="status">
              <p>Steps are taking longer than usual.</p>
              <Button variant="ghost" size="sm" onClick={checkSteps} tip={TIP.checkSteps}>
                Check again
              </Button>
            </div>
          ) : null}
          <ol className={styles.list} aria-label="Tasks to do now, most urgent first">
            {items.map((item) =>
              item.task.path === openNow ? (
                <OpenItem key={item.task.path} item={item} actions={actions} />
              ) : (
                <ClosedItem key={item.task.path} item={item} actions={actions} />
              ),
            )}
          </ol>
        </div>
      );
    }
  }

  return (
    <>
      <Panel
        title={TITLE}
        fit
        state={state}
        message={message}
        hint={hint}
        onRetry={onRetry}
        retrying={focus.loading}
        retryTip={TIP.retry}
        notice={notice}
        skeleton="rows"
        meta={state === "ok" && items.length ? plural(items.length, "task") : undefined}
        menu={menu}
      >
        {body}
      </Panel>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
