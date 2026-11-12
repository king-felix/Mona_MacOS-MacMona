import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  RecoveryJournalView,
  RecoveryRestoreReceipt,
  RecoverySnapshot,
  RecoveryView,
} from "../../shared/contracts/update";
import { assertIntegrity, openDatabase, readUserVersion } from "./database";
import { StateError } from "./errors";
import { migrateDatabase, readMigrationJournal } from "./migrations";
import { CURRENT_SCHEMA_VERSION } from "./schema";

/**
 * Recovery for the case where the app cannot open its state.
 *
 * Three failures are distinguished, because they need three different answers:
 *
 * - `newer_schema` — an older app was opened against a database a newer app
 *   migrated. There is no forward path; the app must not "try anyway", and the
 *   only safe restore is a verified snapshot at this build's schema version.
 * - `migration_failed` — this build's own migration failed. The journal names
 *   the pre-migration snapshot; it is the restore candidate.
 * - `unreadable` — the file is not a usable database. Snapshots are still
 *   listed so the user has a path forward.
 *
 * This module never decides to open a newer schema. It reads, it lists, and it
 * restores only when the snapshot's own `user_version` equals this build's.
 */

export interface RecoveryPaths {
  database: string;
  backupsDir: string;
  supportDir: string;
}

function schemaVersionOf(path: string): number | null {
  if (!existsSync(path)) return null;
  let db;
  try {
    db = openDatabase({ path, readonly: true });
    return readUserVersion(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed or never opened.
    }
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function timestampFromName(name: string): string | null {
  // Snapshots are named with an ISO timestamp whose separators are dashes.
  const match = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(name);
  if (!match?.[1]) return null;
  const iso = match[1].replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  return iso;
}

/** Every `.sqlite` snapshot in the backup directory, newest first. */
export function listSnapshots(
  backupsDir: string,
  options: { schemaVersion?: number; limit?: number } = {},
): RecoverySnapshot[] {
  const schemaVersion = options.schemaVersion ?? CURRENT_SCHEMA_VERSION;
  const limit = options.limit ?? 40;
  if (!existsSync(backupsDir)) return [];
  const rows: RecoverySnapshot[] = [];
  for (const name of readdirSync(backupsDir)) {
    if (!name.endsWith(".sqlite")) continue;
    const path = join(backupsDir, name);
    let size: number;
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      continue;
    }
    const found = schemaVersionOf(path);
    let integrity: RecoverySnapshot["integrity"] = "failed";
    if (found !== null) {
      let db;
      try {
        db = openDatabase({ path, readonly: true });
        assertIntegrity(db, "snapshot listing");
        integrity = "ok";
      } catch {
        integrity = "failed";
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore.
        }
      }
    }
    rows.push({
      path,
      fileName: basename(path),
      schemaVersion: found ?? -1,
      createdAt: timestampFromName(name) ?? new Date(statSync(path).mtimeMs).toISOString(),
      sizeBytes: size,
      sha256: sha256File(path),
      integrity,
      // A snapshot is restorable when this build can read it and migrate it
      // forward. A newer snapshot is not: an older app cannot open a schema it
      // does not know, and pretending otherwise would corrupt real work.
      appliesToThisBuild:
        found !== null && found >= 1 && found <= schemaVersion && integrity === "ok",
    });
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return rows.slice(0, limit);
}

function findJournal(backupsDir: string): RecoveryJournalView | null {
  if (!existsSync(backupsDir)) return null;
  const candidates = readdirSync(backupsDir)
    .filter((name) => name.startsWith("migration-journal-") && name.endsWith(".json"))
    .map((name) => join(backupsDir, name));
  if (candidates.length === 0) return null;
  candidates.sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) return null;
  const journal = readMigrationJournal(latest);
  if (!journal) return null;
  return {
    path: latest,
    fromVersion: journal.from_version,
    toVersion: journal.to_version,
    state: journal.state,
    backupPath: journal.backup_path,
    error: journal.error?.message ?? null,
    updatedAt: journal.updated_at,
  };
}

