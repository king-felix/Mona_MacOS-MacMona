# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P10) · revision 106 · verified commit pending
**Current prompt:** P10 completed. Next eligible: **P11** — not started, not
authorized in this session.

## Where the build stands

P00–P10 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, and now a **prompt work
board and durable continuation**. Plans become bounded tasks with one execution
owner, an evidence-gated state machine, deterministic selection, resume at a
recorded step, stale-verification reopening, and a handoff generated from state.

### P10 — Prompt work board and durable continuation (complete)

- **`src/main/state/schema.ts` + migration v3** — rebuilt `tasks` to the spec
  §8.2 states, added `task_acceptance`, `task_steps`, `task_runs`,
  `task_events`; the rebuild preserves dependencies and evidence.
- **`src/main/state/task-machine.ts`** — one transition table and actor policy;
  completion is unreachable from a generic status write.
- **`src/main/state/store.ts`** — task CRUD with owner/requirements/criteria/
  steps, acceptance satisfaction by check or human, recorded steps, run receipts,
  one-running-run indexes, prerequisite checks, completion gate, stale reopening,
  dependency-cycle detection, and a single-transaction plan insert.
- **`src/main/work/board.ts`** — deterministic selection, inert plan import/
  export, exact context preview, one-prompt `runOnce`, explicit resume,
  reconciliation, and handoff.
- **`src/main/work/fingerprint.ts`** — bounded workspace + evidence digest.
- **IPC** — 18 narrow `board:*` channels; file dialogs in the main entry point;
  `board:dispatch-next` is the only prompt-submitting channel and checks the
  studio preflight first.
- **UI** — the board screen now creates tasks with owner/criteria/steps/
  dependencies, satisfies criteria, links requirement evidence, starts/resumes/
  verifies/completes, previews submitted context, imports/exports plans,
  reconciles, and runs one selected prompt.
- **Verification** — 289 tests in 34 files; P10 sample-project run **22/22**;
  Electron security smoke green with the full narrow bridge; shell smoke renders
  the 6-lane board; local CI green. Evidence:
  `docs/evidence/macos/P10-continuity.md`, `artifacts/p10-*`.

## Next exact action (P11)

Read spec §8.4 (three-attempt rule), §8.5 (resume), §10.3 (concurrency), the
prompt P11 body, O3, and this handoff. Then deliver the attempt ledger and
execution boundaries:

1. Stable problem IDs, attempt records with hypothesis/action/observed/evidence,
   total and consecutive-no-progress counters, persisted before continuation.
2. Block at the third consecutive no-progress attempt; keep unrelated eligible
   work running; Victor handoff card; human resolution/new-evidence transitions
   with an audit record that survives a new session.
3. Mechanical enforcement for Mona-owned dispatch; a documented enforcement
   boundary for engine-internal loops (no error-string guessing).
4. Pause-after-task, interrupt-now, cancel-queued, and blocker-paused connected
   to real engine/process behavior with the correct execution owner.
5. Tests and evidence: `docs/evidence/macos/P11-attempts.md`.

## Nonblocking issues carried forward

1. **No automatic runtime start from a Finder handoff** — deliberate (D-019);
   the composer is focused and **Start engine** is one click. The board dispatch
   does start the studio, but only from an explicit **Run next selected prompt**.
2. **Service install scope** — `~/Library/Services` for development; the packaged
   installer must place it in `/Library/Services` with the app and re-register
   (D-020, P21).
3. **LaunchServices ignores `/tmp` bundles** and the Services daemon can serve a
   stale record after a bundle change (D-021). P21/P24 must verify the packaged
   pair.
4. **Interactive multi-selection alert** — CLI-tested; clicking the native alert
   is human QA (P24/P26).
5. **Window drop is not automated end to end** — the equivalent Service handoff
   is proven end to end.
6. **VoiceOver reading of the Services menu and the new board** — P24/P26.
7. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
8. **Single-owner runtime** — enforced; parallel ownership needs a tested engine
   decision.
9. **Direct cost unknown** — `costComplete: false` whenever the engine omits a
   price.
10. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
    search/restore, terminal, fleet are not adapter operations yet.
11. **Attachments** — disabled in the composer with a stated reason.
12. **Native workflow owner is declared, not dispatched** — the queue refuses
    native tasks; binding native runs to engine goals/events is P15.
13. **Turn completion → task verification is explicit** — P11/P14 own automatic
    projection, attempt accounting, and resume policy.
14. **Fingerprint is bounded and local** — 20,000 files / 64 MB, reports
    truncation; conservative invalidation, not a semantic diff.
15. **Plan export does not carry task status** — P05 `mona-project-export`
    carries durable project state; P19 adds import/export UI and the resume
    packet.
16. **Prompt library search and attachments** — P13/P19.
17. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
18. **Supervisor and Service binaries are gitignored** — P21/P22 ship and sign
    them.
19. **Physical sleep not performed** — manual lid-close test remains.
20. **Second macOS account not exercised** — P24.
21. **Artifact bytes are not portable** — import reports missing digests.
22. **Evidence generation redacts the build machine's home directory**; earlier
    P01 artifacts still contain one absolute path, recorded rather than rewritten.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision from last checkpoint).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-024.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability.
- `docs/decisions/ADR-001…005`.
- `docs/evidence/macos/P00…P10-*.md` and `artifacts/p0*`.
- `src/main/state/` — `store.ts`, `schema.ts`, `task-machine.ts`, `portable.ts`.
- `src/main/work/` — `board.ts`, `fingerprint.ts`, `studio.ts`, `control.ts`,
  `profile.ts`.
- `src/renderer/shell/` — Shell, Board, Studio, Home, Cost, Settings, drop,
  FinderIntegration.
- `scripts/` — `board-smoke.mjs`, `ci.mjs`, `smoke.mjs`, `shell-smoke.mjs`,
  `studio-smoke.mjs`, `engine-smoke.mjs`, `lifecycle-smoke.mjs`,
  `open-smoke.mjs`, `service-smoke.mjs`, build scripts.
- `AGENTS.md` — operating contract and commands.
