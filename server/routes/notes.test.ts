import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, Note, NotesIndex, Snapshot } from "../../shared/types";
import { createNotesStore, type NotesStore } from "../notes";
import { notesRoutes } from "./notes";

// The router mounted the way app.ts mounts it, with app.ts's HTTPException -> ApiError mapping.
// Every test works in its own temp folder. The real vault is never touched.

const NOW = new Date(2026, 9, 30, 9, 0, 0);

let tmp: string;
let dir: string;
let app: Hono;
let refreshLocal: ReturnType<typeof vi.fn<() => Promise<Snapshot>>>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "life-dashboard-notes-api-"));
  dir = path.join(tmp, "vault", "notes");
  await mkdir(path.dirname(dir));
  refreshLocal = vi.fn(async () => ({}) as Snapshot); // the router only awaits it
  app = mount(createNotesStore(dir, { now: () => NOW }));
});

function mount(notes: NotesStore): Hono {
  const mounted = new Hono();
  mounted.route("/api/notes", notesRoutes({ notes, snapshots: { refreshLocal }, now: () => NOW, log: () => undefined }));
  mounted.onError((err, c) => {
    if (err instanceof HTTPException && err.status !== 500) return c.json({ error: err.message } satisfies ApiError, err.status);
    return c.json({ error: "Something went wrong on the server" } satisfies ApiError, 500);
  });
  return mounted;
}
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const q = (p: string) => `?path=${encodeURIComponent(p)}`;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function ok<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function fails(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiError;
  expect(typeof body.error).toBe("string");
  return body.error;
}

