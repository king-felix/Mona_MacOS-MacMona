# Changelog — Mona (macOS)

Mona is built prompt by prompt against a pinned engine; this changelog records
what each build changed and, where a decision shaped the product, its reference in
`.mona/build-macos/DECISIONS.md`. The authoritative per-prompt record is
`docs/evidence/macos/`; the ledger is `.mona/build-macos/state.json`. Build numbers
are `git rev-list --count HEAD` at package time, so they are monotonic but not
semantic.

## Unreleased — Studio flight deck, build 174 (2026-11-15)

Qualified on the owner's Mac: `npm run ci` green (25 steps), 1,189 tests, and a
new 200-check native layout run (`npm run smoke:deck`). The package is built and
verified from its own bytes; **it is not installed yet** — build 170 is still what
`/Applications` contains, and installing needs the owner's terminal. Evidence:
`docs/evidence/macos/studio-flight-deck/`.

- **The window no longer scrolls.** Studio and Focus are bounded to the viewport
  through a definite height chain; the console scrolls inside itself and appending
  output does not move the prompt. Measured pixel-stable at 1440×900, 1280×800 at
  100/125/150/200 %, and 1100×700.
- **One compact deck.** The inspector is removed, and the project/status/activity
  bands collapse into one dashboard plus one activity row. Exact totals and tool
  diagnostics live under Telemetry.
- **Submit replaces Send to engine**, with Pause after task / Resume queue and
  Interrupt now beside it above the prompt, in distinct colours. Every secondary
  action (file mention, queue, engine control, board, favorites, follow-ups) moved
  into one **More** panel that floats above the bar rather than taking two rows of
  every window.
- **The activity signal tells the truth.** Phases are derived only from events
  matching both the current thread and turn; completion, failure and interruption
  clear live motion; an open turn with no reported activity is "waiting", and 45
  seconds of silence stops the animation and says progress cannot be confirmed.
  The check runs on a local clock, so it updates even if snapshots stop. Zero
  added model calls, polls, or provider requests.
- **Routine receipts expire after five seconds** (measured 5,192 ms end to end)
  and pause on hover, focus or a hidden window; replacements restart the timer;
  errors, uncertain outcomes and required input stay. A receipt does not move the
  console.
- **Layout and accessibility defects found by real pixels and fixed:** a 293 px
  rail row at 150 % zoom that left a 22 px console; a stage that never filled its
  column; a screen collapsed to 46 px at 200 % when the rail was hidden; a toolbar
  that wrapped to three rows; secondary actions costing 34 px of every window;
  Escape leaving Focus with a panel open (and then taking Escape from dialogs); a
  resize handle reporting a height outside its own ARIA range; a command list
  squeezed to one clipped row at 200 %.
- **A qualification-harness defect, fixed and disclosed:** the receipt test read
  the system clipboard and stored its text in the evidence report. The harness now
  records only that the pasteboard was restored, its length, and whether it came
  back identical, and the stored artifacts were purged. No product behaviour
  changed; the report was simply never the place for a pasteboard's contents.
- **Preserved unchanged:** drafts and caret identity, archive-send guards, queue
  semantics, uncertain-submission protection, slash completion, the engine pin,
  provider route, permissions, cost accounting and data stores.

## 0.1.0 — build 165 (2026-11-14)

The build qualified by P26/P27.

- **Reasoning controls are declared, not chosen.** Settings → Providers & route →
  Reasoning shows `Auto` with a read-only badge and no way to change it. `auto` is
  the engine's own default, stored in the profile, sent on every new thread and
  turn, and stated on screen. Published effort tiers appear as information only.
  Effective stays `unknown` because the pinned engine reports no effective
  reasoning value on any documented surface (D-108, D-109, D-110, D-111).
- **The model's published tiers are recovered honestly.** When the engine's live
  catalog omits a model's reasoning metadata, Mona reads the engine's own
  Models.dev cache for that exact model, labels the result as metadata, and uses it
  only for the provider's first-party endpoint. Validation stays fail-closed.
- **The transcript preference is Mona's own.** "Show reasoning in Mona's
  transcript" hides reasoning cards without changing the request, and an open
  Studio is told to re-read when it flips.
- **Whole-product QA and the release documentation set.** Measured startup, idle
  CPU, memory (with the Electron floor reported separately), 10k-event typing and
  scrolling, 200 % scaling, reduced motion and axe on the installed bundle; 268
  installed-build checks across five modes; developer guide, contribution and
  security guidance, license status and this changelog
  (`docs/evidence/macos/P26-product-QA.md`, `P27-release.md`).
- **Harness honesty fixed during QA.** The axe gate could not run inside the
  packaged app and reported a failure rather than an absence; the performance
  harness could only measure the source tree. Both were corrected in the harness,
  not by weakening the check.

## 0.1.0 — builds 151–160 (2026-11-14)

The Studio review pass (R13–R15) and the local distribution decisions.

- Installed build qualified from its own bytes: 16/16 build provenance, 137 shell
  checks, 26 command checks, 60 immersive checks, and one live pinned-engine turn
  plus an interrupt with cost observed.
- A real defect found and fixed: the history anchor dropped the reader 115.5 px on
  a 10,054-event project once the console was windowed. The anchor now names the
  card at the top of the viewport and holds its pane offset; the check is in
  `npm run ci` (D-028).
- Release trust measured rather than assumed: preflight exits 3 naming the missing
  Developer ID identities and notary credential; release exits 3 with no artifact;
  verify exits 2 rather than accepting an ad-hoc build.
- There is no shareable release: distribution is local and build-it-yourself
  (D-103). The OS floor is declared at 14.0 and tested on 26.5.1 (D-104). Git is a
  documented dependency, not a bundled payload (D-105).

## 0.1.0 — builds 89–150 (2026-11-12 to 2026-11-14)

The product proper, P00–P25.

- Foundation: pinned-engine discovery and compatibility gate, owned runtime with
  process-tree identity, native arm64 supervisor, transactional state with
  migrations and a maintenance barrier.
- Core: native shell with Daybreak/Afterglow themes, Finder Service and folder
  opening, streaming studio with drafts and bounded history, work board with
  dependency-aware selection, attempt ledger with the three-attempt rule, cost
  ledger with five honest cost states, agents and fleets, memory and handoff,
  extensions and terminal, capability coverage and the shared-core audit.
- Packaging: offline arm64 `.pkg` with a component manifest, install receipt,
  update/migration/rollback and a rehearsed uninstall; a local `.dmg` on request.
- P22 and P24 are `skipped` by owner decision (D-103); their pipelines and
  harnesses remain implemented and re-runnable.

## How to read a build

`/Applications/Mona.app/Contents/Info.plist` carries `CFBundleShortVersionString`
(0.1.0), `MonaBuildVersion` (the build number) and `MonaBuildChannel` (`local`).
`/Library/Application Support/Mona/install-receipt.json` records the package name,
its manifest digest and when it was installed. A build is only that build if those
agree — the packaging gate refuses to certify a copy that does not match the
artifact it just produced.
