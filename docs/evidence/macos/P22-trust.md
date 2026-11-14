# P22 — Signing, notarization, and release automation

**Status:** implementation complete; **release qualification blocked on
EXT-SIGNING** (no Developer ID identity exists on this host).
**Requirements:** MAC-005 (partial), MONA-027 (partial contribution).
**Platform:** darwin-arm64, macOS 26.5.1 (25F80), Electron 45.3.0, pinned
`codewhale 0.10.2` (`ff466b2ed0bf`).

## The rule

`npm run mac:release` never emits unsigned output as production. Without both
Developer ID identities and a notary credential it stops at preflight, exits 3,
and names exactly what is missing. It does not build a lookalike, does not skip
notarization, and does not relabel an ad-hoc package.

The only pass verdict for notarization is `Accepted`. `In Progress` is reported
as a resumable job; anything else is a refusal. **A successful upload is not
notarization success** — that is enforced in `notaryVerdict()`, not in prose.

## What landed

### `npm run mac:release:preflight` and `mac:release` and `mac:verify-release`

`packaging/macos/release.mjs` (new) implements the three commands named in spec
§21:

- **preflight** — read-only. Reports the host (darwin, arm64, Rosetta, macOS
  version), every required tool and its version, both identities, the notary
  credential *presence*, the source commit and working-tree cleanliness, the
  payload manifest's architectures, and whether the evidence ledgers exist.
  Writes `packaging/macos/out/release-preflight.json` and exits 3 when any
  prerequisite is missing.
- **release** — runs preflight, then the signed build, then `notarytool submit
  --wait`, then `notarytool log`, then `stapler staple`, then local assessments
  (`pkgutil --check-signature`, `stapler validate`, `spctl -a -vvv -t install`),
  then writes `release-receipt.json` with the package's SHA-256 and byte size.
- **verify** — re-assesses the promoted bytes against that receipt: digest
  equality, an offline `stapler validate`, and a Gatekeeper assessment. It
  re-reads nothing from the build.

`mac:package:release` was **repointed at the same command**, so there is no
private path that produces a signed-but-unnotarized package under a release
name.

### Signing policy (`packaging/macos/lib/signing.mjs`, new)

Pure functions, no tool execution, so every decision is testable:

- identity parsing and selection, including the team-mismatch refusal;
- component classification by path (app, app-main, helper-app, framework,
  dylib, native-helper, engine), so no `file` command is trusted;
- **inside-out ordering**: deepest Mach-O first, a helper's executable before
  its bundle, and the outer app reserved for last;
- `codesignArgs()` emits `--options runtime --timestamp --entitlements` and
  **never emits `--deep`** — a deep signature is the shortcut this plan exists to
  replace;
- `productsignArgs()` for the flat package.

### Entitlements (`packaging/macos/resources/entitlements/`)

Three files, each justified in `README.md`:

- `main.plist` — the three Electron-documented entitlements (JIT, unsigned
  executable memory, dyld environment variables).
- `helper.plist` — those three plus `com.apple.security.inherit`.
- `service.plist` — empty, because the Finder Service launches the app and exits.

Frameworks, dylibs, `mona-supervisor`, `mona-pty`, and the bundled `codewhale`
engine get **no** entitlements. A test asserts the mapping per class, so a new
binary cannot silently inherit the app's exceptions.

### Build integration (`packaging/macos/build.mjs`)

Release mode now resolves the two identities, signs 25 nested components
inside-out with Hardened Runtime and timestamps, seals the app, signs the
Service, and signs the flat package with `productsign`. It still does **not**
notarize: that is `release.mjs`, which also staples and writes the receipt. A
Hardened Runtime flag that silently disappeared is caught by re-reading the
signature with `codesign -dv` and failing.

Local mode keeps its ad-hoc behaviour exactly (identity `-`, no Hardened
Runtime): `--options runtime` on an ad-hoc signature is not a valid release
shape and was deliberately not applied.

## Verification (what actually ran)

- **Preflight** on this host: exit **3** with four problems — no Developer ID
  Application identity, no Developer ID Installer identity, no notary
  credential, and a working tree that was dirty during development.
  `docs/evidence/macos/artifacts/p22-preflight.json` is the clean-tree run,
  which shows exactly the two release blockers.
- **Release** on this host: exit **3** at preflight, `stage: "preflight"`, and
  **no package was created or replaced**. Captured in
  `docs/evidence/macos/artifacts/p22-release-refusal.json`.
- **Local packaging still works** after the signing refactor: build 139,
  `signing 25 nested components inside-out`, `signed 17 Mach-O files and 8
  nested bundles`, ad-hoc signed and sealed, package built and its declared
  metadata verified. It then stopped at the documented `installed_copy` gate
  (the installed `/Applications/Mona.app` is an older build), which is the gate
  working, not a regression.
- **Tests:** `test/release-trust.test.ts` — 17 passing: identity parsing and
  selection, team mismatch, component classification, entitlement mapping,
  inside-out order, Hardened Runtime/timestamp arguments, no `--deep`,
  `productsign` arguments, notary verdicts (only Accepted passes), submission
  parsing, receipt shape, host redaction, and the real preflight command's
  structured refusal.

## Blocked: EXT-SIGNING

Exact setup needed from Victor (do not paste keys or certificates into chat):

1. An Apple Developer Program membership for the Mona team.
2. **Developer ID Application** and **Developer ID Installer** identities in the
   login Keychain, from the same team.
3. A notarization credential stored locally:
   `xcrun notarytool store-credentials mona-release` (Apple ID + app-specific
   password + team id), or an App Store Connect API key exported as
   `MONA_NOTARY_API_KEY` / `MONA_NOTARY_KEY_ID` / `MONA_NOTARY_ISSUER`.

Then: `npm run mac:release:preflight` → `npm run mac:release -- --keychain-profile mona-release`
→ `npm run mac:verify-release`.

## What is *not* verified

- **No notarization submission was made.** No credential exists, and inventing a
  feed or a fake submission was out of scope.
- **No stapling, Gatekeeper acceptance, or installed nested execution.** Those
  follow the first accepted submission.
- **Offline launch after stapling** is unverified for the same reason.
- **Notary log inspection** is implemented (`notarytool log`, redacted before
  writing) but has never produced a real log.
- `spctl` assessments are implemented and unit-shaped but only ever ran against
  the ad-hoc local package in this session; their output is not evidence of a
  trusted release.
