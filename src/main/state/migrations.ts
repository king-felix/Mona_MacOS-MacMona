import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeJsonDurable } from "./atomic-json";
import {
  assertIntegrity,
  backupDatabase,
  checkIntegrity,
  listTables,
  openDatabase,
  readUserVersion,
  writeUserVersion,
  type OpenDatabaseOptions,
} from "./database";
import { StateError } from "./errors";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrationChecksum,
  requiredTablesFor,
  type Migration,
} from "./schema";

export interface MigrationJournal {
  schema_version: 1;
  db_path: string;
  from_version: number;
  to_version: number;
  state: "started" | "complete" | "failed" | "restored";
  started_at: string;
  updated_at: string;
  backup_path: string | null;
  applied_versions: number[];
  error: { code: string; message: string } | null;
  restored: boolean;
}

export interface MigrateOptions {
  dbPath: string;
  migrations?: readonly Migration[];
  now?: () => Date;
  /** Where pre-migration snapshots and journals live. Defaults beside the DB. */
  backupDir?: string;
  databaseOptions?: Omit<OpenDatabaseOptions, "path">;
}

export interface MigrationOutcome {
  db: DatabaseSync;
  appliedVersions: number[];
  backupPath: string | null;
  journalPath: string | null;
  /** True when the migration ran on a new empty database. */
  fresh: boolean;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function readJournal(path: string): MigrationJournal | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MigrationJournal;
  } catch {
    return null;
  }
}

function appliedVersions(db: DatabaseSync): number[] {
  try {
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    return rows.map((row) => Number(row.version));
  } catch {
    return [];
  }
}

function verifyAppliedChecksums(db: DatabaseSync, migrations: readonly Migration[]): void {
  const rows = appliedVersions(db);
  if (rows.length === 0) return;
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const recorded = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; checksum: string }>;
  for (const row of recorded) {
    const migration = byVersion.get(Number(row.version));
    if (!migration) {
      throw new StateError(
        "UNSUPPORTED_SCHEMA",
        `database records migration v${row.version}, which this build does not know`,
      );
    }
    if (migrationChecksum(migration) !== row.checksum) {
      throw new StateError(
        "UNSUPPORTED_SCHEMA",
        `migration v${row.version} was modified after it was applied`,
        { recorded: row.checksum, expected: migrationChecksum(migration) },
      );
    }
  }
}

function validateMigratedDatabase(
  db: DatabaseSync,
  target: number,
  migrations: readonly Migration[],
): void {
  const version = readUserVersion(db);
  if (version !== target) {
    throw new StateError("MIGRATION_FAILED", `schema version is ${version}, expected ${target}`);
  }
  const tables = new Set(listTables(db));
  const missing = requiredTablesFor(target).filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new StateError("MIGRATION_FAILED", "migrated database is missing required tables", {
      missing,
    });
  }
  const recorded = appliedVersions(db);
  const expected = migrations
    .filter((migration) => migration.version <= target)
    .map((migration) => migration.version);
  if (recorded.join(",") !== expected.join(",")) {
    throw new StateError(
      "MIGRATION_FAILED",
      "schema_migrations does not match the migration list",
      {
        recorded,
        expected,
      },
    );
  }
  assertIntegrity(db, "post-migration validation");
}

function moveAside(dbPath: string, label: string, suffixes: readonly string[]): void {
  for (const suffix of suffixes) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) renameSync(source, `${dbPath}.${label}${suffix}`);
  }
}

