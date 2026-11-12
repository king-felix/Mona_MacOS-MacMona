import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Durable atomic write: temp file in the same directory, fsync the file,
 * rename, fsync the directory. A crash leaves either the old file or the new
 * one, never a truncated journal.
 */
export function writeFileDurable(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fd = openSync(temp, "w", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  chmodSync(path, mode);
  try {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best effort; the file is already durable.
  }
}

export function writeJsonDurable(path: string, value: unknown, mode = 0o600): void {
  writeFileDurable(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
