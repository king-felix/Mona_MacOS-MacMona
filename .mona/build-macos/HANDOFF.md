# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-12 (P20) · `monabuild validate` clean
**Current prompt:** P20 completed. `monabuild next` reports two eligible
prompts: **P21** (the packaging prompt, the natural next step) and **P25**
(shared-core/Windows coordination audit, which depends only on P20). Neither is
started or authorized in this session.

## Where the build stands

P00–P13 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, a prompt work board and
durable continuation, an enforced attempt ledger, a durable cost ledger,
trustworthy change receipts, Git review, and native restore. P14 adds the
daily-use polish, P15 makes native agent work visible and controllable, P16/P17
complete configuration and extensions, P18 adds the integrated terminal, the
command palette, and an auditable capability explorer, and P19 adds project
memory, the prompt shelf, portable handoff, and diagnostics.

### P20 — Recovery, security, and failure testing

Six real defects found by adversarial testing, each with a reproduction and a
root-cause repair. **No feature was disabled, no test removed, no trust
widened.**

- **P20-06 (critical)** — `native/macos-supervisor/main.swift`: `emit` used
  `FileHandle.write`, which aborts on `EPIPE`, and `stopTree` emits *before* it
  signals. A `SIGKILL`ed Electron therefore orphaned the entire runtime tree to
  `launchd`. `emit` now uses `write(2)` and discards `EPIPE`. Proven by a native
  test that **fails against the pre-fix binary**, and by a new real
  `SIGKILL` lifecycle phase (27/27 checks).
- **P20-01 (high)** — `src/main/work/git.ts`: `runGit` passed `process.env`, so a
  repository's own `pre-commit` hook could read `DEEPSEEK_API_KEY` and the
  runtime token. `buildGitEnvironment` is an explicit allowlist with a
  whole-token secret filter (and no `SSH_AUTH_SOCK`, since nothing here reaches
  the network); a plain-Git control run proves the leak was real.
- **P20-02 (high)** — `src/main/work/studio.ts`: the pump resumed from the
  *highest* stored sequence, so a frame lost in transport vanished and the
  timeline claimed a complete turn. `ingest` now reports `sequence gap: <range>`
  and replays once from the last contiguous sequence (budget 2 per turn, reset
  by a terminal event), then keeps the gap recorded.
- **P20-03 (high)** — `src/main/state/safe-archive.ts`: extraction followed a
  symlinked parent out of its root. `prepareTarget` lstats every component,
  refuses symlinks, re-checks realpath containment, and writes `O_EXCL`/
  `O_NOFOLLOW`. Closes carried-forward item 89.
- **P20-04 (medium)** — `ARTIFACT_MISSING` is a `StateErrorCode`; a vanished
  artifact is no longer a raw `ENOENT`.
- **P20-05 (medium)** — one `redactHomePath` requires `home + "/"`, so
  `/Users/victor2/...` is no longer renamed to `~2/...`.
- **Adjacent** — an over-budget archive now yields **no** entries (was a
  prefix); `senderIsTrusted` moved to `src/main/ipc-sender.ts` and refuses child
  frames, destroyed senders, and throwing frame getters; the Finder-alias claim
  in the folder policy now matches behaviour (an alias file is refused with
  instructions).
- **New evidence paths** — `scripts/p20-failure-smoke.mjs`
  (`npm run smoke:failure`, 22 checks, in CI), `test/p20-failure-matrix.test.ts`
  (12), `test/work-git.test.ts` +2, `test/work-studio.test.ts` +3,
  `test/safe-archive.test.ts` +3, `test/supervisor-native.test.ts` +1,
  `test/engine-adapter.test.ts` +2, and the lifecycle smoke's main-crash phase.
- **Verification** — 650 tests in 67 files; typecheck, lint, format clean;
  `npm run ci` 20/20 steps including `smoke:failure` and `smoke:lifecycle`.
  Evidence: `docs/evidence/macos/P20-failure-matrix.md`,
  `artifacts/p20-failure-smoke.json`, `artifacts/p20-lifecycle-crash.json`,
  `artifacts/p20-ci.txt`; `docs/decisions/ADR-014`, D-060…D-067.

### P19 — Project memory, portable handoff, diagnostics

- **`docs/decisions/ADR-013`** + **D-054…D-059** — memory is a read over a fixed
  source list; a context preview is Mona's composition, never the provider
  request; the shelf refuses secrets instead of storing them; a bundle is
  records, digests, and pointers; import parses in memory; a restore holds the
  exclusive barrier.
