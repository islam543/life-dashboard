# T22: Ultrawide Notes and Life map, with hover help

1. **Goal:** Notes and the Life map use the full 21:9 width and height, and every control explains itself on hover.
2. **Why it matters:** Writing meeting notes while seeing the list and the rendered preview at once is the main win of a wide screen.
3. **Files likely changed:** `web/src/views/Notes.tsx`, `Notes.module.css`, `LifeMap.tsx`, `LifeMap.module.css`; everything in `web/src/notes/`; `web/src/lib/lifeGraph.ts` only if the map needs a wider layout computation (keep its tests passing).
4. **Acceptance criteria:**
   - Notes at >=1920px: section tree | note list | editor and live preview side by side (four panes), each scrolling inside itself, fitting 940px height. Editor and preview lines stay at 75ch or less.
   - Life map at >=1920px fills the available width and the viewport height without page scroll; nodes spread to use the wide aspect.
   - All controls have tips per the shared brief (new note, new section, rename, delete to .trash, template pick, project link, tags, edit/preview toggle, conflict choice, map node and filter controls).
   - Below 1920px nothing changes.
5. **Edge cases:** no notes; very long note; Arabic text (RTL) in preview; conflict dialog open; map with 1 or 16 projects.
6. **Tests required:** existing tests pass, including lifeGraph tests; add tests for any new layout logic.
7. **Security impact:** none (markdown preview stays without raw HTML).
8. **Risk level:** low
9. **Recommended order:** batch 7
10. **Dependencies:** supervisor foundation (done).

**Read first:** `docs/ai/tickets/ULTRAWIDE-AND-TIPS.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** files not listed; `shared/types.ts`; npm dependencies; git commits. Visual check port: 5176.

## Definition of Done
- [x] Acceptance criteria met (checked at 2560x940, 1920x950 and 3440x1300 with no page scroll; 1919px and 1440px unchanged; edge cases checked with mocked notes API: no notes, 76 KB note, Arabic, conflict plus failed save, map with 1 and 16 projects)
- [x] Tests listed in item 6 exist and pass (new layout logic in `web/src/lib/lifeGraph.test.ts`: 4 tests; `npx vitest run`: 30 files, 667 tests)
- [x] `npm run typecheck` passes
- [x] No em-dash characters in any file touched
- [x] Report sent
