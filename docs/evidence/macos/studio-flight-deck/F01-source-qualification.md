# F01 — source qualification on the Mac

Captured 2026-11-15 on macOS 26.5.1 (arm64), Electron 45.3.0, Node v26.13.0.
Source: this branch, `studio-flight-deck`, after the integration commit plus the
qualification fixes recorded in `F02-native-layout.md`.

## Checks and what they returned

- `npm run typecheck` → exit 0. Transcript: `mac-typecheck.txt`.
- `npm run lint` → exit 0, 0 errors, 3 pre-existing `no-explicit-any` warnings in
  `engine-adapter`, `engine-orchestration` and `work-agents` tests. `mac-lint.txt`.
- `npm run format:check` → exit 0 (after formatting `test/fixtures/studio-deck.html`,
  which arrived unformatted). `mac-format.txt`.
- `npm run build` → exit 0; the existing large-bundle advisory remains. `mac-build.txt`.
- `npm run test` (vitest) → **1,189 passed in 108 files**, 0 failed. The full
  native run, not a Linux exclusion list.
- `npm run ci` → all 23 steps pass; transcript `mac-ci.txt`.
- `npm run smoke:commands` → 33/33 checks. `mac-command-smoke.txt`.
- `npm run smoke:r11` → `status: passed_with_exception`, `ok: true`. The only
  failing check is `idle_memory_under_350_mb`, reported by the harness as a
  **budget exception** because an empty Electron window on this host already
  measures 362 MiB against a 350 MiB target; the measured idle total was 579.2 MiB
  and idle CPU averaged 0.04 %. `mac-r11.txt`.

## The eight baseline failures the kit warned about did not reproduce

`IMPLEMENTATION_REVIEW.md` recorded eight failures in four files on its Linux
build host (runtime-process 3, usage-hud 3, folder-request 1, app-icon 1) and
excluded those files. On the Mac, **all of them pass**: the full suite is green
with no exclusions, so nothing was waived here.

## Real defects the native checks found, and their fixes

Everything below was a genuine mismatch between the new deck and an existing
assertion or layout, not a test to be relaxed.

1. **`smoke:commands` — two stale selectors.** The command smoke still read
   `[data-testid="studio-connection"]`, which the deck removed, and matched the
   prose "Not started". Both checks now read
   `[data-testid="agent-signal"]`'s `data-connection` attribute and require the
   exact `not_started` state — a stronger assertion than a substring of a label.
2. **`smoke:commands` at 200 % — the list collapsed to one clipped row.** The
   deck's taller composer left just enough panel height for the detail pane to
   render and starve the list (`body_height: 18.5`). The list now has a 96 px
   floor and the Studio drops the detail pane below
   `COMMAND_MENU_DETAIL_MIN_PANEL`; the list body measures 96 px at 200 % and
   183.7 px at 100 %, and the smoke passes.
3. **`smoke:history` — the same stale connection selector, plus a runtime that
   the harness must not start.** The check now reads the signal's state attribute
   and additionally asserts the supervisor is not running.
4. **`smoke:r11` — four checks encoded the *old* layout contract.** They asserted
   a page-scrolling document (`window.scrollY > 0`, `document_scrollable: true`)
   and a console floor that the deck deliberately trades for keeping the prompt on
   screen. They were migrated, not deleted:
   - the title bar must be opaque over content that has scrolled beneath it, which
     now happens inside the console (`console_scrolled`);
   - at 200 %, the console must keep a usable floor **and** the composer must be
     fully visible in a document that does not scroll — a condition the pre-deck
     build failed (`composer_bottom_within_viewport: false`);
   - at the reference window, the console floor is 240 px with the composer fully
     visible and no page scroll (the old build needed 350 px of console because it
     scrolled the whole page).
   The idle-memory target is untouched: still measured raw, still reported as a
   miss, with the host's own Electron floor beside it.
5. **Four unit tests asserted the removed always-visible utility row.**
   `studio-screen` and `studio-focus` now assert the primary controls in the bar
   and the secondary actions in the on-demand panel, which is the owner's FD-09
   requirement; two new tests cover the disclosure and the grip's reported range.

## Event-mapping review against the pinned engine (0.10.2)

Read `agent-signal.ts` against the adapter's event vocabulary:

- Phases require an event whose `threadId` **and** `turnId` both match the
  snapshot; browsing another conversation cannot animate old work.
- `turn.completed`, `turn.failed` and `turn.interrupted` clear every open item, so
  a finished turn cannot leave a live animation.
- `item.completed`/`failed`/`interrupted` close their item, including the legacy
  unidentified-delta case (joined only within one kind, never across tools).
- Item kinds map to reasoning / tool (`tool_call`, `command_execution`,
  `file_change`, `web_search`) / writing (`agent_message`, `assistant_message`);
  an open turn with no open item is `waiting`, never progress.
- A turn with no timestamp anchor reports `quiet` — "progress cannot be
  confirmed" — and a 1 s local clock reaches that state with no new snapshot.
- Pending/sending/unknown requests force `Needs the Human` and stop animation;
  `not_started`/`stopped`/`failed`/`reconnecting` never animate.
- No engine call, poll, or provider request is added anywhere in this path; the
  clock is `Date.now()` in the renderer and stops when the window is hidden.

## Ledger

`monabuild validate` still reports 16 stale source-evidence hashes for the
**historical** P02–P27 records whose files the new Studio legitimately changed.
They were not refreshed: those hashes describe checks that ran against the old
bytes, and F01 ran different checks. They stay stale and visible rather than being
made green. The flight-deck queue is tracked separately in `flight-deck.json`.

## Also fixed while qualifying (same files, same evidence)

- `prefers-reduced-motion` now stops the deck's orb decoration in the emulated
  native setting (0 running animations, measured in F02).
- Contrast of primary text on the deck's surfaces measured 15.91 / 13.86 / 13.86:1
  across Daybreak-Vivid, Afterglow-Vivid and Afterglow-Quiet.
