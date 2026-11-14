# R05 — Focus Studio and native full screen

**Task:** R05 · **Requirements:** MONA-006, MONA-029 · **Findings:** RV-08,
UX-FULLSCREEN · **Platform:** darwin-arm64, macOS on the build host ·
**Engine:** none started, no model request anywhere in this task

The reviewed complaint was concrete: *"Existing Focus hides inspector and some
facts; `styles.css:3545` still uses a clamped 48vh timeline, surrounding shell
remains."* R05 is therefore an evolution of the mode that already existed, not a
second shell.

This document describes the state **after** the independent review pass; the
review's findings and their fixes are recorded at the end rather than hidden.

## What changed

### Two controls, two different facts

| Control | What it changes | Where it lives |
|---|---|---|
| **Focus Studio** | The *stored layout preference* for this project (`focusMode` in the project view) | Work menu ⌘⇧F, the Studio's Focus button, the palette |
| **Enter Full Screen** | The *OS state* of this window | View menu `togglefullscreen` role (⌃⌘F), the Studio's Full Screen button, the green traffic light |

The focused layout is on when either the preference is on **or** the window is
in native full screen. That is why "Enter Full Screen uses the same focused
layout" holds without pretending the two are one switch.

Nothing about full screen is persisted or restored: `main/window.ts` still
creates a plain windowed window; the stored view is
`{ screen, inspectorTab, studioMode, focusMode }` and the smoke asserts the key
set contains no `fullscreen` binding — read while the layout is *on*, so the
assertion cannot pass vacuously.

### Native full screen, observed rather than assumed

`src/main/window-fullscreen.ts` is one controller per window:

- `view()` reports `{ fullscreen, pending, available, epoch }`.
- `fullscreen` is **read back from the window** inside the
  `enter-full-screen` / `leave-full-screen` handlers. `setFullScreen(true)`
  returns long before AppKit finishes its Space animation, so a boolean set on
  the call would claim a transition that may never happen.
- `pending` is published the moment the request is sent, so the control can say
  "waiting" instead of looking inert. A repeat request for the state in flight
  is coalesced; asking for the state the window is still in reverses a pending
  request rather than waiting out an animation.
- A request macOS never answers is dropped after a bounded deadline
  (`settleMs`, 4 s) and the view is re-published — `pending` cannot latch and
  leave the control disabled forever. The renderer notices the unfulfilled
  intent and says so: *"macOS did not report a full screen transition."*
- Duplicate events change no fact, so they neither advance `epoch` nor wake the
  renderer.

IPC is narrow and window-scoped: `window:fullscreen` and
`window:fullscreen:set` carry **no window identifier**. `ipc.ts` resolves the
window from the invoking sender (`BrowserWindow` registry keyed by web contents
id) and refuses when the sender owns no window, so a renderer cannot put another
window into full screen. Both channels go through the existing
`senderIsTrusted` gate and a strict zod object.

The renderer only accepts a view whose four fields validate
(`isWindowFullscreenView`), subscribes to `window:fullscreen-changed`, and
**ignores the reply** to its own request. A test drives exactly that: the fake
bridge answers `setWindowFullscreen(true)` with the *old* observed view and the
layout does not move until the event arrives. The smoke enters and leaves full
screen by **clicking the real control**, so the IPC path, the sender scoping and
the controller are all in the loop.

### The immersive layout

- `.shell--focus` hides the rail, the workspace top bar and the footer, and
  makes the main column fill the window. The column uses `min-height: 100vh`
  with **no overflow**, so it grows and the document scrolls at large text sizes
  instead of shrinking the console — and it never becomes a clip box for the
  absolutely positioned command list.
- The context bar is replaced by the **dashboard**: 52 px (44 px floor), one
  row, with project, conversation + active turn, engine state, elapsed, model,
  project spend, project tokens, and always-reachable Start / Pause / Interrupt.
  Secondary controls (cancel queued, stop engine, blockers, full-screen state,
  layout source, scope, the same model/spend/token values, recent diagnostics)
  live in a `<details>` popover opened by a real button, so it is keyboard- and
  screen-reader-reachable. Escape closes the popover before it can leave the
  layout.
- **Honesty rules in the bar**: spend shows `not recorded` when usage was never
  observed (never `$0.00`), `at least $x` when some turns are unpriced, and the
  token fact is labelled with the same project scope as the Cost screen. Elapsed
  is time since the studio entered its current state — for a running turn that
  transition *is* the turn start — and with no live session it shows `—` rather
  than a clock derived from the snapshot's own timestamp.
- The timeline takes the rest of the stage: `flex: 1` with the old
  `clamp(280px, 48vh, 660px)` gone in this mode. Measured: 379 px of a 682 px
  stage at 1280×800 (55.6 %), 464 of 805 (57.6 %) in native full screen.
