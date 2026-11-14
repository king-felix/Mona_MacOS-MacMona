# Decisions — Mona macOS build

Durable decisions with rationale. Newest first. Product decisions from the
specification are not repeated here; this file records implementation choices
and deviations discovered while building.

## D-009 — The local repository history is not yet shareable

- **Date:** 2026-11-11 (P00)
- **Observation:** During P00 the hash index briefly recorded the absolute
  workspace path, and the committed tree of one intermediate commit
  (`bf552a9`) therefore contains a home-directory path. The current tree is
  clean: the path was removed from the generator, from all captured artifacts,
  and from `index.json`; a scanner check now fails on this machine's home
  directory appearing in any tracked file.
- **Decision:** Do not rewrite history for a local-only repository with no
  remote. Record the fact instead.
- **Consequence:** Publishing or sharing this repository requires either a
  history rewrite or a fresh export. Nothing here is a credential, and no remote
  has received these objects.

## D-008 — Local Git repository only, no remote

- **Date:** 2026-11-11 (P00)
- **Decision:** Initialize this directory as a local Git repository and make
  local checkpoint commits. No remote is configured.
- **Why:** Spec §17 requires a local checkpoint commit when Git is available;
  no authorized Mona remote exists on this machine, and inventing one is
  forbidden. Pushing remains a separate, explicitly authorized action.
- **Consequence:** History exists for reconciliation and rollback on this Mac.
  Remote coordination with the Windows build waits for a real repository.

## D-007 — Engine pinned to installed Codewhale 0.10.2

- **Date:** 2026-11-11 (P00)
- **Decision:** Treat `/opt/homebrew/lib/node_modules/codewhale` (npm wrapper)
  and its native ad-hoc-signed arm64 binary (SHA-256
  `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`) as the
  pinned engine for compatibility work.
- **Why:** Compatibility must be established against the installed binary
  (spec §2.1). Silent upgrades would invalidate every qualification.
- **Consequence:** P01 qualifies this exact build. Any later change is a
  deliberate, re-tested compatibility decision recorded here, not an automatic
  update. Because the binary is only linker-signed, P21/P22 must re-sign it and
  record both digests.

## D-006 — No full Xcode: CLT-based native plan, flagged early

- **Date:** 2026-11-11 (P00)
- **Measured:** `xcode-select -p` is `/Library/Developer/CommandLineTools`;
  `xcodebuild` fails; CLT SDK 14.4, Swift 5.10, clang 15.0.0.
- **Decision:** Proceed with CLT (`swiftc`, `codesign`, `pkgbuild`,
  `productbuild`) for the P02/P09 native helpers, and surface a named build
  prerequisite if a later step genuinely requires a full Xcode installation or
  `.xcodeproj` target. Do not fake Xcode-only steps.
- **Why:** Full Xcode is a large install; the spec permits authorized installs
  but does not require one where CLT suffices. Recipient machines must never
  need developer tools at all.

## D-005 — Attempt counters live in an append-only ledger, enforced in code

- **Date:** 2026-11-11 (P00)
- **Decision:** `.mona/build-macos/attempts.jsonl` records every hypothesis →
  observed-result cycle. `monabuild attempt` refuses a fourth consecutive
  no-progress attempt; `monabuild reopen` requires a named human decision or new
  evidence. Counters are recomputed from disk on every read.
- **Why:** Spec §8.4 requires counters that survive sessions and cannot be reset
  by convenience. Enforcement in the tool is mechanism; prose alone is not.
- **Consequence:** Engine-internal loops remain only cooperatively observable;
  the ledger enforces Mona's own dispatch discipline and says so.

## D-004 — Requirements registry is generated, status is merged

- **Date:** 2026-11-11 (P00)
- **Decision:** `docs/requirements-macos.json` is generated deterministically
  from the two Markdown specifications (prompt map, requirement tables, prompt
  counts, dependency order). Regeneration preserves recorded requirement status
  and evidence; the generated structure itself is never hand-edited.
- **Why:** The spec demands that every referenced ID exists and the graph is
  acyclic (spec §3). Deriving it from the documents removes transcription drift;
  merging preserves traceability across regenerations. Skill/tool output is not
  trusted over the checked file: `monabuild validate` re-checks hashes.

## D-003 — `.mona/build-macos/state.json` is the single runtime authority

- **Date:** 2026-11-11 (P00)
- **Decision:** Prompt status, current prompt, evidence pointers, and blockers
  live in one validated JSON document with monotonic revisions. Writes are
  atomic, revision-checked, single-writer, and backed up.
- **Why:** Spec §8.3. A single authority makes conflict detection real instead
  of conventional.
- **Consequence:** `monabuild recover` restores the last committed revision from
  `state.json.bak` and preserves damaged copies as evidence.

## D-002 — Zero-dependency Node utility for the build ledger

- **Date:** 2026-11-11 (P00)
- **Decision:** Implement `tools/monabuild` with Node's standard library only
  (custom JSON-Schema subset, `node:fs` atomic writes, `node:test`).
- **Why:** P00 must not choose the product's schema library or test runner;
  P02 owns that. A dependency-free bootstrap avoids installing packages before
  the product stack is pinned and keeps the tool auditable.
- **Consequence:** The validator is intentionally narrow; unknown keywords are
  ignored. Product schemas at P02 use the chosen product library.

## D-001 — This directory is the Mac build root

- **Date:** 2026-11-11 (P00)
- **Decision:** Build in the current workspace directory (`<workspace>`) on a local APFS
  volume, as Victor directed, rather than creating `~/Developer/Mona-macOS`.
- **Why:** The user's current request names this working directory. No common
  Windows source tree exists here, so no shared worktree conflict arises.
- **Consequence:** The Mac ledger is `.mona/build-macos/`; the Windows
  `.mona/build/` ledger and Windows sources are untouched and absent here.

## D-010 — Runtime transport, binary, and serialized ownership

- **Date:** 2026-11-11 (P01)
- **Decision:** Mona integrates through `codewhale app-server --http` (canonical
  `/v1/*` HTTP/SSE Runtime API) and launches the self-contained native arm64
  binary directly, with the bearer token supplied only through
  `CODEWHALE_RUNTIME_TOKEN`. One owned runtime per user store; project execution
  is serialized until independent coexistence is proven.
- **Why:** P01 exercised the full surface: thread/turn lifecycle, SSE replay and
  live events, history, interrupt, session export/resume, usage, and
  provider/model identity. `--stdio` is tool-free only; `--socket` adds a second
  auth/attach model without extra capability. The native binary starts with no
  Node on PATH and links only system frameworks. A second `app-server` was
  measured to attach to the first Runtime owner (the first PID owned both ports
  and the first token authenticated the second port), so claiming parallel
  runtimes would be false.
- **Consequence:** P02/P04 must supervise the process tree (the listener is a
  grandson of the npm wrapper) and verify socket ownership, not just an HTTP
  response. P03 builds the adapter against `/v1/*`. Parallel execution needs a
  future, tested compatibility decision or native engine support. Creating a
  separate `CODEWHALE_HOME` to force isolation is forbidden.

## D-011 — Desktop stack and IPC boundary

- **Date:** 2026-11-11 (P02)
- **Decision:** Electron 45.3.0 + React 19 + TypeScript 5.9 + Vite 8 + Zod 4 +
  Vitest 5, npm with a pinned lockfile; one narrow preload bridge with strict
  Zod IPC, trusted-sender checks, renderer isolation and a `connect-src 'none'`
  CSP. Details: `docs/decisions/ADR-001-desktop-stack.md` and
  `docs/decisions/ADR-002-ipc-boundary.md`.
- **Why:** P02 needs a real security boundary and a reproducible local build
  before any engine work. The narrow bridge and strict schemas make malformed
  IPC a test failure instead of a convention; the observed smoke run caught a
  real no-payload defect. Vite's static `file://` build avoids shipping a dev
  server or remote origin.
- **Consequence:** Adding a renderer capability requires a deliberate schema,
  handler, bridge method, and test. No raw Electron API, Node built-in, upstream
  wire type, or secret may cross into the renderer. Electron upgrades re-run the
  security smoke and bundle baseline.

## D-012 — Adapter compatibility, submission safety, and stream typing

- **Date:** 2026-11-11 (P03)
- **Decision:** The adapter fails closed on any engine version/commit other than
  Codewhale 0.10.2 at `ff466b2ed0bf`, persists submission intent before the POST,
  reconciles lost responses only through the read-only operation lookup, and
  never retries a possibly accepted write. Streams distinguish durable events,
  progress transport frames, diagnostics, and terminal `stream.end`; the
  projector deduplicates by per-thread `seq`. Effective route and permission
  posture are read from the turn, not inferred from the request.
- **Why:** P03 must not duplicate billed work or mutate another thread. The
  pinned API's progress frames have no timestamp/payload and are not events;
  treating them as durable caused a real schema-drift diagnostic until the
  distinction was made explicit. The P01 measurement that the listener is a
  native grandchild also rules out the npm wrapper for owned runtime control.
- **Consequence:** P04 builds supervision on `runtime-process.ts`; P05 replaces
  the submission store without changing the persist-before-send contract. A new
  engine version is an explicit re-qualification, not an adapter setting.

## D-013 — Owned runtime supervision and desktop lifecycle

- **Date:** 2026-11-11 (P04)
- **Decision:** Each owned runtime is led by a native arm64 Swift supervisor
  (`native/macos-supervisor`) spawned with the engine as its child. The
  supervisor receives an owner-liveness pipe on fd 3 (token line, then EOF),
  places the child in its own process group, samples descendants as
  `(pid, start time)`, and stops the verified tree with TERM → bounded grace →
  KILL only verified survivors. A mode-0600 control socket returns status and
  stop receipts. Ownership records are atomic, 0600, and never contain the
  bearer token. One owned runtime per user store; a second workspace gets
  `ALREADY_OWNED`. Stale records are reconciled only through verified identity;
  a reused pid or foreign executable is never signalled. The desktop is a
  single instance; close-window keeps work, renderer crash does not touch the
  runtime, sleep becomes `reconnecting`, resume probes health, and crashes
  restart the process only with a bounded backoff. Quit interrupts then stops
  the owned tree; pause-after-task, interrupt-now, cancel-queued, and
  quit-and-stop remain distinct transitions. Full rationale:
  `docs/decisions/ADR-003-runtime-supervisor.md`.
- **Why:** P01 proved the listener can be a grandchild and that parallel runtime
  ownership is unsupported. P03's single-pid stop could not prove descendant
  cleanup, could not distinguish a reused pid from an owned one, and had no
  owner-death channel. P04 needs a stop receipt that is earned, not inferred,
  and must never kill by name or kill a stranger occupying a port.
- **Consequence:** Packaging (P21) must ship the compiled supervisor beside app
  resources; release signing is P22. P05 replaces the JSON ownership record with
  the transactional store without changing identity or token rules. P07 reads
  `RuntimeSupervisor.status()` for real UI state. A physical lid-close sleep was
  not performed; suspend/resume is qualified with Electron power events and
  unit tests, and the limitation is recorded in the P04 evidence.

## D-014 — Stop receipts must be earned, not inferred

- **Date:** 2026-11-11 (P04, review follow-up)
- **Decision:** A `SupervisorStopReceipt` carries `verified`. Only the
  supervisor's control socket can prove the whole tree is gone; the
  supervisor-unreachable signal fallback signals the verified child and the
  group it leads (only when `pgid === childPid`) and reports `verified: false`.
  An unverified stop is recorded as `failed`, not `stopped`, and reclassified
  at the next launch. A restart is allowed only when the supervisor emitted a
  `stopped` receipt with no survivors; otherwise the record becomes
  `STOP_UNVERIFIED` and no restart or second owner happens. The adapter layer
  independently refuses a start when a live/orphaned record exists for the same
  canonical workspace, and refuses records it cannot prove it owns. Starts are
  serialized. The supervisor re-samples descendants during the stop grace
  period, filters zombies on both sides, applies an owner stop that arrives
  mid-spawn to the new child, and lets only one caller own the stop so a racing
  SIGTERM cannot abandon the tree.
- **Why:** Review showed three ways to claim a stop that was not proven: a
  supervisor killed while the engine lived (then restarting beside it), a
  fallback that could not see escaped descendants, and a wake restart that
  ignored an incomplete stop. All three would produce two owners on one user
  store or a false "stopped".
- **Consequence:** `npm test` now builds the supervisor first (`pretest`) and
  the native suite fails rather than skips on this arm64 host, so the native
  guarantees are actually executed by the default test command. Escaped
  descendants remain untrackable when the supervisor is already gone; that is
  reported as unverified rather than hidden.

## D-015 — SQLite project state, single writer, and recoverable migrations

- **Date:** 2026-11-11 (P05)
- **Decision:** Product state uses Electron's built-in `node:sqlite`
  (`DatabaseSync`) with WAL, `synchronous=FULL`, foreign keys, one write path,
  per-row revisions, and checksummed migrations. A maintenance barrier gates
  every reader/writer; backups/snapshots and restore take it exclusively. A
  pre-migration snapshot is taken with the online backup API and recorded in a
  durable journal. Failed migrations restore the snapshot; the failed database
  and journal are preserved, never unlinked. Project identity is canonical path
  plus `(dev, ino)` with path history, so aliases cannot duplicate a project and
  relocation is deliberate. Engine history remains authoritative; runtime
  bindings and artifact bytes are machine-local and excluded from portable
  export. Full rationale: `docs/decisions/ADR-004-project-state.md`.
- **Why:** P03/P04 already required durable submission intent and ownership
  records but used small JSON files. P05 needs multi-table transactions,
  revision checks, crash recovery, and a barrier that can quiesce adapter
  ingestion, indexing, and task execution. `node:sqlite` avoids a native module
  rebuild per Electron upgrade; its API surface was verified in both the host
  Node 26.13.0 and Electron 45's Node 24.22.2, including online `backup()`.
