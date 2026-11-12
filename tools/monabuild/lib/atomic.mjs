// Atomic file replacement, advisory single-writer locking, and strict reads.
// The checkpoint contract: a reader must only ever observe a complete, valid
// previous state or a complete, valid new state.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

export function readJsonStrict(path) {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

export function writeFileDurable(path, contents, { exclusive = false } = {}) {
  const flags = exclusive ? "wx" : "w";
  const fd = openSync(path, flags, 0o644);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDir(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort; not every filesystem permits it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Replace `path` with `contents` atomically. When `backup` is set, the previous
// file survives as `<path>.bak` (also written atomically) before the swap.
export function atomicWrite(path, contents, { backup = true } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const tmp = join(dir, `.${basename(path)}.tmp-${token}`);
  writeFileDurable(tmp, contents, { exclusive: true });
  if (backup) {
    try {
      const previous = readFileSync(path);
      const backupPath = `${path}.bak`;
      const backupTmp = join(dir, `.${basename(path)}.bak.tmp-${token}`);
      writeFileDurable(backupTmp, previous, { exclusive: true });
      renameSync(backupTmp, backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        rmSync(tmp, { force: true });
        throw error;
      }
    }
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

export function atomicWriteJson(path, value, options = {}) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function lockPathFor(statePath) {
  return `${statePath}.lock`;
}

// Single-writer lock via mkdir (atomic on APFS). A lock is stale when its
// recorded pid is gone or it is older than ttlMs.
export function acquireLock(statePath, { ttlMs = 120_000 } = {}) {
  const lockPath = lockPathFor(statePath);
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const infoPath = join(lockPath, "owner.json");
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(infoPath, "utf8"));
    } catch {
      owner = null;
    }
    const age = Date.now() - safeMtime(lockPath);
    const alive = owner && typeof owner.pid === "number" && processAlive(owner.pid);
    if (alive && age < ttlMs) {
      const error2 = new Error(
        `state is locked by pid ${owner.pid} (${Math.round(age / 1000)}s old): ${lockPath}`,
      );
      error2.code = "ELOCKED";
      throw error2;
    }
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
  }
  writeFileDurable(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: process.pid, started_utc: new Date().toISOString() }),
    { exclusive: true },
  );
  return () => rmSync(lockPath, { recursive: true, force: true });
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Leftover temp files from an interrupted checkpoint. Their presence is
// evidence of an interruption, never a reason to discard the committed state.
export function findTempArtifacts(path) {
  const dir = dirname(path);
  const prefix = `.${basename(path)}.tmp-`;
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}
