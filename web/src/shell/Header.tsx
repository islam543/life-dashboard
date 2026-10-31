import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Snapshot, SourceStatus } from "../../../shared/types";
import { useCheckin } from "../context/CheckinContext";
import { useSnapshot } from "../hooks/useSnapshot";
import { MOTION } from "../hooks/useReducedMotion";
import {
  dayKey,
  formatLongDate,
  greeting,
  relativeTime,
  SOURCE_KEYS,
  sourceLabel,
  statusLabel,
  type SourceKey,
} from "../lib/format";
import { noteHash, projectHash, toHash, type View } from "../lib/route";
import { setTipsEnabled, useTipsEnabled } from "../lib/tips";
import { ThemeSwitch } from "./ThemeSwitch";
import { Button } from "../ui/Button";
import { StatusDot, toneForSource } from "../ui/StatusDot";
import styles from "./Header.module.css";

/** The current view (the first part of the hash). Full routing lives in lib/route.ts. */
export type Route = View;

/** The view switch. Each tab links to its view's top level, so it also closes an open project or note. */
const VIEWS: readonly { key: View; href: string; label: string; tip: string }[] = [
  { key: "home", href: toHash({ view: "home" }), label: "Home", tip: "Shows the morning glance: what needs you, next moves and the key numbers." },
  { key: "projects", href: projectHash(), label: "Projects", tip: "Shows your tracked projects with their tasks, notes and time spent." },
  { key: "notes", href: noteHash(), label: "Notes", tip: "Opens your vault notes to browse, read and edit; edits save as you type." },
  { key: "map", href: toHash({ view: "map" }), label: "Life map", tip: "Shows the five life areas as one map, sized by attention in the last 7 days." },
];

const USER_NAME = "Islam";

/** Current time, re-read every `everyMs` so "Updated 3 min ago" and the greeting stay true. */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3.2h-3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const SEVERITY: SourceStatus[] = ["error", "stale", "not_connected", "never_run"];
const SUMMARY_WORD: Record<SourceStatus, string> = {
  error: "failing",
  stale: "out of date",
  not_connected: "not connected",
  never_run: "not collected yet",
  ok: "up to date",
};

/** "1 failing, 2 not connected", or "All up to date". Two most severe groups at most. */
function sourceSummary(sources: Snapshot["sources"]): { text: string; tone: "ok" | "warn" | "danger" | "muted" } {
  const counts = new Map<SourceStatus, number>();
  for (const key of SOURCE_KEYS) counts.set(sources[key].status, (counts.get(sources[key].status) ?? 0) + 1);
  const parts = SEVERITY.filter((s) => counts.has(s))
    .slice(0, 2)
    .map((s) => `${counts.get(s)} ${SUMMARY_WORD[s]}`);
  if (parts.length === 0) return { text: "All up to date", tone: "ok" };
  const tone = counts.has("error") ? "danger" : counts.has("stale") ? "warn" : "muted";
  return { text: parts.join(", "), tone };
}

