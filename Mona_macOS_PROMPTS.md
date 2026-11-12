# Mona for macOS — Execution prompts and durable build protocol

**Version:** macOS 1.0 • **For:** Victor and DeepSeek Flash agents working through Codewhale

**Authoritative requirements:** `Mona_macOS_Project.md` macOS v1.0. These prompts implement that specification; they do not authorize weakening it. Target: Victor’s M3, native arm64, with a signed shareable macOS installer at completion. Research date: November 11, 2026. Current model aliases, engine releases, dependencies, and platform behavior must be verified on the build machine.

## 1. How Victor uses this file

Put `Mona_macOS_Project.md` and `Mona_macOS_PROMPTS.md` in the repository/folder where Mona will be built. Open that folder in your existing Codewhale installation with your working DeepSeek route and Full Access profile. Paste the **first-session prompt** below. In later sessions paste the **resume prompt**. The agent reads the assigned numbered prompt from this file; you do not need to paste the entire document every time.

The default unit of work is **one complete numbered prompt**, including implementation, validation, documentation, and state updates. The agent does not stop after presenting a plan. When that prompt is complete, it reports and pauses. If you explicitly authorize a queue or several prompt IDs, it continues through that selection. Your three-attempt rule always applies.

The Mac files are standalone: retain their filenames and do not replace the Windows specification or its build ledger. Stage in a separate folder such as `~/Developer/Mona-macOS`, or use a separate Git worktree if common Mona source already exists. Native compilation/signing and final validation run on the Mac.

The project is intentionally gated: P00/P01 first establish whether the installed Codewhale can support the promised experience and whether the cost benefit survives. A failed core gate must produce a candid finding, not an attractive mockup passed off as a working product.

### First-session prompt — copy/paste

```text
Build Mona for my M3 Mac in this working directory using
Mona_macOS_Project.md and Mona_macOS_PROMPTS.md. Target native arm64 and
the self-contained signed/notarized installer described there. Keep the
Windows work and .mona/build ledger untouched; use .mona/build-macos.

Read repository instructions, then the operating contract and P00 in
Mona_macOS_PROMPTS.md. Read Mona_macOS_Project.md once to establish scope. Start P00 and
complete its implementation, evidence, state tracking, and handoff before
reporting. Do not merely propose a plan.

You have Victor's authorization to run commands, install needed software,
development dependencies, and useful tool servers, and perform local builds
and tests with Full Access. Preserve my existing Codewhale provider, endpoint,
credentials, model, and project files. Do not buy services, silently switch
models, publish publicly, or invent a remote repository.

Make no more than three attempts at the same problem without material
progress. Preserve the attempt count across sessions. On the third, stop
that problem, record evidence and the precise help needed from Victor, and
continue independent eligible work if available. If it blocks the assigned
prompt or all eligible work, checkpoint and report. Do not architect around
the problem, lower requirements, remove tests, or substitute fake behavior.

Keep .mona/build-macos state, requirement evidence, and HANDOFF.md current. Use
targeted reads and deterministic tools to conserve tokens. Complete P00,
report its result and the next eligible prompt, then pause.
```

### Every later session — copy/paste

```text
Pick up the macOS Mona build where you left off. Target my M3/arm64 Mac
and keep its build ledger separate from Windows. Follow the operating contract in
Mona_macOS_PROMPTS.md and requirements in Mona_macOS_Project.md.

Read repository instructions, .mona/build-macos/state.json and HANDOFF.md, and
the relevant open blockers/attempts. Reconcile unfinished work with the
working tree and actual evidence. Do not reset attempts or repeat completed
work just because this is a new session.

Resume the unfinished current prompt; if it is complete, take the earliest
eligible pending prompt. Read only its relevant specification sections and
files unless document hashes changed. Complete that prompt end to end,
including tests, documentation, evidence, and a durable checkpoint, then
report and pause. Routine authorized installs and local actions do not
need another permission request.

No more than three attempts at one problem without material progress.
Record and stop that problem, involve Victor, and continue independent
eligible work when possible. Never architect around it or fake completion.
```

### Optional explicit assignment

```text
Execute Mona prompt P__ using the operating contract. Check its prerequisites
first; resume existing work instead of starting over. Complete it, verify it,
update durable state and requirement evidence, then report and pause.
```

### Optional queued session

```text
Execute the next three eligible Mona prompts in dependency order, starting
with any unfinished current prompt. Finish each prompt fully and checkpoint
before advancing. The three-attempt rule remains in force. Log nonblocking
issues and continue independent eligible work; report immediately if the
queue cannot progress. Do not expand the scope beyond those three prompts.
```

## 2. Shared operating contract — applies to every prompt

### O1 — Authority and scope

The user wants this built, not another proposal. Run the needed tools and implement the assigned work. Full Access authorizes ordinary local development, dependency installation, tool-server setup, and testing. OS prompts, credentials, paid purchases, public release, or a fundamental design change may still need Victor. Preparing a shareable Mac package is authorized; use already configured signing/notarization credentials to submit the release to Apple when ready. Do not publish publicly. Missing membership or signing credentials must not block independent local development; record the signed-release prerequisite. Do all independent authorized work before reporting an external prerequisite. Respect actual managed/OS restrictions; do not pretend Full Access removes them.

Use the existing repository’s instructions and preserve unrelated user changes. Establish a feature branch if appropriate. Make local checkpoint commits after coherent completed work. Push only when an existing Mona remote and its repository rules clearly authorize it; never use a remembered remote from another project. Do not publish packages, releases, websites, or repositories without authorization.

Do not silently change provider endpoint/model, introduce an AI router, add a background summarizer, or make UI features require paid inference. Do not overwrite credentials or replace Victor’s working engine install. A side-by-side test binary is acceptable only with source/provenance recorded and no silent change of the selected production binary.

### O2 — Efficient execution

Use one bounded implementation plan for the assigned prompt. Search with `rg`, read relevant files, and inspect actual source/help before guessing APIs. Prefer structured tools, compiler results, and tests to explanatory model calls. Batch independent read-only checks; sequence mutations. Keep logs bounded and write large evidence to files with short result summaries.

Keep instructions stable and context selective. Do not load both full documents every session. Bootstrap creates section/requirement indexes and hashes. Subsequent sessions read the handoff, current prompt, relevant requirement sections, and changed source. Local memory is a navigation aid, not a reason to ignore changed requirements.

No mandatory delegation. A single builder is the default. When a child agent would materially help, keep its task independent and tightly scoped, use the same authorized Flash route, give it only required context, allocate a separate worktree for edits when needed, and track aggregate spend and file ownership. Avoid fleets of agents rereading the entire repository. Never delegate away a stuck problem merely to reset its attempt count.

Install MCP/tool servers only when they remove a concrete bottleneck. Record versions, purpose, source, configuration scope, and observed overhead. A local test runner or Git command often needs no server. Do not install unrelated servers in anticipation of possible future use.

### O3 — Three attempts, persistent across sessions

For each unresolved problem create an ID and record: symptom, requirement, hypothesis, action, observed result, evidence path, total attempts, and consecutive attempts without material progress. One attempt is a hypothesis-and-result cycle, not every individual shell command.

Material progress must be demonstrable: a narrowed reproduction, isolated cause, newly passing required behavior, or obtained prerequisite. A different error message or another dependency does not automatically count. Reset only the no-progress count and only with evidence; keep the historical attempts.

At three consecutive no-progress attempts, stop that problem. Record what happened and the exact help needed. Continue independent eligible work if possible, retaining the blocked requirement. If no useful assigned/eligible work remains, report immediately. No alternate architecture, skipped test, fabricated integration, platform substitution, or downgraded requirement may erase the issue. A routine implementation fix is permitted; a workaround that abandons promised behavior is not.

Transient network retries are bounded and counted under the relevant problem when they make no progress. No unbounded polling, restart loops, repeated paid calls, or “one last try.”

### O4 — Start and checkpoint protocol

At start:

1. Read repository instructions and check `git status` if Git exists.
2. Read `.mona/build-macos/state.json`, `HANDOFF.md`, and unresolved issues relevant to the assignment.
3. Validate schemas, file hashes, working tree, and whether a prior running task actually finished.
4. Select explicit assignment, else unfinished current task, else earliest eligible pending task.
5. Check prerequisites by evidence, not a checked box alone. Record the current task and exact next action.

