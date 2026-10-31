import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NeedsYouItem } from "../../../shared/types";
import { MOTION } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { areaLabel, sourceLabel } from "../lib/format";
import {
  dueLabel,
  dueRemaining,
  NEEDS_YOU_CAP,
  needsYouCoverage,
  needsYouOverflow,
  newSinceLastVisit,
  parseSeenIds,
  rankNeedsYou,
  urgencyCounts,
} from "../lib/kpis";
import { EmptyState } from "../ui/EmptyState";
import { Panel, panelFromSource } from "../ui/Panel";
import { StatusDot, toneForUrgency } from "../ui/StatusDot";
import styles from "./NeedsYouStrip.module.css";

// Full-width strip at the top of Home: "what is on fire". One card per snapshot.needsYou item,
// red (act today) before amber (this week). Each card carries a glyph plus a text label, so urgency
// never rests on colour alone. Cards new since the last visit pulse once and keep a "New" tag.
// Past 8 items the header says "+N more not shown" as plain text: the server caps the list, so those
// items are not on this page to link to.

const SEEN_KEY = "life-dashboard:needs-you-seen";

const URGENCY_LABEL = { red: "Act today", amber: "This week" } as const;

const fullDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function readSeen(): string[] | null {
  try {
    return parseSeenIds(window.localStorage.getItem(SEEN_KEY));
  } catch {
    return null;
  }
}

function writeSeen(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    // Private window or blocked storage: nothing pulses next time, nothing breaks.
  }
}

/** Current time, re-read every `everyMs` so due labels stay true while the page is open. */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * Ids that were not on screen at the last visit (or at the previous poll while the page stays open).
 * Remembers the current ids for next time. The first visit ever marks nothing as new.
 */
