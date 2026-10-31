import { describe, expect, it } from "vitest";
import { rankOf, validateProposedMoves } from "./validate";

const move = (rank: unknown) => ({ id: "a", title: "Do a thing", reason: "Because", area: "work", rank });

describe("next move ranks", () => {
  it("keeps numbers, reads numbers written as text, and falls back to the position", () => {
    expect(rankOf(2, 5)).toBe(2);
    expect(rankOf("3", 5)).toBe(3);
    expect(rankOf(" 4 ", 5)).toBe(4);
    expect(rankOf(undefined, 5)).toBe(5);
    expect(rankOf(null, 5)).toBe(5);
    expect(rankOf("first", 5)).toBe(5);
    expect(rankOf(Number.NaN, 5)).toBe(5);
  });

  it("a move without a usable rank no longer rejects the whole answer", () => {
    const check = validateProposedMoves([move(1), move(2), move("third"), move(undefined)]);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.moves.map((m) => m.rank)).toEqual([1, 2, 3, 4]);
  });
});
