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

## RD-012 — A dependency advisory is closed by moving the parents, not by pinning blindly

- **Context:** after R05 was pushed, GitHub reported two moderate npm advisories
  on the default branch: `minimatch` 10.2.6 (GHSA-g3hv-75wg-m249, globparts
  amplification) and `glob` 13.0.7 (GHSA-3g3m-2fjr-6pw4, abort-timeout walk
  continuation). Both were transitive **development** dependencies reached via
  `eslint`, `typescript-eslint` and `@electron/packager` → `@electron/asar`.
- **Decision — fix at the parents first.** `npm audit fix` moved the
  `@electron/asar` 4.3.2 / `glob` 14.0.6 / `minimatch` 11.0.8 subtree without a
  range override, `eslint` moved to 10.15.0 by hand (its own range is now
  `^11.0.5`), and only `@typescript-eslint/typescript-estree` — at its latest
  release, still declaring `^10.2.2` — needed an override, scoped to that one
  package. A blanket `minimatch` override would have forced a major bump on
  packages that had not adopted it yet.
- **Decision — majors are proven, not assumed.** `minimatch` 11 is dual
  (ESM + CJS) and keeps its function and `Minimatch` API; its only call site in
  `typescript-estree` runs under `projectService`, which this repository does not
  enable. `glob` 14 is reached only through `@electron/asar`, and packaging here
  builds with `asar: false`; the filter path was still compared old against new
  with one fixture and one script and produced identical archives and ignores.
- **Decision — exposure is stated, not dramatised.** The production tree is
  `react`, `react-dom`, `scheduler`, `zod` and audits clean. The patterns
  `minimatch` sees are developer-authored config and packager ignore lists. The
  fix was taken because it is cheap and upstream-sanctioned, not because a live
  path existed.
- **Verification:** `npm audit` 0, `npm ls` single versions, `eslint` 297 files
  linted (so matching really ran), `npm run ci` green 18/18 with 983 tests, and
  `mac:package:local` passing every gate up to the admin-gated `installed_copy`
  that EXT-INSTALL already records.
- **Not claimed:** `mac:package:local` is still blocked on administrator
  authorization; signed distribution is still P22/R14; `eslint` 10.15.0's own
  release notes were not audited line by line — the CI run is the evidence.
- **Consequence:** R12 inherits a clean dependency tree and must re-check it at
  the final sweep; the product-ledger manifest hashes and the smoke run records
  this CI run rewrote were re-recorded with notes rather than silently refreshed.

## RD-013 — One committed logo asset, resampled everywhere, never redrawn

- **Context:** the owner supplied `MidnightMona.png` (1254×1254 RGBA) and asked
  for it as the app icon and ico "and anywhere else where the logo may be
  called for". The build previously synthesised its icon mathematically in
  `packaging/macos/icon.mjs` — a rounded square and a gold M — and drew the same
  glyph into the installer background.
- **Decision — the artwork replaces the synthetic mark outright.** The master
  moved to `packaging/macos/resources/MidnightMona.png` and every surface is a
  resample of it: `Mona.icns` (ten iconset sizes), `Mona.ico` (seven PNG
  entries), the installer background, the 24 px in-app rail mark, and the
  window favicon. Nothing draws its own glyph any more.
- **Decision — a wrong asset fails the build.** `readLogo()` refuses a master
  that is not square, not 8-bit RGBA, interlaced, or under 1024 px. A packaging
  run must stop rather than ship a subtly wrong icon.
- **Decision — `.ico` ships even though macOS ignores it.** The format was asked
  for explicitly; it is sealed in `Contents/Resources` and recorded in the
  component manifest as an `image` component, so it is a real payload byte rather
  than a build leftover.
- **Decision — derived, not duplicated, in the renderer.** The rail mark is a
  128 px resample written by `npm run icon:render` from the same master, so the
  in-app logo cannot drift from the bundle icon.
