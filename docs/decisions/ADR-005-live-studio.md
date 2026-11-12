# ADR-005 — Live studio ownership, submission, and event authority

**Status:** accepted · **Date:** 2026-11-11 · **Prompt:** P08

## Context

P03 delivered a versioned adapter and P04 a native supervisor, but nothing owned
a _live session_: which project holds the runtime, which thread a turn belongs
to, where events are stored, and which of Mona's three stop controls is which.
P08 has to turn those pieces into a studio that can be believed: real streaming,
real cost, real permission posture, and honest uncertainty when the engine does
not answer.

Three failure modes had to be designed out:

1. **Two owners on one user store.** The supervisor already serializes starts,
   but the studio could still let a second project claim the same runtime, or
   let navigation start an engine.
2. **Blind retry.** A lost POST response cannot be distinguished from a lost
   response _after_ acceptance by the client alone.
3. **Invented state.** A disconnected stream, a quiet stdout, or a stopped
   process must never be rendered as completion, progress, or zero cost.

## Decision

### One session owns the owned runtime

`WorkStudio` holds at most one `StudioSession`. Starting a second project while
the first is `connecting`, `connected`, `running`, or `reconnecting` is refused
with `STUDIO_BUSY` and the name of the project that holds it. Parallel execution
stays disabled until upstream concurrency is demonstrated; serialization is the
recorded cost of that caution.

Nothing in the studio starts an engine as a side effect of reading: `studio:state`
reads local rows, `studio:start` is an explicit user action, and `studio:submit`
is the only call that posts a turn. The verified smoke asserts zero
`POST /v1/turns` before the user submits.

### The studio is driven only by a runtime Mona started

`RuntimeSupervisor.endpoint()` returns the bearer token, port, and executable
for an owned runtime only. An externally started runtime (`external: true`),
another workspace's runtime, or a missing endpoint fails the start with a typed
reason instead of attaching read-only and pretending to drive it. The adapter is
built over a loopback-only `HttpRuntimeTransport`; the token never enters the
renderer, the snapshot contract, IPC payloads, or logs.

The supervisor's report is verified against the project's _canonical_ path
before any request, and the engine identity is discovered and compatibility
checked before a thread is created.

### Thread per mode, posture bound at creation

Plan and Work are different threads, not a toggle over one. Each is created with
its posture applied (`auto_approve`, `trust_mode`, `allow_shell`, provider/model)
so a later turn cannot silently widen policy, and the turn repeats the posture.
Local thread rows are derived deterministically (`thr_sha256(projectId:mode)`), so
a project has at most one engine thread per mode across launches.

Mona's default profile mirrors the route measured at P01 (`deepseek` /
`deepseek-flash`, full access) and is **written once** to settings on first read,
then shown as _Configured_; it becomes _Observed_ only when a real turn reports
what actually ran. Plan is `ask` with no auto-approve, no trust mode, and no
shell — a genuinely narrower posture that cannot escalate itself.

### Persist intent, reconcile, never resend

The adapter writes the submission record before the POST (now through
`SqliteSubmissionStore`, so it is part of the single transactional write path).
A lost transport response, a 409, or a 5xx marks `outcome_unknown`. The studio
then performs **one read-only** `turn-operations` lookup: a 200 adopts the
existing turn and starts the stream; a 404/409/5xx leaves `outcome_unknown` with
explicit "do not resubmit" guidance and a Reconcile control. There is no retry
of the write path anywhere in the studio.

A confirmed interrupt writes the submission as `interrupted` and reconciled; an
unconfirmed one stays uncertain with the engine's own note. Stopping the process
is never reported as a completed turn, and nothing claims rollback of already
sent requests or external side effects.

### Events are stored, then projected; replay is display-only

Each durable event is inserted with `INSERT OR IGNORE` on `(thread_id, seq)` and
the cursor advanced in the same transaction. Reconnect resumes from the stored
cursor; a full replay ingests only genuinely new sequences. In the verified run
the second replay pass ingested **0** events with 61 duplicates and produced no
duplicate rows; the renderer additionally de-duplicates by thread+seq.

Threads are projections. `StateStore.readProjectEvents` reads a project's
timeline across _all_ its threads, so the live engine thread sits beside the
local shell thread without fragmenting history; engine history remains
authoritative upstream.

### Truthful presentation

- Seven connection states (`not_started`, `connecting`, `connected`, `running`,
  `reconnecting`, `stopped`, `failed`) with their own copy.
- Usage is recorded only from what the engine reports; an unpriced turn stores
  `costComplete: false` and is shown as "at least" — never as zero.
- Reasoning is only what the engine labels as reasoning; otherwise the studio
  shows activity, not a fabricated rationale.
- Engine plumbing (`item.started`, `turn.workspace_snapshot`,
  `model.tools.snapshot`, `turn.provider_request`, `turn.usage`,
  `operation.activity_*`) is stored and _counted_ in a visible line rather than
  flooding the transcript; genuinely unknown kinds get their own card and a
  diagnostics entry.
- Approval and clarification waits are surfaced as a real wait with the next
  step, not an indefinite spinner.

### Markdown without an HTML surface

`markdown.tsx` builds React text nodes and elements it creates. Raw HTML renders
as literal text, links become inert labels with the destination in `title`, and
non-`http(s)` destinations are not shown. A model turn cannot create an anchor,
a script, or an image in the privileged window; the smoke asserts zero of each
after a real turn.

## Consequences

- P09 (Finder launch) opens a project; it still does not authorize execution and
  does not start the studio.
- P10 adds task creation and the board; `Cancel queued` becomes meaningful when
  a queue exists. P11 adds three-attempt enforcement and queue starts.
- P16 adds route editing; until then the profile is displayed and written once,
  not editable.
- Crash-time resumption of a non-terminal turn stays explicit-and-pending; P19
  and P20 own the reconcile-after-restart policy.
- Attachments remain disabled with a stated reason until the adapter has a
  qualified attachment operation.
