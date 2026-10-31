import { existsSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiError, Checkin, NextMovesFile } from "../shared/types";
import type { MoveState } from "./ai/nextMoves";
import { validateCheckin } from "./checkinValidate";
import { config, PORT, WEB_DEV_PORT } from "./config";
import { createNotesStore, type NotesStore } from "./notes";
import { focusRoutes } from "./routes/focus";
import { jiraRoutes } from "./routes/jira";
import { notesRoutes } from "./routes/notes";
import { projectsRoutes } from "./routes/projects";
import { scheduleRoutes } from "./routes/schedule";
import type { SnapshotService } from "./snapshot";
import { createStore, type Store } from "./store";

/** The next-moves functions from ai/nextMoves.ts, injected so tests never run `claude`. */
export interface NextMovesApi {
  get(): Promise<NextMovesFile>;
  run(): Promise<NextMovesFile>;
  setState(id: string, state: MoveState): Promise<NextMovesFile | null>;
}

export interface AppDeps {
  snapshots: Pick<SnapshotService, "get" | "refresh" | "refreshLocal">;
  nextMoves: NextMovesApi;
  /** Persists a validated check-in (upsert by date into data/checkins.json). */
  saveCheckin(checkin: Checkin): Promise<unknown>;
  /** data/ store for projects.json. Default: createStore(config.dataDir). */
  store?: Store;
  /**
   * Notes store for /api/notes. Default: createNotesStore(config.notesDir, { vaults: config.vaults }). Pass the same instance
   * the snapshot service uses when you can, so one mtime cache serves both.
   */
  notes?: NotesStore;
  now?: () => Date;
  /** Folder with the built web app; served when it holds index.html. */
  webDistDir?: string | null;
  /** Ports allowed in the Origin header of a write request. Default: API port and Vite dev port. */
  allowedPorts?: readonly number[];
  log?: (line: string) => void;
}


const MAX_BODY_BYTES = 16 * 1024;
/** /api/notes* only: a 200 KB note body can roughly double when JSON-escaped (newlines, quotes). */
const MAX_NOTES_BODY_BYTES = 512 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

function fail(c: Context, status: ContentfulStatusCode, error: string) {
  return c.json({ error } satisfies ApiError, status);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; error: string };

async function readJson(c: Context): Promise<BodyResult> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return { ok: false, error: "Send the body as JSON with Content-Type: application/json" };
  }
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false, error: "Body is not valid JSON" };
  }
}

