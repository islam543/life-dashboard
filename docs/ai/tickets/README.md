# Tickets: life-dashboard v1

Open backlog = files at this level. Finished tickets move to `done/`. Plan: `../../../PLAN.md`. Architecture and contract: `../../ARCHITECTURE.md`.

| Ticket | Title | Owner | Depends on | Batch | Status |
|---|---|---|---|---|---|
| T01 | Scaffold, contract, store, server skeleton | backend-developer | none | 1 | done |
| T02 | GitHub collector | backend-developer | T01 | 2 | done |
| T03 | Claude sessions time collector | backend-developer | T01 | 2 | done |
| T04 | Learning, check-ins, calendar, email collectors | backend-developer | T01 | 2 | done |
| T05 | Jira collector | backend-developer | T01 | 2 | done |
| T06 | Needs-you rule engine | backend-developer | T01 | 2 | done |
| T07 | AI next-moves runner | backend-developer | T01 | 2 | done |
| T08 | Web foundation: tokens, shell, hooks, primitives | frontend-developer | T01 | 2 | done |
| T09 | Needs-you strip, Next moves, KPI tiles | frontend-developer | T08 | 3 | done |
| T10 | Week timeline, project bars, year heatmap | frontend-developer | T08 | 3 | done |
| T11 | Explore detail views | frontend-developer | T08 | 3 | done |
| T12 | Life map view | frontend-developer | T08 | 3 | done |
| T13 | Daily check-in dialog | frontend-developer | T08 | 3 | done |
| T14 | Integration run, review and fixes | main session | T01 to T13 | 4 | done |
| T15 | v1.1 scaffold: contract, stubs, routes, nav | backend-developer | T01 to T14 | 5 | done |
| T16 | Server project tracker, needs-you rules, AI prompt | backend-developer | T15 | 6 | done |
| T17 | Server notes store in the vault | backend-developer | T15 | 6 | done |
| T18 | Projects view and registry-aware charts | frontend-developer | T15 | 6 | done |
| T19 | Notes view | frontend-developer | T15 | 6 | done |
| T20 | Ultrawide Home, shell, details, hover help | frontend-developer | foundation | 7 | done |
| T21 | Ultrawide Projects, hover help | frontend-developer | foundation | 7 | done |
| T22 | Ultrawide Notes and Life map, hover help | frontend-developer | foundation | 7 | done |
| T23 | Right-click menus: Home, header, details | frontend-developer | foundation | 8 | done |
| T24 | Right-click menus: Projects | frontend-developer | foundation | 8 | done |
| T25 | Right-click menus: Notes and Life map | frontend-developer | foundation | 8 | done |
| T26 | Jira, Calendar and Gmail through Claude connectors | backend-developer | none | 9 | done |

## Assumptions taken (say if any is wrong)

- Jira is read with your own Jira API token in a local `.env` (created at id.atlassian.com, Security, API tokens). If QIC does not allow personal API tokens, T05 switches to fetching Jira through Claude's Atlassian connector during the AI run.
- Calendar and Gmail ship as honest "not connected" panels in v1.
- The AI layer uses `claude -p` with your Claude login (no separate API key). It needs one `claude` login in a terminal, since the CLI session on this PC has expired.
- Week starts Sunday, workdays Sunday to Thursday, currency QAR.
- Trading is out of v1, as decided.
