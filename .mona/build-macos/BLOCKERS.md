# Blockers and external prerequisites — Mona macOS build

Open problems that stop a requirement, with the three-attempt count preserved.
Attempt records live in `attempts.jsonl`; this file is the human-readable view
and the place that says exactly what help is needed.

Status: **no blocked problems** as of the P21 checkpoint. P20's six defects were
all reproduced, root-caused, fixed, and regression-tested inside one prompt, so
none became an open problem and no attempt count was consumed. P21 produced a
real installed local package and added one open release-scope decision (Git on a
clean recipient, below); it is not attempt-counted because no attempt failed.

## External prerequisites (not blocked work, not attempt-counted)

### ~~EXT-INSTALL~~ — RESOLVED 2026-11-12: the package was installed

- **What was needed:** administrator authorization to install the P23 package.
- **How it was closed:** the package was opened in Apple Installer by a human with
  authorization. The install replaced build 81 with **build 89** at
  `2026-11-12T21:08:18Z`.
- **Verified afterwards:** the receipt's `manifest_sha256`
  (`3a3af793…`) equals the digest of the installed
  `Contents/Resources/component-manifest.json`, and equals the digest of the same
  file inside the package; the app signature verifies; the P23 update modules and
  the removal utility are present under the installed paths. Record:
  `packaging/macos/out/verification.json`.
- **Not a blocker:** `mac:package:local` still stops at its `installed_copy` gate
  on any later build, because the gate compares the installed copy to the build
  in hand. That is the gate working, not a missing prerequisite.

### EXT-SIGNING — Developer ID credentials (P22 blocked here)

- **Measured 2026-11-14, again:** `security find-identity -v -p codesigning`
  returns **0 valid identities**. `npm run mac:release:preflight` therefore exits
  3 naming both identities and the missing notary credential; see
  `docs/evidence/macos/artifacts/p22-preflight.json`.
- **Implemented and waiting:** `mac:release:preflight`, `mac:release`,
  `mac:verify-release`, inside-out Developer ID signing with Hardened Runtime,
  timestamps and minimal per-component entitlements, `productsign` for the flat
  package, `notarytool submit --wait` + log retrieval, `stapler staple/validate`,
  `spctl` assessment, and the immutable release receipt. All of it fails closed.
- **Help needed (do not paste keys or certificates into chat):**
  1. a Developer ID **Application** identity and a Developer ID **Installer**
     identity from the same team, in the login Keychain;
  2. `xcrun notarytool store-credentials mona-release` (Apple ID, app-specific
     password, team id), or `MONA_NOTARY_API_KEY` / `MONA_NOTARY_KEY_ID` /
     `MONA_NOTARY_ISSUER` in the release shell.
- **Then:** `npm run mac:release:preflight`, `npm run mac:release --
  --keychain-profile mona-release`, `npm run mac:verify-release`.
- **Rule:** this blocks P22's notarized artifact and all of P24. It does not
  block P25 or any local work.

### EXT-SIGNING — Apple Developer ID credentials for P22

- **Needed for:** MAC-005 (Developer ID signatures, notarization, stapling),
  MONA-027, and the shareable-release tier.
- **Measured 2026-11-11:** `security find-identity -v -p codesigning` returns
  **0 valid identities**. `notarytool` and `stapler` are installed; Gatekeeper
  assessments are enabled; nothing was disabled.
- **Impact now:** none. Local development, native arm64 builds, ad-hoc signing,
  and unsigned local `.pkg` packaging remain possible.
- **Help needed from Victor at P22:** an Apple Developer Program membership with
  a **Developer ID Application** identity, a **Developer ID Installer** identity,
  and notarization credentials stored in the login Keychain (for example a
  `notarytool` keychain profile). Do not paste keys or certificates into chat.
- **Rule:** this must not block independent local work before P22.

### OPEN-GIT — Git features on a clean recipient without developer tools

- **Needed for:** MAC-004 “no mandatory consumer development tools”, MONA-027,
  and the P26 recipient matrix.
- **Measured 2026-11-12:** `/usr/bin/git` is a 118,928-byte universal (x86_64 +
  arm64e) **Command Line Tools stub**; no `/opt/homebrew/bin/git` exists on this
  host; this host has CLT installed, which is why Git features work here.
- **Current behavior:** packaged Mona detects that only the stub exists and
  refuses to execute it, so it never triggers Apple's developer-tools install.
  Git features report unavailable with the reason. Development builds are
  unchanged.
