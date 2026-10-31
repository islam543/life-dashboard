import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTORS_FIRST_RUN_MS,
  CONNECTORS_MANUAL_MIN_AGE_MS,
  connectorRunDue,
  connectorsIntervalMs,
  guardedJob,
  startScheduler,
} from "./scheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("guardedJob", () => {
  it("never runs twice at once; a second call joins the first", async () => {
    let release!: () => void;
    const task = vi.fn(() => new Promise<string>((r) => (release = () => r("done"))));
    const job = guardedJob(task);
    const a = job.run();
    const b = job.run();
    expect(job.running).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all([a, b])).toEqual(["done", "done"]);
    expect(job.running).toBe(false);
    const c = job.run();
    expect(task).toHaveBeenCalledTimes(2);
    release();
    await c;
  });

  it("frees the guard after a failure", async () => {
    const job = guardedJob(vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok"));
    await expect(job.run()).rejects.toThrow("boom");
    await expect(job.run()).resolves.toBe("ok");
  });
});

describe("startScheduler", () => {
  it("collects on start, then next moves, then on each interval without overlap", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let releaseCollect: (() => void) | null = null;
    const collect = vi.fn(async () => {
      order.push("collect");
      await new Promise<void>((r) => (releaseCollect = r));
    });
    const nextMoves = vi.fn(async () => {
      order.push("next");
    });
    const scheduler = startScheduler({
      collect,
      nextMoves,
      shouldRunNextMovesOnStart: () => true,
      collectEveryMs: 1_000,
      nextMovesEveryMs: 10_000,
      log: () => undefined,
    });

    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_500); // three ticks while the first collect still runs
    expect(collect).toHaveBeenCalledTimes(1);

    releaseCollect!();
    await scheduler.started;
    expect(order).toEqual(["collect", "next"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(collect).toHaveBeenCalledTimes(2);
    releaseCollect!();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(nextMoves).toHaveBeenCalledTimes(2);

    scheduler.stop();
    const calls = collect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(collect.mock.calls.length).toBe(calls);
  });

  it("skips next moves on start when not due, and survives a failing collect", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const nextMoves = vi.fn(async () => undefined);
    const scheduler = startScheduler({
      collect: async () => {
        throw new Error("disk full");
      },
      nextMoves,
      shouldRunNextMovesOnStart: () => false,
      log,
    });
    await scheduler.started;
    expect(nextMoves).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[scheduler] collect failed: disk full");
    scheduler.stop();
  });
});

