# F04 — durable handoff and the final human pass

Written 2026-11-15 on the owner's Mac after F00–F03. This record supersedes the
kit's prepared-state notes (`REVIEW.md` in this directory stays as the Linux build
host's record and is historical).

## Identifiers

- **Source:** branch `studio-flight-deck`, commits `9c60e3b` (F00 integration),
  `3af9b4b` (F01/F02 qualification and the layout fixes it forced), and the F03/F04
  commits after it. Base `c334cbb` on `main`.
- **Host:** macOS 26.5.1 (25F80), arm64, Electron 45.3.0, Node v26.13.0.
- **Package:** build **176**, channel `local`, version 0.1.0,
  `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg`,
  sha256 starts `d79da531ab3889e5…`.
- **Payload bundle:** `com.mona.workbench` 0.1.0 / 176 / `local`, macOS 14.0+,
  ad-hoc signed, `codesign --verify --deep --strict` clean.
- **Installed:** `/Applications/Mona.app` is still **build 170**, the prior
  release. It was not replaced — see "Not done" below.
- **Engine:** pinned 0.10.2 `ff466b2ed0bf`, sha256 `da0229610647f1cc2…`, verified
  against the installed bytes by the packaging script. Unchanged.
- **Provider route:** unchanged. Nothing in this work touches the profile, model,
  route, reasoning level, permissions or data stores.

## What changed

The Studio flight deck (see the changelog entry and `F01`/`F02` for the full list):
one compact dashboard, one truthful activity signal, Submit/Pause/Interrupt above
a bounded prompt with secondary actions behind **More**, no inspector, internally
scrolling console, five-second routine receipts, and a definite viewport height
chain that survives 100–200 % zoom and short windows.

Eight real layout defects were found by native measurement and fixed rather than
asserted around, including a 293 px rail row at 150 % zoom, a stage that never
filled its column, a screen collapsed to 46 px at 200 %, and Escape leaving Focus
with a panel open. `F02-native-layout.md` lists each one with the measurement that
exposed it.

## Independent review, and what it caught

The change was reviewed adversarially before being declared done. Four defects it
found were real and are fixed, each with a check that would have caught it:

1. **The harness wrote the owner's clipboard into evidence artifacts.** The
   receipt test read the pasteboard and stored the text as `clipboard_restored`;
   that text was already committed in three artifacts. The harness now records
   only that it restored the pasteboard, its previous length, and whether the
   bytes came back identical — and the stored artifacts were purged.
2. **Escape was taken from modal dialogs.** The capture listener that closes
   panels ran before the dialog primitive's own handler, so with a panel open the
   palette or a confirmation dialog could not be dismissed. It now yields to any
   `[role="dialog"]`, and the "panel is open" flag counts only panels that render.
3. **The resize handle reported a value below its own `aria-valuemin`** at 150 %
   and 200 % zoom (56 and 42 against 72). The minimum is now read from the field,
   and every arrangement asserts `min ≤ now ≤ max`.
4. **The narrow-window check was vacuous**: the window's `minWidth` is 860 px, so
   `setSize(760, 700)` measured 860 and the rail-hidden layout was never tested.
   The harness now lowers the minimum for that measurement, asserts the viewport
   really was ≤ 800 px, and the 760 px screenshot is genuinely 760 px.

The review's other reports did not hold up: the toolbar's one-row layout was
re-measured at every arrangement including 430 px wide and never overflows, and
`agent-signal.ts`'s event-shape handling was checked against every shape this
repository writes and is correct.

## Checks that passed (all on these bytes)

- `npm run ci` — **26/26 steps**, exit 0, with the deck smoke now part of it (`mac-ci.txt`).
- `npm run test` — **1,189 passed in 108 files**, no exclusions (`mac-ci.txt`).
- `typecheck`, `lint` (0 errors, 3 pre-existing warnings), `format:check`, `build`.
- `npm run smoke:deck` — **268/268 checks**, six window/zoom arrangements, a real restart
  (`f02-report.json`).
- `node scripts/deck-smoke.mjs --app …/Mona.app` — **268/268 checks against the
  packaged binary** (`f03-packaged-deck-report.json`).
- `npm run smoke:r11` — `passed_with_exception`; the only failing check is the
  idle-memory target, reported alongside this host's blank-Electron floor of
  362 MiB against a 350 MiB target. Idle CPU 0.04 %.
