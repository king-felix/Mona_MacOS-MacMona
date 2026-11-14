# P24 — Clean-recipient install qualification

**Prompt:** P24 · **Status:** **skipped by owner decision** (D-103) — there is no
shareable artifact and there will be none, so there is no recipient matrix to
qualify. Mona is built and used on the machine that builds it; anyone else builds
it from source.

**What is kept:** `scripts/p24-recipient.mjs` (`npm run mac:recipient`) is the
repeatable harness this prompt produced. It is not dead code — it is how anyone
who *does* want to hand a build to another machine would find out whether it
works, and it is how the "build it yourself" answer stays checkable.
**What is not claimed:** no clean-recipient row was executed. The harness's own
verdict below says so, and its `qualification` field reads `blocked`.
**Platform:** darwin-arm64 · host macOS 26.5.1 · build 152 package
(`e4ffe0e0…`), unsigned.

The prompt's own text allows exactly this: *"If no clean test host or signing
identity exists, finish the repeatable test harness/checklist and keep recipient
qualification blocked."* The owner has since made the underlying question
moot — there is no distribution — so the prompt is `skipped`, not completed.

## 1. The verdict, as the harness computes it

```
settled 9 · passed 7 · failed 2 · untested 11 · recorded 2
qualification: blocked
```

The two failures are one root cause, and it is the expected one: the package has
no Developer ID Installer signature, so a quarantined copy is rejected by
Gatekeeper.

## 2. Rows the harness settled

| Row | Result | Measurement |
|---|---|---|
| `artifact.present` | pass | build 152, sha256 `e4ffe0e0…`, 163,802,705 bytes, `pkgutil --check-signature` → unsigned |
| `artifact.signed` | **fail** | an unsigned installer cannot pass a recipient's Gatekeeper; the just-works claim is not available for these bytes |
| `installer.requirements` | pass | the expanded `Distribution` declares an OS-version requirement, `min="14.0"`, and arm64 |
| `payload.architecture` | pass | every Mach-O in the payload is arm64; minimums are `{14.0, 11.0}` where 11.0 is the pinned upstream engine |
| `payload.minimum_os` | pass | every app-owned executable declares 14.0; the engine keeps its upstream floor and is not rewritten |
| `payload.uninstall_bounded` | pass | the shipped `uninstall-mona.sh` satisfies the contract: `#!/bin/sh`, `set -eu`, no wildcard or root deletion, refuses unrecognized paths, honours `MONA_UNINSTALL_ROOT` |
| `security.assessments_enabled` | pass | `spctl --status` → assessments enabled; nothing was disabled for this run |
| `security.quarantine_present` | pass | `com.apple.quarantine` set on a copy the way a download would arrive (`0081;00000000;Safari;`) |
| `security.gatekeeper_install` | **fail** | `spctl -a -vv -t install` → *rejected, source=no usable signature* |

`host.git` and `host.identity` are recorded, not scored: this host has Xcode
Command Line Tools, Homebrew and a cached engine, so it cannot stand in for a
clean recipient.

## 3. Rows only a real recipient can settle

Each is in the harness with its reason, and none is pretended:

1. `recipient.clean_host` — a separate Apple silicon Mac or a clean supported VM,
   running the exact signed installer through quarantine.