function restoreSnapshot(options: {
  db: DatabaseSync;
  dbPath: string;
  backupPath: string;
  expectedVersion: number;
  now: Date;
}): DatabaseSync {
  const { db, dbPath, backupPath, expectedVersion, now } = options;
  const label = `failed-${stamp(now)}`;
  db.close();
  moveAside(dbPath, label, ["", "-wal", "-shm"]);
  copyFileSync(backupPath, dbPath);
  chmodSync(dbPath, 0o600);
  const restored = openDatabase({ path: dbPath });
  try {
    assertIntegrity(restored, "restored pre-migration snapshot");
    if (readUserVersion(restored) !== expectedVersion) {
      throw new StateError("MIGRATION_FAILED", "restored snapshot has the wrong schema version", {
        version: readUserVersion(restored),
        expected: expectedVersion,
      });
    }
    return restored;
  } catch (error) {
    try {
      restored.close();
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

/**
 * Open and migrate. A pre-migration snapshot is taken with SQLite's online
 * backup API, a journal is written before any change, and a failed migration is
 * restored from that snapshot. Neither the journal nor the failed database is
 * removed: they are the evidence needed to diagnose the failure.
 */
export async function migrateDatabase(options: MigrateOptions): Promise<MigrationOutcome> {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date());
  const target = migrations[migrations.length - 1]?.version ?? CURRENT_SCHEMA_VERSION;
  const memory = options.dbPath === ":memory:";
  const backupDir = options.backupDir ?? join(dirname(options.dbPath), "backups");

  const db = openDatabase({ path: options.dbPath, ...options.databaseOptions });
  const from = readUserVersion(db);

  if (from > target) {
    db.close();
    throw new StateError(
      "UNSUPPORTED_SCHEMA",
      `database schema v${from} is newer than this build (v${target})`,
      { from_version: from, to_version: target },
    );
  }
  verifyAppliedChecksums(db, migrations);

  if (from === target) {
    assertIntegrity(db, "opening the existing database");
    return { db, appliedVersions: [], backupPath: null, journalPath: null, fresh: from === 0 };
  }

  const pending = migrations.filter((migration) => migration.version > from);
  if (pending.length === 0) {
    return { db, appliedVersions: [], backupPath: null, journalPath: null, fresh: from === 0 };
  }

  if (memory) {
    applyMigrations(db, pending, target, now);
    validateMigratedDatabase(db, target, migrations);
    return {
      db,
      appliedVersions: pending.map((migration) => migration.version),
      backupPath: null,
      journalPath: null,
      fresh: true,
    };
  }

  let backupPath: string | null = null;
  if (from > 0) {
    backupPath = join(backupDir, `pre-migration-v${from}-${stamp(now())}.sqlite`);
    try {
      await backupDatabase(db, backupPath);
      const snapshot = openDatabase({ path: backupPath, readonly: true });
      try {
        assertIntegrity(snapshot, "pre-migration snapshot");
      } finally {
        snapshot.close();
      }
    } catch (error) {
      db.close();
      throw new StateError("MIGRATION_FAILED", "could not create a pre-migration snapshot", {
        backup_path: backupPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const journalPath = join(
    backupDir,
    `migration-journal-v${from}-to-v${target}-${stamp(now())}.json`,
  );
  const journal: MigrationJournal = {
    schema_version: 1,
    db_path: options.dbPath,
    from_version: from,
    to_version: target,
    state: "started",
    started_at: now().toISOString(),
    updated_at: now().toISOString(),
    backup_path: backupPath,
    applied_versions: [],
    error: null,
    restored: false,
  };
  writeJsonDurable(journalPath, journal);

  try {
    applyMigrations(db, pending, target, now);
    validateMigratedDatabase(db, target, migrations);
    journal.state = "complete";
    journal.applied_versions = pending.map((migration) => migration.version);
    journal.updated_at = now().toISOString();
    writeJsonDurable(journalPath, journal);
    return {
      db,
      appliedVersions: [...journal.applied_versions],
      backupPath,
      journalPath,
      fresh: from === 0,
    };
  } catch (error) {
    const stateError =
      error instanceof StateError
        ? error
        : new StateError(
            "MIGRATION_FAILED",
            error instanceof Error ? error.message : String(error),
          );
    journal.state = "failed";
    journal.error = { code: stateError.code, message: stateError.message };
    journal.updated_at = now().toISOString();

    let restored = false;
    let restoreError: string | null = null;
    if (backupPath) {
      try {
        // The restored handle is closed by restoreSnapshot's validation path on
        // failure; on success the disk file is the recovery artifact. Reopening
        // happens on the next launch, so close it here.
        const restoredDb = restoreSnapshot({
          db,
          dbPath: options.dbPath,
          backupPath,
          expectedVersion: from,
          now: now(),
        });
        restoredDb.close();
        restored = true;
        journal.state = "restored";
      } catch (restoreFailure) {
        restoreError =
          restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure);
      }
    } else {
      // A fresh database has no old state to keep. Preserve the failed file and
      // leave an empty database so the next launch retries cleanly.
      try {
        db.close();
      } catch {
        // Already unusable.
      }
      moveAside(options.dbPath, `failed-${stamp(now())}`, ["", "-wal", "-shm"]);
    }

    journal.restored = restored;
    journal.updated_at = now().toISOString();
    writeJsonDurable(journalPath, journal);
    throw new StateError("MIGRATION_FAILED", `migration v${from} -> v${target} failed`, {
      journal_path: journalPath,
      backup_path: backupPath,
      restored,
      restore_error: restoreError,
      cause: stateError.message,
    });
  }
}

function applyMigrations(
  db: DatabaseSync,
  pending: readonly Migration[],
  target: number,
  now: () => Date,
): void {
  // A table rebuild (SQLite cannot change a CHECK constraint in place) must not
  // cascade into dependent rows. The documented procedure disables foreign-key
  // enforcement before the transaction; `assertIntegrity` runs
  // `PRAGMA foreign_key_check` before the migration is recorded, so a dangling
  // reference still fails the migration.
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as
    { foreign_keys?: number } | undefined;
  const forcedOff = Number(foreignKeys?.foreign_keys ?? 1) === 1;
  if (forcedOff) db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, migrationChecksum(migration), now().toISOString());
    }
    writeUserVersion(db, target);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Fatal I/O errors may already have rolled back.
    }
    throw error;
  } finally {
    if (forcedOff) db.exec("PRAGMA foreign_keys = ON");
  }
}

export function readMigrationJournal(path: string): MigrationJournal | null {
  return readJournal(path);
}

export function checkDatabaseIntegrity(db: DatabaseSync): { ok: boolean; problems: string[] } {
  return checkIntegrity(db);
}
