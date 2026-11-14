# Handoff — Studio review (studio-v2)

**Registry:** `.mona/build-macos/reviews/studio-v2/state.json` (revision after the R03 checkpoint)
**Current task:** R03 — completed (review pass applied) · **Next eligible:** R04, R05, R07
**Review document:** `MacMona_Studio_Review_PROMPTS.md` (sha256
`7e1e16d1…`) · **Hotfix:** `MacMona_Review_Hotfix.patch` (sha256
`a253a05e…`, applied unmodified)
**Product ledger:** unchanged authority —
`.mona/build-macos/state.json` is at P23 completed; P22/P25 remain its
eligible prompts. Nothing in this review queue resets P00–P27 or the attempt
counts (`attempts.jsonl` is empty; no problem consumed an attempt).

## Where R03 landed

- **RV-09 / UX-COMMANDS catalogued.** The catalog is the pinned engine's own
  `GET /v1/commands` response, captured from `codewhale 0.10.2` (`ff466b2ed0bf`,
  binary `da022961…`) through an isolated runtime. The TUI slash registry is not
  the CLI subcommand list; only this endpoint enumerates the composer surface.
  `scripts/command-catalog.mjs --capture` is the only path that starts a
  process and makes no turn; `--check` validates the pin, the capture digest,
  unique spellings, descriptions, usage prefixes, and one annotation per row.
- **109 rows, explicitly annotated.** 35 have a documented Runtime API route
  for R04; 69 are TUI-only; 5 are unavailable on 0.10.2 (`/workflow`,
  `/workflows`, `/lane`, `/remote-env`, `/attach`). `/lane` is the one hidden
  row and is reachable only by filtering. `/new` carries its verified
  `session/new.rs` semantics: fresh saved session, refuses while runtime work
  is active, `--force` discards draft/queued input only.
- **Descriptive autocomplete.** `src/renderer/shell/composer-commands.ts` owns
  position detection and ranking; `CommandMenu.tsx` is the labelled listbox and
  detail panel; `Studio.tsx` wires arrows/Tab/Escape/pointer/IME and a measured
  placement; `Shell.tsx` intercepts a recognised command before submission and
  reports its route. Enter stays a newline. A path, escaped slash, indented
  line, fenced paste, or ordinary prose stays prompt text.
- **No execution in R03.** A command is never sent to the model as a prompt;
  the composer explains the route and leaves the draft. R04 owns
  operation-specific IPC and `/new` lifecycle.
- Evidence: `docs/evidence/macos/review-studio/R03-command-catalog.md` with
  `artifacts/r03-commands-capture.json`, `r03-catalog-check.txt`,
  `r03-focused-tests.txt` (96 tests in 5 files), `r03-full-tests.txt` (885 in
  85), `r03-gates.txt`, `r03-command-smoke.json` (26/26), and the captures
  `r03-command-menu.png` / `r03-command-menu-200.png`.
- Gates on the final bytes: typecheck clean, lint 0 errors (3 pre-existing
  `any` warnings), format clean, full suite **891 tests in 85 files**, shell
  smoke **127/127**, command smoke **26/26**. `catalog:check` also runs in
  `npm run ci`. The 24 shell captures the smoke rewrote were re-recorded; some
  screenshot bytes are run-dependent and are committed as this run's record.
- **Independent review (FAIL → fixed).** The verdict failed on evidence, not
  behaviour: the first shell-smoke report predated the final composer bytes.
  Five real defects were also found and fixed with tests: description matches
  made prose "ambiguous" (`/the release is broken`); `aria-controls` pointed at
  a listbox that renders only with rows; arrow keys were swallowed with no rows;
  a replaced draft left a stale caret; the measured panel floor could exceed the
  room available. Both smokes were then re-run on the final bytes and every
  affected hash re-recorded before this checkpoint.
- Ledger hygiene: shared-file evidence in P02, P03, P04, P09, P10 and P18 was
  re-recorded with the R03 full-suite result after the command catalog IPC and
  composer changed those bytes. No assertion was removed and no requirement
  status was lowered.

## Where R02 landed

- **RV-06 fixed.** `ProjectDetail.events` is the newest **page**, and
  `ProjectDetail.history` says what it covers (`olderCursor`, `hasMore`,
  `storedTotal`, `pageSize`). Older pages come from `projects:history`
  (`{ projectId, before?, limit?, threadId? }`); one item's frames come from
  `projects:history-item`. The cursor is a keyset over the store's receipt
  order `(recorded_at, rowid)` — never an engine `seq`, which is one global
  counter and proves nothing about this thread. Loss stays what `event_gaps`
  records.
