# Decisions — Studio review (studio-v2)

## RD-006 — Draft writes are serialized in the renderer, not CAS'd in main

- **Date:** 2026-11-14 (R01)
- **Context:** R01 allows either "serialize saves per draft key" or "enforce
  revision/CAS ordering in main/storage" so an old save cannot overwrite newer
  text.
- **Decision:** `DraftJournal` (`src/renderer/shell/session.ts`) serializes writes
  per `(project, thread)` key through a promise chain, keeps a revision per edit,
  and only reports `saved` for the revision an acknowledgement actually wrote.
  Main's `saveDraft` is unchanged.
- **Why:** the renderer is the only layer that knows the newest text. A main-side
  CAS would reject an older write, but it cannot stop an older *acknowledgement*
  from labelling newer text "saved", which was half of RV-01. Serializing per key
  also makes the final stored text the newest text by construction.
- **Consequence:** one write per key is in flight at a time; a rejected write
  stops the convergence loop, leaves the text in memory and reports the error.
  The stored draft can lag the composer by one debounce (500 ms) or one flight,
  never more, and text is never cleared except by `acceptSent` on an exact
  revision match.

## RD-007 — A stale outcome is labelled, never dropped

- **Date:** 2026-11-14 (R01)
- **Decision:** when an async completion belongs to a project the user has left,
  its failure is still shown, prefixed with that project's name; its success
  notice is prefixed the same way. `selected`/`studio` are not updated.
- **Why:** hiding a failure to keep the screen tidy is dishonest; presenting it
  as the current project's failure is misleading. Labelling keeps both true.
- **Consequence:** errors can name a project that is not on screen. The Studio
  itself never shows another project's data.

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

## RD-005 — History is paged by storage order, and identity is stored, not inferred

- **Decision:** the conversation page cursor is the store's receipt order
  `(recorded_at, rowid)`, never an engine sequence number. The engine's `seq` is
  one global counter shared by every thread (D-099), so a cursor built on it
  would skip or repeat frames whenever another thread took numbers in between.
  Loss remains only what `event_gaps` records from `previous_seq`.
- **Decision:** `events.item_id` (schema v10) keeps the envelope's item
  identity; a completion that omits it still names its item in
  `payload.item.id`. Rows from before v10 keep `NULL`, which the UI reports as
  unknown identity. They are not filled in by guessing, and a legacy completion
  is bound to an unidentified stream only when exactly one such stream of that
  kind in that turn can be its source.
- **Decision:** a card whose beginning predates the loaded window is marked
  partial. With an item id it offers a bounded reload of that item's stored
  frames (≤ 4,000); without one it says the beginning cannot be reconstructed.
  Backfilling whole pages to hide the boundary was rejected: it turns a page
  read into a transcript read and still cannot recover pre-v10 identity.
- **Decision:** scroll anchoring keys on a completed older-page read
  (`olderLoads`), not on the event array changing. A live append changes the
  same array; anchoring on that would drag a reader down on every new frame.
  `scroll-behavior: smooth` was removed for the same reason: its animation made
  follow-scroll look like the reader had left the live edge.
- **Decision:** the current thread is the project's deterministic local thread
  (`thr_<sha256(projectId)>`), exposed as `ProjectDetail.currentThreadId`, not
  "the most recently updated thread" — an archived thread can hold that title
  and would otherwise be labelled current.
- **Consequence:** R04's `/new` can create additional threads and the Studio
  will label them archived until one becomes current. R11 owns rendering
  performance once a reader has loaded many pages.
