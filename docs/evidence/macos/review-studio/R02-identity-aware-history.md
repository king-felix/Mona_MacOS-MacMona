# R02 — Complete, identity-aware conversation history

- **Completed:** 2026-11-14 (local Mac, arm64; base `10e22ee`)
- **Review task:** R02 — "Build complete, identity-aware history and stable
  streaming" (prerequisites R00; R04, R05 and R07 wait on it)
- **Issues:** RV-04 extended to item/turn identity; **RV-06 closed**
- **Requirements:** MONA-007, MONA-010, MONA-016, MONA-030
- **Feature IDs:** RV-04, RV-06

## What was wrong

1. `ProjectService.detail()` returned the newest **200 raw events**
   (`readProjectEvents`). Older frames were unreachable: the Studio's "Show N
   earlier events" button merely revealed more of the same 200-event window, and
   a long turn's deltas and heartbeats consumed it. A 10,000-event project could
   not be read past its live edge.
2. The engine addresses streamed items with `item_id`, but ingestion stored only
   `thread_id` and (from v6) `turn_id`. The renderer therefore matched a delta to
   a completion by `payload.kind` alone. Two `agent_message` items interleaved
   in one thread merged into one card, and the streamed card (`delta-<seq>`) and
   completed card (`<thread>-<seq>`) used different React keys, so the card
   remounted at completion.
3. A card whose beginning predated the loaded window had no way to say so and
   no way to load its beginning.

## The contract

### Stored identity (schema v10)

`events.item_id` is written from the envelope's `item_id`, falling back to the
completion payload's `item.id`. The column is nullable on purpose:

- a row written before v10 keeps `NULL`, which the UI reports as **unknown
  identity**; it is never filled in from a guess;
- a frame that names no item stays `NULL`;
- the migration is additive (`ALTER TABLE` plus two indexes), runs inside the
  existing backup/journal/transaction machinery, and was verified by upgrading a
  real v9 database with an event in it.

`readEvents`, `listTurnItems` and the project history page all return `turnId`
and `itemId`, so the envelope identity survives persistence and IPC.

### History page (keyset, not a sequence range)

```ts
interface HistoryCursor { recordedAt: string; rowId: number }
interface HistoryPage {
  events: StoredEventSummary[];      // oldest-first within the page
  olderCursor: HistoryCursor | null; // pass back as `before`
  hasMore: boolean;
  storedTotal: number;               // project, or the selected thread
  pageSize: number;
  threadId: string | null;
}
```

- `ProjectDetail.events` is now the **newest page** and
  `ProjectDetail.history` describes it (`olderCursor`, `hasMore`,
  `storedTotal`, `pageSize`).
- Older pages come from `projects:history`
  (`{ projectId, before?, limit?, threadId? }`, strict schema, limit ≤ 500).
- One item's frames come from `projects:history-item`
  (`{ projectId, threadId, itemId }`).
- The cursor is the store's receipt order `(recorded_at, rowid)`. It is not a
  sequence range: `seq` is one global engine counter shared by every thread, and
  a hole in it is normally another thread's traffic. **Loss remains only what
  `event_gaps` records from `previous_seq`.** `hasMore` is a row-count fact from
  the read that produced the page.
- Both new calls are reads. They start no runtime, ask no model, and do not
  write state (asserted by comparing `stateRevision` across a full page walk).

### Projection (`src/renderer/shell/timeline.ts`)

- Frames are bound by identity: `item.delta` and `item.completed` for
  `item_id = X` update the same block, so the streamed and completed card share
  one key, and two items of the same kind in one thread never merge.
- A completion that omits the envelope id still names its item in
  `payload.item.id`, which is accepted.
- Rows that predate identity are grouped only within **one turn and one kind**
  and are rendered with `itemId: null`. A legacy completion binds to an
  unidentified stream only when exactly one such stream of that kind in that
  turn can be its source; otherwise it stands alone.
- Heartbeats and other plumbing are counted, not printed, and never end an open
  item. Unknown kinds stay visible.
- `partial` is true when an item opens at the first non-plumbing frame of the
  supplied window and the transcript is not complete. With an item id the card
  offers "Load the beginning of this message"; without one it says the beginning
  was stored before identity existed and cannot be reconstructed.
- Duplicate `(thread, seq)` replays are ignored; React keys are additionally
  guarded against two terminal frames for one item id.

### Paging in the Studio

- "Load earlier events" reads one older page (200 events) and prepends it.
  The viewport anchor is held by adjusting `scrollTop` by the height growth; the
  anchor applies only when `olderLoads` (a completed page read) changes, so a
  live append never moves a reader.
