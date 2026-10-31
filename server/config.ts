import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** The server listens here and nowhere else. */
export const HOST = "127.0.0.1";
export const PORT = 4317;
/** Vite dev server port (web/vite.config.ts). Allowed as a request origin. */
export const WEB_DEV_PORT = 5173;

/** Repo root (the folder holding package.json). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Jira settings. `email` and `apiToken` are secrets: read them, send them to JIRA_SITE only,
 * never log them, never put them in the snapshot or in an error message.
 * They are non-enumerable on the loaded config, so console.log / JSON.stringify / object spread
 * of this object leave them out. Read them by name: `const { email, apiToken } = config.jira`.
 */
export interface JiraConfig {
  /** Host as written in .env, for example "qicbizdev.atlassian.net" (may still carry https:// or a slash). */
  site: string;
  email: string | null;
  apiToken: string | null;
  /** JIRA_ACCOUNT_ID: assignee of issues created from notes (ticket T28). Plain config, not a secret. */
  accountId: string;
  /** JIRA_PROJECT_KEY: the only project issues are created in (ticket T28). Plain config, not a secret. */
  projectKey: string;
  /**
   * The AN project's required "Product" field, an Assets object reference. Every created issue gets
   * it. Default: "Internal service / process" (object 948), the value on most AN tasks and epics.
   * JIRA_PRODUCT_FIELD, JIRA_PRODUCT_WORKSPACE, JIRA_PRODUCT_OBJECT override it.
   */
  product: { field: string; workspaceId: string; objectId: string };
}

/** The Claude connector run (ticket T26). No secrets here: the connectors use the claude.ai login. */
export interface ConnectorsConfig {
  /** CONNECTORS_EVERY_MIN: minutes between runs. Default 60; the scheduler never goes below 15. */
  everyMin: number;
  /** Empty folder used as the run's cwd: data/connector-run. */
  runDir: string;
}

export const DEFAULT_CONNECTORS_EVERY_MIN = 60;

export interface Config {
  host: string;
  port: number;
  webDevPort: number;
  rootDir: string;
  /** Runtime JSON files (gitignored). See FILES in store.ts. */
  dataDir: string;
  /** Built web app served by `npm start`. */
  webDistDir: string;
  home: string;
  /** Folder with Daily.md and Agenda/YYYY-MM.md. */
  learningDir: string;
  /** Knowledge vault; cwd for `claude -p` so it can read qic-engineering/. */
  vaultDir: string;
  /**
   * Markdown notes written by the dashboard; sections are folders. NOTES_DIR in .env,
   * default VAULT_DIR/notes so Obsidian sees them. Read and written only through server/notes.ts.
   */
  notesDir: string;
  /** Claude Code session logs, one folder per project. */
  claudeProjectsDir: string;
  jira: JiraConfig;
  connectors: ConnectorsConfig;
}

export type EnvSource = Record<string, string | undefined>;

export const DEFAULT_JIRA_SITE = "qicbizdev.atlassian.net";
export const DEFAULT_JIRA_ACCOUNT_ID = "712020:e1e9b601-f708-4c43-84a3-789ac7ef493b";
export const DEFAULT_JIRA_PROJECT_KEY = "AN";
/** AN's Product field: "Internal service / process" in the qicbizdev Assets workspace (checked 2026-10-31). */
export const DEFAULT_JIRA_PRODUCT = {
  field: "customfield_11461",
  workspaceId: "141cbb86-962b-4bb8-8f49-676bb76f7433",
  objectId: "948",
} as const;

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** An env value when it matches `shape`, else `fallback`. */
function pick(value: string | undefined, shape: RegExp, fallback: string): string {
  const text = clean(value);
  return text !== null && shape.test(text) ? text : fallback;
}

