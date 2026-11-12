import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { RuntimeLifecycleError } from "./errors";
import { isSameProcess, readProcessEntry } from "./identity";

export interface SupervisorStartOptions {
  binary: string;
  workspace: string;
  executable: string;
  args?: string[];
  controlSocket: string;
  token: string;
  logPath?: string;
  graceMs?: number;
  label?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SupervisorStartedReceipt {
  event: "started";
  supervisor_pid: number;
  child_pid: number;
  child_start: string;
  pgid: number;
  executable: string;
  label: string;
  token_source: "fd3";
}

export interface SupervisorStatusReceipt {
  ok: boolean;
  state: "running" | "stopping" | "exited" | string;
  supervisor_pid: number;
  child_pid: number;
  child_start: string | null;
  tracked: number;
  alive: number[];
}

export interface SupervisorStopReceipt {
  ok: boolean;
  state: "stopped" | "survivors" | "identity_mismatch" | "unreachable" | string;
  graceful: boolean;
  escalated: boolean;
  survivors: number[];
  exit?: { code: number | null; signal: number | null; reaped?: boolean };
  via: "control_socket" | "signal_fallback";
  note?: string;
}

export interface SupervisorHandle {
  binary: string;
  pid: number;
  childPid: number;
  /** `ps`-visible start time used for every identity comparison. */
  childStartedAt: string;
  /** The supervisor's own (pid:sec.usec) token, kept as startup evidence. */
  reportedChildStart: string;
  pgid: number;
  controlSocket: string;
  process: ChildProcess;
  startedReceipt: SupervisorStartedReceipt;
  events: Array<Record<string, unknown>>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitCode(): number | null;
  stderrText(): string;
  status(timeoutMs?: number): Promise<SupervisorStatusReceipt>;
  stop(options?: { graceMs?: number; force?: boolean }): Promise<SupervisorStopReceipt>;
  closeOwnerChannel(): void;
}

/**
 * Locate the compiled native supervisor. Packaged builds ship it beside the
 * app resources; development builds use the checked-out native directory.
 */
export function resolveSupervisorBinary(explicitPath?: string): string {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.MONA_SUPERVISOR_BIN) candidates.push(process.env.MONA_SUPERVISOR_BIN);
  if (process.resourcesPath) {
    candidates.push(resolve(process.resourcesPath, "native/mona-supervisor"));
    candidates.push(resolve(process.resourcesPath, "mona-supervisor"));
  }
  let directory = __dirname;
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.push(resolve(directory, "native/macos-supervisor/build/mona-supervisor"));
    directory = resolve(directory, "..");
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new SupervisorUnavailableError(
    "the native mona-supervisor binary is not built",
    "run `npm run build:supervisor` (macOS arm64 with Command Line Tools)",
    { searched: candidates },
  );
}

export class SupervisorUnavailableError extends RuntimeLifecycleError {
  constructor(message: string, action: string, details?: Record<string, unknown>) {
    super("SUPERVISOR_UNAVAILABLE", message, action, details);
    this.name = "SupervisorUnavailableError";
  }
}

