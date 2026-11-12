# P08 — Live work studio

**Date:** 2026-11-11 · **Status:** complete · **Host:** macOS 26.5.1 arm64 ·
**Engine:** pinned Codewhale 0.10.2 (`ff466b2ed0bf`) · **Runtime:** Electron 45.3.0

## Result

The studio is live. Victor can start Mona's owned engine for a project, submit a
real task, watch the engine's own events arrive, and read the result — with real
cost, real permission posture, and honest uncertainty when the engine does not
answer. On a real fixture project the pinned engine was given one task, wrote
`hello.txt`, ran `node --test`, and reported `1 test, 1 pass, 0 fail`; the
studio displayed exactly that evidence and billed **$0.0009** for the turn.

Verification: **236 tests in 29 files pass** (31 studio, IPC, boundary, profile,
render, and screen tests added). The real pinned-engine Electron smoke
passes **22/22 checks**, including a real file change, a real test run, replay
de-duplication, a confirmed interrupt, and offline history after stop. Local CI
(`format:check`, `lint`, `typecheck`, `build:supervisor`, `test`, `build`,
renderer secret scan) is green. **205 → 236 tests**, no skips.

Evidence: `p08-tests.txt`, `p08-ci.json`, `p08-studio-smoke.json`,
`p08-studio-run.png` (turn active), `p08-studio-live.png` (completed turn),
`p08-studio-offline.png` (runtime stopped, history intact).

## What the smoke actually did

| Check | Observed |
|---|---|
| Runtime connected | owned runtime, loopback port 51348, `owned: true` |
| Engine identity | `0.10.2` / `ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e` |
| Profile | configured `deepseek / deepseek-flash`, `full_access` |
| Submission | `accepted`, turn `turn_f3a0a093…`, status `completed` |
| File change | `hello.txt` = `mona-p08\n` written by the engine |
| Test run | engine ran `node --test`; output stored and rendered |
| Effective route | observed `deepseek-flash`, `permission_posture = full_access` |
| Cost | `$0.000936` for 1 turn, `costComplete: true` |
| Replay | 2nd pass ingested **0**, 61 duplicates, no duplicate rows |
| Interrupt | confirmed by terminal turn state; submission `interrupted`, reconciled |
| Stop / offline | `stopped`, 81 stored events still rendered |
| Safety | 0 anchors, 0 injected nodes, no fabricated percentage |

Screenshots are live-state captures, not fixtures: the window shows real engine
output, a real spend figure, and a real turn id.

## Architecture

- **`src/main/work/profile.ts`** — Victor's saved DS Full Access profile is read
  from local settings, written once on first read from the measured P01 route
  (`deepseek` / `deepseek-flash`), and displayed persistently as **Configured**
  until a turn reports **Observed**. A malformed stored profile falls back to the
  measured default rather than silently widening anything. **Plan** is a
  genuinely narrower posture (`ask`, no auto-approve, no trust mode, no shell),
  bound at thread creation and repeated on the turn; **Work** uses the saved
  profile.
- **`src/main/work/studio.ts`** — `WorkStudio` owns the live session:
  - starts the engine through `RuntimeSupervisor.ensure(canonicalPath)`, verifies
    the supervisor reports *this* workspace, refuses an externally started
    runtime, builds the loopback transport from `supervisor.endpoint()`, and
    discovers the engine identity before anything else;
  - binds one local thread row per mode (`thr_<sha256(projectId:engine:mode)>`)
    to the engine thread, creating the engine thread with the mode's posture
    applied so a later turn cannot silently widen policy;
  - persists submission intent before sending (adapter contract, now backed by
    `SqliteSubmissionStore`), and on a lost response performs **one read-only
    operation lookup** — never a resend;
  - ingests events into `StateStore` (insert-or-ignore on thread+seq, cursor
    advanced in the same transaction), projecting turns and usage; a replay after
    reconnect advances display state only.
- **`src/main/supervisor/driver.ts`** — the production `RuntimeDriver` is now a
  named module shared by the desktop entry point and the smoke harness, so the
  evidence exercises the shipping wiring.
- **`src/main/supervisor/runtime-supervisor.ts`** — adds `endpoint()`, which
  returns the bearer token, port, and executable to trusted main-process callers
  only, and only for a runtime Mona owns.
- **`src/main/state/store.ts`** — `readProjectEvents` reads a project's timeline
  across its threads (the live engine thread sits beside the local shell thread);
  `listSubmissions` exposes stored submission state.
