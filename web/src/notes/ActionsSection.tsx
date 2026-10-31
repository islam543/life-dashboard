import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { DetectedAction, Note } from "../../../shared/types";
import { ApiRequestError, errorMessage } from "../api";
import { jiraApi } from "../api/jira";
import { useSnapshot } from "../hooks/useSnapshot";
import type { MenuSection } from "../lib/contextMenu";
import {
  actionCounts,
  createPayload,
  draftBlockedReason,
  draftCounts,
  elapsedText,
  jiraErrorKind,
  jiraIssueUrl,
  jiraSiteFrom,
  outcomeText,
  readCreateResult,
  toReview,
  type CreateOutcome,
  type JiraErrorKind,
  type ReviewDraft,
} from "../lib/jiraDraft";
import { followLink } from "../panels/linkMenu";
import { Button, Spinner } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot } from "../ui/StatusDot";
import { CheckIcon } from "./icons";
import styles from "./ActionsSection.module.css";

// "Detected actions" under a note's preview (T30): the task lines and action bullets the server found
// in the note (GET /api/jira/actions, re-read after every save), each with its done state and its Jira
// key when it is already filed. "Draft Jira tasks with AI" asks Claude (POST /api/jira/draft, about 20
// to 60 s, read-only) for one Task per open, unfiled action, then JiraReviewDialog shows the draft for
// editing; nothing reaches Jira before Create there.
//
// The state lives in useNoteJira, which NoteEditor calls once, so a draft or a create keeps running
// when the Preview tab is hidden or the dialog is closed; this section then says what is going on and
// offers to reopen the dialog. Note and AI text render as text only; a key links to Jira only when it
// is an AN key (see lib/jiraDraft).

export interface JiraFailure {
  kind: JiraErrorKind;
  message: string;
}

export interface NoteJira {
  /** Null until the first answer (or when it failed before any). */
  actions: DetectedAction[] | null;
  loading: boolean;
  /** The last read failed; `actions` may still hold an earlier answer. */
  loadError: JiraFailure | null;
  reloadActions: () => void;
  /** Host of the Jira site links point to. */
  site: string;
  /** Why drafting is off right now, or null. */
  blocked: string | null;
  /** When the draft run started (ms), or null when none is running. */
  drafting: number | null;
  draftError: JiraFailure | null;
  startDraft: () => void;
  /** The draft being reviewed, as edited so far. */
  review: ReviewDraft | null;
  setReview: (review: ReviewDraft) => void;
  discardReview: () => void;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** When the create run started (ms), or null. */
  creating: number | null;
  createError: JiraFailure | null;
  outcome: CreateOutcome | null;
  startCreate: () => void;
  dismissOutcome: () => void;
}

const REFRESH_DELAY_MS = 400;
const WRITE_BACK_NOTICE = "The new Jira keys were added to their action lines in this note.";

function failureOf(err: unknown): JiraFailure {
  if (err instanceof ApiRequestError) return { kind: jiraErrorKind(err.status, err.offline), message: err.message };
  return { kind: "failed", message: errorMessage(err) };
}

/** A clock that ticks once a second while `since` is set, for "Drafting 12 s". */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? "" : elapsedText(now - since);
}

export interface UseNoteJiraOptions {
  path: string;
  /** The note has loaded. */
  ready: boolean;
  /** Changes after every save or re-read (the note's `updated`), so the actions are read again. */
  version: string | null;
  /** Why the note can't be sent right now (an unresolved outside change), or null. */
  editorBlocked: string | null;
  flush: () => Promise<boolean>;
  refresh: (notice?: string | null) => Promise<Note | null>;
}

