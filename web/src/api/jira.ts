import type { DetectedAction, JiraCreateResult, JiraDraft, JiraDraftIssue } from "../../../shared/types";
import { ApiRequestError } from "../api";
import { jsonRequest } from "./projects";

// Typed client for /api/jira (docs/ARCHITECTURE.md "v1.2", Jira API table; server ticket T28).
// Every call resolves with the parsed JSON or throws ApiRequestError (from ../api) with the server's
// ApiError message and HTTP status: 400 bad input, no open actions or a stale action id (the message
// says which), 409 a draft or create is already running, 501 the Jira part of the server is not
// built yet, 502 Claude's answer failed the checks or timed out, 503 the Atlassian connector or the
// claude CLI is not signed in (the message says how to sign in), status 0 `offline`. Use
// jiraErrorKind() from ../lib/jiraDraft to tell them apart.
//
// Draft and create wait for an AI run (about 20 to 60 seconds). Nothing reaches Jira before create.

const query = (path: string) => `?path=${encodeURIComponent(path)}`;

const unexpected = () => new ApiRequestError("The server sent an answer this page can't read.", 200, false);

export const jiraApi = {
  /** GET /api/jira/actions?path=: task lines and action bullets found in the note, in note order. */
  actions: async (path: string, signal?: AbortSignal): Promise<DetectedAction[]> => {
    const list = await jsonRequest<DetectedAction[]>("GET", `/api/jira/actions${query(path)}`, { signal });
    if (!Array.isArray(list)) throw unexpected();
    return list;
  },
  /** POST /api/jira/draft: Claude proposes one Task per open, unfiled action under a matching epic. Read-only. */
  draft: async (path: string): Promise<JiraDraft> => {
    const draft = await jsonRequest<JiraDraft>("POST", "/api/jira/draft", { body: { path } });
    if (!draft || !Array.isArray(draft.issues) || !Array.isArray(draft.epics)) throw unexpected();
    return draft;
  },
  /** POST /api/jira/create: creates the reviewed issues in Jira and writes the new keys into the note. */
  create: async (path: string, issues: JiraDraftIssue[]): Promise<JiraCreateResult> => {
    const result = await jsonRequest<JiraCreateResult>("POST", "/api/jira/create", { body: { path, issues } });
    if (!result || !Array.isArray(result.created) || !Array.isArray(result.failed)) throw unexpected();
    return result;
  },
};
