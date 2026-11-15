# Mona Studio flight deck — integration and finish prompts

Prepared 2026-11-15 against `king-felix/Mona_MacOS-MacMona` commit
`344d41c3f154d6461bb82d873d6d3541faaa09b9`.

**This is an implementation handoff, not a request to rebuild Mona.** The supplied
patch already implements the Studio changes. Finish integration and native
qualification on the owner's M3 Mac, then install the verified build. Do not
claim these changes are already in `/Applications` or on GitHub.

## Start or resume

Read `AGENTS.md`, this file, `.mona/build-macos/flight-deck.json`, and the current
`.mona/build-macos/HANDOFF.md`. Inspect `git status --short` and the current HEAD.
If the patch is not integrated, begin F00. Otherwise resume the first unfinished,
unblocked F task. Read only the relevant files and short evidence summaries;
use `rg` rather than repeatedly loading the whole repository or old ledgers.

Complete the current prompt's acceptance checks before reporting or pausing.
Continue with the next eligible prompt when independent work remains. Maintain
`flight-deck.json` with task status, tested source commit, evidence paths, current
blocker, and exact next action after every meaningful checkpoint. Keep the
historical P00–P27 and R00–R15 records separate; they do not prove this revision.
Use the normal macOS ledger tools when accepting new evidence. Never update a
source hash merely to make validation green: rerun the corresponding check first.

You may use the existing full-access work authorization to install ordinary
build/test dependencies and run local checks. Preserve the engine pin, provider,
model, route, permissions, data store, project drafts, and cost accounting. UI
animation and telemetry must make **zero additional provider requests**. Do not
replace Codewhale, add another agent scheduler, buy certificates, publish a
release, or silently push. D-103 and D-111 remain accepted owner decisions.

**Three-attempt rule:** for one problem, record hypothesis, action, result, and
material progress. After three attempts without material progress, stop that
problem and mark it **Needs the Human**. Describe what failed, evidence, impact,
and the smallest decision or help required. Continue independent tasks. Never
redesign around an unresolved defect or weaken an assertion to pass. The build
host's blocked visual preview is documented under EXT-FLIGHT-VISUAL; do not retry
its prohibited browser route. Native QA on the owner's Mac is the intended next
verification surface, not permission to bypass the prior browser restriction.

## Requirements and acceptance contract

| ID    | Required behavior                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FD-01 | The activity signal distinguishes reported reasoning, tool work, response output, waiting, no recent activity, reconnecting/stopped, idle, and Needs the Human.                                        |
| FD-02 | No guessed reasoning, child-agent activity, completion, percentage, heartbeat, or healthy connection. An open turn alone means waiting. Match both current thread and turn.                            |
| FD-03 | After 45 seconds without a recent event/start, stop reassuring animation and say progress cannot be confirmed. This must update even if snapshots stop arriving.                                       |
| FD-04 | Distinct local motion for reasoning, tool work, writing, and waiting; reduced motion and hidden windows stop decorative motion. No inference or provider polling.                                      |
| FD-05 | Normal Studio and Focus fill their available viewport. Transcript and text input scroll internally. Appending output cannot push the prompt or its primary controls below the viewport.                |
| FD-06 | Remove the Task/Requirements/Context inspector from Studio. Keep the durable Work board, requirements/evidence data, and other screens.                                                                |
| FD-07 | Submit replaces Send to engine. Submit, Pause after task/Resume queue, and Interrupt now are visible above the prompt. Secondary actions also live at the top. Use distinct accessible colors.         |
| FD-08 | Preserve Enter for newline, Command-Enter for one submit, IME behavior, slash completion, draft identity/caret, archive-send guards, queue semantics, and uncertain-submission protection.             |
| FD-09 | Reduce clutter: one compact dashboard and one live activity row; exact usage/tool diagnostics under Telemetry; search, favorites, and follow-ups reveal on demand.                                     |
| FD-10 | Successful in-app receipts dismiss after 5 seconds plus a short fade. Pause while hovered, focused, or hidden. Replacement/repeated receipts get a fresh timer. Errors/required input stay actionable. |
| FD-11 | 80–200% page zoom adapts rail, dashboard and composer. At narrow sizes navigation remains reachable through the dashboard command button and Command-K. No horizontal page overflow.                   |
| FD-12 | Native installed-build visual, accessibility, lifecycle, and packaging evidence precedes a completion claim. Linux/DOM tests are not Mac qualification.                                                |

