import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useState } from "react";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { formatMinutes, plural, relativeTime } from "../lib/format";
import {
  AREA_FILTERS,
  AREA_LABEL,
  areaCounts,
  boardSummary,
  buildCards,
  cardDescription,
  groupCards,
  type AreaFilter,
  type ProjectCardModel,
  type StatusGroup,
} from "../lib/projects";
import { projectHash } from "../lib/route";
import { Segmented, useStoredChoice } from "../panels/ProjectTimeBars";
import { Button } from "../ui/Button";
import { CountUp } from "../ui/CountUp";
import { EmptyState } from "../ui/EmptyState";
import { Panel, type PanelStatus } from "../ui/Panel";
import { Sparkline } from "../ui/Sparkline";
import { ChevronIcon, NoteIcon, PlusIcon } from "./icons";
import { AreaChip, DueBadge, ProgressBar } from "./parts";
import type { ProjectsStore } from "./useProjects";
import styles from "./Board.module.css";

// The board: what is slipping and where the week went, by project. A readout row (active, due this
// week, open tasks, time this week), an area filter, then the projects grouped by status (Active,
// Paused, Ideas, and Done collapsed). Each card is one link to the project, and morphs into it.
// Ultrawide (>=1920px): the readout and the filter share one row and the status groups become lanes
// side by side, each scrolling inside itself; empty and folded lanes stay narrow.

const NEW_PROJECT_TIP = "Opens a short form for a new project: name, area, status, deadline and sources.";

/** Card corner radius as a number so the shared-layout morph can correct it (same as --radius-md). */
export const CARD_RADIUS = 10;

/** layoutId shared by a project's card and the top of its detail view. */
export const cardLayoutId = (id: string) => `project-card-${id}`;

export interface BoardProps {
  store: ProjectsStore;
  now: Date;
  onNewProject: () => void;
  /** A project to pulse once (just created or just left). */
  highlight: string | null;
}

export function boardStatus(store: ProjectsStore): PanelStatus {
  if (store.state) {
    if (store.fromSnapshot && store.problem) {
      return {
        state: "ok",
        notice: `Couldn't load the latest projects: ${store.problem.message} Showing the copy from the last refresh, and changes can't be saved yet.`,
      };
    }
    return { state: "ok" };
  }
  if (store.problem) {
    return {
      state: "error",
      message: "Couldn't load your projects.",
      hint: store.problem.message,
      onRetry: () => void store.reload(),
    };
  }
  return { state: "loading" };
}

export function Board({ store, now, onNewProject, highlight }: BoardProps) {
  const status = boardStatus(store);
  const count = store.state?.projects.length ?? 0;
  return (
    <Panel
      title="Projects"
      {...status}
      skeleton="cards"
      meta={store.state ? `${count} tracked` : undefined}
      className={styles.panel}
      bodyClassName={styles.panelBody}
      action={
        // With no projects the empty state carries the same button, so the header stays quiet.
        count > 0 ? (
          <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={onNewProject} tip={NEW_PROJECT_TIP}>
            New project
          </Button>
        ) : undefined
      }
    >
      {store.state ? <BoardBody store={store} now={now} onNewProject={onNewProject} highlight={highlight} /> : null}
    </Panel>
  );
}

