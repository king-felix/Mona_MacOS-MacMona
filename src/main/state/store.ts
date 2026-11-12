import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ProjectId,
  SubmissionState,
  TaskId,
  type SubmissionStatus,
  type TaskStatus,
} from "../../shared/contracts";
import {
  ArtifactFileStore,
  type ArtifactFileStoreOptions,
  type WrittenArtifact,
} from "./artifact-files";
import { writeFileDurable, writeJsonDurable } from "./atomic-json";
import { MaintenanceBarrier } from "./barrier";
import {
  assertIntegrity,
  backupDatabase,
  checkIntegrity,
  ensurePrivateDir,
  nativeDiskProbe,
  openDatabase,
  secureFile,
  withTransaction,
  type DiskProbe,
} from "./database";
import { StateError } from "./errors";
import { identifyPath, type PathIdentity, type RepositoryKind } from "./identity";
import { migrateDatabase } from "./migrations";
import {
  buildBundle,
  bundleToFileText,
  canonicalJson,
  verifyBundle,
  type PortablePayload,
  type ProjectBundle,
} from "./portable";

export interface StoredProject {
  id: ProjectId;
  name: string;
  rootPath: string;
  canonicalPath: string;
  fsDev: number;
  fsIno: number;
  repositoryKind: RepositoryKind;
  repositoryRoot: string | null;
  worktreeName: string | null;
  accent: string | null;
  monogram: string | null;
  archived: boolean;
  pinned: boolean;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface StoredTask {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type BindingState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface RuntimeBinding {
  projectId: ProjectId;
  workspace: string;
  canonicalWorkspace: string;
  executable: string;
  engineVersion: string | null;
  engineCommit: string | null;
  port: number | null;
  state: BindingState;
  updatedAt: string;
}

export interface StoredThread {
  id: string;
  projectId: ProjectId;
  engineThreadId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTurn {
  id: string;
  threadId: string;
  status: string;
  provider: string | null;
  model: string | null;
  permissionPosture: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface StoredEvent {
  threadId: string;
  seq: number;
  kind: string;
  payload: unknown;
  timestamp: string;
  recordedAt: string;
}

export interface UsageRecord {
  id: string;
  projectId: ProjectId | null;
  threadId: string | null;
  turnId: string | null;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costComplete: boolean;
  capturedAt: string;
}

export interface UsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costComplete: boolean;
  observed: boolean;
}

export interface StoredDecision {
  id: string;
  projectId: ProjectId;
  title: string;
  body: string;
  createdAt: string;
}

export interface RequirementEvidenceRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  requirementId: string;
  path: string;
  digest: string | null;
  note: string | null;
  createdAt: string;
}

export interface AttemptRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  problemId: string;
  requirement: string;
  symptom: string | null;
  hypothesis: string;
  action: string;
  observed: string;
  materialProgress: boolean;
  evidence: string[];
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  digest: string;
  relPath: string;
  sizeBytes: number;
  mediaType: string;
  source: string;
  retentionClass: "temporary" | "diagnostic" | "evidence";
  createdAt: string;
}

export interface StoredSettings {
  scope: string;
  version: number;
  value: unknown;
  updatedAt: string;
}

export interface RetentionPolicy {
  temporaryDays?: number;
  diagnosticDays?: number;
  includeProtected?: boolean;
  now?: Date;
}

export interface RetentionPlan {
  candidates: ArtifactRecord[];
  protected: Array<{ artifact: ArtifactRecord; reason: string }>;
  warnings: string[];
}

export interface RetentionResult {
  deleted: ArtifactRecord[];
  protected: Array<{ artifact: ArtifactRecord; reason: string }>;
  freedBytes: number;
  warnings: string[];
}

export interface ImportOptions {
  /** Deliberate rebinding for a moved folder or a new machine. */
  rootPath?: string;
  mode?: "create" | "replace";
  expectedRevision?: number;
}

export interface ImportResult {
  project: StoredProject;
  mode: "create" | "replace";
  imported: {
    tasks: number;
    dependencies: number;
    evidence: number;
    attempts: number;
    decisions: number;
    threads: number;
    turns: number;
    drafts: number;
    settings: number;
    submissions: number;
  };
  missingArtifacts: string[];
}

export interface StateStoreOptions {
  dbPath: string;
  artifactRoot?: string;
  backupDir?: string;
  now?: () => Date;
  newId?: (prefix: string) => string;
  diskProbe?: DiskProbe;
  reserveBytes?: number;
  maxArtifactBytes?: number;
  projectQuotaBytes?: number;
  maxDatabaseBytes?: number;
  artifactOptions?: Partial<ArtifactFileStoreOptions>;
}

type DbRow = Record<string, string | number | null>;

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "interrupted",
];

function asString(value: unknown): string {
  return String(value ?? "");
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function projectFromRow(row: DbRow): StoredProject {
  return {
    id: row.id as string as ProjectId,
    name: asString(row.name),
    rootPath: asString(row.root_path),
    canonicalPath: asString(row.canonical_path),
    fsDev: asNumber(row.fs_dev),
    fsIno: asNumber(row.fs_ino),
    repositoryKind: asString(row.repository_kind) as RepositoryKind,
    repositoryRoot: asNullableString(row.repository_root),
    worktreeName: asNullableString(row.worktree_name),
    accent: asNullableString(row.accent),
    monogram: asNullableString(row.monogram),
    archived: Number(row.archived) === 1,
    pinned: Number(row.pinned) === 1,
    removedAt: asNullableString(row.removed_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    revision: asNumber(row.revision),
  };
}

function taskFromRow(row: DbRow): StoredTask {
  return {
    id: row.id as string as TaskId,
    projectId: row.project_id as string as ProjectId,
    title: asString(row.title),
    prompt: asString(row.prompt),
    status: asString(row.status) as TaskStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    revision: asNumber(row.revision),
  };
}

function artifactFromRow(row: DbRow): ArtifactRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id) as ProjectId,
    taskId: asNullableString(row.task_id) as TaskId | null,
    digest: asString(row.digest),
    relPath: asString(row.rel_path),
    sizeBytes: asNumber(row.size_bytes),
    mediaType: asString(row.media_type),
    source: asString(row.source),
    retentionClass: asString(row.retention_class) as ArtifactRecord["retentionClass"],
    createdAt: asString(row.created_at),
  };
}

function bindingFromRow(row: DbRow): RuntimeBinding {
  return {
    projectId: row.project_id as string as ProjectId,
    workspace: asString(row.workspace),
    canonicalWorkspace: asString(row.canonical_workspace),
    executable: asString(row.executable),
    engineVersion: asNullableString(row.engine_version),
    engineCommit: asNullableString(row.engine_commit),
    port: asNumberOrNull(row.port),
    state: asString(row.state) as BindingState,
    updatedAt: asString(row.updated_at),
  };
}

function validateName(name: string, label: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new StateError("CONFLICT", `${label} must be between 1 and 200 characters`);
  }
  return trimmed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * The single writer for product state. Every mutation runs through `write()`,
 * which holds the maintenance barrier and one SQLite transaction; reads hold
 * the barrier in shared mode. A public store handle never exposes the database.
 */
export class StateStore {
  readonly barrier = new MaintenanceBarrier();
  private closed = false;

  private constructor(
    private db: DatabaseSync,
    private readonly options: Required<
      Pick<StateStoreOptions, "dbPath" | "backupDir" | "now" | "newId" | "reserveBytes">
    > &
      StateStoreOptions,
    readonly artifactFiles: ArtifactFileStore,
    private readonly diskProbe: DiskProbe,
    private readonly projectQuotaBytes: number,
    private readonly maxArtifactBytes: number,
  ) {}

  static async open(options: StateStoreOptions): Promise<StateStore> {
    ensurePrivateDir(dirname(options.dbPath));
    const backupDir = options.backupDir ?? join(dirname(options.dbPath), "backups");
    ensurePrivateDir(backupDir);
    const now = options.now ?? (() => new Date());
    const maxPageCount =
      options.maxDatabaseBytes === undefined
        ? undefined
        : Math.max(1, Math.floor(options.maxDatabaseBytes / 4096));
    const outcome = await migrateDatabase({
      dbPath: options.dbPath,
      now,
      backupDir,
      databaseOptions: { maxPageCount },
    });
    const artifactRoot = options.artifactRoot ?? join(dirname(options.dbPath), "..", "artifacts");
    const artifactFiles = new ArtifactFileStore({
      ...options.artifactOptions,
      root: artifactRoot,
      reserveBytes: options.reserveBytes,
      maxArtifactBytes: options.maxArtifactBytes,
      probe: options.diskProbe,
    });
    const store = new StateStore(
      outcome.db,
      {
        ...options,
        dbPath: options.dbPath,
        backupDir,
        now,
        newId: options.newId ?? ((prefix) => `${prefix}_${randomBytes(8).toString("hex")}`),
        reserveBytes: options.reserveBytes ?? 64 * 1024 * 1024,
      },
      artifactFiles,
      options.diskProbe ?? nativeDiskProbe,
      options.projectQuotaBytes ?? 512 * 1024 * 1024,
      options.maxArtifactBytes ?? 64 * 1024 * 1024,
    );
    return store;
  }

