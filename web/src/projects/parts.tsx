import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import type { DetectedProject, ProjectArea } from "../../../shared/types";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { AREA_LABEL, type DeadlineTone } from "../lib/projects";
import { FlagIcon, RepoIcon, SessionIcon } from "./icons";
import styles from "./parts.module.css";

export { styles as partStyles };

/** "WORK" with the area's dot. */
export function AreaChip({ area, className }: { area: ProjectArea; className?: string }) {
  return (
    <span className={[styles.area, className].filter(Boolean).join(" ")} data-area={area}>
      {AREA_LABEL[area]}
    </span>
  );
}

function ToneGlyph({ tone }: { tone: DeadlineTone }) {
  if (tone === "danger") {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M6 0.6 L11.4 6 L6 11.4 L0.6 6 Z" fill="currentColor" />
      </svg>
    );
  }
  if (tone === "warn") {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M6 1.2 L11 10.4 H1 Z" fill="currentColor" />
      </svg>
    );
  }
  return <FlagIcon />;
}

/** A deadline or due-date countdown. Red diamond under 3 days, amber triangle this week, flag otherwise. */
export function DueBadge({ label, tone, className }: { label: string; tone: DeadlineTone; className?: string }) {
  return (
    <span className={[styles.due, className].filter(Boolean).join(" ")} data-tone={tone}>
      <span className={styles.dueIcon}>
        <ToneGlyph tone={tone} />
      </span>
      <span>{label}</span>
    </span>
  );
}

/** Thin progress track; the fill grows in on first render and glides when the fraction changes. */
export function ProgressBar({ fraction, label, delay = 0 }: { fraction: number; label: string; delay?: number }) {
  const reduced = useReducedMotion();
  const first = useRef(true);
  useEffect(() => {
    first.current = false;
  }, []);
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <div
      className={styles.progress}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(f * 100)}
    >
      <motion.span
        className={styles.progressFill}
        data-complete={f >= 1 || undefined}
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: f }}
        transition={
          first.current
            ? { duration: MOTION.draw, delay: reduced ? 0 : delay, ease: MOTION.easeOut }
            : { duration: MOTION.slow, ease: MOTION.easeOut }
        }
      />
    </div>
  );
}

/**
 * Before an action removes a row that holds focus (a ticked task moving to Done, a deleted task, a
 * tracked name leaving the tray), move focus to `target` so keyboard users keep their place.
 * Does nothing when focus is elsewhere.
 */
export function handOffFocus(leaving: Element | null | undefined, target: HTMLElement | null | undefined): void {
  const active = document.activeElement;
  if (!leaving || !active || !leaving.contains(active)) return;
  target?.focus({ preventScroll: true });
}

/** After a row moved (a task reopened from Done), focus the control that replaced it once it is drawn. */
export function focusWhenReady(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    find()?.focus({ preventScroll: true });
  });
}

/** Session or repo glyph, with the kind spelled out for screen readers. */
export function KindIcon({ kind }: { kind: DetectedProject["kind"] }) {
  return (
    <span className={styles.kindIcon} title={kind === "session" ? "Claude session" : "GitHub repo"}>
      {kind === "session" ? <SessionIcon /> : <RepoIcon />}
      <span className="sr-only">{kind === "session" ? "Claude session" : "GitHub repo"}</span>
    </span>
  );
}
