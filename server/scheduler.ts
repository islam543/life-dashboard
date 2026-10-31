/** Collectors run on start and then this often. */
export const COLLECT_EVERY_MS = 30 * 60_000;
/** Next moves run this often. */
export const NEXT_MOVES_EVERY_MS = 3 * 60 * 60_000;

/** A job that never runs twice at once: a call while running joins the running call. */
export interface GuardedJob<T> {
  run(): Promise<T>;
  readonly running: boolean;
}

export function guardedJob<T>(task: () => Promise<T>): GuardedJob<T> {
  let inFlight: Promise<T> | null = null;
  return {
    run() {
      if (inFlight) return inFlight;
      const p = (async () => task())().finally(() => {
        if (inFlight === p) inFlight = null;
      });
      inFlight = p;
      return p;
    },
    get running() {
      return inFlight !== null;
    },
  };
}

export interface SchedulerOptions {
  collect: () => Promise<unknown>;
  nextMoves: () => Promise<unknown>;
  /** Whether to run next moves right after the first collect (for example: never run, or older than 3 h). */
  shouldRunNextMovesOnStart?: () => boolean | Promise<boolean>;
  collectEveryMs?: number;
  nextMovesEveryMs?: number;
  log?: (line: string) => void;
}

export interface Scheduler {
  readonly collect: GuardedJob<unknown>;
  readonly nextMoves: GuardedJob<unknown>;
  /** Resolves when the start-up runs finish. Never rejects. */
  readonly started: Promise<void>;
  stop(): void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startScheduler(opts: SchedulerOptions): Scheduler {
  const log = opts.log ?? ((line: string) => console.log(line));
  const collect = guardedJob(opts.collect);
  const nextMoves = guardedJob(opts.nextMoves);
  let stopped = false;

  const runCollect = () =>
    collect.run().catch((err: unknown) => log(`[scheduler] collect failed: ${describe(err)}`));
  const runNextMoves = () =>
    nextMoves.run().catch((err: unknown) => log(`[scheduler] next moves failed: ${describe(err)}`));

  const started = (async () => {
    await runCollect();
    if (stopped) return;
    try {
      if (opts.shouldRunNextMovesOnStart && (await opts.shouldRunNextMovesOnStart())) await runNextMoves();
    } catch (err) {
      log(`[scheduler] next moves start check failed: ${describe(err)}`);
    }
  })();

  const timers = [
    setInterval(() => void runCollect(), opts.collectEveryMs ?? COLLECT_EVERY_MS),
    setInterval(() => void runNextMoves(), opts.nextMovesEveryMs ?? NEXT_MOVES_EVERY_MS),
  ];

  return {
    collect,
    nextMoves,
    started,
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
    },
  };
}
