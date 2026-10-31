import { motion } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { DetectedProject, NoteMeta, Project, ProjectArea, ProjectStatus } from "../../../shared/types";
import { errorMessage } from "../api";
import { projectsApi, type ProjectPatch } from "../api/projects";
import { MOTION } from "../hooks/useReducedMotion";
import { formatMinutes, plural, relativeTime } from "../lib/format";
import {
  AREA_LABEL,
  AREA_ORDER,
  dailySeries,
  deadlineInfo,
  detectedFacts,
  displayName,
  LIMITS,
  notesByProject,
  STATUS_LABEL,
  STATUS_ORDER,
  taskProgress,
  weekTotal,
  withoutSource,
  withSource,
} from "../lib/projects";
import { noteHash, projectHash } from "../lib/route";
import { parseDayKey } from "../lib/timeAgg";
import { Segmented } from "../panels/ProjectTimeBars";
import { Button, ButtonLink } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { CountUp } from "../ui/CountUp";
import { EmptyState } from "../ui/EmptyState";
import { Panel, PANEL_RADIUS, type PanelStatus } from "../ui/Panel";
import { StatusDot } from "../ui/StatusDot";
import {
  clickIn,
  focusIn,
  meetingNoteOff,
  patchProject,
  ROW_MENU,
  useDeleteProject,
  useMeetingNote,
  useProjectSave,
  useTargetMenuRegion,
} from "./actions";
import { boardStatus, cardLayoutId } from "./Board";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { BackIcon, CloseIcon, NoteIcon, PencilIcon, PlusIcon, RepoIcon, SessionIcon, TrashIcon } from "./icons";
import { InlineText } from "./InlineText";
import { MOVE_TIP, moveLabel, moveTargets } from "./menus";
import { AreaChip, DueBadge, handOffFocus, KindIcon, partStyles, ProgressBar } from "./parts";
import { Picker } from "./Picker";
import { TaskList } from "./TaskList";
import { CHART_DAYS, TimeChart } from "./TimeChart";
import { useToasts } from "./Toasts";
import type { NotesState, ProjectsStore } from "./useProjects";
import styles from "./ProjectDetail.module.css";

// One project, at #/projects/<id>. The top card grows out of the project's card on the board
// (shared layoutId). Everything edits in place: name, description, status, area, deadline, goals,
// tasks and sources. Linked notes link to #/notes/<path>; New meeting note writes a note in
// "Meeting notes" linked to this project and opens it. Delete asks first and says what happens.
// Ultrawide (>=1920px): three columns that fill the window, each scrolling inside itself:
// overview and goals | tasks | time, notes and sources (CSS only, see .wide).
//
// Right-click (ui/ContextMenu.tsx): the page offers Add task, Add goal, New meeting note, Move to and
// Delete project; a task, goal, linked note or source offers its own row actions instead. Every item
// runs the same handler as the control it matches (the shared ones live in actions.ts).

const GOALS_FULL_TIP = `Holds ${LIMITS.goals} goals at most; remove one to add another.`;

export interface ProjectDetailProps {
  id: string;
  store: ProjectsStore;
  now: Date;
  onDeleted: (project: Project) => void;
  /** Grow out of the board card (shared layoutId). False: fade in, used when the board was scrolled down. Default true. */
  morph?: boolean;
  /** "tasks": arrive with the New task field focused (a card menu's Add task). Default: the top card. */
  startAt?: "tasks";
}

export function ProjectDetail({ id, store, now, onDeleted, morph = true, startAt }: ProjectDetailProps) {
  const leaving = useRef(false);
  const project = store.state?.projects.find((p) => p.id === id) ?? null;

  if (!store.state) {
    return (
      <div className={styles.detail}>
        <BackLink />
        <Panel title="Project" {...boardStatus(store)} skeleton="cards" />
      </div>
    );
  }
  if (!project) {
    if (leaving.current) return null;
    return (
      <div className={styles.detail}>
        <Panel title="Project" state="ok">
          <EmptyState
            title="Project not found."
            body="It may have been deleted in another tab, or the link is out of date. A deleted project's sources are back in Untracked."
            action={
              <ButtonLink href={projectHash()} variant="primary" icon={<BackIcon />} tip="Returns to the board with all your projects.">
                All projects
              </ButtonLink>
            }
          />
        </Panel>
      </div>
    );
  }
  return (
    <DetailBody project={project} store={store} now={now} onDeleted={onDeleted} leaving={leaving} morph={morph} startAt={startAt} />
  );
}