describe("/api/notes routes", () => {
  it("GET / answers the index, creating the default sections on first run", async () => {
    const index = await ok<NotesIndex>(await app.request("/api/notes"));
    expect(index.status).toBe("ok");
    expect(index.sections.map((s) => s.path)).toEqual(["Meeting notes", "Personal notes"]);
    expect(refreshLocal).not.toHaveBeenCalled();
  });

  it("creates, reads, updates and trashes a note, refreshing the snapshot after each write", async () => {
    await app.request("/api/notes");
    const created = await ok<Note>(
      await send("POST", "/api/notes", { section: "Meeting notes", title: "Sprint review", template: "meeting", tags: ["meeting"], projectId: "qic-fastbind" }),
    );
    expect(created.path).toBe("Meeting notes/2026-10-30-sprint-review.md");
    expect(created.body.startsWith("## Attendees")).toBe(true);
    expect(refreshLocal).toHaveBeenCalledTimes(1);

    expect(await ok<Note>(await app.request(`/api/notes/file${q(created.path)}`))).toEqual(created);

    const updated = await ok<Note>(await send("PUT", `/api/notes/file${q(created.path)}`, { body: "- [ ] Send minutes", title: "Sprint review (Q4)" }));
    expect(updated).toMatchObject({ path: created.path, title: "Sprint review (Q4)", body: "- [ ] Send minutes", openActions: 1, tags: ["meeting"] });
    expect(refreshLocal).toHaveBeenCalledTimes(2);

    const index = await ok<NotesIndex>(await send("DELETE", `/api/notes/file${q(created.path)}`));
    expect(index.notes).toEqual([]);
    expect(refreshLocal).toHaveBeenCalledTimes(3);
    expect(await readdir(path.join(dir, ".trash", "Meeting notes"))).toEqual(["2026-10-30-sprint-review.md"]);
    await fails(await app.request(`/api/notes/file${q(created.path)}`), 404);
  });

  it("creates, renames and deletes sections; 409 when not empty or taken", async () => {
    await app.request("/api/notes");
    let index = await ok<NotesIndex>(await send("POST", "/api/notes/sections", { parent: "", name: "Work" }));
    expect(index.sections.map((s) => s.name)).toContain("Work");
    index = await ok<NotesIndex>(await send("POST", "/api/notes/sections", { name: "Side" })); // missing parent = top level
    expect(index.sections.map((s) => s.name)).toContain("Side");
    index = await ok<NotesIndex>(await send("POST", "/api/notes/sections", { parent: "Work", name: "FastBind" }));
    expect(index.sections.find((s) => s.name === "Work")!.children.map((s) => s.path)).toEqual(["Work/FastBind"]);
    index = await ok<NotesIndex>(await send("PATCH", "/api/notes/sections", { path: "Work/FastBind", name: "FastBind 2" }));
    expect(index.sections.find((s) => s.name === "Work")!.children.map((s) => s.path)).toEqual(["Work/FastBind 2"]);

    await fails(await send("POST", "/api/notes/sections", { parent: "", name: "Work" }), 409);
    await fails(await send("PATCH", "/api/notes/sections", { path: "Side", name: "Work" }), 409);
    expect(await fails(await send("DELETE", `/api/notes/sections${q("Work")}`), 409)).toMatch(/1 section/);
    await send("POST", "/api/notes", { section: "Side", title: "Kept" });
    expect(await fails(await send("DELETE", `/api/notes/sections${q("Side")}`), 409)).toMatch(/1 note/);

    const calls = refreshLocal.mock.calls.length;
    index = await ok<NotesIndex>(await send("DELETE", `/api/notes/sections${q("Work/FastBind 2")}`));
    expect(index.sections.find((s) => s.name === "Work")!.children).toEqual([]);
    expect(refreshLocal).toHaveBeenCalledTimes(calls + 1);
  });

  it("validates bodies with app.ts's words, and 413 for a note body over 200 KB", async () => {
    await app.request("/api/notes");
    const noType = await app.request("/api/notes", { method: "POST", body: "{}" });
    expect(await fails(noType, 400)).toBe("Send the body as JSON with Content-Type: application/json");
    const badJson = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(await fails(badJson, 400)).toBe("Body is not valid JSON");
    await fails(await send("POST", "/api/notes", []), 400);
    await fails(await send("POST", "/api/notes", { section: "Meeting notes" }), 400);
    await fails(await send("POST", "/api/notes", { section: "Meeting notes", title: "x", tags: "a" }), 400);
    await fails(await send("POST", "/api/notes", { section: "Meeting notes", title: "x", body: "x".repeat(200 * 1024 + 1) }), 413);
    await fails(await send("PUT", `/api/notes/file${q("Meeting notes/x.md")}`, {}), 400);
    await fails(await send("POST", "/api/notes/sections", { parent: "", name: 5 }), 400);
    await fails(await app.request("/api/notes/file"), 400);
    await fails(await send("DELETE", "/api/notes/sections"), 400);
    expect(refreshLocal).not.toHaveBeenCalled();
  });

  it("rejects every traversal attempt with 400 and writes nothing outside", async () => {
    await app.request("/api/notes");
    await writeFile(path.join(tmp, "vault", "outside.md"), "secret");
    const outside = path.join(tmp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, path.join(dir, "Escape"), "junction");

    const notePaths = [
      "../outside.md",
      "Meeting notes/../../outside.md",
      "/etc/passwd.md",
      "C:/Windows/win.md",
      "C:\\Windows\\win.md",
      "\\\\server\\share\\x.md",
      "Meeting notes\\..\\..\\outside.md",
      "%2e%2e/outside.md", // arrives as %2e%2e after Hono's one decode
      "..%2foutside.md",
      "./x.md",
      ".trash/x.md",
      ".obsidian/app.md",
      "Escape/secret.md",
      "Escape/new.md",
    ];
    for (const p of notePaths) {
      await fails(await app.request(`/api/notes/file${q(p)}`), 400);
      await fails(await send("PUT", `/api/notes/file${q(p)}`, { body: "pwned" }), 400);
      await fails(await send("DELETE", `/api/notes/file${q(p)}`), 400);
    }
    const sectionPaths = ["..", "../vault", "Meeting notes/..", "/tmp", "C:\\", "%2e%2e", "Escape", ".trash"];
    for (const p of sectionPaths) {
      await fails(await send("POST", "/api/notes", { section: p, title: "x" }), 400);
      await fails(await send("POST", "/api/notes/sections", { parent: p, name: "x" }), 400);
      await fails(await send("PATCH", "/api/notes/sections", { path: p, name: "x" }), 400);
      await fails(await send("DELETE", `/api/notes/sections${q(p)}`), 400);
    }
    for (const name of ["..", "../x", "a/b", "a\\b", ".hidden", "C:x"]) {
      await fails(await send("POST", "/api/notes/sections", { parent: "", name }), 400);
      await fails(await send("PATCH", "/api/notes/sections", { path: "Meeting notes", name }), 400);
    }
    // Encoded only once on the wire: Hono decodes %2e%2e%2f to ../, which is refused as text.
    await fails(await app.request("/api/notes/file?path=%2e%2e%2foutside.md"), 400);

    expect(refreshLocal).not.toHaveBeenCalled();
    expect(await readFile(path.join(tmp, "vault", "outside.md"), "utf8")).toBe("secret");
    expect(await readdir(outside)).toEqual(["secret.md"]);
    expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe("secret");
    expect((await readdir(path.join(tmp, "vault"))).sort()).toEqual(["notes", "outside.md"]);
  });
});


