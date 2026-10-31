import { motion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { Area, Snapshot } from "../../../shared/types";
import { useDetailTrigger } from "../context/DetailContext";
import { MOTION } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { detailTitle, plural, type SourceKey } from "../lib/format";
import {
  ageToX,
  availability,
  compareWeeks,
  describeDelta,
  formatCount,
  formatHours,
  jiraSummary,
  lastDayKeys,
  prQueue,
  seriesFor,
  share,
  sleepAverage,
  sleepSeries,
  SPARK_DAYS,
  streakCaption,
  streakSummary,
  sumByDay,
  weekStartIndex,
  type Availability,
  type Direction,
  type JiraSummary,
  type PrQueue,
  type StreakSummary,
} from "../lib/kpis";
import { CountUp } from "../ui/CountUp";
import { detailTip, Panel, panelFromSource } from "../ui/Panel";
import { Sparkline } from "../ui/Sparkline";
import { StatusDot } from "../ui/StatusDot";
import styles from "./KpiTiles.module.css";

// Six bare numbers with a 14-day picture behind each. Every tile is a button that grows into its
// area's detail view (useDetailTrigger(area, key): several tiles open "work", so each has its own key).
// A tile whose source is not connected, never collected, or never succeeded says so; it never shows 0.
//
// Three sources keep per-day history (sessions, commits, check-ins), so those tiles get a Sparkline
// with this week's stretch shaded. Jira, PRs and the streak have no history in the snapshot, so their
// picture is a true breakdown instead: issue status split, PR age strip, streak against the best.

/** Same as --radius-md, as a number so `motion` can correct it during the layout animation. */
const TILE_RADIUS = 10;

interface Compare {
  dir?: Direction;
  text: ReactNode;
}

interface TileModel {
  key: string;
  area: Area;
  source: SourceKey;
  label: string;
  avail: Availability;
  /** Null with avail "ok" means the source works but has nothing for this period (no check-ins). */
  value: number | null;
  format: (n: number) => string;
  unit?: string;
  noValue?: string;
  compare: Compare | null;
  visual: ReactNode;
  /** Full sentence for screen readers, read when the tile's button is focused. */
  spoken: string;
  /** Hover help on the tile: where it opens, plus the comparison figure behind the trend line. */
  tip?: string;
}

/** Current time, re-read every `everyMs` so the week boundary moves at midnight on Saturday. */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const DIR_WORD: Record<Direction, string> = { up: "up", down: "down", flat: "level" };

function ArrowGlyph({ dir }: { dir: Direction }) {
  const d = dir === "up" ? "M6 2.5 10 8H2z" : dir === "down" ? "M6 9.5 2 4h8z" : "M2 5.2h8v1.6H2z";
  return (
    <svg className={styles.arrow} viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg className={styles.expand} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M6 3h7v7M13 3 6.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ---- pictures ------------------------------------------------------------------------------

const SPARK_MIN = 36;
const SPARK_MAX = 112;

/** Height of an element, kept current with a ResizeObserver. */
function useHeight<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect.height ?? 0);
      setHeight((prev) => (prev === h ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, height];
}

/**
 * Sparkline with the stretch the number covers (this week, or the last 7 days) shaded. It grows into
 * the tile's spare height (36 to 112 px) but is positioned so it never makes the tile taller.
 */
interface TrendSparkProps {
  values: (number | null)[];
  label: string;
  from: number;
  baseline?: number;
}

function TrendSpark(props: TrendSparkProps) {
  // Nothing recorded in 14 days: no empty chart box.
  return props.values.some((v) => v !== null) ? <GrowingSpark {...props} /> : null;
}

function GrowingSpark({ values, label, from, baseline }: TrendSparkProps) {
  const [ref, height] = useHeight<HTMLDivElement>();
  const at = values.length > 1 ? Math.max(0, (from - 0.5) / (values.length - 1)) : 0;
  // Grow only when there is a shape to show: two or more points and something above zero.
  const defined = values.filter((v): v is number => v !== null);
  const hasShape = defined.length >= 2 && defined.some((v) => v > 0);
  const h = hasShape ? Math.max(SPARK_MIN, Math.min(SPARK_MAX, height)) : SPARK_MIN;
  return (
    <div ref={ref} className={styles.spark}>
      <div className={styles.sparkInner} style={{ height: h }}>
        <span className={styles.band} style={{ "--at": at } as CSSProperties} aria-hidden="true" />
        <Sparkline values={values} label={label} height={h} baseline={baseline} />
      </div>
    </div>
  );
}

const grow = (delay: number) => ({
  initial: { scaleX: 0 },
  animate: { scaleX: 1 },
  transition: { duration: MOTION.draw, ease: MOTION.easeOut, delay },
});

/** Open issues split into in progress and to do. */
function JiraBar({ s }: { s: JiraSummary }) {
  return (
    <div className={styles.picture} aria-hidden="true">
      <div className={styles.track}>
        {s.inProgress > 0 ? (
          <motion.span className={styles.segActive} style={{ width: `${share(s.inProgress, s.open) * 100}%` }} {...grow(0.25)} />
        ) : null}
        {s.todo > 0 ? (
          <motion.span className={styles.segTodo} style={{ width: `${share(s.todo, s.open) * 100}%` }} {...grow(0.35)} />
        ) : null}
      </div>
      <div className={styles.legend}>
        <span>
          <i className={styles.keyActive} />
          <span className="num">{formatCount(s.inProgress)}</span> in progress
        </span>
        <span>
          <i className={styles.keyTodo} />
          <span className="num">{formatCount(s.todo)}</span> to do
        </span>
      </div>
    </div>
  );
}

/** One dot per PR waiting on your review, placed by how long it has waited (14 days to now). */
function AgeStrip({ q }: { q: PrQueue }) {
  return (
    <div className={styles.picture} aria-hidden="true">
      <div className={styles.ages}>
        <span className={styles.agesAxis} />
        <span className={styles.agesTick} style={{ left: `${ageToX(3) * 100}%` }} />
        <span className={styles.agesTick} style={{ left: `${ageToX(1) * 100}%` }} />
        {q.dots.map((d, i) => (
          <motion.span
            key={d.key}
            className={[styles.ageDot, styles[d.tone]].join(" ")}
            style={{ left: `${d.x * 100}%`, top: `${8 + d.row * 10}px` }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: MOTION.base, ease: MOTION.easeOut, delay: 0.25 + Math.min(i, 20) * 0.02 }}
          />
        ))}
      </div>
      <div className={styles.agesScale}>
        <span>{SPARK_DAYS}d+</span>
        <span className={styles.agesMark} style={{ left: `${ageToX(3) * 100}%` }}>
          3d
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

/** The current streak against the best: one cell per day up to 30, a bar beyond that. */
function StreakBar({ s }: { s: StreakSummary }) {
  if (s.best > 0 && s.best <= 30) {
    return (
      <div className={styles.picture} aria-hidden="true">
        <div className={styles.cells}>
          {Array.from({ length: s.best }, (_, i) => (
            <motion.span
              key={i}
              className={[styles.cell, i < s.current ? styles.cellOn : "", s.isBest && i < s.current ? styles.cellBest : ""]
                .filter(Boolean)
                .join(" ")}
              initial={{ opacity: 0, scaleY: 0.4 }}
              animate={{ opacity: 1, scaleY: 1 }}
              transition={{ duration: MOTION.base, ease: MOTION.easeOut, delay: 0.2 + i * 0.025 }}
            />
          ))}
        </div>
        <div className={styles.scale}>
          <span>0</span>
          <span>best {s.best}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.picture} aria-hidden="true">
      <div className={styles.track}>
        {s.current > 0 ? (
          <motion.span className={[styles.segActive, s.isBest ? styles.segBest : ""].join(" ")} style={{ width: `${s.ratio * 100}%` }} {...grow(0.25)} />
        ) : null}
      </div>
      <div className={styles.scale}>
        <span>0</span>
        <span>best {formatCount(s.best)}</span>
      </div>
    </div>
  );
}

// ---- models --------------------------------------------------------------------------------

function weekCompare(delta: number, fmt: (n: number) => string, unit: string): Compare {
  const d = describeDelta(delta, fmt);
  return {
    dir: d.dir,
    text: d.dir === "flat" ? "Same as last week" : `${d.text}${unit} vs last week`,
  };
}

function buildTiles(data: Snapshot, now: Date): TileModel[] {
  const sources = data.sources ?? ({} as Partial<Snapshot["sources"]>);
  const work = data.work ?? { jira: [], prs: [], ci: [], repoActivity: [], sessionTime: [] };
  const keys = lastDayKeys(now);
  const weekFrom = weekStartIndex(now);

  // Hours worked this week, from Claude Code sessions.
  const minutes = sumByDay((work.sessionTime ?? []).map((s) => s.minutesByDay));
  const hoursWeek = compareWeeks(minutes, now);
  const hoursCmp = weekCompare(hoursWeek.delta / 60, formatHours, "h");
  const hours = hoursWeek.thisWeek / 60;

  // Commits this week, across repos.
  const commitsByDay = sumByDay((work.repoActivity ?? []).map((r) => r.commitsByDay));
  const commitsWeek = compareWeeks(commitsByDay, now);
  const commitsCmp = weekCompare(commitsWeek.delta, formatCount, "");

  const jira = jiraSummary(work.jira ?? [], now);
  const prs = prQueue(work.prs ?? [], now);
  const streak = streakSummary(data.learning?.streak);
  const streakText = streakCaption(streak, data.learning?.streak?.started, now);
  const checkins = data.personal?.checkins ?? [];
  const sleep = sleepAverage(checkins, now);
  const sleepDelta = sleep.delta !== null ? describeDelta(sleep.delta, formatHours) : null;

  const tile = (key: string, area: Area, source: SourceKey, rest: Omit<TileModel, "key" | "area" | "source" | "avail">): TileModel => ({
    key,
    area,
    source,
    avail: availability(sources[source], source, now),
    ...rest,
  });

  return [
    tile("hours", "work", "claudeSessions", {
      label: "Hours this week",
      value: hours,
      format: formatHours,
      unit: "h",
      compare: hoursCmp,
      visual: (
        <TrendSpark
          values={seriesFor(minutes, keys, 0).map((v) => (v === null ? null : v / 60))}
          label="Hours in Claude Code sessions per day, last 14 days"
          from={weekFrom}
        />
      ),
      spoken: `${formatHours(hours)} hours in Claude Code sessions since Sunday, ${DIR_WORD[hoursCmp.dir ?? "flat"]} on the same days last week (${formatHours(hoursWeek.lastWeek / 60)} hours).`,
      tip: `Opens Work on the Time tab; the same days last week came to ${formatHours(hoursWeek.lastWeek / 60)}h.`,
    }),
    tile("jira", "work", "jira", {
      label: "Open Jira issues",
      value: jira.open,
      format: formatCount,
      compare:
        jira.overdue + jira.blocked === 0
          ? { text: jira.open === 0 ? "Nothing open" : "None overdue or blocked" }
          : {
              text: (
                <span className={styles.flags}>
                  {jira.overdue > 0 ? (
                    <span className={styles.flag}>
                      <StatusDot tone="danger" size={8} glow={false} />
                      <span className="num">{formatCount(jira.overdue)}</span> overdue
                    </span>
                  ) : null}
                  {jira.blocked > 0 ? (
                    <span className={styles.flag}>
                      <StatusDot tone="warn" size={8} glow={false} />
                      <span className="num">{formatCount(jira.blocked)}</span> blocked
                    </span>
                  ) : null}
                </span>
              ),
            },
      visual: <JiraBar s={jira} />,
      spoken: `${plural(jira.open, "open Jira issue")}: ${formatCount(jira.inProgress)} in progress, ${formatCount(jira.todo)} to do, ${formatCount(jira.overdue)} overdue, ${formatCount(jira.blocked)} blocked.`,
    }),
    tile("prs", "work", "github", {
      label: "PRs waiting on you",
      value: prs.count,
      format: formatCount,
      compare:
        prs.count === 0
          ? { text: "Nothing waiting" }
          : prs.oldestDays === null
            ? null
            : { text: prs.oldestDays === 0 ? "Oldest opened today" : `Oldest ${plural(prs.oldestDays, "day")}` },
      visual: <AgeStrip q={prs} />,
      spoken: `${plural(prs.count, "pull request")} waiting on your review${
        prs.oldestDays !== null ? `, the oldest for ${plural(prs.oldestDays, "day")}` : ""
      }.`,
    }),
    tile("commits", "work", "github", {
      label: "Commits this week",
      value: commitsWeek.thisWeek,
      format: formatCount,
      compare: commitsCmp,
      visual: <TrendSpark values={seriesFor(commitsByDay, keys, 0)} label="Commits per day, last 14 days" from={weekFrom} />,
      spoken: `${plural(commitsWeek.thisWeek, "commit")} since Sunday, ${DIR_WORD[commitsCmp.dir ?? "flat"]} on the same days last week (${formatCount(commitsWeek.lastWeek)}).`,
      tip: `Opens Work on the Time tab; the same days last week had ${plural(commitsWeek.lastWeek, "commit")}.`,
    }),
    tile("streak", "learning", "learning", {
      label: "Learning streak",
      value: streak.current,
      format: formatCount,
      unit: streak.current === 1 ? "day" : "days",
      compare: { text: streakText },
      visual: <StreakBar s={streak} />,
      spoken: `Learning streak ${plural(streak.current, "day")}, best ${plural(streak.best, "day")}. ${streakText}.`,
      tip:
        streak.current > 0
          ? "Opens Learning details; Daily.md has no last-studied date, so a lapse can't show here."
          : undefined,
    }),
    tile("sleep", "personal", "checkins", {
      label: "Avg sleep, 7 days",
      value: sleep.current,
      format: formatHours,
      unit: "h",
      noValue: "No check-ins in 7 days",
      compare:
        sleepDelta !== null && sleep.delta !== null
          ? {
              dir: sleepDelta.dir,
              text: sleepDelta.dir === "flat" ? "Same as last week" : `${sleepDelta.text}h vs last week`,
            }
          : sleep.current !== null
            ? { text: `${plural(sleep.currentDays, "night")} logged` }
            : null,
      visual: (
        <TrendSpark
          values={sleepSeries(checkins, now)}
          label="Sleep per night, last 14 days. Gaps are days without a check-in."
          from={SPARK_DAYS - 7}
          baseline={sleep.previous ?? undefined}
        />
      ),
      spoken:
        sleep.current === null
          ? "No check-ins in the last 7 days."
          : `Average sleep ${formatHours(sleep.current)} hours over ${plural(sleep.currentDays, "night")}${
              sleep.previous !== null ? `, previous 7 days ${formatHours(sleep.previous)} hours` : ""
            }.`,
      tip:
        sleep.previous !== null
          ? `Opens Personal details; the 7 days before averaged ${formatHours(sleep.previous)}h over ${plural(sleep.previousDays, "night")}.`
          : undefined,
    }),
  ];
}

// ---- tile ----------------------------------------------------------------------------------

const PROBLEM: Record<Exclude<Availability["kind"], "ok">, { title: string; tone: "off" | "idle" | "danger" }> = {
  off: { title: "Not connected", tone: "off" },
  idle: { title: "Not collected yet", tone: "idle" },
  failed: { title: "Update failed", tone: "danger" },
};

function Tile({ model, index }: { model: TileModel; index: number }) {
  const trigger = useDetailTrigger(model.area, model.key);
  const descId = `kpi-${useId().replace(/:/g, "")}`;
  const { avail } = model;
  const caveat = avail.kind === "ok" ? avail.caveat : null;
  const spoken =
    avail.kind === "ok"
      ? `${model.spoken}${caveat ? ` ${caveat}` : ""}`
      : `${PROBLEM[avail.kind].title}. ${avail.message}`;

  return (
    <motion.li
      className={styles.item}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION.base, ease: MOTION.easeOut, delay: index * MOTION.stagger }}
    >
      <motion.div
        {...trigger.motionProps}
        className={[styles.tile, avail.kind !== "ok" ? styles.quiet : ""].filter(Boolean).join(" ")}
        style={{ borderRadius: TILE_RADIUS }}
      >
        <div className={styles.head}>
          <h3 className={styles.label}>
            <button
              type="button"
              className={styles.hit}
              onClick={trigger.open}
              aria-describedby={descId}
              data-tip={(avail.kind === "ok" ? model.tip : undefined) ?? detailTip(model.area, model.key)}
            >
              {model.label}
              <span className="sr-only">, open {detailTitle(model.area)} details</span>
            </button>
          </h3>
          {caveat ? (
            <span className={styles.caveat} data-tip={caveat}>
              <StatusDot tone="warn" size={9} glow={false} />
            </span>
          ) : null}
          <ExpandIcon />
        </div>

        {avail.kind === "ok" ? (
          <>
            {model.value !== null ? (
              <p className={styles.value}>
                <CountUp value={model.value} format={model.format} className={styles.number} />
                {model.unit ? <span className={styles.unit}>{model.unit}</span> : null}
              </p>
            ) : (
              <p className={styles.noValue}>{model.noValue ?? "No data yet"}</p>
            )}
            {model.compare ? (
              <p className={styles.compare}>
                {model.compare.dir ? <ArrowGlyph dir={model.compare.dir} /> : null}
                <span>{model.compare.text}</span>
              </p>
            ) : null}
            <div className={styles.visual}>{model.visual}</div>
          </>
        ) : (
          <div className={styles.problem}>
            <p className={styles.problemTitle}>
              <StatusDot tone={PROBLEM[avail.kind].tone} size={9} glow={false} />
              <span>{PROBLEM[avail.kind].title}</span>
            </p>
            <p className={styles.problemText}>
              {avail.message}
            </p>
          </div>
        )}

        <p id={descId} className="sr-only">
          {spoken}
        </p>
      </motion.div>
    </motion.li>
  );
}

export function KpiTiles() {
  const snap = useSnapshot();
  const now = useNow(60_000);
  const status = panelFromSource(snap, null, { isEmpty: () => false, empty: "" });
  const data = snap.data;
  const tiles = useMemo(() => (data ? buildTiles(data, now) : []), [data, now]);

  return (
    <Panel
      title="Key numbers"
      state={status.state}
      message={status.message}
      hint={status.hint}
      onRetry={status.onRetry}
      retrying={status.retrying}
      skeleton="tiles"
      bodyClassName={styles.body}
    >
      <ul className={styles.grid} role="list">
        {tiles.map((t, i) => (
          <Tile key={t.key} model={t} index={i} />
        ))}
      </ul>
    </Panel>
  );
}
