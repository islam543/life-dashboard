import { AnimatePresence, motion, type Variants } from "motion/react";
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { NextMove } from "../../../shared/types";
import { MOTION } from "../hooks/useReducedMotion";
import { useNextMoves } from "../hooks/useNextMoves";
import { areaLabel, relativeTime } from "../lib/format";
import { openMoves } from "../lib/kpis";
import { Button, Spinner } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Panel, type PanelState } from "../ui/Panel";
import { SkeletonRows } from "../ui/Skeleton";
import { StatusDot } from "../ui/StatusDot";
import { opensIn } from "./NeedsYouStrip";
import styles from "./NextMovesPanel.module.css";

// AI next moves, in the violet accent. A ranked route of steps: the first node glows as "Next".
// Data comes from useNextMoves(); the file's status drives the state, not panelFromSource:
//   never_run      "Generate next moves"
//   running        skeleton plus "Thinking through your day" (also while the POST is in flight)
//   not_logged_in  the exact terminal step, then Try again
//   error          what failed and Try again; earlier moves stay visible under a notice
//   ok             the ranked list, Done and Dismiss animate the move out

type Exit = "done" | "dismissed";
type LastAction = "run" | Exit;

const ACTION_FAILED: Record<LastAction, string> = {
  run: "Couldn't start a run.",
  done: "Couldn't mark that move done.",
  dismissed: "Couldn't dismiss that move.",
};

/** Current time, re-read every `everyMs` so "Generated 2 h ago" stays true. */
function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6zM13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"
        fill="currentColor"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
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

/**
 * Why this move, up to 4 lines. When it runs longer, a "Show full reason" button (keyboard and touch,
 * no hover needed) opens the rest in place. Screen readers always get the full text.
 */
