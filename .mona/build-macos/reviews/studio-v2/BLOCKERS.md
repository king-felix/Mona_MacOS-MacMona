# Blockers — Studio review (studio-v2)

**Status: one blocked review task, not a failed attempt.** `attempts.jsonl` is
empty; no review task has consumed an attempt. R11 measured every budget it
could and recorded the one it could not meet (idle memory) as a derived, named
exception rather than a blocker — the runtime's own floor is 356 MiB against a
350 MiB target, so no application code can satisfy it on this host. R00's four
behavioral fixes were reproduced, fixed and regression-tested inside one task, so
no problem became open. R13 is blocked on a privilege, not a hypothesis.

## R13 is blocked on installing the build it fixed (EXT-INSTALL)

What changed since the task opened: **build 151 is installed** at
`/Applications/Mona.app` and was qualified end to end — 16/16 verifier checks, a
137-check shell smoke through LaunchServices, 26/26 command, 60/60 immersive and
one live pinned-engine turn (22/22). The history mode it ran exposed a real
regression (115.5 px of drift per older page, introduced when R11 windowed the
console). That is fixed in source, `smoke:history` is now in `npm run ci`, and
candidate **build 152** passes all four modes from its own bytes
(137 + 26 + 60 + 19).

`installer` refuses without root, and the packaging gate correctly refuses to
call the old installed copy this build, so the fixed candidate cannot be
qualified in place.

**Exact help needed** — one command, with administrator authorization:

```sh
sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
```

Then R13 closes with `node scripts/r13-candidate-verify.mjs --smoke --launch`,
`node scripts/r13-installed-pass.mjs` (history must read 19/19), and
`npm run mac:package:local` (its install-side gates then run for build 152).
R14 depends on R13; its independent work is recorded with its own external
blocker (EXT-SIGNING). No attempt is counted: a privilege is missing.

Deliberately not done: replacing `/Applications/Mona.app` by copying the bundle
into place. `/Applications` is group-writable for an admin user on this host, so
it would work — and it would leave the package receipt describing a different
payload, which is the opposite of what this task proves.


## R14 is blocked on EXT-SIGNING (credentials, not code)

The release pipeline is finished and refuses to pretend otherwise:
`mac:release:preflight` exits 3 naming the three missing prerequisites,
`mac:release` exits 3 without producing a package, and `mac:verify-release`
exits 2 rather than accept the ad-hoc local build. `test/release-trust.test.ts`
is 17/17.

**Exact help needed** — two Developer ID identities (Application and Installer,
same team) in the login keychain, and one notary credential
(`xcrun notarytool store-credentials mona-release`, or the
`MONA_NOTARY_API_KEY` / `MONA_NOTARY_KEY_ID` / `MONA_NOTARY_ISSUER` triple).

Then: `npm run mac:release:preflight`, `npm run mac:release --
--keychain-profile mona-release`, `npm run mac:verify-release`.

Two scope claims stay open by decision, not by omission (RD-029): 14.0 is a
declared floor that only 26.5.1 has executed, and Git features still need CLT or
another Git. P26 owns both.

## External prerequisites carried from the product ledger

These are not blocked review work and are not attempt-counted. Their full
records live in `.mona/build-macos/BLOCKERS.md`; this file only names the review
tasks that consume them.

- **EXT-SIGNING** — 0 valid Developer ID identities measured 2026-11-11. Gates
  R14's signed/notarized/stapled tier (RV-12, MAC-005, MONA-027). R14 still owes
  scripts, preflight and a dry validation; only native public trust
  verification is blocked. **Help needed at R14:** Developer ID Application +
  Installer identities and a `notarytool` keychain profile, supplied by Victor
  through the Keychain — never pasted into chat.
- **OPEN-LOCAL-TRUST** — the installed local package is ad-hoc signed. Same
  dependency as EXT-SIGNING; R13/R15 must label the candidate as local.
- **OPEN-OSFLOOR** — the 14.0 minimum is declared but not executed on a 14.x
  host. R13 records it; the original P26 owns the tested matrix.
- **OPEN-GIT** — packaged Mona refuses the Command Line Tools Git stub. R13
  records the measured state; P26/P27 still own the bundle-or-document
  decision.
- **EXT-INSTALL / installed_copy** — `mac:package:local` stops at its
  `installed_copy` gate on any build newer than the installed one. R13 must
  install the candidate with the operator's authorization before the gate can
  pass; it is the gate working, not a missing prerequisite.

## Review-specific constraints (not blockers)

- **No live-turn evidence at R00.** R00 is source/fixture-level. Any later live
  probe uses the existing authorized Flash route and its cost controls; no
  automatic provider switch, no paid reviewer.
- **Native fullscreen, VoiceOver and physical display scaling cannot be proven
  from jsdom.** R05 observed native fullscreen (AppKit reported both transitions).
  **R11 observed 200 % interface scale and reduced motion** through a real window and
  Chromium's own media emulation, and **records VoiceOver, multiple monitors, a live
  IME and localization-sized labels as pending human checks** — axe over nine screens
  and programmatic focus assertions are not a spoken walkthrough. These stay open for
  R13 (installed candidate) and P24/P26, and they are not attempt-counted because no
  attempt failed: the limitation is the host, not a hypothesis that did not work.

- **R03 route claims are not execution.** R03 proves the catalog and the
  autocomplete; `support=runtime-api` names a documented operation R04 may call,
  not a qualified Mona action. A row that execution contradicts must be revised
  in R04, not defended.
