# T24: Right-click menus on Projects

1. **Goal:** Right-click on the board lanes, project cards, the Untracked tray and the project page shows actions for that thing.
2. **Why it matters:** This is Islam's example: right-click the Ideas lane and get "Add idea".
3. **Files likely changed:** `web/src/views/Projects.*`, everything in `web/src/projects/`.
4. **Acceptance criteria (suggested items, adjust to what the code supports):**
   - Lane: Active "New project", Ideas "Add idea", Paused "Add paused project", Done none or "New project". Each opens the New project dialog with that status preselected (add an initial-status prop to the dialog if missing; the visible New project button stays).
   - Board background: New project, area filter choices.
   - Project card: Open, Move to Active / Paused / Ideas / Done (omit the current one), Add task, New meeting note, Copy link, Delete project (danger, existing confirm).
   - Untracked tray item: Track, Add to project, Hide.
   - Project page: Add task, Add goal, New meeting note, Change status, Delete project. Task row: Mark done / not done, Set due date, Delete task (danger, existing undo). Goal row and linked note row: Open, Remove or unlink where the page already offers it.
5. **Edge cases:** archived/done project, project with no tasks, lane folded or empty, dialog already open.
6. **Tests required:** existing pass; tests for any new pure helper (e.g. which statuses a card can move to).
7. **Security impact:** none.
8. **Risk level:** low
9. **Recommended order:** batch 8
10. **Dependencies:** supervisor foundation (done).

**Read first:** `docs/ai/tickets/RIGHT-CLICK-MENUS.md`, this ticket, `web/src/ui/ContextMenu.tsx`.
**Forbidden:** files not listed; `shared/types.ts`; npm dependencies; git commits. Visual check port: 5175.

## Definition of Done
- [x] Acceptance criteria met
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
