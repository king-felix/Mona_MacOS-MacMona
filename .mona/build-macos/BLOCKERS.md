# Blockers and external prerequisites — Mona macOS build

Open problems that stop a requirement, with the three-attempt count preserved.
Attempt records live in `attempts.jsonl`; this file is the human-readable view
and the place that says exactly what help is needed.

Status: **no blocked problems** as of the P17 checkpoint. P16/P17 added known
limits with verified routes, not blocked work.

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