- **Consequence:** P07 reads the catalog and view state through `StateStore`;
  P08 records events and usage through the same write path. A second macOS
  account was not created here; P24 owns the literal multi-user test. Network
  filesystem classification depends on `/usr/bin/stat -f %T` and is skipped if
  unavailable, which the P24 host audit must confirm.

## D-016 — Design tokens, measured contrast, and an explicit harness

- **Date:** 2026-11-11 (P06)
- **Decision:** Daybreak and Afterglow are defined once in
  `src/renderer/design/tokens.ts` and applied as CSS custom properties; the
  structural stylesheet contains no palette values. Twenty-three foreground/
  background pairs per theme are measured in tests (16 text at 4.5:1, 7 UI at
  3:1). The specification's coral becomes a decorative accent; normal danger text
  uses the darker `#B8324C`. Interactive borders are strengthened to meet 3:1.
  Focus uses an explicit `:focus { outline: 2px solid var(--focus) }` so the
  indicator does not depend on Chromium's `:focus-visible` heuristic. The P06
  renderer is a labeled fixture harness with local SVG icons and system fonts;
  P07 replaces it with the real catalog and engine state.
- **Why:** The starting palette is explicitly "subject to measured contrast
  validation"; coral-on-white measured 4.10:1 and interactive borders measured
  far below 3:1. A design system that assumed its own hex values would ship an
  inaccessible shell. The harness keeps P06's visual work honest while P07 wires
  real state.
- **Consequence:** Every new color pair is added to `CONTRAST_PAIRS` before it is
  used in a component. axe remains a semantics check; contrast stays a direct
  token measurement because jsdom has no layout engine. P26 collects human
  aesthetic review; the P06 evidence does not claim it already occurred.

## D-017 — Real catalog authority, typed IPC results, and honest engine state

- **Date:** 2026-11-11 (P07)
- **Decision:** The shell reads the catalog and project detail through one
  `ProjectService` over `StateStore`; every mutation is a strict IPC channel that
  returns `{ok,value}` or `{ok:false,error:{code,message,details}}`. Project ids
  are branded; revisions are required for mutations; no channel deletes files.
  Opening a project ensures at most one local shell thread and never resumes
  work. Engine state comes from the supervisor plus the project binding:
  `canExecute` is true only when a running runtime serves this project's
  canonical workspace. Model and permission are reported as “not reported” and
  “unknown” until a turn reports them. Draft and view state are per project; the
  native menu opens the real folder dialog and sends the project id to the shell.
  The P06 harness remains reachable only through `?harness=1`.
- **Why:** A shell that invents engine badges, percentages, or duplicate threads
  would violate the product's honesty rules. Typed envelopes keep stale-revision,
  alias, and missing-folder failures actionable instead of stringified. Catalog
  removal must be visibly distinct from deleting a folder.
- **Consequence:** P08 adds live submission behind the same engine snapshot and
  detail contract; P10 adds task creation; P16 adds route editing; P19 adds
  restore UI. The shell does not start a runtime on navigation.

## D-018 — One live studio session owns the runtime; intent is durable; replay is display-only

- **Date:** 2026-11-11 (P08)
- **Decision:** `WorkStudio` holds one session per launch and refuses a second
  project (`STUDIO_BUSY`) while the owned runtime is connecting, connected,
  running, or reconnecting. It starts the engine only on an explicit user
  action (`studio:start` or `studio:submit`), verifies the supervisor reports
  the project's canonical workspace, refuses an externally started runtime, and
  builds its adapter from `RuntimeSupervisor.endpoint()` — a token-bearing
  accessor that never crosses IPC. Plan and Work are separate engine threads
  with their posture bound at creation (`ask` + no auto-approve/trust/shell
  versus the saved full-access profile), so a later turn cannot widen policy.
  Submission intent is written before transmission; a lost response triggers one
  read-only operation lookup, never a resend. Events are inserted with
  `INSERT OR IGNORE` on `(thread_id, seq)` and the cursor advanced in the same
  transaction; reconnect replays from that cursor and advances display state
  only. Markdown is rendered with React text nodes, inert links, and no HTML
  surface. Full rationale: `docs/decisions/ADR-005-live-studio.md`.
- **Why:** P08 is where a plausible-looking fake becomes easy: a spinner that
  never resolves, an "estimate" presented as cost, a percentage nobody measured,
  a resubmitted turn after a lost response, a second owner on one user store.
  Each of those is a product promise broken. Verifying the workspace, binding
  posture at thread creation, persisting intent first, and storing events before
  projecting them makes the honest behavior the only behavior the code can
  produce.
- **Consequence:** Parallel project execution stays disabled until upstream
  concurrency is proven, and the second project receives a specific reason
  instead of a silent queue. P10/P11 add queue starts and three-attempt
  enforcement; P16 adds profile editing; P19/P20 own resume-after-crash for a
  turn left non-terminal by a crash. The pinned engine emits plumbing events
  (`item.started`, `turn.workspace_snapshot`, `model.tools.snapshot`, …); they are
  stored and counted in the UI rather than dropped, so "unknown" stays visible.

## D-019 — A Finder handoff opens a project, never starts work

- **Date:** 2026-11-11 (P09)
- **Decision:** Every externally supplied folder — Finder Service, Dock or
  window drop, a second launch, `open-file`, and the native open dialog — enters
  one `OpenCoordinator` that can only validate, register, select, and focus. It
  has no supervisor, adapter, or task API to reach for. A Finder handoff does not
  start the headless runtime; Studio shows **Start engine** and the composer is
  focused.
- **Why:** Spec §5.1 step 3 describes the engine starting as part of the Finder
  journey, while §5.1 step 4 and the P09 prompt forbid an external link from
  authorizing execution. Starting a process tree from an Apple Event that any
  local process can send is the weaker promise. P08 already made starting the
  engine an explicit user act with a verified listener, so the open path keeps
  that invariant and says so in the UI.
- **Consequence:** One extra keystroke for a Finder-opened project. In exchange,
  no external argument can spawn an engine, submit a prompt, or resume a turn —
  and the type of the open result carries `runtimeStarted: false` and
  `taskCreated: false` as literals.

## D-020 — `Mona.service` is a standalone bundle; development installs are per-user

- **Date:** 2026-11-11 (P09)
- **Decision:** The Service is a `BNDL` bundle with an `NSServices` entry and a
  single Swift executable. Development installs go to `~/Library/Services` and
  are removed by the smoke; the packaged installer places the same bundle in
  `/Library/Services` with the app (P21). The app is located by bundle identifier
  `com.mona.workbench` and validated with `SecStaticCodeCheckValidity`; at P22
  that identity carries a Developer ID signature, and until then ad-hoc is
  accepted and labelled as such.
- **Why:** The spec asks for a signed standalone payload and forbids private
  `pbs` flags, Finder scripting, and preference editing. Per-user scope keeps
  local work possible without root while keeping the release layout explicit.
- **Consequence:** `npm run smoke:service` installs and removes the user-scope
  bundle and records an install manifest with the executable digest. `Info.plist`
  declares `public.folder` only, so the menu does not offer the Service for
  files; the Service still validates every selection because `NSPerformService`
  does not re-apply menu eligibility.

## D-021 — Two measured LaunchServices behaviors shape the open path

- **Date:** 2026-11-11 (P09)
- **Observation:** (1) `NSWorkspace.urlForApplication(withBundleIdentifier:)`
  returned `nil` for a correctly signed bundle in a temporary directory and
  resolved it immediately once the same bundle was in `~/Applications`.
  (2) After a Service bundle is replaced, the Services daemon can serve a stale
  record: `NSPerformService` returns success without launching the helper until
  the bundle is re-installed and re-registered with `lsregister -f`.
- **Decision:** The application smoke installs a development bundle in
  `~/Applications` and always performs a fresh Service install plus
  `lsregister -f`; if the first handoff is not observed it re-installs once,
  records the attempt, and fails rather than looping. The doctor reports
  install path, registration source, and last handoff instead of guessing.
- **Why:** These are OS behaviors, not defects to paper over. A bounded retry
  with recorded evidence is honest; a background "install watcher" or a silent
  second attempt would hide whether Finder integration actually works.
- **Consequence:** P21 must install the Service and the app in the same
  transaction and re-register after any bundle replacement; P24 verifies the
  packaged layout on a clean recipient.

## D-022 — Task state is spec §8.2 exactly; migration v3 rebuilds the table

- **Date:** 2026-11-11 (P10)
- **Decision:** A task is one of `pending`, `running`, `verifying`, `completed`,
  `blocked`, `interrupted`, `skipped`. `paused` is a queue boundary and `failed`
  is not a terminal task state; a failed verification returns to `running`. The
  v3 migration rebuilds `tasks` because SQLite cannot alter its CHECK constraint,
  maps legacy `paused`/`failed` and any imported `running` to `interrupted`, and
  preserves dependencies and requirement evidence by disabling foreign keys
  around the documented rebuild and re-running `foreign_key_check` before the
  migration is recorded.
- **Why:** The product's status vocabulary is a promise. Keeping `paused` in the
  task model would imply a resumable half-state the spec does not define, and
  keeping `failed` would let a failed check look finished. A status set enforced
  by the database is stronger than a UI convention, and the migration makes the
  change on a real v2 database rather than only on fresh installs.
- **Consequence:** Existing `paused`/`failed` rows become `interrupted`; resume
  is explicit. Every status edge lives in `src/main/state/task-machine.ts`, and
  a transition not in that table is refused even by a direct store call.

## D-023 — Completion is an evidence gate; code changes reopen verification

- **Date:** 2026-11-11 (P10)
- **Decision:** `updateTaskStatus(..., "completed")` is refused. Completion is
  only possible through `completeTask` in `verifying`, with at least one
  acceptance criterion, every criterion satisfied (`check` only with a recorded
  check and evidence path, `human` only by an explicit human action), and one
  linked requirement-evidence row for every declared requirement. Verification
  records a deterministic workspace digest plus the task's own evidence files;
  `reconcile` reopens a completed task to `verifying` when that digest changes.
- **Why:** "The model says done" is the exact failure mode the prompt names.
  Requiring configured criteria, their recorded results, and requirement
  traceability makes completion a property of data rather than a claim. The
  fingerprint makes test evidence stale automatically when code moves, as spec
  §8.3 requires, without pretending to understand the change.
- **Consequence:** A task with no criteria cannot be completed until criteria are
  added. Reopening is audited as actor `reconciler` and clears `completed_at`.
  The fingerprint is bounded (20,000 files / 64 MB) and reports truncation; it is
  a conservative signal, not a semantic diff.

## D-024 — One execution owner and one mutating run, enforced by the store

- **Date:** 2026-11-11 (P10)
- **Decision:** Every task declares `mona_queue` or `native_workflow`. The queue
  starts only tasks whose owner is `mona_queue`, and `beginTaskRun` refuses an
  owner mismatch. Two partial unique indexes — one running task per project and
  one running run per project — make a second mutating run a database error.
  `runOnce` performs exactly one selection and one dispatch; it never loops.
  Plans import as `pending` only and never start work.
- **Why:** Spec §10.3 forbids the Mona queue and a native workflow from
  independently scheduling the same task. Recording the owner is not enough if a
  second scheduler can still start a run, so the invariant is in SQLite. One
  prompt per assignment is the spec default and keeps cost and ownership visible.
- **Consequence:** Native workflow ownership is declared and refused by the
  queue, but binding native runs to real engine goals/events is P15. Skipping a
  task needs an explicit human reason; a blocked task resumes only on new
  evidence or a human decision. The real dispatch path goes through the studio's
  single-turn guard; turn completion to task verification is explicit until
  P11/P14.

## D-025 — The attempt ledger is a state machine, not a UI convention

- **Date:** 2026-11-11 (P11)
- **Decision:** A problem is one durable row per active
  `(project, task, requirement)`, plus a taskless path keyed by a normalized
  symptom fingerprint. `recordProblemAttempt` inserts the attempt, increments
  total and consecutive counters, and blocks at the third consecutive no-progress
  attempt in one transaction. A blocked problem refuses a fourth attempt; a
  progress claim needs linked evidence or a short reason; acknowledgement only
  appends an audit event. Reopening is the only reset path and requires new
  evidence plus a reason. `beginTaskRun` and status writes re-check the database,
  so selection cannot be bypassed.
- **Why:** The spec's failure mode is a loop that “almost works” forever. A UI
  badge cannot prevent it, and an in-memory count resets with the session. The
  stable id is anchored to the task and requirement so a reworded symptom keeps
  the same problem; the partial unique indexes make a second active problem
  impossible. Putting the cap in a CHECK constraint and the fourth-attempt
  refusal in the store makes the promise testable.
- **Consequence:** The fourth retry is refused for a direct store caller too.
  A `pending` task is not moved to `blocked` (no §8.2 edge); its problem blocks
  and both selection and `beginTaskRun` refuse it. Blocking a running task
  interrupts its task-run receipt. See ADR-006 for the engine-internal boundary.

## D-026 — Control actions stay distinct and name their execution owner

- **Date:** 2026-11-11 (P11)
- **Decision:** Pause-after-task gates only the Mona queue dispatch preflight and
  is re-checked in `dispatchNext`; its note says a native-workflow-owned task is
  not gated. Interrupt-now keeps the engine receipt and, through the IPC
  boundary, links a confirmed receipt to the task (`interrupted`, turn cleared);
  an uncertain receipt leaves the task `running` and appends an audit note.
  Cancel-queued reports the real queue (usually empty under one-prompt-per-
  assignment) and never touches the active turn. Blocker-paused is a
  task/problem state, never a process state.
- **Why:** Spec §10.3 defines four actions with different effects. Conflating
  pause with stop, or claiming that an uncertain interrupt stopped a task, would
  make the UI lie about process reality. Recording `active_turn_id` avoids
  guessing which task an interrupt belonged to.
- **Consequence:** Turn completion → task verification remains P14. A finished
  turn does not silently complete a task, and stopping a process never promises
  rollback of external side effects.

## D-027 — Cost is a ledger with explicit provenance; unknown never becomes zero