function BoardBody({ store, now, onNewProject, highlight }: BoardProps) {
  const state = store.state!;
  const [area, setArea] = useStoredChoice<AreaFilter>("life-dashboard:projects-area", AREA_FILTERS, "all");
  const today = now.toDateString();
  const cards = useMemo(
    () => buildCards(state, store.notes.notes, now),
    // `today` stands in for `now`, which is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, store.notes.notes, today],
  );
  const counts = useMemo(() => areaCounts(state.projects), [state.projects]);
  const shownArea = area;
  const groups = useMemo(() => groupCards(cards, shownArea), [cards, shownArea]);
  const shownCards = groups.flatMap((g) => g.cards);
  const summary = boardSummary(shownCards);

  if (state.projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet."
        body={
          state.untracked.length > 0
            ? `Projects add up time, tasks and deadlines across your Claude sessions and GitHub repos. Track one of the ${plural(state.untracked.length, "detected name")} in Untracked, or start one from scratch.`
            : "Projects add up time, tasks and deadlines across your Claude sessions and GitHub repos. Start one from scratch."
        }
        action={
          <Button variant="primary" icon={<PlusIcon />} onClick={onNewProject} tip={NEW_PROJECT_TIP}>
            New project
          </Button>
        }
      />
    );
  }

  const options = AREA_FILTERS.map((value) => ({
    value,
    label: `${value === "all" ? "All" : AREA_LABEL[value]} ${counts[value]}`,
    tip:
      value === "all"
        ? "Shows projects in every area; this browser remembers the filter."
        : `Shows only ${AREA_LABEL[value]} projects; the counts follow, and this browser remembers it.`,
  }));

  return (
    <div className={styles.body}>
      <Readout summary={summary} />
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel} aria-hidden="true">
          Area
        </span>
        <Segmented label="Show projects in area" options={options} value={shownArea} onChange={setArea} />
      </div>
      <div className={styles.lanes}>
        {shownCards.length === 0 && shownArea !== "all" ? (
          <EmptyState
            title={`No ${AREA_LABEL[shownArea].toLowerCase()} projects yet.`}
            body={`Set a project's area to ${AREA_LABEL[shownArea]} on its page, or start a new one.`}
            action={
              <Button
                size="sm"
                tip="Clears the area filter so every project shows again."
                onClick={(e) => {
                  // This button goes away with the empty state: land on the All filter instead.
                  e.currentTarget.closest("section")?.querySelector<HTMLElement>('[role="group"] button')?.focus();
                  setArea("all");
                }}
              >
                Show all areas
              </Button>
            }
          />
        ) : (
          groups.map((g) => <Group key={g.status} group={g} highlight={highlight} anyShown={shownCards.length > 0} />)
        )}
      </div>
    </div>
  );
}

function Readout({ summary }: { summary: ReturnType<typeof boardSummary> }) {
  return (
    <dl className={styles.readout}>
      <div className={styles.cell}>
        <dt>Active</dt>
        <dd className={styles.value}>
          <CountUp value={summary.active} />
        </dd>
        <dd className={styles.sub}>{summary.active === 1 ? "project" : "projects"}</dd>
      </div>
      <div className={styles.cell} data-tone={summary.overdue > 0 ? "danger" : summary.dueSoon > 0 ? "warn" : undefined}>
        <dt>Due this week</dt>
        <dd className={styles.value}>
          <CountUp value={summary.dueSoon} />
        </dd>
        <dd className={styles.sub}>{summary.overdue > 0 ? `${summary.overdue} overdue` : "deadlines in 7 days"}</dd>
      </div>
      <div className={styles.cell}>
        <dt>Open tasks</dt>
        <dd className={styles.value}>
          <CountUp value={summary.openTasks} />
        </dd>
        <dd className={styles.sub}>in unfinished projects</dd>
      </div>
      <div className={styles.cell}>
        <dt>This week</dt>
        <dd className={styles.value}>
          <CountUp value={summary.weekMinutes} format={formatMinutes} />
        </dd>
        <dd className={styles.sub}>Claude Code time</dd>
      </div>
    </dl>
  );
}

const EMPTY_LINE: Record<StatusGroup["status"], string> = {
  active: "No active projects here. Set a project to Active on its page.",
  paused: "Nothing paused.",
  idea: "No ideas parked.",
  done: "Nothing finished yet.",
};