- **RV-04 extended to identity.** Schema v10 stores `events.item_id` from the
  envelope (falling back to `payload.item.id`), nullable so pre-v10 rows are
  explicitly unknown. The timeline binds deltas and completions by item id, so
  two same-kind items in one thread cannot merge and the streamed and completed
  card share one key. Legacy rows are grouped only within one turn and kind;
  a legacy completion binds only when exactly one such stream can be its source.
- **Partial items are honest.** A card that begins at a page boundary is marked
  partial; with an item id it offers a bounded reload (≤ 4,000 frames), without
  one it says the beginning cannot be reconstructed.
- **Paging is real in the Studio.** "Load earlier events" prepends a page and
  holds the viewport (anchored on a completed page read, not on any event
  change); "Jump to latest" returns to the edge; follow state resets on project
  and thread change. A thread selector labels the project's deterministic local
  thread **current** (`ProjectDetail.currentThreadId`) and the rest **archived**.
- Evidence: `docs/evidence/macos/review-studio/R02-identity-aware-history.md`
  with `artifacts/r02-focused-tests.txt` (107 tests in 7 files),
  `r02-full-tests.txt` (849 in 83), `r02-gates.txt`,
  `r02-history-long-smoke.json`, `r02-shell-smoke.json`, and the capture
  `r02-history-long-session.png`.
- Real Electron long-session smoke: 10,054 stored events, one 2,100-frame turn;
  18/18 checks including `200 shown · 10054 stored`, frame 9850 absent before
  the first page and present exactly once after, anchor delta 0 px, jump
  distance 0 px, connection **Not started** (no runtime, no model request).
- Gates: focused **110**, full **852 tests in 83 files** (was 819/81),
  typecheck clean, lint 0 errors, format clean, history smoke 18/18, existing
  shell smoke **127/127**. One earlier shell-smoke run reported
  `terminal_output: false`; the terminal path is untouched and the immediate
  rerun was green — recorded, not hidden.
- **Post-commit review fixes (`7701f37`):** a failed thread switch snaps the
  selector back to the filter that is really on screen; an interrupted item
  keeps its streamed text; a completion that carries its own text is not
  labelled partial. Each has a test. The history smoke now reports a
  repo-relative screenshot path and captures normalize `/Users/<user>`, so the
  secret scan is clean (582 files, 0 findings).
- Ledger hygiene: the 24 shell captures regenerated by the shell smoke were
  re-recorded through `monabuild evidence` with a note saying the previous hash
  described the pre-R02 bytes. R00/R01 source hashes for files R02 changed are
  marked **historical** (their recorded hash is the state at that task's
  verification), not silently refreshed.

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

Three tasks are eligible now:

- **R04 — execute commands correctly and make `/new` real.** Read the R03
  catalog (`src/shared/commands/pinned-commands.json` + `annotations.json`) and
  the documented `/v1` routes on the `runtime-api` rows. Dispatch through
  operation-specific IPC; never send a recognised command to the model. `/new`
  must be tested idle, busy, disconnected, response-lost, restart, and
  project-switch.
- **R05 — focus Studio and native fullscreen.** Read the existing Focus Mode
  paths, `menu-template.ts`, `window.ts`, and IPC sender validation.
- **R07 — in-app pending input and approvals.** Read `work/studio.ts`
  `pendingInputFor`/`ingest`/`snapshot` and probe the pinned engine's
  request/reply endpoints.

```sh
node tools/monabuild/cli.mjs review status   # next_eligible: R04, R05, R07
```

Do not start R06 (needs R05), R08 (needs R04+R07) or R09–R15.

## Rules that still bind

- Enter is newline; Command-Enter submits; no background inference on UI paths.
- A recognised Codewhale command is never submitted as a prompt. R03 explains
  its route; R04 executes it through a validated native operation. Filtering,
  help, and catalog reads make no process, socket, or model call.
- History reads are state reads: `projects:history` and
  `projects:history-item` start no runtime and ask no model. Page cursors are
  storage positions, never engine sequence numbers; loss is only `event_gaps`.
- The pinned engine stays 0.10.2 with the configured DeepSeek Flash route and
  cost controls untouched.
- Three no-progress attempts stop that problem; log evidence and exact help in
  `BLOCKERS.md`, then continue independent work. Use
  `monabuild attempt/reopen` with stable `RV-*`/`UX-*` problem IDs — the review
  ledger never resets a count.
- Finish a prompt through code, focused validation, docs and a checkpoint
  before reporting.