- **`src/main/state/safe-archive.ts`** — a store-only ZIP writer with sorted
  names and fixed timestamps (byte-identical exports) and a fail-closed reader:
  absolute names, `..`, backslashes, control characters, duplicate names,
  encryption, symlinks, device nodes, zip64, CRC mismatches, and oversized
  entries are all refused. `safeJoin` is the only path function extraction may
  use; `extractArchive` never overwrites.
- **`src/main/work/memory.ts`** — `ProjectMemory`: search over tasks, decisions,
  evidence, attempts, problems, threads, artifact metadata, and prompt text with
  a documented deterministic scorer, a per-source count and set digest, a
  bounded on-demand workspace search (extension allowlist, symlinks refused,
  realpath containment, 2,000 files / 8 MiB / 200 hits), the resume packet, and
  the context preview with a literal `exactProviderRequest: false`.
- **`src/main/work/shelf.ts`** — `PromptShelf`: versioned prompts on real change,
  literal one-pass `{{variable}}` substitution, and secret-shaped text refused
  on save, import, and export.
- **`src/main/work/handoff.ts`** — `ProjectHandoff`: a six-entry bundle
  (`manifest.json`, `project.json`, `pointers.json`, `decisions.md`, `README.md`,
  optional `prompts.json`) whose manifest digest covers every entry except
  itself; in-memory import; settings backup/restore; a redacted diagnostics
  preview whose exported bytes are exactly the previewed text.
- **`src/main/state/store.ts`** — `listSettingsScopes` and `restoreSettings`:
  the exclusive barrier, a pre-restore snapshot, a durable journal, one
  transaction, a read-back of every scope, and `expectedRevision` enforced
  *inside* the barrier.
- **`src/renderer/shell/Memory.tsx`** — the Memory screen (Command-9) with
  Search, Prompt shelf, Resume & context, and Handoff & diagnostics.
- **`src/main/work/board.ts`** — `TaskPlan` carries `status`; import reports a
  non-pending status as deferred with its reason (closes item 27).
- **Verification** — 627 tests in 66 files; `smoke:memory` 90/90 on real stores
  with an engine tripwire that proves it is what discovery resolves; shell smoke
  120/120 with `p19-memory-search.png` and `p19-memory-handoff.png`; local CI
  18/18. Evidence: `docs/evidence/macos/P19-memory.md`.

### P18 — Integrated terminal, command palette, capability explorer

- **`docs/decisions/ADR-012`** + **D-049…D-052** — the terminal is owned by a
  native helper, the shell gets an allowlisted environment with no startup
  files, output is inert and bounded, and coverage is computed from rows.
- **`native/macos-pty/`** — `main.swift` + `spawn.c` + README. A standalone
  arm64 Swift PTY host: fd 0/1 raw pty bytes, fd 3 JSON control (resize, kill,
  terminate), fd 4 JSON events. The child calls `setsid()`, takes the pty as its
  controlling terminal, closes inherited descriptors, and dies with its owner
  channel. Built by `npm run build:pty`; no Node addon, no Electron ABI.
- **`src/main/terminal/`** — `buffer.ts` (byte-exact replay ring with exact
  `dropped` accounting), `pty.ts` (protocol, binary resolution,
  `buildShellEnvironment` allowlist), `session.ts` (`TerminalManager`: max 3
  sessions, workspace cwd, write/resize/close, replay, search, a 64 MiB budget
  that ends the session with a reason, redacted read-only log tail).
- **`src/renderer/shell/ansi.ts`** — non-executing transcript parser: CR/CRLF,
  backspace, tab, SGR tones; every other CSI/OSC sequence stripped and counted;
  OSC 8 links become inert text.
- **`src/renderer/shell/TerminalPanel.tsx`** — Shell and Engine-log modes,
  session tabs, real status/exit/cwd/bytes, replay on reconnect, search,
  copy, view-only clear, cols×rows resize, Ctrl-C/Ctrl-D, and the exact
  environment and limits printed under the pane.
- **`src/renderer/shell/palette.ts`** + **Shell.tsx** — local ranking over 8
  screens, actions, projects, prompt favorites, board task prompts, 9 settings
  tabs, and every capability row with an entry point. A capability row shows
  its classification and cost class first; a terminal route only prefills.
  Command-J toggles the terminal, Command-8 opens Capabilities.
