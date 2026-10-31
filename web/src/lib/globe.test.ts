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
