# T19: Notes view

1. **Goal:** Fill `web/src/views/Notes.tsx`: sections and subsections tree, note list, markdown editor with preview, templates, project link.
2. **Why it matters:** Meeting and personal notes live here and in Obsidian; writing must feel fast and never lose text.
3. **Files likely changed (the only files this ticket may create or edit):** `web/src/views/Notes.tsx`, `web/src/views/Notes.module.css`, `web/src/notes/*` (new components and their css), `web/src/lib/notes.ts`, `web/src/lib/notes.test.ts`.
4. **Acceptance criteria:**
   - Three panes on desktop (sections tree, notes list, editor), stacked with back navigation on phone.
   - Tree: nested sections with counts, expand and collapse, create a subsection inline, rename, delete only when empty (disabled with the reason otherwise). Keyboard: arrows move, Enter opens, F2 renames.
   - List: newest first; title, date, linked project chip, open action count, excerpt.
   - New note: choose template (Meeting, Personal, Blank), Meeting by default inside sections under `Meeting notes`; title field focused.
   - Editor: title, project select (from `/api/projects`, plus none), tags, markdown textarea with Write and Preview tabs (preview with `react-markdown` + `remark-gfm`, no raw HTML, links open in a new tab with `rel="noopener noreferrer"`, task checkboxes in preview toggle the matching `- [ ]` line). Autosave 800 ms after typing stops, plus on blur and Ctrl+S, with a visible Saving or Saved state; leaving a note with unsaved changes warns. Delete asks for confirmation and says the file moves to `.trash` in the vault.
   - Shows the notes folder location as plain text so Islam can find the files in Obsidian.
   - Deep link `#/notes/<path>` opens that note.
   - States via `Panel`; tokens only; motion per the vault rules; works at 1440 and 375 px.
5. **Edge cases:** a note changed in Obsidian while open (refetch on window focus; if the server copy is newer and the editor is dirty, offer keep mine or load theirs), 200 notes in a section, an empty section, a very long note, Arabic text (`dir="auto"`), save failing (keep the text, show retry).
6. **Tests required:** `lib/notes.ts`: tree helpers, sort, template choice, task-line toggling in markdown, dirty-state logic.
7. **Security impact:** medium. The preview must not render raw HTML; paths are sent only as the server gave them.
8. **Risk level:** medium
9. **Recommended order:** batch 6. The server notes routes land in parallel; same approach as T18.
10. **Dependencies:** T15

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md` (especially "v1.1: Project tracker and notes" and "Visual direction"), `docs/WORKFLOW.md`, this ticket, the T08 primitives in `web/src/ui`, and vault pages `ux/forms-and-validation.md`, `ux/keyboard-and-focus-patterns.md`, `ux/error-empty-loading-states.md` in `C:\Users\ialab\Desktop\MD Files\Working-With-Claude`.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits; starting, stopping or restarting servers (a shared one runs on 127.0.0.1:4317 and http://localhost:5173 and reloads on save). While testing, create at most one real note and delete it (it goes to `.trash`).
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), what you verified in the browser, needed changes outside your scope.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
