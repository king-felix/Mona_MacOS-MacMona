import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MaintenanceBarrier,
  MIGRATIONS,
  migrateDatabase,
  openDatabase,
  readMigrationJournal,
  withTransaction,
  type Migration,
} from "../src/main/state";
import { StateError } from "../src/main/state/errors";
import { delay, makeClock, openTestStore, tempDir } from "./helpers/state";

const CRASH_HELPER = join(process.cwd(), "test", "helpers", "crash-writer.mjs");

function runCrash(
  dbPath: string,
  mode: "before" | "during" | "after",
  projectId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_HELPER, dbPath, mode, projectId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (/ready|committed/.test(output) && !child.killed) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL" || code === 0) resolve();
      else reject(new Error(`crash helper failed: code=${code} signal=${signal} ${errors}`));
    });
  });
}

describe("database + migrations", () => {
  it("creates the full schema and records every migration", async () => {
    const { store, dbPath, dir } = await openTestStore();
    const db = openDatabase({ path: dbPath, readonly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: MIGRATIONS[MIGRATIONS.length - 1]?.version,
      });
      const versions = (
        db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version);
      expect(versions).toEqual(MIGRATIONS.map((migration) => migration.version));
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      for (const table of [
        "projects",
        "project_paths",
        "runtime_bindings",
        "threads",
        "turns",
        "submissions",
        "tasks",
        "task_dependencies",
        "requirement_evidence",
        "attempts",
        "decisions",
        "event_cursors",
        "usage_records",
        "capability_snapshots",
        "settings_versions",
        "artifacts",
        "drafts",
      ]) {
        expect(tables.has(table), table).toBe(true);
      }
      // Runtime bindings must never have a token column.
      const bindingColumns = (
        db.prepare("PRAGMA table_info(runtime_bindings)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(bindingColumns).not.toContain("token");
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      db.close();
      await store.close();
    }
  });

  it("upgrades v2 tasks through the v3/v4 schema without dropping dependencies or evidence", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "mona.sqlite");
    const v2 = await migrateDatabase({
      dbPath,
      migrations: MIGRATIONS.slice(0, 2),
      now: makeClock().now,
    });
    v2.db
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_path, fs_dev, fs_ino, repository_kind, " +
          "repository_root, worktree_name, archived, pinned, removed_at, created_at, updated_at, revision) " +
          "VALUES ('prj_upgrade00000001', 'Upgrade', '/tmp/upgrade', '/tmp/upgrade', 1, 2, 'none', NULL, NULL, 0, 0, NULL, " +
          "'2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1)",
      )
      .run();
    for (const [id, status, title] of [
      ["tsk_aaaaaaaaaaaaaaaa", "paused", "Paused task"],
      ["tsk_bbbbbbbbbbbbbbbb", "failed", "Failed task"],
    ] as const) {
      v2.db
        .prepare(
          "INSERT INTO tasks (id, project_id, title, prompt, status, created_at, updated_at, revision) " +
            "VALUES (?, 'prj_upgrade00000001', ?, 'prompt', ?, '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1)",
        )
        .run(id, title, status);
    }
    v2.db
      .prepare(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES ('tsk_bbbbbbbbbbbbbbbb', 'tsk_aaaaaaaaaaaaaaaa', '2026-11-11T00:00:00.000Z')",
      )
      .run();
    v2.db
      .prepare(
        "INSERT INTO requirement_evidence (id, project_id, task_id, requirement_id, path, digest, note, created_at) " +
          "VALUES ('evd_upgrade00001', 'prj_upgrade00000001', 'tsk_aaaaaaaaaaaaaaaa', 'MONA-009', 'docs/evidence/x.md', NULL, NULL, '2026-11-11T00:00:00.000Z')",
      )
      .run();
    v2.db.close();

    const v3 = await migrateDatabase({ dbPath, migrations: MIGRATIONS, now: makeClock().now });
    try {
      expect(v3.db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: MIGRATIONS[MIGRATIONS.length - 1]?.version,
      });
      const tasks = v3.db
        .prepare("SELECT id, status, execution_owner FROM tasks ORDER BY id")
        .all() as Array<{ id: string; status: string; execution_owner: string }>;
      expect(tasks).toEqual([
        { id: "tsk_aaaaaaaaaaaaaaaa", status: "interrupted", execution_owner: "mona_queue" },
        { id: "tsk_bbbbbbbbbbbbbbbb", status: "interrupted", execution_owner: "mona_queue" },
      ]);
      expect(
        v3.db
          .prepare(
            "SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = 'tsk_bbbbbbbbbbbbbbbb'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
      expect(
        v3.db
          .prepare(
            "SELECT COUNT(*) AS n FROM requirement_evidence WHERE task_id = 'tsk_aaaaaaaaaaaaaaaa'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
      expect(
        v3.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'task_acceptance'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
      expect(
        v3.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'problems'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
      expect(
        v3.db
          .prepare(
            "SELECT COUNT(*) AS n FROM pragma_table_info('tasks') WHERE name = 'active_turn_id'",
          )
          .get(),
      ).toMatchObject({ n: 1 });
      expect(v3.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      v3.db.close();
    }
  });

  it("refuses a database from a newer schema", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "mona.sqlite");
    const outcome = await migrateDatabase({ dbPath, migrations: MIGRATIONS, now: makeClock().now });
    outcome.db.close();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();
    await expect(
      migrateDatabase({ dbPath, migrations: MIGRATIONS, now: makeClock().now }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });

  it("rejects a migration whose checksum changed after it was applied", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "mona.sqlite");
    const outcome = await migrateDatabase({
      dbPath,
      migrations: MIGRATIONS.slice(0, 1),
      now: makeClock().now,
    });
    outcome.db
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    outcome.db.close();
    await expect(
      migrateDatabase({ dbPath, migrations: MIGRATIONS, now: makeClock().now }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });

  it("restores the pre-migration snapshot when a migration fails", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "mona.sqlite");
    const v1 = await migrateDatabase({
      dbPath,
      migrations: MIGRATIONS.slice(0, 1),
      now: makeClock().now,
      backupDir: join(dir, "backups"),
    });
    v1.db
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_path, fs_dev, fs_ino, repository_kind, " +
          "repository_root, worktree_name, archived, pinned, removed_at, created_at, updated_at, revision) " +
          "VALUES ('prj_aaaaaaaaaaaaaaaa', 'Kept', '/tmp/kept', '/tmp/kept', 1, 2, 'none', NULL, NULL, 0, 0, NULL, " +
          "'2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1)",
      )
      .run();
    v1.db
      .prepare(
        "INSERT INTO project_paths (project_id, path, canonical_path, fs_dev, fs_ino, active, recorded_at) " +
          "VALUES ('prj_aaaaaaaaaaaaaaaa', '/tmp/kept', '/tmp/kept', 1, 2, 1, '2026-11-11T00:00:00.000Z')",
      )
      .run();
    v1.db.close();

    const bad: Migration = {
      version: 5,
      name: "broken",
      sql: "CREATE TABLE collateral (id INTEGER); INSERT INTO missing_table (id) VALUES (1);",
    };
    let failure: StateError | null = null;
    try {
      const outcome = await migrateDatabase({
        dbPath,
        migrations: [...MIGRATIONS, bad],
        now: makeClock("2026-11-12T00:00:00.000Z").now,
        backupDir: join(dir, "backups"),
      });
      outcome.db.close();
    } catch (error) {
      failure = error as StateError;
    }
    expect(failure).toBeInstanceOf(StateError);
    expect(failure?.code).toBe("MIGRATION_FAILED");
    const details = failure?.details as {
      journal_path: string;
      backup_path: string;
      restored: boolean;
    };
    expect(details.restored).toBe(true);
    expect(existsSync(details.backup_path)).toBe(true);
    const journal = readMigrationJournal(details.journal_path);
    expect(journal?.state).toBe("restored");
    expect(journal?.error?.message).toBeTruthy();
    expect(readdirSync(dir).some((name) => name.includes(".failed-"))).toBe(true);

    // The old database is intact and still at v1.
    const restored = openDatabase({ path: dbPath, readonly: true });
    try {
      expect(restored.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      const row = restored
        .prepare("SELECT name FROM projects WHERE id = 'prj_aaaaaaaaaaaaaaaa'")
        .get() as {
        name: string;
      };
      expect(row.name).toBe("Kept");
    } finally {
      restored.close();
    }
  });

  it("restores when post-commit validation finds a damaged schema", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "mona.sqlite");
    const v2 = await migrateDatabase({
      dbPath,
      migrations: MIGRATIONS,
      now: makeClock().now,
      backupDir: join(dir, "backups"),
    });
    v2.db.close();

    const destructive: Migration = {
      version: (MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0) + 1,
      name: "drop-drafts",
      sql: "DROP TABLE drafts;",
    };
    let failure: StateError | null = null;
    try {
      const outcome = await migrateDatabase({
        dbPath,
        migrations: [...MIGRATIONS, destructive],
        now: makeClock("2026-11-13T00:00:00.000Z").now,
        backupDir: join(dir, "backups"),
      });
      outcome.db.close();
    } catch (error) {
      failure = error as StateError;
    }
    expect(failure?.code).toBe("MIGRATION_FAILED");
    const restored = openDatabase({ path: dbPath, readonly: true });
    try {
      expect(restored.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: MIGRATIONS[MIGRATIONS.length - 1]?.version,
      });
      expect(
        restored
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drafts'")
          .get(),
      ).toBeTruthy();
      expect(restored.prepare("PRAGMA integrity_check").get()).toMatchObject({
        integrity_check: "ok",
      });
    } finally {
      restored.close();
    }
  });
});

