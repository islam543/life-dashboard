# T11: Explore detail views

1. **Goal:** Fill `web/src/details/WorkDetail.tsx`, `LearningDetail.tsx`, `PersonalDetail.tsx`, `CalendarDetail.tsx`, the full-screen views that open when a tile expands.
2. **Why it matters:** Glance mode shows few numbers; explore mode is where Islam checks the weekly picture and finds the item behind a number.
3. **Files likely changed (the only files this ticket may create or edit):** those four files, their `.module.css`, `web/src/lib/detailRows.ts`, `web/src/lib/detailRows.test.ts`.
4. **Acceptance criteria:**
   - Work: tabs Jira, Pull requests, CI, Time. Jira and PR tabs are tables per the vault data-table page (human-readable first column like the issue key plus summary, sticky header, sort with visible arrow, default sort most urgent first, filter chips for project and status with a clear-all, right-aligned mono numbers). CI shows pass or fail per repo. Time shows 30-day stacked area by project with a legend in a fixed place.
   - Learning: current concept, cycle steps as a progress stepper, streak with best, this month's agenda checklist (read-only).
   - Personal: 30 and 90 day line charts for sleep, energy, mood; workout bars; spend per week bars; a table of recent check-ins; a "Check in now" button via `CheckinContext` when today is missing.
   - Calendar: the not-connected state with the exact steps to connect Gmail and Calendar in claude.ai Settings, Connectors (no fake events). When data arrives later, a day-by-day agenda list.
   - Every view: a title, a back control, Escape closes (handled by `DetailOverlay`), content stagger under 50 ms per item, all states through `Panel`.
5. **Edge cases:** 0 rows, 200 rows (paginate at 20 or virtual scroll), very long summaries (one-line truncate with full text on hover and focus), only one check-in, a source in error while others are fine.
6. **Tests required:** `detailRows.ts`: sorting (empty values last), filtering, pagination, check-in series building.
7. **Security impact:** low. Text only, links `rel="noopener noreferrer"`.
8. **Risk level:** low
9. **Recommended order:** batch 3
10. **Dependencies:** T08

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket, the T08 primitives and `DetailOverlay`, and vault pages `ux/data-dense-ui-tables-and-dashboards.md`, `ux/search-filters-and-sorting.md`, `ux/error-empty-loading-states.md`.
**Forbidden:** any file not listed in item 3; changing tokens, shell or primitives (report needed changes instead); changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
