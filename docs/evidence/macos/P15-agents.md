# P15 — Agent observatory and native workflows

**Prompt:** P15 (prerequisites P11, P12, P13) · **Requirements:** MONA-018
(satisfied), MONA-019 (partial) · **Date:** 2026-11-12 · **Engine:** Codewhale
0.10.2, commit `ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`

## What this prompt delivered

A new **Agents** screen and the main-process service behind it. It reads the
engine's real orchestration state over the authenticated loopback API, shows it
with real upstream identities, and offers only the controls the pinned runtime
documents. It never schedules a second engine, never dispatches a workflow's
internal steps, and never converts an unknown cost or lifecycle into a known one.

- `src/shared/contracts/agents.ts` — run, worker, fleet, receipt, goal,
  spend-confidence, test-evidence, ownership, parallel-qualification, and gap
  types with zod schemas for every persisted or IPC-carried value.
- `src/main/engine/adapter.ts` — 16 new adapter methods with wire validation
  (`WireAgentRun*`, `WireThreadGoal`, `WireGoalList`, `WireFleet*`).
- `src/main/work/agents.ts` — `AgentObservatory`: snapshot, fleet detail,
  history, agent-run cancel, fleet stop, worker stop/restart, goal
  set/complete/block/clear, and one serial fleet launch.
- `src/main/state/schema.ts` — migration **v7**: `orchestration_runs`,
  `goal_observations`, `orchestration_events`, plus
  `task_runs.upstream_kind/upstream_id` with a unique index.
- `src/renderer/shell/Agents.tsx` + design icon + raw CSS — the screen.
- `scripts/agents-smoke.mjs` — deterministic fixture suite and a `--live`
  qualification run; wired into `npm run ci` as `smoke:agents`.

## Routes verified on the pinned build

Each was exercised against a real `app-server --http` process with a private
bearer token. No `--auth` or shell command was routed around the API.

| Route | Verified behavior |
|---|---|
| `GET /v1/agent-runs` | Real sub-agent records with `spec.run_id`, `worker_id`, role, workspace, `actor_kind`, lifecycle events, artifacts, `usage.status`, and `verification.status` |
| `GET /v1/agent-runs/{id}` | One record; unknown id → `404` |
| `POST /v1/agent-runs/{id}/cancel` | `200` with the terminal record for an already-finished run; `202` handling is implemented per the documented contract |
| `GET /v1/threads/{id}/goal` | `404` when no goal exists, the record otherwise |
| `PUT /v1/threads/{id}/goal` | `201` with `status: "active"`; the objective is trimmed server-side |
| `POST …/goal/block`, `…/goal/complete` | `200` with the new status |
| `DELETE …/goal` | `204`; a later `GET /v1/goals` is empty |
| `POST …/goal/pause` | **`404` — no such route** (`p15-goal-probe.json`) |
| `GET /v1/goals` | Index; bad `status` filter → `400 "unknown goal status 'bogus'"` |
| `POST /v1/fleet/runs` | `201 awaiting_start` with run, task specs, worker specs, frozen member metadata |
| `POST /v1/fleet/runs/{id}/start` | `202` `execution: scheduled`, `leased: 0`, worker ids |
| `GET /v1/fleet/runs/{id}/workers` | Worker status, host, heartbeat, last event with payload, artifacts |
| `GET /v1/fleet/runs/{id}/receipts` | Per-task receipt: result, score, failure class, retry eligibility, artifacts, `evidence_available` |
| `GET /v1/fleet/runs/{id}/receipts/{task}/evidence` | The verification artifact with path, checksum, size, `truncated` |
| `GET /v1/fleet/runs/{id}/events/replay` | Cursored run/task/worker transitions |
| `POST /v1/fleet/runs/{id}/stop` | `200` with `stopped` count; run becomes `cancelled` |
| `POST /v1/fleet/workers/{id}/stop`, `…/restart` | `200` with the worker record |

## One real delegated workflow run

`docs/evidence/macos/artifacts/p15-agents-live.json` — 10/10 checks.

