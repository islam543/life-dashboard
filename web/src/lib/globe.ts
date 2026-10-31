// Math for the figures drawn behind the dashboard (ui/Backdrop.tsx): a turning Earth in the
// bottom-right corner and a HUD dial in the top-left. Plain math, no DOM, so it can be tested.

const RAD = Math.PI / 180;

export interface Projected {
  /** -1..1 across the globe, right is positive. */
  x: number;
  /** -1..1, up is negative (screen direction). */
  y: number;
  /** Depth: above 0 faces you, below 0 is on the far side. */
  z: number;
}

/**
 * Orthographic view of a point on a unit sphere. `spin` turns the globe east (degrees), `tilt`
 * leans the north pole toward you (degrees), like looking down on it from slightly above.
 */
export function project(lon: number, lat: number, spin: number, tilt: number): Projected {
  const l = (lon + spin) * RAD;
  const p = lat * RAD;
  const x = Math.cos(p) * Math.sin(l);
  const y = Math.sin(p);
  const z = Math.cos(p) * Math.cos(l);
  const t = tilt * RAD;
  const y2 = y * Math.cos(t) - z * Math.sin(t);
  const z2 = y * Math.sin(t) + z * Math.cos(t);
  return { x, y: -y2, z: z2 };
}

/** Points along a line of longitude, south to north. */
export function meridian(lon: number, step = 3): [number, number][] {
  const out: [number, number][] = [];
  for (let lat = -90; lat <= 90; lat += step) out.push([lon, lat]);
  return out;
}

/** Points around a line of latitude, a closed loop. */
export function parallel(lat: number, step = 3): [number, number][] {
  const out: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += step) out.push([lon, lat]);
  return out;
}

/**
 * Splits a projected line into the runs that face you, so the far side is never drawn.
 * Each run is a list of screen points.
 */
export function frontRuns(
  points: readonly [number, number][],
  spin: number,
  tilt: number,
): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const [lon, lat] of points) {
    const p = project(lon, lat, spin, tilt);
    if (p.z > 0) run.push({ x: p.x, y: p.y });
    else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

export interface FigureLayout {
  globe: { cx: number; cy: number; r: number };
  dial: { cx: number; cy: number; r: number };
}

/**
 * Where the figures sit for a window size. The globe rises from the bottom edge near the right
 * corner (about its top half shows); the dial sits half off the top-left corner. Both scale with
 * the window's height, which is the short side on a 21:9 screen.
 */
export function figureLayout(width: number, height: number): FigureLayout {
  const r = Math.max(120, Math.min(height * 0.46, width * 0.22));
  const d = Math.max(90, Math.min(height * 0.3, width * 0.16));
  return {
    globe: { cx: width - r * 1.15, cy: height + r * 0.12, r },
    dial: { cx: d * 0.35, cy: d * 0.2, r: d },
  };
}

/** Doha, for the home ping on the globe. */
export const HOME = { lon: 51.53, lat: 25.29 } as const;
