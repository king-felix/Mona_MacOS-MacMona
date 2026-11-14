# R06 — Aurora Studio visual identity

**Task:** R06 · **Requirements:** MONA-006, MONA-029 · **Finding:** UX-AURORA ·
**Platform:** darwin-arm64, real Electron window · **Engine:** none started,
0 model requests.

Victor's request was explicit: make Studio *splashier, cooler and more fun to
use* while keeping it clear. This is the §3 visual direction applied to the
**production shell** (`src/renderer/shell/*`), not to the `design/screens`
fixture harness.

This document describes the state **after** the independent review pass; the
review's findings and their fixes are recorded at the end rather than hidden.

## What changed

### One decorative layer, two intensities

`src/renderer/design/tokens.ts` gained six ornament roles per theme — `auroraA`,
`auroraB`, `auroraC`, `selection`, `selectionInk`, `glow` — and one preference,
`applyIntensity("vivid" | "quiet")`, which sets `data-intensity` on the document
root. The semantic roles are untouched by intensity, which is why one contrast
table governs both: Vivid changes the wash, the luminous edges, the plaque and
which surfaces carry colour; it never moves a text colour. Quiet keeps the exact
layout with plain raised surfaces.

A unit test enforces the structural half of that promise: **no contrast pair may
name an ornament role as its foreground**. `selectionInk` is the one role allowed
to carry text on an ornament fill, and it is measured like any other pair (4.5:1).

### Where the identity lands

- **Rail** — an iris wash at the top fading into the surface, an iris-tinted right
  border, a one-pixel iris→orchid→cyan rule under the brand, a glow behind the
  owner's artwork, and a *selection* fill with a coloured inset edge on the
  current screen and the current project.
- **Plaque** (`context-bar`) — an iris→orchid→cyan wash with the identity block
  on an **opaque** surface layer, so the project name and path never sit on a
  gradient.
- **Turns** — user turns carry a lavender surface with an iris left edge, agent
  turns a cyan left edge, tool calls a sunken framed card, failures a coral card.
  Who spoke is visible from the surface, not only from a 10 px label.
- **Home** — the production project row (`.project-row`, which is what
  `shell/Home.tsx` renders) takes an aurora border and a soft glow, and the
  selected row takes an aurora ring. The harness-only `.project-card` is styled
  too, but the smoke measures the **production** row.
- **Composer** — a luminous focus edge (static); the resize grip is now in the
  ordinary layout as well (see R10).
- **Immersive bar** — the same wash and a matching bottom rule; the dashboard
  keeps its 44–56 px height.

### Motion follows real state or it does not run

- The only new animation is a pulse on `.status-dot--live`. That class is applied
  by one function (`statusDotClass`) and only when the studio's connection state
  is `running` — not for `connected`, `stopped`, or a disconnected agent. A
  disconnected agent cannot look busy because decoration is pulsing.
- It stops when the document is hidden (`data-document-hidden` on
  `visibilitychange`), because Electron keeps a hidden window's compositor alive.
- `prefers-reduced-motion: reduce` removes the pulse and the hover transform.
- Measured: `document.getAnimations()` reports **0 running animations** in all
  four theme/intensity combinations with the window idle.
- No "turn settled" transition is applied to any element: the keyframe exists, but
  a transition that fires on every card would be decoration pretending to be an
  event. The honest signal for a finished turn is the card's status badge.

## What the run measured — 31 checks, all true

`npm run smoke:aurora` launches the real shell against a temporary store and a
real folder seeded with a stored transcript (user turn, long agent answer, tool
call, failed tool call, turn completion) and two stored pending requests. No
engine is started and no model is asked anything.
(`docs/evidence/macos/review-studio/artifacts/r06-aurora-smoke.json`.)

