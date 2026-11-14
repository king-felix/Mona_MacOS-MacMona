# Mona — developer guide (macOS)

Mona is a native Apple Silicon workbench around the Codewhale engine: open a
folder, work in a Codewhale thread, and see the real state, the real cost, and
what actually changed. This guide describes the tree and the mechanics of
building it here. The operating contract for any session in this repository is
`AGENTS.md`; the user-facing view is `docs/owner-guide-macos.md`; the reasoning
behind the code lives in `docs/decisions/` (ADRs) and in the numbered `D-xxx`
entries of `.mona/build-macos/DECISIONS.md`.

## Platform and prerequisites

- **macOS on Apple Silicon.** The native helpers are compiled for
  `arm64-apple-macos14.0`. On any other host the build scripts report
  `skipped` with `native_qualification: "pending"` instead of producing a
  binary; nothing here is qualified for Intel or Rosetta.
- **Node 22 or later.** `package.json` declares `"engines": {"node": ">=22"}`.
  Electron carries its own Node, so a recipient needs none; a developer does.
- **Xcode Command Line Tools.** `xcrun --sdk macosx swiftc`, `clang`,
  `codesign`, `pkgbuild`, `productbuild` and `plutil` come from the CLT. Full
  Xcode is not required and `xcodebuild` is not used (D-006).
- **The pinned Codewhale 0.10.2 binary**, normally at
  `/opt/homebrew/lib/node_modules/codewhale`, for the live smokes and for
  packaging. Without it those steps fail; they do not silently pass.
- `npm run mac:doctor` (`packaging/macos/doctor.mjs`) reports the OS version,
  Rosetta translation, the Swift toolchain, code-signing identities, free disk,
  and whether the native helpers have been built. It is read-only and starts no
  product process.

## Repository layout

**`src/main`** — the Electron main process. Entry point `index.ts`; window and
lifecycle wiring in `window.ts`, `desktop-lifecycle.ts`, `menu.ts`,
`navigation.ts`. Trust and contracts are enforced here: `security.ts` (CSP and
permission handlers), `ipc-sender.ts` (sender trust), `ipc-contract.ts` (the zod
schema for every channel). Feature code is grouped by concern:

| Directory              | Holds                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/`              | The Runtime adapter: `adapter.ts`, `transport.ts`, `sse.ts`, `projector.ts`, the version/commit pin in `compat.ts`, and `runtime-process.ts`, which starts the engine under the native supervisor |
| `state/`               | The SQLite store: `schema.ts` (migrations), `migrations.ts` (runner), `store.ts`, `barrier.ts` (maintenance gate), `recovery.ts`, `safe-archive.ts`, `artifact-files.ts`, `portable.ts`           |
| `supervisor/`          | Driver and records for `mona-supervisor`: ownership, restart, identity checks                                                                                                                     |
| `terminal/`            | The integrated terminal over `mona-pty`: PTY lifecycle, buffer, session                                                                                                                           |
| `open/`                | Folder intake: validation (`folder-request.ts`), Finder Service status, open coordinator                                                                                                          |
| `work/`                | Product services: Studio, work board, costs, changes and Git, memory, settings, capability explorer, notifications, updates                                                                       |
| `projects/`, `update/` | Project catalog; the installer-mediated update path                                                                                                                                               |

**`src/preload/index.ts`** — the entire renderer-facing API. It exposes one
object through `contextBridge` and imports no Node built-ins. There is no raw
`ipcRenderer` and no dynamic channel name.

**`src/renderer`** — the React UI. `shell/` holds screens and view logic;
`design/` holds the design system, the screen components and the harness;
`styles.css` and `assets/` are the remaining renderer inputs. The renderer makes
no network requests: CSP sets `connect-src 'none'` and `test/boundary.test.ts`
fails if renderer sources reference `process.env`, Node modules, `ipcRenderer`
or the upstream wire types.

**`src/shared`** — code both sides may import, split by trust:

- `contracts/` — Mona's own shapes as zod schemas plus inferred types: project,
  engine, events, submission, usage, cost, changes, studio, follow-up, pending,
  bridge, board, agents, settings, extensions, terminal, capability, commands,
  memory, update. These are the only shapes a component may use.
- `engine-wire/runtime.ts` — upstream Codewhale Runtime API shapes transcribed
  from the pinned `RUNTIME_API.md`. Deliberately not Mona contracts: the adapter
  validates and converts them at the boundary, and no renderer component may
  import this module.
- `commands/` — the catalogue of Codewhale slash commands, its annotations and
  pinned entries; `fixtures/` — labelled test fixtures
  (`FIXTURE_LABEL = "TEST FIXTURE — NOT LIVE STATE"`) that are never a
  production fallback; `zoom.ts`.

**`native/`** — three Swift helpers, each with its own README, sources, and a
`build/` directory that is gitignored and carries a `build.json` receipt
(target, arch, digest, signature status):

- `macos-supervisor/` — owns the engine process tree; token passed on fd 3,
  descendants tracked by `(pid, start time)`, stop reported as
  graceful/escalated/survivors. Built by `npm run build:supervisor`.
- `macos-pty/` — the PTY host behind the terminal, plus `spawn.c` because Swift
  marks `fork()` unavailable. Built by `npm run build:pty`.
- `macos-services/` — the Finder Service "Start new DS project with Mona", with
  test-support receiver and harness bundles that are never shipped. Built by
  `npm run build:service`; fixtures by `node scripts/build-service-fixtures.mjs`.

**`packaging/macos`** — the installer pipeline. `build.mjs` builds the app,
signs, builds the flat package and verifies it from its own bytes;
`dmg.mjs` builds the local disk image; `release.mjs` is the release path that
fails closed; `doctor.mjs` reports readiness; `icon.mjs` renders the icon set;
`lib/` holds distribution constants, Mach-O inspection, signing arguments,
secret scanning, script rehearsal and uninstall review. `resources/` holds the
entitlement plists, installer assets and `LICENSE.codewhale.txt` (the pinned
engine's MIT notice).

**`scripts/`** — build helpers and smoke drivers. `ci.mjs` is the gate;
`build-supervisor.mjs`, `build-pty.mjs`, `build-service.mjs` compile the native
helpers; `*-smoke.mjs` is the launch-and-assert pattern described below.

**`test/`** — vitest suites, `test/helpers/` and `test/fixtures/`. Files that
need a DOM opt in with `// @vitest-environment jsdom`; everything else runs in
the node environment configured in `vitest.config.mts`.

**`tools/monabuild`** — the build-ledger CLI. Build infrastructure, not product
code: it is excluded from eslint and prettier. `tools/p01-spike/` generated the
capability inventory; `tools/p18-coverage/reconcile.mjs` reconciles it.

**`docs/`** — the owner guide, discovery report, design system, ADRs, the
generated requirements registry (`requirements-macos.json`), the capability
inventory, and `docs/evidence/macos/` with per-prompt evidence and captured
command output.

**`.mona/build-macos`** — the build ledger: `state.json` (the single source of
truth for prompt status) and its `.bak`, `attempts.jsonl`, `DECISIONS.md`,
`BLOCKERS.md`, `HANDOFF.md`, `index.json`, and `reviews/studio-v2/` for the
subordinate Studio review ledger. Rule 4 in `AGENTS.md` bounds what this build
may write: `.mona/build-macos/`, `docs/requirements-macos.json` and
`docs/evidence/macos/`. The Windows `.mona/build/` ledger is out of scope.

## Setup and the ordinary loop

```sh
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run start
```

`npm ci` installs from `package-lock.json`; the `postinstall` hook runs
Electron's own installer, so the first install needs network access once. After
that:

- `npm run build` cleans `dist/` and `coverage/`, compiles main and preload with
  `tsc -p tsconfig.main.json`, then builds the renderer with Vite.
- `npm run typecheck` runs both TypeScript projects with `--noEmit`; the
  renderer project has its own `tsconfig.renderer.json`.
- `npm run lint` is `eslint .`. It ignores `dist`, `docs/evidence`,
  `packaging/**/out`, `tools/monabuild` and `tools/p01-spike`.
- `npm run test` runs `vitest run`. Its `pretest` hook builds the supervisor and
  the PTY helper first, because several suites spawn the real binaries.
- `npm run smoke` is the smallest end-to-end proof: it launches the real shell
  with `PATH=/usr/bin:/bin` to imitate a Finder launch and asserts what the
  preload actually exposed.

