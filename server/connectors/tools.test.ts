import { describe, expect, it } from "vitest";
import { CONNECTOR_SERVICES, CONNECTOR_TOOLS, allowedConnectorTools, enabledServices, isReadOnlyToolName, signInMessage } from "./tools";

describe("connector tool allowlist", () => {
  it("Jira has exactly the JQL search tool; Calendar and Gmail wait for sign-in", () => {
    expect(CONNECTOR_TOOLS).toEqual({
      jira: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"],
      calendar: [],
      email: [],
    });
    expect(enabledServices()).toEqual(["jira"]);
  });

  it("every configured tool is a read-only claude.ai connector tool", () => {
    for (const s of CONNECTOR_SERVICES) for (const tool of CONNECTOR_TOOLS[s]) expect(isReadOnlyToolName(tool)).toBe(true);
  });

  it.each([
    "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
    "mcp__claude_ai_Atlassian__getJiraIssue",
    "mcp__claude_ai_Gmail__search_threads",
    "mcp__claude_ai_Google_Calendar__list_events",
  ])("accepts the read tool %s", (name) => {
    expect(isReadOnlyToolName(name)).toBe(true);
  });

  it.each([
    "mcp__claude_ai_Atlassian__createJiraIssue",
    "mcp__claude_ai_Atlassian__editJiraIssue",
    "mcp__claude_ai_Atlassian__transitionJiraIssue",
    "mcp__claude_ai_Atlassian__addCommentToJiraIssue",
    "mcp__claude_ai_Gmail__send_message",
    "mcp__claude_ai_Gmail__create_draft",
    "mcp__claude_ai_Gmail__modify_labels",
    "mcp__claude_ai_Google_Calendar__delete_event",
    "mcp__claude_ai_Google_Calendar__update_event",
    "mcp__claude_ai_Google_Calendar__respond_to_event",
    "Bash",
    "WebFetch",
    "mcp__other_server__searchJiraIssuesUsingJql",
    "mcp__claude_ai_Atlassian__*",
    "mcp__claude_ai_Atlassian",
  ])("rejects %s", (name) => {
    expect(isReadOnlyToolName(name)).toBe(false);
  });

  it("the union has no duplicates and leaves out anything that is not read-only", () => {
    const lists = {
      jira: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", "mcp__claude_ai_Atlassian__createJiraIssue"],
      calendar: ["mcp__claude_ai_Google_Calendar__list_events"],
      email: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", "Bash"],
    };
    expect(allowedConnectorTools(lists)).toEqual(["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", "mcp__claude_ai_Google_Calendar__list_events"]);
    // Gmail's only valid tool is a duplicate of Jira's, so it still counts as having a tool.
    expect(enabledServices(lists)).toEqual(["jira", "calendar", "email"]);
    expect(enabledServices({ jira: ["Bash"], calendar: [], email: [] })).toEqual([]);
  });

  it("sign-in messages name the claude.ai connector", () => {
    expect(signInMessage("email")).toBe("Sign in for Claude Code: run claude, type /mcp, pick claude.ai Gmail");
    expect(signInMessage("calendar")).toBe("Sign in for Claude Code: run claude, type /mcp, pick claude.ai Google Calendar");
  });
});
