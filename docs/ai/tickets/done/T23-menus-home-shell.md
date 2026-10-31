# T23: Right-click menus on Home, header and detail views

1. **Goal:** Right-click on Home panels and their rows, the header, and the detail overlays shows actions for that thing.
2. **Why it matters:** Faster daily glance: act on a move or alert where it is.
3. **Files likely changed:** `web/src/views/Home.*`, `web/src/panels/*`, `web/src/shell/Header.tsx`, `web/src/shell/DetailOverlay.tsx`, `web/src/details/*`, `web/src/ui/Panel.tsx`.
4. **Acceptance criteria (suggested items, adjust to what the code supports):**
   - Next moves row: Mark done, Dismiss, Open link (if any). Panel: Re-run next moves.
   - Needs you item: Open (its link or detail), Open in Jira/GitHub where it links out.
   - KPI tile and any panel with a details view: Open details. Panel with retry: Retry.
   - Time by project bar: Open project, Show all projects. Week timeline / heatmap: Open details, switch range or metric.
   - Header view switch: Go to Home / Projects / Notes / Life map. Source dot: Refresh all data.
   - Detail overlay rows (Jira issue, PR): Open in Jira / GitHub, Copy link. Overlay: Close.
5. **Edge cases:** empty panels (only the panel and everywhere sections), AI not run yet, offline.
6. **Tests required:** existing pass; tests for any new pure helper.
7. **Security impact:** none (links reuse existing https-only URLs).
8. **Risk level:** low
9. **Recommended order:** batch 8
10. **Dependencies:** supervisor foundation (done).

**Read first:** `docs/ai/tickets/RIGHT-CLICK-MENUS.md`, this ticket, `web/src/ui/ContextMenu.tsx`.
**Forbidden:** files not listed; `shared/types.ts`; npm dependencies; git commits. Visual check port: 5174.

## Definition of Done
- [x] Acceptance criteria met
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
