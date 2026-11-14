# R01 — Lossless drafts and asynchronous navigation

**Date:** 2026-11-14 · **Platform:** darwin-arm64, macOS 26.5.1 · **Node:** v26.13.0
**Depends on:** R00 (completed) · **Findings:** RV-01, RV-02 · **Feature:** UX-COMPOSER

## 1. What was wrong

Every defect here is an ordering defect, and each one is visible in the R00
source:

- **RV-01 — a send erased text that was never sent.** `submitTask` captured the
  prompt, awaited, and then cleared the composer and saved an empty draft. Text
  typed while the send was in flight was destroyed, and once the user had
  switched projects the empty save landed on a thread that was no longer on
  screen. Nothing prevented a second click or ⌘Enter from dispatching again
  before React had re-rendered the busy state.
- **RV-01 — a draft save could lie.** `persistDraft` wrote whatever the ref held
  when the call began and then set `saved` unconditionally when the reply
  arrived, so an older write's acknowledgement labelled newer text as stored.
  Saves were not serialized: two debounced writes could land out of order.
- **RV-02 — a stale load could own the screen.** `selectProject` had no
  generation counter. `refreshSelected` compared project ids, which cannot
  distinguish A's first load from A's load after A→B→A. `setStudio` was applied
  from every completion path, so a slow action on A could replace B's studio.
  `busy` was a boolean set and cleared around awaits, so overlapping operations
  could clear it early; errors and notices were applied after awaits with no
  identity at all.

## 2. What was built

**`src/renderer/shell/session.ts`** (new, pure, no React):

- `SelectionEpoch` — a monotonic token. A result is applied only if the token it
  captured is still current. This is deliberately stricter than comparing
  project ids, which is exactly the A→B→A hole.
- `SubmissionGate` — a synchronous single-flight claim. The identity is
  immutable `{projectId, threadId, draftRevision, text, mode}`, captured before
  the first await; empty text is refused; release is identity-checked.
- `DraftJournal` — owns draft text per `(project, thread)` key:
  - every edit bumps a revision;
  - writes are **serialized per key** through a promise chain, so an older save
    can never land after a newer one;
  - one convergence loop per key (`settle`) writes the newest text and stops on
    failure, so a rejection does not spin;
  - an acknowledgement may report `saved` only when the revision it wrote is
    still current;
  - `acceptSent(identity)` clears **only** when the active key and revision still
    match exactly, otherwise it returns `preserved` (newer text) or `stale`
    (another project), and never touches that other draft;
  - a cleared draft is persisted as a deletion through the same queue.

**`src/renderer/shell/Shell.tsx`**:

- `selectProject` claims an epoch before its first await and discards its results
  if superseded; the outgoing draft is flushed before the key is replaced.
- `refreshSelected`, `startStudio`, `submitTask`, `runStudioAction`,
  `reconcileStudio`, `performProjectAction`, `relocate`, `submitIdentity`,
  `removeProject`, `openFolder`, `onDrop`, `handleOpenResult` all capture the
  epoch and apply `selected`/`studio`/notices only while it is current.
- Failures are **never suppressed**: a stale error is shown with the project name
  in front, so it cannot be misread as the current project's failure.
- `busy` is a counter (`beginBusy`/`endBusy`), so overlapping work cannot leave
  it stuck or clear it early.
- `submitTask` claims the gate synchronously, sends the captured bytes, and after
  acceptance calls `drafts.acceptSent(identity)`. It says "Text typed since
  sending was kept" when that is what happened.
- Favorite insertion goes through the same journal path as typing; the quit
  dialog flushes the composer before `quitMona`; a project switch flushes the
  outgoing key first.
- `saveProjectView` re-checks the selected project inside the timer, so a mixed
  view is never stored against another project.

## 3. Race matrix

Both columns are the same nine tests in `test/shell-races.test.tsx`, run against
the real `Shell` and `StudioScreen` with a fake bridge whose IPC answers are
deferred by the test. The "before" column is `Shell.tsx` at its R00 state with
the R01 module and tests present.

| Ordering under test | Before (R00 Shell) | After |
|---|---|---|
| Slow A load, then B selected, A resolves last | `expected 'Alpha' to be 'Beta'` — stale selection applied | shows Beta |
| A→B→A, then the first A response arrives last | `expected <textarea> to be null` — stale payload opened A | stays on the catalog; the newest A load opens "fresh A draft" |
| Text typed while a send is in flight | `expected '' to be 'Ship the fix, then update the notes.'` — text destroyed | text kept, sent bytes unchanged, newest text saved |
| Project switch during a send | `expected '' to be 'B work in progress'` — B's draft cleared by A's acceptance | B's draft intact, no empty save for B |
| Click + click + ⌘Enter before resolution | `length 1 but got 3` — three dispatches | one dispatch, gate released afterwards |
| Older save acknowledged after newer typing | `'Draft saved locally' not to contain 'Draft saved locally'` — older ack claimed the newer text | stays "Saving draft…" until the newer write is acknowledged |
| Save rejected by main | passes (text kept, error shown) | passes; still keeps text and says "could not be saved" |
| Acceptance with nothing changed | passes | passes; composer clears and the deletion is persisted |
| Restart with a stored draft | passes | passes; draft restored, nothing sent |

Pre-fix artifact: `artifacts/r01-prefix-races.txt` (`6 failed | 3 passed`).
Post-fix: `9 passed`.

**`test/shell-session.test.ts`** adds 14 unit tests over the primitives,
including serialization order (`calls ["one","two"]`, only one write in flight),
per-project keys, the no-thread draft that is never lost, and gate release by
identity.

## 4. Gates

| Gate | Result |
|---|---|
| `npx vitest run test/shell-races.test.tsx test/shell-session.test.ts` | 23 passed |
| `npm test` | **819 passed in 81 files** (was 796/79) |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 3 pre-existing warnings |
| `npm run format:check` | clean |
| `npm run smoke:shell` (real Electron) | **127/127, exit 0** — draft loads, send enabled, layouts unchanged |

Artifacts: `artifacts/r01-tests.txt`, `artifacts/r01-shell-smoke.json`.

## 5. Design choices worth stating

- **Renderer-side serialization, not main-side CAS.** The prompt allows either.
  Serializing per key in the journal fixes the ordering at the only place that
  knows the user's newest text; main still sees one write at a time per key.
  A CAS column would not have prevented the "older acknowledgement labels newer
  text saved" half of the defect.
- **`preserved` is a real outcome.** When text arrives during a send, clearing it
  would be a data loss; the notice says the newer text was kept instead of
  silently doing either.
- **Stale errors are labelled, not dropped.** Hiding a failure because the user
  moved on would be dishonest; presenting it as the current project's would be
  misleading.

## 6. Not verified here

- No live engine turn; all IPC is the fake bridge in tests, and the shell smoke
  uses the fixture project.
- The installed candidate (R13) and native fullscreen/accessibility (R05/R11)
  are later tasks.
- Multi-window work is out of scope: the shell is single-window, and the journal
  is per renderer instance.
