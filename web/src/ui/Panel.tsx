import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import type { Area, Snapshot } from "../../../shared/types";
import { tileLayoutId, useDetailTrigger } from "../context/DetailContext";
import type { SnapshotResult } from "../hooks/useSnapshot";
import { MOTION } from "../hooks/useReducedMotion";
import { workTabFromLayoutId, type WorkTab } from "../lib/detailRows";
import { relativeTime, sourceLabel, type SourceKey } from "../lib/format";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { SkeletonCards, SkeletonChart, SkeletonRows, SkeletonTiles } from "./Skeleton";
import { StatusDot } from "./StatusDot";
import styles from "./Panel.module.css";

// The card every home panel and detail section sits in. It owns the five states so no panel
// invents its own: loading (skeleton), empty, error, not_connected, ok (your children).
//
//   <Panel title="Time by project" {...panelFromSource(snap, "claudeSessions", {
//       isEmpty: (s) => s.work.sessionTime.length === 0,
//       empty: "No Claude sessions this week.",
//     })} skeleton="chart" detail={{ area: "work" }}>
//     <Bars ... />
//   </Panel>
//
// `detail` turns the title into a button that opens that area's detail view, and puts
// layoutId tileLayoutId(area, key) on the panel so it expands into the overlay (see DetailContext).
// `fit` (ultrawide only): the panel takes its parent's height and its body scrolls when the content is
// taller, so a view can fill one screen without the page scrolling (Home at 1920px and up).

export type PanelState = "loading" | "empty" | "error" | "not_connected" | "ok";
export type PanelSkeleton = "rows" | "chart" | "tiles" | "cards";

export interface PanelProps {
  /** Final title, shown as a small letter-spaced label. Also the panel's accessible name. */
  title: string;
  state: PanelState;
  /** Rendered only when state is "ok". */
  children?: ReactNode;
  /** Right side of the header: one Button, a toggle, a "+N more" link. Hidden while loading. */
  action?: ReactNode;
  /** Small mono text after the title, e.g. "3" or "Generated 2 h ago". */
  meta?: ReactNode;
  /** empty: the line to show. error: what failed. not_connected: the source's message (what to do). */
  message?: string;
  /** Optional second line under `message`. */
  hint?: ReactNode;
  /** error: shows a Retry button. */
  onRetry?: () => void;
  /** Spinner on Retry while it runs. */
  retrying?: boolean;
  /** Hover help on Retry: what retrying does. */
  retryTip?: string;
  /** state "ok" with a caveat (stale data, last update failed): one amber line above the content. */
  notice?: string;
  /** Loading placeholder shape. Default "rows". Pass a node for a custom one. */
  skeleton?: PanelSkeleton | ReactNode;
  /** Makes the title open this area's detail and the panel expand into it. */
  detail?: { area: Area; key?: string };
  /** "ai" adds the violet accent for AI content (Next moves). */
  tone?: "default" | "ai";
  /** At 1920px and wider: fill the parent's height and scroll the body inside it. No effect below. */
  fit?: boolean;
  className?: string;
  bodyClassName?: string;
}

/** Same radius as --radius-lg, as a number so `motion` can correct it during layout animations. */
export const PANEL_RADIUS = 14;

