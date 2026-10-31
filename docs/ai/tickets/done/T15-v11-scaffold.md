# T15: v1.1 scaffold: contract, stubs, routes, nav

1. **Goal:** Add the v1.1 contract to `shared/types.ts` exactly as in ARCHITECTURE, plus every stub, route mount and nav entry so T16 to T19 each fill only their own files.
2. **Why it matters:** Four agents run in parallel next; they can only stay in their lanes if the seams exist first.
3. **Files likely changed:** `shared/types.ts`, `server/config.ts` (+ `NOTES_DIR`, default `VAULT_DIR/notes`), `.env.example`, `README.md`, `server/projects.ts` (stub), `server/notes.ts` (stub), `server/routes/projects.ts` (stub Hono router), `server/routes/notes.ts` (stub Hono router), `server/app.ts` (mount both routers behind all existing guards), `server/snapshot.ts` (fill `projects` and `notes` by calling the stubs), affected existing tests, `package.json` and `package-lock.json` (add `react-markdown` and `remark-gfm`, exact pins), `web/src/App.tsx` (routes `#/projects[/id]`, `#/notes[/path]`), `web/src/shell/Header.tsx` (switch: Home, Projects, Notes, Life map), `web/src/lib/route.ts` + `route.test.ts` (hash parsing helper), `web/src/views/Projects.tsx` and `web/src/views/Notes.tsx` (stubs rendering a loading Panel), `web/src/api/projects.ts` and `web/src/api/notes.ts` (complete typed clients for every v1.1 route, returning parsed JSON or throwing with the `ApiError` message).
4. **Acceptance criteria:**
   - Fixed stub signatures, documented with comments:
     - `server/projects.ts`: `loadProjectsFile(store): Promise<ProjectsFile | null>`, `saveProjectsFile(store, file): Promise<void>`, `seedProjectsFile(snapshot, now): ProjectsFile`, `computeProjectsState(file, snapshot, notes: NoteMeta[], now): ProjectsState` (stub returns an empty state).
     - `server/notes.ts`: `createNotesStore(notesDir)` returning `{ index(): Promise<NotesIndex>; read(path): Promise<Note>; create(input): Promise<Note>; update(path, patch): Promise<Note>; remove(path): Promise<NotesIndex>; createSection(parent, name): Promise<NotesIndex>; renameSection(path, name): Promise<NotesIndex>; removeSection(path): Promise<NotesIndex>; recent(days, now): Promise<NoteMeta[]> }`. Stub: `index` and `recent` return empty with status `never_run`; others throw an error the router maps to 501.
     - Routers export `projectsRoutes(deps)` and `notesRoutes(deps)`; stubs answer 501 `ApiError` "Not built yet".
   - `Snapshot.projects` and `Snapshot.notes` always present (empty when stubbed).
   - `npm test`, `npm run typecheck`, `npm run build` pass; the existing 462 tests still pass.
   - Header switch shows four views with an active state, keyboard reachable, fits at 375 px.
5. **Edge cases:** NOTES_DIR missing (snapshot notes status `not_connected` naming the path); a hash with an encoded note path containing `/`.
6. **Tests required:** routers mounted (501 from stubs), snapshot carries the two new fields, `route.ts` hash parsing for all routes.
7. **Security impact:** medium. The new routers must sit behind the same Host, Origin and body-limit guards as the existing routes.
8. **Risk level:** medium
9. **Recommended order:** batch 5
10. **Dependencies:** T01 to T14

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md` (especially "v1.1: Project tracker and notes"), `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; anything under `~/.claude`; git commits; starting, stopping or restarting servers (a shared one runs on 127.0.0.1:4317 and http://localhost:5173 and reloads on save). This ticket alone may run `npm install`.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), the final stub signatures, open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
