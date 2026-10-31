import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DetectedAction } from "../../../shared/types";
import type { MenuSection } from "../lib/contextMenu";
import {
  checkReview,
  countsText,
  DESCRIPTION_MAX,
  draftCounts,
  editIssue,
  groupByEpic,
  JIRA_PROJECT,
  jiraIssueUrl,
  outcomeText,
  parentOptions,
  parentValue,
  parseParentValue,
  setEpicTasksIncluded,
  SUMMARY_MAX,
  type EpicGroup,
  type IssueEdit,
  type IssueProblems,
  type ParentOption,
  type ReviewIssue,
} from "../lib/jiraDraft";
import { followLink } from "../panels/linkMenu";
import { Button, Spinner } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { StatusDot } from "../ui/StatusDot";
import { FailureLine, useElapsed, type NoteJira } from "./ActionsSection";
import { copyText } from "./filePaths";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";
import styles from "./JiraReviewDialog.module.css";

// Review the AI's Jira draft before anything is created (docs/ARCHITECTURE.md "v1.2": reviewed before
// creation). A native modal <dialog> like the other notes dialogs: Escape or Close hides it and keeps
// the edits (reopen it from Detected actions). Tasks sit under their epic: one of your open epics
// (key and link), a new epic from the draft (its title editable), or No epic. Each Task can be left
// out, renamed, rewritten and moved with its epic picker; a new epic with no included Task is dropped.
// The footer says exactly what Create makes. Create runs in useNoteJira, so closing the window mid-run
// is safe: the result shows under the preview, and here when it is reopened.

export interface JiraReviewDialogProps {
  jira: NoteJira;
  noteTitle: string;
}

function KeyLink({ issueKey, site, label }: { issueKey: string; site: string; label?: string }) {
  const url = jiraIssueUrl(issueKey, site);
  if (!url) {
    return (
      <span className={styles.key} data-plain="">
        {issueKey}
      </span>
    );
  }
  return (
    <a
      className={styles.key}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-tip={`Opens ${label ?? issueKey} in Jira in a new tab.`}
    >
      {issueKey}
    </a>
  );
}

function Counter({ value, max }: { value: string; max: number }) {
  const n = value.trim().length;
  return (
    <span className={`${styles.counter} num`} data-over={n > max || undefined} aria-hidden="true">
      {n}/{max}
    </span>
  );
}

