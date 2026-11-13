# Runtime-store coexistence — verifying what Mona tracks

**Kind:** operator-requested verification and repair (not a numbered prompt) ·
**Date:** 2026-11-13 · **Engine:** Codewhale 0.10.2
(`ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`) · **Host:** macOS arm64,
`~` = the build machine's home directory.

## The question

> Does Mona track state and sessions only for Codewhale instances it starts?
> An independent Codewhale window is running while Mona is being tested; does
> that interfere?

Answer, measured: **Mona's own state is scoped to its own engine instance and
its own store, but the engine's Runtime store is shared per user home, and that
sharing is what interferes.** Two distinct facts, and only the second needed
repair.

## What was measured

All probes ran against the pinned engine with real processes, real ports, and
real ownership records. No probe submitted a turn, so nothing called a model.

- **Threads are Mona's own rows.** `src/main/work/studio.ts` derives a local
  thread id from `sha256(projectId:mode)` and stores the engine thread id in
  Mona's SQLite. Events are fenced three times: Studio ignores an event whose
  `thread_id` is not its binding, and `EventProjector.apply` throws
  `WRONG_THREAD` for a foreign envelope. The SSE subscription names one thread.
- **Cost is Mona's own ledger.** `recordUsage` reads `/v1/usage`, selects the
  bucket for its own engine thread, and writes Mona's `usage_records`.
- **No session enumeration exists.** Mona never calls `GET /v1/sessions`.
  `session.resume` existed only as an adapter capability taking a caller-supplied
  id, with no IPC or screen wiring.
- **A plain Codewhale TUI coexists.** With the operator's live window running
  (pid 46637), Mona's owned runtime started, verified its listener, and created
  its thread → `runtime-store-coexistence.json` (`tuiOnly`). A workspace
  coordination lock held by another process also did not block a start
  (`workspaceLockHeld`), and a pre-seeded `subagents.v1.json` with 7 foreign
  write claims survived a start byte-identical.
- **The engine's Runtime store is one per user home.** Two `app-server --http`
  processes in the same home: the second process's port was served by the
  **first** process's pid, and each token authenticated only its own port
  (cross-token reads returned 401). `GET /v1/sessions` and `/v1/usage` are
  home-wide: a brand-new workspace reported 47 usage buckets.
- **That sharing broke Mona's start, with a misleading message.** Mona's child
  logged `Runtime API listening on 127.0.0.1:<port>`, but `lsof` showed the
  listener was the pre-existing owner, so `verifyListenerOwnership` refused with
  *"port … is served by pid(s) outside the supervised tree"* and the action
  *"stop the runtime; the port is occupied by a process Mona did not start"*.
  Two concurrent Mona instances produced the identical failure.

The refusal itself was correct — Mona must not drive or signal a runtime it did
not start. The diagnosis was wrong: nothing was "occupying" the port; the store
already had an owner.

## What changed

- **`src/main/engine/runtime-store.ts`** (new) — observes the live Runtime-store
  owner. The owner keeps `<home>/tasks/runtime/runtime-process.owner.lock` open
  for the life of its process, so `lsof` names it without touching the file. The
  probe is best-effort by design: a missing tool, an unreadable path, or no
  holder is *unknown*, never a refusal. `owner.json` is deliberately not used as
  a liveness signal — it persists after the owner exits.
- **`runtime-process.ts`** — a preflight (`assertRuntimeStoreAvailable`) runs
  after the same-workspace ownership reconciliation and before any spawn. It
  distinguishes two causes: a leftover of Mona's own making (a record already
  matches the holder pid → names the workspace and asks the user to stop it from
  that window) and another Codewhale host (`→ names pid, executable, and command
  line, and tells the user to quit that host`). The listener check now upgrades
  its message when the stranger *is* the store owner.
- **`adapter.ts`** — a workspace scope on engine reads. `readHistory` refuses a
  thread the engine reports in another workspace (`WRONG_THREAD`, with both
  paths in details); comparison realpaths both sides so a symlinked spelling of
  the same folder is not a false positive. `session.resume` is refused while a
  project is attached, because a saved-session id lives in the shared store and
  cannot be proven to belong to this project; unscoped tooling that owns the id
  can still use it.
- **`studio.ts`** — the adapter is constructed with the project's canonical path
  and scoped again after construction, so an injected adapter factory keeps the
  fence.
- **Tests** — 16 added: 8 in `test/runtime-store.test.ts` (home resolution,
  probe, both preflight causes, no signal to the holder), 6 in
  `test/engine-adapter.test.ts` (foreign workspace refused, own workspace and
  unscoped allowed, symlink tolerated, resume refused/allowed), 2 in
  `test/runtime-process.test.ts` (generic stranger diagnosis, owner-aware
  diagnosis), 1 in `test/work-studio.test.ts` (the studio binds its adapter to
  the project). The studio fixture now reports the workspace the engine would
  report, instead of a stale demo path.

## What was deliberately **not** done

- **No isolated `CODEWHALE_HOME`.** It would remove the contention, and it
  would also remove Mona's provider route: the engine's credentials and
  configuration (`secrets/secrets.json`, `config.toml`, catalogs) live in that
  home. An isolated store means no provider, no model, no useful Mona. Spec §650
  also says not to rewrite the runtime's home for packaging convenience. This is
  a compatibility decision for a prompt with engine-compatibility evidence, not
  a bug fix.
- **`attachExternal` is not wired to the UI.** It is read-only *and* tokenless:
  `RuntimeSupervisor.endpoint()` returns `null` for an external runtime, so the
  studio could show a status but never drive work. A screen for a capability
  that cannot do anything is worse than the accurate refusal, so the refusal
  names the owner and the exact next action instead.

## Verification

- `npx vitest run` — **786 tests in 79 files, all pass** (770 before this work).
- `npm run typecheck` — clean. `npm run lint` — 0 errors (3 pre-existing
  `no-explicit-any` warnings in test files).
- Live, after the change (`runtime-store-conflict.json`): with a foreign host
  running, the start now fails **before a spawn** (no child log at all) with
  `ALREADY_OWNED` and *"another Codewhale runtime host already owns this user's
  Codewhale store (pid N, <binary> — <command>)"*.
- Live (`runtime-store-scope.json`): a thread created in workspace B by another
  host in the same home is refused by a workspace-A-scoped adapter
  (`WRONG_THREAD`, both paths named) and is readable by the same adapter
  unscoped — so the fence, not the transport, is the deciding factor.
  `session.resume` is refused with `UNSUPPORTED_CAPABILITY` and the reason.
- Live (`runtime-store-coexistence.json`): the TUI, a foreign workspace lock,
  and Mona-as-store-owner all still start.

## Residual limits, stated

1. **The store is still shared.** A second host can read `/v1/usage` totals and
   session rows for other workspaces; Mona displays none of it (it reads only
   its own thread bucket), but the payload carries it. That is an engine
   property, not something Mona can fix locally.
2. **The preflight is one observation.** A host that starts between the check
   and the bind still lands on the listener check, which refuses — it just
   cannot name the owner as precisely.
3. **Owner detection needs `lsof`.** Without it the probe reports unknown and
   the listener check remains the guard.
4. **`session.resume` is refused, not scoped.** Scoping it needs a resume
   response that reports the thread's workspace; the observed 0.10.2 route
   requires a session with messages to exercise, so that was not claimed.
5. **A model turn was not run.** Every claim above is about ownership, routing,
   and reads; the turn path was covered by the 786-test suite, not by a live
   provider call in this session.
