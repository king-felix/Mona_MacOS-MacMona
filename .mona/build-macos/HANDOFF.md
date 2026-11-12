# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-12 (P14) · revision 250 · `monabuild validate` clean
**Current prompt:** P14 completed. Next eligible after P14: **P15** — not
started, not authorized in this session.

## Where the build stands

P00–P13 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, a prompt work board and
durable continuation, an enforced attempt ledger, a durable cost ledger,
trustworthy change receipts, Git review, and native restore. P14 adds the
daily-use polish.

### P14 — Daily-use polish without inference overhead

- **`docs/decisions/ADR-009`** — polish is a projection of records; attention is
  local, scoped, and opt-in.
- **`src/shared/contracts/polish.ts`** — digest, catch-up, preferences,
  notifications, attention, favorites, and identity types, with zod schemas for
  every persisted or IPC-carried value.
- **`src/main/work/digest.ts`** — `PolishDigest`: Resume Brief (current prompt,
  blocker with both counters, test result, changed files from settled receipts,
  spend confidence, exact next action, `noCompletionPercentage: true`) and
  "Since you left" (completions, blockers, observed tests, session, attention)
  from stored records only.
- **`src/main/work/notifications.ts`** — derived candidates, durable key
  deduplication, first-run seeding, half-open quiet hours in a stated IANA zone,
  generic default content, suppression receipts with reasons.
- **`src/main/work/attention.ts`** + **`attention-host.ts`** — pure attention
  plan, menu-bar title/tooltip, Dock badge, native menu, launch-at-login read
  back and off by default, one power assertion scoped to active work.
- **`src/main/work/preferences.ts`**, **`notifications`/`polish.ts`** — the
  versioned `settings` table holds preferences, favorites, the seen watermark,
  and notification keys; no migration was needed.
- **Renderer** — Home Resume Brief and catch-up groups, Studio Focus Mode and the
  favorites row, Settings **Attention** tab (categories, details off, quiet
  hours, keep-awake, login item, delivery receipts, quit), identity editor,
  shortcut list.
- **Keyboard** — Command-1…6, Command-K, Command-O, Command-Shift-F,
  Command-Shift-B, Command-period, Command-/, Escape leaves Focus Mode.
- **Lifecycle** — close keeps work, Dock reopen restores the same runtime, Quit
  interrupts first; explicit quit from the menu, the palette, and Settings.
- **Review fixes (D-036)** — an independent review found five real defects, all
  fixed with regression tests: an `unavailable` change delta rendered as "0 files
  in 0 recorded turns"; a failed observed test rendered green; keep-awake never
  engaging during an ordinary turn; a refused notification recorded as delivered;
  and a duplicate-delivery race between main and renderer refreshes.
- **Verification** — 433 tests in 47 files; polish sample **23/23**; Electron
  shell **81/81** with real key events, a real notification attempt, and a
  notification-focus message; lifecycle **22/22**; local CI green including the
  new `smoke:polish`. Evidence: `docs/evidence/macos/P14-polish.md`.

## Next exact action (P15)

Read spec §7 (018/019), §10.3, §11, the P15 prompt body, the capability
inventory, and the P11/P12/P14 control, cost, and attention surfaces. Then:

1. Agent observatory with real parent/child identities, lifecycle, last
   meaningful event, tools/tests, and spend confidence; unknown stays unknown.
2. Native goals, fleets, workflows, runs, artifacts, and supported controls;
   one scheduler per task, default serial execution.
3. Qualify optional parallelism only with isolated worktrees, file/branch
   ownership, aggregate limits, and a merge boundary.
4. Evidence: orchestration ownership ADR, run receipts,
   `docs/evidence/macos/P15-agents.md`; map missing features as gaps.

## Nonblocking issues carried forward

1. **No per-turn engine price** — attribution uses the cumulative thread total;
   an unsplittable total becomes an `unallocated` residual counted once.
2. **No shipped rate table** — until a card is recorded, unpriced routes stay
   unknown and no local estimate is produced (ADR-007).
3. **Quota-billed providers stay unknown** even with a card.
4. **A local budget is not an invoice cap** — a request in flight may complete
   after a stop.
5. **No balance** — never derived from local usage.
6. **Concurrent reservation currency is unproven** — the gate counts in-flight
   slots; a concurrent executor must re-run it per slot (P15/P21).
7. **Tool/API charges are not split out** — the engine reports one total.
8. **Recalculation is preview-only.**
9. **Engine-internal loops are cooperative** (ADR-006).
10. **Turn completion is not auto-projected** — P14's digest reads the board; a
    finished turn still needs its task moved into verification by the operator.
11. **Native workflows are not gated by pause-after-task** — P15.
12. **The attempt ledger is not in the portable bundle** — P19 may extend it.
13. **Confirmed live interrupt remains P08 evidence**; interactive QA is P24/P26.
14. **No automatic runtime start from a Finder handoff** — deliberate (D-019).
15. **Service install scope** — `~/Library/Services` for development; packaged
    installer must use `/Library/Services` (D-020, P21).
16. **LaunchServices ignores `/tmp` bundles** (D-021); P21/P24 verify the pair.
17. **Interactive multi-selection alert and VoiceOver** — P24/P26.
18. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
19. **Single-owner runtime** is enforced; parallel ownership needs an engine
    decision.
