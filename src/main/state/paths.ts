import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { StateError } from "./errors";

/**
 * Per-user product storage. The database lives under Application Support for
 * the current user, never inside the app bundle, a shared system payload, or a
 * cloud-synced folder (SQLite is not safe on a sync/network filesystem).
 */
export interface ProductPaths {
  home: string;
  support: string;
  cache: string;
  logs: string;
  state: string;
  database: string;
  backups: string;
  artifacts: string;
}

export interface ProductPathOptions {
  home: string;
  appName?: string;
  /** Electron's resolved userData directory, when available. */
  supportDir?: string;
  /** Test/inspection hook for the filesystem type query. */
  filesystemType?: (path: string) => string | null;
}

const NETWORK_FILESYSTEMS = new Set(["nfs", "smbfs", "afpfs", "cifs", "webdav", "ftp"]);

export function localFilesystemType(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return execFileSync("/usr/bin/stat", ["-f", "%T", path], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** SQLite must live on a local volume, not a network mount. */
export function assertLocalFilesystem(
  path: string,
  probe: (path: string) => string | null = localFilesystemType,
): void {
  const type = probe(path);
  if (type && NETWORK_FILESYSTEMS.has(type.toLowerCase())) {
    throw new StateError("INVALID_PATH", "Mona state cannot live on a network filesystem", {
      path,
      filesystem: type,
    });
  }
}

const CLOUD_FRAGMENTS = [
  "Library/Mobile Documents",
  "Library/CloudStorage",
  "/Dropbox",
  "/Google Drive",
  "/OneDrive",
  "/iCloud Drive",
];

export function assertLocalDataLocation(path: string): void {
  const normalized = resolve(path);
  for (const fragment of CLOUD_FRAGMENTS) {
    if (`${normalized}${sep}`.includes(`${fragment}${sep}`) || normalized.endsWith(fragment)) {
      throw new StateError("INVALID_PATH", "Mona state cannot live in a cloud-synced folder", {
        path: normalized,
        fragment,
      });
    }
  }
  if (normalized.includes(".app/Contents")) {
    throw new StateError("INVALID_PATH", "Mona state cannot live inside the app bundle", {
      path: normalized,
    });
  }
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Non-POSIX volume; reported by verifyPrivatePermissions.
  }
  return dir;
}

export function resolveProductPaths(options: ProductPathOptions): ProductPaths {
  const appName = options.appName ?? "Mona";
  const home = resolve(options.home);
  const support = resolve(
    options.supportDir ?? join(home, "Library", "Application Support", appName),
  );
  assertLocalDataLocation(support);
  assertLocalFilesystem(support, options.filesystemType);
  const cache = join(home, "Library", "Caches", appName);
  const logs = join(home, "Library", "Logs", appName);
  const state = join(support, "state");
  for (const dir of [support, cache, logs, state]) ensure(dir);
  return {
    home,
    support,
    cache,
    logs,
    state,
    database: join(state, "mona.sqlite"),
    backups: join(state, "backups"),
    artifacts: join(support, "artifacts"),
  };
}

export interface PermissionProblem {
  path: string;
  mode: string;
  expected: string;
}

/** Modes are checked, not assumed: another macOS user must not be able to read them. */
export function verifyPrivatePermissions(paths: ProductPaths): PermissionProblem[] {
  const problems: PermissionProblem[] = [];
  const check = (path: string, expectedMode: number) => {
    if (!existsSync(path)) return;
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0 || mode !== expectedMode) {
      problems.push({
        path,
        mode: mode.toString(8).padStart(3, "0"),
        expected: expectedMode.toString(8).padStart(3, "0"),
      });
    }
  };
  for (const dir of [paths.support, paths.state, paths.backups]) check(dir, 0o700);
  check(paths.database, 0o600);
  return problems;
}
