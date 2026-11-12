# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-12 (P15) · revision 284 · `monabuild validate` clean
**Current prompt:** P15 completed. Next eligible after P15: **P16** — not
started, not authorized in this session.

## Where the build stands

P00–P13 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, a prompt work board and
durable continuation, an enforced attempt ledger, a durable cost ledger,
trustworthy change receipts, Git review, and native restore. P14 adds the
daily-use polish, and P15 makes native agent work visible and controllable.

### P15 — Agent observatory and native orchestration

- **`docs/decisions/ADR-010`** + **D-037…D-040** — one scheduler per task,
  read-not-dispatch, serial-only launch, and per-identity spend.
- **`src/shared/contracts/agents.ts`** — run, worker, fleet, receipt, evidence,
  goal, spend-confidence, test-evidence, ownership, parallel-qualification, and
  gap types with zod schemas for every persisted or IPC-carried value.
- **`src/main/engine/adapter.ts`** — 16 methods over `/v1/agent-runs`,
  `/v1/threads/{id}/goal`, `/v1/goals`, and `/v1/fleet/*` with wire validation.
- **`src/main/work/agents.ts`** — `AgentObservatory`: snapshot with per-section
  live-or-stored fallback, fleet detail, receipt evidence, history, agent-run
  cancel, fleet stop, worker stop/restart, goal set/complete/block/clear, and
  one serial native fleet launch that links `task_runs.upstream_id`.
- **`src/main/state/schema.ts`** — migration **v7**: `orchestration_runs`,
  `goal_observations`, `orchestration_events`, and a unique
  `task_runs.upstream_kind/upstream_id` link.
- **`src/renderer/shell/Agents.tsx`** — 7th screen (Command-7): collapsible run
  tree with real identities, inspector with identity/task/branch/event/tools/
  tests/spend/artifacts, goal controls, serial launch form, parallel
  qualification, and capability gaps.
- **Review pass (D-041)** — an independent review found six real defects, all
  fixed with regression tests: a failed route read rendering as an empty list; a
  failed launch returning a result object instead of throwing; pruning stored
  workers when a run's detail load failed; a hardcoded `200` on goal receipts; a
  worker losing its ledger spend/tools/tests when its ledger row named a
  different workspace; and engine controls enabled in a stored view.
- **Verification** — 469 tests in 50 files; fixture suite 13/13 covering child
  failure, disconnect, unknown usage, blocked dependency, cancel, and partial
  completion; **one real serial fleet run** 10/10 (`fleet-dab394c7`, receipt
  `partial`, worker inheriting unknown spend and self-reported tests, readable
  evidence); shell smoke 99/99 with stored observatory captures in both themes;
  local CI green including `smoke:agents`. Evidence:
  `docs/evidence/macos/P15-agents.md`.

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

## Next exact action (P16)

Read spec §7 (008/020), §9, §11 providers, §13, the P16 prompt body, the P12
cost rate-card surface, and the P03/P08 profile plumbing. Then:

1. Provider/model catalogs from `/v1/providers` and
   `/v1/providers/{id}/models`, effective profile display, and credential
   source status without secrets (`credentialSource`/`credentialWritable`).
2. Separate a saved new-thread default from an active thread's route; show
   requested versus effective and never persist an unsupported setting.
3. Keep Victor's DeepSeek Flash route the default; disable automatic expensive
   routing and fallback. Route failure stays on the configured route.
4. Evidence: configuration-scope tests, diagnostics redaction,
   `docs/evidence/macos/P16-settings.md`. Use local fixtures for failure cases
   so no uncontrolled charge is incurred.

## Nonblocking issues carried forward

5. **No per-turn engine price** — attribution uses the cumulative thread total;
   an unsplittable total becomes an `unallocated` residual counted once.
6. **No shipped rate table** — until a card is recorded, unpriced routes stay
   unknown and no local estimate is produced (ADR-007).
7. **Quota-billed providers stay unknown** even with a card.
8. **A local budget is not an invoice cap** — a request in flight may complete
   after a stop.
9. **No balance** — never derived from local usage.
10. **Concurrent reservation currency is unproven** — the gate counts in-flight
   slots; a concurrent executor must re-run it per slot (P15/P21).
11. **Tool/API charges are not split out** — the engine reports one total.
12. **Recalculation is preview-only.**
13. **Engine-internal loops are cooperative** (ADR-006).
14. **Turn completion is not auto-projected** — P14's digest reads the board; a
    finished turn still needs its task moved into verification by the operator.
