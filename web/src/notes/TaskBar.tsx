import { useEffect, useId, useRef, useState } from "react";
import type { Note, TaskInfo, TaskNote, TaskPatch } from "../../../shared/types";
import { ApiRequestError, errorMessage, OFFLINE_MESSAGE } from "../api";
import { jsonRequest } from "../api/projects";
import type { MenuSection } from "../lib/contextMenu";
import { Spinner } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { StatusDot } from "../ui/StatusDot";
import styles from "./TaskBar.module.css";

// The task bar: a note in the Tasks section is a task (docs/ARCHITECTURE.md "v1.2", Task notes), and
// this row above its text shows the task's day, start time, length and a Done box. Every change is
// sent at once with PATCH /api/schedule/tasks?path= (the date and time fields wait until typing
// stops), then the note is re-read so the list and the editor show the file's new state. The note's
// own autosave never touches the task_* frontmatter, so the two never overwrite each other.
// Right-click offers Mark done, Due today and the clears, all shortcuts to the visible fields.

/** True for a note in the Tasks section (the server adds `task` to these). */
export function isTaskPath(path: string): boolean {
  return path.startsWith("Tasks/");
}

/** The task fields the server sent with a note, or null when it sent none (schedule server not ready). */
export function taskOf(note: Note | null): TaskInfo | null {
  const task = (note as (Note & { task?: TaskInfo }) | null)?.task;
  return task && typeof task === "object" ? task : null;
}

/** PATCH /api/schedule/tasks?path= (T27). The Home Schedule panel has its own client; this one only edits fields. */
function patchTask(path: string, patch: TaskPatch): Promise<TaskNote> {
  return jsonRequest<TaskNote>("PATCH", `/api/schedule/tasks?path=${encodeURIComponent(path)}`, { body: patch });
}

const LENGTHS = [15, 30, 45, 60, 90, 120] as const;
const TYPE_DELAY_MS = 700;

function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function failureText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.offline) return `${OFFLINE_MESSAGE} The change wasn't saved.`;
    if (err.status === 501) return "Schedule server not ready, so task changes can't be saved yet.";
    if (err.status === 404) return "This task note isn't in the notes folder any more.";
  }
  return `Couldn't save the change. ${errorMessage(err)}`;
}

const EMPTY: TaskInfo = { due: null, start: null, minutes: null, done: false, source: "me" };

export interface TaskBarProps {
  path: string;
  /** From the note; null when the server sent no task fields. */
  task: TaskInfo | null;
  /** Read only while the editor waits on Keep mine or Load theirs. */
  disabled: boolean;
  /** Re-read the note after a change landed. */
  onChanged: () => void;
}

