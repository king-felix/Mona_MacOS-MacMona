# F04 — durable handoff and the final human pass

Written 2026-11-15 on the owner's Mac after F00–F03. This record supersedes the
kit's prepared-state notes (`REVIEW.md` in this directory stays as the Linux build
host's record and is historical).

## Identifiers

- **Source:** branch `studio-flight-deck`, commits `9c60e3b` (F00 integration),
  `3af9b4b` (F01/F02 qualification and the layout fixes it forced), and the F03/F04
  commits after it. Base `c334cbb` on `main`.
- **Host:** macOS 26.5.1 (25F80), arm64, Electron 45.3.0, Node v26.13.0.
- **Package built from HEAD:** build **177**, channel `local`, version 0.1.0,
  `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg`,
  sha256 starts `88b487158d65328e…`. `MonaBuildVersion` 177 in the payload,
  `com.mona.workbench`, macOS 14.0+, arm64, ad-hoc signed,
  `codesign --verify --deep --strict` clean.
- **That package passes the two-phase deck run** — 268/268, including the relaunch
  — so build 177's own bytes are qualified, not just its source.
- **Installed:** `/Applications/Mona.app` is build **178** from this commit,
  verified from its own bytes against the 268-check two-phase deck suite. See
  "Installed and verified" below.
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
  packaged build-177 binary**, including the relaunch
  (`f03-packaged-deck-report.json`).
- `npm run smoke:r11` — `passed_with_exception`; the only failing check is the
  idle-memory target, reported alongside this host's blank-Electron floor of
  362 MiB against a 350 MiB target. Idle CPU 0.04 %.
- `npm run smoke:commands` — 33/33. `smoke:history` — 24/24.
- `monabuild secrets` — 0 findings over 812 tracked files.
- `monabuild validate` — **clean**: 0 errors, 0 warnings, revision 1534, index
  rebuilt. The 32 stale source/evidence hashes left by the deck were refreshed one
  by one, each with a note recording what actually re-ran on these bytes; no hash
  was touched before its owning check passed.

## Installed and verified

`/Applications/Mona.app` is build **178** — the current HEAD — with the installer's
receipt at `/Library/Application Support/Mona/install-receipt.json`
(`installed_at` 2026-11-16T02:33:39Z). It was verified against its own bytes:

- its **package smoke** passes in a scrubbed `HOME`: packaged, arm64, channel
  `local`, standard install location, **13 components hash-ok**,
  `runtime_started: false`, `inference_calls: 0`;
- the **268-check two-phase deck suite** passes against `/Applications/Mona.app`,
  including native full screen and a real relaunch that restored the Focus
  preference and the composer draft, with no runtime started;
- it **launches and quits through LaunchServices**, with the owner's own projects
  listed and the engine reported disconnected;
- its `Contents/Resources/app/dist` — main bundle, renderer bundle, preload,
  **131 files** — is byte-identical to a fresh build of HEAD. The only difference
  in the component manifest is the list of bundled evidence documents, by the
  three files created after the install.

The install itself required an administrator credential this session could not
supply, so it was recorded as `F03-INSTALL-AUTH` rather than worked around. The
owner installed it, and the blocker is resolved with this evidence.

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

Installing replaces only the app bundle and the Finder Service. Any earlier build
is reproducible from git history with `npm run mac:package:local`; the previous
install was build 176 (`d0c5ac2`). Project folders, `.mona/` state, `~/.codewhale`
and credentials are untouched, and the uninstall rehearsal proves unrelated
content survives.

## Next eligible prompt

**None.** F00–F04 are complete, including packaging and installation. The queue's
state is `.mona/build-macos/flight-deck.json`; the resume pointer is
`.mona/build-macos/HANDOFF.md`. The deck work is on `origin/main` at `c66cd31`.