Checkpoint after a meaningful implementation boundary, a newly discovered blocker, a test milestone, and before ending a session. Update atomic state, requirement evidence, decisions, and short handoff. Do not continuously rewrite state after every tiny command; do not wait until a long context is exhausted either.

If state is missing or malformed, reconstruct conservatively from commits, evidence, and source; do not mark everything pending or completed. Preserve corrupt files for diagnosis. If code and evidence disagree, code plus fresh relevant verification governs; explain the reconciliation.

### O5 — Definition of done and report

Each prompt requires implementation, relevant tests, updated docs, requirement evidence, and durable state. A mock-only test is not evidence of runtime compatibility. A Linux build does not prove macOS Finder/installer integration. An unsigned package does not prove production signing. A successful HTTP response does not prove a requested setting was honored.

Use `completed`, `partial`, `blocked`, or `interrupted` honestly. Completing one prompt’s contribution does not complete a requirement that still depends on later prompts. The traceability file tracks partial satisfaction and final acceptance separately.

The final prompt report is short:

```text
Prompt: P__ — completed / partial / blocked
Result: concrete behavior delivered
Validation: key checks and evidence location
Open issues: problem ID, impact, help needed, or none
Next: next eligible prompt and first action
Checkpoint: commit and handoff path, if available
```

Do not ask “shall I continue?” after an explicitly queued assignment. Outside queue mode, report and pause at the assigned prompt’s end.

## 3. Prompt map and dependency order

Dependencies are a directed acyclic graph, not a demand to do everything in parallel. Default execution follows numeric order. Independent work after a blocker is allowed only when prerequisites are truly satisfied.

| Prompt | Deliverable | Prerequisites | Main requirements |
|---|---|---|---|
| P00 | Mac bootstrap, inventory, durable build ledger | None | 001, 010, MAC-001, MAC-008 |
| P01 | Integration, cost, and coverage gates | P00 | 001–003, 030 |
| P02 | Desktop repository and contracts | P01 | 006, 026 |
| P03 | Real engine adapter | P02 | 001, 002, 007, 008, 016 |
| P04 | Runtime/process supervisor | P03 | 002, 012, 016, MAC-003 |
| P05 | Transactional state and migration | P02 | 005, 010, 016, 025 |
| P06 | Design system and accessible screens | P02 | 006, 029, MAC-002 |
| P07 | Project catalog and shell | P04, P05, P06 | 005, 006, 029 |
| P08 | Live work studio | P03, P07 | 007, 008, 012, 014 |
| P09 | Finder Service, folder drop and native launch | P07, P08 | 004, MAC-002 |
| P10 | Prompt work board and continuity | P05, P08 | 009, 010, 024 |
| P11 | Attempt ledger and execution boundaries | P04, P10 | 011, 012 |
| P12 | Cost ledger and budgets | P03, P05, P08 | 003, 013 |
| P13 | Changes, Git, tests and restore | P08, P05 | 014, 015 |
| P14 | Resume Brief, menu bar and focus | P10, P11, P12, P13 | 017, 029 |
| P15 | Agent observatory and native workflows | P11, P12, P13 | 018, 019 |
| P16 | Provider/model/configuration workbench | P08, P12 | 008, 020, MAC-003 |
| P17 | MCP, skills, plugins and hooks | P16 | 021 |
| P18 | Terminal and complete capability explorer | P15, P17 | 022, 023, 030 |
| P19 | Memory, import/export and diagnostics | P10, P13, P18 | 024, 025 |
| P20 | Recovery, security and failure testing | P14–P19 | 016, 025, 026 |
| P21 | Self-contained arm64 app and offline installer | P09, P20 | 004, 027, MAC-001, MAC-004 |
| P22 | Signing, notarization and release automation | P21 | 027, MAC-005 |
| P23 | Update, migration and uninstall lifecycle | P21 | 025, 027, MAC-006 |
| P24 | Clean recipient install qualification | P22, P23 | 028, MAC-007 |
| P25 | Shared-core/Windows coordination audit | P20 | MAC-008 |
| P26 | Whole-product QA and economics recheck | P24, P25 | 003, 006, 028, 030, MAC-001–MAC-008 |
| P27 | Shareable release and final handoff | P26 | 027, 028, all final acceptance |

Bare three-digit numbers in “requirements” refer to `MONA-xxx`; `MAC-xxx` identifiers refer to the additional Mac requirements. Mac ranges are inclusive. `P14–P19` means all prompts in that inclusive range. Generate the machine-readable ledger from this map and validate that every referenced ID exists and the graph has no cycle.

## 4. The execution prompts

### P00 — Bootstrap the project and establish ground truth

**Goal:** Create a trustworthy native Mac build workspace and durable continuation system before implementation.

**Read:** Entire project specification once; operating contract; existing repository instructions. Relevant spec sections: 2, 3, 7, 8, 9, 17.

**Execute:**

1. Inspect the Mac working directory and preserve existing files. Confirm Apple Silicon architecture, actual macOS version, Rosetta/native process state, Xcode/CLT availability, shell, package managers, and native build tools. Establish a separate Mac branch/worktree if common source exists; do not touch the Windows working tree or its ledger. Record source baseline and nonsecret environment facts. Prefer `~/Developer/Mona-macOS` over an iCloud-synced location.
2. Locate the exact Codewhale executable(s) and selected installation. Capture version and help, inspect matching official docs/source, and detect conflicting PATH installations. Do not dump credential files or environment variables containing secrets.
3. Determine the configured provider/model/endpoint by supported redacted inspection. If credentials are absent, complete read-only discovery and record the missing live-test prerequisite. Do not ask Victor to paste a key into chat; point him to the engine’s secure local setup when needed.
4. Create a minimal `AGENTS.md` containing the stable operating contract and document pointers. Preserve existing instructions and explain any conflict rather than overwriting them.
5. Initialize `.mona/build-macos/state.json`, `attempts.jsonl`, `HANDOFF.md`, `DECISIONS.md`, and `BLOCKERS.md`; register P00–P27 and all 30 MONA plus 8 MAC requirements in `docs/requirements-macos.json`.
6. Build a small local validation/checkpoint utility with schema validation, atomic replacement, revision conflict detection, and hash/index generation. This is a bootstrap utility, not a premature app framework.
7. Create a discovery report and initial capability inventory structure. Note upstream desktop overlap. Inventory signing identity availability by certificate names/expiry only; do not export secrets or stop because paid membership is absent. Separate Mac build prerequisites from the eventual no-developer-tools recipient environment.

**Acceptance:** Both specs indexed and hashed; all prompt IDs and requirements present; dependency graph valid; a simulated interrupted checkpoint preserves recoverable state; no secret committed; actual engine/platform identity recorded or explicitly unavailable.

**Evidence:** `docs/evidence/macos/P00-bootstrap.md`, schema validation output, first handoff, initial local commit.

**Stop boundary:** Report P00, native Mac/toolchain status, and P01 live-test prerequisites. Missing Apple release credentials are logged for P22, not treated as a P00 implementation blocker. Do not start building visual screens yet.

### P01 — Prove headless integration and preserve the economics

**Goal:** Resolve G0/G1/G2 with a minimal real integration spike before investing in the UI.

**Read:** Spec sections 2, 6, 7.1, 9, 10; P00 discovery and matching engine documentation.

**Execute:**

