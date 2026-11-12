# ADR-010 — One scheduler per task, and native orchestration is read, not re-implemented

**Status:** accepted · **Date:** 2026-11-12 · **Prompt:** P15

## Context

P15 has to make agent work visible and controllable without creating a second
agent engine. The pinned runtime (0.10.2) exposes four distinct orchestration
surfaces over the authenticated loopback API:

- `GET/POST /v1/agent-runs` — persisted sub-agent lane receipts, one per
  `agent …` dispatch, with lifecycle events, bounded artifacts, usage, and a
  verification summary.
- `GET /v1/threads/{id}/goal`, `PUT` (set), `/complete`, `/block`, `DELETE`
  (clear), plus the read-only `GET /v1/goals` index.
- `POST /v1/fleet/runs` (validate + journal), `POST /v1/fleet/runs/{id}/start`
  (crosses the launch gate), `POST /v1/fleet/runs/{id}/stop`,
  `GET /v1/fleet/runs/{id}/workers`, `POST /v1/fleet/workers/{id}/{stop,restart}`,
  `GET /v1/fleet/runs/{id}/receipts[/{task_id}[/evidence]]`, and
  `GET /v1/fleet/runs/{id}/events/replay`.
- The CLI `codewhale workflow` / `lane` surface, which has **no** `/v1`
  equivalent on this build.

Three forces made a naive implementation wrong:

1. **Two schedulers, one task.** Mona already owns a queue (`mona_queue`) with a
   database-enforced one-mutating-run-per-workspace index. A fleet run is a
   second scheduler with its own driver. If both can start the same task, the
   user pays twice and the workspace is mutated twice.
2. **Fake swarm.** Upstream identities are real and boring: `agent_8f9c0296`,
   `fleet-efb4a405-local-1`. A decorative graph that invents avatars, parents,
   or progress would be the exact lie the three-attempt rule exists to prevent.
3. **Unknown cost.** The sub-agent ledger reports `usage.status = unknown` with
   a note; fleet receipts carry no token or cost totals at all. A total that
   sums parent and child would double-count a parent thread total that may
   already include the child.

## Decision

### One execution owner is enforced in the schema, not in prose

`tasks.execution_owner` is `mona_queue` or `native_workflow`. The Mona queue
starts only its own tasks (`beginTaskRun` refuses an owner mismatch). A fleet
launch starts only a `native_workflow` task and is refused otherwise
(`NOT_A_NATIVE_TASK`).

The link back to the engine is `task_runs.upstream_kind` + `upstream_id` with a
**unique index**. One engine run can belong to exactly one local task run, so a
second claim fails in SQLite rather than in a convention. If the link cannot be
written, the just-created fleet run is stopped and the local run is failed; it is
never allowed to proceed unowned.

A workspace may still hold only one mutating run: the observatory refuses a
launch while `activeTaskRun` is set, and the existing partial unique index backs
that refusal.

### Mona monitors a native run; it does not dispatch its steps

`POST /v1/fleet/runs` prepares durable work; `/start` hands the run to the
engine's executor drive. Mona performs both for a launch it initiated, then stops
steering. It reads `workers`, `receipts`, and the replay journal and offers only
the controls the engine documents: stop run, stop worker, restart worker, cancel
agent run. It never sets a goal's continuation turns, never leases a task, and
never re-dispatches a task the engine already owns.

A terminal fleet run settles the local task run, then places the task in
**verification** with a fresh workspace fingerprint. Engine completion is not
Mona completion: the acceptance criteria still have to be satisfied and
verified. Mona never writes `completed` from an engine lifecycle.

### Spend is per identity and never aggregated

`SpendView` carries a confidence (`priced`, `unpriced`, `unknown`,
`not_reported`), an amount or `null`, and the exact source. A parent and a child
each report their own row. `aggregateNote` says "not additive across parent and
child" in the contract, so the renderer has no field to add and a test asserts
the view exposes no `total`.

The summary's `unknownSpend` counts rows that are not priced, so a screen can
never read as "all cost known" while fleet receipts are unpriced.

### Serial only; parallel is refused with named reasons

`launchFleet` accepts `parallelism: "serial"` as a literal and the IPC schema
rejects anything else. `ParallelQualification` carries four named checks —
isolated worktrees, distinct branch ownership, aggregate limits, merge/review
boundary — and all four are `false`, with the reason stated on screen.

This is not theoretical caution. A live probe
(`docs/evidence/macos/artifacts/p15-parallel-probe.json`) created a `parallel`
workflow with **two builder tasks declaring the same repository root** and the
pinned runtime accepted it with `201`. Mona therefore does not trust the engine
to keep two builders off one mutable tree, and does not expose a parallel launch
it cannot qualify.

### Goals: set, complete, block, clear — and no invented pause

`PUT /v1/threads/{id}/goal` with an objective makes the goal `active`, and the
engine then owns continuation. That is disclosed in the UI before the action.
The runtime documents no pause route over HTTP, so Mona offers block and clear
and the gap row says so; it does not implement pause as a local flag. Goal
controls are scoped to a thread already bound to the project.

Setting a goal does **not** make `pause-after-task` gate goal continuations. The
gap row `goal-continuation-ownership` says this explicitly, correcting the P14
handoff note.

### Disconnect falls back to a bounded projection, never a silent empty list

`orchestration_runs`, `goal_observations`, and `orchestration_events` (migration
v7) hold bounded projections: identity, lifecycle, workspace, task link,
timestamps, and a small detail object. They never hold prompts, tool output, or
transcripts. When the studio is detached, the view says `source: "stored"`, shows
`lastObservedAt`, marks goals `stale`, and disables controls. A terminal
observation never regresses to a running one on a late list read.

Local rows are pruned only after a successful live list read **and** a complete
detail read for every listed run. An unread section, or a run whose workers could
not be fetched, keeps its previous rows: "not read" is never treated as "no
workers", so an offline session cannot be mistaken for a deleted run.

Stored and detached views disable engine controls — cancel, stop run, stop or
restart worker, and fleet launch — and say why. A control is an engine
operation, so offering one that must fail would be a promise the view cannot
keep.

### Fleet workers are not duplicate agent rows

The engine lists fleet workers in the same sub-agent ledger. The observatory
keeps one row per real identity: a worker already shown under its fleet is not
repeated as a standalone sub-agent, and the worker row inherits that ledger
entry's spend, tools, and test evidence.

## Consequences

- A task started by a fleet can only be started once, and the database proves it.
- A parallel launch is impossible through Mona until every qualification check
  can be demonstrated — a real worktree per task, one branch per task, an
  aggregate cost/concurrency limit, and a named merge boundary.
- Fleet and sub-agent cost stays unknown wherever the engine is silent. This
  build does not estimate it from tokens without a recorded rate card.
- `codewhale workflow` / `lane` (checked-in JS workflows run through a Lane
  Runtime) remain terminal-only on this build; there is no `/v1` route to bind.
  The capability row records that as a gap rather than as coverage.
- The observatory is read-mostly and adds zero inference: no refresh, no screen
  render, and no control call spends a model turn.
