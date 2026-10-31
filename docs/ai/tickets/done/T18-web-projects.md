# T18: Projects view and registry-aware charts

1. **Goal:** Fill `web/src/views/Projects.tsx` with the project tracker UI, and make the life map and project-time bars use tracked projects.
2. **Why it matters:** This is where Islam adds, removes and steers projects, and sees time, tasks, deadlines and notes per project.
3. **Files likely changed (the only files this ticket may create or edit):** `web/src/views/Projects.tsx`, `web/src/views/Projects.module.css`, `web/src/projects/*` (new components and their css), `web/src/lib/projects.ts`, `web/src/lib/projects.test.ts`, `web/src/lib/lifeGraph.ts` and its test, `web/src/views/LifeMap.tsx` (only to pass registry data), `web/src/panels/ProjectTimeBars.tsx`, `web/src/lib/timeAgg.ts` and its test.
4. **Acceptance criteria:**
   - Board: cards grouped by status (Active, Paused, Idea, Done collapsed), each with area chip, deadline countdown (red under 3 days), task progress bar, hours this week with a sparkline, open actions from linked notes, last note date. Filter by area.
   - Add project: dialog with name, area, status, deadline, description, and a picker of untracked detected names to fold in as sources.
   - Project detail (`#/projects/<id>`, shared-layout morph from its card): inline-editable fields, goals list, tasks (add with Enter, tick with animation, due date, delete with a 5 s undo toast), sources editor (add from untracked, remove), linked notes list linking to `#/notes/<path>`, a "New meeting note" button that creates a note in `Meeting notes` linked to this project via `web/src/api/notes.ts` and opens it, Delete project with a confirm step that says what happens (its sources become untracked, notes keep their files).
   - Untracked tray: detected names with minutes and commits; actions Track (creates a project), Add to project, Hide; a Hidden list with Unhide.
   - Charts: bars and life map group time by tracked project and area from the registry; hidden names excluded; untracked active names fold into Other.
   - Every state (loading, empty with a clear first step, error) via `Panel`; tokens only; motion per the vault rules; works at 1440 and 375 px; fully keyboard operable.
5. **Edge cases:** zero projects (empty state invites curating), 40 projects, 200 tasks in one project, a project deleted elsewhere (404 handled), long names, Arabic names.
6. **Tests required:** `lib/projects.ts` (grouping, countdowns, progress, sort); updated lifeGraph and timeAgg tests for registry grouping.
7. **Security impact:** low. Text as text; links only to internal hashes or https.
8. **Risk level:** medium
9. **Recommended order:** batch 6. The server routes land in parallel: build against `web/src/api/projects.ts`; while a route still answers 501, test with in-tab fetch stubs, then re-verify once it is live.
10. **Dependencies:** T15

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md` (especially "v1.1: Project tracker and notes" and "Visual direction"), `docs/WORKFLOW.md`, this ticket, the T08 primitives in `web/src/ui`, and vault pages `ux/data-dense-ui-tables-and-dashboards.md`, `ux/forms-and-validation.md`, `ux/motion-principles.md` in `C:\Users\ialab\Desktop\MD Files\Working-With-Claude`.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits; starting, stopping or restarting servers (a shared one runs on 127.0.0.1:4317 and http://localhost:5173 and reloads on save).
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), what you verified in the browser, needed changes outside your scope.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
