# ADR-008 — Change receipts, Git boundaries, and native restore

**Status:** accepted · **Date:** 2026-11-11 · **Prompt:** P13

## Context

P08 made a live turn visible; P12 priced it. Neither could answer the question
that decides whether to keep the work: what changed, who or what changed it,
what does Git see, and can it be safely undone? Three failure modes had to be
designed out:

1. **Attribution by vibes.** A path that is dirty when a turn ends is not proof
   the agent wrote it. The engine records a workspace delta, not authorship;
   shell commands, other threads, editors, and the user can write the same
   workspace while a turn runs.
2. **A second snapshot engine.** Reimplementing diffs, snapshots, or restore in
   Mona would drift from the engine's own receipts and could silently overwrite
   later work. The pinned engine already records restore points and exposes a
   checked `file-revert` route.
3. **Routine repository destruction.** `reset --hard`, blanket `clean`, and
   whole-index commits are the usual shortcuts. They erase the unrelated staged
   work a careful user keeps while reviewing.

## Decision

### The engine's turn record is the change authority

A completed turn produces a **change set**: workspace delta state (`settled`,
`pending`, `unavailable`), pre/post snapshot ids, and typed artifact references.
Mona stores that projection in `change_sets` / `change_files` (migration v6) and
never scans the workspace to invent a competing list.

- Evidence never regresses. A settled route read (rank 3) is not overwritten by
  a `turn.artifacts` event without files (rank 2) or a bare `turn.completed`
  (rank 1). A later complete record may replace an earlier one.
- `state: unavailable` is stored with the engine's reason
  (`snapshots_disabled`, `workspace_too_large`, `too_many_files`,
  `unsafe_location`, `snapshot_failed`, `not_captured`, `runtime_restarted`,
  `delta_failed`) or `receipt_unavailable`. An unavailable set is rendered as a
  missing receipt, not as an empty diff. A settled set with no files is the one
  case where "nothing changed" is a real answer.
- Tool output and media are listed as artifacts with their ids; they are not
  workspace paths and are never offered for restore.

### Attribution is weaker than authorship

Every file row carries both a `source` (what the engine said) and an
`attribution` (what Mona can defend):

- `tool` — the engine recorded a tool call that wrote the path. Mona names the
  tool and never says "the agent wrote every related file".
- `workspace_delta` — the path changed while the turn ran but the engine did not
  attribute it to a tool. It may be a shell write, another thread, or the user's
  own edit. Restoring it requires explicit acknowledgement.
- `artifact` — tool output or media, not a workspace file.
- `unreceipted` — a dirty Git path that no stored turn names. It may be
  pre-existing, staged before this review, or edited outside Mona. Timing alone
  never promotes it to agent authorship.

### Git is read with a fixed allowlist, and only the named paths move

`src/main/work/git.ts` issues only `rev-parse`, `status --porcelain=v2 -z`,
`diff`, `log`, `add`, and `commit`. It never runs `reset`, `checkout`, `clean`,
`stash`, `rebase`, or a force operation. Paths are validated (relative, no
`.git`, no `..`, no NUL) and passed literally after `--` with
`--literal-pathspecs`, so a filename that looks like a flag stays a filename.
Output is bounded and time-limited; `--no-ext-diff` and `--no-textconv` prevent
a repository config from executing helpers during review.

A commit from Mona names the selected paths (`git commit -m … -- <paths>`), so
unrelated staged entries remain in the index. A selected file that has both
staged and unstaged content is refused unless the user explicitly chooses to
include the working-tree content; otherwise path-limited commit would silently
include the unstaged edit. There is no "commit all" control and no automatic
staging of anything the user did not select.

A non-Git folder is reported as such. Mona does not initialize a repository.

### Restore is the engine's checked revert, never a Mona snapshot

Mona exposes one restore primitive: `POST /v1/threads/{id}/file-revert` for
exactly one regular file, with the exact restore point the engine recorded and
the `expected_hash` of the bytes the preview saw. It is deliberately narrower
than the engine's whole-workspace `/v1/snapshots/{id}/restore` and forking
`patch-undo`.

A restore has two phases:

1. **Preview.** For each selected path: scope, predicted action (`modified`,
   `recreated`, `removed`), current hash, recorded revision, exclusions
   (`no_restore_point`, `not_a_workspace_file`, `outside_workspace`), conflicts
   (`changed_after_turn`, `unattributed_change`, `not_a_regular_file`), and
   recovery information. A path whose bytes differ from the recorded revision
   is a `changed_after_turn` conflict; an unattributed delta is always a conflict;
   both must be acknowledged path by path. `planHash` binds the preview's scope
   and hashes.
2. **Execution.** Recompute the preview, compare the supplied `expected` hashes
   to the current files (a mismatch is `STALE_PREVIEW` and nothing runs), check
   acknowledgements, then call `file-revert` sequentially. A failure stops the
   run; files already restored and files not attempted are both reported. Each
   attempt is recorded in `restore_receipts` with the engine's snapshot id and
   action.

Recovery is the engine's mandatory `pre-restore:` snapshot, described as such.
The snapshot store is pruned by the engine (newest 50 snapshots plus newest 50
turn boundaries; older records may be unrecoverable), so recovery is explicitly
not permanent. Mona does not create a second snapshot store, and restore is
unavailable — with a reason — when the studio is not live or the engine build
does not advertise the route.

Unsupported effects stay unsupported: shell writes to excluded paths, build
output, dependency installs, binaries excluded from snapshots, deployments, API
writes, installed software, and every external side effect. They are named in
the preview rather than promised as reversible.

### Editor writes use the engine's revision check

The file viewer reads a recorded revision (turn artifact, or the current
workspace file when the engine is live) and edits only a complete, non-truncated
text window. Saving goes through `PUT /v1/workspace/files` with the revision
that was read. A 409 becomes a visible conflict with the current revision; the
draft stays in the editor and the file is not overwritten. Without a live
engine the editor is disabled rather than falling back to an unguarded local
write.

### Views are lazy and bounded

Text and diff windows are read on demand. The renderer virtualizes visible lines
of a monospace view, and "load more" advances an explicit offset; it does not
build a 10,000-node list. Binary content is reported as binary, files over the
engine's 16 MiB read limit are reported as oversized, and a missing snapshot is
reported as missing. The per-call `changes` route supplies a real patch when the
engine recorded one; when it did not, the view says so instead of showing an
empty diff or substituting an unrelated local diff.

## Consequences

- A reviewer can trust the receipt, reject the attribution, and see both.
- Restore cannot erase a later edit without an explicit acknowledgement, and
  cannot promise rollback of excluded or external effects.
- Mona's Git surface is intentionally smaller than a full Git client. Partial
  hunk staging, history rewriting, and remote operations are not offered.
- `patch-undo` (conversation-forking) and whole-workspace snapshot restore
  remain engine-native actions without a Mona control. They are recorded in the
  capability gap ledger rather than approximated.
- The change ledger adds local projections only; no inference occurs on any read,
  preview, restore, stage, or commit path.
