import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readExecutablePath, readProcessEntry } from "../supervisor/identity";

/**
 * The Codewhale engine keeps one Runtime store per user home, and exactly one
 * live process owns it. A second engine host in the same home (a desktop
 * window, `codewhale web`, `serve --http`, another Mona) does not get its own
 * store: the existing owner serves its port instead. Mona must never mistake
 * that arrangement for its own runtime, and its failure message has to name
 * the real cause rather than blaming the port.
 *
 * This module only *observes* the owner lock — it never signals or claims it.
 */

/** The engine home. An absolute CODEWHALE_HOME wins, as the engine itself does. */
export function codewhaleHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.CODEWHALE_HOME;
  return fromEnv && fromEnv.startsWith("/") ? resolve(fromEnv) : join(home, ".codewhale");
}

export interface RuntimeStorePaths {
  /** `<home>/tasks/runtime` — the shared Runtime store directory. */
  directory: string;
  /** Durable owner id. Present whenever a store exists, live or not. */
  ownerFile: string;
  /**
   * The lock the live owner keeps open for the life of its process. Its holder
   * is the store owner; a path with no holder belongs to a stopped store.
   */
  ownerLock: string;
}

export function runtimeStorePaths(home = codewhaleHome()): RuntimeStorePaths {
  const directory = join(home, "tasks", "runtime");
  return {
    directory,
    ownerFile: join(directory, "owner.json"),
    ownerLock: join(directory, "runtime-process.owner.lock"),
  };
}

export interface RuntimeStoreOwner {
  pid: number;
  /** Executable path reported by `ps`, when it can be read. */
  executable: string | null;
  /** Full command line, bounded; useful because several hosts share one binary. */
  command: string | null;
  home: string;
  lockPath: string;
}

/** Test seam: return the pids holding the lock file open. */
export type LockHolderReader = (lockPath: string) => number[];

const MAX_COMMAND = 160;

/**
 * `lsof` reports which process has a file open without touching the file.
 * Exit status 1 means "nothing holds it", which is an ordinary answer.
 */
export function lockHoldersWithLsof(lockPath: string): number[] {
  const result = spawnSync("lsof", ["-nP", "-Fp", "--", lockPath], { encoding: "utf8" });
  const holders = (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.startsWith("p"))
    .map((line) => Number(line.slice(1)))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  return [...new Set(holders)];
}

function processCommand(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const text = (result.stdout ?? "").trim();
  if (text.length === 0) return null;
  return text.length > MAX_COMMAND ? `${text.slice(0, MAX_COMMAND - 1)}…` : text;
}

export interface RuntimeStoreProbe {
  /** Override the engine home; defaults to CODEWHALE_HOME or `~/.codewhale`. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the lock holder lookup. */
  holders?: LockHolderReader;
}

/**
 * The live Runtime-store owner, or null when nothing owns the store.
 * Probing is best-effort: a missing tool or an unreadable file is "unknown",
 * never a reason to refuse a start.
 */
export function runtimeStoreOwner(options: RuntimeStoreProbe = {}): RuntimeStoreOwner | null {
  const home = options.home ?? codewhaleHome(options.env ?? process.env);
  const paths = runtimeStorePaths(home);
  if (!existsSync(paths.ownerLock)) return null;
  let holders: number[];
  try {
    holders = (options.holders ?? lockHoldersWithLsof)(paths.ownerLock);
  } catch {
    return null;
  }
  const live = holders.filter((pid) => pid !== process.pid && readProcessEntry(pid) !== null);
  if (live.length === 0) return null;
  // The oldest holder is the owner; a second descriptor on the same path is a
  // guest, and the owner is the process that created the store.
  const pid = live.sort((a, b) => a - b)[0] as number;
  return {
    pid,
    executable: readExecutablePath(pid),
    command: processCommand(pid),
    home,
    lockPath: paths.ownerLock,
  };
}

/** A bounded, human-readable identity for the owner. */
export function describeRuntimeStoreOwner(owner: RuntimeStoreOwner): string {
  const executable = owner.executable ?? "an unidentified process";
  const command = owner.command && owner.command !== owner.executable ? ` — ${owner.command}` : "";
  return `pid ${owner.pid}, ${executable}${command}`;
}
