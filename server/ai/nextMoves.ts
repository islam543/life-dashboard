import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { NextMove, NextMovesFile, Snapshot } from "../../shared/types";
import { config, presentVaults, type VaultConfig } from "../config";
import { normaliseSnapshot } from "../snapshot";
import { createStore, FILES, type Store } from "../store";
import { createNotesStore } from "../notes";
import { buildPrompt, knownUrls, type NoteActions } from "./prompt";
import {
  extractFirstJsonArray,
  isMoveHistory,
  isNextMovesFile,
  looksLikeAuthFailure,
  oneLine,
  parseEnvelope,
  titleKey,
  validateProposedMoves,
  type MoveHistory,
  type ProposedMove,
} from "./validate";

// docs/ARCHITECTURE.md "AI next moves". Runs `claude -p` (no shell, argument array) in the
// knowledge vault with a trimmed snapshot, validates the JSON answer and keeps
// data/next-moves.json. Expected failures (claude missing, not logged in, bad JSON, timeout)
// never reject: they set `status` and `message` and keep the previous moves.
//
// - getNextMoves(): current file; status "running" while a run is in progress.
// - runNextMoves(): marks itself running synchronously; a call while running returns the
//   in-flight promise. Resolves with the final file.
// - setMoveState(id, state): persists "done" or "dismissed" by id, or null for an unknown id.

export type MoveState = Exclude<NextMove["state"], "open">;

export const RUN_TIMEOUT_MS = 5 * 60_000;
export const MAX_MOVES = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DISMISS_WINDOW_MS = 7 * DAY_MS;
/** Done and dismissed titles from the last 7 days, so new runs can skip them. */
export const HISTORY_FILE = "next-moves-history.json";
const HISTORY_MAX = 200;
export const NOT_LOGGED_IN_MESSAGE = "Run claude in a terminal and log in";

/** Tools the run may not use. It only needs Read/Glob/Grep inside the vault. */
export const BLOCKED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill"] as const;
/** The only tools the run has at all (the block list stays as a second guard). */
export const ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

export function emptyNextMovesFile(): NextMovesFile {
  return { generatedAt: null, status: "never_run", moves: [] };
}

function emptyHistory(): MoveHistory {
  return { dismissed: [], done: [] };
}

// ---------------------------------------------------------------------------------------
// Process runner (injectable so tests never start the real CLI)

export interface RunRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface RunResult {
  /** null when the process never started or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started, for example "ENOENT". */
  errorCode?: string;
}

/** Must never reject. */
export type ProcessRunner = (req: RunRequest) => Promise<RunResult>;

const MAX_OUTPUT_CHARS = 1_000_000;
const KILL_GRACE_MS = 5_000;
const CLOSE_AFTER_EXIT_MS = 2_000;

function codeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

/** Runs a command with spawn (shell: false). Kills it after `timeoutMs`. Never rejects. */
export const spawnRunner: ProcessRunner = (req) =>
  new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (extra: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve({ exitCode: null, stdout, stderr, timedOut, ...extra });
    };

    let child: ChildProcess;
    try {
      child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ errorCode: codeOf(err) ?? "SPAWN_FAILED" });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.on("error", (err) => {
      // Before a pid exists this is a start failure; later errors (a failed kill) wait for close.
      if (child.pid === undefined) finish({ errorCode: codeOf(err) ?? "SPAWN_FAILED" });
    });
    child.on("close", (code) => finish({ exitCode: code }));
    // A grandchild holding the pipes open must not keep us waiting after claude itself exits.
    child.on("exit", (code) => {
      timers.push(setTimeout(() => finish({ exitCode: code }), CLOSE_AFTER_EXIT_MS));
    });

    timers.push(
      setTimeout(() => {
        timedOut = true;
        child.kill();
        timers.push(
          setTimeout(() => {
            child.kill("SIGKILL");
            finish({});
          }, KILL_GRACE_MS),
        );
      }, req.timeoutMs),
    );
  });

/**
 * The CLI to start. Prefers the native installer's location (~/.local/bin) so a server
 * started without it on PATH still finds it, then falls back to "claude" on PATH.
 */