export function useNoteJira({ path, ready, version, editorBlocked, flush, refresh }: UseNoteJiraOptions): NoteJira {
  const snap = useSnapshot();
  const [actions, setActions] = useState<DetectedAction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<JiraFailure | null>(null);
  const [tick, setTick] = useState(0);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [draftError, setDraftError] = useState<JiraFailure | null>(null);
  const [review, setReview] = useState<ReviewDraft | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState<number | null>(null);
  const [createError, setCreateError] = useState<JiraFailure | null>(null);
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const [createdUrls, setCreatedUrls] = useState<string[]>([]);
  const mounted = useRef(true);
  const loaded = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Read the actions when the note opens, and again shortly after each save.
  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        jiraApi.actions(path, ctrl.signal).then(
          (list) => {
            loaded.current = true;
            setActions(list);
            setLoadError(null);
            setLoading(false);
          },
          (err: unknown) => {
            if (ctrl.signal.aborted) return;
            setLoadError(failureOf(err));
            setLoading(false);
          },
        );
      },
      loaded.current ? REFRESH_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [path, ready, version, tick]);

  const reloadActions = useCallback(() => {
    setLoading(!loaded.current);
    setTick((t) => t + 1);
  }, []);

  const jiraUrls = snap.data?.work.jira.map((i) => i.url) ?? [];
  const site = jiraSiteFrom([...createdUrls, ...jiraUrls]);

  let blocked: string | null = null;
  if (!actions) {
    if (loadError?.kind === "not_ready") blocked = "Jira drafts aren't ready on the dashboard server yet.";
    else if (loadError) blocked = "The note's actions couldn't be read, so there is nothing to draft yet.";
    else blocked = "Checking the note for actions.";
  } else {
    blocked = draftBlockedReason(actions);
  }
  if (!blocked && creating !== null) blocked = "Wait for the Jira create to finish.";
  if (!blocked && editorBlocked) blocked = editorBlocked;

  const startDraft = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setDraftError(null);
    setDrafting(Date.now());
    try {
      if (!(await flush())) {
        setDraftError({
          kind: "failed",
          message:
            "The note has changes that aren't saved, so Claude would read an older copy. Fix the save problem shown above, then draft again.",
        });
        return;
      }
      const draft = await jiraApi.draft(path);
      if (!mounted.current) return;
      if (!draft.issues.some((i) => i.type === "Task")) {
        setDraftError({
          kind: "failed",
          message: "Claude didn't propose any tasks for these actions. Make the action lines more specific, then draft again.",
        });
        return;
      }
      setReview(toReview(draft));
      setOutcome(null);
      setCreateError(null);
      setDialogOpen(true);
    } catch (err) {
      if (mounted.current) setDraftError(failureOf(err));
    } finally {
      busy.current = false;
      if (mounted.current) setDrafting(null);
    }
  }, [path, flush]);

  const startCreate = useCallback(async () => {
    if (!review || busy.current) return;
    busy.current = true;
    const sent = review;
    setCreateError(null);
    setCreating(Date.now());
    try {
      if (!(await flush())) {
        setCreateError({
          kind: "failed",
          message: "The note has changes that aren't saved yet. Fix the save problem in the editor, then create again.",
        });
        return;
      }
      const result = await jiraApi.create(path, createPayload(sent));
      // Re-read the note so it shows the keys the server wrote into the action lines.
      const fresh = await refresh(WRITE_BACK_NOTICE);
      if (!mounted.current) return;
      setCreatedUrls(result.created.map((c) => c.url));
      setOutcome(readCreateResult(result, sent, fresh?.body ?? null));
      setTick((t) => t + 1);
    } catch (err) {
      if (mounted.current) setCreateError(failureOf(err));
    } finally {
      busy.current = false;
      if (mounted.current) setCreating(null);
    }
  }, [review, path, flush, refresh]);

  return {
    actions,
    loading,
    loadError,
    reloadActions,
    site,
    blocked,
    drafting,
    draftError,
    startDraft: () => void startDraft(),
    review,
    setReview,
    discardReview: () => {
      setReview(null);
      setCreateError(null);
      setDialogOpen(false);
    },
    dialogOpen,
    openDialog: () => setDialogOpen(true),
    closeDialog: () => setDialogOpen(false),
    creating,
    createError,
    outcome,
    startCreate: () => void startCreate(),
    dismissOutcome: () => {
      setOutcome(null);
      setReview(null);
      setDialogOpen(false);
    },
  };
}

/* View ------------------------------------------------------------------------------------------ */

export function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6zM13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"
        fill="currentColor"
      />
    </svg>
  );
}

const FAILURE_TITLE: Record<JiraErrorKind, string> = {
  not_ready: "Jira drafts not ready.",
  sign_in: "Jira isn't signed in.",
  busy: "A Jira run is already going.",
  invalid: "The server turned this down.",
  offline: "Can't reach the dashboard server.",
  failed: "That didn't work.",
};

/** One failure, said plainly: what happened, then the server's own words (how to sign in, which issue). */
export function FailureLine({ failure, className }: { failure: JiraFailure; className?: string }) {
  let detail = failure.message;
  if (failure.kind === "not_ready") detail = "The Jira part of the dashboard server isn't built yet. The note itself works as usual.";
  if (failure.kind === "offline") detail = "Check that npm run dev is still running, then try again.";
  if (failure.kind === "busy") detail = `${failure.message.replace(/\.?$/, ".")} Wait for it to finish, then try again.`;
  return (
    <p className={[styles.failure, className].filter(Boolean).join(" ")} role="alert" data-kind={failure.kind}>
      <StatusDot tone={failure.kind === "not_ready" || failure.kind === "sign_in" ? "off" : "danger"} size={9} glow={false} />
      <span>
        <strong>{FAILURE_TITLE[failure.kind]}</strong> {detail}
      </span>
    </p>
  );
}

