# T01: Scaffold, contract, store and server skeleton

1. **Goal:** Create the runnable skeleton every other ticket plugs into: root package with all dependencies installed, `shared/types.ts` copied exactly from `docs/ARCHITECTURE.md`, config, JSON store, Hono server with every API route, scheduler, collector registry with one stub file per collector, stub `needsYou.ts` and `ai/nextMoves.ts`, a minimal Vite React app that fetches `/api/snapshot` and prints `generatedAt`.
2. **Why it matters:** Parallel tickets each own one file. They can only do that if the registry, routes, stubs and contract already exist and do not move.
3. **Files likely changed (the only files this ticket may create or edit):** `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `vitest.config.ts`, `.env.example`, `README.md`, `shared/types.ts`, `server/index.ts`, `server/app.ts` (Hono app factory, exported for tests), `server/config.ts`, `server/store.ts`, `server/scheduler.ts`, `server/snapshot.ts` (assembles Snapshot from collector results), `server/checkinValidate.ts`, `server/collectors/types.ts` (Collector interface), `server/collectors/index.ts` (registry), stub files `server/collectors/{github,jira,claudeSessions,learning,checkins,calendar,email}.ts`, `server/needsYou.ts` (stub returns []), `server/ai/nextMoves.ts` (stub: never_run), `server/*.test.ts`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/App.tsx`.
4. **Acceptance criteria:**
   - `npm install` done with every dependency named in ARCHITECTURE "Stack": hono, @hono/node-server, tsx, typescript, vite, @vitejs/plugin-react, react, react-dom, @types/react, @types/react-dom, @types/node, motion, d3, @types/d3, @fontsource/space-grotesk, @fontsource/jetbrains-mono, vitest, concurrently, dotenv. Exact versions pinned (no `^`).
   - Scripts `dev`, `build`, `start`, `test`, `collect`, `typecheck` work. `typecheck` covers server, shared and web.
   - Collector interface lets each collector return its slice of the snapshot plus a `SourceState`. Each stub returns status `never_run`. The registry imports all seven by fixed file name so later tickets only edit their own file and never the registry.
   - `needsYou.ts` exports `computeNeedsYou(snapshot, now): NeedsYouItem[]` and `countNeedsYou(snapshot, now): number` (stubs). `ai/nextMoves.ts` exports `getNextMoves()`, `runNextMoves()`, `setMoveState(id, state)` (stubs). Signatures are fixed for T06 and T07.
   - Snapshot assembly keeps the last good data of a failing collector and marks it `error` with the message.
   - All six API routes from ARCHITECTURE exist and return contract-shaped data. `POST /api/checkin` validates with `checkinValidate.ts` (sleepHours 0 to 24, energy and mood integers 1 to 5, workoutMinutes 0 to 600, spendQar 0 to 1,000,000, note max 500 chars, date YYYY-MM-DD not in the future, defaults to today), upserts by date into `data/checkins.json`, returns 400 with a plain message on bad input.
   - Server binds `127.0.0.1:4317` only; serves `web/dist` in `start`; Vite dev server proxies `/api` to it.
   - Store writes atomically (tmp file then rename) and creates `data/` if missing.
   - Scheduler runs collectors on start and every 30 min, next-moves every 3 h, never two runs of the same job at once.
   - `.env.example` lists `JIRA_SITE=qicbizdev.atlassian.net`, `JIRA_EMAIL=`, `JIRA_API_TOKEN=`, `LEARNING_DIR=C:\Users\ialab\Desktop\MD Files\Learning`, `VAULT_DIR=C:\Users\ialab\Desktop\MD Files\Working-With-Claude`, `CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`).
   - `README.md`: how to install, run, add Jira credentials, log in to `claude`.
5. **Edge cases:** missing or corrupt JSON in `data/` (treat as empty, never crash); port in use (clear error); a collector that throws or hangs (60 s timeout, mark error).
6. **Tests required:** store atomic write and corrupt-file recovery; checkin validation (valid, each bad field, future date); snapshot assembly keeps last good data on error; routes via `app.request()` return 200 or 400 as specified.
7. **Security impact:** medium. Sets the localhost-only binding, input validation and secret loading every later ticket relies on. Never log env values.
8. **Risk level:** medium
9. **Recommended order:** batch 1
10. **Dependencies:** none

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; anything under `~/.claude`; git commits. (This ticket alone may run `npm install`.)
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
