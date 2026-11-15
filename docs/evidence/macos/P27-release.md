# P27 — Release candidate, artifact promotion and final handoff

Status: **local release complete and installed; shareable tier refused by owner
decision** · Date: 2026-11-14 · Source commit: `538b339` · Build: **168**, channel
`local`, arm64 · Engine: Codewhale 0.10.2 `ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`

This prompt allows two outcomes: a real shareable installer, **or** an explicit
identification of the remaining release blocker. It is the second, and the blocker
is the same one D-103 already recorded: there is no Apple Developer account, so
there is no signed, notarized and stapled artifact to share. Everything that does
not depend on those credentials is done.

## The artifact

| Fact | Value |
|---|---|
| Package | `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg` |
| SHA-256 | `ec4f207be0c842bb2155d79de28235a938d6aa09cf23990cfaaa319e3a49a341` |
| Size | 163,824,392 bytes |
| Version / build | 0.1.0 / **168** (`git rev-list --count HEAD`) |
| Channel | `local` (`MonaBuildChannel` in the bundle; in the package name) |
| Source commit | `538b339` (build number = commit count = 168) |
| Architecture | arm64 only, `arm64-apple-macos14.0` |
| Signature | ad-hoc; `pkgutil --check-signature` reports **no signature** |
| Engine inside | 0.10.2 `ff466b2ed0bf`, sha256 `41e6dfd8…` |
| Payload | 674 files, 14 links |
| Package report | `packaging/macos/out/package-report.json` |

**Rebuilt from HEAD by the authorized install, and it is that build.** This record
first described build 166 from commit `e13ebb6`. The owner then ran
`npm run mac:install`, which rebuilds before installing, and HEAD had advanced by
two **ledger-only** commits (`913391d`, `538b339`). The installed artifact is
therefore build **168** from `538b339`, and the earlier 166 package was superseded
by a rebuild of the same payload source.

