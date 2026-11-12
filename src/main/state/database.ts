import { chmodSync, existsSync, mkdirSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { StateError } from "./errors";

/**
 * SQLite is provided by Electron 45's embedded Node (24.22.2) as `node:sqlite`.
 * Verified on this host: DatabaseSync, prepared statements, custom functions,
 * `PRAGMA journal_mode=WAL`, and the module-level online `backup()` all work in
 * both the host Node 26 and the Electron runtime. No native module is pinned.
 */
export interface OpenDatabaseOptions {
  path: string;
  readonly?: boolean;
  busyTimeoutMs?: number;
  /** Test hook: lets a test force SQLITE_FULL through max_page_count. */
  maxPageCount?: number;
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A directory on a filesystem without POSIX modes is reported by the
    // multi-user check rather than silently treated as private.
  }
}

export function secureFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Missing file or non-POSIX filesystem; callers that require a mode test it.
  }
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const memory = options.path === ":memory:";
  if (!memory) {
    ensurePrivateDir(dirname(options.path));
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.path, {
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (error) {
    throw new StateError("CORRUPT_DATABASE", `cannot open ${options.path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!options.readonly) {
    try {
      if (!memory) db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
      // Treat a corrupt schema as an error rather than running it defensively.
      db.exec("PRAGMA trusted_schema = OFF");
      if (options.maxPageCount !== undefined) {
        db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(options.maxPageCount))}`);
      }
    } catch (error) {
      db.close();
      throw mapSqliteError(error, "configuring the database");
    }
    if (!memory) {
      secureFile(options.path);
      secureFile(`${options.path}-wal`);
      secureFile(`${options.path}-shm`);
    }
  }
  return db;
}

export async function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
  ensurePrivateDir(dirname(destination));
  try {
    await sqliteBackup(db, destination);
    secureFile(destination);
  } catch (error) {
    throw mapSqliteError(error, "snapshotting the database");
  }
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function writeUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${Math.floor(version)}`);
}

export interface IntegrityReport {
  ok: boolean;
  problems: string[];
}

export function checkIntegrity(db: DatabaseSync): IntegrityReport {
  const problems: string[] = [];
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const value = Object.values(row)[0];
      if (String(value).toLowerCase() !== "ok") problems.push(`integrity: ${String(value)}`);
    }
    const foreign = db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
    for (const row of foreign) problems.push(`foreign key: ${JSON.stringify(row)}`);
  } catch (error) {
    problems.push(
      `integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: problems.length === 0, problems };
}

export function assertIntegrity(db: DatabaseSync, context: string): void {
  const report = checkIntegrity(db);
  if (!report.ok) {
    throw new StateError("CORRUPT_DATABASE", `${context}: database failed validation`, {
      problems: report.problems.slice(0, 10),
    });
  }
}

/**
 * One transaction per write. `BEGIN IMMEDIATE` takes the write lock up front so
 * a failure cannot leave a half-applied multi-statement change.
 */
export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = work();
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled back (for example on a fatal I/O error).
    }
    throw mapSqliteError(error, "writing the transaction");
  }
  try {
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore: the commit failure is the actionable error.
    }
    throw mapSqliteError(error, "committing the transaction");
  }
  return result;
}

export function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

export interface DiskProbe {
  freeBytes(path: string): number;
}

/** Filesystem headroom, measured at the database/artifact location. */
export const nativeDiskProbe: DiskProbe = {
  freeBytes(path: string): number {
    const stats = statfsSync(existsSync(path) ? path : dirname(path));
    return stats.bavail * stats.bsize;
  },
};

export function mapSqliteError(error: unknown, context: string): Error {
  if (error instanceof StateError) return error;
  const candidate = error as { code?: string; errcode?: number; message?: string };
  const message = candidate?.message ?? String(error);
  const errcode = Number(candidate?.errcode ?? 0);
  if (errcode === 13 || /database or disk is full|SQLITE_FULL/i.test(message)) {
    return new StateError("DISK_FULL", `${context}: the disk is full`, {
      sqlite_code: errcode,
      cause: message,
    });
  }
  return new StateError("CORRUPT_DATABASE", `${context}: ${message}`, {
    sqlite_code: errcode || null,
    cause: message,
  });
}
