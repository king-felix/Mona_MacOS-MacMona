# P23 — Update, migration, rollback, and uninstall lifecycle

**Status:** complete (local milestone; release-feed trust pre-staged for P22) ·
**Date:** 2026-11-12 · **Prompt:** P23 ·
**Requirements:** MAC-006 (primary), MONA-025, MONA-027 (contributions) ·
**Decision record:** `docs/decisions/ADR-016-update-and-lifecycle.md`

## What this prompt had to prove

An installed copy has to stay maintainable: replaceable without losing work,
recoverable when a replacement fails, honest when an older app meets newer data,
and removable without touching a user's projects. The spec is explicit that this
is **installer-mediated**, not a self-updater, and that the trust verification
must be local and deterministic.

Six behaviours are required to pass locally: **upgrade N→N+1**, **reinstall**,
**failed migration**, **active-run deferral**, **wrong-package rejection**, and
**uninstall**. All six pass. Signed trust cases need P22's Developer ID; the
implementation and fixtures for that tier are complete and independently tested.

## What was built

- **`src/shared/contracts/update.ts`** — the whole vocabulary: channels, source
  configuration, manifest and signed envelope, package facts, rejection codes,
  deferral items, handoff receipt, intent record, uninstall view, and recovery
  view. Every persisted or IPC-carried value is a zod schema.
- **`src/main/update/version.ts`** — numeric version ordering with pre-release
  precedence, macOS version comparison, and build-counter parsing. The only
  basis for a downgrade or replay decision.
- **`src/main/update/manifest.ts`** — Ed25519 envelope verification over the
  exact payload bytes, key fingerprinting, and secure URL resolution constrained
  to the configured host **and base path**.
- **`src/main/update/trust.ts`** — the trust policy as a pure function over
  observed facts, plus real `pkgutil` package inspection (signature chain,
  identifiers, bundles, minimum OS, architectures) and the
  announce/package-staging split.
- **`src/main/update/source.ts`** — the only network code: HTTPS only,
  same-host and bounded redirects, bounded manifest and package sizes, a partial
  download that is hashed while written and removed on any failure.
- **`src/main/update/coordinator.ts`** — verify → defer → record → snapshot →
  hand off, with the intent ledger, the maintenance-barrier snapshot, and
  launch reconciliation.
- **`src/main/state/recovery.ts`** — read-only recovery facts (schema, journal,
  verified snapshots) and one explicit restore of a snapshot this build can
  open, which then migrates forward through the normal path.
- **`src/main/update/uninstall.ts`** — the uninstall view: manifest-owned paths
  with per-bundle identity verification, user state named separately, and the
  exact commands.
- **`src/main/state/schema.ts`** — migration **v8**: `update_intents` with
  forward-only states.
- **`src/main/state/store.ts`** — `recordUpdateIntent`, `attachUpdateBackup`,
  `settleUpdateIntent`, `latestUpdateIntent`, `listUpdateIntents`,
  `appliedUpdatePackages`, `backupForUpdate` (under the maintenance barrier),
  and `activeWork`.
- **`packaging/macos/scripts/uninstall-mona.sh`** + `lib/uninstall.mjs` +
  `lib/rehearsal.mjs` — the bounded removal utility, its build-time contract,
  and the guard that keeps every rehearsal inside a temporary directory.
- **`src/renderer/shell/UpdateSettings.tsx`** — Settings → **Updates**: build
  identity, source configuration, check result with its machine-readable code,
  candidate facts and digest, engine-change disclosure, active-work deferral
  list, update history, verified snapshots with a matching-schema restore, and
  the uninstall guide.
- **IPC** — eleven channels (`update:*`, `state:recovery*`), a narrow preload
  surface, and strict request schemas. No generic filesystem or exec reach.

## Acceptance evidence

### Upgrade N→N+1, and reinstall N→N

`smoke:p23` builds two package fixtures and drives the real coordinator over a
real store. For the upgrade it asserts `available` + `installKind: upgrade`, the
handoff receipt, that Installer was opened exactly once, that the snapshot's
recorded SHA-256 matches the file on disk, that the intent recorded before the
handoff names the same package and backup, and that the user's existing task is
still there afterwards. The reinstall case asserts `installKind: reinstall`, a
handoff, and preserved tasks.

Unit coverage: `test/update-coordinator.test.ts` (19 tests) covers intent-before-
handoff ordering, barrier release, deferral, unconfirmed local builds, a genuine
digest change (the inspector hashes real bytes), Installer refusing to open,
replay, launch reconciliation, missing files, manual mode, invalid
configuration, and an activity-probe failure counting as active.

### Failed migration and older-app-against-newer-schema

`test/update-recovery.test.ts` (7 tests) builds a database whose `user_version`
is beyond this build, proves `inspectRecovery` reports `newer_schema`, proves
`StateStore.open` refuses it with `UNSUPPORTED_SCHEMA`, proves a matching
snapshot restores and reopens with its rows intact, refuses a snapshot whose
schema the caller was not told about, refuses a path outside the backup
directory, reports a genuinely failed migration from its journal, and reports an
unreadable database while still listing snapshots.

The smoke repeats the newer-schema case over a real database and restores the
pre-update snapshot, checking the replaced database is kept.

### Active-run deferral

