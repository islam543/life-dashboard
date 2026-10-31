import { describe, expect, it } from "vitest";
import { scrollToReveal } from "./fit";

// A lane on screen from y=100 to y=500, scrolled down 200px.
const box = { top: 100, bottom: 500 };

describe("scrollToReveal", () => {
  it("leaves the scroll alone when the card is already in view", () => {
    expect(scrollToReveal(200, box, { top: 150, bottom: 300 }, 8)).toBe(200);
  });

  it("scrolls up just enough for a card above the view", () => {
    expect(scrollToReveal(200, box, { top: 40, bottom: 190 }, 8)).toBe(132);
  });

  it("never scrolls above the top", () => {
    expect(scrollToReveal(20, box, { top: -400, bottom: -250 }, 8)).toBe(0);
  });

  it("scrolls down just enough for a card below the view", () => {
    expect(scrollToReveal(200, box, { top: 450, bottom: 600 }, 8)).toBe(308);
  });

  it("lines a card taller than the lane up with its top", () => {
    expect(scrollToReveal(200, box, { top: 300, bottom: 900 }, 8)).toBe(392);
  });
});
