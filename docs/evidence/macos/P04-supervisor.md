# P04 — Owned runtime processes and truthful stopping

**Date:** 2026-11-11 · **Engine:** pinned Codewhale 0.10.2 (`ff466b2ed0bf`) ·
**Status:** complete · **Host:** macOS 26.5.1 arm64

## Result

Mona now owns a supervised runtime process tree instead of a single spawned
pid. A native arm64 Swift supervisor leads the tree, tracks descendants by
`(pid, start time)`, stops grandchildren including escaped process groups, and
exits with its owner. The desktop has one instance, distinguishes window close
from quit, survives renderer crashes and sleep/wake, reconciles stale ownership
records without killing strangers, and restarts only the process after a
bounded crash sequence.

Verification: **129 tests in 16 files pass**, the Electron lifecycle smoke passes
**21/21** checks, the real pinned-engine smoke passes **17/17** checks through
the supervisor, and local CI is green (`p04-ci.txt`).

## Native supervisor

`native/macos-supervisor/main.swift` → `build/mona-supervisor` (Mach-O arm64,
deployment target `arm64-apple-macos14.0`, ad-hoc signed and verified,
SHA-256 `033ee5b2…a708e07a`, 201,920 bytes). Build receipt:
`artifacts/p04-supervisor-build.json`.

Contract:

```text
mona-supervisor --control <socket> --workspace <dir> [--grace-ms N]
                [--log <file>] [--label <name>] -- <exe> [args...]
```

- fd 3 is the owner-liveness channel: token line first, EOF means owner death.
- The child is spawned with `POSIX_SPAWN_SETPGROUP` and a closed fd set
  (`POSIX_SPAWN_CLOEXEC_DEFAULT`).
- Descendants are sampled every 250 ms and once more immediately before stop.
- `status`, `stop`, and `force-stop` are answered over a mode-0600 Unix socket.
- Signals and owner liveness are armed before the child exists; an owner stop
  that arrives mid-spawn is remembered and the just-created child is stopped
  immediately, so a stop during startup cannot leak a runtime.
- Descendants are re-sampled during the stop grace period, so a grandchild
  forked after the last regular sample is still found and signalled by identity.