describe("crash injection", () => {
  it("survives a crash before, during, and after a transaction", async () => {
    const { store, dbPath, dir } = await openTestStore();
    const project = await store.createProject({ name: "Crash", rootPath: dir });
    await store.close();

    await runCrash(dbPath, "before", project.id);
    let reopened = await openTestStore({ dbPath, dir, artifactRoot: join(dir, "artifacts") });
    expect(await reopened.store.listTasks(project.id)).toHaveLength(0);
    expect((await reopened.store.stats()).integrity).toEqual([]);
    await reopened.store.close();

    await runCrash(dbPath, "during", project.id);
    reopened = await openTestStore({ dbPath, dir, artifactRoot: join(dir, "artifacts") });
    expect(await reopened.store.listTasks(project.id)).toHaveLength(0);
    expect((await reopened.store.stats()).integrity).toEqual([]);
    // A write still succeeds after the incomplete transaction was rolled back.
    const task = await reopened.store.createTask({
      projectId: project.id,
      title: "After crash",
      prompt: "write again",
    });
    expect(task.status).toBe("pending");
    await reopened.store.close();

    await runCrash(dbPath, "after", project.id);
    reopened = await openTestStore({ dbPath, dir, artifactRoot: join(dir, "artifacts") });
    const tasks = await reopened.store.listTasks(project.id);
    expect(tasks.map((row) => row.title)).toContain("crash after");
    expect((await reopened.store.stats()).integrity).toEqual([]);
    await reopened.store.close();
  }, 30_000);
});