/** A whole number of minutes from env, or `fallback` when missing or not a positive number. */
function minutes(value: string | undefined, fallback: number): number {
  const text = clean(value);
  if (text === null || !/^\d+(\.\d+)?$/.test(text)) return fallback;
  const n = Math.round(Number(text));
  return n > 0 ? n : fallback;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Builds the config from an env object. Pure apart from path resolution, so tests can pass
 * their own env and folders: `loadConfig({ JIRA_API_TOKEN: "t" }, { rootDir: tmp, home: tmp })`.
 */
export function loadConfig(env: EnvSource, opts: { rootDir?: string; home?: string } = {}): Config {
  const rootDir = opts.rootDir ?? ROOT_DIR;
  const home = opts.home ?? os.homedir();
  const dir = (key: string, fallback: string): string => {
    const value = clean(env[key]);
    return path.resolve(value ? expandHome(value, home) : fallback);
  };

  const accountId = clean(env.JIRA_ACCOUNT_ID);
  const projectKey = clean(env.JIRA_PROJECT_KEY);
  const jira = {
    site: clean(env.JIRA_SITE) ?? DEFAULT_JIRA_SITE,
    accountId: accountId && /^[A-Za-z0-9:_-]{1,128}$/.test(accountId) ? accountId : DEFAULT_JIRA_ACCOUNT_ID,
    projectKey: projectKey && /^[A-Z][A-Z0-9]{1,9}$/.test(projectKey) ? projectKey : DEFAULT_JIRA_PROJECT_KEY,
    product: {
      field: pick(env.JIRA_PRODUCT_FIELD, /^customfield_\d{1,8}$/, DEFAULT_JIRA_PRODUCT.field),
      workspaceId: pick(env.JIRA_PRODUCT_WORKSPACE, /^[0-9a-f-]{36}$/, DEFAULT_JIRA_PRODUCT.workspaceId),
      objectId: pick(env.JIRA_PRODUCT_OBJECT, /^\d{1,10}$/, DEFAULT_JIRA_PRODUCT.objectId),
    },
  } as JiraConfig;
  Object.defineProperty(jira, "email", { value: clean(env.JIRA_EMAIL), enumerable: false });
  Object.defineProperty(jira, "apiToken", { value: clean(env.JIRA_API_TOKEN), enumerable: false });

  const vaultDir = dir("VAULT_DIR", path.join(home, "Desktop", "MD Files", "Working-With-Claude"));
  const dataDir = path.join(rootDir, "data");

  return {
    host: HOST,
    port: PORT,
    webDevPort: WEB_DEV_PORT,
    rootDir,
    dataDir,
    webDistDir: path.join(rootDir, "web", "dist"),
    home,
    learningDir: dir("LEARNING_DIR", path.join(home, "Desktop", "MD Files", "Learning")),
    vaultDir,
    notesDir: dir("NOTES_DIR", path.join(vaultDir, "notes")),
    claudeProjectsDir: dir("CLAUDE_PROJECTS_DIR", path.join(home, ".claude", "projects")),
    jira,
    connectors: {
      everyMin: minutes(env.CONNECTORS_EVERY_MIN, DEFAULT_CONNECTORS_EVERY_MIN),
      runDir: path.join(dataDir, "connector-run"),
    },
  };
}

/**
 * Reads a .env file into a plain object. Missing or unreadable file gives {}.
 * It does not touch process.env, so secrets are not inherited by child processes (gh, claude).
 */
export function readDotenv(file: string): EnvSource {
  if (!existsSync(file)) return {};
  try {
    return dotenv.parse(readFileSync(file));
  } catch {
    return {};
  }
}

/** Real environment variables win over values from .env. */
function mergedEnv(): EnvSource {
  const fromFile = readDotenv(path.join(ROOT_DIR, ".env"));
  const fromProcess: EnvSource = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (clean(value) !== null) fromProcess[key] = value;
  }
  return { ...fromFile, ...fromProcess };
}

/** The app config, loaded once from `.env` in the repo root plus the process environment. */
export const config: Config = loadConfig(mergedEnv());
