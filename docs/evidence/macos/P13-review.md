# P13 — Changes, Git, and restore evidence

**Prompt:** P13 — Make changes, evidence, Git, and restore trustworthy
**Date:** 2026-11-11 · **Engine:** Codewhale 0.10.2
(`ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`) · **Host:** M3, macOS 26.5.1,
arm64

## What shipped

- **A real Changes lens** (`src/renderer/shell/Changes.tsx`) with two views:
  engine receipts and workspace/Git. It is reachable by the rail, by `⌘4`, and
  by the persisted screen selection. No screen change starts a runtime or makes
  an inference call.
- **Change receipts as stored projections** (`src/main/work/changes.ts`,
  migration v6): `change_sets`, `change_files`, `restore_receipts`,
  `commit_receipts`, plus `events.turn_id` so a tool item can be joined to its
  turn without reparsing the envelope.
- **Capture from the engine**: on a terminal turn the studio reads
  `GET /v1/threads/{id}/turns/{turn_id}/artifacts`; the later `turn.artifacts`
  event upgrades the same projection. Evidence rank prevents a weaker receipt
  from overwriting a stronger one. A route failure stores an explicit
  `unavailable` receipt, never an empty diff.
- **Attribution that stops at what is known**: `tool`, `workspace_delta`,
  `artifact`, and `unreceipted` are separate labels. A dirty path with no
  receipt is never called agent-written.
- **Lazy review windows**: text and per-call diffs are fetched on demand; the
  renderer virtualizes visible lines; binary, oversized (>16 MiB), deleted, and
  missing content each have their own honest state. Tool output and media are
  read through the engine's artifact route.
- **Git awareness** (`src/main/work/git.ts`): porcelain v2 status, branch,
  detached HEAD, linked worktree name, upstream/ahead/behind, HEAD subject,
  bounded literal diffs, selected staging, and selected commits. Unrelated
  staged work survives. A non-Git folder is reported and never initialized.
- **Native restore**: previews of exact scope, exclusions, conflicts, and
  recovery information; `POST /v1/threads/{id}/file-revert` with the recorded
  restore point and `expected_hash`; path-by-path acknowledgement of later or
  unattributed edits; `STALE_PREVIEW` refusal when the file changed after the
  preview; a restore receipt per attempt.
- **Revision-checked editor writes**: `PUT /v1/workspace/files` with the revision
  that was read; a 409 keeps the draft and shows the current revision. No
  unguarded local write fallback.
- **New narrow IPC**: `changes:snapshot`, `changes:refresh`, `changes:file`,
  `changes:artifact`, `changes:restore-preview`, `changes:restore`,
  `changes:git-stage`, `changes:git-commit`, `changes:write-file`,
  `changes:reveal`. Every payload is a strict schema.

Decision record: `docs/decisions/ADR-008-changes-git-and-restore.md`.

## Verification

### Automated tests

`docs/evidence/macos/artifacts/p13-tests.txt` — **383 tests in 41 files pass**,
including:

- `test/work-git.test.ts` (11): clean/dirty/conflict/worktree/subfolder status;
  literal path safety; selected commit leaves unrelated staged work staged; a
  file staged and then edited is not committed by accident; staged vs unstaged
  diffs.
- `test/work-changes.test.ts` (16): settled projection and source attribution;
  unavailable delta is not an empty diff; evidence never regresses; dirty Git
  attribution with unreceipted work; preview conflicts, acknowledgement,
  successful restore receipt, stale preview, exclusions, no-engine refusal,
  lazy text/diff windows, binary detection, write conflicts, selected commits,
  and non-Git refusal.
- `test/engine-artifacts.test.ts` (15): artifact listing, binary/oversized/
  missing artifact windows, captured vs pending call spans, file-revert 200/
  409/405, restore probe, snapshot listing, workspace read states, and the 409
  write-conflict revision.
- `test/changes-screen.test.tsx` (3): receipt rendering with real attribution
  labels, worktree/unreceipted Git rows, non-Git honesty, lazy text load, and
  the restore-unavailable reason.
- `test/state-database.test.ts` updated for migration v6; migration recovery
  still restores the previous database when a later migration damages the
  schema.

### Sample ledger run

`docs/evidence/macos/artifacts/p13-changes-sample.json` — **27/27 checks pass**
on a real temporary SQLite database and a real Git repository:

```
settled_receipt, missing_delta_is_not_empty, tool_attribution,
delta_attribution, artifact_attribution, binary_and_large_marked,
deleted_file_kept, restore_available, text_window, diff_window,
later_edit_is_conflict, conflict_refused, restore_through_engine,
restored_bytes, restore_receipt_written, stale_preview_refused,
stale_preview_did_not_overwrite, artifact_not_restorable,
selected_commit_only, unrelated_staged_preserved,
unreceipted_is_not_agent_authored, commit_receipt_written,
mixed_commit_refused, explicit_mixed_commit, editor_conflict,
non_git_reported, non_git_stage_refused
```

The script also proves the Git commit contains exactly `selected.txt` while
`unrelated-staged.txt` remains staged, and that the restored file's bytes match
the pre-turn content.

### Real Electron shell

`docs/evidence/macos/artifacts/p13-shell-changes.json` — the shell smoke report
is **57/57 checks pass** (including all P07/P11/P12 checks) with the new changes
checks:

- `changes_screen`, `changes_receipt_rendered`, `changes_attribution`
  (`Tool: edit_file` and `Workspace delta`), `changes_missing_restore_point`,
  `changes_restore_unavailable` (with the exact reason), `changes_git_state`
  (branch `main` and an unreceipted dirty path), and
  `changes_no_horizontal_overflow`, and `changes_lazy_text_window` (opening
  `src-app.ts` lazily shows the real local window with a labelled source).