function ActionRow({ action, site }: { action: DetectedAction; site: string }) {
  const url = jiraIssueUrl(action.jiraKey, site);
  const menu = useMenuRegion((): MenuSection | null =>
    url && action.jiraKey
      ? {
          title: action.jiraKey,
          items: [{ label: "Open in Jira", onSelect: () => followLink(url), tip: `Opens ${action.jiraKey} in Jira in a new tab.` }],
        }
      : null,
  );
  return (
    <li className={styles.item} data-done={action.done || undefined} {...menu}>
      <span className={styles.mark} aria-hidden="true">
        {action.done ? <CheckIcon /> : <span className={styles.ring} />}
      </span>
      <span className={styles.text} dir="auto">
        <span className="sr-only">{action.done ? "Done: " : "Open: "}</span>
        {action.text}
      </span>
      {action.jiraKey ? (
        url ? (
          <a
            className={styles.key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-tip={`Opens ${action.jiraKey} in Jira in a new tab.`}
          >
            {action.jiraKey}
          </a>
        ) : (
          <span className={styles.key} data-plain="" data-tip="The Jira key already on this line; it isn't an AN key, so it has no link.">
            {action.jiraKey}
          </span>
        )
      ) : null}
    </li>
  );
}

export interface ActionsSectionProps {
  jira: NoteJira;
  /** "tab": under the preview in the Preview tab. "panel": pinned under the live preview (ultrawide). */
  layout: "tab" | "panel";
}

export function ActionsSection({ jira, layout }: ActionsSectionProps) {
  const headingId = `actions-${useId().replace(/:/g, "")}`;
  const reasonId = `${headingId}-reason`;
  const draftClock = useElapsed(jira.drafting);
  const createClock = useElapsed(jira.creating);
  const { actions, loadError, blocked, review, outcome } = jira;
  const counts = useMemo(() => (actions ? actionCounts(actions) : null), [actions]);
  const drafting = jira.drafting !== null;
  const creating = jira.creating !== null;
  const waiting = review && !outcome && !jira.dialogOpen && !creating && !jira.createError ? draftCounts(review) : null;

  const draftTip = blocked
    ? blocked
    : "Claude drafts one Jira task per open action under your epics; you review them before anything is created.";

  const menu = useMenuRegion(
    (): MenuSection => ({
      title: "Detected actions",
      items: [
        {
          label: drafting ? "Drafting" : "Draft Jira tasks with AI",
          onSelect: jira.startDraft,
          disabled: drafting ? "Claude is drafting already." : (blocked ?? false),
          tip: draftTip,
        },
        waiting ? { label: "Review drafts", onSelect: jira.openDialog, tip: "Opens the waiting draft to edit and create it." } : null,
        outcome && !jira.dialogOpen
          ? { label: "Show Jira results", onSelect: jira.openDialog, tip: "Opens the list of created keys and failures again." }
          : null,
        loadError ? { label: "Check again", onSelect: jira.reloadActions, tip: "Reads the note's actions from the server again." } : null,
      ],
    }),
  );

  let list: ReactNode;
  if (!actions && jira.loading) {
    list = (
      <div className={styles.skeleton} aria-hidden="true">
        <Skeleton width="78%" height={14} radius={4} />
        <Skeleton width="64%" height={14} radius={4} />
        <Skeleton width="70%" height={14} radius={4} />
      </div>
    );
  } else if (!actions && loadError) {
    list =
      loadError.kind === "not_ready" ? (
        <p className={styles.empty}>
          <StatusDot tone="off" size={9} glow={false} />
          <span>
            <strong>Jira drafts not ready.</strong> The dashboard server can't list this note's actions yet; its Jira part
            is still being built. The note itself works as usual.
          </span>
        </p>
      ) : (
        <div className={styles.problem}>
          <FailureLine failure={loadError} />
          <Button size="sm" onClick={jira.reloadActions} tip="Reads the note's actions from the server again.">
            Try again
          </Button>
        </div>
      );
  } else if (actions && actions.length === 0) {
    list = (
      <p className={styles.empty}>
        <span>
          <strong>No actions in this note.</strong> Task lines like <code>- [ ] Send the slip</code>, and bullets under a
          heading such as Action items or Next steps, show here.
        </span>
      </p>
    );
  } else if (actions) {
    list = (
      <ul className={styles.list} aria-labelledby={headingId}>
        {actions.map((a) => (
          <ActionRow key={a.id} action={a} site={jira.site} />
        ))}
      </ul>
    );
  }

  return (
    <section className={styles.section} data-layout={layout} aria-labelledby={headingId} {...menu}>
      <div className={styles.head}>
        <h3 id={headingId} className={styles.title}>
          Detected actions
          {counts ? (
            <span className={`${styles.count} num`} aria-label={`, ${counts.total}`}>
              {counts.total}
            </span>
          ) : null}
        </h3>
        <Button
          variant="ai"
          size="sm"
          icon={<SparkIcon />}
          loading={drafting}
          loadingLabel={`Drafting ${draftClock}`}
          disabled={!drafting && !!blocked}
          aria-describedby={blocked && !drafting ? reasonId : undefined}
          onClick={jira.startDraft}
          tip={drafting ? "Claude is reading the note and your open epics; this usually takes 20 to 60 seconds." : draftTip}
        >
          Draft Jira tasks with AI
        </Button>
      </div>

      {counts && counts.total > 0 ? (
        <p className={styles.summary}>
          {counts.draftable} open to file <span aria-hidden="true">·</span> {counts.filed} in Jira{" "}
          <span aria-hidden="true">·</span> {counts.done} done
        </p>
      ) : null}

      {blocked && !drafting && actions && actions.length > 0 ? (
        <p id={reasonId} className={styles.reason}>
          {blocked}
        </p>
      ) : blocked && !drafting ? (
        <span id={reasonId} className="sr-only">
          {blocked}
        </span>
      ) : null}

      {drafting ? (
        <p className={styles.running} role="status">
          <Spinner size={14} />
          <span>Claude is reading the note and your open epics in Jira. This usually takes 20 to 60 seconds.</span>
        </p>
      ) : null}

      {jira.draftError ? <FailureLine failure={jira.draftError} /> : null}

      {waiting ? (
        <div className={styles.notice} data-tone="ai">
          <p>
            <strong>Draft ready.</strong> {waiting.tasks} {waiting.tasks === 1 ? "task is" : "tasks are"} waiting for your
            review. Nothing is in Jira yet.
          </p>
          <div className={styles.noticeActions}>
            <Button size="sm" variant="primary" data-jira-resume="" onClick={jira.openDialog} tip="Opens the draft to edit it and create the tasks in Jira.">
              Review drafts
            </Button>
            <Button size="sm" variant="ghost" onClick={jira.discardReview} tip="Throws this draft away; nothing was created in Jira.">
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {creating && !jira.dialogOpen ? (
        <div className={styles.notice} data-tone="ai" role="status">
          <p className={styles.runningLine}>
            <Spinner size={14} />
            <span>Creating in Jira, {createClock}. The result shows here when it's done.</span>
          </p>
          <div className={styles.noticeActions}>
            <Button size="sm" data-jira-resume="" onClick={jira.openDialog} tip="Opens the review window again to follow the run.">
              Show progress
            </Button>
          </div>
        </div>
      ) : null}

      {jira.createError && !jira.dialogOpen && !creating ? (
        <div className={styles.notice} data-tone="danger">
          <FailureLine failure={jira.createError} className={styles.flat} />
          <div className={styles.noticeActions}>
            <Button size="sm" data-jira-resume="" onClick={jira.openDialog} tip="Opens the draft again, so you can fix it and create again.">
              Back to the draft
            </Button>
          </div>
        </div>
      ) : null}

      {outcome && !jira.dialogOpen ? (
        <div className={styles.notice} data-tone={outcome.writeBack || outcome.failed.length ? "warn" : "ok"} role="status">
          <p>
            <strong>{outcomeText(outcome)}</strong>
            {outcome.writeBack ? ` ${outcome.writeBack}` : null}
          </p>
          <div className={styles.noticeActions}>
            <Button size="sm" data-jira-resume="" onClick={jira.openDialog} tip="Opens the list of created keys, with links, and any failures.">
              Show results
            </Button>
            <Button size="sm" variant="ghost" onClick={jira.dismissOutcome} tip="Hides this summary; the issues stay in Jira.">
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {actions && loadError ? (
        <p className={styles.stale}>
          Couldn't refresh the list, so it may be out of date.{" "}
          <button type="button" className={styles.inlineButton} onClick={jira.reloadActions} data-tip="Reads the note's actions from the server again.">
            Try again
          </button>
        </p>
      ) : null}

      <div className={styles.listWrap}>{list}</div>
    </section>
  );
}