- The composer is bounded and resizable: a `role="separator"` grip with pointer
  drag, Arrow keys, Home and End, `aria-valuemin/max/now`. The maximum is
  measured from the live stage and the composer's own chrome — a ResizeObserver
  re-clamps it on window resize, zoom change and layout change, so a shrink can
  never leave a height the new stage cannot afford. At the maximum the composer
  is 286 px (41.9 %) and the timeline still 341 px; at 200 % the timeline keeps
  226 px of a 497 px stage while the document scrolls 154 px to reach Send.
- The composer is deliberately **not** a scroll container in this layout: the
  command list is absolutely positioned above it, and `overflow` here clipped
  the list out of sight in the first implementation of R05.
- Below 940/1400 px of CSS width the least urgent facts step out of the bar; the
  drawer repeats their exact values, and the two labels that are visually elided
  stay in the accessibility tree.

### Escape and focus

Escape closes the command list (composer), then a popover or dialog, and only
then leaves Focus Studio. It never interrupts a turn and never discards a draft.
From inside the composer it does nothing, which is what keeps a half-written
prompt safe.

Full screen has **no renderer accelerator**: ⌃⌘F belongs to the AppKit role and
the green button, so one press cannot toggle twice. The focus toggle keeps its
200 ms guard, now covered by a shell-level test that fires the DOM handler and
the menu event for one press and asserts a single toggle. Its state writer is a
single function with a ref, so the keyboard handler and the rendered state can
never disagree, and the React updater stays pure.

### No remount

The Studio is the same component tree in both layouts; only props and CSS
change. The smoke records the `.studio` and `textarea` nodes before the first
toggle and asserts identity after focus, after native full screen, and after
leaving it — with the draft text and its `[6, 19]` selection intact.

## Verification

**Unit / component — 137 tests in 6 files** (`artifacts/r05-focused-tests.txt`)

- `test/window-fullscreen.test.ts` (11): observed-vs-requested, pending
  publication, coalescing, reversal, events nobody requested, duplicate events,
  refusal, non-macOS, destroyed window, dispose, and the settle deadline.
- `test/studio-focus.test.tsx` (15): dashboard contents, elapsed source and the
  `—` case, pause/interrupt enablement, Start, drawer values, Escape closing the
  drawer, full-screen state from the observed view, pending/unavailable/exit
  gating, grip presence, keyboard and pointer resize with bounds, no remount
  (node identity + selection + focus).
- `test/shell-races.test.tsx` (6 new): observed transition drives the layout,
  the request does not, composer identity across focus, one press = one toggle,
  a refused transition is announced, stored view has no full-screen key, Escape
  priority.
- `test/ipc-contract.test.ts` (2 new): strict payloads; a caller-supplied window
  id is refused.
- `test/menu-template.test.ts` (1 new): exactly one full-screen binding, on the
  role, with no second accelerator.
- `test/studio-screen.test.tsx`: unchanged and still green, which is the
  regression that the everyday Studio did not move.

**Full suite — 983 tests in 90 files** (`artifacts/r05-full-tests.txt`; 948 in
88 at R04).

**Static gates — typecheck clean, lint 0 errors (3 pre-existing `no-explicit-any`
warnings), formatting clean** (`artifacts/r05-gates.txt`).

**Real window, real AppKit transition — 60/60 checks**
(`artifacts/r05-immersive-smoke.json`, `npm run smoke:immersive`). Isolated
state store, isolated user-data directory, a real project folder, no runtime,
captured `2026-11-14T07:40:16Z`.

- Entry and exit went through the **rendered control** (`window:fullscreen:set`),
  not a direct `setFullScreen` from main. While the request was in flight the
  control reported `aria-busy="true"`, `aria-pressed="false"`, disabled, and the
  document still said `data-fullscreen="off"`.
- The window reported `enter-full-screen` at `07:40:19.564Z` and
  `leave-full-screen` at `07:40:22.958Z`; bounds went 1280×800 → 1470×923 →
  1280×800 at the same origin. The renderer received
  `{ fullscreen: true, pending: false, available: true, epoch: 1 }`.
- Focus layout: dashboard 52 px, rail and top bar `display: none`, timeline
  55.6 % of the stage, composer 36.4 %, no page overflow, draft and selection
  preserved, node identity preserved.
- The slash-command list opens **in the focused layout** at 520 px tall, fully
  inside the viewport, and a hit test just inside its top-left corner resolves
  into the list itself (`hit_is_menu: true`), which is what proves no ancestor
  clips it. Escape then closes the list and keeps the layout.