1. Inventory the installed binary’s commands, configuration, API transport, permission semantics, session persistence, model resolution, agent/workflow features, and platform restrictions. Populate `docs/codewhale-capabilities-macos.json` with evidence and UI-route proposals. Do not claim total coverage from a README alone.
2. Write the smallest disposable-but-testable local client for the documented primary runtime. Discover the actual authentication, port, workspace, permission, and request contracts. Do not invent flags/endpoints from this specification’s illustrative TypeScript names.
3. In a temporary local APFS workspace run one inexpensive real tool task: create/edit a small file and run its test. Observe events, effective provider/model and Full Access, completion, history, and resume. Interrupt a controlled long-running harmless command and verify actual ownership/cancellation.
4. Test whether multiple owned runtimes can safely coexist against the installed store/config without corruption or route drift. If not, record serialized execution as the honest initial mode; do not manufacture isolated credential/config copies.
5. Run the spec’s paired cost pilot: direct engine versus the adapter, matched configuration and tasks, recorded cache/tokens/quality. Start tiny and honor the $2 pilot ceiling. Use fixtures for remaining checks when live accounting or a credential prerequisite is unavailable; mark economics provisional/inconclusive as applicable.
6. Verify zero inference for client startup, idle, discovery, history reading, and reconnect. Compare redacted effective requests or supported inspection/fixtures without logging secrets or rewriting provider traffic.
7. Write one clear feasibility decision, including upstream feature gaps and release-versus-main discrepancies. Pin the compatible native arm64 target or report a blocker. Prototype the packaged-app execution path with no Terminal PATH assumptions; identify runtime-critical Git/libraries/native modules for inclusion. Verify the native Finder Services approach with the target SDK. Do not silently upgrade Victor’s installation or substitute Rosetta. Signing credentials can remain a later prerequisite; a missing redistributable runtime capability cannot be hidden.

**Acceptance:** G0 real execution evidence; G1 instrumentation and honest live results; G2 complete discovered surface with implementation routes. A core failure blocks dependent implementation; independent reports/fixtures may still finish.

**Evidence:** `docs/evidence/macos/P01-feasibility.md`, benchmark data, capability inventory, ADR for chosen transport/binary. “No evidence of overhead” and “proven exact parity” are not interchangeable.

### P02 — Create the desktop foundation and strict contracts

**Goal:** Establish a small maintainable Electron/React/TypeScript project with real security boundaries.

**Read:** Spec sections 3, 6, 8.1, 13; P01 decision.

**Execute:** Reuse portable Mona packages from an available common baseline; otherwise scaffold the specified compatible structure with pinned dependencies and a lockfile. Keep native helpers in `native/macos-services/` and `native/macos-supervisor/`, installer assets in `packaging/macos/`, and evidence in `docs/evidence/macos/`. Do not overwrite the parallel Windows build. Pin the native Electron arm64 target and rebuild native modules for its ABI. Select one package manager, one schema library, one state approach, and one test runner. Add format/lint/typecheck/build commands and a local CI-equivalent entry point. Configure renderer sandboxing, context isolation, disabled Node integration, narrow preload bridge, restrictive content policy, and validated application-origin checks. The renderer must never receive runtime keys or arbitrary shell access.

Define shared schemas for project/task identities, engine capabilities, effective profiles, event envelopes, submission state, usage evidence, and error results. Separate proposed Mona types from upstream wire types. Use branded/opaque IDs or equivalent checks to prevent accidental project/thread/turn substitution. Add adapters at the boundary rather than spreading upstream response shapes through UI components.

Create fixture records for connecting, running, completed, interrupted, unknown-cost, blocked, unsupported, and malformed events. Fixtures are labeled test data and never become a production “demo success” fallback. Create a window that loads locally and displays the actual app version and placeholder navigation without making inference calls. Add the native application menu/Services menu and traffic-light titlebar; distinguish closing a window from quitting the app. Establish GUI-launch tool discovery and per-user Application Support/Cache/Logs paths now.

**Acceptance:** Clean install/build/test from documented commands; no secrets in built renderer; unrecognized/malformed IPC is rejected; remote navigation and privileged popups refused; schema validation tests cover wrong IDs and unknown fields policy. Establish baseline bundle and process footprint.

**Evidence:** ADRs for dependency selection and IPC boundary, `docs/evidence/macos/P02-foundation.md`.

**Avoid:** Premature plugin frameworks, additional servers, cloud services, broad Electron API exports, or a large design-system dependency set.

### P03 — Implement the real versioned engine adapter

**Goal:** Replace the P01 spike with a reusable, contract-tested runtime adapter.

**Read:** Spec sections 6, 7.1, 10.2; pinned runtime contract and P01 fixtures.

**Execute:** Implement discover, effective profile, thread/session open/create, submit, history, events, usage, interrupt, and supported capability invocation. Validate all inputs/results. Implement an explicit version/capability compatibility policy. Unsupported operations return typed reasons; unknown events remain available for diagnostics.

Persist submission identity before sending. Qualify upstream idempotency and read-only reconciliation where available. A lost write response must not trigger blind retry. For an older runtime without the required protection, return outcome-unknown with reconciliation guidance. Do not claim local operation keys alone make upstream writes idempotent.

Implement bounded streaming parsers and reconnect behavior using the engine’s actual cursor semantics. Distinguish durable events, transient updates, and terminal transport frames. Deduplicate events; never count replay as a new charge or reexecute tool work. Handle UTF-8 chunk boundaries, partial frames, malformed payloads, authentication errors, oversize events, and schema drift.

Preserve the existing provider route, tool profile, engine compaction, and message history. No prompt suffix for dashboard metadata. No guessed provider implementation inside Mona. Keep one-shot exec jobs explicitly separate from the persistent runtime interface.

**Acceptance:** Recorded contract fixtures plus a real pinned-runtime smoke test pass; wrong-thread responses cannot mutate another project; response-loss simulation does not duplicate work; reconnect yields the same projected state; permission/model settings are verified effective, not just requested.

**Evidence:** Adapter compatibility report, fixtures, `docs/evidence/macos/P03-adapter.md`. If an upstream operation is missing, retain a named capability gap rather than silently adding terminal scraping.

### P04 — Own runtime processes and stopping behavior correctly

**Goal:** Make Mona a reliable local process supervisor without killing unrelated work.

**Read:** Spec sections 6.4, 10.3, 13; P03 adapter contracts.

**Execute:** Implement single desktop ownership, per-workspace runtime ownership records, safe process spawning, startup readiness, authenticated loopback connection, and bounded failure handling. Verify executable path and identity; distinguish a legitimate child from a stranger occupying the port. Use argument arrays, preserve ordinary user privileges, and keep secrets off command lines.

Implement macOS descendant ownership/cleanup with a tested native supervisor, process groups, process identity, and an owner-liveness channel. Exercise grandchildren, reparenting and group escape; killing the parent alone is not sufficient. Do not install a root LaunchDaemon or default login item. Handle PID reuse and stale records. Explicitly distinguish renderer crash, close-last-window, app quit, runtime crash, forced app termination, and machine restart. Do not turn Mona into an automatically persistent daemon as an accidental consequence of detached children.

Implement Pause after task, Interrupt now, Cancel queued, and Quit and stop work as different transitions. Await real receipts or show uncertainty; forced termination is a last bounded step for owned processes, not evidence of rollback. External runtimes are not owned and must not be terminated by Mona.

**Acceptance:** Test Command-W versus Command-Q, Dock reopen, sleep/wake, and optional bounded keep-awake cleanup. Real harmless long-running process tree can be stopped; unrelated Codewhale/shell processes survive; window close/reopen keeps the same work; main-process failure produces documented cleanup/recovery behavior; occupied port, permission denial, missing executable, stale PID, and runtime startup failure are actionable states. No restart loop spends inference automatically.

**Evidence:** Native process tests, shutdown/recovery matrix, `docs/evidence/macos/P04-supervisor.md`. If the current host is not macOS on Apple Silicon, complete portable logic and tests, but leave native qualification explicitly pending.

### P05 — Build transactional project state and safe migrations

**Goal:** Durable local data with one clear authority and recoverable updates.

**Read:** Spec sections 8, 10.1, 17; bootstrap state helpers.

**Execute:** Implement the local DB/service with migrations, foreign keys, revision checks, and a single write path. Represent projects, runtime bindings, tasks/dependencies, submissions, attempts, requirement evidence, event cursors, usage, capability snapshots, decisions, and settings versions. Keep engine session history authoritative; cache only projections/references needed for the UI.

Define local/portable data boundaries. Keep machine-local bindings and secrets out of tracked project state. Implement atomic project status export/import with digests and revisions. Store large artifacts as bounded files with metadata. Add retention configuration and disk-space handling; never prune evidence still needed to understand a blocked task without a warning and explicit policy.

Use platform-derived per-user Application Support paths; no DB inside the app, iCloud, or shared system payload. Verify two macOS users cannot read each other’s runtime tokens or receive each other’s sessions. Implement migration backup and restore using a safe database snapshot method. All writers, including ingestion/indexing/background workers, must respect the maintenance barrier. If validation fails, retain the old DB and its recovery information. No unlinking recovery journals as an optimistic repair step.