function BackLink() {
  return (
    <ButtonLink
      href={projectHash()}
      variant="ghost"
      size="sm"
      icon={<BackIcon />}
      className={styles.back}
      tip="Returns to the board and puts you back on this project's card."
    >
      All projects
    </ButtonLink>
  );
}

function DetailBody({
  project,
  store,
  now,
  onDeleted,
  leaving,
  morph,
  startAt,
}: {
  project: Project;
  store: ProjectsStore;
  now: Date;
  onDeleted: (project: Project) => void;
  leaving: { current: boolean };
  morph: boolean;
  startAt?: "tasks";
}) {
  const uid = useId().replace(/:/g, "");
  const titleId = `project-${uid}-title`;
  const heroRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const state = store.state!;
  const stats = state.stats.find((s) => s.id === project.id) ?? null;
  const linked = store.notes.notes ? (notesByProject(store.notes.notes).get(project.id) ?? []) : null;
  const openActions = linked ? linked.reduce((s, n) => s + Math.max(0, n.openActions || 0), 0) : null;
  const progress = taskProgress(project.tasks);
  const week = weekTotal(stats?.minutesByDay, now);
  const month = dailySeries(stats?.minutesByDay, now, CHART_DAYS).reduce((s, v) => s + v, 0);
  const commits = dailySeries(stats?.commitsByDay, now, CHART_DAYS).reduce((s, v) => s + v, 0);
  const deadline = deadlineInfo(project.deadline, now, project.status);
  const notice = boardStatus(store).notice;
  const writer = useProjectSave(store);
  const note = useMeetingNote(store);
  const creatingNote = note.creating === project.id;
  const del = useDeleteProject(store, onDeleted, {
    onStart: () => (leaving.current = true),
    onFail: () => (leaving.current = false),
  });

  // Arriving from the board or a link: start reading at the top, with focus on this project. A card
  // menu's Add task arrives on the New task field instead.
  useEffect(() => {
    if (startAt === "tasks" && rootRef.current?.querySelector("[data-part=new-task]")) {
      focusIn(rootRef.current, "[data-part=new-task]");
      return;
    }
    heroRef.current?.focus({ preventScroll: true });
    // Only on arrival; startAt is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  /** Saves a change; the caller shows a failure (inline fields keep their text and say why). */
  const save = (patch: ProjectPatch) => writer.save(project.id, patch);
  /** Saves a change and reports a failure as a toast, for controls with no room for an inline error. */
  const saveOrToast = (patch: ProjectPatch, what: string) => writer.saveOrToast(project.id, patch, what);

  const setStatus = (status: ProjectStatus) => {
    if (status !== project.status) void saveOrToast({ status }, "status").catch(() => undefined);
  };
  const setArea = (area: ProjectArea) => {
    if (area !== project.area) void saveOrToast({ area }, "area").catch(() => undefined);
  };

  const newMeetingNote = () => note.start(project);
  const notesReady = note.ready;
  const noteTip = note.tip;

  // The page's section. Rows with their own section (a task, goal, note or source) and the delete
  // dialog keep it out, so their menus stay short.
  const menu = useTargetMenuRegion((target) => {
    if (target?.closest(`dialog, [${ROW_MENU}]`)) return null;
    return {
      title: project.name,
      items: [
        {
          label: "Add task",
          icon: <PlusIcon />,
          tip: "Moves to the New task field, ready to type the next step.",
          onSelect: () => focusIn(rootRef.current, "[data-part=new-task]"),
        },
        {
          label: "Add goal",
          icon: <PlusIcon />,
          tip: "Moves to the New goal field, ready to write what done looks like.",
          disabled: project.goals.length >= LIMITS.goals ? GOALS_FULL_TIP : false,
          onSelect: () => focusIn(rootRef.current, "[data-part=new-goal]"),
        },
        {
          label: "New meeting note",
          icon: <NoteIcon />,
          tip: noteTip,
          disabled: meetingNoteOff(note),
          onSelect: () => void newMeetingNote(),
        },
        ...moveTargets(project.status).map((s) => ({ label: moveLabel(s), tip: MOVE_TIP[s], onSelect: () => setStatus(s) })),
        {
          label: "Delete project",
          icon: <TrashIcon />,
          danger: true,
          tip: "Asks first, then deletes the project; its sources go back to Untracked.",
          onSelect: () => del.ask(project),
        },
      ],
    };
  });

  return (
    <div ref={rootRef} className={`${styles.detail} ${styles.wide}`} {...menu}>
      <BackLink />
      {notice ? (
        <p className={styles.notice}>
          <StatusDot tone="warn" size={9} glow={false} />
          <span>{notice}</span>
        </p>
      ) : null}

      <motion.section
        ref={heroRef}
        layoutId={morph ? cardLayoutId(project.id) : undefined}
        initial={morph ? undefined : { opacity: 0, y: 8 }}
        animate={morph ? undefined : { opacity: 1, y: 0 }}
        transition={{ duration: MOTION.base, ease: MOTION.easeOut, layout: { duration: MOTION.slow, ease: MOTION.easeOut } }}
        className={styles.hero}
        style={{ borderRadius: PANEL_RADIUS }}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-status={project.status}
      >
        <motion.div
          className={styles.heroInner}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: MOTION.base, delay: MOTION.fast, ease: MOTION.easeOut }}
        >
          <div className={styles.heroTop}>
            <div className={styles.heroChips}>
              <AreaChip area={project.area} />
              <span className={styles.statusChip} data-status={project.status}>
                {STATUS_LABEL[project.status]}
              </span>
              {deadline ? <DueBadge label={deadline.label} tone={deadline.tone} /> : null}
            </div>
            <div className={styles.heroActions}>
              <Button
                size="sm"
                icon={<NoteIcon />}
                onClick={() => void newMeetingNote()}
                loading={creatingNote}
                loadingLabel="Starting note"
                disabled={!notesReady}
                tip={noteTip}
              >
                New meeting note
              </Button>
              <Button
                size="sm"
                icon={<TrashIcon />}
                className={partStyles.danger}
                onClick={() => del.ask(project)}
                tip="Asks first, then deletes the project; its sources go back to Untracked."
              >
                Delete
              </Button>
            </div>
          </div>

          <div className={styles.titleRow}>
            <InlineText
              as="h2"
              id={titleId}
              value={project.name}
              label="Project name"
              editLabel="Rename project"
              maxLength={LIMITS.name}
              requiredMessage="A project needs a name."
              className={styles.title}
              tip="Renames the project; Enter saves, Esc cancels."
              onSave={(name) => save({ name })}
            />
          </div>
          <div className={styles.description}>
            <InlineText
              as="p"
              value={project.description}
              label="Description"
              editLabel={project.description ? "Edit description" : "Add a description"}
              emptyText="No description yet. Say what this project is for."
              maxLength={LIMITS.description}
              multiline
              className={styles.descriptionText}
              tip={
                project.description
                  ? "Edits the description; Ctrl+Enter saves, Esc cancels."
                  : "Adds a line on what this project is for; Ctrl+Enter saves, Esc cancels."
              }
              onSave={(description) => save({ description })}
            />
          </div>

          <div className={styles.controls}>
            <div className={styles.control}>
              <span className={styles.controlLabel} aria-hidden="true">
                Status
              </span>
              <Segmented
                label="Status"
                options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s], tip: MOVE_TIP[s] }))}
                value={project.status}
                onChange={setStatus}
              />
            </div>
            <div className={styles.control}>
              <span className={styles.controlLabel} aria-hidden="true">
                Area
              </span>
              <Segmented
                label="Area"
                options={AREA_ORDER.map((a) => ({
                  value: a,
                  label: AREA_LABEL[a],
                  tip: `Moves the project to ${AREA_LABEL[a]}, for the board's Area filter and the life map.`,
                }))}
                value={project.area}
                onChange={setArea}
              />
            </div>
            <div className={styles.control}>
              <span className={styles.controlLabel} aria-hidden="true">
                Deadline
              </span>
              <DeadlineField deadline={project.deadline} onSave={(deadline) => saveOrToast({ deadline }, "deadline")} />
            </div>
          </div>

          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>Tasks</dt>
              <dd className={styles.statValue}>
                <CountUp value={progress.done} />
                <span className={styles.statOf}> / {progress.total}</span>
              </dd>
              <dd className={styles.statBar}>
                <ProgressBar fraction={progress.fraction} label={`Tasks: ${progress.label}`} />
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>This week</dt>
              <dd className={styles.statValue}>
                <CountUp value={week} format={formatMinutes} />
              </dd>
              <dd className={styles.statSub}>Claude Code time</dd>
            </div>
            <div className={styles.stat}>
              <dt>Last {CHART_DAYS} days</dt>
              <dd className={styles.statValue}>
                <CountUp value={month} format={formatMinutes} />
              </dd>
              <dd className={styles.statSub}>{plural(commits, "commit")}</dd>
            </div>
            <div className={styles.stat}>
              <dt>Notes</dt>
              <dd className={styles.statValue}>
                <CountUp value={linked?.length ?? stats?.noteCount ?? 0} />
              </dd>
              <dd className={styles.statSub} data-strong={openActions ? true : undefined}>
                {openActions === null ? "Notes not available" : openActions > 0 ? plural(openActions, "open action") : "No open actions"}
              </dd>
            </div>
          </dl>
        </motion.div>
      </motion.section>

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel
            title="Tasks"
            state="ok"
            meta={`${project.tasks.filter((t) => !t.done).length} open`}
            className={styles.tasksPanel}
            bodyClassName={styles.scrollBody}
          >
            <TaskList project={project} store={store} now={now} />
          </Panel>
          <Panel
            title="Goals"
            state="ok"
            meta={`${project.goals.length} of ${LIMITS.goals}`}
            className={styles.goalsPanel}
            bodyClassName={styles.scrollBody}
          >
            <Goals project={project} onSave={(goals) => save({ goals })} />
          </Panel>
        </div>
        <div className={styles.side}>
          <Panel title="Time" state="ok" meta={`Last ${CHART_DAYS} days`}>
            <TimeChart name={project.name} minutesByDay={stats?.minutesByDay} commitsByDay={stats?.commitsByDay} now={now} />
            {project.sources.sessions.length + project.sources.repos.length === 0 ? (
              <p className={styles.timeHint}>Add a source below so time and commits count here.</p>
            ) : null}
          </Panel>
          <Panel
            title="Notes"
            {...notesPanelStatus(store.notes, () => void store.reloadNotes())}
            meta={linked ? String(linked.length) : undefined}
            action={
              notesReady ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<PlusIcon />}
                  onClick={() => void newMeetingNote()}
                  loading={creatingNote}
                  loadingLabel="Starting"
                  tip={noteTip}
                >
                  Meeting note
                </Button>
              ) : undefined
            }
          >
            <LinkedNotes notes={linked ?? []} />
          </Panel>
          <Panel title="Sources" state="ok" meta={String(project.sources.sessions.length + project.sources.repos.length)}>
            <Sources project={project} store={store} />
          </Panel>
        </div>
      </div>

      <DeleteProjectDialog
        open={del.open}
        project={project}
        noteCount={linked ? linked.length : null}
        busy={del.busy}
        error={del.error}
        onCancel={del.cancel}
        onConfirm={() => void del.confirm()}
      />
    </div>
  );
}