function SourceStatusBar({ sources, now }: { sources: Snapshot["sources"] | null; now: Date }) {
  const [active, setActive] = useState<SourceKey | null>(null);
  const tipId = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (key: SourceKey) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setActive(key);
  };
  const hideSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setActive(null), 120);
  };
  useEffect(() => () => void (closeTimer.current && clearTimeout(closeTimer.current)), []);

  const summary = sources ? sourceSummary(sources) : null;
  const current = active && sources ? sources[active] : null;

  return (
    <div
      className={styles.sources}
      role="group"
      aria-label="Data sources"
      onMouseLeave={hideSoon}
      onKeyDown={(e) => {
        if (e.key === "Escape" && active) {
          e.stopPropagation();
          setActive(null);
        }
      }}
    >
      <span className={`label ${styles.sourcesLabel}`}>Sources</span>
      <ul className={styles.sourceList}>
        {SOURCE_KEYS.map((key) => {
          const state = sources?.[key];
          const tone = state ? toneForSource(state.status) : "idle";
          const name = sourceLabel(key);
          return (
            <li key={key}>
              <button
                type="button"
                className={styles.source}
                data-status={state?.status ?? "loading"}
                aria-describedby={active === key ? tipId : undefined}
                aria-label={`${name}: ${state ? statusLabel(state.status) : "loading"}`}
                onMouseEnter={() => show(key)}
                onFocus={() => show(key)}
                onBlur={hideSoon}
              >
                <StatusDot tone={tone} size={9} glow={tone !== "off" && tone !== "idle"} />
                <span className={styles.sourceName} aria-hidden="true">
                  {name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {summary ? (
        <span className={styles.summary} data-tone={summary.tone}>
          {summary.text}
        </span>
      ) : null}

      {active ? (
        <div
          id={tipId}
          role="tooltip"
          className={styles.tooltip}
          onMouseEnter={() => show(active)}
          onMouseLeave={hideSoon}
        >
          <p className={styles.tipHead}>
            <span className={styles.tipName}>{sourceLabel(active)}</span>
            {current ? (
              <span className={styles.tipStatus} data-status={current.status}>
                <StatusDot tone={toneForSource(current.status)} size={8} glow={false} />
                {statusLabel(current.status)}
              </span>
            ) : (
              <span className={styles.tipStatus}>Loading</span>
            )}
          </p>
          {current ? (
            <p className={styles.tipMeta}>
              {current.updatedAt ? (
                <>
                  Last updated <span className="num">{relativeTime(current.updatedAt, now)}</span>
                </>
              ) : (
                "No successful update yet"
              )}
            </p>
          ) : null}
          {current?.message ? <p className={styles.tipMessage}>{current.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
    </svg>
  );
}

/** Turns hover help (ui/TipLayer) on or off for this browser. */
function TipsSwitch() {
  const on = useTipsEnabled();
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<HelpIcon />}
      aria-pressed={on}
      onClick={() => setTipsEnabled(!on)}
      tip={on ? "Turns off these explanations when you hover over controls." : undefined}
    >
      {on ? "Hover help on" : "Hover help off"}
    </Button>
  );
}

export function Header({ route }: { route: Route }) {
  const snap = useSnapshot();
  const { openCheckin } = useCheckin();
  const now = useNow(30_000);
  const data = snap.data;
  const checkedIn = data?.personal.checkedInToday ?? false;

  return (
    <header className={styles.header}>
      <div className={styles.top}>
        <div className={styles.intro}>
          <h1 className={styles.greeting}>
            {greeting(now.getHours())}, {USER_NAME}
          </h1>
          <p className={styles.date}>
            <time dateTime={dayKey(now)}>{formatLongDate(now)}</time>
          </p>
        </div>

        <div className={styles.actions}>
          <p className={styles.updated}>
            {snap.collecting ? (
              "Collecting from every source"
            ) : data ? (
              <>
                Updated <time dateTime={data.generatedAt}>{relativeTime(data.generatedAt, now)}</time>
              </>
            ) : snap.loading ? (
              "Loading"
            ) : null}
          </p>
          <TipsSwitch />
          <ThemeSwitch />
          <Button
            icon={<RefreshIcon />}
            loading={snap.collecting}
            loadingLabel="Refreshing"
            onClick={() => void snap.collect()}
            tip="Re-reads all 7 sources now, from GitHub to Calendar; panels update when it finishes."
          >
            Refresh
          </Button>
          <Button
            icon={checkedIn ? <CheckIcon /> : <PlusIcon />}
            onClick={() => openCheckin()}
            tip={
              checkedIn
                ? "Opens today's saved check-in to change it; saving again replaces it."
                : "Logs today's sleep, energy, mood, workout and spend in about 30 seconds."
            }
          >
            {checkedIn ? "Edit check-in" : "Check in"}
          </Button>
        </div>
      </div>

      <div className={styles.bar}>
        <nav className={styles.views} aria-label="View">
          {VIEWS.map(({ key, href, label, tip }) => (
            <a key={key} href={href} className={styles.view} aria-current={route === key ? "page" : undefined} data-tip={tip}>
              {route === key ? (
                <motion.span
                  layoutId="view-switch-pill"
                  className={styles.viewPill}
                  transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
                />
              ) : null}
              <span className={styles.viewLabel}>{label}</span>
            </a>
          ))}
        </nav>
        <SourceStatusBar sources={data?.sources ?? null} now={now} />
      </div>
    </header>
  );
}
