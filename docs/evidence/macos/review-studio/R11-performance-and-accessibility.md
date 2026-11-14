# R11 — Performance, accessibility and visual regression

**Prompt:** R11 · **Status:** completed · **Platform:** darwin-arm64 ·
**Host:** Mac15,12, macOS 26.5.1, Apple M-series, 8 cores, 16 GB, one
2560×1664 Retina display (`scaleFactor` 2, logical work area 1470×875)
**Runtime:** Electron 45.3.0 / Chromium 156.0.8078.96 / Node 24.22.2
**Engine:** none started — every run in this document makes **zero provider
requests**, asserted from the supervisor's own status (`no_runtime_started`).

Four jobs: bound what the console renders, make the shell accessible rather than
merely labelled, measure the budgets the specification states, and find the visual
regressions that only a rendered frame shows. Each produced findings; several were
real defects that neither the suite nor the existing smokes caught.

---

## 1. What was bounded, and why it needed bounding

**The console rendered the entire loaded transcript as DOM.** `HistoryPager` kept
every page it had read in one array; `PAGE_LIMIT = 200` bounded a *page*, never the
accumulated view. The projection was recomputed in the render body on every render,
and only one `useMemo` existed in the 2,662-line Studio. Because the draft lives in
the same shell state, **every keystroke re-projected the whole conversation and
re-rendered every card**, each re-parsing Markdown and re-formatting a
`toLocaleTimeString`.

Three mechanisms bound it, each with the reason written beside it:

- **`src/renderer/shell/virtual-window.ts`** — the arithmetic, pure and testable.
  Given the ordered keys, the measured heights and the scroll position it returns
  the slice to mount, the two spacer sizes, and **`visibleStart`: the first card
  actually on screen**, which is not the same as the first card mounted (14 tests).
- **`src/renderer/shell/timeline-window.ts`** — the measurement. One
  `ResizeObserver` on the pane, one over the mounted cards, scroll coalesced to one
  read per animation frame, heights flushed once per frame.
- **The Studio** — `projectTimeline` and `projectActivity` are memoized on the
  event list, the paging state and a flattened `completeItems` key; cards are
  `memo`ized and read their handlers through a stable ref, because the shell
  rebuilds every callback on every render.

Three rules keep the window honest rather than clever:

1. **No measurement, no window.** A pane with no height (server render, jsdom, a
   hidden screen) renders the whole list. A window built on a guessed viewport would
   hide content from a reader who cannot scroll it.
2. **A short list is not worth windowing.** Below 80 cards nothing changes.
3. **A measurement never moves what you are reading.** A corrected height shifts the
   viewport only when that card sits **above `visibleStart`** — not above `start`.
   Cards in the leading overscan band are mounted but off screen, so correcting one
   of them must not scroll the reader. (The first implementation used `start` and
   was wrong for exactly that band; see §7.)