function SkeletonFor({ kind }: { kind: PanelProps["skeleton"] }) {
  switch (kind) {
    case "chart":
      return <SkeletonChart />;
    case "tiles":
      return <SkeletonTiles />;
    case "cards":
      return <SkeletonCards />;
    case "rows":
    case undefined:
      return <SkeletonRows />;
    default:
      return <>{kind}</>;
  }
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M6 3h7v7M13 3 6.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StateBody(props: PanelProps & { titleText: string }) {
  const { state, message, hint, onRetry, retrying, retryTip, notice, skeleton, children, titleText } = props;
  switch (state) {
    case "loading":
      return (
        <>
          <span className="sr-only">Loading {titleText}</span>
          <SkeletonFor kind={skeleton} />
        </>
      );
    case "empty":
      return <EmptyState title={message ?? "Nothing here yet."} body={hint} />;
    case "error":
      return (
        <div className={styles.problem}>
          <p className={styles.problemTitle}>
            <StatusDot tone="danger" size={9} />
            <span>{message ?? `Couldn't load ${titleText.toLowerCase()}.`}</span>
          </p>
          {hint ? <p className={styles.problemHint}>{hint}</p> : null}
          {onRetry ? (
            <Button
              size="sm"
              onClick={onRetry}
              loading={retrying}
              loadingLabel="Retrying"
              className={styles.retry}
              tip={retryTip ?? "Tries loading this panel's data again; the rest of the page stays as it is."}
            >
              Retry
            </Button>
          ) : null}
        </div>
      );
    case "not_connected":
      return (
        <div className={styles.problem}>
          <p className={styles.problemTitle}>
            <StatusDot tone="off" size={10} glow={false} />
            <span>Not connected</span>
          </p>
          <p className={styles.instruction}>{message ?? "This source is not set up yet."}</p>
          {hint ? <p className={styles.problemHint}>{hint}</p> : null}
        </div>
      );
    default:
      return (
        <>
          {notice ? (
            <p className={styles.notice}>
              <StatusDot tone="warn" size={9} glow={false} />
              <span>{notice}</span>
            </p>
          ) : null}
          {children}
        </>
      );
  }
}

const WORK_TAB_TIP: Record<WorkTab, string> = {
  jira: "Opens Work details on the Jira tab: every open issue, with filters and sorting.",
  prs: "Opens Work details on the Pull requests tab, with the ones waiting on you first.",
  ci: "Opens Work details on the CI tab: the latest run on each repo's default branch.",
  time: "Opens Work details on the Time tab: time per project and commits, last 30 days.",
};

const AREA_TIP: Record<Area, string> = {
  work: "Opens Work details: Jira issues, pull requests, CI runs and 30 days of time.",
  learning: "Opens Learning details: the current cycle, your streak and the life agenda.",
  personal: "Opens Personal details: sleep, mood, workouts, spend and the check-in log.",
  calendar: "Opens your agenda beside the emails that are waiting on a reply.",
  email: "Opens the emails waiting on a reply beside your agenda.",
};

/** Hover help for anything that opens a detail view: what opens, and on which tab for Work. */
export function detailTip(area: Area, key?: string): string {
  if (area === "work") {
    const tab = workTabFromLayoutId(tileLayoutId(area, key));
    if (tab) return WORK_TAB_TIP[tab];
  }
  return AREA_TIP[area];
}

function PanelTitle({ id, title, detail }: { id: string; title: string; detail: { area: Area; key?: string } }) {
  const trigger = useDetailTrigger(detail.area, detail.key);
  return (
    <h2 id={id} className={styles.title}>
      <button type="button" className={styles.titleButton} onClick={trigger.open} data-tip={detailTip(detail.area, detail.key)}>
        <span>{title}</span>
        <span className="sr-only">, open details</span>
        <ExpandIcon />
      </button>
    </h2>
  );
}

function DetailShell({ detail, ...rest }: { detail: { area: Area; key?: string } } & Omit<ShellProps, "motionProps">) {
  const trigger = useDetailTrigger(detail.area, detail.key);
  return <Shell {...rest} motionProps={trigger.motionProps} />;
}

interface ShellProps {
  className: string;
  titleId: string;
  busy: boolean;
  children: ReactNode;
  motionProps?: ReturnType<typeof useDetailTrigger>["motionProps"];
}

function Shell({ className, titleId, busy, children, motionProps }: ShellProps) {
  return (
    <motion.section
      className={className}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      style={{ borderRadius: PANEL_RADIUS }}
      {...motionProps}
    >
      {children}
    </motion.section>
  );
}

export function Panel(props: PanelProps) {
  const { title, state, action, meta, detail, tone = "default", fit = false, className, bodyClassName } = props;
  const titleId = `panel-${useId().replace(/:/g, "")}`;
  const classes = [styles.panel, tone === "ai" ? styles.ai : "", fit ? styles.fit : "", className].filter(Boolean).join(" ");

  const inner = (
    <>
      <header className={styles.head}>
        {detail ? (
          <PanelTitle id={titleId} title={title} detail={detail} />
        ) : (
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        )}
        {meta !== undefined && meta !== null && state !== "loading" ? <span className={styles.meta}>{meta}</span> : null}
        {action && state !== "loading" ? <div className={styles.action}>{action}</div> : null}
      </header>
      <motion.div
        key={state}
        className={[styles.body, bodyClassName].filter(Boolean).join(" ")}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
      >
        <StateBody {...props} titleText={title} />
      </motion.div>
    </>
  );

  return detail ? (
    <DetailShell detail={detail} className={classes} titleId={titleId} busy={state === "loading"}>
      {inner}
    </DetailShell>
  ) : (
    <Shell className={classes} titleId={titleId} busy={state === "loading"}>
      {inner}
    </Shell>
  );
}

/** Ends a server message with a full stop so it can sit inside a longer line. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** The props Panel needs for its state, from the shared snapshot. Spread them onto <Panel>. */
export interface PanelStatus {
  state: PanelState;
  message?: string;
  hint?: string;
  onRetry?: () => void;
  retrying?: boolean;
  retryTip?: string;
  notice?: string;
}

/**
 * Maps the snapshot and one source's SourceState to Panel props:
 *   no data yet and loading          -> loading
 *   no data and the request failed   -> error with Retry (re-read)
 *   source not_connected             -> not_connected with the source's message (what to do)
 *   source never_run                 -> empty "Not collected yet"
 *   source error, nothing to show    -> error with the source's message and Retry (runs collectors)
 *   source error or stale, has data  -> ok with an amber notice
 *   ok but isEmpty(snapshot)         -> empty with your `empty` line
 * Pass `source: null` for panels fed by several sources (Needs you): only the snapshot-level
 * states and isEmpty apply.
 */
export function panelFromSource(
  snap: Pick<SnapshotResult, "data" | "loading" | "error" | "refresh" | "collect" | "collecting">,
  source: SourceKey | null,
  opts: { isEmpty: (s: Snapshot) => boolean; empty: string; emptyHint?: string },
  now: Date = new Date(),
): PanelStatus {
  const { data } = snap;
  if (!data) {
    if (snap.error && !snap.loading) {
      return {
        state: "error",
        message: "Couldn't load the dashboard data.",
        hint: snap.error,
        onRetry: () => void snap.refresh(),
        retryTip: "Asks the local server for the dashboard data again.",
      };
    }
    return { state: "loading" };
  }

  const empty = opts.isEmpty(data);
  const emptyStatus: PanelStatus = { state: "empty", message: opts.empty, hint: opts.emptyHint };
  if (source === null) return empty ? emptyStatus : { state: "ok" };

  const src = data.sources[source];
  const name = sourceLabel(source);
  switch (src.status) {
    case "not_connected":
      return { state: "not_connected", message: src.message ?? `Connect ${name} to see this.` };
    case "never_run":
      return {
        state: "empty",
        message: "Not collected yet.",
        hint: src.message ?? `${name} is collected on the next refresh.`,
      };
    case "error":
      if (empty) {
        return {
          state: "error",
          message: `${name} update failed.`,
          hint: src.message,
          onRetry: () => void snap.collect(),
          retrying: snap.collecting,
          retryTip: `Re-reads all 7 sources, ${name} included; this takes a few seconds.`,
        };
      }
      // updatedAt is the time of the last ok result, so it dates the data still on screen.
      return {
        state: "ok",
        notice: `Last ${name} update failed${src.message ? `: ${sentence(src.message)}` : "."} ${
          src.updatedAt ? `Showing data from ${relativeTime(src.updatedAt, now)}.` : "Showing the last saved data."
        }`,
      };
    case "stale":
      if (empty) return emptyStatus;
      return { state: "ok", notice: `${name} data is from ${relativeTime(src.updatedAt, now)}.` };
    default:
      return empty ? emptyStatus : { state: "ok" };
  }
}
