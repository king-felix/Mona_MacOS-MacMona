# Blockers — Studio review (studio-v2)

**Status: no blocked review problem.** `attempts.jsonl` is empty; no review
task has consumed an attempt. R00's four behavioral fixes were reproduced,
fixed and regression-tested inside one task, so no problem became open.

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
  from jsdom.** R05/R11 must either observe them on this Mac or record them as
  pending human checks.
