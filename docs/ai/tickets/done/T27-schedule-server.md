# T27: Schedule server: task notes, schedule range, AI day/week plan

1. **Goal:** Serve the Schedule API in docs/ARCHITECTURE.md "v1.2": task notes in the Tasks section, meetings plus tasks per day, and an AI plan Islam accepts.
2. **Why it matters:** Home's new Schedule panel (T29) and the Notes task bar (T30) read and write through it.
3. **Files likely changed:**
   - `server/routes/schedule.ts`: replace the stub, keep the export and deps.
   - new `server/schedule.ts`: range building, task create and patch.
   - new `server/ai/schedulePlan.ts`: prompt, run, validate, store.
   - `server/notes.ts` and `server/notesFrontmatter.ts`: the task_* fields, read into TaskNote and written on create and patch. Unknown keys stay verbatim, as today.
   - `server/connectors/run.ts`: calendar window to 7 days, max 60 events; plus its test.
   - `server/config.ts`, only if a constant is needed.
   - tests next to each file.
4. **Acceptance criteria:**
   - Every route in the Schedule API table works with the shapes in shared/types.ts.
     - Bad input gets 400 with `ApiError`.
     - `from`/`to` spanning more than 14 days, or in the wrong order, is 400.
   - **Creating a task** makes `notes/Tasks/<slug>.md`:
     - The Tasks section is created on first use, and the slug is unique.
     - It sets `task_source: me`.
     - The note shows in /api/notes like any other and links its project.
   - **PATCH** changes only the given fields. `done` toggles `task_done`; a title change updates the first heading.
   - **ScheduleRange:**
     - Each day lists the calendar events starting that day (local time), and the tasks due that day sorted by start time, with no-start tasks last.
     - `unscheduled` = open tasks with no due date.
     - `overdue` = open tasks due before `from`.
     - `calendar` mirrors the calendar source status.
   - **Plan run:**
     - Runs `claude -p` with `--tools ""`, `--strict-mcp-config`, `--setting-sources project`, the BLOCKED_TOOLS list, `--output-format json` and the sonnet model.
     - cwd is an empty `data/schedule-run`; env is `childEnv()`.
     - The prompt holds the meetings, open tasks, project deadlines and current Next moves for the scope. It asks for 3 to 10 PlanItems placed in free time between meetings, 08:00 to 18:00 Asia/Qatar, Sunday to Thursday workdays.
     - Output is validated: dates within the scope, HH:MM times, minutes 10 to 240, projectId must exist or be null, text capped.
     - Saved to `data/schedulePlan.json`. One run at a time.
   - **Accept** creates task notes for the chosen ids (`task_source: ai`) and removes them from the plan. **Dismiss** clears it.
   - **Connector calendar window:** now to the end of day 7 in Asia/Qatar, max 60 events. Update the T26 tests.
5. **Edge cases:**
   - No calendar connector: calendar status is not_connected, and tasks still work.
   - A task note edited in Obsidian with bad task_* values: treat them as unset, never crash.
   - Two tasks with the same title.
   - The plan run fails or returns junk: status error with a message, and existing tasks untouched.
   - Time zones around midnight.
6. **Tests required:**
   - frontmatter task fields round-trip
   - range building with events, tasks, unscheduled and overdue
   - create and patch through the route, with a temp notes dir
   - the plan args builder
   - the prompt contains the meetings
   - the validator with good, junk and hostile input
   - accept and dismiss
   - the 7-day calendar window
7. **Security impact:** The plan run has no tools, meeting titles are treated as untrusted text in the prompt, and the output is validated.
8. **Risk level:** medium
9. **Recommended order:** batch 10
10. **Dependencies:** supervisor contract (done).

**Read first:** `docs/ARCHITECTURE.md` section "v1.2" (decisions, contract, API, safety rules), `shared/types.ts` (v1.2 block, do not change it), this ticket.
**Forbidden:**
- files not listed in item 3
- `shared/types.ts`, `server/app.ts`
- npm dependencies
- running the real `claude` CLI in tests
- reading `.env`
- restarting or writing through the live dashboard on port 4317 (real notes and Jira)
- git commits
- em-dashes

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass (vitest 52 files, 1099 tests pass; typecheck clean for T27 files and web, the only errors are in T28's in-progress `server/routes/jira.test.ts`)
- [x] No em-dash characters in any file touched
- [x] Report sent
