# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P11) · revision 126 · verified commit `e32b1a1`
**Current prompt:** P11 completed. Next eligible: **P12** — not started, not
authorized in this session.

## Where the build stands

P00–P11 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, a prompt work board and
durable continuation, and now an **enforced attempt ledger and clear stop
controls**.

### P11 — Attempt ledger and execution boundaries (complete)

- **`src/main/state/schema.ts` + migration v4** — `problems` (stable id,
  requirement, symptom fingerprint, status, total/consecutive counters,
  `help_needed`, `blocked_at`, `resolved_at`, `resolution`),
  `problem_events` (append-only audit), and `tasks.active_turn_id`. Two partial
  unique indexes prevent a second active problem for the same task+requirement
  or taskless fingerprint.
- **`src/main/state/store.ts`** — `recordProblemAttempt` does the attempt insert,
  both counter moves, and the third-attempt block in one transaction. Progress
  needs evidence or a reason; a blocked problem refuses a fourth attempt;
  acknowledgement only audits; reopening is the only reset path and needs
  evidence plus a reason; resolution is a human decision. `beginTaskRun` and
  `updateTaskStatus(..., "running")` refuse a task with a blocked problem.
  Blocking a running task interrupts its task-run receipt.
- **`src/main/work/board.ts`** — problem views, blocked-problem selection
  gating, dependency propagation with the blocking task id, independent work
  continuing, the Victor handoff card, attempt/acknowledge/resolve/reopen
  methods, a pause gate on `dispatchNext`, and `noteEngineInterrupt` linking a
  receipt to a task.
- **IPC/UI** — four new narrow channels (`board:attempt`,
  `board:problem-acknowledge`, `board:problem-resolve`, `board:problem-reopen`);
  the board renders attempt history, both counters, the exact help card, and
  human resolution/reopen controls.
- **Control** — pause-after-task gates only Mona queue dispatch and says native
  workflows are not gated; a confirmed interrupt moves the linked task to
  `interrupted`, an uncertain one leaves it `running` with an audit note;
  cancel-queued reports the real queue.
- **Verification** — 304 tests in 35 files; P10/P11 sample run **37/37**;
  Electron shell smoke **44/44** with a real seeded blocked problem; local CI
  green. Evidence: `docs/evidence/macos/P11-attempts.md`, ADR-006, and
  `artifacts/p11-*`.

## Next exact action (P12)

Read spec §9 (economics), §11 (providers/models if relevant), the P12 prompt
body, O1/O2, and this handoff. Then build the cost ledger and optional budget
controls:

1. Usage semantics and rate ADR: observed vs estimated vs unknown; cache and
   reasoning token treatment; which prices are authoritative and when they were
   read.
2. Durable cost ledger over `usage_records` with per-task/per-project/per-model
   rollups, honest `costComplete: false` whenever any turn is unpriced.
3. Optional budgets with a visible limit class (soft warning vs hard stop) and
   no hidden inference or router call; unknown cost never becomes zero.
4. Tests and evidence: `docs/evidence/macos/P12-costs.md`, with fixtures for
   priced, partially priced, and unpriced turns.

## Nonblocking issues carried forward

1. **Engine-internal loops are cooperative** — Mona refuses a fourth dispatch
   for its own queue and records the blocked problem, but it does not parse
   error strings or claim a semantic limit inside one engine turn (ADR-006).
2. **No engine-side attempt reporting hook** — attempts are recorded by the
   board UI or an executor that can call `board:attempt`; binding native engine
   events to structured attempt reports is P15.
3. **Native workflows are not gated by pause-after-task** — the note says so;
   native goal/fleet dispatch is P15.
4. **Turn completion is not auto-projected** — P11 links the dispatch turn and
   honors an interrupt receipt; moving a finished turn to verification is P14.
5. **Attempt ledger is not in the portable bundle** — tasks, criteria, and
   requirement evidence export today; the P19 resume packet may extend it.
6. **Confirmed live interrupt remains P08 evidence** — P11 tests linkage and
   the uncertain path deterministically; P24/P26 own interactive QA.
7. **No automatic runtime start from a Finder handoff** — deliberate (D-019).
8. **Service install scope** — `~/Library/Services` for development; the
   packaged installer must use `/Library/Services` (D-020, P21).
9. **LaunchServices ignores `/tmp` bundles** and can serve a stale Service
   record after a bundle change (D-021). P21/P24 verify the packaged pair.
10. **Interactive multi-selection alert** — CLI-tested; the native alert is
    human QA (P24/P26).
11. **Window drop is not automated end to end** — the equivalent Service
    handoff is proven end to end.
12. **VoiceOver reading of the Services menu and the work board** — P24/P26.
13. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
14. **Single-owner runtime** — enforced; parallel ownership needs a tested
    engine decision.
15. **Direct cost unknown** — `costComplete: false` whenever the engine omits a
    price.
16. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
    search/restore, terminal, fleet are not adapter operations yet.
17. **Attachments** — disabled in the composer with a stated reason.
18. **Native workflow owner is declared, not dispatched** — the queue refuses
    native tasks; binding native runs to engine goals/events is P15.
19. **Fingerprint is bounded and local** — 20,000 files / 64 MB, reports
    truncation; conservative invalidation, not a semantic diff.
20. **Plan export does not carry task status** — P05 project export carries
    durable project state; P19 adds import/export UI and the resume packet.
21. **Prompt library search and attachments** — P13/P19.
22. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
23. **Supervisor and Service binaries are gitignored** — P21/P22 ship and sign
    them.
24. **Physical sleep not performed** — manual lid-close test remains.
25. **Second macOS account not exercised** — P24.
26. **Artifact bytes are not portable** — import reports missing digests.
27. **Evidence generation redacts the build machine's home directory**; earlier
    P01 artifacts still contain one absolute path, recorded rather than
    rewritten.
29. **P07 shell screenshots are restored after the P11 smoke** — the P11 shell
    run rewrites those paths; they were restored to their committed bytes so
    P07's hash-pinned evidence stays valid. `p11-shell-board.png` keeps the P11
    capture.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 126 at the P11 checkpoint).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-026.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability; MONA-011/012 now
  satisfied with P11 evidence, final acceptance pending.
- `docs/decisions/ADR-001…006`; ADR-006 is the attempt/control boundary.
- `docs/evidence/macos/P00…P11-*.md` and `artifacts/p0*, p11-*`.
- `src/main/state/` — `store.ts`, `schema.ts`, `task-machine.ts`, `portable.ts`.
- `src/main/work/` — `board.ts`, `control.ts`, `fingerprint.ts`, `studio.ts`,
  `profile.ts`.
- `src/renderer/shell/` — Shell, Board, Studio, Home, Cost, Settings, drop,
  FinderIntegration.
- `scripts/` — `board-smoke.mjs`, `ci.mjs`, `smoke.mjs`, `shell-smoke.mjs`,
  `studio-smoke.mjs`, `engine-smoke.mjs`, `lifecycle-smoke.mjs`,
  `open-smoke.mjs`, `service-smoke.mjs`, build scripts.
- `AGENTS.md` — operating contract and commands (rule 3 is the stable
  three-attempt instruction).