- Both themes × both intensities rendered, each capture taken in the **normal**
  layout (the runner clears a persisted Focus Studio preference through the
  product's exit control and asserts `normal_layout_<theme>_<intensity>`).
- Vivid plaque/rail carry gradients; Quiet ones are plain.
- Vivid turns have distinct 3 px edges; Quiet turns have none.
- **Painted** text/background pairs, composited over the nearest opaque ancestor
  and measured from the rendered elements — user turn, agent turn, tool card,
  error card, selected rail item, plaque title — all ≥ 4.5:1 in all four
  combinations. Daybreak Vivid: 14.51, 15.91, 14.08, 13.56, 8.89, 15.91.
- The production Home row renders and its border and selection differ between
  Vivid and Quiet (`.project-row`, measured, not inferred).
- Two pending cards render (an approval and a structured question).
- Long output and the failed-tool card are present in the scrolled console.
- 200 % zoom: no horizontal overflow, plaque identity intact.
- No two captures are byte-identical, so a stale composited frame cannot pass as
  a second state.

Captures (viewed, not merely generated): `r06-daybreak-vivid-home.png`,
`r06-daybreak-vivid-studio.png`, `r06-daybreak-vivid-focus.png`,
`r06-daybreak-quiet-home.png`, `r06-daybreak-quiet-studio.png`,
`r06-afterglow-vivid-home.png`, `r06-afterglow-vivid-studio.png`,
`r06-afterglow-vivid-focus.png`, `r06-afterglow-quiet-home.png`,
`r06-afterglow-quiet-studio.png`, `r06-daybreak-vivid-timeline.png`,
`r06-daybreak-vivid-200.png`.

## Review pass — three defects found, all fixed

The independent review returned **FAIL** on the first version of this task. Its
findings, and what changed:

1. **The Home treatment targeted a class production never renders.** The first
   version styled `.project-card`, which only the design harness renders; Home
   renders `.project-row`, and the smoke's Home probe recorded `cards: 0` while
   still passing because nothing consumed that fact. Fixed: `.project-row` and
   `.project-row--selected` are styled, the probe measures `.project-row`, and
   three checks now fail if the production row is untreated or identical between
   intensities.
2. **The contrast check compared tokens, not pixels.** It read `--ink` and
   `--surface` from the root, so it could not detect a regression in a tinted
   turn surface and reported identical numbers for Vivid and Quiet. Fixed: the
   probe resolves each element's real background (walking up and compositing
   translucent ancestors over white) and the smoke asserts six painted pairs in
   all four combinations. That fix immediately exposed a real measurement bug —
   an unanchored `/rgba?\(/` also matches the `rgb(` inside `color(srgb …)`,
   yielding `NaN`, which JSON reports as `null`. Both are corrected, and the
   artifact now carries real ratios.
3. **Two defects were found by looking at the captures:** a stack of pending
   cards pushed the console and composer out of the immersive window (now bounded
   at 38vh with its own scrolling), and an option description rendered flush
   against its label (`npmcreates package-lock.json`; now a separate line).

The reviewer also noted that the R06 report had claimed "before/after" evidence
it did not hold; that claim is gone.

## What R06 deliberately did not do

`smoke:shell` was **not** re-run for its captures. It was executed once for
behaviour on these bytes and passed (`ok: true`; log kept as
`r06-r10-shell-smoke-run.txt`), then its 24 rewritten product captures were
restored to their committed bytes. Those captures show pre-R06 chrome and are
hash-pinned per prompt; R12 owns that reconciliation, as it did for R05. Nothing
in the product ledger was re-recorded or lowered.

## Known limits

- Pending cards in the R06 captures come from stored rows with no live session,
  so their buttons are disabled with the stated reason. The *answerable* card is
  proven by the R07 unit tests and `r07-pending-smoke.json`, not by a screenshot.
- The capture set is one window size (1280×800) plus 200 % zoom. Narrow widths
  and multi-monitor scaling are R11's scope.
- "No idle CPU regression" is evidenced by zero running animations, not a
  profiler trace.
- The Home row's Vivid difference is a border colour and a shadow; the Home
  screen's layout is deliberately unchanged, because Home is a reading surface.
