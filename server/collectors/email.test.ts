import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { CONNECTORS_FILE, emptyConnectorsCache } from "../connectors/validate";
import { createStore, type Store } from "../store";
import { emailCollector } from "./email";
import type { CollectorContext } from "./types";

// "off" stands for a setup where Calendar and Gmail have no connector tools (not signed in);
// "on" enables every service, so both the sign-in message and the cache path are tested.
const tools = vi.hoisted(() => ({ on: false }));
vi.mock("../connectors/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connectors/tools")>();
  return {
    ...actual,
    enabledServices: (lists?: Parameters<typeof actual.enabledServices>[0]) =>
      tools.on ? [...actual.CONNECTOR_SERVICES] : actual.enabledServices({ ...actual.CONNECTOR_TOOLS, calendar: [], email: [], ...lists }),
  };
});

const NOW = new Date("2026-10-31T09:00:00.000Z");
const MIN = 60_000;
let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-email-"));
  store = createStore(tmp);
  tools.on = false;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ctx = (): CollectorContext<"email"> => ({
  config: loadConfig({}, { rootDir: tmp, home: tmp }),
  store,
  now: NOW,
  signal: new AbortController().signal,
  previous: { email: [] },
});
const mail = { id: "m-1", from: "Sara <sara@example.com>", subject: "UAT sign-off", receivedAt: "2026-10-31T07:15:00.000Z" };

describe("emailCollector", () => {
  it("without connector tools: not_connected with the sign-in steps", async () => {
    expect(await emailCollector.collect(ctx())).toEqual({
      status: "not_connected",
      message: "Sign in for Claude Code: run claude, type /mcp, pick claude.ai Gmail",
      data: { email: [] },
    });
  });

  it("with tools: reads fresh mail from the cache and re-checks it", async () => {
    tools.on = true;
    await store.write(CONNECTORS_FILE, {
      ...emptyConnectorsCache(),
      fetchedAt: new Date(NOW.getTime() - 10 * MIN).toISOString(),
      email: {
        items: [mail, { ...mail, id: "m-2", url: "https://evil.example.com/", body: "secret body" }, { id: "m-3", subject: "no sender" }],
        fetchedAt: new Date(NOW.getTime() - 10 * MIN).toISOString(),
        lastStatus: "ok",
      },
    });
    const result = await emailCollector.collect(ctx());
    expect(result).toEqual({
      status: "ok",
      message: "Via Claude connector, fetched 11:50",
      data: { email: [mail, { ...mail, id: "m-2" }] },
    });
  });

  it("with tools and no run yet: never_run", async () => {
    tools.on = true;
    expect(await emailCollector.collect(ctx())).toEqual({
      status: "never_run", message: "Waiting for the first Claude connector run", data: { email: [] } });
  });
});