15. **Native workflows are not gated by pause-after-task** — resolved as a
    stated limit: Mona cannot install a boundary inside a scheduler it does not
    own. `WorkController.pauseAfterTask`'s note and the observatory's
    `goal-continuation-ownership` gap both say so (D-037).
16. **The attempt ledger is not in the portable bundle** — P19 may extend it.
17. **Confirmed live interrupt remains P08 evidence**; interactive QA is P24/P26.
18. **No automatic runtime start from a Finder handoff** — deliberate (D-019).
19. **Service install scope** — `~/Library/Services` for development; packaged
    installer must use `/Library/Services` (D-020, P21).
20. **LaunchServices ignores `/tmp` bundles** (D-021); P21/P24 verify the pair.
21. **Interactive multi-selection alert and VoiceOver** — P24/P26.
22. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
23. **Single-owner runtime** is enforced; parallel ownership needs an engine
    decision.
24. **Adapter gaps** — approvals, clarifications, steer, artifacts older than
    the recorded turn, terminal, fleet are not adapter operations yet.
25. **Attachments** are disabled in the composer with a stated reason.
26. **Fingerprint is bounded and local** (20,000 files / 64 MB).
27. **Plan export does not carry task status** — P19.
28. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
29. **Supervisor and Service binaries are gitignored** — P21/P22 ship them.
30. **Physical sleep and a second macOS account** — manual QA (P24).
31. **Artifact bytes are not portable** — import reports missing digests.
32. **Evidence generation redacts the build machine's home directory.**
33. **P07/P11/P12/P13 shell screenshots are hash-pinned evidence.** The shell
    smoke rewrites them on every run; they were restored to their committed
    bytes after the P14 run, so P07/P11/P12/P13 stay valid. P14 captures are
    `p14-home-daybreak.png`, `p14-settings-attention.png`, and
    `p14-studio-focus-afterglow.png`.
34. **Whole-workspace restore is not surfaced.** P13 exposes snapshot listing and
    one-file `file-revert`. `POST /v1/snapshots/{id}/restore` and forking
    `patch-undo` remain engine-native gaps (MONA-CAP-063).
35. **Restore needs the live studio.** Without it the checked revert route is
    unreachable; Mona deliberately does not build a local snapshot store.
36. **Snapshot pruning is the engine's** (newest 50 + newest 50 turn
    boundaries); a pruned restore point surfaces as the engine's 409.
37. **Restore cannot undo excluded effects** — build output, dependency
    installs, binaries, `.gitignore` paths, deployments, API writes, installed
    software.
38. **Attribution is evidence, not authorship.** `workspace_delta` and
    `unreceipted` paths may be the user's work and require acknowledgement.
39. **Selected commits use working-tree content.** A file staged and then edited
    needs an explicit `includeUnstaged` choice; partial hunk staging is not
    offered.
40. **No per-call diff when the engine recorded none** — the view says so or
    shows a labelled current Git diff; it never mislabels it.
41. **Binary/large content is not displayed** — binary is reported as binary,
    >16 MiB as oversized; text editing needs a complete, non-truncated window.
42. **Git is local only** — no remote operations, history rewriting, stash, or
    conflict-resolution automation.
43. **Notification delivery depends on the macOS permission for Mona.** A
    receipt records `shown`, `handed_over`, `failed`, or `suppressed` with a
    reason; on this headless dev host macOS refuses, and Settings shows
    "system refused". Permission denial and a second user account are P24/P26.
44. **Menu-bar appearance is verified by installed state and tooltip**, not by a
    system-menu-bar screenshot, because capturing it needs screen-recording
    permission this build does not request. Packaging verifies the login item at
    install time (P21). The lifecycle smoke asserts the install after Dock reopen.
45. **A notification click is proven by message and retained listener**, not by a
    scripted click on a system alert; no automation surface for that exists here.
46. **The Resume Brief is only as complete as the records.** Turns captured
    before P13 have no change receipt; the brief says receipts are unavailable
    rather than showing zero changed files.
47. **Quiet hours do not pause work** — deliberate. Pausing is a separate,
    explicit control, and an in-flight request may complete after an interrupt.
48. **A suppressed alert is not replayed later.** Turning notifications back on
    alerts new events only; the suppression is recorded, not queued.
49. **The lifecycle smoke now canonicalizes the second-launch path comparison.**
    P09 resolves symlinks before registration and macOS routes temp directories
    through `/private`; the previous string comparison failed on a correct
    handoff. The assertion still checks that the same folder reached the owner.
50. **Focus Mode is per project and off by default**; Escape leaves it. The
    inspector returns on the next launch only if the stored layout says so.
