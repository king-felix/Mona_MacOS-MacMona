import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { nativeDiskProbe, type DiskProbe } from "./database";
import { StateError } from "./errors";

const EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-diff": "diff",
};

export interface ArtifactFileStoreOptions {
  root: string;
  probe?: DiskProbe;
  /** Headroom kept free so a write cannot fill the volume. */
  reserveBytes?: number;
  maxArtifactBytes?: number;
}

export interface WrittenArtifact {
  relPath: string;
  digest: string;
  sizeBytes: number;
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function safeRelPath(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [project, file] = parts;
  return (
    project !== undefined &&
    file !== undefined &&
    safeSegment(project) &&
    /^[a-f0-9]{64}\.[a-z0-9]+$/.test(file)
  );
}

/**
 * Bounded artifact files live outside the database. Metadata (digest, size,
 * media type, source, retention) is in SQLite; the bytes are here.
 */
export class ArtifactFileStore {
  private readonly root: string;
  private readonly probe: DiskProbe;
  private readonly reserveBytes: number;
  private readonly maxArtifactBytes: number;

  constructor(options: ArtifactFileStoreOptions) {
    this.root = options.root;
    this.probe = options.probe ?? nativeDiskProbe;
    this.reserveBytes = options.reserveBytes ?? 64 * 1024 * 1024;
    this.maxArtifactBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  get directory(): string {
    return this.root;
  }

  availableBytes(): number {
    return this.probe.freeBytes(this.root);
  }

  absolute(relPath: string): string {
    if (!safeRelPath(relPath)) {
      throw new StateError("INVALID_PATH", "artifact path is not a Mona artifact reference", {
        relPath,
      });
    }
    return join(this.root, relPath);
  }

  write(input: { projectId: string; data: Buffer; mediaType: string }): WrittenArtifact {
    if (!safeSegment(input.projectId)) {
      throw new StateError("INVALID_PATH", "invalid project id for artifact storage", {
        projectId: input.projectId,
      });
    }
    if (input.data.length > this.maxArtifactBytes) {
      throw new StateError("ARTIFACT_TOO_LARGE", "artifact exceeds the configured maximum", {
        size: input.data.length,
        max: this.maxArtifactBytes,
      });
    }
    if (this.availableBytes() - input.data.length < this.reserveBytes) {
      throw new StateError("DISK_FULL", "not enough free space to store the artifact", {
        available: this.availableBytes(),
        required: input.data.length + this.reserveBytes,
      });
    }
    const digest = createHash("sha256").update(input.data).digest("hex");
    const extension = EXTENSIONS[input.mediaType] ?? "blob";
    const relPath = `${input.projectId}/${digest}.${extension}`;
    const dir = join(this.root, input.projectId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(this.root, relPath);
    if (existsSync(target)) {
      // Content-addressed: an identical artifact is already stored.
      return { relPath, digest, sizeBytes: input.data.length };
    }
    const temp = join(
      dir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, input.data);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // Nothing to remove.
      }
      const candidate = error as { code?: string };
      if (candidate.code === "ENOSPC") {
        throw new StateError("DISK_FULL", "the disk filled while writing the artifact");
      }
      throw error;
    }
    closeSync(fd);
    renameSync(temp, target);
    chmodSync(target, 0o600);
    return { relPath, digest, sizeBytes: input.data.length };
  }

  read(relPath: string, options: { verifyDigest?: boolean } = {}): Buffer {
    const path = this.absolute(relPath);
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // A missing file is a named state condition, not a raw ENOENT: the UI
        // must be able to say "this artifact is missing" instead of surfacing a
        // filesystem error it cannot interpret.
        throw new StateError(
          "ARTIFACT_MISSING",
          "the artifact file is missing from local storage",
          {
            relPath,
          },
        );
      }
      throw error;
    }
    if (options.verifyDigest) {
      const digest = createHash("sha256").update(data).digest("hex");
      const expected = relPath.split("/")[1]?.split(".")[0];
      if (digest !== expected) {
        throw new StateError("CORRUPT_DATABASE", "artifact contents do not match its digest", {
          relPath,
          expected,
          actual: digest,
        });
      }
    }
    return data;
  }

  remove(relPath: string): boolean {
    const path = this.absolute(relPath);
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Files on disk, as relative paths. Used to detect orphans left by a crash. */
  list(): string[] {
    if (!existsSync(this.root)) return [];
    const files: string[] = [];
    for (const project of readdirSync(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || !safeSegment(project.name)) continue;
      const dir = join(this.root, project.name);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !safeRelPath(`${project.name}/${entry.name}`)) continue;
        files.push(`${project.name}/${entry.name}`);
      }
    }
    return files.sort();
  }

  /** Locate a stored artifact by content digest (used by import). */
  find(digest: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(digest)) return null;
    return this.list().find((relPath) => relPath.split("/")[1]?.startsWith(`${digest}.`)) ?? null;
  }

  sweepOrphans(referenced: ReadonlySet<string>, options: { minAgeMs?: number } = {}): string[] {
    const minAgeMs = options.minAgeMs ?? 60 * 60 * 1000;
    const cutoff = Date.now() - minAgeMs;
    const removed: string[] = [];
    for (const relPath of this.list()) {
      if (referenced.has(relPath)) continue;
      const path = join(this.root, relPath);
      try {
        if (statSync(path).mtimeMs > cutoff) continue;
        unlinkSync(path);
        removed.push(relPath);
      } catch {
        // A file removed concurrently is already gone.
      }
    }
    return removed;
  }
}
