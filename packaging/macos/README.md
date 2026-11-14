# packaging/macos

The local Apple Silicon app and installer pipeline, landed at P21. Signed and
notarized release qualification is P22; update, migration, rollback, and
uninstall lifetime are P23 (see `docs/decisions/ADR-016-update-and-lifecycle.md`).

## Commands

```sh
npm run mac:doctor            # host, tools, artifacts, engine, identities (read-only)
npm run mac:install           # build, package, install it (sudo prompts), verify the installed copy
npm run mac:package:local     # build, sign ad-hoc, package, verify — stops before installing
npm run mac:package:dmg       # on request: a local disk image, verified from its own bytes
npm run mac:package:release   # fails closed: there is no Developer ID identity here
```

`mac:install` is the ordinary path to a running build: it packages exactly what
`mac:package:local` does, then installs that package with `sudo` (the password
prompt is your own terminal), then runs the install-side gates — the package
smoke against the installed app, the LaunchServices launch, and the whole-content
digest comparison that refuses to certify an installed copy which is not this
build. Without `--install` the same run stops at that comparison and says so.

`mac:package:dmg` is **not** part of the build loop and is not run by CI. It is
made when someone asks for a disk image.

**Distribution is local (D-103).** There is no Apple Developer account for this
project and none will be obtained, so there is no signed, notarized, shareable
release and `mac:package:release` correctly refuses to make one. `mac:package:local`
and `mac:package:dmg` are the artifacts this build has; the image contains a
notice saying so, and anyone else builds from source.

`mac:package:local` writes to `packaging/macos/out/` (gitignored):

- `Mona-<version>-macOS-arm64-local.pkg` — the flat installer.
- `Mona-<version>-macOS-arm64-local.dmg` — a local disk image: the app, a pointer
  to `/Applications`, the owner guide, and a README stating the local signing
  tier. `dmg-report.json` records its digest, the app content digest and every
  verification check, including the honest `gatekeeper_would_accept: false`.
- `manifest.json` — components, hashes, architecture/min-OS scan, dependency
  and secret scan, package digest, install checks.
- `install-receipt.json` — the build/install receipt.
- `sha256.txt`, `build.log`, `package-smoke.json`, `gui-launch.png` (when the
  session has Screen Recording permission).

The build always rebuilds the main/renderer bundles and the three native helpers
unless `--skip-build` is given, so a package cannot silently ship an older
`dist/` than its source.

The build also rehearses the removal utility it ships and writes
`out/uninstall-rehearsal.json` as it goes: a dry run that changes nothing, a
missing-manifest refusal, a wrong-identifier refusal, then a real removal that
preserves unrelated applications and user config. Every installer rehearsal is
guarded by `lib/rehearsal.mjs`, which refuses any root outside the process's
temporary directory — a build step must never resolve an empty
`MONA_INSTALL_ROOT` to the real `/`.

## Payload

- `Applications/Mona.app`
  - `Contents/Resources/engine/codewhale` — the pinned Codewhale 0.10.2 arm64
    binary, re-signed inside the app (upstream and packaged digests both
    recorded).
  - `Contents/Resources/native/mona-supervisor`, `mona-pty` — native helpers.
  - `Contents/Resources/docs/codewhale-capabilities-macos.json`.
  - `Contents/Resources/notices/` — Electron/Chromium, Codewhale, React,
    React DOM, zod notices.
  - `Contents/Resources/component-manifest.json` — the payload's own hashes.
- `Library/Services/Mona.service` — the Finder Service.
- `Library/Application Support/Mona/owned-paths.json` — the ownership list the
  removal utility reads; the only source of package-owned paths.
- `Library/Application Support/Mona/uninstall-mona.sh` — the bounded removal
  utility (P23). It verifies each bundle's identifier, refuses an unrecognized
  path or a missing manifest, and preserves every user's state by default.
  A candidate's identity is read from the package's own `PackageInfo` and
  `Distribution` (a metadata-only `pkgutil --expand`), which carry the package
  identifier, version, build counter, both bundle identifiers, the minimum macOS,
  and the arm64 gate. No extra metadata file is shipped: `productbuild` embeds only
  resources the Distribution references, so the build now reads the declared values
  back out of the finished package and fails if any is missing.

No ASAR archive, no native `.node` modules, no developer config, keys, state,
sessions, source projects, or build-machine paths.

## Installer behaviour

- arm64 only; macOS 14.0 or later (native helper deployment target).
- Non-relocatable app and service; reinstall replaces the package-owned bundles
  after checking their bundle identifiers.
- Minimal `preinstall`/`postinstall`: no network, no launch, no TCC changes, no
  project execution, no credential reads, no user-state writes.
- Writes `/Library/Application Support/Mona/install-receipt.json` and registers
  the Service with LaunchServices.
- `MONA_INSTALL_ROOT` is a rehearsal hook used by the build against a temporary
  root; real installs use `/`.

The real installation needs standard Installer administrator authorization:

```sh
sudo installer -pkg packaging/macos/out/Mona-<version>-macOS-arm64-local.pkg -target /
```

Local mode is ad-hoc signed and named/labelled “Local development build”. It is
not a shareable release. Release mode refuses to run without Developer ID
Application and Installer identities, and P22 adds notarization, stapling, and
release verification.

## Updating an installed copy (P23)

Mona never installs itself. With no distribution source configured it shows
**Manual package updates** and verifies a package you choose; with an explicitly
configured HTTPS source it reads an Ed25519-signed manifest, then verifies the
downloaded bytes. Either way the order is: verify → defer while any run is
active → record the intent → take a verified state snapshot → open Apple
Installer. Settings → Updates shows every recorded fact, including the exact
refusal code and the active items that deferred an update.

## Verification

See `docs/evidence/macos/P21-package.md` and
`docs/decisions/ADR-015-packaging-and-payload.md`. The build gate checks
architecture, dynamic-library paths, secret/path hygiene, package expansion and
symlinks, installer script rehearsal and idempotency, the installed app's
component digests, a real GUI launch, and (when the Service is installed) the
Finder Service registration.
