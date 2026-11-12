import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Read-mostly Git access for the changes surface.
 *
 * Only these commands are ever issued: `rev-parse`, `status`, `diff`, `log`,
 * `add`, and `commit`. There is no reset, checkout, clean, stash, rebase, or
 * force operation anywhere in this module, so a routine review cannot destroy
 * Victor's work. Paths are literal (no glob interpretation) and always follow
 * `--`, so a filename that looks like a flag is a filename.
 */

export interface GitEntryStatus {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitHead {
  commit: string;
  shortCommit: string;
  subject: string;
  committedAt: string;
}

export interface GitStatusReport {
  available: boolean;
  reason: string | null;
  root: string | null;
  branch: string | null;
  detached: boolean;
  /** Linked worktree name, or null for a main checkout. */
  worktree: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  head: GitHead | null;
  entries: GitEntryStatus[];
  /** The status listing hit the output cap; the entry list is partial. */
  truncated: boolean;
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
  binary: boolean;
  note: string | null;
}

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export class GitError extends Error {
  constructor(
    readonly code:
      "GIT_MISSING" | "NOT_A_REPOSITORY" | "INVALID_PATH" | "COMMAND_FAILED" | "NOTHING_TO_COMMIT",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const GIT_CANDIDATES = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
const MAX_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 8_000;

export function resolveGitBinary(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const candidate of GIT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Validate a workspace-relative path before it reaches Git. Absolute paths,
 * `..`, empty components, `.git`, and NUL bytes are refused. A trailing slash
 * is normalized away; the caller still passes the original to the engine.
 */
export function validateGitPath(path: string): string | null {
  if (typeof path !== "string") return null;
  if (path.length === 0 || path.length > 4096) return null;
  if (path.includes("\0") || isAbsolute(path)) return null;
  if (path.startsWith("/") || path.endsWith("/")) return null;
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part === ".git")) {
    return null;
  }
  return path;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
}

/** Spawn with a hard output cap and timeout; never a shell, never a pager. */
export function runGit(
  binary: string,
  args: string[],
  options: { cwd: string; maxBytes?: number; timeoutMs?: number },
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const cap = options.maxBytes ?? MAX_OUTPUT_BYTES;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes >= cap) {
        truncated = true;
        return;
      }
      const room = cap - outBytes;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, room));
        outBytes = cap;
        truncated = true;
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes >= 16 * 1024) return;
      const room = 16 * 1024 - errBytes;
      err.push(chunk.subarray(0, room));
      errBytes += Math.min(chunk.length, room);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: error.message,
        truncated,
        timedOut,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated,
        timedOut,
      });
    });
  });
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0]?.trim() ?? "";
}