- **Date:** 2026-11-11 (P12)
- **Decision:** `usage_records` is the cost ledger. A turn is recorded once per
  `(thread, turn)` by a partial unique index, with one of five cost states —
  `reported`, `estimated`, `unknown_price`, `missing_usage`, `unallocated` — and
  integer pico-USD amounts. The engine's cumulative `/v1/usage` thread total is
  converted into an exact per-turn delta against a stored thread mark; a total
  that moves backwards or arrives after unpriced turns becomes an unallocated
  residual counted once. `cost_complete` is true only when every turn is
  definite and no residual remains. Mona ships **no** price table; a rate card
  is a human-recorded row with a revision hash and read time, and a new revision
  never rewrites an already-priced turn.
- **Why:** The engine exposes exactly one price signal (a cumulative thread
  total) and no per-turn price or balance endpoint. A ledger that divided a total
  across turns, or that printed `$0.00` for an unpriced turn, would invent the
  number the spec forbids inventing (§9.3). Integer arithmetic makes fixtures
  exact, and an empty rate table keeps Mona from copying a remembered price into
  code.
- **Consequence:** Unpriced traffic stays unknown until the engine prices it or a
  human records a card. Recalculation is preview-only; applying it is a separate
  explicit decision. `usage_records.cost_usd` remains a formatted mirror for
  existing readers; every rollup uses `cost_pico_usd`.

## D-028 — Budgets block the next dispatch and never claim to be an invoice cap

- **Date:** 2026-11-11 (P12)
- **Decision:** Budgets are optional, user-set, scoped to `session`, `project`, or
  `day`, and evaluated with civil-day windows in a recorded IANA zone. The gate
  runs in the board dispatch preflight and again in `studio.submit`, so a refused
  dispatch starts no task run and sends no request. `stop` blocks the next
  dispatch; `warn` does not. When any turn in scope is unpriced the known spend is
  a lower bound and the UI says so. Mona serializes mutating work, so the
  “reservation” is a count of in-flight slots rather than an invented per-turn
  dollar estimate.
- **Why:** Spec §9.3 permits local warn/stop thresholds while forbidding a
  guessed remaining balance or a mandatory small cap. A budget evaluated inside
  the executor would be recorded as an unknown outcome, which would misrepresent
  a local refusal as a possible engine write; preflight keeps the distinction.
- **Consequence:** An in-flight provider request can complete after a stop, and
  the UI states that a local limit is not an invoice cap. A future qualified
  concurrent executor must re-run the gate per slot (P15/P21), not inherit this
  serialized assumption.

## D-029 — Change receipts are engine projections with non-regressing evidence

- **Date:** 2026-11-11 (P13)
- **Decision:** A finished turn is stored as a `change_sets` row plus
  `change_files`, projected from the engine's turn-artifact route or the
  `turn.artifacts` event. Each projection carries an evidence rank (settled
  route/event = 3, unavailable with tool files = 2, bare completion = 1) and a
  later weaker receipt cannot overwrite a stronger one. An unavailable delta is
  stored with the engine's reason; a route failure is stored as
  `receipt_unavailable`. Only a settled set with no files means "nothing
  changed".
- **Why:** The engine explicitly says a delta is not attribution, and an
  unreadable record is not an empty diff. Without an evidence rank, a late
  `turn.completed` could erase a complete artifact list, and a missing route
  could render as a clean turn.
- **Consequence:** Receipts survive restarts and are refreshable from the live
  engine. A route gap is visible, never converted into a claim.

## D-030 — Attribution stops at the engine's evidence

- **Date:** 2026-11-11 (P13)
- **Decision:** Every changed path has an attribution of `tool` (a recorded tool
  call wrote it), `workspace_delta` (changed during the turn without tool
  attribution), `artifact` (tool output/media, not a workspace file), or
  `unreceipted` (dirty in Git, named by no stored turn). A dirty path is never
  presented as agent-authored because it changed near a turn.
- **Why:** Spec §11 says to show staged/unstaged/user pre-existing work
  separately where evidence supports it and not to attribute every workspace
  change to the agent. Shell commands, other threads, editors, and the user can
  write the same workspace.
- **Consequence:** An unattributed change is a restore conflict requiring
  explicit acknowledgement. The UI explains what it cannot claim.

## D-031 — Git is a narrow, non-destructive allowlist

- **Date:** 2026-11-11 (P13)
- **Decision:** `GitService` issues only `rev-parse`, `status --porcelain=v2 -z`,
  `diff`, `log`, `add`, and `commit`. Paths are literal, validated, and placed
  after `--`. A commit names only the selected paths, so unrelated staged work
  stays staged. A selected file with both staged and unstaged edits is refused
  unless the user explicitly chooses to include the working-tree content. There
  is no reset, clean, checkout, stash, rebase, force, or commit-all control, and
  a non-Git folder is never initialized.
- **Why:** Spec §15 scenario 2 and §11 source review require a dirty repository to
  open without losing or committing unrelated work. The usual troubleshooting
  shortcuts destroy precisely the work under review.
- **Consequence:** Mona is not a full Git client: no partial hunk staging, no
  history rewrite, no remote operation. A merge conflict is displayed and left
  to the user.

## D-032 — Restore is the engine's checked one-file revert, not a second snapshot engine

- **Date:** 2026-11-11 (P13)
- **Decision:** Restore previews exact scope, exclusions, conflicts, and recovery,
  then calls `POST /v1/threads/{id}/file-revert` once per selected file with the
  engine-recorded restore point and `expected_hash`. Later edits
  (`changed_after_turn`) and unattributed deltas require path-by-path
  acknowledgement; a changed hash between preview and execution is
  `STALE_PREVIEW` and nothing runs. Every attempt is recorded in
  `restore_receipts`. The engine's mandatory `pre-restore:` snapshot is the
  recovery point, and its pruning limit is disclosed. Mona does not create a
  local snapshot store, and whole-workspace restore and forking `patch-undo`
  stay engine-native actions without a Mona control.
- **Why:** Spec §11 and §15 scenario 9 require restore to refuse conflicting or
  unsupported scope without destroying later user work. Building a second
  incomplete snapshot engine would drift from the engine's receipts and invite
  silent overwrites.
- **Consequence:** Unsupported effects (excluded paths, build output,
  deployments, API writes, installed software) are named, not promised.
  Whole-workspace restore remains a recorded capability gap (MONA-CAP-063).

## D-033 — The Resume Brief and "Since you left" are projections, not summaries

- **Date:** 2026-11-12 (P14)
- **Decision:** `PolishDigest` composes the board snapshot, settled change sets,
  the cost ledger, stored events, and one per-project `polish:seen:<id>`
  watermark into typed facts and ordered groups. It never calls a model and
  emits no completion percentage; `ResumeBriefView` carries
  `noCompletionPercentage: true` and the tests assert that no `%` appears. An
  absent source is named ("Changes unavailable", "No usage recorded") instead of
  rendered as a zero, and a task with no acceptance check says "No machine check
  recorded" rather than implying a pass.
- **Why:** Spec §9.1 forbids hidden convenience inference, and §12 asks for a
  brief from real state. A summarizer would spend tokens on every visit and make
  identical state produce different prose; a percentage bar would be exactly the
  invented progress the three-attempt rule exists to prevent.
- **Consequence:** The brief is only as complete as the records. Receipts
  captured before P13 leave a gap that is reported, and reading a project
  advances only the watermark — never a task, attempt, or verification state.

## D-034 — Alerts are re-derived from state, deduplicated durably, and redacted by default

- **Date:** 2026-11-12 (P14)
- **Decision:** `PolishNotifier` computes completion, blocker, and limit
  candidates from stored tasks, blocked problems, and budget evaluations on
  every refresh, keyed by stable identity, and records delivered and suppressed
  keys in `settings` (`polish:notifications`). The first refresh seeds a cursor
  rather than replaying history. Quiet hours are half-open, wrap midnight, and
  are evaluated through `Intl` in a stated IANA zone. A suppressed alert is
  recorded with its reason and never queued. Default bodies are generic; task
  titles, paths, and help text appear only after `showDetails` is enabled.
- **Why:** An event subscription loses position across a reconnect, so the same
  completion would be announced twice; a lock-screen body carrying a prompt
  fragment or file name is a real leak. Quiet hours are a delivery preference,
  not a scheduling authority, so they must not pause work or silently defer.
- **Consequence:** Delivery is at-most-once per key. A denied system permission
  or a quiet window shows a `suppressed` receipt with the reason in Settings.
  Travel and DST change when the window lands, and the time zone is validated so
  an unknown zone is refused rather than approximated.

## D-035 — Native attention is scoped, opt-in, and read back

- **Date:** 2026-11-12 (P14)
- **Decision:** `planAttention` is a pure function over running/blocked/unseen/
  limit counts; `AttentionController` writes chrome only on change and clears it
  when the user turns a surface off. Launch at login is off by default, applied
  only from the stored preference, and the controller reads the system's real
  login-item state at construction so a default of "off" makes no call. One
  power assertion is held only while work is active and the preference is on;
  release is idempotent and runs on work end, preference change, and quit. A
  tray that fails to install is reported in Settings instead of shown as
  working. Focus Mode hides the inspector but keeps the control strip, and
  Escape leaves it.
- **Why:** An unreleased power assertion drains a battery; a self-installed
  login item is an unrequested change to the user's Mac; a menu-bar control that
  silently does nothing is worse than a stated absence. Focus Mode must not hide
  Interrupt now or the blocker access path.
- **Consequence:** Menu-bar appearance and Dock badge are verified by installed
  state and tooltip, not by a screen capture of the system menu bar; packaging
  (P21) verifies the login item at install time. Closing the window still keeps
  work alive, and Quit remains the explicit interrupt-and-stop.

## D-036 — A delivery receipt records what the system reported, not an assumption

- **Date:** 2026-11-12 (P14, review follow-up)
- **Decision:** `NotificationHost.deliver` resolves `shown` (the system confirmed
  display), `failed` (the system refused), or `handed_over` (accepted with no
  confirmation inside the window). Only `shown` sets `delivered: true`; Settings
  labels all four states including `suppressed`. Any receipt — even a refusal —
  spends the key, so a permanently denied permission cannot retry on every
  refresh. `PolishNotifier.refresh` is serialized per project, because main and
  the renderer both observe the same terminal push and interleaved loads could
  each see an unseen key. A change set the engine stored as `unavailable` is
  counted and named ("N turns with no recorded delta") instead of being filtered
  away, and a test result's tone follows the observed command status before any
  check arithmetic.
- **Why:** The review found the first implementation reporting a refused
  notification as delivered, a missing delta as zero changed files, a failed
  observed test as success, and a duplicate-delivery race. Each was a claim about
  something never observed — the exact failure mode spec §2 promise 2 forbids.
  On this host macOS genuinely refuses dev-context notifications, so the old code
  would have shown a reassuring falsehood in Settings.
- **Consequence:** A refused or unconfirmed alert is visible as such. `delivered`
  is a strict subset of receipts, so a UI must read `delivery` to describe the
  outcome. Keep-awake state reports `scopedToActiveWork` only while an assertion
  is actually held for observed work.

## D-037 — One scheduler per task; native orchestration is read, not re-implemented

- **Date:** 2026-11-12 (P15)
- **Decision:** A task has exactly one execution owner (`tasks.execution_owner`).
  The Mona queue starts only `mona_queue` tasks and a native fleet launch only
  `native_workflow` tasks. `task_runs.upstream_kind/upstream_id` is unique, so an
  engine run can belong to exactly one local task run; if the link cannot be
  written the fleet run is stopped and the local run fails. Mona performs
  `POST /v1/fleet/runs` + `/start` for a launch it initiated, then only reads
  workers, receipts, evidence, and replay, and offers stop/stop-worker/restart.
  A terminal fleet run settles the task run and moves the task to **verifying**
  with a fresh fingerprint — never to `completed`.
- **Why:** A fleet run is a second scheduler with its own driver. Two schedulers
  starting one task would spend twice and mutate the workspace twice. Engine
  completion says the worker stopped; it does not satisfy Mona's acceptance
  criteria, so treating it as completion would be a fabricated success.
- **Consequence:** `pause-after-task` does not gate a native workflow's own
  scheduler, and the control now says so instead of implying otherwise. A
  second launch for the same task is refused by the database, not convention.

## D-038 — Parallel launch is refused because the engine accepted overlapping writers

- **Date:** 2026-11-12 (P15)
- **Decision:** `launchFleet` accepts only `parallelism: "serial"`, the IPC schema
  rejects anything else, and `ParallelQualification` renders four failing checks
  (isolated worktrees, branch ownership, aggregate limits, merge boundary). Mona
  launches exactly one task per fleet run.
- **Why:** A live probe (`p15-parallel-probe.json`) created a `parallel` workflow
  with two builder tasks declaring `root: "."` and the pinned runtime returned
  `201`. The documented "overlapping effective write roots are rejected" note did
  not hold for that shape. Isolated worktrees, per-task branch ownership, an
  aggregate budget, and a merge/review boundary are all absent, so no
  qualification could be demonstrated.
- **Consequence:** Parallel builders are impossible through Mona until every
  check can be shown on a real run. Mona performs no merge, so it cannot delete a
  branch or silently resolve a conflict.

## D-039 — Unknown spend stays unknown, and no parent+child total exists

- **Date:** 2026-11-12 (P15)
- **Decision:** `SpendView` carries a confidence (`priced`, `unpriced`,
  `unknown`, `not_reported`), an amount or null, and its source. Sub-agent usage
  comes from the worker ledger verbatim (0.10.2 says `unknown`); fleet receipts
  carry no totals (`not_reported`). The observatory view exposes no aggregate
  amount, and `aggregateNote` states that parent and child are not additive. The
  summary counts non-priced rows as `unknownSpend`.
- **Why:** The parent thread total may already include the child's tokens, so any
  sum would double-count. A locally derived balance or estimate without a
  recorded rate card would be an invented number, which ADR-007 and spec §9.3
  forbid.
