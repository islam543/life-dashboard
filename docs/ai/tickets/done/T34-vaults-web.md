# T34: Web: vaults in the Notes tree, choosing where a note goes, read-only notes

1. **Goal:** Implement docs/ARCHITECTURE.md "v1.4" in the Notes view:
   - the tree grouped by vault
   - the New note dialog lets Islam choose the vault and folder, or a new folder
   - read-only notes and folders are shown and handled as read-only
2. **Why it matters:** Islam's Learning (about 1,300 notes) and QIC Underwriting Agent (about 200 notes) vaults join the dashboard, and he picks where each note is filed.
3. **Files likely changed:**
   - `web/src/notes/*`: SectionTree, NoteList, NewNoteDialog, NoteEditor, plus any new picker component and its CSS.
   - `web/src/lib/notes.ts` and its test: pure helpers for path prefixes, grouping by vault, folder options, read-only checks.
   - `web/src/views/Notes.tsx` and `Notes.module.css`.
   - `web/src/api/notes.ts`, only if a type or call changes.
4. **Acceptance criteria:**
   - **Contract:** code against the v1.4 types in shared/types.ts. Do not change that file.
   - **Tree:**
     - One collapsible group per vault, in `NotesIndex.vaults` order, each with its label, note count, and a "Copy folder path" or "Open in Obsidian" hint (the absolute `dir`).
     - Under each group, that vault's folder tree. The default vault keeps today's sections, including Tasks.
     - Big vaults start collapsed below the first level, and the open or closed state is kept per folder in this browser.
     - Protected folders show a lock icon with a tip: "Protected by this vault's rules: read only".
   - **List:**
     - Selecting a folder lists its notes. Selecting a vault lists that vault's notes, newest first.
     - It stays responsive with 1,300 notes: render progressively or window it, so no visible jank.
     - A small filter box on the list filters by title as you type. Client-side is fine.
   - **New note:**
     - The dialog has a Vault picker (default: the vault of the selected folder, else Working-With-Claude) and a Folder picker. The folder picker is a searchable list of that vault's folders, excluding protected ones and with the full path shown, plus "New folder..." to create a subfolder by name.
     - Templates and project link work as before.
     - The note is created at the chosen place and opens.
     - Right-click "New note here" on a folder preselects it (existing menu, extend it).
   - **Read-only notes:**
     - The editor shows the preview only, with a "Read only: protected by the vault's rules" bar.
     - No rename, delete, task bar, or editing.
     - Detected actions and "Draft Jira tasks with AI" still work. If the server reports the write-back refused, show that the keys were created but not written into the note.
   - **Projects:** linking a note to a project works for any vault (it is a frontmatter edit, so not on read-only notes).
   - **Navigation:** URLs `#/notes/@learning/wiki/...` open the right note. Old URLs without a prefix still work.
   - **Help and menus:** tips and right-click menus on every new control, using the existing patterns. Ultrawide layout unchanged (four panes), with no page scroll.
5. **Edge cases:**
   - A vault missing from the index (folder gone).
   - A note path with Arabic or spaces.
   - Selecting a protected folder, then New note (defaults to a writable parent or the vault root).
   - An empty vault.
   - The server answering 403 on save (show the message, keep the text).
   - A 501 or unknown `vaults` field from an older server (fall back to today's single tree).
6. **Tests required:**
   - pure helpers: prefix parsing, grouping by vault, folder options excluding read-only, default destination choice, filter
   - the existing notes tests pass
7. **Security impact:** none on the client. Read-only is enforced by the server; the UI only mirrors it.
8. **Risk level:** medium
9. **Recommended order:** batch 12
10. **Dependencies:** v1.4 contract (done). Code against it; T33 lands in parallel.

**Read first:** `docs/ARCHITECTURE.md` sections "v1.1" (notes) and "v1.4", the v1.4 block of `shared/types.ts`, this ticket, the existing `web/src/notes/*`.

**Forbidden:**
- files not listed
- `shared/types.ts`
- server files
- npm dependencies
- creating, editing or deleting real notes through the live dashboard on port 4317 (use a mocked API on port 5176 for checks, and stop it after)
- git commits
- em-dashes

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
