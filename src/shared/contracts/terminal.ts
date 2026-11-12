import { z } from "zod";
import { ProjectId } from "./ids";

/**
 * P18 — integrated terminal contracts.
 *
 * The terminal is a native arm64 PTY owned by a small Swift helper
 * (`native/macos-pty`), not an engine attach and not an npm native module.
 * Two facts shape every field here:
 *
 * 1. Terminal bytes are inert. The renderer receives text spans, never an
 *    executable escape sequence, a hyperlink target, or IPC authority. There is
 *    no channel from terminal output back into the application.
 * 2. Output is bounded. A session keeps an exact replay ring; bytes the ring
 *    discarded are counted, and a session that exceeds its total byte budget
 *    stops with a stated limit instead of growing without bound.
 */

export const TERMINAL_LIMITS = {
  maxSessions: 3,
  /** Replay ring kept for reconnect; the newest bytes win. */
  replayBytes: 262_144,
  replayLines: 5_000,
  /** Hard total per session. Reaching it ends the session with `limit`. */
  sessionBytes: 64 * 1024 * 1024,
  /** One input write, before it is handed to the pty. */
  inputBytes: 8_192,
  searchMatches: 200,
  logTailBytes: 131_072,
  minCols: 20,
  maxCols: 500,
  minRows: 4,
  maxRows: 300,
} as const;

export const TERMINAL_STATUSES = [
  "starting",
  "running",
  "exited",
  "failed",
  "limit",
  "closed",
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * The environment a shell is launched with. It is an allowlist, never a
 * pass-through: a provider key or runtime token present in Mona's own
 * environment is deliberately withheld, and shell startup files are not read.
 */
export interface TerminalEnvironmentView {
  shell: string;
  arguments: string[];
  startupFiles: "not_sourced";
  path: string;
  variables: string[];
  withheld: string[];
  note: string;
}

export interface TerminalSessionView {
  id: string;
  title: string;
  projectId: ProjectId | null;
  /** Home directory redacted to `~`. */
  cwd: string;
  status: TerminalStatus;
  cols: number;
  rows: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  helperPid: number | null;
  shellPid: number | null;
  bytesOut: number;
  /** Bytes evicted from the replay ring; the transcript is still readable. */
  droppedBytes: number;
  replayBytes: number;
  truncated: boolean;
  limitReason: string | null;
  helper: "mona-pty";
  note: string;
}

export interface TerminalSnapshot {
  available: boolean;
  unavailableReason: string | null;
  sessions: TerminalSessionView[];
  activeSessionId: string | null;
  environment: TerminalEnvironmentView;
  limits: typeof TERMINAL_LIMITS;
  /** Why this pane is a native pty rather than an engine terminal attach. */
  engineTerminalNote: string;
}

export interface TerminalOutputView {
  sessionId: string;
  /** Source byte offset of the first byte in `data`. */
  offset: number;
  /** Offset to pass to the next read. */
  nextCursor: number;
  /** Total bytes ever produced by the session. */
  total: number;
  /** Bytes evicted from the replay ring before `offset`. */
  dropped: number;
  data: string;
  /** True when a caller asked for an offset older than the ring. */
  truncated: boolean;
  status: TerminalStatus;
  exitCode: number | null;
  /**
   * The session's event sequence at the moment of the read. A live output event
   * with a sequence at or below this one is already inside `data`, so a
   * reconnecting pane can drop it instead of rendering the bytes twice.
   */
  seq: number;
}

export interface TerminalSearchMatch {
  sessionId: string;
  /** Character offset in the replay text. */
  index: number;
  line: number;
  /** The matching line, bounded for display. */
  text: string;
}

export interface TerminalSearchView {
  query: string;
  matches: TerminalSearchMatch[];
  truncated: boolean;
  scannedBytes: number;
}

export interface TerminalLogView {
  available: boolean;
  reason: string | null;
  path: string | null;
  bytes: number;
  truncated: boolean;
  text: string;
  readAt: string;
}

export interface TerminalCreateResult {
  snapshot: TerminalSnapshot;
  sessionId: string;
  /** An ended session evicted to stay within the session cap, if any. */
  replacedSessionId: string | null;
  /** A live session that could not be evicted, when creation was refused. */
  refusedReason: string | null;
}

export interface TerminalEvent {
  sessionId: string;
  kind: "output" | "state" | "exit";
  /** Monotonic per session. */
  seq: number;
  status: TerminalStatus;
  /** Output bytes since the last event, already bounded by the main process. */
  data?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  note?: string | null;
}

export const TerminalIdSchema = z
  .string()
  .regex(/^term_[a-f0-9]{16}$/, "terminal id must be term_<16 hex>");

export const TerminalCreateSchema = z.strictObject({
  projectId: ProjectId.nullable().optional(),
  cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols).optional(),
  rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows).optional(),
});

export const TerminalWriteSchema = z.strictObject({
  sessionId: TerminalIdSchema,
  data: z.string().min(1).max(TERMINAL_LIMITS.inputBytes),
  encoding: z.enum(["text", "base64"]).optional(),
});

export const TerminalResizeSchema = z.strictObject({
  sessionId: TerminalIdSchema,
  cols: z.number().int().min(TERMINAL_LIMITS.minCols).max(TERMINAL_LIMITS.maxCols),
  rows: z.number().int().min(TERMINAL_LIMITS.minRows).max(TERMINAL_LIMITS.maxRows),
});

export const TerminalTargetSchema = z.strictObject({ sessionId: TerminalIdSchema });

export const TerminalOutputSchema = z.strictObject({
  sessionId: TerminalIdSchema,
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxBytes: z.number().int().min(1).max(TERMINAL_LIMITS.replayBytes).optional(),
});

export const TerminalSearchSchema = z.strictObject({
  sessionId: TerminalIdSchema,
  query: z.string().min(1).max(200),
});

export const TerminalLogSchema = z.strictObject({
  projectId: ProjectId,
  maxBytes: z.number().int().min(1).max(TERMINAL_LIMITS.logTailBytes).optional(),
});
