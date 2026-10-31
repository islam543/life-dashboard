# T12: Life map view

1. **Goal:** Fill `web/src/views/LifeMap.tsx`: an interactive d3-force graph of Islam's life per ARCHITECTURE "Visual direction".
2. **Why it matters:** The big-picture view that answers "am I neglecting an area of my life" and makes the dashboard feel alive.
3. **Files likely changed (the only files this ticket may create or edit):** `web/src/views/LifeMap.tsx`, `web/src/views/LifeMap.module.css`, `web/src/lib/lifeGraph.ts`, `web/src/lib/lifeGraph.test.ts`.
4. **Acceptance criteria:**
   - Center node "Islam"; area nodes Work, Learning, Personal, Calendar, Email; project nodes around Work from `sessionTime` and `repoActivity` (merge names that match case-insensitively), Learning gets the current concept node.
   - Node size by attention in the last 7 days (minutes for projects, a fixed scale for areas from their activity), with a minimum size so idle nodes stay visible and look dim. Red or amber halo when the node has a needs-you item (Jira project or repo match). Not-connected areas drawn dashed with a tooltip saying what to connect.
   - Drag nodes, hover and focus tooltip, click an area or project opens `openDetail(area)`. Zoom and pan with wheel and drag on the background, a reset button.
   - Calm motion: the simulation settles within about 2 s then stops; a slow, very subtle glow on halo nodes only, disabled under reduced motion. Never loops forever otherwise.
   - Accessible fallback: a visually hidden list of areas and projects with their attention and alerts, and every node reachable by Tab.
   - A legend in a fixed corner explaining size, halo and dashed.
5. **Edge cases:** no projects, 60 projects (show top 20 by attention, the rest as one "Other" node), window resize, very long project names (truncate in label, full in tooltip), 360 px screen.
6. **Tests required:** `lifeGraph.ts`: node and link building, name merging, top 20 plus Other, halo assignment, size scale floor.
7. **Security impact:** none.
8. **Risk level:** medium (most complex visual)
9. **Recommended order:** batch 3
10. **Dependencies:** T08

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket, the T08 primitives, and vault pages `ux/motion-principles.md`, `ux/keyboard-and-focus-patterns.md`, `ux/color-and-contrast.md`.
**Forbidden:** any file not listed in item 3; changing tokens, shell or primitives (report needed changes instead); changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
