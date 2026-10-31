# T10: Week timeline, project-time bars, year heatmap

1. **Goal:** Fill `web/src/panels/WeekTimeline.tsx`, `ProjectTimeBars.tsx` and `YearHeatmap.tsx` as hand-drawn d3 SVG charts.
2. **Why it matters:** These answer the weekly question "where did my time go, and what is coming" at a glance.
3. **Files likely changed (the only files this ticket may create or edit):** those three files, their `.module.css`, `web/src/lib/timeAgg.ts`, `web/src/lib/timeAgg.test.ts`.
4. **Acceptance criteria:**
   - Week timeline: 7 columns, Sunday to Saturday, today highlighted, Jira due dates and calendar events placed by day (calendar not connected shows a small inline note, not an empty chart), overdue items stacked in a left "Overdue" lane in red. Hover or focus shows a tooltip; click opens the source.
   - Project-time bars: horizontal bars sorted descending, hours this week per project from `sessionTime`, top 8 plus "Other". Toggle week or month. Bars grow in on first load. Labels left, values right-aligned in mono.
   - Year heatmap: GitHub-style grid of the last 52 weeks. A selector switches the metric: work minutes (sessions), commits, check-in sleep, workouts. Sequential cyan scale with 5 steps and a legend; empty days distinct from zero. Tooltip per cell with date and value. Keyboard: arrow keys move between cells with a visible focus, Enter opens the detail for that area.
   - All three accept `prefers-reduced-motion`, use tokens only, and show loading, empty, error and not-connected states through `Panel`.
   - Clicking a chart's title area calls `openDetail(area)` with `layoutId={"tile-" + area}`.
5. **Edge cases:** one project only, 40 projects, a project name 60 characters long, all-zero year, leap year, timezone day boundaries, a narrow 360 px screen (heatmap scrolls inside its own panel only, newest weeks visible first).
6. **Tests required:** `timeAgg.ts`: week bucketing from Sunday, month totals, top 8 plus Other, heatmap grid building with gaps, quantile thresholds.
7. **Security impact:** none.
8. **Risk level:** low
9. **Recommended order:** batch 3
10. **Dependencies:** T08

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket, the T08 primitives, and vault pages `ux/data-dense-ui-tables-and-dashboards.md`, `ux/motion-principles.md`, `ux/color-and-contrast.md`, `ux/keyboard-and-focus-patterns.md`.
**Forbidden:** any file not listed in item 3; changing tokens, shell or primitives (report needed changes instead); changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
