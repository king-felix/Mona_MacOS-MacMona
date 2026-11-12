# P05 — Transactional project state and safe migrations

**Date:** 2026-11-11 · **Status:** complete · **Host:** macOS 26.5.1 arm64 ·
**Runtime:** Electron 45.3.0 / Node 24.22.2 (host Node 26.13.0)

## Result

Mona now has a real per-user project database with a single write path, versioned
migrations, revision-checked writes, a maintenance barrier that quiesces every
writer for backup/restore, crash-safe transactions, alias-aware project identity,
portable export/import with digests and revisions, and bounded artifacts with
retention that protects blocked-task evidence.

The database opens in the real Electron app as well as under the test runner:
`~/Library/Application Support/Mona/state/mona.sqlite`, mode 0600, directory mode
0700, schema v2, WAL, foreign keys on, `integrity_check` ok. The Electron smoke
reports `state_database_open: true`, `state_integrity_clean: true`, and
`state_permissions_private: true` (21/21 checks).

Verification: **166 tests in 21 files pass**, including **37 new P05 tests** across
five files. Local CI is green. Evidence: `p05-tests.txt`, `p05-full-suite.txt`,
`p05-schema.txt`, `p05-state-smoke.json`.

## Mechanism

`src/main/state/` — no Electron imports, so the whole layer runs under Vitest:

- `database.ts` — opens `node:sqlite` with WAL, `synchronous=FULL`,
  `foreign_keys=ON`, `trusted_schema=OFF`, busy timeout, 0600 modes; maps
  `SQLITE_FULL` to a typed `DISK_FULL`; runs `integrity_check` and
  `foreign_key_check`; one `BEGIN IMMEDIATE` transaction per write.
- `schema.ts` / `migrations.ts` — v1 core schema and v2 project-identity columns;
  checksums recorded per migration; pre-migration online snapshot; durable journal
  (`started` → `complete` / `failed` / `restored`); snapshot restore on failure;
  failed database preserved as `.failed-<stamp>`; journal never unlinked.
- `barrier.ts` — shared read/write gate with exclusive maintenance, writer
  preference, and FIFO drain.
- `store.ts` — the single writer: projects, path history, bindings, threads,
  turns, submissions, tasks/dependencies, evidence, attempts, decisions, events
  and cursors, usage, capability snapshots, settings versions, drafts, artifacts.
- `identity.ts` — canonical path + `(dev, ino)` identity, nested Git repository
  and linked-worktree detection.
- `artifact-files.ts` — content-addressed private files, size/quota/headroom
  limits, digest-verified reads, orphan sweep.
- `portable.ts` — canonical JSON, SHA-256 digest, strict bundle validation,
  referential and duplicate checks.
- `submission-store.ts` — `SqliteSubmissionStore` implements P03's
  `SubmissionStore` (persist-before-send unchanged).
- `paths.ts` — Application Support/Caches/Logs derivation, 0700/0600
  enforcement, cloud-synced and network filesystem rejection.

Wired at startup in `src/main/index.ts`: the store opens after the IPC boundary is
registered, a smoke run uses a temporary database so evidence never disturbs
product state, and the store closes on quit. `app:paths` now reports the database
path. Schema and ownership rationale: `docs/decisions/ADR-004-project-state.md`.

## Acceptance evidence

**Crash injection before/during/after a transaction.** A child process uses the
same SQLite engine and file format. `before` dies with no transaction, `during`
dies with `BEGIN IMMEDIATE` and an uncommitted row, `after` commits and then dies.
On reopen: no partial row in either interrupted case, the committed row survives,
integrity is clean, and the next write succeeds. (`state-database.test.ts`)

**Stale revision writes fail.** A project renamed at revision 1 is rev 2; a write
presenting revision 1 fails with `STALE_REVISION` and the stored row is unchanged.
The same check guards tasks. (`state-database.test.ts`, `state-catalog.test.ts`)

**Migration failure is recoverable.** A deliberately broken v3 migration rolls
back; the pre-migration snapshot is restored; the project row is still present at
v1. A destructive migration that commits but fails post-commit validation (drops
`drafts`) also restores the snapshot. The journal records the failure, the backup
exists, and the failed database is preserved. A changed migration checksum and a
newer schema are refused. (`state-database.test.ts`)