- **`src/main/work/capability.ts`** + **`src/renderer/shell/Capabilities.tsx`** —
  inventory validation, computed coverage, read-only drift probe
  (`--version`/`--help`/`features list`), additions/removals, cached projection
  (validated before reuse), and a screen with summary, drift, feature flags,
  filters, and a row detail carrying route, cost, test, and gap.
- **`tools/p18-coverage/reconcile.mjs`** — reconciles all 75 rows with an entry
  point (kind/target/label/tested), status, invocation, help source, test, and
  gap. `--check` runs in the capability smoke. **`entryTargetIsKnown`** refuses
  a target this build does not render.
- **Verification** — 566 tests in 59 files; `smoke:terminal` 31/31 on the real
  helper (controlling terminal, allowlisted env, startup files not sourced,
  `codewhale --version` reachable, resize observed by the child, ring eviction,
  exit code 5, verified close, redacted log, native arm64, no pty dependency);
  `smoke:capability` 17/17 (reconcile in sync, drift clean, 43/43 CLI help
  probes, gaps named, parity not claimed); Electron shell smoke 112/112 with
  `p18-capabilities.png` and `p18-terminal.png`; local CI green.

### P17 — Tools and extensions

- **`docs/decisions/ADR-011`** + **D-046/D-047** — engine-mediated extension
  actions, `If-Match` revisions, project-scope read-only, and plugin trust as a
  terminal action.
- **`src/shared/contracts/extensions.ts`** — scope, provenance, health, action
  (availability + reason + side effect + destructive + revision need), MCP,
  skill, plugin, hook, instruction, command, capability, and gap types.
- **`src/main/engine/adapter.ts`** — typed MCP list/add/control/tools, skills
  list/detail/toggle/install, plugins list/control/install, hooks,
  instructions, workspace trust, and commands. The adapter adds `If-Match`
  headers through `RequestOptions`.
- **`src/main/work/extensions.ts`** — `ExtensionWorkbench`: deterministic
  snapshot with per-section live-or-stored fallback, home/command/URL/problem
  redaction, absolute-executable rule for MCP adds, revision preconditions,
  on-demand tool listing, action gating, workspace trust, skill toggles, plugin
  install/remove, and six named gaps.
- **`src/renderer/shell/ExtensionsSettings.tsx`** — Settings → Extensions with
  MCP, Skills, Plugins, Hooks, Instructions, and Commands tabs, health/tool
  detail, install forms, and known limits.
- **Fixtures** — `test/fixtures/mcp/echo-server.mjs` (minimal stdio MCP) and
  `test/fixtures/plugin/` (one inert skill).
- **Verification** — 494 tests in 52 files; `smoke:extensions` 39/39 with a live
  local server: add, handshake, tools, disable, stale 412, missing executable,
  remove preserving unrelated/unknown config, skill toggle, plugin
  install-disabled/remove. Shell smoke 101/101 including
  `settings_extensions_categories`. Evidence:
  `docs/evidence/macos/P17-extensions.md`.

### P16 — Providers, models, permissions, effective settings

- **`docs/decisions/ADR-011`** + **D-042…D-045** — scoped validated defaults,
  engine switch with backup and stale-read refusal, credential pass-through,
  and redacted diagnostics.
- **`src/shared/contracts/settings.ts`** — provider/model catalogs, credential
  classes, saved route, requested-vs-effective observation, routing policy,
  engine selection, diagnostics, and change receipts.
- **`src/main/engine/adapter.ts`** — providers/models/refresh, runtime config,
  setting write, reload, provider switch, and provider key set/clear. A
  `settingsEngine` cast in main keeps the adapter surface narrow.
- **`src/main/work/settings.ts`** — `RouteWorkbench`: compare-and-swap saved
  default, live route validation (model + published reasoning levels), separate
  engine-default switch with config backup/sha256/receipt, credential
  pass-through that refuses non-writable providers, redacted doctor reports,
  engine selection display, and cached catalogs with read times.
- **`src/main/state/store.ts`** — `putSettingsIfVersion` compare-and-swap.
- **`src/main/engine/runtime-process.ts`** — `CODEWHALE_BIN` must be absolute;
  a bare PATH name is refused.
- **`src/renderer/shell/RouteSettings.tsx`** — Settings → Providers & route.
- **Verification** — `smoke:settings` 22/22 with isolated HOME and no turn:
  live catalogs, unsupported level refused, stale saved/config revision
  refused, backup hash and unknown TOML table preserved, credential value never
  echoed, 53 diagnostics redactions. Shell smoke 101/101 including
  `settings_route_offline`. Evidence:
  `docs/evidence/macos/P16-settings.md`.

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