- **Caught while building it:** the artwork's corner is fully transparent, so
  sampling (8,8) for the installer gradient produced black. The gradient now
  scans for the darkest pixel with `alpha ≥ 250`. The pre-existing
  `focus_mode_composer_usable` check also failed once the icon made the smoke
  run reach Focus Mode: it asserted against the sticky control strip R05
  removed, so it was generalized to its intent (Send reachable, on screen, and
  not covered where a strip exists) rather than deleted.
- **Not claimed:** the Installer's own background rendering and the Dock tile are
  unverified until the package is installed; `smoke:shell`'s 36 pinned product
  captures were deliberately not regenerated (R12 owns them, and they were
  already stale from R04/R05).
- **Consequence:** R06 restyles around this identity instead of regenerating it.

## RD-014 — A pending ask is a durable row with the engine's own capability

- **Context:** RV-10. At R05 a pending approval or clarification was one sentence
  in `StudioSession.pendingInput`, produced by a `kind`-only classifier. It had no
  id, no thread, no turn, no options, no status and no persistence, and its text
  advised switching to Full Access or answering in Codewhale. A restart forgot it,
  because the event stream resumes from the stored cursor and a prompt at or
  below it is never replayed.
- **Decision — schema v12 `pending_requests` is Mona's receipt, not a second
  truth.** A row records the Runtime's capability (`request_key`), the local
  thread and engine thread, the turn, what was asked, and how it settled. The
  engine stays authoritative about *what is pending*: `hydratePending` reads
  `pending_approvals[]` / `pending_user_inputs[]` from thread detail on start,
  on reattach, on the still-live path and after a terminal turn. Rows the engine
  no longer lists are marked `expired` with that reason; rows it still lists are
  refreshed. When thread detail carries no list at all, nothing is expired.
- **Decision — the capability never reaches the renderer.** IPC names Mona's row
  id (`prq_…`); main echoes the engine's id. The zod schema refuses anything that
  is not Mona's own id shape, and a test plus the smoke assert the capability is
  absent from the snapshot the screen receives.
