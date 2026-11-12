# ADR-009 — Polish is a projection of records, and attention is local

**Status:** accepted · **Date:** 2026-11-12 · **Prompt:** P14

## Context

P14 adds the parts of Mona that a long session lives inside: a Resume Brief, a
"Since you left" catch-up, Focus Mode, saved layouts, prompt favorites, keyboard
shortcuts, a menu-bar item, Dock badges, notifications, quiet hours, close
versus Quit, keep-awake, and launch-at-login.

Four failure modes had to be designed out:

1. **A summarizer disguised as a convenience.** The obvious way to write a
   brief or a "what did I miss" digest is a model call. That would spend tokens
   on every visit, make the same state produce different prose, and quietly
   contradict spec §9.1.
2. **Invented progress.** A percentage bar is the natural way to fill a gap
   where a record is missing. It is also the exact lie spec §2 (promise 2) and
   the three-attempt rule exist to prevent: unverified is not 80 percent done.
3. **Notification storms and leaks.** Event subscriptions lose position across
   a reconnect, so a naive implementation announces the same completion twice.
   A detailed body on a lock screen leaks a prompt fragment or a file name.
4. **Attention machinery that outlives its reason.** A power assertion that is
   not released drains a battery; a login item that installs itself is an
   unrequested change to the user's Mac.

## Decision

### The brief and the digest are pure projections

`PolishDigest` (`src/main/work/digest.ts`) reads the board snapshot, stored
change receipts, the cost ledger, stored engine events, and one per-project
watermark (`polish:seen:<projectId>`). It emits typed facts and ordered groups.
It never calls a model, never reads the network, and its output for a given
state is stable. `ResumeBriefView` carries a literal `noCompletionPercentage:
true` field, and the test suite asserts that no `%` appears anywhere in a brief.

Facts are named for what produced them: the current prompt and its status, the
unresolved blocker with both attempt counters, the test result as
"satisfied checks of total checks" plus an observed command, the changed-file
count from settled receipts, and spend confidence with unknown turns counted
separately. Where a source is absent the brief says so (`Changes unavailable`,
`No usage recorded`) instead of substituting a zero.

### "Since you left" is grouped, not narrated

Entries come from event rows after the watermark, blocked problems newer than
it, and tasks verified since it. Group identity is stable (`completion`,
`blocker`, `test`, `change`, `attention`, `session`) and entry keys are
`thread:seq`, `blocker:<problemId>`, `task-completed:<taskId>`, so replaying a
stream cannot inflate the digest. Duplicate rows are counted and reported.
Reading a project advances the watermark; nothing about a task changes.

### Notifications are derived, deduplicated in durable state, and redacted

`PolishNotifier` re-derives candidates from stored tasks, blocked problems, and
budget evaluations on every refresh, rather than subscribing to a stream that
can reconnect. Each candidate has a stable key; delivered and suppressed keys
are stored in `settings` (`polish:notifications`). The first refresh seeds a
cursor instead of replaying history as a burst.

Delivery is a pure decision (`planNotification`): global switch, category
switch, then quiet hours. Quiet hours are evaluated in a stated IANA zone
through `Intl`, so the window follows the user's zone across travel and DST and
is testable on any host. A suppressed alert is **recorded with its reason and
never queued**: quiet hours silence delivery, not computation, and a morning
backfill would be a second, surprising alert.

Default content is generic (`Mona · work finished`). Detailed titles are opt-in
and are never enabled by default, so a lock screen cannot show a prompt
fragment, a path, or a help request. A click only focuses the app and names the
project and evidence; it never dispatches work.

### Attention is native chrome over stored state

`planAttention` reduces four numbers (running, blocked, unseen completions,
limit alerts) to a short menu title, tooltip, and badge count. It is a pure
function with its own tests. `AttentionController` writes only when the plan
changes, clears the surfaces when the user turns them off, and reports whether
the menu-bar item actually installed. A tray that cannot be created is
reported in Settings rather than presented as working.

### Preferences are explicit, and side effects are scoped

- **Launch at login** is off by default and is applied only from the stored
  preference. The controller reads the real login-item state at construction,
  so a default of "off" makes no system call when the system already agrees.
- **Keep-awake** is a single power assertion held only while an active turn or a
  running task exists _and_ the preference is on. Release is idempotent and runs
  on work end, on preference change, and on quit.
- **Focus Mode** hides the inspector and secondary context facts, but the
  control strip (Pause after task, Interrupt now, blockers) stays visible, and
  Escape leaves Focus Mode. The choice is stored per project alongside the
  existing view state.

## Consequences

- Reading Home is free of inference, and the same records produce the same
  brief on every visit. Nothing about a notification or a read can move a task,
  an attempt counter, or a verification state.
- The digest can only be as good as the records: when no receipt exists it says
  "Changes unavailable", and when a task has no acceptance check it says "No
  machine check recorded". That is deliberate.
- Quiet hours apply to alerts only. A user who wants work to stop at night must
  pause or interrupt explicitly; Mona does not conflate the two.
- The menu-bar item, Dock badge, and login item are best-effort native calls.
  Their real state is read back and shown in Settings; a failure is visible.
- Detail in notification text is a user decision with a security consequence,
  stated in the Settings copy rather than buried in a tooltip.
- Launch at login writes a login item on the build machine during smoke runs
  only if the preference is enabled, which it is not by default. This preserves
  the "no unrequested system change" boundary.
