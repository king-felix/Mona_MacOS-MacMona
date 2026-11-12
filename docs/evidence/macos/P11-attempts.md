# P11 — Attempt ledger and execution boundaries

**Prompt:** P11 — Enforce the three-attempt rule and clear stop controls
**Requirements:** MONA-011 (three-attempt enforcement), MONA-012 (pause after
task, interrupt now, queue cancel, resume, truthful uncertain outcomes)
**Status:** complete, verified on this host
**Date:** 2026-11-11
**Decision record:** `docs/decisions/ADR-006-attempt-enforcement-boundary.md`

## What this prompt delivers

Mona now has a durable problem ledger and enforces its own retry boundary in
one transaction. A problem keeps a stable id and two counters across sessions;
three consecutive attempts without material progress block it and its task; a
fourth attempt is refused in the store, not hidden in the UI. Acknowledging a
notification cannot reset the count, and only new evidence with a reason or a
human decision can reopen or resolve the problem. The Victor handoff card is
generated from those stored rows.

Nothing in this path calls a model. Recording an attempt, selecting work,
blocking, acknowledging, reopening, resolving, and rendering the handoff are
local state operations.

### Schema (migration v4)

`src/main/state/schema.ts` adds:

- `problems` — stable id, project, task, requirement, current symptom, symptom
  fingerprint, status (`open` / `blocked` / `resolved`), `total_attempts`,
  `no_progress_attempts` (CHECK 0–3), `help_needed`, `blocked_at`,
  `resolved_at`, `resolution`, revision.
  Two partial unique indexes keep one active problem per
  `(project, task, requirement)` and one per taskless symptom fingerprint.
- `problem_events` — append-only audit: `created`, `attempt`,
  `progress_reset`, `blocked`, `acknowledged`, `reopened`, `resolved`, with
  actor, reason, and evidence paths.
- `tasks.active_turn_id` — links a Mona dispatch to the engine turn it opened,
  so a confirmed interrupt names the task it stopped.

### Mechanical enforcement

- `StateStore.recordProblemAttempt` creates or finds the stable problem, inserts
  the attempt, moves both counters, and blocks at the third consecutive
  no-progress attempt — all inside one SQLite transaction.
- A progress claim without linked evidence or a short reason is refused before
  any counter resets.
- A blocked problem refuses a new attempt with `CONFLICT`; `reopenProblem` is the
  only reset path and requires a reason plus at least one evidence path.
- Blocking a `running` or `verifying` task moves it to `blocked`, writes a
  `task_events` audit row, and interrupts the task's running receipt. A
  `pending` task has no legal edge to `blocked` (spec §8.2), so the problem
  blocks and both selection and `beginTaskRun` refuse the task.
- `beginTaskRun` and a direct `updateTaskStatus(..., "running")` re-check the
  database for a blocked problem, so a caller cannot skip board selection.
- Board selection reports a problem-blocked task as waiting, reports dependents
  with the blocking task id, and leaves genuinely independent eligible work
  selectable. `runOnce` still starts exactly one task and stops.
- `acknowledgeProblem` appends an `acknowledged` event and changes no counter.

### Control boundaries

- **Pause after task** now gates the dispatch preflight for `mona_queue` work and
  is checked again in `dispatchNext`; the note states that a
  `native_workflow`-owned task is not gated by Mona's queue.
- **Interrupt now** returns the engine receipt and, through the IPC boundary,
  links it to the task. Confirmed: task → `interrupted`, recorded turn cleared.
  Uncertain: status stays `running` and a `task_events` note records that
  reconciliation is required. No rollback is claimed.
- **Cancel queued** reports the real, usually empty, queue instead of inventing
  cancellations; the active turn is untouched.
- **Blocker-paused** is a task/problem state, not a process state.

The boundary between what Mona can enforce and what the engine owns is recorded
in ADR-006. Inside one engine turn Mona does not parse error strings, count
tool calls as attempts, or pay a second model to watch the first. AGENTS.md
rule 3 remains the stable instruction; structured reports arrive through
`board:attempt`; native hook enforcement waits for a qualified engine event
(P15).

## Acceptance evidence

`test/work-attempts.test.ts` (14 tests) covers the prompt's acceptance list:

- fixture sequence 1/2/3 with a changed error string keeping the same problem
  id, blocking at three, and a fourth attempt refused with `CONFLICT`;
- evidenced material progress resetting only the consecutive counter, and an
  unevidenced progress claim refused;
- a new store session over the same database retaining 3 total / 3 consecutive,
  still blocked, with the fourth attempt refused and the handoff card intact;
- acknowledgement leaving both counters untouched;
- dependency propagation: the dependent waits, the independent task is selected
  and runs, and the blocked task is never dispatched;
- a pending task with a blocked problem staying `pending` but undispatchable;
- reopen requiring evidence, preserving the total, resetting only consecutive,
  resuming the task, and appending `reopened`; human resolution ending the
  problem and allowing resume;
- a new recurrence after resolution creating a new problem rather than
  inheriting the resolved one;
- the pause gate refusing dispatch with zero executor calls;
- a confirmed interrupt moving the linked task to `interrupted`, and an
  uncertain one leaving it `running` with an audit note;
- **attribution by turn identity** — an interrupt of `turn_manual` or of a turn
  whose completion already released the link changes no task;
