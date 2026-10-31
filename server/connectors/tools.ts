// Read-only tool allowlist for the connector run (ticket T26).
//
// `claude -p` sees the claude.ai connectors as `mcp__claude_ai_<Server>__<tool>`. The run may
// call only the exact tools listed here, plus ToolSearch to load them. Every name must be a
// read tool: nothing that creates, edits, sends, moves or deletes. A service with an empty
// list is skipped by the run, and its collector reports not_connected.

export type ConnectorService = "jira" | "calendar" | "email";

export const CONNECTOR_SERVICES = ["jira", "calendar", "email"] as const satisfies readonly ConnectorService[];

export const CONNECTOR_TOOLS: Readonly<Record<ConnectorService, readonly string[]>> = {
  jira: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"],
  // Read only. The connector also offers create, update, delete and respond: never listed here.
  calendar: ["mcp__claude_ai_Google_Calendar__list_events"],
  // Read only, sender and subject. The connector also offers send, reply, forward, draft, label,
  // spam and trash tools: never listed here.
  email: ["mcp__claude_ai_Gmail__search_threads"],
};

/** The connector's name as claude.ai shows it in /mcp. */
export const CONNECTOR_LABELS: Readonly<Record<ConnectorService, string>> = {
  jira: "Atlassian",
  calendar: "Google Calendar",
  email: "Gmail",
};

/** Shown by a collector whose service has no tools yet. */
export function signInMessage(service: ConnectorService): string {
  return `Sign in for Claude Code: run claude, type /mcp, pick claude.ai ${CONNECTOR_LABELS[service]}`;
}

const TOOL_NAME = /^mcp__claude_ai_[A-Za-z0-9_-]+__[A-Za-z0-9_]+$/;
// Verbs that mean a tool changes something. A name holding one of them is never allowed.
const WRITE_VERBS =
  /(create|edit|update|delete|remove|trash|send|draft|reply|forward|transition|add|move|modify|write|post|put|patch|archive|label|mark|accept|decline|respond|invite|share|upload|import|execute)/i;

/** True for a claude.ai connector tool name whose action part reads only. */
export function isReadOnlyToolName(name: string): boolean {
  if (!TOOL_NAME.test(name)) return false;
  const action = name.slice(name.lastIndexOf("__") + 2);
  return !WRITE_VERBS.test(action);
}

/** Services that have at least one allowed tool, in a fixed order. */
export function enabledServices(tools: Readonly<Record<ConnectorService, readonly string[]>> = CONNECTOR_TOOLS): ConnectorService[] {
  return CONNECTOR_SERVICES.filter((s) => tools[s].some(isReadOnlyToolName));
}

/** Union of every service's read-only tools, without duplicates. Names that fail the read-only check are dropped. */
export function allowedConnectorTools(tools: Readonly<Record<ConnectorService, readonly string[]>> = CONNECTOR_TOOLS): string[] {
  return [...new Set(CONNECTOR_SERVICES.flatMap((s) => tools[s].filter(isReadOnlyToolName)))];
}
