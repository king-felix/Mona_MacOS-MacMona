# R04 — Safe command execution and a real `/new` thread lifecycle

**Task:** R04 (prerequisites R02, R03) · **Platform:** darwin-arm64 · **Engine:**
Codewhale 0.10.2 (`ff466b2ed0bf`) · **Requirements:** MONA-022, MONA-030,
MONA-003 · **Feature:** UX-COMMANDS.

R03 catalogued the engine's composer surface and said which route *could* carry
each row. R04 is the execution layer. A recognised command now travels from the
composer through one typed IPC request into the main process, where it resolves
against the same pinned catalog and a curated execution plan. It is never sent
to the model as a prompt, never interpolated into a shell, and never reported as
having happened when it did not.

## What landed

- **One validated request.** `commands:execute` accepts only
  `{ projectId, mode, spelling, arguments, operationKey, confirm?, resolveBusy? }`.
  `spelling` is a bare name or alias; main resolves it against canonical names
  *and* aliases, so `/yasuo` validates exactly like `/compact`. A slash, a space,
  a shell metacharacter, a 4 KiB argument, or an unknown field is rejected at the
  IPC boundary (`src/main/ipc-contract.ts`).
- **A curated route for every row.** `src/shared/commands/execution-plan.ts`
  maps all 109 catalogued commands. The builder refuses to run when a command
  has no route, a route has no command, a native route disagrees with the
  catalog's support claim, or a terminal invocation is not shell-word-only.
  - **native (5):** `new`, `compact`, `retry`, `rename`, `fork` — typed engine
    operations.
  - **view (19):** opens the existing Mona surface that owns the operation
    (Cost, Changes, Board, Agents, Settings › route/extensions, Studio). The
    receipt says Mona opened it and did not run the command.
  - **terminal (80):** the TUI/CLI is the only implementation. The receipt names
    a fixed invocation; the terminal pane is **prefilled** and the user must
    launch it. Typed arguments are never added.
  - **unavailable (5):** `attach`, `lane`, `remote-env`, `workflow`, `workflows`.
- **Native operations report real receipts.**
  - `/new` — see below.
  - `/rename <title>` — `PATCH /v1/threads/{id}` with `{ title }` only; the same
    title is stored locally. The live smoke read the title back from the engine.
  - `/compact` — `POST /v1/threads/{id}/compact`; the engine's own message is
    reported. It may spend, so it asks first.
  - `/fork` — `POST /v1/threads/{id}/fork` (with the command key as
    `operation_key`); the fork becomes a new generation in the same project and
    the source thread stays readable.
  - `/retry` — `POST /v1/threads/{id}/retry`; the engine forks and starts a turn,
    Mona adopts the fork and attaches the stream. It is *not* described as an
    in-place retry, and a repeated key is refused rather than blindly repeated.
- **`/new` is a real conversation lifecycle.** Schema v11 adds
  `threads.mode`, `threads.generation` and `command_operations`. `/new` allocates
  a new generation, records the operation key **before** the engine write,
  creates a fresh engine thread with a deterministic key
  (`thread-<project>-<mode>-<generation>`), and rebinds the studio. Every earlier
  conversation keeps its local row, events, turns, drafts, usage and attempt
  evidence; the thread selector already labels it `archived`.
- **Busy work is an explicit choice.** With a turn running, `/new` refuses with
  the turn id and two named options. The renderer shows a dialog with **Wait**
  and **Interrupt and start a new conversation**; only the second path calls the
  interrupt, and only a *confirmed* interrupt clears the in-memory turn. The
  receipt says the old turn's final frame is stored when that conversation is
  next opened, rather than claiming it moved.
- **Disconnected is honest.** Offline `/new` creates the local generation and
  says the engine thread is deferred. The next submission creates it with the
  same deterministic key; no fake engine identity is invented.
- **Retry-safe operation keys.** A lost response, a double click, or a restart
  resolves the recorded key instead of allocating a second conversation. A
  completed key returns its first receipt (`duplicate: true`); a deferred
  conversation stays pending and is resumed, not replayed as a failure.