function ParentSelect({
  id,
  value,
  options,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  options: ParentOption[];
  onChange: (value: string) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  const known = options.some((o) => o.value === value);
  const groups: { label: string; items: ParentOption[] }[] = [
    { label: "Your open epics", items: options.filter((o) => o.group === "existing") },
    { label: "New epics in this draft", items: options.filter((o) => o.group === "new") },
  ].filter((g) => g.items.length > 0);
  return (
    <select
      id={id}
      className={styles.input}
      value={known ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-tip="Moves the task under another epic, a new epic from the draft, or no epic."
    >
      {!known ? <option value="">Pick an epic</option> : null}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
      <option value="none">No epic</option>
    </select>
  );
}

function TaskCard({
  task,
  problems,
  options,
  actionText,
  onEdit,
}: {
  task: ReviewIssue;
  problems: IssueProblems | undefined;
  options: ParentOption[];
  actionText: (id: string) => string;
  onEdit: (edit: IssueEdit) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const ids = {
    include: `t-inc-${uid}`,
    summary: `t-sum-${uid}`,
    summaryError: `t-sum-e-${uid}`,
    description: `t-desc-${uid}`,
    descriptionError: `t-desc-e-${uid}`,
    epic: `t-epic-${uid}`,
    epicError: `t-epic-e-${uid}`,
    covers: `t-cov-${uid}`,
  };
  const p = task.include ? problems : undefined;
  const menu = useMenuRegion(
    (): MenuSection => ({
      title: task.summary.trim() || "Task",
      items: [
        {
          label: task.include ? "Leave out" : "Include",
          onSelect: () => onEdit({ include: !task.include }),
          tip: task.include ? "Keeps this task out of Jira; its action stays unfiled." : "Puts this task back into the create.",
        },
        task.parent
          ? { label: "Move to No epic", onSelect: () => onEdit({ parent: null }), tip: "Creates the task without a parent epic." }
          : null,
      ],
    }),
  );

  return (
    <article className={styles.task} data-off={!task.include || undefined} aria-labelledby={ids.summary} {...menu}>
      <label className={styles.include} htmlFor={ids.include} data-tip="Leave it ticked to create this task; untick to keep it out of Jira.">
        <input
          id={ids.include}
          type="checkbox"
          className={styles.check}
          aria-label={`Include: ${task.summary.trim() || "this task"}`}
          checked={task.include}
          onChange={(e) => onEdit({ include: e.target.checked })}
        />
        <span>Include</span>
        {!task.include ? <span className={styles.leftOut}>Left out of Jira</span> : null}
      </label>

      <div className={styles.taskMain}>
        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor={ids.summary} className={styles.label}>
              Summary
            </label>
            <Counter value={task.summary} max={SUMMARY_MAX} />
          </div>
          <input
            id={ids.summary}
            className={styles.input}
            value={task.summary}
            dir="auto"
            autoComplete="off"
            aria-invalid={p?.summary ? true : undefined}
            aria-describedby={p?.summary ? ids.summaryError : undefined}
            onChange={(e) => onEdit({ summary: e.target.value.replace(/[\r\n]+/g, " ") })}
          />
          {p?.summary ? (
            <p id={ids.summaryError} className={styles.fieldError}>
              {p.summary}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor={ids.description} className={styles.label}>
              Description
            </label>
            <Counter value={task.description} max={DESCRIPTION_MAX} />
          </div>
          <textarea
            id={ids.description}
            className={styles.textarea}
            value={task.description}
            dir="auto"
            rows={3}
            aria-invalid={p?.description ? true : undefined}
            aria-describedby={p?.description ? ids.descriptionError : undefined}
            onChange={(e) => onEdit({ description: e.target.value })}
          />
          {p?.description ? (
            <p id={ids.descriptionError} className={styles.fieldError}>
              {p.description}
            </p>
          ) : null}
        </div>
      </div>

      <div className={styles.taskSide}>
        <div className={styles.field}>
          <label htmlFor={ids.epic} className={styles.label}>
            Epic
          </label>
          <ParentSelect
            id={ids.epic}
            value={parentValue(task.parent)}
            options={options}
            onChange={(v) => onEdit({ parent: parseParentValue(v) })}
            invalid={!!p?.parent}
            describedBy={p?.parent ? ids.epicError : undefined}
          />
          {p?.parent ? (
            <p id={ids.epicError} className={styles.fieldError}>
              {p.parent}
            </p>
          ) : null}
        </div>
        <div className={styles.covers}>
          <p id={ids.covers} className={styles.label}>
            Covers {task.actionIds.length === 1 ? "this action" : `${task.actionIds.length} actions`}
          </p>
          <ul className={styles.coverList} aria-labelledby={ids.covers}>
            {task.actionIds.map((id) => (
              <li key={id} dir="auto">
                {actionText(id)}
              </li>
            ))}
          </ul>
          {p?.actions ? <p className={styles.fieldError}>{p.actions}</p> : null}
        </div>
      </div>
    </article>
  );
}

function GroupHead({
  group,
  site,
  onEdit,
  onIncludeAll,
  epicProblems,
}: {
  group: EpicGroup;
  site: string;
  onEdit: (draftId: string, edit: IssueEdit) => void;
  onIncludeAll: (epicId: string, include: boolean) => void;
  epicProblems: IssueProblems | undefined;
}) {
  const uid = useId().replace(/:/g, "");
  const [openDescription, setOpenDescription] = useState(false);
  const menu = useMenuRegion((): MenuSection | null => {
    if (group.kind === "existing") {
      const url = jiraIssueUrl(group.key, site);
      return url
        ? { title: group.key, items: [{ label: "Open in Jira", onSelect: () => followLink(url), tip: `Opens epic ${group.key} in Jira in a new tab.` }] }
        : null;
    }
    if (group.kind === "new") {
      const id = group.epic.draftId;
      return {
        title: "New epic",
        items: [
          group.dropped
            ? { label: "Include its tasks", onSelect: () => onIncludeAll(id, true), tip: "Ticks every task under this epic, so the epic is created too." }
            : { label: "Leave out its tasks", onSelect: () => onIncludeAll(id, false), tip: "Unticks every task under this epic, so the epic is dropped." },
        ],
      };
    }
    return null;
  });

  if (group.kind === "existing") {
    return (
      <div className={styles.groupHead} {...menu}>
        <span className={styles.kind}>Epic</span>
        <KeyLink issueKey={group.key} site={site} label={`epic ${group.key}`} />
        <span className={styles.epicTitle} dir="auto">
          {group.summary || "Unknown epic"}
        </span>
        {!group.known ? (
          <span className={styles.flag}>
            <StatusDot tone="warn" size={8} glow={false} />
            Not one of your open epics
          </span>
        ) : null}
      </div>
    );
  }

  if (group.kind === "none") {
    return (
      <div className={styles.groupHead}>
        <span className={styles.kind}>No epic</span>
        <span className={styles.groupHint}>These tasks are created without a parent epic.</span>
      </div>
    );
  }

  const epic = group.epic;
  const titleId = `epic-title-${uid}`;
  const titleErrorId = `epic-title-e-${uid}`;
  const descId = `epic-desc-${uid}`;
  const descErrorId = `epic-desc-e-${uid}`;
  const p = group.dropped ? undefined : epicProblems;
  return (
    <div className={styles.groupHead} data-new="" {...menu}>
      <div className={styles.newEpic}>
        <label htmlFor={titleId} className={styles.kind} data-new="">
          New epic
        </label>
        <input
          id={titleId}
          className={`${styles.input} ${styles.epicInput}`}
          value={epic.summary}
          dir="auto"
          autoComplete="off"
          aria-invalid={p?.summary ? true : undefined}
          aria-describedby={p?.summary ? titleErrorId : undefined}
          onChange={(e) => onEdit(epic.draftId, { summary: e.target.value.replace(/[\r\n]+/g, " ") })}
          data-tip="Renames the new epic; it is created first and its tasks go under it."
        />
        <button
          type="button"
          className={styles.disclose}
          aria-expanded={openDescription}
          aria-controls={descId}
          onClick={() => setOpenDescription((o) => !o)}
          data-tip="Shows or hides the new epic's description, so you can edit it."
        >
          {openDescription ? "Hide description" : "Description"}
        </button>
      </div>
      {p?.summary ? (
        <p id={titleErrorId} className={styles.fieldError}>
          {p.summary}
        </p>
      ) : null}
      {group.dropped ? (
        <p className={styles.dropped}>Not created: none of its tasks are included.</p>
      ) : null}
      <div id={descId} className={styles.field} hidden={!openDescription && !p?.description}>
        <div className={styles.labelRow}>
          <label htmlFor={`${descId}-input`} className={styles.label}>
            Epic description
          </label>
          <Counter value={epic.description} max={DESCRIPTION_MAX} />
        </div>
        <textarea
          id={`${descId}-input`}
          className={styles.textarea}
          value={epic.description}
          dir="auto"
          rows={3}
          aria-invalid={p?.description ? true : undefined}
          aria-describedby={p?.description ? descErrorId : undefined}
          onChange={(e) => onEdit(epic.draftId, { description: e.target.value })}
        />
        {p?.description ? (
          <p id={descErrorId} className={styles.fieldError}>
            {p.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Results({ jira }: { jira: NoteJira }) {
  const outcome = jira.outcome!;
  const uid = useId().replace(/:/g, "");
  const [copied, setCopied] = useState(false);
  const tasksMade = outcome.created.filter((c) => c.type === "Task");
  const copyKeys = () =>
    void copyText(tasksMade.map((c) => `${c.key} ${c.summary}`).join("\n")).then((ok) => {
      if (ok) setCopied(true);
    });

  return (
    <div className={styles.results}>
      <p className={styles.resultHead}>{outcomeText(outcome)}</p>

      {outcome.writeBack ? (
        <div className={styles.banner} data-tone="warn" role="alert">
          <p>
            <strong>Keys not written into the note.</strong> {outcome.writeBack}
          </p>
          {tasksMade.length ? (
            <div>
              <Button
                size="sm"
                icon={copied ? <CheckIcon /> : <CopyIcon />}
                onClick={copyKeys}
                tip="Copies each new task key with its summary, one per line, to paste into the note."
              >
                {copied ? "Copied" : "Copy keys"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : tasksMade.length ? (
        <p className={styles.resultNote}>The new keys were added to their action lines in the note.</p>
      ) : null}

      {outcome.created.length ? (
        <section className={styles.resultBlock} aria-labelledby={`jira-created-${uid}`}>
          <h3 id={`jira-created-${uid}`} className={styles.label}>
            Created in {JIRA_PROJECT}
          </h3>
          <ul className={styles.resultList}>
            {outcome.created.map((c) => (
              <li key={c.key} className={styles.resultRow}>
                <KeyLink issueKey={c.key} site={jira.site} />
                <span className={styles.typeTag}>{c.type}</span>
                <span className={styles.resultText} dir="auto">
                  {c.summary}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {outcome.failed.length ? (
        <section className={styles.resultBlock} aria-labelledby={`jira-failed-${uid}`}>
          <h3 id={`jira-failed-${uid}`} className={styles.label}>
            Not created
          </h3>
          <ul className={styles.resultList}>
            {outcome.failed.map((f) => (
              <li key={f.draftId} className={styles.resultRow} data-failed="">
                <StatusDot tone="danger" size={9} glow={false} />
                <span className={styles.resultText}>
                  <span dir="auto">{f.summary || "An issue from the draft"}</span>
                  <span className={styles.failReason} dir="auto">
                    {f.error}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.resultNote}>Their actions stay unfiled, so drafting again picks them up.</p>
        </section>
      ) : null}
    </div>
  );
}

export function JiraReviewDialog({ jira, noteTitle }: JiraReviewDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const uid = useId().replace(/:/g, "");
  const ids = { heading: `jira-review-${uid}`, intro: `jira-review-intro-${uid}`, status: `jira-review-status-${uid}` };
  const { review, outcome, actions } = jira;
  const open = jira.dialogOpen && (review !== null || outcome !== null);
  const creating = jira.creating !== null;
  const clock = useElapsed(jira.creating);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      headingRef.current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      // Back to the button that opened it; when that is now off (a create is running), to the
      // section's Show progress or Show results button instead, so focus never drops to the page.
      const back = opener.current;
      if (back?.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
      else document.querySelector<HTMLElement>("[data-jira-resume]")?.focus();
    }
  }, [open]);

  const actionIds = useMemo(() => (actions ? new Set(actions.map((a) => a.id)) : null), [actions]);
  const byId = useMemo(() => new Map<string, DetectedAction>((actions ?? []).map((a) => [a.id, a])), [actions]);
  const groups = useMemo(() => (review ? groupByEpic(review) : []), [review]);
  const options = useMemo(() => (review ? parentOptions(review) : []), [review]);
  const check = useMemo(() => (review ? checkReview(review, actionIds) : null), [review, actionIds]);
  const counts = review ? draftCounts(review) : { tasks: 0, epics: 0 };
  const problemCount = check ? Object.values(check.issues).reduce((n, p) => n + Object.keys(p).length, 0) : 0;

  const edit = (draftId: string, change: IssueEdit) => {
    if (review && !creating) jira.setReview(editIssue(review, draftId, change));
  };
  const includeAll = (epicId: string, include: boolean) => {
    if (review && !creating) jira.setReview(setEpicTasksIncluded(review, epicId, include));
  };
  const actionText = (id: string) => byId.get(id)?.text ?? "An action that is no longer in the note";

  let blockedWhy: string | null = null;
  if (check && !check.ok) {
    blockedWhy = check.form ?? `Fix ${problemCount === 1 ? "the field" : `the ${problemCount} fields`} marked in red first.`;
  }

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={ids.heading}
      aria-describedby={ids.intro}
      onCancel={(e) => {
        e.preventDefault();
        jira.closeDialog();
      }}
    >
      <div className={styles.frame}>
        <header className={styles.head}>
          <div className={styles.headText}>
            <h2 id={ids.heading} ref={headingRef} tabIndex={-1} className={styles.heading}>
              {outcome ? "Jira results" : "Review Jira drafts"}
            </h2>
            <p id={ids.intro} className={styles.intro}>
              {outcome ? (
                <>
                  From the note <span dir="auto">"{noteTitle}"</span>.
                </>
              ) : (
                <>
                  Drafted by Claude from <span dir="auto">"{noteTitle}"</span>. Edit what you like; nothing reaches Jira until
                  you press Create.
                </>
              )}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<CloseIcon />}
            aria-label="Close"
            onClick={jira.closeDialog}
            className={styles.close}
            tip={
              creating
                ? "Hides this window; the Jira run keeps going and its result shows under the preview."
                : "Hides this window and keeps your edits; reopen it from Detected actions. Esc does the same."
            }
          />
        </header>

        <div className={styles.scroll}>
          {outcome ? (
            <Results jira={jira} />
          ) : review ? (
            <fieldset className={styles.groups} disabled={creating} aria-busy={creating || undefined}>
              <legend className="sr-only">Drafted Jira issues</legend>
              {groups.map((g) => (
                <section
                  key={g.id}
                  className={styles.group}
                  data-kind={g.kind}
                  data-dropped={(g.kind === "new" && g.dropped) || undefined}
                  aria-label={
                    g.kind === "existing"
                      ? `Epic ${g.key} ${g.summary}`
                      : g.kind === "new"
                        ? `New epic: ${g.epic.summary}`
                        : "No epic"
                  }
                >
                  <GroupHead
                    group={g}
                    site={jira.site}
                    onEdit={edit}
                    onIncludeAll={includeAll}
                    epicProblems={g.kind === "new" ? check?.issues[g.epic.draftId] : undefined}
                  />
                  <div className={styles.tasks}>
                    {g.tasks.map((t) => (
                      <TaskCard
                        key={t.draftId}
                        task={t}
                        problems={check?.issues[t.draftId]}
                        options={options}
                        actionText={actionText}
                        onEdit={(change) => edit(t.draftId, change)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </fieldset>
          ) : null}
        </div>

        <footer className={styles.foot}>
          {outcome ? (
            <div className={styles.footActions}>
              <Button variant="primary" onClick={jira.closeDialog} tip="Closes this window; the summary stays under the preview.">
                Done
              </Button>
            </div>
          ) : (
            <>
              <div className={styles.footText} id={ids.status} aria-live="polite">
                <p className={styles.counts}>{countsText(counts)}</p>
                {creating ? (
                  <p className={styles.runningLine}>
                    <Spinner size={14} />
                    <span>
                      Creating in Jira through Claude, {clock}. This usually takes 20 to 60 seconds. You can close this window;
                      the result shows under the preview.
                    </span>
                  </p>
                ) : blockedWhy ? (
                  <p className={styles.blocked}>{blockedWhy}</p>
                ) : null}
              </div>
              {jira.createError && !creating ? <FailureLine failure={jira.createError} className={styles.footError} /> : null}
              <div className={styles.footActions}>
                <Button
                  variant="ghost"
                  onClick={jira.closeDialog}
                  tip={
                    creating
                      ? "Hides this window; the Jira run keeps going and its result shows under the preview."
                      : "Hides this window and keeps your edits; reopen it from Detected actions."
                  }
                >
                  Close
                </Button>
                <Button
                  variant="primary"
                  loading={creating}
                  loadingLabel="Creating in Jira"
                  disabled={!creating && !!blockedWhy}
                  aria-describedby={ids.status}
                  onClick={jira.startCreate}
                  tip={
                    blockedWhy ??
                    `Creates the included issues in ${JIRA_PROJECT}, assigned to you, then adds their keys to the note.`
                  }
                >
                  Create in Jira
                </Button>
              </div>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