export function inspectRecovery(paths: RecoveryPaths): RecoveryView {
  const databaseVersion = schemaVersionOf(paths.database);
  const journal = findJournal(paths.backupsDir);
  const snapshots = listSnapshots(paths.backupsDir);

  let state: RecoveryView["state"] = "ok";
  let problem: RecoveryView["problem"] = null;

  if (!existsSync(paths.database)) {
    state = "unreadable";
    problem = {
      code: "NOT_FOUND",
      message: "There is no state database for this user yet.",
    };
  } else if (databaseVersion === null) {
    state = "unreadable";
    problem = {
      code: "CORRUPT_DATABASE",
      message:
        "The state database could not be read. Recover from a verified snapshot or a backup.",
    };
  } else if (databaseVersion > CURRENT_SCHEMA_VERSION) {
    state = "newer_schema";
    problem = {
      code: "UNSUPPORTED_SCHEMA",
      message:
        `This Mac's state was written by a newer Mona (schema v${databaseVersion}); ` +
        `this build understands v${CURRENT_SCHEMA_VERSION}. An older app cannot migrate a newer database. ` +
        "Install the newer Mona again, or restore a snapshot this build can open.",
    };
  } else if (journal && (journal.state === "failed" || journal.state === "started")) {
    state = "migration_failed";
    problem = {
      code: "MIGRATION_FAILED",
      message:
        journal.error ??
        `The migration to v${journal.toVersion} did not finish. Its snapshot is listed below.`,
    };
  }

  const matching = snapshots.filter((snapshot) => snapshot.appliesToThisBuild);
  return {
    buildSchemaVersion: CURRENT_SCHEMA_VERSION,
    databaseSchemaVersion: databaseVersion,
    state,
    problem,
    snapshots,
    journal,
    support: {
      supportPath: paths.supportDir,
      backupsPath: paths.backupsDir,
      reportPath: null,
      instruction:
        state === "ok"
          ? "No action needed. Snapshots are listed so a failed migration or a rollback has a verified target."
          : "Choose a snapshot this build can open, or keep the evidence and install the build that wrote this state. Mona never opens a newer schema.",
    },
    canRestoreSnapshot: matching.length > 0,
    note:
      state === "newer_schema"
        ? "App rollback and database rollback are different. Reinstalling the newer app keeps your current data; restoring an older snapshot discards everything recorded after it."
        : "A restore replaces the whole database with the snapshot. The current file is moved aside, never deleted.",
  };
}

/**
 * Verify that a snapshot may be restored, without touching anything.
 *
 * Every restore path calls this first, so the expensive and destructive part
 * never runs against a snapshot that was not listed, was not the one the user
 * saw, is newer than this build, or failed its integrity check.
 */
export function selectSnapshotForRestore(
  paths: RecoveryPaths,
  request: { snapshotPath: string; expectedSchemaVersion: number },
): RecoverySnapshot {
  const snapshots = listSnapshots(paths.backupsDir, { limit: 500 });
  const target = snapshots.find((snapshot) => snapshot.path === request.snapshotPath);
  if (!target) {
    throw new StateError("NOT_FOUND", "that snapshot is not in Mona's backup directory", {
      snapshot_path: request.snapshotPath,
    });
  }
  if (target.schemaVersion !== request.expectedSchemaVersion) {
    throw new StateError("CONFLICT", "the snapshot's schema version changed since it was listed", {
      expected: request.expectedSchemaVersion,
      actual: target.schemaVersion,
    });
  }
  if (target.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new StateError(
      "UNSUPPORTED_SCHEMA",
      `this build cannot open a v${target.schemaVersion} snapshot; it understands up to v${CURRENT_SCHEMA_VERSION}`,
      { snapshot_schema: target.schemaVersion, build_schema: CURRENT_SCHEMA_VERSION },
    );
  }
  if (target.integrity !== "ok") {
    throw new StateError("CORRUPT_DATABASE", "the snapshot failed its integrity check", {
      snapshot_path: target.path,
    });
  }
  return target;
}

