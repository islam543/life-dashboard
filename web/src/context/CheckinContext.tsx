import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { dayKey } from "../lib/format";

// The daily check-in dialog, opened from anywhere (header button, Personal detail "Check in now").
// shell/AppShell always renders <CheckinDialog />; the dialog reads this context to know whether it
// is open and for which day, and calls closeCheckin() when done. After a successful POST /api/checkin,
// pass the returned Snapshot to useSnapshot().replace(), then call closeCheckin().

export interface CheckinContextValue {
  isOpen: boolean;
  /** Day the dialog opens on, "YYYY-MM-DD" (local). Today unless the opener asked for another day. */
  date: string;
  /** Open the dialog, optionally on a past day. Remembers the focused element. */
  openCheckin: (date?: string) => void;
  /** Close the dialog and return focus to the element that opened it. */
  closeCheckin: () => void;
}

const CheckinContext = createContext<CheckinContextValue | null>(null);

export function CheckinProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ isOpen: boolean; date: string }>(() => ({
    isOpen: false,
    date: dayKey(new Date()),
  }));
  const opener = useRef<HTMLElement | null>(null);

  const openCheckin = useCallback((date?: string) => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setState({ isOpen: true, date: date ?? dayKey(new Date()) });
  }, []);

  const closeCheckin = useCallback(() => {
    setState((s) => (s.isOpen ? { ...s, isOpen: false } : s));
    const el = opener.current;
    opener.current = null;
    // After the dialog has left the top layer, so the browser does not move focus again.
    requestAnimationFrame(() => {
      if (el && el.isConnected) el.focus({ preventScroll: true });
    });
  }, []);

  const value = useMemo<CheckinContextValue>(
    () => ({ isOpen: state.isOpen, date: state.date, openCheckin, closeCheckin }),
    [state, openCheckin, closeCheckin],
  );

  return <CheckinContext.Provider value={value}>{children}</CheckinContext.Provider>;
}

/** `{ isOpen, date, openCheckin(date?), closeCheckin() }` */
export function useCheckin(): CheckinContextValue {
  const ctx = useContext(CheckinContext);
  if (!ctx) throw new Error("useCheckin must be used inside <CheckinProvider>");
  return ctx;
}
