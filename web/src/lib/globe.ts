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

// ---------------------------------------------------------------------------------------------
// Routes: curved arcs between places, each carrying a travelling dot
// ---------------------------------------------------------------------------------------------

export type Vec3 = [number, number, number];

/** A point on the unit sphere for lon/lat (degrees), in the same axes as `project` before spin. */
export function toVec(lon: number, lat: number): Vec3 {
  const l = lon * RAD;
  const p = lat * RAD;
  return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
}

/**
 * A 3D point (any length) seen through the same spin and tilt as `project`. `visible` is true when
 * it faces you, or when it floats far enough above the surface to clear the globe's edge.
 */
export function viewPoint(v: Vec3, spin: number, tilt: number): { x: number; y: number; z: number; visible: boolean } {
  const s = spin * RAD;
  const x = v[0] * Math.cos(s) + v[2] * Math.sin(s);
  const z1 = v[2] * Math.cos(s) - v[0] * Math.sin(s);
  const t = tilt * RAD;
  const y = v[1] * Math.cos(t) - z1 * Math.sin(t);
  const z = v[1] * Math.sin(t) + z1 * Math.cos(t);
  return { x, y: -y, z, visible: z > 0 || Math.hypot(x, y) > 1 };
}

/**
 * Points along the shortest path from a to b over the globe, lifted into an arc: height above the
 * surface peaks halfway and grows with the distance, so long routes arc higher.
 */
export function arcPoints(a: Vec3, b: Vec3, n = 40): Vec3[] {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  const lift = 0.06 + 0.22 * (angle / Math.PI);
  const sin = Math.sin(angle) || 1;
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const wa = angle === 0 ? 1 - f : Math.sin((1 - f) * angle) / sin;
    const wb = angle === 0 ? f : Math.sin(f * angle) / sin;
    const r = 1 + lift * Math.sin(Math.PI * f);
    out.push([(a[0] * wa + b[0] * wb) * r, (a[1] * wa + b[1] * wb) * r, (a[2] * wa + b[2] * wb) * r]);
  }
  return out;
}

export interface City {
  name: string;
  lon: number;
  lat: number;
}

export const CITIES: Record<string, City> = {
  doha: { name: "Doha", lon: HOME.lon, lat: HOME.lat },
  london: { name: "London", lon: -0.13, lat: 51.51 },
  frankfurt: { name: "Frankfurt", lon: 8.68, lat: 50.11 },
  istanbul: { name: "Istanbul", lon: 28.98, lat: 41.01 },
  cairo: { name: "Cairo", lon: 31.24, lat: 30.04 },
  nairobi: { name: "Nairobi", lon: 36.82, lat: -1.29 },
  johannesburg: { name: "Johannesburg", lon: 28.05, lat: -26.2 },
  mumbai: { name: "Mumbai", lon: 72.88, lat: 19.08 },
  singapore: { name: "Singapore", lon: 103.82, lat: 1.35 },
  tokyo: { name: "Tokyo", lon: 139.69, lat: 35.69 },
  sydney: { name: "Sydney", lon: 151.21, lat: -33.87 },
  newyork: { name: "New York", lon: -74.0, lat: 40.71 },
  saopaulo: { name: "Sao Paulo", lon: -46.63, lat: -23.55 },
};

/** Who talks to whom. Most routes start or end in Doha. */
export const ROUTES: readonly [string, string][] = [
  ["doha", "london"],
  ["doha", "newyork"],
  ["mumbai", "doha"],
  ["doha", "singapore"],
  ["tokyo", "doha"],
  ["doha", "nairobi"],
  ["doha", "johannesburg"],
  ["istanbul", "doha"],
  ["doha", "sydney"],
  ["frankfurt", "doha"],
  ["doha", "cairo"],
  ["london", "newyork"],
  ["singapore", "sydney"],
  ["saopaulo", "london"],
  ["tokyo", "singapore"],
];

/** Seconds a dot takes to cross a route, and how long the launch and landing effects last. */
export const TRAVEL = 2.8;
export const LAUNCH = 0.6;
export const LANDING = 1.1;

/**
 * Where route `i` is in its loop at time `t` (seconds). Each route waits a different time between
 * trips, so the dots never move in lockstep.
 *   travel: a dot is on its way, `p` from 0 to 1 (eased: slow out, fast middle, slow in)
 *   landed: it just arrived, `p` from 0 to 1 over the landing effect
 *   idle: nothing moving on this route
 * `launch` is 0..1 during the first LAUNCH seconds of a trip, for the take-off ring.
 */
export function routePhase(i: number, t: number): { state: "travel" | "landed" | "idle"; p: number; launch: number | null } {
  const rest = 2.2 + ((i * 1.37) % 3.1);
  const period = TRAVEL + rest;
  const local = (((t + i * 0.83) % period) + period) % period;
  if (local < TRAVEL) {
    const f = local / TRAVEL;
    const eased = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
    return { state: "travel", p: eased, launch: local < LAUNCH ? local / LAUNCH : null };
  }
  const since = local - TRAVEL;
  if (since < LANDING) return { state: "landed", p: since / LANDING, launch: null };
  return { state: "idle", p: 0, launch: null };
}
