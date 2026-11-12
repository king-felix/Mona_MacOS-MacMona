# P21 — Self-contained arm64 app and offline installer

**Date:** 2026-11-12 · **Status:** complete (local milestone) · **Host:**
macOS 26.5.1, Apple M3 arm64, CLT SDK 14.4 / Swift 5.10 · **Electron:** 45.3.0
· **Engine:** Codewhale 0.10.2 (`ff466b2ed0bf`) · **Signing:** ad-hoc only
(0 Developer ID identities)

## Result

A real, complete Apple Silicon app and flat installer exist and were installed
on this Mac:

```
Mona-0.1.0-macOS-arm64-local.pkg
SHA-256 06c06042a7da48e2edf24b78cf4d75f3d53eaf6c470fbe29bcee81572b2e9eb0
161,927,839 bytes
```

`/Applications/Mona.app` is 364,218,636 bytes (content digest
`ce4ff5df307c…`), carries the pinned Codewhale engine, the native supervisor,
the native PTY helper, the capability inventory, the Finder Service payload, and
the third-party notices. It launches through LaunchServices from Applications,
opens a renderer, initializes a fresh per-user state store, and exits cleanly.
The packaged Finder Service passed the full 21/21 native discovery/launch proof.
The only trust claim not made is a signed, notarized release: that is P22, and
the release mode refuses to build without it.

## What the package owns

- `/Applications/Mona.app`
- `/Library/Services/Mona.service`
- `/Library/Application Support/Mona/install-receipt.json`
- `/Library/Application Support/Mona/owned-paths.json`

It preserves `~/Library/Application Support/Mona`, `~/.codewhale`, the user's
external Codewhale installation, credentials, and every project. The install
receipt names the component-manifest digest, version, channel, package, and
install time. `owned-paths.json` is the P23 uninstall input.

## Payload components

| Component | Kind | Arch | Min macOS | Bytes | SHA-256 (first 12) |
|---|---|---|---|---|---|
| `engine/codewhale` | engine | arm64 | 11.0 | 89,793,568 | `41e6dfd8577a` |
| `native/mona-supervisor` | helper | arm64 | 14.0 | 201,920 | `15db348b18d6` |
| `native/mona-pty` | helper | arm64 | 14.0 | 105,136 | `9c23d0387e4f` |
| `docs/codewhale-capabilities-macos.json` | data | — | — | 98,447 | `10d45d85228d` |
| notices + Chromium notices | notice | — | — | — | see manifest |

The engine's upstream digest and packaged digest are deliberately different:
`da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d` (the
installed 0.10.2 artifact) versus `41e6dfd8577ad449a93346e695d178885c7de44e1e33acd24ba8bc9d20fe4d49`
(re-signed inside Mona). Both are recorded; the packaged bytes are the identity
of this payload. The app's overall Mach-O floor is 14.0 (17 app Mach-O files and
1 service file, all arm64); Electron's own components are 13.0, the engine 11.0,
and the native helpers 14.0.

## Verification performed

- **Host gate / doctor:** `npm run mac:doctor` → all checks true, 0 identities;
  the missing Developer ID is reported as P22's prerequisite, not a local
  blocker.
- **Build:** `npm run mac:package:local` → all seven gates true: architecture,
  dependencies, secrets, package expansion, installer rehearsal, package smoke,
  and GUI launch.
- **Architecture:** every Mach-O in the app and service is arm64; no x86_64-only
  component, no `.node`, no Rosetta.
- **Dependency scan:** `otool -L` on the app, engine, both helpers, and the
  Service; no `/Users`, `/opt/homebrew`, or `/Library/Developer` dependency.
- **Hygiene:** 401 text files scanned for the actual build host, checkout path,
  credential-shaped values, and forbidden developer state; 0 hits. No source
  maps, TypeScript source, `.env`, `.mona`, sessions, keys, or test home.
- **Licenses:** Electron MIT + `LICENSES.chromium.html`, Codewhale MIT (vendored
  pinned text), React/React DOM/zod MIT; each notice digest is in the component
  manifest.
- **Package expansion:** `pkgutil --expand-full` reproduced 644 files and 14
  symlinks with 0 content mismatches, 0 extras, and 0 link mismatches.
- **Installer scripts:** rehearsed against a temporary root twice. The previous
  app/service are replaced; the receipt is written; an unrelated app and config
  file survive. The package plist marks both bundles non-relocatable.
