# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P04, revision 44) · verified content commit
`31fe0e0` (evidence redaction follow-up `098a7d2`)
**Current prompt:** P05 — **pending, not started**

## Where the build stands

P00–P04 are complete: qualified headless integration, a secure desktop shell, a
contract-tested engine adapter, and a native process supervisor with an honest
desktop lifecycle. No product UI is connected to the engine yet; the shell still
shows “Not connected” and “Cost unknown”.

### P04 — owned runtime processes (complete)

- **Native supervisor.** `native/macos-supervisor` (Swift, arm64, macOS 14
  target, ad-hoc signed) leads each owned runtime tree. The child is spawned in
  its own process group; the supervisor samples descendants every 250 ms and
  stops escaped/reparented grandchildren by `(pid, start time)`. It never
  signals a pid whose start time changed, never kills by name, and exits with
  the child or owner — no login item, launch agent, or daemon.
- **Owner liveness.** fd 3 carries the runtime bearer token as its first line
  and then EOF on owner death. The token is never on argv or in the supervisor
  environment. The supervisor stops the tree and exits on EOF.
- **Stop receipts.** A mode-0600 control socket answers `status`, `stop`, and
  `force-stop`. Stop is TERM to the verified tree → bounded grace → KILL only
  verified survivors. Receipts carry `graceful`, `escalated`, `survivors`, and
  child exit; “stopped” is never inferred from silence.
- **Ownership records.** Atomic 0600 JSON at `<state>/runtime-ownership.json`
  with executable path + SHA-256, supervisor/child pid + start time, pgid, port,
  control socket, engine identity, state, and receipts. **No token field.** One
  owned runtime per user store; a second workspace gets `ALREADY_OWNED`.
- **Stale recovery.** Verified orphans are stopped; a reused pid or foreign
  executable yields `STALE_OWNERSHIP` with no signal. External runtimes are
  read-only attach and are never stopped by Mona.
- **Startup hardening.** Workspace and executable validation with SHA-256, port
  bind preflight, child parent/start/executable verification, authenticated
  loopback `/v1/runtime/info`, pinned compatibility, and listener-in-tree
  verification. Occupied port, permission denial, missing/non-executable
  engine, missing supervisor, incompatible engine, startup timeout, and
  ownership mismatch are typed and carry an action.
- **Desktop lifecycle.** Single instance; a second launch hands its folder over
  and exits. ⌘W keeps the app and runtime; Dock reopen shows the same work. A
  renderer crash does not touch the runtime. Sleep → `reconnecting`, resume
  probes health, and an unhealthy runtime is stopped before a bounded restart.
  Runtime crash restarts **the process only** — never resubmits work.
- **Transitions.** Pause-after-task (queue boundary), interrupt-now (engine
  receipt, uncertainty reported), cancel-queued (future starts only), and
  quit-and-stop (interrupt then stop, one bounded forced escalation, no rollback
  claim) are separate, tested transitions.
- **Verification.** 119 tests in 16 files; Electron lifecycle smoke 21/21; real
  pinned-engine smoke 17/17 through the supervisor (completed turn, 15 events,
  `deepseek`/`deepseek-flash`/`full_access`, listener verified in-tree, clean
  shutdown, record stopped). CI green; renderer secret scan 226,270 bytes, no
  findings.

## Next exact action (P05)

Read spec §8, §10.1, §17; the P00 bootstrap state helpers (`tools/monabuild/`);
P03 submission contract (`src/main/engine/submission-store.ts`,
`adapter.ts`); P04 ownership records (`src/main/supervisor/records.ts`); this
handoff. Then implement transactional project state:

1. Choose the SQLite mechanism available in the Electron 45 embedded Node
   (24.22.2) — verify `node:sqlite` locally or pin a native module; record the
   decision. No DB inside the app bundle, iCloud, or a shared system payload.
2. Schema and migrations for projects, runtime bindings, threads, turns,
   submissions, tasks, dependencies, requirement evidence, attempts, decisions,
   event cursors, usage, capability snapshots, settings versions. Foreign keys,
   revision checks, one write path.
3. Engine session history stays authoritative; store IDs/projections only.
4. Atomic project export/import with digests and revisions; artifacts as bounded
   files with metadata; retention and disk-space handling.
5. Per-user Application Support paths; verify two macOS users cannot read each
   other’s runtime tokens or receive each other’s sessions.
6. Migration backup/restore via a safe snapshot; a maintenance barrier every
   writer (adapter ingestion, indexer, task runner) must respect. Keep the old
   DB on validation failure; never unlink a recovery journal as an optimistic
   repair.
7. Crash-injection tests before/during/after a transaction; stale-revision
   writes fail; migration failure is recoverable; backup/restore with writers
   quiesced; disk-full does not produce false completion; two aliases of one
   project do not duplicate it; test relocation and distinct worktrees.

Do not start P05 unless it is the assigned prompt; the requested P04 work is
complete, so pause here.

## Nonblocking issues carried forward

1. **Single-owner runtime** — enforced (`ALREADY_OWNED`). Parallel ownership
   still needs a future tested engine decision; never invent a separate
   `CODEWHALE_HOME`.
2. **Direct cost unknown** — `codewhale exec` agent mode omits the usage split
   and price coverage. No exact-parity claim may be made.
3. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
   search/restore, terminal, and fleet are not adapter operations yet.
4. **Usage cost completeness** — `costComplete: false` appears whenever unpriced
   turns are in range; preserved honestly.
5. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
6. **No Developer ID signing** — P22 prerequisite; local app and supervisor are
   ad-hoc signed.
7. **Supervisor packaging** — the compiled binary is gitignored; P21 must ship
   it beside app resources and P22 must sign it.
8. **Physical sleep not performed** — suspend/resume is qualified with real
   Electron power events plus unit tests; a lid-close test remains manual.
9. **Keep-awake cleanup not implemented** — optional P04 item; no assertion is
   taken, so nothing is released.
10. **Renderer state not wired** — P07 consumes `RuntimeSupervisor.status()`;
    the shell is still the P02 placeholder.
11. **Pause/interrupt controls have no UI** — `WorkController` is implemented and
    tested; P08/P11 connect it.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 44).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-013.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability (never hand-edit).
- `docs/codewhale-capabilities-macos.json` — 72 qualified rows.
- `docs/discovery-macos.md` — host/engine facts plus P01 qualification.
- `docs/decisions/ADR-001-desktop-stack.md`, `ADR-002-ipc-boundary.md`,
  `ADR-003-runtime-supervisor.md`.
- `docs/evidence/macos/P01-feasibility.md`, `P02-foundation.md`,
  `P03-adapter.md`, `P04-supervisor.md`.
- `docs/evidence/macos/artifacts/p04-*`.
- `native/macos-supervisor/` — Swift supervisor plus build/test notes.
- `src/main/supervisor/` — identity, records, native client, restart policy,
  runtime supervisor; `src/main/work/control.ts` — transitions;
  `src/main/desktop-lifecycle.ts` — Electron lifecycle.
- `src/main/engine/` — adapter and supervised runtime driver.
- `scripts/build-supervisor.mjs`, `scripts/lifecycle-smoke.mjs`,
  `scripts/engine-smoke.mjs`.
- `AGENTS.md` — operating contract and commands.
