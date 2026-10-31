import { describe, expect, it } from "vitest";
import { cleanSections, nextEnabled, placeMenu } from "./contextMenu";

const noop = () => undefined;

describe("cleanSections", () => {
  it("drops empty slots and empty sections, keeping order", () => {
    const out = cleanSections([
      { title: "Card", items: [{ label: "Open", onSelect: noop }, null, false] },
      null,
      { title: "Empty", items: [undefined] },
      { items: [{ label: "Refresh", onSelect: noop }] },
    ]);
    expect(out.map((s) => s.title)).toEqual(["Card", undefined]);
    expect(out[0].items.map((i) => i.label)).toEqual(["Open"]);
  });

  it("returns nothing when no region offered an action", () => {
    expect(cleanSections([])).toEqual([]);
  });
});

describe("placeMenu", () => {
  const view = { w: 1000, h: 800 };
  const size = { w: 200, h: 300 };

  it("opens down and right from the pointer", () => {
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 });
  });

  it("flips left and up near the right and bottom edges", () => {
    expect(placeMenu({ x: 950, y: 700 }, size, view)).toEqual({ left: 750, top: 400 });
  });

  it("stays inside the window when the menu is taller than the space either way", () => {
    expect(placeMenu({ x: 10, y: 400 }, { w: 200, h: 790 }, view).top).toBe(8);
  });
});

describe("nextEnabled", () => {
  it("skips disabled items and wraps", () => {
    const disabled = [false, true, false, false];
    expect(nextEnabled(disabled, 0, 1)).toBe(2);
    expect(nextEnabled(disabled, 3, 1)).toBe(0);
    expect(nextEnabled(disabled, 0, -1)).toBe(3);
  });

  it("returns -1 when every item is disabled", () => {
    expect(nextEnabled([true, true], 0, 1)).toBe(-1);
  });
});