1. Started an owned runtime (native binary, listener pid recorded).
2. Created a board task owned by `native_workflow` with one acceptance criterion.
3. `AgentObservatory.launchFleet` created a one-task `parallel` workflow with a
   `reviewer` role, linked `task_runs.upstream_id` to the new run, and started it
   (`202`).
4. The engine's own executor produced `fleet-23804495`:
   - worker `fleet-23804495-local-1`, role `reviewer`, `"completed exit_code=0 P15-OK"`;
   - receipt `result: "partial"`, score `0.5/1` with the engine's reason
     ("worker produced 6 characters of deliverable: P15-OK");
   - a readable verification artifact (1083 bytes, `sha256:064aa98c…`).
5. The observatory showed the run linked to the task, with
   `spend: not_reported` and one unknown-spend row.
6. The local task run settled and the task moved to **`verifying`** — not
   `completed`. The workspace fingerprint was recorded.
7. The worker row inherited the ledger's unknown usage and self-reported
   verification instead of inventing either (`live-worker-inherits-ledger`).
8. The one-mutating-run owner was released.

The run was written to `/tmp` and the task prompt was "Reply with exactly
P15-OK. Do not read, create, edit, or delete any file." The only inference was
that one 6-character reply.

## One scheduler per task

- `tasks.execution_owner` is `mona_queue` or `native_workflow`; the Mona queue
  refuses a task it does not own, and `launchFleet` refuses a task owned by Mona
  with `NOT_A_NATIVE_TASK`.
- `task_runs.upstream_id` is unique, so two local runs cannot claim one engine
  run. If the link cannot be written, the created fleet run is stopped and the
  local run fails; the run never proceeds unowned.
- A launch is refused while another mutating run is active.
- `WorkController.pauseAfterTask` still does **not** gate a native workflow's own
  scheduler. The P14 handoff note said this was P15's job; the honest result is
  that Mona cannot install a boundary in a scheduler it does not own, so the
  control's own note and the `goal-continuation-ownership` gap now say so.

## Parallel execution is refused, with evidence

The prompt allows parallel work only with isolated worktrees, branch ownership,
aggregate limits, and a merge boundary. None is available, and the engine does
not supply the first one either: a live probe created a `parallel` workflow with
**two builder tasks declaring `root: "."`** and the pinned runtime accepted it
with `201` (`p15-parallel-probe.json`). Mona therefore:

- accepts only `parallelism: "serial"` (the IPC schema rejects anything else);
- launches exactly one task per run;
- renders four qualification checks, all failing, with the reason for each;
- performs no merge, so it cannot delete a branch and cannot silently resolve a
  conflict.

## Fixtures for the failure cases

`p15-agents-smoke.json` — 13/13 checks over a scripted adapter and a real SQLite
store:

- **child failure** — a `failed` child renders as failed and terminal, never green;
- **disconnect** — the view becomes `stored`, keeps `lastObservedAt`, and shows
  every run's spend as unknown;
- **unknown usage** — the sub-agent ledger's `usage.status: "unknown"` reaches
  the screen verbatim;
- **blocked dependency** — a task with an unmet prerequisite is refused before
  any engine call, by the store's own check;
- **cancel** — an accepted `202` is recorded and reported as "poll", not as a
  terminal success;
- **partial completion** — `partial` is shown as partial, with the engine's score
  note, and never becomes `completed`.

## Ownership and spend rules proven by tests

`test/work-agents.test.ts` (17 tests): real identities and unknown spend; a
sub-agent attributed to its origin turn without an invented parent; parent and
child spend reported separately with no total in the view; stored fallback;
`202` cancel; refused control without a live studio; refusal of a Mona-queue
task; a full launch that links, settles, and moves the task to verification; goal
scoping to project-bound threads; goal complete/block/clear with receipts.

`test/engine-orchestration.test.ts` (10 tests): wire validation and normalization
for agent runs, goals, fleet runs, workers, receipts, and evidence, including a
`422` fleet refusal surfaced as `CONTROL_REFUSED`.

`test/agents-screen.test.tsx` (5 tests): rendering of real identities, the
serial boundary and gap rows, a deliberate confirmation before cancel, and the
disconnected stored view with no enabled goal control.

