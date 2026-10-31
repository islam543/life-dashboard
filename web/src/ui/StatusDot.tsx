import type { SourceStatus } from "../../../shared/types";
import styles from "./StatusDot.module.css";

// A small status glyph. Shape and color both carry the meaning, so it still reads in grayscale
// or for color-blind users. Always pair it with text (visible, or `label` for screen readers).
//
//   ok      cyan filled circle        healthy, up to date
//   warn    amber filled triangle     this week, stale
//   danger  red filled diamond        act today, failed
//   off     muted dashed ring         not connected
//   idle    muted hollow ring         not collected yet
//   ai      violet filled circle      AI content

export type StatusTone = "ok" | "warn" | "danger" | "off" | "idle" | "ai";

export interface StatusDotProps {
  tone: StatusTone;
  /** Glyph size in px (default 10). */
  size?: number;
  /** Accessible name. Leave empty when visible text next to the dot already says the same. */
  label?: string;
  /** Soft glow behind filled tones. Default true. */
  glow?: boolean;
  /** One expanding ring when it mounts (for "changed since last visit"). Never loops. */
  pulse?: boolean;
  className?: string;
}

const SOURCE_TONE: Record<SourceStatus, StatusTone> = {
  ok: "ok",
  stale: "warn",
  error: "danger",
  not_connected: "off",
  never_run: "idle",
};

export const toneForSource = (status: SourceStatus): StatusTone => SOURCE_TONE[status];

export const toneForUrgency = (urgency: "red" | "amber"): StatusTone => (urgency === "red" ? "danger" : "warn");

function Glyph({ tone }: { tone: StatusTone }) {
  switch (tone) {
    case "warn":
      return <path d="M6 1.2 L11 10.4 H1 Z" className={styles.fill} strokeLinejoin="round" />;
    case "danger":
      return <path d="M6 0.6 L11.4 6 L6 11.4 L0.6 6 Z" className={styles.fill} />;
    case "off":
      return <circle cx="6" cy="6" r="4.4" className={styles.ring} strokeDasharray="2.2 1.8" />;
    case "idle":
      return <circle cx="6" cy="6" r="4.4" className={styles.ring} />;
    default:
      return <circle cx="6" cy="6" r="4.6" className={styles.fill} />;
  }
}

export function StatusDot({ tone, size = 10, label, glow = true, pulse = false, className }: StatusDotProps) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <span
      className={[styles.dot, styles[tone], glow ? styles.glow : "", pulse ? styles.pulse : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size }}
      {...a11y}
    >
      <svg viewBox="0 0 12 12" width={size} height={size} focusable="false">
        <Glyph tone={tone} />
      </svg>
    </span>
  );
}