Measured on a real 10,203-event conversation with **601 cards loaded** (eight "Load
earlier" pages — the control a reader uses):

```text
cards projected   601
cards mounted      10   (16 after scrolling into the history)
top spacer      69273px
windowed          true
```

The console reports this rather than hiding it: `601 shown · 10203 stored · older
pages available · 10 painted`.

## 2. What the measurement cost

Keystroke latency is input handler + React commit + paint, measured **one frame**
after the input event — two frames would add a fixed 16.7 ms floor and blur the
number being measured.

```text
                        cold        warm
typing  p50 / p95    16.7 / 16.9   16.7 / 17.3 ms    (601 cards projected, 10 mounted)
scroll  p50 / p95    16.7 / 18.1   16.6 / 18.0 ms    (59 frames, 240 px per frame)
studio open            135 ms        109 ms
interactive (Mona start → ready)     1279 ms       1262 ms
spawn → exit, wall                  81377 ms      19918 ms  (includes the 60 s idle sample)
```

Both p95s are inside two 60 Hz frames. Startup meets the specification with room
(**cold within 5 s**, **warm within 2 s**, excluding engine and provider time):
Mona reaches `ready` in **1.28 s cold, 1.26 s warm**. The warm run is not
meaningfully faster because the expensive part is the Chromium process tree, and the
state-directory read is a small fraction of it. Reported as measured.

Idle: **0.05 % average CPU, 0.66 % peak** over 60 seconds of 2-second samples,
against "average app CPU below 1 % over 60 seconds". No timer was added and nothing
polls the engine; the Studio's only recurring clock is the elapsed-time component,
which re-renders itself and not the transcript.

## 3. The one budget that is not met, and the exception it forces

Memory: **552.0 MiB average, 568.7 MiB peak** across 4 processes (Browser 266.7,
GPU 94.2, Utility 48.0, Tab 131.5). The specification's target is "initial idle
total Mona processes target under 350 MiB".

That target cannot be met by application code on this runtime. Measured on the same
host with the same warm-up, a window whose entire content is an `<h1>`:

```text
bare Electron 45.3.0, blank page   356 MiB
```

The framework, its GPU process, its network utility and one renderer already exceed
350 MiB before any Mona code runs. **Mona's own share is ≈ 213 MiB above the runtime
floor.** No process was trimmed, no forced GC was introduced, no feature removed,
and the target was not reformulated.

The exception is carried as **data derived from the measurement**, never as prose.
`scripts/r11-smoke.mjs` runs the baseline and attaches an exception — naming the
exact check it covers — only when `baseline.total_mb_max >= 350`:

```json
"status": "passed_with_exception",
"failing_checks": ["idle_memory_under_350_mb"],
"budget_exceptions": [{
  "check": "idle_memory_under_350_mb",
  "target_mb": 350, "measured_mb": 568.7, "runtime_floor_mb": 356,
  "measured_over_runtime_mb": 212.7
}]
```

A failure the exception does not name stays fatal. A run that writes **no report is
itself a failure** (`run_produced_a_report`), and a non-zero exit is
(`electron_exited_zero`) — a missing report must never read as "no failing checks".
That guard exists because the first version of this harness did exactly that: a cold
run was killed at its bound, produced nothing, and the merge printed `"passed"`.

## 4. Accessibility: four defects found, and what proves each

The audit covered the **whole shell** — nine screens, every one reachable from the
rail. The first pass found four real defects outside the Studio.

**a. A dialog lost the caret.** `Dialog`'s focus effect depended on `onClose`, and
every caller passes an inline arrow, so the effect re-ran on every parent render — a
live engine frame or a draft save is twice a second. Each run restored focus to the
pre-dialog element and then focused the dialog. It also focused the header's
**Close** button rather than the body. Fixed: the handler is read through a ref, the
deps are `[open]`, and initial focus is the body's first control (`[data-autofocus]`,
then the first field, then the panel). Two tests cover it and both were proven to
fail on the pre-R11 code; the re-render is proven by a state echo rather than
assumed, because jsdom's visibility filter had masked the original movement.

**b. A modal did not own the keyboard.** The shell's single `window` keydown
listener had no modal guard, so ⌘1–⌘9 navigated behind an open confirm dialog and ⌘J
hid the terminal under one. It had no IME guard either. Fixed in
`src/renderer/shell/keyboard.ts`: `acceleratorAllowed` refuses while a modal is open
and refuses both spellings of a composing keystroke (`isComposing`, and
`keyCode === 229`, which WebKit reports on the event that *starts* a composition).

**c. A `<textarea>` claimed `role="combobox"`.** ARIA in HTML permits only `textbox`
there, so axe reported `aria-allowed-role`; `aria-expanded` is combobox-only too
(`aria-allowed-attr`). The composer keeps its implicit textbox role and expresses
the popup through `aria-haspopup`, `aria-autocomplete`, `aria-controls` and
`aria-activedescendant`, so a screen reader still announces the highlighted
suggestion on each arrow press. The R03 assertion that pinned the invalid role was
updated with the reason; the *dangling-reference* property it also asserted (no
`aria-controls` target and no active option when there is nothing to choose) is now
asserted directly.