export async function startSupervisor(options: SupervisorStartOptions): Promise<SupervisorHandle> {
  if (!existsSync(options.executable)) {
    throw new RuntimeLifecycleError(
      "MISSING_EXECUTABLE",
      `runtime executable does not exist: ${options.executable}`,
      "install the pinned Codewhale engine or set CODEWHALE_BIN",
      { executable: options.executable },
    );
  }
  const args = [
    "--control",
    options.controlSocket,
    "--workspace",
    options.workspace,
    "--grace-ms",
    String(options.graceMs ?? 8_000),
    "--label",
    options.label ?? "runtime",
  ];
  if (options.logPath) args.push("--log", options.logPath);
  args.push("--", options.executable, ...(options.args ?? []));

  const child = spawn(options.binary, args, {
    cwd: options.workspace,
    // fd 3 is the owner-liveness channel: token first, then EOF on owner death.
    // The token never appears in argv or in the supervisor's environment.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });

  const events: Array<Record<string, unknown>> = [];
  let stderr = "";
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
  });
  child.on("error", (error) => {
    stderr += `spawn error: ${String(error)}\n`;
  });

  const ownerChannel = child.stdio[3] as NodeJS.WritableStream | null;
  if (!ownerChannel) {
    child.kill("SIGKILL");
    throw new SupervisorUnavailableError(
      "the supervisor owner-liveness channel could not be opened",
      "reinstall Mona; the native supervisor requires fd 3",
    );
  }
  ownerChannel.on("error", () => {
    // A closed channel means the supervisor died first; exit handling reports it.
  });
  ownerChannel.write(`${options.token}\n`);

  let started: SupervisorStartedReceipt | null = null;
  let spawnFailure: string | null = null;
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  lines.on("line", (line) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    events.push(parsed);
    if (parsed.event === "started" && started === null) {
      started = parsed as unknown as SupervisorStartedReceipt;
    }
    if (parsed.event === "spawn_failed" || parsed.event === "spawn_error") {
      spawnFailure = String(parsed.message ?? parsed.error ?? "spawn failed");
    }
  });

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (started === null && spawnFailure === null && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  if (started === null) {
    const receipt = await shutdownAfterFailedStart(child, exit, options.graceMs ?? 2_000);
    throw new SupervisorUnavailableError(
      spawnFailure ?? "the supervisor did not report a started child",
      "inspect the runtime log and the engine executable",
      { stderr: stderr.slice(-2000), events, exit: receipt },
    );
  }

  const startedReceipt = started as SupervisorStartedReceipt;
  if (startedReceipt.supervisor_pid !== (child.pid ?? -1)) {
    const cleanup = await shutdownAfterFailedStart(child, exit, options.graceMs ?? 2_000);
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      "the started receipt does not belong to the supervisor Mona spawned",
      "stop the runtime and inspect the process tree",
      { expected: child.pid ?? -1, reported: startedReceipt.supervisor_pid, cleanup },
    );
  }
  // The supervisor reports its own monotonic identity token; Mona records the
  // `ps`-visible start time so records, verdicts, and the fallback signal path
  // all compare the same representation.
  const childEntry = readProcessEntry(startedReceipt.child_pid);
  if (!childEntry || childEntry.ppid !== (child.pid ?? -1)) {
    const supervisorEntry = readProcessEntry(child.pid ?? -1);
    // If the supervisor is already gone, the child was reparented because the
    // runtime exited during startup: that is a startup failure, not a stranger.
    const supervisorAlive = supervisorEntry !== null;
    const startupFailure = childEntry === null || !supervisorAlive;
    const cleanup = await shutdownAfterFailedStart(child, exit, options.graceMs ?? 2_000);
    throw new RuntimeLifecycleError(
      startupFailure ? "STARTUP_FAILED" : "OWNERSHIP_MISMATCH",
      startupFailure
        ? "the runtime exited before its process identity could be recorded"
        : `supervised pid ${startedReceipt.child_pid} has parent ${childEntry?.ppid}, not the supervisor`,
      "inspect the runtime log for the engine's error, then retry",
      {
        stderr: stderr.slice(-2000),
        events,
        cleanup,
        reported_child_start: startedReceipt.child_start,
      },
    );
  }
  const handle: SupervisorHandle = {
    binary: options.binary,
    pid: child.pid ?? -1,
    childPid: startedReceipt.child_pid,
    childStartedAt: childEntry.startedAt,
    reportedChildStart: startedReceipt.child_start,
    pgid: startedReceipt.pgid,
    controlSocket: options.controlSocket,
    process: child,
    startedReceipt,
    events,
    exit,
    exitCode: () => child.exitCode,
    stderrText: () => stderr,
    status: (timeoutMs = 3_000) => controlStatus(options.controlSocket, timeoutMs),
    stop: (stopOptions = {}) => stopSupervisor(handle, stopOptions),
    closeOwnerChannel: () => {
      const closable = ownerChannel as unknown as { destroy?: () => void };
      if (typeof closable.destroy === "function") closable.destroy();
      ownerChannel.end?.();
    },
  };
  return handle;
}

async function shutdownAfterFailedStart(
  child: ChildProcess,
  exit: Promise<unknown>,
  graceMs: number,
): Promise<unknown> {
  if (child.exitCode !== null) return { already_exited: true, code: child.exitCode };
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exit.then(() => false),
    sleep(graceMs + 1_000).then(() => true),
  ]);
  if (timedOut) child.kill("SIGKILL");
  return { already_exited: false, escalated: timedOut };
}

