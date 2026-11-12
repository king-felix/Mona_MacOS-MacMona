# ADR-012 — Terminal ownership, a controlled environment, and inert output

**Status:** accepted · **Date:** 2026-11-12 · **Prompt:** P18

## Context

P18 has to expose "the integrated terminal" without handing untrusted bytes,
model output, or a hyperlink any authority over the application. Three facts
from the pinned 0.10.2 runtime and this desktop stack shaped the decision.

1. **The engine's terminal routes attach; they do not create.** The documented
   `GET /v1/terminal/{name}/output` (plus `input`, `resize`, `kill`) addresses
   the stateful shell the engine's own tools drive. A name with no live session
   answers `404`, because "conjuring a shell from an HTTP request would give the
   client a terminal the Engine does not know about". A native client therefore
   cannot open _its own_ shell through that family.
2. **The engine's PTY job route cannot resize.** `POST /v1/threads/{id}/jobs`
   with `tty: true` creates an interactive job with stdin and a resumable output
   cursor, but the documented route set has no resize call. P18's acceptance
   requires that resize works and that the child observes it.
3. **A Node native addon is a liability here.** `node-pty` would have to match
   Electron's ABI and be compiled (or prebuilt) on every recipient Mac, which
   the spec forbids: "use native arm64 PTY modules matching Electron's ABI, not
   a global npm/native build dependency on the recipient Mac".

## Decision

### 1. Mona owns its PTY through a standalone native helper

`native/macos-pty` is a single Swift executable (plus a C fork/exec shim, since
Swift marks `fork()` unavailable). It is built by `npm run build:pty`, is arm64
only, ad-hoc signed in development, and has no Node coupling at all — there is
no ABI to match and nothing to compile on a recipient machine. The helper is a
child of the desktop process; the shell is a session leader in its own process
group with the pty as its controlling terminal.

**Consequence:** the engine's attach-only terminal remains unimplemented
(`MONA-CAP-061` stays open with that reason), and an attach view for
engine-owned shells is future work. Mona's pane and the engine's shell are
different shells, which the UI states.

### 2. The environment is an allowlist and startup files are skipped

The helper passes exactly the `KEY=VALUE` entries it is given. `pty.ts` builds
them from `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`,
`LANG`, `TMPDIR` — never from `process.env` as a whole. Secret-shaped variables
present in Mona's environment are reported in `withheld` and never passed. The
shell is launched as `/bin/zsh -f`, so `/etc/zshrc` and `~/.zshrc` do not run.

**Consequence:** personal aliases and prompt customization do not load in
Mona's pane. That is the price of never sourcing a startup file to discover a
credential, and it is printed under the pane rather than hidden.

### 3. Output is inert and bounded

The renderer receives text spans produced by `ansi.ts`, which strips and counts
every CSI/OSC sequence, keeps only SGR emphasis, and never emits a link, a
clipboard write, or an IPC call. OSC 8 hyperlinks become plain text. Output is
bounded twice: a byte-exact replay ring in main (`dropped` = the offset of the
first retained byte) with a line cap, and a 64 MiB per-session budget that ends
the session with a stated reason. A renderer reload reconnects to the same
session by reading the ring from cursor 0; sessions are never re-created
silently.

**Consequence:** full-screen programs (`vim`, `top`) are not rendered and the
pane says so. A non-zero exit is reported as `exited` with its code, not as a
`failed` Mona operation; `failed` is reserved for a helper or spawn failure.

### 4. Capability coverage is computed, and entry points are validated

The P01 inventory is reconciled by `tools/p18-coverage/reconcile.mjs`, which
records for every row an entry point, status, invocation, help source, test, and
gap. Coverage is computed from the rows, never trusted from the file's summary.
`entryTargetIsKnown` rejects a row whose target is not a screen or Settings tab
this build renders.

**Consequence:** a row Mona cannot reach stays visible and blocks the parity
claim. `MONA-CAP-018` (workflows) and `MONA-CAP-019` (lanes) are `blocked_gap`:
the engine exposes no `/v1` route, and a terminal button would not satisfy
MONA-019. Twenty-eight rows are `unqualified` — write, destructive, or costly
operations that were deliberately not executed, or ones that need input Mona
will not invent (`session-diagnostics`, `scorecard`); each names its route, and
a row that says it was not exercised can never be `verified`.

## Alternatives considered

- **Attach to `/v1/terminal/{name}` only.** Rejected: it cannot create a shell,
  so there would be nothing to attach to for a user-opened pane.
- **`node-pty`.** Rejected: ABI coupling to Electron, a compile step per
  recipient, and an unnecessary native surface when a 100 KB helper exists.
- **`/usr/bin/script -q /dev/null`.** Rejected: no resize control, no verified
  process group, and no exit receipt.
- **Render the engine's raw ANSI in a `<pre>`.** Rejected: OSC 52/8 and cursor
  sequences would be live, and only OSC 8's own tooling would decide what a
  click means.

## Consequences

- Packaging (P21) must ship `mona-pty` beside the app resources and sign it with
  the Developer ID at P22; the build script already records its hash.
- A helper that loses its owner channel terminates its shell, so a desktop crash
  cannot leave an orphan. Verified by `ps -p` in `test/terminal-manager.test.ts`.
- Every capability row now carries an honest status; the coverage report is part
  of the evidence and is reproducible without the app running.
