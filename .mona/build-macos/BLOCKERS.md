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

## Closed problems

None yet.
