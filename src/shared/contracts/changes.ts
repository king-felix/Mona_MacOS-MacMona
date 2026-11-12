/**
 * Change-receipt, Git, and restore contracts.
 *
 * These types cross the narrow IPC boundary. Every field is a projection of a
 * real engine receipt, a real Git command, or a stored Mona record. Nothing in
 * this surface starts inference, and an unrecorded state is never rendered as
 * an empty diff or a zero.
 */
import type { ProjectId } from "./ids";

/** Where the engine said a change came from. */
export type ChangeSource =
  "tool_mutation" | "tool_output_spill" | "tool_media" | "workspace_changed_during_turn";

/**
 * Attribution is deliberately weaker than authorship. A tool receipt names the
 * call that wrote a path; a workspace delta only says the path changed while a
 * turn ran. Timing alone never proves who wrote a file.
 */
export type ChangeAttribution = "tool" | "workspace_delta" | "artifact" | "unreceipted";

export type ChangeKind = "created" | "updated" | "deleted" | "renamed" | "unknown";

export type ChangeSetState = "settled" | "pending" | "unavailable";

export type ChangeSetOrigin = "engine" | "turn.artifacts" | "turn.completed";

export interface ChangeFileView {
  /** Engine artifact id, used to read tool output and media windows. */
  artifactId: string | null;
  /** Workspace-relative path, or a session-relative path for output/media. */
  path: string;
  previousPath: string | null;
  kind: "file" | "tool_output" | "media";
  change: ChangeKind;
  source: ChangeSource;
  attribution: ChangeAttribution;
  toolName: string | null;
  toolCallId: string | null;
  itemId: string | null;
  sizeBytes: number | null;
  /** SHA-256 hex of the recorded content; null when deleted or unknown. */
  revision: string | null;
  /** A restore point this thread owns, when the engine recorded one. */
  restoreSnapshotId: string | null;
  /** Filename heuristic only; the reader confirms it on open. */
  binaryHint: boolean;
  /** Above the engine's 16 MiB read limit, so no content can be shown. */
  oversized: boolean;
}

export interface ArtifactRefView {
  id: string;
  kind: string;
  path: string | null;
  sizeBytes: number | null;
  mediaType: string | null;
}

/** One tool call the engine recorded for a turn. */
export interface ToolReceiptView {
  itemId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  status: string;
  summary: string;
  artifacts: ArtifactRefView[];
}

export interface ChangeSetView {
  id: string;
  turnId: string;
  threadId: string;
  taskId: string | null;
  state: ChangeSetState;
  /** Why the engine could not produce a delta; never an empty-file excuse. */
  reason: string | null;
  preSnapshotId: string | null;
  postSnapshotId: string | null;
  capturedAt: string;
  origin: ChangeSetOrigin;
  truncated: boolean;
  omitted: number | null;
  files: ChangeFileView[];
  tools: ToolReceiptView[];
  note: string | null;
}

export interface GitEntryView {
  path: string;
  originalPath: string | null;
  /** Porcelain v2 index/worktree status characters; "." means clean there. */
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  attribution: ChangeAttribution;
  receipt: { changeSetId: string; turnId: string; toolName: string | null } | null;
}

export interface GitStateView {
  available: boolean;
  reason: string | null;
  root: string | null;
  branch: string | null;
  detached: boolean;
  /** Linked worktree name when this folder is a secondary checkout. */
  worktree: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  head: { commit: string; shortCommit: string; subject: string; committedAt: string } | null;
  entries: GitEntryView[];
  /** True when the status listing hit Mona's output cap; counts are then partial. */
  truncated: boolean;
  counts: { staged: number; unstaged: number; untracked: number; conflicted: number };
  /**
   * Entries already staged that no recorded Mona turn produced. Mona never
   * resets or unstages them.
   */
  stagedBeforeReview: number;
}

export interface ChangesSnapshot {
  projectId: ProjectId;
  sets: ChangeSetView[];
  git: GitStateView;
  receipts: { available: boolean; reason: string | null };
  restore: { available: boolean; reason: string | null };
  /** The last commit Mona made from this surface, if any. */
  lastCommit: {
    shortHash: string;
    subject: string;
    paths: string[];
    createdAt: string;
  } | null;
  notes: string[];
  generatedAt: string;
}