- **Review boundaries.** `compact` and `retry` return
  `confirmation-required` until the user confirms, listing the cost class and
  effects. Nothing is sent before that.
- **Literal text stays available.** A leading space, a second slash, a fenced
  block, or an indented line remains prose; the command notice says how to send
  a command as text. A leading-space `/new …` is tested at the renderer
  boundary.
- **Routes stay visible.** The command detail now says what Command-Enter will
  do for each support class instead of "execution is not wired yet".

## Command-to-route matrix (109 rows)

Counts: **native 5 · view 19 · terminal 80 · unavailable 5**.

| Command | Catalog support | Route | Target |
| --- | --- | --- | --- |
| `/advisor` | terminal-only | terminal | `codewhale` (prefill only) |
| `/agent` | terminal-only | terminal | `codewhale` (prefill only) |
| `/anchor` | terminal-only | terminal | `codewhale` (prefill only) |
| `/attach` | unavailable | unavailable | — |
| `/auth` | terminal-only | terminal | `codewhale auth` (prefill only) |
| `/auto` | terminal-only | terminal | `codewhale` (prefill only) |
| `/automation` | runtime-api | terminal | `codewhale` (prefill only) |
| `/balance` | terminal-only | terminal | `codewhale account` (prefill only) |
| `/branch` | terminal-only | terminal | `codewhale` (prefill only) |
| `/cache` | terminal-only | terminal | `codewhale` (prefill only) |
| `/change` | terminal-only | terminal | `codewhale` (prefill only) |
| `/clear` | terminal-only | terminal | `codewhale` (prefill only) |
| `/color` | terminal-only | terminal | `codewhale` (prefill only) |
| `/compact` | runtime-api | native | compact (asks first) |
| `/config` | runtime-api | view | settings › route |
| `/connect` | terminal-only | terminal | `codewhale login` (prefill only) |
| `/constitution` | runtime-api | terminal | `codewhale` (prefill only) |
| `/context` | runtime-api | view | studio |
| `/copy` | terminal-only | terminal | `codewhale` (prefill only) |
| `/cost` | runtime-api | view | cost |
| `/diff` | runtime-api | view | changes |
| `/disconnect` | terminal-only | terminal | `codewhale logout` (prefill only) |
| `/edit` | terminal-only | terminal | `codewhale` (prefill only) |
| `/effort` | terminal-only | terminal | `codewhale` (prefill only) |
| `/exit` | terminal-only | terminal | `codewhale` (prefill only) |
| `/export` | terminal-only | terminal | `codewhale` (prefill only) |
| `/feedback` | terminal-only | terminal | `codewhale` (prefill only) |
| `/fleet` | runtime-api | view | agents |
| `/fork` | runtime-api | native | fork |
| `/fullscreen` | terminal-only | terminal | `codewhale` (prefill only) |
| `/goal` | runtime-api | view | agents |
| `/help` | terminal-only | terminal | `codewhale help` (prefill only) |
| `/hf` | terminal-only | terminal | `codewhale` (prefill only) |
| `/home` | terminal-only | terminal | `codewhale` (prefill only) |
| `/hooks` | runtime-api | view | settings › extensions |
| `/hotbar` | terminal-only | terminal | `codewhale` (prefill only) |
| `/import-claude` | terminal-only | terminal | `codewhale` (prefill only) |
| `/init` | terminal-only | terminal | `codewhale init` (prefill only) |
| `/inline` | terminal-only | terminal | `codewhale` (prefill only) |
| `/jobs` | runtime-api | terminal | `codewhale` (prefill only) |
| `/lane` | unavailable | unavailable | — |
| `/links` | terminal-only | terminal | `codewhale` (prefill only) |
| `/load` | terminal-only | terminal | `codewhale` (prefill only) |
| `/login` | terminal-only | terminal | `codewhale login` (prefill only) |
| `/logout` | terminal-only | terminal | `codewhale logout` (prefill only) |
| `/lsp` | runtime-api | terminal | `codewhale` (prefill only) |
| `/mcp` | runtime-api | view | settings › extensions |
| `/memory` | terminal-only | terminal | `codewhale` (prefill only) |
| `/mode` | terminal-only | terminal | `codewhale` (prefill only) |
| `/model` | runtime-api | view | settings › route |
| `/modeldb` | terminal-only | terminal | `codewhale` (prefill only) |
| `/models` | runtime-api | view | settings › route |
| `/network` | terminal-only | terminal | `codewhale` (prefill only) |
| `/new` | runtime-api | native | new |
| `/note` | terminal-only | terminal | `codewhale` (prefill only) |
| `/overview` | terminal-only | terminal | `codewhale` (prefill only) |
| `/permissions` | terminal-only | terminal | `codewhale` (prefill only) |
| `/pet` | terminal-only | terminal | `codewhale` (prefill only) |
| `/pin` | terminal-only | terminal | `codewhale` (prefill only) |
| `/plugin` | runtime-api | view | settings › extensions |
| `/preview-request` | terminal-only | terminal | `codewhale` (prefill only) |
| `/profile` | terminal-only | terminal | `codewhale` (prefill only) |
| `/provider` | runtime-api | view | settings › route |
| `/purge` | terminal-only | terminal | `codewhale` (prefill only) |
| `/queue` | terminal-only | terminal | `codewhale` (prefill only) |
| `/rc` | terminal-only | terminal | `codewhale rc` (prefill only) |
| `/receipts` | runtime-api | terminal | `codewhale receipts --last --format json` (prefill only) |
| `/relay` | terminal-only | terminal | `codewhale` (prefill only) |
| `/remote-env` | unavailable | unavailable | — |
| `/rename` | runtime-api | native | rename |
| `/restore` | runtime-api | view | changes |
| `/resume` | runtime-api | terminal | `codewhale sessions` (prefill only) |
| `/retry` | runtime-api | native | retry (asks first) |
| `/review` | terminal-only | terminal | `codewhale review` (prefill only) |
| `/rlm` | terminal-only | terminal | `codewhale` (prefill only) |
| `/router` | terminal-only | terminal | `codewhale` (prefill only) |
| `/save` | terminal-only | terminal | `codewhale` (prefill only) |
| `/sessions` | runtime-api | terminal | `codewhale sessions` (prefill only) |
| `/settings` | terminal-only | terminal | `codewhale` (prefill only) |
| `/setup` | terminal-only | terminal | `codewhale setup` (prefill only) |
| `/share` | terminal-only | terminal | `codewhale` (prefill only) |
| `/skill` | runtime-api | view | settings › extensions |
| `/skills` | runtime-api | view | settings › extensions |
| `/stash` | terminal-only | terminal | `codewhale` (prefill only) |
| `/status` | terminal-only | terminal | `codewhale` (prefill only) |
| `/statusline` | terminal-only | terminal | `codewhale` (prefill only) |
| `/structcopy` | terminal-only | terminal | `codewhale` (prefill only) |
| `/subagents` | runtime-api | view | agents |
| `/system` | terminal-only | terminal | `codewhale` (prefill only) |
| `/task` | runtime-api | view | board |
| `/theme` | terminal-only | terminal | `codewhale` (prefill only) |
| `/title` | terminal-only | terminal | `codewhale` (prefill only) |
| `/tokens` | runtime-api | view | cost |
| `/tools` | terminal-only | terminal | `codewhale` (prefill only) |
| `/transcript` | terminal-only | terminal | `codewhale` (prefill only) |
| `/translate` | terminal-only | terminal | `codewhale` (prefill only) |
| `/tree` | terminal-only | terminal | `codewhale` (prefill only) |
| `/trust` | runtime-api | view | settings › extensions |
| `/turn` | terminal-only | terminal | `codewhale` (prefill only) |
| `/undo` | runtime-api | terminal | `codewhale` (prefill only) |
| `/update` | terminal-only | terminal | `codewhale update` (prefill only) |
| `/verbose` | terminal-only | terminal | `codewhale` (prefill only) |
| `/voice` | runtime-api | terminal | `codewhale speech` (prefill only) |
| `/voicecontrol` | runtime-api | terminal | `codewhale` (prefill only) |
| `/voicesend` | runtime-api | terminal | `codewhale` (prefill only) |
| `/workbar` | terminal-only | terminal | `codewhale` (prefill only) |
| `/workflow` | unavailable | unavailable | — |
| `/workflows` | unavailable | unavailable | — |
| `/workspace` | terminal-only | terminal | `codewhale` (prefill only) |