function Group({ group, highlight, anyShown }: { group: StatusGroup; highlight: string | null; anyShown: boolean }) {
  const headingId = `group-${useId().replace(/:/g, "")}`;
  const listId = `${headingId}-list`;
  const collapsible = group.status === "done";
  const [open, setOpen] = useState(false);
  const expanded = !collapsible || open;
  const n = group.cards.length;

  if (n === 0) {
    if (group.status !== "active" || !anyShown) {
      return (
        <section className={styles.groupEmpty} aria-labelledby={headingId}>
          <h3 id={headingId} className={styles.groupTitle}>
            {group.label} <span className={styles.groupCount}>0</span>
          </h3>
          <p className={styles.groupNone}>{EMPTY_LINE[group.status]}</p>
        </section>
      );
    }
  }

  return (
    <section
      className={styles.group}
      aria-labelledby={headingId}
      data-status={group.status}
      data-empty={n === 0 || undefined}
      data-folded={!expanded || undefined}
    >
      <h3 id={headingId} className={styles.groupTitle}>
        {collapsible ? (
          <button
            type="button"
            className={styles.groupToggle}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
            data-tip={expanded ? "Hides the finished projects again." : "Shows the projects you marked Done."}
          >
            <span className={styles.chevron} data-open={expanded || undefined}>
              <ChevronIcon />
            </span>
            {group.label} <span className={styles.groupCount}>{n}</span>
            <span className="sr-only">{expanded ? ", shown" : ", hidden"}</span>
          </button>
        ) : (
          <>
            {group.label} <span className={styles.groupCount}>{n}</span>
          </>
        )}
      </h3>
      {n === 0 ? (
        <p className={styles.groupNone}>{EMPTY_LINE[group.status]}</p>
      ) : expanded ? (
        <ul id={listId} className={styles.cards} data-scroller="">
          <AnimatePresence initial={false} mode="popLayout">
            {group.cards.map((card, i) => (
              <motion.li
                key={card.project.id}
                layout="position"
                className={styles.cardItem}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, transition: { duration: MOTION.fast } }}
                transition={{ duration: MOTION.base, ease: MOTION.easeOut, delay: Math.min(i, 10) * MOTION.stagger }}
              >
                <ProjectCard card={card} index={i} highlight={highlight === card.project.id} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : (
        <ul id={listId} className={styles.cards} hidden />
      )}
    </section>
  );
}

export function ProjectCard({ card, index, highlight }: { card: ProjectCardModel; index: number; highlight: boolean }) {
  const reduced = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const nameId = `card-${uid}-name`;
  const descId = `card-${uid}-desc`;
  const { project, deadline, progress, weekMinutes, series, openActions, lastNoteAt } = card;
  const hasTime = series.some((v) => v > 0);

  return (
    <motion.a
      href={projectHash(project.id)}
      layoutId={cardLayoutId(project.id)}
      transition={{ layout: { duration: MOTION.slow, ease: MOTION.easeOut } }}
      className={styles.card}
      style={{ borderRadius: CARD_RADIUS }}
      data-status={project.status}
      data-tone={deadline?.tone === "danger" ? "danger" : undefined}
      data-highlight={highlight || undefined}
      data-project-card={project.id}
      data-tip="Opens this project to edit its tasks, goals, deadline and sources."
      aria-labelledby={nameId}
      aria-describedby={descId}
    >
      <span className={styles.cardTop}>
        <AreaChip area={project.area} />
        {deadline ? <DueBadge label={deadline.label} tone={deadline.tone} /> : null}
      </span>
      <span id={nameId} className={styles.cardName} dir="auto">
        {project.name}
      </span>
      {project.description ? (
        <span className={styles.cardDesc} dir="auto">
          {project.description}
        </span>
      ) : null}
      <span className={styles.cardTasks}>
        <ProgressBar fraction={progress.fraction} label={`${project.name}: ${progress.label}`} delay={reduced ? 0 : index * MOTION.stagger} />
        <span className={styles.cardTaskText}>{progress.label}</span>
      </span>
      <span className={styles.cardTime}>
        <span className={styles.cardHours}>
          <CountUp value={weekMinutes} format={formatMinutes} flash={false} className={styles.cardHoursValue} />
          <span className={styles.cardHoursLabel}>this week</span>
        </span>
        <span className={styles.cardSpark} aria-hidden="true">
          {hasTime ? (
            <Sparkline values={series} label={`${project.name}: time per day, last 14 days`} height={28} />
          ) : (
            <span className={styles.cardFlat} />
          )}
        </span>
      </span>
      <span className={styles.cardFoot}>
        {openActions ? (
          <span className={styles.actions}>
            <span className={styles.actionsMark} aria-hidden="true" />
            {plural(openActions, "open action")}
          </span>
        ) : null}
        <span className={styles.lastNote}>
          <NoteIcon />
          {lastNoteAt ? `Note ${relativeTime(lastNoteAt, new Date())}` : "No notes yet"}
        </span>
      </span>
      <span id={descId} className="sr-only">
        {cardDescription(card)}
      </span>
    </motion.a>
  );
}
