# T02: GitHub collector

1. **Goal:** Fill `server/collectors/github.ts` to produce `prs`, `ci` and `repoActivity` per ARCHITECTURE "Collector details", using the `gh` CLI (already logged in as `islam543`).
2. **Why it matters:** PRs waiting on Islam and failing builds are top needs-you signals; commit activity feeds the heatmap and life map.
3. **Files likely changed (the only files this ticket may create or edit):** `server/collectors/github.ts`, `server/collectors/github.test.ts`, `server/collectors/fixtures/github/*.json`.
4. **Acceptance criteria:** authored and review-requested open PRs with role, draft flag and checks rollup (pass, fail, pending, none); latest default-branch run per repo pushed in the last 30 days; commits per day for the last 365 days for repos pushed in the last year (owned and org repos visible to the user). `execFile` with argument arrays only. Results cached 30 min. One pure exported parse function per `gh` output, used by the tests.
5. **Edge cases:** `gh` missing or logged out (status error, message "Run gh auth login"); rate limit (keep last data, error message); repos with no Actions; stats endpoint returning 202 while computing (skip that repo this round); 0 PRs.
6. **Tests required:** parsers against fixture JSON for PRs, runs and activity; logged-out stderr maps to the right status. No network in tests.
7. **Security impact:** low. Read-only `gh` calls; this code never reads or logs a token.
8. **Risk level:** low
9. **Recommended order:** batch 2
10. **Dependencies:** T01

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket.
**Forbidden:** any file not listed in item 3; changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` passes
- [ ] No em-dash characters in any file touched
- [ ] Report sent