51. **39 shared-file evidence hashes were re-recorded at P14** for P00/P02/P03/
    P04/P09/P10, following the P10 precedent: those entries name files later
    prompts changed (`index.ts`, IPC, preload, styles, `package.json`, CI), and
    `monabuild validate` compares content. No requirement status was lowered and
    no assertion was removed; the files were re-verified by the P14 CI run.

52. **Checked-in workflows are unreachable natively.** `codewhale workflow` and
    `lane` run JS workflows through a Lane Runtime and expose no `/v1` route on
    0.10.2. MONA-CAP-018/019 are `blocked_gap`; MONA-019 stays `partial`. P18
    owns the coverage decision.
53. **No goal pause route.** Only set/complete/block/clear exist; a live probe
    returned `404` for `POST …/goal/pause`. Mona offers block and clear and says
    pause is unavailable (`p15-goal-probe.json`).
54. **Setting an active goal starts engine work.** Disclosed before the action;
    Mona never drives goal continuation turns itself.
55. **Fleet and sub-agent cost is unknown/not reported.** No token totals on
    fleet records; the sub-agent ledger says `unknown`. No total is derived and
    the view has no additive field (D-039).
56. **Parallel launch is refused.** A live probe showed the engine accepting two
    `parallel` builder tasks declaring the same repository root
    (`p15-parallel-probe.json`), so Mona never runs two builders on one tree
    (D-038).
57. **Only `this_computer` fleet targets.** `another_computer` and `cloud` return
    `501` on 0.10.2.
58. **The 202 cancel path is contract-implemented, not observed.** Every live
    cancellation returned `200` because the run was already terminal; the
    pending case is unit-tested against the documented response.
59. **Probe leftovers in the shared engine ledger.** One completed probe fleet
    run (`fleet-efb4a405`, a 6-character reply) and several cancelled
    never-started runs remain in the engine's own fleet ledger, by design not
    deleted. Mona shows them because they belong to `/tmp` workspaces, not to a
    catalog project.
60. **Sub-agent parentage is upstream-only.** `parent_run_id`/`parent_agent_id`
    is shown when reported; Mona never infers a parent from timing or text.
61. **A run's branch is a local Git read.** The sub-agent record carries a
    workspace but no branch; the observatory reads `HEAD` locally and labels the
    source `local_git`.
62. **Fleet workers are deduplicated against sub-agent rows** by upstream id, so
    one identity is one row (D-040). A worker with no ledger entry keeps its own
    record's fields and shows spend unknown.
63. **P15 re-recorded 69 shared evidence hashes** (P00/P01/P02/P03/P04/P07/P09/
    P10/P11/P12/P13/P14) after legitimate shared-file changes: the new Agents
    screen, the 7-item rail, orchestration IPC, migration v7, the fixture
    capability set, and `package.json`/`scripts/ci.mjs`. All 99 shell checks and
    466 tests pass in the P15 CI run; no assertion was removed and no requirement
    status was lowered.
64. **The 36 older shell screenshots were rewritten by the P15 smoke run** and
    re-recorded, because a 7th rail item changes every capture. They are current,
    not stale; the P15 captures are `p15-agents-daybreak.png`,
    `p15-agents-afterglow.png`, and `p15-agents-inspector.png`.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 284).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-040.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — MONA-017/018/029 satisfied with P14/P15
  evidence; MONA-019 is `partial` (workflows and lanes have no `/v1` route);
  MONA-006/MAC-002 carry contributions without claiming completion.
- `docs/decisions/ADR-001…010`; ADR-009 is polish, ADR-010 orchestration
  ownership.
- `src/main/work/` — `agents.ts`, `attention.ts`, `board.ts`, `changes.ts`,
  `control.ts`, `costs.ts`, `cost-math.ts`, `digest.ts`, `fingerprint.ts`,
  `git.ts`, `notifications.ts`, `polish.ts`, `preferences.ts`, `profile.ts`,
  `studio.ts`.
- `src/renderer/shell/` — Shell, Home, Studio, Board, Changes, Cost, Agents,
  Settings, drop, FinderIntegration, timeline, visual.
- `scripts/` — `agents-smoke.mjs`, `polish-smoke.mjs`, `board-smoke.mjs`,
  `changes-smoke.mjs`, `cost-smoke.mjs`, `ci.mjs`, `smoke.mjs`,
  `shell-smoke.mjs`, `studio-smoke.mjs`, `engine-smoke.mjs`,
  `lifecycle-smoke.mjs`, `open-smoke.mjs`, `service-smoke.mjs`, build
  scripts.
- `AGENTS.md` — operating contract and commands (rule 3 is the stable
  three-attempt instruction).
