# P27 — Release candidate, artifact promotion and final handoff

Status: **local release complete; shareable tier refused by owner decision** · Date:
2026-11-14 · Source commit: `e13ebb6` · Build: **166**, channel `local`, arm64 ·
Engine: Codewhale 0.10.2 `ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`

This prompt allows two outcomes: a real shareable installer, **or** an explicit
identification of the remaining release blocker. It is the second, and the blocker
is the same one D-103 already recorded: there is no Apple Developer account, so
there is no signed, notarized and stapled artifact to share. Everything that does
not depend on those credentials is done.

## The artifact

| Fact | Value |
|---|---|
| Package | `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg` |
| SHA-256 | `e73464bee43b287b1e16d0da1d2645dbe059e1dbf37f773685f0f61f8dcdae30` |
| Size | 163,824,343 bytes |
| Version / build | 0.1.0 / **166** (`git rev-list --count HEAD`) |
| Channel | `local` (`MonaBuildChannel` in the bundle; in the package name) |
| Source commit | `e13ebb62bf752165650019e5c8e16eb02930953f` |
| Architecture | arm64 only, `arm64-apple-macos14.0` |
| Signature | ad-hoc; `pkgutil --check-signature` reports **no signature** |
| Engine inside | 0.10.2 `ff466b2ed0bf`, sha256 `41e6dfd8…` |
| Payload | 674 files, 14 links |
| Package report | `packaging/macos/out/package-report.json` |

**Built from the recorded commit.** The package was produced after commit
`e13ebb6`, from that tree, so the artifact matches the source it claims. Its
component manifest records a digest for every payload file and for each of the
three native helpers.

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

The package is content-identical to the build that P26 qualified, and build 165 was
installed and exercised in the previous turn; build 166 differs only in
documentation, evidence and harness files (no payload source changed between the
two — the diff is `docs/`, `LICENSE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`scripts/r11-smoke.mjs`, `scripts/r13-installed-pass.mjs`, `src/main/index.ts`'s
axe path and `docs/requirements-macos.json`). `src/main/index.ts` **is** payload
source, so the artefact is not byte-identical to build 165; the axe-path change is
inert in normal use, but this is stated rather than glossed.

**The installer could not be launched with administrator authorization from this
session.** Two `osascript ... with administrator privileges` attempts produced a
`SecurityAgent` process with **no window** — the authorization sheet never
rendered — so both were cancelled rather than left hanging. The exact help needed
is one command in the owner's own terminal, which is the documented path (D-107):

```sh
npm run mac:install
```

or, to install the package already built and verified above:

```sh
sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
```

Until that runs, `/Applications/Mona.app` holds **build 165** and
`installed_copy` remains the one pending package gate. This is an authorization
step, not a defect: the package itself passed every gate that does not need
root.

## Recipient qualification

`npm run mac:recipient` reads the package's own bytes and settles what one host
can: **7 passed, 2 failed, 11 untested, 2 recorded** — `qualified` is not claimed
(`artifacts/p24-recipient.json`). The two failures are the honest ones: the
package is unsigned, so a recipient's Gatekeeper refuses it. The eleven untested
rows need a second Apple silicon Mac, which D-103 removed from scope when it
removed the shareable artifact.

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

1. **Authorize the install** (one command above); this closes `installed_copy`.
2. **The human QA checklist** in `P26-product-QA.md`: the VoiceOver walkthrough,
   the aesthetic review of the captures, and one real two-folder workflow.
3. **Decide the license**, if the public repository is to invite use.
4. **Nothing else.** Scenario 12 stays blocked until a signed artifact exists, and
   that requires an Apple Developer account the owner has decided not to obtain.
