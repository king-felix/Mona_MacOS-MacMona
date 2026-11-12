# P20 — Recovery, security, and failure testing

**Status:** complete · **Date:** 2026-11-12 · **Prompt:** P20 ·
**Requirements:** MONA-016, MONA-025, MONA-026 · **Decision record:**
`docs/decisions/ADR-014-hardening-and-failure-boundaries.md`

## What this prompt had to prove

P20 is a hardening prompt, not a feature prompt. The assembled product had to be
shown to keep its promises when a peer dies, a disk fills, an event frame is
lost, a repository is hostile, a bundle is malformed, or a restore is
interrupted — and to say **unknown** when the outcome genuinely is unknown.

Six real defects were found, each with a reproducible case and a root-cause
repair. No feature was disabled, no test removed, and no trust widened.

## Defects found and fixed

### P20-01 — A repository hook could read Mona's provider key (high)

`runGit` passed `{...process.env}` to Git. `git commit` executes hooks supplied
by the opened repository, so any project could have written
`/usr/bin/env > /tmp/leak` from its own `pre-commit` hook and captured
`DEEPSEEK_API_KEY`, the runtime token, and anything else Mona holds.

- **Reproduction:** open a repository whose `.git/hooks/pre-commit` dumps its
  environment, stage a file, and commit through `GitService`. A control run with
  plain `git commit` under `DEEPSEEK_API_KEY=control-value` shows the hook *does*
  receive the variable (1 match), so the assertion is not vacuous.
- **Repair:** `buildGitEnvironment` (`src/main/work/git.ts`) is an explicit
  allowlist — PATH, HOME, USER, LOGNAME, TMPDIR, locale, Git identity,
  `XDG_CONFIG_HOME` — with a whole-token secret-name filter and forced
  `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`, `LC_ALL=C`.
  `SSH_AUTH_SOCK` is deliberately **not** passed: this service runs only local
  subcommands and never pushes, fetches, or clones, so handing a repository hook
  the user's loaded SSH keys would be needless authority (found in review).
- **Proof:** `test/work-git.test.ts` → *never hands Mona's provider secrets to a
  repository hook*; smoke checks `git_hook_ran` and
  `git_hook_saw_no_provider_key`.

### P20-02 — A lost event frame disappeared silently (high)

The pump reconnected with `sinceSeq = store.getCursor()`, which is the **highest
sequence stored**. If frame 4 was lost in transport and frame 5 arrived, the
cursor moved to 5 and frame 4 was never fetched again. The timeline showed a
complete turn that had lost an item.

- **Reproduction:** a stream that emits 1, 2, 5 (3 and 4 dropped), then replays
  from `since_seq=<contiguous>`.
- **Repair:** `WorkStudio.ingest` compares the incoming `seq` with the stored
  cursor. On a gap it records `sequence gap: <range>` in diagnostics and sets
  `session.resumeFrom` to the last contiguous sequence; the pump reconnects from
  there with the instability counter untouched (a deliberate replay is not a
  flapping stream). After two recoveries it stops rewinding and keeps the gap
  reported, because the engine contract does not promise contiguous numbering.
- **Proof:** `test/work-studio.test.ts` → *detects a sequence gap, replays it
  from the last contiguous event, and says so* (asserts `since_seq=2`, the
  diagnostic text, and stored seqs `{1,2,4,5,6}`), *records a gap instead of
  looping when replay never fills it* (≤2 rewinds), and *recovers a second gap
  in a later turn after the first turn spent its budget* (proves the budget is
  per turn, not per session).

### P20-03 — `extractArchive` followed a planted symlink out of its root (high)

`safeJoin` is lexical. A pre-existing `<root>/nested → /tmp/outside` made
`mkdirSync` + `writeFileSync` write outside the root; P19 carried this forward as
item 89.

- **Repair:** `prepareTarget` walks each component with `lstat`, refuses a
  symlink at any position and a non-regular final target, re-resolves the parent
  and re-checks containment, and the write is opened `O_EXCL`/`O_NOFOLLOW`
  (`O_TRUNC` only when overwrite is explicitly requested). A symlinked *root* is
  resolved to its real directory, since the caller named that destination.
- **Proof:** `test/safe-archive.test.ts` → *refuses a symlinked parent directory
  planted beneath the extraction root* (both overwrite modes), *refuses a symlink
  at the final entry name even with overwrite enabled* (victim file unchanged),
  *treats a symlinked root as its real directory, never as an escape*; smoke
  checks `archive_escape_write_refused` and `archive_escape_left_outside_clean`.

