import { useLayoutEffect, type RefObject } from "react";

// Ultrawide screens (>=1920px, see tokens.css): the board and a project's page fill the window
// height, and their columns scroll inside themselves instead of the page. CSS needs to know how much
// of the window the page frame already takes, so useFitHeight keeps two variables on the element:
//   --fit-top     its distance from the top of the page (header, offline banner)
//   --fit-bottom  the page frame's padding below it
// Projects.module.css turns them into --fit-height. They are measured on load, on resize and when
// the page around the element changes size (the header wrapping, the offline banner coming or
// going), so a change to the header or the frame needs no change here.

interface Edge {
  top: number;
  bottom: number;
}

/**
 * The scrollTop that shows `item` whole inside the scroll box `box` (both as on-screen rects), moving
 * as little as possible, with `margin` px of room around it. An item taller than the box lines up
 * with the box's top.
 */
export function scrollToReveal(scrollTop: number, box: Edge, item: Edge, margin = 0): number {
  const above = box.top - (item.top - margin);
  if (above > 0) return Math.max(0, scrollTop - above);
  const below = item.bottom + margin - box.bottom;
  if (below > 0) return scrollTop + Math.min(below, item.top - margin - box.top);
  return scrollTop;
}

/**
 * Scrolls the lane holding `el` (a list marked data-scroller) so `el` is in view. No effect where
 * the lane does not scroll, which is everywhere below 1920px.
 */
export function revealInScroller(el: HTMLElement): void {
  const box = el.closest<HTMLElement>("[data-scroller]");
  if (!box || box.scrollHeight <= box.clientHeight) return;
  box.scrollTop = scrollToReveal(box.scrollTop, box.getBoundingClientRect(), el.getBoundingClientRect(), 8);
}

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Keeps --fit-top and --fit-bottom on `ref`'s element current. */
export function useFitHeight(ref: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const main = el.closest("main");
    const frame = main?.parentElement ?? null;
    let last = "";
    let frameId = 0;

    const measure = () => {
      frameId = 0;
      const top = el.getBoundingClientRect().top + window.scrollY;
      let bottom = 0;
      if (main) {
        const s = getComputedStyle(main);
        bottom += px(s.paddingBottom) + px(s.borderBottomWidth) + px(s.marginBottom);
      }
      if (frame) {
        const s = getComputedStyle(frame);
        bottom += px(s.paddingBottom) + px(s.borderBottomWidth);
      }
      const next = `${Math.round(top)}|${Math.round(bottom)}`;
      if (next === last) return;
      last = next;
      el.style.setProperty("--fit-top", `${Math.round(top)}px`);
      el.style.setProperty("--fit-bottom", `${Math.round(bottom)}px`);
    };
    // A resize callback that changes our own height would resize the frame again in the same frame
    // (a ResizeObserver loop): measure on the next frame instead.
    const later = () => {
      if (!frameId) frameId = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("resize", later);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    if (ro && frame) ro.observe(frame);
    return () => {
      window.removeEventListener("resize", later);
      ro?.disconnect();
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [ref]);
}
