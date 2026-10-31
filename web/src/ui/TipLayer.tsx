import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tipsEnabled } from "../lib/tips";
import styles from "./TipLayer.module.css";

// Hover help for the whole app. Any element with data-tip="What this does." gets a tooltip:
// after HOVER_DELAY on mouse hover, at once on keyboard focus. One layer, mounted once in App.
//   - Esc hides it, moving the pointer onto the tip keeps it open, it stays until you leave (WCAG 1.4.13).
//   - While shown, the element's aria-describedby points at the tip so screen readers read it.
//   - Touch is ignored; tips are help, never the only way to learn what a control does.
//   - The header switch turns hover help off (lib/tips.ts).
//   - The tip is a manual popover, so it sits in the top layer above an open modal <dialog>. It is placed
//     inside the topmost open dialog, because everything outside a modal dialog is inert (not hoverable).
// Write tips as one short sentence that says what happens: "Re-runs the AI suggestions now."

const HOVER_DELAY = 450;
/** Moving straight from one tipped element to the next shows the next tip at once. */
const WARM_WINDOW = 400;
const HIDE_GRACE = 120;
const GAP = 8;
const EDGE = 8;

interface Shown {
  el: Element;
  text: string;
  /** Where the tip node lives: the topmost open modal dialog, or the body. */
  host: Element;
}

function hostFor(el: Element): Element {
  const dialogs = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal"));
  const top = dialogs[dialogs.length - 1];
  return top && top.contains(el) ? top : document.body;
}

function tipTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest("[data-tip]");
  return el && el.getAttribute("data-tip")?.trim() ? el : null;
}

function addDescribedBy(el: Element, id: string) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  if (!ids.includes(id)) el.setAttribute("aria-describedby", [...ids, id].join(" "));
}

function removeDescribedBy(el: Element, id: string) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
  if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

export function TipLayer() {
  const id = useId();
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: "above" | "below" } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHidden = useRef(0);
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;

  useEffect(() => {
    const clearTimers = () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      showTimer.current = hideTimer.current = null;
    };
    const show = (el: Element) => {
      clearTimers();
      const text = el.getAttribute("data-tip")?.trim();
      if (!text || !tipsEnabled()) return;
      setShown({ el, text, host: hostFor(el) });
    };
    const hide = () => {
      clearTimers();
      if (shownRef.current) lastHidden.current = Date.now();
      setShown(null);
    };
    const hideSoon = () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      showTimer.current = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(hide, HIDE_GRACE);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (tipRef.current?.contains(e.target as Node)) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        return;
      }
      const el = tipTarget(e.target);
      const current = shownRef.current?.el;
      if (el && el === current) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        return;
      }
      if (!el) {
        if (current || showTimer.current) hideSoon();
        return;
      }
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (showTimer.current) clearTimeout(showTimer.current);
      const warm = current || Date.now() - lastHidden.current < WARM_WINDOW;
      if (warm) show(el);
      else showTimer.current = setTimeout(() => show(el), HOVER_DELAY);
    };
    const onLeaveWindow = (e: PointerEvent) => {
      if (!e.relatedTarget) hideSoon();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      // Only keyboard focus: a mouse click also focuses, and the hover path already covers it.
      // Rows you step through with arrow keys (tree, list, menu, tabs) show their tip on hover only,
      // so arrowing down a list doesn't flash a tip on every row.
      const target = e.target as Element;
      const roving = target.matches('[role="treeitem"], [role="option"], [role="menuitem"], [role="tab"]');
      if (el && !roving && target.matches(":focus-visible")) show(el);
      else if (shownRef.current && el !== shownRef.current.el) hide();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (shownRef.current && tipTarget(e.target) === shownRef.current.el) hideSoon();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && shownRef.current) {
        // Close only the tip; a dialog under it stays open.
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    };
    const onDown = () => hide();
    const onScroll = () => {
      if (shownRef.current) hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onLeaveWindow);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      clearTimers();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onLeaveWindow);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // Point the element at the tip while it's shown.
  useEffect(() => {
    if (!shown) return;
    addDescribedBy(shown.el, id);
    return () => removeDescribedBy(shown.el, id);
  }, [shown, id]);

  // A tipped element that leaves the page (closed dialog, re-render) takes its tip with it.
  useEffect(() => {
    if (!shown) return;
    const t = setInterval(() => {
      if (!shown.el.isConnected) setShown(null);
    }, 300);
    return () => clearInterval(t);
  }, [shown]);

  // Below the element when there's room, else above; kept inside the window.
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!shown || !node) {
      setPos(null);
      return;
    }
    // A hidden popover has no box, so open it before measuring.
    try {
      // Set here, not as a JSX prop: React 18's types don't list the popover attribute.
      if (!node.hasAttribute("popover")) node.setAttribute("popover", "manual");
      if (!node.matches(":popover-open")) node.showPopover();
    } catch {
      // No popover support: it still shows as a fixed element, just not above modal dialogs.
    }
    const r = shown.el.getBoundingClientRect();
    const tip = node.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = r.bottom + GAP + tip.height <= vh - EDGE || r.top - GAP - tip.height < EDGE;
    const top = below ? r.bottom + GAP : r.top - GAP - tip.height;
    const centre = r.left + r.width / 2 - tip.width / 2;
    const left = Math.min(Math.max(EDGE, centre), vw - EDGE - tip.width);
    setPos({ left, top, side: below ? "below" : "above" });
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={tipRef}
      id={id}
      role="tooltip"
      className={styles.tip}
      data-side={pos?.side}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}
    >
      {shown.text}
    </div>,
    shown.host,
  );
}
