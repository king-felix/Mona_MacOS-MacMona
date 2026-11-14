# R14 — Shareable Mac release prerequisites and pipeline

**Prompt:** R14 · **Status:** **skipped by owner decision** (D-103) — there is no
Apple Developer account and none will be obtained, so no shareable release will
be produced for this project. The pipeline is implemented and tested; it fails
closed, and it was not weakened to yield a file named "release".
**Distribution that does exist:** a **local** ad-hoc-signed `.pkg` and a local
`.dmg` (`npm run mac:package:dmg`), both labelled local, both refused by
Gatekeeper on any other Mac. Anybody else builds from source.
**Platform:** darwin-arm64 · **Host:** macOS 26.5.1 (25F80), arm64, not translated

The prompt's own acceptance allows this outcome: *"Either an exact
signed/notarized/stapled candidate with provenance, or an explicit blocked
shareable-release status plus completed independent work."* The owner has closed
the question permanently, so the status is `skipped` rather than `blocked`.

## 1. What the pipeline is

`packaging/macos/release.mjs` is a working pipeline, not a branch that throws.
`preflight` gathers facts and refuses when the trust prerequisites are absent;
`release` runs preflight, builds the inside-out signed payload, submits to
`notarytool`, staples, assesses and writes an immutable receipt; `verify`
re-checks a package against that receipt. The release build mode signs with
Hardened Runtime, secure timestamps and per-component entitlements, never with
`--deep`; the flat package is signed with `productsign`; both are covered by
`test/release-trust.test.ts` (17 tests, passing — `artifacts/r14-release-tests.txt`).

## 2. Every refusal, measured

- **`npm run mac:release:preflight` → exit 3** with exactly three problems
  (`artifacts/r14-preflight.json`):
  - no `Developer ID Application` identity is installed;
  - no `Developer ID Installer` identity is installed;
  - no notarization credential is configured.
  Tools are all present (`codesign`, `pkgbuild`, `productbuild`, `productsign`,
  `notarytool`, `stapler`, `pkgutil`, `spctl`, `security`, `plutil`); the host is
  native arm64 on 26.5.1; the tree is clean; the evidence review passes.
- **`npm run mac:release` → exit 3**, `stage: preflight`, and the message
  "Release refused at preflight. No unsigned package was produced."
  (`artifacts/r14-release-refusal.txt`). The only `.pkg` in `out/` is the
  explicitly local, ad-hoc one.
- **`npm run mac:verify-release` → exit 2**, because a release package and a
  release receipt are both absent, with the note "This artifact is not a
  verifiable release." It does **not** fall back to the local package
  (`artifacts/r14-verify-refusal.txt`).

That is the safeguard working: no code path produces a file named "release"
without credentials, and verification cannot be satisfied by the ad-hoc build.

## 3. What would have been required (recorded, not pursued)

Two Developer ID identities from the same team in the login keychain, plus one
notary credential. Nothing is pasted into chat or committed.

1. Developer ID **Application** — signs the app, both native helpers, the engine
   copy and the nested bundles.
2. Developer ID **Installer** — signs the flat package.
3. `xcrun notarytool store-credentials mona-release` (Apple ID, app-specific
   password, team id), or `MONA_NOTARY_API_KEY` / `MONA_NOTARY_KEY_ID` /
   `MONA_NOTARY_ISSUER` in the release shell.

These steps are **not** being taken. They are kept here because the pipeline is
still the mechanism that keeps the claim honest: if credentials ever exist, these
three commands produce a real artifact, and until then the pipeline refuses.

```sh
npm run mac:release:preflight                      # exits 3 today, naming all three gaps
npm run mac:release -- --keychain-profile mona-release
npm run mac:verify-release
```

## 4. Release scope, as decided (D-104, D-105)

Two original-scope claims are now **decided by the owner**, and the documentation
states the narrower claim instead of the original one:

- **Minimum tested OS — decided.** The claim is "requires macOS 14.0 or later;
  tested on macOS 26.5.1". The floor is declared in the payload, the
  `Distribution` and the preinstall script and enforced by the installer; no 14.x
  host has executed it, and the owner accepts that. Asserting "tested on 14.0"
  would be a fabricated fact, so the documentation does not (D-104).
- **No mandatory developer tools — decided.** Git is not bundled. Core features
  need no developer tools, and packaged Mona refuses Apple's `/usr/bin/git` CLT
  stub rather than executing it, so nothing triggers the developer-tools
  installer. Git *features* require CLT or another Git and report themselves
  unavailable with that reason. The owner accepted this documented dependency
  over a bundled Git with its GPL source-offer obligation (D-105); MAC-004 stays
  `partial` and says which half is which.

Neither decision is a euphemism. No bypass-Gatekeeper recipe (`xattr` removal,
`spctl --master-disable`, right-click-open instructions) is presented anywhere as
recipient readiness — including in the DMG's own README, which says in plain text
that macOS will refuse the app on any other Mac.

## 5. What is independent and finished

- Preflight fact-gathering: host, tools and their paths, identities and team
  consistency, notary method, source cleanliness, build manifest, evidence
  review, and the last-verified-commit comparison (it reports
  `matches_verified: false` for `3d1cf29` vs `f7b744a` as a fact, not a pass).
- The fail-closed order: preflight → signed build → notarize → staple →
  assess → receipt, with each stage able to stop without producing a
  mislabelled artifact.
- The local build path (`--mode local`, ad-hoc) is exercised continuously by
  packaging (R13 §5), which is what proves the payload half of the pipeline.
- **A local disk image** (`npm run mac:package:dmg`) built from the same staged
  app, verified from its own bytes after writing: mounted read-only, the app
  inside hashed against the app that went in, the seal re-verified, the manifest
  build compared, and `gatekeeper_would_accept` recorded honestly as `false`.
- The trust model P23 consumes: Ed25519 manifest envelope, HTTPS-only source,
  signature and digest checks, installer-mediated update.

## 6. What is not proven

Not pursued, by decision:

1. A signed, notarized, stapled package (no Developer ID account — D-103).
2. `spctl` acceptance on another Mac (impossible for an ad-hoc build, and not
   needed: distribution is build-it-yourself).
3. A 14.x host (D-104) and Git on a machine without CLT (D-105) — both accepted
   as documented limits.
4. Notarization log handling on a real submission — implemented and redacted, but
   no submission will occur.

## 7. Evidence

| Artifact | What it is |
|---|---|
| `artifacts/r14-preflight.json` | The preflight report: three named problems, all tools present, clean source, evidence review green. |
| `artifacts/r14-release-refusal.txt` | `release` refusing at preflight, exit 3, no artifact. |
| `artifacts/r14-verify-refusal.txt` | `verify` refusing an absent release, exit 2, "not a verifiable release". |
| `artifacts/r14-release-tests.txt` | `test/release-trust.test.ts`, 17/17. |
| `artifacts/r14-dmg.json` | The local image's receipt: digest, app content digest, every check including `gatekeeper_would_accept: false`. |
