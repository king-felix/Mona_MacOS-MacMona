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

## RD-006 — The command catalog is captured from the engine, and R03 does not execute it

- **Decision:** the slash-command catalog is the pinned engine's own
  `GET /v1/commands` response, captured from `codewhale 0.10.2` (commit
  `ff466b2ed0bf`, binary sha256 `da022961…`) through an isolated runtime. The
  TUI slash registry is not the CLI subcommand list: `codewhale --help`
  enumerates `serve`, `review`, `fleet` and other processes, while the runtime
  endpoint enumerates `/goal`, `/new`, `/mcp`, `/anchor` and the rest of the
  composer surface. `scripts/command-catalog.mjs --check` reproduces the
  coverage and the capture digest offline; `--capture` is the only path that
  starts a process, and it makes no turn.
- **Decision:** every row carries an explicit annotation — scope, side effects,
  cost class, support, and route. `support=runtime-api` names documented `/v1`
  operations for R04 to wire; `terminal-only` means only the TUI implements it;
  `unavailable` means this engine version exposes no route. A missing or extra
  annotation is a gate failure, not a default. 109 rows resolve to 35 / 69 / 5,
  with `/lane` the one hidden row.
- **Decision:** R03 catalogues and explains; it does not execute. A recognised
  command is intercepted before the submission gate and never reaches the
  engine as a prompt. This keeps RV-09's "never send `/new` to the model
  pretending it is a local action" true while R04 owns operation-specific IPC,
  effects, and receipts.
- **Decision:** recognition is exact. Only a canonical name or alias becomes a
  command; a prefix with matches is reported as ambiguous and selects nothing;
  a path (`/Users/…`), an escaped slash, an indented line, fenced pasted code,
  and ordinary prose remain prompt text. `Enter` stays a newline; `Tab` accepts;
  `Escape` closes the list before Focus Mode; `⌘Enter` explains an incomplete or
  ambiguous command.
- **Decision:** the list is anchored to the composer input, on the side with
  measured room, and clamped to the viewport. At 200% page zoom it keeps a
  scrollable list and drops the detail/footer rather than overflowing the
  window or covering the composer. The measure listens to resize, scroll, and
  `visualViewport` changes because Electron page zoom changes the CSS viewport
  without a window resize.
- **Consequence:** R04 consumes this registry instead of inventing routes; a
  real execution result that contradicts an annotation must revise the
  annotation rather than preserve it. The catalog is pinned, so a live engine
  version/commit difference is shown as drift and is never silently accepted.

## RD-008 — Commands execute through one dispatcher, and `/new` is a generation

- **Context:** R03 catalogued 109 composer commands and deliberately executed
  none. R04 must run the ones the pinned engine can run, leave the rest honest,
  and make `/new` a real conversation switch — without turning slash text into a
  prompt or a shell line.
- **Decision:** every command crosses one typed `commands:execute` request. Main
  resolves the spelling (canonical name *or* alias) against the pinned catalog
  and a curated execution plan (`src/shared/commands/execution-plan.ts`), which
  the builder validates against the catalog. A route is one of native (five
  typed engine operations), view (open the existing owner surface), terminal
  (prefill a fixed shell-word invocation; never run it), or unavailable.
- **Shell safety:** a terminal invocation is a fixed string validated against a
  shell-word grammar, and no typed argument is ever added to it. A command that
  takes no argument refuses arguments rather than ignoring them.
- **`/new`:** a project/mode conversation is a *generation*. Schema v11 stores
  `threads.mode`, `threads.generation` and `command_operations`. `/new` records
  the operation key and its target thread before the engine write, creates the
  engine thread with a key derived from `(project, mode, generation)`, and
  rebinds the studio. A lost response or restart resumes the recorded target;
  a completed key returns its first receipt. No earlier row, event, draft, usage
  row or attempt is deleted.
- **Busy:** a running turn is refused with the turn id and a Wait/Interrupt
  choice. Only a *confirmed* interrupt clears the in-memory turn, and the receipt
  says the old thread's final frame is stored when that conversation is reopened.
- **Consequence:** R05/R08 inherit a conversation identity that survives a
  restart without a second scheduler, and R10/R12 can build on typed command
  receipts rather than re-parsing slash text. A route that a later prompt cannot
  honour must be revised in the plan, not hidden behind a successful-looking
  receipt.

## RD-009 — The composer submits to the conversation on screen, and `/new` clears only what it sent

