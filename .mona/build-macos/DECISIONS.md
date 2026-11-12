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