## Live engine evidence (`artifacts/r04-command-execute-smoke.json`)

`npm run smoke:commands:live` starts the pinned engine in an isolated HOME and
workspace, drives the real `WorkStudio` and `CommandDispatchService`, and
submits **no turn**. `/new` creates threads only, so the run makes zero provider
requests: the engine reports `turns: 0` with no spend, and the Studio label is
"No usage recorded".

This table is the shape of one run; the local and engine ids it produced are
per-run values and live only in the artifact, so this page cannot drift from
them.

| Step | Route | Status |
| --- | --- | --- |
| `/new` #1 | native | completed — generation 0 |
| `/new` #2 | native | completed — generation 1 |
| `/new` #3 (`--force`) | native | completed — generation 2 |
| `/new` #2 again (same key) | native | completed, `duplicate: true`, same two ids |
| `/rename Live smoke title` | native | completed; the engine's own thread record carries the title |
| `/cost` | view | completed (opens the Cost lens) |
| `/theme` | terminal | deferred, prefilled `codewhale` |
| `/workflow` | unavailable | not-executable |
| `/compact` | native | confirmation-required (nothing sent) |
| `/new ; rm -rf /` | native | invalid-argument (no thread) |

The artifact's own assertions, all `true` on the committed run:

- `three_generations` — generations 0, 1 and 2 each allocated once;
- `distinct_engine_threads` — three different engine thread ids;
- `duplicate_returns_same_thread` — the repeat key returned the same local and
  engine thread and created nothing;
