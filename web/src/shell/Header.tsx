import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Area, Snapshot, SourceStatus } from "../../../shared/types";
import { useCheckin } from "../context/CheckinContext";
import { tileLayoutId, useDetail } from "../context/DetailContext";
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
import { noteHash, parseHash, projectHash, toHash, type View } from "../lib/route";
import { setTipsEnabled, useTipsEnabled } from "../lib/tips";
import { ThemeSwitch } from "./ThemeSwitch";
import { Button } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { detailTip } from "../ui/Panel";
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

// Right-click menus here: the view switch offers "Go to" the other views (the current one is left out
// unless a project or note is open in it); a source dot offers the details that source feeds. Refresh,
// Check in, theme and hover help come from the menu's "everywhere" section, so they are not repeated.

/**
 * The details each source feeds, for its dot's right-click menu. Work keys pick the tab without
 * matching a Home tile, so the view opens in place instead of growing out of an unrelated tile.
 */
const SOURCE_DETAIL: Record<SourceKey, { area: Area; key?: string; label: string }> = {
  github: { area: "work", key: "pull-requests", label: "Open pull requests" },
  jira: { area: "work", key: "issues", label: "Open Jira issues" },
  claudeSessions: { area: "work", key: "sessions", label: "Open time by project" },
  learning: { area: "learning", label: "Open learning details" },
  checkins: { area: "personal", label: "Open personal details" },
  calendar: { area: "calendar", label: "Open agenda" },
  email: { area: "email", label: "Open emails" },
};

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

/** One source's dot. Hover or focus shows its status; right-click offers the details it feeds. */
function SourceDot({
  sourceKey,
  state,
  describedBy,
  onShow,
  onHide,
}: {
  sourceKey: SourceKey;
  state: Snapshot["sources"][SourceKey] | undefined;
  describedBy: string | undefined;
  onShow: (key: SourceKey) => void;
  onHide: () => void;
}) {
  const { openDetail } = useDetail();
  const tone = state ? toneForSource(state.status) : "idle";
  const name = sourceLabel(sourceKey);
  const menu = useMenuRegion(() => {
    const d = SOURCE_DETAIL[sourceKey];
    return {
      title: name,
      items: [
        {
          label: d.label,
          onSelect: () => openDetail(d.area, d.key ? tileLayoutId(d.area, d.key) : undefined),
          tip: detailTip(d.area, d.key),
        },
      ],
    };
  });
  return (
    <li {...menu}>
      <button
        type="button"
        className={styles.source}
        data-status={state?.status ?? "loading"}
        aria-describedby={describedBy}
        aria-label={`${name}: ${state ? statusLabel(state.status) : "loading"}`}
        onMouseEnter={() => onShow(sourceKey)}
        onFocus={() => onShow(sourceKey)}
        onBlur={onHide}
      >
        <StatusDot tone={tone} size={9} glow={tone !== "off" && tone !== "idle"} />
        <span className={styles.sourceName} aria-hidden="true">
          {name}
        </span>
      </button>
    </li>
  );
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
        {SOURCE_KEYS.map((key) => (
          <SourceDot
            key={key}
            sourceKey={key}
            state={sources?.[key]}
            describedBy={active === key ? tipId : undefined}
            onShow={show}
            onHide={hideSoon}
          />
        ))}
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

  // Read at right-click time: inside a project or note, its view's tab still leads back to the top level.
  const viewMenu = useMenuRegion(() => {
    const here = toHash(parseHash(window.location.hash));
    return {
      title: "Views",
      items: VIEWS.map((v) =>
        v.href === here
          ? null
          : {
              label: `Go to ${v.label}`,
              onSelect: () => {
                window.location.hash = v.href;
              },
              tip: v.tip,
            },
      ),
    };
  });

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
        <nav {...viewMenu} className={styles.views} aria-label="View">
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
