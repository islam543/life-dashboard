import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useCheckin } from "../context/CheckinContext";
import { useSnapshot } from "../hooks/useSnapshot";
import { cleanSections, nextEnabled, placeMenu, type CleanSection, type MenuAction, type MenuSection } from "../lib/contextMenu";
import { setTheme, useTheme } from "../lib/theme";
import { setBackdropMotion, useBackdropMotion } from "../lib/motionPref";
import { setTipsEnabled, useTipsEnabled } from "../lib/tips";
import styles from "./ContextMenu.module.css";

// The app's own right-click menu.
//
// A component offers actions for its area with useMenuRegion:
//     const menu = useMenuRegion(() => ({ title: "Ideas", items: [{ label: "Add idea", onSelect: add }] }));
//     <section {...menu}>...</section>
// Right-clicking shows the sections of every region under the pointer, innermost first, then the
// "everywhere" section (refresh, check in, theme, hover help). ContextMenuLayer, mounted once in App,
// draws it.
//
// The browser's own menu still appears in text fields, over selected text (so copy and paste keep
// working), and on Shift + right-click. The menu key and Shift+F10 open ours from the keyboard;
// arrows, Home and End move, Enter or Space picks, Esc closes and returns focus.

type Builder = () => MenuSection | null | undefined;

/** Regions that answered one contextmenu event, innermost first (React bubbles child to parent). */
const collected = new WeakMap<Event, Builder[]>();

/** Props that make an element offer a menu section. Spread them onto any element. */
export function useMenuRegion(build: Builder): { onContextMenu: (e: ReactMouseEvent) => void } {
  const ref = useRef(build);
  ref.current = build;
  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    const list = collected.get(e.nativeEvent) ?? [];
    list.push(() => ref.current());
    collected.set(e.nativeEvent, list);
  }, []);
  return { onContextMenu };
}

function wantsNativeMenu(e: MouseEvent): boolean {
  if (e.shiftKey && e.button === 2) return true;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  return !!window.getSelection()?.toString().trim();
}

function hostFor(el: Element | null): Element {
  const dialogs = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal"));
  const top = dialogs[dialogs.length - 1];
  return top && el && top.contains(el) ? top : document.body;
}

interface Open {
  sections: CleanSection[];
  at: { x: number; y: number };
  host: Element;
  returnFocus: HTMLElement | null;
}

/** The "everywhere" section: actions that make sense on any part of the page. */
function useGlobalSection(): Builder {
  const snap = useSnapshot();
  const { openCheckin } = useCheckin();
  const theme = useTheme();
  const tips = useTipsEnabled();
  const motion = useBackdropMotion();
  const checkedIn = snap.data?.personal.checkedInToday ?? false;
  return () => ({
    items: [
      {
        label: snap.collecting ? "Refreshing" : "Refresh all data",
        onSelect: () => void snap.collect(),
        disabled: snap.collecting ? "Already collecting from every source." : false,
        tip: "Runs every collector now (GitHub, Jira, Claude sessions, learning) and redraws.",
      },
      {
        label: checkedIn ? "Edit today's check-in" : "Check in",
        onSelect: () => openCheckin(),
        tip: "Opens the 30-second daily check-in: sleep, workout, mood and money.",
      },
      {
        label: theme === "dark" ? "Light theme" : "Dark theme",
        onSelect: () => setTheme(theme === "dark" ? "light" : "dark"),
        tip: "Switches the colour theme. Remembered in this browser.",
      },
      {
        label: tips ? "Turn hover help off" : "Turn hover help on",
        onSelect: () => setTipsEnabled(!tips),
        tip: "Shows or hides the explanations that appear when you hover over controls.",
      },
      {
        label: motion ? "Pause background motion" : "Resume background motion",
        onSelect: () => setBackdropMotion(!motion),
        tip: "Stops or starts the moving background and the Life map radar. Remembered in this browser.",
      },
    ],
  });
}

