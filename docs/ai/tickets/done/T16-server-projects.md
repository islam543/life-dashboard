# T16: Server project tracker, needs-you rules, AI prompt

1. **Goal:** Implement `server/projects.ts` and `server/routes/projects.ts` per ARCHITECTURE v1.1 (registry, CRUD, tasks, hide and unhide, stats, untracked detection, first-run seeding), add the v1.1 needs-you rules to `server/needsYou.ts`, and add projects and recent notes to the AI prompt in `server/ai/prompt.ts`.
2. **Why it matters:** Projects become the spine of the dashboard: time, tasks, deadlines, notes and AI advice all hang off them.
3. **Files likely changed (the only files this ticket may create or edit):** `server/projects.ts`, `server/projects.test.ts`, `server/routes/projects.ts`, `server/routes/projects.test.ts`, `server/needsYou.ts`, `server/needsYou.test.ts`, `server/ai/prompt.ts`, `server/ai/nextMoves.test.ts` (prompt assertions only).
4. **Acceptance criteria:** every projects route in the API table with the listed validation limits; ids are slugs unique across projects (suffix `-2` on clash); task ids random 8 chars; `updatedAt` bumped on every change; stats and untracked exactly as "Stats and detection"; seeding as specified, only when the file is missing; all five new needs-you rules with their ids, reading `snapshot.projects` and `snapshot.notes.recent` (open actions in a note whose section starts with `Meeting notes`); the prompt includes projects and notes as specified, trimmed so the whole prompt stays under the existing Windows length cap, and still treats them as data.
5. **Edge cases:** deleting a project whose name is also hidden; a source name claimed by two projects (409); a past deadline on a `done` project (no alert); 200 tasks; non-ASCII names; concurrent writes (serialise writes through one promise chain).
6. **Tests required:** CRUD and validation per route (400, 404, 409), seeding, stats summed across sources, untracked filtering, each new needs-you rule at its boundary, the prompt contains a project task and a note action line and no env values.
7. **Security impact:** low. Validate all input.
8. **Risk level:** medium
9. **Recommended order:** batch 6
10. **Dependencies:** T15

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md` (especially "v1.1: Project tracker and notes"), `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits; starting, stopping or restarting servers (a shared one runs on 127.0.0.1:4317 and http://localhost:5173 and reloads on save).
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
