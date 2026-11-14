# P25 — Shared-core / Windows coordination audit

**Status:** interface audit complete; **no counterpart source was available**, so
no merge is claimed.
**Requirement:** MAC-008 (partial contribution).
**Baseline:** commit `db18592` (`main`), schema v13 (`queued-follow-ups`),
31 shared contract/command modules, 90 main-process modules, 43 renderer
modules.

## What was actually available

- This checkout (`Mac_MacOS-MacMona`) is the only source tree in the workspace.
- There is **no Windows checkout, no common-source checkout, and no
  `.mona/build/` ledger** (`ls .mona` → `build-macos/` only).
- The repository has one remote (`origin`). Nothing was fetched, pushed, or
  branched: the prompt forbids unrequested publication, and there was no
  authorized Windows branch to integrate.

So this is the second route the prompt allows: **a complete interface audit and
a precise integration handoff against the known baseline.** Nothing in this
document reports a cross-platform merge that did not happen.

## Machine-checked: the shared core is platform-free

`tools/p25-audit.mjs` (run by `test/shared-core.test.ts`) scans every file under
`src/shared` for:

- Node builtins (`node:fs`, `node:child_process`, `node:sqlite`, …);
- `process.platform` branches;
- `darwin` literals, `/Applications/`, `/Library/…` literals;
- shelling out to macOS tools, or Swift.

**Result on this commit:** 31 shared files, **0 violations**, 2 reviewed
*mentions* (`docs/evidence/macos/artifacts/p25-audit.json`):

- `src/shared/contracts/bridge.ts` — a comment naming the Finder handoff;
- `src/shared/contracts/update.ts` — the provenance label `"pkgutil"`.

Both are names, not behaviour. The second is a real portability seam: a Windows
core must map `source: "pkgutil"` to its own installer tool (for example an MSI
or Authenticode inspector) when it records update provenance. The Mac side will
not rename the value unilaterally, because that would invalidate P23 evidence.

## Classification of the main process

**76 of 90 modules are platform-free** and are the portable core. The 14
macOS-bound modules, with the reason the audit found:

- `src/main/index.ts` — window/menu/Dock wiring, `spctl`/`pkgutil` calls,
  Finder registration.
- `src/main/navigation.ts`, `src/main/window-fullscreen.ts` — `darwin` branch.
- `src/main/install-location.ts` — `/Applications`.
- `src/main/ipc.ts` — platform branch and Finder IPC.
- `src/main/open/*` — Finder Service registration and status.
- `src/main/update/service-status.ts` — `/Library/Services`, `pkgutil` receipts.
- `src/main/update/trust.ts` — `pkgutil`, `spctl`, `codesign` inspection.
- `src/main/update/uninstall.ts` — owned paths under `/Applications` and
  `/Library`.
- `src/main/work/git.ts` — the `/Applications/Xcode…` CLT-stub refusal.
- `src/main/work/changes.ts`, `src/main/package-smoke.ts`,
  `src/main/tool-discovery.ts` — Finder labels and installed-app checks.

Everything else — board, attempts, cost maths, memory, digest, handoff,
notifications, agents, capability, commands, the engine adapter, the event
projector, the state store, migrations, the portable bundle, the safe archive,
the terminal session manager, follow-ups — has no platform branch.

## The five platform seams (what a Windows core must implement)

These are the only places a second platform has to bind. Each already exists as
an interface or a named function on the Mac side; none of them is a second
engine.

1. **Runtime ownership.** `StudioSupervisor`
   (`src/main/work/studio.ts`): `ensure`, `endpoint`, `status`, `stopOwned`,
   `isOwned`. macOS implements it with a native supervisor process and a control
   socket. A Windows implementation needs a Job Object with
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and an equivalent owner-liveness channel.
   *The contract must not grow a platform field* — the studio only asks whether
   the runtime is owned and where it listens.
2. **Shell launch.** `buildShellEnvironment` (`src/main/terminal/pty.ts`) plus a
   PTY host. The allowlist, the "no startup files" rule, and the bounded buffer
   are portable policy; the PTY itself is `openpty` on macOS and ConPTY on
   Windows.
