# T28: Jira server: detected actions, AI draft, create reviewed issues, write-back

1. **Goal:** Serve the Jira API in docs/ARCHITECTURE.md "v1.2":
   - detect the actions in a note
   - draft Jira issues for them with AI (read-only)
   - create the issues Islam reviewed, through the Atlassian connector
   - write the new keys back into the note
2. **Why it matters:** Islam turns meeting notes into Jira tasks under the right epic, assigned to and reported by him, without retyping.
3. **Files likely changed:**
   - `server/routes/jira.ts`: replace the stub, keep the export and deps.
   - new `server/jira/actions.ts`: pure detection.
   - new `server/jira/draft.ts`, `server/jira/create.ts` and `server/jira/writeBack.ts`.
   - `server/config.ts`: `JIRA_ACCOUNT_ID` (default `712020:e1e9b601-f708-4c43-84a3-789ac7ef493b`) and `JIRA_PROJECT_KEY` (default `AN`). Both are plain config, not secrets.
   - tests and fixtures next to each.
4. **Acceptance criteria:**
   - **Verified facts (supervisor, 2026-10-31):**
     - AN issue types are Epic (id 10000), Story, Task (id 10002), Sub-task, Bug and Analytics task.
     - Islam's open epics today are AN-3977 "QIC FastBind..." (In Progress) and AN-4373 "MVHI Claims Copilot" (Backlog). AN-4541 is Done.
     - `claude -p` sees the connector as `mcp__claude_ai_Atlassian__<tool>`.
     - The run must allow `ToolSearch`, or it races the connector while it is still connecting.
     - The working arg pattern, from T26: `--tools ToolSearch --allowedTools <exact tool> --setting-sources project --output-format json --model sonnet`.
     - Reuse `childEnv`, `BLOCKED_TOOLS` and the spawn and not-logged-in handling from `server/ai/nextMoves.ts` and `server/connectors/run.ts`.
   - **GET actions:**
     - Returns DetectedAction[], following the detection rules in the architecture doc.
     - Ids are stable for the same text and line.
     - `jiraKey` is set when the line holds `[A-Z][A-Z0-9]+-\d+`.
   - **POST draft:**
     - Allowed tools: only ToolSearch and `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql`.
     - The prompt gives the note title, the project name if linked, the unfiled actions with their surrounding note text (capped), and the exact epic JQL from the architecture doc.
     - It asks for `{epics:[{key,summary}], issues:[JiraDraftIssue]}`.
     - Nothing is created.
   - **Draft validation:**
     - The type is Task or Epic.
     - An existing parent key must be in the returned epics and match `^AN-\d+$`.
     - A new parent must be an Epic draftId in the same draft.
     - Epics have no parent.
     - Every Task covers at least one known action id.
     - Summary is 5 to 120 characters, description 20 to 1500, with at most 15 issues.
   - **POST create:**
     - Re-validates the edited issues with the same rules, plus they must belong to the note's actions.
     - Runs `claude -p` with only ToolSearch and `mcp__claude_ai_Atlassian__createJiraIssue`.
     - Gives exact payloads: project key, issue type name, summary, description, the assignee account id from config, and for Tasks `parent` = the epic key.
     - New Epics are created first, in a first run or step, and their returned keys are filled into their Tasks before those are created.
     - The run must return JSON `[{draftId,key}]`. Keys must match `^AN-\d+$`; anything else is a failure.
     - Returns JiraCreateResult, with url `https://<JIRA_SITE>/browse/<key>`.
   - **Write-back:**
     - After a create, each created Task's key is appended to its action lines as ` (AN-123)`, through the notes store.
     - On a version conflict it refuses and the result says so; the Jira keys are still returned.
     - The note's mtime and cache update as usual.
   - **Logging:** one line per run with counts and duration, never note text.
5. **Edge cases:**
   - A note with no actions: draft returns 400 "No open actions to file". The same applies when every action is already filed.
   - The connector is not signed in: 503 with a sign-in message, like T26.
   - The model invents an epic key, returns a Story or Sub-task, or goes over the caps.
   - A half-done create, for example the epic was created but a task failed: return both lists and write back only what was created.
   - Two creates at once: single-flight, and the second gets 409.
   - The note is edited during a run: report the write-back conflict, never overwrite.
6. **Tests required:**
   - detection over meeting-template notes, mixed bullets, already-filed lines and Arabic text
   - the draft validator with good, hostile and invented-key input
   - create payload building, epic-first ordering and parent fill-in
   - create result validation
   - write-back text edits and the conflict path
   - route tests with a fake runner
   - the args builders: the exact allowed tools, BLOCKED_TOOLS present, no strict-mcp-config
7. **Security impact:** high attention.
   - This is the one place the app writes to an outside system.
   - Note text is untrusted in the draft run, which has read tools only.
   - The create run gets only the reviewed, validated payloads and only the create tool.
   - The assignee comes from config, never from the model, and the project key is fixed.
   - No new server network calls.
8. **Risk level:** high
9. **Recommended order:** batch 10
10. **Dependencies:** supervisor contract (done).

**Read first:** `docs/ARCHITECTURE.md` section "v1.2" (decisions, contract, API, safety rules), `shared/types.ts` (v1.2 block, do not change it), this ticket.
**Forbidden:**
- files not listed in item 3
- `shared/types.ts` and `server/app.ts`
- npm dependencies
- running the real `claude` CLI in tests
- reading `.env`
- restarting or writing through the live dashboard on port 4317 (real notes and Jira)
- creating any real Jira issue
- git commits
- em-dashes

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