function useFreshIds(ids: readonly string[] | null): ReadonlySet<string> {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const previous = useRef<readonly string[] | null | undefined>(undefined);
  const signature = ids ? ids.join("\n") : null;

  useEffect(() => {
    if (!ids) return;
    if (previous.current === undefined) previous.current = readSeen();
    const next = newSinceLastVisit(ids, previous.current);
    previous.current = ids;
    writeSeen(ids);
    if (next.size > 0) setFresh(next);
    // `signature` stands for `ids`: re-run only when the set of ids changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return fresh;
}

function ExternalIcon() {
  return (
    <svg className={styles.extIcon} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M6.5 3.5H3.5v9h9v-3M9 3h4v4M13 3 7.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Readable names for the sites links go to. Anything else shows its host name. */
const SITE_NAMES: readonly [RegExp, string][] = [
  [/(^|\.)github\.com$/, "GitHub"],
  [/(^|\.)atlassian\.net$/, "Jira"],
  [/(^|\.)gitlab\.com$/, "GitLab"],
  [/^calendar\.google\.com$/, "Google Calendar"],
  [/^mail\.google\.com$/, "Gmail"],
];

/**
 * Hover help for a link to a source item, without the full stop: "Opens it on GitHub in a new tab",
 * "Opens it on the Projects page". Shared by Needs you and Next moves.
 */
export function opensIn(url: string): string {
  if (url.startsWith("#")) {
    if (url.startsWith("#/projects")) return "Opens it on the Projects page of this dashboard";
    if (url.startsWith("#/notes")) return "Opens the note in the Notes view of this dashboard";
    return "Opens it here in the dashboard";
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const site = SITE_NAMES.find(([re]) => re.test(host))?.[1] ?? host;
    return `Opens it on ${site} in a new tab`;
  } catch {
    return "Opens it in a new tab";
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function NeedCard({ item, index, now, fresh }: { item: NeedsYouItem; index: number; now: Date; fresh: boolean }) {
  const due = dueLabel(item.dueAt, now);
  const left = dueRemaining(item.dueAt, now);
  const overdue = due?.startsWith("Overdue") ?? false;
  const delay = Math.min(index, 10) * MOTION.stagger;
  // The link covers the whole card, so its tip also carries the exact due time.
  const tip = item.url
    ? `${opensIn(item.url)}${item.dueAt ? `; due ${fullDate.format(new Date(item.dueAt))}` : ""}.`
    : undefined;

  return (
    <motion.li
      className={[styles.card, styles[item.urgency], fresh ? styles.fresh : ""].filter(Boolean).join(" ")}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOTION.base, ease: MOTION.easeOut, delay }}
    >
      <div className={styles.cardHead}>
        <span className={styles.urgency}>
          <StatusDot tone={toneForUrgency(item.urgency)} size={10} pulse={fresh} />
          <span>{URGENCY_LABEL[item.urgency]}</span>
        </span>
        {fresh ? <span className={styles.newTag}>New</span> : null}
        <span className={styles.area}>{areaLabel(item.area)}</span>
      </div>

      <h3 className={styles.cardTitle} title={item.url ? undefined : item.title}>
        {item.url ? (
          <a
            className={styles.cardLink}
            href={item.url}
            data-tip={tip}
            {...(item.url?.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
          >
            <span className={styles.clamp}>{item.title}</span>
            {item.url?.startsWith("#") ? null : (
              <>
                <span className="sr-only"> (opens in a new tab)</span>
                <ExternalIcon />
              </>
            )}
          </a>
        ) : (
          <span className={styles.clamp}>{item.title}</span>
        )}
      </h3>

      {item.detail ? (
        <p className={styles.detail} title={item.url ? undefined : item.detail}>
          {item.detail}
        </p>
      ) : null}

      {due && item.dueAt ? (
        <div className={styles.due}>
          <time
            className={[styles.dueText, overdue ? styles.overdue : ""].filter(Boolean).join(" ")}
            dateTime={item.dueAt}
            title={item.url ? undefined : fullDate.format(new Date(item.dueAt))}
          >
            {due}
          </time>
          {left !== null ? (
            <span className={styles.fuse} aria-hidden="true">
              <motion.span
                className={styles.fuseFill}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: Math.max(left, 0.03) }}
                transition={{ duration: MOTION.draw, ease: MOTION.easeOut, delay: 0.1 + delay }}
              />
            </span>
          ) : null}
        </div>
      ) : null}
    </motion.li>
  );
}

/** The calm all-clear: a runway that draws itself in once, then what was not checked. */
function AllClear({ unchecked }: { unchecked: string[] }) {
  return (
    <div className={styles.clear}>
      <EmptyState
        tone="ok"
        title="Nothing urgent. Clear runway."
        body={unchecked.length ? `Not checked: ${joinNames(unchecked)}.` : undefined}
      />
      <svg className={styles.runway} viewBox="0 0 400 14" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line className={styles.runwayEdge} x1="0" y1="2" x2="400" y2="2" />
        <line className={styles.runwayCenter} x1="0" y1="7" x2="400" y2="7" />
        <line className={styles.runwayEdge} x1="0" y1="12" x2="400" y2="12" />
      </svg>
    </div>
  );
}

export function NeedsYouStrip() {
  const snap = useSnapshot();
  const now = useNow(60_000);
  const data = snap.data;

  const ranked = useMemo(() => rankNeedsYou(data?.needsYou), [data]);
  const shown = ranked.slice(0, NEEDS_YOU_CAP);
  const more = data ? needsYouOverflow(shown.length, data.needsYouTotal, ranked.length) : 0;
  const fresh = useFreshIds(data ? shown.map((i) => i.id) : null);
  const counts = urgencyCounts(shown);
  const freshCount = shown.filter((i) => fresh.has(i.id)).length;

  const status = panelFromSource(snap, null, {
    isEmpty: (s) => rankNeedsYou(s.needsYou).length === 0,
    empty: "Nothing urgent. Clear runway.",
  });
  const coverage = data ? needsYouCoverage(data.sources) : null;

  let state = status.state;
  let body: ReactNode = null;
  if (status.state === "empty" && coverage) {
    // An all-clear is only true for sources that were actually read.
    state = "ok";
    body =
      coverage.checked.length === 0 ? (
        <EmptyState
          tone="idle"
          title="Nothing checked yet."
          body="Press Refresh at the top to collect Jira, GitHub, learning and check-ins."
        />
      ) : (
        <AllClear unchecked={coverage.unchecked.map(sourceLabel)} />
      );
  } else if (status.state === "ok") {
    body = (
      <ul className={styles.cards} role="list">
        {shown.map((item, i) => (
          <NeedCard key={item.id} item={item} index={i} now={now} fresh={fresh.has(item.id)} />
        ))}
      </ul>
    );
  }

  const meta =
    status.state === "ok" && shown.length > 0 ? (
      <span className={styles.meta}>
        {counts.red > 0 ? (
          <span className={styles.metaCount}>
            <StatusDot tone="danger" size={9} glow={false} />
            <span>{counts.red}</span>
            <span className="sr-only"> to act on today</span>
          </span>
        ) : null}
        {counts.amber > 0 ? (
          <span className={styles.metaCount}>
            <StatusDot tone="warn" size={9} glow={false} />
            <span>{counts.amber}</span>
            <span className="sr-only"> this week</span>
          </span>
        ) : null}
        {freshCount > 0 ? <span className={styles.metaNew}>{freshCount} new</span> : null}
      </span>
    ) : undefined;

  // Plain text, not a link: the server sends only the first 8 items, so the rest cannot be shown anywhere.
  const action =
    more > 0 ? (
      <p className={styles.more}>
        <span className="num">+{more.toLocaleString("en-US")}</span> more not shown
      </p>
    ) : undefined;

  return (
    <Panel
      title="Needs you"
      fit
      state={state}
      message={status.message}
      hint={status.hint}
      onRetry={status.onRetry}
      retrying={status.retrying}
      skeleton="cards"
      meta={meta}
      action={action}
    >
      {body}
    </Panel>
  );
}