  get path(): string {
    return this.options.dbPath;
  }

  // ------------------------------------------------------------- primitives

  private now(): string {
    return this.options.now().toISOString();
  }

  private id(prefix: string): string {
    return this.options.newId(prefix);
  }

  private assertOpen(): void {
    if (this.closed) throw new StateError("CONFLICT", "state store is closed");
  }

  private assertHeadroom(): void {
    const free = this.diskProbe.freeBytes(dirname(this.options.dbPath));
    if (free < this.options.reserveBytes) {
      throw new StateError("DISK_FULL", "not enough free disk space to write state", {
        available: free,
        reserve: this.options.reserveBytes,
      });
    }
  }

  private async read<T>(work: (db: DatabaseSync) => T): Promise<T> {
    this.assertOpen();
    return this.barrier.run("read", () => work(this.db));
  }

  private async write<T>(work: (db: DatabaseSync, now: string) => T): Promise<T> {
    this.assertOpen();
    return this.barrier.run("write", () => {
      this.assertHeadroom();
      return withTransaction(this.db, () => {
        const result = work(this.db, this.now());
        this.bumpRevision(this.db);
        return result;
      });
    });
  }

  private bumpRevision(db: DatabaseSync): number {
    const row = db.prepare("SELECT value_json FROM meta WHERE key = 'state_revision'").get() as
      { value_json: string } | undefined;
    const next = (row ? Number(row.value_json) : 0) + 1;
    db.prepare(
      "INSERT INTO meta (key, value_json, updated_at) VALUES ('state_revision', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    ).run(String(next), this.now());
    return next;
  }

  async stateRevision(): Promise<number> {
    return this.read((db) => {
      const row = db.prepare("SELECT value_json FROM meta WHERE key = 'state_revision'").get() as
        { value_json: string } | undefined;
      return row ? Number(row.value_json) : 0;
    });
  }

  // --------------------------------------------------------------- projects

  private findProjectRow(db: DatabaseSync, id: string): DbRow | null {
    return (db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbRow | undefined) ?? null;
  }

  private requireProjectRow(db: DatabaseSync, id: string): DbRow {
    const row = this.findProjectRow(db, id);
    if (!row) throw new StateError("NOT_FOUND", `project ${id} does not exist`, { project_id: id });
    return row;
  }

  private findProjectByIdentity(db: DatabaseSync, identity: PathIdentity): DbRow | null {
    const row = db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_paths pp ON pp.project_id = p.id
         WHERE pp.active = 1 AND pp.fs_dev = ? AND pp.fs_ino = ?`,
      )
      .get(identity.dev, identity.ino) as DbRow | undefined;
    return row ?? null;
  }

  /**
   * A removed catalog entry keeps its path history. Re-opening that folder
   * revives the stable project id instead of creating a parallel record.
   */
  private findRemovedProjectByIdentity(db: DatabaseSync, identity: PathIdentity): DbRow | null {
    const row = db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_paths pp ON pp.project_id = p.id
         WHERE p.removed_at IS NOT NULL AND pp.fs_dev = ? AND pp.fs_ino = ?
         ORDER BY pp.recorded_at DESC LIMIT 1`,
      )
      .get(identity.dev, identity.ino) as DbRow | undefined;
    return row ?? null;
  }

  private insertActivePath(
    db: DatabaseSync,
    projectId: string,
    identity: PathIdentity,
    now: string,
  ): void {
    db.prepare(
      "INSERT INTO project_paths (project_id, path, canonical_path, fs_dev, fs_ino, active, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, ?) " +
        "ON CONFLICT(project_id, canonical_path) DO UPDATE SET active = 1, recorded_at = excluded.recorded_at",
    ).run(projectId, identity.input, identity.canonical, identity.dev, identity.ino, now);
  }

  async createProject(input: {
    name: string;
    rootPath: string;
    pinned?: boolean;
    accent?: string | null;
    monogram?: string | null;
  }): Promise<StoredProject> {
    const identity = identifyPath(input.rootPath);
    const name = validateName(input.name || basename(identity.canonical), "project name");
    return this.write((db, now) => {
      const existing = this.findProjectByIdentity(db, identity);
      if (existing) {
        throw new StateError("ALIAS_CONFLICT", "this folder is already in the project catalog", {
          project_id: existing.id,
          canonical_path: identity.canonical,
        });
      }
      const removed = this.findRemovedProjectByIdentity(db, identity);
      if (removed) {
        // Re-opening a folder removed from the catalog revives its stable
        // project id instead of creating a parallel history.
        db.prepare(
          "UPDATE projects SET name = ?, root_path = ?, canonical_path = ?, fs_dev = ?, fs_ino = ?, " +
            "repository_kind = ?, repository_root = ?, worktree_name = ?, removed_at = NULL, " +
            "updated_at = ?, revision = revision + 1 WHERE id = ?",
        ).run(
          name,
          identity.input,
          identity.canonical,
          identity.dev,
          identity.ino,
          identity.repository.kind,
          identity.repository.root,
          identity.repository.worktreeName,
          now,
          String(removed.id),
        );
        this.insertActivePath(db, String(removed.id), identity, now);
        return projectFromRow(this.requireProjectRow(db, String(removed.id)));
      }
      const id = this.id("prj");
      db.prepare(
        "INSERT INTO projects (id, name, root_path, canonical_path, fs_dev, fs_ino, repository_kind, " +
          "repository_root, worktree_name, accent, monogram, archived, pinned, removed_at, created_at, " +
          "updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 1)",
      ).run(
        id,
        name,
        identity.input,
        identity.canonical,
        identity.dev,
        identity.ino,
        identity.repository.kind,
        identity.repository.root,
        identity.repository.worktreeName,
        input.accent ?? null,
        input.monogram ?? null,
        input.pinned ? 1 : 0,
        now,
        now,
      );
      this.insertActivePath(db, id, identity, now);
      return projectFromRow(this.requireProjectRow(db, id));
    });
  }

  async openProject(rootPath: string): Promise<{ project: StoredProject; created: boolean }> {
    const identity = identifyPath(rootPath);
    const existing = await this.read((db) => this.findProjectByIdentity(db, identity));
    if (existing) {
      return { project: projectFromRow(existing), created: false };
    }
    const removed = await this.read((db) => this.findRemovedProjectByIdentity(db, identity));
    if (removed) {
      const revived = await this.createProject({
        name: basename(identity.canonical),
        rootPath,
      });
      return { project: revived, created: false };
    }
    try {
      const project = await this.createProject({
        name: basename(identity.canonical),
        rootPath,
      });
      return { project, created: true };
    } catch (error) {
      if (error instanceof StateError && error.code === "ALIAS_CONFLICT") {
        const raced = await this.read((db) => this.findProjectByIdentity(db, identity));
        if (raced) return { project: projectFromRow(raced), created: false };
      }
      throw error;
    }
  }