export function resolveClaudeCommand(
  home: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string {
  const local = path.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
  return exists(local) ? local : "claude";
}

const ENV_ALLOW = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "USERNAME", "USERDOMAIN",
  "COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "USER", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
// The CLI's own settings, such as CLAUDE_CONFIG_DIR or CLAUDE_CODE_GIT_BASH_PATH. CLAUDECODE (set
// inside a Claude Code session) does not match, so a dashboard started from Claude Code still runs it.
const ENV_ALLOW_PREFIXES = ["CLAUDE_", "ANTHROPIC_"];
const ENV_DENY = new Set(["CLAUDE_CODE_ENTRYPOINT"]);

/**
 * Minimal environment for the child: system paths, proxy settings and the CLI's own settings.
 * Everything else (JIRA_*, other tokens) is left out.
 */
export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (ENV_DENY.has(upper) || upper.includes("JIRA")) continue;
    if (ENV_ALLOW.has(upper) || ENV_ALLOW_PREFIXES.some((p) => upper.startsWith(p))) env[key] = value;
  }
  return env;
}

/** `--add-dir <folder>...` so a run may read those folders too, or nothing when there are none. */
export function addDirArgs(dirs: readonly string[]): string[] {
  return dirs.length > 0 ? ["--add-dir", ...dirs] : [];
}

/**
 * `claude -p <prompt> --output-format json --model sonnet`, plus read-only hardening. `vaultDirs`
 * (v1.4): the extra note vaults, readable as reference next to the knowledge vault (the cwd).
 */
export function claudeArgs(prompt: string, vaultDirs: readonly string[] = []): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    "sonnet",
    // Work item titles come from other people: keep the run read-only and free of MCP servers.
    "--tools",
    ...ALLOWED_TOOLS,
    ...addDirArgs(vaultDirs),
    "--disallowedTools",
    ...BLOCKED_TOOLS,
    "--strict-mcp-config",
    // Only project settings, so the user's own hooks do not run inside this child.
    "--setting-sources",
    "project",
  ];
}

// ---------------------------------------------------------------------------------------
// Interpreting a run

export type RunOutcome =
  | { ok: true; moves: ProposedMove[] }
  | { ok: false; status: "error" | "not_logged_in"; message: string };

const failure = (message: string): RunOutcome => ({ ok: false, status: "error", message });
const notLoggedIn: RunOutcome = { ok: false, status: "not_logged_in", message: NOT_LOGGED_IN_MESSAGE };