## Next exact action (P21)

Read spec §3, §14, §19–§21 and the P21 prompt body. P21 packages the product:
a deterministic, offline, self-contained arm64 `.pkg` for `/Applications` plus
the signed service payload under `/Library/Services`. Before starting:

1. Enumerate exactly what the package owns, and keep the developer's config,
   keys, databases, sessions, projects, and test home out of it. There is a
   component manifest and a secret-scan gate to build.
2. Ship the qualified native Codewhale binary, the supervisor, the PTY helper,
   and the Services helper with verified arm64 Mach-O slices and Electron ABI.
   No Homebrew cellar, global npm, Xcode, Rust, or Python dependency.
3. Honour the two carried-forward packaging items: the packaged installer must
   put the Service in `/Library/Services` (item 19), and LaunchServices delivery
   of a `/tmp` bundle is not evidence for a real install location (item 20).
4. EXT-SIGNING is still open: 0 Developer ID identities on this host. Local mode
   must work and must be visibly labelled as development; release mode requires
   P22. Do not block local work on it.

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
16. **The attempt ledger travels in the project handoff** (resolved at P19).
    `project.json` carries `payload.attempts`, so a bundle round-trips attempts;
    the *settings* backup is scopes only and does not.
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
27. **Plan export carries task status** (resolved at P19). A non-pending status
    is reported in `ImportPlanResult.deferredStatuses` and never applied, so a
    plan cannot manufacture a completion (`test/board-plan-status.test.ts`).
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

65. **P16/P17 added two Settings tabs** (`Providers & route`, `Extensions`) and
    added 25 tests; the shell smoke now has 101 checks. The 2026-11-12 P16/P17
    CI run is green (`docs/evidence/macos/artifacts/p16-p17-ci.txt`).
66. **A saved route needs a live engine to validate.** Offline, the last catalog
    is shown with its read time and a save is refused rather than persisted
    unverified.
67. **Engine switch cannot select a named custom `model_provider_id`.** It
    accepts provider kind + model; a named custom route can be a saved
    new-thread default only.
68. **The engine may normalize its config document on first route resolution.**
    Snapshots read the revision after catalog reads and the switch rechecks it
    before writing.
69. **Plugin capability trust has no desktop route.** The HTTP detail redacts
    `review.token`; Mona shows trust state and points at `/plugins trust`.
70. **Project-scope MCP entries are read-only through the runtime.** Mona never
    rewrites `.codewhale/mcp.json`; edits belong to the user/engine.
71. **Skill install is remote-source only** and needs network approval; local
    directories are discovered, not installed. Plugin install accepts a local
    bundle.
72. **No tool-level discovery budget** is exposed on 0.10.2. Mona reports
    server-level enable/disable and makes no token-savings claim.
73. **Hook editing and user-command editing have no desktop route.** Hooks are
    read-only with engine semantics; commands are listed with `host`/`prompt`
    binding. Both are named gaps with a verified terminal/config route.
74. **A config backup can contain a literal key.** A route switch copies
    `config.toml` (mode `0600`) into the product backup directory so the change
    is recoverable. It is never rendered or exported. Mona's own caches hold
    only endpoint authority and credential classes (D-048).
75. **Health is per handshake.** `connected` from the list is shown as
    connected; anything else stays `not_checked` until the user requests one.
76. **Credential scope is session or durable.** Session keys live in engine
    memory and do not survive a restart; durable writes use the engine's own
    store and are refused when the engine does not own the route.

77. **Mona's terminal is a native PTY, not the engine's shell.** `GET
    /v1/terminal/{name}` attaches only (404 for an unknown name), so Mona owns
    its own pane. MONA-CAP-061 stays open with that reason; an attach view for
    engine-owned shells is future work.
78. **The terminal transcript is not a VT100 emulator.** Full-screen programs
    are unsupported and escape sequences are stripped rather than interpreted;
    the pane says so. This is a deliberate security boundary (ADR-012).
79. **Personal shell aliases do not load** (`/bin/zsh -f`). Credentials are
    never read from startup files; the trade-off is printed in the pane.
80. **28 capability rows stay open** — write/destructive/costly operations that
    were not executed in P18, or ones needing input Mona will not invent. Each
    row names its exact route and why; a `verified` terminal row must be run by
    `smoke:capability`, which is why `scorecard` and `session-diagnostics` are
    open rather than green.
81. **Workflows and lanes remain blocked gaps** (`MONA-CAP-018/019`): no `/v1`
    route on 0.10.2, and a terminal button would not fulfil MONA-019.
