# Mona design system — Daybreak and Afterglow

**Version:** P06 · **Source of truth:** `src/renderer/design/tokens.ts` ·
**Styles:** `src/renderer/styles.css` · **Harness:** `src/renderer/design/Harness.tsx`

Mona is a luminous working studio, not a dark admin template. Brightness lives
in intentional accents and project identity; surfaces stay calm. Both themes use
the same information architecture, components, spacing, and keyboard map.

## Art direction

- Warm pearl Daybreak is the default; deep indigo Afterglow is a peer theme, not
  a tinted afterthought.
- Violet carries primary action and focus. Sea-glass confirms success. Amber
  marks attention. Coral is a selective identity/highlight accent, never the
  only carrier of an error.
- Status is always text + icon + color. No meaning is encoded in hue alone.
- Native macOS chrome, Command-key conventions, system fonts, and local inline
  SVG icons. No icon font, remote font, or network asset.

## Color tokens

| Role                        | Daybreak              | Afterglow             |
| --------------------------- | --------------------- | --------------------- |
| Canvas                      | `#F7F8FC`             | `#12142A`             |
| Surface                     | `#FFFFFF`             | `#1B1E3A`             |
| Raised surface              | `#FFFFFF`             | `#232748`             |
| Sunken surface              | `#EEF1F8`             | `#0D0F20`             |
| Ink                         | `#18213B`             | `#EDEBFF`             |
| Muted ink                   | `#53617A`             | `#B4B2D6`             |
| Primary                     | `#6346DF`             | `#A78BFA`             |
| On primary                  | `#FFFFFF`             | `#1A1233`             |
| Success                     | `#007B70`             | `#5BE3B0`             |
| Success soft / ink          | `#E3F4F1` / `#005A52` | `#12352C` / `#8FF3CF` |
| Attention soft / ink        | `#FFF1D6` / `#8A5700` | `#3A2A14` / `#FFD9A3` |
| Danger                      | `#B8324C`             | `#FF8FA3`             |
| Danger soft / ink           | `#FCE8EC` / `#8E2338` | `#3A1D27` / `#FFC2CD` |
| Accent (decorative)         | `#D94A66`             | `#FF8FA3`             |
| Border / interactive border | `#DCE2EF` / `#7C8AA3` | `#33375F` / `#6A70AD` |
| Focus                       | `#6346DF`             | `#B9A4FF`             |

The specification's starting coral (`#D94A66` on white = 4.10:1) was moved to a
decorative/accent role; normal danger text uses the darker `#B8324C` (5.84:1 on
white). Interactive borders were strengthened from the pale layout border to
`#7C8AA3` (3.29:1 on canvas) because WCAG 2.2 non-text contrast applies to input
boundaries. Afterglow equivalents were chosen and measured the same way.

### Measured contrast

`test/design-tokens.test.ts` audits **23 foreground/background pairs in both
themes**: 16 normal-text pairs at 4.5:1 and 7 non-text/UI pairs at 3:1. All pass.
Lowest measured ratios:

- Daybreak: input border on canvas **3.29**, success icon on canvas **4.87**,
  attention ink on soft **5.46**, muted text on sunken **5.53**, danger button
  label **5.84**, link text on canvas **5.70**, ink on canvas **15.00**.
- Afterglow: input border on surface **3.51**, link text on surface **5.97**,
  primary button label **6.55**, muted text on surface **7.95**, ink on canvas
  **15.47**.

Automated axe checks run separately for semantics (labels, roles, ARIA,
landmarks). Axe's color-contrast rule is disabled under jsdom because there is no
layout engine; contrast is measured directly from the token pairs instead. This
is a measured pass, not an assertion that an automated scanner certifies the
product.

## Typography and rhythm

- UI: `-apple-system`, `BlinkMacSystemFont`, `"SF Pro Text"`, `"Helvetica Neue"`,
  Arial, sans-serif. Mono: `ui-monospace`, `"SF Mono"`, Menlo, Monaco.
- Body 15 px comfortable / 14 px dense; line-height 1.5; headings 17.5–28 px
  with tight tracking; eyebrow 10 px uppercase.
- 8 px spacing rhythm (`4/8/12/16/20/24/32/40`), 12–16 px panel corners, one
  restrained shadow family.
- Long paths wrap (`overflow-wrap: anywhere`) or truncate with a `title` and
  never force horizontal page scrolling.

## Density, scaling, motion

- `data-density="comfortable|dense"` changes card padding, control height, row
  gap, and small text — not the information architecture.
- Layout reflows at 1180 px (home/studio/blocker stack), 940 px (rail becomes an
  icon-only top bar), and 640 px (identity/facts stack). Verified at 1280×800 and
  at real 200% browser zoom (640×400 CSS viewport), with zero horizontal page
  overflow in both themes.
