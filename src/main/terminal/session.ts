import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { ProjectId } from "../../shared/contracts/ids";
import {
  TERMINAL_LIMITS,
  type TerminalCreateResult,
  type TerminalEnvironmentView,
  type TerminalEvent,
  type TerminalLogView,
  type TerminalOutputView,
  type TerminalSearchView,
  type TerminalSessionView,
  type TerminalSnapshot,
  type TerminalStatus,
} from "../../shared/contracts/terminal";
import { redactDiagnostics } from "../work/settings";
import { TerminalBuffer } from "./buffer";
import {
  DEFAULT_SHELL,
  DEFAULT_SHELL_ARGS,
  buildShellEnvironment,
  resolvePtyBinary,
  resolveTerminalCwd,
  shellTitle,
  spawnPty,
  type PtyExit,
  type PtyHost,
  type ShellEnvironment,
} from "./pty";

const HOME = homedir();
const MAX_EVENT_BYTES = 32 * 1024;
const FLUSH_INTERVAL_MS = 33;

interface TerminalSession {
  id: string;
  title: string;
  projectId: ProjectId | null;
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  host: PtyHost;
  buffer: TerminalBuffer;
  /** Keeps a multi-byte character from splitting across IPC chunks. */
  decoder: StringDecoder;
  seq: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  limitReason: string | null;
}

export interface TerminalManagerOptions {
  binary?: string;
  shell?: string;
  shellArgs?: string[];
  /** The project's canonical workspace, resolved by the caller's catalog. */
  workspaceFor?: (projectId: ProjectId) => Promise<string | null>;
  /** The owned runtime's engine log path for a workspace, or null. */
  logPathFor?: (workspace: string) => string | null;
  emit?: (event: TerminalEvent) => void;
  now?: () => Date;
  environment?: ShellEnvironment;
  /** Test seam; production always uses the native helper. */
  spawn?: typeof spawnPty;
  limits?: Partial<typeof TERMINAL_LIMITS>;
}

