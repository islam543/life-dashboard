import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { JiraCreateResult, JiraDraft, JiraEpicRef } from "../../shared/types";
import { childEnv, resolveClaudeCommand, spawnRunner, type RunResult } from "../ai/nextMoves";
import { oneLine } from "../ai/validate";
import { jiraSites } from "../collectors/jira";
import { config } from "../config";
import { actionContext, detectActions, openActions } from "../jira/actions";
import { CREATE_TIMEOUT_MS, createIssues, type CreateSettings } from "../jira/create";
import {
  DRAFT_TIMEOUT_MS,
  SEARCH_TOOL,
  buildDraftPrompt,
  cleanEpics,
  interpretDraftRun,
  jiraRunArgs,
  promptActions,
  validateDraftIssues,
  type RunFailure,
} from "../jira/draft";
import { writeBack, writeBackEdits, writeBackFailure } from "../jira/writeBack";
import type { NotesStore } from "../notes";
import { loadProjectsFile } from "../projects";
import type { SnapshotService } from "../snapshot";
import type { Store } from "../store";

// /api/jira: actions detected in a note, AI drafts of Jira issues for them, and creating the
// reviewed drafts in Jira through the Claude connector. Contract: shared/types.ts "v1.2", API table
// in docs/ARCHITECTURE.md "v1.2". Ticket T28.
//
// Mounted by app.ts after its guards (Host, Origin, Sec-Fetch-Site, no-store, 16 KB body limit).
// Errors: HTTPException 400 (bad input, nothing to file), 409 (a run of the same kind is going),
// 502 (Claude's answer failed or did not pass the checks), 503 (CLI or connector not signed in).
// One log line per run with counts and duration; never note text, summaries or model output.

/** Settings for the Jira runs. Production uses the real CLI, data/jira-run and config.jira. */
export interface JiraRunSettings extends Omit<CreateSettings, "timeoutMs"> {
  draftTimeoutMs: number;
  createTimeoutMs: number;
}

export interface JiraRoutesDeps {
  notes: NotesStore;
  store: Store;
  snapshots: Pick<SnapshotService, "get" | "refresh" | "refreshLocal">;
  now: () => Date;
  log: (line: string) => void;
  /** Overrides for the runs; tests pass a fake runner here so the real claude never starts. */
  run?: Partial<JiraRunSettings>;
}

/** Drafts remembered per note (their epic lists), so create can check existing parents. */
const MAX_REMEMBERED_DRAFTS = 20;

const badRequest = (message: string) => new HTTPException(400, { message });

