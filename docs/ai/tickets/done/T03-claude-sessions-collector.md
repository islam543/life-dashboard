# T03: Claude sessions time collector

1. **Goal:** Fill `server/collectors/claudeSessions.ts`: active minutes per project per local day from `~/.claude/projects/*/*.jsonl`, per ARCHITECTURE.
2. **Why it matters:** The only automatic record of where Islam's working time goes; it drives project-time bars, the heatmap and the life map.
3. **Files likely changed (the only files this ticket may create or edit):** `server/collectors/claudeSessions.ts`, `server/collectors/claudeSessions.test.ts`, `server/collectors/fixtures/claude/**`.
4. **Acceptance criteria:** display names from folder names (`C--Users-ialab-Documents-GitHub-QIC-QIC-FastBind` becomes `QIC-FastBind`; `C--Users-ialab-Desktop-Trading-research` becomes `Trading-research`; `C--Users-ialab` becomes `Home`); `--claude-worktrees-*` folders folded into the parent; folders containing `AppData-Local-Temp` or `AppData-Roaming-Claude-scratch` skipped; lines streamed with `readline`, only `timestamp` read; gaps under 15 min summed; last 365 days; system local timezone. Cache per file by mtime so unchanged files are not reread. Read-only: never copy message content anywhere.
5. **Edge cases:** malformed lines, lines without timestamp, very large files (over 100 MB), a session crossing midnight (split minutes across days), empty folders, the same project name from two folders (merge).
6. **Tests required:** name mapping table; gap summing; midnight split; malformed lines ignored; worktree folding.
7. **Security impact:** low. Reads timestamps only.
8. **Risk level:** low
9. **Recommended order:** batch 2
10. **Dependencies:** T01

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; writing anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