- `npm run smoke:commands` — 33/33. `smoke:history` — 24/24.
- `monabuild secrets` — 0 findings over 812 tracked files.
- `monabuild validate` — **clean**: 0 errors, 0 warnings, revision 1534, index
  rebuilt. The 32 stale source/evidence hashes left by the deck were refreshed one
  by one, each with a note recording what actually re-ran on these bytes; no hash
  was touched before its owning check passed.

## Not done — Needs the Human, with the exact step

**Installing build 176 into `/Applications`.** This session has no terminal
(`process.stdin.isTTY` is false, `tty` reports "not a tty") and no credential
(`sudo -n` → "a password is required"), and the earlier INSTALL-AUTH record shows a
prompted SecurityAgent sheet does not render here. Nothing was bypassed or faked;
`monabuild attempt` records this as `F03-INSTALL-AUTH`.

In your own Terminal:

```sh
cd ~/DS_Projects/Mona
npm run mac:install
```

That builds, packages, installs with `sudo` (your password is all it asks for) and
re-runs the install-side gates against the installed copy. To close the installed
evidence afterwards:

```sh
node scripts/deck-smoke.mjs --app /Applications/Mona.app
node scripts/r11-smoke.mjs   --app /Applications/Mona.app
```

Then F03's last two items are checkable in one pass: `/Applications/Mona.app`
reports build 176 and matches the package payload by digest, and a LaunchServices
launch and quit of the installed copy. Everything else F03 asks for is already
proven against these exact bytes by the two-phase harness — a genuine relaunch
restored the Focus preference and the draft on the same state directory, native
full screen was entered and left through the deck's own control, a draft survived
a resize and a zoom change, and no runtime was started by any of it.

## What this pass added after the handoff

The first handoff left F03's launch/restart/lifecycle items as "checkable later".
They did not need `/Applications`, so they are now proven against the packaged
bytes instead of deferred:

- **A real restart.** The harness launches twice on one state directory: the first
  run leaves a draft and the Focus preference, the second proves both came back
  and that no runtime started. Its checks appear as `relaunch:*` in the same
  report.
- **Native full screen** entered and left by clicking the deck's own control, so
  the sender-scoped IPC, the controller and AppKit are all in the loop; the draft
  is intact afterwards and the console is still the stage's remainder.
- **A draft surviving a layout change**: unchanged through a window resize and a
  zoom change, and read back from the store rather than the screen.
- **A layout gate in CI.** `smoke:deck` is now one of the CI steps (26 total), so
  the deck's geometry cannot regress without failing `npm run ci`.

Running this on a machine where the owner works in other apps also exposed six
defects in the harness itself — an rAF-based settle that hung forever on an
occluded window, an unbounded renderer call, a viewport that kept the previous
zoom, a verify launch that re-seeded its own project, an aborting screenshot, and
a receipt timer measured in wall-clock time instead of the visible time FD-10
specifies. Each was fixed at the cause and is recorded in `F02-native-layout.md`.

## Remaining human checks (none blocking a queue item)

1. **VoiceOver spoken walkthrough** of Studio and Focus — the axe pass and the
   live-region design are in place, but a spoken read is a human judgement.
2. **Aesthetic judgement** of the installed build at 100–200 % zoom, both themes.
   Contrast is measured (15.91 / 13.86 / 13.86:1); taste is not.
3. **One real turn watched** to confirm the animated activity phases (reasoning,
   tool, writing, waiting, then the 45-second quiet state). These need a provider
   turn; the idle and offline appearance is already qualified natively as
   un-animated with an exact `data-connection`.
4. **One physical Enter keypress.** Electron's synthetic key event proves the key
   arrives and is not consumed (`prevented: false`) but cannot show the browser's
   newline default; `test/studio-screen.test.tsx` covers the handler side.

## Rollback

Installing 176 replaces only the app bundle and the Finder Service. Build 170 is
reproducible from git history with `npm run mac:package:local`, so nothing must be
preserved by hand. Project folders, `.mona/` state, `~/.codewhale` and credentials
are untouched, and the uninstall rehearsal proves unrelated content survives.

## Next eligible prompt

**None.** F00–F02 and F04 are complete; F03's packaging and packaged-binary
verification are complete and its install step is Needs the Human. The queue's
state is `.mona/build-macos/flight-deck.json`; the resume pointer is
`.mona/build-macos/HANDOFF.md`. Nothing has been pushed to a remote.