### P20-04 — A missing artifact surfaced as a raw `ENOENT` (medium)

`ArtifactFileStore.read` let the filesystem error escape, so the renderer
received a code it cannot act on and could not distinguish "deleted" from
"corrupt".

- **Repair:** `StateErrorCode` gains `ARTIFACT_MISSING`; `read` maps
  `ENOENT`/`ENOTDIR` to it with the relative path. Digest mismatch keeps
  `CORRUPT_DATABASE`.
- **Proof:** `test/p20-failure-matrix.test.ts` → *reports ARTIFACT_MISSING
  instead of a raw ENOENT and never invents bytes*, and *still detects silently
  altered bytes by digest*; smoke check `missing_artifact_named`.

### P20-05 — The home redactor renamed a different account's files (medium)

Three separate helpers used `path.startsWith(HOME) ? "~" + slice : path`, so with
home `/Users/victor` a path `/Users/victor2/x` rendered as `~2/x` — a *different*
file name in every diagnostic, log tail, and error message.

- **Repair:** one `redactHomePath(path, home)` in `src/main/work/settings.ts`
  requiring `home + "/"`, handling `home` exactly, and refusing a degenerate
  home. Capability, extensions, and terminal now call it.
- **Proof:** smoke check `redaction_respects_path_separator` and
  `test/p20-failure-matrix.test.ts` → *redacts the home directory and nothing
  that merely shares its prefix*.

### Adjacent fixes made while proving the boundary

- **Archive over-budget prefix (medium).** `readArchive` returned the entries it
  had already accepted when the total-byte cap was crossed, so a caller could
  import a truncated bundle. It now clears `entries` and reports
  `ARCHIVE_TOO_LARGE` with zero entries.
- **IPC sender policy (hardening).** Moved to `src/main/ipc-sender.ts`, free of
  Electron imports and therefore directly testable. It refuses a destroyed
  sender, a **child frame** (`senderFrame.parent != null`), a non-`file:` URL, a
  path outside the renderer root, and any evaluation that throws.
- **Finder alias honesty (medium, documentation + message).** The folder policy
  comment claimed aliases are "resolved"; `realpathSync` does not resolve an
  alias *file*. The comment now states what is true, and an alias file is refused
  as `NOT_A_DIRECTORY` with an instruction to open the folder it points at.

### P20-06 — A main-process crash orphaned the owned runtime tree (critical)

The supervisor's owner-liveness channel is the mechanism that makes main-process
death safe: EOF on fd 3 makes it stop the child tree. It never worked after an
*Electron* death, because `emit` wrote receipts with
`FileHandle.standardOutput.write`, which raises an uncatchable Objective-C
exception on a broken pipe — and the **first** statement of `stopTree` is an
`emit`. With the owner gone, the supervisor aborted before it signalled
anything, and the runtime was reparented to `launchd` with PPID 1.

- **Reproduction:** start the app in lifecycle-smoke crash mode, record the
  tree, `kill -9` the Electron pid. Supervisor gone in ~400 ms; child still
  `SN` under PPID 1 twenty seconds later.
- **Why it escaped P04:** the existing unit test closed the owner channel while
  the receipt pipe was still open, so `emit` always succeeded.
- **Repair:** `emit` writes with `write(2)` on fd 1 and discards `EPIPE`; the
  stop path now runs to completion whether or not anyone is listening
  (`native/macos-supervisor/main.swift`).
- **Proof:** `test/supervisor-native.test.ts` → *still stops the tree when the
  owner dies and nobody reads its receipts* (verified to **fail** against the
  pre-fix binary, pass against the fixed one), and the lifecycle smoke's new
  `crash_killed_main` / `crash_left_no_orphan` /
  `crash_left_no_orphan_supervisor` / `crash_shutdown_settled` checks (27/27).
- **Observed after the fix:** the supervisor survives its grace window
  (~2 s), stops the group, and exits 0; no process reparents.

## Failure matrix

Every row is exercised by `npm run smoke:failure` (22 checks, real stores and
real subprocesses) and/or the unit suite. `only mocked` means the fault is
induced by a stated seam, not by the product being replaced.

- **Stale revision** — proven · `store.renameProject` with an old revision →
  `STALE_REVISION`; row keeps `name=First, revision=2`. *smoke + unit*
- **Disk full** — proven · `freeBytes: 0` → `DISK_FULL`; task stays `pending`,
  revision unchanged. *smoke + unit*
