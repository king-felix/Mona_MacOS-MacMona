# Blockers and external prerequisites — Mona macOS build

Open problems that stop a requirement, with the three-attempt count preserved.
Attempt records live in `attempts.jsonl`; this file is the human-readable view
and the place that says exactly what help is needed.

Status: **no blocked problems, and no open external prerequisites** as of
2026-11-14. `attempts.jsonl` is empty: nothing reached three attempts, and no
problem was ever reset. The four external prerequisites this build carried
(signing, a recipient host, the OS floor, and Git on a clean Mac) were closed by
an owner decision recorded in `DECISIONS.md` — D-103 (distribution is local),
D-104 (14.0 declared, 26.x tested), D-105 (Git is a documented dependency).
Each closure says what is *not* proven; none of them raised a requirement.

## External prerequisites — all closed by owner decision (2026-11-14)

There is **no open blocker**. Four prerequisites were closed by decision rather
than by work, and one by the work itself. Nothing was closed by lowering a
requirement: each entry says what is not proven and where that is stated.

### ~~EXT-SIGNING~~ — CLOSED: there is no Apple Developer account (D-103)

- **What was needed:** a Developer ID Application and Installer identity from one
  team, plus a notary credential. Measured repeatedly: `security find-identity -v
  -p codesigning` → **0 valid identities**.
- **How it closed:** the owner decided there is no Apple Developer account and
  none will be obtained. Mona is not distributed; it is built and used on the
  machine that builds it, and anyone else builds from source.
- **What is still true:** `mac:release:preflight` exits 3 naming all three gaps,
  `mac:release` exits 3 without producing an artifact, `mac:verify-release` exits
  2 rather than accepting the ad-hoc build, and 17 release-trust tests pass. The
  pipeline stays implemented and fail-closed. It was not renamed, repurposed or
  weakened to yield a file called "release".
- **What replaces it:** `npm run mac:package:dmg` — a local, ad-hoc-signed disk
  image, verified from its own bytes, whose README says in plain text that macOS
  refuses it on any other Mac.

### ~~EXT-RECIPIENT-HOST~~ — CLOSED: no recipient matrix to run (D-103)

- **What was needed:** a second Apple silicon Mac or a clean VM to run the
  installer through quarantine.
- **Why it closed:** with no shareable artifact there is nothing to hand to a
  recipient. P24 delivered the repeatable harness anyway (`npm run
  mac:recipient`); it settled 9 rows on this host and names the 11 only a real
  recipient could settle, and it stays re-runnable for anyone who does hand a
  build to another machine.

### ~~OPEN-GIT~~ — CLOSED: documented dependency, not a bundled payload (D-105)

- **Measured:** `/usr/bin/git` on a machine without Command Line Tools is Apple's
  118,928-byte stub. Packaged Mona refuses that stub rather than executing it, so
  it never triggers the developer-tools installer.
- **Decision:** Git is not bundled. Core features (launch, edit, terminal, engine
  turns, acceptance sample) need no developer tools; Git **features** require CLT
  or another Git and report themselves unavailable with that reason.
- **Why:** bundling a relocatable Git carries a GPL source-offer obligation the
  owner declined. MAC-004 stays `partial` and the owner guide says which half is
  which.

### ~~OPEN-OSFLOOR~~ — CLOSED: declared at 14.0, tested on 26.5.1 (D-104)

- **Measured:** the payload, the `Distribution` and the preinstall script declare
  and enforce macOS 14.0; the only host that has executed it is 26.5.1.
- **Decision:** the claim is "requires macOS 14.0 or later; tested on macOS
  26.5.1". No 14.x host has run it and nothing claims otherwise.
- **Why this is honest:** asserting a tested 14.0 would be inventing a fact. A
  later 14.x run would upgrade the claim; nothing forbids adding one.

### ~~OPEN-LOCAL-TRUST~~ — CLOSED: the local package is *meant* to be ad-hoc (D-103)