The implementation is in `Studio.tsx`, `AgentSignal.tsx`, `agent-signal.ts`,
`TransientNotice.tsx`, `Shell.tsx`, and `styles.css`. Existing native smoke checks
in `src/main/index.ts` were adapted to the moved controls. This is not a change
to production engine routes. The design keeps Afterglow/Daybreak and Quiet/Vivid,
with luminous violet/mint edges, a compact dashboard, and restrained activity
motion. Protect legibility; do not make everything glow or animate.

## F00 — integrate without losing local work

**Goal:** put the provided implementation onto the current Mac checkout safely.

1. Record OS/architecture, Git HEAD, branch, and dirty paths. Read the existing
   owner handoff and decisions before changing release or engine behavior.
2. Keep the extracted kit as a subfolder of the repository (for example
   `Mona_Studio_Future_Kit/`). Do not copy its files over existing project files.
3. Inspect `Mona_Studio_Flight_Deck.patch`. If the checkout matches the declared
   baseline and affected paths are clean, run `git apply --check` with the actual
   patch path, then `git apply`. If the same changes are already present, verify
   them and skip application. Never apply the patch twice.
4. If HEAD has moved or files are dirty, use a separate integration worktree or
   branch; adapt the patch with a three-way comparison against the declared
   baseline. Preserve the owner's work, especially recent engine fixes. No hard
   reset, forced checkout, history rewrite, or bulk replacement.
5. Read the new `flight-deck.json`. Set F00 complete only when all patch files
   are present, the diff has been reviewed, and the intended changed paths are
   recorded. Commit this integration locally after the secret scan.

**Done:** patch integrated once, working changes preserved, branch/source recorded,
F01 identified as next. No runtime, provider request, or install is needed here.

## F01 — qualify the source and resolve integration regressions

**Goal:** the changed source satisfies the existing architecture and real checks.

1. Use the repository's pinned package lock (`npm ci` when needed). Run
   `npm run typecheck`, `npm run lint`, formatting checks, and `npm run build`.
2. Run the focused tests for agent-signal, agent-signal-clock, transient-notice,
   studio-screen, studio-focus, studio-deck-accessibility, polish-screen, shell-races, and studio-activity.
   Then run the repository's complete native CI (`npm run ci`) on the Mac.
   If preflight stops on stale source-evidence hashes, run the owning checks
   separately, accept only evidence actually reverified on these bytes, rebuild
   the index, and rerun CI. Do not clear that preflight by blindly refreshing
   hashes. The untouched baseline validator passed; this patch has 16 expected
   stale source-hash entries pending legitimate requalification.
3. Do not inherit the Linux exclusions as Mac waivers. Eight failures in four
   test files also occurred on the untouched baseline in the Linux build host:
   runtime-process (3), usage-hud (3), folder-request (1), app-icon (1). Reproduce
   them on the Mac; if still present, diagnose the actual issue and use the
   three-attempt rule. See `docs/evidence/macos/studio-flight-deck/REVIEW.md`.
4. Review event mapping against the pinned engine: `agent_reasoning`,
   `agent_message`/`assistant_message`, item starts/deltas/completions, tool kinds,
   thread/turn identity, pending requests, reconnects, and missing events.
   Completion/interrupt/failure must clear any misleading live activity. No
   `reasoning` label just because a timer is running.
5. Ensure notification tone and text remain one receipt, identical notices
   restart timeout, and failed clipboard/pending responses remain attention.
   Required requests and uncertain-submission reconciliation must never expire.
6. Check the actual native smoke selectors. A layout assertion may change to
   match the new owner requirement (removed inspector/top controls), but retain
   or strengthen checks for geometry, reachability, and state truth. Record any
   necessary migration rather than hiding a failing check.
7. Save commands, exit codes, counts, and source identity. Re-run only checks
   affected by subsequent edits. Run `monabuild secrets` before local commits.

**Done:** native source checks pass, or unresolved independent issues are clearly
recorded as Needs the Human; no source-evidence hash has been falsely refreshed.

## F02 — prove the live layout and polish the actual pixels

**Goal:** the screen is beautiful, usable, and bounded under real display pressure.

Run the actual Electron renderer first. The optional portable fixture is
`test/fixtures/studio-deck.html`; `scripts/studio-deck-smoke.mjs` drives its real
Studio component with local records. Install Playwright as a test-only tool if
needed (`npm install --no-save --package-lock=false playwright`, then its normal
Chromium install). Do not commit a changed lockfile for an optional tool.
`node scripts/studio-deck-smoke.mjs` writes into `out/studio-deck` by default.
These fixture results are labelled fixtures, not evidence of live provider work.

