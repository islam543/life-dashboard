import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { createStore, FILES } from "../store";
import { calendarCollector } from "./calendar";
import { checkinsCollector, selectCheckins, windowStart } from "./checkins";
import { emailCollector } from "./email";
import type { CollectorContext, CollectorSlices, SourceKey } from "./types";

const NOW = new Date(2026, 9, 30, 21, 15); // local time, 2026-10-30

const entry = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  sleepHours: 7,
  energy: 3,
  mood: 4,
  workoutMinutes: 30,
  spendQar: 50,
  ...extra,
});

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-checkins-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

function ctx<K extends SourceKey>(previous: CollectorSlices[K], now: Date = NOW): CollectorContext<K> {
  return {
    config: loadConfig({}, { rootDir: tmp, home: tmp }),
    store: createStore(path.join(tmp, "data")),
    now,
    signal: new AbortController().signal,
    previous,
  };
}

const checkinsCtx = (now: Date = NOW) => ctx<"checkins">({ checkins: [], checkedInToday: false }, now);

describe("selectCheckins", () => {
  it("starts the window 364 days before today, so it holds 365 days", () => {
    expect(windowStart(NOW)).toBe("2025-10-31");
  });

  it("keeps the last 365 days, sorted by date, and drops future dates", () => {
    const raw = [
      entry("2026-10-29"),
      entry("2025-10-30"),
      entry("2026-10-31"),
      entry("2025-10-31"),
      entry("2026-10-30"),
      entry("2026-01-15"),
    ];
    const result = selectCheckins(raw, NOW);
    expect(result.checkins.map((c) => c.date)).toEqual(["2025-10-31", "2026-01-15", "2026-10-29", "2026-10-30"]);
    expect(result.checkedInToday).toBe(true);
    expect(result.skipped).toBe(0);
  });

  it("is not checked in today without an entry for today's local date", () => {
    expect(selectCheckins([entry("2026-10-29")], NOW).checkedInToday).toBe(false);
    const justAfterMidnight = new Date(2026, 9, 31, 0, 30);
    expect(selectCheckins([entry("2026-10-30")], justAfterMidnight).checkedInToday).toBe(false);
    expect(selectCheckins([entry("2026-10-31")], justAfterMidnight).checkedInToday).toBe(true);
  });

  it("skips invalid entries and never reads an undated entry as today", () => {
    const { date: _date, ...undated } = entry("2026-10-30");
    const raw = [undated, entry("", {}), entry("2026-10-28", { mood: 9 }), "junk", null, entry("2026-10-27")];
    const result = selectCheckins(raw, NOW);
    expect(result.checkins.map((c) => c.date)).toEqual(["2026-10-27"]);
    expect(result.checkedInToday).toBe(false);
    expect(result.skipped).toBe(5);
  });

  it("keeps one entry per date, the later one in the file", () => {
    const result = selectCheckins([entry("2026-10-20", { mood: 2 }), entry("2026-10-20", { mood: 5 })], NOW);
    expect(result.checkins).toEqual([entry("2026-10-20", { mood: 5 })]);
  });

  it("returns nothing for content that is not a list", () => {
    expect(selectCheckins({ date: "2026-10-30" }, NOW)).toEqual({ checkins: [], checkedInToday: false, skipped: 0 });
  });
});

describe("checkinsCollector", () => {
  it("returns ok with no check-ins when checkins.json does not exist yet", async () => {
    const result = await checkinsCollector.collect(checkinsCtx());
    expect(result).toEqual({ status: "ok", data: { checkins: [], checkedInToday: false } });
  });

  it("reads checkins.json through the store, sorted, with checkedInToday", async () => {
    const c = checkinsCtx();
    await c.store.write(FILES.checkins, [entry("2026-10-30"), entry("2026-10-01"), entry("2024-01-01")]);
    const result = await checkinsCollector.collect(c);
    expect(result.status).toBe("ok");
    expect(result.message).toBeUndefined();
    expect(result.data?.checkins.map((x) => x.date)).toEqual(["2026-10-01", "2026-10-30"]);
    expect(result.data?.checkedInToday).toBe(true);
  });

  it("says how many entries it skipped", async () => {
    const c = checkinsCtx();
    await c.store.write(FILES.checkins, [entry("2026-10-29"), entry("2026-10-28", { energy: 0 })]);
    const result = await checkinsCollector.collect(c);
    expect(result.status).toBe("ok");
    expect(result.data?.checkins.map((x) => x.date)).toEqual(["2026-10-29"]);
    expect(result.message).toBe("Skipped 1 check-in with missing or invalid fields in checkins.json");
  });

  it("returns ok with no check-ins when the file is corrupt", async () => {
    const c = checkinsCtx();
    await mkdir(c.store.dir, { recursive: true });
    await writeFile(c.store.pathOf(FILES.checkins), "{ not json", "utf8");
    const result = await checkinsCollector.collect(c);
    expect(result).toEqual({ status: "ok", data: { checkins: [], checkedInToday: false } });
  });
});

describe("calendar and email stubs", () => {
  it("calendar is not_connected with an empty list", async () => {
    expect(await calendarCollector.collect(ctx<"calendar">({ calendar: [] }))).toEqual({
      status: "not_connected",
      message: "Connect Google Calendar",
      data: { calendar: [] },
    });
  });

  it("email is not_connected with an empty list", async () => {
    expect(await emailCollector.collect(ctx<"email">({ email: [] }))).toEqual({
      status: "not_connected",
      message: "Connect Gmail",
      data: { email: [] },
    });
  });
});
