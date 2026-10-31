import { describe, expect, it } from "vitest";
import { makeMotes, moteCount, moteLinks, pointerGlow, stepMotes } from "./motes";

describe("mote field", () => {
  it("scales the count with the window and keeps it in bounds", () => {
    expect(moteCount(300, 200)).toBe(24);
    expect(moteCount(2560, 940)).toBe(67);
    expect(moteCount(3440, 1440)).toBe(90);
  });

  it("is the same for the same size and seed, and inside the window", () => {
    const a = makeMotes(800, 600);
    expect(makeMotes(800, 600)).toEqual(a);
    for (const m of a) {
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(800);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(600);
    }
  });

  it("wraps motes that drift past an edge", () => {
    const motes = [{ x: 799, y: 5, vx: 100, vy: -100, r: 1, phase: 0 }];
    stepMotes(motes, 1, 800, 600, 20);
    expect(motes[0].x).toBeCloseTo(899 - 840);
    expect(motes[0].y).toBeCloseTo(-95 + 640);
  });

  it("links only close pairs, stronger when closer", () => {
    const m = (x: number, y: number) => ({ x, y, vx: 0, vy: 0, r: 1, phase: 0 });
    const links = moteLinks([m(0, 0), m(30, 0), m(500, 0)], 120);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ a: 0, b: 1 });
    expect(links[0].strength).toBeCloseTo(0.75);
  });

  it("lights points near the pointer only", () => {
    expect(pointerGlow(0, 0, null, null, 100)).toBe(0);
    expect(pointerGlow(0, 0, 0, 0, 100)).toBe(1);
    expect(pointerGlow(0, 0, 50, 0, 100)).toBeCloseTo(0.5);
    expect(pointerGlow(0, 0, 200, 0, 100)).toBe(0);
  });
});