- The More popover opens from its real control, fits the viewport, and carries
  the values the narrow bar elides — model, spend, tokens — with the honest
  wording for a project that has no usage (`not recorded`, never `$0.00`).
  Escape closes the popover, keeps the layout, and is the keyboard-only route
  out of it (`r05-focus-drawer.png`).
- Composer at its maximum: 41.9 % of the stage, timeline still 341 px.
- At 200 %: dashboard controls in view at the top, Send/grip/timeline in view
  after a 154 px document scroll, timeline 226 px, no horizontal overflow.
- Stored view **while focus is on**: `{ screen: "studio", inspectorTab: "task",
  studioMode: "work", focusMode: true }` — no full-screen key.
- Engine state `disconnected`, connection "Not started" throughout: no turn and
  no model request exists to account for.

**Captures** — `r05-studio-normal.png`, `r05-focus-windowed.png`,
`r05-focus-command-menu.png`, `r05-focus-drawer.png`,
`r05-native-fullscreen.png`, `r05-focus-200.png`.

**Normal layout regression** — the R03 command smoke was re-run against this
build: 25 of 26 checks pass, including the menu inside the viewport at 100 % and
200 % and no page overflow. The one failure is `tui_only_explained`, which still
expects the R03 wording "TUI-only"; R04 replaced that notice with *"The terminal
pane is prefilled with the command above and waits for you to launch it."* It is
pre-existing drift between two closed tasks, needs no behaviour change, and R12
owns the reconciliation. Its two R03 captures were restored to their committed
bytes afterwards so R03's hash record stays valid.

**Not run here:** `smoke:shell`. It rewrites 36 hash-pinned product captures
across P07/P11/P12/P13/P14/P16–P19/P23, and the ordinary Studio's visuals did
change (the context bar gained a Full Screen button). It is not part of
`npm run ci`; running it belongs with R12's capture reconciliation, which owns
those hashes. The normal layout is covered meanwhile by the full vitest suite
and the command smoke above.

## Independent review

The reviewer returned **FAIL** with three major-or-worse defects and eight
smaller ones. All of them were fixed, and each fix has a check that fails
without it:

1. **Focus Studio clipped the slash-command autocomplete.** `.composer` had
   `overflow: auto`; the list is absolutely positioned above it, so it was cut
   off. The composer is no longer a scroll container in this layout; the text
   area carries the bound. Proven by the hit test and
   `r05-focus-command-menu.png`.
2. **The composer height was never re-clamped when the stage shrank.** The
   200 % artifact showed a 77 % composer over a 72 px console. The stage and the
   composer's chrome are now observed and re-clamped, the console keeps a 160 px
   floor (140 px on a short viewport), and the smoke asserts the console's share
   at 200 %.
3. **The "slim dashboard" hid model/spend/tokens with no alternative route.**
   The drawer now repeats their exact values, and elided labels stay in the
   accessibility tree.
4. `pending` was never published, so the pending UI was dead code and a refused
   request was silent. It is published, and the renderer announces a transition
   macOS did not make.
5. The exit control was enabled while full screen supplied the layout and did
   nothing. It is disabled with the reason in its title.
6. Escape did not close the More popover, so it tore down the layout instead.
   It closes the popover first, with a test.
7. The smoke never exercised the IPC path. It now enters and leaves full screen
   by clicking the rendered control.
8. The stored-view assertion was vacuous. It now reads the view while focus is
   on.
9. `ELAPSED 0s` beside "Not started" was a fabricated clock. It reads `—`.
10. `aria-valuenow` disagreed with the text field's height and read layout during
    render. Limits are observed state now.
11. `setScreen` inside a `setFocusMode` updater. One pure writer replaces it.

Two host facts surfaced during the review round and are recorded rather than
smoothed over: macOS ignores a full-screen request from an inactive app (the
runner activates the window and waits, and one early run showed the transition
never arriving), and an Electron probe left running by a debugging step held
activation so that every attempt failed — after it was cleaned up, the transition
arrived on the first request.

## Not verified

- **VoiceOver** announcements for the dashboard, the popover and the resize
  separator. R11 owns accessibility QA.
- **A second display / display-scaling change** during full screen, and
  Mission Control behaviour beyond enter and leave.
- **The green button and a physical lid close.** The smoke drives the same
  AppKit role through the rendered control; a physical green-button click and
  real sleep are R11/P24 manual QA.
- **Window dragging** is unchanged (`titleBarStyle: hiddenInset`), but the
  focused layout leaves only the 38 px title strip as a drag region.

## Notes for the next task

R06 (Aurora) inherits this layout: the dashboard, the grip and the focus-only
styles are the surface it restyles. R09's HUD is a different, non-immersive
surface and should reuse the bar's scope labels rather than invent a second cost
reading. R12 owes the `tui_only_explained` wording and the product-capture
reconciliation named above.