describe("revisions and disk pressure", () => {
  it("rejects a stale revision write and leaves the row untouched", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "One", rootPath: dir });
    const renamed = await store.renameProject(project.id, "Two", project.revision);
    expect(renamed.revision).toBe(project.revision + 1);
    await expect(store.renameProject(project.id, "Three", project.revision)).rejects.toMatchObject({
      code: "STALE_REVISION",
      details: { actual_revision: renamed.revision },
    });
    expect((await store.getProject(project.id))?.name).toBe("Two");
    await store.close();
  });

  it("refuses a write when free space is below the reserve and never claims completion", async () => {
    let free = 8 * 1024 * 1024 * 1024;
    const { store, dir } = await openTestStore({
      diskProbe: { freeBytes: () => free },
    });
    const project = await store.createProject({ name: "Full", rootPath: dir });
    const task = await store.createTask({
      projectId: project.id,
      title: "Work",
      prompt: "do it",
      acceptance: [{ text: "the check passes", kind: "check" }],
    });
    free = 0;
    await expect(store.updateTaskStatus(task.id, "running", task.revision)).rejects.toMatchObject({
      code: "DISK_FULL",
    });
    const reread = await store.getTask(task.id);
    expect(reread?.status).toBe("pending");
    expect(reread?.revision).toBe(task.revision);
    free = 8 * 1024 * 1024 * 1024;
    const running = await store.updateTaskStatus(task.id, "running", task.revision);
    const criterion = (await store.listAcceptance(task.id))[0];
    if (!criterion) throw new Error("criterion missing");
    const satisfied = await store.satisfyAcceptance(task.id, criterion.id, running.revision, {
      by: "check",
      evidencePath: "docs/evidence/full-check.txt",
    });
    const verifying = await store.markTaskVerifying(task.id, satisfied.revision, "a".repeat(64));
    const completed = await store.completeTask(task.id, verifying.revision, {
      fingerprint: "a".repeat(64),
    });
    expect(completed.status).toBe("completed");
    await store.close();
  });

  it("maps a real SQLITE_FULL error and rolls the transaction back", () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, "full.sqlite"), maxPageCount: 24 });
    db.exec("CREATE TABLE blobs (data BLOB)");
    let failure: unknown = null;
    try {
      withTransaction(db, () => {
        const chunk = Buffer.alloc(8 * 1024);
        for (let index = 0; index < 64; index += 1) {
          db.prepare("INSERT INTO blobs (data) VALUES (?)").run(chunk);
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StateError);
    expect((failure as StateError).code).toBe("DISK_FULL");
    expect(db.prepare("SELECT COUNT(*) AS n FROM blobs").get()).toMatchObject({ n: 0 });
    db.close();
  });
});

