# ADR-003 — Owned runtime supervision and desktop lifecycle (P04)

**Status:** accepted · **Date:** 2026-11-11

## Context

P01 measured two facts that make naive process control unsafe on this Mac:

1. The installed npm wrapper spawns the native binary as a **grandchild**, and
   the listener belongs to that grandchild, not to the pid returned by `spawn`.
2. A second `app-server` attaches to the first runtime owner on the same user
   store. Parallel ownership is not supported, and inventing a separate
   `CODEWHALE_HOME` is forbidden because it changes credentials, sessions, and
   caching.

P03 shipped a minimal spawn/stop path sufficient for the adapter. P04 must make
Mona a supervisor that can stop its own work without killing unrelated
processes, survive renderer and window events, and be honest when a stop cannot
be confirmed.

## Decision

1. **A native supervisor process owns each runtime tree.**
   `native/macos-supervisor` (Swift, arm64, deployment target macOS 14, ad-hoc
   signed) is spawned per owned runtime with the engine as its child. It exits
   as soon as the child exits or the tree is stopped. It installs no launch
   agent, login item, or root service, so a detached child cannot turn Mona
   into a daemon by accident.
2. **Owner liveness is a pipe on fd 3.** Mona writes the runtime bearer token as
   the first line, then keeps the pipe open. The token never appears in argv or
   in the supervisor environment. EOF means the desktop owner is gone; the
   supervisor stops the tree and exits. The initial target on main-process
   failure is clean child termination, not daemon survival.
3. **Process groups plus sampled identity.** The child is spawned with
   `POSIX_SPAWN_SETPGROUP`, so it leads its own group. The supervisor samples the
   descendant tree every 250 ms and retains `(pid, start time)` for every
   descendant. At stop it signals the group only while the leader's identity
   still matches, and separately signals tracked descendants whose identities
   still match — this covers grandchildren that `setpgid()` or are reparented to
   launchd. Sampled identity is refreshed once more immediately before signaling.
4. **PID reuse is a hard stop.** A pid whose `ps` start time differs from the
   record is a stranger: Mona never signals it. The same rule applies to the
   durable record, the control-socket fallback, and stale-record recovery.
5. **Control socket for receipts.** A Unix-domain socket (mode 0600 in a 0700
   directory, with a short-path fallback under the temp directory) accepts
   `status`, `stop`, and `force-stop`. A stop is TERM to the verified tree,
   a bounded grace period, then KILL only for verified survivors. The receipt
   reports `graceful`, `escalated`, `survivors`, and the child exit, so "stopped"
   is never inferred from silence.
6. **Ownership records are durable and token-free.** Records live at
   `<state>/runtime-ownership.json`, written atomically with mode 0600. They
   carry executable path and SHA-256, supervisor and child pid plus start time,
   process group, port, control socket, engine identity, state, and receipts.
   They never carry the bearer token, so a copied state file cannot impersonate
   a runtime.
7. **One owned runtime per user store.** Starting a second workspace while one
   is live is refused (`ALREADY_OWNED`); stale records are reconciled first.
   A verified orphan is stopped through its recorded identity. A reused pid or a
   foreign executable stops reconciliation with `STALE_OWNERSHIP` and no signal.
   A runtime Mona did not start is read-only attach and is never stopped.
8. **Desktop lifecycle is explicit.**
   - One instance owns the app; a second launch dispatches its folder and exits.
   - Closing the last window (⌘W) leaves the app and runtime alive; Dock
     reopen reuses the same work.
   - A renderer crash is recorded and leaves the runtime untouched.
   - Sleep becomes `reconnecting` without a new request; resume probes health,
     and an unhealthy runtime is stopped before a bounded restart.
   - Runtime crash restarts **the process only**, with exponential backoff and a
     cap. Reconciling or resubmitting a turn is a separate decision; restart
     never spends inference.
   - Quit (⌘Q) runs the quit-and-stop transition: interrupt the active turn if
     any, then stop the owned tree, with one bounded forced escalation. Forced
     termination is cleanup, never rollback.
9. **Transitions stay distinct.** Pause-after-task is a Mona queue boundary;
   interrupt-now is an engine operation with a receipt; cancel-queued removes
   future starts; quit-and-stop composes interrupt and shutdown and reports
   uncertainty truthfully.
10. **Startup failures carry an action.** Occupied port, permission denial,
    missing or non-executable engine, missing supervisor, incompatible engine,
    startup timeout, and ownership mismatch are typed, and each names the next
    action. An HTTP 200 on an occupied port is never accepted as ownership;
    the listener must be inside the supervised tree and run the recorded binary.

## Consequences

- Packaging (P21) must ship the compiled supervisor beside the app resources;
  `resolveSupervisorBinary` already checks `process.resourcesPath`.
- P05 moves ownership records into the transactional store without changing the
  identity/token rules. P07 reads `RuntimeSupervisor.status()` for real UI state.
- P11's queue builds on `WorkController`; the transitions and their truthfulness
  rules are already contract-tested.
- A stop that leaves survivors is reported and retained for a forced retry; it
  is never reported as stopped.
- A physical lid-close sleep was not performed on the build machine. The
  suspend/resume wiring is exercised with real Electron power events and the
  state machine is unit-tested; that limitation is recorded in the P04 evidence.
