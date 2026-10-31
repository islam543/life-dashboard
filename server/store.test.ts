import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkin } from "../shared/types";
import { createStore, FILES, upsertCheckin } from "./store";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-store-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

const checkin = (date: string, mood: 1 | 2 | 3 | 4 | 5 = 3): Checkin => ({
  date,
  sleepHours: 7,
  energy: 3,
  mood,
  workoutMinutes: 0,
  spendQar: 0,
});

describe("store", () => {
  it("creates the data folder if missing and round-trips JSON", async () => {
    const store = createStore(path.join(tmp, "nested", "data"));
    await store.write("thing.json", { a: 1, list: [1, 2] });
    expect(await store.read("thing.json", null)).toEqual({ a: 1, list: [1, 2] });
  });

  it("writes atomically: no temp files left, file always parses", async () => {
    const store = createStore(tmp);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.write("race.json", { i })));
    const names = await readdir(tmp);
    expect(names).toEqual(["race.json"]);
    const parsed = JSON.parse(await readFile(path.join(tmp, "race.json"), "utf8"));
    expect(parsed).toEqual({ i: 24 }); // writes are serialized in call order
  });

  it("returns the fallback for a missing or empty file", async () => {
    const store = createStore(tmp);
    expect(await store.read("missing.json", [])).toEqual([]);
    await writeFile(path.join(tmp, "empty.json"), "  \n");
    expect(await store.read("empty.json", { x: 1 })).toEqual({ x: 1 });
  });

  it("recovers from a corrupt file and keeps a copy of it", async () => {
    const store = createStore(tmp);
    await writeFile(path.join(tmp, "bad.json"), "{ not json");
    expect(await store.read("bad.json", [])).toEqual([]);
    const names = await readdir(tmp);
    const backup = names.find((n) => n.startsWith("bad.json.corrupt-"));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(tmp, backup!), "utf8")).toBe("{ not json");
  });

  it("treats valid JSON of the wrong shape as corrupt when a validator is given", async () => {
    const store = createStore(tmp);
    await writeFile(path.join(tmp, "shape.json"), JSON.stringify({ not: "an array" }));
    const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
    expect(await store.read("shape.json", [], isArray)).toEqual([]);
  });

  it("reads a file with a UTF-8 BOM", async () => {
    const store = createStore(tmp);
    await writeFile(path.join(tmp, "bom.json"), "\uFEFF[1]");
    expect(await store.read("bom.json", [])).toEqual([1]);
  });

  it("rejects file names that escape the data folder", () => {
    const store = createStore(tmp);
    expect(() => store.pathOf("../secret.json")).toThrow();
    expect(() => store.pathOf("a/../../b.json")).toThrow();
    expect(() => store.pathOf("C:\\x.json")).toThrow();
    expect(store.pathOf("cache/github.json")).toBe(path.join(tmp, "cache", "github.json"));
  });

  it("refuses to write undefined", async () => {
    const store = createStore(tmp);
    await expect(store.write("u.json", undefined)).rejects.toThrow();
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("upsertCheckin", () => {
  it("adds, replaces by date and keeps the list sorted", async () => {
    const store = createStore(tmp);
    await upsertCheckin(store, checkin("2026-10-29"));
    await upsertCheckin(store, checkin("2026-10-27"));
    const list = await upsertCheckin(store, checkin("2026-10-29", 5));
    expect(list.map((c) => [c.date, c.mood])).toEqual([
      ["2026-10-27", 3],
      ["2026-10-29", 5],
    ]);
    expect(await store.read(FILES.checkins, [])).toEqual(list);
  });

  it("does not lose updates when many saves happen at once", async () => {
    const store = createStore(tmp);
    const dates = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    await Promise.all(dates.map((d) => upsertCheckin(store, checkin(d))));
    const saved = await store.read<Checkin[]>(FILES.checkins, []);
    expect(saved.map((c) => c.date)).toEqual(dates);
  });

  it("starts fresh from a corrupt checkins file without crashing", async () => {
    const store = createStore(tmp);
    await writeFile(store.pathOf(FILES.checkins), "garbage");
    const list = await upsertCheckin(store, checkin("2026-10-30"));
    expect(list).toHaveLength(1);
    expect((await readdir(tmp)).some((n) => n.startsWith("checkins.json.corrupt-"))).toBe(true);
  });
});