**Acceptance:** Crash injection before/during/after a transaction leaves valid recoverable state; stale revision writes fail; migrations can recover from failure; backup/restore works with active writers quiesced; disk-full is handled without false completion; two aliases of one project do not create accidental duplicates. Test relocation and distinct worktrees.

**Evidence:** Schema/ownership ADR, migration fixtures, recovery tests, `docs/evidence/macos/P05-state.md`.

### P06 — Build Mona’s distinctive design system

**Goal:** A beautiful, accessible visual language usable throughout the product.

**Read:** Spec sections 4, 12, 15. Use the stated art direction as the starting design, not a generic dark admin template.

**Execute:** Implement Daybreak and Afterglow tokens, typography, spacing, surfaces, focus styles, density controls, and motion. Create accessible button, input, select, tab, dialog, menu, notification, badge, card, inspector, empty state, skeleton, and error components. Use consistent status language and iconography; no color-only meaning.

Build fixture-backed screens for home, project studio, work board, cost lens, blocker card, and settings. Use Mac Command-key conventions, native window chrome, menu bar, Retina scaling, and VoiceOver-readable labels; preserve the vibrant design without imitating Windows controls. Include real content density: long paths, long task names, unknown cost, disconnected state, many events, and permission labels. Clearly label this as a visual development harness rather than live behavior.

Validate contrast instead of assuming the starting hex palette passes. Use system/bundled fonts and local icons. Make all important actions keyboard accessible; preserve focus on panel transitions; honor reduced motion. Screens must work at 1280×800 and 200% scaling as well as a large desktop. Use 120–180 ms purposeful motion; no constant animations consuming CPU.

**Acceptance:** Automated accessibility checks plus keyboard inspection; screenshots in both themes and dense/comfortable layouts; all major non-happy states designed; typography remains readable; focus is visible; zero external font/assets requests and zero inference.

**Evidence:** `docs/design-system.md`, actual rendered screenshots, `docs/evidence/macos/P06-design.md`. Use screenshot/visual inspection tools autonomously when available; human aesthetic review can be collected at final QA without claiming it already occurred.

### P07 — Assemble the project catalog and desktop shell

**Goal:** A usable multi-project workspace with clear identity and navigation.

**Read:** Spec sections 4.2, 4.3, 5, 7 (004–006, 029), 10.1.

**Execute:** Implement home and the desktop shell using the real state service and supervisor. Add open/create/import existing folder, recent/pinned projects, label rename, archive, local search, reveal folder, relocation, and catalog removal. Never delete source files when removing a catalog entry. Canonicalize paths and distinguish nested repositories/worktrees without scanning entire drives.

Connect project selection to its correct runtime binding and persisted view state. Display actual engine connection, branch, model, permission, and local state availability. Missing credentials/runtime should prevent execution while leaving project history and settings usable. Add the command palette shell and keyboard navigation, with safe action routing.

Preserve unsent drafts per project/session. Switching projects must not mix drafts, turns, costs, or permissions. Opening an existing project should not create duplicate threads or restart unfinished work automatically.

**Acceptance:** Catalog survives restart; relocation can rebind deliberately; archived projects restore; dirty and non-Git folders open; path aliases deduplicate; project switching during a simulated run remains isolated; offline history works. A user can reach every major screen without a mouse.

**Evidence:** End-to-end shell/catalog tests and `docs/evidence/macos/P07-projects.md`. No fake percentage complete or hard-coded engine badge remains in production.

### P08 — Deliver the live work studio

**Goal:** Victor can submit work, observe the real engine, and understand its result inside Mona.

**Read:** Spec sections 4, 5.2, 6, 7 (007, 008, 012, 014), 13.

**Execute:** Connect the conversation timeline and composer to P03/P04. Support streaming text, tool cards, code blocks, user messages, final outcomes, drafts, explicit file references, and attachments only when actually supported. Render Markdown safely; disable executable raw HTML. Large content is virtualized or expanded on demand.

Expose Plan/Work and effective permission information through qualified controls. Configure Victor’s saved DS Full Access profile once and show it persistently. Starting the engine is not submitting an invented task. Missing profile authority, managed restrictions, and authentication failures receive accurate explanations. Full Access is not a macOS privacy grant. Test app/helper/engine attribution for protected folders and provide focused denial/recovery guidance; do not demand broad Full Disk Access at onboarding.

Implement the execution control strip and real pending-input/approval handling where the engine exposes it. Full Access must not leave hidden approval waits spinning forever. Unsupported input/approval types are surfaced with diagnostics. Keep user-facing explanation separate from raw logs. Do not fabricate internal reasoning when the engine only provides an activity status.

**Acceptance:** A real fixture project receives a task, changes a file, runs a test, and displays matching evidence. Draft recovery, connection loss, tool failure, oversized output, unsupported attachments, and duplicate event replay all work. Model output cannot invoke privileged IPC or navigate the app to an untrusted page.

**Evidence:** Real run receipt and UI recording/screenshots, `docs/evidence/macos/P08-studio.md`. Reconfirm no model calls from merely opening, searching, or re-rendering the studio.

### P09 — Deliver Finder selected-folder launch and native open actions

**Goal:** Open the right project from Finder without requiring a shell, Finder scripting, or a global folder monitor.

**Read:** Spec sections 5.1, 14.1, 19; Apple Services documentation and target SDK. P01 must have recorded feasibility of this mechanism.

**Execute:** Implement a minimal Swift/AppKit Services provider accepting local file URLs. Advertise **Start new DS project with Mona**, eligible for folders, using the supported Services mechanism. Choose the specified signed standalone service payload for the final package; use a clearly scoped local test install during development. Test actual service discovery and launch on Victor’s macOS. Do not depend on private `pbs` flags, edit privacy preferences, or silently enable a disabled service.

Forward a validated folder to the correct Mona app identity through supported launch/open and single-instance handling. Opening may register/select a project and start the headless runtime, but never submits a prompt or resumes execution based on an external service/URL argument. The app verifies its own effective profile. Add folder drop onto the Dock/window and File → Open Project as first-class paths.

Accept one selected folder at a time or provide a clear multi-selection choice. Handle APFS aliases/symlinks, spaces, quotes, Unicode normalization, newlines, shell metacharacters, missing permissions, volume roots, and offline cloud placeholders. Do not force an empty-Finder-background command: Services selection semantics are the intentional v1 design. No fake global menu via monitoring the whole drive.

**Acceptance:** Finder Services opens the precise folder; Dock/drop/dialog paths match; second invocation reuses the app; no shell injection or automatic model call; a user-disabled service has a guided recovery path; no project duplication. Native tests run on macOS. An unregistered helper launched from Terminal is not sufficient evidence.

**Evidence:** Service registration/launch tests, native UI evidence, `docs/evidence/macos/P09-finder.md`. Final signed installation and clean-recipient verification remain P21/P24 responsibilities.

### P10 — Implement prompt execution and durable continuation

**Goal:** Turn project plans into bounded executable tasks with clear acceptance evidence.

**Read:** Spec sections 8, 10.3, 17; this file’s ledger and dependency map.

**Execute:** Implement task/prompt creation, editing, import, dependency validation, selected-prompt dispatch, acceptance checklists, evidence links, and requirement traceability. Explicitly assign each task one execution owner: Mona queue or native workflow. No double scheduling. Default to one prompt per assignment and one mutating run per workspace.

Implement the defined task states and transitions. Code changes that invalidate test evidence must make verification stale. Prevent “completed” from being set merely because the model says it is done; require the configured evidence/check results and preserve any human-only acceptance items.

Implement deterministic next-task selection, Resume reconciliation, and concise handoff generation from state. Keep imported plans and prompt packs as inert data until started. Review exactly what context will be submitted; do not inject both full Mona design documents into every turn. Keep the app’s own build ledger separate from user project state.

**Acceptance:** Dependency cycles rejected; completed prerequisites verified; interrupted task resumes at recorded step; out-of-order independent work retains accurate status; two workspaces do not share task ownership; explicit queue runs its selection and then stops; user-authored criteria survive import/export.

