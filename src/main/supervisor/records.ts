import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isSameProcess, readExecutablePath, readProcessEntry, type ProcessEntry } from "./identity";

export type OwnershipState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface RuntimeIdentity {
  version: string;
  commit: string;
  permissionPosture?: string | null;
}

/**
 * A durable ownership record. It deliberately has no token field: the runtime
 * bearer token lives only in the owning process, so a stolen or copied state
 * file cannot attach to or impersonate an owned runtime.
 */
export interface OwnershipRecord {
  id: string;
  workspace: string;
  canonicalWorkspace: string;
  executable: string;
  executableSha256: string;
  supervisorPid: number;
  supervisorStartedAt: string;
  childPid: number;
  childStartedAt: string;
  pgid: number;
  port: number;
  baseUrl: string;
  controlSocket: string;
  startedAt: string;
  updatedAt: string;
  state: OwnershipState;
  engine: RuntimeIdentity | null;
  startupReceipt: Record<string, unknown> | null;
  stopReceipt: Record<string, unknown> | null;
}

export interface StoreSnapshot {
  revision: number;
  records: OwnershipRecord[];
  /** Set when the file was unreadable and preserved for diagnosis. */
  corruptionBackup: string | null;
}

interface StoreFile {
  schema_version: 1;
  revision: number;
  records: OwnershipRecord[];
}

export class OwnershipStore {
  constructor(private readonly filePath: string) {}

  path(): string {
    return this.filePath;
  }

  read(): StoreSnapshot {
    if (!existsSync(this.filePath)) {
      return { revision: 0, records: [], corruptionBackup: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
      if (parsed.schema_version !== 1 || !Array.isArray(parsed.records)) throw new Error("shape");
      return {
        revision: Number(parsed.revision) || 0,
        records: parsed.records.filter(isRecord),
        corruptionBackup: null,
      };
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, backup);
      } catch {
        // Nothing else to preserve.
      }
      return { revision: 0, records: [], corruptionBackup: backup };
    }
  }

  list(): OwnershipRecord[] {
    return this.read().records;
  }

  get(id: string): OwnershipRecord | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  forWorkspace(canonicalWorkspace: string): OwnershipRecord | null {
    return (
      this.list().find(
        (record) =>
          record.canonicalWorkspace === canonicalWorkspace &&
          (record.state === "starting" ||
            record.state === "running" ||
            record.state === "stopping"),
      ) ?? null
    );
  }

  live(): OwnershipRecord[] {
    return this.list().filter(
      (record) => record.state === "starting" || record.state === "running",
    );
  }

  put(record: OwnershipRecord): OwnershipRecord {
    const snapshot = this.read();
    const records = snapshot.records.filter((candidate) => candidate.id !== record.id);
    records.push(record);
    this.write(records, snapshot.revision + 1);
    return record;
  }

  remove(id: string): void {
    const snapshot = this.read();
    const records = snapshot.records.filter((record) => record.id !== id);
    this.write(records, snapshot.revision + 1);
  }

  /** Drop stopped records older than the retention window. */
  pruneStopped(retentionMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
    const snapshot = this.read();
    const keep = snapshot.records.filter((record) => {
      if (record.state !== "stopped" && record.state !== "failed") return true;
      const updated = Date.parse(record.updatedAt);
      return Number.isFinite(updated) ? now - updated < retentionMs : true;
    });
    if (keep.length !== snapshot.records.length) this.write(keep, snapshot.revision + 1);
    return snapshot.records.length - keep.length;
  }

  private write(records: OwnershipRecord[], revision: number): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload: StoreFile = { schema_version: 1, revision, records };
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on exotic filesystems.
    }
  }
}

function isRecord(value: unknown): value is OwnershipRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OwnershipRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.workspace === "string" &&
    typeof record.canonicalWorkspace === "string" &&
    typeof record.executable === "string" &&
    typeof record.executableSha256 === "string" &&
    Number.isInteger(record.supervisorPid) &&
    typeof record.supervisorStartedAt === "string" &&
    Number.isInteger(record.childPid) &&
    typeof record.childStartedAt === "string" &&
    Number.isInteger(record.pgid) &&
    Number.isInteger(record.port) &&
    typeof record.controlSocket === "string" &&
    typeof record.state === "string"
  );
}

export function newRecordId(): string {
  return `rt_${randomBytes(6).toString("hex")}`;
}

export function executableDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export type OwnershipVerdict =
  "live_owned" | "orphaned_owned" | "stopped" | "pid_reused" | "foreign_executable" | "unknown";

export interface OwnershipEvidence {
  verdict: OwnershipVerdict;
  supervisorAlive: boolean;
  childAlive: boolean;
  note: string;
}

export interface VerdictDependencies {
  readEntry?: (pid: number) => ProcessEntry | null;
  readExecutable?: (pid: number) => string | null;
}

/**
 * Decide what an on-disk record means now. The only verdict that permits a
 * signal is one where pid *and* start time still match our record.
 */
export function classifyOwnership(
  record: OwnershipRecord,
  dependencies: VerdictDependencies = {},
): OwnershipEvidence {
  const entryFor = dependencies.readEntry ?? readProcessEntry;
  const executableFor = dependencies.readExecutable ?? readExecutablePath;

  if (record.state === "stopped") {
    return {
      verdict: "stopped",
      supervisorAlive: false,
      childAlive: false,
      note: `record already ${record.state}`,
    };
  }

  const supervisorEntry = entryFor(record.supervisorPid);
  const supervisorAlive = isSameProcess(
    { pid: record.supervisorPid, startedAt: record.supervisorStartedAt },
    supervisorEntry,
  );
  const childEntry = entryFor(record.childPid);
  if (childEntry) {
    if (!isSameProcess({ pid: record.childPid, startedAt: record.childStartedAt }, childEntry)) {
      return {
        verdict: "pid_reused",
        supervisorAlive,
        childAlive: false,
        note: "child pid is live under a different start time; refusing to signal it",
      };
    }
    const actual = executableFor(record.childPid);
    if (actual && actual !== record.executable) {
      return {
        verdict: "foreign_executable",
        supervisorAlive,
        childAlive: true,
        note: `pid ${record.childPid} now runs ${actual}, not ${record.executable}`,
      };
    }
    return {
      verdict: supervisorAlive ? "live_owned" : "orphaned_owned",
      supervisorAlive,
      childAlive: true,
      note: supervisorAlive
        ? "supervisor and child identities match the record"
        : "child identity matches but the supervisor is gone; stop it through the verified identity",
    };
  }

  if (supervisorAlive) {
    return {
      verdict: "live_owned",
      supervisorAlive: true,
      childAlive: false,
      note: "supervisor identity matches but the child has exited",
    };
  }
  return {
    verdict: "stopped",
    supervisorAlive: false,
    childAlive: false,
    note: "neither supervisor nor child identity is alive",
  };
}

/**
 * Unix-domain socket paths are limited to ~104 bytes. A deeply nested user
 * data path falls back to the per-user temp directory rather than failing the
 * runtime start with an opaque bind error.
 */
export function controlSocketPath(stateDir: string, id: string): string {
  const inState = join(runtimeRunDir(stateDir), `${id}.sock`);
  if (Buffer.byteLength(inState) < 100) return inState;
  return join(tmpdir(), `mona-${id}.sock`);
}

export function runtimeRunDir(stateDir: string): string {
  const dir = join(stateDir, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort.
  }
  return dir;
}
