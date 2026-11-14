# Blockers — Studio review (studio-v2)

**Status: no blocked review problem.** `attempts.jsonl` is empty; no review
task has consumed an attempt. R11 measured every budget it could and recorded the
one it could not meet (idle memory) as a derived, named exception rather than a
blocker — the runtime's own floor is 356 MiB against a 350 MiB target, so no
application code can satisfy it on this host. R00's four behavioral fixes were reproduced,
fixed and regression-tested inside one task, so no problem became open.

## R13 is blocked on one admin-authorized install (EXT-INSTALL)

Build 147 is assembled and its payload is verified, but `/Applications/Mona.app`
still holds build 104. The packaging build stops at `installed_copy` by design,
and `sudo -n` refuses in this session, so the installed candidate cannot be
qualified without Victor.

**Exact help needed** — one command, with administrator authorization:

```sh
sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
```

Then R13 resumes with `node scripts/r13-candidate-verify.mjs --smoke --launch`
against `/Applications/Mona.app`, the interactive pass its acceptance names, and
`npm run mac:package:local` (whose install gates then run for the new build).
R14 depends on R13 and stays pending until then. Nothing about this is
attempt-counted: no hypothesis failed, a privilege is missing.

Measured while blocked: a `ditto` copy at `/Applications/Mona-r13-candidate.app`
passed the app's own acceptance sample and launched through LaunchServices, but
will not quit — the product refuses a packaged copy outside `/Applications`
while the installed copy exists (`-[NSAlert runModal]` observed in a stack
sample). That is the rule working, and the reason the interactive checks need
the install.

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