- Motion: 120 ms controls, 160 ms panel entry, 180 ms ceiling. No infinite
  animation. `prefers-reduced-motion: reduce` and the harness
  `data-reduced-motion="true"` switch collapse animation and transition duration
  to effectively zero.

## Components

| Component                                  | Contract                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button                                     | `primary/secondary/ghost/danger`, `md/sm`, optional leading/trailing icon; disabled is visually and functionally distinct; 36 px (30 px small) target |
| IconButton                                 | `label` is required and becomes `aria-label` + `title`; never icon-only without a name                                                                |
| Field / TextField / TextArea / SelectField | label is associated by `id`/`for`; hint and error are connected with `aria-describedby`; `aria-invalid` on error; mono variant for paths              |
| Tabs / TabPanel                            | roving `tabindex`, Arrow/Home/End, `aria-selected`, `aria-controls`, visible focus on the selected tab                                                |
| Dialog                                     | `role=dialog`, `aria-modal`, labelled/described, focus trapped, Escape closes, focus restored to the opener                                           |
| Menu                                       | `aria-haspopup`/`aria-expanded`, `role=menu`, Arrow/Home/End navigation, Escape closes and returns focus                                              |
| Notification / Callout                     | tone plus icon plus text; danger uses `role=alert`, other notifications `role=status`; callouts are static notes                                      |
| Badge / StatusBadge                        | text label always present; tone never the only signal; work statuses map to Unstarted/Running/Paused/Blocked/Completed/Failed/Interrupted/Unknown     |
| Card / Inspector                           | semantic section with heading; inspector is a labelled complementary region; one inspector at a time                                                  |
| EmptyState                                 | states what is absent and the next safe action; never a fake success                                                                                  |
| Skeleton                                   | `role=status` with a label; static blocks, no shimmer loop                                                                                            |
| ErrorState                                 | `role=alert`, plain-language title, message, next action                                                                                              |
| SegmentedControl / Switch                  | `aria-pressed` / `role=switch` + `aria-checked`, visible text label                                                                                   |
| KeyCap                                     | displays Command-key shortcuts without intercepting them                                                                                              |

## Screen coverage

Fixture-backed screens (clearly labeled **TEST FIXTURE — NOT LIVE STATE**):

- **Home** — pinned/recent projects, health badges, needs-attention list,
  deterministic "since you left" digest; empty state for a first folder.
- **Studio** — compact project/model/spend dashboard, observed activity signal,
  internally scrolling transcript, and a composer with top-mounted controls.
  The former inspector and bottom strip are removed from the live Studio.
  Telemetry carries exact totals and diagnostic detail. The original design
  harness remains a historical fixture; `test/fixtures/studio-deck.tsx` renders
  the current Studio with explicit local test records for geometry checks.
- **Work board** — Running, Unstarted, Needs attention, Verified lanes; long
  titles, dependency chips, no invented percentages, blocker handoff.
- **Cost lens** — observed spend with an explicit "at least" qualifier, unpriced
  rows, cache evidence, budget empty state, calculation rules; unknown is never
  zero.
- **Blocker** — problem, impact, three attempts with hypotheses/actions/observed
  results and evidence links, affected requirements, specific help needed,
  acknowledge-does-not-clear, nonblocking issue.
- **Settings** — Route, Runtime, Privacy, Recovery tabs; long paths, permission
  labels, missing-credentials/disconnected states, destructive restore
  confirmation.

## Keyboard map (harness)

- `⌘1`…`⌘6` switch screens; `⌘K` opens the command palette.
- `Tab`/`Shift+Tab` traverse in DOM order; skip link is first.
- `⌘⇧D` toggles density; `⌘⇧T` toggles theme; `⌘⇧M` toggles reduced motion.
- Tabs use Arrow keys; menus use Arrow/Home/End; dialogs trap focus and close on
  Escape.

## Zero-inference and zero-asset rules

`test/design-no-network.test.ts` scans every renderer source for `fetch`,
`XMLHttpRequest`, `sendBeacon`, `WebSocket`, remote `@import`, `@font-face`,
remote script/stylesheet/image URLs. None exist. The content policy remains
`default-src 'self'` with `connect-src 'none'`. The harness reads the app version
through the existing narrow bridge only; it makes no inference call.

## Harness boundary

The harness is a visual development instrument. It is not a production fallback:
the banner is always visible, fixture data is labeled at the source, and P07
replaces the harness with the real catalog, supervisor status, and project state.
Human aesthetic review remains a final-QA activity; this prompt records measured
contrast, automated semantics, keyboard behavior, and actual rendered screenshots
without claiming that a human review already occurred.
