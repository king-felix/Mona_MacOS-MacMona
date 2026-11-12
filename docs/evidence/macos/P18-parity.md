# P18 — Complete advanced access: integrated terminal, command palette, capability explorer

Status: **completed** · Date: 2026-11-12 · Requirements: MONA-022, MONA-023,
MONA-030 (contribution; P26 owns the final matrix)

## What was built

### 1. Integrated terminal — a native arm64 PTY, not a node addon

- `native/macos-pty/` — `main.swift` + `spawn.c` (fork/exec shim) + README.
  One standalone Swift executable, `arm64-apple-macos14.0`, ad-hoc signed
  (`sha256` in `build/build.json`). No Node native module, so there is no
  Electron ABI to match and nothing is compiled on a recipient Mac.
- Contract: fd 0/1 raw pty bytes, fd 3 JSON control (resize, kill, terminate),
  fd 4 JSON events (started, resized, exit). The child calls `setsid()`, takes
  the pty as its controlling terminal, closes every inherited descriptor, and
  runs in its own process group. Closing the owner channel terminates the group,
  so a desktop crash cannot leave an orphan shell.
- `src/main/terminal/pty.ts` — binary resolution, protocol, signal names, and
  `buildShellEnvironment`: an **allowlist** (`PATH`, `HOME`, `USER`, `LOGNAME`,
  `SHELL`, `TERM`, `COLORTERM`, `LANG`, `TMPDIR`). Mona's own environment is not
  passed through, so a provider key or runtime token cannot reach a shell.
- `src/main/terminal/buffer.ts` — byte-exact replay ring: `dropped` is exactly
  the offset of the first retained byte, a reader behind the ring is told it was
  truncated, and the line budget evicts whole lines.
- `src/main/terminal/session.ts` — `TerminalManager`: at most 3 sessions,
  workspace cwd, write/resize/close, replay reads, search, a hard 64 MiB session
  budget that ends the session with a stated reason, and a read-only tail of the
  owned runtime's log (redacted).
- `src/renderer/shell/ansi.ts` — a non-executing transcript parser: CR/CRLF,
  backspace, tab, SGR tones, and every other CSI/OSC sequence stripped and
  counted. OSC 8 hyperlinks become inert text; there is no path from terminal
  bytes to the bridge.