export function TaskBar({ path, task, disabled, onChanged }: TaskBarProps) {
  const uid = useId().replace(/:/g, "");
  const [value, setValue] = useState<TaskInfo>(task ?? EMPTY);
  const [pending, setPending] = useState(0);
  const pendingRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  /** The last state the server confirmed, to roll back to when a change fails. */
  const confirmed = useRef<TaskInfo>(task ?? EMPTY);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const typing = useRef<{ timer: ReturnType<typeof setTimeout>; patch: TaskPatch } | null>(null);
  const mounted = useRef(true);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (typing.current) {
        clearTimeout(typing.current.timer);
        // Leaving with a date still being typed: send it rather than drop it.
        void patchTask(path, typing.current.patch).catch(() => undefined);
        typing.current = null;
      }
    };
  }, [path]);

  // The note was re-read (or changed outside): show the file's values when nothing is on its way.
  const taskKey = JSON.stringify(task);
  useEffect(() => {
    if (pendingRef.current > 0 || typing.current) return;
    const next = task ?? EMPTY;
    confirmed.current = next;
    setValue(next);
  }, [taskKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const unavailable = task === null;
  const off = disabled || unavailable;

  /** Sends one change after the ones before it, so quick edits land in order. */
  const send = (patch: TaskPatch) => {
    pendingRef.current += 1;
    setPending(pendingRef.current);
    setError(null);
    queue.current = queue.current.then(async () => {
      try {
        const saved = await patchTask(path, patch);
        const next =
          saved && saved.task && typeof saved.task === "object"
            ? saved.task
            : { ...confirmed.current, ...(patch as Partial<TaskInfo>) };
        confirmed.current = next;
        pendingRef.current -= 1;
        if (!mounted.current) return;
        setPending(pendingRef.current);
        if (pendingRef.current === 0 && !typing.current) setValue(next);
        onChangedRef.current();
      } catch (err) {
        pendingRef.current -= 1;
        if (!mounted.current) return;
        setPending(pendingRef.current);
        setValue(confirmed.current);
        setError(failureText(err));
      }
    });
  };

  const change = (patch: TaskPatch) => {
    if (off) return;
    if (typing.current) {
      clearTimeout(typing.current.timer);
      patch = { ...typing.current.patch, ...patch };
      typing.current = null;
    }
    setValue((v) => ({ ...v, ...(patch as Partial<TaskInfo>) }));
    send(patch);
  };

  /** Date and time fields: show at once, send once typing stops (a year typed digit by digit is one change). */
  const type = (patch: TaskPatch) => {
    if (off) return;
    setValue((v) => ({ ...v, ...(patch as Partial<TaskInfo>) }));
    const merged = { ...(typing.current?.patch ?? {}), ...patch };
    if (typing.current) clearTimeout(typing.current.timer);
    typing.current = { patch: merged, timer: setTimeout(() => commitTyping(), TYPE_DELAY_MS) };
  };

  const commitTyping = () => {
    const t = typing.current;
    if (!t) return;
    clearTimeout(t.timer);
    typing.current = null;
    send(t.patch);
  };

  const today = todayIso();
  const overdue = !value.done && value.due !== null && value.due < today;

  const menu = useMenuRegion((): MenuSection | null => {
    if (off) return null;
    return {
      title: "Task",
      items: [
        {
          label: value.done ? "Mark not done" : "Mark done",
          onSelect: () => change({ done: !value.done }),
          tip: value.done ? "Opens the task again; it shows in the schedule as open." : "Ticks the task off in its note and the schedule.",
        },
        value.due !== today
          ? { label: "Due today", onSelect: () => change({ due: today }), tip: "Sets the task's day to today, so it shows in today's schedule." }
          : null,
        value.due
          ? { label: "Clear due date", onSelect: () => change({ due: null }), tip: "Takes the day off the task; it moves to the unscheduled list." }
          : null,
        value.start
          ? { label: "Clear start time", onSelect: () => change({ start: null }), tip: "Keeps the day but drops the time, so it can happen any time that day." }
          : null,
      ],
    };
  });

  const lengths: number[] = [...LENGTHS];
  if (value.minutes !== null && !lengths.includes(value.minutes)) lengths.push(value.minutes);
  lengths.sort((a, b) => a - b);

  const ids = { done: `task-done-${uid}`, due: `task-due-${uid}`, start: `task-start-${uid}`, len: `task-len-${uid}` };

  return (
    <div className={styles.bar} data-done={value.done || undefined} data-off={off || undefined} {...menu}>
      <div className={styles.fields} role="group" aria-label="Task">
        <label className={styles.done} htmlFor={ids.done} data-tip="Ticks the task off; it leaves the open lists in the schedule.">
          <input
            id={ids.done}
            type="checkbox"
            className={styles.check}
            checked={value.done}
            disabled={off}
            onChange={(e) => change({ done: e.target.checked })}
          />
          <span>Done</span>
        </label>

        <div className={styles.field}>
          <label htmlFor={ids.due} className={styles.label}>
            Due
          </label>
          <input
            id={ids.due}
            type="date"
            className={styles.input}
            value={value.due ?? ""}
            disabled={off}
            onChange={(e) => type({ due: e.target.value || null })}
            onBlur={commitTyping}
            data-tip="Sets the day the task is planned for; clear it to move it to unscheduled."
          />
          {overdue ? (
            <span className={styles.overdue}>
              <StatusDot tone="warn" size={8} glow={false} />
              Overdue
            </span>
          ) : null}
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.start} className={styles.label}>
            Start
          </label>
          <input
            id={ids.start}
            type="time"
            step={300}
            className={styles.input}
            value={value.start ?? ""}
            disabled={off}
            onChange={(e) => type({ start: e.target.value || null })}
            onBlur={commitTyping}
            data-tip="Sets the start time on that day; leave it empty for any time that day."
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={ids.len} className={styles.label}>
            Length
          </label>
          <select
            id={ids.len}
            className={styles.input}
            value={value.minutes === null ? "" : String(value.minutes)}
            disabled={off}
            onChange={(e) => change({ minutes: e.target.value ? Number(e.target.value) : null })}
            data-tip="Sets how long the task should take, so the schedule can block the time."
          >
            <option value="">No length</option>
            {lengths.map((m) => (
              <option key={m} value={m}>
                {lengthLabel(m)}
              </option>
            ))}
          </select>
        </div>

        {value.source === "ai" ? (
          <span className={styles.source} data-tip="This task came from an AI day or week plan you accepted.">
            From AI plan
          </span>
        ) : null}

        <span className={styles.state} aria-live="polite">
          {pending > 0 ? (
            <>
              <Spinner size={12} />
              Saving
            </>
          ) : null}
        </span>
      </div>

      {unavailable ? (
        <p className={styles.note}>
          <StatusDot tone="off" size={9} glow={false} />
          <span>Schedule server not ready, so this task's day, time and length can't be shown or changed yet.</span>
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          <StatusDot tone="danger" size={9} glow={false} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