82. **Coverage describes this build.** A version/commit change shows as drift
    and requires re-qualification; the probe is read-only and never upgrades.
83. **The 36 older shell screenshots were rewritten again** by the P18 shell
    smoke because the rail gained an eighth item. They are current, not stale;
    their hashes were re-recorded at this checkpoint with no assertion removed.
84. **`monabuild secrets` reports two pre-existing false positives** (present at
    HEAD before P18): the captured `p16-p17-ci.txt` contains the build machine's
    home path in pasted output, and `test/settings-workbench.test.ts` contains a
    literal `sk-…` sample used to prove redaction. P18's own files scan clean.
    Rewriting the P16/P17 artifact would change hashed evidence, so it is
    recorded rather than silently edited.
85. **A terminal session ends at quit.** `before-quit` closes every session; a
    desktop crash closes the owner channel, which terminates the shell group.
    No shell is left behind in either path (verified by `ps -p`).

86. **P19 starts no process.** Engine identity for requalification comes from
    the last stored capability snapshot, not a probe. An independent review found
    the original code spawned `codewhale --version` on the main thread while the
    contract said otherwise; the exec is gone, `RequalificationView` carries
    `source` and `localEngine.observedAt`, and the smoke proves its tripwire is
    what `discoverTools` resolves.
87. **No provider-request inspection exists on 0.10.2.** The context preview is
    Mona's own composition; `exactProviderRequest` is the literal `false` and the
    screen says so. This is not closable from Mona's side.
88. **Engine identity is only as fresh as the last capability snapshot.** With
    no snapshot, requalification reports `unavailable` and names the next step
    (run the capability explorer). Nothing refreshes it implicitly.
89. **Resolved at P20** — `extractArchive` now refuses a symlinked parent, a
    symlinked entry name, and a non-regular target, re-checks realpath
    containment, and writes with `O_NOFOLLOW` (`P20-03`).
90. **Search is a substring match, not a query language** — no fuzzy matching,
    no recency weighting, no per-field weights. Deterministic and inspectable was
    the goal; a richer scorer needs its own evidence.
91. **Workspace-search and resume-packet boundaries are untested.** The 2,000
    file / 8 MiB / 200 hit caps and the 8,000-character packet cap are enforced
    and reported, but no fixture reaches them; the shared clipping helper is
    tested through the context guard instead.
92. **A handoff preview and a later export are not byte-identical** — the store
    stamps `exported_at` and the README embeds it. The durable guarantee is
    self-consistency: every entry hashes to the manifest's digest and the
    manifest digest reproduces from those entries.
93. **A settings backup is not a configuration backup.** It holds the versioned
    `settings` table only; `config.toml` remains P16's switch backup, and a
    config backup can still contain a literal key (item 74).
94. **A replace restore preserves credential-named scopes and `prompts:shelf`.**
    That is deliberate, and the confirmation dialog says so; a preserved scope
    appears in the restore receipt's `skipped` list rather than as an applied
    change.
95. **The 36 older shell screenshots were rewritten again** by the P19 shell
    smoke because the rail gained a ninth item. They are current, not stale;
    their hashes were re-recorded at this checkpoint with no assertion removed.
    P19's own captures are `p19-memory-search.png` and `p19-memory-handoff.png`.
96. **The P19 captures show a "notification was not delivered" banner.** The
    headless smoke host refuses notifications (item 43); it is the host's real
    state, not a screenshots-only fixture.
97. **Re-running `smoke:memory` rewrites `p19-memory-smoke.json`,** so its
    recorded hash goes stale. The artifact is a run report: `captured_at` is a
    genuine fact about the run, so byte-stability would mean discarding real
    evidence. The report now redacts the build machine's temp root (`~smoke/…`,
    `~tmp/…`) per item 32, but a re-run still needs
    `monabuild evidence --prompt P19 docs/evidence/macos/artifacts/p19-memory-smoke.json`
    before the next checkpoint. The same applies to every `*-smoke.json` artifact.
    A captured CI log does too: `p19-ci.txt` is `npm run ci` output, which names
    the checkout by absolute path, so it is redacted (`/Users/<name>` → `~`)
    before it is committed. Item 84's two P16/P17/P18 findings are the same class
    left unredacted at the time; P19's own artifacts scan clean.

98. **A smoke report is a run record, so re-running rewrites it.** The P16–P19
    `*-smoke.json` artifacts and the P18 coverage JSON/markdown changed when P20's
    CI re-ran their smokes; their recorded hashes were re-recorded with
    `monabuild evidence` (same class as item 97). No assertion was removed and no
    status was lowered.
