import { area as d3area, curveMonotoneX, extent, line as d3line, scaleLinear } from "d3";
import { motion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import styles from "./Sparkline.module.css";

// A tiny trend line for number tiles: d3 for the geometry, `motion` for the draw-in.
// Fills its container's width; height is fixed. `null` values are gaps (a missing day is not zero).
// On first render the line draws itself in, the area fades up and the latest point pops with one ring.
// Reduced motion: drawn complete at once.
//
//   <Sparkline values={last14Days} label="Hours worked per day, last 14 days" />

export type SparklineTone = "data" | "ai" | "warn" | "danger";

export interface SparklineProps {
  /** Oldest first. `null` = no data for that point (drawn as a gap). */
  values: ReadonlyArray<number | null>;
  /** Accessible name, e.g. "Sleep per night, last 14 days". */
  label: string;
  /** Height in px. Default 36. */
  height?: number;
  tone?: SparklineTone;
  /** Faint fill under the line. Default true. */
  area?: boolean;
  /** Dot on the latest defined value. Default true. */
  showLast?: boolean;
  /** Fixed y range, e.g. [0, 10] for sleep hours. Default: 0 (or the minimum if negative) to the maximum. */
  domain?: readonly [number, number];
  /** Optional dashed reference line, e.g. last week's average. */
  baseline?: number;
  className?: string;
}

const PAD = 4;

export function Sparkline({
  values,
  label,
  height = 36,
  tone = "data",
  area = true,
  showLast = true,
  domain,
  baseline,
  className,
}: SparklineProps) {
  const reduced = useReducedMotion();
  const gradientId = `spark-${useId().replace(/:/g, "")}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const defined = values.filter((v): v is number => v !== null && Number.isFinite(v));
  let [lo, hi] = domain ?? [Math.min(0, extent(defined)[0] ?? 0), extent(defined)[1] ?? 0];
  if (baseline !== undefined && !domain) hi = Math.max(hi, baseline);
  if (hi === lo) hi = lo + 1;

  const x = scaleLinear()
    .domain([0, Math.max(1, values.length - 1)])
    .range([PAD, Math.max(PAD, width - PAD)]);
  const y = scaleLinear().domain([lo, hi]).range([height - PAD, PAD]).clamp(true);
  const isDefined = (v: number | null): v is number => v !== null && Number.isFinite(v);

  const linePath =
    d3line<number | null>()
      .defined(isDefined)
      .x((_, i) => x(i))
      .y((v) => y(v as number))
      .curve(curveMonotoneX)(values as (number | null)[]) ?? "";
  const areaPath =
    d3area<number | null>()
      .defined(isDefined)
      .x((_, i) => x(i))
      .y0(height)
      .y1((v) => y(v as number))
      .curve(curveMonotoneX)(values as (number | null)[]) ?? "";

  let lastIndex = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (isDefined(values[i] ?? null)) {
      lastIndex = i;
      break;
    }
  }
  const last = lastIndex >= 0 ? (values[lastIndex] as number) : null;
  const ready = width > 0 && defined.length > 0;
  const draw = { duration: MOTION.draw, ease: MOTION.easeOut };

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={label}
      className={[styles.spark, styles[tone], className].filter(Boolean).join(" ")}
      style={{ height }}
    >
      {ready ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className={styles.areaTop} />
              <stop offset="100%" className={styles.areaBottom} />
            </linearGradient>
          </defs>
          {baseline !== undefined ? (
            <line className={styles.baseline} x1={PAD} x2={width - PAD} y1={y(baseline)} y2={y(baseline)} />
          ) : null}
          {area ? (
            <motion.path
              d={areaPath}
              fill={`url(#${gradientId})`}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: MOTION.draw, delay: reduced ? 0 : MOTION.draw * 0.35 }}
            />
          ) : null}
          <motion.path
            d={linePath}
            className={styles.line}
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={draw}
          />
          {values.map((v, i) =>
            isDefined(v) && !isDefined(values[i - 1] ?? null) && !isDefined(values[i + 1] ?? null) && i !== lastIndex ? (
              <circle key={i} className={styles.dot} cx={x(i)} cy={y(v)} r={2} />
            ) : null,
          )}
          {showLast && last !== null ? (
            <g transform={`translate(${x(lastIndex)} ${y(last)})`}>
              {!reduced ? (
                <motion.circle
                  className={styles.ring}
                  r={3}
                  initial={{ scale: 1, opacity: 0 }}
                  animate={{ scale: [1, 3.2], opacity: [0.8, 0] }}
                  transition={{ duration: 0.9, delay: MOTION.draw * 0.9, ease: MOTION.easeOut }}
                />
              ) : null}
              <motion.circle
                className={styles.dot}
                r={2.75}
                initial={reduced ? false : { scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ duration: MOTION.base, delay: reduced ? 0 : MOTION.draw * 0.85, ease: MOTION.easeOut }}
              />
            </g>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
