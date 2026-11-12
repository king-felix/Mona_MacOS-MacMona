# P14 — Daily-use polish without inference overhead

**Date:** 2026-11-12 · **Prompt:** P14 · **Requirements:** MONA-017, MONA-029
(contributes to MONA-006 and MAC-002)

## What this prompt delivers

- **Resume Brief** — current prompt and status, unresolved blocker with both
  attempt counters, test result, changed-file accounting from receipts, spend
  confidence, and the exact next action, all derived from stored records.
- **Since you left** — deterministic grouping of completions, blockers, observed
  tests, session changes, and attention events after a per-project watermark.
- **Focus Mode** — one task, the timeline, the composer, and the emergency
  control strip; the inspector and secondary facts step aside. Stored per
  project; Escape leaves it.
- **Saved layout and density** — screen, inspector tab, studio mode, Focus Mode,
  theme, and density persist (theme/density locally; layout per project).
- **Project identity** — the measured accent palette and a one- or two-character
  monogram, editable from Home, validated against markup.
- **Prompt favorites** — inert local text with an exact-text preview and an
  update-by-text rule; inserting never sends.
- **Keyboard flow** — Command-1…6 screens, Command-K palette, Command-O open,
  Command-Shift-F Focus Mode, Command-Shift-B blockers, Command-period interrupt,
  Command-/ shortcut list, plus Command-W close and Command-Q quit.
- **Attention** — menu-bar title and tooltip, Dock badge, blocker and completion
  counts, and a native menu with Open / Interrupt / Blockers / Quit.
- **Notifications** — completion, blocker, and limit alerts derived from stored
  state, deduplicated in durable state, redacted by default, with quiet hours in
  a stated IANA zone and a receipt that records what the system actually did.
- **Lifecycle** — close keeps work, Dock reopen restores the same runtime, Quit
  is explicit and interrupts first; launch-at-login is off until chosen;
  keep-awake is one assertion scoped to observed active work.

## Architecture

`src/main/work/digest.ts`, `notifications.ts`, `attention.ts`, `preferences.ts`,
`polish.ts` hold the main-process logic. `attention-host.ts` and
`notification-host.ts` are the only files that touch Electron's tray, Dock
badge, login item, power blocker, and Notification APIs; each reads back real
state rather than assuming success. Renderer surfaces are the Home Resume Brief,
the Studio Focus Mode and favorites row, and the Settings **Attention** tab. IPC
is a narrow set of `polish:*` channels — reads and explicit preferences only.
`docs/decisions/ADR-009-polish-digest-and-attention.md` records the reasoning.

No schema migration was needed: preferences, favorites, the seen watermark, and
notification keys live in the existing versioned `settings` table, so P14 adds no
new durable structure.

## Verification

Measured on this host (macOS arm64, Electron 45.3.0).

- **Unit and integration tests:** 433 in 47 files, all passing —
  `docs/evidence/macos/artifacts/p14-tests.txt`. New: `work-digest` (7),
  `work-notifications` (14), `work-attention` (6), `work-preferences` (6),
  `work-polish-service` (4), `polish-screen` (5), plus 4 IPC contract cases.
- **Polish sample run:** 23/23 checks against a real SQLite store and a real Git
  repository, with no engine and no provider call —
  `docs/evidence/macos/artifacts/p14-polish-sample.json`. Keep-awake is exercised
  through `PolishService`, not the class alone.
- **Real Electron shell:** 81/81 checks — brief from stored state, attention
  settings, Afterglow Focus Mode, a real notification attempt with its real
  receipt, the shortcut list, and a notification-focus message —
  `docs/evidence/macos/artifacts/p14-shell-smoke.json`.
- **Lifecycle:** 22/22 including menu-bar installation after Dock reopen —
  `docs/evidence/macos/artifacts/p14-lifecycle-smoke.json`.
- **Local CI:** format, lint, both typechecks, supervisor and Service builds,
  tests, build, and five sample smokes green with a clean renderer secret scan —
  `docs/evidence/macos/artifacts/p14-ci.txt`.

### Acceptance checks from the prompt

- **Notifications occur once across reconnects.** Candidates are re-derived from
  stored state and deduplicated by durable key. Tests deliver a completion once,
  start a second notifier over the same store, and assert silence. A third test
  fires two refreshes concurrently (main and renderer both observe a terminal
  push) and asserts exactly one delivery, because the notifier serializes per
  project. A quiet-hours alert is recorded as suppressed and is not replayed.
- **Quiet hours and timezone changes behave correctly.** The window is
  half-open, wraps midnight, is evaluated in the stated zone through `Intl`, and
  treats equal endpoints as no window. Tests assert `22:00–07:00` boundaries and
  one instant in `UTC`, `America/Los_Angeles`, and `Europe/Berlin`.