20. **Adapter gaps** — approvals, clarifications, steer, artifacts older than
    the recorded turn, terminal, fleet are not adapter operations yet.
21. **Attachments** are disabled in the composer with a stated reason.
22. **Fingerprint is bounded and local** (20,000 files / 64 MB).
23. **Plan export does not carry task status** — P19.
24. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
25. **Supervisor and Service binaries are gitignored** — P21/P22 ship them.
26. **Physical sleep and a second macOS account** — manual QA (P24).
27. **Artifact bytes are not portable** — import reports missing digests.
28. **Evidence generation redacts the build machine's home directory.**
29. **P07/P11/P12/P13 shell screenshots are hash-pinned evidence.** The shell
    smoke rewrites them on every run; they were restored to their committed
    bytes after the P14 run, so P07/P11/P12/P13 stay valid. P14 captures are
    `p14-home-daybreak.png`, `p14-settings-attention.png`, and
    `p14-studio-focus-afterglow.png`.
30. **Whole-workspace restore is not surfaced.** P13 exposes snapshot listing and
    one-file `file-revert`. `POST /v1/snapshots/{id}/restore` and forking
    `patch-undo` remain engine-native gaps (MONA-CAP-063).
31. **Restore needs the live studio.** Without it the checked revert route is
    unreachable; Mona deliberately does not build a local snapshot store.
32. **Snapshot pruning is the engine's** (newest 50 + newest 50 turn
    boundaries); a pruned restore point surfaces as the engine's 409.
33. **Restore cannot undo excluded effects** — build output, dependency
    installs, binaries, `.gitignore` paths, deployments, API writes, installed
    software.
34. **Attribution is evidence, not authorship.** `workspace_delta` and
    `unreceipted` paths may be the user's work and require acknowledgement.
35. **Selected commits use working-tree content.** A file staged and then edited
    needs an explicit `includeUnstaged` choice; partial hunk staging is not
    offered.
36. **No per-call diff when the engine recorded none** — the view says so or
    shows a labelled current Git diff; it never mislabels it.
37. **Binary/large content is not displayed** — binary is reported as binary,
    >16 MiB as oversized; text editing needs a complete, non-truncated window.
38. **Git is local only** — no remote operations, history rewriting, stash, or
    conflict-resolution automation.
39. **Notification delivery depends on the macOS permission for Mona.** A
    receipt records `shown`, `handed_over`, `failed`, or `suppressed` with a
    reason; on this headless dev host macOS refuses, and Settings shows
    "system refused". Permission denial and a second user account are P24/P26.
40. **Menu-bar appearance is verified by installed state and tooltip**, not by a
    system-menu-bar screenshot, because capturing it needs screen-recording
    permission this build does not request. Packaging verifies the login item at
    install time (P21). The lifecycle smoke asserts the install after Dock reopen.
41. **A notification click is proven by message and retained listener**, not by a
    scripted click on a system alert; no automation surface for that exists here.
42. **The Resume Brief is only as complete as the records.** Turns captured
    before P13 have no change receipt; the brief says receipts are unavailable
    rather than showing zero changed files.
43. **Quiet hours do not pause work** — deliberate. Pausing is a separate,
    explicit control, and an in-flight request may complete after an interrupt.
44. **A suppressed alert is not replayed later.** Turning notifications back on
    alerts new events only; the suppression is recorded, not queued.
45. **The lifecycle smoke now canonicalizes the second-launch path comparison.**
    P09 resolves symlinks before registration and macOS routes temp directories
    through `/private`; the previous string comparison failed on a correct
    handoff. The assertion still checks that the same folder reached the owner.
46. **Focus Mode is per project and off by default**; Escape leaves it. The
    inspector returns on the next launch only if the stored layout says so.
47. **39 shared-file evidence hashes were re-recorded at P14** for P00/P02/P03/
    P04/P09/P10, following the P10 precedent: those entries name files later
    prompts changed (`index.ts`, IPC, preload, styles, `package.json`, CI), and
    `monabuild validate` compares content. No requirement status was lowered and
    no assertion was removed; the files were re-verified by the P14 CI run.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 250).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-036.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — MONA-017/029 satisfied with P14 evidence;
  MONA-006/MAC-002 carry a P14 contribution without claiming completion.
- `docs/decisions/ADR-001…009`; ADR-009 is polish/digest/attention.
- `src/main/work/` — `attention.ts`, `board.ts`, `changes.ts`, `control.ts`,
  `costs.ts`, `cost-math.ts`, `digest.ts`, `fingerprint.ts`, `git.ts`,
  `notifications.ts`, `polish.ts`, `preferences.ts`, `profile.ts`, `studio.ts`.
- `src/renderer/shell/` — Shell, Home, Studio, Board, Changes, Cost, Settings,
  drop, FinderIntegration, timeline, visual.
- `scripts/` — `polish-smoke.mjs`, `board-smoke.mjs`, `changes-smoke.mjs`,
  `cost-smoke.mjs`, `ci.mjs`, `smoke.mjs`, `shell-smoke.mjs`,
  `studio-smoke.mjs`, `engine-smoke.mjs`, `lifecycle-smoke.mjs`,
  `open-smoke.mjs`, `service-smoke.mjs`, build scripts.
- `AGENTS.md` — operating contract and commands (rule 3 is the stable
  three-attempt instruction).