function notesPanelStatus(notes: NotesState, retry: () => void): PanelStatus {
  switch (notes.status) {
    case "loading":
      return { state: "loading" };
    case "failed":
      return { state: "error", message: "Couldn't load notes.", hint: notes.message, onRetry: retry };
    case "not_connected":
      return { state: "not_connected", message: notes.message ?? "Set NOTES_DIR in .env to your notes folder." };
    case "error":
      return { state: "error", message: "The notes folder couldn't be read.", hint: notes.message, onRetry: retry };
    case "never_run":
      return { state: "empty", message: "Notes are not read yet.", hint: "They load on the next refresh." };
    default:
      return { state: "ok" };
  }
}

/** The deadline as a date field: picking or typing a date saves when you leave the field or press Enter. */
function DeadlineField({ deadline, onSave }: { deadline: string | null; onSave: (next: string | null) => Promise<unknown> }) {
  const [draft, setDraft] = useState(deadline ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow changes made elsewhere while the field is not being edited.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(deadline ?? "");
  }, [deadline]);

  const commit = async (value: string) => {
    const next = value === "" ? null : value;
    if (next === deadline) return;
    if (next !== null && !parseDayKey(next)) {
      setError("Pick a real date, or clear the deadline.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      setDraft(deadline ?? "");
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className={styles.deadline}>
      <input
        ref={inputRef}
        type="date"
        className={partStyles.input}
        aria-label="Deadline. Saves when you leave the field."
        data-tip="Saves when you leave the field; Needs you flags Active projects 3 days before."
        value={draft}
        readOnly={saving}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onBlur={(e) => void commit(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit(e.currentTarget.value);
          }
        }}
      />
      {deadline ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<CloseIcon />}
          aria-label="Clear the deadline"
          tip={saving ? "Works again once the deadline finishes saving." : "Removes the deadline; its countdown leaves the card and Needs you."}
          onClick={() => {
            setDraft("");
            // The clear button goes away with the deadline; keep focus on the field.
            inputRef.current?.focus();
            void commit("");
          }}
          disabled={saving}
        />
      ) : null}
      {error ? (
        <span className={partStyles.fieldError} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function Goals({ project, onSave }: { project: Project; onSave: (goals: string[]) => Promise<unknown> }) {
  const uid = useId().replace(/:/g, "");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const goals = project.goals;
  const full = goals.length >= LIMITS.goals;
  const fullTip = GOALS_FULL_TIP;

  /** Removes goal `i` right away (no undo), keeping keyboard focus in the list when its row held it. */
  const remove = (i: number, row: Element | null) => {
    setError(null);
    const next = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>("[data-part=remove-goal]");
    handOffFocus(row, next ?? inputRef.current);
    void onSave(goals.filter((_, j) => j !== i)).catch((err) => setError(`Couldn't remove the goal. ${errorMessage(err)}`));
  };

  const add = async () => {
    const value = draft.trim();
    if (value === "") {
      setError("Type the goal first.");
      return;
    }
    if ([...value].length > LIMITS.goal) {
      setError(`Keep a goal to ${LIMITS.goal} characters or fewer (now ${[...value].length}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave([...goals, value]);
      setDraft("");
      // At the limit the field turns off; hand focus to the list instead of losing it.
      if (goals.length + 1 >= LIMITS.goals) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-part=remove-goal]")?.focus());
      else inputRef.current?.focus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.goals}>
      {goals.length === 0 ? (
        <EmptyState size="inline" title="No goals yet." body="Write what done looks like, one goal at a time." />
      ) : (
        <ol className={styles.goalList}>
          {goals.map((g, i) => (
            <GoalItem
              key={`${i}-${g}`}
              goal={g}
              index={i}
              onSaveText={(next) => onSave(goals.map((x, j) => (j === i ? next : x)))}
              onRemove={(row) => remove(i, row)}
            />
          ))}
        </ol>
      )}
      <form
        className={styles.goalAdd}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="sr-only" htmlFor={`goal-${uid}`}>
          New goal
        </label>
        <input
          ref={inputRef}
          id={`goal-${uid}`}
          data-part="new-goal"
          className={partStyles.input}
          value={draft}
          dir="auto"
          disabled={full}
          readOnly={busy}
          placeholder={full ? `${LIMITS.goals} goals is the limit` : "Add a goal and press Enter"}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `goal-${uid}-error` : undefined}
          data-tip={full ? fullTip : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
        />
        <Button
          type="submit"
          size="sm"
          icon={<PlusIcon />}
          disabled={full}
          loading={busy}
          loadingLabel="Adding"
          tip={full ? fullTip : "Adds the goal to the end of the list; Enter in the field does the same."}
        >
          Add goal
        </Button>
        {error ? (
          <p id={`goal-${uid}-error`} className={partStyles.fieldError} role="alert">
            <StatusDot tone="danger" size={9} glow={false} />
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}

const EDIT_GOAL_TIP = "Edits this goal; Enter saves, Esc cancels.";
const REMOVE_GOAL_TIP = "Deletes this goal right away; there is no undo.";

/** One goal: its text edits in place; right-click offers Edit goal and Remove goal. */
function GoalItem({
  goal,
  index,
  onSaveText,
  onRemove,
}: {
  goal: string;
  index: number;
  onSaveText: (next: string) => Promise<unknown>;
  onRemove: (row: Element | null) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const menu = useMenuRegion(() => ({
    title: goal,
    items: [
      { label: "Edit goal", icon: <PencilIcon />, tip: EDIT_GOAL_TIP, onSelect: () => clickIn(rowRef.current, "[data-part=edit-text]") },
      { label: "Remove goal", icon: <TrashIcon />, danger: true, tip: REMOVE_GOAL_TIP, onSelect: () => onRemove(rowRef.current) },
    ],
  }));
  return (
    <li ref={rowRef} className={styles.goal} data-row-menu="" {...menu}>
      <span className={styles.goalIndex} aria-hidden="true">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className={styles.goalText}>
        <InlineText
          value={goal}
          label={`Goal ${index + 1}`}
          editLabel={`Edit goal ${index + 1}`}
          maxLength={LIMITS.goal}
          requiredMessage="A goal needs some text. Remove it instead if it is not needed."
          quietButton
          tip={EDIT_GOAL_TIP}
          onSave={onSaveText}
        />
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon={<CloseIcon />}
        className={styles.goalRemove}
        aria-label={`Remove goal ${index + 1}: ${goal}`}
        tip={REMOVE_GOAL_TIP}
        data-part="remove-goal"
        onClick={(e) => onRemove(e.currentTarget.closest("li"))}
      />
    </li>
  );
}

/** One linked note: a link to it in Notes; right-click offers Open note. */
function NoteItem({ note }: { note: NoteMeta }) {
  const menu = useMenuRegion(() => ({
    title: note.title || displayName(note.path),
    items: [
      {
        label: "Open note",
        icon: <NoteIcon />,
        tip: "Opens this note in Notes to read or edit it.",
        onSelect: () => (window.location.hash = noteHash(note.path)),
      },
    ],
  }));
  return (
    <li className={styles.note} data-row-menu="" {...menu}>
      <a href={noteHash(note.path)} className={styles.noteLink} dir="auto" data-tip="Opens this note in Notes to read or edit it.">
        {note.title || displayName(note.path)}
      </a>
      <span className={styles.noteMeta}>
        <span dir="auto">{note.section}</span>
        <span aria-hidden="true">·</span>
        <span>{relativeTime(note.updated, new Date())}</span>
        {note.openActions > 0 ? (
          <span className={styles.noteActions}>
            <span className={styles.noteActionsMark} aria-hidden="true" />
            {plural(note.openActions, "open action")}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function LinkedNotes({ notes }: { notes: NoteMeta[] }) {
  if (notes.length === 0) {
    return (
      <EmptyState
        size="inline"
        title="No linked notes yet."
        body="Start a meeting note here, or link any note to this project from Notes."
      />
    );
  }
  return (
    <ul className={styles.notes}>
      {notes.slice(0, 12).map((n) => (
        <NoteItem key={n.path} note={n} />
      ))}
      {notes.length > 12 ? (
        <li className={styles.noteMore}>
          <a href={noteHash()} data-tip="Opens the Notes view, where every note in your vault is listed.">
            {plural(notes.length - 12, "more note")} in Notes
          </a>
        </li>
      ) : null}
    </ul>
  );
}

const REMOVE_SOURCE_TIP = "Moves this source back to Untracked so it stops counting here; Undo is offered.";

/** One source: a session or repo counting toward the project; right-click offers Move to Untracked. */
function SourceItem({ kind, name, onRemove }: { kind: DetectedProject["kind"]; name: string; onRemove: () => void }) {
  const rowRef = useRef<HTMLLIElement>(null);
  /** The row is about to leave: when it holds focus, move it to the next Remove button or Add source. */
  const remove = () => {
    const row = rowRef.current;
    const box = row?.closest("[data-sources]");
    const others = [...(box?.querySelectorAll<HTMLElement>("[data-part=remove-source]") ?? [])].filter((b) => !row?.contains(b));
    handOffFocus(row, others[0] ?? box?.querySelector<HTMLElement>("[aria-haspopup=listbox]"));
    onRemove();
  };
  const menu = useMenuRegion(() => ({
    title: displayName(name),
    items: [{ label: "Move to Untracked", tip: REMOVE_SOURCE_TIP, onSelect: remove }],
  }));
  return (
    <li ref={rowRef} className={styles.source} data-row-menu="" {...menu}>
      <KindIcon kind={kind} />
      <span className={styles.sourceName} dir="auto" title={name}>
        {name}
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon={<CloseIcon />}
        className={styles.sourceRemove}
        aria-label={`Remove ${name} from this project`}
        tip={REMOVE_SOURCE_TIP}
        data-part="remove-source"
        onClick={remove}
      />
    </li>
  );
}

function Sources({ project, store }: { project: Project; store: ProjectsStore }) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const untracked = store.state?.untracked ?? [];

  const change = async (next: Project["sources"], optimisticUntracked: (u: DetectedProject[]) => DetectedProject[]) => {
    await store.write(
      () => projectsApi.update(project.id, { sources: next }),
      (s) => ({ ...patchProject(s, project.id, { sources: next }), untracked: optimisticUntracked(s.untracked) }),
    );
  };

  const add = async (d: Pick<DetectedProject, "name" | "kind">) => {
    setBusy(true);
    try {
      await change(withSource(project.sources, d), (u) => u.filter((x) => !(x.name === d.name && x.kind === d.kind)));
      toasts.push({ tone: "success", message: `Added ${displayName(d.name)}. Its time and commits count here now.` });
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't add ${displayName(d.name)}. ${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: DetectedProject["kind"], name: string) => {
    try {
      await change(withoutSource(project.sources, kind, name), (u) => u);
      toasts.push({
        message: `Moved ${displayName(name)} to Untracked.`,
        action: { label: "Undo", onAction: () => void add({ name, kind }) },
      });
    } catch (err) {
      toasts.push({ tone: "error", message: `Couldn't remove ${displayName(name)}. ${errorMessage(err)}` });
    }
  };

  const groups: { kind: DetectedProject["kind"]; title: string; names: string[] }[] = [
    { kind: "session", title: "Claude sessions", names: project.sources.sessions },
    { kind: "repo", title: "GitHub repos", names: project.sources.repos },
  ];
  const total = project.sources.sessions.length + project.sources.repos.length;

  return (
    <div className={styles.sources} data-sources>
      {total === 0 ? (
        <EmptyState size="inline" title="No sources yet." body="Add a Claude session or a GitHub repo so its time and commits count here." />
      ) : (
        groups
          .filter((g) => g.names.length > 0)
          .map((g) => (
            <div key={g.kind} className={styles.sourceGroup}>
              <h3 className={partStyles.kicker}>{g.title}</h3>
              <ul className={styles.sourceList}>
                {g.names.map((name) => (
                  <SourceItem key={name} kind={g.kind} name={name} onRemove={() => void remove(g.kind, name)} />
                ))}
              </ul>
            </div>
          ))
      )}
      <Picker
        label="Add source"
        icon={<PlusIcon />}
        searchLabel="Find a session or repo"
        tip="Adds an untracked session or repo, so its time and commits count here."
        loading={busy}
        options={untracked.map((d) => ({
          value: `${d.kind}:${d.name}`,
          label: displayName(d.name),
          detail: `${d.kind === "session" ? "Claude session" : "GitHub repo"}. ${detectedFacts(d)}`,
          icon: d.kind === "session" ? <SessionIcon /> : <RepoIcon />,
        }))}
        empty="Nothing untracked to add. Every active session and repo is already in a project or hidden."
        onPick={(value) => {
          const d = untracked.find((x) => `${x.kind}:${x.name}` === value);
          if (d) void add(d);
        }}
      />
    </div>
  );
}