**Evidence:** Task state tests, a sample project run, `docs/evidence/macos/P10-continuity.md`. Update the Mona build ledger using the same disciplined semantics without requiring the unfinished GUI to operate it.

### P11 — Enforce the three-attempt rule and clear stop controls

**Goal:** Prevent unproductive loops without abandoning unrelated useful work.

**Read:** Spec sections 8.4, 8.5, 10.3; O3; native hook/event capabilities.

**Execute:** Implement stable problem IDs, attempt records, hypothesis/result/evidence fields, total and consecutive-no-progress counters, and blocked dependency propagation. Persist these before any continuation decision. Require evidence/reason when material progress resets the consecutive counter. Acknowledging a notification cannot reset attempts.

At the third no-progress attempt block that problem and display the Victor handoff card. Allow only genuinely independent eligible work to continue. Keep blockers visible and tied to requirements. Implement human resolution/new-evidence transitions with an audit record. A new session must retain the count.

Enforce the limit mechanically for Mona’s own retries/job dispatch. For engine-internal iterations, use only verified events/hooks if they can enforce it reliably; otherwise issue the stable repository instruction and display cooperative enforcement accurately. Do not promise a semantic guarantee from repeated error-string detection. Do not pay a separate model to monitor loops.

Connect Pause after task, Interrupt now, Cancel queued, and blocker-paused states to actual engine/process behavior. A pause request should not silently leave a native goal independently dispatching work; use the correct execution owner.

**Acceptance:** Fixture attempt sequences 1/2/3, real material progress, session restart, manual acknowledgement, dependency block, and independent task continuation behave correctly. Fourth hidden retry is rejected in Mona-owned logic. Uncertain interruption is shown honestly.

**Evidence:** Enforcement-boundary document, attempt state tests, `docs/evidence/macos/P11-attempts.md`.

### P12 — Build the cost ledger and optional budget controls

**Goal:** Make cost preservation visible, correctly attributed, and testable.

**Read:** Spec section 9 and P01 economics evidence; provider usage semantics for the actual route.

**Execute:** Ingest usage/cost evidence without double-counting stream replay, parent/child aggregates, cache tokens, or reasoning tokens. Store rate source/revision/time and preserve historical estimates. Support provider-reported cost, local estimate, missing usage, and unknown price as distinct states. Do not show unknown as $0.00.

Build per-turn/task/session/project views with input/output/cache data when available, actual/estimated labels, cumulative spend, optional export, and pricing freshness. Do not claim an exact remaining balance from local usage alone. Price updates must not retrospectively rewrite historical records without an explicit recalculation view.

Implement optional user-set warning/stop thresholds and aggregate reservations for qualified concurrent work. A dispatch limit blocks the next task; in-flight cost may overshoot. If the engine exposes no internal call control, disclose that limitation. No auto-fallback to a more expensive model and no mandatory new spend limit for ordinary authorized work.

Add a fixture/proxy boundary check that asserts UI actions cause no inference calls and do not mutate outgoing context. Reuse the P01 paid evidence unless a changed adapter/context behavior warrants another bounded live test.

**Acceptance:** Known arithmetic fixtures match exactly; inclusive/exclusive token buckets handled correctly; duplicates/reconnects/child aggregates do not inflate totals; unknown rates propagate; timezone/day boundaries are correct; no misleading hard invoice-cap promise.

**Evidence:** Usage semantics/rates ADR, cost fixtures, `docs/evidence/macos/P12-costs.md`. Explain any unobservable costs rather than inventing numbers.

### P13 — Make changes, evidence, Git, and restore trustworthy

**Goal:** Let Victor understand what happened and safely keep or revert supported local work.

**Read:** Spec sections 5.5, 7 (014/015), 10, 11 source review.

**Execute:** Build file change lists, lazy text/diff views, binary/oversized-file indicators, test receipts, tool output artifacts, and source links. Connect claims to actual receipts/tests. Distinguish attributable tool changes from workspace-wide deltas and pre-existing user edits; do not infer sole agent authorship from timing.

Add Git status, branch/worktree display, selected-file staging/commit, and non-Git behavior. Avoid touching unrelated staged work. Implement fresh-revision editor writes and conflicts. No routine reset/clean of the repository.

Expose verified native undo/restore capabilities with a preview of exact scope, exclusions, current conflicts, and recovery information. A restore must not overwrite later user edits silently. Represent unavailable snapshots and unsupported binary/external effects. Do not build a second incomplete snapshot engine as a workaround for missing native behavior.

**Acceptance:** Dirty-repository scenario preserves user changes and staged entries; changed file edited externally gets conflict handling; deleted/binary/large files display honestly; missing snapshot is not an empty diff; supported restore works and unsupported scope is explained; test cards link to commands/results/commit evidence.

**Evidence:** Real and fixture change receipts, conflict/restore tests, `docs/evidence/macos/P13-review.md`. Keep any unsupported restore feature in the capability gap ledger.

### P14 — Deliver the daily-use polish without inference overhead

**Goal:** Make Mona pleasant and immediately understandable during long sessions.

**Read:** Spec sections 4, 5.3, 12; P10–P13 state surfaces.

**Execute:** Implement Resume Brief and Since you left from deterministic task/events/evidence data. Group meaningful changes without asking a model to narrate them. Include unresolved blocker, current prompt, test result, changed-file count, spend confidence, and next step. No fake completion percentages.

Add Focus Mode, saved panel layouts/density, project color/monogram identities, prompt favorites, keyboard shortcuts, menu-bar/Dock state, completion/blocker notifications, quiet hours, and deduplication. Reopening a notification focuses the right project and evidence, not a new task. Default notification content should not expose sensitive prompt/file details on the lock screen.

Follow macOS close-versus-Quit behavior while active work continues, provide Dock reopen and menu-bar status, preserve the user’s preference, and provide explicit quit/interrupt actions. Any launch-at-login option stays off until chosen. An optional keep-awake toggle is scoped to active work and tested for cleanup. Quiet hours silence notification delivery without pausing computation unless the user requested that separate behavior. Avoid always-on animation and rapid screen-reader announcements.

**Acceptance:** Run-completion and blocker notifications occur once across reconnects; quiet hours and timezone changes behave correctly; Resume Brief matches source records; Focus Mode retains emergency controls; all navigation uses no inference and remains keyboard accessible.

**Evidence:** Actual UI screenshots in both themes, notification tests, `docs/evidence/macos/P14-polish.md`.

**Milestone:** If all Foundation/Core requirements now have their remaining evidence, prepare a clearly labeled Core preview. Do not claim full Codewhale parity before later prompts.

### P15 — Surface native agents, goals, fleets, and workflows

**Goal:** Make agent work visible and controllable without creating a second agent engine.

**Read:** Spec sections 7 (018/019), 10.3, 11; actual capability inventory and native orchestration contracts.

**Execute:** Build the agent observatory with expandable parent/child relationships, task, workspace/branch, actual lifecycle, last meaningful event, tools/tests, and spend confidence. Use real upstream identities; no synthetic avatars implying nonexistent agents. A native child’s unknown progress/cost remains unknown.

Expose native goals, fleets, workflows, runs, history, artifacts, and controls through supported interfaces. Ensure only one scheduler owns any given task. A native workflow may own its internal steps; Mona monitors and requests supported controls rather than independently dispatching the same steps.

Keep default execution serial. Qualify optional parallel tasks with isolated worktrees, branch/file ownership, aggregate limits, and a merge/review boundary. Do not start multiple builders on one mutable tree merely because the engine can spawn them. Keep route/model restrictions consistent across children; unsupported credential handoff is a blocker, not permission to copy keys into process arguments.

**Acceptance:** One real small delegated/workflow run where supported; fixtures for child failure, disconnect, unknown usage, blocked dependency, cancel, and partial completion; parent/child totals do not double count; independent work ownership is clear; merge conflicts stop the affected integration without deleting branches.

**Evidence:** Orchestration ownership ADR, run receipts, `docs/evidence/macos/P15-agents.md`. Map missing supported-native features as gaps and platform-unsupported features as unavailable, not completed.

### P16 — Expose providers, models, permissions, and effective settings

**Goal:** Control engine configuration transparently while retaining Victor’s economics.