- **Decision — a decision is recorded only after the Runtime's 2xx.** A `404`
  becomes `expired` with no decision, an interruption becomes `cancelled` with no
  decision (the payload's deny is the engine's, not the user's), and a transport
  failure becomes `unknown` while keeping the attempted decision and refusing a
  retry until the engine's list is read. "Answered" is never inferred from a
  click.
- **Decision — single-use is enforced in code, not by care.** `claimPendingRequest`
  is a compare-and-set (`pending|unknown → sending`) inside one SQLite
  transaction, and `validateAnswers` checks the engine's own answer rules before
  the claim. A concurrent double answer in the tests sends exactly one request.
- **Rejected:** polling `GET /v1/approvals` on a timer (a second loop for state the
  stream and thread detail already carry); auto-approving or widening the posture
  to clear a wait (forbidden by the review prompt and by Mona's honesty rules);
  answering a clarification by submitting ordinary prompt text (the engine has a
  typed answer route; guessing would be a fabricated capability).
- **Measured against 0.10.2:** the pending lists live at the **envelope's top
  level** of thread detail, beside `thread` and `turns` — the first
  implementation looked inside `thread` and silently read nothing. The live smoke
  is what caught it, and both spellings are now accepted.
- **Not claimed:** a live approval prompt has not been round-tripped (that needs
  a turn, a tool call and inference). The contract, the capability's single-use
  behaviour, the 404 path, the lifecycle and the 2xx mapping are verified; the
  limitation is recorded in the evidence rather than glossed.
- **Consequence:** R08 can build "reply to this pending question" on a real row
  id and a real receipt instead of a text banner.

## RD-015 — Decoration intensity is a preference, never a second design

- **Context:** R06 asks for a splashier interface *and* for both themes to remain
  fully usable. Two designs or a contrast trade-off would violate MONA-006.
- **Decision — one ornament layer, one semantic palette.** `Intensity`
  (`vivid` | `quiet`) sets `data-intensity` on the document root and changes only
  decorative roles (`--aurora-a/b/c`, `--selection`, `--selection-ink`, `--glow`).
  Text roles are untouched, which the unit test asserts directly and the live
  smoke measures from the painted document: ink-on-surface, ink-on-canvas and
  muted-on-surface are byte-identical between intensities in both themes.
- **Decision — gradients never sit under text.** The plaque wash has an opaque
  content layer; turn surfaces use a border and a tinted background, not a
  gradient behind prose. That is why one contrast table can govern both
  intensities.
- **Decision — animation needs a state, and a hidden window is not watching.** The
  only pulse is on `.status-dot--live`, set by one function and only while the
  connection state is `running`; it stops under `prefers-reduced-motion` and when
  `data-document-hidden` is set on `visibilitychange`, because Electron keeps a
  hidden window's compositor alive. The smoke asserts zero running animations in
  all four combinations.
- **Rejected:** a "turn settled" transition on every card (decoration implying an
  event it did not observe — the keyframes exist but nothing applies them); a
  particle/glass background (the prompt rules it out and it costs CPU while
  idle); animating progress (no fabricated percentages).
- **Decision — captures are checked, not just taken.** The R06 runner waits two
  animation frames, invalidates the frame, captures, and asserts that no two
  captures are byte-identical. That check caught a persisted Focus Studio
  preference labelling a focused frame as "normal", and the runner now clears the
  preference through the product's own exit control and asserts the layout state.
- **Consequence:** Quiet needs no second palette to maintain, and a future theme
  inherits both intensities by filling in six ornament roles.

## RD-016 — Search, copy and file context are reads with an honest boundary

- **Context:** R10 asks for conveniences without hidden inference, data loss or a
  fabricated attachment.
- **Decision — search runs in SQLite over this project's stored events.**
  `LIKE … ESCAPE '\'` with `%`, `_` and `\` escaped, `LIMIT` ≤ 100, optional
  thread scope, and an anchor (`threadId`, `seq`, `itemId`, snippet) per hit. It
  is a state read: no runtime, no socket, no model. The UI says "Local read only;
  nothing is sent to the engine", and a hit that is not in the loaded window
  makes the console load one more page rather than pretending the card is there.
- **Decision — copy is acknowledged by the clipboard itself.** Main writes with
  Electron's clipboard and reads the text back; the renderer reports success only
  when the read-back matches. A card copies its exact body and a fenced block
  copies its source, both through the same channel.
- **Decision — file context is a verified read, not an attachment.** The mention
  path goes through the engine's own `workspace/files/read` route; main refuses
  absolute paths and `..` before asking, the engine refuses symlinks and escapes,
  the dialog shows byte size and a token estimate explicitly labelled as an
  estimate, and the content is inserted as text the user submits. Binary stays
  unavailable with the reason on the disabled control.
- **Rejected:** reading files from the renderer or main directly (bypasses the
  engine's containment); a directory-listing route Mona does not have; inserting
  a mention without showing size/cost; replacing the draft on insertion.
- **Caught while building it:** the R05 "grip only in the immersive layout" test
  failed once the grip became universal. It was rewritten to assert the new
  behaviour rather than deleted, because widening the control was the point.
- **Consequence:** R11/R12 inherit a search surface that is bounded and a copy
  path that cannot lie about a clipboard; a ranked index remains an honest gap.

## RD-017 — A claim that dies with the process is reopened; a live claim is not

- **Context:** the first R07 implementation marked a request `sending` before the
  reply left and left it there on a transport failure (`unknown`). The reviewer
  found the hole that remained: a process that dies *during* the POST leaves a row
  in `sending` forever. The engine still lists the capability, so it cannot be
  answered again, and the card says "An answer is being delivered" indefinitely —
  exactly the "a real wait looks like a hang" failure R07 exists to remove.
- **Decision — the engine's list is the evidence, the process is the claim.** A
  `sending` row is reopened when the engine still lists the capability *and* the
  current process holds no claim on it. A cold start hydrates the conversations
  the store already holds, so this happens without the user submitting anything.
  While `answerPending` is in flight the row id is in `session.answering`, and a
  reconcile that runs then leaves it alone.
- **Rejected:** a timeout-only rule (a crash just after the claim would wait out an
  arbitrary interval with the UI still saying "sending"); a durable claim token
  (a second identity to keep consistent for a window measured in milliseconds).
- **Consequence:** the reopen path needs a test that goes through `answerPending`
  with a held transport, not a store write, or it would assert bookkeeping that
  no real caller performs. Both forms are now tested.

## RD-018 — Reconciling only the list the engine actually reported

- **Context:** `available` was `Array.isArray(approvals) || Array.isArray(inputs)`.
  An engine that reported one list and omitted the other would have expired every
  stored row of the omitted kind — inventing an absence from silence.
- **Decision:** `PendingSnapshot` reports `approvalsAvailable` and
  `inputsAvailable` separately, and `expireUnlistedPendingRequests` takes a `kind`
  and reconciles only that kind. The pinned 0.10.2 reports both; a narrower
  payload is treated as silence, not as an empty list.
- **Consequence:** a future engine that drops a list cannot silently expire
  requests Mona still shows.

## RD-019 — Evidence must be able to fail

- **Context:** the R06 contrast check read root tokens and reported identical
  numbers for Vivid and Quiet, and the Home probe counted a selector production
  never renders. Both passed while proving nothing. The reviewer called this out
  as evidence outrunning code.
- **Decision — every visual check reads the rendered element it claims to
  describe.** Text/background pairs are measured by compositing each element's
  ancestors; the Home check reads `.project-row`; the capture set asserts that no
  two captures are byte-identical, so a stale composited frame cannot stand in for
  a second state. A smoke check that cannot fail is treated as a defect.
- **Caught while fixing it:** `/rgba?\(/` also matches the `rgb(` inside
  `color(srgb …)`, so painted colours parsed to `NaN` and JSON reported `null`.
  The regexes are anchored and srgb is parsed explicitly.
- **Consequence:** the R06 artifact now carries real ratios, and the two
  measurement bugs are recorded rather than quietly corrected.

## RD-020 — Render a measured slice, and never hide a card behind a guess

- **Context:** the console mounted every loaded card. `PAGE_LIMIT = 200` bounded
  a page, not the accumulated view; the projection ran in the render body with a
  fresh `Set` in its argument list, so a keystroke in the composer re-projected and
  re-rendered the whole conversation.
- **Decision — the window is decided by measurement, and the fallback is
  "render everything".** `computeWindow` is pure arithmetic over ordered keys,
  measured heights and the scroll position; `useTimelineWindow` supplies the
  measurements from `ResizeObserver`. When the pane has no height (server render,
  jsdom, a hidden screen, a collapsed split) the hook reports `complete: true` and
  every card renders. A window built on a guessed viewport would hide content from a
  reader who cannot scroll it, which is worse than a slow render.
- **Decision — a short list is not windowed at all** (below 80 cards), so ordinary
  conversations keep exactly the DOM they had.
- **Decision — a correction never moves what you are reading.** A measured height
  shifts the viewport only when it belongs to a card above **`visibleStart`**, the
  first card actually on screen. The first implementation used the rendered start
  and was wrong for the leading overscan band; the range type now carries
  `visibleStart` so the mistake cannot be re-made silently.
- **Consequence:** 601 projected cards mount 10–16 nodes, keystroke and scroll p95
  stay inside two 60 Hz frames, and the console reports `10 painted` rather than
  implying it is showing 601 cards.

## RD-021 — A budget the runtime alone exceeds is an exception with a measurement

- **Context:** the specification asks for "initial idle total Mona processes under
  350 MiB". Measured: 568.7 MiB peak. Measured again on this host with a window
  whose whole content is an `<h1>`: **356 MiB** for bare Electron 45.3.0.
- **Decision — the target is measured exactly as written and reported as missed.**
  No process is trimmed, no forced GC is added, no feature removed, and the target is
  not reformulated. `scripts/r11-smoke.mjs` runs the baseline itself and attaches an
  exception only when `baseline.total_mb_max >= 350`, naming the single check it
  covers and stating Mona's own share as a difference (212.7 MiB here).
- **Decision — absence is failure.** A run that writes no report, or exits non-zero,
  fails its own check (`run_produced_a_report`, `electron_exited_zero`). The first
  version of the harness printed `"passed"` for a cold run that had been killed
  before writing anything; that is exactly the "no failing checks" fallacy a
  measurement tool must not commit.
- **Consequence:** `status: "passed_with_exception"` is a real verdict, distinguishable
  from `passed`, and no other check can hide behind the exception.

## RD-022 — Accessibility is asserted by mechanism, not by label

- **Context:** the shell was carefully labelled — landmarks, `aria-modal` dialogs,
  a real listbox for suggestions, IME guards on the composer — and still had four
  real defects, all found by running axe over all nine screens rather than the Studio.
- **Decision — fix the mechanism and prove the property failed before it passed.**
  The `Dialog` focus effect is keyed on `[open]` with the close handler behind a ref,
  so an unrelated parent render cannot move focus; two tests cover it and both were
  proven to fail on the pre-R11 code. The window listener asks
  `acceleratorAllowed(event, acceleratorScope(document))` instead of open-coding two
  `if`s. The composer dropped `role="combobox"` and `aria-expanded` — both invalid on
  a `<textarea>` — and keeps the popup relationship in attributes the textbox role
  does support.
- **Decision — no live region may wrap streaming content.** The console contains no
  `aria-live`, `role="log"` or `role="status"`; the command detail panel stopped being
  a live region because `aria-activedescendant` already announces the option, and the
  duplicate made a screen reader say each command twice.
- **Consequence:** 9 screens, 0 violations, 0 serious or critical. VoiceOver itself
  remains unproven and is stated as such: axe and programmatic focus are not a
  spoken walkthrough.

## RD-023 — The empty→loaded transition is a hook boundary

- **Context:** an independent review found a BLOCKER the whole gate had missed: the
  `activity` memo sat after `if (!detail) return <EmptyState "Choose a project">`, so
  opening a project from that very empty state changed the hook count and React threw
  "Rendered more hooks than during the previous render". Reachable from the empty
  state's own **Open folder** button, from ⌘O and from drag-and-drop.
- **Why the gate could not see it:** `eslint.config.mjs` has **no `react-hooks`
  plugin**, so `rules-of-hooks` is never evaluated — "lint 0 errors" was not evidence
  for this class of bug — and no test rendered `detail: null` and then a project.
- **Decision — the memo moved above the return, and a test now mounts empty, loads,
  and returns to empty.** The test was proven to fail when the memo is put back in the
  old position. Adding `eslint-plugin-react-hooks` is recorded as R12 work: this prompt
  fixes the defect and its regression test, and does not silently add a plugin that
  would change the lint result for files it did not touch.
- **Consequence:** the transition is covered, and the limits of the lint gate are
  written down instead of assumed.

## RD-024 — Three visual regressions, and one attempted fix that was reverted

- **Context:** reading the captures found what the suite could not: a transparent
  fixed title bar with scrolled content bleeding through it; a composer below the fold
  at the 1280×800 reference window; and "Jump to latest" landing 59 px short and
  un-arming itself.
- **Decision — fix the two that are defects; report the one that is a layout fact.**
  The title bar now paints the rail's surface across the rail's width and the canvas
  beyond (with a narrow-layout override), asserted while scrolled. The jump re-pins
  while following, in the window hook and after two frames in `jumpToLatest`, asserted
  at `distance: 0` with the newest frame on screen. The composer's position is a
  consequence of a scrolling document with 549 px of chrome above the console: the
  console keeps 350 px and, scrolled to, the composer is fully visible and uncovered —
  which is measured and asserted, not described.
- **Rejected fix, recorded:** a measured `maxHeight` clamp on the console. Its reserve
  calculation picked up a 421 px element, it ratcheted the console down to its 180 px
  floor, and the composer still did not fit. It was reverted rather than shipped as
  decorative arithmetic.
- **Consequence:** the two defects have checks that fail without the fix; the layout
  fact has a check that states what is actually guaranteed.

## RD-025 — The hooks gate is configured, and the one it cannot host is named

- **Date:** 2026-11-14 (R12)
- **Context:** RD-023 recorded that R11's runtime blocker (a `useMemo` after an
  early return) survived a green lint because `eslint.config.mjs` had no
  `react-hooks` plugin. R12's handoff left the plugin as "consider"; the review
  prompt requires the gate to be trustworthy.
- **Decision — `eslint-plugin-react-hooks` 7.1.1 is pinned and
  `react-hooks/rules-of-hooks` is an error for `src/renderer/**`.**
  `test/lint-hooks-gate.test.ts` lints fixture source through the repository's own
  config and proves the rule rejects a conditional hook and a `use`-named
  callback, and accepts top-of-component and custom hooks. With the rule set to
  `off` the same test fails 2 of 3 — the gate is proven, not asserted.
- **Decision — `exhaustive-deps` stays off.** It is a correctness hint that
  reports on almost every effect here; enabling it would change the lint result
  for files this queue did not touch, which is exactly the silent-refresh pattern
  the ledger rules forbid. Turning it on is its own task with its own evidence.
- **Consequence:** the rule immediately found one real defect — `useFavorite` in
  `Shell.tsx` was a plain `useCallback` callback named like a hook, so React's
  own naming convention (and Fast Refresh) read it as one. Renamed
  `insertFavorite`; behaviour unchanged.

## RD-026 — A test fixture may not invent a contract the product never promised

- **Date:** 2026-11-14 (R12)
- **Context:** fixing the 20 `not wrapped in act` warnings meant awaiting the
  bridge promises inside `act`. With that fixed, `test/settings-screen.test.tsx`
  crashed: `FinderIntegration` reads `status.recovery.length`, and the test's
  generic proxy had been answering *every* bridge method — including
  `serviceStatus()`, whose contract is `Promise<ServiceStatus>` — with an
  `IpcResult` refusal. The warning had been hiding a fixture that lied.
- **Decision — the harness answers each API with its documented "nothing here"
  shape:** a real not-installed `ServiceStatus` for `serviceStatus` and
  `refreshService`, the refusal envelope for the rest. Product code unchanged.
- **Decision — act warnings are fixed at the boundary.** The suite was green with
  20 warnings, which is the state where a warning is easiest to silence and most
  misleading. The harness now renders and settles inside an async act; warnings
  are 20 → 0 and the same four tests still pass.
- **Consequence:** a fixture that returns the wrong shape now fails visibly
  rather than hiding behind a warning that everyone had learned to ignore.

## RD-027 — A candidate is qualified from its own bytes; the install is a privilege

- **Date:** 2026-11-14 (R13)
- **Context:** R13 must qualify the *installed* artifact, and this session has no
  administrator authorization (`sudo -n` → "a password is required"). The build
  stops at `installed_copy` by design; weakening that gate to obtain a passing
  run would be the exact opposite of the task.
- **Decision — add a verifier that reads the artifact, not the build's
  intentions.** `scripts/r13-candidate-verify.mjs` takes a bundle (staged,
  copied, or installed) and proves: bundle identity and build number against
  `git rev-list --count HEAD`, every component in the bundle's own manifest
  (size + sha256), every Mach-O header (arm64 only; app-owned minimum 14.0), the
  native helpers, the acceptance sample, the review's own channel names in the
  shipped bundles, and the payload's hygiene. It is re-runnable after the install.
- **Decision — the duplicate-copy notice is a fact to report, not a failure to
  hide.** A packaged copy outside `/Applications/Mona.app` raises a modal notice
  while the installed copy exists and will not quit until someone answers it
  (`-[NSAlert runModal]` observed in a sample). The verifier records
  `duplicate_copy_notice` and marks `graceful_shutdown` *not testable at this
  location*. The installed build 104 quits on `SIGTERM` in 1 s on the same host,
  which is what isolates the cause.
- **Decision — the task is `blocked`, not `completed-with-exceptions`.** The
  prompt's acceptance names the installed app exercised through
  LaunchServices/Finder; an uninstalled copy cannot do that. The blocker records
  the exact one-line command and is not attempt-counted: no hypothesis failed.
- **Consequence:** R14 stays ineligible until R13 completes, which keeps the
  release task behind a real artifact instead of a simulated one.

## RD-028 — The history anchor names a card, not a height

- **Date:** 2026-11-14 (R13)
- **Context:** the installed-artifact pass ran `--history-smoke`, which was never
  in `npm run ci`. It had been failing since R11 windowed the console: R02's
  anchor held the reader's place by adding the list's height growth to the scroll
  position, which is exact only while every card is mounted. With windowing the
  height includes estimated spacers, so on a 10,054-event project every older
  page dropped the reader **115.5 px** — one card — and the smoke's
  `document.body.textContent` proxy for "the page loaded" no longer described a
  page rendered above the window.
- **Decision — anchor on identity.** `loadOlder` records the card at the top of
  the viewport and its pane offset; the layout effect holds that offset for up to
  four animation frames while the new slice measures itself. The old height form
  stays as the fallback for a card that is not mounted. A reader who loads an
  older page sees the same message in the same place.
- **Decision — assert what the reader sees.** `scroll_anchor_held` now compares
  the anchored card's offset from the pane top (≤ 2 px) instead of comparing
  height growth with scroll movement. The second page is proven by the projected
  list (`data-cards`), and a third check proves reachability by painting the
  oldest page's range at the top. The tolerance was not widened and no check was
  removed; the metric is the contract.
- **Decision — put the guarantee in the gate.** `smoke:history` joins
  `scripts/ci.mjs`. The defect survived because a real check existed but nothing
  ran it, which is the same failure mode R13's command-smoke note records.
- **Consequence:** the fixed source is verified on the development tree (19/19,
  three runs) and on candidate build 152's own bytes (137 + 26 + 60 + 19). The
  installed copy remains build 151 until one admin-authorized install, so R13
  stays `blocked` with that exact command rather than claiming the reinstall.

## RD-029 — The release states its untested scope instead of asserting it

- **Date:** 2026-11-14 (R14)
- **Context:** R14 asks to reconcile the minimum tested OS and clean-host
  Git/tool prerequisites with the original release scope. The candidate declares
  and enforces macOS 14.0, but the only host that has run it is 26.5.1. The spec
  asks for runtime-critical Git to be bundled and for no core feature to trigger
  Apple's Command Line Tools installer; packaged Mona refuses the CLT stub, so
  core features satisfy that, but Git features therefore need CLT or another Git.
- **Decision — record the gap, do not close it by wording.** The release
  evidence names 14.0 as a *declared* floor and "no developer tools" as *not
  claimed for Git features*. No release note, receipt or verify output may say
  otherwise until P26 executes a 14.x matrix and P27/P26 decides bundle-Git
  versus documented dependency.
- **Decision — do not choose the owner's licensing question.** Bundling a
  relocatable Git carries a GPL source-offer obligation the owner must accept;
  documenting the dependency narrows MAC-004's claim. R14 records both options
  and neither is implemented by implication.
- **Consequence:** a signed artifact, when it exists, will be accompanied by a
  scope statement that is true on the hardware actually used. The release stays
  `blocked` on EXT-SIGNING; its independent checks (preflight, refusal, verify,
  trust tests) are recorded as done.
