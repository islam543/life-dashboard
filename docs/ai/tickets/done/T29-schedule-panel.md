# T29: Home Schedule panel: meetings, tasks, add task, AI plan review

1. **Goal:** A Schedule panel on Home directly under Next moves that:
   - shows today or this week: meetings from the calendar plus task notes
   - lets Islam add tasks and tick them done
   - offers an AI "Plan my day / week" proposal that Islam accepts item by item
2. **Why it matters:** One place to see the day's meetings and work, and let AI fit tasks into free time.
3. **Files likely changed:**
   - new `web/src/panels/SchedulePanel.tsx` and `.module.css`
   - new `web/src/api/schedule.ts`
   - new `web/src/lib/schedule.ts` (pure helpers: day columns, time layout, free gaps) and its test
   - `web/src/views/Home.tsx` and `Home.module.css` (add the cell under Next moves at every size)
4. **Acceptance criteria:**
   - **Day view:** a vertical timeline from 08:00 to 18:00, extending to the earliest or latest item.
     - Meetings are blocks with time and title, linking to Google Calendar when they have a url.
     - Tasks with a start time are blocks; tasks without one are listed under the timeline.
     - A "now" line.
   - **Week view:** seven day columns from today, each with meetings and tasks as compact rows.
   - The Day/Week toggle is remembered, and arrows move between days or weeks within 14 days.
   - **Add task:** an inline form with title (required), project (picker from projects), day, start and length (15/30/45/60/90/120). It POSTs, and the task appears at once.
   - **Task rows:** a checkbox marks a task done (PATCH). Clicking a task opens its note (`#/notes/<path>`).
   - **Not placed:** overdue and unscheduled open tasks appear in a small strip with a quick "Today" button that sets the due date.
   - **AI plan:**
     - "Plan my day" (day view) or "Plan my week" (week view) calls POST plan, with a running state of about 30 to 60 s.
     - The proposal shows as ghost blocks in the timeline, plus a list with checkboxes and each item's reason.
     - Accept selected, Accept all, and Dismiss. Accepted items become real tasks.
   - **Ultrawide (2560x940):**
     - Home still has no page scroll.
     - The left column stacks Needs you, Next moves and Schedule, and each scrolls inside itself.
     - Tune the split and say why.
   - **Smaller widths:** Schedule comes directly after Next moves.
   - **Help and menus:** hover tips on every control, and right-click menus (Add task, Plan my day/week, Today, Mark done, Open note), using the existing patterns (`tip`, `useMenuRegion`).
   - **States:** loading, empty ("Nothing scheduled. Add a task or let AI plan your day."), error, and calendar not connected.
5. **Edge cases:**
   - an all-day event
   - overlapping meetings (side by side)
   - a task with no start time
   - a past day
   - a plan item that collides with a meeting (show it anyway)
   - the API returning 501 before T27 lands: show "Schedule server not ready", never crash
6. **Tests required:**
   - pure helpers for the timeline layout: overlap lanes, minutes to pixels, free gaps
   - week column building
   - tests for any other new logic
7. **Security impact:** none. Renders text only, and links only https urls from the server.
8. **Risk level:** medium
9. **Recommended order:** batch 10
10. **Dependencies:** contract (done). Code against the API table; T27 lands in parallel.

**Read first:**
- `docs/ARCHITECTURE.md` section "v1.2" (decisions, contract, API)
- `shared/types.ts` (v1.2 block, do not change it)
- `docs/WORKFLOW.md`
- this ticket
- existing panels (`web/src/panels/NextMovesPanel.tsx`, `ProjectTimeBars.tsx`) for patterns

**Forbidden:**
- files not listed in item 3
- `shared/types.ts`
- any server file
- npm dependencies
- writing real data through the live dashboard on port 4317
- git commits
- em-dashes

**Visual check port:** 5174.

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met (checked against a mocked API on port 5174; the live T27 server is still pending)
- [x] Tests listed in item 6 exist and pass (`web/src/lib/schedule.test.ts`, 32 tests)
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