`npm run format` and `npm run format:check` are Prettier over the whole tree.
`.prettierignore` excludes law and generated material — `AGENTS.md`, the
specification and prompt sequence, `.mona/`, `docs/requirements-macos.json`,
`docs/codewhale-capabilities-macos.json`, `docs/discovery-macos.md`,
`docs/evidence/`, and the `tools/monabuild` / `tools/p01-spike` trees.

## The one gate: `npm run ci`

`scripts/ci.mjs` runs the repository's checks in a fixed order with `CI=1` and
stops at the first failure, so a green run means every step ran:

1. `format:check`, `lint`, `typecheck`.
2. `catalog:check` — the pinned slash-command catalogue must match its
   annotations and capture digest. Offline and deterministic.
3. `build:supervisor`, `build:pty`, `build:service` — the native helpers.
4. `test` — the vitest suite.
5. `build` — main, preload and renderer.
6. The smokes, in this order: `board`, `cost`, `changes`, `polish`, `agents`,
   `settings`, `reasoning`, `extensions`, `terminal`, `capability`, `commands`,
   `history`, `memory`, `failure`, `p23`, `lifecycle`.

If every step passed, it then walks `dist/renderer` and fails on a provider-key
pattern, a runtime-token or provider-key environment-variable name, a private
key block, a source map, a `node_modules/` path, or the live `DEEPSEEK_API_KEY`
value when that variable is set. The JSON summary on stdout records each step's
exit code and elapsed time, the renderer scan, and `dist_bytes`.

Several smokes need the pinned engine binary — `smoke:capability` for the
`--help` probes and version/commit drift, and any smoke that starts the runtime.
On a machine without it those checks fail rather than skip, which is the
intended behaviour — an unproven claim is not a pass.

## Packaging

```sh
npm run mac:package:local   # build, ad-hoc sign, flat .pkg in packaging/macos/out
npm run mac:install         # same build, install with sudo, then verify /Applications
npm run mac:package:dmg     # local disk image — on request only
```

- `mac:package:local` runs `packaging/macos/build.mjs --mode local`. It packages
  the app and the Finder Service, ad-hoc signs, labels the package as a local
  development build, rehearses both installer scripts twice in a temporary root,
  launches the installed app through LaunchServices with a fresh home, and
  verifies the payload against the artifact it just built.
- `mac:install` is the ordinary loop. It builds exactly as above, installs with
  `sudo` on your own terminal, then re-runs the install-side gates against
  `/Applications/Mona.app`. It refuses immediately when there is no terminal
  rather than hang on a password prompt, and it does not use `sudo -n` (D-107).
- `mac:package:dmg` produces a local disk image of the same ad-hoc-signed app,
  with a notice stating that Gatekeeper refuses it on any other Mac. It is not
  run by `mac:install`, by `mac:package:local`, or by CI. The image installs the
  app only; the package also updates the Finder Service.
- `mac:release` is implemented and **fails closed**. There is no Apple Developer
  account and none is planned, so the distribution tier is local. The app is
  ad-hoc signed with no Developer ID and no notarization ticket; macOS refuses
  it on any other Mac, and `spctl` assessment there is expected to reject it.
  That is the decision recorded as "There is no shareable release; the
  deliverable is a local build" in `.mona/build-macos/DECISIONS.md` — the ledger
  currently carries two entries numbered D-103, so cite that one by title.
- The declared OS floor is macOS 14.0 and the tested host is macOS 26.5.1; the
  claim states both separately (D-104). The floor is enforced by the installer
  and has not been executed on a 14.x host.

## Engine adapter qualification

`src/main/engine/compat.ts` is the whole policy:

```ts
export const PINNED_ENGINE = {
  version: "0.10.2",
  commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e",
} as const;

export const REQUIRED_CAPABILITIES = ["threads", "turns", "event_replay"] as const;
```

`evaluateCompatibility(info)` compares the engine's `/v1/runtime/info` against
that pin and returns a report with `versionMatch`, `commitMatch`,
`missingCapabilities` and human-readable `reasons`. A different version, a
different commit, or a missing required capability is an incompatibility, not an
invitation to try unknown fields:

- `EngineAdapter.discover()` throws `AdapterError("INCOMPATIBLE_ENGINE", …)` with
  the report attached. Nothing downstream runs against an unqualified engine.