- **Resume Brief matches source records.** The brief's task, blocker counters,
  and next action are asserted against the board snapshot and stored change
  sets. A turn whose engine delta is `unavailable` is named ("1 turn with no
  recorded delta", with the engine's reason) rather than reported as zero
  changed files. A failed observed test command renders as a danger result, not
  a success. A missing receipt source yields "Changes unavailable".
- **Focus Mode retains emergency controls.** The renderer test and the Electron
  smoke both assert the inspector is gone, the control strip and Interrupt now
  remain, the composer stays clickable above the strip, and Escape leaves Focus
  Mode.
- **A notification reopens the right project and evidence.** The notification
  host retains the `Notification` while its click listener is live, and the
  Electron smoke delivers the same `polish:focus` message a click sends and
  asserts the shell selects the project, switches to Changes, and renders the
  receipt list.
- **Navigation uses no inference and stays keyboard accessible.** Every screen,
  Focus Mode, blockers, the shortcut list, and Quit are reachable from the
  keyboard; the shell smoke drives them with real key events. No polish code
  path can submit a turn.

### Screenshots (real application, real state)

- `p14-home-daybreak.png` — Home with Resume Brief and Since you left, Daybreak.
- `p14-settings-attention.png` — Attention tab in Daybreak: categories, details
  off, quiet hours, time zone.
- `p14-settings-attention-native.png` — native state: menu-bar text, badge,
  blocked count, keep-awake scope, login item.
- `p14-settings-receipts.png` — delivery receipts showing the system's real
  answer on this host.
- `p14-studio-focus-afterglow.png` — Focus Mode in Afterglow with a favorite chip
  and the control strip visible.

## Defects found in review and fixed

An independent review of the first implementation found five real defects. All
are fixed, with regression tests where a test can hold the behavior:

1. **Missing delta rendered as "0 files in 0 recorded turns."** A stored
   `unavailable` change set was filtered out before counting, so a turn the
   engine could not describe looked like a turn that changed nothing. Now those
   turns are counted and named with the engine's reason; `test/work-digest.test.ts`
   asserts the label and note.
2. **A failed test command rendered green.** With no acceptance checks, `0 === 0`
   produced a success badge for `Observed: npm test (failed)`. The tone is now
   derived from the observed status first; regression test included.
3. **Keep-awake never engaged during ordinary work.** `refresh` ran only on
   terminal pushes, so a running turn never set the scope. Every non-event push
   (turn start, control, connection) now refreshes, and the smoke proves the
   assertion through the service while work is active.
4. **A refused notification was recorded as delivered.** The receipt read a
   synchronous flag before the system answered. `deliver` now resolves with
   `shown`, `handed_over`, or `failed`, only `shown` counts as delivered, and
   Settings labels each honestly. On this host the real answer is `failed`
   (see the receipts screenshot), which is exactly what the old code hid.
5. **Duplicate alert race.** Main and the renderer both refresh on a terminal
   push; interleaved loads could both see the key as unseen. Refreshes are now
   serialized per project, with a concurrency test.

The review also caught three overstatements in the first draft of this document
(a denied permission producing a suppression receipt, the claimed keep-awake
scope, and the "21/21 menu-bar" claim without an assertion). The lifecycle smoke
now asserts menu-bar installation, and the wording above matches what the code
and artifacts show.

## Honest limits

1. **Notification delivery depends on the macOS permission for Mona.** In this
   headless development context macOS refused the request, and the receipt says
   `system refused`. A user who grants permission sees `shown`; a system that
   accepts without confirming shows `handed over`. Permission denial and a second
   account are P24/P26.
2. **Menu-bar and Dock state are read back, not guaranteed.** A tray that fails
   to install is reported. The menu-bar *appearance* is verified by installed
   state and tooltip, not by a screenshot of the system menu bar, because
   capturing it needs screen-recording permission this build does not request.
3. **A notification click is proven by message and by retained listener**, not by
   a scripted click on a system alert; no automation surface for that exists here.
4. **The brief is only as complete as the records.** It names missing deltas and
   unpriced turns rather than filling them; spend stays incomplete while any turn
   is unpriced.
5. **Quiet hours do not pause work.** Deliberate. A suppressed alert is recorded,
   not queued, and a request already in flight may complete after an interrupt.
6. **Launch at login writes a real login item** when enabled. It is off by
   default and the controller reads the system state before writing anything.
   Install-time verification is P21.
7. **Detailed notification text is opt-in** and can reveal a task title to the
   lock screen; the setting states the trade-off.
8. **The lifecycle smoke now canonicalizes the second-launch path.** P09 resolves
   symlinks before registration and macOS routes temp directories through
   `/private`; the previous string comparison failed on a correct handoff. The
   assertion still checks that the same folder reached the owner, and a new check
   was added rather than any check removed.
9. **No Core preview is claimed.** MONA-017 and MONA-029 now have their evidence,
   but several Core requirements still depend on later prompts (provider routing,
   capability explorer, terminal, packaging). P14 does not declare a shareable
   Core preview.