- **Consequence:** A screen cannot show a fleet's total cost as known. The cost
  lens remains the only place a priced turn appears, and only from a stored rate
  card.

## D-040 — Fleet workers are one row, under their fleet

- **Date:** 2026-11-12 (P15, review follow-up)
- **Decision:** The engine lists fleet workers in the same `/v1/agent-runs`
  ledger as sub-agents. The observatory deduplicates by real identity: a worker
  shown under its fleet is removed from the standalone sub-agent list, and the
  worker row inherits that ledger entry's spend, tools, and test evidence.
- **Why:** A live run showed one worker appearing twice (once as a fleet worker,
  once as a sub-agent) and inflating the summary counts and the unknown-spend
  total. Two rows for one identity is the fake-swarm failure mode in miniature.
- **Consequence:** Summary counts are per real identity. A worker with no ledger
  entry keeps its own record's fields and shows spend as unknown.

## D-041 — An unread section, an unverified detail, and a detached view are not success

- **Date:** 2026-11-12 (P15, review follow-up)
- **Decision:** Four claims were tightened after an independent review.
  1. A list route that fails is no longer rendered as an empty list. The section
     falls back to its last stored projection and names the failure; `source`
     becomes `stored` with a stated reason unless at least one section was read.
  2. `refused()` returns `never`, so a failed `fleet_create`/`fleet_start` throws
     after recording its receipt instead of also returning a result object the
     caller could treat as a launch.
  3. Stored workers are pruned only when **every** listed run's detail was read.
     An unloaded detail is "not read", not "no workers".
  4. `HTTP status` on a goal receipt is the status the engine answered (201 on
     set, 200 on block/complete, 204/404 on clear), not a hardcoded 200.
  5. Every sub-agent ledger record is normalized before the project filter, so a
     fleet worker's spend, tools, and tests survive even when its ledger row
     names the runtime workspace rather than the project root.
  6. Engine controls — cancel, stop run, stop/restart worker, fleet launch — are
     disabled in a stored or detached view with a stated reason, and a launch is
     offered only when the engine advertises fleet create and start.
- **Why:** Each was a claim about something never observed: an emptier list than
  reality, a launch that did not happen, a worker silently forgetting its usage,
  a status nobody received, and buttons that could only fail. Spec §2 promise 2
  and the three-attempt rule exist to forbid exactly this class of quiet
  falsehood.
- **Consequence:** A partial failure degrades to a labelled stored section, not
  to zero rows. A refused launch surfaces as an error with a durable receipt.
  The observatory's controls track the engine connection and advertised
  capabilities rather than optimism.

## D-042 — A saved route is a scoped, validated, compare-and-swap record

- **Date:** 2026-11-12 (P16)
- **Decision:** Mona's saved new-thread route lives in `engine:profile` and is
  written only after live validation: the provider must be reported by
  `/v1/providers`, the model must appear in
  `/v1/providers/{id}/models`, and a reasoning level must be one that exact
  model publishes. The write uses `putSettingsIfVersion`, so a stale revision is
  a conflict. The studio keeps the profile it started with; an active turn is
  never rewritten by a settings change.
- **Why:** The engine has three route scopes (configured, per-thread, per-turn)
  and Mona adds a fourth (saved default). Conflating them is how a "default"
  edit silently changes running work. Persisting an unvalidated model or an
  unsupported effort level would also be a promise the next turn cannot keep.
- **Consequence:** Offline saves are refused instead of stored unverified. An
  active session's observed route is shown from its receipt, not recomputed from
  the saved default.

## D-043 — The engine route is changed only through its switch route, with a backup and a stale-read refusal

- **Date:** 2026-11-12 (P16)
- **Decision:** "Apply to engine default" is a separate, confirmed action. Mona
  reads the config document's SHA-256, refuses a mismatch, writes a copy plus a
  manifest and receipt under the product backup directory, calls
  `POST /v1/providers/{id}/switch`, re-reads `/v1/config`, and reports `applied`
  only when the observed provider and model match. Unknown TOML tables are left
  to the engine's writer.
- **Why:** The config document is shared user state. A UI-level rewrite would
  delete unknown tables; a concurrent edit must be caught, not overwritten; and
  a switch response is not proof that the effective route moved.
- **Consequence:** The receipt carries before/after routes, document hashes, and
  the backup path. A named custom `model_provider_id` is not selectable through
  this route and is stated as a limit.

## D-044 — Credentials are classes and pass-through; no secret is ever represented

- **Date:** 2026-11-12 (P16)
- **Decision:** The workbench shows `credentialState`, `credentialSource`,
  `credentialWritable`, and the engine's reason. A key is accepted only on the
  dedicated IPC call, forwarded to `PUT /v1/providers/{id}/key` with an explicit
  session or durable scope, and dropped. A route whose credential the engine
  does not own is refused before submission.
- **Why:** Writing around an account session or a literal config value would
  corrupt the credential authority; keeping a key in renderer state, a receipt,
  or a log would leak it. The engine already exposes a safe structural
  projection.
- **Consequence:** Receipts contain state/scope/backend only. A mock provider
  can be configured without Mona ever holding the value.

## D-045 — Diagnostics are redacted before display or export

- **Date:** 2026-11-12 (P16)
- **Decision:** `codewhale doctor --json` and `config doctor` are run read-only,
  bounded, and passed through a redactor covering the home directory, `sk-`
  keys, bearer tokens, `key=value` secrets, URL userinfo, and private-key
  blocks. The exported JSON records the redaction count. The smoke asserts the
  report contains no fixture secret.
- **Why:** Spec §13 requires diagnostics to be local and redacted by default,
  with an explicit export preview. A path or a key in a support bundle is a
  leak even when it came from the engine's own output.
- **Consequence:** A path printed by the engine appears as `~`. Engine warnings
  remain readable and attributable.

## D-046 — Extension actions are engine-mediated, revision-guarded, and scoped

- **Date:** 2026-11-12 (P17)
- **Decision:** MCP mutations carry the engine's revision in `If-Match`; adds
  require an absolute executable path or an http(s) URL; project-scope entries
  are shown read-only. Tool listing is a separate on-demand call, never part of
  a snapshot. Every action view states its scope, side effect, availability, and
  reason.
- **Why:** A second writer to `mcp.json` would race the engine and could delete
  unrelated entries. A page open must not load every tool schema into model
  context. A PATH name could resolve a different binary under a GUI launch.
- **Consequence:** Stale revisions are the engine's 412 surfaced verbatim;
  removes preserve unrelated servers and unknown keys. No token-savings claim is
  made because the pinned engine exposes no tool-level budget.

## D-047 — Plugin trust stays with the engine; Mona reports the gap

- **Date:** 2026-11-12 (P17)
- **Decision:** The HTTP plugin detail returns `review.token` as `[redacted]`,
  so Mona does not offer a trust button. It shows `trustStatus`, inventory,
  content/capability hashes, and the exact terminal route (`/plugins trust`).
  Installed bundles remain disabled and untrusted until the engine records a
  review; hooks are read-only; imported content has no path to the desktop IPC
  bridge.
- **Why:** A UI-only "trust" toggle without the engine's capability review would
  be a false security control. The engine's approval semantics are the
  authority.
- **Consequence:** Trust, project MCP edits, hook edits, tool-level discovery,
  and command editing appear as named gaps with a verified route, not as
  missing buttons or simulated success.

## D-048 — Review fix: no cached URL may carry credentials

- **Date:** 2026-11-12 (P16, review follow-up)
- **Decision:** The engine-route cache stores `scheme://host` plus an endpoint
  classification (`configured`/`default`/`malformed`/`unknown`), never the raw
  `base_url`. The cache is a typed `StoredEngineRoute`, not the adapter's
  config object. A regression test feeds a `base_url` with userinfo and a
  query token and asserts neither the settings row nor the offline snapshot
  contains it.
- **Why:** A configured `base_url` can embed a key in userinfo or a query
  parameter. The earlier cache wrote the engine's response verbatim into
  Mona's unencrypted settings table — a second on-disk copy of a credential
  Mona never needed. This is the "unknown is not zero" rule applied to secret
  handling: a value Mona does not need, it must not keep.
- **Consequence:** Cached and offline route views show the authority only. The
  config backup still contains the engine document by design (mode `0600`,
  never rendered or exported); that is stated in the P16 evidence rather than
  hidden behind a blanket "no copy" claim.

## D-049 — The terminal is a native helper, not an engine attach and not an addon

- **Date:** 2026-11-12 (P18)
- **Decision:** Mona's integrated terminal is owned by `native/macos-pty`, a
  standalone arm64 Swift executable (with a C fork/exec shim) that hosts a pty,
  the shell session, resize, and a verified exit receipt over fd 0/1 raw bytes,
  fd 3 JSON control, and fd 4 JSON events. Sessions live in the main process;
  the renderer reconnects to the same shell by reading the replay ring.
- **Why:** On 0.10.2 the engine's `/v1/terminal/{name}` family only *attaches*
  to a shell the engine already owns (an unknown name is `404`), and
  `/v1/threads/{id}/jobs` has no resize route. P18's acceptance requires resize
  that the child observes. A Node addon would also have to match Electron's ABI
  and be compiled per recipient Mac; a helper has no ABI coupling at all.
- **Consequence:** `MONA-CAP-061` stays open (engine terminal attach is not
  built). Packaging (P21) ships and P22 signs the helper. A closed owner channel
  terminates the whole process group, so a desktop crash leaves no orphan shell.

## D-050 — The shell gets an allowlisted environment and no startup files

- **Date:** 2026-11-12 (P18)
- **Decision:** The helper receives exactly the entries `buildShellEnvironment`
  builds from `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`,
  `LANG`, `TMPDIR`. Mona's own environment is never passed through; a
  secret-shaped variable is reported as withheld. The shell is `/bin/zsh -f`, so
  `/etc/zshrc` and `~/.zshrc` do not run.
- **Why:** "Never source user shell startup files just to find provider
  credentials" is a spec rule, and an inherited environment is how a runtime
  token or provider key would leak into a child process. An allowlist is
  stronger than a denylist: a future variable is excluded by default.
- **Consequence:** Personal aliases and prompt themes do not load inside Mona's
  pane; the pane prints the exact environment, and a throwaway `HOME` with a
  marker `.zshrc` proves the file never ran.

## D-051 — Terminal output is inert, bounded, and honestly not an emulator

