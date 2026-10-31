# T14: Integration run, review and fixes

1. **Goal:** Run the whole app with real data, check it in the browser at desktop and phone widths, get independent frontend and security reviews, and fix what they find.
2. **Why it matters:** Batch tickets were built against the contract in isolation; this is where they meet real data.
3. **Files likely changed:** any, scoped to fixes the reviews confirm.
4. **Acceptance criteria:** `npm test`, `npm run typecheck`, `npm run build` pass; `npm run collect` produces a snapshot with github, claudeSessions, learning, checkins `ok` and jira, calendar, email `not_connected` (until Islam adds credentials); home, every detail view, life map and check-in work in the browser at 1440 px and 375 px with no console errors; frontend-reviewer and security-reviewer findings either fixed or listed as open.
5. **Edge cases:** first run with empty `data/`; server restarted mid-run.
6. **Tests required:** existing suites; add regression tests for any bug fixed.
7. **Security impact:** medium. Confirms the localhost binding and token handling.
8. **Risk level:** medium
9. **Recommended order:** batch 4
10. **Dependencies:** T01 to T13

Owner: main session (supervisor).

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Reviews done and findings handled
- [ ] No em-dash characters in any file touched
