# Handoff — Studio review (studio-v2)

**Registry:** `.mona/build-macos/reviews/studio-v2/state.json` (revision 3)
**Current task:** R00 — completed · **Next eligible:** R01, R02
**Review document:** `MacMona_Studio_Review_PROMPTS.md` (sha256
`7e1e16d1…`) · **Hotfix:** `MacMona_Review_Hotfix.patch` (sha256
`a253a05e…`, applied unmodified)
**Product ledger:** unchanged authority —
`.mona/build-macos/state.json` is at P23 completed; P22/P25 remain its
eligible prompts. Nothing in this review queue resets P00–P27 or the attempt
counts (`attempts.jsonl` is empty; no problem consumed an attempt).

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

Start **R01** (drafts and asynchronous navigation are lossless) — it is the
prerequisite for R03, R05 and R07:

```sh
node tools/monabuild/cli.mjs review status
# read:
#   src/renderer/shell/Shell.tsx  persistDraft / selectProject / refreshSelected /
#                                 submitTask / action handlers
#   src/shared/contracts/project-bridge.ts, draft storage, IPC contracts
# then set R01 running through `monabuild review checkpoint`.
```

R02 (identity-aware history and paging) is independent of R01 and may run
instead if history work is preferred first. Do not start R03/R05/R07 before
their prerequisites are completed.

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