export function ContextMenuLayer() {
  const [open, setOpen] = useState<Open | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const menuRef = useRef<HTMLDivElement>(null);
  const globalSection = useGlobalSection();
  const globalRef = useRef(globalSection);
  globalRef.current = globalSection;
  const openRef = useRef(open);
  openRef.current = open;

  const close = useCallback((restore: boolean) => {
    const current = openRef.current;
    setOpen(null);
    setActive(-1);
    if (restore && current?.returnFocus?.isConnected) current.returnFocus.focus({ preventScroll: true });
  }, []);

  // Open on right-click (or the menu key) anywhere in the app.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (menuRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        return;
      }
      if (wantsNativeMenu(e)) return;
      const builders = [...(collected.get(e) ?? []), () => globalRef.current()];
      const sections = cleanSections(builders.map((b) => b()));
      if (!sections.length) return;
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      // The menu key and Shift+F10 report no pointer position: open at the focused element instead.
      let at = { x: e.clientX, y: e.clientY };
      if (e.button !== 2 && at.x === 0 && at.y === 0 && target) {
        const r = target.getBoundingClientRect();
        at = { x: r.left, y: r.bottom };
      }
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen({ sections, at, host: hostFor(target), returnFocus: focused });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Close on a click elsewhere, scrolling, resizing, leaving the window or changing view.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    const onAway = () => close(false);
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", onAway);
    window.addEventListener("hashchange", onAway);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("hashchange", onAway);
    };
  }, [open, close]);

  const items: MenuAction[] = open ? open.sections.flatMap((s) => s.items) : [];
  const disabled = items.map((i) => !!i.disabled);

  // Show in the top layer (above open dialogs), measure, place, and focus the first enabled item.
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!open || !node) {
      setPos(null);
      return;
    }
    try {
      if (!node.hasAttribute("popover")) node.setAttribute("popover", "manual");
      if (!node.matches(":popover-open")) node.showPopover();
    } catch {
      // No popover support: still a fixed layer, just not above modal dialogs.
    }
    const r = node.getBoundingClientRect();
    const view = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
    setPos(placeMenu(open.at, { w: r.width, h: r.height }, view));
    const first = nextEnabled(open.sections.flatMap((s) => s.items).map((i) => !!i.disabled), -1, 1);
    setActive(first);
  }, [open]);

  useEffect(() => {
    if (active < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus({ preventScroll: true });
  }, [active, pos]);

  if (!open) return null;

  const pick = (item: MenuAction) => {
    if (item.disabled) return;
    close(true);
    // After focus is back where it was, so an action that opens a dialog can take focus itself.
    setTimeout(item.onSelect, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const go = (i: number) => {
      e.preventDefault();
      if (i >= 0) setActive(i);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(nextEnabled(disabled, active, 1));
      case "ArrowUp":
        return go(nextEnabled(disabled, active < 0 ? 0 : active, -1));
      case "Home":
        return go(nextEnabled(disabled, -1, 1));
      case "End":
        return go(nextEnabled(disabled, disabled.length, -1));
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0) pick(items[active]);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        e.preventDefault();
        close(true);
        return;
    }
  };

  let index = -1;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Actions"
      className={styles.menu}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      {open.sections.map((section, si) => (
        <div key={si} role="group" aria-label={section.title} className={styles.group}>
          {si > 0 ? <div role="separator" className={styles.separator} /> : null}
          {section.title ? (
            <div className={styles.title} aria-hidden="true">
              {section.title}
            </div>
          ) : null}
          {section.items.map((item) => {
            index += 1;
            const i = index;
            const reason = typeof item.disabled === "string" ? item.disabled : undefined;
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                data-index={i}
                data-danger={item.danger || undefined}
                aria-disabled={item.disabled ? true : undefined}
                data-tip={reason ?? item.tip}
                className={styles.item}
                onClick={() => pick(item)}
                onPointerEnter={() => !item.disabled && setActive(i)}
              >
                <span className={styles.icon} aria-hidden="true">
                  {item.icon}
                </span>
                <span className={styles.label}>{item.label}</span>
                {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>,
    open.host,
  );
}