That the payload is the same is checked, not assumed: the only files those two
commits touched are `.mona/build-macos/` and `docs/evidence/macos/`, which are
build outputs rather than inputs (R13's rule). The version, channel, engine digest
and gate results below are read from the build that actually ran.

### Package-level gates (all pass, no administrator authorization needed)

| Gate | Result |
|---|---|
| declared metadata | pass — package id, version 0.1.0, build 166, both bundles, arm64 only, macOS 14.0+ |
| architecture | pass — arm64 only from the bytes |
| dependencies | pass |
| secrets | pass — no credential-shaped material in the payload |
| payload expand | pass — 674 files, 14 links |
| install rehearsal | pass — idempotent reinstall in a rehearsal root |
| uninstall rehearsal | pass — 11 checks: dry run changes nothing, missing manifest refused, foreign bundle refused, user data removed for the named home, projects preserved, outside-root refused, removal exit 0, owned paths removed, unrelated content preserved |

Raw: `packaging/macos/out/package-report.json` (gitignored) and
`packaging/macos/out/verification.json`.

### Install-side gates

The owner ran `npm run mac:install` in their own terminal and then launched the
app. Verified from the installed bytes afterwards, not from the command's exit
status:

| Check | Result |
|---|---|
| Installed version / build | 0.1.0 / **168**, channel `local` (`Info.plist`: `CFBundleShortVersionString`, `MonaBuildVersion`, `MonaBuildChannel`) |
| Architecture | `arm64` only (`lipo -archs` on the installed executable) |
| Installed content digest | `fe7fdb11d089c6f70f9671d6c2f23715cfdc0a0f2de59e1ce5f230004a612731` — **identical** to the packaged payload's digest |
| Manifest chain | installed `component-manifest.json` = `e3e9ce9c…` = `install-receipt.json.manifest_sha256` — the receipt describes the bytes on disk |
| Package smoke against `/Applications` | pass (`package-smoke.json`, generated 7 s after the install): packaged from an app bundle, arm64 executable, bundled engine `codewhale 0.10.2 (ff466b2ed0bf)`, native supervisor and pty run, `runtime_started: false`, `inference_calls: 0` |
| LaunchServices GUI launch | pass — `open -na /Applications/Mona.app` from `/Applications`, one window rendered, alive at 12 s, graceful quit, **0** main process, **0** helpers, no supervisor left behind |
| Crash reports | none from this launch; the only `DiagnosticReports` entries are seven `mona-supervisor` files from 2026-11-12 |
| State store | migrated to schema **13**; the stored profile now carries `reasoningEffort: "auto"` with `declaredAt`/`declaredNote`, which is D-110 applied to the owner's real profile rather than a fixture |

`package-report.json` still lists these two gates as `pending`: that file is
written **before** the install by design (D-092's stale-report hazard fix), so a
post-install pass cannot appear in it. The evidence above is the post-install
record.

The installer itself did not need an agent: three `osascript` authorization
attempts from an agent session produced a `SecurityAgent` process with no window,
so the sheet never rendered. That limitation is recorded in `BLOCKERS.md` with the
terminal command that resolved it, and the attempts are in `attempts.jsonl`.

## Recipient qualification

`npm run mac:recipient` reads **these** bytes (`ec4f207b…`, build 168) and settles
what one host can: **7 passed, 2 failed, 11 untested, 2 recorded**;
`qualification: "blocked"` (`artifacts/p24-recipient.json`). The two failures are
the honest ones and they are the same fact twice: the package is ad-hoc signed, so
a recipient's Gatekeeper refuses it (`spctl`: "rejected, source=no usable
signature"). The eleven untested rows need a second Apple silicon Mac, which D-103
removed from scope when it removed the shareable artifact.

## Documentation set

Written for this prompt, each checked against the tree rather than from memory:

| Document | Covers |
|---|---|
| `docs/owner-guide-macos.md` | the command-free owner view: install, first launch, folder launch, Full Access meaning, resume, costs, stopping work, blockers, backups, restore limits, privacy, updates, uninstall |
| `docs/developer-guide-macos.md` | layout, reproducible builds, the exact `ci.mjs` order, engine pin and qualification, state migrations, failure fixtures, capability coverage, the ledger, and how to add a smoke |
| `CONTRIBUTING.md` | the gates, commit expectations, how to record a decision and a blocker, and the conventions the code actually enforces |
| `SECURITY.md` | the trust boundaries that exist, how to report privately (no contact exists yet — stated, not invented), out of scope, local-only distribution |
| `LICENSE.md` | proprietary, no grant; the source is public at the owner's instruction but **visibility is not permission**; the license decision stays open |
| `docs/changelog-macos.md` | what each build changed, with decision references |
| `docs/evidence/macos/P26-product-QA.md` | measured QA, the twelve scenarios, both matrices, the human checklist |

Install, first launch, credentials, folder launch, Full Access, prompt
assignment, resume, costs, stopping work, blockers, backups, restore limitations,
privacy, updates and uninstall are covered between the owner guide and the
developer guide; the owner guide is the one written for a person who will not read
the other.

## Requirement and capability matrices

**Requirements: 26 satisfied, 10 partial, 2 blocked, 0 pending** — reconciled row
by row in `docs/requirements-macos.json`, each partial row naming what is missing.
Five rows (`MONA-001`, `MONA-002`, `MONA-009`, `MONA-010`, `MONA-030`) were moved
to satisfied on evidence that already existed but had never been recorded; nothing
was moved without a citation. `MONA-028`, `MONA-006` and `MAC-002` are partial
because their human half is outstanding, not their automated half.

**Capabilities: 75 rows — 43 verified, 28 unqualified, 2 unavailable, 2 blocked.**
Computed by `tools/p18-coverage/reconcile.mjs`; 72 rows carry an entry point and 51
have a tested one. Full parity is not claimed.

## Release tiers, stated plainly

| Tier | Status |
|---|---|
| Local development usable | **yes** — the tree builds, tests and runs on this host |
| Packaged candidate | **yes** — build 166, every package gate green, content-verified against its payload |
| Shareable release qualified | **no** — blocked by D-103: no Developer ID identity, no notarization credential, no staple, and therefore no clean-recipient qualification |

## What still needs the owner

1. ~~Authorize the install~~ — **done**: build 168 is installed and verified from
   its own bytes.
2. **The human QA checklist** in `P26-product-QA.md`: the VoiceOver walkthrough,
   the aesthetic review of the captures, and one real two-folder workflow.
3. **Decide the license**, if the public repository is to invite use.
4. **Decide whether to push.** Three commits are local and unpublished
   (`origin/main` behind `HEAD`); publishing is the owner's call, not the agent's.
5. **Nothing else.** Scenario 12 stays blocked until a signed artifact exists, and
   that requires an Apple Developer account the owner has decided not to obtain.