Screenshots: `docs/evidence/macos/artifacts/p13-shell-changes.png` and
`docs/evidence/macos/artifacts/p13-shell-changes-file.png`.

The P07/P11/P12 screenshots were rewritten by the shell run and then restored to
their committed bytes, so their pinned hashes remain valid. Only the new P13
screenshot is committed from this run.

### Local CI

`docs/evidence/macos/artifacts/p13-ci.txt` — format, lint, both typechecks,
supervisor and service builds, 383 tests, renderer build, `smoke:board`,
`smoke:cost`, and `smoke:changes` all pass; the renderer secret scan reports 0
patterns in 3 files.

### Schema and engine contract

- `docs/evidence/macos/artifacts/p13-schema.txt` — `user_version = 6` and the
  four new tables plus the `events.turn_id` column.
- `docs/evidence/macos/artifacts/p13-routes.txt` — the pinned engine's artifact,
  call-changes, snapshot-list, file-revert, and workspace file routes, copied
  from the declared runtime contract.

## Acceptance mapping

- **Dirty-repository scenario preserves user changes and staged entries**:
  `work-git` selected-commit test and `p13-changes-sample.json` checks
  `selected_commit_only`, `unrelated_staged_preserved`; no reset/clean command
  exists in the module.
- **Changed file edited externally gets conflict handling**:
  `changed_after_turn` conflicts, path-by-path acknowledgement, `STALE_PREVIEW`
  when bytes change after preview, and the engine's own 409 preserved as
  `RESTORE_CONFLICT`.
- **Deleted/binary/large files display honestly**: `deleted` kind is kept,
  `binaryHint`/`oversized` are shown, binary windows are not rendered, >16 MiB
  windows say so, and a missing snapshot is `missing`, not blank.
- **Missing snapshot is not an empty diff**: unavailable sets store the engine's
  reason and are counted as missing; the UI says "That is a missing receipt, not
  an empty diff."
- **Supported restore works and unsupported scope is explained**: file-revert
  succeeds with a receipt; no-restore-point, artifact, symlink/non-regular, and
  later-edit cases are exclusions or acknowledged conflicts; the recovery
  snapshot and its pruning are disclosed.
- **Test cards link to commands/results/commit evidence**: every set lists the
  engine's tool and test receipts (name, status, summary, output artifacts);
  when a commit from Mona names the set's paths, the card shows the commit
  hash/subject; otherwise it says no commit from this surface names them.

## Limitations and capability gaps

These remain truthful and are recorded rather than hidden:

1. **Restore needs the live studio.** Without it, the engine's checked revert
   route is unreachable; Mona does not build a local snapshot store as a
   fallback (`changes_restore_unavailable` in the shell smoke).
2. **One file at a time.** `patch-undo` (which forks the conversation) and
   whole-workspace `/v1/snapshots/{id}/restore` are engine-native actions with
   no Mona control yet. They stay in the capability gap ledger.
3. **Snapshot pruning is the engine's.** Recovery is not permanent (newest 50
   snapshots plus newest 50 turn boundaries). A pruned restore point surfaces
   as the engine's 409 and is not retried.
4. **Excluded effects are not restorable.** Build output, dependency installs,
   binaries and `.gitignore` paths excluded from snapshots, shell writes to
   those paths, deployments, API writes, and installed software are named as
   unsupported rather than promised.
5. **Attribution is not authorship.** A `workspace_delta` or `unreceipted` path
   may be the user's own work; the UI says so and requires acknowledgement
   before a restore can touch it.
6. **Selected commits commit working-tree content.** A path with both staged and
   unstaged changes requires an explicit `includeUnstaged` choice; partial hunk
   staging is not offered. Unrelated staged entries are preserved but not
   committed.
7. **Git is deliberately small.** No history rewriting, no remote operations, no
   stash, no conflict-resolution automation. A merge conflict is displayed as a
   conflict and must be resolved by the user.
8. **No per-file diff when the engine recorded none.** The view falls back to a
   labelled current local Git diff, or says there is no patch; it never presents
   a local diff as the turn's diff.
9. **Editor scope is a complete text window.** Truncated/oversized/binary files
   cannot be edited; writes go through the engine's 4 MiB body limit.
10. **Native restore and Git behavior on a signed packaged build** still need the
    P21/P22 release checks; this evidence is the local arm64 build.

## Files

Main process: `src/main/work/changes.ts`, `src/main/work/git.ts`,
`src/main/state/schema.ts`, `src/main/state/store.ts`,
`src/main/engine/adapter.ts`, `src/main/engine/types.ts`,
`src/main/engine/errors.ts`, `src/main/engine/transport.ts`,
`src/main/work/studio.ts`, `src/main/ipc.ts`, `src/main/ipc-contract.ts`,
`src/main/index.ts`.

Shared/renderer: `src/shared/contracts/changes.ts`,
`src/shared/contracts/bridge.ts`, `src/preload/index.ts`,
`src/renderer/shell/Changes.tsx`, `src/renderer/shell/Shell.tsx`,
`src/renderer/shell/types.ts`, `src/renderer/design/icons.tsx`,
`src/renderer/styles.css`.

Tests and smoke: `test/work-git.test.ts`, `test/work-changes.test.ts`,
`test/engine-artifacts.test.ts`, `test/changes-screen.test.tsx`,
`scripts/changes-smoke.mjs`; CI now runs `smoke:changes`.
