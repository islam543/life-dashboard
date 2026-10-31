import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";

// Placeholder shapes shown while data loads. Decorative: the owning Panel announces "Loading ..."
// once for screen readers, so every skeleton is aria-hidden.

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** One shimmering block. Width defaults to 100%, height to one text line. */
export function Skeleton({ width = "100%", height = 12, radius, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={[styles.block, className].filter(Boolean).join(" ")}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** Stacked list rows: a title line and a shorter detail line each. */
export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className={styles.rows} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton width={10} height={10} radius="50%" />
          <div className={styles.rowText}>
            <Skeleton width={`${72 - ((i * 13) % 30)}%`} height={12} />
            <Skeleton width={`${44 - ((i * 7) % 18)}%`} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A chart area: faint axis lines and bars of varied height. */
export function SkeletonChart({ height = 160, bars = 12 }: { height?: number; bars?: number }) {
  return (
    <div className={styles.chart} style={{ height }} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <Skeleton key={i} className={styles.bar} height={`${28 + ((i * 37) % 64)}%`} radius="3px 3px 0 0" />
      ))}
    </div>
  );
}

/** A row of number tiles: label, big number, sparkline strip. */
export function SkeletonTiles({ count = 6 }: { count?: number }) {
  return (
    <div className={styles.tiles} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.tile}>
          <Skeleton width="55%" height={10} />
          <Skeleton width="45%" height={30} radius={6} />
          <Skeleton width="100%" height={24} radius={4} />
        </div>
      ))}
    </div>
  );
}

/** Horizontal cards in a strip (Needs you). */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className={styles.cards} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.card}>
          <Skeleton width={64} height={10} />
          <Skeleton width="85%" height={14} />
          <Skeleton width="60%" height={10} />
        </div>
      ))}
    </div>
  );
}