export type FileWindowMode = "text" | "diff";

export interface FileWindowView {
  path: string;
  mode: FileWindowMode;
  availability: "available" | "binary" | "oversized" | "missing" | "unsupported" | "error";
  content: string | null;
  diff: string | null;
  encoding: "utf-8" | "base64" | null;
  offset: number;
  /** Offset to request next for "load more"; equals offset when nothing is left. */
  nextOffset: number;
  totalBytes: number | null;
  truncated: boolean;
  revision: string | null;
  source: "workspace" | "snapshot" | "artifact" | "git" | null;
  /** True only when the engine's checked write path is reachable. */
  canEdit: boolean;
  note: string | null;
}

export interface ArtifactWindowView {
  artifactId: string;
  availability: "available" | "binary" | "oversized" | "missing" | "unsupported";
  mediaType: string | null;
  sizeBytes: number | null;
  content: string | null;
  encoding: "utf-8" | "base64" | null;
  offset: number;
  nextOffset: number;
  truncated: boolean;
  note: string | null;
}

export type RestoreConflictKind =
  | "changed_after_turn"
  | "unattributed_change"
  | "not_a_regular_file"
  | "already_matches"
  /** The engine recorded no revision for this path, so a later edit is undetectable. */
  | "unverifiable_revision";

export interface RestoreScopeEntry {
  path: string;
  /** What the engine will do to the file, predicted from the receipt. */
  action: "modified" | "recreated" | "removed";
  /** `sha256:` of the current bytes, or `absent`. Checked again at execution. */
  expectedHash: string;
  currentRevision: string | null;
  recordedRevision: string | null;
  note: string | null;
}

export interface RestoreExclusion {
  path: string;
  reason: "no_restore_point" | "not_a_workspace_file" | "outside_workspace" | "unsupported";
  detail: string;
}

export interface RestoreConflict {
  path: string;
  kind: RestoreConflictKind;
  detail: string;
}

export interface RestorePreviewView {
  projectId: ProjectId;
  changeSetId: string;
  turnId: string;
  planHash: string;
  generatedAt: string;
  engine: { available: boolean; reason: string | null };
  scope: RestoreScopeEntry[];
  exclusions: RestoreExclusion[];
  conflicts: RestoreConflict[];
  /** Paths whose conflict must be acknowledged before execution. */
  requiresAcknowledgement: string[];
  recovery: {
    mechanism: string;
    durable: boolean;
    note: string;
    recent: Array<{ id: string; label: string; timestamp: number | null }>;
  };
  canRestore: boolean;
  note: string;
}

export interface RestoreRequestEntry {
  path: string;
  expectedHash: string;
}

export interface RestoreResultView {
  ok: boolean;
  restored: Array<{
    path: string;
    action: string;
    snapshotId: string;
    snapshotLabel: string;
    /** Revision after the revert, read back when the file still exists. */
    newRevision: string | null;
  }>;
  refused: Array<{ path: string; code: string; message: string }>;
  notAttempted: string[];
  recovery: { mechanism: string; durable: boolean; note: string };
  snapshot: ChangesSnapshot;
}

export interface GitActionResult {
  ok: boolean;
  /** The exact command class that ran; never includes a credential or secret. */
  command: string;
  note: string;
  commit: { hash: string; shortCommit: string; subject: string } | null;
  status: GitStateView;
}

export interface FileWriteResultView {
  written: boolean;
  path: string;
  revision: string;
  sizeBytes: number;
  created: boolean;
  note: string;
}

/** A local-only bounded window of the current workspace file, for previews. */
export interface WorkspaceReadView {
  path: string;
  availability: "available" | "binary" | "oversized" | "missing" | "unsupported";
  encoding: "utf-8" | "base64" | null;
  content: string | null;
  offset: number;
  sizeBytes: number | null;
  revision: string | null;
  truncated: boolean;
  note: string | null;
}