function durationLabel(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

/** Pure: turns the CLI result into moves or a status. */
export function interpretRun(result: RunResult, timeoutMs: number = RUN_TIMEOUT_MS): RunOutcome {
  if (result.errorCode === "ENOENT") return failure("Claude Code CLI not found. Install it and check that claude is on PATH.");
  if (result.errorCode) return failure(`Could not start claude (${result.errorCode}).`);
  if (result.timedOut) return failure(`Claude did not answer within ${durationLabel(timeoutMs)}. Kept the previous moves.`);

  const envelope = parseEnvelope(result.stdout);
  if (result.exitCode !== 0 || envelope === null || envelope.isError) {
    // Only a failed run is checked for auth text, so a move about "OAuth" cannot trip it.
    if (looksLikeAuthFailure(`${result.stdout}\n${result.stderr}`)) return notLoggedIn;
    if (envelope?.isError) return failure(`Claude reported an error: ${oneLine(envelope.result, 200) || "no details"}`);
    if (result.exitCode !== 0) {
      const detail = oneLine(result.stderr || result.stdout, 200);
      return failure(`claude exited with code ${result.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    return failure("Claude returned output that was not JSON. Kept the previous moves.");
  }

  const array = extractFirstJsonArray(envelope.result);
  if (array === null) {
    if (looksLikeAuthFailure(envelope.result)) return notLoggedIn;
    return failure("Claude's answer had no JSON list of moves. Kept the previous moves.");
  }
  const check = validateProposedMoves(array);
  if (!check.ok) return failure(`Claude's answer did not match the expected format (${check.error}). Kept the previous moves.`);
  return { ok: true, moves: check.moves };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * Pure: drops moves dismissed in the window, keeps the top MAX_MOVES by rank, renumbers
 * ranks from 1, gives ids that are URL-safe and unique across runs, and keeps sourceUrl
 * only when it points at an item that was in the prompt.
 */
export function finalizeMoves(
  proposed: readonly ProposedMove[],
  opts: { dismissedTitles: ReadonlySet<string>; allowedUrls: ReadonlySet<string>; runTag: string },
): NextMove[] {
  const used = new Set<string>();
  return proposed
    .filter((m) => !opts.dismissedTitles.has(titleKey(m.title)))
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.rank - b.m.rank || a.i - b.i)
    .slice(0, MAX_MOVES)
    .map(({ m }, i) => {
      const base = `${slug(m.id) || `move-${i + 1}`}-${opts.runTag}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      const move: NextMove = { id, title: m.title, reason: m.reason, area: m.area, rank: i + 1, state: "open" };
      if (m.sourceUrl && opts.allowedUrls.has(m.sourceUrl)) move.sourceUrl = m.sourceUrl;
      return move;
    });
}

function pruneHistory(history: MoveHistory, now: Date): MoveHistory {
  const cutoff = now.getTime() - DISMISS_WINDOW_MS;
  const keep = (list: MoveHistory["done"]) =>
    list.filter((e) => Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) >= cutoff).slice(0, HISTORY_MAX);
  return { dismissed: keep(history.dismissed), done: keep(history.done) };
}

// ---------------------------------------------------------------------------------------
// Service

export interface NextMovesDeps {
  store: Store;
  /** cwd for the CLI (the knowledge vault). */
  vaultDir: string;
  /**
   * v1.4: the other note vaults (not the default one, which sits inside vaultDir). Those whose folder
   * exists at run time are named in the prompt as read-only reference and passed with --add-dir.
   */
  vaults?: readonly VaultConfig[];
  /** Latest snapshot. Default reads data/snapshot.json, which the snapshot service saves after every refresh. */
  loadSnapshot?: (now: Date) => Promise<Snapshot>;
  /** Open "- [ ]" lines for the given note paths. Default: none, so the prompt only has each note's count. */
  loadNoteActions?: (paths: string[]) => Promise<NoteActions>;
  runner?: ProcessRunner;
  command?: string;
  env?: Record<string, string>;
  now?: () => Date;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface NextMovesService {
  get(): Promise<NextMovesFile>;
  run(): Promise<NextMovesFile>;
  setState(id: string, state: MoveState): Promise<NextMovesFile | null>;
}

export async function readSnapshotFile(store: Store, now: Date): Promise<Snapshot> {
  return normaliseSnapshot(await store.read<unknown>(FILES.snapshot, null), now);
}

export function createNextMoves(deps: NextMovesDeps): NextMovesService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const runner = deps.runner ?? spawnRunner;
  const timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS;
  const loadSnapshot = deps.loadSnapshot ?? ((at: Date) => readSnapshotFile(deps.store, at));

  let current: NextMovesFile = emptyNextMovesFile();
  let history: MoveHistory = emptyHistory();
  let loading: Promise<void> | null = null;
  let inFlight: Promise<NextMovesFile> | null = null;

  function load(): Promise<void> {
    loading ??= (async () => {
      const file = await deps.store.read(FILES.nextMoves, emptyNextMovesFile(), isNextMovesFile);
      // "running" is never written, but an old or hand-edited file must not look stuck.
      current = file.status === "running" ? { ...file, status: "error", message: "The last run did not finish. Run it again." } : file;
      history = pruneHistory(await deps.store.read(HISTORY_FILE, emptyHistory(), isMoveHistory), now());
    })();
    return loading;
  }

  function view(): NextMovesFile {
    const copy = structuredClone(current);
    if (!inFlight) return copy;
    return { generatedAt: copy.generatedAt, status: "running", moves: copy.moves };
  }

  async function save(name: string, value: unknown): Promise<void> {
    try {
      await deps.store.write(name, value);
    } catch (err) {
      log(`[next-moves] could not save ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function execute(): Promise<NextMovesFile> {
    await load();
    const startedAt = now();
    let outcome: RunOutcome;
    let allowedUrls = new Set<string>();

    if (!existsSync(deps.vaultDir)) {
      outcome = failure("Knowledge vault folder not found. Set VAULT_DIR in .env.");
    } else {
      const snapshot = await loadSnapshot(startedAt);
      const recent = pruneHistory(history, startedAt);
      const actionPaths = snapshot.notes.recent.filter((n) => n.openActions > 0).map((n) => n.path).slice(0, 10);
      const noteActions = deps.loadNoteActions && actionPaths.length ? await deps.loadNoteActions(actionPaths).catch(() => ({})) : {};
      const vaults = presentVaults(deps.vaults ?? []).filter((v) => path.resolve(v.dir) !== path.resolve(deps.vaultDir));
      const built = buildPrompt({
        snapshot,
        noteActions,
        now: startedAt,
        recentlyDismissed: recent.dismissed.map((e) => e.title),
        recentlyDone: recent.done.map((e) => e.title),
        vaults: vaults.map((v) => ({ label: v.label, dir: v.dir })),
      });
      allowedUrls = knownUrls(built.trimmed);
      const result = await runner({
        command: deps.command ?? "claude",
        args: claudeArgs(built.prompt, vaults.map((v) => v.dir)),
        cwd: deps.vaultDir,
        env: deps.env ?? childEnv(),
        timeoutMs,
      });
      outcome = interpretRun(result, timeoutMs);
    }

    const finishedAt = now();
    if (outcome.ok) {
      // Use the history as it is now, so a dismissal made during the run still counts.
      history = pruneHistory(history, finishedAt);
      const moves = finalizeMoves(outcome.moves, {
        dismissedTitles: new Set(history.dismissed.map((e) => titleKey(e.title))),
        allowedUrls,
        runTag: finishedAt.getTime().toString(36),
      });
      current = { generatedAt: finishedAt.toISOString(), status: "ok", moves };
    } else {
      // Keep the latest moves, including states set while the run was going.
      current = { generatedAt: current.generatedAt, status: outcome.status, message: outcome.message, moves: current.moves };
      log(`[next-moves] ${outcome.status}: ${outcome.message}`);
    }
    await save(FILES.nextMoves, current);
    return structuredClone(current);
  }

  return {
    async get() {
      await load();
      return view();
    },

    run() {
      if (inFlight) return inFlight;
      const p: Promise<NextMovesFile> = execute()
        .catch(async (err: unknown) => {
          log(`[next-moves] run failed: ${err instanceof Error ? err.message : String(err)}`);
          current = {
            generatedAt: current.generatedAt,
            status: "error",
            message: "Next moves run failed. Check the server log.",
            moves: current.moves,
          };
          await save(FILES.nextMoves, current);
          return structuredClone(current);
        })
        .finally(() => {
          if (inFlight === p) inFlight = null;
        });
      inFlight = p;
      return p;
    },

    async setState(id, state) {
      await load();
      const target = current.moves.find((m) => m.id === id);
      if (!target) return null;
      current = { ...current, moves: current.moves.map((m) => (m.id === id ? { ...m, state } : m)) };
      const at = now();
      const key = titleKey(target.title);
      const without = (list: MoveHistory["done"]) => list.filter((e) => titleKey(e.title) !== key);
      const entry = { title: target.title, at: at.toISOString() };
      history = pruneHistory(
        state === "dismissed"
          ? { dismissed: [entry, ...without(history.dismissed)], done: without(history.done) }
          : { dismissed: without(history.dismissed), done: [entry, ...without(history.done)] },
        at,
      );
      await Promise.all([save(FILES.nextMoves, current), save(HISTORY_FILE, history)]);
      return view();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Default instance used by server/index.ts (export signatures fixed by T01)

/** Reads each note and keeps its unchecked, non-empty "- [ ]" lines. Unreadable notes are skipped. */
export async function openActionLines(
  notes: { read(path: string): Promise<{ body: string }> },
  paths: string[],
): Promise<NoteActions> {
  const out: Record<string, string[]> = {};
  for (const p of paths) {
    try {
      const { body } = await notes.read(p);
      const lines = body
        .split(/\r?\n/)
        .map((l) => /^\s*[-*] \[ \]\s+(.+)$/.exec(l)?.[1]?.trim())
        .filter((l): l is string => Boolean(l));
      if (lines.length) out[p] = lines;
    } catch {
      // A note deleted or moved since the snapshot: leave it out.
    }
  }
  return out;
}

let defaultService: NextMovesService | null = null;

function service(): NextMovesService {
  defaultService ??= createNextMoves({
    store: createStore(config.dataDir),
    vaultDir: config.vaultDir,
    vaults: config.vaults.filter((v) => v.prefix !== ""),
    command: resolveClaudeCommand(config.home),
    loadNoteActions: (paths) => openActionLines(createNotesStore(config.notesDir, { vaults: config.vaults }), paths),
  });
  return defaultService;
}

export async function getNextMoves(): Promise<NextMovesFile> {
  return service().get();
}

export function runNextMoves(): Promise<NextMovesFile> {
  return service().run();
}

export async function setMoveState(id: string, state: MoveState): Promise<NextMovesFile | null> {
  return service().setState(id, state);
}
