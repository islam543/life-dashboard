# T25: Right-click menus on Notes and the Life map

1. **Goal:** Right-click on note sections, notes and map nodes shows actions for that thing.
2. **Why it matters:** Meeting notes are created and filed often; doing it from the tree or list is faster.
3. **Files likely changed:** `web/src/views/Notes.*`, `web/src/views/LifeMap.*`, everything in `web/src/notes/`.
4. **Acceptance criteria (suggested items, adjust to what the code supports):**
   - Section in the tree: New note here, New meeting note here, New subsection, Rename, Copy folder path, Delete section (danger; disabled with the reason when not empty).
   - Note in the list: Open, Link to project, Copy path, Delete note (danger; it goes to notes/.trash, keep the existing confirm).
   - Notes list background: New note. Editor and preview: leave the browser menu in the text area (already automatic); the preview gets Edit / Show preview toggles where the view has them.
   - Life map: project node: Open project, Show details; area node: Open details; background: Reset view, Zoom in, Zoom out.
5. **Edge cases:** "All notes" pseudo-section (no rename or delete), unsaved changes, conflict dialog open, map with no projects.
6. **Tests required:** existing pass; tests for any new pure helper.
7. **Security impact:** none (no new file access; copy actions use the clipboard API only on user action).
8. **Risk level:** low
9. **Recommended order:** batch 8
10. **Dependencies:** supervisor foundation (done).

**Read first:** `docs/ai/tickets/RIGHT-CLICK-MENUS.md`, this ticket, `web/src/ui/ContextMenu.tsx`.
**Forbidden:** files not listed; `shared/types.ts`; npm dependencies; git commits. Visual check port: 5176.

## Definition of Done
- [x] Acceptance criteria met
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
