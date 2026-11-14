# Handoff — Studio review (studio-v2)

**Registry:** `.mona/build-macos/reviews/studio-v2/state.json` (revision 9)
**Current task:** R01 — completed · **Next eligible:** R02, R03
**Review document:** `MacMona_Studio_Review_PROMPTS.md` (sha256
`7e1e16d1…`) · **Hotfix:** `MacMona_Review_Hotfix.patch` (sha256
`a253a05e…`, applied unmodified)
**Product ledger:** unchanged authority —
`.mona/build-macos/state.json` is at P23 completed; P22/P25 remain its
eligible prompts. Nothing in this review queue resets P00–P27 or the attempt
counts (`attempts.jsonl` is empty; no problem consumed an attempt).

## Where R01 landed

- **RV-01 fixed.** `src/renderer/shell/session.ts` now owns the composer through
  `DraftJournal`: one revision per edit, writes serialized per draft key, and an
  acknowledgement may claim `saved` only for the revision it actually wrote.
  `SubmissionGate` claims a submission synchronously with an immutable identity
  `{project, thread, revision, text, mode}`; `acceptSent` clears **only** the
  submitted revision, and reports `preserved` when text arrived during the send
  or `stale` when another project is open.
- **RV-02 fixed.** `SelectionEpoch` invalidates older loads, refreshes and
  actions, including A→B→A, which a project-id comparison cannot catch. Stale
  results never replace `selected`/`studio`; stale failures are still shown,
  labelled with their project name. `busy` is a counter, so no latch sticks.
- Favorites, the quit dialog and project switches flush through the journal;
  `saveProjectView` re-checks the selected project inside its timer.
- Evidence: `docs/evidence/macos/review-studio/R01-drafts-and-navigation.md`
  with the race matrix, `artifacts/r01-prefix-races.txt` (6 failed | 3 passed
  before the fix) and `artifacts/r01-tests.txt`, `r01-shell-smoke.json`.
- Gates: 23 focused tests, **819 tests in 81 files**, typecheck clean, lint 0
  errors, format clean, real Electron shell smoke **127/127**.

## Where R00 landed

- HEAD at adoption `656b12a`; the six hotfix files were byte-identical to the
  reviewed baseline (local `4d893fc` = remote `10d8375`), so the patch applied
  with `git apply` and **no adaptation**.
- Fixed and verified: replacement now deletes `events` + `event_cursors`
  (RV-03); timeline projects per thread (RV-04); plumbing frames no longer split
  a streamed message (RV-05); Enter stays newline, Command-Enter submits behind
  one honest gate with IME/repeat guards (RV-07, UX-COMPOSER).
- Formatting (RV-11) was already closed at `4411ef1`; format:check is green.
  `MacMona_Studio_Review_PROMPTS.md` is now in `.prettierignore`.
- Evidence: `docs/evidence/macos/review-studio/R00-baseline.md` plus six
  artifacts (host baseline, pre/post test runs, focused validation, format gate,
  shell-smoke report).
- Gates: focused 24→29 tests; full suite 791→796 in 79 files; typecheck clean;
  lint 0 errors; `smoke:shell` 127/127 with Electron exit 0.
- Original-ledger hygiene: P10/P19 `store.ts` hashes re-recorded **after** the
  suite passed, with notes saying the original reports describe pre-review
  bytes; 19 rewritten shell captures re-recorded per task with notes.

## Exact next action

Two tasks are eligible now:

- **R02 — complete, identity-aware history and paging.** Read
  `src/main/projects/service.ts` (the fixed 200-event tail),
  `src/main/state/store.ts` event reads, `src/shared/contracts/project-bridge.ts`
  and `src/renderer/shell/timeline.ts`. R03 does not depend on it, but R04 does.
- **R03 — verified slash-command catalog and autocomplete.** Read the pinned
  0.10.2 slash-command registry before writing a catalog; never generate
  descriptions from memory or with a model.

```sh
node tools/monabuild/cli.mjs review status   # next_eligible: R02, R03
```

Do not start R04, R05 or R07 before their prerequisites complete.

## Rules that still bind

- Enter is newline; Command-Enter submits; no background inference on UI paths.
- The pinned engine stays 0.10.2 with the configured DeepSeek Flash route and
  cost controls untouched.
- Three no-progress attempts stop that problem; log evidence and exact help in
  `BLOCKERS.md`, then continue independent work. Use
  `monabuild attempt/reopen` with stable `RV-*`/`UX-*` problem IDs — the review
  ledger never resets a count.
- Finish a prompt through code, focused validation, docs and a checkpoint
  before reporting.
