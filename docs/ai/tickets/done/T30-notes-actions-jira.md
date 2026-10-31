# T30: Notes: task bar, detected actions, Jira review dialog

1. **Goal:**
   - Task notes get a task bar in the editor.
   - Every note's preview gets a "Detected actions" section under it, with a button that drafts Jira issues with AI.
   - A review dialog lets Islam edit the drafts and create them.
2. **Why it matters:** Meeting notes become Jira tasks under the right epic in one reviewed step.
3. **Files likely changed:**
   - in `web/src/notes/*`: new `TaskBar.tsx`, `ActionsSection.tsx` and `JiraReviewDialog.tsx` with their CSS; edits to `NoteEditor.tsx` and to where `MarkdownPreview` is placed
   - new `web/src/api/jira.ts`
   - new `web/src/lib/jiraDraft.ts` (pure helpers: grouping tasks under epics, validation that mirrors the server) and its test
   - `web/src/views/Notes.tsx`, if needed
4. **Acceptance criteria:**
   - **Task bar:** a note in the Tasks section shows due date, start time, length and a done checkbox above the editor.
     - Changes PATCH `/api/schedule/tasks?path=...` and refresh the note.
     - Other notes show no bar.
   - **Detected actions:** a section below the preview lists the actions from GET `/api/jira/actions`.
     - Each action shows its text, done state, and a Jira key chip (a link) if already filed.
     - The count shows in the section header.
     - The list refreshes after a save.
   - **"Draft Jira tasks with AI":** enabled when at least one action is unfiled and not done. It shows a running state of about 20 to 60 s.
   - **Review dialog** (a native dialog, like the others):
     - Drafted Tasks are grouped under their epic: an existing epic with its key and a link, or "New epic: title", which is editable.
     - Each Task has an include checkbox, an editable summary and description, the actions it covers, and an epic picker (existing epics from the draft, new epics in the draft, or none).
     - Removing all Tasks from a new epic drops that epic.
     - The footer reads "Creates N tasks and M epics in AN, assigned to you".
     - Create POSTs `/api/jira/create` with the edited issues.
     - The result list shows keys with links and failures with reasons, and the note reloads to show the written-back keys.
   - **Help and menus:** tips and right-click menus on the new controls, using the existing patterns.
5. **Edge cases:**
   - no actions
   - every action already filed (button disabled, with the reason)
   - 503 not signed in (show the sign-in message)
   - 409 already running
   - partial failure
   - write-back conflict: show "Created in Jira, but the note changed; add the keys by hand: ..."
   - dialog closed mid-run
   - the API returning 501 before T28 lands: the section says "Jira drafts not ready", and nothing crashes
6. **Tests required:**
   - pure helpers: epic grouping, dropping empty new epics, the payload sent to create, the counts text
   - the existing notes tests still pass
7. **Security impact:** untrusted note text renders as text only. Links appear only for keys matching `^AN-\d+$` on the configured site.
8. **Risk level:** medium
9. **Recommended order:** batch 10
10. **Dependencies:** contract (done). Code against the API table; T28 lands in parallel.

**Read first:** `docs/ARCHITECTURE.md` section "v1.2" (decisions, contract, API), `shared/types.ts` (v1.2 block, do not change it), this ticket.

**Forbidden:**
- files not listed in item 3
- `shared/types.ts`
- any server file
- npm dependencies
- writing real data or creating Jira issues through the live dashboard on port 4317
- git commits
- em-dashes

**Visual check port:** 5176. Mock the API in the browser for checks.

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
