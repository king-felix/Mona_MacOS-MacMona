# F02 — the Studio flight deck on real pixels

Run on the owner's Mac (macOS 26.5.1, arm64, Electron 45.3.0) through the real
renderer: `npm run smoke:deck`, which opens a real project in the production
shell, grows its stored transcript by 1,200 frames and one 8,000-line open
stream, and measures the deck at six window/zoom arrangements. **No runtime is
started and no model request is made.**

Machine-readable report: `f02-report.json` (215 checks, `ok: true`).
Runner: `scripts/deck-smoke.mjs` → `runDeckSmoke` in `src/main/index.ts`.
Screenshots in this directory: `f02-*.png`.

## What the run measures

Per arrangement (1440×900 at 100 %, 1280×800 at 100/125/150/200 %, 1100×700 at
100 %), before and after 1,200 appended frames plus the 8,000-line stream:

- the document does not grow (scroll height ≤ viewport, no horizontal overflow);
- the console scrolls internally (`overflow-y: auto`) and keeps a usable height;
- the prompt stays inside the viewport and its bottom does **not** move when
  output arrives (measured pixel-identical);
- the command bar sits above the prompt and Submit/Interrupt are hit-testable
  (the topmost element at their centre is the control itself);
- the obsolete inspector is absent, and the one-row conversation toolbar neither
  overflows itself nor pushes its actions outside its box (checked at every size,
  including the 430 px-wide zoomed window);
- at the live edge the tail is present (or its truncation is stated beside it);
  scrolling up stays inside the console, offers "Jump to latest", and the jump
  returns to the edge without scrolling the page;
- the composer grip reports its own bounds, End grows the prompt, Home restores
  the floor, and after shrinking the window to 900×620 and zooming to 200 % the
  height is re-clamped so the prompt still fits.

Then, once: the secondary-action panel, Focus + Escape ordering, the command list
at 100 %/200 %/narrow, the copy receipt's five-second life, reduced motion through
Chromium's emulation of the macOS setting, the narrow command button, and both
themes with both intensities.

## Layout defects this found, and the fixes

The first native run failed 19 checks. Each failure was a real arrangement, not a
test artifact, and the layout was fixed rather than the assertion relaxed.

1. **150 % page zoom left the console 22 px tall.** The rail becomes a horizontal
   strip below 940 px, and with two `auto` grid rows in a `min-height: 100vh`
   container the browser stretched the rail's row to half the free space — a
   293 px strip. Fixed by declaring the rows (`min-content minmax(0,1fr)`) and
   placing the rail in row 1 and the screen in row 2 explicitly.
2. **The stage never filled the main column** (`flex` computed against a
   content-sized parent), so at 150 % the console was 70 px while 102 px sat
   unused below the composer. The chain is now definite:
   `.shell--studio .harness__main` (flex column, `min-height: 0`) →
   `.screen--studio` (`flex: 1 1 0`) → `.studio` → `.studio__timeline`.
3. **A hidden screen at 200 %** when the rail is `display: none`: the main column
   became the only grid child and auto-placed into the `min-content` row, giving a
   46 px screen with the deck rendering outside it. The explicit row placement
   above fixes both cases.
4. **The conversation toolbar wrapped to three rows (66 px)** at 450 CSS px wide
   and took the room from the console. It is one row now, with the scope sentence
   eliding and its full text in `title`.
5. **The secondary actions cost 34 px of every window** and were the difference
   between a 22 px and a usable console at 150 %. They moved into one on-demand
   panel behind **More** in the command bar (FD-09 "reveal on demand"), floating
   above the bar so opening it never covers the prompt. A first attempt put the
   panel inside the bar and it pushed the prompt; the measurement caught that.
6. **Escape left Focus with a panel still open** when the keyboard focus was not
   inside the panel's subtree. A capture-phase listener now owns Escape while any
   panel is open, and deliberately does not move focus into the composer, so the
   next Escape can leave Focus. Nesting is list → panel → Focus: while the command
   list is open the list closes first, because that is the surface the keyboard is
   in.
7. **The grip reported `72` while the field rendered 104 px.** It now reports the
   observed height, and the initial size is inside the clamp it advertises.
8. **The command list squeezed itself to one clipped row** at 200 % on the taller
   deck composer: the detail pane is `0 0 auto` with a 156 px cap and the list was
   `flex: 1 1 auto`. The list now has a 96 px floor, and the Studio drops the
   detail pane entirely below the panel height that can hold head + foot + detail
   + floor (`COMMAND_MENU_DETAIL_MIN_PANEL`), so the list can never be displaced.

Result after the fixes: console heights 373.8 / 308.5 / 277.3 / 111.2 / 141.0 /
336.5 px across the six arrangements, every document bounded, every primary
control hit-testable.

## Behaviour qualified natively

- **Receipts**: copying a card (the product's own clipboard path) produces one
  success receipt; it dismissed itself after **5,192 ms**, and the console's top
  and scroll position were unchanged while it was on screen. The clipboard was
  read before the run and restored after it.
- **Keyboard**: a real Enter key event reaches the composer exactly once and is
  not prevented, so the browser's newline default governs; Command-Enter on
  `/help` runs the submit path once, explains the TUI-only route, keeps the draft
  and leaves the connection `not_started`.
- **Focus and Escape**: Focus enters; Search opens; the first Escape closes the
  search panel and stays in Focus; the second leaves Focus.
- **Command list**: inside the viewport at 100 % and 200 % (body scrolls, 79
  options) and at an 820 px window.
- **Reduced motion**: with `prefers-reduced-motion: reduce` emulated, the media
  query matches and zero animations are running. Idle with no turn: zero
  animations, `data-animated="false"`.
- **Themes**: Daybreak/Vivid, Afterglow/Vivid and Afterglow/Quiet all render
  bounded with no page overflow; ink-on-surface contrast measured 15.91, 13.86 and
  13.86:1.

## Honest limits of this record

- **Enter's browser default is not observable through Electron's synthetic key
  event.** The probe proves the key arrives and that the product does not consume
  it (`prevented: false`); the textarea's value did not change under
  `sendInputEvent`, which is a limitation of synthetic events, not of the app.
  A human pressing Enter is the remaining confirmation.
- **A live turn's animated phases** (reasoning, tool, writing, waiting, quiet
  after 45 s, reconnecting) cannot be produced without a provider turn. Their
  projection truth is covered by `test/agent-signal.test.ts`; the *idle and
  offline* appearance is qualified here (no animation, exact `data-connection`).
  Observing the animated appearances during real work, plus VoiceOver, is listed
  as Needs the Human in `flight-deck.json`.
- Screenshots are of the development shell (`electron .`), not the installed
  bundle. F03 repeats the installed copy's own smoke.
