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
