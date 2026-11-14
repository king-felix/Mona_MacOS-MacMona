# R14 — Shareable Mac release prerequisites and pipeline

**Prompt:** R14 · **Status:** blocked on EXT-SIGNING (no Developer ID identities,
no notary credential) — the pipeline, its refusals, and every independent check
it can run without credentials are measured below
**Platform:** darwin-arm64 · **Host:** macOS 26.5.1 (25F80), arm64, not translated
**Source:** `3d1cf29`, clean tree (0 dirty files)
**Artifact:** none. `packaging/macos/out/` holds only the ad-hoc local package;
no `.pkg` with a release name, no receipt, nothing notarized, nothing published.

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

## 3. The exact owner prerequisite

Two Developer ID identities from the same team in the login keychain, plus one
notary credential. Nothing is pasted into chat or committed.

1. Developer ID **Application** — signs the app, both native helpers, the engine
   copy and the nested bundles.
2. Developer ID **Installer** — signs the flat package.
3. `xcrun notarytool store-credentials mona-release` (Apple ID, app-specific
   password, team id), or `MONA_NOTARY_API_KEY` / `MONA_NOTARY_KEY_ID` /
   `MONA_NOTARY_ISSUER` in the release shell.

Then, in order:

```sh
npm run mac:release:preflight                      # exits 0 with the facts
npm run mac:release -- --keychain-profile mona-release
npm run mac:verify-release                         # re-checks package against receipt
```

No purchase, enrollment, agreement acceptance, hosting or publication happens
under this prompt, and none is required to finish the scripts — they are
finished.

## 4. Release scope reconciled with the original specification

Two original-scope claims are **not** established by this candidate, and the
release cannot honestly claim them until the owner decides:

- **Minimum tested OS.** The payload and installer declare and enforce macOS
  **14.0**; the only host that has executed it is **26.5.1**. The assertion
  "14.0+" is a declared floor, not a tested one. R14 keeps it declared and names
  the gap; P26 owns the 14.x matrix (OPEN-OSFLOOR). A release that named 14.0 as
  tested would be inventing a fact.
- **No mandatory developer tools.** The spec asks that a runtime-critical Git
  dependency be bundled (with GPL source obligations honoured) and that no core
  feature trigger Apple's Command Line Tools installer. Core features satisfy
  this — packaged Mona refuses the `/usr/bin/git` CLT stub rather than execute
  it — but **Git features therefore require CLT or another Git**, so the
  candidate does not yet meet "no developer tools" for MONA-015. The owner
  decision recorded in `BLOCKERS.md` (bundle a relocatable Git with its source
  offer, or document the dependency and narrow the release claim) belongs to
  P26/P27; R14 records it rather than choosing it (D-029).

Neither gap is worked around. No bypass-Gatekeeper recipe (`xattr` removal,
`spctl --master-disable`, right-click-open instructions) is presented anywhere
as recipient readiness.

## 5. What is independently finished

- Preflight fact-gathering: host, tools and their paths, identities and team
  consistency, notary method, source cleanliness, build manifest, evidence
  review, and the last-verified-commit comparison (it reports
  `matches_verified: false` for `3d1cf29` vs `f7b744a` as a fact, not a pass).
- The fail-closed order: preflight → signed build → notarize → staple →
  assess → receipt, with each stage able to stop without producing a
  mislabelled artifact.
- The local build path (`--mode local`, ad-hoc) is exercised continuously by
  packaging (R13 §5), which is what proves the payload half of the pipeline.
- The trust model P23 consumes: Ed25519 manifest envelope, HTTPS-only source,
  signature and digest checks, installer-mediated update.

## 6. What is not proven

1. A signed, notarized, stapled package from real credentials.
2. `spctl` acceptance on a clean recipient (needs the signed artifact and a
   quarantined download).
3. Any 14.x host, and Git on a recipient without CLT (P24/P26).
4. Notarization log behaviour on a real submission — the log fetch is
   implemented and redacted, but no submission has occurred.

## 7. Evidence

| Artifact | What it is |
|---|---|
| `artifacts/r14-preflight.json` | The preflight report: three named problems, all tools present, clean source, evidence review green. |
| `artifacts/r14-release-refusal.txt` | `release` refusing at preflight, exit 3, no artifact. |
| `artifacts/r14-verify-refusal.txt` | `verify` refusing an absent release, exit 2, "not a verifiable release". |
| `artifacts/r14-release-tests.txt` | `test/release-trust.test.ts`, 17/17. |