- `src/renderer/shell/TerminalPanel.tsx` — Shell/Engine-log modes, session tabs,
  real status/exit/cwd/bytes, replay on reconnect, search with prev/next, copy,
  view-only clear, cols×rows resize, line input, Ctrl-C/Ctrl-D, and the exact
  environment and limits printed under the pane (including "startup files not
  sourced" and "full-screen programs are not emulated").

### 2. Command palette over the whole surface

- `src/renderer/shell/palette.ts` — deterministic local ranking: exact, prefix,
  word-start, substring, keyword, subsequence, hint; ties break by kind so a
  real action outranks a capability row with the same words.
- Entries: 8 screens, actions (open folder, Focus Mode, shortcuts, quit, reveal),
  every project, prompt favorites, work-board task prompts, all 9 settings tabs,
  and every capability row **that has an entry point**.
- Capability rows show their classification badge and cost class in the palette
  before anything happens; selecting one opens its real entry point, and a
  terminal route only *prefills* the command. Nothing is executed by the palette.
- Command-J toggles the terminal; Command-8 opens Capabilities; Command-1…8 keep
  the existing order with Capabilities appended.

### 3. Capability explorer and coverage report

- `docs/codewhale-capabilities-macos.json` is reconciled by
  `tools/p18-coverage/reconcile.mjs` (idempotent; `--check` is part of the smoke).
  Every one of the 75 rows now carries: description, scope, exact invocation,
  help source, **entry point (kind/target/label/tested)**, status, test, and a
  named gap when no faithful route exists.
- `src/main/work/capability.ts` — `CapabilityExplorer`: validates the inventory
  with zod, computes coverage **from the rows**, probes the installed engine
  read-only (`--version`, `--help`, `features list`), reports additions and
  removals against the recorded surface, and caches the last projection.
- `src/renderer/shell/Capabilities.tsx` — summary counts, "Full parity is not
  claimed" verdict, version drift, live feature flags, the status vocabulary,
  filters, all rows, and a row detail with the exact route, cost class, test and
  gap. Terminal rows open the shell prefilled; native rows navigate.
- `src/shared/contracts/capability.ts` — `entryTargetIsKnown` binds a row to the
  screens and Settings tabs this build actually renders; a unit test fails if
  the inventory names a target that does not exist.

## Coverage (computed, not asserted)

From `docs/evidence/macos/artifacts/p18-capability-coverage.md`:

- **75 rows**: 43 verified, 28 open (route named, operation not exercised),
  2 blocked gaps, 2 unavailable.
- 72 rows have an in-app entry point; 51 entry points were exercised.
- Integrations: 45 native views, 15 advanced actions, 12 integrated-terminal,
  2 blocked gaps, 1 unavailable.
- **Blocked gaps**: checked-in workflows (`MONA-CAP-018`) and lane management
  (`MONA-CAP-019`) have no `/v1` route on 0.10.2. A terminal button would not
  fulfil MONA-019, so full parity stays blocked until the engine exposes a route
  or Victor narrows scope.
- **Unavailable**: cloud `dispatch` (paused for new users on this build) and
  `remote-setup` (cloud bundles are outside 1.0 scope).
- Open rows are write/destructive/costly operations that were deliberately not
  executed (`run` TUI, `speech`, `apply`, `update`, `login`/`logout`/`auth`,
  `fork`, workflows' siblings, approvals resolution, whole-workspace restore,
  workspace file search, engine terminal attach). Each names its route and why.

Drift on the installed engine: 0.10.2 (`ff466b2ed0bf`), 0 additions,
0 removals, version and commit match. `features list` returned 19 flags and the
Capabilities screen renders them.

## Acceptance evidence

| Acceptance | Evidence |
|---|---|
| Every supported row has a working tested entry point | 72/75 rows carry an entry point; `entry_targets_exist_in_this_build` and the screen test prove the targets render; 51 are marked exercised, and every `verified` terminal row's exact route is executed by `smoke:capability` |
| Unavailable/gap states are clear | explorer shows `blocked_gap`/`unavailable` rows with the exact route and no Open control (`capabilities_gap_named` in the shell smoke) |
| Terminal reconnect works | sessions live in main; the renderer reloads by `terminalOutput(cursor 0)`. `output()` flushes any batched bytes before reading, so every byte in a replay already has an event at or below the returned `seq`; the pane keeps only events with a higher sequence, which is what makes reconnect duplication-free (`flushes pending output before a read…`, `does not render replay and live bytes twice on reconnect`) |
| Terminal exit works | real `exit 5` observed as `status: exited, code: 5` (`exit_code_observed`, `exit_event_emitted`) |
| Terminal resize works | `stty size` answered `40 120` after a resize to 120×40, in the unit test, the terminal smoke, and the real Electron app (`terminal_resize_reaches_child`) |
| Unsupported terminal lifecycle is not faked | full-screen programs are stated as unsupported; a non-zero exit is `exited`, not `failed`; an unconfirmed close says so |
| Malicious terminal links remain inert | an OSC 8 `file:///etc/passwd` link renders as text, with no `<a>`, no URL, and no escape byte (`terminal_link_inert`; `ansi.test.ts`) |
| Secrets are not inherited by the shell | `secrets_withheld`: `DEEPSEEK_API_KEY`, `CODEWHALE_RUNTIME_TOKEN`, `OPENAI_API_KEY` all absent in a real shell |
| Startup files are not sourced | throwaway `HOME` with a marker `.zshrc`; the marker was never created |
| No orphan process on owner death | closing the control channel ends the shell, verified by `ps -p` |
| Coverage report computes completeness without excluding awkward features | `smoke:capability`: `coverage_math`, `every_row_has_route`, `parity_not_claimed`, `report_names_gaps` |
| Version drift detected | `drift_checked`, `drift_version_matches`, `drift_commit_matches`, `no_additions`, `no_removals` |

## Verification

- Full suite: **566 tests in 59 files**; local CI green including
  `smoke:terminal` and `smoke:capability` (`p18-ci.txt`, `p18-tests.txt`).
- `smoke:terminal` — **31/31** on the real native helper: controlling terminal,
  allowlisted env, startup files not sourced, resize observed, search, ring
  eviction with exact dropped bytes, exit code 5, retained transcript after
  exit, write refused after exit, terminate with a verified-gone pid, session
  cap with an ended-session eviction and a refusal for three live shells,
  redacted/absent log, native arm64 + ad-hoc signature, no pty dependency
  (`p18-terminal-smoke.json`). Includes `engine_reachable_from_shell`: `codewhale --version` answers from inside the Mona shell with the per-process PATH and no startup file.
- `smoke:capability` — **17/17**: reconcile in sync, inventory valid, coverage
  math, every row has a route, entry targets exist, drift clean, 43/43 CLI
  `--help` probes answer, every `verified` terminal row's exact route runs
  (`help`, `metrics`, `completion zsh`), feature flags read, report names the
  gaps (`p18-capability-smoke.json`).
- Real Electron shell smoke — **112/112**, including `palette_capabilities`,
  `capabilities_explorer`, `capability_entry_navigates`, `terminal_session`,
  `terminal_output`, `terminal_link_inert`, `terminal_resize_reaches_child`,
  `terminal_exit_observed` (`p18-shell-smoke.json`, `p18-capabilities.png`,
  `p18-terminal.png`).

## Independent review pass

Two adversarial read-only reviews ran against the finished change. Everything
they found was fixed and covered by a regression test:

1. **Overstated coverage (major).** `session-diagnostics` and `scorecard` were
   `verified` on a `--help` probe alone, and their own test notes said "not
   exercised" — the exact contradiction spec §2 forbids. Both are now
   `unqualified` with their observed behaviour recorded (`session-diagnostics`
   needs a `<jsonl>` path; `scorecard` refused the bare command with exit 2 and
   `--input <FILE>`). `smoke:capability` now **executes** the exact route of
   every `verified` terminal row (`help`, `metrics`, `completion zsh`), and the
   reconciler refuses any `verified` row that is untested, contradicts its own
   note, or is an unexecuted terminal row.
2. **Unhandled bridge rejection (major).** A size outside the schema bounds made
   `ipcRenderer.invoke` reject outside `envelope`, leaving the pane permanently
   busy with no message. Sizes are clamped before the call and every bridge call
   in the panel is guarded, with `busy` cleared in `finally`.
3. **Replay/live duplication (minor).** Bytes reached the buffer but the event
   batch trailed by up to 33 ms, so a reconnect could render the same bytes
   twice. `output()` now flushes pending bytes before reading, which makes
   "`seq <= read.seq` ⇒ already in `data`" true; the panel keeps only newer
   events and a test drives the race explicitly.
4. **Stale non-active session status, stale error banner, per-batch snapshot
   churn, and a tab switch during an in-flight replay (minor).** The event
   handler refreshes the snapshot for a non-visible session or a state/exit
   event only, `closeSession` clears prior messages, and a replay continuation
   from a session that is no longer on screen is discarded.

## Boundaries and carried-forward issues

1. **The engine's terminal routes are not used.** `GET /v1/terminal/{name}`
   attaches to an engine-owned shell and returns 404 for a name it does not
   know; Mona cannot create its own shell through it. The pane is a native PTY.
   An attach view for engine-owned terminals is not built (MONA-CAP-061 stays
   open with that reason).
2. **The transcript is not a VT100 emulator.** Full-screen programs are not
   supported; escape sequences are stripped rather than interpreted. This is
   stated in the pane and in the README, and it is a deliberate security choice.
3. **Personal shell aliases do not load** (`zsh -f`). Credentials are never read
   from startup files.
4. **28 rows stay open.** Each is a write/destructive/costly operation that was
   not executed in P18 — or, for `session-diagnostics` and `scorecard`, one that
   needs input Mona will not invent; the row names its exact route and records
   the observed refusal. No 100% parity claim.
5. **Workflows and lanes remain blocked gaps** (no `/v1` route on 0.10.2).
6. **Approvals resolution, workspace file search, whole-workspace restore, and
   plugin trust remain open** — unchanged from P08/P13/P17, now visible with
   their routes in the explorer.
7. **Capability coverage is a claim about this build**, not a promise about a
   later engine. A version/commit change is reported as drift and requires an
   explicit re-qualification.
8. **The 36 shell screenshots were rewritten again** because the rail gained an
   eighth item; they are current, not stale. Their hashes were re-recorded at
   this checkpoint with no assertion removed.
