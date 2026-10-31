/** Collectors run on start and then this often. */
export const COLLECT_EVERY_MS = 30 * 60_000;
/** Next moves run this often. */
export const NEXT_MOVES_EVERY_MS = 3 * 60 * 60_000;

/** The first Claude connector run starts this long after the server (ticket T26). */
export const CONNECTORS_FIRST_RUN_MS = 60_000;
export const CONNECTORS_DEFAULT_EVERY_MIN = 60;
/** Connector runs cost Claude usage: never more often than this. */
export const CONNECTORS_MIN_EVERY_MIN = 15;
/** A manual refresh starts a connector run only when the last run is older than this. */
export const CONNECTORS_MANUAL_MIN_AGE_MS = 10 * 60_000;

/** Minutes between connector runs (CONNECTORS_EVERY_MIN) to ms: default 60, floor 15. */
export function connectorsIntervalMs(everyMin?: number): number {
  const minutes = typeof everyMin === "number" && Number.isFinite(everyMin) && everyMin > 0 ? everyMin : CONNECTORS_DEFAULT_EVERY_MIN;
  return Math.max(CONNECTORS_MIN_EVERY_MIN, minutes) * 60_000;
}

/**
 * Whether a manual refresh should start a connector run: no run yet, an unreadable time, a
 * time in the future (clock changed), or a last run at least 10 minutes old.
 */
export function connectorRunDue(lastRunAt: string | null, now: Date, minAgeMs: number = CONNECTORS_MANUAL_MIN_AGE_MS): boolean {
  if (!lastRunAt) return true;
  const at = Date.parse(lastRunAt);
  if (!Number.isFinite(at)) return true;
  const age = now.getTime() - at;
  return age < 0 || age >= minAgeMs;
}

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
  /** The Claude connector run. First run after CONNECTORS_FIRST_RUN_MS, then every connectorsEveryMs. */
  connectors?: () => Promise<unknown>;
  /** Floored to CONNECTORS_MIN_EVERY_MIN. Default 60 minutes. */
  connectorsEveryMs?: number;
  connectorsFirstRunMs?: number;
  /** When the last connector run finished (null before the first), for refreshConnectorsIfDue. */
  connectorsLastRunAt?: () => Promise<string | null> | string | null;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Scheduler {
  readonly collect: GuardedJob<unknown>;
  readonly nextMoves: GuardedJob<unknown>;
  /** null when no connector job was given. */
  readonly connectors: GuardedJob<unknown> | null;
  /** Resolves when the start-up runs finish. Never rejects. */
  readonly started: Promise<void>;
  /**
   * For a manual refresh: starts a connector run when the last one is older than 10 minutes,
   * without waiting for it. Resolves true when it started one. Never rejects.
   */
  refreshConnectorsIfDue(): Promise<boolean>;
  stop(): void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startScheduler(opts: SchedulerOptions): Scheduler {
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => new Date());
  const collect = guardedJob(opts.collect);
  const nextMoves = guardedJob(opts.nextMoves);
  const connectors = opts.connectors ? guardedJob(opts.connectors) : null;
  let stopped = false;

  const runCollect = () =>
    collect.run().catch((err: unknown) => log(`[scheduler] collect failed: ${describe(err)}`));
  const runNextMoves = () =>
    nextMoves.run().catch((err: unknown) => log(`[scheduler] next moves failed: ${describe(err)}`));
  const runConnectors = () =>
    connectors?.run().catch((err: unknown) => log(`[scheduler] connector run failed: ${describe(err)}`));

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
  // The connector run never blocks the start-up collect: it has its own timers.
  const connectorsEveryMs = Math.max(opts.connectorsEveryMs ?? connectorsIntervalMs(), CONNECTORS_MIN_EVERY_MIN * 60_000);
  const firstConnectorRun = connectors
    ? setTimeout(() => {
        if (stopped) return;
        void runConnectors();
        timers.push(setInterval(() => void runConnectors(), connectorsEveryMs));
      }, opts.connectorsFirstRunMs ?? CONNECTORS_FIRST_RUN_MS)
    : null;

  return {
    collect,
    nextMoves,
    connectors,
    started,
    async refreshConnectorsIfDue() {
      if (!connectors || stopped || connectors.running) return false;
      try {
        const last = opts.connectorsLastRunAt ? await opts.connectorsLastRunAt() : null;
        if (!connectorRunDue(last, now())) return false;
      } catch (err) {
        log(`[scheduler] connector refresh check failed: ${describe(err)}`);
        return false;
      }
      if (stopped || connectors.running) return false;
      void runConnectors();
      return true;
    },
    stop() {
      stopped = true;
      if (firstConnectorRun) clearTimeout(firstConnectorRun);
      for (const t of timers) clearInterval(t);
    },
  };
}
