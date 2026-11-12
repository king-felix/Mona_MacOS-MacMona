import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { WELL_KNOWN_DIRS } from "../tool-discovery";

/**
 * The one owner of a native PTY helper process.
 *
 * This module owns process facts only: spawn, the two byte pipes, the control
 * channel, and the exit receipt. It has no engine, state-store, or IPC reach, so
 * terminal bytes cannot become application actions here even by mistake.
 */

export const DEFAULT_SHELL = "/bin/zsh";
/** `-f` skips /etc/zshrc and ~/.zshrc; startup files are never sourced. */
export const DEFAULT_SHELL_ARGS = ["-f"];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export class PtyError extends Error {
  constructor(
    readonly code: "PTY_UNAVAILABLE" | "PTY_SPAWN_FAILED" | "PTY_NOT_RUNNING" | "PTY_PROTOCOL",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PtyError";
  }
}

export interface ShellEnvironment {
  /** KEY=VALUE entries handed to execve, in order. Nothing else is passed. */
  entries: string[];
  /** Allowlisted variable names, for display. */
  variables: string[];
  /** Secret-shaped names present in Mona's own environment and withheld. */
  withheld: string[];
  path: string;
}

function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/**
 * A documented, controlled environment. Shell startup files are not read, and
 * Mona's own process environment is never inherited wholesale: a provider key
 * or runtime token present here is withheld by construction, not by a filter
 * that a future contributor could weaken.
 */
export function buildShellEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  shell = DEFAULT_SHELL,
): ShellEnvironment {
  const inherited = (source.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0 && isAbsolute(dir));
  const path = Array.from(new Set([...inherited, ...WELL_KNOWN_DIRS])).join(":");
  const locale =
    source.LANG && /^[A-Za-z]{2,3}(_[A-Za-z0-9]+)?(\.[A-Za-z0-9-]+)?$/.test(source.LANG)
      ? source.LANG
      : "en_US.UTF-8";
  let user = "user";
  let home = homedir();
  try {
    const info = userInfo();
    user = info.username || user;
    home = info.homedir || home;
  } catch {
    // A missing passwd entry must not stop the terminal from opening.
  }
  const values: Array<[string, string]> = [
    ["PATH", path],
    ["HOME", home],
    ["USER", user],
    ["LOGNAME", user],
    ["SHELL", shell],
    ["TERM", "xterm-256color"],
    ["COLORTERM", "truecolor"],
    ["LANG", locale],
    ["TMPDIR", tmpdir()],
  ];
  const withheld = Object.keys(source)
    .filter((name) => looksSecret(name))
    .sort();
  return {
    entries: values.map(([name, value]) => `${name}=${value}`),
    variables: values.map(([name]) => name),
    withheld,
    path,
  };
}

/**
 * Locate the compiled native PTY helper. Packaged builds ship it beside the app
 * resources; development builds use the checked-out native directory.
 */
export function resolvePtyBinary(explicitPath?: string): string {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.MONA_PTY_BIN) candidates.push(process.env.MONA_PTY_BIN);
  if (process.resourcesPath) {
    candidates.push(resolve(process.resourcesPath, "native/mona-pty"));
    candidates.push(resolve(process.resourcesPath, "mona-pty"));
  }
  let directory = __dirname;
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.push(resolve(directory, "native/macos-pty/build/mona-pty"));
    directory = resolve(directory, "..");
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new PtyError("PTY_UNAVAILABLE", "the native mona-pty helper is not built", {
    searched: candidates,
    action: "run `npm run build:pty` (macOS arm64)",
  });
}

export interface PtySpawnOptions {
  binary: string;
  shell?: string;
  shellArgs?: string[];
  cwd: string;
  cols: number;
  rows: number;
  environment: ShellEnvironment;
}

export interface PtyExit {
  code: number | null;
  signal: string | null;
}

export interface PtyHost {
  pid: number;
  shellPid(): number | null;
  startedAt: string;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal: "INT" | "TERM" | "KILL" | "HUP"): void;
  terminate(): void;
  onOutput(callback: (bytes: Buffer) => void): void;
  onExit(callback: (exit: PtyExit) => void): void;
  onError(callback: (error: Error) => void): void;
  exit: Promise<PtyExit>;
  exited: boolean;
  close(): void;
}

const MAX_START_WAIT_MS = 3_000;