/**
 * The Hono app with every API route. No network listening here (see index.ts), so tests
 * can call `app.request()` directly.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const ports = deps.allowedPorts ?? [PORT, WEB_DEV_PORT];
  const allowedOrigins = new Set(
    ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`]),
  );

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // motion and d3 set inline style attributes.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // Local-only guard. The server binds 127.0.0.1, but a web page in the browser can still
  // try to reach it: a foreign Host header means DNS rebinding, a foreign Origin on a write
  // means cross-site request forgery. Both are refused. No CORS headers are ever sent.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host !== undefined && !LOOPBACK_HOSTS.has(hostnameOf(host))) {
      return fail(c, 403, "Requests must come from this computer");
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !allowedOrigins.has(origin)) return fail(c, 403, "Cross-origin requests are not allowed");
      if (c.req.header("sec-fetch-site") === "cross-site") return fail(c, 403, "Cross-origin requests are not allowed");
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const tooLarge = (c: Context) => fail(c, 413, "Request body is too large");
  const smallBodies = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
  const noteBodies = bodyLimit({ maxSize: MAX_NOTES_BODY_BYTES, onError: tooLarge });
  app.use("/api/*", (c, next) => {
    const p = c.req.path;
    // Notes and Jira create carry note-sized text (up to 15 issues with long or Arabic descriptions).
    const big = p === "/api/notes" || p.startsWith("/api/notes/") || p.startsWith("/api/jira/");
    return big ? noteBodies(c, next) : smallBodies(c, next);
  });

  app.get("/api/snapshot", (c) => c.json(deps.snapshots.get(now())));

  app.post("/api/refresh", async (c) => {
    await deps.snapshots.refresh();
    return c.json(deps.snapshots.get(now()));
  });

  app.get("/api/next-moves", async (c) => c.json(await deps.nextMoves.get()));

  // Registered before /:id so "run" is never read as a move id.
  app.post("/api/next-moves/run", async (c) => {
    // Started synchronously (not awaited) so the run can mark itself "running" before get().
    let running: Promise<NextMovesFile>;
    try {
      running = deps.nextMoves.run();
    } catch (err) {
      running = Promise.reject(err);
    }
    running.catch((err: unknown) => {
      log(`[next-moves] run failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const current = await deps.nextMoves.get();
    return c.json({ ...current, status: "running" } satisfies NextMovesFile, 202);
  });

  app.post("/api/next-moves/:id", async (c) => {
    const id = c.req.param("id");
    if (id.length === 0 || id.length > 200) return fail(c, 400, "Move id is missing or too long");
    const body = await readJson(c);
    if (!body.ok) return fail(c, 400, body.error);
    const state = (body.value as { state?: unknown } | null)?.state;
    if (state !== "done" && state !== "dismissed") return fail(c, 400, 'state must be "done" or "dismissed"');
    const file = await deps.nextMoves.setState(id, state);
    if (!file) return fail(c, 404, "No next move with that id");
    return c.json(file);
  });

  app.post("/api/checkin", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return fail(c, 400, body.error);
    const result = validateCheckin(body.value, now());
    if (!result.ok) return fail(c, 400, result.error);
    await deps.saveCheckin(result.value);
    await deps.snapshots.refresh(["checkins"]);
    return c.json(deps.snapshots.get(now()));
  });

  // v1.1 routers. Mounted after every guard above, so they inherit the Host, Origin and
  // Sec-Fetch-Site checks, no-store and the body limits. Their errors reach onError below.
  const snapshots = deps.snapshots;
  const store = deps.store ?? createStore(config.dataDir);
  const notes = deps.notes ?? createNotesStore(config.notesDir, { vaults: config.vaults });
  app.route("/api/projects", projectsRoutes({ store, snapshots, now, log }));
  app.route("/api/notes", notesRoutes({ notes, snapshots, now, log }));
  // v1.2 routers (tickets T27, T28): same guards, same shared notes store.
  app.route("/api/schedule", scheduleRoutes({ notes, store, snapshots, now, log }));
  app.route("/api/focus", focusRoutes({ notes, store, snapshots, now, log }));
  app.route("/api/jira", jiraRoutes({ notes, store, snapshots, now, log }));

  const dist = deps.webDistDir ? path.resolve(deps.webDistDir) : null;
  if (dist && existsSync(path.join(dist, "index.html"))) {
    // The page itself is re-checked on every load, so a rebuild shows at once; the hashed files in
    // /assets never change under the same name and stay cached.
    app.use("/*", async (c, next) => {
      await next();
      if (!c.req.path.startsWith("/api/") && !c.req.path.startsWith("/assets/")) c.header("Cache-Control", "no-cache");
    });
    app.use("/*", serveStatic({ root: dist }));
  } else {
    app.get("/", (c) =>
      c.text(
        "The web app is not built yet. Run `npm run build` and then `npm start`, or run `npm run dev` and open http://127.0.0.1:5173.",
      ),
    );
  }

  app.notFound((c) => (c.req.path.startsWith("/api/") ? fail(c, 404, "Not found") : c.text("Not found", 404)));

  // Routers and stores throw HTTPException(status, { message }) for answers the client should see
  // (400, 404, 409, 413, 501). Anything else is a bug: logged, and a generic 500 for the client.
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status >= 400 && err.status < 600 && err.status !== 500) {
      return fail(c, err.status, err.message || "Request failed");
    }
    log(`[api] ${c.req.method} ${c.req.path} failed: ${err.message}`);
    return fail(c, 500, "Something went wrong on the server");
  });

  return app;
}
