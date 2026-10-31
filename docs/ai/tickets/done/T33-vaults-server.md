# T33: Server: multi-vault notes store and AI reading all vaults

1. **Goal:** Implement docs/ARCHITECTURE.md "v1.4" on the server:
   - one notes store over three vaults, with prefixed paths, read-only folders and per-vault trash
   - `NotesIndex.vaults`
   - `NoteMeta.vault` and `NoteMeta.readOnly`
   - `--add-dir` access for the AI runs
2. **Why it matters:** Islam wants his Learning and QIC Underwriting Agent vaults in the dashboard, notes filed where he chooses, and the AI drawing on all of them, while those vaults' own rules (raw/ and sources/ never edited) stay intact.
3. **Files likely changed:**
   - `server/config.ts`: the vault list, `QIC_UW_DIR`, read-only folder lists.
   - `server/notes.ts`, `server/notesFrontmatter.ts` (only if needed), `server/routes/notes.ts`, and their tests.
   - `server/snapshot.ts` and its test, where the notes slice needs the new fields.
   - `server/ai/nextMoves.ts`, `server/ai/taskSteps.ts`, `server/jira/draft.ts` and `server/routes/jira.ts`: `--add-dir`, read tools, prompt lines. Plus their tests.
   - Test fixtures across `server/**/*.test.ts` that build `NoteMeta` or `NotesIndex` (they now miss `vault` and `readOnly`).
4. **Acceptance criteria:**
   - **Contract:** the v1.4 types in shared/types.ts compile everywhere on the server. Do not change shared/types.ts. `npm run typecheck` currently fails in server files only.
   - **Vaults:**
     - Config builds the three vaults from the table in the architecture doc, with env overrides.
     - A missing folder is skipped and logged.
     - The default vault keeps today's paths and behaviour exactly; all existing notes tests still pass.
   - **Paths:**
     - A `@<id>/` prefix routes to that vault. An unknown prefix is 400.
     - Traversal, absolute paths and junctions or symlinks out of the vault are refused, each vault confined to its own real folder.
     - Section paths for other vaults start with the prefix. The top section of an extra vault has path `@<id>` and name = label.
   - **Listing:**
     - Dot folders, `Excalidraw/`, `*.excalidraw.md`, non-`.md` files and links are never listed.
     - `NoteMeta.vault` and `readOnly` are set on every note; `NoteSection.readOnly` on protected folders.
   - **Read-only:** create, update, rename, move and delete inside a read-only folder of a vault answer 403 "This folder is protected by the vault's rules". Reading works.
   - **Delete:** moves the note to that vault's `.trash`.
   - **Tasks:** stay in the default vault. The Tasks section logic is unchanged.
   - **Snapshot:** recent notes (last 14 days, max 30) include all vaults.
   - **AI runs:**
     - Next moves adds `--add-dir` for each extra vault, and its prompt names each vault and says it is read-only reference.
     - Task steps gains `--tools Read Glob Grep` plus `--add-dir` for every vault folder, keeping BLOCKED_TOOLS, `--strict-mcp-config` and project-only settings. Its prompt says the AI may look up related notes. The validation rules are unchanged.
     - Jira draft adds Read, Glob and Grep to its allowed set plus `--add-dir` for every vault, keeping the search tool. Create is unchanged.
     - Args-builder tests assert all of this.
   - **Performance:** indexing all vaults (about 1,500 notes) stays under 2 s cold and under 200 ms warm (mtime cache). Measure it with a temp fixture of about 1,500 small files and report the numbers.
5. **Edge cases:**
   - A folder name containing `@`.
   - A note in Learning whose name collides with a default-vault note.
   - Arabic file names.
   - A huge note (cap the excerpt as today).
   - A vault folder deleted while running.
   - Write-back of a Jira key into a read-only note: fails with the message, and the keys are still returned (check `server/jira/writeBack.ts` uses the store, so the 403 surfaces).
6. **Tests required:**
   - path parsing per vault
   - confinement per vault (traversal, prefix crossing)
   - listing filters
   - read-only refusals for each write operation
   - per-vault trash
   - the index across vaults
   - the default vault unchanged (the existing suite)
   - snapshot recent notes across vaults
   - args builders for next moves, steps and the Jira draft
   - index timing on a 1,500-file temp fixture
7. **Security impact:**
   - File access widens to two more folders, read and write, guarded per vault by real-path confinement and the read-only rules.
   - The AI gets read-only access to those folders and nothing more.
8. **Risk level:** high (file system writes in new places)
9. **Recommended order:** batch 12
10. **Dependencies:** v1.3 (done).

**Read first:**
- `docs/ARCHITECTURE.md` sections "v1.1" (notes), "v1.2", "v1.3" and "v1.4"
- the v1.4 block of `shared/types.ts`
- `server/notes.ts` (its safety comments)
- this ticket

**Forbidden:**
- files not listed
- `shared/types.ts`
- web files
- npm dependencies
- creating, editing, moving or deleting anything in the real vaults under `C:\Users\ialab\Desktop\MD Files` (tests use temp dirs only; reading the real folders to measure counts is fine)
- running the real `claude` CLI in tests
- reading `.env`
- writing through the live dashboard on port 4317
- git commits
- em-dashes

**Report back (under 200 words):** what changed, files, exact check commands with pass/fail counts, timings, open issues.

## Definition of Done
- [x] Acceptance criteria met
- [x] Tests listed in item 6 exist and pass
- [x] `npx vitest run` and `npm run typecheck` pass
- [x] No em-dash characters in any file touched
- [x] Report sent