- Zombies are not treated as live processes on either side of the boundary
  (`ps` state `Z` is filtered in the supervisor and in Mona's process table).
- Only one caller owns the stop: losing stop paths report `already_stopping`
  and never call `exit`, so a SIGTERM racing a control stop cannot abandon the
  tree with a wrong exit code.
- The supervisor unlinks its socket and exits with the child; it never becomes a
  daemon.

## Ownership model

- `src/main/supervisor/identity.ts` — `ps`-based process table, identity
  matching, descendant walk, listener discovery, port preflight.
- `src/main/supervisor/records.ts` — atomic, 0600 ownership records; corruption
  is preserved as `.corrupt-<ts>` rather than discarded; no token field;
  `classifyOwnership` returns `live_owned`, `orphaned_owned`, `pid_reused`,
  `foreign_executable`, or `stopped`.
- `src/main/supervisor/native.ts` — supervisor spawn/control client; records the
  `ps`-visible child start time as the canonical identity and keeps the
  supervisor's `pid:sec.usec` token only as startup evidence; control-socket
  stop with a verified-identity fallback.
- `src/main/supervisor/runtime-supervisor.ts` — one runtime per user store,
  serialized starts, workspace serialization, external read-only attach,
  suspend/resume, bounded process-only restart, record reconciliation.
- `src/main/engine/runtime-process.ts` — resolves and hashes the native engine,
  validates the workspace, refuses a live/orphaned record for the same
  workspace, preflights the port, verifies the child's parent and executable,
  waits for authenticated `/v1/runtime/info`, and verifies that the listener is
  inside the supervised tree and runs the recorded binary.

Records live at `<state>/runtime-ownership.json`; runtime logs at
`<state>/logs/<id>.log`; control sockets under `<state>/run/` (or a short temp
path when the state path would exceed the Unix-socket limit).

## Truthful stop and restart semantics

A stop receipt carries `verified`. Only the supervisor's control socket can
prove the whole tree is gone, so only that path sets `verified: true`. The
signal fallback (used when the supervisor is unreachable) signals the verified
child and its recorded process group, reports any remaining group member, and
sets `verified: false`; it never claims more than it knows. An unverified stop
is recorded as `failed`, not `stopped`, and is reclassified at the next launch.

A supervisor exit is not proof the runtime tree stopped. Before restarting,
Mona looks for the stop receipt the supervisor itself emitted (`stopped` event).
Without one, the record is marked `failed` with `STOP_UNVERIFIED`, no restart is
scheduled, and no second owner starts. A restart after a wake probe is refused
unless the stop before it was `stopped`.

Concurrent `ensure` calls are refused (`ALREADY_OWNED`) rather than racing two
spawns, and a start during `reconnecting`/`stopping` is refused rather than
silently stopping the in-flight owner.

## Shutdown / recovery matrix

| Scenario | Mechanism | Test | Observed |
| --- | --- | --- | --- |
| Graceful stop of a tree | TERM to the verified group, bounded wait | `supervisor-native` | parent + grandchild dead, `state: stopped`, `escalated: false` |
| TERM-ignoring child | bounded grace, then KILL only verified survivors | `supervisor-native` | `escalated: true`, tree dead |
| Escaped process group | sampled identity, killed by `(pid, start)` even after `setpgid` | `supervisor-native` | detached grandchild dead; tracked ≥ 3 |
| Unrelated process | never kill by name | `supervisor-native` | unrelated `sleep` survives |
| Owner death | fd 3 EOF | `supervisor-native`, lifecycle smoke | tree stopped and supervisor exits |
| PID reuse | start-time mismatch | `supervisor-native`, `runtime-supervisor` | `identity_mismatch` / `STALE_OWNERSHIP`; process untouched |
| Renderer crash | record and keep runtime | lifecycle smoke | renderer crashed, main alive, same child pid alive |
| Close last window (⌘W) | macOS keeps the process | lifecycle smoke | 0 windows, runtime running, child alive |
| Dock reopen | `activate` opens a window | lifecycle smoke | 1 window, same runtime/child |
| Sleep | state becomes `reconnecting` | lifecycle smoke + unit | runtime `reconnecting`, child alive |
| Wake | health probe, no resubmission | lifecycle smoke + unit | `running`, same child; start count unchanged |
| Runtime crash (supervisor reported a tree stop) | bounded process restart | `runtime-supervisor` | `reconnecting` → `starting` → `running`; no turn resubmission |
| Supervisor killed, no stop receipt | refuse restart, mark failed | `runtime-supervisor` | `failed` / `STOP_UNVERIFIED`, no second owner |
| Unhealthy after wake, stop incomplete | refuse restart | `runtime-supervisor` | `failed` / `STOP_INCOMPLETE` |
| Fallback stop (supervisor unreachable) | verified identity only | `runtime-supervisor`, `runtime-process` | state `stopped`, `verified: false`, record `failed` for re-check |
| Concurrent starts | serialized guard | `runtime-supervisor` | second call `ALREADY_OWNED`, one spawn |
| Leftover record, same workspace | reconcile then start | `runtime-supervisor`, `runtime-process` | orphan stopped; pid-reuse refused |
| Restart budget exhausted | stop restarting, report failure | `runtime-supervisor` | `failed` / `RESTART_EXHAUSTED` |
| Quit (⌘Q) | interrupt then stop owned tree | lifecycle smoke | `stopped: true`, `escalated: false`, `rollback: not_promised`, all pids dead |
| Second launch | single-instance handoff | lifecycle smoke | second exits 0; owner receives the folder |
| Occupied port | bind preflight | `runtime-process` | `PORT_IN_USE` with listeners and action |
| Missing executable | path/access check | `runtime-process` | `MISSING_EXECUTABLE`, `NOT_EXECUTABLE` |
| Missing workspace | stat before spawn | `runtime-process` | `WORKSPACE_UNAVAILABLE` |
| Startup exit | wait for health, observe exit | `runtime-process` | `STARTUP_FAILED`, record `failed` |
| Stranger on the port | listener must be in the tree | `runtime-process` | `OWNERSHIP_MISMATCH` |

The lifecycle smoke drives a real Electron app around a real supervised
`/bin/sh` tree (`sleep 300 & sleep 300`) and checks pids from the outside after
the app exits. The engine smoke drives the real pinned Codewhale binary through
the supervisor.

## Real pinned-engine supervision

`artifacts/p04-engine-smoke.json`:

- Supervisor pid 56626, child/runtime pid 56627, process group 56627; listener
  pid 56627, verified inside the tree.
- Engine `0.10.2` / `ff466b2ed0bf`; executable SHA-256
  `da022961…515e590d` recorded.
- One live ownership record, `state: running`, **no token field**.
- A real turn completed (`completed`), 15 durable events, effective route
  `deepseek` / `deepseek-flash` / `full_access`, operation lookup completed,
  usage reported.
- Shutdown: `stopped: true`, supervisor gone, child gone, no listener left,
  record `stopped`.
- Usage totals in the 10-minute window aggregate five smoke turns
  (15,786 input / 15 output tokens, $0.00478836, `costComplete: true`). The
  window includes earlier verification runs; it is not a per-turn price.

## Transitions

`src/main/work/control.ts` implements four distinct transitions with receipts:

- **Pause after task** sets a queue boundary; the active task continues and
  queued work does not start.
- **Interrupt now** calls the engine and reports `confirmed` or `uncertain`;
  the queue is untouched.
- **Cancel queued** removes future starts only.
- **Quit and stop work** cancels queued work, interrupts the active turn (or
  records uncertainty/timeout), stops the owned tree with one bounded forced
  escalation, and returns `rollback: "not_promised"`.

## Honest limitations

1. **Physical sleep not performed.** Suspend/resume was exercised with Electron
   `powerMonitor` events against a live supervised tree. A lid-close sleep was
   not performed on the build machine; native sleep qualification remains a
   manual check.
2. **Bounded keep-awake cleanup is not implemented.** It is optional in the
   prompt; no keep-awake assertion is taken, so there is nothing to release.
3. **Parallel ownership remains unsupported.** This is the P01 measurement, now
   enforced by `ALREADY_OWNED` and a single record per user store.
4. **Renderer-side state is not wired yet.** The supervisor exposes truthful
   state (`RuntimeSupervisor.status()`), but the P04 shell still shows the P02
   disconnected placeholder. P07 connects it.
5. **A supervisor stop during a hardware failure** depends on the OS delivering
   fd-3 EOF; if the whole machine loses power, the next launch reconciles the
   record and stops only a verified orphan.
6. **The signal fallback cannot see escaped descendants.** If the supervisor is
   unreachable, only the verified child and its process group can be checked;
   the receipt says `verified: false` and the record is re-checked next launch.
7. **Forced termination is not rollback.** If a turn already sent a provider
   request, stopping the process cannot undo it; submission reconciliation
   remains a separate decision (P03 contract).

## Files

- `native/macos-supervisor/main.swift`, `build/mona-supervisor`,
  `build/build.json`, `README.md`
- `scripts/build-supervisor.mjs`, `scripts/lifecycle-smoke.mjs`,
  `scripts/engine-smoke.mjs`, `scripts/ci.mjs`
- `src/main/supervisor/{identity,records,native,restart,runtime-supervisor,errors}.ts`
- `src/main/work/control.ts`, `src/main/desktop-lifecycle.ts`, `src/main/index.ts`
- `src/main/engine/{runtime-process,types,adapter,errors}.ts`
- `test/{supervisor-identity,supervisor-records,supervisor-restart,supervisor-native,runtime-supervisor,runtime-process,work-control}.test.ts`
- `docs/decisions/ADR-003-runtime-supervisor.md`

## Evidence artifacts

- `artifacts/p04-supervisor-build.json` — supervisor build/signature/hash.
- `artifacts/p04-lifecycle-smoke.json` — 21/21 Electron lifecycle checks.
- `artifacts/p04-engine-smoke.json` — 17/17 real-engine checks.
- `artifacts/p04-tests.txt` — 129 passing tests.
- `artifacts/p04-ci.txt` — format, lint, typecheck, supervisor, tests, build,
  renderer secret scan (`226,270` bytes, no findings).
