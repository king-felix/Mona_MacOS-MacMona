# native/macos-supervisor

Owned process-tree supervision for Mona's Codewhale runtime. Implemented at
P04. The binary is built by `npm run build:supervisor` into
`build/mona-supervisor` (arm64, macOS 14 deployment target, ad-hoc signed).

## Why it exists

Measured P01 facts that constrain the supervisor:

- `/opt/homebrew/bin/codewhale` is a Node wrapper; the native binary it spawns
  owns the TCP listener. The listener can be a **grandchild**, not the PID
  returned by `spawn`.
- A second `app-server` attaches to the first Runtime owner on the same user
  store; independent parallel ownership is unsupported.
- Killing a parent PID is insufficient: tool children, shells, and detached
  grandchildren must be stopped too, without ever killing by process name.

## Contract

```text
mona-supervisor --control <socket> --workspace <dir> [--grace-ms N]
                [--log <file>] [--label <name>] -- <executable> [args...]
```

- **fd 3 = owner liveness.** Mona writes the runtime bearer token as the first
  newline-terminated line and keeps the pipe open. The token never reaches argv
  or the supervisor environment. EOF means the owner is gone: the supervisor
  stops the tree and exits.
- The child is spawned in its own process group with `POSIX_SPAWN_SETPGROUP`;
  the supervisor's other descriptors are closed with
  `POSIX_SPAWN_CLOEXEC_DEFAULT`.
- Descendants are sampled every 250 ms and immediately before stopping, and are
  retained as `(pid, start time)`. A descendant that escapes the group or is
  reparented is still stopped by identity.
- A pid whose start time no longer matches is treated as reused and is never
  signalled.
- Stop is TERM to the verified tree, a bounded grace period, then KILL for
  verified survivors. The receipt reports `graceful`, `escalated`, `survivors`,
  and the child exit — never an inferred "stopped".
- `status`, `stop`, and `force-stop` are answered over a mode-0600 Unix socket
  in a mode-0700 directory.
- Signals and owner liveness are armed before the child exists, so a stop during
  startup still cleans up what was spawned.
- No launch agent, login item, or root service. The supervisor exits with the
  child; detached children cannot make Mona persist by accident.

## Verification

- `test/supervisor-native.test.ts` — real trees: graceful stop, escaped group,
  TERM-ignoring escalation, owner EOF, pid-reuse refusal, status receipt.
- `test/runtime-process.test.ts` — workspace, executable, port, listener
  ownership, and startup-failure states.
- `scripts/lifecycle-smoke.mjs` — Electron window close/reopen, renderer crash,
  sleep/wake wiring, single-instance handoff, and quit-and-stop with external
  pid checks.
- `scripts/engine-smoke.mjs` — the real pinned Codewhale binary under the
  supervisor, including listener-in-tree verification and clean shutdown.

Shipping: packaging (P21) must place the compiled binary beside the app
resources; `resolveSupervisorBinary` checks `process.resourcesPath`. Release
signing is P22.