- `rename_route_completed` and `rename_confirmed_by_engine` — a follow-up
  `GET /v1/threads/{id}` returned the title Mona set;
- `view_route`, `terminal_route`, `unavailable_route` — the three non-native
  shapes each reported honestly;
- `spend_needs_confirmation` — `/compact` sent nothing before confirmation;
- `injection_refused` — `/new ; rm -rf /` was refused as an argument;
- `no_provider_usage` and `no_model_request` — `turns: 0`, no spend.

The engine's thread list contains the three created threads, and the local rows
keep generations 0 and 1 beside generation 2. Cleanup stopped the isolated
runtime (`SIGTERM`, exit within the 5 s grace) and no user store was touched. The
runtime token travelled in `CODEWHALE_RUNTIME_TOKEN`, never on the process list.

## Fixture evidence: the scenarios a live run must not spend on

`test/studio-new-thread.test.ts` (18 tests) drives the real `WorkStudio` over a
deterministic transport:

- **idle `/new`** — generation 0 → 1, a second engine `POST /v1/threads`, the
  first row, its events and its cursor still present;
- **busy refusal** — a turn is active; `/new` returns `busy`, names the turn and
  creates nothing;
- **explicit interrupt** — only `resolveBusy: "interrupt"` calls the interrupt;
  a confirmed receipt allows the new generation, an unconfirmed one creates
  nothing;
- **disconnected** — `/new` creates the local generation and defers the engine
  thread; the next submission creates it with `thread-<project>-work-0`;
- **response lost** — the first engine create fails after the local row is
  written; the same key resumes the same generation, and the engine sees the
  same `operation_key` (one thread create, not two);
- **repeat key** — a completed key returns its first receipt and allocates
  nothing;
- **restart** — a second `WorkStudio` over the same store continues at generation
  2 instead of reusing generation 0;
- **pre-R04 project** — a thread written with the old deterministic id is adopted
  as generation 0 and keeps its engine thread; no second conversation and no new
  engine create;
- **project switch** — `/new` on a project with no session changes only that
  project's local state and leaves the bound project's conversation untouched;
- **native operations** — rename patches the engine and the local title, compact
  reports the engine's message, fork adopts a sibling generation and keeps the
  source, retry adopts the fork and attaches its turn, and all four refuse with
  `NOT_CONNECTED` when nothing is bound;
- **active turn** — fork and compact refuse with `TURN_ACTIVE` and the turn stays
  attached; nothing rebinds the conversation under a running turn;
