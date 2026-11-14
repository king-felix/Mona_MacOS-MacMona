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

## P23 polish — the console got the width and the height

At the operator's request the studio was re-laid out so the agent console is the
wide surface instead of a column squeezed beside a docked inspector:

- The console (timeline) is now a full-width panel at the top. It was in a `1fr`
  column beside a permanently docked 350 px inspector, capped at
  `min(28vh, 320px)` — roughly six events on a laptop.
- The prompt composer and the Task / Requirements / Context inspector now share
  the row beneath it (composer `1fr`, inspector 350 px).
- Console height is `clamp(300px, 44vh, 620px)`, so it grows with the window but
  keeps the composer within a short scroll.

Measured, not asserted — four new shell-smoke checks at 1280×800:

```
studio_console_spans_width        console 100% of the studio width
studio_console_is_tall            console 352 px
studio_console_above_composer     true
studio_inspector_beside_composer  inspector 350 px beside a 632 px composer
```

The shell smoke also now passes its own `--user-data-dir`: it previously exited
silently with no report whenever the user had the installed Mona open, because
its second Electron lost the single-instance lock. Verified with the product
running: **124 checks, 0 failures**.

Captures `p07-shell-studio.png` and `p14-studio-focus-afterglow.png` show the new
arrangement; all 36 hash-pinned captures were re-recorded, with no assertion
removed.

**Not regenerated:** `p08-studio-run.png` and `p08-studio-live.png` still show the
previous arrangement. `smoke:studio` cannot run while the installed Mona is open
(the single-instance lock), and giving it an isolated `--user-data-dir` makes it
fail with `state store is closed` in `WorkStudio.replay`, so that change was
reverted rather than shipped. Re-run `npm run smoke:studio` with Mona closed to
refresh those two captures.

## P23 defect — a silent stream froze a turn, and a gap could never be repaired

**Reported:** an agent thought stopped mid-thought and never returned; nothing
else happened in the turn; reconnecting "picked up from the cursor" and stayed
broken.

**Measured in the live state** (`~/Library/Application Support/Mona/state`):

```
thread   thr_2e0303d546909547
cursor   3523          (highest stored sequence)
stored   1567 events   first stored 1690
gap      3173–3439     (267 events never received)
silence  2026-11-12T21:41:34Z → 21:53:31Z (about 12 minutes)
```

**Four defects, each independently sufficient:**

1. `subscribe` had no idle deadline. A socket that stays open while the peer
   stops sending blocks the pump forever; the turn stays "active" and nothing
   errors. Fixed with an `idleMs` watchdog that turns silence into
   `end: idle_timeout` (every frame, including `stream.progress`, resets it).
2. The pump resumed from `getCursor` — the *highest* stored sequence — so a hole
   below the cursor could never be fetched by any reconnect. It now resumes from
   `firstMissingSeq`, which points at the hole.
3. `start()` returned the existing snapshot when the connection merely said
   "connected"/"running"/"reconnecting", without checking the pump. That is why
   the operator's reconnect did nothing. Re-attaching now requires a live pump.
4. `ingest` reported `terminal` even when it had just requested a rewind, so the
   pump returned before reconnecting. A terminal event is honoured only when no
   rewind is pending.

**Honest reporting:** `StudioConnection` now carries `lastEventAt`,
`silentForMs`, and `missing` ranges. The Studio shows "No engine events for Ns"
after 45 s of silence with a Reconnect action, and lists the exact ranges that
were never received. Nothing is invented to fill a hole.

**Verification:** 754 tests in 75 files (three new stream tests that hang without
the watchdog, three new screen tests); `npm run ci` 21/21; shell smoke 124/124.

The existing hole in this user's state is repaired on the next attach if the
engine still holds those events (the pump now asks from 3172); otherwise it is
shown as a gap rather than silently skipped.

## Post-P23 defect — the console was frozen on its first 200 events

**Reported:** "The agent feedback area broke and is still not working. It
remains hung in the exact same location." The live thread was healthy — cursor
4076, turns completing — so this was not the D-095 stream stall.

**Root cause:** `StateStore.readProjectEvents` returned the **oldest** 200 rows
(`ORDER BY recorded_at ASC LIMIT 200`), and `ProjectService.detail` feeds that
list to the Studio. Below 200 events the window covered the whole thread, so the
console followed. Once the thread passed 200 events, every refresh returned the
same first page: the screen froze on the first turn while new frames were stored
and never read.