- **Date:** 2026-11-12 (P18)
- **Decision:** The renderer receives text spans from `ansi.ts`, which strips and
  counts every CSI/OSC sequence, keeps only SGR emphasis, and never produces a
  link or a call. OSC 8 hyperlinks are plain text. Output is bounded by a
  byte-exact replay ring (`dropped` = the first retained byte's offset) plus a
  64 MiB per-session budget that ends the session with a stated reason. A
  non-zero exit is `exited` with its code; `failed` is reserved for a helper or
  spawn failure.
- **Why:** Terminal escape sequences are an untrusted input surface: OSC 52 can
  write the clipboard, OSC 8 can disguise a target, and cursor sequences can
  misrepresent content. A line-oriented transcript also has to admit what it
  cannot do rather than render a corrupted `vim`.
- **Consequence:** Full-screen programs are unsupported and the pane says so.
  Search runs over the retained buffer, not the visible lines, and a truncated
  replay is reported with the dropped byte count.

## D-052 — Coverage is computed from rows, and an entry point must exist

- **Date:** 2026-11-12 (P18)
- **Decision:** `tools/p18-coverage/reconcile.mjs` reconciles every inventory row
  with an entry point, status, invocation, help source, test, and gap; the app
  and the smoke compute coverage **from the rows** and never trust the file's
  summary. `entryTargetIsKnown` refuses a target this build does not render, and
  a unit test fails on a dead target. The installed engine is compared against
  the recorded version/commit/command set by a read-only help probe.
- **Why:** "All functionality" is only auditable if a hidden or awkward feature
  still counts. A hand-written summary can drift; a computed one cannot. A
  terminal button is not blanket support, so a `blocked_gap` row names the route
  it cannot reach instead of offering a dead control.
- **Consequence:** 43 rows verified, 28 open (write/destructive/costly, or
  needing input Mona will not invent; each names its route), 2 blocked gaps
  (workflows, lanes — no `/v1` route on 0.10.2), 2 unavailable. A `verified`
  terminal row must be executed by the capability smoke, and the reconciler
  refuses a row that contradicts its own test note. Full parity is explicitly not claimed. An engine change shows
  as drift and requires re-qualification, never a silent upgrade.

## D-053 — P18 review fixes: honest rows, guarded bridge calls, no duplicate replay

- **Date:** 2026-11-12 (P18, review follow-up)
- **Decision:** Two independent read-only reviews of the P18 change found six
  defects; each was fixed with a regression test.
  1. `session-diagnostics` and `scorecard` were `verified` on a `--help` probe
     while their own notes said "not exercised". Both are now `unqualified`
     with the observed behaviour recorded, and `smoke:capability` executes the
     exact route of every `verified` terminal row. The reconciler now refuses a
     `verified` row that is untested, that contradicts its own test note, or
     that is an unexecuted terminal row.
  2. A size outside the IPC schema made `ipcRenderer.invoke` reject outside
     `envelope`, stranding the pane busy with no message. Sizes are clamped
     before the call and each bridge call is guarded with `busy` cleared in
     `finally`.
  3. Bytes entered the replay buffer immediately but reached the renderer
     through a 33 ms batch, so a reconnect could draw them twice. `output()`
     flushes pending bytes before reading, making "`seq <= read.seq` ⇒ already
     in `data`" true.
  4. A replay continuation from a session the user had switched away from could
     write into the newly selected transcript; it is now discarded by session
     identity.
  5. A non-active session's event left its tab status stale; the snapshot is
     refreshed for a non-visible session or a state/exit event, but not for the
     visible session's 33 ms output batches.
  6. A successful close kept a previous refusal banner; close clears messages.
- **Why:** Finding 1 is the failure mode the whole prompt exists to prevent — a
  green badge over an operation nobody ran. Findings 2–6 are the same class at a
  smaller scale: a control that silently sticks, a transcript that shows the
  same line twice, a status that freezes at the last snapshot.
- **Consequence:** A `verified` terminal row is now provably executed (three
  rows: `help`, `metrics`, `completion zsh`); coverage reports 43 verified,
  28 open, 2 blocked gaps, 2 unavailable, 51 exercised entry points. Findings
  2–4 have named tests: a thrown create, the replay/live race, and an initial
  snapshot refusal that must render as an error rather than an empty pane.

## D-054 — P19: memory is a read, the shelf stores text, and a bundle is records plus pointers

- **Date:** 2026-11-12 (P19)
- **Decision:** Project memory, the prompt shelf, and handoff are three separate
  surfaces with three separate guarantees, and none of them can start work.
  See `docs/decisions/ADR-013-memory-and-handoff.md`.
- **Why:** The prompt asks for "project memory" without a cloud service and
  without a competing transcript. Bundling search, prompts, and export into one
  store would have made each guarantee harder to state and easier to weaken.
- **Consequence:** `ProjectMemory` reads a fixed source list and reports its
  exclusions; `PromptShelf` refuses secret-shaped text rather than storing it;
  `ProjectHandoff` imports by parsing in memory and calling the existing
  `importProject`, so no extraction root exists to escape.

## D-055 — A context preview states what it is, and what it is not

- **Date:** 2026-11-12 (P19)
- **Decision:** `ContextSelectionPreview.exactProviderRequest` is the literal
  `false`, and `ResumePacket.engineInspection` is the literal `"unavailable"`.
  Both the API and the screen say the engine assembles the provider request and
  0.10.2 exposes no inspection route.
- **Why:** The prompt says not to pretend this can show the exact provider
  request unless the engine supplies that inspection. A boolean that can never
  be true is clearer than a comment, and it survives refactoring.
- **Consequence:** The screen never claims to show "the prompt that will be
  sent"; it shows Mona's composition and invites the user to compare it with the
  engine's own transcript.

## D-056 — Import parses in memory instead of extracting

- **Date:** 2026-11-12 (P19)
- **Decision:** A handoff import never writes the bundle's entries to disk. The
  archive is read with a fail-closed reader, each entry's sha256 is checked
  against the manifest, and the parsed `project.json` object goes straight to
  `StateStore.importProject`.
- **Why:** Path traversal is the classic archive bug. Removing extraction removes
  the attack surface rather than defending it. The reader still refuses unsafe
  names because `extractArchive` exists for future use and must not be the weak
  link.
- **Consequence:** A hostile bundle with `../../escape.txt` fails inspection with
  `PATH_ESCAPE`, and nothing is written outside any directory. Covered by
  `test/safe-archive.test.ts` (nine cases) and `smoke:memory`.

## D-057 — Settings restore runs under the exclusive barrier, with a journal and read-back

- **Date:** 2026-11-12 (P19)
- **Decision:** `StateStore.restoreSettings` takes the maintenance barrier for
  the whole operation, snapshots first, journals `started`, mutates in one
  transaction, verifies every scope by reading it back, then journals `complete`.
  It writes the `settings` table directly because the barrier is not re-entrant:
  a nested `putSettings` would deadlock behind the exclusive run.
- **Why:** A restore that reports success without reading back is a claim, not a
  verification. A restore that calls public write methods would deadlock.
- **Consequence:** A failed read-back throws `MAINTENANCE_FAILED` and leaves the
  journal and snapshot on disk; it never reports a rollback it did not perform.
  `smoke:memory` starts a concurrent `putSettings` before the restore and proves
  both the restore and the concurrent write land.

## D-058 — Plan export carries status; import reports it as deferred

- **Date:** 2026-11-12 (P19)
- **Decision:** `TaskPlan.tasks[].status` is exported and accepted on import, but
  import never applies it. A non-`pending` status is returned in
  `ImportPlanResult.deferredStatuses` with the reason that a plan describes
  intended work and a completed state needs its own evidence.
- **Why:** Closes the carried-forward gap "plan export does not carry task
  status" (item 27) without letting a plan manufacture a completion on a machine
  that has no evidence for it.
- **Consequence:** A status is visible to a human reading the plan and inert to
  the state machine. Covered by `test/board-plan-status.test.ts`.

## D-059 — P19 review: a false "no engine call" claim, and twelve smaller fixes

- **Date:** 2026-11-12 (P19, review follow-up)
- **Decision:** An independent adversarial review of the P19 change returned one
  major and thirteen minor findings. All were verified; every real one is fixed.
  1. **Major — the surface spawned the engine while promising it could not.**
     `engineIdentity()` ran `codewhale --version` synchronously on the main
     thread, reachable from `diagnostics:preview` and handoff inspection, while
     the bridge contract, an IPC comment, and the diagnostics note all said the
     surface never reached the engine. The exec is removed: presence is a PATH
     stat, and version/commit come from the last stored capability snapshot with
     its capture time. `RequalificationView` gains `source` and
     `localEngine.observedAt` so "requalified" cannot be read as "a probe just
     ran"; with no snapshot it reports `unavailable` and names the next step.
  2. `truncated` was reported but never applied, so a >100 KB context preview
     claimed a cut while shipping everything. Blocks are now fitted to the budget
     *before* the text and slot byte counts are derived, preserving the
     "slot bytes sum to the total" invariant. This exposed a second bug in the
     new guard: the marker was sized in characters while the budget is in bytes.
  3. The shelf's save hint promised secret-shaped text would be redacted; save
     refuses it. The hint now says refused.
  4. The replace-restore confirmation implied every absent scope is reset; it now
     names the preserved credential scopes and the prompt shelf.
  5. `restoreSettings` accepted `expectedRevision` and ignored it. It is now
     enforced inside the exclusive barrier, where the guarantee holds; a
     caller-side check races a writer.
  6. The restore failure message credited the journal with previous values. The
     journal holds the attempt; the snapshot holds the values.
  7. The settings-backup note claimed credentials are never read. They are read
     to be excluded; the claim is now about what leaves the machine.
  8. The shelf projection redacted `description` and `acceptance` but not `body`,
     `label`, or older version bodies — reachable through a settings restore. All
     strings are projected through the redactor, and `redacted` is computed
     instead of hard-coded `false`.
  9. A shelf save changing only `description`, `tags`, or `note` returned the
     stored prompt unchanged, silently dropping the edit. Every editable field
     counts and tags compare order-insensitively.
  10. Two smoke checks could not fail: `redactions >= 0` (now `> 0`, guaranteed
      by the fixture) and a "no engine was invoked" check whose engine lookup did
      not resolve to the tripwire (now asserted explicitly, and the tripwire was
      proven by hand to mark an actual spawn).
  11. `extractArchive` would follow a symlinked parent directory. It is unused by
      P19 because import parses in memory; recorded as a limit with P20 named as
      the owner rather than quietly hardened without a test.
- **Why:** The major finding is the exact failure this project exists to prevent:
  a truthful-looking note over a surface that does something else. A version
  probe is not inference, but "no engine call" was still a false sentence, and it
  blocked the main thread for up to five seconds from a screen open.
- **Consequence:** Every fix has a regression test or a smoke check.
  `smoke:memory` grew from 82 to 90 checks, `test/memory-search.test.ts` from 8 to
  12, `test/memory-shelf.test.ts` from 12 to 14, and
  `test/settings-restore.test.ts` was added (5). Evidence:
  `docs/evidence/macos/P19-memory.md`, section "Review".

## D-060 — A child process inherits trust, so Git gets an allowlist

`runGit` passed `{...process.env}`. Git runs hooks supplied by the repository
under review, so any opened project could read Mona's provider key and runtime
token from its own `pre-commit`. `buildGitEnvironment` now passes only PATH,
HOME, USER, LOGNAME, TMPDIR, locale, `SSH_AUTH_SOCK`, Git identity variables,
and `XDG_CONFIG_HOME`, drops any secret-shaped name even inside that list, and
forces `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`,
`LC_ALL=C`. A plain-Git control run confirms the leak was real, so the test is
not vacuous. The same reasoning already governed the PTY allowlist (ADR-012);
it now applies to every child Mona spawns with a repository-controlled input.

## D-061 — A sequence gap is detected, replayed once, then reported

The pump resumed from `store.getCursor()`, the **highest** stored sequence. A
frame lost in transport therefore advanced the cursor past itself and the
timeline silently lost an item while claiming a complete turn. `ingest` now
compares the incoming `seq` to the stored cursor, records
`sequence gap: <range>`, and asks the pump to reconnect from the last contiguous
sequence. That replay does not count against the instability budget, because a
deliberate rewind is not a flapping stream. After two recoveries the gap stays
recorded: the engine contract does not promise contiguous numbering, and looping
forever would misrepresent what recovery can achieve. Unknown stays unknown.

## D-062 — A cap that keeps a prefix is not a cap

When the total-byte budget was crossed, `readArchive` returned the entries it had
already accepted alongside an `ARCHIVE_TOO_LARGE` problem. A caller could then
import a truncated bundle and describe it as complete. The reader now clears
`entries` when the total cap is hit, matching the all-or-nothing behaviour the
entry-count and entry-size caps already had.

## D-063 — Extraction validates the real tree, not only the name

`safeJoin` is lexical by design. A pre-existing `<root>/nested → /tmp/out`
redirected `writeFileSync` outside the root, which is why P19 recorded it as a
limit rather than claiming safety. `prepareTarget` now `lstat`s every component,
refuses a symlink anywhere in the path and a non-regular final target,
re-resolves the parent and re-checks containment, and the write uses
`O_EXCL`/`O_NOFOLLOW` (`O_TRUNC` only for an explicit overwrite). A symlinked
*root* resolves to its real directory: the caller named that destination.

## D-064 — A receipt is worth nothing compared with stopping the tree

The native supervisor's `emit` used `FileHandle.standardOutput.write`, which
raises an uncatchable Objective-C exception on `EPIPE`. `stopTree` emits before
it signals anything, so when the desktop owner died the supervisor aborted
before stopping a single process and the runtime was reparented to `launchd`.
`emit` now uses `write(2)` and discards `EPIPE`; stopping always runs to
completion. The P04 test missed this because it closed the owner channel while
the receipt pipe was still readable. The new test destroys the receipt pipe
first, and was verified to fail against the pre-fix binary. The Electron
lifecycle smoke adds a real `SIGKILL` phase for the same guarantee end to end.

## D-065 — Named state conditions, and one redactor

`ARTIFACT_MISSING` is a `StateErrorCode`, so a vanished artifact byte file is
reported as that condition instead of a raw `ENOENT` the UI cannot interpret;
digest mismatch keeps `CORRUPT_DATABASE`. `redactHomePath` is the single home
redactor for settings, capability, extensions, and the terminal. It requires
`home + "/"`, handles `home` itself, and does not operate on a degenerate home,
because a bare prefix match renamed `/Users/victor2/...` to `~2/...`.

## D-066 — IPC sender policy is a pure, testable rule

`senderIsTrusted` moved to `src/main/ipc-sender.ts`, free of Electron imports.
It refuses a destroyed sender, a child frame, a non-`file:` URL, a path outside
the renderer root, and any evaluation that throws. The policy is now proven
directly in `test/p20-failure-matrix.test.ts` rather than only asserted through
the shell smoke's observed `require`/`process` values.

## D-067 — Finder aliases are refused, not silently resolved

The folder policy claimed aliases were "resolved"; `realpathSync` resolves
symlinks, not alias files. The Service and Dock paths deliver the resolved
folder URL, which opens normally. When an alias *file* arrives directly it is
now refused as `NOT_A_DIRECTORY` with the instruction to open the folder it
points at, and the comment states what is true. Interactive alias delivery
remains P24 QA.

## D-068 — The installed copy owns Finder handoffs

The Service originally resolved Mona only through
`NSWorkspace.urlForApplication(withBundleIdentifier:)`. With a staged or
development copy registered, macOS could hand a folder to that copy while the
installed app sat in `/Applications`. The Service now prefers
`/Applications/Mona.app` when it is the expected bundle, executable, and validly
signed, then falls back to LaunchServices. The installer marks the app
non-relocatable, and a packaged copy running from elsewhere warns when the
installed copy exists. ADR-015 §2. Proven by the packaged Service smoke after
unregistering the competing copies.

## D-069 — Re-signing changes the engine's identity; record both

The bundled Codewhale binary is the qualified 0.10.2 arm64 artifact
(`da022961…`), re-signed inside Mona (`41e6dfd8…`). Packaging records both
hashes and refuses an engine whose version/commit is not pinned, or whose
default artifact bytes changed. The packaged digest is the payload identity; the
upstream digest is provenance. ADR-015 §3.

## D-070 — Local is not release, and release refuses to pretend

`--mode local` produces an ad-hoc, `-local`-named package with a visible
“Local development build” channel. `--mode release` requires Developer ID
Application and Installer identities and still stops before producing anything
until P22 adds signing, notarization, stapling, and release verification. A
missing identity is a P22 prerequisite, not a reason to emit an unsigned
production package. ADR-015 §6.

## D-071 — Installer scripts touch only owned paths

`preinstall` performs the arm64/OS gate and removes the previous app/service
after checking their bundle identifiers. `postinstall` verifies the bundles,
registers the Service, and writes the receipt. Neither launches Mona, uses the
network, changes TCC, or reads user state. `MONA_INSTALL_ROOT` rehearses both
against a temporary root twice; the real install uses `/` and standard Installer
authorization. ADR-015 §7.

## D-072 — The payload is visible and complete

ASAR is disabled and there are no native Node modules; every executable is a
real file in the signed payload. The pinned engine, supervisor, PTY helper,
capability inventory, component manifest, and third-party notices are all
inside `Contents/Resources`, and the app verifies their digests at package-smoke
time. ADR-015 §4, §10.

## D-073 — Git is probed, not invited

On a clean Mac `/usr/bin/git` is Apple's Command Line Tools stub. Packaged Mona
now returns Git unavailable with an explanation when only the stub exists,
instead of triggering an OS developer-tools install. Development behavior is
unchanged. Bundling a GPL Git is a release decision with source obligations,
recorded as an open MAC-004/P26 item. ADR-015 §8.

## D-074 — Packaging is verified by running the installed artifact

The package gate is not a checklist. It expands the product, compares every
file and symlink to the staged payload, rehearses both scripts twice, launches
the installed app through LaunchServices with a fresh home, runs the in-app
component-digest acceptance sample, and (with the Service installed) runs the
package smoke from `/Applications`. The real `installer` run was performed with
administrator authorization and its receipt, signatures, and Service
registration are recorded. ADR-015 §7, §9.

## D-075 — Determinism covers inputs and content, not every container byte

The build rebuilds all inputs, stages a fixed sorted file set, normalizes
modification times, and records content digests. The app content digest is
stable across repeated builds here. Flat-package xar/BOM metadata and native
Mach-O compiler UUIDs can still differ, so the release receipt freezes the exact
package digest rather than promising byte-identical rebuilds. ADR-015 §9.

## D-076 — The product floor is 14.0 because the native helpers say so

The supervisor and PTY helper target `arm64-apple-macos14.0`; Electron's floor is
13.0 and the engine's 11.0. Installer declares 14.0 and the script repeats it.
The floor has not yet been executed on a 14.x host; P26 owns the version matrix.
ADR-015 §5.

## D-077 — Two trust tiers, and only one of them is publisher authentication

A **release** candidate needs an Ed25519-signed manifest over its exact bytes, a
Developer ID Installer signature from the configured team, a matching digest and
length, a declared notarization, and a strictly increasing version. A **local**
package the user chose records its digest and identity but is never publisher-
authenticated, and can never replace a release install. A digest inside an
unauthenticated manifest proves nothing: whoever can change the manifest can
change the digest. ADR-016 §1.

## D-078 — Verify, defer, record, snapshot, hand off — in that order

The order is the guarantee. Active work (a running task with its turn, a live
submission, an engine runtime binding, or a probe failure) defers the update with
the exact items listed; nothing is stopped or interrupted to make updating
convenient. The intent is written to `update_intents` before any privileged step,
the state snapshot is taken under the maintenance barrier and re-verified, and
only a confirmed Installer handoff reports `handed_off`. A failed handoff closes
the intent as `failed` and leaves Mona running. ADR-016 §3.

## D-079 — An older app refuses a newer schema; a restore is the only way back

`user_version` above this build's schema stops the store from opening; there is
no "try anyway". A DB rollback is an explicit restore of a snapshot whose schema
is between 1 and this build's schema and which passes integrity — it is moved
into place, the previous file is kept, and it is migrated forward through the
same `migrateDatabase` path (with its own snapshot and journal). The startup
dialog distinguishes newer schema, failed migration, and unreadable database, and
offers only a snapshot this build can open. ADR-016 §4.

## D-080 — Removal is bounded by the package's own manifest

`uninstall-mona.sh` ships inside the payload and plans only paths that
`owned-paths.json` names, verifying each bundle's identifier and refusing
anything unrecognized or missing a manifest. It never walks another user's home,
never uses a wildcard, and deletes user state only with
`--remove-user-data --home <one user>`. Deleting the app and deleting a user's
projects are two decisions. ADR-016 §5.

## D-081 — A rehearsal may never touch the real filesystem

The first P23 uninstall rehearsal set only `MONA_UNINSTALL_ROOT`, so `preinstall`
resolved an empty `MONA_INSTALL_ROOT` to `/` and attempted to remove
`/Applications/Mona.app`; root ownership stopped it and the installed bundle
still verifies. The repair is mechanism, not discipline: both root hooks are
always set together, and `assertRehearsalRoot` fails the build for any root
outside the process's temporary directory (`/`, the temp root itself,
`/Applications`, prefix lookalikes, empty). `lib/uninstall.mjs` additionally
asserts the shipped script's bounds at build time. ADR-016 §5.