function redactHome(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

/**
 * Terminal session owner.
 *
 * Sessions live in the main process, so a renderer reload reconnects to the
 * same shell instead of starting a second one. Nothing here can start a turn,
 * call the engine, or write a workspace file: the only writable surface is the
 * pty byte stream and the helper's control channel.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly options: TerminalManagerOptions;
  private readonly limits: typeof TERMINAL_LIMITS;
  private readonly environmentView: TerminalEnvironmentView;
  private activeSessionId: string | null = null;
  private unavailableReason: string | null = null;

  constructor(options: TerminalManagerOptions = {}) {
    this.options = options;
    this.limits = { ...TERMINAL_LIMITS, ...(options.limits ?? {}) } as typeof TERMINAL_LIMITS;
    const environment = options.environment ?? buildShellEnvironment();
    this.environmentView = {
      shell: options.shell ?? DEFAULT_SHELL,
      arguments: options.shellArgs ?? DEFAULT_SHELL_ARGS,
      startupFiles: "not_sourced",
      path: environment.path,
      variables: environment.variables,
      withheld: environment.withheld,
      note: "Launched with an explicit allowlist. Shell startup files are not sourced, so personal aliases do not load. Mona's provider keys and runtime token are never passed.",
    };
  }

  environment(): TerminalEnvironmentView {
    return this.environmentView;
  }

  list(): TerminalSessionView[] {
    return Array.from(this.sessions.values()).map((session) => this.view(session));
  }

  snapshot(): TerminalSnapshot {
    return {
      available: this.unavailableReason === null,
      unavailableReason: this.unavailableReason,
      sessions: this.list(),
      activeSessionId: this.activeSessionId,
      environment: this.environmentView,
      limits: this.limits,
      engineTerminalNote:
        "The engine's own terminal routes attach to a shell the engine already owns and cannot create one, so Mona's pane is the native helper. Engine sessions are not simulated here.",
    };
  }

  async create(input: {
    projectId?: ProjectId | null;
    cols?: number;
    rows?: number;
  }): Promise<TerminalCreateResult> {
    // The cap bounds real resources (shells and their buffers). When it is
    // reached, an ended session may be evicted so its transcript is the only
    // thing lost; a live shell is never evicted, and the refusal says why.
    let replacedSessionId: string | null = null;
    if (this.sessions.size >= this.limits.maxSessions) {
      const ended = Array.from(this.sessions.values())
        .filter((session) => session.status !== "running" && session.status !== "starting")
        .sort((a, b) => (a.endedAt ?? a.createdAt).localeCompare(b.endedAt ?? b.createdAt))[0];
      if (!ended) {
        throw Object.assign(
          new Error(
            `Mona keeps at most ${this.limits.maxSessions} running terminal sessions; close one first.`,
          ),
          { code: "TERMINAL_LIMIT" },
        );
      }
      this.sessions.delete(ended.id);
      if (this.activeSessionId === ended.id) this.activeSessionId = null;
      replacedSessionId = ended.id;
    }
    let binary: string;
    if (this.options.spawn && !this.options.binary) {
      // Test seam: a fake host does not need the compiled helper.
      binary = "mona-pty";
    } else {
      try {
        binary = resolvePtyBinary(this.options.binary);
      } catch (error) {
        this.unavailableReason =
          error instanceof Error ? error.message : "the pty helper is unavailable";
        throw error;
      }
    }
    const cols = clamp(input.cols ?? 100, this.limits.minCols, this.limits.maxCols);
    const rows = clamp(input.rows ?? 30, this.limits.minRows, this.limits.maxRows);
    const projectId = input.projectId ?? null;
    const workspace = projectId ? ((await this.options.workspaceFor?.(projectId)) ?? null) : null;
    const cwd = resolveTerminalCwd(workspace);
    const environment = this.options.environment ?? buildShellEnvironment();
    const shell = this.options.shell ?? DEFAULT_SHELL;
    const spawnHost = this.options.spawn ?? spawnPty;
    const host = await spawnHost({
      binary,
      shell,
      shellArgs: this.options.shellArgs ?? DEFAULT_SHELL_ARGS,
      cwd,
      cols,
      rows,
      environment,
    });
    const id = `term_${randomBytes(8).toString("hex")}`;
    const session: TerminalSession = {
      id,
      title: shellTitle(shell),
      projectId,
      cwd,
      cols,
      rows,
      status: "running",
      createdAt: this.stamp(),
      startedAt: host.startedAt,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      host,
      buffer: new TerminalBuffer({
        maxBytes: this.limits.replayBytes,
        maxLines: this.limits.replayLines,
      }),
      decoder: new StringDecoder("utf8"),
      seq: 0,
      pending: "",
      flushTimer: null,
      limitReason: null,
    };
    this.sessions.set(id, session);
    this.activeSessionId = id;

    host.onOutput((bytes) => this.onOutput(session, bytes));
    host.onExit((exit) => this.onExit(session, exit));
    host.onError((error) => {
      if (session.status === "running") {
        session.limitReason = error.message;
      }
    });
    host.exit.then((exit) => this.onExit(session, exit)).catch(() => {});
    return { snapshot: this.snapshot(), sessionId: id, replacedSessionId, refusedReason: null };
  }

  /** Whether a session can be created without evicting a running shell. */
  capacity(): { live: number; total: number; canCreate: boolean } {
    const live = Array.from(this.sessions.values()).filter(
      (session) => session.status === "running" || session.status === "starting",
    ).length;
    return {
      live,
      total: this.sessions.size,
      canCreate: live < this.limits.maxSessions,
    };
  }

  write(sessionId: string, data: string, encoding: "text" | "base64" = "text"): number {
    const session = this.require(sessionId);
    if (session.status !== "running") {
      throw Object.assign(new Error("this terminal session is no longer running"), {
        code: "TERMINAL_NOT_RUNNING",
      });
    }
    const bytes = encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
    if (bytes.length > this.limits.inputBytes) {
      throw Object.assign(new Error("terminal input is larger than one write allows"), {
        code: "TERMINAL_INPUT_TOO_LARGE",
      });
    }
    session.host.write(bytes);
    return bytes.length;
  }

  resize(sessionId: string, cols: number, rows: number): TerminalSessionView {
    const session = this.require(sessionId);
    session.cols = clamp(cols, this.limits.minCols, this.limits.maxCols);
    session.rows = clamp(rows, this.limits.minRows, this.limits.maxRows);
    if (session.status === "running") session.host.resize(session.cols, session.rows);
    const view = this.view(session);
    this.push(session, { kind: "state" });
    return view;
  }

  async close(sessionId: string): Promise<TerminalSessionView> {
    const session = this.require(sessionId);
    if (session.status === "running") {
      session.host.terminate();
      const receipt = await Promise.race([
        session.host.exit,
        new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 2_500)),
      ]);
      if (receipt === null && session.status === "running") {
        session.host.kill("KILL");
        await Promise.race([
          session.host.exit,
          new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 1_000)),
        ]);
      }
      if (session.status === "running") {
        // The helper did not confirm the exit. Say so; do not claim closed.
        session.status = "closed";
        session.limitReason = "the helper did not confirm the shell exited";
        session.endedAt = this.stamp();
        this.push(session, { kind: "state" });
      }
    }
    if (this.activeSessionId === sessionId) {
      const remaining = Array.from(this.sessions.values()).filter(
        (entry) => entry.status === "running",
      );
      this.activeSessionId = remaining[remaining.length - 1]?.id ?? null;
    }
    return this.view(session);
  }

  output(sessionId: string, cursor = 0, maxBytes?: number): TerminalOutputView {
    const session = this.require(sessionId);
    // Bytes enter the buffer immediately but reach the renderer through a
    // 33 ms batch. Flush here so a reader never sees bytes whose event has not
    // been emitted yet: that invariant is what lets a reconnecting pane drop
    // exactly the events already inside its replay instead of drawing them
    // twice.
    this.flush(session);
    const read = session.buffer.read(cursor, maxBytes ?? this.limits.replayBytes);
    return {
      sessionId,
      offset: read.offset,
      nextCursor: read.nextCursor,
      total: read.total,
      dropped: read.dropped,
      data: read.data,
      truncated: read.truncated,
      status: session.status,
      exitCode: session.exitCode,
      seq: session.seq,
    };
  }

  search(sessionId: string, query: string): TerminalSearchView {
    const session = this.require(sessionId);
    const result = session.buffer.search(query, this.limits.searchMatches);
    return {
      query,
      matches: result.matches.map((match) => ({ sessionId, ...match })),
      truncated: result.truncated,
      scannedBytes: session.buffer.retained,
    };
  }

  /** Read-only tail of the owned runtime's log for a project. */
  async log(input: { projectId: ProjectId; maxBytes?: number }): Promise<TerminalLogView> {
    const workspace = await this.options.workspaceFor?.(input.projectId);
    const path = workspace ? (this.options.logPathFor?.(workspace) ?? null) : null;
    const readAt = this.stamp();
    if (!path) {
      return {
        available: false,
        reason:
          "no owned runtime log is recorded for this project. Start the engine once; logs are per launch.",
        path: null,
        bytes: 0,
        truncated: false,
        text: "",
        readAt,
      };
    }
    if (!existsSync(path)) {
      return {
        available: false,
        reason: "the recorded run has no log file on disk",
        path: redactHome(path),
        bytes: 0,
        truncated: false,
        text: "",
        readAt,
      };
    }
    const limit = Math.min(input.maxBytes ?? this.limits.logTailBytes, this.limits.logTailBytes);
    const size = statSync(path).size;
    const length = Math.min(size, limit);
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    const redacted = redactDiagnostics(buffer.toString("utf8"));
    return {
      available: true,
      reason: null,
      path: redactHome(path),
      bytes: size,
      truncated: size > length,
      text: redacted.text,
      readAt,
    };
  }

  /** Close every session. Called on quit; a shell never outlives Mona. */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.sessions.keys()).map((sessionId) => this.close(sessionId)),
    );
  }

  private require(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown terminal session: ${sessionId}`), {
        code: "TERMINAL_NOT_FOUND",
      });
    }
    return session;
  }

  private onOutput(session: TerminalSession, bytes: Buffer): void {
    if (session.status !== "running" && session.status !== "limit") return;
    session.buffer.append(bytes);
    if (session.buffer.total > this.limits.sessionBytes) {
      session.limitReason = `the session produced more than ${Math.round(
        this.limits.sessionBytes / (1024 * 1024),
      )} MiB and was stopped`;
      session.status = "limit";
      session.host.terminate();
    }
    const text = session.decoder.write(bytes);
    if (text.length === 0) return;
    session.pending += text;
    while (session.pending.length >= MAX_EVENT_BYTES) {
      this.push(session, { kind: "output", data: session.pending.slice(0, MAX_EVENT_BYTES) });
      session.pending = session.pending.slice(MAX_EVENT_BYTES);
    }
    if (session.flushTimer === null) {
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        this.flush(session);
      }, FLUSH_INTERVAL_MS);
      session.flushTimer.unref?.();
    }
  }

  private flush(session: TerminalSession): void {
    if (session.pending.length === 0) return;
    this.push(session, { kind: "output", data: session.pending });
    session.pending = "";
  }

  private onExit(session: TerminalSession, receipt: PtyExit): void {
    if (session.status === "exited" || session.status === "failed" || session.status === "closed") {
      return;
    }
    session.exitCode = receipt.code;
    session.exitSignal = receipt.signal;
    session.endedAt = this.stamp();
    // A non-zero exit is an observed exit, not a Mona failure. `failed` is
    // reserved for the helper or the spawn itself failing.
    session.status = session.status === "limit" ? "limit" : "exited";
    this.flush(session);
    this.push(session, { kind: "exit" });
    session.host.close();
  }

  private push(
    session: TerminalSession,
    event: Omit<TerminalEvent, "sessionId" | "seq" | "status">,
  ): void {
    session.seq += 1;
    const payload: TerminalEvent = {
      sessionId: session.id,
      seq: session.seq,
      status: session.status,
      ...event,
    };
    if (payload.kind === "exit") {
      payload.exitCode = session.exitCode;
      payload.exitSignal = session.exitSignal;
      payload.note = session.limitReason;
    }
    this.options.emit?.(payload);
  }

  private view(session: TerminalSession): TerminalSessionView {
    return {
      id: session.id,
      title: session.title,
      projectId: session.projectId,
      cwd: redactHome(session.cwd),
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      helperPid: session.host.pid,
      shellPid: session.host.shellPid(),
      bytesOut: session.buffer.total,
      droppedBytes: session.buffer.dropped,
      replayBytes: session.buffer.retained,
      truncated: session.buffer.dropped > 0,
      limitReason: session.limitReason,
      helper: "mona-pty",
      note:
        session.status === "running"
          ? "Native arm64 pty. Escape sequences are rendered as inert text."
          : "This session has ended; the retained transcript is still readable.",
    };
  }

  private stamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