- **Decision needed from Victor at P26/P27:** either (a) bundle a relocatable
  Git with its GPL source-distribution obligation and notices, or (b) accept
  that Git features require CLT/another Git and state it in the release scope.
  P21 does not improvise a GPL payload.
- **Rule:** this does not block P22 signing or P25 coordination.

### OPEN-OSFLOOR — the 14.0 floor is declared, not yet executed

- **Needed for:** MAC-001/ MAC-004's explicit tested version matrix.
- **Measured:** native helpers target `arm64-apple-macos14.0`; Electron 45
  reports 13.0; the engine reports 11.0. The installer enforces 14.0.
- **Help needed:** P26 runs the recipient matrix on an actual 14.x host (or a
  supported VM). No local workaround is warranted.

### OPEN-LOCAL-TRUST — the installed package is ad-hoc

- **Needed for:** the shareable-release tier (MAC-005/MONA-027).
- **Measured:** `security find-identity` still returns 0 identities; the local
  package is unsigned and the app/service are ad-hoc. It installed and ran on
  this Mac, which is the intended local milestone, but it is not a
  Gatekeeper-acceptable shareable artifact.
- **Help needed:** the Developer ID/notary setup in EXT-SIGNING, then P22.

### EXT-SIGNING remains the P21/P22 gate

P21's **local** package mode does not need it: ad-hoc signing, a local `.pkg`,
and a development-labelled installer are all possible on this host. Release mode
is P22's, and needs the credentials described above. Do not block P21's local
work on the signing prerequisite.

### ~~EXT-DISK~~ — RESOLVED 2026-11-13: the install-side gates ran

- **How it was closed:** the volume had 10 GiB free; `npm run mac:package:local`
  then passed every gate — `architecture`, `dependencies`, `secrets`, `expand`,
  `rehearsal`, `uninstall_rehearsal`, `package_smoke`, and `gui_launch` — and
  printed `"ok": true` with `package-report.json` written for build 104. The
  earlier failure was disk space, exactly as recorded below.
- **Also closed:** the `installed_copy` comparison. Build 104 was installed over
  `/Applications/Mona.app` with administrator authorization
  (`installer -pkg … -target /`), and the re-run matched the installed copy to
  the build in hand. `defaults read` reports `CFBundleVersion` 104 and
  `codesign --verify --deep --strict` passes.
- **Still true:** a later build will stop at `installed_copy` until it is
  installed, because that gate compares the installed copy with the build in
  hand. That is the gate working, not a missing prerequisite.

### EXT-DISK (original measurement, kept for history)

- **What is needed:** free space on the boot volume to rehearse an install.
- **Measured 2026-11-13T00:30Z:** 327 MiB free of 228 GiB (98% used). The
  packaging run builds and metadata-verifies the installer, then fails at
  `rehearseInstall` because `/usr/bin/ditto` cannot copy the ~390 MiB payload
  into its temporary root: `No space left on device`.
- **What did run:** declared metadata, native architecture, dependency,
  secret, and payload-expansion gates; the app is ad-hoc signed and
  `codesign --verify --deep --strict` passes. The package at
  `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg` (build 102, sha256
  `79731342…`) contains both fixes.
- **What did not run:** install rehearsal, in-app package smoke, LaunchServices
  launch, and the `installed_copy` comparison. `package-report.json` is absent
  rather than stale, which is D-093 working.
- **Help needed:** free roughly 2 GB (the build consumes ~1 GB before the
  rehearsal), then `npm run mac:package:local` completes the record. Nothing is
  lowered or skipped to work around it.
- **Cleaned while investigating:** the stale `Mona-0.1.0-macOS-arm64-local.dmg`
  (P21 leftover, not referenced by any evidence entry) and the packaging run's
  `out/stage`, both regenerable.

### EXT-XCODE — full Xcode only if a later step requires it

- **Measured 2026-11-11:** only Command Line Tools are installed; `xcodebuild`
  requires Xcode.
- **Impact now:** none. CLT provides `swiftc`, `codesign`, `pkgbuild`,
  `productbuild`, and `stapler`.
- **Trigger:** if P02/P09 packaging or the Services helper genuinely requires an
  `.xcodeproj`/`xcodebuild` workflow, record it here and install Xcode under the
  existing authorization rather than substituting a different architecture.

## Closed problems

None yet.
