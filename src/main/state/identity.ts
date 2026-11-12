import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { StateError } from "./errors";

export type RepositoryKind = "none" | "git" | "git_worktree";

export interface RepositoryInfo {
  kind: RepositoryKind;
  root: string | null;
  worktreeName: string | null;
}

export interface PathIdentity {
  /** The path as supplied, for display and relocation history. */
  input: string;
  /** Symlink-free absolute path (macOS case-preserving canonical form). */
  canonical: string;
  dev: number;
  ino: number;
  repository: RepositoryInfo;
}

function readGitFile(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(text);
    return match?.[1] ? resolve(dirname(path), match[1]) : null;
  } catch {
    return null;
  }
}

function inspectRepository(canonical: string): RepositoryInfo {
  let current = canonical;
  for (;;) {
    const dotGit = join(current, ".git");
    if (existsSync(dotGit)) {
      const stats = statSync(dotGit);
      if (stats.isDirectory()) {
        return { kind: "git", root: current, worktreeName: null };
      }
      if (stats.isFile()) {
        // A linked worktree points at <main>/.git/worktrees/<name>. Its
        // commondir file points back at the shared repository.
        const gitdir = readGitFile(dotGit);
        if (gitdir) {
          let repositoryRoot: string | null = null;
          const commonDirFile = join(gitdir, "commondir");
          if (existsSync(commonDirFile)) {
            try {
              const commonDir = resolve(gitdir, readFileSync(commonDirFile, "utf8").trim());
              // `commondir` names the shared `.git` directory; the repository
              // root is its parent.
              repositoryRoot = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
            } catch {
              repositoryRoot = null;
            }
          }
          if (!repositoryRoot) {
            // Fall back to `<main>/.git/worktrees/<name>` -> `<main>`.
            const candidate = dirname(dirname(gitdir));
            repositoryRoot = basename(candidate) === ".git" ? dirname(candidate) : null;
          }
          return {
            kind: "git_worktree",
            root: repositoryRoot ? safeRealpath(repositoryRoot) : null,
            worktreeName: basename(gitdir),
          };
        }
        return { kind: "git", root: current, worktreeName: null };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { kind: "none", root: null, worktreeName: null };
    current = parent;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Canonicalize a project folder and read its filesystem identity. Two paths
 * that name the same directory (trailing slash, `..`, a symlink) produce the
 * same `(dev, ino)` pair, so they cannot become two catalog entries.
 */
export function identifyPath(input: string): PathIdentity {
  if (!isAbsolute(input)) {
    throw new StateError("INVALID_PATH", "project folders must be absolute paths", { path: input });
  }
  let canonical: string;
  let stats: ReturnType<typeof statSync>;
  try {
    canonical = realpathSync.native(input);
    stats = statSync(canonical);
  } catch (error) {
    throw new StateError("INVALID_PATH", "project folder does not exist", {
      path: input,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!stats.isDirectory()) {
    throw new StateError("INVALID_PATH", "project root must be a folder", { path: input });
  }
  return {
    input,
    canonical,
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    repository: inspectRepository(canonical),
  };
}

export function identifyOptionalPath(input: string): PathIdentity | null {
  try {
    return identifyPath(input);
  } catch {
    return null;
  }
}