async function readObject(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw badRequest("Send the body as JSON with Content-Type: application/json");
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw badRequest("Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest("Body must be a JSON object");
  return value as Record<string, unknown>;
}

function notePathOf(value: unknown): string {
  if (typeof value !== "string" || value === "") throw badRequest("path must be the note path");
  return value;
}

function defaultSettings(): JiraRunSettings {
  return {
    runner: spawnRunner,
    command: resolveClaudeCommand(config.home),
    env: childEnv(),
    runDir: path.join(config.dataDir, "jira-run"),
    site: jiraSites(config.jira.site)[0]!,
    accountId: config.jira.accountId,
    projectKey: config.jira.projectKey,
    draftTimeoutMs: DRAFT_TIMEOUT_MS,
    createTimeoutMs: CREATE_TIMEOUT_MS,
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const isSignIn = (f: RunFailure) => f.kind === "not_logged_in" || f.kind === "unavailable" || f.kind === "cli_missing";

export function jiraRoutes(deps: JiraRoutesDeps): Hono {
  const router = new Hono();
  const drafts = new Map<string, JiraEpicRef[]>();
  let drafting = false;
  let creating = false;

  const settings = (): JiraRunSettings => ({ ...defaultSettings(), ...deps.run });

  function rememberEpics(notePath: string, epics: JiraEpicRef[]): void {
    drafts.delete(notePath);
    drafts.set(notePath, epics);
    while (drafts.size > MAX_REMEMBERED_DRAFTS) drafts.delete(drafts.keys().next().value!);
  }

  async function projectNameOf(id: string | null): Promise<string | null> {
    if (!id) return null;
    try {
      const name = (await loadProjectsFile(deps.store))?.projects.find((p) => p.id === id)?.name;
      return name ? oneLine(name, 80) : null;
    } catch {
      return null;
    }
  }

  // DetectedAction[]
  router.get("/actions", async (c) => {
    const note = await deps.notes.read(notePathOf(c.req.query("path")));
    return c.json(detectActions(note.body, config.jira.projectKey));
  });

  // { path } -> JiraDraft. Waits for the AI run; nothing is created.
  router.post("/draft", async (c) => {
    if (drafting) throw new HTTPException(409, { message: "A Jira draft is already running" });
    drafting = true;
    try {
      const body = await readObject(c);
      const note = await deps.notes.read(notePathOf(body.path));
      const open = openActions(detectActions(note.body, config.jira.projectKey));
      if (open.length === 0) throw badRequest("No open actions to file");
      const s = settings();
      const actions = promptActions(open, (a) => actionContext(note.body, a.line));
      const prompt = buildDraftPrompt({
        noteTitle: oneLine(note.title, 120),
        projectName: await projectNameOf(note.projectId),
        actions,
        site: s.site,
        projectKey: s.projectKey,
      });

      const startedAt = deps.now().getTime();
      let result: RunResult;
      try {
        await mkdir(s.runDir, { recursive: true });
        result = await s.runner({ command: s.command, args: jiraRunArgs(prompt, SEARCH_TOOL), cwd: s.runDir, env: s.env, timeoutMs: s.draftTimeoutMs });
      } catch {
        result = { exitCode: null, stdout: "", stderr: "", timedOut: false, errorCode: "RUN_FAILED" };
      }
      const took = seconds(deps.now().getTime() - startedAt);
      const outcome = interpretDraftRun(result, s.draftTimeoutMs);
      if (!outcome.ok) {
        deps.log(`[jira] draft failed (${outcome.reason}) in ${took}: ${actions.length} open actions`);
        throw new HTTPException(isSignIn(outcome) ? 503 : 502, { message: outcome.message });
      }
      const epics = cleanEpics(outcome.answer.epics, s.projectKey);
      const check = validateDraftIssues(outcome.answer.issues, {
        epicKeys: new Set(epics.map((e) => e.key)),
        actionIds: new Set(actions.map((a) => a.id)),
        projectKey: s.projectKey,
        orphanEpics: "drop",
      });
      if (!check.ok) {
        deps.log(`[jira] draft failed (invalid_draft) in ${took}: ${actions.length} open actions`);
        throw new HTTPException(502, { message: `Claude's draft did not pass the checks (${check.error}). Try again.` });
      }
      rememberEpics(note.path, epics);
      const draft: JiraDraft = { notePath: note.path, createdAt: deps.now().toISOString(), epics, issues: check.issues };
      const newEpics = check.issues.filter((i) => i.type === "Epic").length;
      deps.log(
        `[jira] draft done in ${took}: ${actions.length} open actions, ${epics.length} epics found, ` +
          `${check.issues.length - newEpics} tasks, ${newEpics} new epics`,
      );
      return c.json(draft);
    } finally {
      drafting = false;
    }
  });

  // { path, issues } (as Islam edited them) -> JiraCreateResult. The one write to Jira.
  router.post("/create", async (c) => {
    if (creating) throw new HTTPException(409, { message: "A Jira create is already running" });
    creating = true;
    try {
      const body = await readObject(c);
      const note = await deps.notes.read(notePathOf(body.path));
      const baseBody = note.body;
      const open = openActions(detectActions(baseBody, config.jira.projectKey));
      if (open.length === 0) throw badRequest("No open actions to file");
      const s = settings();
      const check = validateDraftIssues(body.issues, {
        epicKeys: new Set((drafts.get(note.path) ?? []).map((e) => e.key)),
        actionIds: new Set(open.map((a) => a.id)),
        projectKey: s.projectKey,
        orphanEpics: "reject",
      });
      if (!check.ok) throw badRequest(check.error);

      const startedAt = deps.now().getTime();
      const outcome = await createIssues(check.issues, { ...s, timeoutMs: s.createTimeoutMs });
      const took = seconds(deps.now().getTime() - startedAt);
      const { created, failed } = outcome.result;
      if (outcome.signIn) {
        deps.log(`[jira] create failed (${outcome.signIn.reason}) in ${took}: ${check.issues.length} issues, none created`);
        throw new HTTPException(503, { message: outcome.signIn.message });
      }

      // New epics become existing ones for a retry of the Tasks that failed.
      const newEpics = created.filter((x) => x.type === "Epic");
      if (newEpics.length > 0) {
        const summaryOf = new Map(check.issues.map((i) => [i.draftId, i.summary] as const));
        rememberEpics(note.path, [
          ...(drafts.get(note.path) ?? []),
          ...newEpics.map((e) => ({ key: e.key, summary: summaryOf.get(e.draftId) ?? "" })),
        ]);
      }

      const edits = writeBackEdits(created, check.issues, open);
      const written = await writeBack(deps.notes, note.path, baseBody, edits);
      if (written.status === "written") await deps.snapshots.refreshLocal();
      const writeFailure = writeBackFailure(written, edits);
      const result: JiraCreateResult = { created, failed: writeFailure ? [...failed, writeFailure] : failed };

      const tasks = created.length - newEpics.length;
      const ignored = outcome.ignored > 0 ? `, ${outcome.ignored} answer entries ignored` : "";
      deps.log(
        `[jira] create done in ${took}: ${outcome.runs} runs, ${newEpics.length} epics and ${tasks} tasks created, ` +
          `${failed.length} failed${ignored}, write-back ${written.status}${written.status === "written" ? ` (${written.lines} lines)` : ""}`,
      );
      return c.json(result);
    } finally {
      creating = false;
    }
  });

  return router;
}
