# R08 — Follow-ups, qualified steering and current activity

**Reviewed against:** `MacMona_Studio_Review_PROMPTS.md` §R08.
**Requirements:** MONA-018, MONA-019 (contribution); MONA-019 stays `partial`
because the engine still exposes no steer route.
**Feature:** UX-AGENT-COMMS.
**Platform:** darwin-arm64, Electron 45, pinned `codewhale 0.10.2` (`ff466b2ed0bf`).

## The rule this task is built around

A follow-up is a person's sentence, not a scheduler's guess. Three facts are
kept separate everywhere in the code:

- **queued** — the row exists and nothing was sent;
- **accepted** — the Runtime returned a turn id;
- **unknown** — the write may or may not have landed, and it is never resent.

Mona already refuses a second mutating turn in one workspace, so the queue is a
*dispatch boundary*, not a second executor. Nothing in this task starts a timer,
a loop, or a background narrator.

## What changed

### Durable queue (schema v13)

`src/main/state/schema.ts` adds `follow_ups`:

- `thread_id` and `engine_thread_id` are captured **when the person queues it**
  and are never re-derived. That is what makes "target stays stable" a fact
  rather than an intention.
- `status ∈ queued | dispatching | accepted | rejected | canceled | unknown |
  stale`, plus `operation_key`, `turn_id`, and a bounded `note`.
- `prompt` is bounded at 100,000 characters, the same bound as the composer.
- No foreign key to `threads`: `/new` deletes nothing, and the row must survive
  as a record of what was queued for a conversation that has since been
  replaced.
- `deleteProjectContents` removes the rows with their project, and
  `REQUIRED_TABLES`/`requiredTablesFor` include the table so an older database
  reports its real version instead of passing.

### The single dispatch owner

`src/main/work/studio.ts`:

- `enqueueFollowUp` writes the row and returns. It sends nothing.
- `editFollowUp` and `cancelFollowUp` are compare-and-set on `status = 'queued'`;
  a claimed row refuses both and the note names the current status.
- `dispatchFollowUps` is the explicit send-now path. It refuses while a turn is
  active and while the Mona queue is paused.
- `dispatchNextFollowUp` is the only automatic path. It runs **once per finished
  turn**, deferred past the ingest iteration with a `setTimeout(0)` so a
  follow-up in another conversation cannot await the pump that is carrying the
  completion event (that would deadlock the reader).
- The claim is `UPDATE … SET status='dispatching' WHERE id=? AND status='queued'`.
  SQLite serialises it, so two dispatchers cannot both win. A test asserts that
  directly on the store.
- The transmit body was extracted into `transmit()`, shared by the composer and
  the queue, so the two cannot disagree about acceptance, reconciliation, or
  which binding became active.
- Budget: `CostLedger.dispatchGate` is evaluated before the claim. A stop leaves
  the row `queued` with `blocked by budget: …` recorded; no retry loop is
  started on its behalf.
- Pause: `WorkController.pauseAfterTask` is consulted before the claim, so a
  paused queue never starts a turn.
- Stale: if `session.bindings[mode].engineThreadId` is no longer the row's
  target (a `/new` happened), the row settles `stale` with both ids in the note
  and is not sent.
- Uncertain: the adapter's own `reconcileSubmission` decides between `accepted`
  and `unknown`. A second dispatch call cannot resend an unsettled row.

### Steering is named, not faked

`STEERING_CAPABILITY` is exported from `studio.ts` and carried on every
snapshot. It reports:

- `available: false`
- the missing route: `POST /v1/threads/{thread}/turns/{turn}/steer`
- what to do instead, in the interface: queue the text, and Mona sends it after
  the turn ends in the same conversation — which is explicitly **not** the same
  as steering.

No "Steer this run" control is rendered anywhere. The shell smoke asserts its
absence.

### Current activity, derived only from stored frames

`src/renderer/shell/activity.ts` — `projectActivity()`:

