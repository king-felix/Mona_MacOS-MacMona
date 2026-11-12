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
 * Restore one verified snapshot. The caller must name the schema version it was
 * told the snapshot holds; a mismatch is a refusal, so a stale screen cannot
 * restore a snapshot it never inspected.
 */
export async function restoreSnapshotForBuild(
  paths: RecoveryPaths,
  request: { snapshotPath: string; expectedSchemaVersion: number },
): Promise<RecoveryRestoreReceipt> {
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

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let replacedPath: string | null = null;
  if (existsSync(paths.database)) {
    replacedPath = `${paths.database}.replaced-${stamp}`;
    renameSync(paths.database, replacedPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${paths.database}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${replacedPath}${suffix}`);
    }
  }
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
        {
          version: restoredVersion,
          expected: target.schemaVersion,
        },
      );
    }
    assertIntegrity(restored, "restored snapshot");
  } finally {
    restored.close();
  }

  // An older snapshot is migrated forward with the normal path, which takes its
  // own pre-migration snapshot and journal. One deterministic outcome, and the
  // evidence for the second migration is kept too.
  const migratedFrom = restoredVersion;
  if (restoredVersion < CURRENT_SCHEMA_VERSION) {
    // The same migration implementation the launch path uses: it takes its own
    // pre-migration snapshot and writes its own journal, and a failure there
    // restores the snapshot it just took rather than leaving a half-migrated DB.
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
        {
          version,
          expected: CURRENT_SCHEMA_VERSION,
        },
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
    replacedPath,
    integrity: "ok",
    note:
      migratedFrom < CURRENT_SCHEMA_VERSION
        ? `The snapshot was at v${migratedFrom} and was migrated to v${CURRENT_SCHEMA_VERSION}. The previous database was moved aside, not deleted.`
        : "The previous database was moved aside, not deleted. Launch Mona again to open the restored snapshot.",
  };
}