- **IPC** — 8 new strict channels (`studio:state|start|submit|interrupt|pause|resume-queue|cancel-queued|reconcile|stop`).
  The submit payload is a mode enum plus bounded prompt; no policy field is
  settable from the renderer. `studio:changed` is a main→renderer push over a
  named preload subscription.
- **Renderer** — `Studio.tsx` renders the timeline, composer, Plan/Work control,
  and the persistent control strip; `timeline.ts` projects stored events
  deterministically; `markdown.tsx` renders Markdown with no HTML injection.

## Honesty rules carried into the UI

- **Disconnected is not stopped; interrupted is not completed.**
  `not_started`, `connecting`, `connected`, `running`, `reconnecting`, `stopped`,
  and `failed` are distinct states with their own copy. A stopped runtime says
  the work was interrupted and that restarting does not resend it.
- **Unknown cost is not zero.** A turn whose price the engine does not report is
  stored with `costComplete: false` and displayed as *“At least $x; some turns
  are unpriced”*. A project with no usage says *“No usage recorded”*, including
  while the first turn is still running.
- **No invented progress.** There is no percentage anywhere in the studio; the
  smoke asserts no `\d+%` appears in the context bar or control strip.
- **Reasoning is only what the engine says.** If the engine emits
  `agent_reasoning` items they are shown and labelled as engine-reported; if it
  emits only activity, Mona shows activity and never fabricates a rationale.
- **Pending input is a real wait.** Approval and clarification events surface as
  “The engine is waiting for input Mona cannot answer”, with the concrete next
  step, instead of an indefinite spinner.
- **Internal activity is counted, not hidden.** The pinned engine emits
  plumbing (`item.started`, `turn.workspace_snapshot`, `model.tools.snapshot`,
  `turn.provider_request`, `turn.usage`, `operation.activity_*`). They stay
  stored and are counted in a visible line; genuinely unknown kinds are shown as
  “Unrecognized event” cards and collected in the diagnostics list.

## Safety

- Model and tool output is never `innerHTML`. `Markdown` builds React text nodes
  and elements it creates; raw HTML renders as literal text, links become inert
  labels with the destination in `title`, and only `http(s)` destinations are
  shown at all.
- The smoke asserts `0` anchors inside the studio and `0` injected
  `script`/`img` nodes after a real model turn.
- The runtime token, port, and executable stay in the main process:
  `src/shared/contracts/studio.ts` carries none of them, and a boundary test
  fails if `fetch(` appears outside `transport.ts`, `runtime-process.ts`, and
  `supervisor/driver.ts`.
- One mutating turn per workspace is enforced in code: a second submit is
  rejected with `TURN_ACTIVE` before any HTTP write, and a second project cannot
  claim the owned runtime (`STUDIO_BUSY`).
- Browsing, searching, and re-rendering the studio make **zero** model calls:
  `studio:state` reads local rows only; starting is explicit; only `submit`
  posts a turn. The smoke's first check passes with zero `POST /v1/turns` before
  submission.

## Controls and their distinct meanings

| Control | Effect | What it never claims |
|---|---|---|
| Pause after task | Mona queue boundary; active task continues | Does not stop the engine |
| Resume queue | Clears the boundary | Does not start anything by itself |
| Interrupt now | Engine interrupt with a receipt; polls history for the terminal state | Not rollback of side effects |
| Cancel queued | Removes future starts | Leaves the active turn alone |
| Stop engine | Interrupt (if active) then stop the owned process tree | Not completion, not rollback |
| Quit and stop work | Lifecycle path: interrupt → stop owned tree | Same, with survivors reported |

A confirmed interrupt marks the stored submission `interrupted` and reconciled;
an unconfirmed one is reported as uncertain with the engine's own note.

## Known limits carried forward

1. **Attachments** — the pinned adapter has no attachment operation, so the
   composer shows a disabled **Attach file** button with that reason instead of
   pretending. Attachments land when the capability is qualified.
2. **Prompt queueing** — P10 owns task creation and the board; `Cancel queued`
   is honest today (empty queue) and becomes meaningful there.
3. **Steer, approvals, clarifications** — surfaced as a real wait, not answered.
   P11/P15 add answering when the engine exposes it.
4. **Direct cost** — `costComplete: false` whenever the engine omits a price;
   the studio shows "at least" rather than inventing a number.
5. **Crash reconciliation** — a turn interrupted by an app crash stays
   non-terminal and is shown as such; P19/P20 own resume-after-crash policy.
6. **One runtime per user store** — parallel project execution stays disabled
   until upstream concurrency is proven; the second project gets a clear reason.
7. **No Developer ID signing** — still P22; this evidence is a local build.
