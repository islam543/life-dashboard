import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MOTION } from "../hooks/useReducedMotion";
import { matchesQuery } from "../lib/projects";
import { Button, type ButtonVariant } from "../ui/Button";
import styles from "./Picker.module.css";

// A button that opens a small searchable list and picks one option: "Add to project" on an untracked
// name, "Add source" on a project. Combobox pattern: focus goes to the search box, Arrow Up and Down
// move through the options, Enter picks, Escape or Tab closes and focus returns to the button. The
// list stays inside the viewport at phone width.

export interface PickerOption {
  value: string;
  label: string;
  /** Muted second line, e.g. "Session, 2h in 7 days". */
  detail?: string;
  /** Small tag after the label, e.g. "Suggested". */
  badge?: string;
  icon?: ReactNode;
}

export interface PickerProps {
  /** Text on the trigger. */
  label: string;
  /** Accessible name of the trigger when it needs more context than `label` ("Add NFC to a project"). */
  ariaLabel?: string;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Accessible name of the search box, e.g. "Find a project". */
  searchLabel: string;
  options: readonly PickerOption[];
  onPick: (value: string) => void;
  /** Shown when there are no options at all, e.g. "No projects yet." */
  empty: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  /** Hover help on the trigger: what picking does (and, when disabled, why). */
  tip?: string;
}

const VIEWPORT_MARGIN = 12;

export function Picker({
  label,
  ariaLabel,
  icon,
  variant = "secondary",
  size = "sm",
  searchLabel,
  options,
  onPick,
  empty,
  disabled,
  loading,
  className,
  tip,
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [offset, setOffset] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId().replace(/:/g, "");
  const listId = `picker-${uid}-list`;
  const optionId = (i: number) => `picker-${uid}-opt-${i}`;

  const shown = useMemo(
    () => options.filter((o) => matchesQuery(`${o.label} ${o.detail ?? ""}`, query)),
    [options, query],
  );

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    setOffset(null);
    if (refocus) triggerRef.current?.focus();
  };

  // Keep the list inside the viewport: start at the trigger's left edge, shift left when it would spill.
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const pop = popRef.current;
    if (!wrap || !pop) return;
    const w = wrap.getBoundingClientRect();
    const width = pop.offsetWidth;
    const vw = document.documentElement.clientWidth;
    let left = 0;
    if (w.left + width > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - width - w.left;
    if (w.left + left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN - w.left;
    setOffset(left);
  }, [open]);

  // Focus the search box once the list is placed (it is hidden until then, and hidden boxes can't take focus).
  const placed = offset !== null;
  useEffect(() => {
    if (open && placed) inputRef.current?.focus();
  }, [open, placed]);

  // A press outside closes the list without moving focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep the active option in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`);
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const pick = (i: number) => {
    const option = shown[i];
    if (!option) return;
    close(true);
    onPick(option.value);
  };

  return (
    <div
      ref={wrapRef}
      className={[styles.wrap, className].filter(Boolean).join(" ")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <Button
        ref={triggerRef}
        size={size}
        variant={variant}
        icon={icon}
        disabled={disabled}
        loading={loading}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        // While the list is open the tip would cover it.
        tip={open ? undefined : tip}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {label}
      </Button>
      <AnimatePresence>
        {open ? (
          <motion.div
            ref={popRef}
            className={styles.pop}
            style={{ left: offset ?? 0, visibility: offset === null ? "hidden" : "visible" }}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: MOTION.fast } }}
            transition={{ duration: MOTION.fast, ease: MOTION.easeOut }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== triggerRef.current) close(false);
            }}
          >
            {options.length === 0 ? (
              <p className={styles.empty}>{empty}</p>
            ) : (
              <>
                <input
                  ref={inputRef}
                  className={styles.search}
                  type="text"
                  role="combobox"
                  aria-label={searchLabel}
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={shown[active] ? optionId(active) : undefined}
                  placeholder={searchLabel}
                  value={query}
                  spellCheck={false}
                  autoComplete="off"
                  dir="auto"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActive((i) => Math.min(shown.length - 1, i + 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActive((i) => Math.max(0, i - 1));
                    } else if (e.key === "Home") {
                      e.preventDefault();
                      setActive(0);
                    } else if (e.key === "End") {
                      e.preventDefault();
                      setActive(Math.max(0, shown.length - 1));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      pick(active);
                    } else if (e.key === "Tab") {
                      close(false);
                    }
                  }}
                />
                <ul ref={listRef} id={listId} role="listbox" aria-label={searchLabel} className={styles.list}>
                  {shown.length === 0 ? (
                    <li className={styles.none} role="presentation">
                      Nothing matches “{query.trim()}”.
                    </li>
                  ) : (
                    shown.map((o, i) => (
                      <li
                        key={o.value}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === active}
                        className={styles.option}
                        onPointerMove={() => setActive(i)}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => pick(i)}
                      >
                        {o.icon ? <span className={styles.icon}>{o.icon}</span> : null}
                        <span className={styles.text}>
                          <span className={styles.label} dir="auto">
                            {o.label}
                            {o.badge ? <span className={styles.badge}>{o.badge}</span> : null}
                          </span>
                          {o.detail ? <span className={styles.detail}>{o.detail}</span> : null}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
