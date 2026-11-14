# R13 — Native installed-artifact qualification

**Prompt:** R13 · **Status:** blocked at the install gate for build **152** — the
installed build **151** was qualified end to end and exposed one defect, which is
fixed and verified on the candidate and on the development tree
**Platform:** darwin-arm64 · **Host:** macOS 26.5.1, Apple silicon, node 26.13.0,
Electron 45.3.0
**Installed:** `/Applications/Mona.app`, build **151**, source `26c38c5`, clean
tree, installed 2026-11-14T17:57:26Z, ad-hoc, manifest `31eaa3a3…`
**Candidate in hand:** build **152**, source `c9745dc`, clean tree, ad-hoc,
`Mona-0.1.0-macOS-arm64-local.pkg` sha256 `e4ffe0e0308866e2bf7185e24701b82a599dc49591f99aba83ef2592308c777d`,
163,802,705 bytes, assembled 2026-11-14T18:18:40Z
**Engine:** 0.10.2 (`ff466b2ed0bf`) inside both bundles. One live turn and one
interrupt were run through the installed app; nothing else contacted a provider.

The install that this task was blocked on has happened: build 151 replaced
build 104. Every acceptance item that does not need a second privileged install
is measured below. The one that does — putting the fixed candidate at
`/Applications/Mona.app` — is recorded in §7 with the exact command.

---

## 1. The installed artifact is this checkout's build

`node scripts/r13-candidate-verify.mjs --smoke --launch` against
`/Applications/Mona.app`: **16 checks, all true** (`artifacts/r13-candidate-verify.json`).

- **identity** — `com.mona.workbench`, 0.1.0, build 151, channel local, minimum
  macOS 14.0.
- **the artifact names its source** — the bundle's component manifest carries
  `commit 26c38c5770d4039972811427b23b056a469985d1` and `dirty: false`; the build
  number equals `git rev-list --count HEAD`; the tree is clean. The same content
  digest (`45f076607eaa00a0…`) is computed from the installed bundle and from the
  staged payload the package was built from, so the install really is these
  bytes.
- **component digests** — 13/13 listed components (bundled engine, both native
  helpers, two icons, the capability inventory, seven licence/notice files) match
  their recorded size and sha256.
- **arm64 only, 14.0 declared** — every app-owned Mach-O is arm64 at 14.0; the
  bundled engine declares 11.0 because it is the pinned upstream binary and is
  not rewritten.
- **the review's features shipped** — the packaged main bundle registers
  `projects:history-item` (R02), `commands:execute` (R04),
  `window:fullscreen:set` (R05), `studio:answer-pending` (R07) and
  `studio:follow-up-add` (R08); the renderer bundle carries "Load earlier
  events", "Jump to latest" and "Vivid".
- **LaunchServices launch and shutdown** — `open -na` started a real main process,
  a renderer and a per-user state directory, and a `SIGTERM` ended it with no
  helper left behind. `graceful_shutdown` is measured here rather than inferred
  (the earlier copy at `/Applications/Mona-r13-candidate.app` could not quit
  because of the duplicate-copy notice — D-027).
- **signing tier** — ad-hoc, `TeamIdentifier=not set`, Hardened Runtime not
  applicable, Gatekeeper rejects it. A local candidate, exactly as labelled.

## 2. The installed app's own native smokes, through LaunchServices

`scripts/r13-installed-pass.mjs` spawns the binary the OS runs
(`/Applications/Mona.app/Contents/MacOS/Mona`) with the repository's own
fixture-driven UI modes, isolated user-data and a temporary capture directory.
The shell mode was additionally driven through LaunchServices (`open -na`) with
`--env`, so the LaunchServices path itself ran 137 checks.

| Mode | Checks | Result |
|---|---|---|
| shell (LaunchServices) | 137 | all pass |
| shell (driver) | 137 | all pass |
| command | 26 | all pass — slash-command autocomplete, keyboard selection, dispatch interception, 200 % scale |
| immersive | 60 | all pass — Focus Studio, native fullscreen, composer and draft survival |
| history | 18 | **2 fail — `scroll_anchor_held`, `second_older_page_loaded`** |

Report: `artifacts/r13-installed-pass.json` (the failing history run),
`artifacts/r13-shell-smoke-launchservices.json`.

## 3. The defect the installed pass found

The history smoke was **not** in the local CI list, so it had been failing
unnoticed since R11 (`e299dc8`) windowed the agent console. It fails on the
installed build and on the development build identically, three runs in three,
so this is a source regression, not a packaging artifact:

- On a 10,054-event project, loading an older page moved the reader **115.5 px**
  (about one card) instead of holding the message being read.
- The second page was counted but never painted, because the windowing change
  meant the smoke's old "it is in `document.body.textContent`" proxy no longer
  described a page that sits far above the viewport.

Root cause: R02's anchor compared the list's *height* growth with the viewport's
movement. That identity was exact while every card was mounted. R11 renders a
window plus estimated spacers, so the list's height is an estimate and the
identity cannot hold. The fix (`src/renderer/shell/Studio.tsx`) anchors on
**card identity**: the card at the top of the viewport when "Load earlier" is
clicked has its pane offset held across the frames the new slice needs to
measure itself.

