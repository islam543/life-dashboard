import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Project, ProjectsState, ProjectTask } from "../../../shared/types";
import { ApiRequestError, errorMessage } from "../api";
import { projectsApi } from "../api/projects";
import { MOTION } from "../hooks/useReducedMotion";
import { dayKey, plural } from "../lib/format";
import { LIMITS, sortTasks, taskDueInfo, taskProgress } from "../lib/projects";
import { parseDayKey } from "../lib/timeAgg";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { StatusDot } from "../ui/StatusDot";
import { ChevronIcon, PlusIcon, TrashIcon } from "./icons";
import { InlineText } from "./InlineText";
import { DueBadge, focusWhenReady, handOffFocus, partStyles, ProgressBar } from "./parts";
import { useToasts } from "./Toasts";
import type { ProjectsStore } from "./useProjects";
import styles from "./TaskList.module.css";

// A project's tasks. Add with Enter (an optional due date beside it). Tick to finish: the box draws
// its check, the text is struck through, and the task slides down to Done a moment later. Click a
// task's text to edit it, its date to change it. Delete hides the task at once and shows a 5 s Undo;
// the server delete runs when that time is up (or when you leave the page).
// Long lists: the first 50 open tasks and the first 30 done ones render, with a Show all.

const OPEN_FIRST = 50;
const DONE_FIRST = 30;
/** How long a ticked task stays in place, showing its check, before it moves to Done. */
const SETTLE_MS = 650;

/** Hover help on a new task's controls until the server has saved it. */
const PENDING_TIP = "Works once this new task finishes saving, in a moment.";
const SET_DUE_TIP = "Sets a due date; Needs you flags the task 3 days ahead while the project is Active.";

function patchTask(s: ProjectsState, projectId: string, taskId: string, patch: Partial<ProjectTask>): ProjectsState {
  return {
    ...s,
    projects: s.projects.map((p) =>
      p.id === projectId ? { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) } : p,
    ),
  };
}

