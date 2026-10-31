# T17: Server notes store in the vault

1. **Goal:** Implement `server/notes.ts` and `server/routes/notes.ts` per ARCHITECTURE v1.1: markdown files with frontmatter under `NOTES_DIR`, nested sections as folders, templates, trash instead of delete, recent notes for the snapshot.
2. **Why it matters:** Notes are Islam's meeting and personal records, stored where Obsidian reads them; a bug here can lose or overwrite real writing.
3. **Files likely changed (the only files this ticket may create or edit):** `server/notes.ts`, `server/notes.test.ts`, `server/notesFrontmatter.ts`, `server/notesFrontmatter.test.ts`, `server/routes/notes.ts`, `server/routes/notes.test.ts`.
4. **Acceptance criteria:** every notes route in the API table; frontmatter round-trips for dashboard-made notes; hand-made notes without frontmatter are read (title = first `# ` heading or filename) and only gain frontmatter when saved through the dashboard; templates: `meeting` body = `## Attendees`, `## Agenda`, `## Notes`, `## Decisions`, `## Action items` with one `- [ ] ` line, `personal` = `## Notes`, `blank` = empty; filenames `YYYY-MM-DD-<slug>.md` with `-2` suffix on clash; atomic writes (tmp then rename in the same folder); `updated` bumped on save; delete moves to `.trash/<original relative path>` with a timestamp suffix on clash; sections max depth 4; default sections `Meeting notes` and `Personal notes` created on first run; `recent(days, now)` newest first; mtime cache so an unchanged folder is not re-parsed; `openActions` counts unchecked `- [ ]` lines.
5. **Edge cases:** path traversal (`..`, absolute, `C:\`, encoded `%2e%2e`, backslashes, symlinks or junctions pointing outside: compare real paths and refuse), a note edited in Obsidian between read and save (write the full new body, never truncate), CRLF, BOM, files over 200 KB (refuse), a section name colliding with a file, Arabic titles in slugs (keep letters, fall back to `note`), `.trash` and `.obsidian` and other dot-folders never listed.
6. **Tests required:** a temp dir per test: CRUD, templates, frontmatter round-trip, hand-made note parsing, every traversal attempt rejected with 400, trash move, section create, rename and refuse-non-empty delete (409), recent ordering, openActions count. Never touch the real vault in tests.
7. **Security impact:** high. Filesystem writes inside the user's vault from an HTTP API: path confinement is the main control. Never delete files permanently.
8. **Risk level:** high
9. **Recommended order:** batch 6
10. **Dependencies:** T15

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md` (especially "v1.1: Project tracker and notes"), `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; writing anywhere in the real vault except through a manual smoke test that creates and then trashes one note; git commits; starting, stopping or restarting servers (a shared one runs on 127.0.0.1:4317 and http://localhost:5173 and reloads on save).
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