**Fix:** select the newest `limit` rows (`recorded_at DESC, rowid DESC`) inside a
subquery, then re-order oldest-first for display. The window stays bounded at
200 events, which is what makes it safe to refresh during streaming; it just
points at the live edge now.

**Measured** (`docs/evidence/macos/artifacts/p08-console-window.json`):

```
project prj_b66fc315c2eae670, 2120 stored events, seq 1690-4076
before: seq 1690-1889, last recorded 21:30:41Z  (first turn)
after:  seq 3877-4076, last recorded 23:56:55Z  (latest turn.completed)
```

**Verification:** the new case in `test/projects-service.test.ts` failed on the
old query (`expected 1 to be 51`) and passes with the fix; 755 tests in 75 files;
`npm run typecheck` and `npm run lint` clean (three pre-existing test-file
warnings). The remaining gap `3172-3439` is unchanged and still reported; no
event content was rewritten or invented.

## Correction (2026-11-13, D-099) — the "hole" in this record was another thread's traffic

The P23 section above reads the 3173–3439 hole as loss that a replay would
fill, and says the pump "asks from 3172". That diagnosis was wrong in one
respect: `seq` is a single counter shared by every Runtime thread, so the
numbers between two stored frames are usually other threads' events. All 291
"missing" sequences were owned by three smoke-run threads and 24 one-event
probes.

`previous_seq` — the engine's own statement of what it delivered for *this*
thread — is now the only evidence of loss, `event_gaps` (schema v9) is the only
record of it, and a replay resumes from the accepted cursor instead of the first
arithmetic hole. The idle watchdog, the pump-liveness check, and the
terminal-vs-rewind ordering from P23 stand unchanged.

Evidence: `docs/evidence/macos/engine-event-gaps.md`.

## Studio console: plumbing and known frames were labelled "Unrecognized" (2026-11-13)

**Reported:** "Unrecognized event · operation.heartbeat" appearing every ten
seconds, "Stored and inspectable; this build does not project it."

**Measured.** `operation.heartbeat` carries only `{ observed_at }` — it is a
liveness ping sent while a long operation runs, and the timeline had no rule for
it, so each one became a card. The session diagnostic fired for it too, which
put `Event "operation.heartbeat" … does not project it` into the bounded
12-slot diagnostics ring and could evict a real one.

Auditing every kind the engine actually stored in the operator's thread found
the same defect in three more:

| Kind | Stored | Why it was wrong |
| --- | --- | --- |
| `operation.heartbeat` | 25 | Plumbing; liveness only |
| `turn.artifacts` | 14 | Mona **already captures it** into the change set |
| `item.interrupted` | 2 | An interruption is not an unknown kind |
| `turn.interrupt_requested` | 3 | Same |

**Fix.**

- `ENGINE_PLUMBING_KINDS` in `src/shared/contracts/events.ts` is one list with
  two consumers: the timeline counts a plumbing frame instead of printing a
  card, and the Studio skips the "not projected" diagnostic for it. A kind in
  neither list is still genuinely unseen and still shows — the honesty rule is
  unchanged.
- `turn.artifacts`, `item.interrupted`, and `turn.interrupt_requested` are
  projected for real: "Turn artifacts" reports workspace state, artifact count,
  snapshot changed/unchanged, and omissions; "Item interrupted" keeps the
  partial text; "Interrupt requested" states that the outcome arrives as a
  terminal event. All three join `KNOWN_EVENT_KINDS`, so they are no longer
  diagnosed as drift either.

**Verified.**

- Real data: the operator's newest 2,000 stored events (6 heartbeats, 14
  `turn.artifacts`) project to **0 unknown entries and 0 unprojected kinds**,
  207 frames counted as internal activity.
- Unit/screen: 791 tests in 79 files. New: a heartbeat is counted, not printed
  (`studio-render`); a heartbeat produces no diagnostic while `future.event`
  still does (`work-studio`); interrupt/artifact frames project with the exact
  bodies above.
- Gates: typecheck, lint, build clean; `smoke:studio` 22/22 on the pinned engine
  with no `Unrecognized` text in the report.
- Storage unchanged: heartbeats are still stored and inspectable; nothing is
  dropped from the record, only from the conversation view.