describe("/api/notes with vaults (v1.4)", () => {
  it("routes @learning/ paths, answers 403 with the vault rule for writes in a read-only folder, and still reads them", async () => {
    const learning = path.join(tmp, "Learning");
    await mkdir(path.join(learning, "raw"), { recursive: true });
    await writeFile(path.join(learning, "raw", "src.md"), "# Src\n");
    app = mount(
      createNotesStore(dir, {
        now: () => NOW,
        log: () => undefined,
        vaults: [{ id: "learning", label: "Learning", prefix: "@learning/", dir: learning, readOnlyFolders: ["raw"] }],
      }),
    );
    const index = await ok<NotesIndex>(await app.request("/api/notes"));
    expect(index.vaults.map((v) => [v.id, v.noteCount])).toEqual([
      ["notes", 0],
      ["learning", 1],
    ]);
    expect(index.sections.map((s) => s.path)).toEqual(["Meeting notes", "Personal notes", "@learning"]);
    expect(index.sections[2]!.children).toEqual([{ path: "@learning/raw", name: "raw", children: [], noteCount: 1, readOnly: true }]);

    const src = "@learning/raw/src.md";
    expect(await ok<Note>(await app.request(`/api/notes/file${q(src)}`))).toMatchObject({ path: src, vault: "learning", readOnly: true, body: "# Src\n" });
    const rule = "This folder is protected by the vault's rules";
    expect(await fails(await send("PUT", `/api/notes/file${q(src)}`, { body: "changed" }), 403)).toBe(rule);
    expect(await fails(await send("DELETE", `/api/notes/file${q(src)}`), 403)).toBe(rule);
    expect(await fails(await send("POST", "/api/notes", { section: "@learning/raw", title: "x" }), 403)).toBe(rule);
    expect(await fails(await send("POST", "/api/notes/sections", { parent: "@learning/raw", name: "x" }), 403)).toBe(rule);
    expect(await fails(await send("PATCH", "/api/notes/sections", { path: "@learning/raw", name: "y" }), 403)).toBe(rule);
    expect(await fails(await send("DELETE", `/api/notes/sections${q("@learning/raw")}`), 403)).toBe(rule);
    await fails(await app.request(`/api/notes/file${q("@nope/x.md")}`), 400);
    await fails(await app.request(`/api/notes/file${q("@learning/../vault/notes/x.md")}`), 400);
    expect(refreshLocal).not.toHaveBeenCalled();
    expect(await readFile(path.join(learning, "raw", "src.md"), "utf8")).toBe("# Src\n");
    expect(await readdir(learning)).toEqual(["raw"]);

    const top = await ok<Note>(await send("POST", "/api/notes", { section: "@learning", title: "Top note" }));
    expect(top).toMatchObject({ path: "@learning/2026-10-30-top-note.md", section: "@learning", vault: "learning", readOnly: false });
    expect(refreshLocal).toHaveBeenCalledTimes(1);
  });
});
