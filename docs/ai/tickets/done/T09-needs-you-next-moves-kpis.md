# T09: Needs-you strip, Next moves panel, KPI tiles

1. **Goal:** Fill `web/src/panels/NeedsYouStrip.tsx`, `NextMovesPanel.tsx` and `KpiTiles.tsx`.
2. **Why it matters:** These answer the morning questions "what is on fire" and "what do I do first" without a click (see `docs/WORKFLOW.md`).
3. **Files likely changed (the only files this ticket may create or edit):** those three files, `web/src/panels/NeedsYouStrip.module.css`, `NextMovesPanel.module.css`, `KpiTiles.module.css`, `web/src/lib/kpis.ts`, `web/src/lib/kpis.test.ts`.
4. **Acceptance criteria:**
   - Needs-you strip: one card per item, red then amber, each with an icon plus text label for urgency (not color alone), title, detail, due time, link opens the source in a new tab. Items new since the last visit (ids remembered in localStorage, wrapped in try/catch) pulse once. Empty state when nothing needs Islam: a calm "Nothing urgent. Clear runway." line. "+N more" opens the work detail.
   - Next moves: ranked list in the AI violet accent, each with title, one-line reason, source link, Done and Dismiss buttons (`POST /api/next-moves/:id`) with exit animation. "Generated 2h ago" and a Re-run button (`POST /api/next-moves/run`, shows running state). States: `never_run` (button "Generate next moves"), `running` (skeleton plus "Thinking through your day"), `not_logged_in` (message plus the exact terminal step "Run claude in a terminal and log in"), `error`.
   - KPI tiles (bare numbers, `CountUp`, `Sparkline` of the last 14 days, comparison to the previous week): hours worked this week (sessions), open Jira issues, PRs waiting on you, commits this week, learning streak, 7-day average sleep. A tile whose source is not connected shows the not-connected state, never 0. Clicking a tile calls `openDetail(area)` and carries `layoutId={"tile-" + area}`.
   - `kpis.ts` holds every number calculation as pure functions.
5. **Edge cases:** 0 and huge counts (1,000+), 30 needs-you items, missing check-ins on some days (gaps in the sparkline, not zeros), week boundary (week starts Sunday), very long PR titles (two-line clamp with full title in `title` attribute).
6. **Tests required:** `kpis.ts`: this-week vs last-week, Sunday week start, sleep average skipping missing days, sparkline series with gaps.
7. **Security impact:** low. External links use `rel="noopener noreferrer"`.
8. **Risk level:** low
9. **Recommended order:** batch 3
10. **Dependencies:** T08

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket, the T08 primitives in `web/src/ui/`, and vault pages `ux/data-dense-ui-tables-and-dashboards.md`, `ux/motion-principles.md`, `ux/error-empty-loading-states.md`.
**Forbidden:** any file not listed in item 3; changing tokens, shell or primitives (report needed changes instead); changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