99. **`monabuild secrets` still reports four pre-existing false positives**
    (present before P20): two captured CI logs contain the build machine's home
    path (`p16-p17-ci.txt`, `p18-tests.txt`), and `sk-…` samples exist in
    `scripts/terminal-smoke.mjs` and `test/settings-workbench.test.ts` to prove
    redaction. P20's own artifacts scan clean: `p20-ci.txt` redacts
    `/Users/<name>` to `~`.
100. **The main-crash proof uses `SIGKILL`, not power loss.** The supervisor's
    owner-liveness channel is closed by the kernel when the owner dies, which is
    the same event a power cut produces for the *supervisor* — but a real power
    loss also leaves SQLite mid-`fsync`, which is covered separately by the
    crash-writer and, ultimately, by P24 manual QA.
101. **A physical lid-close is still simulated.** `powerMonitor.emit("suspend")`
    drives the real wiring; the lifecycle smoke says so. Real sleep and a second
    macOS account are P24/P26.
102. **`extractArchive` has no production caller.** It is now safe, but import
    still parses in memory (D-056), so the hardening is proven by tests and the
    smoke rather than by a user-reachable path.
103. **Over-budget archives now fail closed for every entry.** That changes
    observable behaviour from P19: a bundle just over the cap previously yielded
    its accepted prefix. Nothing in the product relied on the prefix, and
    `test/safe-archive.test.ts` covers the new all-or-nothing rule.
104. **The supervisor lingers through its grace window after owner death**
    (observed ~2 s at `--grace-ms 2000`). That is correct — it is stopping the
    tree — but a check that samples immediately will see it alive. The lifecycle
    smoke waits for both the tree and the supervisor to settle.

## Key files

- `.mona/build-macos/state.json` — prompt status (P20 completed).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-067.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — MONA-016, MONA-017/018/021/022/023/024/025/026/
  029 satisfied with P14/P15/P17/P18/P19/P20 evidence; MONA-019 keeps the
  workflow/lane gaps and MONA-030 is `partial` (P26 owns the final matrix);
  MONA-006/MAC-002 carry contributions without claiming completion.
- `docs/decisions/ADR-001…014`; ADR-009 is polish, ADR-010 orchestration
  ownership, ADR-011 configuration and extensions, ADR-012 the terminal and
  capability coverage, ADR-013 memory and handoff, ADR-014 hardening and
  failure boundaries.
- `src/main/work/` — `agents.ts`, `attention.ts`, `board.ts`, `capability.ts`,
  `changes.ts`, `control.ts`, `costs.ts`, `cost-math.ts`, `digest.ts`,
  `extensions.ts`, `fingerprint.ts`, `git.ts`, `handoff.ts`, `memory.ts`,
  `notifications.ts`, `polish.ts`, `preferences.ts`, `profile.ts`, `settings.ts`,
  `shelf.ts`, `studio.ts`.
- `src/main/state/` — `safe-archive.ts` is the fail-closed zip reader/writer
  (extraction validates real paths); `portable.ts` holds the project bundle;
  `store.ts` owns the barrier.
- `src/main/ipc-sender.ts` — the pure, testable IPC sender/frame policy.
- `scripts/p20-failure-smoke.mjs` — the 22-check fault-injection smoke.
- `src/main/terminal/` — `buffer.ts`, `pty.ts`, `session.ts`;
  `native/macos-pty/` holds the Swift helper.
- `src/renderer/shell/` — Shell, Home, Studio, Board, Changes, Cost, Agents,
  Capabilities, Memory, TerminalPanel, Settings, ansi, palette, drop,
  FinderIntegration, timeline, visual.
- `scripts/` — `memory-smoke.mjs`, `terminal-smoke.mjs`,
  `capability-smoke.mjs`, `build-pty.mjs`,
  `settings-smoke.mjs`, `extensions-smoke.mjs`,
  `agents-smoke.mjs`, `polish-smoke.mjs`, `board-smoke.mjs`,
  `changes-smoke.mjs`, `cost-smoke.mjs`, `ci.mjs`, `smoke.mjs`,
  `shell-smoke.mjs`, `studio-smoke.mjs`, `engine-smoke.mjs`,
  `lifecycle-smoke.mjs`, `open-smoke.mjs`, `service-smoke.mjs`, build
  scripts.
- `AGENTS.md` — operating contract and commands (rule 3 is the stable
  three-attempt instruction).