export async function stopSupervisor(
  handle: SupervisorHandle,
  options: { graceMs?: number; force?: boolean } = {},
): Promise<SupervisorStopReceipt> {
  const graceMs = options.graceMs ?? 8_000;
  const force = options.force === true;
  try {
    const response = await controlRequest(
      handle.controlSocket,
      { op: force ? "force-stop" : "stop", graceMs, force },
      graceMs + 5_000,
    );
    const survivors = Array.isArray(response.survivors) ? (response.survivors as number[]) : [];
    return {
      ok: response.ok === true,
      state: String(response.state ?? "unknown"),
      graceful: !force,
      escalated: response.escalated === true || force,
      survivors,
      exit: response.exit as SupervisorStopReceipt["exit"],
      via: "control_socket",
    };
  } catch (error) {
    // The supervisor is unreachable. Fall back to a verified-identity signal;
    // never kill by name and never signal a reused pid.
    return stopByVerifiedIdentity(
      {
        childPid: handle.childPid,
        childStartedAt: handle.childStartedAt,
        pgid: handle.pgid,
      },
      { graceMs, force, note: `control socket failed: ${String(error)}` },
    );
  }
}

export interface VerifiedTarget {
  childPid: number;
  childStartedAt: string;
  pgid: number;
}

export async function stopByVerifiedIdentity(
  target: VerifiedTarget,
  options: { graceMs?: number; force?: boolean; note?: string } = {},
): Promise<SupervisorStopReceipt> {
  const graceMs = options.graceMs ?? 8_000;
  const identity = { pid: target.childPid, startedAt: target.childStartedAt };
  if (readProcessEntry(target.childPid) === null) {
    return {
      ok: true,
      state: "stopped",
      graceful: true,
      escalated: false,
      survivors: [],
      via: "signal_fallback",
      note: options.note ?? "the recorded process is already gone",
    };
  }
  if (!isSameProcess(identity)) {
    return {
      ok: false,
      state: "identity_mismatch",
      graceful: false,
      escalated: false,
      survivors: [],
      via: "signal_fallback",
      note:
        options.note ??
        `pid ${target.childPid} is not the recorded process; refusing to signal a reused pid`,
    };
  }
  let escalated = options.force === true;
  signalGroup(target, options.force ? "SIGKILL" : "SIGTERM");
  const deadline = Date.now() + (options.force ? 2_000 : graceMs);
  while (Date.now() < deadline) {
    if (!isSameProcess(identity)) break;
    await sleep(50);
  }
  if (isSameProcess(identity)) {
    escalated = true;
    signalGroup(target, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && isSameProcess(identity)) await sleep(50);
  }
  const survivors = isSameProcess(identity) ? [target.childPid] : [];
  return {
    ok: survivors.length === 0,
    state: survivors.length === 0 ? "stopped" : "survivors",
    graceful: options.force !== true,
    escalated,
    survivors,
    via: "signal_fallback",
    note: options.note,
  };
}

function signalGroup(target: VerifiedTarget, signal: NodeJS.Signals): void {
  try {
    process.kill(-target.pgid, signal);
  } catch {
    try {
      process.kill(target.childPid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function controlStatus(
  socketPath: string,
  timeoutMs: number,
): Promise<SupervisorStatusReceipt> {
  return (await controlRequest(
    socketPath,
    { op: "status" },
    timeoutMs,
  )) as unknown as SupervisorStatusReceipt;
}

export function controlRequest(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value ?? {});
    };
    const timer = setTimeout(
      () => finish(new Error(`control socket timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        finish(new Error(`malformed supervisor response: ${String(error)}`));
      }
    });
    socket.once("end", () => {
      clearTimeout(timer);
      if (!settled && buffer.trim().length > 0) {
        try {
          finish(null, JSON.parse(buffer.trim()) as Record<string, unknown>);
        } catch {
          finish(new Error("malformed supervisor response"));
        }
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function processStartToken(pid: number): string | null {
  return readProcessEntry(pid)?.startedAt ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function supervisorBuildInfo(binary: string): { path: string; present: boolean } {
  return { path: binary, present: existsSync(binary) };
}