export function TaskList({ project, store, now }: { project: Project; store: ProjectsStore; now: Date }) {
  const toasts = useToasts();
  const uid = useId().replace(/:/g, "");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const [showAllOpen, setShowAllOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tempSeq = useRef(0);
  const settleTimers = useRef(new Map<string, number>());

  useEffect(() => {
    const timers = settleTimers.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
    };
  }, []);

  const visible = sortTasks(project.tasks.filter((t) => !hiddenIds.has(t.id)));
  const open = visible.filter((t) => !t.done || settling.has(t.id));
  const done = visible.filter((t) => t.done && !settling.has(t.id));
  const progress = taskProgress(visible);
  const openShown = showAllOpen ? open : open.slice(0, OPEN_FIRST);
  const doneShown = showAllDone ? done : done.slice(0, DONE_FIRST);
  const wrapRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ open, done });
  latest.current = { open, done };

  const rowEl = (id: string) => wrapRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) ?? null;
  const control = (id: string | undefined, part: "check" | "delete") =>
    id ? (rowEl(id)?.querySelector<HTMLElement>(part === "check" ? "input[type=checkbox]" : "[data-part=delete]") ?? null) : null;
  /** The task after `id` in `list`, else the one before it. */
  const neighbour = (id: string, list: readonly ProjectTask[]) => {
    const i = list.findIndex((t) => t.id === id);
    return list[i + 1]?.id ?? list[i - 1]?.id;
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (value === "") {
      setAddError("Type the task first.");
      return;
    }
    if ([...value].length > LIMITS.task) {
      setAddError(`Keep a task to ${LIMITS.task} characters or fewer (now ${[...value].length}).`);
      return;
    }
    if (due !== "" && !parseDayKey(due)) {
      setAddError("Pick a real due date, or leave it empty.");
      return;
    }
    setAddError(null);
    const tempId = `pending-${++tempSeq.current}`;
    const created = new Date().toISOString();
    const dueValue = due === "" ? null : due;
    setText("");
    setDue("");
    inputRef.current?.focus();
    try {
      await store.write(
        () => projectsApi.addTask(project.id, { text: value, due: dueValue }),
        (s) => ({
          ...s,
          projects: s.projects.map((p) =>
            p.id === project.id
              ? { ...p, tasks: [...p.tasks, { id: tempId, text: value, done: false, due: dueValue, doneAt: null, createdAt: created }] }
              : p,
          ),
        }),
      );
    } catch (err) {
      // Give the text back so nothing typed is lost.
      setText((current) => (current === "" ? value : current));
      setDue((current) => (current === "" && dueValue ? dueValue : current));
      setAddError(`Couldn't add the task. ${errorMessage(err)}`);
    }
  };

  const toggle = async (task: ProjectTask) => {
    const doneNow = !task.done;
    if (doneNow) {
      setSettling((s) => new Set(s).add(task.id));
      const old = settleTimers.current.get(task.id);
      if (old) window.clearTimeout(old);
      settleTimers.current.set(
        task.id,
        window.setTimeout(() => {
          settleTimers.current.delete(task.id);
          // The ticked task is about to leave the open list: keep keyboard focus in the list.
          const next = neighbour(task.id, latest.current.open);
          handOffFocus(rowEl(task.id), control(next, "check") ?? inputRef.current);
          setSettling((s) => {
            const next = new Set(s);
            next.delete(task.id);
            return next;
          });
        }, SETTLE_MS),
      );
    }
    try {
      const saved = store.write(
        () => projectsApi.updateTask(project.id, task.id, { done: doneNow }),
        (s) => patchTask(s, project.id, task.id, { done: doneNow, doneAt: doneNow ? new Date().toISOString() : null }),
      );
      // Reopened from Done: the row moves to the open list; follow it with focus.
      if (!doneNow) focusWhenReady(() => control(task.id, "check"));
      await saved;
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't ${doneNow ? "finish" : "reopen"} “${task.text}”. ${errorMessage(err)}` });
    }
  };

  const saveText = (task: ProjectTask, next: string) =>
    store.write(
      () => projectsApi.updateTask(project.id, task.id, { text: next }),
      (s) => patchTask(s, project.id, task.id, { text: next }),
    );

  const saveDue = (task: ProjectTask, next: string | null) =>
    store.write(
      () => projectsApi.updateTask(project.id, task.id, { due: next }),
      (s) => patchTask(s, project.id, task.id, { due: next }),
    );

  const unhide = (id: string) =>
    setHiddenIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  const remove = (task: ProjectTask) => {
    const list = task.done ? latest.current.done : latest.current.open;
    const next = neighbour(task.id, list);
    handOffFocus(rowEl(task.id), control(next, "delete") ?? inputRef.current);
    setHiddenIds((s) => new Set(s).add(task.id));
    toasts.push({
      message: `Deleted “${task.text}”.`,
      action: { label: "Undo", onAction: () => unhide(task.id) },
      duration: 5000,
      onExpire: () => {
        store
          .write(
            () => projectsApi.removeTask(project.id, task.id),
            (s) => ({
              ...s,
              projects: s.projects.map((p) => (p.id === project.id ? { ...p, tasks: p.tasks.filter((t) => t.id !== task.id) } : p)),
            }),
          )
          .then(() => unhide(task.id))
          .catch((err) => {
            unhide(task.id);
            // A task that is already gone (deleted elsewhere) is what we wanted.
            if (!(err instanceof ApiRequestError && err.status === 404)) {
              toasts.push({ tone: "error", message: `Couldn't delete “${task.text}”. It is back in the list. ${errorMessage(err)}` });
            }
          });
      },
    });
  };

  const row = (task: ProjectTask) => (
    <TaskRow
      key={task.id}
      task={task}
      now={now}
      pending={task.id.startsWith("pending-")}
      onToggle={() => void toggle(task)}
      onSaveText={(next) => saveText(task, next)}
      onSaveDue={(next) => saveDue(task, next)}
      onDelete={() => remove(task)}
    />
  );

  return (
    <div ref={wrapRef} className={styles.wrap}>
      {visible.length > 0 ? (
        <div className={styles.summary}>
          <ProgressBar fraction={progress.fraction} label={`Tasks: ${progress.label}`} />
          <span className={styles.summaryText}>{progress.label}</span>
        </div>
      ) : null}

      <form className={styles.add} onSubmit={(e) => void add(e)} noValidate>
        <label className={styles.addLabel} htmlFor={`task-${uid}-text`}>
          New task
        </label>
        <div className={styles.addRow}>
          <input
            ref={inputRef}
            id={`task-${uid}-text`}
            className={`${partStyles.input} ${styles.addText}`}
            value={text}
            dir="auto"
            autoComplete="off"
            placeholder="What is the next step? Press Enter to add"
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? `task-${uid}-error` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (addError) setAddError(null);
            }}
          />
          <input
            type="date"
            className={`${partStyles.input} ${styles.addDue}`}
            aria-label="Due date for the new task (optional)"
            data-tip="Sets an optional due date; Needs you flags it 3 days ahead while the project is Active."
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            icon={<PlusIcon />}
            className={styles.addButton}
            tip="Adds the task to the open list; Enter in the text field does the same."
          >
            Add
          </Button>
        </div>
        {addError ? (
          <p id={`task-${uid}-error`} className={partStyles.fieldError} role="alert">
            <StatusDot tone="danger" size={9} glow={false} />
            {addError}
          </p>
        ) : null}
      </form>

      {visible.length === 0 ? (
        <EmptyState size="inline" title="No tasks yet." body="Add the next concrete step above. Tasks with a due date show up in Needs you when they get close." />
      ) : open.length === 0 ? (
        <EmptyState size="inline" tone="ok" title="Every task is done." body="Add the next step above, or set the project to Done." />
      ) : (
        <ul className={styles.list} aria-label={`Open tasks, ${open.length}`}>
          <AnimatePresence initial={false}>
            {openShown.map((t) => (
              <motion.li
                key={t.id}
                layout="position"
                className={styles.item}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: MOTION.fast } }}
                transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
              >
                {row(t)}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      {open.length > OPEN_FIRST ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.more}
          aria-expanded={showAllOpen}
          onClick={() => setShowAllOpen((v) => !v)}
          tip={showAllOpen ? `Shows only the first ${OPEN_FIRST} open tasks again.` : `Lists every open task, not just the first ${OPEN_FIRST}.`}
        >
          {showAllOpen ? "Show fewer" : `Show all ${open.length} open tasks`}
        </Button>
      ) : null}

      {done.length > 0 ? (
        <div className={styles.done}>
          <button
            type="button"
            className={styles.doneToggle}
            aria-expanded={doneOpen}
            aria-controls={`task-${uid}-done`}
            onClick={() => setDoneOpen((v) => !v)}
            data-tip={doneOpen ? "Hides the finished tasks." : "Shows finished tasks; untick one to reopen it."}
          >
            <span className={styles.chevron} data-open={doneOpen || undefined}>
              <ChevronIcon />
            </span>
            Done <span className={styles.count}>{done.length}</span>
          </button>
          <ul id={`task-${uid}-done`} className={styles.list} hidden={!doneOpen} aria-label={`Done tasks, ${done.length}`}>
            {doneOpen ? doneShown.map((t) => <li key={t.id} className={styles.item}>{row(t)}</li>) : null}
          </ul>
          {doneOpen && done.length > DONE_FIRST ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.more}
              aria-expanded={showAllDone}
              onClick={() => setShowAllDone((v) => !v)}
              tip={showAllDone ? `Shows only the first ${DONE_FIRST} done tasks again.` : `Lists every done task, not just the first ${DONE_FIRST}.`}
            >
              {showAllDone ? "Show fewer" : `Show all ${plural(done.length, "done task")}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  now,
  pending,
  onToggle,
  onSaveText,
  onSaveDue,
  onDelete,
}: {
  task: ProjectTask;
  now: Date;
  pending: boolean;
  onToggle: () => void;
  onSaveText: (next: string) => Promise<unknown>;
  onSaveDue: (next: string | null) => Promise<unknown>;
  onDelete: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const checkId = `task-${uid}-check`;
  return (
    <div className={styles.row} data-task-id={task.id} data-done={task.done || undefined} data-pending={pending || undefined}>
      <span className={styles.check}>
        <input
          id={checkId}
          type="checkbox"
          checked={task.done}
          disabled={pending}
          onChange={onToggle}
          aria-label={task.text}
          data-tip={
            pending
              ? PENDING_TIP
              : task.done
                ? "Reopens the task and moves it back to the open list."
                : "Marks the task done; it moves to Done a moment later."
          }
        />
        <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <rect className={styles.box} x="1.5" y="1.5" width="15" height="15" rx="4" />
          <path className={styles.tick} d="M5 9.4l2.7 2.6L13 6.4" pathLength={1} />
        </svg>
      </span>
      <span className={styles.text}>
        <InlineText
          value={task.text}
          label="Task"
          editLabel={`Edit task: ${task.text}`}
          maxLength={LIMITS.task}
          requiredMessage="A task needs some text. Delete it instead if it is not needed."
          onSave={onSaveText}
          className={styles.textValue}
          quietButton
          tip="Edits the task; Enter saves, Esc cancels."
        />
      </span>
      <DueEditor due={task.due} done={task.done} now={now} taskText={task.text} onSave={onSaveDue} disabled={pending} />
      <Button
        variant="ghost"
        size="sm"
        icon={<TrashIcon />}
        className={styles.delete}
        data-part="delete"
        aria-label={`Delete task: ${task.text}`}
        tip={pending ? PENDING_TIP : "Deletes the task; Undo in the message or Ctrl+Z brings it back within 5 seconds."}
        onClick={onDelete}
        disabled={pending}
      />
    </div>
  );
}

/** The task's due date as a countdown; a click turns it into a date field (Enter or leaving it saves, empty clears). */
function DueEditor({
  due,
  done,
  now,
  taskText,
  onSave,
  disabled,
}: {
  due: string | null;
  done: boolean;
  now: Date;
  taskText: string;
  onSave: (next: string | null) => Promise<unknown>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(due ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const handled = useRef(false);
  const info = taskDueInfo(due, now, done);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    el?.focus();
    try {
      el?.showPicker?.();
    } catch {
      // showPicker needs a user gesture in some browsers; the field is focused either way.
    }
  }, [editing]);

  const finish = async (refocus: boolean) => {
    handled.current = true;
    const next = draft === "" ? null : draft;
    if (next !== null && !parseDayKey(next)) {
      setError("Pick a real date, or clear it.");
      handled.current = false;
      return;
    }
    setEditing(false);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
    if (next === due) return;
    try {
      await onSave(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (editing) {
    return (
      <span className={styles.dueEdit}>
        <input
          ref={inputRef}
          type="date"
          className={`${partStyles.input} ${styles.dueInput}`}
          aria-label={`Due date: ${taskText}. Enter saves, Escape cancels, empty clears it.`}
          value={draft}
          min={dayKey(new Date(now.getFullYear() - 1, 0, 1))}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              handled.current = true;
              setEditing(false);
              requestAnimationFrame(() => buttonRef.current?.focus());
            }
          }}
          onBlur={() => {
            if (!handled.current) void finish(false);
          }}
        />
      </span>
    );
  }

  return (
    <span className={styles.due}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.dueButton}
        data-empty={!info || undefined}
        disabled={disabled}
        aria-label={info ? `Due ${info.label}. Change the due date of: ${taskText}` : `Set a due date for: ${taskText}`}
        data-tip={disabled ? PENDING_TIP : info ? "Changes the due date; Enter saves, Esc cancels, an empty date clears it." : SET_DUE_TIP}
        onClick={() => {
          handled.current = false;
          setDraft(due ?? "");
          setError(null);
          setEditing(true);
        }}
      >
        {info ? <DueBadge label={info.label} tone={info.tone} /> : <span className={styles.dueEmpty}>Due date</span>}
      </button>
      {error ? (
        <span className={styles.dueError} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