### The first attempt at that fix was itself defective, and a review caught it

An independent review of the first fix found two real problems, both reproduced:

1. **The identity path was unreachable.** A page is 200 cards and the insertion
   happens above the reader, while the window is re-sliced from the
   *pre-insertion* scroll position — so the card the pin looked for was not in
   the DOM. The pin fell back to the height form, settled, and never ran again.
2. **The check could not fail.** It passed at 0 px because the anchor it picked
   (a card from the archived thread, timestamped *first* in the fixture) sat
   **above** the insertion point. Nothing needed correcting, so nothing was
   corrected. The zero delta was geometry, not behaviour.

Both are fixed, and each has a mechanism rather than a promise:

- `heldKey` keeps the anchored card **mounted** by passing it to the existing
  `includeKey` window input, so the pin can measure it. `settle()` only clears
  its **own** anchor, so a second click cannot have its anchor erased.
  `jumpToLatest` clears the anchor, the pin bails when the reader is following
  the live edge, and an anchor is abandoned on a project/thread change.
- The fixture timestamps the archived thread **last**, so the block no longer
  sits where the reader scrolls; the reader is placed at **3,000 px** inside the
  long-session page; the prepended page contains a deliberately **tall** block, so
  the cards above the viewport are not uniform; and the pin writes
  `data-anchor-mode`.
- The smoke now asserts `anchor_scenario_exercised` (the first page was exactly
  200 cards and the viewport actually moved by more than 1,000 px),
  `anchor_card_stayed_mounted` (the recorded card is still in the DOM **and**
  `anchor_mode === "identity"`), and `scroll_anchor_held` (its pane offset within
  2 px). `older_page_rendered_once` no longer asserts key uniqueness — React and
  the merge already guarantee that — and instead counts the painted older frames
  once the list has been scrolled to the oldest end: at least five frames, none
  repeated.

**Failing-first proof.** With `heldKey` removed from `includeKey` and everything
else unchanged, the smoke fails exactly one check and reports the fallback:
`anchor_card_stayed_mounted` false, `anchor_mode: "height"`
(`artifacts/r13-anchor-failing-first.json`). Restored, it passes with
`anchor_mode: "identity"`.

### A second review pass found the mount guarantee had no expiry

`heldKey` is what keeps the card mounted, so it is also the thing that can strand
the console: a page read that **fails**, or that finds no cursor, increments no
counter, so the pin never runs and the window stays forced onto one card. The
review said so and it was verified by reading `history.ts`: the failure path does
set `loading: false`, but the no-cursor path returns before `loading` is ever set
and changes nothing the pin scopes on.

Fixed with one release path and a deadline:

- `releaseHold()` clears the timer, the anchor and `heldKey`. Every abandon routes
  through it — settle on a superseded click, `followRef`, a project change, jump
  to latest, a settled read that moved no counter, and unmount.
- `loadOlder` arms a **5 s deadline**, so no failure mode can leave the window
  pinned.
- The pin is the only place that clears its own anchor
  (`anchorRef.current === anchor`), so a second click cannot have its anchor
  erased by the first one settling.
- `data-anchor-mode` is cleared before the scenario, so the assertion cannot be
  satisfied by an earlier pin.

The same pass also corrected two claims this document had made: the tall block in
the prepended page is **realism, not a discriminator** (an inserted region that is
entirely unmeasured corrects identically under both forms — the failing-first
artifact shows `height_delta: 0`), and `older_page_rendered_once` now also
requires the painted frames to be older-page frames (`newest <= 9650`).

### The gate was racing too

Putting `smoke:history` into `npm run ci` exposed two real races in
`smoke:commands`, which was already in CI: a single synthetic project click that
a re-render could drop (observed once in CI as `studio_opened: false`), and a
200 % menu geometry measured before layout settled (observed once under three
concurrent runs). Both are fixed at the cause — readiness is now an asserted
check, the click is retried inside the deadline, the zoom is confirmed through
`getZoomFactor()` rather than `devicePixelRatio`, and the rectangle is measured
once it stops moving. No assertion was removed and no tolerance was widened.

Verified after the correction:

- `node scripts/history-smoke.mjs` — **20/20, three consecutive runs**; the
  viewport moved 22,000 px and the anchored card's offset moved **0 px**
  (`artifacts/r02-history-long-smoke.json`).
- The candidate's own bytes through the same driver: **shell 137/137, command
  26/26, immersive 60/60, history 19/19**
  (`artifacts/r13-candidate-pass-152.json`, `artifacts/r13-candidate-verify-152.json`).

## 4. One live route interaction on the installed app

`--studio-smoke` on the installed bundle ran one tool-enabled task and one
interrupt through the owned pinned engine (`artifacts/r13-studio-live.json`,
captures `r13-installed-studio-run.png`, `r13-installed-studio-live.png`,
`r13-installed-studio-offline.png`). **22/22:** runtime connected, engine identity
pinned, profile `deepseek / deepseek-flash` (the configured route; Mona made no
switch), submission accepted, turn completed, file changed, test command
observed, tool card rendered, effective permission full access, **cost observed**,
replay without duplicates, interrupt confirmed as terminal, runtime stopped,
offline history retained, no link navigation and no fake percentage in chrome.