2. `recipient.auth_install` — the standard Installer authentication prompt.
3. `recipient.launch_after_install` — launch from Applications and the Finder
   Service opening a folder. (The LaunchServices launch path itself is proven for
   the local build in R13; the *recipient's* is not.)
4. `recipient.new_user_api_setup` — secure provider setup on a machine with no
   cached credential. A second local user is additional evidence; the prompt says
   it is not proof, and neither is this host.
5. `recipient.offline_first_run` — offline local operation before a provider
   exists.
6. `recipient.denied_folder_permission` — a denied or revoked folder permission
   (TCC needs interactive consent).
7. `recipient.locked_keychain` — a locked login keychain.
8. `recipient.sleep_wake` — physical suspend; simulated suspend is covered by the
   lifecycle smoke and is labelled as simulated.
9. `recipient.multiple_users` — two accounts on one Mac.
10. `recipient.unsupported_os` — a host below 14.0; declared and enforced in the
    preinstall script, not executed.
11. `recipient.clean_reinstall_upgrade_uninstall` — the mechanisms are proven
    under isolated roots (install rehearsal, 11 uninstall sub-checks, the P23
    lifecycle smoke 58 checks), the recipient run is not.

## 4. What is already proven, and where

The recipient matrix is not the only place these behaviours are checked. What
exists, and what it does and does not cover:

- **Install / upgrade / migration / uninstall mechanics** — `smoke:p23` in CI,
  58 checks: trust tiers, deferral, the update intent ledger, snapshot restore,
  rollback refusals.
- **Uninstall safety** — the 11 sub-checks in the packaging report: dry run
  changes nothing, a missing manifest and a foreign bundle are refused, user data
  is removed only for the named home, projects survive `--remove-user-data`.
- **The installed payload** — R13: 16/16 verifier checks, 137/137 shell smoke
  through LaunchServices, one real turn that edited a file and ran a test, one
  interrupt, graceful shutdown.
- **A committed task with no toolchain install** — the studio smoke's own
  acceptance sample writes a file and runs a test as the pinned engine's tool
  call; it passed on the installed build. It is not a *recipient* claim because
  this host has CLT and the test command runs there.
- **Git without developer tools** — packaged Mona refuses Apple's CLT stub rather
  than triggering the installer, so nothing forces a toolchain install. Git
  **features** then report unavailable on a machine with no Git. That is the
  honest state and it is why "no developer tools" cannot be claimed for Git
  (OPEN-GIT, RD-029).

## 5. The checklist a recipient run follows

Repeatable, in order, on a host that is not this one:

```sh
# on the release machine
npm run mac:release:preflight
npm run mac:release -- --keychain-profile mona-release
npm run mac:verify-release
# transfer the package and its receipt; the recipient downloads it (quarantine on)

# on the recipient — no terminal work is expected at any point
open Mona-0.1.0-macOS-arm64.pkg        # Installer authenticates once
# then: launch from Applications, open a folder from Finder's Service,
#       confirm offline state, configure a provider, run one small task,
#       deny then grant a folder, lock the keychain, sleep/wake, second user,
#       reinstall over the previous build, uninstall

# on the release machine, after the recipient run
npm run mac:recipient -- --pkg <the exact package the recipient installed>
```

A recipient run is **failed** if anyone needs a terminal command, Rosetta, an
`xattr` removal, a Gatekeeper override, or a developer account. The harness
refuses to report `qualified` until every row is settled, so it cannot be talked
into a pass.

## 6. Blockers, exactly

- **No Developer ID identity** — decided against (D-103). An ad-hoc build is
  rejected by Gatekeeper on another Mac, which is measured above rather than
  assumed, and that is now the accepted state rather than a gap to close.
- **No second host** — this project has neither a second Mac nor a VM. With
  distribution out of scope, a recipient matrix would test a delivery route that
  does not exist.

Neither is attempt-counted: no hypothesis failed and none was reset. The
three-attempt ledger stays empty.

## 7. Evidence

| Artifact | What it is |
|---|---|
| `docs/evidence/macos/artifacts/p24-recipient.json` | The harness report: every row with its status, the measurements behind the settled ones, and the reasons for the unsettled ones. |
| `scripts/p24-recipient.mjs` | The harness. Reads the package, not the staging tree; sets quarantine on a copy; never removes it. |
| `docs/owner-guide-macos.md` | The command-free end-user guide (no terminal step is presented as necessary). |
| `docs/evidence/macos/review-studio/R13-installed-candidate.md` | The installed-payload evidence this document leans on and does not re-claim. |

## 8. Platform matrix

| | macOS 26.x arm64 | macOS 15.x arm64 | macOS 14.x arm64 | arm64 requirement |
|---|---|---|---|---|
| Declared | yes | yes | yes (`min="14.0"`) | arm64 only |
| Executed here | 26.5.1 | no | no | — |
| Recipient run | pending | pending | pending | — |

The 14.0 floor has never been executed (OPEN-OSFLOOR, P26). Intel and Rosetta are
unsupported by construction: the installer and every app-owned binary are
arm64-only, and the harness verifies that from the package's own payload.