**d. A command suggestion was announced twice.** The detail panel was
`aria-live="polite"` while `aria-activedescendant` already announced the option, so
every arrow press said the command twice. The panel is now visual detail only.

Also fixed: two `heading-order` violations (an `h3` empty state under an `h1` title —
`EmptyState` now takes a `headingLevel`, and the Studio, Changes and Cost pass 2),
and two `scrollable-region-focusable` violations (the Capabilities feature-flag list
and four Memory lists scrolled but were unreachable by keyboard; the Memory results
container also gained `role="region"` so its `aria-label` is permitted).

Final pass, all nine screens: **9 audited, 0 violations, 0 serious or critical.**

Streaming is not announced: no live region exists inside the console and no card
carries one (asserted, along with `role="log"` and `role="status"`).

## 5. Reduced motion, scale and display

- **Reduced motion** is the OS setting, applied through `prefers-reduced-motion` in
  CSS — Chromium maps macOS "Reduce motion" onto it. Production had also been pinning
  `data-reduced-motion="false"` in an effect, which read as though the app had decided
  to ignore the setting; that is gone. Under Chromium's own
  `Emulation.setEmulatedMedia`, the media query **matches**, **0** animations run, and
  the live pulse's computed duration collapses to `1e-06s`.
- **No theme or intensity animates without a real running turn**: all four
  combinations report `running_animations: 0`, `live_dots: 0`, no horizontal overflow.
- **200 % interface scale**: 640 CSS px viewport, no horizontal overflow, console
  298 px, composer visible, window intact (`windowed: true`, 10 cards). The rail
  becomes its compact strip at the 940 px breakpoint — the existing narrow layout.
- **Multiple monitors were not exercised**: one physical display on this host.

## 6. Three visual regressions the rendered frame exposed

None were visible to the test suite; all three came from reading the captures.

**a. The fixed title bar was transparent.** Scrolled content showed through it — the
Usage strip printed over "MONA". It now paints the rail's own surface across the
rail's width and the canvas beyond, so it continues both columns instead of drawing a
seam across the navigation; the narrow layout overrides it to a single surface.
Asserted while scrolled.

**b. The composer sat below the fold at the reference window.** The console was
`clamp(300px, 44vh, 620px)` regardless of what sat beneath it. A measured `maxHeight`
clamp was **tried and reverted**: its reserve calculation picked up a 421 px element,
it ratcheted the console to its floor (180 px) and still did not make the composer
fit. The measured facts are reported instead: the console keeps **350 px** at
1280×800, the console and composer do not overlap, and **scrolled to, the composer is
fully on screen and uncovered** (`fully_visible: true`, `overlaps_strip: false`,
`box_bottom` 502 above `strip_top` 565). The Studio is a scrolling document; that is
a layout fact, stated rather than disguised as a fix.

**c. "Jump to latest" landed short and un-armed itself.** The programmatic jump moved
the scroll position; the window then re-measured and changed the list's height; the
pane's own `onScroll` read the 59 px gap as "the reader scrolled away", so the button
the user had just pressed came back. Fixed in two places: the window re-pins while
following, and `jumpToLatest` re-pins after two frames. Now `distance: 0` with the
newest stored frame (`seq 10203`) on screen.

## 7. Independent review — one blocker and three majors, all fixed

A separate reviewer was asked to refute the change against the code, not the claims.

1. **BLOCKER — a hook after a conditional early return.** The `activity` `useMemo`
   sat *after* `if (!detail) return <EmptyState "Choose a project">`. Opening a
   project from that very empty state re-renders the same component with a different
   hook count, and React throws "Rendered more hooks than during the previous
   render" — reachable from the empty state's own **Open folder** button, from ⌘O and
   from drag-and-drop. It passed the gates because `eslint.config.mjs` has **no
   `react-hooks` plugin**, so `rules-of-hooks` is never checked, and no test rendered
   the `detail: null → project` transition. Fixed by moving the memo above the
   return; a regression test now mounts empty, loads a project and returns to empty,
   and was **proven to fail** on the pre-fix order.
