import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { CONNECTORS_FILE, emptyConnectorsCache } from "../connectors/validate";
import { createStore, type Store } from "../store";
import { calendarCollector } from "./calendar";
import type { CollectorContext } from "./types";

// Calendar has no connector tools until Islam signs in; this switch stands in for the
// supervisor filling tools.ts, so the cache path can be tested too.
const tools = vi.hoisted(() => ({ on: false }));
vi.mock("../connectors/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connectors/tools")>();
  return {
    ...actual,
    enabledServices: (lists?: Parameters<typeof actual.enabledServices>[0]) =>
      tools.on ? [...actual.CONNECTOR_SERVICES] : actual.enabledServices(lists),
  };
});

const NOW = new Date("2026-10-31T09:00:00.000Z");
const MIN = 60_000;
let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-calendar-"));
  store = createStore(tmp);
  tools.on = false;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ctx = (): CollectorContext<"calendar"> => ({
  config: loadConfig({}, { rootDir: tmp, home: tmp }),
  store,
  now: NOW,
  signal: new AbortController().signal,
  previous: { calendar: [] },
});
const event = { id: "evt-1", title: "Sprint review", start: "2026-10-31T10:00:00.000Z", end: "2026-10-31T11:00:00.000Z" };

async function saveCache(ageMin: number | null, extra: Record<string, unknown> = {}): Promise<void> {
  const at = ageMin === null ? null : new Date(NOW.getTime() - ageMin * MIN).toISOString();
  await store.write(CONNECTORS_FILE, {
    ...emptyConnectorsCache(),
    fetchedAt: new Date(NOW.getTime() - MIN).toISOString(),
    calendar: { items: at ? [event] : [], fetchedAt: at, lastStatus: "ok", ...extra },
  });
}

describe("calendarCollector", () => {
  it("without connector tools: not_connected with the sign-in steps, even when a cache exists", async () => {
    await saveCache(5);
    expect(await calendarCollector.collect(ctx())).toEqual({
      status: "not_connected",
      message: "Sign in for Claude Code: run claude, type /mcp, pick claude.ai Google Calendar",
      data: { calendar: [] },
    });
  });

  it("with tools: never_run, ok, stale and error from the cache", async () => {
    tools.on = true;
    expect((await calendarCollector.collect(ctx())).status).toBe("never_run");

    await saveCache(30);
    expect(await calendarCollector.collect(ctx())).toEqual({
      status: "ok", message: "Via Claude connector, fetched 11:30", data: { calendar: [event] } });

    await saveCache(180);
    expect(await calendarCollector.collect(ctx())).toMatchObject({ status: "stale", data: { calendar: [event] } });

    await saveCache(null, { lastStatus: "unavailable", error: "Claude could not reach the Google Calendar connector." });
    expect(await calendarCollector.collect(ctx())).toEqual({
      status: "error", message: "Claude could not reach the Google Calendar connector. (via Claude connector)", data: { calendar: [] } });
  });
});