- **crash window** — a pending key whose thread row was lost resumes the
  generation it recorded, so it cannot reuse the first conversation's engine key;
- **durable receipts** — rename, compact and fork each leave a completed
  `command_operations` row, so a repeat key has something to find;
- **deferred generation** — a deferred `/new` records its generation with the
  key, and resuming it reuses that conversation instead of allocating another.

`test/command-dispatch.test.ts` (15 tests) walks **all 109 rows** through the
dispatcher and asserts the declared route, that aliases resolve, that an unknown
spelling is rejected, that view/terminal/unavailable routes never call the
studio, that a terminal invocation cannot absorb typed text, that argument rules
hold, that a spend asks first, that a completed key is reused, that a key cannot
cross commands or projects, and that a busy `/new` keeps the choice visible.

`test/command-execution-plan.test.ts` (7 tests) proves the plan covers every row
exactly once, that only the five native operations exist, that every terminal
invocation matches a fixed shell-word grammar, and that the five unavailable
rows are the engine's own gaps.

`test/shell-races.test.tsx` adds thirteen renderer tests: an argument-bearing
command reaches main with the exact bytes, a non-`/new` command keeps the
composer, a confirmation reuses the operation key, a busy `/new` offers Wait vs
Interrupt, a command that cannot use an interrupt offers only Close, a completed
`/new` clears only the dispatched line and selects the new conversation, text
typed while a `/new` dispatch is in flight survives it and is reported as kept,
the composer re-keys to the new conversation after `/new`, a send is refused
while the reader is looking at an earlier conversation, a conversation-rewriting
command is refused from an archive view while a view command is still allowed,
a busy `/new` keeps the typed line, a leading-space line is still sent as prose,
and a repeated Command-Enter dispatches once.

`test/ipc-contract.test.ts` adds four tests: the typed request is accepted;
slashes, shell words, embedded spaces, `$(…)` and traversal are rejected;
oversized arguments, bad keys, unknown fields and unknown busy modes are
rejected; and the engine's real non-ASCII and punctuation aliases (`语音`, `?`,
`接力`) are accepted, because a rule that refused them would make a catalogued
command undispatchesable.

## Gates on the final bytes

| Check | Result | Artifact |
| --- | --- | --- |
| Focused tests (5 files) | 109 passed | `artifacts/r04-focused-tests.txt` |
| Full suite | **948 passed in 88 files** (was 891 in 85 at R03) | `artifacts/r04-full-tests.txt` |
| `npm run typecheck` | clean (main + renderer) | `artifacts/r04-gates.txt` |
| `npm run lint` | 0 errors; 3 pre-existing `any` warnings | `artifacts/r04-gates.txt` |
| `prettier --check .` | clean | `artifacts/r04-gates.txt` |
| Live engine smoke | every assertion true; 0 model requests | `artifacts/r04-command-execute-smoke.json` |

One full-suite run reported `runtime-process.test.ts > stops a verified orphan
record before starting a new owner` failing with `SUPERVISOR_UNAVAILABLE`
instead of `STARTUP_FAILED`. The file passes 3/3 in isolation and the next full
run was 948/948 green; it is recorded as a load flake under 88 concurrent
workers, not fixed and not hidden.

## What is not claimed

- **80 terminal routes do not execute the command.** Mona prefills a fixed
  invocation and waits for the user. Some are verified CLI subcommands
  (`codewhale login`, `codewhale sessions`, `codewhale receipts --last --format
  json`, …); the rest are TUI-local and the pane opens the TUI (`codewhale`).
  Nothing is reported as run.
- **`/compact [focus]`**: the focus argument is TUI-only. It is refused with an
  explanation rather than silently dropped.
- **`/retry` is not idempotent at the engine.** It forks and starts a turn. A
  repeated operation key is refused rather than re-issued; a lost response is an
  uncertain attempt the user must check, not a retry Mona performs.
- **Busy and interrupt were proved with a deterministic adapter, not a paid
  turn.** A live model turn is P24/R13 interactive QA. The interrupt receipt is
  the engine's own; an unconfirmed one creates nothing.
