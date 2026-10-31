import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedJob, startScheduler } from "./scheduler";

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