- **Real `SQLITE_FULL`** — proven · `max_page_count` → transaction rolls back,
  zero rows. *unit (`state-database`)*
- **Maintenance barrier** — proven · a writer queued behind
  `runMaintenance` sees `active = 0` inside maintenance and runs after it.
  *smoke + unit*
- **Corrupted database** — proven · a non-SQLite file → `CORRUPT_DATABASE`, file
  preserved for diagnosis. *smoke*
- **Failed migration** — proven · pre-migration snapshot restored, checksum
  change refused, post-commit validation restores. *unit (`state-database`)*
- **Interrupted restore** — proven · corrupt snapshot →
  `MAINTENANCE_FAILED`, prior state intact, journal path recorded. *smoke + unit*
- **Crash during a transaction** — proven · a `SIGKILL`ed writer mid-`BEGIN
  IMMEDIATE` leaves a readable DB, `integrity = []`, zero uncommitted tasks.
  *smoke (real child) + unit*
- **Runtime crash / restart** — proven · bounded restart, then truthful stop;
  no auto-resubmit. *unit (`runtime-supervisor`, `supervisor-restart`)*
- **Sleep/wake** — proven at the supervisor seam · suspend → reconnecting,
  resume re-checks liveness before restarting. *unit* · **physical sleep is
  manual QA (P24/P26).**
- **Lost event stream** — proven · bounded backoff, stored-cursor resume,
  `stream_unstable` after the budget. *unit (`work-studio`)*
- **Gap in a live stream** — proven · one bounded replay from the last
  contiguous seq, then an honest recorded gap. *unit (new)*
- **Lost submission response** — proven · intent persisted before send, one
  read-only operation lookup, `outcome_unknown` when inconclusive, never a
  second write. *unit (`engine-adapter`, `work-studio`)*
- **Duplicate / out-of-order events** — proven · `INSERT OR IGNORE`, cursor is
  `max()`, never moves backwards; replayed batches store once. *smoke + unit*
- **Missing artifact** — proven · `ARTIFACT_MISSING`; tamper still
  `CORRUPT_DATABASE`. *smoke + unit*
- **Revoked credentials** — proven · `401` on submit → `AUTH_FAILED` after
  exactly one `POST /turns`, durable intent left non-completed; an
  unauthenticated stream raises `AUTH_FAILED` instead of reconnecting.
  *unit (`engine-adapter`, new)* · **a real revoked key needs P24/P26
  interactive QA.**
- **Occupied port** — proven · an HTTP 200 on a busy port is never accepted as
  ownership; `PORT_IN_USE` before spawning. *unit (`runtime-process`)*
- **Renderer crash** — proven · `process.crash()` on a real renderer:
  `render-process-gone` increments the count, main survives, the runtime child
  survives (`renderer_crash_kept_main`, `_counted`, `_kept_work`).
  *lifecycle smoke (real Electron)*
- **Main crash** — proven · `SIGKILL` on the real Electron process **without**
  any graceful path: the supervisor takes over through the owner-liveness
  channel, stops the group, and exits 0; zero orphans at PPID 1
  (`crash_killed_main`, `crash_left_no_orphan`, `crash_left_no_orphan_supervisor`).
  *lifecycle smoke + `test/supervisor-native.test.ts`* · **physical power loss is
  simulated through the crash-writer, not by cutting power.**
- **Owned process shutdown** — proven · `before-quit` disposes terminal
  sessions, closes the studio, and stops only what Mona owns; external runtimes
  are never signalled; after quit every recorded child is dead
  (`all_children_dead_after_quit`). *lifecycle smoke + unit*
- **Archive hostility** — proven · traversal, absolute, backslash, control,
  symlink, encrypted, zip64, CRC, duplicate, entry/total/entry-count caps; a
  refusable total yields no entries. *smoke + unit*
- **Repository hooks** — proven · allowlisted environment, secret withheld,
  control run shows plain Git *does* leak. *smoke + unit*
- **IPC sender** — proven · top-level local document accepted; remote, escaping,
  child-frame, non-file, destroyed, and throwing senders refused. *unit (new)*

## Security boundary review