- **Package smoke:** run from `/Applications/Mona.app` with a temporary
  `HOME`/`CFFIXED_USER_HOME`/`--user-data-dir`: 11/11 component digests match,
  bundled engine reports `0.10.2 (ff466b2ed0bf)`, supervisor and PTY helper run,
  the capability inventory loads, the state directory is created under the
  temporary home, `runtime_started=false`, `inference_calls=0`. The installed
  smoke additionally reports the Finder Service installed at
  `/Library/Services/Mona.service`.
- **GUI launch:** `open -na /Applications/Mona.app` with a fresh home reached a
  main process and a `Mona Helper (Renderer)` child, initialized
  `Library/Application Support/Mona/state` there, and quit with no leftover
  helpers. (A screen capture is unavailable because this session has no Screen
  Recording permission; process and state evidence is recorded instead.)
- **Real install:** `osascript … with administrator privileges` ran
  `/usr/sbin/installer -pkg … -target /`; `pkgutil --pkg-info` reports
  `com.mona.workbench.pkg` version 0.1.0, both installed bundles verify with
  `codesign --verify --deep --strict`, the receipt exists with the matching
  manifest digest, and LaunchServices lists the Service.
- **Finder Service:** the packaged `Mona.service` was installed per-user and
  passed **21/21** checks: macOS discovery and launch, exact folder delivery,
  awkward/Unicode/newline names, folder-only eligibility, refusal of files and
  empty selections, multi-selection choice, and no engine process or orphan.
- **External engine:** `codewhale config doctor` still reports
  “credentials and endpoints clean” after packaging; no route, config, or
  credential was touched.
- **CI:** `npm run ci` — **20/20** steps, **666 tests in 69 files**, typecheck,
  lint, format, renderer secret scan all green.
- **Release gate:** `npm run mac:package:release` exits 1 with
  “release mode requires Developer ID Application and Developer ID Installer
  identities”; no unsigned package is emitted under a release name.

## Two adjacent defects found and fixed

- **A duplicate registered copy could intercept a Finder handoff.** The Service
  located the app only through LaunchServices; with a staged or development copy
  registered, the packaged Service delivered to that copy. It now prefers
  `/Applications/Mona.app` after checking identifier, executable, and signature,
  then falls back to LaunchServices. Proven by the Service smoke after
  unregistering the competing copies.
- **`/usr/bin/git` could trigger Apple's developer-tools installer.** On a clean
  Mac the path is a stub. Packaged Mona now refuses to execute it without a real
  toolchain and reports Git unavailable with an explanation instead of prompting
  the recipient. Development behavior is unchanged.

## Limits and open issues (not hidden)

- **Signed release is P22.** The local package is ad-hoc signed and explicitly
  labeled local; it is not a shareable release. No Developer ID identity is
  present (measured again at P21).
- **Git on a clean recipient.** Git features need Apple's Command Line Tools or
  a separately installed Git. Mona no longer triggers the CLT installer, but the
  P26 “no developer tools” matrix must decide whether to bundle a GPL Git (with
  source-distribution obligations) or accept and document this dependency.
  Tracked as an open MAC-004/P26 item.
- **The 14.0 minimum has not been run on a 14.x host.** The floor is measured
  from the native helpers and declared in the installer; P26 owns the version
  matrix.
- **Screen capture was unavailable** in this session (no Screen Recording
  permission). The GUI evidence is process, state, and LaunchServices based.
- **Archive container bytes** are not promised to be identical between builds;
  the payload content digest is stable and the exact package digest is frozen in
  the receipt. Native Swift rebuilds can change a Mach-O UUID.

## Evidence paths

- `docs/evidence/macos/artifacts/p21-package-manifest.json` — full build
  manifest, components, hashes, scans, checks, install receipt.
- `docs/evidence/macos/artifacts/p21-package-receipt.json` — package receipt.
- `docs/evidence/macos/artifacts/p21-package-smoke.json`,
  `p21-installed-package-smoke.json` — staged and installed acceptance samples.
- `docs/evidence/macos/artifacts/p21-system-install.json` — real `installer`
  receipt, signatures, service registration, external-config check.
- `docs/evidence/macos/artifacts/p21-service-smoke.json` — 21/21 packaged
  Finder Service proof.
- `docs/evidence/macos/artifacts/p21-doctor.json`,
  `p21-release-gate.txt`, `p21-ci.txt`, `p21-package-sha256.txt`.
- `docs/decisions/ADR-015-packaging-and-payload.md`.
