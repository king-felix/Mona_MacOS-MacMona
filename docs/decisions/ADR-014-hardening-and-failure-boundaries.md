# ADR-014 — Hardening: what a fault may change and what must stay provable

**Status:** accepted · **Date:** 2026-11-12 · **Prompt:** P20

## Context

P20 is not a feature prompt. It asks whether the assembled product keeps its
promises when a peer process dies, a disk fills, a stream drops a frame, a
repository is hostile, or a bundle is malformed. Six facts shaped the answer.

1. **Durable evidence is the only arbiter.** A crash, a lost response, or a
   refused write is a _fact to read back_, not a state to guess. Every recovery
   path in Mona already reads from SQLite or a journal; P20 adds no path that
   trusts in-memory intent over the stored row.
2. **Uncertainty is a value, not a gap to fill.** A gap in an event sequence, a
   missing artifact, or a refused restore is representable. The failure matrix
   asserts the _named_ answer, never a plausible substitute.
3. **A child process inherits trust.** `git commit` executes hooks supplied by
   the repository being reviewed. Handing Git Mona's whole environment would
   hand a stranger the provider key. The environment is therefore an allowlist,
   the same discipline the terminal already used (ADR-012).
4. **Lexical path validation is not filesystem validation.** `safeJoin` proves a
   name stays under a root. It cannot know that `<root>/nested` is a symlink to
   `/tmp/evil`. Extraction must check real paths and open with `O_NOFOLLOW`.
5. **A cap that keeps a prefix is not a cap.** An archive over its total budget
   must yield _no_ entries, or a caller imports a truncated bundle and calls it
   complete.
6. **A secret redactor that mangles paths is a correctness bug.** Matching
   `/Users/victor` inside `/Users/victor2` silently renames another account's
   files in every diagnostic and error message.
7. **A receipt is not worth a process tree.** The supervisor's event writer ran
   before every signal in the stop path. On a broken pipe it aborted the
   supervisor, so main-process death orphaned the runtime instead of stopping
   it.

## Decision

### 1. Failure injection is a first-class, repeatable artifact

`scripts/p20-failure-smoke.mjs` (`npm run smoke:failure`, wired into `ci.mjs`)
runs ten real faults against real stores in an isolated temporary tree and
records `docs/evidence/macos/artifacts/p20-failure-smoke.json`. It uses no
fixture doubles except the clock and the free-space probe, which are stated in
the file. `test/p20-failure-matrix.test.ts` covers the same boundaries at unit
grain plus the ones that need no subprocess.

### 2. Gap detection is explicit and bounded

The event pump previously reconnected from the _highest_ stored sequence. A
frame lost in transport therefore advanced the cursor past it and the timeline
silently lost an item. Now `WorkStudio.ingest` compares the incoming sequence to
the stored cursor, records `sequence gap: <range>` in diagnostics, and asks the
pump to reconnect **from the last contiguous sequence**, bypassing the
instability counter because this is a deliberate replay, not a flapping stream.
After two attempts it stops rewinding and keeps the gap recorded: the engine
contract does not promise contiguous numbering, so looping would be a lie about
what recovery can do.

### 3. Child processes get an allowlisted environment

`buildGitEnvironment` passes PATH, HOME, USER, LOGNAME, TMPDIR, TZ-adjacent
locale, SSH agent socket, Git identity variables, and `XDG_CONFIG_HOME`, then
forces `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`,
`LC_ALL=C`. A secret-shaped name is dropped even if it appears in the allowlist.
The proof is a repository hook that dumps its environment; a control run with
plain Git shows the same hook _does_ see the variable, so the assertion is not
vacuous.

### 4. Extraction validates the real tree and writes with `O_NOFOLLOW`

`prepareTarget` walks each path component with `lstat`, refuses a symlink at any
position, refuses a non-directory parent and a non-regular final target, then
re-resolves the parent and re-checks containment before the open. The file is
opened `O_EXCL` (or `O_TRUNC` only when overwrite is explicitly requested) with
`O_NOFOLLOW`, so a link planted between check and write still fails. A symlinked
_root_ is allowed and resolved to its real directory: the caller asked for that
destination.

### 5. Named conditions instead of raw errno

`StateErrorCode` gains `ARTIFACT_MISSING`. `ArtifactFileStore.read` maps
`ENOENT`/`ENOTDIR` to it with the relative path, so the UI can say "this
artifact is missing" instead of surfacing a filesystem code it cannot act on.
Digest mismatch keeps its own distinct code.

### 6. One home redactor

`redactHomePath` is the single implementation used by settings, capability,
extensions, and the terminal. It requires `home + "/"`, handles `home` exactly,
and refuses to operate on a degenerate home (`/`).

### 7. Receipts are best-effort; stopping is not

`emit` writes with `write(2)` on fd 1 and discards `EPIPE`. The stop path always
runs to completion, whether or not an observer is listening. This is proven by
a test that destroys the receipt pipe _before_ closing the owner channel — the
case the P04 test missed — and by a real `SIGKILL` of the Electron process in
the lifecycle smoke.

### 8. IPC sender policy is testable and frame-aware

`senderIsTrusted` moved to `src/main/ipc-sender.ts`. It refuses a destroyed
sender, a child frame (`senderFrame.parent != null`), a non-`file:` URL, a path
outside the renderer root, and a sender whose URL cannot be read. The whole
evaluation is wrapped so a throwing frame getter fails closed.

## Consequences

- A hostile repository cannot read Mona's provider key through its hook.
- A dropped event frame is recovered once and then honestly reported.
- An archive cannot write outside its root through a planted symlink.
- Missing artifacts and corrupt databases surface as named, actionable states.
- Two new carried-forward items exist: a second _confirmed_ fault on the same
  green paths would still be caught only by the matrix, and physical
  sleep/second-account behaviour remains manual (P24/P26).
