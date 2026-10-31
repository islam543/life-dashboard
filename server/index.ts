import { serve } from "@hono/node-server";
import { getNextMoves, resolveClaudeCommand, runNextMoves, setMoveState } from "./ai/nextMoves";
import { createApp } from "./app";
import { collectors } from "./collectors";
import { jiraSites } from "./collectors/jira";
import { config } from "./config";
import { createConnectorRuns } from "./connectors/run";
import { CONNECTOR_TOOLS, enabledServices } from "./connectors/tools";
import { NEXT_MOVES_EVERY_MS, connectorsIntervalMs, startScheduler, type Scheduler } from "./scheduler";
import { createNotesStore } from "./notes";
import { createSnapshotService } from "./snapshot";
import { createStore, FILES, upsertCheckin } from "./store";

// Entry point.
//   tsx server/index.ts            serve the API (and web/dist when built) on 127.0.0.1:4317
//   tsx server/index.ts --collect  run every collector once, save data/snapshot.json, exit

async function collectOnce(): Promise<void> {
  const store = createStore(config.dataDir);
  const snapshots = createSnapshotService({ collectors, config, store, log: () => undefined });
  await snapshots.load();
  const snapshot = await snapshots.refresh();
  for (const [key, state] of Object.entries(snapshot.sources)) {
    console.log(`${key.padEnd(15)} ${state.status}${state.message ? `  ${state.message}` : ""}`);
  }
  console.log(`Saved ${store.pathOf(FILES.snapshot)}`);
}

async function serveApp(): Promise<void> {
  const store = createStore(config.dataDir);
  // One notes store for the snapshot and the API, so they share one cache.
  const notes = createNotesStore(config.notesDir);
  const snapshots = createSnapshotService({ collectors, config, store, notes });
  await snapshots.load();

  // Claude connector run (ticket T26). With JIRA_API_TOKEN set, Jira stays on its REST path,
  // so the run leaves Jira out instead of spending Claude usage on it.
  const connectorTools = config.jira.apiToken ? { ...CONNECTOR_TOOLS, jira: [] } : CONNECTOR_TOOLS;
  const connectorSources = enabledServices(connectorTools);
  const connectors = createConnectorRuns({
    store,
    runDir: config.connectors.runDir,
    jiraSites: jiraSites(config.jira.site),
    tools: connectorTools,
    command: resolveClaudeCommand(config.home),
  });
  // After each run the affected panels read the new cache at once (cheap: no network).
  const runConnectors = async () => {
    await connectors.run();
    if (connectorSources.length) await snapshots.refresh(connectorSources);
  };

  let scheduler: Scheduler | null = null;

  const app = createApp({
    snapshots: {
      get: snapshots.get,
      refreshLocal: snapshots.refreshLocal,
      // A manual Refresh also starts a connector run when the last one is older than 10 minutes.
      // It does not wait for it; the panels update when the run finishes.
      refresh: (keys) => {
        if (!keys) void scheduler?.refreshConnectorsIfDue();
        return snapshots.refresh(keys);
      },
    },
    notes,
    nextMoves: { get: getNextMoves, run: runNextMoves, setState: setMoveState },
    saveCheckin: (checkin) => upsertCheckin(store, checkin),
    webDistDir: config.webDistDir,
  });

  // The scheduler starts only once the port is ours, so a second copy never collects.
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`Life dashboard API on http://${info.address}:${info.port}`);
    scheduler = startScheduler({
      collect: () => snapshots.refresh(),
      nextMoves: runNextMoves,
      shouldRunNextMovesOnStart: async () => {
        const file = await getNextMoves();
        if (!file.generatedAt) return true;
        return Date.now() - Date.parse(file.generatedAt) > NEXT_MOVES_EVERY_MS;
      },
      connectors: connectorSources.length ? runConnectors : undefined,
      connectorsEveryMs: connectorsIntervalMs(config.connectors.everyMin),
      connectorsLastRunAt: async () => (await connectors.read()).fetchedAt,
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${config.port} on ${config.host} is already in use. Another copy of the dashboard may be running; stop it and try again.`,
      );
    } else {
      console.error(`Server failed to start: ${err.message}`);
    }
    process.exit(1);
  });

  const shutdown = () => {
    scheduler?.stop();
    server.close();
    // Collectors, a next-moves run or a connector run may still hold child processes; do not
    // wait for them. An unfinished connector run writes nothing, and the next start runs again.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const main = process.argv.includes("--collect") ? collectOnce : serveApp;

main().then(
  () => {
    if (process.argv.includes("--collect")) process.exit(0);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
