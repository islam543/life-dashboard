# T04: Learning, check-ins, calendar and email collectors

1. **Goal:** Fill `server/collectors/learning.ts`, `checkins.ts`, `calendar.ts`, `email.ts` per ARCHITECTURE.
2. **Why it matters:** Learning streak and check-ins are two of the v1 life areas; honest not-connected states for calendar and email keep the screen truthful.
3. **Files likely changed (the only files this ticket may create or edit):** those four files, `server/collectors/learning.test.ts`, `server/collectors/checkins.test.ts`, `server/collectors/fixtures/learning/*.md`.
4. **Acceptance criteria:** learning parses `LEARNING_DIR/Daily.md`: the streak line (`**Current: N** · Best: M · Started: YYYY-MM-DD`), the `**Concept:**` line, and the checkbox steps under the `## Current cycle` heading (label = the bold step word, for example `READ`, done = `[x]`), plus checkbox lines from `LEARNING_DIR/Agenda/YYYY-MM.md` for the current month. Read the real files once to learn the shape; fixtures must paraphrase content and keep structure. Checkins returns the last 365 days sorted plus `checkedInToday`. Calendar and email return status `not_connected` with messages "Connect Google Calendar" and "Connect Gmail" and empty arrays.
5. **Edge cases:** files missing (not_connected naming the expected path), format drift (partial parse, status ok with what was found, no crash), emoji in headings, CRLF line endings.
6. **Tests required:** fixture parse; missing file; CRLF; checkins sorting and `checkedInToday`.
7. **Security impact:** low. Check-ins are personal and stay in `data/`.
8. **Risk level:** low
9. **Recommended order:** batch 2
10. **Dependencies:** T01

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; editing anything in `LEARNING_DIR`; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
