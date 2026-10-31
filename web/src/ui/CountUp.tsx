import { animate } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { MOTION, useReducedMotion } from "../hooks/useReducedMotion";
import { formatNumber } from "../lib/format";
import styles from "./CountUp.module.css";

// A number that counts up from 0 on first render, and from its old value when it changes (with one
// soft glow so the change is noticed). Mono, tabular digits; width reserved so nothing shifts.
// Reduced motion: shows the final value at once. Screen readers get the final value only.
//
//   <CountUp value={42} />
//   <CountUp value={200} format={formatMinutes} />      -> "3h 20m"
//   <CountUp value={7.25} decimals={1} />               -> "7.3"

export interface CountUpProps {
  value: number;
  /** How to print the number (also used for every frame). Default: grouped with `decimals`. */
  format?: (n: number) => string;
  /** Fraction digits for the default format. Default 0. */
  decimals?: number;
  /** Glow once when the value changes after the first render. Default true. */
  flash?: boolean;
  className?: string;
}

const CHANGE_DURATION = 0.5;

export function CountUp({ value, format, decimals = 0, flash = true, className }: CountUpProps) {
  const reduced = useReducedMotion();
  const textRef = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const settled = useRef(false);
  const print = (n: number) => (format ? format(n) : formatNumber(n, decimals));
  const finalText = print(value);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const from = shown.current ?? 0;
    const first = !settled.current;

    if (reduced || from === value || !Number.isFinite(value)) {
      shown.current = value;
      settled.current = true;
      el.textContent = print(value);
      return;
    }

    el.textContent = print(from);
    if (!first && flash) {
      const host = el.parentElement;
      host?.classList.remove(styles.flash);
      void host?.offsetWidth; // restart the one-shot animation
      host?.classList.add(styles.flash);
    }

    const controls = animate(from, value, {
      duration: first ? MOTION.count : CHANGE_DURATION,
      ease: MOTION.easeOut,
      onUpdate: (v) => {
        shown.current = v;
        el.textContent = print(v);
      },
      onComplete: () => {
        shown.current = value;
        settled.current = true;
        el.textContent = print(value);
      },
    });
    return () => controls.stop();
    // `print` is rebuilt every render; the value and format output are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced, finalText]);

  return (
    <span className={[styles.count, "num", className].filter(Boolean).join(" ")}>
      <span ref={textRef} aria-hidden="true" className={styles.text} style={{ minWidth: `${finalText.length}ch` }} />
      <span className="sr-only">{finalText}</span>
    </span>
  );
}