## D-082 — The artifact declares its own identity, and the build proves it

A candidate's identity comes from the package's own `PackageInfo` and
`Distribution` (metadata-only `pkgutil --expand`), not from a sidecar file. A
`Resources/update-metadata.json` written at P23 was silently dropped by
`productbuild`, which embeds only referenced resources — so the ADR claimed
something the artifact did not contain. The file is removed and
`verifyDeclaredMetadata` now expands the finished package and fails unless the
identifier, version, build counter, both bundle identifiers, the arm64 gate, and
the macOS floor are all declared. ADR-016 §6.

## D-083 — An update check is a local read with a literal zero

`UpdateCheckView.inference` is `{requests: 0}` and the screen prints it. A check
reads one bounded HTTPS document from an explicitly configured host (or nothing
at all in manual mode); it downloads no package, starts no process, and makes no
model call. The only privileged step is Apple Installer's own authorization.
ADR-016 §2.

## D-084 — A smoke that races the scheduler is a flaky gate, not a check

P18's terminal smoke read the ring's eviction totals as soon as its marker
appeared. On a loaded host the child was still writing, so `dropped` was 0 and
two checks failed intermittently (observed twice, then three clean runs after the
fix). It now waits for the ring to stop growing before asserting eviction. The
assertion itself is unchanged.

## D-085 — Reconciliation reports what it observed, not what it expected

`reconcileOnLaunch` closes a `handed_off` intent. Only a running version strictly
greater than the intent's `from_version` proves the update happened; a same-version
reinstall leaves the version unchanged, so a cancelled run would be
indistinguishable from a completed one. Reporting `observed_migrated` there would
also make the package a replay and strand the user. Anything else is recorded
`cancelled` with the observed and target versions kept. ADR-016 §3.

## D-086 — An engine acknowledgement is bound to a digest

`install()` accepts only the digest-bound `confirmEngineChange(sha256)`
acknowledgement; a boolean in the request is not evidence that the user saw *this*
package's engine change. Both review findings are recorded in
`docs/evidence/macos/P23-lifecycle.md`. ADR-016 §1, §3.

## D-087 — A live store is the only correct writer for its own file

Restoring a snapshot from Settings used to swap `mona.sqlite` under the open
`StateStore`. Its connection then pointed at the renamed inode, so the screen
showed the restored state while the running app kept writing into
`mona.sqlite.replaced-*` — and the next launch silently discarded that work. The
restore now routes through `StateStore.restoreFrom` when a store is open (barrier,
close, swap, re-open, rollback) and the file-swap path refuses if told a store is
open. Verification happens before any mutation in both paths. ADR-016 §4.

## D-088 — A failed restore puts the previous database back

The swap is failure-safe: the current database is moved aside first, and any
failure after that point restores it, re-verifies its integrity, and reports the
real outcome. The startup dialog no longer claims "Nothing was replaced" when the
rollback itself failed. ADR-016 §4.

## D-089 — Uncertain facts fail closed

A version Mona cannot order, a package that declares no identifier, bundle id, or
architecture, and an oversized package are all refusals — not "unknown, so fine".
`manifestFromPackage` no longer substitutes Mona's identities for ones the package
failed to declare, and `compareVersions` being total for sorting is never used as
an ordering guarantee. ADR-016 §1.

## D-090 — The uninstall plan is a fixed allowlist, and the docs say so

The shipped utility deletes four known paths after verifying identity; the
ownership manifest is a required precondition, not an instruction, so a hostile
manifest naming `/Applications` cannot widen the plan (proven by the smoke). ADR-
016 previously described the manifest as the source of the plan; that was wrong
and is corrected rather than "fixed" in the script, because the allowlist is the
stronger guarantee. In a rehearsal the `--remove-user-data` home must also be
inside `MONA_UNINSTALL_ROOT`, so the destructive branch is bounded by the same
guard as the payload. ADR-016 §5.

## D-091 — A rehearsal cleans up after itself

`rehearseInstall` and `rehearseUninstall` each copy the full ~390 MiB payload into
a temporary root and never removed it. On a machine near capacity that leaked
space every build until a build failed with `No space left on device` — which is
what happened while producing the P23 test artifact. Both rehearsals now remove
their root in a `finally`, so a failed rehearsal cannot poison the next build.
The peak footprint is unchanged (the copy is sequential); the leak is gone.

## D-092 — The build proves the metadata an update relies on

`productbuild` embeds only resources the Distribution references, so a
`Resources/update-metadata.json` staged at P23 was silently dropped while the ADR
claimed it shipped. The file is removed, and `verifyDeclaredMetadata` expands the
finished package and fails unless the identifier, version, build counter, both
bundle identifiers, the arm64 gate, and the OS floor are all declared — the exact
inputs `src/main/update/trust.ts` identifies a candidate by. It writes
`out/declared-metadata.json` as it passes, so the evidence survives a later gate
stopping the build. ADR-016 §6.

## D-093 — A report on disk never describes a different build

`manifest.json` was written only after the administrator-only install gate, so a
build stopped there left the previous build's report next to a fresh package:
"build 81" beside a build-89 artifact. The build now clears every report at
start and writes `package-report.json` — package digest, size, and all
package-level gates — before the install gate, leaving the install-dependent
gates explicitly `pending`. A later run rewrites `manifest.json` as before. This
was found by asking, in plain terms, how a person could tell which package they
had installed; the answer has to be checkable, not asserted. ADR-016 §6.

## D-094 — The Studio puts the agent console where the width is

At the operator's request, the Studio changed shape: the agent console (timeline)
is now a full-width panel at the top, and the prompt composer shares the row
beneath it with the Task / Requirements / Context inspector (350 px). Previously
the console sat in a `1fr` column beside a permanently docked inspector, so its
width was ~72% of the screen and its height was capped at `min(28vh, 320px)` —
about six events. Watching a turn was the point of the screen and the layout
fought it.

The console height is now `clamp(300px, 44vh, 620px)`: generous, but bounded so
the composer stays within a short scroll on a small window. Focus Mode keeps a
single column (the inspector is hidden there anyway) with a taller console.

This is measured, not asserted: the shell smoke gained four checks —
`studio_console_spans_width` (console ≥ 90% of the studio width),
`studio_console_is_tall` (≥ 340 px), `studio_console_above_composer`, and
`studio_inspector_beside_composer` (inspector starts after the composer ends and
their vertical ranges overlap). Measured at 1280×800: console 100% wide, 352 px
tall, inspector 350 px beside a 632 px composer.

The same run found a verification defect: the shell smoke could not run while
the user had the installed Mona open, because the smoke's second Electron lost
`requestSingleInstanceLock()` and exited silently with no report. The shell smoke
now passes its own `--user-data-dir`, so it is isolated from the real app state
and from the running instance. The same change was tried for `smoke:studio` and
**rejected**: with an isolated user-data directory that smoke fails with
`state store is closed` inside `WorkStudio.replay` (22 checks pass without it),
so the isolation was reverted there rather than shipped as a flaky gate.

## D-095 — A silent stream is a failure, not a busy turn

An operator report: a turn stopped mid-thought and never returned; "nothing else
happened in the turn"; a reconnect claimed to pick up from the cursor and stayed
broken. Reading the live state showed the shape of it — the stored cursor at
3523 with sequences 3173–3439 (267 events) missing, and a 12-minute silence
between two turns. Four defects, each independently reachable:

1. **No deadline on the event stream.** `for await` over the SSE body with no
   idle timeout: a healthy socket whose peer stops sending blocks the pump
   forever, so the console shows a live-looking turn that will never advance.
   Nothing errors, because nothing is wrong at the transport layer. `subscribe`
   now takes `idleMs`; every frame (including `stream.progress`) resets it, and a
   deadline yields `end: idle_timeout`, which is a reconnect.
2. **Resume from the highest stored sequence.** The pump asked for events after
   the cursor, so a hole *below* the cursor could never be fetched — no reconnect
   could ever repair it. It now asks from the first missing sequence
   (`StateStore.firstMissingSeq`), which is the hole.
3. **Reconnect was a no-op on a wedged session.** `start()` returned the existing
   snapshot whenever the connection merely *claimed* to be connected/running/
   reconnecting, without checking that the pump was alive. Re-attaching now
   requires a running pump; otherwise Start re-subscribes from the first missing
   event. This is why pressing reconnect changed nothing.
4. **A terminal event beat the gap repair.** `ingest` reported `terminal` even
   when it had just asked for a rewind, so the pump returned before reconnecting
   and the hole became permanent. A terminal event is now only honoured once no
   rewind is pending.

The gap budget (`gapRecoveries`, 2 per turn) is replaced by one rule: ask once per
hole, and if the engine does not send it, record that hole in `skippedGaps` and
stop asking. The engine's numbering may legitimately skip values, so retrying
forever would be the loop this replaces; asking once and recording the result is
both bounded and honest.

The stall and the hole are now visible: `StudioConnection` carries `lastEventAt`,
`silentForMs`, and `missing` ranges, the Studio shows "No engine events for Ns"
past 45 s of silence with a Reconnect action, and a explicit banner lists the
event ranges that were never received. A quiet stream during a long model call is
not a stall; a stream that never speaks again is.

Tests: `test/work-studio.test.ts` gains three — a stream that yields one event
and then never ends or closes (the test hangs without the watchdog), a hole that
must be filled by resuming from the hole rather than the cursor, and a hole the
engine refuses to replay (asked once, recorded, visible in `missing`).
`test/studio-screen.test.tsx` gains three that pin the banners.

## D-096 — The agent console reads the live edge of the event log

An operator report: the Studio's agent console "broke and is still not working"
and "remains hung in the exact same location". The earlier stream repair (D-095)
was real, but it addressed a different layer: the live thread was ingesting
events normally (cursor 4076, turns completing) while the screen showed only its
first turn.

**Root cause.** `StateStore.readProjectEvents` selected
`ORDER BY recorded_at ASC, seq ASC LIMIT 200`: the *oldest* 200 events. That is
the query `ProjectService.detail` feeds to the Studio. While a project had fewer
than 200 stored events the window covered the whole thread and the console
followed. Once the thread grew past 200 events, the window froze on its first
page forever. The renderer refreshed every 400 ms, but every refresh returned the
same first 200 rows; ingestion was healthy and invisible.

