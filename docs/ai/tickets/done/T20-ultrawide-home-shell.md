# T20: Ultrawide Home, shell and details, with hover help

1. **Goal:** Home fits a 2560x940 viewport with no page scroll, and every control in the shell, Home panels, detail overlays and check-in dialog explains itself on hover.
2. **Why it matters:** Home is the morning glance; on the 21:9 monitor it currently stacks into a scroll.
3. **Files likely changed:** `web/src/views/Home.tsx`, `Home.module.css`; `web/src/panels/*`; `web/src/shell/Header.tsx` (tips only, keep TipsSwitch as is), `Header.module.css`, `AppShell.*`, `DetailOverlay.*`; `web/src/details/*`; `web/src/checkin/*`; `web/src/ui/EmptyState.*`, `Panel.*`, `Sparkline.*`, `CountUp.*`, `StatusDot.*`, `Skeleton.*`.
4. **Acceptance criteria:**
   - At >=1920px Home is three columns: left (about 28%) Needs you above Next moves (the act-now column); centre (about 47%) KPI tiles, week timeline, year heatmap; right (about 25%) project time bars. Tune ratios if the content argues for it, and say why.
   - At 2560x940 no page scroll on Home; Next moves and project bars scroll inside their panels if long.
   - Detail overlay uses the extra width (e.g. wider panel or two-column content) at >=1920px.
   - Header fits on one row at >=1920px (greeting, actions, view switch, sources).
   - All controls in these files have tips per the shared brief; native `title=` on controls replaced.
   - Below 1920px nothing changes.
5. **Edge cases:** Needs you empty ("Clear runway"); 0 or 10 next moves; 1 or 16 projects; AI not run yet; offline banner shown.
6. **Tests required:** existing tests pass; add a test only if you add logic.
7. **Security impact:** none.
8. **Risk level:** low
9. **Recommended order:** batch 7
10. **Dependencies:** supervisor foundation (done).

**Read first:** `docs/ai/tickets/ULTRAWIDE-AND-TIPS.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** files not listed; `shared/types.ts`; npm dependencies; git commits. Visual check port: 5174.

## Definition of Done
- [x] Acceptance criteria met (project bars never scroll: they cap at 8 projects plus Other, so they always fit)
- [x] Tests listed in item 6 exist and pass (`npx vitest run`: 30 files, 667 tests)
- [x] `npm run typecheck` passes
- [x] No em-dash characters in any file touched
- [x] Report sent
