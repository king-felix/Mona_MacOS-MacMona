# ADR-004 — Transactional project state, ownership, and recovery

**Status:** accepted · **Date:** 2026-11-11 · **Prompt:** P05

## Context

Mona needs durable local state for project catalogs, runtime bindings, thread and
turn projections, submissions, tasks, requirement evidence, attempts, decisions,
event cursors, usage, capability snapshots, settings versions, drafts, and
artifact metadata. The state must survive crashes, failed migrations, full disks,
folder moves, and path aliases without inventing completion or duplicating a
project. Engine conversation history stays authoritative in Codewhale.

Electron 45 embeds Node 24.22.2. The host Node is 26.13.0. Both run on macOS
arm64 and neither may be replaced by Rosetta or a runtime-compiled dependency.

## Decision

### SQLite through `node:sqlite`

Use the built-in `node:sqlite` `DatabaseSync` from Electron's embedded Node. It
is present without a flag in both the host Node and Electron 45's runtime.

Verified on the build host:

- `DatabaseSync`, `StatementSync`, prepared statements, and transactions work.
- `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`,
  `busy_timeout`, `trusted_schema=OFF`, `max_page_count`, and
  `wal_checkpoint(TRUNCATE)` work.
- The module-level online `backup(sourceDb, path)` returns a Promise and produces
  a standalone snapshot that opens read-only and passes `integrity_check`.

No native module, prebuild, or ABI rebuild is pinned. A future Electron/Node
upgrade must re-run the state suite before the engine pin changes; that is a
compatibility decision, not a silent upgrade.

Rejected: `better-sqlite3` (native ABI rebuild per Electron upgrade, more
supply-chain surface), JSON files (no transactional multi-row writes, no foreign
keys, no online backup), and IndexedDB in the renderer (wrong privilege boundary,
no maintenance/writer coordination).

### Schema and versioning

- Schema version lives in `PRAGMA user_version`; every applied migration is also
  recorded in `schema_migrations` with its SHA-256 checksum and timestamp.
- Migrations are additive SQL strings applied in one transaction. Editing an
  applied migration is detected as `UNSUPPORTED_SCHEMA`; a database newer than
  the build is refused rather than opened.
- Foreign keys are enabled on every connection. `PRAGMA integrity_check` and
  `foreign_key_check` run after migration and on restore.
- `projects` and `tasks` carry per-row `revision`; writes require the expected
  revision and fail with `STALE_REVISION` instead of overwriting competing work.
  A `meta.state_revision` counter advances once per committed write transaction.

### One write path and the maintenance barrier

`StateStore` owns the only connection. Public methods either take a shared
read/write slot or an exclusive maintenance slot from `MaintenanceBarrier`.
Every mutation runs in `BEGIN IMMEDIATE ... COMMIT` with `synchronous=FULL`.
Adapter ingestion, the indexer, the task runner, and the catalog UI are expected
to call the same store; none receives the raw database handle.

Backup, restore, and explicit snapshots take the exclusive slot, so no writer
can slip in a transaction while a snapshot is taken. New work queues behind a
pending maintenance request and drains after it.

### Authority split

- **Codewhale owns** conversation/tool history, session receipts, and provider
  credentials. Mona stores thread/turn IDs and projections only.
- **Mona owns** project identity, catalog metadata, runtime bindings, tasks,
  dependencies, requirement evidence, attempts, decisions, settings versions,
  drafts, event cursors, usage records, capability snapshots, and artifact
  metadata.
- **Machine-local, never exported:** `runtime_bindings` (workspace, executable
  path, port, state) and artifact file bytes. No token column exists in the
  schema; runtime tokens live only in the owning process (P04).
- **Portable export:** project, path history, tasks, dependencies, evidence,
  attempts, decisions, thread/turn/usage projections, drafts, settings, artifact
  metadata, and submissions, wrapped with a SHA-256 digest over canonical JSON
  and the project revision. Import verifies the digest, referential integrity,
  duplicate IDs, and revisions before applying anything in one transaction.

### Project identity, aliases, and relocation

Identity is `(st_dev, st_ino)` from the canonical (`realpath`) folder plus the
canonical path. Active identities are unique across the catalog; trailing
slashes, `..`, case variations, and symlinks therefore resolve to one project.
Path history is retained; relocation deactivates the old path and records the new
one deliberately. A path that already belongs to another project yields
`ALIAS_CONFLICT`. Nested repositories and Git linked worktrees are distinct
roots; a linked worktree records its shared repository root separately.

### Artifacts, retention, and disk pressure

Artifact bytes live outside the database in a content-addressed private tree
(`<support>/artifacts/<project>/<sha256>.<ext>`), with digest, size, media type,
source, task, and retention class in SQLite. Per-artifact and per-project limits
are enforced before writing; a reserve keeps headroom. Evidence-class artifacts
never expire automatically. Temporary and diagnostic artifacts are pruned only
when expired; artifacts referenced by requirement evidence or by a blocked or
interrupted task are protected and produce warnings. Deleting protected artifacts
requires an explicit policy flag and records that it happened. Orphan files are
swept separately rather than silently deleted during a metadata transaction.

### Failure behavior

- A write transaction that hits `SQLITE_FULL` rolls back and returns `DISK_FULL`;
  task completion is never claimed. A filesystem headroom probe fails writes
  closed before they start.
- Before migrating an existing database, a snapshot is written with the online
  backup API, validated, and recorded in a durable journal. A failed migration is
  rolled back; a failed post-commit validation restores the snapshot. The failed
  database and the journal are preserved, never unlinked. Journals are marked
  `started`, `complete`, `failed`, or `restored`.
- Restore moves the current database aside as evidence, copies and validates the
  snapshot, and puts the pre-restore database back if validation fails.
- Opening a database runs `integrity_check`. A corrupt file is reported, not
  silently replaced.

## Consequences

- `SqliteSubmissionStore` implements P03's `SubmissionStore`, preserving
  persist-before-send without changing the adapter contract.
- P07 reads the catalog and view state through this store; P08 records events
  and usage through it; P10/P11 use tasks, dependencies, attempts, and evidence.
- Backups and migration snapshots are local SQLite files under
  `<support>/state/backups` with mode 0600.
- Actual two-OS-account isolation and Finder/packaging relocation are qualified
  in P24; P05 verifies disjoint per-user paths, 0700/0600 modes, no token column,
  and that no state is written into the workspace or a cloud-synced folder.
