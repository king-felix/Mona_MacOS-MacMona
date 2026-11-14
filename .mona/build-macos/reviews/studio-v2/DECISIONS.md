# Decisions — Studio review (studio-v2)

Durable choices made while carrying out the MacMona Studio review. These are
subordinate to the original product decisions (`.mona/build-macos/DECISIONS.md`,
D-001…D-103) and never replace them.

## RD-005 — The review ledger is written only through `monabuild review`

- **Decision:** R00–R15, RV-01…RV-13 and the five UX feature IDs live in
  `.mona/build-macos/reviews/studio-v2/state.json`, created and changed only by
  `monabuild review checkpoint|evidence`.
- **Why:** the review asks for atomic writes, revision checks and per-task
  evidence hashes; a hand-edited JSON file cannot guarantee any of them.
  `tools/monabuild/lib/review.mjs` validates a schema plus invariants the schema
  cannot express (exact task/issue sets, prerequisite cycles, a completed task
  with remaining acceptance, `current_task` agreement) and refuses the write.
- **Consequence:** evidence files are hashed on attachment; a stale evidence
  hash fails `review validate`. A completed task that names an attempt problem
  with three no-progress attempts is refused, so a blocked problem cannot be
  papered over by marking the task done.

## RD-004 — Attempt counts continue in the shared ledger

- **Decision:** review tasks do not own an attempt counter. Problems use stable
  IDs (`RV-03`, `UX-COMMANDS`, …) against `.mona/build-macos/attempts.jsonl`.
- **Why:** a subordinate queue is not an excuse to reset the three-attempt rule.
- **Consequence:** `review validate` reads the same ledger and reports blocked
  problems; a task that names one cannot be completed while it is blocked.

## RD-003 — Invalidated source hashes are recorded, not repaired

- **Decision:** when the hotfix changed `src/main/state/store.ts`, the P10/P19
  evidence entries were refreshed only after the full suite re-ran on the new
  bytes, and each note now says the original report describes the pre-review
  bytes. The review registry records the reviewed-baseline hash in the R00
  source-hash note.
- **Why:** rehashing an old report would claim a verification that never
  happened. The review explicitly forbids that.
- **Consequence:** history stays auditable: old bytes, new bytes, and the run
  that qualified each are all named.

## RD-002 — The hotfix applied unmodified

- **Decision:** apply `MacMona_Review_Hotfix.patch` with `git apply` and change
  nothing in it.
- **Measured reason:** the only commits between the reviewed baseline and HEAD
  are a format-only cleanup of four other files, shortened secret fixtures, and
  ledger/evidence updates. The six hotfix files were byte-identical, and
  `git apply --check` passed. Re-deriving the fixes by hand would have added
  risk without adding an adapted behavior.
- **Consequence:** the review's own regression tests ship with the fix.

## RD-001 — Formatting stays separate from behavior

- **Decision:** the four files the review found unformatted are not touched by
  the behavioral patch. They were already formatted at `4411ef1`; R00 only
  confirmed the gate.
- **Consequence:** the one formatting-relevant change R00 makes is
  configuration — the owner-supplied review document joins the other law
  documents in `.prettierignore`, so CI does not reformat Victor's text.
