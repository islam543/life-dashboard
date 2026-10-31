import { describe, expect, it } from "vitest";
import landDots from "../assets/landDots.json";
import { HOME, figureLayout, frontRuns, meridian, parallel, project } from "./globe";

describe("globe projection", () => {
  it("puts lon 0, lat 0 in the middle, facing you", () => {
    const p = project(0, 0, 0, 0);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(1);
  });

  it("turns east with spin and hides the far side", () => {
    expect(project(90, 0, 0, 0).x).toBeCloseTo(1);
    expect(project(0, 0, 90, 0).x).toBeCloseTo(1);
    expect(project(180, 0, 0, 0).z).toBeCloseTo(-1);
  });

  it("draws the north pole up the screen, and tilting shows it more", () => {
    expect(project(0, 90, 0, 0).y).toBeCloseTo(-1);
    expect(project(0, 90, 0, 20).z).toBeGreaterThan(0);
  });

  it("splits lines into front-facing runs only", () => {
    const runs = frontRuns(parallel(0), 0, 0);
    for (const run of runs) for (const pt of run) expect(Math.hypot(pt.x, pt.y)).toBeLessThanOrEqual(1.0001);
    expect(runs.length).toBeGreaterThan(0);
    expect(frontRuns(meridian(180), 0, 0)).toEqual([]);
  });
});

describe("figure layout", () => {
  it("puts the globe low on the right with about its top half on screen", () => {
    const { globe } = figureLayout(2560, 940);
    expect(globe.cx).toBeGreaterThan(2560 / 2);
    expect(globe.cy).toBeGreaterThan(940);
    expect(globe.cy - globe.r).toBeLessThan(940 - globe.r * 0.8);
  });

  it("keeps both figures a usable size on small and huge windows", () => {
    expect(figureLayout(400, 300).globe.r).toBeGreaterThanOrEqual(120);
    expect(figureLayout(3440, 1440).globe.r).toBeLessThanOrEqual(1440 * 0.46);
  });
});

describe("land dots", () => {
  it("are valid lon/lat pairs and include the area around Doha", () => {
    const dots = landDots as [number, number][];
    expect(dots.length).toBeGreaterThan(1500);
    for (const [lon, lat] of dots) {
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
    expect(dots.some(([lon, lat]) => Math.abs(lon - HOME.lon) < 4 && Math.abs(lat - HOME.lat) < 4)).toBe(true);
  });
});

describe("routes", async () => {
  const { CITIES, ROUTES, arcPoints, routePhase, toVec, viewPoint, TRAVEL, LANDING } = await import("./globe");

  it("every route joins two known cities", () => {
    for (const [a, b] of ROUTES) {
      expect(CITIES[a]).toBeDefined();
      expect(CITIES[b]).toBeDefined();
    }
  });

  it("arcs start and end on the cities and rise in the middle", () => {
    const a = toVec(CITIES.doha.lon, CITIES.doha.lat);
    const b = toVec(CITIES.london.lon, CITIES.london.lat);
    const pts = arcPoints(a, b, 20);
    pts[0].forEach((v, i) => expect(v).toBeCloseTo(a[i]));
    pts[20].forEach((v, i) => expect(v).toBeCloseTo(b[i]));
    expect(Math.hypot(...pts[10])).toBeGreaterThan(1.05);
  });

  it("matches project() for points on the surface", () => {
    const v = toVec(40, 20);
    const p = project(40, 20, 33, 18);
    const q = viewPoint(v, 33, 18);
    expect(q.x).toBeCloseTo(p.x);
    expect(q.y).toBeCloseTo(p.y);
    expect(q.z).toBeCloseTo(p.z);
  });

  it("shows an arc point behind the globe only once it clears the edge", () => {
    expect(viewPoint([0, 0, -1], 0, 0).visible).toBe(false);
    expect(viewPoint([1.2, 0, -0.1], 0, 0).visible).toBe(true);
  });

  it("each route travels, lands, then rests, with eased progress", () => {
    const start = routePhase(0, 0);
    expect(start.state).toBe("travel");
    expect(start.launch).toBe(0);
    expect(routePhase(0, TRAVEL / 2).p).toBeCloseTo(0.5);
    expect(routePhase(0, TRAVEL + 0.1).state).toBe("landed");
    expect(routePhase(0, TRAVEL + LANDING + 0.5).state).toBe("idle");
    const states = new Set(ROUTES.map((_, i) => routePhase(i, 10).state));
    expect(states.size).toBeGreaterThan(1);
  });
});
