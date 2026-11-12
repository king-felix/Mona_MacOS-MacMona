# ADR-006 — Attempt enforcement boundary

- **Date:** 2026-11-11 (P11)
- **Status:** accepted
- **Prompt:** P11 — Enforce the three-attempt rule and clear stop controls
- **Requirements:** MONA-011, MONA-012
- **Related:** spec §8.4, §8.5, §10.3; O3; AGENTS.md rule 3; ADR-005

## Context

The three-attempt rule has two very different surfaces. Mona owns task selection,
dispatch, retries, and process lifecycle, so it can count and stop those
mechanically. Inside one engine turn, the engine owns the loop: it may retry
tool calls, reformulate a hypothesis, or change an error string without telling
Mona anything structured. A desktop app that claimed to enforce a semantic
attempt limit there would be guessing from prose.

The spec forbids exactly that guess (§8.4): “do not claim perfect semantic
enforcement by parsing error text.” It asks for a stable instruction, structured
attempt reports where available, honest visibility, and a stated boundary. This
ADR records where the line is and why each side of it is implemented the way it
is.

## Decision

### Mechanically enforced by Mona

1. **Stable problem identity.** `problems` has one active row per
   `(project, task, requirement)`. The first attempt creates a `prb_…` id; later
   attempts on the same task and requirement reuse it even when the observed
   symptom or error string changes. A taskless problem keys on a normalized
   symptom fingerprint. Partial unique indexes make a second active row for the
   same problem impossible, so reopening a session or rewording an error cannot
   fork the count.
2. **Counters live on the problem row.** Every attempt is one transaction that
   inserts the attempt, increments `total_attempts`, and moves
   `no_progress_attempts`. The column CHECK caps the consecutive counter at
   three. There is no code path that writes the counters from the UI.
3. **Material progress is evidenced.** `material_progress = 1` requires linked
   evidence or a short recorded reason. Without one the store refuses the
   attempt; the consecutive counter is never reset by an unexplained claim.
4. **The third consecutive no-progress attempt blocks.** The same transaction
   sets `status = 'blocked'`, records `help_needed`, appends a `blocked` audit
   event, interrupts the task's running receipt, and moves a `running` or
   `verifying` task to `blocked`. A `pending` task has no legal transition to
   `blocked` (spec §8.2), so its problem blocks instead; selection and
   `beginTaskRun` refuse it.
5. **The fourth attempt is refused in code.** `recordProblemAttempt` on a
   blocked problem throws `CONFLICT` before inserting an attempt. This covers a
   restarted session, a new UI, and a direct store caller. Reopening is the only
   reset path and requires new evidence plus a reason.
6. **Acknowledgement is not progress.** `acknowledgeProblem` writes an
   `acknowledged` audit event and changes no counter. It cannot unblock a task.
7. **Dispatch cannot route around a block.** Board selection excludes tasks with
   a blocked problem and reports why; `beginTaskRun` and a direct
   `updateTaskStatus(..., 'running')` both re-check the database. Dependents of a
   problem-blocked task are reported as waiting with the blocking task id, while
   genuinely independent eligible tasks stay selectable. `runOnce` still starts
   exactly one task and stops.
8. **Audit survives the session.** Attempts, events, counters, `blocked_at`,
   `resolved_at`, and `resolution` are ordinary rows in the project database.
   A new process reads the same count. There is no in-memory attempt state.
9. **A problem belongs to exactly one task or to none.** A task-bound attempt
   keys only on its `(project, task, requirement)` and never adopts a taskless
   problem, so a block can never detach from the task that selection and
   `beginTaskRun` check.
10. **A replace import clears the ledger.** `deleteProjectContents` removes
    `problem_events` and `problems` before deleting tasks. Carrying a block
    across a supported replace import would either apply it to a task the
    bundle never described or orphan it via `ON DELETE SET NULL`. Imported
    tasks keep the status the bundle recorded; the block itself is not
    reconstructed without the attempts that justified it.

### Cooperative or unobservable

- **Inside one engine turn.** Mona cannot see the engine's internal retries as
  structured attempts. It does not parse error strings, count tool calls as
  attempts, or pay a second model to watch the first. The stable instruction is
  AGENTS.md rule 3 (also mirroring O3), which travels with the repository. When
  an executor can report a hypothesis-and-result cycle, it calls
  `board:attempt`; that report is evidence of a report, not proof that a test
  actually passed. Test evidence is still a recorded check path, never a model
  claim.
- **Native hooks/events.** The pinned engine 0.10.2 exposes no qualified
  event that can deterministically stop an internal retry loop. P15 owns
  qualifying native goals/fleets/workflows. Until then Mona does not pretend
  those hooks exist; it offers **Interrupt now** and **Stop engine**, both with
  receipts.
- **The assistant's self-report.** “Almost there,” a new theory, or more code is
  not material progress. The store only accepts an evidenced attempt, and a
  human resolution is a separate, audited transition.

### Control boundaries (spec §10.3)

These are distinct actions with distinct owners, and P11 connects each to real
engine or process behavior:

- **Pause after task** is a Mona queue boundary. The dispatch preflight refuses
  new `mona_queue` work while the boundary is set; the active turn continues.
  It does not gate a `native_workflow`-owned task, and the note says so instead
  of implying a global stop.
- **Interrupt now** is an engine operation. The action returns the engine turn
  it targeted, and a task is attributed only when `tasks.active_turn_id` equals
  that turn. A confirmed receipt moves that task to `interrupted` and clears the
  link; an uncertain receipt leaves the task `running` and appends an audit note
  requiring reconciliation. A finished turn releases its link
  (`onTurnFinished` → `clearFinishedTurn`), so a later manual turn's interrupt
  can never inherit it. It never claims rollback.
- **Cancel queued** removes future starts only. The active turn is untouched.
  Because P11 dispatches one prompt per assignment, the queue is usually empty,
  and the result says so rather than inventing cancellations.
- **Blocker-paused** is not a process state. A blocked problem makes its task
  ineligible and keeps the requirement visible; it never masquerades as a stopped
  process or a completed task.

### What remains unenforced by design

- A script run entirely outside Mona and the engine can ignore repository
  instructions. Mona cannot and does not claim otherwise.
- An engine-internal loop may consume tokens until a human interrupts or the
  provider stops it. Mona records the block that follows and refuses a fourth
  dispatch from its own queue; it does not promise that the engine's internal
  loop shared the same counter.
- Process stop cannot undo external side effects or already-sent requests. The
  UI and receipts say `rollback: not_promised`.

## Consequences

- The test surface is deterministic: fixture sequences 1/2/3, a reset with
  evidence, a session restart, an acknowledgement, a dependency block, and an
  independent task all read the same stored rows.
- `attempts` retains the pre-P11 journal method for historical/imported rows.
  It is not exposed through IPC. All product paths use
  `recordProblemAttempt`.
- P15 may add native hook enforcement after qualifying it. It must update this
  ADR rather than silently changing the claim in the UI.
- P14 owns projecting a finished engine turn into task verification. P11 stops at
  linking the turn to the task and honoring an interrupt receipt.
