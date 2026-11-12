# packaging/macos

The local Apple Silicon app and installer pipeline, landed at P21. Signed and
notarized release qualification is P22.

## Commands

```sh
npm run mac:doctor            # host, tools, artifacts, engine, identities (read-only)
npm run mac:package:local     # build, sign ad-hoc, package, verify, install receipt
npm run mac:package:release   # fails closed until P22 signing/notarization exists
```

`mac:package:local` writes to `packaging/macos/out/` (gitignored):

- `Mona-<version>-macOS-arm64-local.pkg` — the flat installer.
- `manifest.json` — components, hashes, architecture/min-OS scan, dependency
  and secret scan, package digest, install checks.
- `install-receipt.json` — the build/install receipt.
- `sha256.txt`, `build.log`, `package-smoke.json`, `gui-launch.png` (when the
  session has Screen Recording permission).

The build always rebuilds the main/renderer bundles and the three native helpers
unless `--skip-build` is given, so a package cannot silently ship an older
`dist/` than its source.

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
- `Library/Application Support/Mona/owned-paths.json` — the P23 ownership list.

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

## Verification

See `docs/evidence/macos/P21-package.md` and
`docs/decisions/ADR-015-packaging-and-payload.md`. The build gate checks
architecture, dynamic-library paths, secret/path hygiene, package expansion and
symlinks, installer script rehearsal and idempotency, the installed app's
component digests, a real GUI launch, and (when the Service is installed) the
Finder Service registration.
