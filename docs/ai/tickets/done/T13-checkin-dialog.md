# T13: Daily check-in dialog

1. **Goal:** Fill `web/src/checkin/CheckinDialog.tsx`: the 30-second evening check-in opened from the header and the personal detail via `CheckinContext`.
2. **Why it matters:** It is the only source for sleep, energy, mood, workouts and spending, so it has to be fast enough to do every day.
3. **Files likely changed (the only files this ticket may create or edit):** `web/src/checkin/CheckinDialog.tsx`, `web/src/checkin/CheckinDialog.module.css`, `web/src/checkin/checkinForm.ts`, `web/src/checkin/checkinForm.test.ts`.
4. **Acceptance criteria:**
   - Native `<dialog>` (or equivalent with focus trap), title "Today's check-in", date shown and changeable to a past day (not future).
   - Controls: sleep hours (stepper, 0.5 steps, default last value or 7), energy 1 to 5 and mood 1 to 5 (segmented buttons with text labels, not emoji only), workout minutes (quick picks 0, 20, 30, 45, 60 plus custom), spend in QAR (number), optional note (500 max with counter). Everything has a visible label.
   - Prefilled with today's existing check-in when editing. One Save button, Enter submits, Escape closes. Validation mirrors the server ranges and shows errors inline next to the field; server 400 message shown at the top.
   - On success: a short check animation, the dialog closes, the snapshot refreshes (`refresh` from `useSnapshot`).
   - Doable with keyboard only in under 30 seconds (tab order follows the visual order).
5. **Edge cases:** server offline (keep entered values, show retry), double click on Save (one request), editing yesterday, decimal comma typed in spend.
6. **Tests required:** `checkinForm.ts`: validation, defaults from last check-in, payload building, decimal comma handling.
7. **Security impact:** low. Personal data posted only to the local server.
8. **Risk level:** low
9. **Recommended order:** batch 3
10. **Dependencies:** T08

**Read first:** `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`, this ticket, the T08 primitives and contexts, and vault pages `ux/forms-and-validation.md`, `ux/keyboard-and-focus-patterns.md`, `ux/ux-writing-and-microcopy.md`.
**Forbidden:** any file not listed in item 3; changing tokens, shell or primitives (report needed changes instead); changing `shared/types.ts`; adding npm dependencies; anything under `~/.claude`; git commits.
**Report back (under 200 words):** what changed, files, check results (exact commands and pass/fail counts), open issues or contract problems.

## Definition of Done
- [ ] Acceptance criteria met
- [ ] Tests listed in item 6 exist and pass
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] No em-dash characters in any file touched
- [ ] Report sent