2. **MAJOR — the shift used `start`, not `visibleStart`.** Cards in the leading
   overscan are mounted but off screen, so correcting their height scrolled the
   reader — the exact pathology rule 3 claims to prevent. `computeWindow` now returns
   `visibleStart` and the correction is measured against it (§1, rule 3).
3. **MAJOR — a forced search anchor defeated the bound.** Lowering `start` to an old
   page while `end` stayed at the live edge mounted every card between them. The
   forced window is now the same size as the reader's window, positioned around the
   anchor; two cases are tested (anchor below, anchor above) and both assert the
   slice stays ≤ 40 cards.
4. **MAJOR — one check was vacuous.** `composer_reachable` ("document offset below
   document height") is true for any element that exists. It was removed; the
   non-vacuous predicate in §6b replaced it.
5. **MINOR** the Memory results container's `aria-label` on a bare `div` — fixed by
   `role="region"`.

The reviewer could not refute the pure window arithmetic, the memo inputs, the
dialog lifecycle, the accelerator policy or the harness's failure paths.

## 8. Evidence

| Artifact | What it is |
|---|---|
| `artifacts/r11-perf.json` | The merged cold+warm report: **37 cold checks, 35 warm**, the runtime baseline, and the derived budget exception. |
| `artifacts/r11-studio-long-100.png` | The 601-card console at the live edge, 100 %, empty composer, opaque title bar. |
| `artifacts/r11-studio-200.png` | The same at 200 % interface scale. |
| `artifacts/r11-afterglow-vivid-100.png` | Afterglow/Vivid on a long conversation. |

Reproduce with `npm run smoke:r11` (builds first; ~2 minutes, most of it the
60-second idle sample). The harness runs the shell three times: once for the runtime
baseline, once cold, once warm on the same isolated state directory.

**Gates on these bytes:** typecheck clean (main and renderer), lint **0 errors**
(3 pre-existing `no-explicit-any` warnings in untouched test files), formatting
clean, full suite **1,118 tests in 100 files**, shell smoke **137/137**,
`monabuild validate` green, `monabuild secrets` 693 files and 0 findings.

## 9. What is not proven

1. **VoiceOver has not been heard.** No screen reader was driven and none can be
   automated honestly. What exists: axe over all nine screens, programmatic focus
   assertions, labelled landmarks, a real listbox, and the dialog lifecycle. A spoken
   walkthrough is **P24/P26**.
2. **Multiple monitors and physical display scaling were not exercised.** One display
   on this host; 200 % *interface* scale was measured.
3. **IME was tested at the contract, not with a live IME.** Both spellings are
   asserted in the composer and the dialog; no Japanese/Chinese/Korean method was
   driven in a real window.
4. **Localization-sized labels were not swept** — Mona ships English only.
5. **The memory target is exceeded** (§3): measured, attributed, carried as a named
   exception.
6. **`npm run smoke:shell` rewrites the 36 hash-pinned product captures.** It was run
   (137/137) and the captures restored to their committed bytes afterwards, because
   R12 owns that reconciliation; their hashes describe the pre-R11 shell.
7. **19 shared-file evidence entries were re-recorded** (P02, P03, P04, P09, P10, P18,
   P19) after R11 changed `package.json`, `index.ts`, `styles.css`, `Shell.tsx`,
   `Capabilities.tsx`, `Memory.tsx` and `primitives.tsx`. Each carries a note that the
   original report describes the pre-R11 bytes; no assertion was removed and no
   requirement status was lowered.
8. **The activity strip's age is the clock of the last recomputation**, not of the
   last paint. While a turn is live the snapshot pushes twice a second so it is fresh;
   when the project is completely idle nothing recomputes it and the reported age
   stops advancing. That was already true (R08 has no timer on purpose); a keystroke
   used to refresh it by accident. A timer would re-render the whole screen every second to
   move one label.