**Read:** Spec sections 7 (008/020), 9, 11 providers, 13; supported engine configuration interfaces.

**Execute:** Implement provider/model catalogs, effective profile display, configured endpoint/key source status without secrets, supported reasoning controls, Plan/Work/permission selection, and connection diagnostics. Keep Victor’s existing Flash route as default and disable automatic expensive routing/fallback by default.

Separate editing a saved default from altering an active thread. Show requested versus effective settings and scope. A mode label must reflect actual engine state. Invalid or unsupported settings fail clearly; do not persist them and pretend they took effect. Show any policy restrictions without attempting to bypass them.

Use the engine’s credential store/config tools. Separate bundled-engine selection from optional external-engine adoption. Do not switch to an arbitrary PATH binary. Validate GUI-launch tool resolution and Keychain identity/upgrade behavior on the signed candidate later; local ad-hoc builds cannot prove stable recipient Keychain behavior. If a secure local credential-entry surface is necessary, confine it to a validated privileged path and never persist it in renderer local storage, analytics, project settings, or logs. Preserve unknown configuration keys and detect concurrent edits. Write backup/revision evidence before supported configuration changes.

**Acceptance:** Changing a new-thread default leaves an active turn alone unless expressly applied; missing key and invalid endpoint are distinct; effective model matches the receipt; unsupported reasoning choices are not sent; route failure stays on the configured route; exported diagnostics contain no secrets.

**Evidence:** Configuration scope tests and `docs/evidence/macos/P16-settings.md`. No real provider-switch experiment should incur uncontrolled charges; use local fixtures for most failure cases.

### P17 — Make tools and extensions manageable

**Goal:** Expose Codewhale’s MCP, skills, plugins, hooks, rules, and instructions coherently.

**Read:** Spec sections 7 (021), 9.2, 11 extensions, 13; pinned extension/configuration documentation.

**Execute:** Inventory installed/configured extensions and their scopes. Implement list/details, provenance, effective configuration, health, enable/disable, and supported install/update/remove routes. Explain what affects global configuration versus one project. Preserve unknown keys and existing user files.

Use local deterministic metadata and health checks. Do not load every server/tool description into model context merely because its settings page is open. Where Codewhale supports selective discovery, expose it faithfully; where it does not, report the limitation instead of a guessed token-savings percentage.

For each supported action show source and side effects, use verified package identities, and honor existing user authorization. Avoid duplicated tool servers that merely wrap already available local commands. Imported instructions are inert until enabled; no arbitrary downloaded content can invoke the desktop bridge. Hook configuration must follow engine semantics, not become an unrestricted renderer scripting system.

**Acceptance:** Configure a harmless local test server or fixture, observe health, disable it, and verify the intended scope only; stale configuration edits conflict correctly; missing executable/failed handshake is actionable; secret-bearing configuration is redacted; remove preserves unrelated settings.

**Evidence:** Extension coverage rows, scoped configuration tests, `docs/evidence/macos/P17-extensions.md`. If a category is not programmatically exposed, record the verified advanced action or terminal route explicitly rather than hiding it.

### P18 — Complete advanced access and the capability explorer

**Goal:** Ensure “all functionality” is an auditable claim, not a slogan.

**Read:** Spec sections 7.1, 11 terminal/palette, 13; current capability inventory.

**Execute:** Implement the integrated terminal with qualified native macOS arm64 PTY support, resize/copy/search, process ownership, output limits, and safe links. Keep terminal data separate from application authority. Launch shells with a documented controlled environment and per-process PATH; never source user shell startup files just to find provider credentials during app startup. Use native arm64 PTY modules matching Electron’s ABI, not a global npm/native build dependency on the recipient Mac. Terminal escape sequences, model output, and hyperlinks cannot invoke privileged application commands.

Finish the command palette and capability explorer. Give every discovered engine capability a name, scope, description, invocation route, support/version/platform status, help source, cost implications, and test. Frequent workflows deserve native controls; rare features can use validated advanced forms or explicit terminal access. Do not convert local commands into model prompts.

Compare current discovery against the P01 inventory. Investigate additions/removals and version changes. Preserve unknown feature records for inspection, but do not offer untested mutating operations. A terminal entry alone does not fulfill promised native controls. Identify any supported upstream feature still unreachable or unusable and leave full parity blocked until resolved or Victor narrows scope.

**Acceptance:** Every supported row has a working tested entry point; unavailable/gap states are clear; terminal reconnect/exit and resize work; unsupported terminal lifecycle is not faked; malicious terminal links remain inert; coverage report computes completeness without excluding awkward features.

**Evidence:** Final feature matrix draft, terminal tests, `docs/evidence/macos/P18-parity.md`. No claim of 100% parity while required gaps remain.

### P19 — Finish project memory, portable handoff, and diagnostics

**Goal:** Make projects understandable across sessions and machines without cloud services.

**Read:** Spec sections 8, 10.1, 12, 13; P05 data authority and retention design.

**Execute:** Implement local text search over explicitly indexed project metadata, decisions, task evidence, and permitted history projections. Use local deterministic indexing, not an embedding service. Respect ignore/retention settings and avoid indexing credentials. Repository contents should be searched on demand or under a documented scope, not copied wholesale into a new DB.

Add prompt shelf/import/export with variables, acceptance criteria, preview, versioning, and inert import behavior. Implement explicit context-selection preview and a concise resume packet assembled from known state. Do not pretend this can show the exact provider request unless the engine supplies that inspection.

Implement project handoff export/import, settings backup/restore, local diagnostic bundle preview, redaction, artifact digest checks, and safe path handling. Imported machine bindings must be requalified. Never include provider keys, runtime tokens, private environment dumps, or full source unless explicitly selected.

**Acceptance:** A redacted handoff imports into a clean profile and reconstructs task/decision/evidence pointers without auto-executing; missing local files and stale digests are identified; malicious archive paths cannot escape extraction root; active restore honors the maintenance barrier; search and exports require zero inference.

**Evidence:** Portable bundle tests, redaction fixtures, `docs/evidence/macos/P19-memory.md`. Record what portable handoff intentionally cannot transfer, such as inaccessible engine-owned sessions on another machine.

### P20 — Harden recovery and test hostile or failing inputs

**Goal:** Verify the most consequential boundaries across the assembled product.

**Read:** Spec sections 6.4, 10, 13, 15; all unresolved risks and prior evidence.

**Execute:** Add and run targeted failure injection for renderer crash, main crash, runtime crash, lost stream, lost submission response, duplicate/out-of-order events, disk full, stale revision, corrupted metadata, failed migration, missing artifact, revoked credentials, occupied port, sleep/wake, and interrupted restore. Reconcile based on durable evidence; never auto-replay uncertain tool effects.

Audit IPC sender validation, renderer isolation, runtime auth, loopback binding, secret storage/redaction, Markdown/file links, terminal links, imported archives/prompts, path canonicalization, and generated-app previews. Keep previews isolated from the privileged app origin. Test suspicious folder names and symlinks, Finder aliases, Unicode normalization and APFS case behavior on macOS.

Check all write paths obey maintenance mode and all owned processes obey shutdown. Verify task/usage state after each fault. Security findings receive stable issue IDs and follow the three-attempt rule. Fix root causes; do not hide a failing test by disabling the feature or widening trust.

**Acceptance:** High-consequence scenarios have passing evidence or a release-blocking issue; no unexplained duplicate effects/costs, corrupted state, leaked secrets, broad IPC, or orphan process ownership. Unknown outcome stays unknown until reconciled. Offline UI still opens for inspection.

**Evidence:** `docs/evidence/macos/P20-failure-matrix.md`, security boundary review, reproducible failing cases and repairs. Avoid claiming formal security certification.

### P21 — Package the self-contained Apple Silicon installer

**Goal:** Produce a real offline `.pkg` that installs Mona and required runtime components without developer setup on the recipient machine.

**Read:** Spec sections 3, 14, 19–21; pinned packaging APIs and Apple package documentation. Reuse established shared build tooling where compatible.

**Execute:** Create deterministic staging and packaging scripts for `/Applications/Mona.app` plus the signed native service payload under `/Library/Services`. Enumerate exactly what the package owns. Include the qualified native Codewhale binary and all runtime-critical helpers, Git/search tools and dynamic libraries. Verify every Mach-O/native module architecture and Electron ABI; unpack executables from ASAR where needed. No hidden dependency on Victor’s Homebrew cellar, global npm, Xcode, Rust, Python, or shell profile.