- **The old turn's final frame after an interrupt** is stored when that
  conversation is next opened, because the single pump moves to the new
  conversation. The receipt says this rather than claiming the turn moved.
- **`/new` and drafts.** Mona's composer draft is keyed to the project's local
  thread. `/new` claims the dispatch identity *before* the engine call, so only
  the exact submitted revision is cleared: text typed while the call was in
  flight changes the revision and is preserved. Per-conversation draft switching
  is not introduced here.
- **A host at 99% disk stopped the suite twice.** The cause was this repo's own
  test residue: `tempDir()` in `test/helpers/state.ts` created a `mona-*`
  directory per store and never removed it, so 94,112 trees (33.7 GB) had
  accumulated in the host temp directory. `test/helpers/temp.ts` now registers
  each directory and removes it when the file's tests finish (one sweep per
  file, so a later test never loses a fixture a sibling still needs). Files that
  call `mkdtemp` directly still leave a handful of small directories per run
  (147 / 0.5 MB observed); that residue is bounded and recorded, not hidden.
  The regenerable `packaging/macos/out/stage` copy was also removed to finish a
  run; no receipt or package artifact was touched.
- **Reading an earlier conversation is read-only.** Selecting an archived thread
  in the Studio filters the transcript. The composer is then disabled with a
  stated reason, because a send would go to the current conversation and the
  reader would be looking at a different one. Nothing is discarded.
- **The interrupted conversation's transcript is not re-read.** `/new` after a
  confirmed interrupt moves the single pump to the new conversation, so the old
  thread's final frame is stored the next time that thread is opened. The
  receipt says this; it does not claim the turn moved. The connection returns to
  `connected` only when it really was `running`.
- **Views open the owner, they do not perform the command.** `/restore` opens
  Changes (whole-workspace restore remains MONA-CAP-063); `/config`, `/model`,
  `/provider` open Settings › Providers & route; `/mcp`, `/skills`, `/plugin`,
  `/hooks`, `/trust` open Settings › Extensions where their own boundaries
  apply. The receipt always says the command was not run.
- **Concurrent `/new` with different keys** is safe by deterministic thread ids
  and serialized store writes, not by an explicit per-project lock. Two
  simultaneous intents could resolve to the same generation; they cannot create
  two engine conversations under the same key.
- **`/fork`, `/compact` and `/retry` start a change the engine owns.** `/fork`
  and `/compact` refuse while a turn is active rather than rebinding the
  conversation under it. `/retry` forks and starts a turn; a repeated key is
  refused rather than re-issued, and a lost response is an uncertain attempt the
  user must check.

## Files

- `src/shared/contracts/command-execution.ts` — request, route plan, receipt and
  thread-receipt types.
- `src/shared/commands/execution-plan.ts` — the 109-row plan and its validation.
- `src/main/work/commands.ts` — catalog + plan service; alias-preserving resolve.
- `src/main/work/command-dispatch.ts` — the one dispatcher; native, view,
  terminal and unavailable receipts; argument and confirmation rules.
- `src/main/work/studio.ts` — generation-aware bindings, `/new`, rename,
  compact, fork and retry receipts.
- `src/main/engine/adapter.ts`, `src/main/engine/types.ts` — `renameThread`,
  `compactThread`, `forkThread`, `retryThread` with wire validation.
- `src/main/state/schema.ts`, `src/main/state/store.ts` — migration v11
  (`threads.mode`, `threads.generation`, `command_operations`) and the store API.
- `src/main/ipc.ts`, `src/main/ipc-contract.ts`, `src/preload/index.ts`,
  `src/shared/contracts/bridge.ts` — `commands:execute`.
- `src/renderer/shell/Shell.tsx`, `src/renderer/shell/composer-commands.ts` —
  dispatch, the confirm/busy dialog, the `/new` draft boundary, the typed
  spelling, and the literal-text escape.
- `scripts/command-execute-smoke.mjs` — the isolated live run.
- Tests: `test/command-execution-plan.test.ts`, `test/command-dispatch.test.ts`,
  `test/studio-new-thread.test.ts`, `test/ipc-contract.test.ts`,
  `test/shell-races.test.tsx`.
