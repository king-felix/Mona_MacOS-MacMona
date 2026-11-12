# ADR-016 — Installer-mediated updates, recoverable migration, and bounded removal

**Status:** accepted at P23 · **Date:** 2026-11-12

## Context

P21 shipped a complete local package that owns four system paths and writes
nothing into a user's state. P22 owns signing and notarization and is blocked on
a Developer ID identity. P23 must make that package maintainable: an installed
copy has to be replaceable without losing work, a failed replacement has to be
recoverable, an older app must not quietly corrupt newer data, and removal has
to delete exactly what the package installed — no more.

The spec is explicit that this is **not** a self-updater: Apple Installer is the
installer, and Mona's job is to verify, defer, record, back up, and hand off.

## Decisions

### 1. Two trust tiers, never blended

An update is one of two things, and the UI says which:

- **Release** — an Ed25519-signed manifest from an explicitly configured HTTPS
  source, a Developer ID Installer signature from the configured team, a matching
  digest and length, a declared notarization, and a strictly increasing version.
- **Local** — a `.pkg` the user chose. Its identity comes from `PackageInfo` and
  its digest is recorded, but an ad-hoc package is _never_ publisher-
  authenticated, and a local package can never replace a release install.

A manifest's digest is worthless on its own: an attacker who can change the
manifest can change the digest with it. The envelope signs the exact payload
bytes, the package signature names the publisher, and neither is trusted alone.

### 2. The check is local and deterministic; installation is Installer's

There is no built-in URL and no default host. With nothing configured, Mona says
**Manual package updates** and never reaches the network. A configured check is
one HTTPS GET of a bounded document on the configured host, with same-host
redirects only and no proxy or credential trust. The expensive and privileged
step — actually replacing `/Applications/Mona.app` — is handed to Apple
Installer, which asks the user for authorization itself. Mona never escalates
its own privileges and never runs a downloaded script.

An update check makes **zero** inference requests; `UpdateCheckView.inference`
is a literal `{requests: 0}` that the screen prints.

### 3. Verify → defer → record → snapshot → hand off, in that order

The order is the guarantee, and every step is a separate refusal:

1. **Verify** the candidate against the policy. Wrong team, tampered bytes,
   wrong size, unsigned, ad-hoc, unnotarized, foreign identity, Intel, too-old
   OS, downgrade, replay, and an unconfirmed engine change are all distinct
   codes with actionable reasons.
2. **Defer** when anything is active. The activity probe reads the store
   (running tasks with their active turn, live submissions, engine runtime
   bindings) and the supervisor, and a probe _failure_ counts as active work,
   not as idle. Deferring never stops, pauses, or interrupts anything.
3. **Record the intent** in `update_intents` (schema v8) before any privileged
   action, with the from/to version, channel, package path, digest, source, and
   the build. State advances forward only: `recorded → handed_off →
observed_migrated | cancelled | failed`.
4. **Snapshot** the whole database under the exclusive maintenance barrier,
   reopen it read-only, integrity-check it, and hash it. The hash goes into the
   intent, so a later recovery has a verified target rather than a guess.
5. **Hand off** to `/usr/bin/open -a Installer <pkg>`, and only then report
   `handed_off`. A failure to open Installer closes the intent as `failed` and
   leaves Mona running with its state unchanged.

`quitRequested` is true only after a confirmed handoff, and the quit goes through
the normal shutdown path (interrupt nothing — nothing is active by construction —
stop the owned runtime, then quit) so the bundle is free for Installer.

### 4. App rollback and database rollback are different, and both are refused safely

- An older Mona opening a newer database is refused with `UNSUPPORTED_SCHEMA`.
  There is no "try anyway": `user_version` is compared to the build's schema and
  a newer value stops the store from opening at all.
- A **DB rollback** is an explicit restore of a verified snapshot. A snapshot is
  offered only when its schema is between 1 and this build's schema and it
  passes an integrity check; a newer snapshot is never offered. Restoring moves
  the current database aside (never deletes it), verifies the restored file, and
  migrates it forward through the same `migrateDatabase` path — so the forward
  migration takes its own pre-migration snapshot and journal.
- The startup path distinguishes `newer_schema`, `migration_failed`, and
  `unreadable`, and offers the newest matching snapshot in a native dialog. If
  there is no matching snapshot it says so and keeps the evidence.

A failed migration already left a pre-migration snapshot and a journal (P05);
P23 makes them discoverable and restorable, and names the support path.

### 5. Removal is bounded by the package's own manifest

`/Library/Application Support/Mona/uninstall-mona.sh` ships inside the payload.
It reads `owned-paths.json` — the only source of package-owned paths — and:

- plans only paths that manifest names, and verifies each bundle's
  `CFBundleIdentifier` before removing it;
- refuses an unrecognized path instead of deleting it; refuses entirely when the
  ownership manifest or receipt is missing;
- keeps every user's state, projects, credentials, and external Codewhale
  installation unless `--remove-user-data --home <one user>` is given;
- has no `--all-users`, no wildcard, no home walk, and no `rm -rf` of an
  unresolved variable.

The build refuses to ship a script that violates those bounds
(`lib/uninstall.mjs`), rehearses the shipped script against a temporary root, and
guards every rehearsal with `assertRehearsalRoot` so a build step can never run
an installer script against the real `/`.

**This guard was written after a real near-miss in this prompt.** The first
uninstall rehearsal passed only `MONA_UNINSTALL_ROOT`, so `preinstall` saw an
empty `MONA_INSTALL_ROOT`, resolved it to the real `/`, and attempted
`rm -rf /Applications/Mona.app`. It failed on permission (the bundle is root-
owned; `codesign --verify --deep --strict` still passes and all 640 files are
present), but the attempt was one privileged session away from destroying the
installed app. The fix is mechanism, not discipline: both root hooks are always
set together, and a non-temporary root is a hard build failure.

### 6. The manifest carries its own documentation

`Distribution`'s resources now include `update-metadata.json` (version, build,
channel, bundle and package identifiers, minimum macOS, architectures). It is
read from a metadata-only `pkgutil --expand`, which is fast, and it is
cross-checked against `PackageInfo` and the `Distribution` rather than believed.
It is package metadata, not an authentication credential.

## Consequences

- A release feed needs P22's Developer ID identity; until then the tier exists,
  is tested, and is refused rather than approximated.
- `update_intents` is a record of intent, not a package database. Installer owns
  installation state; a cancelled Installer run is detected on the next launch
  by comparing the running version to the intent's target.
- The engine is never updated independently. A package that ships a different
  engine is a whole-app change and requires an explicit, digest-bound
  acknowledgement.
- The removal utility cannot remove a Mona build that was installed by hand (no
  receipt, no manifest). That is the intended asymmetry: an uninstall that
  guesses is an uninstall that eventually deletes someone's work.
- P24 still owns the recipient test: quarantine, a clean Mac, a second user, and
  the signed artifact.
