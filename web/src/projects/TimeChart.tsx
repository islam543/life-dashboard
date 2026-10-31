import { scaleBand, scaleLinear } from "d3";
import { motion } from "motion/react";
import { useState } from "react";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { dayKey, formatMinutes, plural } from "../lib/format";
import { dailySeries } from "../lib/projects";
import { addDays, longDay, shortDay, startOfDay } from "../lib/timeAgg";
import { ChartTooltip, useElementWidth, type TipData } from "../panels/ProjectTimeBars";
import styles from "./TimeChart.module.css";

// One project's last 30 days: a column per day for Claude Code minutes, a tick under the day for
// GitHub commits. Columns grow in on first load; hover shows the day. Screen readers get one
// sentence (the total, the busiest day and the commit count) instead of 30 bars.

export const CHART_DAYS = 30;
const HEIGHT = 132;
const AXIS = 20;
const TOP = 8;

export interface TimeChartProps {
  name: string;
  minutesByDay: Readonly<Record<string, number>> | undefined;
  commitsByDay: Readonly<Record<string, number>> | undefined;
  now: Date;
}

export function TimeChart({ name, minutesByDay, commitsByDay, now }: TimeChartProps) {
  const reduced = useReducedMotion();
  const [hostRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const today = startOfDay(now);
  const dates = Array.from({ length: CHART_DAYS }, (_, i) => addDays(today, i - CHART_DAYS + 1));
  const keys = dates.map(dayKey);
  const minutes = dailySeries(minutesByDay, now, CHART_DAYS);
  const commits = dailySeries(commitsByDay, now, CHART_DAYS);
  const total = minutes.reduce((s, v) => s + v, 0);
  const totalCommits = commits.reduce((s, v) => s + v, 0);
  const busiest = minutes.reduce((best, v, i) => (v > (minutes[best] ?? 0) ? i : best), 0);
  const max = Math.max(1, ...minutes);

  const x = scaleBand<string>().domain(keys).range([0, Math.max(1, width)]).paddingInner(0.28).paddingOuter(0.1);
  const y = scaleLinear().domain([0, max]).range([HEIGHT - AXIS, TOP]);
  const base = HEIGHT - AXIS;

  const summary =
    total > 0
      ? `${name}: ${formatMinutes(total)} of Claude Code time in the last ${CHART_DAYS} days, busiest ${longDay(dates[busiest]!)} with ${formatMinutes(minutes[busiest] ?? 0)}. ${plural(totalCommits, "commit")}.`
      : `${name}: no Claude Code time in the last ${CHART_DAYS} days. ${plural(totalCommits, "commit")}.`;

  const tip: TipData | null =
    hover !== null && width > 0
      ? {
          x: (x(keys[hover]!) ?? 0) + x.bandwidth() / 2,
          top: y(minutes[hover] ?? 0) - 4,
          bottom: base,
          title: hover === CHART_DAYS - 1 ? `Today, ${shortDay(dates[hover]!)}` : longDay(dates[hover]!),
          value: minutes[hover] ? formatMinutes(minutes[hover]!) : "No session time",
          meta: commits[hover] ? plural(commits[hover]!, "commit") : undefined,
        }
      : null;

  const labels = [0, Math.floor(CHART_DAYS / 2), CHART_DAYS - 1];

  return (
    <div ref={hostRef} className={styles.host} onPointerLeave={() => setHover(null)}>
      <div role="img" aria-label={summary} className={styles.stage} style={{ height: HEIGHT }}>
        {width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            aria-hidden="true"
            focusable="false"
            onPointerMove={(e) => {
              const left = e.currentTarget.getBoundingClientRect().left;
              const step = x.step();
              const i = Math.floor((e.clientX - left - x.paddingOuter() * step) / step);
              setHover(i >= 0 && i < CHART_DAYS ? i : null);
            }}
          >
            {[0.5, 1].map((t) => (
              <line key={t} className={styles.grid} x1={0} x2={width} y1={y(max * t)} y2={y(max * t)} />
            ))}
            <line className={styles.axis} x1={0} x2={width} y1={base} y2={base} />
            {keys.map((k, i) => {
              const v = minutes[i] ?? 0;
              const h = Math.max(0, base - y(v));
              const bx = x(k) ?? 0;
              const isToday = i === CHART_DAYS - 1;
              return (
                <g key={k} data-hover={hover === i || undefined}>
                  {v > 0 ? (
                    <motion.rect
                      className={isToday ? styles.barToday : styles.bar}
                      x={bx}
                      width={x.bandwidth()}
                      rx={Math.min(2, x.bandwidth() / 3)}
                      initial={reduced ? false : { y: base, height: 0 }}
                      animate={{ y: base - h, height: h }}
                      transition={{ duration: MOTION.draw, delay: reduced ? 0 : i * 0.012, ease: MOTION.easeOut }}
                    />
                  ) : (
                    <rect className={styles.zero} x={bx} y={base - 1.5} width={x.bandwidth()} height={1.5} />
                  )}
                  {commits[i] ? (
                    <circle className={styles.commit} cx={bx + x.bandwidth() / 2} cy={base + 6} r={Math.min(3, 1.6 + (commits[i] ?? 0) * 0.3)} />
                  ) : null}
                </g>
              );
            })}
            {hover !== null ? (
              <rect
                className={styles.hoverBand}
                x={(x(keys[hover]!) ?? 0) - (x.step() - x.bandwidth()) / 2}
                y={TOP - 4}
                width={x.step()}
                height={base - TOP + 4}
              />
            ) : null}
            {labels.map((i) => (
              <text
                key={i}
                className={styles.label}
                x={(x(keys[i]!) ?? 0) + x.bandwidth() / 2}
                y={HEIGHT - 2}
                textAnchor={i === 0 ? "start" : i === CHART_DAYS - 1 ? "end" : "middle"}
              >
                {i === CHART_DAYS - 1 ? "Today" : shortDay(dates[i]!)}
              </text>
            ))}
          </svg>
        ) : null}
      </div>
      <ChartTooltip tip={tip} hostWidth={width} />
    </div>
  );
}