Inspect normal Studio, Focus, and native fullscreen on the M3 at 100%, 125%, 150%,
and 200%, both a laptop-size window and a smaller window. At minimum include
1440×900, 1280×800, and the logical size corresponding to 200% on the owner's
normal window. Use real `webContents.setZoomFactor`/Mona menu controls for native
qualification; a narrower browser viewport is only a useful approximation.

For each layout:

- Capture before/after bounding boxes for the viewport, timeline, textarea,
  Submit, Pause, and Interrupt. Append 1,200 events and an 8,000-line single
  streaming item. The page must not grow; the textarea's bottom must not move
  with output. The tail must remain reachable **inside** the console.
- Scroll up while work streams: reading stays anchored and Jump to latest works.
  Check item expansion, long tool output, horizontal code overflow, history
  paging, search results, and switching threads without losing draft/caret.
- Resize the composer using pointer, arrows, Home, and End. Then shrink the
  window and change zoom. Re-clamp to the available height. Submit/Interrupt must
  remain visible and hit-testable, not merely present in the DOM.
- Test the slash menu near both viewport edges. No clipping under a hidden
  overflow ancestor. Enter adds a newline and Command-Enter submits once.
- Open Telemetry, Favorites, Follow-ups, and Search. Keep panels scrollable and
  dismissible; Escape closes the local panel before leaving Focus. Required
  approval cards remain reachable even with multiple requests and large text.
- Check the compact navigation command button at narrow sizes. Do not trade
  zoom responsiveness for an inaccessible screen switcher.
- Compare Daybreak/Afterglow and Quiet/Vivid. Keep primary text legible, disabled
  controls distinguishable, keyboard focus visible, and accents attractive.
  Check reduced motion both in macOS and Mona Settings; nothing should flash.
- Reproduce reasoning/tool/writing/waiting with local replay, then a quiet stream
  (no updates for >45 s), reconnect, stopped process, and pending input. No green
  pulse on stale/disconnected state. If current live work exists, observe it
  without submitting extra prompts merely to exercise chrome.
- Verify five-second routine notice dismissal, hover/focus pause, replacement,
  and required-warning persistence. Notices must not move the transcript.

If actual pixels reveal a layout defect, fix the layout directly and repeat the
affected cases. Do not restore page scrolling, hide essential controls, shrink
text to unreadable sizes, or remove the stress case to pass. Record screenshots
with source build, zoom, viewport, and fixture/live provenance. Measure idle
CPU/memory and active animation impact; prevent background busy loops.

**Done:** geometry, reachability, motion, and visual evidence pass. If the owner
must judge aesthetics or VoiceOver personally, mark those specific checks
Needs the Human and finish the automated work without declaring them passed.

## F03 — package, install, and verify this exact source

**Goal:** the owner launches the changed app from Applications, not an old build.

1. Commit the verified source locally. Run the established `npm run mac:install`
   loop and required local packaging verification. Follow the actual scripts and
   current decisions; do not revive certificate/notarization work declined in
   D-103. Do not claim a universally trusted shareable package.
2. If an active agent session prevents safe restart, stop here with a precise
   Needs the Human handoff. Do not kill work to install cosmetics. If macOS needs
   an administrator credential, let the human enter it; never collect it.
3. Verify `/Applications/Mona.app` build identity against the new source and
   package receipt. Launch that installed copy through LaunchServices. Repeat
   the focused zoom/long-output/submit-controls smoke against the installed app.
4. Check launch/restart, Focus preference persistence, native fullscreen entry
   and exit, and a draft surviving layout changes. Verify normal engine operation
   and that UI activity produces no provider requests. Keep secrets out of logs.
5. Retain a rollback path to the prior installed build; do not remove project
   state, engine credentials, or `~/.codewhale`.

**Done:** verified package and installed copy match the source, with checks and
remaining human items recorded. No inferred success from `npm run build` alone.

## F04 — durable handoff and the final human pass

Update the owner guide, changelog, build handoff, relevant source/evidence records,
and `flight-deck.json`. Keep earlier evidence historical and revalidate the
current claim. Run the ledger validator after legitimate evidence acceptance;
report remaining mismatches instead of silently refreshing hashes.

Leave only genuine human checks: VoiceOver spoken walkthrough, preference on
visual style, and any native action that could not be automated. The interface
and report must use **Needs the Human**, never a particular person's name.

Final report: source/build identifiers, package and installed location, changes,
checks passed, baseline/environment limitations, exact remaining decisions, and
rollback. Include representative installed-build captures with zoom. Do not say
"fully verified" while any required F02/F03 gate is pending. State the next
eligible prompt, or `none` only after this queue is actually finished.
