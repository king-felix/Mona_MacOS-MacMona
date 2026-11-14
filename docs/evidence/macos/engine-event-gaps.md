# Engine event gaps — a false "never received" notice, and the replay it caused

**Date:** 2026-11-13 · operator-reported · not a prompt (D-099)
**Reported:** "On the studio window — will messages like this ever go away on
their own? (*Some engine events were never received — #3173–3439,
#4078–4101 — the timeline below is missing those frames.*)"

They would not have gone away, and they were not true. This records the
measurement, the repair, and what is still not claimed.

## Measurement

Mona's live store (`~/Library/Application Support/Mona/state/mona.sqlite`) held
one engine thread, `thr_2e0303d546909547`, with 8,499 stored events, cursor
10,479, and two arithmetic holes: 3173–3439 (267) and 4078–4101 (24). The engine
kept 8,500 rows for the same thread with the identical holes, so nothing was
lost in transit.

Every one of those 291 sequences belonged to a **different** engine thread:

| Range | Owner | Events |
| --- | --- | --- |
| 3173–3277 | `thr_25af9ee5…` (a `mona-studio-smoke-project-*` run) | 105 |
| 3278–3352 | `thr_bb2037a6…` (second smoke run) | 75 |
| 3353–3439 | `thr_bbc70f888…` (third smoke run) | 87 |
| 4078–4101 | 24 one-event probe threads (`mona-isolation-ws-*`, `mona-owner-ws-*`) | 24 |

## Root cause

The Runtime allocates `seq` from **one counter shared by every thread**. Its own
API documentation says so, and says what a client may conclude from it
(`docs/evidence/macos/artifacts/upstream-RUNTIME_API.md`, "SSE event stream"):

> `seq` is allocated globally across all Runtime threads. Consequently, gaps
> between a thread's events are normal when other threads interleave. On this
> per-thread SSE stream, `previous_seq` is the sequence of the last event
> delivered for this thread … clients detect loss by comparing it with their
> accepted per-thread cursor, not by requiring `seq == previous_seq + 1`.

Mona ignored `previous_seq` (it was parsed into `EventEnvelope` and never read)
and required contiguity in three places:

- `WorkStudio.ingest` — `event.seq > cursor + 1` became a rewind and a gap
  diagnostic;
- `StateStore.firstMissingSeq` — the resume point was derived from the first
  arithmetic hole, so every attach asked `since_seq=3172` again;
- `StateStore.eventGaps` — `connection.missing`, and therefore the notice, was
  recomputed from stored-sequence contiguity on every snapshot.

Nothing could retire a gap: `skippedGaps` was an in-memory `Set`, `events` rows
are never deleted, and `connection.missing` had no acknowledgement path. The
notice was therefore permanent for that thread, and it grew as smoke runs and
the TUI took numbers from the shared counter.

**Cost beyond the message.** Each attach replayed 7,016 duplicate frames (1,483
of the 8,499 stored rows are at or below 3,172). During a live turn, any other
thread taking a slice of sequences made the next frame for this thread look like
a hole, so the pump broke the stream, reconnected, replayed, and recorded a gap
that did not exist — the same failure family as the P23 stall, misattributed in
the P23 record.

## Repair

1. **`event_gaps` is a durable table** (schema v9): `thread_id, first_seq,
   last_seq, detected_at`. It is written only when the engine reports loss and
   is deleted as replayed events arrive, so a repaired hole stops being a gap.
2. **Loss is `previous_seq`, never arithmetic.** `ingest` rewinds only when
   `previous_seq > accepted cursor` on a thread that already had events. A
   replay resumes from the cursor accepted *before* the hole.
3. **The pump concludes a replay honestly**: after the replay connection ends,
   the ledger says whether the range filled (`… was replayed and filled`) or the
   engine does not have it (`… was replayed and not returned; recorded as a gap
   the engine skips`). One attempt per hole, then the fact stands.
4. **`connection.missing` reads the ledger.** `StateStore.eventGaps` no longer
   consults contiguity; `firstMissingSeq` is gone.
5. **The Studio copy is unchanged.** "Mona asked the engine to replay them and
   recorded the gap rather than inventing content" was already true; the set of
   ranges was the lie.

The existing false ranges disappear without touching stored data: the ledger
starts empty for a thread whose holes were other threads' traffic.

## Verification

- **Live engine contract.** A temporary trace of the adapter during
  `npm run smoke:studio` (real pinned engine 0.10.2, reverted after the run)
  showed `previous_seq` on all 45 frames of a live turn; the first frame after
  attach reported the requested cursor (`seq=10914 previous=0`), matching the
  documented rule.
- **Real run, no false positives.** That run produced zero `sequence gap`
  diagnostics and no `connection.missing` ranges.
- **Real store, migrated copy.** A copy of the operator's v8 database opened
  through this build, migrated to v9, and reported: `event_gaps` empty, stored
  range 1,690–10,479, cursor 10,479 — so an attach asks `since_seq=10479`
  instead of replaying 7,016 frames.
- **Unit/screen:** `npx vitest run` — **788 tests in 79 files**, all passing.
  New: another thread's interleaved sequences are not a gap (the regression for
  this defect); a replayed hole is filled and removed from the ledger; an
  unfillable hole is recorded once; the ledger merges, splits, and clears.
- **Gates:** `npm run lint` 0 errors (3 pre-existing warnings),
  `npm run typecheck` clean, `npm run build` ok, `smoke:p23` 58/58,
  `smoke:failure` 22/22, `smoke:studio` 22/22 twice consecutively.
  `p08-studio-run.png`, `p08-studio-live.png`, and `p08-studio-offline.png` are
  regenerated by those runs (they were stale in the P08 record).

## Limits, stated

- **If the engine omits `previous_seq`, loss is not detected.** Detection
  degrades to "no claim" rather than to a guess. That is deliberate: a missing
  field must not produce a false warning.
- **The first event of a thread cannot prove loss.** Detection requires an
  accepted cursor above zero, because a first frame's `previous_seq` is the
  requested cursor by definition.
- **`smoke:studio` remains intermittent.** One run in this session failed with
  the already-documented `state store is closed` inside `WorkStudio.replay`
  before any gap path ran; two consecutive runs passed. It is recorded in
  `P08-studio.md` and is not caused by this change.
- **`npm run ci` is red at `format:check` for four files this change does not
  touch** (`src/main/ipc.ts`, `src/renderer/shell/Settings.tsx`,
  `src/main/engine/adapter.ts`, `test/runtime-process.test.ts`). Pre-existing;
  left alone rather than reformatting unrelated code inside this repair.
- **`events` rows still survive `deleteProjectContents`** (pre-existing). The
  new `event_gaps` rows are removed with their project; the older omission is
  reported, not fixed here.

## Files

- `src/main/state/schema.ts` — v9 `event_gaps`, required-table list.
- `src/main/state/store.ts` — `recordEventGap`, `listEventGaps`,
  `noteEventStored`, ledger-based `eventGaps`, contiguity removed.
- `src/main/work/studio.ts` — `previous_seq` detection, cursor resume, replay
  conclusion, `replaySince`/`pendingGap` state.
- `test/work-studio.test.ts`, `test/state-catalog.test.ts`,
  `test/update-coordinator.test.ts` — fixtures carry `previous_seq`; the schema
  assertion follows `CURRENT_SCHEMA_VERSION` instead of a literal.