function parseStatus(
  stdout: string,
  prefix: string,
): {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  headOid: string | null;
  entries: GitEntryStatus[];
} {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let headOid: string | null = null;
  const entries: GitEntryStatus[] = [];
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith("# ")) {
      const header = token.slice(2);
      if (header.startsWith("branch.oid ")) headOid = header.slice("branch.oid ".length);
      else if (header.startsWith("branch.head ")) {
        const value = header.slice("branch.head ".length);
        detached = value === "(detached)";
        branch = detached ? null : value;
      } else if (header.startsWith("branch.upstream ")) {
        upstream = header.slice("branch.upstream ".length);
      } else if (header.startsWith("branch.ab ")) {
        const match = /^\+(\d+) -(\d+)$/.exec(header.slice("branch.ab ".length));
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }
    let record: { xy: string; path: string; original: string | null } | null = null;
    if (token.startsWith("1 ")) {
      const parts = token.slice(2).split(" ");
      if (parts.length >= 8)
        record = { xy: parts[0] ?? "..", path: parts.slice(7).join(" "), original: null };
    } else if (token.startsWith("2 ")) {
      const parts = token.slice(2).split(" ");
      if (parts.length >= 9) {
        record = {
          xy: parts[0] ?? "..",
          path: parts.slice(8).join(" "),
          original: tokens[index + 1] ?? null,
        };
        index += 1;
      }
    } else if (token.startsWith("u ")) {
      const parts = token.slice(2).split(" ");
      if (parts.length >= 10)
        record = { xy: parts[0] ?? "..", path: parts.slice(9).join(" "), original: null };
    } else if (token.startsWith("? ")) {
      record = { xy: "??", path: token.slice(2), original: null };
    }
    if (!record) continue;
    if (prefix && !record.path.startsWith(prefix)) continue;
    const relative = prefix ? record.path.slice(prefix.length) : record.path;
    const original = record.original
      ? prefix && record.original.startsWith(prefix)
        ? record.original.slice(prefix.length)
        : record.original
      : null;
    if (!relative) continue;
    const indexStatus = record.xy[0] ?? ".";
    const worktreeStatus = record.xy[1] ?? ".";
    const untracked = indexStatus === "?" && worktreeStatus === "?";
    const conflicted =
      record.xy === "UU" ||
      record.xy === "AA" ||
      record.xy === "DD" ||
      record.xy === "AU" ||
      record.xy === "UA" ||
      record.xy === "DU" ||
      record.xy === "UD";
    entries.push({
      path: relative,
      originalPath: original,
      indexStatus: untracked ? "." : indexStatus,
      worktreeStatus: untracked ? "?" : worktreeStatus,
      staged: !untracked && indexStatus !== ".",
      unstaged: !untracked && worktreeStatus !== ".",
      untracked,
      conflicted,
    });
  }
  return { branch, detached, upstream, ahead, behind, headOid, entries };
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export class GitService {
  private readonly binary: string | null;

  constructor(options: { binary?: string } = {}) {
    this.binary = resolveGitBinary(options.binary);
  }

  get available(): boolean {
    return this.binary !== null;
  }

  private require(): string {
    if (!this.binary) {
      throw new GitError("GIT_MISSING", "Git was not found at a known system location");
    }
    return this.binary;
  }

  async head(cwd: string): Promise<GitHead | null> {
    const binary = this.require();
    const result = await runGit(binary, ["log", "-1", "--format=%H%x00%h%x00%s%x00%cI"], { cwd });
    if (result.exitCode !== 0 || !result.stdout) return null;
    const [commit, shortCommit, subject, committedAt] = result.stdout.split("\0");
    if (!commit || !shortCommit) return null;
    return {
      commit,
      shortCommit,
      subject: subject ?? "",
      committedAt: committedAt ?? "",
    };
  }

  async status(cwd: string): Promise<GitStatusReport> {
    if (!this.binary) {
      return {
        available: false,
        reason: "Git was not found at a known system location",
        root: null,
        branch: null,
        detached: false,
        worktree: null,
        upstream: null,
        ahead: null,
        behind: null,
        head: null,
        entries: [],
        truncated: false,
      };
    }
    const binary = this.binary;
    const inside = await runGit(binary, ["rev-parse", "--is-inside-work-tree"], { cwd });
    if (inside.exitCode !== 0 || firstLine(inside.stdout) !== "true") {
      return {
        available: false,
        reason:
          firstLine(inside.stderr) ||
          "this folder is not a Git worktree; Mona does not initialize one",
        root: null,
        branch: null,
        detached: false,
        worktree: null,
        upstream: null,
        ahead: null,
        behind: null,
        head: null,
        entries: [],
        truncated: false,
      };
    }
    const [rootResult, prefixResult, statusResult, headResult] = await Promise.all([
      runGit(binary, ["rev-parse", "--show-toplevel"], { cwd }),
      runGit(binary, ["rev-parse", "--show-prefix"], { cwd }),
      runGit(
        binary,
        [
          "-c",
          "core.quotepath=false",
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
          "--",
          ".",
        ],
        { cwd, maxBytes: 2 * 1024 * 1024 },
      ),
      this.head(cwd),
    ]);
    if (statusResult.exitCode !== 0) {
      return {
        available: false,
        reason: firstLine(statusResult.stderr) || `git status exited ${statusResult.exitCode}`,
        root: null,
        branch: null,
        detached: false,
        worktree: null,
        upstream: null,
        ahead: null,
        behind: null,
        head: null,
        entries: [],
        truncated: false,
      };
    }
    const root = firstLine(rootResult.stdout) || null;
    const prefix = prefixResult.stdout.replace(/\r?\n$/, "");
    const parsed = parseStatus(statusResult.stdout, prefix);
    const worktree = await this.worktreeName(cwd);
    return {
      available: true,
      reason: null,
      root: root ? (realpathOrNull(root) ?? root) : null,
      branch: parsed.branch,
      detached: parsed.detached,
      worktree,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      head: headResult,
      entries: parsed.entries,
      truncated: statusResult.truncated || statusResult.timedOut,
    };
  }

  /** The linked worktree name, or null for the main checkout. */
  async worktreeName(cwd: string): Promise<string | null> {
    const binary = this.require();
    const result = await runGit(binary, ["rev-parse", "--git-dir", "--git-common-dir"], { cwd });
    if (result.exitCode !== 0) return null;
    const [gitDir, commonDir] = result.stdout.trim().split("\n");
    if (!gitDir || !commonDir) return null;
    if (gitDir === commonDir) return null;
    const parts = gitDir.split("/");
    const index = parts.lastIndexOf("worktrees");
    const name = index >= 0 ? parts[index + 1] : undefined;
    return name ? name : null;
  }

  async diff(
    cwd: string,
    path: string,
    options: { staged: boolean; maxBytes?: number },
  ): Promise<GitDiffResult> {
    const target = validateGitPath(path);
    if (!target) throw new GitError("INVALID_PATH", `refusing unsafe Git path: ${path}`);
    const binary = this.require();
    const args = [
      "--literal-pathspecs",
      "diff",
      ...(options.staged ? ["--cached"] : []),
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      target,
    ];
    const result = await runGit(binary, args, {
      cwd,
      maxBytes: options.maxBytes ?? MAX_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) {
      throw new GitError("COMMAND_FAILED", firstLine(result.stderr) || "git diff failed", {
        path: target,
      });
    }
    const binaryMarker = /^Binary files .* differ$/m.test(result.stdout);
    return {
      diff: result.stdout,
      truncated: result.truncated || result.timedOut,
      binary: binaryMarker,
      note: result.timedOut ? "git diff reached its time limit" : null,
    };
  }

  async lastCommitForPath(
    cwd: string,
    path: string,
  ): Promise<{ hash: string; shortCommit: string; subject: string; committedAt: string } | null> {
    const target = validateGitPath(path);
    if (!target) return null;
    const binary = this.require();
    const result = await runGit(
      binary,
      ["--literal-pathspecs", "log", "-1", "--format=%H%x00%h%x00%s%x00%cI", "--", target],
      { cwd, timeoutMs: 5_000 },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    const [commit, shortCommit, subject, committedAt] = result.stdout.split("\0");
    if (!commit || !shortCommit) return null;
    return { hash: commit, shortCommit, subject: subject ?? "", committedAt: committedAt ?? "" };
  }

  async stage(cwd: string, paths: string[]): Promise<{ staged: string[] }> {
    const safe = this.requirePaths(paths);
    const binary = this.require();
    const result = await runGit(binary, ["--literal-pathspecs", "add", "--", ...safe], { cwd });
    if (result.exitCode !== 0) {
      throw new GitError("COMMAND_FAILED", firstLine(result.stderr) || "git add failed", {
        paths: safe,
      });
    }
    return { staged: safe };
  }

  /**
   * Commit exactly the named paths. The pathspec form leaves every other index
   * entry untouched, so unrelated staged work survives. The caller is
   * responsible for telling the user that each named file is committed at its
   * current working-tree content.
   */
  async commit(
    cwd: string,
    message: string,
    paths: string[],
  ): Promise<{ commit: GitHead | null; summary: string }> {
    const safe = this.requirePaths(paths);
    if (message.trim().length === 0) {
      throw new GitError("COMMAND_FAILED", "a commit message is required");
    }
    const binary = this.require();
    const result = await runGit(
      binary,
      ["--literal-pathspecs", "commit", "-m", message, "--", ...safe],
      { cwd, timeoutMs: 30_000 },
    );
    const summary = `${result.stdout}${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      if (/nothing to commit|no changes added|nothing added to commit/i.test(summary)) {
        throw new GitError("NOTHING_TO_COMMIT", summary || "nothing to commit", { paths: safe });
      }
      throw new GitError("COMMAND_FAILED", firstLine(summary) || "git commit failed", {
        paths: safe,
        exit: result.exitCode,
      });
    }
    return { commit: await this.head(cwd), summary };
  }

  private requirePaths(paths: string[]): string[] {
    if (paths.length === 0) {
      throw new GitError("INVALID_PATH", "no paths were selected");
    }
    const safe: string[] = [];
    for (const path of paths) {
      const checked = validateGitPath(path);
      if (!checked) throw new GitError("INVALID_PATH", `refusing unsafe Git path: ${path}`);
      safe.push(checked);
    }
    return safe;
  }
}

/** Used by tests and the smoke script to prove a plain command is available. */
export async function gitVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 3_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}