- `startOwnedRuntime` records the report on the runtime handle, so the UI can
  show why a runtime is not usable instead of presenting a degraded success.

The commit is pinned as well as the version because a rebuild of the same
version can carry a different surface; the pin is the exact installed build
recorded by P00 (D-007). The packaging script pins the same build a second time,
with its SHA-256 and source path, in `PINNED_ENGINE` at the top of
`packaging/macos/build.mjs`, and refuses a bundle whose engine bytes differ from
the qualified artifact.

To qualify a new engine, in this order:

1. Read the Runtime API document for that exact tag, not `main`. The P00 copy is
   `docs/evidence/macos/artifacts/upstream-RUNTIME_API.md`; it is the upstream
   text and names `app-server --http` as the canonical transport.
2. Update `PINNED_ENGINE` and, only if the adapter relies on more, the
   `REQUIRED_CAPABILITIES` list.
3. Update the engine block in `docs/codewhale-capabilities-macos.json` and
   reconcile it (see below).
4. Update the packaging pin (version, commit, SHA-256, source path).
5. Run the adapter and compatibility suites, then `npm run engine:smoke`, which
   builds and runs the real pinned binary under the supervisor.
6. Record the decision and its evidence in `.mona/build-macos/DECISIONS.md`.
   A silent upgrade is a bug.

## State schemas and migrations

State is SQLite through Node's built-in `node:sqlite` (`DatabaseSync`).
`src/main/state/schema.ts` declares the history:

- `MIGRATIONS` is an ordered array of `{ version, name, sql }`.
  `CURRENT_SCHEMA_VERSION` is the last entry's version.
- The database's version is SQLite's `PRAGMA user_version`; the applied
  migrations are also rows in `schema_migrations`, each with a SHA-256 checksum
  over `version + "\0" + sql`.
- `REQUIRED_TABLES` and `requiredTablesFor(version)` say which tables a database
  at a given version must have, so a migration that forgets a table fails
  validation instead of surfacing later as a missing-table error.

`migrateDatabase` (`migrations.ts`) is the runner. For an existing database it:

1. refuses a database newer than this build (`UNSUPPORTED_SCHEMA`) rather than
   guessing at unknown columns;
2. verifies the checksum of every applied migration, so editing an applied
   migration is detected, not silently ignored;
3. takes a snapshot with SQLite's online backup API into `backups/` and asserts
   its integrity before touching anything;
4. writes a journal (`started`) before the first change;
5. applies pending migrations in one `BEGIN IMMEDIATE` transaction with foreign
   keys disabled around it (the documented table-rebuild procedure), writes
   `user_version`, and commits;
6. validates version, required tables, the `schema_migrations` set and
   `PRAGMA foreign_key_check`, then marks the journal `complete`;
7. on failure, restores the pre-migration snapshot, keeps the journal and the
   failed file, and throws `MIGRATION_FAILED` with both paths in `details`.

Backup and restore are maintenance operations. Every writer passes through
`MaintenanceBarrier`; `backupTo` and `restoreFrom` take it exclusively, and the
queue is writer-preferring so a busy app cannot starve a backup. The barrier is
not re-entrant, which is why public store methods acquire it once and call
internal helpers afterwards. `state/recovery.ts` handles the case where the app
cannot open the database at all, and distinguishes `newer_schema`,
`migration_failed` and `unreadable`; it restores only a snapshot whose
`user_version` equals this build's.

**Adding a migration.** Append a new entry; never edit an applied one. A change
SQLite cannot make in place — altering a `CHECK` constraint, for example — is a
table rebuild: create the new table, copy and translate the rows, drop the old
one, rename, and recreate the indexes (V3 in `schema.ts` is the worked example).
Add any new table to `REQUIRED_TABLES` and to the version gate in
`requiredTablesFor`. Then migrate real data, not an empty schema: extend
`test/state-database.test.ts` (or add a suite beside it) with a database created
at the previous version, run the migration, and assert both the data and the
reported version. The suite already covers failed-migration restore and recovery
classification; keep those green.

## Failure fixtures

The failure matrix exists twice, at two grains, and both are run by
`npm run ci`.

`test/p20-failure-matrix.test.ts` asserts the product's named answer at unit
grain, injecting real faults rather than mocked returns. It covers:

- **IPC sender trust** — only the top-level local renderer document is
  accepted; remote, escaping, child, non-`file:`, destroyed and unreadable
  senders are refused.
- **Missing and tampered artifacts** — `ARTIFACT_MISSING` with the relative path
  in `details`, never a raw `ENOENT`; altered bytes detected by digest.
- **Home redaction** — the home directory is redacted and a path that merely
  shares its prefix is not.
- **Hostile folder names and identity** — unusual but legal names (`-rf`,
  newlines, RTL overrides, decomposed Unicode) resolve without reinterpretation;
  symlink, trailing slash and `..` forms collapse to one `(dev, ino)` identity;
  an alias-like file is refused as `NOT_A_DIRECTORY`.
- **Event identity** — an out-of-order duplicate is stored once and the cursor
  never moves backwards.
- **Archive limits** — an archive over its byte budget or entry count yields no
  entries and a named problem code.

`scripts/p20-failure-smoke.mjs` (`npm run smoke:failure`) injects real faults
against real stores and real child processes, reads the durable result back, and
writes `docs/evidence/macos/artifacts/p20-failure-smoke.json`. Its checks are:

| Check                                                        | Fault                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `stale_revision_refused`                                     | a second writer holding an old revision loses with `STALE_REVISION`, row untouched |
| `disk_full_refused`                                          | a full disk refuses the write with `DISK_FULL`, no partial row                     |
| `maintenance_barrier_quiesces_writers`                       | queued writers cannot run inside a maintenance window                              |
| `corrupt_database_named`                                     | a non-database file is refused as `CORRUPT_DATABASE` and preserved                 |
| `interrupted_restore_refused`                                | a corrupt snapshot changes nothing, and its journal survives                       |
| `missing_artifact_named`                                     | a deleted artifact reports `ARTIFACT_MISSING`                                      |
| `archive_escape_write_refused`                               | a symlinked directory cannot redirect an extraction write                          |
| `git_hook_saw_no_provider_key`                               | a repository hook sees the allowlisted Git environment only                        |
| `redaction_respects_path_separator`, `redactor_hides_secret` | redaction is not prefix-matching and removes secret-shaped values                  |
| `crash_during_transaction_left_readable_db`                  | a `SIGKILL`ed writer leaves a readable database and no uncommitted row             |

Only the clock and the free-space probe are stood in for, and the file says so.
When adding a case, keep that discipline: inject a fault the product will
actually meet, assert the named code and the durable state, and let
`report.ok` stay derived from every check. If a stand-in is unavoidable, label
it in the source.

## Capability coverage

`docs/codewhale-capabilities-macos.json` is generated by
`tools/p01-spike/build-inventory.mjs` from the pinned engine's surface. The
reconciliation overlay in `tools/p18-coverage/reconcile.mjs` records what Mona
can actually reach: for each `MONA-CAP-xxx` row it supplies `scope`,
`invocation`, `help_source`, `integration` (`native_view`,
`advanced_action`, `integrated_terminal`, `unavailable`, `blocked_gap`), an
explicit entry point (`kind`, `target`, `label`, `tested`), a status, and either
a named test or a named gap.

```sh
node tools/p18-coverage/reconcile.mjs          # check; exits non-zero on drift
node tools/p18-coverage/reconcile.mjs --write  # apply the overlay to the file
node tools/p18-coverage/reconcile.mjs --json   # coverage only, machine-readable
```

The check recomputes the file and compares everything except
`coverage.assessed_utc`; drift reports "run with `--write`". It also rejects a
row with no reconciliation, a CLI row whose command the recorded help no longer
lists, an entry point of `none` on a row not marked `blocked_gap` or
`unavailable`, and a `verified` row whose entry point was never exercised or
whose test note begins "Not exercised". A `verified` terminal row must name
`smoke:capability`, because that is what actually executed the route. Coverage
is computed from the rows, never asserted, so an unreachable feature stays
visible and parity is not claimed while any row is open.

`npm run smoke:capability` runs the reconcile in check mode and asserts
`reconcile_in_sync`, that coverage math adds up, that every row has an
invocation, help source and test text, that every entry target exists, that
parity is not claimed, and — against the installed binary — that the engine
version and commit match the inventory with no added or removed commands and
that every recorded `--help` answers.