`test/ipc-contract.test.ts` (27 tests, 4 new): every orchestration channel is a
strict object; `parallelism: "parallel"` and an unknown role are rejected.

## Real-shell verification

`p15-shell-agents.json` — 99/99 checks on the actual Electron app, including
`nav_count: 7`, `Command-7` reaching the Agents screen, the honest
"Not connected" / "The live studio is not attached" state with the last stored
rows, seven gap rows, four failing parallel checks, a launch control refused
because a detached view publishes no fleet capability, an inspector with real
identity/parent/spend fields and a disabled cancel, a stored goal whose controls
are locked, and no horizontal overflow.
`p15-agents-daybreak.png`, `p15-agents-afterglow.png`, and `p15-agents-inspector.png` are the captures.

## Verification summary

- 469 tests in 50 files.
- `npm run ci` green: format, lint, typecheck, builds, tests, and five smokes
  (`board`, `cost`, `changes`, `polish`, `agents`) — `p15-ci.json`.
- Shell smoke green — 99/99.
- Live engine run green — 10/10; fixture suite — 13/13.

## Review pass (D-041)

An independent reviewer read the change and was interrupted after a thorough
pass; its findings were verified against the code and six were real. All six are
fixed with regression tests:

1. **A failed route read rendered as an empty list.** Fixed: per-section fallback
   to the stored projection, with the failure named (`keeps a section's last
   observation when its live read fails`).
2. **A failed launch could also return a result object.** `refused()` now returns
   `never`; a refused create/start throws after recording its receipt
   (`fails the local run and records a receipt when fleet creation is refused`).
3. **Pruning deleted stored workers when a run's detail load failed.** Pruning is
   now gated on every listed run's detail being read (`never prunes a run's
   stored workers when that run's detail read failed`).
4. **Goal receipts hardcoded HTTP `200`.** The adapter now returns the status the
   engine answered (201/200/204/404) and the receipt carries it.
5. **A fleet worker could lose its ledger spend, tools, and tests** when its
   ledger row named the runtime workspace instead of the project root. The whole
   ledger is normalized before the project filter
   (`inherits a worker's tools, tests, and usage…`), and the live smoke asserts
   it (`live-worker-inherits-ledger`).
6. **Engine controls stayed enabled in a stored view.** Cancel, stop, restart,
   and launch are now gated on a live, capable engine with a stated reason
   (`refuses to offer a fleet launch the runtime cannot start`, plus the
   disabled-cancel assertion).

## Gaps and limits recorded honestly

1. **Checked-in workflows are unreachable.** `codewhale workflow` / `lane` have
   no `/v1` route on 0.10.2 (`strings` on the pinned binary shows no
   `/v1/workflow*`). MONA-CAP-018/019 are `blocked_gap`; MONA-019 is `partial`.
   P18 owns the coverage decision.
2. **No goal pause.** Only set/complete/block/clear exist. Mona offers those and
   says pause is unavailable; it does not implement pause as a local flag.
3. **Setting an active goal starts engine work.** Disclosed in the UI before the
   action. Mona does not drive goal continuation turns.
4. **Fleet and sub-agent cost is unknown or not reported.** No token totals on
   fleet records; the sub-agent ledger says unknown. No total is derived.
5. **Parallel launch is refused.** The engine accepted overlapping writer roots
   in a live probe; Mona will not rely on it.
6. **No remote target.** `another_computer` and `cloud` return `501`; Mona sends
   `this_computer` only.
7. **`202` cancel is implemented from the documented contract.** Every live
   cancellation observed returned `200` because the run was already terminal.
8. **The probe left one completed fleet run in the shared engine ledger**
   (`fleet-efb4a405`, a 6-character reply, no file changes). Every other probe run
   was cancelled; none was started.
9. **Sub-agent parentage is upstream-only.** `parent_run_id` (or
   `parent_agent_id`) is shown when the engine reports it; Mona never infers a
   parent from timing or objective text.
10. **Branch is a local Git read.** The engine's sub-agent record carries a
    workspace but not a branch; the observatory reads `HEAD` locally and labels
    the source `local_git`.