| Boundary | State | Evidence |
|---|---|---|
| IPC sender/frame validation | validated; child frames refused | `src/main/ipc-sender.ts`, `test/p20-failure-matrix.test.ts` |
| IPC schema strictness | every channel is a `strictObject` | `src/main/ipc-contract.ts`, `test/ipc-contract.test.ts` (33) |
| Renderer isolation | `sandbox`, `contextIsolation`, no Node, no webview | `src/main/window.ts`, shell smoke (`require`/`process` = `undefined`) |
| Permissions / navigation | deny-all permission handlers; local-file navigation only; `window.open` denied | `src/main/security.ts`, `navigation.ts`, `test/navigation.test.ts` |
| CSP | `default-src 'self'`, `connect-src 'none'`, `object-src 'none'`, no inline script | `src/renderer/index.html`, `security.ts` |
| Runtime auth | random 24-byte bearer token, loopback-only, never logged or exported | `src/main/engine/runtime-process.ts`, `transport.ts` |
| Owned-process liveness | fd-3 EOF stops the tree even with a dead observer | `native/macos-supervisor/main.swift`, lifecycle smoke |
| Loopback binding | `^http://127\.0\.0\.1:\d+$` required by the transport | `src/main/engine/transport.ts` |
| Secret storage/redaction | engine credential store for provider keys; Mona redacts diagnostics; shelf/handoff refuse secret-shaped text | `work/settings.ts`, `work/shelf.ts`, `work/handoff.ts` |
| Child-process environment | Git allowlist (new); PTY allowlist (`-f`, no startup files) | `work/git.ts`, `terminal/pty.ts` |
| Markdown / output | text nodes only, raw HTML inert, links inert with https-only labels | `renderer/shell/markdown.tsx`, `test/studio-render.test.tsx` |
| Terminal links | OSC 8 becomes inert text; no VT100 emulation | `renderer/shell/ansi.ts`, `ADR-012` |
| Imported archives | fail-closed reader + real-path extraction with `O_NOFOLLOW` | `state/safe-archive.ts` |
| Prompt packs | schema-validated, digest-checked, secret-refusing, inert | `work/shelf.ts` |
| Path canonicalization | `realpathSync.native` + `(dev, ino)` identity | `state/identity.ts`, `open/folder-request.ts` |
| Generated-app previews | **no such surface exists in this build** | no renderer loads remote/local HTML into a privileged window |

## macOS filesystem hostility

- **Suspicious names** — `-rf`, `--help`, spaces, trailing space, newline, RTL
  override, composed and decomposed accents, quotes and `$HOME`, CJK: all
  resolve and are never reinterpreted. No path reaches a shell; engine, PTY, and
  Git receive paths as option *values* (`--workspace`, `--cwd`, `--`).
- **Symlinks** — resolved to the real folder, then deduped by `(dev, ino)`; a
  symlink, trailing slash, and `./a/../a` all produce one identity.
- **Unicode normalization** — a decomposed name resolves to the same canonical
  path and inode on this APFS volume; the folder policy records the fact.
- **APFS case behaviour** — dedupe is by inode, not by string, so a
  case-sensitive volume cannot produce two entries for one directory. The
  case-insensitive behaviour itself is a property of the user's volume and is
  recorded rather than assumed.
- **Finder aliases** — the Service and Dock paths deliver the resolved folder
  URL. An alias *file* is refused as `NOT_A_DIRECTORY` with an explanation; it is
  never silently followed. **Interactive Finder alias delivery remains P24 QA.**

## Verification

```
npm run typecheck            # main + renderer, clean
npx eslint src test scripts  # 0 errors (3 pre-existing warnings in older tests)
npx prettier --check …       # clean
npx vitest run               # 650 tests in 67 files
npm run build                # main + renderer
npm run smoke:failure        # 22/22
npm run smoke:lifecycle      # 27/27, including the new main-crash checks
npm run ci                   # 20/20 steps, renderer secret scan clean
```

Evidence artifacts: `docs/evidence/macos/artifacts/p20-failure-smoke.json`
(22 checks), `docs/evidence/macos/artifacts/p20-lifecycle-crash.json` (27
checks, including the real `SIGKILL` orphan proof), and
`docs/evidence/macos/artifacts/p20-ci.txt` (20 green CI steps).

## What is not claimed

- **No formal security certification.** This is a boundary review against the
  specified model, not an audit by a third party.
- **Physical sleep, a second macOS account, and a revoked live provider key**
  are manual QA (P24/P26).
- **The engine's own processes remain outside Mona's control** outside the
  owned-runtime supervisor; Mona proves ownership of what it started, not of
  what another owner started.
- **A local full-access agent can still damage user-accessible files.** Project
  labels and UI validation are not OS isolation.
