# P10 — Prompt execution and durable continuation

**Prompt:** P10 — Implement prompt execution and durable continuation
**Requirements:** MONA-009 (work board), MONA-010 (durable state), MONA-024
(prompt library/import/export and resume packet)
**Status:** complete, verified on this host
**Date:** 2026-11-11

## What this prompt delivers

The work board now turns a project's plans into bounded, evidence-gated tasks
over the P05 transactional store, and keeps continuation state durable without a
running GUI. It adds no model call of its own: reading the board, selecting a
task, importing a plan, reconciling state, and generating a handoff all make
zero inference requests. Only an explicit dispatch hands a prompt to the engine.

### Task model (migration v3)

`src/main/state/schema.ts` rebuilds `tasks` so its status CHECK matches spec
§8.2 exactly:

```text
pending → running → verifying → completed
running/verifying → blocked → running (new evidence or a human decision)
running/verifying → interrupted → running (reconcile and resume)
pending → skipped (explicit human scope decision with a recorded reason only)
completed → verifying (reconciliation when code changed, never a generic write)
```

`paused` and `failed` are gone from task state: pause is a queue boundary, and a
failed verification is an actionable result that returns the task to `running`.
A pre-P10 database is upgraded in place; `paused`, `failed`, and an orphaned
`running` from another machine become `interrupted`, while dependencies and
requirement evidence survive the table rebuild (the migration runner disables
foreign keys around the documented rebuild, then runs `foreign_key_check`).

New tables:

- `task_acceptance` — ordered `check` and `human` criteria with satisfaction,
  source, evidence path, and timestamp.
- `task_steps` — recorded steps with state and evidence, used for resume.
- `task_runs` — one receipt per dispatch, with owner and outcome.
- `task_events` — append-only transition audit (from, to, actor, reason).

New task fields: `execution_owner`, `requirements_json`, `next_step`,
`verification_fingerprint`, `verification_stale`, `stale_reason`, `completed_at`,
`imported_from`.

### One owner, one mutating run

- Every task declares `mona_queue` or `native_workflow`. The board selects for
  one owner at a time, and `beginTaskRun` refuses a run whose owner does not
  match the task.
- `tasks_one_running_per_project` and `task_runs_one_mutating_per_project` are
  partial unique indexes, so two mutating runs in one workspace are rejected by
  SQLite, not by convention.
- The queue is a single assignment: `runOnce` selects once, dispatches once, and
  stops. A second call returns `no_eligible_task` while the first task is still
  running.

### Evidence-gated completion

`updateTaskStatus(..., "completed")` is refused outright. The only completion
path is `completeTask`, which requires:

1. status `verifying`,
2. at least one acceptance criterion,
3. every criterion satisfied — `check` only by a recorded check with an
   evidence path, `human` only by an explicit human action,
4. one linked requirement-evidence row for every declared requirement.

Model output cannot satisfy a criterion, and no model-controlled code path calls
`completeTask`. A task with no criteria cannot be completed.

### Verification staleness

`src/main/work/fingerprint.ts` computes a deterministic digest of the workspace
(path + content, skipping `.git`, `node_modules`, build output, and similar) and
folds in that task's own evidence files. Verification records the digest.
`reconcile` recomputes it; a mismatch reopens a completed task to `verifying`,
sets `verification_stale`, clears `completed_at`, and writes a `reconciler`
audit row. One task's evidence does not invalidate another task.

### Deterministic selection, resume, handoff

- Selection is creation order (`created_at`, then id) over `pending` tasks whose
  prerequisites are all `completed` and whose owner matches. Ineligible tasks
  report their unmet and blocking prerequisites.
- Interrupted tasks keep the first step that is not completed as `next_step`;
  `resumeTask` starts at that recorded step and audits `interrupted → running`.
- `handoff` derives focus, last verified step, next exact action, blockers, open
  attempt count, and recent evidence paths from state. It is deterministic and
  never asks the model what to do next.

### Import, export, context preview

- `mona-task-plan` v1 is validated with a strict schema, resolves local keys to
  real task ids, rejects duplicate/unknown/self references and cycles, and
  inserts all tasks in one transaction. Imported tasks are `pending`, carry
  `imported_from`, and start nothing.
- Export writes the same inert plan; user-authored check/human criteria,
  requirements, steps, owner, and dependencies survive a round trip. Status is
  deliberately not exported: importing a plan creates unstarted work.
- `previewContext` returns the exact bytes that would be submitted — title,
  prompt, criteria, requirement ids — and lists what is excluded (the full
  product specification, the full prompt sequence, other workspaces). A test
  asserts neither design document appears.

### Surfaces

- Main: `src/main/work/board.ts` (board service), `src/main/work/fingerprint.ts`,
  `src/main/state/task-machine.ts`, `src/main/state/store.ts` (task records,
  transitions, runs, gate, staleness), migration v3.
