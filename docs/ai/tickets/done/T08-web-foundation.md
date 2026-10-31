# T08: Web foundation: tokens, shell, data hooks, primitives

1. **Goal:** Build the dark navy sci-fi foundation every panel uses: design tokens, bundled fonts, app shell and header, typed API client and hooks, shared UI primitives, the detail-overlay and check-in contexts, the Home grid with one stub file per panel, and the Home or Life map view switch.
2. **Why it matters:** Batch 3 tickets each own one panel file. They can work in parallel only if the grid, tokens, contexts and stubs exist and do not move.
3. **Files likely changed (the only files this ticket may create or edit):** `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles/tokens.css`, `web/src/styles/global.css`, `web/src/api.ts`, `web/src/hooks/useSnapshot.ts`, `web/src/hooks/useNextMoves.ts`, `web/src/hooks/useReducedMotion.ts`, `web/src/ui/{Panel,CountUp,Sparkline,Skeleton,StatusDot,Button,EmptyState}.tsx`, `web/src/ui/*.module.css`, `web/src/shell/{AppShell,Header,DetailOverlay}.tsx` and their css, `web/src/context/{DetailContext,CheckinContext}.tsx`, `web/src/views/Home.tsx`, `web/src/views/Home.module.css`, stub files `web/src/panels/{NeedsYouStrip,NextMovesPanel,KpiTiles,WeekTimeline,ProjectTimeBars,YearHeatmap}.tsx`, `web/src/details/{WorkDetail,LearningDetail,PersonalDetail,CalendarDetail}.tsx`, `web/src/views/LifeMap.tsx`, `web/src/checkin/CheckinDialog.tsx`, `web/src/lib/format.ts`, `web/src/lib/format.test.ts`.
4. **Acceptance criteria:**
   - Tokens per ARCHITECTURE "Visual direction": navy background and surface steps, cyan data accent, red and amber urgency, violet for AI, text levels, border and glow, spacing scale, radius, motion durations and easings. Components use tokens only. WCAG AA contrast for all text tokens on their surfaces (state the ratios in the report).
   - Fonts from `@fontsource` (Space Grotesk UI, JetBrains Mono numbers with `font-variant-numeric: tabular-nums`). Subtle background grid lines.
   - Header: date and greeting by local time, a refresh button (`POST /api/refresh`, spinner state), a check-in button (opens via `CheckinContext`), a Home or Life map switch (hash `#/` and `#/map`), and one status dot per source with a tooltip showing status, last update and message.
   - `useSnapshot` loads, polls every 5 min, exposes `{data, loading, error, refresh}`. `useNextMoves` exposes `{data, run, setState}` and polls every 3 s only while status is `running`.
   - Primitives: `Panel` with title, optional action, and `state` of loading (skeleton), empty, error, not_connected (renders the source message and what to do), ok. `CountUp` animates numbers on first render and when the value changes. `Sparkline` (d3 line, draws in). All motion respects `prefers-reduced-motion`.
   - `DetailContext` exposes `openDetail(area)` and `closeDetail()`; `DetailOverlay` renders the matching `details/*` component inside a `motion` element with `layoutId={"tile-" + area}`, closes on Escape, backdrop click and a back button, and returns focus to the opener. Tiles in batch 3 put the same `layoutId` on themselves.
   - Home grid (CSS grid areas): Needs-you strip full width on top; Next moves and KPI tiles next; then week timeline, project-time bars, year heatmap. Most important top-left. Works from 1440 px to 360 px wide with no horizontal scroll.
   - Each stub panel renders a `Panel` in loading state with its final title, so the page looks complete while batch 3 works.
5. **Edge cases:** API down (header shows an offline banner with retry; panels show error state); very long greeting or source message; reduced motion; keyboard only (visible focus ring on every control, logical tab order).
6. **Tests required:** `format.ts` helpers (relative time like "2 days ago", minutes to "3h 20m", QAR money, greeting by hour) unit tested. `npm run build` passes.
7. **Security impact:** low. Renders strings from the API as text only, never as HTML.
8. **Risk level:** medium
9. **Recommended order:** batch 2
10. **Dependencies:** T01

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket, and in `C:\Users\ialab\Desktop\MD Files\Working-With-Claude`: `ux/data-dense-ui-tables-and-dashboards.md`, `ux/motion-principles.md`, `ux/color-and-contrast.md`, `ux/dark-mode-and-theming.md`, `ux/no-invented-assets.md`.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; invented data or logos; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
