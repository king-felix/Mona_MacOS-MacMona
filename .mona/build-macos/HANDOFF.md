# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P03, revision 37) · verified content commit
`9a0628e`
**Current prompt:** P04 — **pending, not started**
**Queue executed:** P01 → P02 → P03, all completed and checkpointed

## Where the build stands

P00–P03 are complete. There is a qualified headless integration, a secure
desktop shell, and a contract-tested engine adapter. No product UI is connected
to the engine yet; the shell deliberately shows “Not connected” and “Cost
unknown”.

### P01 — headless integration and economics (complete)

- `app-server --http` `/v1/*` works against Codewhale 0.10.2 (`ff466b2ed0bf`):
  thread/turn lifecycle, SSE replay/live, history, interrupt, session resume,
  usage, providers/models.
- Real tool turn wrote `hello.txt`, ran `node verify.mjs` (`PASS`), completed
  with `permission_posture = full_access`, effective `deepseek` /
  `deepseek-flash`. Interrupt confirmed; no stray process. Session resume 200.
- Zero inference for startup, discovery, idle, history, and reconnect.
- Paired cost pilot under the $2 ceiling: 3 tasks accepted, total-token deltas
  +0.77% / −0.33% / −0.26%; adapter cost $0.012559. Direct `exec` cost is
  **unknown**, not zero.
- **Single-owner finding:** a second `app-server` attaches to the first Runtime
  owner; the first PID owned both ports and the first token authenticated the
  second. Serialize owned runtimes; do not invent a separate `CODEWHALE_HOME`.
- **Process-tree finding:** the npm wrapper spawns the native binary as a
  grandchild; the listener is the grandchild, not the PID returned by `spawn`.
- Capability inventory: 72 rows, 30 verified, 41 discovered/routed-pending,
  1 unavailable (`dispatch`), 0 blocked gaps.
- Native binary launches with no Node on PATH and links only system frameworks.
  Finder Service mechanism verified with CLT, `NSServices`, ad-hoc signing, and
  LaunchServices registration.

### P02 — desktop foundation (complete)

- Electron 45.3.0 arm64 + React 19 + TypeScript 5.9 + Vite 8 + Zod 4 +
  Vitest 5, npm lockfile, pinned versions.
- Renderer is sandboxed and context-isolated: no Node globals, three-method
  preload bridge, strict Zod IPC, trusted-sender checks, `connect-src 'none'`
  CSP, denied navigation/window.open/permissions.
- Mona contracts use branded IDs and strict unknown-field policy; upstream wire
  types are separate; 8 labeled fixtures.
- Native menu/Services, hiddenInset traffic lights, close-versus-quit policy.
- Per-user Application Support/Cache/Logs paths; GUI-launch tool discovery finds
  Homebrew with `PATH=/usr/bin:/bin`.
- Clean `npm ci` + CI (format, lint, typecheck, 70 tests, build, renderer secret
  scan) passes. Renderer baseline 226,270 bytes; ~408 MB working set.

### P03 — versioned engine adapter (complete)

- `src/main/engine/` implements discover, owned runtime, create/open thread,
  submit, reconcile, subscribe, interrupt, history, usage, effective profile,
  capability invocation, shutdown.
- Exact pinned compatibility; typed unsupported reasons; no silent upgrade.
- Submission intent persisted before POST; lost response → `outcome_unknown` and
  read-only operation lookup, never a blind retry. Response-loss test proves one
  POST.
- Streaming distinguishes durable events, `stream.progress`, diagnostics, and
  `stream.end`; per-thread `seq` dedupe; deterministic reconnect projection;
  wrong-thread events and responses are rejected; malformed/schema-drift frames
  remain diagnostics.
- Effective profile is read from the turn with strict fail-closed checks.
- 70 tests pass; real pinned-runtime smoke 10/10 (completed turn, 15 durable
  events, same-turn lookup, Full Access verified, clean shutdown).
- Interrupt on a completed turn returns 409 and is reported as “no active turn”,
  not a confirmed stop.

## Next exact action (P04)

Read spec §6.4, §10.3, §13; P03 adapter contracts (`src/main/engine/adapter.ts`,
`runtime-process.ts`); this handoff. Then implement the process supervisor:

1. One owned runtime per user store; serialize workspace execution until
   independent coexistence is proven.
2. Track the process tree (native binary may be a grandchild of a wrapper) by
   PID + creation identity; never kill by name. Own the process group.
3. Single-instance desktop owner; second launch dispatches to the existing
   owner.
4. Renderer crash cannot kill a task; closing the last window preserves work;
   **Quit and stop work** interrupts then shuts down owned children.
5. Sleep/network loss becomes reconnecting, not duplicate requests; runtime
   crash triggers bounded process restart only — resubmission is a separate
   reconciled decision.
6. User-launched external runtimes are read-only attach, not owned.

Do not start P04 unless it is the assigned prompt. The requested queue of three
(P01–P03) is complete; pause here.

## Nonblocking issues carried forward

1. **Single-owner runtime** — parallel owned runtimes are unsupported. P04 must
   enforce serialization or a future tested engine decision must change it.
2. **Direct cost unknown** — `codewhale exec` agent mode omits usage split and
   price coverage. No exact-parity claim may be made.
3. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
   search/restore, terminal, and fleet are not adapter operations yet.
4. **Usage cost completeness** — `costComplete: false` appears whenever unpriced
   turns are in range; preserved honestly.
5. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
6. **No Developer ID signing** — P22 prerequisite; local app is unsigned.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 37).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-012.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability (never hand-edit).
- `docs/codewhale-capabilities-macos.json` — 72 qualified rows.
- `docs/discovery-macos.md` — host/engine facts plus P01 qualification.
- `docs/decisions/ADR-001-desktop-stack.md`, `ADR-002-ipc-boundary.md`.
- `docs/evidence/macos/P01-feasibility.md`, `P02-foundation.md`,
  `P03-adapter.md`.
- `docs/evidence/macos/artifacts/p01-*`, `p02-*`, `p03-*`.
- `src/main/engine/` — adapter; `scripts/engine-smoke.mjs` — real runtime smoke.
- `AGENTS.md` — operating contract and commands.