- **replace import clears the ledger** — no active problem or event survives, so
  a re-imported task is not falsely blocked and a new attempt starts at 1;
- **the handoff never says “Start”** for a pending task whose problem is
  blocked, and instead names the unblock step;
- **a task-bound attempt never adopts a taskless problem**, so the block cannot
  detach from the task that selection and `beginTaskRun` check.

Commands and captured output:

```sh
node tools/monabuild/cli.mjs secrets
npx vitest run
node scripts/board-smoke.mjs
npm run smoke:shell
npm run ci
```

Observed results on this host:

- **Tests:** 304 passed in 35 files. Evidence:
  `docs/evidence/macos/artifacts/p11-tests.txt`.
- **Board sample run:** 37/37 checks, including 15 new P11 checks
  (`attempt_one_open`, `attempt_two_same_problem`, `attempt_three_blocks`,
  `attempt_task_blocked`, `attempt_fourth_rejected`, `attempt_ack_keeps_count`,
  `independent_work_continues`, `pause_gate_blocks_dispatch`,
  `victor_handoff_card`, `handoff_names_unblock_not_start`,
  `interrupt_attribution_by_turn`, `finished_turn_releases_link`,
  `reopen_keeps_total`, `reopen_allows_resume`, `attempt_audit`). The sample
  records the fourth-retry refusal as
  `CONFLICT: this problem is blocked after three attempts without progress`.
  Evidence: `docs/evidence/macos/artifacts/p11-board-sample.json` and
  `docs/evidence/macos/artifacts/p11-attempts.txt`.
- **Shell smoke:** 44/44 checks with a real seeded blocked problem. The rendered
  board shows the Victor handoff card, the exact help text, the requirement, and
  `3 attempts · 3 consecutive without progress`; the opened blocked task shows
  three attempt records, the acknowledge/reopen/resolve controls, and a disabled
  resume; the six lanes render without horizontal overflow. Evidence:
  `docs/evidence/macos/artifacts/p11-shell-smoke.json`,
  `docs/evidence/macos/artifacts/p11-shell-board.png`, and
  `docs/evidence/macos/artifacts/p11-shell-attempts.png`.
- **Local CI:** all eight steps green (format, lint, typecheck, supervisor,
  service, tests, build, board smoke) and the renderer scan found no secrets or
  source maps. Evidence: `docs/evidence/macos/artifacts/p11-ci.txt`.

The shell smoke rewrites the P07 screenshot paths when it runs. Those files were
restored to their committed bytes immediately afterwards so P07's hash-pinned
evidence stays valid; the P11 capture is preserved separately.

## Review findings closed before the checkpoint

An independent adversarial review of the diff found three defects that were
fixed and covered by new tests rather than deferred:

1. **Replace import did not clear the ledger.** `deleteProjectContents` omitted
   `problems` and `problem_events`; deleting tasks set `problems.task_id` to
   NULL, which orphaned an active block (a fourth attempt became reachable after
   a supported replace import) and could collide on the taskless fingerprint
   index. The import now deletes child problem events before problems and before
   tasks. Test: “clears the problem ledger on a replace import”.
2. **Interrupt attribution was a heuristic.** It matched any `running` task with
   a non-null `active_turn_id`, so a confirmed interrupt of an unrelated manual
   turn could flip a task whose turn had already finished. `interrupt` now
   returns the targeted `turnId`, `noteEngineInterrupt` requires an exact match,
   and `WorkStudio` releases the link when the engine reports that turn
   finished. Test: “attributes an interrupt only to the task linked to that
   exact turn”.
3. **The handoff told the human to start a refused task.** A pending task with a
   blocked problem fell through to `Start "…"`. The handoff now branches on the
   blocked card and names the unblock step. Test: “tells the human to unblock,
   never to start”.
4. **A taskless problem could be adopted by a task attempt**, leaving the block
   detached from the task that selection checks. A task-bound attempt now keys
   only on its task and requirement. Test: “never adopts a taskless problem”.

## Honest limits

1. **Engine-internal loops remain cooperative.** A retry loop that lives inside
   one engine turn is not machine-observable without text guessing. Mona stops
   its own dispatch, records the blocked problem, and offers Interrupt now /
   Stop engine with receipts. It does not claim a semantic guarantee there.
2. **Native workflows are not gated by pause-after-task.** The note says so.
   P15 owns native goal/fleet dispatch and any event-based enforcement.
3. **Turn completion is not auto-projected.** P11 links a dispatch to its turn
   and honors an interrupt receipt. Moving a finished turn to verification is
   P14's explicit boundary; a task stays `running` until a human records the
   verification, so no completion is inferred from a quiet stream.
4. **A confirmed live interrupt is P08 evidence.** P11 tests the linkage and the
   uncertain path deterministically; it did not spend a new live turn merely to
   reproduce P08's confirmed receipt.
5. **Attempt/event rows are not exported.** Portable export carries tasks,
   criteria, and requirement evidence; the problem ledger is operational state
   scoped to this machine's store, and a replace import clears it rather than
   carrying a stale block into a new project. A new session over the same
   database retains the count, which is the prompt's requirement. The P19 resume
   packet may include a redacted problem summary.
6. **The legacy `recordAttempt` journal method remains** for historical/imported
   rows and is not exposed through IPC. All product paths use the enforced
   ledger.