**Backup/restore with writers quiesced.** A held reader defers a snapshot and a
queued write in that order; after release, the reader finishes, the snapshot runs,
then the write proceeds. Restoring a snapshot reverts later changes; restoring a
corrupt file fails and puts the pre-restore database back. (`state-database.test.ts`)

**Disk-full is handled without false completion.** With the headroom probe at
zero, `updateTaskStatus(completed)` fails with `DISK_FULL`, and the task remains
`pending` at its original revision. A real `SQLITE_FULL` from
`PRAGMA max_page_count` rolls the transaction back (`state-database.test.ts`,
`state-artifacts.test.ts`). Artifact writes under pressure record no metadata.

**Two aliases do not duplicate a project.** Trailing slash, `..`, and a symlink
all resolve to one project; the catalog contains one entry. Nested repositories
and two linked worktrees of one repository remain distinct roots with the shared
repository recorded. A renamed folder is rebound deliberately by
`relocateProject`; the project id survives, path history keeps one active path,
and reopening the new path returns the same project. (`state-catalog.test.ts`)

**Portable export/import.** The bundle is digest-stable across exports, contains
no runtime binding, executable path, token, or artifact bytes, and round-trips
tasks, evidence, attempts, decisions, threads, usage, drafts, settings, and
submissions. A tampered payload is rejected with `IMPORT_DIGEST_MISMATCH`; a
duplicate id is rejected with `IMPORT_INVALID`; an older or unexpected revision
is refused with `IMPORT_REVISION_CONFLICT`; a missing target folder fails with
`INVALID_PATH` and no partial rows. (`state-portable.test.ts`)

**Retention protects blocked evidence.** Expired temporary artifacts are pruned;
evidence-class artifacts and artifacts belonging to a blocked task are retained
with warnings. Explicitly forcing deletion records that protected evidence was
removed. Orphan files are swept without touching referenced artifacts.
(`state-artifacts.test.ts`)

**Offline/replay correctness.** Replayed events with an existing `(thread, seq)`
are ignored; the cursor never moves backwards; usage with an unpriced turn reports
`costComplete: false` and never reports a complete cost. (`state-catalog.test.ts`)

## Multi-user and storage boundaries

- Paths derive from the user's home (`Library/Application Support/Mona`) or
  Electron's `userData`; two homes produce disjoint paths.
- Directories are 0700 and the database is 0600. `verifyPrivatePermissions`
  reports widened modes rather than assuming privacy.
- `runtime_bindings` has no token column; the schema inspection artifact lists its
  columns. Runtime tokens remain only in the owning process (P04).
- Cloud-synced locations (`Library/Mobile Documents`, `Library/CloudStorage`,
  Dropbox, Google Drive, OneDrive) and paths inside `.app/Contents` are refused;
  network filesystems (`nfs`, `smbfs`, `afpfs`, `cifs`, `webdav`, `ftp`) are
  refused through a filesystem-type check.

A second real macOS account was **not** created in this session (it needs a
different login and admin action). P05 qualifies path derivation, permissions, and
the absence of stored tokens; the literal two-account read/write denial belongs to
the P24 clean-recipient multi-user test. This is recorded below as a limitation,
not claimed as tested.

## Limitations / nonblocking issues

1. **Second OS account not exercised** — needs a separate login; scheduled for
   P24 (clean recipient, multi-user denial). P05 verifies the mechanisms that
   make it hold.
2. **Network filesystem classification** uses `/usr/bin/stat -f %T`; an
   unavailable `stat` skips the check rather than blocking startup. The P24 host
   audit should confirm on the recipient.
3. **No UI yet** — P07 consumes the catalog and bindings; P08 records events and
   usage. The state layer is wired at startup but not surfaced beyond smoke facts.
4. **Artifact bytes are not portable** — export carries metadata and digests
   only; import reports missing artifact digests instead of inventing files.
5. **Adapter ingestion barrier** is available (`StateStore.barrier`) but the P03
   adapter still uses an injected submission store; P08 will route its live
   ingestion through the same gate.

## Commands run

```sh
npx vitest run                      # 166 tests / 21 files
npm run build && npm run smoke      # 21/21 checks incl. state facts
npm run lint                        # 0 errors
node tools/monabuild/cli.mjs validate
```