function Reason({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = `reason-${useId().replace(/:/g, "")}`;
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  // Re-measured on resize and once web fonts load (wrapping changes, the clamped box may not) while
  // closed; once open, the button stays so it can close again.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    let live = true;
    const measure = () => {
      if (live) setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    void document.fonts?.ready.then(measure);
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [open, text]);

  return (
    <div className={styles.reasonBox}>
      <p ref={ref} id={id} className={[styles.reason, open ? styles.reasonOpen : ""].filter(Boolean).join(" ")}>
        {text}
      </p>
      {clipped || open ? (
        <button
          type="button"
          className={styles.reasonToggle}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          data-tip={open ? "Shortens the reason back to 4 lines." : "Shows the rest of why Claude ranked this move here."}
        >
          {open ? "Show less" : "Show full reason"}
        </button>
      ) : null}
    </div>
  );
}

function Running() {
  return (
    <div className={styles.running}>
      <p className={styles.runningLine}>
        <span className={styles.runningIcon}>
          <Spinner size={14} />
        </span>
        <span>Thinking through your day</span>
      </p>
      <SkeletonRows count={3} />
    </div>
  );
}

function ActionError({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className={styles.actionError} role="alert">
      <StatusDot tone="danger" size={9} glow={false} />
      <p>{message}</p>
      <Button
        variant="ghost"
        size="sm"
        icon={<CloseIcon />}
        onClick={onClose}
        aria-label="Hide this message"
        tip="Hides this message; the list stays as it is."
      />
    </div>
  );
}

interface MoveRowProps {
  move: NextMove;
  index: number;
  exits: Record<string, Exit>;
  onSet: (move: NextMove, next: Exit) => void;
  registerFocus: (id: string, el: HTMLButtonElement | null) => void;
}

const MoveRow = forwardRef<HTMLLIElement, MoveRowProps>(function MoveRow({ move, index, exits, onSet, registerFocus }, ref) {
  const first = index === 0;
  // The exit reads the latest `exits` through AnimatePresence's `custom`, so Done and Dismiss leave differently.
  const variants: Variants = {
    hidden: { opacity: 0, x: -8 },
    shown: {
      opacity: 1,
      x: 0,
      transition: { duration: MOTION.base, ease: MOTION.easeOut, delay: Math.min(index, 8) * MOTION.stagger },
    },
    exit: (kinds: Record<string, Exit>) =>
      kinds[move.id] === "done"
        ? { opacity: 0, x: 36, transition: { duration: MOTION.slow, ease: MOTION.easeIn } }
        : { opacity: 0, scale: 0.96, transition: { duration: MOTION.base, ease: MOTION.easeIn } },
  };

  return (
    <motion.li
      ref={ref}
      layout="position"
      className={[styles.move, first ? styles.first : ""].filter(Boolean).join(" ")}
      variants={variants}
      initial="hidden"
      animate="shown"
      exit="exit"
      custom={exits}
    >
      <span className={styles.node} aria-hidden="true">
        <span className={styles.rank}>{String(index + 1).padStart(2, "0")}</span>
      </span>

      <div className={styles.moveBody}>
        <div className={styles.moveHead}>
          {first ? <span className={styles.nextTag}>Next</span> : null}
          <span className={styles.area}>{areaLabel(move.area)}</span>
        </div>
        <h3 className={styles.moveTitle} title={move.sourceUrl ? undefined : move.title}>
          {move.sourceUrl ? (
            <a
              className={styles.moveLink}
              href={move.sourceUrl}
              data-tip={`${opensIn(move.sourceUrl)}.`}
              {...(move.sourceUrl?.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            >
              <span className={styles.clamp}>{move.title}</span>
              {move.sourceUrl?.startsWith("#") ? null : (
                <>
                  <span className="sr-only"> (opens in a new tab)</span>
                  <ExternalIcon />
                </>
              )}
            </a>
          ) : (
            <span className={styles.clamp}>{move.title}</span>
          )}
        </h3>
        {move.reason ? <Reason text={move.reason} /> : null}
      </div>

      <div className={styles.moveActions}>
        <Button
          ref={(el) => registerFocus(move.id, el)}
          variant="ghost"
          size="sm"
          icon={<CheckIcon />}
          className={styles.done}
          onClick={() => onSet(move, "done")}
          aria-label={`Done: ${move.title}`}
          tip="Marks this move done and takes it off the list; new runs skip it for 7 days."
        >
          Done
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<CloseIcon />}
          className={styles.dismiss}
          onClick={() => onSet(move, "dismissed")}
          aria-label={`Dismiss: ${move.title}`}
          tip="Hides this move without doing it; new runs skip it for 7 days."
        >
          Dismiss
        </Button>
      </div>
    </motion.li>
  );
});

export function NextMovesPanel() {
  const nm = useNextMoves();
  const now = useNow(60_000);
  const file = nm.data;
  const moves = openMoves(file?.moves);
  const running = nm.starting || file?.status === "running";

  const exits = useRef<Record<string, Exit>>({});
  const doneButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const rerunRef = useRef<HTMLButtonElement>(null);
  const [lastAction, setLastAction] = useState<LastAction>("run");
  const [announcement, setAnnouncement] = useState("");

  const registerFocus = (id: string, el: HTMLButtonElement | null) => {
    if (el) doneButtons.current.set(id, el);
    else doneButtons.current.delete(id);
  };

  const run = () => {
    setLastAction("run");
    setAnnouncement("Generating next moves.");
    void nm.run();
  };

  const setMove = (move: NextMove, next: Exit) => {
    const at = moves.findIndex((m) => m.id === move.id);
    const neighbour = moves[at + 1] ?? moves[at - 1] ?? null;
    exits.current = { ...exits.current, [move.id]: next };
    pendingFocus.current = neighbour ? neighbour.id : "";
    setLastAction(next);
    setAnnouncement(next === "done" ? `Done: ${move.title}.` : `Dismissed: ${move.title}.`);
    void nm.setState(move.id, next);
  };

  // The button that was clicked leaves with its row: move focus to the neighbour's Done, or to Re-run.
  const openIds = moves.map((m) => m.id).join("\n");
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = target ? doneButtons.current.get(target) : rerunRef.current;
    el?.focus({ preventScroll: true });
  }, [openIds]);

  // Announce when a run finishes.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && file) {
      if (file.status === "ok") setAnnouncement(`Next moves ready: ${moves.length}.`);
      else if (file.status === "not_logged_in") setAnnouncement("Claude is not logged in.");
      else if (file.status === "error") setAnnouncement("Generating next moves failed.");
    }
    wasRunning.current = running;
  }, [running, file, moves.length]);

  const actionError = nm.actionError ? (
    <ActionError message={`${ACTION_FAILED[lastAction]} ${nm.actionError}`} onClose={nm.clearActionError} />
  ) : null;

  let state: PanelState = "ok";
  let message: string | undefined;
  let hint: string | undefined;
  let onRetry: (() => void) | undefined;
  let notice: string | undefined;
  let body: ReactNode = null;
  let showRerun = false;
  // "Generated 2 h ago" dates the moves on screen, so it shows only next to a list.
  let showGenerated = false;

  if (!file) {
    if (nm.error && !nm.loading) {
      state = "error";
      message = "Couldn't load next moves.";
      hint = nm.error;
      onRetry = () => void nm.refresh();
    } else {
      state = "loading";
    }
  } else if (running) {
    body = <Running />;
    showRerun = file.status !== "never_run";
  } else if (file.status === "never_run") {
    body = (
      <EmptyState
        tone="ai"
        title="Your ranked next steps appear here."
        body="Claude reads your tickets, pull requests and learning, then picks what to do first and why."
        action={
          <Button
            variant="primary"
            icon={<SparkIcon />}
            onClick={run}
            tip="Asks Claude to rank your next steps from your tickets, pull requests and learning."
          >
            Generate next moves
          </Button>
        }
      />
    );
  } else if (file.status === "not_logged_in") {
    body = (
      <div className={styles.problem}>
        <p className={styles.problemTitle}>
          <StatusDot tone="off" size={10} glow={false} />
          <span>Claude is not logged in.</span>
        </p>
        <p className={styles.instruction}>
          Run <code className={styles.code}>claude</code> in a terminal and log in.
        </p>
        <p className={styles.problemHint}>Then try again here.</p>
        <Button
          variant="ai"
          size="sm"
          icon={<SparkIcon />}
          onClick={run}
          tip="Runs Claude again; log in first by running claude in a terminal."
        >
          Try again
        </Button>
      </div>
    );
  } else if (file.status === "error" && moves.length === 0) {
    state = "error";
    message = "Couldn't generate next moves.";
    hint = file.message ?? "The last run failed.";
    onRetry = run;
  } else if (moves.length === 0) {
    showRerun = true;
    body = (
      <EmptyState tone="ai" title="All moves cleared." body="Re-run to get fresh suggestions from your latest data." />
    );
  } else {
    showRerun = true;
    showGenerated = true;
    if (file.status === "error") {
      const why = file.message ? ` ${file.message.trim().replace(/\.?$/, ".")}` : "";
      notice = `Last run failed.${why} Showing moves from ${relativeTime(file.generatedAt, now)}.`;
    }
    body = (
      <ol className={styles.list}>
        <AnimatePresence mode="popLayout" initial={false} custom={exits.current}>
          {moves.map((move, i) => (
            <MoveRow
              key={move.id}
              move={move}
              index={i}
              exits={exits.current}
              onSet={setMove}
              registerFocus={registerFocus}
            />
          ))}
        </AnimatePresence>
      </ol>
    );
  }

  const meta =
    showGenerated && file?.generatedAt ? (
      <time dateTime={file.generatedAt} title={new Date(file.generatedAt).toLocaleString("en-GB")}>
        Generated {relativeTime(file.generatedAt, now)}
      </time>
    ) : undefined;

  const action = showRerun ? (
    <Button
      ref={rerunRef}
      variant="ai"
      size="sm"
      icon={<SparkIcon />}
      loading={running}
      loadingLabel="Running"
      onClick={run}
      tip={
        running
          ? "Claude is ranking your moves now; the list updates when it finishes."
          : "Asks Claude for a new ranked list from your latest data; if it fails, these stay."
      }
    >
      Re-run
    </Button>
  ) : undefined;

  return (
    <>
      <Panel
        title="Next moves"
        tone="ai"
        fit
        state={state}
        message={message}
        hint={hint}
        onRetry={onRetry}
        retrying={running}
        retryTip={file ? "Runs Claude again to rank your next moves." : "Loads the saved next moves from the local server again."}
        notice={notice}
        skeleton="rows"
        meta={meta}
        action={action}
      >
        {actionError}
        {body}
      </Panel>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
