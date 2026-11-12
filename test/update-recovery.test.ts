import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/main/state/store";
import {
  inspectRecovery,
  listSnapshots,
  restoreSnapshotWithoutStore,
  selectSnapshotForRestore,
  type RecoveryPaths,
} from "../src/main/state/recovery";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../src/main/state/schema";
import { StateError } from "../src/main/state/errors";
import { migrateDatabase } from "../src/main/state/migrations";
import { openTestStore, tempDir } from "./helpers/state";

/**
 * Recovery is what protects a person from an app rollback: an older build must
 * refuse a newer schema, and the only way back is a snapshot it can verify.
 *
 * These tests build real databases at real schema versions — the "newer app" is
 * a database whose `user_version` is beyond this build, which is exactly what a
 * newer Mona leaves behind.
 */

function paths(dir: string): RecoveryPaths {
  return {
    database: join(dir, "state", "mona.sqlite"),
    backupsDir: join(dir, "backups"),
    supportDir: dir,
  };
}

/** A database written by a hypothetical future build. */
async function writeFutureDatabase(dir: string, futureVersion: number): Promise<void> {
  const dbPath = join(dir, "state", "mona.sqlite");
  mkdirSync(join(dir, "state"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE future_only (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  db.exec(`PRAGMA user_version = ${futureVersion}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
}

describe("state recovery", () => {
  it("reports a newer schema as a refusal, never as something to open anyway", async () => {
    const dir = tempDir("mona-recovery-");
    const future = CURRENT_SCHEMA_VERSION + 3;
    await writeFutureDatabase(dir, future);

    const view = inspectRecovery(paths(dir));
    expect(view.state).toBe("newer_schema");
    expect(view.databaseSchemaVersion).toBe(future);
    expect(view.buildSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(view.problem?.code).toBe("UNSUPPORTED_SCHEMA");
    expect(view.problem?.message).toContain("newer Mona");
    expect(view.canRestoreSnapshot).toBe(false);
  });

  it("refuses to open that newer database through the store either", async () => {
    const dir = tempDir("mona-recovery-");
    const future = CURRENT_SCHEMA_VERSION + 2;
    await writeFutureDatabase(dir, future);
    await expect(
      StateStore.open({
        dbPath: join(dir, "state", "mona.sqlite"),
        backupDir: join(dir, "backups"),
        artifactRoot: join(dir, "artifacts"),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    // The database and its version are untouched by the refusal.
    expect(inspectRecovery(paths(dir)).databaseSchemaVersion).toBe(future);
  });

  it("lists verified snapshots and restores only one this build can open", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    const snapshot = await store.store.backupForUpdate("0.2.0");
    await store.store.close();

    const listed = listSnapshots(join(dir, "backups"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(listed[0]?.integrity).toBe("ok");
    expect(listed[0]?.appliesToThisBuild).toBe(true);
    expect(listed[0]?.sha256).toBe(snapshot.sha256);

    // Replace the live database with something unreadable, then restore.
    const database = join(dir, "state", "mona.sqlite");
    const recovery = inspectRecovery(paths(dir));
    expect(recovery.canRestoreSnapshot).toBe(true);

    const receipt = await restoreSnapshotWithoutStore(paths(dir), {
      snapshotPath: listed[0]?.path ?? "",
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(receipt.restored).toBe(true);
    expect(receipt.integrity).toBe("ok");
    expect(receipt.replacedPath).not.toBeNull();
    expect(existsSync(receipt.replacedPath ?? "")).toBe(true);
    expect(existsSync(database)).toBe(true);

    // The restored database opens and reports the right schema.
    await expect(
      StateStore.open({
        dbPath: database,
        backupDir: join(dir, "backups"),
        artifactRoot: join(dir, "artifacts"),
      }),
    ).resolves.toBeDefined();
  });

  it("refuses a snapshot whose schema the user was not told about", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    const snapshot = await store.store.backupForUpdate("0.2.0");
    await store.store.close();
    await expect(
      restoreSnapshotWithoutStore(paths(dir), {
        snapshotPath: snapshot.path,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION + 1,
      }),
    ).rejects.toThrow(/schema version changed/);
  });

  it("refuses a path outside the backup directory", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    await store.store.close();
    const outsider = join(dir, "elsewhere.sqlite");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(dir, "state", "mona.sqlite"), outsider);
    await expect(
      restoreSnapshotWithoutStore(paths(dir), {
        snapshotPath: outsider,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      }),
    ).rejects.toThrow(/not in Mona's backup directory/);
  });

  it("reports a failed migration from its journal and offers the pre-migration snapshot", async () => {
    const dir = tempDir("mona-recovery-");
    const dbPath = join(dir, "state", "mona.sqlite");
    mkdirSync(join(dir, "state"), { recursive: true });
    // Migrate to v1 only, so a v2 target is a genuine pending migration.
    await migrateDatabase({
      dbPath,
      backupDir: join(dir, "backups"),
      migrations: [MIGRATIONS[0]!],
    });
    const closing = await migrateDatabase({
      dbPath,
      backupDir: join(dir, "backups"),
      migrations: [MIGRATIONS[0]!],
    });
    closing.db.close();

    // A migration that fails after taking its snapshot.
    const failing = [
      ...MIGRATIONS.slice(0, 2),
      { ...MIGRATIONS[1]!, version: 2, sql: "CREATE TABLE broken (" },
    ];
    await expect(
      migrateDatabase({ dbPath, backupDir: join(dir, "backups"), migrations: failing }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    const view = inspectRecovery({
      database: dbPath,
      backupsDir: join(dir, "backups"),
      supportDir: dir,
    });
    expect(view.journal).not.toBeNull();
    expect(view.journal?.state === "failed" || view.journal?.state === "restored").toBe(true);
    expect(view.canRestoreSnapshot).toBe(true);
    const restorable = view.snapshots.filter((snapshot) => snapshot.appliesToThisBuild);
    expect(restorable).toHaveLength(1);
    expect(restorable[0]?.schemaVersion).toBe(1);
    // The journal and the failed evidence are kept, not cleaned up.
    expect(readdirSync(join(dir, "backups")).some((name) => name.endsWith(".json"))).toBe(true);
  });

  it("reports an unreadable database and still lists snapshots", async () => {
    const dir = tempDir("mona-recovery-");
    mkdirSync(join(dir, "state"), { recursive: true });
    mkdirSync(join(dir, "backups"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "state", "mona.sqlite"), "not a database at all", "utf8");

    const view = inspectRecovery(paths(dir));
    expect(view.state).toBe("unreadable");
    expect(view.databaseSchemaVersion).toBeNull();
    expect(view.problem?.code).toBe("CORRUPT_DATABASE");
    expect(view.canRestoreSnapshot).toBe(false);
    expect(view.note).toContain("moved aside");
  });

  it("refuses to swap the file under an open store", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    const snapshot = await store.store.backupForUpdate("0.2.0");
    // A live store holds the only correct handle; restoreFrom is the only
    // writer that can swap the file safely. The startup path must refuse.
    await expect(
      restoreSnapshotWithoutStore(
        paths(dir),
        { snapshotPath: snapshot.path, expectedSchemaVersion: CURRENT_SCHEMA_VERSION },
        { storeOpen: true },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await store.store.listProjects({})).toEqual([]);
    // The store is still healthy and writable.
    await store.store.putSettings("app:theme", { name: "daybreak" });
    expect((await store.store.getSettings("app:theme"))?.value).toEqual({ name: "daybreak" });
    await store.store.close();
  });

  it("puts the previous database back when the snapshot cannot be restored", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    const workspace = join(dir, "ws");
    mkdirSync(workspace, { recursive: true });
    const project = await store.store.createProject({ name: "Original work", rootPath: workspace });
    await store.store.close();

    // A snapshot this build "can open" by version and integrity, but whose
    // migration must fail: it records a schema version this build never wrote.
    const poisoned = join(dir, "backups", "pre-update-poisoned-2026-11-12T00-00-00-000Z.sqlite");
    await migrateDatabase({
      dbPath: poisoned,
      backupDir: join(dir, "poison-backups"),
      migrations: MIGRATIONS.slice(0, CURRENT_SCHEMA_VERSION - 1),
    });
    const db = new DatabaseSync(poisoned);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(99, "from-the-future", "0".repeat(64), "2026-11-12T00:00:00.000Z");
    db.close();

    const before = listSnapshots(join(dir, "backups")).find((entry) => entry.path === poisoned);
    expect(before?.appliesToThisBuild).toBe(true);

    const error = await restoreSnapshotWithoutStore(paths(dir), {
      snapshotPath: poisoned,
      expectedSchemaVersion: before?.schemaVersion ?? 0,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StateError);
    expect((error as { code: string }).code).toBe("MAINTENANCE_FAILED");
    expect((error as { details: Record<string, unknown> }).details.rollback).toBe("ok");
    expect((error as { message: string }).message).toContain("put back");

    // The original data is intact and readable, not stranded in a `.replaced-*`.
    const reopened = await StateStore.open({
      dbPath: join(dir, "state", "mona.sqlite"),
      backupDir: join(dir, "backups"),
      artifactRoot: join(dir, "artifacts"),
    });
    const projects = await reopened.listProjects({});
    expect(projects.map((entry) => entry.name)).toEqual(["Original work"]);
    expect(projects[0]?.id).toBe(project.id);
    await reopened.close();
  });

  it("verifies before mutating: a newer snapshot leaves the database byte-identical", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    await store.store.backupForUpdate("0.2.0");
    await store.store.close();

    const futurePath = join(dir, "backups", "pre-update-future-2026-11-12T00-00-00-000Z.sqlite");
    copyFileSync(join(dir, "state", "mona.sqlite"), futurePath);
    const future = new DatabaseSync(futurePath);
    future.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 4}`);
    future.close();

    const database = join(dir, "state", "mona.sqlite");
    const before = readFileSync(database);
    await expect(
      restoreSnapshotWithoutStore(paths(dir), {
        snapshotPath: futurePath,
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION + 4,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    // Nothing was moved aside, nothing was replaced.
    expect(readFileSync(database).equals(before)).toBe(true);
    expect(readdirSync(join(dir, "state")).filter((name) => name.includes("replaced"))).toEqual([]);
  });

  it("selects a snapshot without touching the filesystem", async () => {
    const store = await openTestStore();
    const dir = store.dir;
    const snapshot = await store.store.backupForUpdate("0.2.0");
    await store.store.close();
    const database = join(dir, "state", "mona.sqlite");
    const before = readFileSync(database);
    const selected = selectSnapshotForRestore(paths(dir), {
      snapshotPath: snapshot.path,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(selected.path).toBe(snapshot.path);
    expect(readFileSync(database).equals(before)).toBe(true);
  });
});