export async function spawnPty(options: PtySpawnOptions): Promise<PtyHost> {
  const args = [
    "--shell",
    options.shell ?? DEFAULT_SHELL,
    "--cwd",
    options.cwd,
    "--cols",
    String(options.cols),
    "--rows",
    String(options.rows),
    ...(options.shellArgs ?? DEFAULT_SHELL_ARGS).flatMap((arg) => ["--arg", arg]),
    ...options.environment.entries.flatMap((entry) => ["--env", entry]),
  ];

  const child = spawn(options.binary, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    env: {
      // The helper itself needs no environment; the shell gets its own below.
      PATH: "/usr/bin:/bin",
    },
  });

  const outputCallback: Array<(bytes: Buffer) => void> = [];
  const exitCallback: Array<(exit: PtyExit) => void> = [];
  const errorCallback: Array<(error: Error) => void> = [];
  let shellPid: number | null = null;
  let exited = false;
  let settled = false;
  let resolveExit: (exit: PtyExit) => void = () => {};
  const exit = new Promise<PtyExit>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const startedAt = new Date().toISOString();

  const control = child.stdio[3] as NodeJS.WritableStream | null;
  const events = child.stdio[4] as NodeJS.ReadableStream | null;
  const stdin = child.stdin;
  const stdout = child.stdout;

  const finish = (receipt: PtyExit): void => {
    if (settled) return;
    settled = true;
    exited = true;
    for (const callback of exitCallback) callback(receipt);
    resolveExit(receipt);
  };

  if (!control || !events || !stdin || !stdout) {
    child.kill("SIGKILL");
    throw new PtyError("PTY_SPAWN_FAILED", "the pty helper did not expose its pipes");
  }

  const started = new Promise<number>((resolveStarted, rejectStarted) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectStarted(new PtyError("PTY_SPAWN_FAILED", "the pty helper did not report a shell pid"));
    }, MAX_START_WAIT_MS);
    const reader = createInterface({ input: events, crlfDelay: Infinity });
    reader.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        for (const callback of errorCallback) {
          callback(new PtyError("PTY_PROTOCOL", "the pty helper sent a malformed event"));
        }
        return;
      }
      switch (event.event) {
        case "started": {
          shellPid = typeof event.pid === "number" ? event.pid : null;
          if (shellPid === null) {
            clearTimeout(timer);
            rejectStarted(new PtyError("PTY_PROTOCOL", "the pty helper reported no pid"));
            return;
          }
          clearTimeout(timer);
          resolveStarted(shellPid);
          return;
        }
        case "exit": {
          finish({
            code: typeof event.code === "number" ? event.code : null,
            signal: typeof event.signal === "number" ? signalName(event.signal) : null,
          });
          return;
        }
        case "error": {
          for (const callback of errorCallback) {
            callback(new PtyError("PTY_SPAWN_FAILED", String(event.message ?? "pty helper error")));
          }
          return;
        }
        default:
          return;
      }
    });
    reader.on("close", () => {
      if (shellPid === null) {
        clearTimeout(timer);
        rejectStarted(new PtyError("PTY_SPAWN_FAILED", "the pty helper closed before starting"));
      }
    });
  });

  stdout.on("data", (chunk: Buffer) => {
    for (const callback of outputCallback) callback(chunk);
  });
  stdout.on("error", () => {
    // A closed read end is the helper exiting; the exit receipt carries the reason.
  });
  stdin.on("error", () => {
    // Writing after the shell exited is reported through the exit receipt.
  });

  child.on("exit", (code, signal) => {
    finish({ code: code ?? null, signal: signal ?? null });
    if (shellPid === null) {
      // `started` was rejected by the reader-close path when it applies.
    }
  });
  child.on("error", (error) => {
    for (const callback of errorCallback) callback(error);
    finish({ code: null, signal: null });
  });

  let pid: number;
  try {
    pid = await started;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const sendControl = (payload: Record<string, unknown>): void => {
    if (exited) return;
    try {
      control.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The helper is gone; the exit receipt is the authority.
    }
  };

  return {
    pid,
    shellPid: () => shellPid,
    startedAt,
    write: (bytes) => {
      if (exited) throw new PtyError("PTY_NOT_RUNNING", "the terminal session is not running");
      if (bytes.length > 0) stdin.write(bytes);
    },
    resize: (cols, rows) => sendControl({ op: "resize", cols, rows }),
    kill: (signal) => sendControl({ op: "kill", signal }),
    terminate: () => sendControl({ op: "terminate" }),
    onOutput: (callback) => outputCallback.push(callback),
    onExit: (callback) => exitCallback.push(callback),
    onError: (callback) => errorCallback.push(callback),
    exit,
    get exited() {
      return exited;
    },
    close: () => {
      try {
        stdin.end();
        control.end();
      } catch {
        // Already closed.
      }
    },
  };
}

export function signalName(signal: number): string {
  switch (signal) {
    case 1:
      return "SIGHUP";
    case 2:
      return "SIGINT";
    case 3:
      return "SIGQUIT";
    case 9:
      return "SIGKILL";
    case 15:
      return "SIGTERM";
    default:
      return `SIG${signal}`;
  }
}

export function shellTitle(shell: string): string {
  return basename(shell) || "shell";
}

export function resolveTerminalCwd(workspace: string | null, home = homedir()): string {
  return workspace && isAbsolute(workspace) ? workspace : home;
}

export function stateDirectoryLog(dir: string, id: string): string {
  return join(dir, `${id}.log`);
}

export type { ChildProcess };
