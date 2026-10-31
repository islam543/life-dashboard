import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkin, NextMovesFile, Snapshot } from "../shared/types";
import type { NextMovesApi } from "./app";
import { createApp } from "./app";
import { localDateKey } from "./checkinValidate";
import type { CollectorRegistry } from "./collectors/types";
import { SOURCE_KEYS } from "./collectors/types";
import { loadConfig } from "./config";
import { createNotesStore, type NotesStore } from "./notes";
import { createSnapshotService } from "./snapshot";
import { createStore, FILES, upsertCheckin, type Store } from "./store";

const NOW = new Date(2026, 9, 30, 9, 0);

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-app-"));
  store = createStore(path.join(tmp, "data"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

function fakeNextMoves(): NextMovesApi & { runs: number } {
  let file: NextMovesFile = {
    generatedAt: NOW.toISOString(),
    status: "ok",
    moves: [{ id: "m1", title: "Review PR #42", reason: "Blocks Thursday release", area: "work", rank: 1, state: "open" }],
  };
  const api = {
    runs: 0,
    get: async () => file,
    run: async () => {
      api.runs += 1;
      return file;
    },
    setState: async (id: string, state: "done" | "dismissed") => {
      if (!file.moves.some((m) => m.id === id)) return null;
      file = { ...file, moves: file.moves.map((m) => (m.id === id ? { ...m, state } : m)) };
      return file;
    },
  };
  return api;
}

function build(opts: { webDistDir?: string; notes?: NotesStore } = {}) {
  // Notes live in a temp folder; the real vault is never touched.
  const notes = opts.notes ?? createNotesStore(path.join(tmp, "notes"));
  const base = Object.fromEntries(
    SOURCE_KEYS.map((k) => [k, { key: k, collect: async () => ({ status: "never_run", data: null }) }]),
  ) as unknown as CollectorRegistry;
  const collectors: CollectorRegistry = {
    ...base,
    // Same file and shape T04 reads: data/checkins.json holding Checkin[].
    checkins: {
      key: "checkins",
      collect: async (ctx) => {
        const list = await ctx.store.read<Checkin[]>(FILES.checkins, []);
        return { status: "ok", data: { checkins: list, checkedInToday: list.some((c) => c.date === localDateKey(ctx.now)) } };
      },
    },
  };
  const snapshots = createSnapshotService({
    collectors,
    config: loadConfig({}, { rootDir: tmp, home: tmp }),
    store,
    notes,
    now: () => NOW,
    log: () => undefined,
  });
  const nextMoves = fakeNextMoves();
  const app = createApp({
    snapshots,
    nextMoves,
    saveCheckin: (c) => upsertCheckin(store, c),
    store,
    notes,
    now: () => NOW,
    webDistDir: opts.webDistDir ?? null,
    log: () => undefined,
  });
  return { app, nextMoves };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const goodCheckin = { sleepHours: 7, energy: 4, mood: 4, workoutMinutes: 30, spendQar: 55 };

describe("API routes", () => {
  it("GET /api/snapshot returns a contract-shaped snapshot", async () => {
    const { app } = build();
    const res = await app.request("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const snap = (await res.json()) as Snapshot;
    expect(Object.keys(snap.sources).sort()).toEqual([...SOURCE_KEYS].sort());
    expect(snap.sources.github).toEqual({ status: "never_run", updatedAt: null });
    expect(Array.isArray(snap.needsYou)).toBe(true);
    expect(Object.keys(snap.work).sort()).toEqual(["ci", "jira", "prs", "repoActivity", "sessionTime"]);
    expect(snap.personal).toEqual({ checkins: [], checkedInToday: false });
    expect(typeof snap.generatedAt).toBe("string");
  });

  it("POST /api/refresh runs collectors and returns the snapshot", async () => {
    const { app } = build();
    const res = await app.request("/api/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Snapshot;
    expect(snap.sources.checkins.status).toBe("ok");
  });

  it("GET /api/next-moves returns the file", async () => {
    const { app } = build();
    const res = await app.request("/api/next-moves");
    expect(res.status).toBe(200);
    expect(((await res.json()) as NextMovesFile).moves).toHaveLength(1);
  });

  it("POST /api/next-moves/run answers 202 with status running", async () => {
    const { app, nextMoves } = build();
    const res = await app.request("/api/next-moves/run", { method: "POST" });
    expect(res.status).toBe(202);
    expect(((await res.json()) as NextMovesFile).status).toBe("running");
    expect(nextMoves.runs).toBe(1);
  });

  it("POST /api/next-moves/:id sets state, 400 on bad state, 404 on unknown id", async () => {
    const { app } = build();
    const ok = await app.request("/api/next-moves/m1", json({ state: "done" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as NextMovesFile).moves[0]?.state).toBe("done");
    expect((await app.request("/api/next-moves/m1", json({ state: "open" }))).status).toBe(400);
    expect((await app.request("/api/next-moves/m1", json({}))).status).toBe(400);
    expect((await app.request("/api/next-moves/nope", json({ state: "dismissed" }))).status).toBe(404);
  });

  it("POST /api/checkin saves, upserts by date and returns the snapshot", async () => {
    const { app } = build();
    const first = await app.request("/api/checkin", json(goodCheckin));
    expect(first.status).toBe(200);
    const snap = (await first.json()) as Snapshot;
    expect(snap.personal.checkedInToday).toBe(true);
    expect(snap.personal.checkins).toEqual([{ date: "2026-10-30", ...goodCheckin }]);

    const second = await app.request("/api/checkin", json({ ...goodCheckin, mood: 2, note: "tired" }));
    const again = (await second.json()) as Snapshot;
    expect(again.personal.checkins).toEqual([{ date: "2026-10-30", ...goodCheckin, mood: 2, note: "tired" }]);
  });

  it("POST /api/checkin answers 400 with a plain message on bad input", async () => {
    const { app } = build();
    const bad = await app.request("/api/checkin", json({ ...goodCheckin, energy: 9 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "energy must be a whole number from 1 to 5" });

    const future = await app.request("/api/checkin", json({ ...goodCheckin, date: "2026-10-31" }));
    expect(future.status).toBe(400);

    const notJson = await app.request("/api/checkin", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "Body is not valid JSON" });

    const wrongType = await app.request("/api/checkin", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(goodCheckin) });
    expect(wrongType.status).toBe(400);

    expect(await store.read(FILES.checkins, null)).toBeNull();
  });

  it("rejects oversized bodies", async () => {
    const { app } = build();
    const res = await app.request("/api/checkin", json({ ...goodCheckin, note: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it("answers JSON 404 for unknown API paths", async () => {
    const { app } = build();
    const res = await app.request("/api/nothing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("local-only guard", () => {
  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const { app } = build();
    const res = await app.request("/api/snapshot", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(403);
    expect((await app.request("/api/snapshot", { headers: { host: "127.0.0.1:4317" } })).status).toBe(200);
    expect((await app.request("/api/snapshot", { headers: { host: "localhost:5173" } })).status).toBe(200);
  });

  it("refuses writes from another origin", async () => {
    const { app } = build();
    const evil = await app.request("/api/checkin", json(goodCheckin, { origin: "https://evil.example.com" }));
    expect(evil.status).toBe(403);
    const otherLocalApp = await app.request("/api/refresh", { method: "POST", headers: { origin: "http://localhost:3000" } });
    expect(otherLocalApp.status).toBe(403);
    const crossSite = await app.request("/api/refresh", { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const vite = await app.request("/api/checkin", json(goodCheckin, { origin: "http://127.0.0.1:5173" }));
    expect(vite.status).toBe(200);
  });

  it("sends no CORS headers", async () => {
    const { app } = build();
    const res = await app.request("/api/snapshot", { headers: { origin: "https://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// The v1.1 routers. Every assertion here holds for the T15 stubs (501) and for the built routers
// (T16, T17) alike, so these tests stay as they are when the stubs are filled in.
describe("v1.1 routers (/api/projects, /api/notes)", () => {
  /** A JSON request whose body (and Content-Length) is exactly `bytes` long. */
  const sized = (method: string, bytes: number) => ({
    method,
    headers: { "content-type": "application/json", "content-length": String(bytes) },
    body: JSON.stringify({ body: "x".repeat(bytes - 11) }),
  });

  it("are mounted: answers come from the routers as JSON with no-store, never the JSON 404", async () => {
    const { app } = build();
    for (const p of ["/api/projects", "/api/notes"]) {
      const res = await app.request(p);
      expect(res.status, p).not.toBe(404);
      expect(res.headers.get("cache-control"), p).toBe("no-store");
      expect(res.headers.get("content-type"), p).toMatch(/^application\/json/);
    }
  });

  it("answers 501 Not built yet as an ApiError when a store is not built", async () => {
    const unbuilt = async (): Promise<never> => {
      throw new HTTPException(501, { message: "Not built yet" });
    };
    const notes: NotesStore = {
      index: unbuilt,
      read: unbuilt,
      create: unbuilt,
      update: unbuilt,
      remove: unbuilt,
      createSection: unbuilt,
      renameSection: unbuilt,
      removeSection: unbuilt,
      recent: unbuilt,
    };
    const { app } = build({ notes });
    const res = await app.request(`/api/notes/file?path=${encodeURIComponent("Meeting notes/2026-10-30-review.md")}`);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "Not built yet" });
  });

  it("sit behind the Host, Origin and Sec-Fetch-Site guards", async () => {
    const { app } = build();
    const evilHost = { headers: { host: "evil.example.com" } };
    expect((await app.request("/api/projects", evilHost)).status).toBe(403);
    expect((await app.request("/api/notes/file?path=a.md", evilHost)).status).toBe(403);
    const evilOrigin = { origin: "https://evil.example.com" };
    expect((await app.request("/api/projects", json({ name: "x", area: "work" }, evilOrigin))).status).toBe(403);
    expect((await app.request("/api/notes", json({ section: "Meeting notes", title: "x" }, { origin: "http://localhost:3000" }))).status).toBe(403);
    expect((await app.request("/api/projects/p1", { method: "PATCH", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await app.request("/api/notes/file?path=a.md", { method: "DELETE", headers: evilOrigin })).status).toBe(403);
    expect((await app.request("/api/notes/sections?path=a", { method: "DELETE", headers: evilOrigin })).status).toBe(403);
    const read = await app.request("/api/projects", { headers: evilOrigin });
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("limit bodies to 16 KB on /api/projects and 512 KB on /api/notes", async () => {
    const { app } = build();
    expect((await app.request("/api/projects", sized("POST", 20_000))).status).toBe(413);
    expect((await app.request("/api/projects/p1/tasks", sized("POST", 20_000))).status).toBe(413);
    expect((await app.request("/api/notes", sized("POST", 600_000))).status).toBe(413);
    expect((await app.request("/api/notes/file?path=a.md", sized("PUT", 600_000))).status).toBe(413);
    expect((await app.request("/api/notes", sized("POST", 100_000))).status).not.toBe(413);
  });

  it("leave unknown paths under them to the JSON 404", async () => {
    const { app } = build();
    for (const p of ["/api/projects/a/b/c/d", "/api/notes/nothing/here"]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });
});

describe("web app serving", () => {
  it("serves web/dist when built, and a hint when not", async () => {
    const dist = path.join(tmp, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>x</title>");
    const built = build({ webDistDir: dist }).app;
    const page = await built.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>x</title>");

    const notBuilt = build().app;
    expect(await (await notBuilt.request("/")).text()).toContain("npm run build");
  });
});