/**
 * Restore a verified snapshot **when no store is open** — the startup recovery
 * path, where the application could not open its database at all.
 *
 * When a store *is* open, its `restoreFrom` is the only correct writer: it holds
 * the maintenance barrier, closes its connection before the swap, re-opens
 * afterwards, and rolls back on failure. Swapping the file under a live handle
 * would leave that handle writing into the renamed inode, so this function
 * refuses to run in that case rather than producing silent data loss.
 *
 * The swap itself is failure-safe: the current database is moved aside first,
 * and any failure after that point puts it back before the error is raised.
 */
export async function restoreSnapshotWithoutStore(
  paths: RecoveryPaths,
  request: { snapshotPath: string; expectedSchemaVersion: number },
  options: { storeOpen?: boolean } = {},
): Promise<RecoveryRestoreReceipt> {
  if (options.storeOpen === true) {
    throw new StateError(
      "CONFLICT",
      "a state store is open; the store must perform the restore under its maintenance barrier",
      { snapshot_path: request.snapshotPath },
    );
  }
  const target = selectSnapshotForRestore(paths, request);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const replacedPath = `${paths.database}.replaced-${stamp}`;
  let moved = false;
  if (existsSync(paths.database)) {
    renameSync(paths.database, replacedPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${paths.database}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${replacedPath}${suffix}`);
    }
    moved = true;
  }

  try {
    copyFileSync(target.path, paths.database);
    chmodSync(paths.database, 0o600);

    const restored = openDatabase({ path: paths.database, readonly: true });
    let restoredVersion: number;
    try {
      restoredVersion = readUserVersion(restored);
      if (restoredVersion !== target.schemaVersion) {
        throw new StateError(
          "MIGRATION_FAILED",
          "the restored database has the wrong schema version",
          { version: restoredVersion, expected: target.schemaVersion },
        );
      }
      assertIntegrity(restored, "restored snapshot");
    } finally {
      restored.close();
    }

    // An older snapshot is migrated forward with the normal path, which takes
    // its own pre-migration snapshot and journal, and restores that snapshot if
    // the migration fails.
    const migratedFrom = restoredVersion;
    if (restoredVersion < CURRENT_SCHEMA_VERSION) {
      const outcome = await migrateDatabase({
        dbPath: paths.database,
        backupDir: join(paths.backupsDir),
      });
      outcome.db.close();
    }

    const final = openDatabase({ path: paths.database, readonly: true });
    try {
      const version = readUserVersion(final);
      if (version !== CURRENT_SCHEMA_VERSION) {
        throw new StateError(
          "MIGRATION_FAILED",
          "the restored database did not reach this build's schema",
          { version, expected: CURRENT_SCHEMA_VERSION },
        );
      }
      assertIntegrity(final, "restored and migrated database");
    } finally {
      final.close();
    }

    return {
      restored: true,
      fromVersion: migratedFrom,
      toVersion: CURRENT_SCHEMA_VERSION,
      snapshotPath: target.path,
      replacedPath: moved ? replacedPath : null,
      integrity: "ok",
      note:
        migratedFrom < CURRENT_SCHEMA_VERSION
          ? `The snapshot was at v${migratedFrom} and was migrated to v${CURRENT_SCHEMA_VERSION}. The previous database was moved aside, not deleted.`
          : "The previous database was moved aside, not deleted. Launch Mona again to open the restored snapshot.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rollback = moved ? rollbackTo(replacedPath, paths.database, stamp) : null;
    throw new StateError(
      "MAINTENANCE_FAILED",
      rollback === "ok"
        ? "the snapshot could not be restored; the previous database was put back"
        : "the snapshot could not be restored and the previous database could not be put back",
      {
        snapshot_path: target.path,
        replaced_path: moved ? replacedPath : null,
        rollback,
        cause: message,
      },
    );
  }
}

/** Put the pre-restore database back. Returns an honest outcome, never a guess. */
function rollbackTo(replacedPath: string, database: string, stamp: string): "ok" | "failed" {
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${database}${suffix}`;
      if (existsSync(target)) renameSync(target, `${target}.failed-restore-${stamp}${suffix}`);
    }
    copyFileSync(replacedPath, database);
    chmodSync(database, 0o600);
    const restored = openDatabase({ path: database, readonly: true });
    try {
      assertIntegrity(restored, "restored pre-restore database");
    } finally {
      restored.close();
    }
    return "ok";
  } catch {
    return "failed";
  }
}