- IPC: 18 narrow `board:*` channels; `board:dispatch-next` is the only channel
  that can hand a prompt to the engine, and it checks the studio preflight
  first. File import/export dialogs live in the main entry point and cap plans
  at 2 MB.
- Renderer: `src/renderer/shell/Board.tsx` replaces the P07 placeholder with a
  live board: create tasks with owner/criteria/steps/dependencies, satisfy
  criteria, link requirement evidence, start/resume/verify/complete, preview the
  submitted context, import/export plans, reconcile, and run one selected
  prompt. `WorkStatus` gained `verifying` and `skipped`.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (main + renderer) | clean |
| `npx vitest run` | **290 tests in 34 files passed** |
| P10 sample-project run (`npm run smoke:board`) | **22/22 checks passed** |
| Electron security smoke (`npm run smoke`) | `ok: true`, `bridge_is_narrow: true` |
| Shell smoke (`npm run smoke:shell`) | board rendered, task present, **6 lanes**, no overflow |
| `npm run build` | main + renderer built |
| Local CI (`npm run ci`) | see `docs/evidence/macos/artifacts/p10-ci.txt` |

### Board tests (`test/work-board.test.ts`, 12 tests)

- Dependency cycles are rejected at import and at `addTaskDependency`, with no
  partial import.
- A task starts only after completed prerequisites; independent work keeps its
  own status while a dependent task waits with its blocking prerequisite named.
- One owner and one mutating run per workspace; cross-project selection never
  leaks task ids.
- Completion without criteria, with unsatisfied criteria, with a kind mismatch,
  or without requirement evidence is refused; a direct status write cannot
  complete.
- A workspace change reopens completed verification.
- An interrupted task resumes at its recorded step and audits the transition.
- Plans import inert, criteria survive export/re-import, the queue runs one
  prompt and stops, context preview excludes the design documents, and the
  handoff names the resume step.
- A pending task can be edited; an active run refuses edits; linked requirement
  evidence is visible on the task.

### Sample project run (`artifacts/p10-board-sample.txt`)

The run uses the compiled `StateStore` and `TaskBoard` against a temporary
workspace, executes a real `node --test test/feature.test.mjs`, records the
output as evidence, and reports:

```text
dependency_cycle_rejected   no_partial_import        import_is_inert
imported_tasks_pending      imported_owner_default   deterministic_selection
preview_has_prompt          preview_excludes_spec    queue_ran_one
queue_stopped               other_tasks_unstarted    running_is_one
evidence_gated_completion   prerequisite_verified    interrupted_next_step
resume_at_recorded_step     stale_after_code_change  criteria_survive_export
round_trip_criteria         workspaces_isolated      handoff_from_state
transitions_audited
```

### Build ledger — same discipline, no GUI required

The Mona build ledger was advanced with the same semantics without using the
unfinished work board:

- prompt state changes go through `monabuild checkpoint` with a revision CAS;
- evidence is added by path and SHA-256;
- shared files changed by P10 (IPC, preload, styles, package scripts) made the
  P00/P02/P03/P04/P09 evidence hashes stale; those hashes were re-recorded against
  the current files, and no requirement status was lowered;
- the requirement registry is regenerated from the specifications;
- the sample project run above is a headless script, so the board's behavior is
  provable even when the Electron window is not running.

This keeps `.mona/build-macos/` (building Mona) separate from a user project's
board, as spec §8.1 requires.

## Known limits and next prompts

1. **Native workflow owner is declared but not dispatched by Mona.** P10 records
   `native_workflow` ownership and refuses queue starts for it; binding native
   workflow runs to real engine goals/events is P15.
2. **Turn outcome → task verification is explicit.** Dispatch starts one run and
   records the receipt. Marking implementation ready and completing remain
   explicit actions; automatic turn-completion projection belongs to P11/P14
   with the attempt ledger and resume brief.
3. **Fingerprint is bounded and local.** It hashes up to 20,000 files / 64 MB and
   reports `truncated`; it is a conservative invalidation signal, not a semantic
   diff. A truncated workspace may reopen a task when the scanned window changes.
4. **Plan format v1 has no status field.** Exporting a plan is not exporting
   project state; P05 `mona-project-export` carries durable state.
5. **Attachment and prompt-library search** remain P19/P13 work.
6. **Physical two-account and VoiceOver board checks** remain P24/P26.

## Artifacts

- `docs/evidence/macos/artifacts/p10-board-sample.txt` — sample run report.
- `docs/evidence/macos/artifacts/p10-board.png` — board screen from the shell
  smoke (6 lanes, real task).
- `docs/evidence/macos/artifacts/p10-ci.txt` — local CI transcript.
- Source and tests listed above.
