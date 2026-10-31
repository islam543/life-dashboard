import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MOTION } from "../hooks/useReducedMotion";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { CloseIcon } from "./icons";
import styles from "./Toasts.module.css";

// Short messages at the bottom of the Projects view: what just happened, with at most one action
// (Undo, Open). Polite live region, so screen readers hear them without losing their place.
// Each toast closes after `duration` (5 s by default, 8 s for errors); the timer pauses while the
// pointer or focus is on a toast. A toast's onExpire runs once when it leaves without its action
// being used (timeout, close button, pushed out by newer toasts, or the view closing), which is how
// a deferred delete gets committed. Ctrl+Z outside a text field runs the newest Undo.

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onAction: () => void };
  /** Milliseconds on screen. Default 5000, errors 8000. */
  duration?: number;
  onExpire?: () => void;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_TOASTS = 3;

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const live = useRef<Toast[]>([]);
  const timers = useRef(new Map<number, { left: number; started: number; handle: number | null }>());
  const paused = useRef(false);
  const seq = useRef(0);

  const remove = useCallback((id: number, ran: "action" | "expire") => {
    const toast = live.current.find((t) => t.id === id);
    if (!toast) return;
    live.current = live.current.filter((t) => t.id !== id);
    const timer = timers.current.get(id);
    if (timer?.handle) window.clearTimeout(timer.handle);
    timers.current.delete(id);
    setToasts(live.current);
    if (ran === "expire") toast.onExpire?.();
  }, []);

  const startTimer = useCallback(
    (id: number) => {
      const timer = timers.current.get(id);
      if (!timer || timer.handle !== null || paused.current) return;
      timer.started = Date.now();
      timer.handle = window.setTimeout(() => remove(id, "expire"), timer.left);
    },
    [remove],
  );

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++seq.current;
      const toast: Toast = { ...input, id };
      const overflow = live.current.length + 1 - MAX_TOASTS;
      const pushedOut = overflow > 0 ? live.current.slice(0, overflow) : [];
      live.current = [...live.current.slice(Math.max(0, overflow)), toast];
      setToasts(live.current);
      timers.current.set(id, { left: input.duration ?? (input.tone === "error" ? 8000 : 5000), started: 0, handle: null });
      startTimer(id);
      for (const old of pushedOut) {
        const timer = timers.current.get(old.id);
        if (timer?.handle) window.clearTimeout(timer.handle);
        timers.current.delete(old.id);
        old.onExpire?.();
      }
      return id;
    },
    [startTimer],
  );

  const dismiss = useCallback((id: number) => remove(id, "expire"), [remove]);

  const pause = useCallback(() => {
    if (paused.current) return;
    paused.current = true;
    for (const timer of timers.current.values()) {
      if (timer.handle === null) continue;
      window.clearTimeout(timer.handle);
      timer.handle = null;
      timer.left = Math.max(1200, timer.left - (Date.now() - timer.started));
    }
  }, []);

  const resume = useCallback(() => {
    if (!paused.current) return;
    paused.current = false;
    for (const id of timers.current.keys()) startTimer(id);
  }, [startTimer]);

  // Leaving the view: every toast that is still up counts as expired (commits deferred deletes).
  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const timer of timerMap.values()) if (timer.handle) window.clearTimeout(timer.handle);
      timerMap.clear();
      const left = live.current;
      live.current = [];
      for (const t of left) t.onExpire?.();
    };
  }, []);

  // Ctrl+Z (Cmd+Z) runs the newest Undo, so keyboard users need not Tab down to the toast. Text fields
  // keep their own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      const last = [...live.current].reverse().find((t) => t.action?.label === "Undo");
      if (!last?.action) return;
      e.preventDefault();
      const action = last.action;
      remove(last.id, "action");
      action.onAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remove]);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        className={styles.region}
        aria-label="Notifications"
        onPointerEnter={pause}
        onPointerLeave={resume}
        onFocus={pause}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume();
        }}
      >
        <ol className={styles.list} aria-live="polite" aria-relevant="additions">
          <AnimatePresence initial={false}>
            {toasts.map((t) => (
              <motion.li
                key={t.id}
                layout="position"
                className={styles.toast}
                data-tone={t.tone ?? "info"}
                role={t.tone === "error" ? "alert" : undefined}
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: MOTION.fast } }}
                transition={{ duration: MOTION.base, ease: MOTION.easeOut }}
              >
                <StatusDot tone={t.tone === "error" ? "danger" : "ok"} size={9} glow={t.tone !== "info"} />
                <p className={styles.message}>{t.message}</p>
                {t.action ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className={styles.action}
                    title={t.action.label === "Undo" ? "Undo (Ctrl+Z)" : undefined}
                    aria-keyshortcuts={t.action.label === "Undo" ? "Control+Z" : undefined}
                    onClick={() => {
                      const action = t.action;
                      remove(t.id, "action");
                      action?.onAction();
                    }}
                  >
                    {t.action.label}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<CloseIcon />}
                  className={styles.close}
                  aria-label="Close message"
                  onClick={() => remove(t.id, "expire")}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </section>
    </ToastContext.Provider>
  );
}