Inspect license/notice/source-distribution obligations before including dependencies. Record original upstream and final packaged hashes separately. Bundle clean defaults only: never copy the developer’s config, keys, DB, sessions, source projects, signing secrets, or test home. Provide a component manifest and secret-scan gate.

Create a standard Apple Installer package with useful branding, explicit arm64/OS checks, minimal scripts, and idempotent reinstall behavior. Do not fetch dependencies, execute model calls, accept agreements, modify TCC, or launch Mona as root from installer scripts. First user launch initializes per-user data. Handle an existing Mona installation or app in another location deliberately instead of creating multiple competing copies.

Add local-package and release-package modes. Local mode can work without Developer ID and is visibly labeled for development; it never counts as a qualified shareable release. Release mode requires P22 signing/qualification. Use a harmless built-in/core runtime acceptance sample that does not need a language compiler or Xcode tools.

**Acceptance:** Actual arm64 app and package built; offline installation succeeds; app starts from Applications with minimal GUI environment; bundled engine and required core features run; no build-machine paths or secrets; external Codewhale/config preserved. Missing signing identity does not block this local milestone.

**Evidence:** Payload/BOM manifest, architecture/dependency scan, installer script review, local install receipts, `docs/evidence/macos/P21-package.md`.

### P22 — Automate signing, notarization, and release verification

**Goal:** Turn the local package into the shareable trusted artifact through one repeatable command after publisher setup.

**Read:** Spec sections 14.3, 20, 21; current Apple notarization/signing docs. Verify tool versions; do not copy obsolete `altool` notarization recipes.

**Execute:** Implement `mac:release:preflight`, `mac:release`, and `mac:verify-release` (or equivalent documented commands). Preflight validates source/evidence freshness, OS/arch manifest, required identities, certificate validity, and access to a configured notary credential profile without exposing private material.

Enumerate and sign nested native components inside-out using minimal per-component entitlements, Hardened Runtime, and timestamps. Apply appropriate Electron exceptions only where actually required. Sign app/service with Developer ID Application and the flat package with Developer ID Installer. No blanket deep signing to hide missed components, debug entitlements, or modification after signing.

Submit the final package to Apple with supported tooling, store the notary submission ID, resume lookups after interruption, inspect logs, and require Accepted. Staple/validate the ticket and verify the installed nested execution path, including offline behavior. A successful upload is not notarization success. Pending submission is a resumable job, not a reason for repeated new submissions. The three-attempt rule covers repeated rejection/no-progress repairs.

Run actual code/package assessment and write the final immutable artifact digest and release receipt. If credentials or membership are missing, finish scripts, fixtures, preflight and local tests; record the precise setup needed from Victor and continue independent P23/P25 work. Do not purchase membership or accept legal terms. Existing configured credentials authorize the private Apple submission for this release preparation; public publication remains separate.

**Acceptance:** Signed/stapled final `.pkg` with accepted notary status and real verification evidence, or truthful partial status naming the missing prerequisite. The release command must never silently emit unsigned output as production.

**Evidence:** Redacted signing/notary logs and submission state, entitlements audit, release receipt, `docs/evidence/macos/P22-trust.md`.

### P23 — Implement upgrade, migration, rollback, and uninstall

**Goal:** Keep installed copies maintainable without silent privileged code or loss of work.

**Read:** Spec sections 10, 22; P21 payload ownership and state schemas.

**Execute:** Implement the installer-mediated update flow. A configured authenticated distribution manifest can announce a version and provide the signed package; without a real configured host, show Manual package updates and support a local qualified package. Do not query invented URLs or publish a feed as part of this prompt.

Validate publisher/team/product identity, package signature, digest/length, OS minimum, architecture, version order and allowed source before handoff. Reject wrong-team, tampered, unsigned, downgrade, replayed and incompatible packages. Keep trust verification local/deterministic. Do not introduce a competing self-updater or a root background daemon.

Defer installation while tasks are active. Record intent, quiesce writers, make a verified local state backup, and launch Apple Installer through the user’s normal authorization path. Quit safely only after a controlled handoff; do not kill a run to make updating convenient. The next user launch migrates its own state. Test failure before/after replacement and prevent older binaries from opening incompatible schemas.

Provide uninstall instructions and a bounded signed removal utility if needed for the system service. Remove only package-owned paths with verified ownership; preserve projects, external engine/config, and user state by default. Data deletion is a separate enumerated action. Do not scan other users’ homes from a root script or equate deleting a package receipt with uninstalling files.

**Acceptance:** Upgrade N→N+1, reinstall, failed migration, active-run deferral, wrong-package rejection and uninstall pass locally. Signed trust cases require P22 artifacts; build fixtures/implementation independently if signing is pending. No update check incurs model calls.

**Evidence:** Update trust/ownership ADR, lifecycle tests, `docs/evidence/macos/P23-lifecycle.md`.

### P24 — Test the artifact as a new recipient

**Goal:** Prove the requested just-works installation outside Victor’s prepared development environment.

**Read:** Spec sections 23–24; P21–P23 artifact and trust evidence.

**Execute:** Use a separate Apple Silicon Mac or clean supported macOS VM plus a physical-M3 smoke. A second local user is additional evidence, not proof that global Xcode/Homebrew are absent. Record OS/hardware and demonstrate the target has no development tool prerequisites or cached engine/config. Preserve normal Gatekeeper/quarantine behavior; obtain/test the actual distribution bytes rather than copying the build app directly from source.

Walk through download, standard installer/authentication, Applications launch, Finder Service, offline local operation, secure new-user API setup, and one small authorized real task. The task must edit a file and verify the outcome without forcing a language toolchain install. Test Git/core features without accidentally invoking an Apple CLT installer stub.

Exercise disabled service, denied/revoked folder permission, locked Keychain, offline provider, sleep/wake, multiple users, unsupported architecture/OS, clean reinstall, upgrade and uninstall. Record expected system prompts and every unexpected manual repair step. No recipient should need terminal fixes, Rosetta, `xattr` removal, Gatekeeper disablement, or a developer membership.

If no clean test host or signing identity exists, finish the repeatable test harness/checklist and keep recipient qualification blocked. Do not reset the three-attempt counter by moving a failure to a new VM. Work on independent tests while the prerequisite is pending.

**Acceptance:** The exact signed installer passes the clean-recipient matrix; evidence identifies both package and installed app/runtime versions, all required permissions and their denial paths, and unchanged security protections. Any required repair command blocks the just-works claim.

**Evidence:** `docs/evidence/macos/P24-recipient.md`, UI recording/screenshots, command-free end-user guide, platform matrix.

### P25 — Reconcile common code with the parallel Windows build

**Goal:** Keep one maintainable Mona core while both platforms progress independently.

**Read:** Spec section 3.3; available shared repository instructions/contracts; Mac baseline and decisions.

**Execute:** Inspect only an authorized, available Windows/common source checkout or remote. Compare shared contracts, data schemas, engine adapter semantics, cost behavior, design tokens, and task/attempt logic. Document baseline commits and propose portable changes with explicit platform interfaces for process ownership, shell launch, storage, credential handling and installation.

Do not modify the other machine’s live working tree, overwrite its `AGENTS.md` or `.mona/build`, copy runtime credentials/databases, or reset its progress. Prefer a reviewable source-only change/patch or authorized branch integration. Native evidence and build ledgers remain platform-specific. Resolve actual merge conflicts carefully and run relevant shared tests without claiming they prove native behavior.

If Windows code is unavailable or still being built, complete the interface audit and a precise integration handoff against the known baseline. Do not block a finished Mac release solely on the other platform’s timing; also do not claim a cross-platform merge that never happened. Keep outstanding integration clearly recorded without secretly maintaining a second engine implementation.

**Acceptance:** Shared-core boundaries and migration compatibility are documented; Mac files cannot overwrite Windows state; any integrated source passes relevant checks; missing counterpart availability is recorded accurately. No unrequested public push or publication.

**Evidence:** `docs/evidence/macos/P25-shared-core.md`, baseline/contract comparison and change list.

