# T06: Needs-you rule engine

1. **Goal:** Implement `server/needsYou.ts`: `computeNeedsYou(snapshot, now)` and `countNeedsYou(snapshot, now)` as pure functions covering every rule in the ARCHITECTURE table.
2. **Why it matters:** This is the "things I cannot miss" strip, the heart of the product.
3. **Files likely changed (the only files this ticket may create or edit):** `server/needsYou.ts`, `server/needsYou.test.ts`.
4. **Acceptance criteria:** all eight rules; stable ids (`jira:KEY`, `pr:repo#n`, `ci:repo`, `cal:id`, `checkin:YYYY-MM-DD`, `learning:YYYY-MM-DD`); red before amber, then by due time, then title; max 8 returned, `countNeedsYou` returns the full count. Workdays are Sunday to Thursday. All time logic uses the `now` argument, never `Date.now()`. Titles and details in plain language, for example "PR #42 waiting for your review" and "FastBind, opened 2 days ago".
5. **Edge cases:** sources not connected contribute nothing; failing checks and review request on the same PR merge into one item at the higher urgency; a due date without a time means end of that local day.
6. **Tests required:** one test per rule just inside and just outside each threshold; sort order; cap at 8 with full count; duplicate merge.
7. **Security impact:** none.
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
