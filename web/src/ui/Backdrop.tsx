import { useEffect, useRef } from "react";
import { figureLayout, type FigureLayout } from "../lib/globe";
import { useBackdropMotion } from "../lib/motionPref";
import { makeMotes, moteLinks, pointerGlow, stepMotes, type Mote } from "../lib/motes";
import { useTheme } from "../lib/theme";
import styles from "./Backdrop.module.css";
import { drawFigures } from "./figures";

// The animated layer behind every view: three slow colour glows (CSS), two figures (a turning
// Earth bottom-right and a HUD dial top-left, see ui/figures.ts), and a field of data motes that
// drift, link up when close and light up near the pointer (canvas).
//   - Cheap on purpose: the glows only animate transform, the canvas draws at 30 fps at most,
//     at no more than 1.5x pixel density, and stops while the tab is hidden.
//   - Still (one frame, no loop) under the OS reduce-motion setting or when Motion is off.
//   - Never catches the pointer; it only listens for where the pointer is.

const FPS = 30;
const LINK = 130;
const POINTER_RADIUS = 180;
const MAX_DPR = 1.5;

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    mote: get("--accent", "#5ce1f5"),
    link: get("--accent", "#5ce1f5"),
    glow: get("--accent-strong", "#9aefff"),
    figures: {
      accent: get("--accent", "#5ce1f5"),
      strong: get("--accent-strong", "#9aefff"),
      blue: get("--cat-2", "#4c8dff"),
      violet: get("--ai", "#b4a6ff"),
    },
  };
}

export function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motion = useBackdropMotion();
  const theme = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const light = theme === "light";
    const colors = readColors();
    let width = 0;
    let height = 0;
    let motes: Mote[] = [];
    let layout: FigureLayout = figureLayout(1, 1);
    let pointer: { x: number; y: number } | null = null;
    let raf = 0;
    let last = 0;
    let acc = 0;
    let t = 0;

    const live = () => motion && !reduce.matches;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      motes = makeMotes(width, height);
      layout = figureLayout(width, height);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const px = live() ? (pointer?.x ?? null) : null;
      const py = live() ? (pointer?.y ?? null) : null;
      // Lighter strokes on the light theme, where dark-on-light reads stronger.
      const k = light ? 0.55 : 1;

      drawFigures(ctx, t, layout, colors.figures, light ? 0.7 : 1);

      ctx.lineWidth = 1;
      ctx.strokeStyle = colors.link;
      for (const { a, b, strength } of moteLinks(motes, LINK)) {
        const ma = motes[a];
        const mb = motes[b];
        const glow = Math.max(pointerGlow(ma.x, ma.y, px, py, POINTER_RADIUS), pointerGlow(mb.x, mb.y, px, py, POINTER_RADIUS));
        ctx.globalAlpha = (strength * 0.16 + glow * 0.3) * k;
        ctx.beginPath();
        ctx.moveTo(ma.x, ma.y);
        ctx.lineTo(mb.x, mb.y);
        ctx.stroke();
      }

      // Threads from the pointer to the motes around it.
      if (px !== null && py !== null) {
        ctx.strokeStyle = colors.glow;
        for (const m of motes) {
          const glow = pointerGlow(m.x, m.y, px, py, POINTER_RADIUS);
          if (glow <= 0) continue;
          ctx.globalAlpha = glow * 0.22 * k;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(m.x, m.y);
          ctx.stroke();
        }
      }

      for (const m of motes) {
        const glow = pointerGlow(m.x, m.y, px, py, POINTER_RADIUS);
        const twinkle = 0.5 + 0.5 * Math.sin(m.phase + t * 0.9);
        ctx.globalAlpha = (0.22 + twinkle * 0.22 + glow * 0.5) * k;
        ctx.fillStyle = glow > 0.4 ? colors.glow : colors.mote;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r + glow * 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      acc += dt;
      if (acc < 1 / FPS) return;
      t += acc;
      stepMotes(motes, acc, width, height);
      acc = 0;
      draw();
    };

    const start = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      if (live() && !document.hidden) raf = requestAnimationFrame(frame);
      else draw();
    };

    const onResize = () => {
      resize();
      draw();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch") pointer = { x: e.clientX, y: e.clientY };
    };
    const onLeave = (e: PointerEvent) => {
      if (!e.relatedTarget) pointer = null;
    };

    resize();
    start();
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onLeave);
    document.addEventListener("visibilitychange", start);
    reduce.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onLeave);
      document.removeEventListener("visibilitychange", start);
      reduce.removeEventListener("change", start);
    };
  }, [motion, theme]);

  return (
    <div className={styles.backdrop} aria-hidden="true">
      <div className={`${styles.aurora} ${styles.a}`} />
      <div className={`${styles.aurora} ${styles.b}`} />
      <div className={`${styles.aurora} ${styles.c}`} />
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
