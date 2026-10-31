# T21: Ultrawide Projects, with hover help

1. **Goal:** The Projects board and project detail use the full 21:9 width, and every control explains itself on hover.
2. **Why it matters:** The tracker is where tasks and deadlines get edited; wide columns let a whole project fit on one screen.
3. **Files likely changed:** `web/src/views/Projects.tsx`, `Projects.module.css`; everything in `web/src/projects/`.
4. **Acceptance criteria:**
   - Board at >=1920px: status columns plus the Untracked tray side by side, each column scrolls inside itself; the board fits 940px height.
   - Project detail at >=1920px: three columns (for example overview and goals / tasks / linked notes and time chart) that fit 940px height with inner scroll.
   - All controls have tips per the shared brief (task checkbox, due date, delete with undo, status picker, track / merge / hide in the tray, new meeting note, delete project, inline edit fields).
   - Below 1920px nothing changes.
5. **Edge cases:** project with 0 or 40 tasks; empty status column; empty tray; long project names.
6. **Tests required:** existing tests pass; add tests only for new logic.
7. **Security impact:** none.
8. **Risk level:** low
9. **Recommended order:** batch 7
10. **Dependencies:** supervisor foundation (done).

**Read first:** `docs/ai/tickets/ULTRAWIDE-AND-TIPS.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** files not listed; `shared/types.ts`; npm dependencies; git commits. Visual check port: 5175.

## Definition of Done
- [x] Acceptance criteria met (checked at 2560x940, 1920x950 and 3440x1300: no page scroll; 1440 unchanged)
- [x] Tests listed in item 6 exist and pass (new logic: `web/src/projects/fit.test.ts`, 5 tests)
- [x] `npm run typecheck` passes
- [x] No em-dash characters in any file touched
- [x] Report sent