- the active turn's first and last stored frame, in milliseconds (`frames span`);
- the age of the newest stored frame (`last event … ago`) — silence is shown as
  silence, never as thinking;
- tool rows keyed by `item_id`, with start/completion timestamps and a measured
  duration, bounded to 8 rows with a count of what was not shown;
- a completion whose start predates the loaded window is reported as "began
  before the loaded events" with a null duration instead of an invented start;
- `needsYou` from the engine's pending requests, and status `waiting` when an
  ask is open — a pending ask outranks "running";
- `unknown` when the connection failed or stopped, so a dead runtime is never
  rendered as idle work.

`activity.ts` is pure and unit-tested (8 tests) without Electron.

### Interface

`src/renderer/shell/Studio.tsx`:

- `ActivityStrip` above the console: status, scope, turn id, frames span, last
  event age, Needs-you badge, and expandable tool chips.
- `FollowUpQueue` under the composer: queue count, per-item Edit / Cancel, Run
  now when idle, and the last three settled items with their status and turn id.
  The steering sentence appears only while a turn is active.
- "Queue after turn" beside "Send to engine", disabled for an archived thread or
  an empty draft.
- IPC: `studio:follow-up-add|edit|cancel|dispatch`, each strict-validated and
  wired through `bridge.ts` and the preload.

## Verification

- **Focused tests:** `test/studio-follow-up.test.ts` — 9 passing:
  dispatch-once after the turn ends; cancel before the boundary; stale on a
  replaced conversation; paused queue; budget stop leaves the row queued;
  uncertain send is settled and not resent; restart keeps the row queued and
  starts nothing; the store claim admits exactly one dispatcher; no fleet route
  is touched.
- `test/studio-activity.test.ts` — 8 passing: span, cross-turn isolation, failed
  vs open tools, out-of-window start, waiting, idle with real age, failed
  connection, bounded tool rows.
- **Full suite:** 1,057 tests in 95 files (was 1,040 in 93).
- **Gates:** typecheck clean, lint 0 errors (3 pre-existing warnings in test
  files), `format:check` clean.
- **Shell smoke:** 133/133 in the real Electron shell, including six new checks:
  `activity_strip_present`, `activity_reports_idle`, `activity_names_scope`,
  `queue_control_present`, `follow_up_queue_present`, `steer_not_offered`.
  Capture: `docs/evidence/macos/artifacts/p-r08-activity.png`.

## What is *not* verified

- **No live engine turn with a dispatched follow-up.** That needs inference, and
  this task was authorized to prove queue semantics, not to spend. The dispatch
  path is exercised end to end through a fixture transport that answers like
  `0.10.2` (turn accepted → completion → second submission), not through the
  real engine.
- **No live steering**, because no route exists. The absence is reported, not
  simulated.
- **The 24 hash-pinned shell captures were restored to their committed bytes**
  after the smoke run, per the R02 precedent: the strip changed the Studio
  screenshots, and R12 owns re-recording hashes with notes. `p-r08-activity.png`
  is the new, committed capture for this task.
- **No agent/thread filter beyond the conversation selector.** The strip reports
  the scope it is describing (project or selected conversation) and does not
  claim to merge agents it cannot see.

## Files

- `src/shared/contracts/follow-up.ts` (new), `contracts/studio.ts`,
  `contracts/bridge.ts`, `contracts/index.ts`
- `src/main/state/schema.ts` (v13), `src/main/state/store.ts`
- `src/main/work/studio.ts`, `src/main/ipc.ts`, `src/main/ipc-contract.ts`
- `src/preload/index.ts`
- `src/renderer/shell/activity.ts` (new), `Studio.tsx`, `Shell.tsx`,
  `src/renderer/styles.css`
- `test/studio-follow-up.test.ts` (new), `test/studio-activity.test.ts` (new)
- `src/main/index.ts` (six shell-smoke checks and the R08 capture)