**Fix.** Select the newest `limit` rows in a subquery ordered
`recorded_at DESC, rowid DESC`, then re-order them oldest-first for the timeline.
`rowid` is the tiebreaker so events recorded in the same millisecond keep
insertion order. The window stays bounded (200 events, safe to refresh while a
turn streams); it now selects the live edge instead of the first page.

**Measured on the user's live state** (`prj_b66fc315c2eae670`, 2,120 stored
events, sequences 1690–4076, one known gap 3172–3439):

- before: window seq 1690–1889, last recorded event 21:30:41Z — the first turn;
- after: window seq 3877–4076, last recorded event 23:56:55Z — the newest turn,
  ending in `turn.completed` for `turn_10c0c1f74f6542eca2afb35df1e09b05`.

**Test.** `test/projects-service.test.ts` inserts 250 events and asserts the
detail window starts at 51, ends at 250, excludes seq 1, and advances to 251
after one more event. It failed on the old query (`expected 1 to be 51`) and
passes with the fix. 755 tests in 75 files; typecheck and lint clean (three
pre-existing `no-explicit-any` warnings in test files).

**Limit, stated rather than hidden.** The detail window remains 200 raw events,
so it may cover one long turn rather than the whole conversation. That is the
pre-existing bound and the reason the screen offers "Show earlier"; reading
further back needs a paginated event route, which this repair does not add.

## D-097 — Scale is page zoom owned by main, not a per-panel size

An operator request: hold Command and press plus or minus to resize the
interface. Measuring the existing build first was the whole decision.

**What already worked, and why it did not feel like it.** The View menu used
Electron's `viewMenu` role. Its Zoom In registers only
`CommandOrControl+Plus`; on a US layout "+" is Shift-equals, so the plain
Command-equals most people press was unbound — while the generic role also
listed a Developer Tools item that can never do anything here because devtools
are disabled. Zoom Out (⌘−) and Actual Size (⌘0) did work, and Chromium already
persisted the factor per origin: a probe set 1.5, quit, and read 1.5 back on
relaunch.

**The mechanism.** `webContents.setZoomFactor` scales the renderer uniformly —
CSS pixels, images, and scrollbars together. That is why a stylesheet full of
`px` (860 values, only 21 `rem`) is not a problem: no token rewrite, no
`rem` migration, no per-component multiplier. The same fact rules out reading
this as element sizing; density stays the setting for panel-level sizing.

**The ladder, and why it is discrete.** `src/shared/zoom.ts` holds
`0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2`, shared by main and renderer so the
displayed percentage is always the applied one. Free-form zoom drifts to
unusable factors (Chromium permits 25%–500%) and fractional factors blur
pixel-aligned edges. `normalizeZoom` snaps any stored or requested value onto
the ladder; impossible input (NaN, a string, an extreme) becomes 100%.

**Ownership and failure.** Main owns the factor and persists it in the
`app:zoom` settings scope, and applies it to every window at creation — a Dock
reopen comes back at the same size. `ZoomController` treats an unreadable or
unwritable store as a warning and keeps working at 100%: a broken settings row
must not make the app unusable, and the same rule already governs the other
projections.

**Verified.** 127 shell-smoke checks (three new: menu registered, the menu item
moves 1.0→1.1, the write persists), `p07-interface-scale.json` measuring four
rungs through the real menu items with no horizontal overflow (1180, 944, 786,
and 590 CSS px viewports), 15 new unit/screen tests, 770 tests in 78 files,
typecheck and lint clean.

**Limit, stated.** The 200-event Studio window and the compact-rail breakpoint
are unchanged. At 150% on a 1180-wide window the rail becomes the horizontal
strip the narrow layout already defines; that is a reflow, not a broken paint,
and the smoke measures it rather than asserting it is pretty.

## D-098 — One shared Runtime store per user home; Mona refuses rather than shares

- **Date:** 2026-11-13 (operator-requested verification)
- **Observation:** The engine keeps one Runtime store per user home with one
  live owner. A second host in that home — another Codewhale window,
  `codewhale web`, `serve --http`, or a second Mona — does not get its own store:
  the existing owner serves the new process's port (`lsof` on the requested port
  names the *first* pid), and `/v1/sessions` and `/v1/usage` answer with
  home-wide data. Mona's listener check therefore refused with
  `OWNERSHIP_MISMATCH` and the misleading advice to stop "a process Mona did not
  start", although the runtime it started was healthy and merely unneeded. The
  operator's independent Codewhale window was the suspected cause; measurement
  showed a plain TUI coexists, while a second *runtime host* does not.