### P26 — Run whole-product QA and prove the remaining claims

**Goal:** Evaluate Mona as a user would, with measured performance and honest economics.

**Read:** Spec sections 15–17 and 19–24; requirement traceability; capability inventory; open blockers.

**Execute:** Run the mandatory end-to-end scenarios from the spec on the pinned native Apple Silicon/reference setup. Exercise real engine execution at least once through the installed app. Check both themes, 200% scaling, keyboard-only navigation, focus restoration, reduced motion, VoiceOver behavior, long text, large histories, empty/error/offline states, and all essential controls.

Measure cold/warm startup, typing/scrolling under a 10,000-event fixture, idle CPU, total Mona-process memory, and engine memory separately. Document hardware and measurement method. Investigate budget misses instead of adjusting the target to the observed number without explanation.

Re-run the zero-inference checks and a bounded paired cost benchmark if adapter/context/orchestration changes warrant it. Compare cost per accepted task and state confidence/limitations. Do not spend indefinitely to manufacture statistical certainty. Follow the pilot ceiling or an updated explicit Victor budget.

Audit every requirement and capability row. Remaining human-only tests receive an exact minimal checklist with prerequisites and expected results, after all autonomous checks are complete. Human signoff is not invented. A screenshot of a mock is never release evidence for a real workflow.

**Acceptance:** Core gates remain valid; all machine-testable required scenarios pass; no concealed feature gaps; cost report is defensible; accessibility and performance findings are documented. Unavailable mandatory native/human evidence keeps the relevant release status partial.

**Evidence:** `docs/evidence/macos/P26-product-QA.md`, real screenshots, performance and economics reports, final requirement/feature matrix draft. Report a short actionable remaining checklist, not a dump of every test command.

### P27 — Package the release candidate and finish the handoff

**Goal:** Leave a complete, maintainable Mac release with a real shareable installer, or explicitly identify the remaining release blocker.

**Read:** Spec sections 16–25; all gates, evidence, and open issues.

**Execute:** Resolve final documentation inconsistencies and promote the exact `Mona-<version>-macOS-arm64.pkg` already built and qualified by P21–P24/P26, with its checksums, build provenance, compatibility/BOM manifest, licenses/notices, changelog, and migration/rollback instructions. Preserve and verify those signed/stapled bytes. If a source or payload correction requires another build, run the one-command release pipeline and repeat the affected trust/recipient checks before promotion; do not deliver a different unqualified package after testing. Document install, first launch, existing credentials, folder launch, Full Access meaning, prompt assignment, resume, costs, stopping work, blockers, backups, restore limitations, privacy, updates, and uninstall.

Write the developer guide for repository layout, reproducible builds, adapter qualification, schemas/migrations, failure fixtures, and adding new capability coverage. Include contribution/security-report guidance suitable for a future public release without publishing it. Reassess whether upstream desktop changes affect the maintenance case and record the finding.

Perform a clean-environment build/install smoke using the produced artifact. Reconcile every MONA and MAC requirement against evidence and every capability against the pinned engine. Distinguish local development usable, packaged candidate, and shareable release qualified. A remaining Apple credential, notarization, OS-floor, or clean-recipient prerequisite prevents a shareable-complete claim. Do not relabel missing mandatory work as an enhancement.

Finalize `.mona/build-macos` with exact completed/blocked statuses, unresolved issues, artifact paths, tested platform/version, source commit, and next human action. Commit the coherent release state locally; remote push only to a confirmed authorized Mona remote. No public upload, package publication, certificate purchase, or repository creation without explicit authorization. A private notarization submission to Apple using Victor’s configured credentials is part of the authorized release preparation.

**Acceptance:** Artifact matches recorded commit; clean install/build evidence exists; documentation matches actual product; no secrets; all mandatory gaps explicitly resolved or blocking; state supports a later “continue” without rediscovery.

**Evidence:** `docs/evidence/macos/P27-release.md`, immutable artifact digest and release receipt, final requirement/capability matrix, and the short recipient installation guide. Package timestamps/signatures need not be byte-reproducible; the exact promoted bytes must match their qualification evidence.

**Final report:** What works, whether cost benefit was preserved and with what evidence, tested macOS versions/M3/arm64 engine, exact `.pkg` location and trust/qualification status, one-command rebuild instructions, installation steps for recipients, and any concrete remaining prerequisite. If all required work is complete, say so and stop. Do not start Later-scope features automatically.

## 5. Evidence and state templates

### Requirement evidence record

```json
{
  "id": "MONA-004",
  "status": "partial",
  "owning_prompts": ["P09", "P21", "P24", "P26"],
  "criteria": [
    {"id": "folder-launch", "status": "pending", "evidence": []},
    {"id": "folder-drop", "status": "pending", "evidence": []},
    {"id": "finder-service", "status": "pending", "evidence": []},
    {"id": "safe-paths", "status": "pending", "evidence": []}
  ],
  "verified_commit": null,
  "tested_environment": null,
  "open_issue_ids": []
}
```

A real implementation can extend the schema. Evidence records should include command/check, result, timestamp, relevant version/commit, artifact path/hash, and whether the test was real, fixture-based, or human-performed. Do not record a boolean pass without enough information to assess it later.

### Problem and attempt record

```json
{
  "problem_id": "ISSUE-0001",
  "requirement_id": "MONA-002",
  "symptom_fingerprint": "runtime-permission-not-effective",
  "attempt_number": 1,
  "hypothesis": "Describe one falsifiable cause",
  "action": "Describe the bounded diagnostic or repair",
  "observed_result": "Actual result, not intended result",
  "material_progress": false,
  "progress_evidence": [],
  "consecutive_no_progress": 1,
  "status": "open",
  "help_needed": null
}
```

### Short handoff structure

```text
# Mona build handoff
Current prompt:
Current status:
Last verified commit / dirty work:
Completed in this session:
Next exact action:
Relevant files and spec sections:
Open problem IDs and no-progress counts:
Blocked dependencies:
Last relevant validation:
Human input needed, if any:
Next eligible prompt:
```

Keep handoffs concise, usually under 800 words. Link detailed evidence instead of copying entire logs. Handoffs are deterministic project notes, not a separate paid AI summarization job.

## 6. Final implementation reminders

- The files are a build specification and prompt system; no feature is already implemented merely because it is described.
- Use the actual Codewhale integration surface, not an imagined CLI flag or HTTP route.
- Mona’s delight comes from clear interaction and local computation. It must not erode the reason Victor chose Codewhale.
- Evidence wins over optimistic status text.
- Finish the assigned prompt. Preserve state. Respect the three-attempt rule. Involve Victor when it matters.


## 7. Publisher setup checklist — do not let it block early development

The builder completes local development and all independent tests first. Before the signed sharing milestone, determine whether Victor already has usable Apple Developer Program membership and Developer ID identities. The agent may inspect identity availability without printing secrets, but cannot enroll/purchase or accept agreements for him.

The exact later checklist must be generated from the actual machine/account state:

1. Publisher-controlled bundle IDs/team identity selected and consistent across app/service/helpers.
2. Developer ID Application and Developer ID Installer certificates/private keys available through approved local/CI secret storage.
3. Notarization credentials configured securely with supported Apple tooling; avoid credentials in prompts, source files, command output, or exported logs.
4. One successful signed/notarized/stapled package and real offline/online Gatekeeper tests.
5. Clean recipient validation on the supported macOS range.

A normal recipient supplies none of this publisher setup. They install the package, give any necessary OS consent, and enter their own API key. “Full Access” in Codewhale and OS privacy permissions are separate controls. No instructions to disable Gatekeeper/SIP or remove quarantine belong in the end-user installation guide.

## 8. Platform-specific continuation rules

- If Victor says “continue” on the Mac, use `.mona/build-macos`, not the Windows ledger.
- Never mark Mac acceptance complete solely from Windows tests or a Linux build.
- Missing Apple signing credentials block P22’s final acceptance and dependent release qualification, but P23/P25 and other independent work can continue.
- No shared `.pkg` includes Victor’s key, projects, sessions, machine paths or signing secrets.
- Do not silently adopt a model/provider or bundled engine different from the verified profile.
- P27 is the end of this authorized build plan. Additional Intel/universal, App Store, mobile, or remote-control work needs new scope.
