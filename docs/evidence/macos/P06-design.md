# P06 — Mona design system and accessible screens

**Date:** 2026-11-11 · **Status:** complete · **Host:** macOS 26.5.1 arm64 ·
**Runtime:** Electron 45.3.0 / Chromium 156

## Result

Mona has a distinctive, measured design language with two peer themes, a
component set with accessibility contracts, and six fixture-backed screens
covering the product's main views and non-happy states. The renderer is a
clearly labeled visual harness; it makes no engine call and fetches no external
asset.

Verification: **192 tests in 24 files pass**, including **26 new P06 tests**
across token contrast, axe semantics, keyboard behavior, and a no-network source
scan. **15 rendered screenshots** were captured from the real Electron renderer
(2560×1600 physical at a 1280×800 viewport), including both themes, dense and
comfortable layouts, empty/disconnected/blocked/unknown-cost states, and a real
200% zoom shot (640×400 CSS viewport). The keyboard receipt records a visible
2 px focus ring, skip-link-first tab order, `⌘2` screen switching, and a command
palette that traps focus and closes on Escape.

Evidence: `p06-tests.txt`, `p06-full-suite.txt`, `p06-shots.json`,
`p06-keyboard.json`, `p06-*.png`, `docs/design-system.md`.

## Design decisions

- **Tokens are code.** `src/renderer/design/tokens.ts` defines both themes and
  applies them as CSS custom properties. `styles.css` contains structure only.
  The contrast test imports the same tokens the renderer uses, so documentation
  and measurement cannot drift.
- **Measured contrast, not assumed palette.** 23 pairs × 2 themes are audited.
  The specification's coral was moved off normal text (4.10:1 on white) to an
  accent role; danger text uses `#B8324C` (5.84:1). Interactive borders were
  strengthened to `#7C8AA3` / `#6A70AD` to meet the 3:1 non-text threshold.
- **Status is never color-only.** Every badge pairs an icon and a word; the work
  status vocabulary is fixed (Unstarted, Running, Paused, Blocked, Completed,
  Failed, Interrupted, Unknown). No task shows a guessed percentage.
- **No external assets.** Icons are inline SVG in `icons.tsx`; typography is the
  macOS system stack. The source scan rejects `fetch`, XHR, beacon, WebSocket,
  remote `@import`, `@font-face`, or remote script/style/image URLs.
- **Motion is bounded.** 120 ms controls, 160 ms panel entry, 180 ms ceiling; no
  infinite animation. Reduced motion is honored by media query and an explicit
  harness switch.
- **The harness is labeled.** A persistent banner reads **TEST FIXTURE — NOT LIVE
  STATE**; fixture data is also labeled at its source. P07 replaces the harness
  with the real catalog and engine state.

## Screens and states

- Home: pinned/recent projects, long paths, health badges, attention list,
  deterministic digest; empty first-folder state.
- Studio: context bar, 40-event timeline, composer, Plan/Work, inspector tabs,
  persistent execution strip; disconnected and unknown-cost variants.
- Work board: four status lanes, long task names, dependency chips, blocker
  handoff; empty state.
- Cost lens: observed spend with "at least" qualifier, unpriced rows, cache
  evidence, budget empty state, calculation rules.
- Blocker: three attempts with hypothesis/action/observed/evidence, affected
  requirements, specific help, acknowledge-does-not-clear, nonblocking issue.
- Settings: Route, Runtime, Privacy, Recovery tabs; long paths, permission and
  credential states, destructive restore confirmation.

## Automated accessibility evidence

`test/design-components.test.tsx` renders every screen in jsdom and runs
axe-core with the color-contrast rule disabled (jsdom has no layout engine;
contrast is measured by the token test instead). Thirteen renderings — six
screens in the default state, the same six in empty and disconnected states, plus
the full harness — produce **zero serious or critical violations**.

Keyboard tests verify:

- Arrow keys move tab selection and keep focus on the selected tab.
- A dialog contains focus, closes on Escape, and restores focus to its opener.
- A menu opens into `role=menu`, ArrowDown moves to the second item, selection
  fires, and Escape closes it.
- A switch exposes `role=switch`, `aria-checked`, and its visible label.

The Electron keyboard receipt goes further than jsdom:

```text
first_tab:   a "Skip to content"   outline solid 2px  focus_visible true
second_tab:  button "Home"         outline solid 2px  focus_visible true
command_2:   studio
palette:     open, focus inside, title "Command palette"
escape:      dialog closed
```

## Scaling and density

The screenshot manifest records `horizontal_overflow: false` for all 15 shots.
At 200% real Chromium zoom the viewport is 640×400 CSS pixels; the rail becomes
an icon-only top bar, the studio stacks, and the context facts wrap. The fixture
label remains visible. Dense mode reduces padding, control height, row gap, and
small text without changing the information architecture.

## Limitations / nonblocking issues

1. **Human aesthetic review is still pending.** Final QA (P26) collects Victor's
   judgment. This evidence does not claim it already happened.
2. **axe under jsdom has no layout.** It checks semantics/ARIA/labels; contrast
   and clipping are measured separately (tokens and the Electron shot manifest).
3. **Screenshots are harness data.** They are actual renders, not live engine
   state. P07 replaces the harness with real state and supervisor status.
4. **VoiceOver walkthrough** is not performed here; the components use native
   semantics and labels, and the P24/P26 QA pass owns the spoken walkthrough.
5. **No icon-font or display font dependency** was added; future display type
   must remain bundled and permissively licensed.

## Commands run

```sh
npx vitest run test/design-*        # 26 tests
npx vitest run                      # 192 tests / 24 files
npm run build && npm run smoke      # 21/21 checks
electron . --design-shots           # 15 screenshots + keyboard receipt
npm run lint                        # 0 errors
```
