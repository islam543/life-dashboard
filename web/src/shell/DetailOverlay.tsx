import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useRef, useState, type ComponentType } from "react";
import type { Area } from "../../../shared/types";
import { TILE_LAYOUT_TRANSITION, useDetail, type DetailProps } from "../context/DetailContext";
import { CalendarDetail } from "../details/CalendarDetail";
import { LearningDetail } from "../details/LearningDetail";
import { PersonalDetail } from "../details/PersonalDetail";
import { CopyNotice } from "../details/rowMenu";
import { WorkDetail } from "../details/WorkDetail";
import { MOTION } from "../hooks/useReducedMotion";
import { detailTitle } from "../lib/format";
import { Button } from "../ui/Button";
import { useMenuRegion } from "../ui/ContextMenu";
import { PANEL_RADIUS } from "../ui/Panel";
import { StatusDot } from "../ui/StatusDot";
import noticeStyles from "../details/rowMenu.module.css";
import styles from "./DetailOverlay.module.css";

// Explore mode. Renders the open area's details/* view in a modal card. When the opener passed a
// layoutId, the card shares it, so the tile grows into the card and shrinks back on close.
// Closes on Escape, a backdrop click and the Back button; focus returns to the opener.
// The overlay owns the title and Back control; detail views render their body only.
// Right-click anywhere in it (backdrop included) offers Close. Rows that copy a link report the result
// through CopyNotice: a pill at the bottom of the card for a moment, also read out by screen readers.

const VIEWS: Record<Area, ComponentType<DetailProps>> = {
  work: WorkDetail,
  learning: LearningDetail,
  personal: PersonalDetail,
  calendar: CalendarDetail,
  email: CalendarDetail,
};

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M9.5 3.5 5 8l4.5 4.5M5.5 8H13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CLOSE_TIP = "Closes these details and returns to where you opened them; Esc does the same.";
const NOTICE_MS = 2500;

function OverlayCard({ area, layoutId, onClose }: { area: Area; layoutId: string | null; onClose: () => void }) {
  const titleId = `detail-${useId().replace(/:/g, "")}`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const View = VIEWS[area];
  const title = detailTitle(area);
  const menu = useMenuRegion(() => ({ title, items: [{ label: "Close", hint: "Esc", onSelect: onClose, tip: CLOSE_TIP }] }));

  // Result of the last "Copy link", shown for a moment in place of the Esc hint.
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((text: string, ok: boolean) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, ok });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Focus the heading (long, structured content), lock page scroll, close on Escape.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return; // a dialog on top (check-in) closes first
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      root.style.overflow = previous;
    };
  }, [onClose]);

  const morph = layoutId !== null;
  const fade = { opacity: 0, scale: 0.97, y: 8 };

  return (
    <div className={styles.root} {...menu}>
      <motion.div
        className={styles.backdrop}
        aria-hidden="true"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: MOTION.fast, ease: MOTION.easeIn } }}
        transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.card}
        style={{ borderRadius: PANEL_RADIUS }}
        layoutId={layoutId ?? undefined}
        initial={morph ? undefined : fade}
        animate={morph ? undefined : { opacity: 1, scale: 1, y: 0 }}
        exit={morph ? { opacity: 0 } : fade}
        transition={
          morph
            ? { ...TILE_LAYOUT_TRANSITION, opacity: { duration: MOTION.slow, ease: MOTION.easeIn } }
            : { duration: MOTION.base, ease: MOTION.easeOut }
        }
      >
        <motion.div
          className={styles.inner}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: MOTION.base, delay: morph ? MOTION.slow * 0.6 : 0.05 } }}
          exit={{ opacity: 0, transition: { duration: MOTION.fast * 0.6 } }}
        >
          <header className={styles.head}>
            <Button
              variant="ghost"
              size="sm"
              icon={<BackIcon />}
              onClick={onClose}
              className={styles.back}
              tip={CLOSE_TIP}
            >
              Back
            </Button>
            <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.title}>
              {title}
            </h2>
            <span className={styles.hint} aria-hidden="true">
              <kbd>Esc</kbd> to close
            </span>
          </header>
          <div className={styles.body}>
            <CopyNotice.Provider value={say}>
              <View area={area} />
            </CopyNotice.Provider>
          </div>
          {notice ? (
            <p className={noticeStyles.notice} aria-hidden="true">
              <StatusDot tone={notice.ok ? "ok" : "danger"} size={8} glow={false} />
              <span>{notice.text}</span>
            </p>
          ) : null}
          <span className="sr-only" role="status" aria-live="polite">
            {notice?.text ?? ""}
          </span>
        </motion.div>
      </motion.div>
    </div>
  );
}

export function DetailOverlay() {
  const { openArea, openLayoutId, closeDetail, restoreFocus } = useDetail();
  return (
    <AnimatePresence onExitComplete={restoreFocus}>
      {openArea ? (
        <OverlayCard
          key={`${openArea}:${openLayoutId ?? ""}`}
          area={openArea}
          layoutId={openLayoutId}
          onClose={closeDetail}
        />
      ) : null}
    </AnimatePresence>
  );
}
