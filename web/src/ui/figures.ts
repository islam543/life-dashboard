import landDots from "../assets/landDots.json";
import { HOME, frontRuns, meridian, parallel, project, type FigureLayout } from "../lib/globe";

// Canvas drawing for the background figures (called by ui/Backdrop.tsx each frame):
//   - a holographic Earth rising from the bottom-right corner: dotted continents, a lat/long grid,
//     a glowing rim, a scan line, two orbits with satellites, and a ping over Doha
//   - a HUD dial half off the top-left corner: tick rings turning slowly in opposite directions
// `t` is seconds since start; nothing here reads the DOM.

export interface FigureColors {
  accent: string;
  strong: string;
  blue: string;
  violet: string;
}

const DOTS = landDots as [number, number][];
const TILT = 18; // degrees the north pole leans toward you
const SPIN_SPEED = 4; // degrees per second: one turn every 90 s
const GRID_LONS = Array.from({ length: 12 }, (_, i) => i * 30 - 180);
const GRID_LATS = [-60, -30, 0, 30, 60];

function strokeRuns(ctx: CanvasRenderingContext2D, runs: { x: number; y: number }[][], cx: number, cy: number, r: number) {
  for (const run of runs) {
    ctx.beginPath();
    ctx.moveTo(cx + run[0].x * r, cy + run[0].y * r);
    for (let i = 1; i < run.length; i++) ctx.lineTo(cx + run[i].x * r, cy + run[i].y * r);
    ctx.stroke();
  }
}

function drawGlobe(ctx: CanvasRenderingContext2D, t: number, g: FigureLayout["globe"], c: FigureColors, k: number) {
  const { cx, cy, r } = g;
  const spin = -30 + t * SPIN_SPEED;

  // Atmosphere: a soft halo just outside the rim.
  const halo = ctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.28);
  halo.addColorStop(0, c.accent);
  halo.addColorStop(1, "transparent");
  ctx.globalAlpha = 0.22 * k;
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.28, 0, Math.PI * 2);
  ctx.fill();

  // Glass body: darker in the middle, lit toward the rim.
  const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  body.addColorStop(0, c.blue);
  body.addColorStop(1, "transparent");
  ctx.globalAlpha = 0.1 * k;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Grid.
  ctx.lineWidth = 1;
  ctx.strokeStyle = c.accent;
  ctx.globalAlpha = 0.16 * k;
  for (const lon of GRID_LONS) strokeRuns(ctx, frontRuns(meridian(lon, 4), spin, TILT), cx, cy, r);
  for (const lat of GRID_LATS) strokeRuns(ctx, frontRuns(parallel(lat, 4), spin, TILT), cx, cy, r);

  // Scan line: one bright meridian sweeping faster than the globe turns.
  ctx.strokeStyle = c.strong;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.45 * k;
  strokeRuns(ctx, frontRuns(meridian(-t * 14, 3), spin, TILT), cx, cy, r);

  // Continents as dots, brighter and larger toward you.
  ctx.fillStyle = c.accent;
  for (const [lon, lat] of DOTS) {
    const p = project(lon, lat, spin, TILT);
    if (p.z <= 0.02) continue;
    ctx.globalAlpha = (0.18 + 0.62 * p.z) * k;
    const size = 0.9 + 1.5 * p.z;
    ctx.fillRect(cx + p.x * r - size / 2, cy + p.y * r - size / 2, size, size);
  }

  // Rim.
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.2;
  ctx.globalAlpha = 0.55 * k;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Home ping over Doha while it faces you.
  const home = project(HOME.lon, HOME.lat, spin, TILT);
  if (home.z > 0.1) {
    const hx = cx + home.x * r;
    const hy = cy + home.y * r;
    const pulse = (t % 2.4) / 2.4;
    ctx.strokeStyle = c.strong;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = (1 - pulse) * 0.8 * home.z * k;
    ctx.beginPath();
    ctx.arc(hx, hy, 3 + pulse * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = c.strong;
    ctx.globalAlpha = 0.95 * home.z * k;
    ctx.beginPath();
    ctx.arc(hx, hy, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Orbits: tilted ellipses, each with a satellite. Behind the globe they fade out.
  const orbits = [
    { rx: 1.42, ry: 0.32, rot: -0.32, speed: 0.22, color: c.violet, size: 3 },
    { rx: 1.68, ry: 0.5, rot: 0.42, speed: -0.14, color: c.blue, size: 2.4 },
  ];
  for (const o of orbits) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(o.rot);
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 7]);
    ctx.globalAlpha = 0.3 * k;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * o.rx, r * o.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = t * o.speed;
    const sx = Math.cos(a) * r * o.rx;
    const sy = Math.sin(a) * r * o.ry;
    // Upper half of the ellipse passes behind the globe; hide the satellite there if it overlaps the disc.
    const behind = Math.sin(a) < 0 && Math.hypot(sx, sy) < r;
    ctx.globalAlpha = (behind ? 0.08 : 0.9) * k;
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.arc(sx, sy, o.size, 0, Math.PI * 2);
    ctx.fill();
    // A short trail behind the satellite.
    ctx.strokeStyle = o.color;
    ctx.lineWidth = o.size * 0.8;
    ctx.globalAlpha = (behind ? 0.04 : 0.35) * k;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * o.rx, r * o.ry, 0, a - Math.sign(o.speed) * 0.35, a, o.speed < 0);
    ctx.stroke();
    ctx.restore();
  }
}

function drawDial(ctx: CanvasRenderingContext2D, t: number, d: FigureLayout["dial"], c: FigureColors, k: number) {
  const { cx, cy, r } = d;
  ctx.save();
  ctx.translate(cx, cy);

  // Outer ring of ticks, a long one every 30 degrees, turning clockwise.
  ctx.save();
  ctx.rotate(t * 0.05);
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1;
  for (let i = 0; i < 72; i++) {
    const long = i % 6 === 0;
    ctx.globalAlpha = (long ? 0.4 : 0.18) * k;
    const a = (i / 72) * Math.PI * 2;
    const r1 = r * (long ? 0.9 : 0.94);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();

  // Middle ring: four arcs turning the other way.
  ctx.save();
  ctx.rotate(-t * 0.09);
  ctx.strokeStyle = c.blue;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.28 * k;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.74, a, a + Math.PI / 3);
    ctx.stroke();
  }
  ctx.restore();

  // Inner dashed ring and a sweeping hand.
  ctx.strokeStyle = c.violet;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 6]);
  ctx.globalAlpha = 0.3 * k;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const hand = t * 0.6;
  ctx.strokeStyle = c.strong;
  ctx.globalAlpha = 0.35 * k;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(hand) * r * 0.86, Math.sin(hand) * r * 0.86);
  ctx.stroke();

  ctx.restore();
}

/** Draws both figures. `k` scales every opacity (lower on the light theme). */
export function drawFigures(ctx: CanvasRenderingContext2D, t: number, layout: FigureLayout, colors: FigureColors, k: number): void {
  drawDial(ctx, t, layout.dial, colors, k);
  drawGlobe(ctx, t, layout.globe, colors, k);
  ctx.globalAlpha = 1;
}