To cover a new capability: let P01's generator discover it, add the overlay row
with its true entry point, and leave the status `unqualified` until a named test
or smoke exercises that entry point.

## Evidence and the ledger

```sh
node tools/monabuild/cli.mjs status
node tools/monabuild/cli.mjs validate
node tools/monabuild/cli.mjs checkpoint --expect-revision <n> --patch-json '{...}'
node tools/monabuild/cli.mjs evidence --prompt P20 docs/evidence/macos/P20-failure-matrix.md
node tools/monabuild/cli.mjs index --write
node tools/monabuild/cli.mjs secrets
```

- `status` prints the compact ledger summary and attempt counters; `validate`
  checks the state schema, the requirements registry, task/registry agreement
  and evidence hashes, and reports hash-index drift. It exits non-zero on any
  error; index drift is a warning.
- `checkpoint` refuses a stale `--expect-revision` (exit 3), validates against
  `tools/monabuild/schemas/state.schema.json`, writes atomically, and keeps the
  previous revision in `state.json.bak`. `recover` restores that backup, or the
  committed blob at `HEAD` on a fresh clone, preserving any damaged file first.
- `evidence` attaches files to a prompt with their SHA-256. `index --write`
  regenerates the hash index. `secrets` scans tracked files for credential
  patterns and is required before every commit.
- Exit codes are `0` ok, `1` invalid, `2` usage, `3` refused.

Only `.mona/build-macos/`, `docs/requirements-macos.json` and
`docs/evidence/macos/` are written by this build. The registry's **structure** is
generated: regenerate it with `node tools/monabuild/cli.mjs requirements sync`
rather than reshaping ids or prompt links by hand. Its human half — `status`,
`acceptance`, `evidence` and `notes` — is authored and is preserved across a sync
(`mergeWithExisting`), so reconciling a row means editing those fields and running
`sync` to validate. Do not write outside those three paths.

## Adding a new smoke

A smoke is two halves: a mode inside the app that produces a JSON report, and a
driver that spawns the app and grades that report.

1. **App side.** In `src/main/index.ts`, add a CLI flag
   (`IS_<NAME>_SMOKE = process.argv.includes("--<name>-smoke")`) and a
   `run<Name>Smoke(window)` branch. The `MONA_*_SMOKE_*` environment variables
   name where the report and its artifacts go — `MONA_SMOKE_OUT` for the base
   smoke, and `MONA_<NAME>_SMOKE_OUT` / `MONA_<NAME>_SMOKE_OUT_DIR` (plus
   `MONA_R11_SMOKE_MODE`, `MONA_R11_AXE_PATH` where a mode or asset is needed)
   for the rest. The flag selects the mode; the variables only carry paths.
   Write a report with `schema_version`, a label, `captured_at`, `ok`, and named
   checks, and set a non-zero exit code when a check fails.
2. **Driver side.** Add `scripts/<name>-smoke.mjs`. Spawn Electron (or a built
   app) with the flag and the environment, keep `PATH` minimal when imitating a
   Finder launch, collect stdout and stderr, read the report, and treat a
   missing report as a failure — never as "no failing checks". Fail the process
   on any false check and print a short summary.
3. **Gate.** Add the npm script next to its peers in `package.json`, with the
   build step it needs in front (some smokes run `npm run build:main` only), and
   add it to the list in `scripts/ci.mjs` if it should block a change.
4. **Constraints.** A smoke that is not about the engine starts no runtime and
   makes no model request; several say so in their own source. Artifacts go
   under `docs/evidence/macos/`.

`scripts/r11-smoke.mjs` also accepts `--app /Applications/Mona.app`, which makes
it spawn the installed binary instead of `electron .`, so the same performance
and accessibility harness can measure the product a recipient would launch.

## Where to look next

- `AGENTS.md` — the operating contract, the checkpoint protocol, and the rules
  this guide assumes.
- `docs/decisions/` — ADR-002 (IPC and renderer trust), ADR-003 (supervisor),
  ADR-004 (project state), ADR-014 (hardening) and ADR-015 (packaging).
- `docs/owner-guide-macos.md` — what the app does, written for its user.
- `docs/evidence/macos/` — per-prompt evidence, including
  `P20-failure-matrix.md` and `security/dependency-advisory-2026-11.md`.