- **Measured:** `security find-identity` → 0 identities; the app and package are
  ad-hoc; Gatekeeper rejects them on another Mac (`spctl`: "rejected, source=no
  usable signature").
- **Decision:** that is the intended tier, not a defect pending signature. It is
  labelled local in the bundle (`MonaBuildChannel`), in the package name, in the
  DMG volume name, in the DMG's README and in the owner guide.

### EXT-DISK — remains operational, not a blocker

- The volume needs roughly 2 GiB free for a package + DMG build; both write to
  `packaging/macos/out/` (gitignored). Last measured: 23 GiB free.

## Needs the Human

**Nothing blocks a prompt.** The two items this build carried are settled; what
remains needs a person at the machine and is listed here so it is not lost.

### Nothing open that stops work

- **One owner action, not a blocker:** authorize the install of build 166 with
  `npm run mac:install` in your own terminal (or `sudo installer -pkg
  packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /`). Two
  `osascript` authorization attempts from an agent session produced a
  `SecurityAgent` process with no window, so the sheet never rendered; the
  terminal path is the documented one (D-107) and needs no agent.
- **Three human QA items** (`docs/evidence/macos/P26-product-QA.md`): the spoken
  VoiceOver walkthrough, an aesthetic review of the installed-build captures, and
  one real two-folder workflow. Automated checks covering the same surfaces pass;
  these are the halves only a person can perform, and human signoff is not
  invented.
- **One open product decision, not a blocker:** the license. `LICENSE.md` records
  that the source is public at the owner's instruction while granting no rights;
  choosing terms stays the owner's call.
- **One hardware prerequisite, closed by decision:** a clean-recipient test
  (scenario 12, MAC-007) needs a signed artifact, which needs an Apple Developer
  account the owner decided not to obtain (D-103).

## Closed problems

### ~~CI-LIFECYCLE-LOCK~~ — CLOSED: quit the app; the step passed unchanged

- **Measured twice:** with `/Applications/Mona.app` running, `smoke:lifecycle`
  failed because the app holds Electron's single-instance lock, so the smoke's
  instance called `app.exit(0)` before writing `ready`/`crash.json`.
- **Fixed by the owner, not the code:** Mona was quit, and the step then passed
  **27/27** with no change to it. `npm run ci` is **25 of 25** green
  (`docs/evidence/macos/artifacts/p23-lifecycle-smoke.json`, `ok: true`).
- **What stays true:** the smoke still requires the app to be quit; its own
  failure message says so, and CI runs it last. No assertion was modified,
  reordered, or skipped to reach the green run.

### ~~ENGINE-REASONING-FACTS~~ — CLOSED: the workaround is accepted as permanent (D-111)

- **Measured:** the live catalog drops the reasoning metadata it holds, and no
  documented surface reports the effective reasoning value. Both were probed
  exhaustively on 0.10.2; the matrix is
  `docs/evidence/macos/artifacts/reasoning-engine-gap.json`.
- **How it closed:** the owner accepted the workaround as the permanent shape.
  Mona declares `auto` and sends it explicitly (D-110), so the request is visible
  and unambiguous; the effective value stays `unknown` because no surface reports
  it, and Mona never presents the request as proof that it was honoured.
- **What is still true:** the upstream change request
  (`docs/evidence/macos/engine-change-request-reasoning.md`) is retained as design
  documentation, not pending work. Mona already consumes the field it asks for, so
  a later engine needs no client change. Nothing was relabelled as an enhancement.

### ~~CI-LIFECYCLE-LOCK~~ — CLOSED: quit the app; the step passed unchanged

- **Measured twice:** with `/Applications/Mona.app` running, `smoke:lifecycle`
  failed because the app holds Electron's single-instance lock, so the smoke's
  instance called `app.exit(0)` before writing `ready`/`crash.json`.
- **Fixed by the owner, not the code:** Mona was quit, and the step then passed
  **27/27** with no change to it. `npm run ci` is **25 of 25** green.
