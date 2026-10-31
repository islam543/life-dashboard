# T31: Server: plan placement fix and the Do now API

1. **Goal:** Implement docs/ARCHITECTURE.md "v1.3" on the server:
   - `PlanRequest` with the viewed date
   - placing existing tasks (`taskPath`)
   - a start time on every plan item, through a pure placer
   - `SchedulePlan.from`
   - accept that PATCHes existing tasks
   - the `/api/focus` routes with cached AI step summaries
2. **Why it matters:**
   - Islam accepted a plan and did not see it on the timeline: the plan targeted Sunday while the panel showed Saturday, and it never timed his own tasks.
   - Do now replaces the 30-day panel with what to do now and how.
3. **Files likely changed:**
   - `server/ai/schedulePlan.ts` and its test
   - `server/routes/schedule.ts` and its test
   - `server/schedule.ts` and its test (only if needed)
   - new `server/schedulePlacer.ts` (pure) and test
   - new `server/focus.ts` (pick items, labels), new `server/ai/taskSteps.ts` (prompt, run, validate, cache), new `server/routes/focus.ts`, and tests
   - `server/app.ts` (mount `/api/focus` next to `/api/schedule`, one line)
4. **Acceptance criteria:**
   - **Contract:** the v1.3 types in shared/types.ts compile everywhere on the server. Do not change shared/types.ts.
   - **Plan request:**
     - POST plan takes `{ scope, date }` with the date validated. A missing date means today, for backward compatibility.
     - Day plans that date; week plans 7 days from it. Weekends are allowed.
     - For today, nothing starts before now (rounded up to 15 min). Window 07:00 to 22:00.
     - The prompt keeps work tasks inside 08:00 to 18:00 on Sunday to Thursday.
   - **Existing tasks:**
     - The prompt lists open tasks without a start, without a due date, or overdue, each with its path.
     - The model may return `taskPath` for those only; any other path is dropped.
     - Accept PATCHes due, start and minutes on them; `taskPath: null` creates a new note as before.
   - **Placer:** pure, given a day's meetings and timed tasks (busy blocks), the window, and items.
     - Keeps an item's start if it fits and has no overlap.
     - Otherwise moves it to the first free gap of that day that fits, then later days in scope.
     - Drops an item that fits nowhere and counts it in `message`.
     - Minutes default to 30 when missing.
   - **Plan output:** `SchedulePlan.from` is set, and every item has a start and minutes.
   - **Focus selection** (`server/focus.ts`, pure):
     - Order: now, next (timed later today), overdue (oldest first), today without a time. At most 6 items.
     - Labels exactly as in the architecture doc.
     - projectName comes from the registry; jiraKey is the first `AN-\d+` in the title or body.
   - **Task steps:**
     - The run uses `claude -p` with `--tools ""`, `--strict-mcp-config`, `--setting-sources project`, BLOCKED_TOOLS, JSON output and sonnet, in an empty `data/steps-run`, with `childEnv()`.
     - The prompt holds, per task: title, body (capped), project name, description and goals, the project's open tasks, and the Jira summary and status from the connector cache if jiraKey matches. All text is untrusted.
     - It returns 3 to 7 imperative steps per task, each 5 to 160 characters, with no markdown or URLs.
     - Batched: one run for up to 3 tasks.
     - Cached in `data/taskSteps.json`, keyed by path and `updated`.
   - **Focus routes:**
     - GET `/api/focus` never waits for AI. It returns cached steps or `pending`, and starts one background batch for the top 3 that are missing (single-flight).
     - POST `/api/focus/steps` `{ path, force? }` runs for that task and returns the FocusItem: 404 for an unknown path, 409 while a run is going.
5. **Edge cases:**
   - no tasks
   - a task with no body
   - a task whose note changed (cache miss)
   - a run that fails (stepsStatus error with message, others unaffected)
   - midnight rollover
   - a plan when the day is fully booked (items dropped, message)
   - an existing task path that no longer exists at accept (skip with message)
6. **Tests required:**
   - the placer: fits, overlap moved, next-day spill, drop
   - plan validation with taskPath allowed and not allowed
   - accept PATCH versus create
   - plan date and window rules, including today after now and a weekend
   - focus selection order and labels
   - steps prompt, validation (junk, hostile, markdown and URLs stripped or rejected), cache key and invalidation
   - routes with fake runners
7. **Security impact:**
   - Both AI runs have no tools.
   - Note, project and Jira text is untrusted, and the output is validated.
   - No outside writes.
8. **Risk level:** medium
9. **Recommended order:** batch 11
10. **Dependencies:** v1.2 (done).

**Read first:** `docs/ARCHITECTURE.md` sections "v1.2" and "v1.3", the v1.2 and v1.3 blocks of `shared/types.ts` (do not change them), this ticket.

**Forbidden:**
- files not listed
- `shared/types.ts`
- web files
- npm dependencies
- running the real `claude` CLI in tests
- reading `.env`
- writing through the live dashboard on port 4317
- git commits
- em-dashes

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