  async listProjects(
    options: { includeArchived?: boolean; includeRemoved?: boolean; query?: string } = {},
  ): Promise<StoredProject[]> {
    return this.read((db) => {
      const clauses: string[] = [];
      const values: Array<string | number | null> = [];
      if (!options.includeArchived) clauses.push("archived = 0");
      if (!options.includeRemoved) clauses.push("removed_at IS NULL");
      if (options.query && options.query.trim()) {
        const pattern = `%${escapeLike(options.query.trim())}%`;
        clauses.push("(name LIKE ? ESCAPE '\\' OR root_path LIKE ? ESCAPE '\\')");
        values.push(pattern, pattern);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM projects ${where} ORDER BY pinned DESC, updated_at DESC, name COLLATE NOCASE`,
        )
        .all(...values) as DbRow[];
      return rows.map(projectFromRow);
    });
  }

  async getProject(
    id: ProjectId,
    options: { includeRemoved?: boolean } = {},
  ): Promise<StoredProject | null> {
    return this.read((db) => {
      const row = this.findProjectRow(db, id);
      if (!row) return null;
      if (!options.includeRemoved && row.removed_at !== null) return null;
      return projectFromRow(row);
    });
  }

  private mutateProject(
    db: DatabaseSync,
    id: ProjectId,
    expectedRevision: number,
    patch: Partial<Pick<StoredProject, "name" | "pinned" | "archived" | "accent" | "monogram">>,
    now: string,
  ): StoredProject {
    const row = this.requireProjectRow(db, id);
    if (Number(row.revision) !== expectedRevision) {
      throw new StateError("STALE_REVISION", "project changed since it was read", {
        project_id: id,
        expected_revision: expectedRevision,
        actual_revision: Number(row.revision),
      });
    }
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(validateName(patch.name, "project name"));
    }
    for (const [column, value] of [
      ["pinned", patch.pinned],
      ["archived", patch.archived],
    ] as const) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value ? 1 : 0);
      }
    }
    for (const [column, value] of [
      ["accent", patch.accent],
      ["monogram", patch.monogram],
    ] as const) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return projectFromRow(row);
    sets.push("updated_at = ?", "revision = revision + 1");
    values.push(now, id);
    db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return projectFromRow(this.requireProjectRow(db, id));
  }

  async renameProject(
    id: ProjectId,
    name: string,
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, { name }, now));
  }

  async setProjectPinned(
    id: ProjectId,
    pinned: boolean,
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, { pinned }, now));
  }

  async setProjectArchived(
    id: ProjectId,
    archived: boolean,
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, { archived }, now));
  }

  async setProjectIdentity(
    id: ProjectId,
    identity: { accent: string | null; monogram: string | null },
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, identity, now));
  }

  async removeProjectFromCatalog(id: ProjectId, expectedRevision: number): Promise<StoredProject> {
    return this.write((db, now) => {
      const row = this.requireProjectRow(db, id);
      if (row.removed_at !== null) {
        throw new StateError("CONFLICT", "project is already removed from the catalog", {
          project_id: id,
        });
      }
      if (Number(row.revision) !== expectedRevision) {
        throw new StateError("STALE_REVISION", "project changed since it was read", {
          project_id: id,
          expected_revision: expectedRevision,
          actual_revision: Number(row.revision),
        });
      }
      db.prepare("UPDATE project_paths SET active = 0 WHERE project_id = ?").run(id);
      db.prepare(
        "UPDATE projects SET removed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, now, id);
      return projectFromRow(this.requireProjectRow(db, id));
    });
  }

  async relocateProject(
    id: ProjectId,
    newRoot: string,
    expectedRevision: number,
  ): Promise<StoredProject> {
    const identity = identifyPath(newRoot);
    return this.write((db, now) => {
      const row = this.requireProjectRow(db, id);
      if (Number(row.revision) !== expectedRevision) {
        throw new StateError("STALE_REVISION", "project changed since it was read", {
          project_id: id,
          expected_revision: expectedRevision,
          actual_revision: Number(row.revision),
        });
      }
      const owner = this.findProjectByIdentity(db, identity);
      if (owner && String(owner.id) !== String(id)) {
        throw new StateError(
          "ALIAS_CONFLICT",
          "the new location already belongs to another project",
          {
            project_id: owner.id,
          },
        );
      }
      db.prepare("UPDATE project_paths SET active = 0 WHERE project_id = ?").run(id);
      this.insertActivePath(db, id, identity, now);
      db.prepare(
        "UPDATE projects SET root_path = ?, canonical_path = ?, fs_dev = ?, fs_ino = ?, " +
          "repository_kind = ?, repository_root = ?, worktree_name = ?, updated_at = ?, " +
          "revision = revision + 1 WHERE id = ?",
      ).run(
        newRoot,
        identity.canonical,
        identity.dev,
        identity.ino,
        identity.repository.kind,
        identity.repository.root,
        identity.repository.worktreeName,
        now,
        id,
      );
      return projectFromRow(this.requireProjectRow(db, id));
    });
  }

  async listProjectPaths(
    projectId: ProjectId,
  ): Promise<Array<{ path: string; canonicalPath: string; active: boolean; recordedAt: string }>> {
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT path, canonical_path, active, recorded_at FROM project_paths WHERE project_id = ? " +
            "ORDER BY active DESC, recorded_at DESC",
        )
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        path: asString(row.path),
        canonicalPath: asString(row.canonical_path),
        active: Number(row.active) === 1,
        recordedAt: asString(row.recorded_at),
      }));
    });
  }

  // --------------------------------------------------------------- bindings

  async setRuntimeBinding(binding: RuntimeBinding): Promise<RuntimeBinding> {
    return this.write((db) => {
      this.requireProjectRow(db, binding.projectId);
      db.prepare(
        "INSERT INTO runtime_bindings (project_id, workspace, canonical_workspace, executable, " +
          "engine_version, engine_commit, port, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(project_id) DO UPDATE SET workspace = excluded.workspace, " +
          "canonical_workspace = excluded.canonical_workspace, executable = excluded.executable, " +
          "engine_version = excluded.engine_version, engine_commit = excluded.engine_commit, " +
          "port = excluded.port, state = excluded.state, updated_at = excluded.updated_at",
      ).run(
        binding.projectId,
        binding.workspace,
        binding.canonicalWorkspace,
        binding.executable,
        binding.engineVersion,
        binding.engineCommit,
        binding.port,
        binding.state,
        binding.updatedAt,
      );
      return binding;
    });
  }

  async getRuntimeBinding(projectId: ProjectId): Promise<RuntimeBinding | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM runtime_bindings WHERE project_id = ?")
        .get(projectId) as DbRow | undefined;
      return row ? bindingFromRow(row) : null;
    });
  }

  async clearRuntimeBinding(projectId: ProjectId): Promise<void> {
    await this.write((db) => {
      db.prepare("DELETE FROM runtime_bindings WHERE project_id = ?").run(projectId);
    });
  }

  // ---------------------------------------------------------- threads/turns

  async upsertThread(input: {
    id: string;
    projectId: ProjectId;
    engineThreadId?: string | null;
    title?: string | null;
  }): Promise<StoredThread> {
    return this.write((db, now) => {
      this.requireProjectRow(db, input.projectId);
      db.prepare(
        "INSERT INTO threads (id, project_id, engine_thread_id, title, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET " +
          "engine_thread_id = excluded.engine_thread_id, title = COALESCE(excluded.title, threads.title), " +
          "updated_at = excluded.updated_at",
      ).run(input.id, input.projectId, input.engineThreadId ?? null, input.title ?? null, now, now);
      const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(input.id) as DbRow;
      return {
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        engineThreadId: asNullableString(row.engine_thread_id),
        title: asNullableString(row.title),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    });
  }

  async listThreads(projectId: ProjectId): Promise<StoredThread[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        engineThreadId: asNullableString(row.engine_thread_id),
        title: asNullableString(row.title),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }));
    });
  }

  async upsertTurn(input: StoredTurn): Promise<StoredTurn> {
    return this.write((db) => {
      db.prepare(
        "INSERT INTO turns (id, thread_id, status, provider, model, permission_posture, started_at, ended_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, " +
          "provider = excluded.provider, model = excluded.model, " +
          "permission_posture = excluded.permission_posture, ended_at = excluded.ended_at",
      ).run(
        input.id,
        input.threadId,
        input.status,
        input.provider,
        input.model,
        input.permissionPosture,
        input.startedAt,
        input.endedAt,
      );
      return input;
    });
  }

  // ------------------------------------------------------------- submissions

  async putSubmission(
    state: SubmissionState,
    projectId?: ProjectId | null,
  ): Promise<SubmissionState> {
    const parsed = SubmissionState.parse(state);
    return this.write((db) => {
      db.prepare(
        "INSERT INTO submissions (operation_key, project_id, thread_id, turn_id, status, submitted_at, " +
          "reconciled, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(operation_key) DO UPDATE SET status = excluded.status, turn_id = excluded.turn_id, " +
          "reconciled = excluded.reconciled, note = excluded.note",
      ).run(
        parsed.operationKey,
        projectId ?? null,
        parsed.threadId,
        parsed.turnId,
        parsed.status,
        parsed.submittedAt,
        parsed.reconciled ? 1 : 0,
        parsed.note ?? null,
      );
      return parsed;
    });
  }

  async getSubmission(operationKey: string): Promise<SubmissionState | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM submissions WHERE operation_key = ?")
        .get(operationKey) as DbRow | undefined;
      if (!row) return null;
      const value: Record<string, unknown> = {
        operationKey: asString(row.operation_key),
        threadId: asString(row.thread_id),
        turnId: asNullableString(row.turn_id),
        status: asString(row.status) as SubmissionStatus,
        submittedAt: asString(row.submitted_at),
        reconciled: Number(row.reconciled) === 1,
      };
      if (row.note !== null) value.note = asString(row.note);
      return SubmissionState.parse(value);
    });
  }

  // ------------------------------------------------------------------- tasks

  async createTask(input: {
    projectId: ProjectId;
    title: string;
    prompt: string;
    dependsOn?: TaskId[];
  }): Promise<StoredTask> {
    const title = validateName(input.title, "task title");
    if (!input.prompt.trim()) throw new StateError("CONFLICT", "task prompt cannot be empty");
    return this.write((db, now) => {
      const project = this.requireProjectRow(db, input.projectId);
      if (project.removed_at !== null) {
        throw new StateError("CONFLICT", "cannot add a task to a removed project", {
          project_id: input.projectId,
        });
      }
      const id = this.id("tsk");
      db.prepare(
        "INSERT INTO tasks (id, project_id, title, prompt, status, created_at, updated_at, revision) " +
          "VALUES (?, ?, ?, ?, 'pending', ?, ?, 1)",
      ).run(id, input.projectId, title, input.prompt, now, now);
      for (const dependency of input.dependsOn ?? []) {
        this.insertDependency(db, id, dependency, input.projectId, now);
      }
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  private insertDependency(
    db: DatabaseSync,
    taskId: string,
    dependsOnTaskId: string,
    projectId: ProjectId,
    now: string,
  ): void {
    if (taskId === dependsOnTaskId) {
      throw new StateError("CONFLICT", "a task cannot depend on itself", { task_id: taskId });
    }
    const prerequisite = db
      .prepare("SELECT project_id FROM tasks WHERE id = ?")
      .get(dependsOnTaskId) as { project_id: string } | undefined;
    if (!prerequisite) {
      throw new StateError("NOT_FOUND", `prerequisite task ${dependsOnTaskId} does not exist`);
    }
    if (String(prerequisite.project_id) !== String(projectId)) {
      throw new StateError("CONFLICT", "task dependencies cannot cross projects", {
        task_id: taskId,
        prerequisite: dependsOnTaskId,
      });
    }
    db.prepare(
      "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
    ).run(taskId, dependsOnTaskId, now);
  }

  async addTaskDependency(taskId: TaskId, dependsOnTaskId: TaskId): Promise<void> {
    await this.write((db, now) => {
      const task = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as
        { project_id: string } | undefined;
      if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
      if (this.dependsTransitively(db, dependsOnTaskId, taskId)) {
        throw new StateError("CONFLICT", "dependency would create a cycle", {
          task_id: taskId,
          depends_on_task_id: dependsOnTaskId,
        });
      }
      this.insertDependency(db, taskId, dependsOnTaskId, String(task.project_id) as ProjectId, now);
    });
  }

  private dependsTransitively(db: DatabaseSync, from: string, target: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) continue;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const rows = db
        .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
        .all(current) as Array<{ depends_on_task_id: string }>;
      for (const row of rows) queue.push(String(row.depends_on_task_id));
    }
    return false;
  }

  async listTasks(projectId: ProjectId): Promise<StoredTask[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, rowid")
        .all(projectId) as DbRow[];
      return rows.map(taskFromRow);
    });
  }

  async getTask(id: TaskId): Promise<StoredTask | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
      return row ? taskFromRow(row) : null;
    });
  }

  async listDependencies(
    projectId: ProjectId,
  ): Promise<Array<{ taskId: TaskId; dependsOnTaskId: TaskId }>> {
    return this.read((db) => {
      const rows = db
        .prepare(
          `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
        )
        .all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>;
      return rows.map((row) => ({
        taskId: row.task_id as TaskId,
        dependsOnTaskId: row.depends_on_task_id as TaskId,
      }));
    });
  }