## 5. Rehearsals and honesty checks

- **Install rehearsal** — package scripts against a temporary root, twice:
  `idempotent_reinstall: true`, receipt written.
- **Uninstall rehearsal** — 11/11 sub-checks: dry run changed nothing and listed
  owned paths; a missing manifest and a foreign bundle were refused; user data
  was removed only for the named home; projects survived `--remove-user-data`; a
  home outside the rehearsal root was refused; removal touched only owned paths
  and preserved unrelated content.
- **Payload hygiene** — 673 files + 14 links; no developer paths, no credentials;
  the one documented allowance is `main/work/git.js` naming the Xcode/CLT paths so
  it can refuse Apple's Git stub.
- **`npm run mac:doctor`** — all host checks green, 0 Developer ID identities,
  ≥5 GiB free (28 GiB).
- **Git on a clean recipient** — `/usr/bin/git` here is real (CLT installed);
  packaged Mona still refuses the CLT stub, so the MAC-004 dependency stays open
  and R14 reconciles it.
- **OS floor** — 14.0 declared, this host is 26.5.1; no 14.x host executed
  (OPEN-OSFLOOR, P26).

## 6. Why build 152 is not installed

`/Applications` still holds build 151, and the packaging gate refuses to pretend
otherwise (it compares the whole content digest, not the version string). A
rebuild is not byte-identical to an earlier one because the ad-hoc signature
seals the bundle's resource directory, which seals the component manifest, which
names the source commit — by construction, a changed source means a changed
digest, and the installed copy must be the candidate, not a lookalike.

`installer` refuses without root:

```
$ installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
installer: Must be run as root to install this package.
```

Replacing `/Applications/Mona.app` by copying the bundle into place is possible
for an admin-group user on this host (`/Applications` is group-writable), and it
is **deliberately not done**: it would leave the package receipt describing a
different payload and would bypass the install path this task exists to prove.

## 7. The one remaining step

```sh
sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
```

Then, in this order:

1. `node scripts/r13-candidate-verify.mjs --smoke --launch` — 16 checks against
   build 152 at the standard path.
2. `node scripts/r13-installed-pass.mjs` — shell/command/immersive/history from
   the installed bytes; history must show 19/19.
3. `npm run mac:package:local` — its `installed_copy`, `package_smoke` and
   `gui_launch` gates then execute for build 152 and close the package report.

No hypothesis failed here; a privilege is missing, so no attempt is counted.

## 8. Evidence

| Artifact | What it is |
|---|---|
| `artifacts/r13-candidate-verify.json` | The verifier against installed build 151: 16/16, including LaunchServices launch and measured shutdown. |
| `artifacts/r13-candidate-verify-152.json` | The same verifier against candidate build 152's staged bytes: 13/13 components, source `c9745dc`; `package_smoke`'s `install location` check is the only non-pass, because the bundle is not at `/Applications`. |
| `artifacts/r13-installed-pass.json` | The installed-mode driver on build 151: shell 137/137, command 26/26, immersive 60/60, history 18/20 with the two anchor failures that opened the defect. |
| `artifacts/r13-candidate-pass-152.json` | The same driver on candidate build 152: 137 + 26 + 60 + 19, all pass. |
| `artifacts/r13-shell-smoke-launchservices.json` | The 137-check shell smoke driven through `open -na` on the installed app. |
| `artifacts/r13-command-smoke.json`, `artifacts/r13-immersive-smoke.json`, `artifacts/r13-studio-live.json` | The command, immersive and live-studio reports from the installed bundle. |
| `artifacts/r13-history-anchor-defect.json` | One failing history run on the installed build, kept as the defect's record rather than deleted. |
| `artifacts/r02-history-long-smoke.json`, `artifacts/r02-history-long-session.png` | The fixed smoke: 19/19, delta 0, and its capture. |
| `artifacts/r13-package-report.json`, `artifacts/r13-uninstall-rehearsal.json` | Build 152's own gate report and the 11 uninstall sub-checks. |
| `artifacts/r13-installed-studio-{run,live,offline}.png` | Captures from the installed app's live run, interrupt and offline history. |

Reproduce: `node scripts/r13-candidate-verify.mjs --smoke --launch`,
`node scripts/r13-installed-pass.mjs [--app <bundle> --out <file>]`.

## 9. What is not proven

1. **Build 152 at `/Applications`.** The fix is verified on the candidate's bytes
   and on the development tree, not on an installed copy (§7).
2. **A 14.x host** and a **clean recipient without CLT** (OPEN-OSFLOOR, OPEN-GIT).
3. **Finder Service handoff from the packaged Service** and the installed
   Service's enabled state remain human checks (P24).
4. **Clean-host Gatekeeper acceptance** is impossible for an ad-hoc build by
   definition; R14/EXT-SIGNING own it.
5. **No screen recording permission**, so captures are Electron page captures of
   the real windows, not desktop recordings.