describe("connector runs (T26)", () => {
  const MIN = 60_000;
  const base = { collect: async () => undefined, nextMoves: async () => undefined, log: () => undefined };

  it("interval: CONNECTORS_EVERY_MIN, default 60, never below 15", () => {
    expect(connectorsIntervalMs()).toBe(60 * MIN);
    expect(connectorsIntervalMs(30)).toBe(30 * MIN);
    expect(connectorsIntervalMs(15)).toBe(15 * MIN);
    expect(connectorsIntervalMs(5)).toBe(15 * MIN);
    expect(connectorsIntervalMs(0)).toBe(60 * MIN);
    expect(connectorsIntervalMs(-3)).toBe(60 * MIN);
    expect(connectorsIntervalMs(Number.NaN)).toBe(60 * MIN);
  });

  it("manual refresh threshold: due when never run or at least 10 minutes old", () => {
    const now = new Date("2026-10-31T09:00:00.000Z");
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(CONNECTORS_MANUAL_MIN_AGE_MS).toBe(10 * MIN);
    expect(connectorRunDue(null, now)).toBe(true);
    expect(connectorRunDue("garbage", now)).toBe(true);
    expect(connectorRunDue(ago(5 * MIN), now)).toBe(false);
    expect(connectorRunDue(ago(10 * MIN - 1), now)).toBe(false);
    expect(connectorRunDue(ago(10 * MIN), now)).toBe(true);
    expect(connectorRunDue(ago(-5 * MIN), now)).toBe(true); // clock moved back
  });

  it("first run 60 s after start, then on the floored interval; never blocks the start-up collect", async () => {
    vi.useFakeTimers();
    const connectors = vi.fn(() => new Promise<void>(() => undefined)); // a run that never ends
    const scheduler = startScheduler({ ...base, connectors, connectorsEveryMs: 1 * MIN });
    await scheduler.started; // collect finished without waiting for the connector run
    expect(connectors).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CONNECTORS_FIRST_RUN_MS - 1);
    expect(connectors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connectors).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("repeats every interval (floor 15 min) without overlapping a running run", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const connectors = vi.fn(() => new Promise<void>((r) => (release = r)));
    const scheduler = startScheduler({ ...base, connectors, connectorsEveryMs: 1 * MIN });
    await vi.advanceTimersByTimeAsync(CONNECTORS_FIRST_RUN_MS);
    expect(connectors).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(connectors).toHaveBeenCalledTimes(1); // 1 min asked, 15 min floor
    release!();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(connectors).toHaveBeenCalledTimes(2);

    // Still running at the next tick: the tick joins it instead of starting another.
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(connectors).toHaveBeenCalledTimes(2);
    release!();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(connectors).toHaveBeenCalledTimes(3);

    scheduler.stop();
    release!();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(connectors).toHaveBeenCalledTimes(3);
  });

  it("manual refresh starts a run only when the last one is 10+ minutes old, and does not wait for it", async () => {
    let lastRunAt: string | null = new Date(Date.now() - 5 * MIN).toISOString();
    let release: (() => void) | null = null;
    const connectors = vi.fn(() => new Promise<void>((r) => (release = r)));
    const scheduler = startScheduler({ ...base, connectors, connectorsFirstRunMs: 60 * MIN, connectorsLastRunAt: () => lastRunAt });

    expect(await scheduler.refreshConnectorsIfDue()).toBe(false);
    expect(connectors).not.toHaveBeenCalled();

    lastRunAt = new Date(Date.now() - 11 * MIN).toISOString();
    expect(await scheduler.refreshConnectorsIfDue()).toBe(true); // resolves while the run is still going
    expect(connectors).toHaveBeenCalledTimes(1);
    expect(scheduler.connectors?.running).toBe(true);

    // A second click while it runs starts nothing.
    expect(await scheduler.refreshConnectorsIfDue()).toBe(false);
    expect(connectors).toHaveBeenCalledTimes(1);

    release!();
    await vi.waitFor(() => expect(scheduler.connectors?.running).toBe(false));
    lastRunAt = null;
    expect(await scheduler.refreshConnectorsIfDue()).toBe(true);
    expect(connectors).toHaveBeenCalledTimes(2);
    release!();
    scheduler.stop();
  });

  it("without a connector job, or after stop, manual refresh does nothing", async () => {
    const plain = startScheduler(base);
    expect(plain.connectors).toBeNull();
    expect(await plain.refreshConnectorsIfDue()).toBe(false);
    plain.stop();

    const connectors = vi.fn(async () => undefined);
    const stopped = startScheduler({ ...base, connectors, connectorsLastRunAt: () => null });
    stopped.stop();
    expect(await stopped.refreshConnectorsIfDue()).toBe(false);
    expect(connectors).not.toHaveBeenCalled();
  });

  it("a failing last-run lookup is logged, not thrown", async () => {
    const log = vi.fn();
    const connectors = vi.fn(async () => undefined);
    const scheduler = startScheduler({ ...base, log, connectors, connectorsLastRunAt: () => Promise.reject(new Error("disk")) });
    expect(await scheduler.refreshConnectorsIfDue()).toBe(false);
    expect(log).toHaveBeenCalledWith("[scheduler] connector refresh check failed: disk");
    scheduler.stop();
  });
});