describe("maintenance barrier", () => {
  it("blocks new work behind maintenance and drains it afterwards", async () => {
    const barrier = new MaintenanceBarrier();
    const order: string[] = [];
    let releaseWriter: (() => void) | null = null;
    const writer = barrier.run(
      "write",
      () =>
        new Promise<void>((resolve) => {
          releaseWriter = () => {
            order.push("writer");
            resolve();
          };
        }),
    );
    const maintenance = barrier.runMaintenance(async () => {
      order.push("maintenance-start");
      await delay(20);
      order.push("maintenance-end");
    });
    const later = barrier.run("write", () => {
      order.push("later");
    });
    await delay(10);
    expect(order).toEqual([]);
    releaseWriter?.();
    await Promise.all([writer, maintenance, later]);
    expect(order).toEqual(["writer", "maintenance-start", "maintenance-end", "later"]);
  });

  it("quiesces active work for a snapshot and resumes writing after it", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Quiesce", rootPath: dir });
    const order: string[] = [];
    let release: (() => void) | null = null;
    const holder = store.barrier.run(
      "read",
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("reader");
            resolve();
          };
        }),
    );
    const snapshot = store.createSnapshot("quiesce").then(() => {
      order.push("snapshot");
    });
    const write = store.renameProject(project.id, "After", project.revision).then(() => {
      order.push("write");
    });
    await delay(20);
    expect(order).toEqual([]);
    release?.();
    await Promise.all([holder, snapshot, write]);
    expect(order).toEqual(["reader", "snapshot", "write"]);
    expect((await store.getProject(project.id))?.name).toBe("After");
    await store.close();
  });
});

describe("backup and restore", () => {
  it("restores a verified snapshot and puts the previous database back on failure", async () => {
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Before", rootPath: dir });
    const snapshot = await store.createSnapshot("restore");
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    await store.renameProject(project.id, "After", project.revision);
    expect((await store.getProject(project.id))?.name).toBe("After");

    const restored = await store.restoreFrom(snapshot);
    expect(restored.restored).toBe(true);
    expect((await store.getProject(project.id))?.name).toBe("Before");

    // A corrupt snapshot must fail with a rollback, not lose local state.
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, "not a database");
    const current = await store.getProject(project.id);
    if (!current) throw new Error("project vanished");
    const afterRestore = await store.renameProject(project.id, "Still here", current.revision);
    await expect(store.restoreFrom(corrupt)).rejects.toMatchObject({ code: "MAINTENANCE_FAILED" });
    expect((await store.getProject(project.id))?.name).toBe("Still here");
    expect(afterRestore.revision).toBe(current.revision + 1);
    await store.close();
  });
});