The store probe finds running tasks (with their active turn), live submissions,
and engine runtime bindings; the supervisor is a second independent check. A
probe failure is reported as active work with the reason *"Mona could not read
whether work is active"*, never as idle. Deferring writes no intent and launches
nothing, and the running task is confirmed still `running` afterwards.

### Wrong-package rejection

Eleven refusal codes are exercised in the smoke against the real policy:
`wrong_team`, `digest_mismatch`, `size_mismatch`, `package_unsigned`,
`package_adhoc`, `downgrade`, `replayed`, `os_too_old`, `architecture_mismatch`,
`product_mismatch`, and `engine_change_unconfirmed` — plus the positive control
that a confirmed engine change is accepted. `test/update-trust.test.ts` (22
tests) adds unsigned/ad-hoc/notarization, identity mismatches, local-vs-release
precedence, replay vs equal version, announce-stage evaluation, tampered and
wrong-key manifests, a signature valid for other bytes, a schema-invalid signed
payload, and secure URL refusals (plaintext, cross-host, credentials, traversal,
base-path escape).

### Uninstall

The shipped utility is rehearsed two independent ways:

- **The package gate** (`npm run mac:package:local`) installs the payload with the
  real `preinstall`/`postinstall`, runs the utility's dry run (exit 0, lists the
  owned paths, changes nothing), checks a missing ownership manifest is refused,
  checks a wrong-identifier bundle is refused, then removes the payload and
  confirms unrelated applications and user config survive. Result:
  `p23-uninstall-rehearsal.json`, all eight sub-checks true.
- **The smoke** runs the same shipped script against its own synthetic root and
  additionally proves the user's state directory and a `keep-me.json` survive.

`test/update-uninstall.test.ts` (6 tests) pins the view: only manifest-owned
paths, per-bundle identity verification, corrupt-manifest refusal, and the
separation of state deletion into its own `--remove-user-data --home` command.

### A real near-miss, and the mechanism that now prevents it

The first uninstall rehearsal passed only `MONA_UNINSTALL_ROOT`. `preinstall`
therefore saw an empty `MONA_INSTALL_ROOT`, resolved it to the real `/`, and
attempted `/bin/rm -rf /Applications/Mona.app`. It failed on permission (the
bundle is root-owned): `codesign --verify --deep --strict` still passes, all 640
files are present, and the receipt is intact — but it was one privileged session
away from destroying the installed app.

The repair is mechanism: both root hooks are always set together, and
`assertRehearsalRoot` refuses any root that is not inside the process's temporary
directory (`test/package-macos.test.ts` covers `/`, the temp root itself,
`/Applications`, a `tmp-` prefix lookalike, and empty). The utility's own bounds
are additionally asserted at build time by `reviewUninstallScript`.

## Verification

- **737 tests in 75 files** (P21: 666 in 69) — +71 tests across
  `update-version`, `update-trust`, `update-coordinator`, `update-recovery`,
  `update-uninstall`, `update-screen`, and `package-macos`.
- **`npm run ci` 21/21 steps** including the new `smoke:p23`; renderer secret
  scan clean (764,403 bytes, 3 files, 0 hits).
- **`smoke:p23` 55/55 checks, 0 skipped.**
- **`npm run smoke:shell` 120/120** with the real Electron shell; the Settings
  rail now carries a tenth tab and all 36 hash-pinned captures were re-recorded
  with no assertion removed.
- **`npm run mac:package:local`**: the uninstall gate is green; the build then
  stops at the documented install gate because replacing `/Applications/Mona.app`
  now needs administrator authorization (see the open item below).
- `smoke:p23` also fixed a genuine race in P18's terminal smoke: a marker
  reaching the ring does not mean the child finished writing, so the eviction
  assertion read `dropped: 0` on a slow run. It now waits for the ring to stop
  growing. (Observed twice before the fix; three clean runs after.)

## Artifacts

- `docs/evidence/macos/artifacts/p23-lifecycle-smoke.json` — the 55 checks.
- `docs/evidence/macos/artifacts/p23-uninstall-rehearsal.json` — the package
  gate's own rehearsal (eight sub-checks).
- `docs/evidence/macos/artifacts/p23-ci.txt` — the redacted 21-step CI run.
- `docs/decisions/ADR-016-update-and-lifecycle.md`.

## Open items

1. **The release trust tier has no signed artifact yet.** Every refusal and the
   whole acceptance path for a release candidate are implemented and tested, but
   a real Developer ID Installer signature and an accepted notarization are
   P22's. `mac:package:release` still fails closed.
2. **The rebuilt package is not installed.** `mac:package:local` now stops at
   "the installed copy is not this build" because replacing
   `/Applications/Mona.app` requires administrator authorization, which this
   session cannot supply non-interactively (`sudo -n` refuses). The command is
   the one from P21 and is recorded in `BLOCKERS.md`.
3. **No live feed was queried.** There is no configured host and none was
   invented; the network path (HTTPS fetch, redirect policy, bounded download,
   digest-while-writing) is covered by unit tests and the source module's
   contract, not by a live server.
4. **A cancelled Installer run is detected on the next launch**, not while it is
   happening: the intent stays `handed_off` until the running version is
   compared to the target. That is deliberate — Installer owns its own progress.
5. **Uninstall has no GUI action.** It produces an owned-path plan and the exact
   commands; executing them is the user's privileged decision in Terminal. A
   signed privileged helper with an authorization prompt is future work that the
   spec does not require.
