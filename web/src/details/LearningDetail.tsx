import { motion } from "motion/react";
import type { LearningState } from "../../../shared/types";
import type { DetailProps } from "../context/DetailContext";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { currentStepIndex, parseDay } from "../lib/detailRows";
import { plural } from "../lib/format";
import { streakSummary } from "../lib/kpis";
import { CountUp } from "../ui/CountUp";
import { Panel, panelFromSource } from "../ui/Panel";
import { StatusDot } from "../ui/StatusDot";
import { Stagger, StaggerItem } from "./WorkDetail";
import styles from "./LearningDetail.module.css";

// Learning explore view: the current concept with its cycle as a progress stepper, the streak against
// the best, and the Life agenda as a read-only checklist. All from the learning source: Daily.md (its
// streak line, "Current cycle" section and "Life Agenda" table); nothing here is editable.

const dayLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M3.5 8.4 6.6 11.3 12.5 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ stepper */

// Horizontal on wide screens, vertical on phones (CSS). The connector after a done step fills in,
// one segment after another, so the progress reads left to right.
function Stepper({ steps }: { steps: NonNullable<LearningState["cycle"]>["steps"] }) {
  const reduced = useReducedMotion();
  const current = currentStepIndex(steps);

  return (
    <div className={styles.stepper}>
      <ol className={styles.steps} style={{ ["--steps" as string]: steps.length }}>
        {steps.map((step, i) => {
          const state = step.done ? "done" : i === current ? "current" : "todo";
          return (
            <li
              key={`${i}-${step.label}`}
              className={cx(styles.step, styles[state])}
              style={{ ["--i" as string]: i }}
              aria-current={state === "current" ? "step" : undefined}
            >
              <motion.span
                className={styles.node}
                initial={reduced ? false : { scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: MOTION.base, delay: reduced ? 0 : 0.1 + i * MOTION.stagger, ease: MOTION.easeOut }}
              >
                {state === "done" ? <CheckGlyph /> : <span className={cx(styles.nodeNum, "num")}>{i + 1}</span>}
                {state === "current" && !reduced ? (
                  <motion.span
                    className={styles.nodeRing}
                    initial={{ scale: 1, opacity: 0.8 }}
                    animate={{ scale: 1.9, opacity: 0 }}
                    transition={{ duration: 1, delay: MOTION.draw, ease: MOTION.easeOut }}
                  />
                ) : null}
              </motion.span>
              <span className={styles.stepLabel}>
                <span className="sr-only">{state === "done" ? "Done: " : state === "current" ? "Current step: " : "To do: "}</span>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ streak */

function Streak({ streak }: { streak: LearningState["streak"] }) {
  const reduced = useReducedMotion();
  // Same rules as the Learning tile: a 1-day streak tying a best of 1 is not called a record.
  const { current, best, isBest } = streakSummary(streak);
  const { started } = streak;
  const scale = Math.max(best, current, 1);
  const startDate = started ? parseDay(started) : null;
  const startText = startDate && !Number.isNaN(startDate.getTime()) ? dayLabel.format(startDate) : started;

  return (
    <div className={styles.streak}>
      <p className={styles.streakHero}>
        <CountUp value={current} className={styles.streakNum} />
        <span className={styles.streakUnit}>{current === 1 ? "day" : "days"} in a row</span>
      </p>
      <div
        className={styles.bullet}
        role="img"
        aria-label={`Current streak ${plural(current, "day")}, best ${plural(best, "day")}`}
      >
        <motion.span
          className={cx(styles.bulletFill, isBest && styles.bulletBestFill)}
          initial={reduced ? false : { width: 0 }}
          animate={{ width: `${(current / scale) * 100}%` }}
          transition={{ duration: MOTION.draw, ease: MOTION.easeOut, delay: reduced ? 0 : 0.1 }}
        />
        {best > 0 ? <span className={styles.bulletBest} style={{ left: `${(best / scale) * 100}%` }} /> : null}
      </div>
      <dl className={styles.streakFacts}>
        <div>
          <dt>Best</dt>
          <dd className="num">{plural(best, "day")}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd className="num">{current > 0 && startText ? startText : "Not running"}</dd>
        </div>
      </dl>
      {isBest ? (
        <p className={styles.badge}>
          <StatusDot tone="ok" size={9} pulse />
          Your best streak so far
        </p>
      ) : current === 0 ? (
        <p className={styles.streakHint}>Finish today's step to start a new streak.</p>
      ) : (
        <p className={styles.streakHint}>{plural(best - current + 1, "more day")} to beat your best.</p>
      )}
      {current > 0 ? (
        <p className={styles.streakSource}>
          As recorded in Daily.md. The file has no last-studied date, so this can't tell whether the streak is still alive.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ agenda */

function Agenda({ items }: { items: LearningState["agendaThisMonth"] }) {
  const reduced = useReducedMotion();
  const done = items.filter((i) => i.done).length;
  return (
    <div className={styles.agenda}>
      <div className={styles.agendaHead}>
        <p className={styles.agendaCount}>
          <CountUp value={done} className={styles.agendaNum} />
          <span>of {plural(items.length, "item")} done</span>
        </p>
        <div className={styles.progress} role="img" aria-label={`${done} of ${items.length} agenda items done`}>
          <motion.span
            className={styles.progressFill}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${items.length > 0 ? (done / items.length) * 100 : 0}%` }}
            transition={{ duration: MOTION.draw, ease: MOTION.easeOut }}
          />
        </div>
      </div>
      <Stagger as="ul" className={styles.checklist}>
        {items.map((item, i) => (
          <StaggerItem as="li" key={`${i}-${item.text}`} className={cx(styles.checkItem, item.done && styles.checkDone)}>
            <span className={styles.box} aria-hidden="true">
              {item.done ? <CheckGlyph /> : null}
            </span>
            <span className={styles.checkText}>
              <span className="sr-only">{item.done ? "Done: " : "Not done: "}</span>
              {item.text}
            </span>
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}

/* -------------------------------------------------------------------- view */

export function LearningDetail(_props: DetailProps) {
  const snap = useSnapshot();
  const learning = snap.data?.learning;

  const cycleStatus = panelFromSource(snap, "learning", {
    isEmpty: (s) => s.learning.cycle === null || s.learning.cycle.steps.length === 0,
    empty: "No learning cycle in progress.",
    emptyHint: 'Add a "Current cycle" section with a "Concept:" line and step checkboxes to Daily.md in your Learning folder.',
  });
  // A streak of 0 is real data once the source has read Daily.md at least once; before that, say so.
  const streakStatus = panelFromSource(snap, "learning", {
    isEmpty: (s) => s.sources.learning.updatedAt === null,
    empty: "No streak data yet.",
    emptyHint: 'The streak comes from the "Current" and "Best" line in Daily.md in your Learning folder.',
  });
  // The list is the "Life Agenda" table in Daily.md (server/collectors/learning.ts), not a monthly file.
  const agendaStatus = panelFromSource(snap, "learning", {
    isEmpty: (s) => s.learning.agendaThisMonth.length === 0,
    empty: "No Life agenda items found.",
    emptyHint: 'Add rows to the "Life Agenda" table in Daily.md in your Learning folder. Start each row with [ ] for open or [x] for done.',
  });

  const cycle = learning?.cycle ?? null;
  const stepsDone = cycle ? cycle.steps.filter((s) => s.done).length : 0;

  return (
    <Stagger className={styles.grid}>
      <StaggerItem className={styles.cycleCell}>
        <Panel
          title="Current cycle"
          {...cycleStatus}
          meta={cycle && cycle.steps.length > 0 ? `${stepsDone} of ${cycle.steps.length} steps` : undefined}
          skeleton="rows"
        >
          {cycle ? (
            <div className={styles.cycle}>
              <div>
                <p className={styles.kicker}>Concept</p>
                <p className={styles.concept}>{cycle.concept || "Untitled concept"}</p>
              </div>
              <Stepper steps={cycle.steps} />
            </div>
          ) : null}
        </Panel>
      </StaggerItem>
      <StaggerItem className={styles.streakCell}>
        <Panel title="Streak" {...streakStatus} skeleton="rows">
          {learning ? <Streak streak={learning.streak} /> : null}
        </Panel>
      </StaggerItem>
      <StaggerItem className={styles.agendaCell}>
        <Panel title="Life agenda" {...agendaStatus} skeleton="rows">
          {learning ? <Agenda items={learning.agendaThisMonth} /> : null}
        </Panel>
      </StaggerItem>
    </Stagger>
  );
}
