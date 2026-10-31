import { describe, expect, it } from "vitest";
import type { CalendarEvent, TaskNote } from "../shared/types";
import {
  busyBlocks,
  DEFAULT_ITEM_MINUTES,
  fromMinutes,
  placeItems,
  roundedNowMinutes,
  toMinutes,
  type DraftPlanItem,
} from "./schedulePlacer";

// The pure placer: no clock, no disk.

const WINDOW = { start: toMinutes("07:00"), end: toMinutes("22:00") };
const SUN = "2026-11-01";
const MON = "2026-11-02";

const draft = (id: string, date: string, start: string | null, minutes: number | null): DraftPlanItem => ({
  id, title: `Item ${id}`, projectId: null, date, start, minutes, reason: "why", taskPath: null,
});
const block = (from: string, to: string) => ({ start: toMinutes(from), end: toMinutes(to) });
const slots = (items: { id: string; date: string; start: string; minutes: number }[]) => items.map((i) => `${i.id} ${i.date} ${i.start} ${i.minutes}`);

describe("time helpers", () => {
  it("converts HH:MM and wraps at midnight", () => {
    expect(toMinutes("09:30")).toBe(570);
    expect(fromMinutes(570)).toBe("09:30");
    expect(fromMinutes(1440)).toBe("00:00");
    expect(fromMinutes(1455)).toBe("00:15");
  });

  it("rounds now up to the next 15 minutes in Doha", () => {
    expect(roundedNowMinutes(new Date("2026-11-01T06:00:00Z"))).toBe(toMinutes("09:00")); // exactly 09:00
    expect(roundedNowMinutes(new Date("2026-11-01T06:00:30Z"))).toBe(toMinutes("09:15"));
    expect(roundedNowMinutes(new Date("2026-11-01T06:07:00Z"))).toBe(toMinutes("09:15"));
    expect(roundedNowMinutes(new Date("2026-11-01T06:45:00Z"))).toBe(toMinutes("09:45"));
    expect(roundedNowMinutes(new Date("2026-11-01T20:50:00Z"))).toBe(1440); // 23:50 -> midnight
  });
});

describe("busyBlocks", () => {
  const task = (due: string | null, start: string | null, minutes: number | null, done = false): TaskNote => ({
    path: `Tasks/${due}-${start}.md`, section: "Tasks", title: "t", created: "", updated: "", projectId: null, tags: [], excerpt: "",
    openActions: 0, vault: "notes", readOnly: false, task: { due, start, minutes, done, source: "me" },
  });
  const event = (start: string, end: string): CalendarEvent => ({ id: start, title: "m", start, end });

  it("has timed meetings in Doha time, clipped per day, and timed tasks of that day; all-day events do not block", () => {
    const busy = busyBlocks(
      [SUN, MON],
      [
        event("2026-11-01T10:00:00+03:00", "2026-11-01T11:00:00+03:00"),
        event("2026-11-01T20:30:00Z", "2026-11-01T22:00:00Z"), // 23:30 Sunday to 01:00 Monday in Doha
        event(SUN, MON),
        event("2026-11-03T09:00:00+03:00", "2026-11-03T10:00:00+03:00"), // outside the dates
      ],
      [task(SUN, "14:00", 45), task(SUN, "16:00", null, true), task(SUN, null, 30), task(null, "09:00", 30), task(MON, "08:00", 60)],
    );
    expect(busy[SUN]).toEqual([block("10:00", "11:00"), block("14:00", "14:45"), block("16:00", "16:30"), { start: toMinutes("23:30"), end: 1440 }]);
    expect(busy[MON]).toEqual([block("00:00", "01:00"), block("08:00", "09:00")]);
  });
});

describe("placeItems", () => {
  it("keeps a start that fits and has no overlap", () => {
    const out = placeItems({ dates: [SUN], busy: { [SUN]: [block("10:00", "11:00")] }, window: WINDOW, items: [draft("a", SUN, "11:00", 60)] });
    expect(slots(out.items)).toEqual(["a 2026-11-01 11:00 60"]);
    expect(out.dropped).toEqual([]);
  });

  it("moves an item that overlaps a meeting to the first free gap of that day that fits", () => {
    const busy = { [SUN]: [block("07:00", "09:00"), block("09:30", "10:00"), block("10:00", "12:00")] };
    const out = placeItems({ dates: [SUN], busy, window: WINDOW, items: [draft("a", SUN, "10:30", 60)] });
    // 09:00 to 09:30 is too short for 60 minutes; 12:00 is the first gap that fits.
    expect(slots(out.items)).toEqual(["a 2026-11-01 12:00 60"]);
  });

  it("places untimed items, defaults minutes to 30, and never overlaps items it placed", () => {
    const out = placeItems({
      dates: [SUN],
      busy: { [SUN]: [block("08:15", "09:00")] },
      window: WINDOW,
      items: [draft("timed", SUN, "07:15", 30), draft("u1", SUN, null, null), draft("u2", SUN, null, 45)],
    });
    // u1 fits 07:45 to 08:15 between the timed item and the meeting; u2 needs 45 minutes, so 09:00.
    expect(slots(out.items)).toEqual(["timed 2026-11-01 07:15 30", "u1 2026-11-01 07:45 30", "u2 2026-11-01 09:00 45"]);
    expect(DEFAULT_ITEM_MINUTES).toBe(30);
  });

  it("when two timed items overlap, the earlier keeps its start and the later one moves", () => {
    const out = placeItems({ dates: [SUN], busy: {}, window: WINDOW, items: [draft("b", SUN, "10:30", 60), draft("a", SUN, "10:00", 60)] });
    expect(slots(out.items)).toEqual(["b 2026-11-01 07:00 60", "a 2026-11-01 10:00 60"]);
  });

  it("respects the window end and the day's earliest start (today after now)", () => {
    const out = placeItems({
      dates: [SUN],
      busy: {},
      window: WINDOW,
      earliest: { [SUN]: toMinutes("15:15") },
      items: [draft("past", SUN, "09:00", 30), draft("late", SUN, "21:45", 30), draft("ok", SUN, "16:00", 30)],
    });
    // "late" would end at 22:15; 15:45 is taken by "ok" at 16:00, so it lands at 16:30.
    expect(slots(out.items)).toEqual(["past 2026-11-01 15:15 30", "ok 2026-11-01 16:00 30", "late 2026-11-01 16:30 30"]);
  });

  it("spills to a later day in scope when the item's day is full, never to an earlier one", () => {
    const out = placeItems({
      dates: [SUN, MON],
      busy: { [SUN]: [block("07:00", "21:30")], [MON]: [block("07:00", "08:00")] },
      window: WINDOW,
      items: [draft("a", SUN, "10:00", 60), draft("b", MON, null, 30)],
    });
    expect(slots(out.items)).toEqual(["a 2026-11-02 08:00 60", "b 2026-11-02 09:00 30"]);
  });

  it("drops an item that fits nowhere in scope", () => {
    const full = { [SUN]: [block("07:00", "22:00")], [MON]: [block("07:00", "21:00")] };
    const out = placeItems({ dates: [SUN, MON], busy: full, window: WINDOW, items: [draft("a", SUN, null, 90), draft("b", MON, null, 60)] });
    expect(slots(out.items)).toEqual(["b 2026-11-02 21:00 60"]);
    expect(out.dropped.map((d) => d.id)).toEqual(["a"]);
  });
});