  async updateTaskStatus(
    id: TaskId,
    status: TaskStatus,
    expectedRevision: number,
  ): Promise<StoredTask> {
    if (!TASK_STATUSES.includes(status)) {
      throw new StateError("CONFLICT", `unknown task status ${status}`);
    }
    return this.write((db, now) => {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
      if (!row) throw new StateError("NOT_FOUND", `task ${id} does not exist`);
      if (Number(row.revision) !== expectedRevision) {
        throw new StateError("STALE_REVISION", "task changed since it was read", {
          task_id: id,
          expected_revision: expectedRevision,
          actual_revision: Number(row.revision),
        });
      }
      db.prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(status, now, id);
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  // -------------------------------------------------------------- evidence

  async addRequirementEvidence(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    requirementId: string;
    path: string;
    digest?: string | null;
    note?: string | null;
  }): Promise<RequirementEvidenceRecord> {
    if (!/^(MONA|MAC)-\d{3}$/.test(input.requirementId)) {
      throw new StateError("CONFLICT", "requirement ids look like MONA-001 or MAC-001");
    }
    return this.write((db, now) => {
      const id = this.id("evd");
      db.prepare(
        "INSERT INTO requirement_evidence (id, project_id, task_id, requirement_id, path, digest, note, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.requirementId,
        input.path,
        input.digest ?? null,
        input.note ?? null,
        now,
      );
      return {
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        requirementId: input.requirementId,
        path: input.path,
        digest: input.digest ?? null,
        note: input.note ?? null,
        createdAt: now,
      };
    });
  }

  async listRequirementEvidence(projectId: ProjectId): Promise<RequirementEvidenceRecord[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM requirement_evidence WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        taskId: asNullableString(row.task_id) as TaskId | null,
        requirementId: asString(row.requirement_id),
        path: asString(row.path),
        digest: asNullableString(row.digest),
        note: asNullableString(row.note),
        createdAt: asString(row.created_at),
      }));
    });
  }

  async recordAttempt(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    problemId: string;
    requirement: string;
    symptom?: string | null;
    hypothesis: string;
    action: string;
    observed: string;
    materialProgress: boolean;
    evidence?: string[];
  }): Promise<AttemptRecord> {
    return this.write((db, now) => {
      const id = this.id("atp");
      const evidence = input.evidence ?? [];
      db.prepare(
        "INSERT INTO attempts (id, project_id, task_id, problem_id, requirement, symptom, hypothesis, " +
          "action, observed, material_progress, evidence_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.problemId,
        input.requirement,
        input.symptom ?? null,
        input.hypothesis,
        input.action,
        input.observed,
        input.materialProgress ? 1 : 0,
        JSON.stringify(evidence),
        now,
      );
      return {
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        problemId: input.problemId,
        requirement: input.requirement,
        symptom: input.symptom ?? null,
        hypothesis: input.hypothesis,
        action: input.action,
        observed: input.observed,
        materialProgress: input.materialProgress,
        evidence,
        createdAt: now,
      };
    });
  }

  async listAttempts(projectId: ProjectId, problemId?: string): Promise<AttemptRecord[]> {
    return this.read((db) => {
      const rows = (
        problemId
          ? db
              .prepare(
                "SELECT * FROM attempts WHERE project_id = ? AND problem_id = ? ORDER BY created_at",
              )
              .all(projectId, problemId)
          : db
              .prepare("SELECT * FROM attempts WHERE project_id = ? ORDER BY created_at")
              .all(projectId)
      ) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        taskId: asNullableString(row.task_id) as TaskId | null,
        problemId: asString(row.problem_id),
        requirement: asString(row.requirement),
        symptom: asNullableString(row.symptom),
        hypothesis: asString(row.hypothesis),
        action: asString(row.action),
        observed: asString(row.observed),
        materialProgress: Number(row.material_progress) === 1,
        evidence: JSON.parse(asString(row.evidence_json) || "[]") as string[],
        createdAt: asString(row.created_at),
      }));
    });
  }

  async addDecision(input: {
    projectId: ProjectId;
    title: string;
    body: string;
  }): Promise<StoredDecision> {
    return this.write((db, now) => {
      const id = this.id("dec");
      db.prepare(
        "INSERT INTO decisions (id, project_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, input.projectId, input.title, input.body, now);
      return {
        id,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        createdAt: now,
      };
    });
  }

  async listDecisions(projectId: ProjectId): Promise<StoredDecision[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        title: asString(row.title),
        body: asString(row.body),
        createdAt: asString(row.created_at),
      }));
    });
  }

  // ----------------------------------------------------------------- events

  async recordEvent(input: {
    threadId: string;
    seq: number;
    kind: string;
    payload: unknown;
    timestamp: string;
  }): Promise<{ recorded: boolean; cursor: number }> {
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new StateError("CONFLICT", "event sequence must be a positive integer");
    }
    return this.write((db, now) => {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO events (thread_id, seq, kind, payload_json, timestamp, recorded_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.threadId,
          input.seq,
          input.kind,
          JSON.stringify(input.payload),
          input.timestamp,
          now,
        );
      const recorded = Number(result.changes) > 0;
      const row = db
        .prepare("SELECT last_seq FROM event_cursors WHERE thread_id = ?")
        .get(input.threadId) as { last_seq: number } | undefined;
      const cursor = Math.max(Number(row?.last_seq ?? 0), recorded ? input.seq : 0);
      db.prepare(
        "INSERT INTO event_cursors (thread_id, last_seq, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at",
      ).run(input.threadId, cursor, now);
      return { recorded, cursor };
    });
  }

  async getCursor(threadId: string): Promise<number> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT last_seq FROM event_cursors WHERE thread_id = ?")
        .get(threadId) as { last_seq: number } | undefined;
      return Number(row?.last_seq ?? 0);
    });
  }

  async readEvents(threadId: string, afterSeq = 0, limit = 200): Promise<StoredEvent[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 1000);
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(threadId, afterSeq, bounded) as DbRow[];
      return rows.map((row) => ({
        threadId: asString(row.thread_id),
        seq: asNumber(row.seq),
        kind: asString(row.kind),
        payload: JSON.parse(asString(row.payload_json)),
        timestamp: asString(row.timestamp),
        recordedAt: asString(row.recorded_at),
      }));
    });
  }

  // ------------------------------------------------------------------ usage

  async recordUsage(
    input: Omit<UsageRecord, "id" | "costComplete"> & { costComplete?: boolean },
  ): Promise<UsageRecord> {
    return this.write((db, now) => {
      const id = this.id("usg");
      const complete = input.costUsd !== null && (input.costComplete ?? true);
      db.prepare(
        "INSERT INTO usage_records (id, project_id, thread_id, turn_id, provider, model, input_tokens, " +
          "output_tokens, cached_tokens, reasoning_tokens, cost_usd, cost_complete, captured_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.projectId,
        input.threadId,
        input.turnId,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cachedTokens,
        input.reasoningTokens,
        input.costUsd,
        complete ? 1 : 0,
        input.capturedAt || now,
      );
      return { ...input, id, costComplete: complete, capturedAt: input.capturedAt || now };
    });
  }

  async summarizeUsage(projectId: ProjectId): Promise<UsageSummary> {
    return this.read((db) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS turns,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd,
                  SUM(CASE WHEN cost_complete = 1 THEN 1 ELSE 0 END) AS complete_rows
           FROM usage_records WHERE project_id = ?`,
        )
        .get(projectId) as DbRow;
      const turns = asNumber(row.turns);
      return {
        turns,
        inputTokens: asNumber(row.input_tokens),
        outputTokens: asNumber(row.output_tokens),
        cachedTokens: asNumber(row.cached_tokens),
        reasoningTokens: asNumber(row.reasoning_tokens),
        costUsd: asNumber(row.cost_usd),
        costComplete: turns > 0 && asNumber(row.complete_rows) === turns,
        observed: turns > 0,
      };
    });
  }

  // ------------------------------------------------------------- capability

  async saveCapabilitySnapshot(input: {
    engineVersion: string;
    engineCommit: string;
    payload: unknown;
  }): Promise<{ id: string; digest: string; capturedAt: string }> {
    const actual = createHash("sha256").update(canonicalJson(input.payload)).digest("hex");
    return this.write((db, now) => {
      const id = this.id("cap");
      db.prepare(
        "INSERT INTO capability_snapshots (id, engine_version, engine_commit, digest, payload_json, captured_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.engineVersion,
        input.engineCommit,
        actual,
        JSON.stringify(input.payload),
        now,
      );
      return { id, digest: actual, capturedAt: now };
    });
  }

  async latestCapabilitySnapshot(): Promise<{
    engineVersion: string;
    engineCommit: string;
    digest: string;
    payload: unknown;
    capturedAt: string;
  } | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM capability_snapshots ORDER BY captured_at DESC, rowid DESC LIMIT 1")
        .get() as DbRow | undefined;
      if (!row) return null;
      return {
        engineVersion: asString(row.engine_version),
        engineCommit: asString(row.engine_commit),
        digest: asString(row.digest),
        payload: JSON.parse(asString(row.payload_json)),
        capturedAt: asString(row.captured_at),
      };
    });
  }

  // --------------------------------------------------------------- settings

  private validateScope(scope: string): string {
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(scope)) {
      throw new StateError("CONFLICT", "settings scope has invalid characters", { scope });
    }
    return scope;
  }

  async putSettings(scope: string, value: unknown): Promise<StoredSettings> {
    const validScope = this.validateScope(scope);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new StateError("CONFLICT", "settings value is not serializable");
    }
    return this.write((db, now) => {
      const current = db.prepare("SELECT version FROM settings WHERE scope = ?").get(validScope) as
        { version: number } | undefined;
      const version = Number(current?.version ?? 0) + 1;
      db.prepare(
        "INSERT INTO settings_versions (scope, version, value_json, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(validScope, version, serialized, now);
      db.prepare(
        "INSERT INTO settings (scope, version, value_json, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(scope) DO UPDATE SET version = excluded.version, value_json = excluded.value_json, " +
          "updated_at = excluded.updated_at",
      ).run(validScope, version, serialized, now);
      return { scope: validScope, version, value, updatedAt: now };
    });
  }

  async getSettings(scope: string): Promise<StoredSettings | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM settings WHERE scope = ?").get(scope) as
        DbRow | undefined;
      if (!row) return null;
      return {
        scope: asString(row.scope),
        version: asNumber(row.version),
        value: JSON.parse(asString(row.value_json)),
        updatedAt: asString(row.updated_at),
      };
    });
  }

  async listSettingsVersions(
    scope: string,
  ): Promise<Array<{ version: number; value: unknown; recordedAt: string }>> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM settings_versions WHERE scope = ? ORDER BY version")
        .all(scope) as DbRow[];
      return rows.map((row) => ({
        version: asNumber(row.version),
        value: JSON.parse(asString(row.value_json)),
        recordedAt: asString(row.recorded_at),
      }));
    });
  }

  // ----------------------------------------------------------------- drafts

  async putDraft(projectId: ProjectId, threadId: string, text: string): Promise<void> {
    await this.write((db, now) => {
      db.prepare(
        "INSERT INTO drafts (project_id, thread_id, text, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(project_id, thread_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
      ).run(projectId, threadId, text, now);
    });
  }

  async getDraft(projectId: ProjectId, threadId: string): Promise<string | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT text FROM drafts WHERE project_id = ? AND thread_id = ?")
        .get(projectId, threadId) as { text: string } | undefined;
      return row ? String(row.text) : null;
    });
  }

  async deleteDraft(projectId: ProjectId, threadId: string): Promise<void> {
    await this.write((db) => {
      db.prepare("DELETE FROM drafts WHERE project_id = ? AND thread_id = ?").run(
        projectId,
        threadId,
      );
    });
  }

  // -------------------------------------------------------------- artifacts

  async putArtifact(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    data: Buffer;
    mediaType: string;
    source: string;
    retentionClass: ArtifactRecord["retentionClass"];
  }): Promise<ArtifactRecord> {
    this.assertOpen();
    if (input.data.length > this.maxArtifactBytes) {
      throw new StateError("ARTIFACT_TOO_LARGE", "artifact exceeds the configured maximum", {
        size: input.data.length,
        max: this.maxArtifactBytes,
      });
    }
    return this.barrier.run("write", async () => {
      this.assertHeadroom();
      const used = this.usedArtifactBytes(input.projectId);
      if (used + input.data.length > this.projectQuotaBytes) {
        throw new StateError("QUOTA_EXCEEDED", "project artifact quota is exhausted", {
          used,
          requested: input.data.length,
          quota: this.projectQuotaBytes,
        });
      }
      const written: WrittenArtifact = this.artifactFiles.write({
        projectId: input.projectId,
        data: input.data,
        mediaType: input.mediaType,
      });
      try {
        return withTransaction(this.db, () => {
          const id = this.id("att");
          const now = this.now();
          this.db
            .prepare(
              "INSERT INTO artifacts (id, project_id, task_id, digest, rel_path, size_bytes, media_type, " +
                "source, retention_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              id,
              input.projectId,
              input.taskId ?? null,
              written.digest,
              written.relPath,
              written.sizeBytes,
              input.mediaType,
              input.source,
              input.retentionClass,
              now,
            );
          this.bumpRevision(this.db);
          return {
            id,
            projectId: input.projectId,
            taskId: input.taskId ?? null,
            digest: written.digest,
            relPath: written.relPath,
            sizeBytes: written.sizeBytes,
            mediaType: input.mediaType,
            source: input.source,
            retentionClass: input.retentionClass,
            createdAt: now,
          };
        });
      } catch (error) {
        // The metadata did not commit, so the fresh file is an orphan; remove
        // it now rather than leaving an unclaimed artifact behind.
        this.artifactFiles.remove(written.relPath);
        throw error;
      }
    });
  }

  private usedArtifactBytes(projectId: ProjectId): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS used FROM artifacts WHERE project_id = ?")
      .get(projectId) as { used: number };
    return Number(row.used);
  }

  async listArtifacts(projectId: ProjectId): Promise<ArtifactRecord[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[];
      return rows.map(artifactFromRow);
    });
  }

  async readArtifact(id: string): Promise<{ artifact: ArtifactRecord; data: Buffer }> {
    const artifact = await this.read((db) => {
      const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as DbRow | undefined;
      return row ? artifactFromRow(row) : null;
    });
    if (!artifact) throw new StateError("NOT_FOUND", `artifact ${id} does not exist`);
    const data = this.artifactFiles.read(artifact.relPath, { verifyDigest: true });
    return { artifact, data };
  }

  async planRetention(policy: RetentionPolicy = {}): Promise<RetentionPlan> {
    const now = policy.now ?? this.options.now();
    const temporaryDays = policy.temporaryDays ?? 7;
    const diagnosticDays = policy.diagnosticDays ?? 30;
    return this.read((db) => {
      const rows = db.prepare("SELECT * FROM artifacts").all() as DbRow[];
      const artifacts = rows.map(artifactFromRow);
      const candidates: ArtifactRecord[] = [];
      const protectedArtifacts: Array<{ artifact: ArtifactRecord; reason: string }> = [];
      const warnings: string[] = [];
      for (const artifact of artifacts) {
        if (artifact.retentionClass === "evidence") {
          // Evidence-class artifacts never expire automatically. Removing one
          // requires an explicit policy with a recorded warning.
          protectedArtifacts.push({ artifact, reason: "retention class is evidence" });
          warnings.push(`retained ${artifact.id}: retention class is evidence`);
          continue;
        }
        const ageDays = (now.getTime() - Date.parse(artifact.createdAt)) / 86_400_000;
        const limit = artifact.retentionClass === "temporary" ? temporaryDays : diagnosticDays;
        if (ageDays < limit) continue;

        const evidenceRef = db
          .prepare("SELECT id FROM requirement_evidence WHERE digest = ? OR path = ? LIMIT 1")
          .get(artifact.digest, artifact.relPath) as { id: string } | undefined;
        const blockedTask =
          artifact.taskId === null
            ? undefined
            : (db.prepare("SELECT status FROM tasks WHERE id = ?").get(artifact.taskId) as
                { status: string } | undefined);
        let reason: string | null = null;
        if (evidenceRef) reason = "referenced by requirement evidence";
        else if (
          blockedTask &&
          (blockedTask.status === "blocked" || blockedTask.status === "interrupted")
        ) {
          reason = `task is ${blockedTask.status}`;
        }
        if (reason) {
          protectedArtifacts.push({ artifact, reason });
          warnings.push(`retained ${artifact.id}: ${reason}`);
        } else {
          candidates.push(artifact);
        }
      }
      return { candidates, protected: protectedArtifacts, warnings };
    });
  }

  async pruneArtifacts(policy: RetentionPolicy = {}): Promise<RetentionResult> {
    const plan = await this.planRetention(policy);
    const includeProtected = policy.includeProtected ?? false;
    const toDelete = includeProtected
      ? [...plan.candidates, ...plan.protected.map((entry) => entry.artifact)]
      : [...plan.candidates];
    const warnings = [...plan.warnings];
    if (includeProtected && plan.protected.length > 0) {
      warnings.push(
        `explicit policy deleted ${plan.protected.length} protected artifact(s); review the reason list before relying on the evidence`,
      );
    }
    if (toDelete.length === 0) {
      return { deleted: [], protected: plan.protected, freedBytes: 0, warnings };
    }
    const freed = await this.barrier.run("write", () => {
      this.assertHeadroom();
      const ids = toDelete.map((artifact) => artifact.id);
      const placeholders = ids.map(() => "?").join(",");
      return withTransaction(this.db, () => {
        this.db.prepare(`DELETE FROM artifacts WHERE id IN (${placeholders})`).run(...ids);
        this.bumpRevision(this.db);
        return toDelete.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
      });
    });
    for (const artifact of toDelete) {
      if (!this.artifactFiles.remove(artifact.relPath)) {
        warnings.push(`metadata removed but file was already gone: ${artifact.relPath}`);
      }
    }
    return { deleted: toDelete, protected: plan.protected, freedBytes: freed, warnings };
  }

  async sweepOrphanArtifacts(options: { minAgeMs?: number } = {}): Promise<string[]> {
    const referenced = new Set(
      (await this.read((db) => db.prepare("SELECT rel_path FROM artifacts").all() as DbRow[])).map(
        (row) => asString(row.rel_path),
      ),
    );
    return this.artifactFiles.sweepOrphans(referenced, options);
  }

  // --------------------------------------------------------------- portable

  private collectPayload(db: DatabaseSync, projectId: ProjectId): PortablePayload {
    const project = projectFromRow(this.requireProjectRow(db, projectId));
    const paths = (
      db
        .prepare("SELECT * FROM project_paths WHERE project_id = ? ORDER BY recorded_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      path: asString(row.path),
      canonicalPath: asString(row.canonical_path),
      active: Number(row.active) === 1,
      recordedAt: asString(row.recorded_at),
    }));
    const tasks = (
      db
        .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => {
      const task = taskFromRow(row);
      return {
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        revision: task.revision,
      };
    });
    const dependencies = (
      db
        .prepare(
          `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
        )
        .all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>
    ).map((row) => ({
      taskId: row.task_id as TaskId,
      dependsOnTaskId: row.depends_on_task_id as TaskId,
    }));
    const evidence = (
      db
        .prepare("SELECT * FROM requirement_evidence WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: asString(row.id),
      taskId: asNullableString(row.task_id) as TaskId | null,
      requirementId: asString(row.requirement_id),
      path: asString(row.path),
      digest: asNullableString(row.digest),
      note: asNullableString(row.note),
      createdAt: asString(row.created_at),
    }));
    const attemptRows = db
      .prepare("SELECT * FROM attempts WHERE project_id = ? ORDER BY created_at")
      .all(projectId) as DbRow[];
    const attempts = attemptRows.map((row) => ({
      id: asString(row.id),
      taskId: asNullableString(row.task_id) as TaskId | null,
      problemId: asString(row.problem_id),
      requirement: asString(row.requirement),
      symptom: asNullableString(row.symptom),
      hypothesis: asString(row.hypothesis),
      action: asString(row.action),
      observed: asString(row.observed),
      materialProgress: Number(row.material_progress) === 1,
      evidence: JSON.parse(asString(row.evidence_json) || "[]") as string[],
      createdAt: asString(row.created_at),
    }));
    const decisions = (
      db
        .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: asString(row.id),
      title: asString(row.title),
      body: asString(row.body),
      createdAt: asString(row.created_at),
    }));
    const threadRows = db
      .prepare("SELECT * FROM threads WHERE project_id = ? ORDER BY created_at")
      .all(projectId) as DbRow[];
    const threads = threadRows.map((row) => ({
      id: asString(row.id),
      engineThreadId: asNullableString(row.engine_thread_id),
      title: asNullableString(row.title),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
    const threadIds = threads.map((thread) => thread.id);
    const placeholders = threadIds.map(() => "?").join(",");
    const turns =
      threadIds.length === 0
        ? []
        : (
            db
              .prepare(
                `SELECT * FROM turns WHERE thread_id IN (${placeholders}) ORDER BY started_at`,
              )
              .all(...threadIds) as DbRow[]
          ).map((row) => ({
            id: asString(row.id),
            threadId: asString(row.thread_id),
            status: asString(row.status),
            provider: asNullableString(row.provider),
            model: asNullableString(row.model),
            permissionPosture: asNullableString(row.permission_posture),
            startedAt: asString(row.started_at),
            endedAt: asNullableString(row.ended_at),
          }));
    const usage = (
      db
        .prepare("SELECT * FROM usage_records WHERE project_id = ? ORDER BY captured_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: asString(row.id),
      threadId: asNullableString(row.thread_id),
      turnId: asNullableString(row.turn_id),
      provider: asString(row.provider),
      model: asString(row.model),
      inputTokens: asNumberOrNull(row.input_tokens),
      outputTokens: asNumberOrNull(row.output_tokens),
      cachedTokens: asNumberOrNull(row.cached_tokens),
      reasoningTokens: asNumberOrNull(row.reasoning_tokens),
      costUsd: asNumberOrNull(row.cost_usd),
      costComplete: Number(row.cost_complete) === 1,
      capturedAt: asString(row.captured_at),
    }));
    const drafts = (
      db
        .prepare("SELECT * FROM drafts WHERE project_id = ? ORDER BY updated_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      threadId: asString(row.thread_id),
      text: asString(row.text),
      updatedAt: asString(row.updated_at),
    }));
    const settings = (
      db
        .prepare(
          "SELECT * FROM settings WHERE scope = ? OR scope = ? OR scope LIKE ? ESCAPE '\\' ORDER BY scope",
        )
        .all(
          `project:${projectId}`,
          `view:${projectId}`,
          `project:${escapeLike(String(projectId))}:%`,
        ) as DbRow[]
    ).map((row) => ({
      scope: asString(row.scope),
      version: asNumber(row.version),
      value: JSON.parse(asString(row.value_json)),
      updatedAt: asString(row.updated_at),
    }));
    const artifacts = (
      db
        .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => {
      const artifact = artifactFromRow(row);
      return {
        id: artifact.id,
        taskId: artifact.taskId,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        sizeBytes: artifact.sizeBytes,
        source: artifact.source,
        retentionClass: artifact.retentionClass,
        createdAt: artifact.createdAt,
      };
    });
    const submissions = (
      db
        .prepare("SELECT * FROM submissions WHERE project_id = ? ORDER BY submitted_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      operationKey: asString(row.operation_key),
      threadId: asString(row.thread_id),
      turnId: asNullableString(row.turn_id),
      status: asString(row.status) as SubmissionStatus,
      submittedAt: asString(row.submitted_at),
      reconciled: Number(row.reconciled) === 1,
      note: asNullableString(row.note),
    }));

    return {
      project: {
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        canonicalPath: project.canonicalPath,
        repositoryKind: project.repositoryKind,
        repositoryRoot: project.repositoryRoot,
        worktreeName: project.worktreeName,
        accent: project.accent,
        monogram: project.monogram,
        archived: project.archived,
        pinned: project.pinned,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        revision: project.revision,
      },
      paths,
      tasks,
      dependencies,
      evidence,
      attempts,
      decisions,
      threads,
      turns,
      usage,
      drafts,
      settings,
      artifacts,
      submissions,
    };
  }

  async exportProject(projectId: ProjectId): Promise<ProjectBundle> {
    return this.read((db) => buildBundle(this.collectPayload(db, projectId), this.options.now()));
  }

  async exportProjectToFile(
    projectId: ProjectId,
    destination: string,
  ): Promise<{ digest: string; bundle: ProjectBundle }> {
    const bundle = await this.exportProject(projectId);
    writeFileDurable(destination, bundleToFileText(bundle));
    return { digest: bundle.digest, bundle };
  }

  async importProject(value: unknown, options: ImportOptions = {}): Promise<ImportResult> {
    const { bundle, problems } = verifyBundle(value);
    if (!bundle) {
      const digestProblem = problems.some((problem) => problem.path === "digest");
      throw new StateError(
        digestProblem ? "IMPORT_DIGEST_MISMATCH" : "IMPORT_INVALID",
        digestProblem
          ? "imported project digest does not match its contents"
          : "imported project is invalid",
        { problems: problems.slice(0, 20) },
      );
    }
    const payload = bundle.payload;
    const identity = identifyPath(options.rootPath ?? payload.project.rootPath);
    const mode = options.mode ?? "create";
    const missingArtifacts: string[] = [];
    return this.write((db, now) => {
      const existing = this.findProjectRow(db, payload.project.id);
      const owner = this.findProjectByIdentity(db, identity);
      if (owner && String(owner.id) !== String(payload.project.id)) {
        throw new StateError(
          "ALIAS_CONFLICT",
          "the imported folder already belongs to another project",
          {
            project_id: owner.id,
          },
        );
      }
      if (existing && mode !== "replace") {
        throw new StateError("CONFLICT", "project already exists; import needs replace mode", {
          project_id: payload.project.id,
          revision: Number(existing.revision),
        });
      }
      if (existing) {
        const actual = Number(existing.revision);
        if (options.expectedRevision !== undefined && options.expectedRevision !== actual) {
          throw new StateError(
            "IMPORT_REVISION_CONFLICT",
            "project changed since import was requested",
            {
              expected_revision: options.expectedRevision,
              actual_revision: actual,
            },
          );
        }
        if (payload.project.revision < actual) {
          throw new StateError(
            "IMPORT_REVISION_CONFLICT",
            "imported state is older than the local project",
            {
              imported_revision: payload.project.revision,
              local_revision: actual,
            },
          );
        }
        this.deleteProjectContents(db, payload.project.id);
      }

      const revision = existing ? Number(existing.revision) + 1 : payload.project.revision;
      if (existing) {
        db.prepare(
          "UPDATE projects SET name = ?, root_path = ?, canonical_path = ?, fs_dev = ?, fs_ino = ?, " +
            "repository_kind = ?, repository_root = ?, worktree_name = ?, accent = ?, monogram = ?, " +
            "archived = ?, pinned = ?, removed_at = NULL, updated_at = ?, revision = ? WHERE id = ?",
        ).run(
          payload.project.name,
          options.rootPath ?? payload.project.rootPath,
          identity.canonical,
          identity.dev,
          identity.ino,
          identity.repository.kind,
          identity.repository.root,
          identity.repository.worktreeName,
          payload.project.accent,
          payload.project.monogram,
          payload.project.archived ? 1 : 0,
          payload.project.pinned ? 1 : 0,
          now,
          revision,
          payload.project.id,
        );
      } else {
        db.prepare(
          "INSERT INTO projects (id, name, root_path, canonical_path, fs_dev, fs_ino, repository_kind, " +
            "repository_root, worktree_name, accent, monogram, archived, pinned, removed_at, created_at, " +
            "updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        ).run(
          payload.project.id,
          payload.project.name,
          options.rootPath ?? payload.project.rootPath,
          identity.canonical,
          identity.dev,
          identity.ino,
          identity.repository.kind,
          identity.repository.root,
          identity.repository.worktreeName,
          payload.project.accent,
          payload.project.monogram,
          payload.project.archived ? 1 : 0,
          payload.project.pinned ? 1 : 0,
          payload.project.createdAt,
          now,
          revision,
        );
      }
      this.insertActivePath(db, payload.project.id, identity, now);
      for (const path of payload.paths) {
        if (path.active) continue;
        db.prepare(
          "INSERT OR IGNORE INTO project_paths (project_id, path, canonical_path, fs_dev, fs_ino, active, recorded_at) " +
            "VALUES (?, ?, ?, 0, 0, 0, ?)",
        ).run(payload.project.id, path.path, path.canonicalPath, path.recordedAt);
      }

      for (const thread of payload.threads) {
        db.prepare(
          "INSERT INTO threads (id, project_id, engine_thread_id, title, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          thread.id,
          payload.project.id,
          thread.engineThreadId,
          thread.title,
          thread.createdAt,
          thread.updatedAt,
        );
      }
      for (const task of payload.tasks) {
        db.prepare(
          "INSERT INTO tasks (id, project_id, title, prompt, status, created_at, updated_at, revision) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          task.id,
          payload.project.id,
          task.title,
          task.prompt,
          task.status,
          task.createdAt,
          task.updatedAt,
          task.revision,
        );
      }
      for (const dependency of payload.dependencies) {
        db.prepare(
          "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
        ).run(dependency.taskId, dependency.dependsOnTaskId, now);
      }
      for (const evidence of payload.evidence) {
        db.prepare(
          "INSERT INTO requirement_evidence (id, project_id, task_id, requirement_id, path, digest, note, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          evidence.id,
          payload.project.id,
          evidence.taskId,
          evidence.requirementId,
          evidence.path,
          evidence.digest,
          evidence.note,
          evidence.createdAt,
        );
      }
      for (const attempt of payload.attempts) {
        db.prepare(
          "INSERT INTO attempts (id, project_id, task_id, problem_id, requirement, symptom, hypothesis, " +
            "action, observed, material_progress, evidence_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          attempt.id,
          payload.project.id,
          attempt.taskId,
          attempt.problemId,
          attempt.requirement,
          attempt.symptom,
          attempt.hypothesis,
          attempt.action,
          attempt.observed,
          attempt.materialProgress ? 1 : 0,
          JSON.stringify(attempt.evidence),
          attempt.createdAt,
        );
      }
      for (const decision of payload.decisions) {
        db.prepare(
          "INSERT INTO decisions (id, project_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(decision.id, payload.project.id, decision.title, decision.body, decision.createdAt);
      }
      for (const turn of payload.turns) {
        db.prepare(
          "INSERT INTO turns (id, thread_id, status, provider, model, permission_posture, started_at, ended_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          turn.id,
          turn.threadId,
          turn.status,
          turn.provider,
          turn.model,
          turn.permissionPosture,
          turn.startedAt,
          turn.endedAt,
        );
      }
      for (const usage of payload.usage) {
        db.prepare(
          "INSERT INTO usage_records (id, project_id, thread_id, turn_id, provider, model, input_tokens, " +
            "output_tokens, cached_tokens, reasoning_tokens, cost_usd, cost_complete, captured_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          usage.id,
          payload.project.id,
          usage.threadId,
          usage.turnId,
          usage.provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedTokens,
          usage.reasoningTokens,
          usage.costUsd,
          usage.costComplete ? 1 : 0,
          usage.capturedAt,
        );
      }
      for (const draft of payload.drafts) {
        db.prepare(
          "INSERT INTO drafts (project_id, thread_id, text, updated_at) VALUES (?, ?, ?, ?)",
        ).run(payload.project.id, draft.threadId, draft.text, draft.updatedAt);
      }
      for (const setting of payload.settings) {
        db.prepare(
          "INSERT INTO settings (scope, version, value_json, updated_at) VALUES (?, ?, ?, ?)",
        ).run(setting.scope, setting.version, JSON.stringify(setting.value), setting.updatedAt);
        db.prepare(
          "INSERT INTO settings_versions (scope, version, value_json, recorded_at) VALUES (?, ?, ?, ?)",
        ).run(setting.scope, setting.version, JSON.stringify(setting.value), setting.updatedAt);
      }
      for (const artifact of payload.artifacts) {
        const relPath = this.artifactFiles.find(artifact.digest);
        if (!relPath) {
          missingArtifacts.push(artifact.digest);
          continue;
        }
        db.prepare(
          "INSERT INTO artifacts (id, project_id, task_id, digest, rel_path, size_bytes, media_type, " +
            "source, retention_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          artifact.id,
          payload.project.id,
          artifact.taskId,
          artifact.digest,
          relPath,
          artifact.sizeBytes,
          artifact.mediaType,
          artifact.source,
          artifact.retentionClass,
          artifact.createdAt,
        );
      }
      for (const submission of payload.submissions) {
        db.prepare(
          "INSERT INTO submissions (operation_key, project_id, thread_id, turn_id, status, submitted_at, " +
            "reconciled, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          submission.operationKey,
          payload.project.id,
          submission.threadId,
          submission.turnId,
          submission.status,
          submission.submittedAt,
          submission.reconciled ? 1 : 0,
          submission.note,
        );
      }

      return {
        project: projectFromRow(this.requireProjectRow(db, payload.project.id)),
        mode: existing ? "replace" : "create",
        imported: {
          tasks: payload.tasks.length,
          dependencies: payload.dependencies.length,
          evidence: payload.evidence.length,
          attempts: payload.attempts.length,
          decisions: payload.decisions.length,
          threads: payload.threads.length,
          turns: payload.turns.length,
          drafts: payload.drafts.length,
          settings: payload.settings.length,
          submissions: payload.submissions.length,
        },
        missingArtifacts,
      };
    });
  }

  private deleteProjectContents(db: DatabaseSync, projectId: string): void {
    db.prepare("DELETE FROM submissions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM artifacts WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM drafts WHERE project_id = ?").run(projectId);
    db.prepare(
      "DELETE FROM settings_versions WHERE scope = ? OR scope = ? OR scope LIKE ? ESCAPE '\\'",
    ).run(`project:${projectId}`, `view:${projectId}`, `project:${escapeLike(projectId)}:%`);
    db.prepare("DELETE FROM settings WHERE scope = ? OR scope = ? OR scope LIKE ? ESCAPE '\\'").run(
      `project:${projectId}`,
      `view:${projectId}`,
      `project:${escapeLike(projectId)}:%`,
    );
    db.prepare("DELETE FROM attempts WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM requirement_evidence WHERE project_id = ?").run(projectId);
    db.prepare(
      "DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)",
    ).run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM decisions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM usage_records WHERE project_id = ?").run(projectId);
    db.prepare(
      "DELETE FROM turns WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)",
    ).run(projectId);
    db.prepare("DELETE FROM threads WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_paths WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM runtime_bindings WHERE project_id = ?").run(projectId);
  }

  // ---------------------------------------------------------- backup/restore

  async backupTo(destination: string): Promise<{ destination: string; integrity: string[] }> {
    this.assertOpen();
    return this.barrier.runMaintenance(async () => {
      await backupDatabase(this.db, destination);
      const snapshot = openDatabase({ path: destination, readonly: true });
      try {
        const report = checkIntegrity(snapshot);
        if (!report.ok) {
          throw new StateError("MIGRATION_FAILED", "backup snapshot failed validation", {
            problems: report.problems,
          });
        }
        return { destination, integrity: report.problems };
      } finally {
        snapshot.close();
      }
    });
  }

  async createSnapshot(label = "manual"): Promise<string> {
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "snapshot";
    const destination = join(
      this.options.backupDir,
      `snapshot-${safeLabel}-${this.now().replace(/[:.]/g, "-")}.sqlite`,
    );
    await this.backupTo(destination);
    return destination;
  }

  /**
   * Restore under the maintenance barrier. The current database is moved aside
   * as evidence, the snapshot is copied into place and validated, and the
   * pre-restore copy is put back if validation fails. Writers cannot slip in:
   * the barrier is exclusive for the whole operation.
   */
  async restoreFrom(
    source: string,
  ): Promise<{ restored: boolean; journal: string; preRestore: string }> {
    this.assertOpen();
    return this.barrier.runMaintenance(async () => {
      const stamp = this.now().replace(/[:.]/g, "-");
      const journalPath = join(this.options.backupDir, `restore-journal-${stamp}.json`);
      const preRestore = `${this.options.dbPath}.pre-restore-${stamp}`;
      const journal = {
        schema_version: 1,
        action: "restore",
        source,
        db_path: this.options.dbPath,
        state: "started",
        started_at: this.now(),
        updated_at: this.now(),
        pre_restore_path: preRestore,
        error: null as string | null,
      };
      writeJsonDurable(journalPath, journal);

      this.db.close();
      try {
        // Preserve the current database and its WAL sidecars.
        for (const suffix of ["", "-wal", "-shm"]) {
          const from = `${this.options.dbPath}${suffix}`;
          if (existsSync(from)) renameSync(from, `${preRestore}${suffix}`);
        }
        copyFileSync(source, this.options.dbPath);
        secureFile(this.options.dbPath);
        const outcome = await migrateDatabase({
          dbPath: this.options.dbPath,
          backupDir: this.options.backupDir,
          now: this.options.now,
        });
        this.db = outcome.db;
        assertIntegrity(this.db, "restored database");
        journal.state = "complete";
        journal.updated_at = this.now();
        writeJsonDurable(journalPath, journal);
        return { restored: true, journal: journalPath, preRestore };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        journal.state = "failed";
        journal.error = message;
        journal.updated_at = this.now();
        writeJsonDurable(journalPath, journal);
        // Put the pre-restore database back so a failed restore does not cost
        // the user their verified state.
        try {
          for (const suffix of ["", "-wal", "-shm"]) {
            const target = `${this.options.dbPath}${suffix}`;
            if (existsSync(target)) renameSync(target, `${target}.failed-restore-${stamp}`);
          }
          copyFileSync(preRestore, this.options.dbPath);
          secureFile(this.options.dbPath);
          this.db = openDatabase({ path: this.options.dbPath });
          assertIntegrity(this.db, "pre-restore database");
        } catch (restoreError) {
          journal.error = `${message}; rollback failed: ${
            restoreError instanceof Error ? restoreError.message : String(restoreError)
          }`;
          writeJsonDurable(journalPath, journal);
          throw new StateError("MAINTENANCE_FAILED", "restore failed and rollback failed", {
            journal_path: journalPath,
            pre_restore_path: preRestore,
            cause: journal.error,
          });
        }
        throw new StateError(
          "MAINTENANCE_FAILED",
          "restore failed; previous database was put back",
          {
            journal_path: journalPath,
            pre_restore_path: preRestore,
            cause: message,
          },
        );
      }
    });
  }

  // -------------------------------------------------------------- lifecycle

  async stats(): Promise<{
    projects: number;
    tasks: number;
    events: number;
    artifacts: number;
    settings: number;
    stateRevision: number;
    integrity: string[];
  }> {
    return this.read((db) => {
      const count = (table: string): number => {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        return Number(row.n);
      };
      const revisionRow = db
        .prepare("SELECT value_json FROM meta WHERE key = 'state_revision'")
        .get() as { value_json: string } | undefined;
      return {
        projects: count("projects"),
        tasks: count("tasks"),
        events: count("events"),
        artifacts: count("artifacts"),
        settings: count("settings"),
        stateRevision: revisionRow ? Number(revisionRow.value_json) : 0,
        integrity: checkIntegrity(db).problems,
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.barrier.runMaintenance(() => {
      if (this.closed) return;
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // A checkpoint failure is not a reason to leak the handle.
      }
      this.db.close();
      this.closed = true;
    });
  }
}
