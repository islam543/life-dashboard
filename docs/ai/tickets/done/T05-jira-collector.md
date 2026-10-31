# T05: Jira collector

1. **Goal:** Fill `server/collectors/jira.ts`: issues assigned to Islam and not done, from Jira Cloud REST, per ARCHITECTURE.
2. **Why it matters:** Ticket due dates and blocked work are the core work signal.
3. **Files likely changed (the only files this ticket may create or edit):** `server/collectors/jira.ts`, `server/collectors/jira.test.ts`, `server/collectors/fixtures/jira/*.json`.
4. **Acceptance criteria:** without `JIRA_API_TOKEN` or `JIRA_EMAIL`, status `not_connected`, message "Add JIRA_EMAIL and JIRA_API_TOKEN to .env". With them: `GET https://{JIRA_SITE}/rest/api/3/search/jql` with the JQL from ARCHITECTURE, fields summary, status, priority, duedate, updated, project, labels; paginate with `nextPageToken` up to 200 issues; map to `JiraIssue` with `url = https://{site}/browse/{key}`. Global `fetch` with a 20 s timeout (`AbortSignal.timeout`).
5. **Edge cases:** 401 or 403 (status error "Jira token rejected"); 429 (keep last data); no due date; non-English status names (use statusCategory key); `JIRA_SITE` given with `https://` or a trailing slash.
6. **Tests required:** mapping from fixture response; missing env; 401; pagination stops at 200; site normalisation. Mock `fetch`, no network.
7. **Security impact:** high. Handles the Jira API token: read only from env, sent only to `JIRA_SITE` over https, never logged, never placed in the snapshot or in error messages.
8. **Risk level:** medium
9. **Recommended order:** batch 2
10. **Dependencies:** T01

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; creating a real `.env`; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
