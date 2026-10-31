# T32: Web: plan placement in the Schedule panel and the Do now panel

1. **Goal:**
   - The Schedule panel plans the day it shows and shows accepted items on the timeline.
   - A Do now panel replaces "Time by project, last 30 days" in the bottom right of Home.
2. **Why it matters:**
   - Islam accepted a plan and did not see it on the timeline.
   - He wants the bottom right to say what to do now and how, step by step.
3. **Files likely changed:**
   - `web/src/panels/SchedulePanel.tsx` and `.module.css`
   - `web/src/api/schedule.ts`
   - `web/src/lib/schedule.ts` and its test
   - new `web/src/panels/DoNowPanel.tsx` and `.module.css`
   - new `web/src/api/focus.ts`
   - new `web/src/lib/focus.ts` (pure helpers) and its test
   - `web/src/views/Home.tsx` and `Home.module.css`
   - `web/src/panels/ProjectTimeBars.tsx`, only to drop the now-unused `fixedRange` use if it becomes dead code (keep the "last30" range in `lib/timeAgg.ts`, it has tests)
4. **Acceptance criteria:**
   - **Plan request:** "Plan my day" sends `{ scope: "day", date: <the date the panel shows> }`; "Plan my week" sends `{ scope: "week", date }`.
   - **Plan label:** the plan header reads "AI plan for <weekday day month>" from `plan.from`, with "today" or "tomorrow" when it applies. It never says "today" for another day.
   - **Ghost blocks:** shown on the timeline for the matching date only, in day and week view. Items with `taskPath` read "Move: <title>" and show the task's current slot faded, if any.
   - **After Accept:** the panel switches to Day view on `plan.from`, reloads, and briefly highlights the new and moved blocks (once, under 1 s, none with reduced motion).
   - **Do now panel:** in the bottom-right cell where the 30-day panel was, at every breakpoint; the cell keeps its grid name or gets a new one.
     - It lists FocusItems from GET `/api/focus`.
     - The first item is expanded: title (opens the note), project chip, Jira key chip (link to qicbizdev, `AN-\d+` only), label ("Now until 15:30"), the steps as a numbered list, and buttons: Mark done (PATCH task done, then reload), Regenerate steps (POST force), Open note.
     - The other items are collapsed rows (title, label, project) and expand on click; only one is expanded at a time.
     - `stepsStatus` pending shows a skeleton plus "Writing steps..." and polls GET every 5 s, up to 2 min.
     - error shows the message and a Try again button.
     - Empty: "Nothing due right now." with buttons Plan my day (scrolls to Schedule and starts the plan) and Add task.
   - **Ultrawide (2560x940):** no page scroll. Time by project on top and Do now under it share the right column; Do now gets the larger share (about 60%) and scrolls inside. Below 1920 it sits where the 30-day panel was.
   - Hover tips on every control and right-click menus (Mark done, Regenerate steps, Open note, Open in Jira), using the existing patterns.
   - Handle 501 or 404 from `/api/focus` (server not ready) without crashing.
5. **Edge cases:** no tasks; 6 items; very long steps; an item disappearing after Mark done; the plan for a date outside the 14-day arrows; reduced motion.
6. **Tests required:** pure helpers for plan label text, ghost block filtering by date, the post-accept target date, focus item ordering and display text; existing tests pass.
7. **Security impact:** none. Text only; links only for `AN-\d+` keys on the configured site.
8. **Risk level:** medium
9. **Recommended order:** batch 11
10. **Dependencies:** v1.3 contract (done). Code against it; T31 lands in parallel.

**Read first:**
- `docs/ARCHITECTURE.md` sections "v1.2" and "v1.3"
- the v1.2 and v1.3 blocks of `shared/types.ts` (do not change them)
- this ticket
- `web/src/panels/SchedulePanel.tsx`
- `web/src/panels/ProjectTimeBars.tsx`

**Forbidden:**
- files not listed
- `shared/types.ts`
- server files
- npm dependencies
- writing real data through the live dashboard on port 4317 (use a mocked API on port 5174 for checks, and stop it after)
- git commits
- em-dashes

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