- **Context:** R04 makes a project hold several conversations of one mode. Two
  boundaries became reachable that R02/R03 did not exercise: a draft claimed
  across an await, and a send whose target was the studio's binding rather than
  the transcript the reader had selected.
- **Decision:** a command dispatch claims the draft identity *before* the first
  await, so `acceptSent` can only clear the exact revision it sent; text typed
  during the engine call changes the revision and is preserved. Selecting an
  archived conversation disables the composer with a stated reason instead of
  sending into a different conversation. The status line reports the studio's
  selected conversation (`bindings[lastMode]`), not whichever mode happens to
  have a binding.
- **Also:** `completeCommandOperation` is insert-or-update, so rename, compact
  and fork leave a durable receipt; a pending `/new` records its generation with
  its key so a crash between the two writes cannot resume at generation 0 and
  reuse the first conversation's engine key.
- **Consequence:** the invariant "Mona never discards text the user can still
  see, and never sends into a conversation the user cannot see" is now enforced
  in the same place it is claimed. R08/R10 inherit both rules.

## RD-010 — A test fixture directory is removed by the file that made it

- **Context:** the host filled up twice while running R04's suite. The cause was
  not a large build: `tempDir()` minted one `mona-*` directory per state store
  and never deleted it. 94,112 trees (33.7 GB) had accumulated in the temp
  directory across earlier prompts, which also exhausted inodes.
- **Decision:** `test/helpers/temp.ts` owns `tempDir()`, registers every
  directory it creates, and sweeps them in one `afterAll` per test file. One
  sweep per file, not per test: several suites take a store directory and a
  workspace inside it, and a per-test sweep would delete a fixture a later test
  in the same file still needs.
- **Not claimed:** files that call `mkdtemp` directly still leave ~147 small
  directories (0.5 MB) per run. That is bounded and recorded; routing each of
  those call sites through the helper is a test-hygiene task, not R04's.
- **Consequence:** a full suite no longer consumes gigabytes of host disk, so a
  green run cannot fail because of its own leftovers. R12's CI reconciliation
  inherits a suite that starts from, and returns to, a clean temp directory.

## RD-011 — Full screen is an observation, and the immersive layout never clips

- **Context:** R05 asked for a focused Studio plus native macOS full screen. The
  first implementation passed its own tests and its own smoke, and an
  independent review then refuted it with three defects that the tests could not
  see: the composer had become a scroll container, so the absolutely positioned
  slash-command list was clipped out of sight; the composer's pixel height was
  never re-clamped when the stage shrank, so at 200 % it took 77 % of the stage
  and left a 72 px console; and the "slim dashboard" hid model, spend and tokens
  at ordinary widths while the popover promised as their fallback carried prose
  instead of values.
- **Decision — full screen is a fact about the window, not an intention.**
  `main/window-fullscreen.ts` reads `isFullScreen()` inside the
  `enter-full-screen` / `leave-full-screen` handlers. `setFullScreen(true)`
  returns before AppKit animates, so the published view carries the *observed*
  state plus `pending`. The request is bounded: an intent macOS never answers is
  dropped and re-published, so `pending` cannot disable a control forever. The
  renderer ignores the reply to its own request and moves only on the event, and
  a transition macOS did not make is announced rather than swallowed.
- **Decision — the window is decided by the sender.** The two IPC channels carry
  no window identifier; main resolves the window from `event.sender.id` and
  refuses a sender that owns none. A renderer cannot put another window into
  full screen.
- **Decision — the focused layout is not a scroll container.** A layout that
  bounds its composer with `overflow` also clips everything positioned above it,
  and the command list lives there. The stage uses `min-height` with no overflow
  so large text scrolls the document instead of shrinking the console; the text
  area, not the composer, carries the height bound; the bound is measured from
  the live stage and re-applied by a ResizeObserver.
- **Decision — hiding a fact is not removing it.** Where a narrow bar elides a
  value, the drawer repeats the same value with the same wording, and an elided
  label stays in the accessibility tree rather than being withdrawn from it.
- **Not claimed:** the green button, a real second display, VoiceOver and
  physical sleep are unverified here (R11/P24). `smoke:shell` was not re-run
  because it rewrites 36 hash-pinned product captures; R12 owns that
  reconciliation.
- **Consequence:** every future immersive or HUD surface inherits three rules —
  observe, do not assume; never bound a layout with `overflow` when something is
  positioned outside it; and any fact you hide needs a route that still shows it.