- "Jump to latest" appears when the reader is away from the live edge and
  returns to it. Follow/show-history state resets on project and thread change.
- A thread selector lists every project thread; the project's own shell thread
  is labelled **current** (from `ProjectDetail.currentThreadId`, which now
  prefers the deterministic local thread id over "most recently updated"), and
  the rest are labelled **archived**.
- The scope line states what is on screen: `N shown · M stored · older pages
  available | earliest stored event loaded`.
- `scroll-behavior: smooth` was removed: follow-scroll runs on every frame, and
  an animation reported the reader as away from the edge mid-flight, making
  "Jump to latest" flicker during a healthy stream.

## Agent-driven history API (main → renderer)

```
projects:history        { projectId, before?: {recordedAt,rowId}, limit?, threadId? }
projects:history-item   { projectId, threadId, itemId }
```

Both are strict IPC objects; a malformed cursor, a limit above 500, or a thread
that does not belong to the project is refused (`CONFLICT` for the thread).

## Verification

**Focused fixtures — 110 tests in 7 files**
(`artifacts/r02-focused-tests.txt`):

- 10,050-event project: every frame reachable exactly once by walking
  `olderCursor`; first page is the newest 200; `storedTotal` exact; state
  revision unchanged across the walk (no write, no runtime, no model request).
- One turn with **2,100 message frames** for `item_big`, 300 interleaved
  `item_small` frames, 52 heartbeats, both completions: the tail page shows
  `item_big` partial; `history-item` returns all 2,101 frames;
  `completeItems` rebuilds the exact text and clears `partial`; `item_small`
  stays a separate card.
- Two items of the same kind interleaved in one thread stay separate; streamed
  and completed cards share a key; a 1 → 90 sequence hole does not create loss,
  an error, or an unknown card; legacy rows are explicit unknown identity; a
  legacy completion is not bound when two same-kind streams are open.
- Scroll anchoring: prepending an older page moves `scrollTop` by exactly the
  height growth; a live append does not move it at all. The real Shell is
  exercised with a deferred IPC page.
- Schema v9 → v10: old event keeps `turn_id`, gains `item_id = NULL`; new rows
  can carry identity; both indexes exist.
- IPC: page and item requests validated; malformed cursors, limits and threads
  refused.
- Review-driven fixes: a failed thread switch snaps the selector back to the
  filter that is really on screen; an interrupted item keeps its streamed text
  instead of replacing it with the item kind; and a card whose completion
  carries its own text is not labelled partial (only a completion that merely
  adopts the streamed text leaves the page-boundary warning in place).

**Full suite — 852 tests in 83 files** (was 819 in 81 at R01). Typecheck clean,
lint 0 errors (3 pre-existing `any` warnings), `prettier --check .` clean.
(`artifacts/r02-full-tests.txt`, `artifacts/r02-gates.txt`.)

**Real Electron long-session smoke — 18/18**
(`artifacts/r02-history-long-smoke.json`, screenshot
`artifacts/r02-history-long-session.png`). Seeded into a real temporary
`StateStore` on this Mac: 10,054 stored events, one 2,100-frame turn, a second
archived thread. Observed in the running shell:

- scope `200 shown · 10054 stored · older pages available`;
- newest frame visible, frame 9850 absent until the first older page;
- thread selector: `Local shell thread · current`, `Archived work · archived`;
- engine connection **Not started** — history reading made no runtime request;
- after scrolling to `scrollTop = 300`, loading an older page grew the content
  by 14,700 px and moved the viewport by exactly 14,700 px (`delta = 0`, one
  anchor application);
- frame 9850 rendered exactly once; a second page reached frame 9650;
- "Jump to latest" returned to the live edge (`distance = 0`) and disappeared.

**Existing shell smoke — 127/127** on rerun (`artifacts/r02-shell-smoke.json`).
One earlier run reported `terminal_output: false`; the terminal path is
untouched by R02, and the immediate rerun was green. The flake is recorded
rather than hidden.

## Limits and deliberate non-goals

- **Legacy rows cannot be reconstructed.** Frames stored before v10 without an
  item id are grouped by turn and kind and shown as unknown identity. Loading
  them cannot recover a beginning that was never stored with identity; the card
  says so.
- **Item loads are bounded** at 4,000 frames per request (8,000 hard cap). A
  larger item reports `truncated` and the card states how many frames it holds.
- **Virtualization is not here.** The Studio renders the pages it has loaded
  (200 per page). Rendering performance under very large loaded windows is R11's
  subject; R02 makes the data bounded and reachable first.
- **New-thread lifecycle (`/new`) is R04.** The thread selector already
  distinguishes the current thread from archived ones, but creating a thread is
  not part of this task.
