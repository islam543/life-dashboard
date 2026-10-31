# T07: AI next-moves runner

1. **Goal:** Implement `server/ai/nextMoves.ts` (keeping the T01 export signatures) per ARCHITECTURE "AI next moves": build the prompt, run `claude -p` with `spawn` and argument arrays, validate output, persist `data/next-moves.json`, handle done and dismiss.
2. **Why it matters:** Turns a pile of signals into "do this next, because", including QIC process steps from the vault.
3. **Files likely changed (the only files this ticket may create or edit):** `server/ai/nextMoves.ts`, `server/ai/prompt.ts`, `server/ai/validate.ts`, `server/ai/nextMoves.test.ts`.
4. **Acceptance criteria:** the prompt carries a trimmed snapshot (titles, keys, due dates, statuses, needs-you items, learning step, today's check-in numbers; no message bodies, no env values), tells Claude to read `qic-engineering/index.md` in the vault when a QIC ticket is near release or UAT, and asks for strict JSON only. Runs `claude -p <prompt> --output-format json --model sonnet` with cwd `VAULT_DIR`, 5 min timeout, reads the `result` field of the JSON envelope. The guard rejects anything not matching `NextMove[]` minus `state`; on rejection keep previous moves and set status error. Auth failure output ("Failed to authenticate", "OAuth") maps to `not_logged_in` with message "Run claude in a terminal and log in" (this is the current state of this PC). Status `running` while in progress; a second request while running is ignored. Done and dismissed persist by id; titles dismissed in the last 7 days are filtered from new runs. The process runner is injectable for tests.
5. **Edge cases:** `claude` not on PATH (error, clear message); prose around the JSON (extract the first JSON array); 0 moves; more than 6 (keep top 6 by rank); timeout kill.
6. **Tests required:** with an injected fake runner: success, auth failure, bad JSON, timeout, prose-wrapped JSON, dismissed filtering, concurrent run guard.
7. **Security impact:** medium. Sends work item titles to Claude (same channel as normal Claude Code use). Must never include env values or the Jira token. No shell, so no interpolation of prompt text.
8. **Risk level:** medium
9. **Recommended order:** batch 2
10. **Dependencies:** T01

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; actually running `claude -p` in tests; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