3. **Storage.** `StateStore` over `node:sqlite` with versioned migrations
   (`src/main/state/schema.ts`, v1–v13). The SQL and the migration contract are
   portable; only the database path and the file-mode hardening are
   platform-specific.
4. **Credentials.** Mona never reads a provider key. The engine owns its route
   and its store; the adapter passes opaque endpoint authority and credential
   *classes*. A Windows core must keep that boundary rather than introducing a
   local credential cache.
5. **Installation, update and removal.** macOS is installer-mediated
   (`Installer` + `pkgutil` + `productsign`). Windows needs its own trusted
   installer path with an equivalent refusal set (wrong publisher, tampered,
   downgrade, replayed, incompatible) and its own bounded removal manifest. The
   *policy* (`src/main/update/trust.ts` decisions, `UpdateCoordinator` states)
   is portable; the inspector is not.

Secondary seams, all already isolated: native menu-bar/Dock attention
(`src/main/work/attention-host.ts`, `src/main/work/notification-host.ts`),
Finder/Explorer integration (`src/main/open/`), and window zoom
(`src/main/zoom.ts` — Electron-level, portable).

## Portable data formats

These are the files that must round-trip between platforms:

- **Project bundle** (`src/main/work/handoff.ts`, `src/main/state/portable.ts`) —
  six entries, a manifest digest over every entry except itself, JSON payloads.
  No absolute mac home path is stored by construction; attempt/decision records
  travel inside `project.json`.
- **Settings backup** — the versioned `settings` table only. Deliberately not
  `config.toml`, which is the engine's file and may hold a literal key.
- **Task plan import/export** — inert JSON; a non-pending status is reported as
  deferred, never applied.

**Platform-specific by design, and must not be merged:** `install-receipt.json`
and `owned-paths.json`. They name `/Applications/Mona.app`,
`/Library/Services/Mona.service` and `/Library/Application Support/Mona`. A
Windows installer writes its own equivalents; importing a Mac receipt would be a
removal bug, and `uninstall-mona.sh` refuses paths outside its manifest.

## Migration compatibility

- One schema history, one direction: a Windows core must ship the **same
  migrations by version and checksum**. `migrationChecksum()` hashes the version
  and the SQL, so an edited historical migration is detected rather than
  silently applied.
- An older binary opening a newer database must refuse, not migrate backwards.
  The Mac build records the schema version in the installer receipt and in the
  recovery report; the Windows side needs the same check before it opens a
  shared copy of a bundle (not the database itself — a database is never shared
  between machines).
- A bundle import parses in memory and never overwrites an existing project's
  events; that rule is in the shared `safe-archive`/`portable` code and applies
  unchanged.

## Change list a Windows core would take

1. Consume `src/shared/**` unchanged (contracts, commands catalog, execution
   plan, ids). Do not fork it.
2. Consume the portable main modules listed above through the same interfaces;
   implement `StudioSupervisor` with a Job Object.
3. Map the `pkgutil` update-provenance label to the Windows inspector's own
   name in its receipts, keeping the same six-state refusal vocabulary.
4. Implement the installer/update/removal policy with the same refusals; keep
   `install-receipt`/`owned-paths` platform-specific.
5. Keep `.mona/build/` and `docs/requirements-*.json` separate; only
   `docs/requirements-macos.json` is this build's registry.

## What this audit does **not** claim

- **No comparison was made**, because no counterpart source exists. When a
  Windows checkout appears, the comparison is: shared files by content hash,
  contract exports by name, schema migrations by version+checksum, and the
  adapter surface by method signature.
- **No Windows behaviour is qualified** by Mac evidence. MAC-008 stays `partial`.
- **No shared test run proves both platforms.** The 1,076 Mac tests prove the Mac
  tree.
- **No push, branch, or publication** was performed.

## Evidence

- `tools/p25-audit.mjs` — the audit (no network, no build, no inference).
- `test/shared-core.test.ts` — 2 tests asserting platform-freedom, the baseline
  shape, and that the Mac-bound set is classified rather than hidden.
- `docs/evidence/macos/artifacts/p25-audit.json` — the recorded run.