- **Decision:** Keep the store shared and keep the refusal, but make both ends
  truthful:
  1. A preflight observes the store's owner lock (`tasks/runtime/
     runtime-process.owner.lock`, held open by the owner) and refuses before
     spawning, naming the pid, executable, and command line, and distinguishing
     a leftover of Mona's own making from another host.
  2. The listener check names the store owner when the stranger *is* the owner.
  3. Engine reads are fenced to the project's workspace; `session.resume` is
     refused while a project is attached, because a saved-session id in a shared
     store cannot be proven to belong to this project.
  4. `CODEWHALE_HOME` stays the user's real engine home. **Isolation is
     rejected:** credentials and route configuration (`secrets/secrets.json`,
     `config.toml`, catalogs) live there, so an isolated store means no provider
     and no useful Mona — and spec §650 forbids rewriting the runtime home for
     packaging convenience. Isolation is a compatibility decision that needs its
     own engine-compatibility evidence, not a bug fix.
  5. `attachExternal` is not wired to a screen. It is read-only *and* tokenless
     (`RuntimeSupervisor.endpoint()` returns `null`), so it can show status but
     never drive work; the accurate refusal is more useful than a screen with no
     capability behind it.
- **Why not work around it:** sharing the store would mean Mona driving a
  runtime it did not start, and inventing isolation would silently rebuild the
  user's credential resolution. Both are worse than an honest refusal that names
  the other host.
- **Consequence:** Mona and one Codewhale runtime host cannot run at the same
  time under one user account; the failure now says exactly that, before a
  process is spawned. A plain Codewhale TUI, a foreign workspace lock, and
  coordination state remain compatible (verified). Evidence:
  `docs/evidence/macos/runtime-store-coexistence.md`.

## D-099 — Engine `seq` is one global counter; loss is `previous_seq`, and it is a ledger

- **Date:** 2026-11-13 (operator-reported studio notice)
- **Observation:** The Studio showed "Some engine events were never received —
  #3173–3439, #4078–4101" permanently. The engine's own journal had the same
  holes, and every one of those 291 sequences belonged to a different Runtime
  thread (three smoke runs and 24 one-event probes). The Runtime allocates `seq`
  from a counter shared by all threads and documents that clients must not infer
  loss from `seq == previous_seq + 1`.
- **Root cause:** Mona inferred loss from contiguity in three places (`ingest`,
  `firstMissingSeq`, `eventGaps`) and ignored `previous_seq`, which its own
  envelope already parsed. Consequences: a permanent, false notice; a
  rewind-and-replay of up to 7,016 duplicate frames on every attach
  (`since_seq=3172`); and a spurious stream break whenever another thread took a
  slice of numbers mid-turn — which is what the P23 record misattributed.
- **Decision:**
  1. `event_gaps` (schema v9) is the only record of loss: `thread_id,
     first_seq, last_seq, detected_at`. It is written when the engine reports a
     hole and deleted as replayed frames arrive, so a filled hole stops being a
     gap.
  2. Loss is `previous_seq > accepted cursor` on a thread with a cursor. A
     replay resumes from the cursor accepted before the hole. Contiguity is
     never consulted.
  3. The pump concludes each replay against the ledger: filled, or "replayed and
     not returned" (recorded once, then left as a fact). Silence about a hole is
     not allowed in either direction.
  4. `connection.missing` is a read of that ledger; `firstMissingSeq` is
     removed rather than reworded.
- **Rejected:** recomputing holes from stored sequences with a wider window
  (still wrong), a dismissible notice (hides loss instead of recording it), and
  deleting the affected thread's events (destroys evidence and does not address
  the counter).
- **Consequence:** the operator's two ranges vanish without data surgery; an
  attach on that thread replays nothing; a genuine hole is still shown and still
  says why. If the engine ever omits `previous_seq`, Mona stops claiming loss
  rather than guessing. Evidence: `docs/evidence/macos/engine-event-gaps.md`.

## D-100 — Plumbing is counted, known frames are projected; only real drift stays "unrecognized"

- **Date:** 2026-11-13 (operator-reported console noise)
- **Observation:** "Unrecognized event · operation.heartbeat" appeared every ten
  seconds. Heartbeats carry only `{ observed_at }`. Auditing every kind the
  engine actually stored also found `turn.artifacts` (which Mona already
  captures into its change set), `item.interrupted`, and
  `turn.interrupt_requested` labelled the same way.
- **Cause:** the timeline's plumbing set was missing `operation.heartbeat`, and
  three kinds the engine emits had no projection at all. The Studio's
  "not projected" diagnostic keyed off `KNOWN_EVENT_KINDS` alone, so a known
  plumbing frame was recorded as drift and could evict a real diagnostic from
  the 12-slot ring.
- **Decision:**
  1. `ENGINE_PLUMBING_KINDS` is a shared contract list with two consumers: the
     timeline counts those frames, the Studio does not diagnose them. Adding a
     future plumbing kind is one edit in one place.
  2. `turn.artifacts`, `item.interrupted`, and `turn.interrupt_requested` are
     projected as first-class status cards and added to `KNOWN_EVENT_KINDS`.
  3. A kind in neither list is still shown as unrecognized. That is the
     guarantee this change preserves: no frame the build has never seen is
     silently swallowed.
- **Rejected:** hiding all `operation.*` events by prefix (the prefix also
  carries activity marks that explain a stalled turn), and dropping heartbeats
  from storage (they are the engine's liveness record; the console is a
  projection, not the archive).
- **Consequence:** the console shows conversation, tools, and outcomes; plumbing
  appears only as "N engine activity events stored". Evidence:
  `docs/evidence/macos/P08-studio.md`.

## D-101 — Publication scrub: no secret was found, and the history was still rewritten

- **Date:** 2026-11-13 (operator: "carry out all your recommendations")
- **Context:** the working tree was pushed to a **public** repository,
  `github.com/king-felix/Mona_MacOS-MacMona`, at the operator's explicit request
  (AGENTS.md rule 7 otherwise reserves public hosting for Victor; this is
  Victor's own instruction). Before pushing, the operator asked whether any key
  had been committed.
- **Audit result — no credential was ever committed.** The live key
  (`~/.codewhale/secrets/secrets.json`, `entries.deepseek`, 35 characters) was
  compared against every blob in all 108 commits: exact match 0, any 10-character
  window 0, base64/hex/URL-encoded forms 0. No `.env`, `secrets.json`, `id_rsa`,
  `id_ed25519`, `.pem`, `.p12`, or `.key` file was ever tracked. Every
  `-----BEGIN … PRIVATE KEY-----` occurrence is a bare marker inside a unit-test
  assertion with no key material. The scanner's 10 findings were two fake
  `sk-live-…` fixtures and eight captured `machine-home-path` strings.
- **Decision — three changes, none of them a rotation:**
  1. The two fixtures are now `sk-fixture-notreal01`: still ≥8 characters after
     the prefix, so `redactDiagnostics` must still strip them, but below the
     scanner's 20-character threshold. `test/settings-workbench.test.ts` now
     asserts the fixture is *present* in the raw text before asserting it is
     gone, so that coverage cannot silently become vacuous again.
  2. `p01-live.json`, `p16-p17-ci.txt`, and `p18-tests.txt` normalize the
     account name and home paths to `<user>` / `/Users/<user>`, each carrying a
     written provenance note. No measurement in them changed.
  3. History was rewritten (`git filter-repo`) so the old fixture values and the
     account name are not in the public record either: 108 commits, tip tree
     **byte-identical** (`fea6437…`), 1,715 blobs re-scanned with 0 residue.
- **Verified:** 791 tests in 79 files; `smoke:terminal` 31/31 with
  `log_redacts_key: true` and `log_redacts_home: true`; lint, typecheck, build
  clean; `monabuild validate` green; `monabuild secrets` 0 findings (was 10).
- **Rejected:** rotating the key (nothing leaked; rotation would be theater),
  deleting the evidence files (destroys the record the build is built on), and
  leaving the account name (a public personal identifier plus permanent scanner
  noise).
- **Commit mapping** (the rewrite means old SHAs no longer exist):

  | Role | Before | After |
  | --- | --- | --- |
  | Gap-ledger repair | `7e71273` | `0e3f1c0` |
  | Console plumbing fix | `10d8375` | `4d893fc` |
  | Pre-scrub tip | `db830e1` | `5b15c66` |
  | Last verified before this session | `76c9863` | `ba199da` |
  | P23 verified commit (HANDOFF) | `f755d8a` | `6a492d0` |

- **Limits, stated:** GitHub may keep unreachable objects reachable by SHA for a
  time, and pages, API caches, forks, and clones made before the rewrite keep
  their own copies. Rewriting history also means any clone taken earlier no
  longer shares ancestry; it must be re-cloned rather than pulled.

## D-102 — Public repository: gate turned green, and the security posture read through `gh`

- **Date:** 2026-11-13 (operator: "carry out your recommended actions that are safe")
- **Context:** `gh` authenticated as `king-felix` over SSH. The account's only SSH
  key is labeled `Cline Is My Boy` (2026-10-24) and its fingerprint matches
  `~/.ssh/id_ed25519.pub`, so the key Mona pushes with is that entry. No
  `AGENTS.key` file exists; a second registration of the same public key is
  refused by GitHub, which is why the label did not change. Victor confirmed the
  old label is his own and should stay.
- **Gate:** `npm run ci` had been red at its first step (`format:check`) on four
  files inherited from an older Prettier — `adapter.ts`, `ipc.ts`,
  `Settings.tsx`, `runtime-process.test.ts`. `git diff -w` shows line wrapping,
  trailing commas, and one import reflow; no logic. After formatting, the full
  gate passes: **exit 0, 21/21 steps**, including three native builds, 791 tests,
  and 13 smokes (lifecycle 34 s).
- **Run records:** the smokes regenerate their own artifacts (HANDOFF items
  97/98/117). Their evidence hashes were re-recorded in the same commit; no
  assertion was removed.
- **Security posture, measured through the API rather than assumed:**
  - secret scanning **enabled**, push protection **enabled**, **0 alerts** in
    open and resolved state. The prediction that GitHub would flag the
    historical fake fixtures was **wrong**, and the measurement wins.
  - vulnerability alerts were **disabled**; enabled now. That surfaced **2
    medium** advisories: `minimatch` `>=7.0.0, <11.0.1` and `glob`
    `>=9.0.0, <=14.0.1`.
  - Both are **dev-only transitive** dependencies
    (`@electron/packager → @electron/asar`, `eslint`, `typescript-eslint`). Mona's
    shipped runtime dependencies are `react`, `react-dom`, `zod`, so a recipient
    of the packaged app is not exposed. Fixing them means a semver-major jump
    (minimatch 10→11, glob 13→14) inside the linting/packaging toolchain, which
    is a dependency decision with breakage risk, not a safe unilateral edit.
    **Recorded, not fixed.**
  - `secret_scanning_validity_checks` and
    `secret_scanning_non_provider_patterns` were requested twice and remain
    **disabled**; GitHub accepted the request without applying it. Reported as
    attempted-and-refused rather than claimed.
  - No CI workflow exists (0 workflows). Adding one needs a macOS runner for the
    Swift service and pty helper; that is unverified here, so no workflow was
    invented to turn a badge green.
- **Not done, deliberately:** deleting and recreating the repository to purge the
  unreachable-by-ref commits (destructive, needs `delete_repo`), and deleting
  `/tmp/git-backup-pre-rewrite` (the only local copy of the pre-rewrite history).
  Both need the operator's word.

## D-103 — The Studio review runs in a subordinate, code-enforced ledger

- **Date:** 2026-11-14 (R00)
- **Context:** Victor supplied `MacMona_Studio_Review_PROMPTS.md` (review 1.0,
  reviewed remote commit `10d8375`, local equivalent `4d893fc`) and
  `MacMona_Review_Hotfix.patch` (sha256 `a253a05e…`), and asked for R00 first.
  The review requires a subordinate plan under
  `.mona/build-macos/reviews/studio-v2/` with revision checks and evidence
  hashes, and forbids restarting P00 or resetting attempt counts.
- **Decision:** R00–R15 and findings RV-01…RV-13 plus UX-FULLSCREEN,
  UX-COMMANDS, UX-COMPOSER, UX-AURORA and UX-AGENT-COMMS are tracked in
  `reviews/studio-v2/state.json`, written only by `monabuild review`
  (`tools/monabuild/lib/review.mjs` + `schemas/review.schema.json`). The
  original P00–P27 state stays authoritative for product requirements.
- **Why mechanism, not prose:** the review CLI enforces schema, exact task/issue
  sets, prerequisite cycles, `current_task` agreement, a completed task with
  remaining acceptance, evidence-file existence and hashes, and — through the
  shared `attempts.jsonl` — that a task naming a blocked problem cannot be
  completed. Atomic replacement, a single-writer lock and `--expect-revision`
  are inherited from the same utilities as the product ledger.
- **Hotfix:** applied with `git apply`, unmodified. The only commits between the
  reviewed baseline and HEAD are the format-only cleanup of four other files
  (`4411ef1`), shortened secret fixtures (`5b15c66`), and ledger/evidence
  updates; the six hotfix files were byte-identical, so no adaptation was
  needed and none was invented. With the three source fixes stashed and the
  regression tests kept, exactly the five expected tests fail (24 pass), so the
  tests demonstrably catch the defects they claim.
- **Evidence hashes:** `store.ts` changed, invalidating the P10/P19 recorded
  hash `89944463…`. It was re-recorded only after the full suite passed on the
  new bytes, with a note saying the original reports describe the pre-review
  bytes. The 19 shell captures rewritten by the R00 smoke were re-recorded per
  task with notes. No old report was rewritten and no assertion was removed.
- **Findings disposition at R00:** RV-03/04/05/07 and UX-COMPOSER verified;
  RV-11 verified (already closed at `4411ef1`, confirmed green); RV-01/02/06/08/
  09/10/12/13 and the remaining UX IDs stay open on their owning tasks.
- **Not claimed:** drafts/navigation lossless (R01), history paging (R02),
  slash commands (R03/R04), immersive/fullscreen Studio (R05), Aurora visuals
  (R06), approvals (R07), follow-ups/steering (R08), HUD (R09), conveniences
  (R10), accessibility/perf matrix (R11), installed artifact (R13), signed
  release (R14). `--mode release` still fails closed.

## D-104 — The release pipeline refuses rather than substituting (P22)

- **One command family, one rule.** `mac:release:preflight`, `mac:release` and
  `mac:verify-release` all live in `packaging/macos/release.mjs`.
  `mac:package:release` was repointed at `mac:release`, so no second path can
  produce a signed-but-unnotarized package under a release name.
- **Refusal is a receipt, not a sentence.** Preflight writes
  `out/release-preflight.json` with `ok: false` and every missing prerequisite,
  then exits 3. `release` runs the same gate first and, when it fails, writes
  `{ stage: "preflight" }` and produces no artifact. The refusal is machine
  readable, so "no package" is verifiable rather than promised.
- **Only `Accepted` passes.** `notaryVerdict()` maps `In Progress` to a resumable
  pending job and every other value to a refusal. A 200 from `notarytool submit`
  is not evidence of notarization; the status string is.
- **Inside-out, never `--deep`.** `signingOrder()` enumerates every Mach-O file
  and nested bundle and orders them deepest-first, with a helper's executable
  before its bundle and the outer app last. `codesignArgs()` has no code path
  that emits `--deep`. A blanket deep signature would hide precisely the missed
  component the audit exists to find.
- **Entitlements are earned per class.** Main app and Electron helpers get the
  three documented Electron entitlements; helpers additionally get `inherit`;
  the Service gets an empty file. Frameworks, dylibs, native helpers and the
  engine get none. The mapping is a pure function with a test per class.
- **Local mode is unchanged.** `--options runtime` with an ad-hoc signature is
  not a release shape, so local packaging stays exactly as P21 left it. Build
  139 re-verified the refactor: 25 components signed inside-out, 17 Mach-O files
  and 8 nested bundles sealed, then the documented `installed_copy` gate stopped
  the run.
- **Not claimed:** notarization, stapling, Gatekeeper acceptance, offline launch
  after stapling, and the installed nested execution path. None of them ran
  because EXT-SIGNING has no credential on this host.

## D-102 — A blocked qualification reports the rows it could not settle

- **Date:** 2026-11-14 (P24, review R13–R15)
- **Context:** P24 asks for a clean-recipient matrix on a second Apple silicon Mac
  or clean VM against "the actual distribution bytes". Neither the host nor a
  signed artifact exists here. The instruction is explicit that the harness and
  checklist should be finished and the qualification kept blocked — so the risk
  is a report that looks complete because everything measurable passed.
- **Decision — statuses, not a score.** `scripts/p24-recipient.mjs` gives every
  matrix row one of four statuses: `passed`, `failed`, `recorded` (an observation
  that decides nothing, such as which Git this host has), or `untested` (a fact
  this host cannot establish, with the reason). `qualification` is `qualified`
  only when nothing is `failed` and nothing is `untested`, and the process exits
  non-zero otherwise. There is no average, no percentage and no "mostly green".
- **Decision — measure the refusal.** The harness quarantines a *copy* of the
  package the way a browser download arrives and runs `spctl -a -vv -t install`
  on it. For the unsigned local build that is a rejection, and the rejection is
  recorded as a failed row: it is the same measurement a recipient would get.
  Nothing removes the attribute, disables Gatekeeper, or offers a right-click
  recipe — those would turn a prerequisite into a bypass.
- **Decision — read the package, not the staging tree.** `pkgutil --expand-full`
  unpacks the payload, so architecture, minimum OS and the removal utility are
  read from the bytes that would ship. A staging directory passing would prove
  only that the build was hopeful.
- **Consequence:** P24 is `blocked` on EXT-SIGNING and EXT-RECIPIENT-HOST with a
  re-runnable harness; when a signed artifact and a second host exist, the same
  command either goes green or names exactly which row fails. No attempt is
  counted, and moving the matrix to another host later cannot reset the count.

## D-103 — There is no shareable release; the deliverable is a local build

- **Date:** 2026-11-14 (owner decision, closing P22/R14)
- **Context:** P22 and R14 were blocked on Developer ID credentials. The owner
  has decided there is **no Apple Developer account and none will be obtained**.
  Mona is not published: the owner runs it on the machine that builds it, and
  anyone else builds it from source.
- **Decision:** the distribution tier is **local**. `npm run mac:package:local`
  produces an ad-hoc-signed `.pkg`, and `npm run mac:package:dmg` produces a
  local disk image of the same ad-hoc-signed app, labelled as a local build, with
  a notice in the image stating that Gatekeeper refuses it on any other Mac and
  that other people build their own. `npm run mac:release` remains implemented
  and **still fails closed** — it is not repurposed, renamed, or weakened to
  produce something that looks shareable.
- **Why not delete the release pipeline:** it is the mechanism that keeps the
  claim honest. If credentials ever appear, it produces a real artifact; until
  then it refuses. Its 17 trust tests stay in the suite.
- **Consequence:** P22, P24 and R14 are recorded as `skipped` by owner decision
  (scaffolding plus independent work retained, artifact never produced), RV-12 is
  `wontfix` (a local package is not meant to be friend-ready here), and MAC-005 /
  MAC-007 stay unsatisfied with that reason. No requirement is marked satisfied
  to make the matrix look complete.

## D-104 — The OS floor is declared at 14.0 and tested on 26.x

- **Date:** 2026-11-14 (owner decision, resolving OPEN-OSFLOOR's claim question)
- **Decision:** the release claim is "requires macOS 14.0 or later; tested on
  macOS 26.5.1". The 14.0 floor is declared in the payload, the `Distribution`
  and the preinstall script, and is enforced by the installer; no 14.x host has
  executed it, and the owner accepts that.
- **Why this is not a lowering:** the claim now states exactly what was measured.
  The alternative — asserting "tested on 14.0" — would be a fabricated fact.
- **Consequence:** `r13`/P24 evidence names the tested host and the declared
  floor separately; P26 records the same. A 14.x run would upgrade the claim, and
  nothing forbids adding it later.

## D-105 — Git is a documented dependency, not a bundled payload

- **Date:** 2026-11-14 (owner decision, resolving OPEN-GIT)
- **Decision:** Mona does **not** bundle Git. Core features (launch, edit,
  terminal, engine turns, the acceptance sample) need no developer tools, and
  packaged Mona refuses Apple's `/usr/bin/git` CLT stub rather than triggering
  the developer-tools installer. Git **features** therefore require Xcode Command
  Line Tools or another Git, and report themselves unavailable with that reason
  when neither exists.
- **Why:** bundling a relocatable Git carries a GPL source-offer obligation the
  owner has declined; documenting the dependency is the honest alternative.
- **Consequence:** MAC-004 stays `partial` — "no mandatory consumer development
  tools" is true for core work and false for Git features, and the docs say which
  is which. No installer is silently triggered, and no bypass is offered.

## D-106 — A skipped prerequisite satisfies its dependants

- **Date:** 2026-11-14 (P22/P24 decisions, above)
- **Context:** eligibility required every prerequisite to be `completed`, so
  skipping P22/P24 would leave P26/P27 permanently ineligible — the ledger would
  keep saying "blocked" about a question the owner had already answered.
- **Decision:** `computeNextEligible` (product ledger) and `eligibleTasks` (review
  ledger) treat `skipped` as satisfying a prerequisite. `blocked` and unfinished
  states still hold the queue. Covered by
  `tools/monabuild/test/store.test.mjs` ("a prerequisite settled by decision
  satisfies its dependants, a blocked one does not").
- **Why:** `skipped` means "decided not to do this", which is a settled outcome;
  conflating it with "not done yet" would misreport what is actionable.

## D-107 — The install is one authorized command; the image is on request

- **Date:** 2026-11-14 (owner request)
- **Context:** installing the latest build took three steps with a deliberate
  failure in the middle: `mac:package:local` refused at the `installed_copy` gate
  because `/Applications` still held the previous build, then the operator ran
  `sudo installer`, then re-ran the packaging command to close the gates. The
  gate is right; the ritual around it was not. The owner also said a disk image
  is wanted only on request.
- **Decision — `npm run mac:install` performs the whole cycle.** It builds and
  packages exactly as `mac:package:local` does, installs that package with
  `sudo` on the caller's own terminal, then runs the install-side gates against
  the result. The gate is not skipped: `copyToApplications` still compares the
  full content digest, and it now re-checks *after* installing and refuses to
  certify a copy that does not match the artifact built in the same run.
- **Decision — no silent authorization.** `sudo -n` is not used. If the run has
  no terminal it refuses immediately with the two remedies, because a subprocess
  waiting on a password prompt that can never arrive is worse than a refusal.
  This was observed: the first implementation hung on `sudo installer` with
  stdin closed; the guard and a ten-minute deadline are the fix.
- **Decision — the DMG is on request.** `mac:package:dmg` stays (it is the local
  image, verified from its own bytes) but is not run by `mac:install`, by
  `mac:package:local`, or by CI. Its cost is a second ~170 MB artifact and a full
  copy; there is no reason to pay that on every build.
- **Consequence:** the ordinary loop is `npm run mac:install`. The image is
  `npm run mac:package:dmg` when asked. The difference between the two is stated
  in the owner guide: the image installs the app only, the package also updates
  the Finder Service.
