import type { ReactNode } from "react";
import { StatusDot, type StatusTone } from "./StatusDot";
import styles from "./EmptyState.module.css";

// A text-only message for a panel with nothing to show, or a state that needs a next step.
// Pattern: what this is or why it is empty, then how to fill it, then at most one action.
// Many of these can sit on one screen, so no illustrations.

export interface EmptyStateProps {
  /** One short line, e.g. "Nothing urgent. Clear runway." */
  title: string;
  /** Optional second line: why it is empty, or what to do. */
  body?: ReactNode;
  /** At most one action (a Button or ButtonLink). */
  action?: ReactNode;
  /** Leading glyph. Default none; "ok" suits a calm all-clear, "off" a not-connected source. */
  tone?: StatusTone;
  /** "inline" for tight spaces (a tile), "block" (default) for a panel body. */
  size?: "inline" | "block";
}

export function EmptyState({ title, body, action, tone, size = "block" }: EmptyStateProps) {
  return (
    <div className={[styles.empty, styles[size]].join(" ")}>
      <p className={styles.title}>
        {tone ? <StatusDot tone={tone} size={9} className={styles.dot} /> : null}
        <span>{title}</span>
      </p>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
