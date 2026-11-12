import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProjectId } from "../../shared/contracts";
import type {
  ArtifactWindowView,
  ChangeAttribution,
  ChangeKind,
  ChangesSnapshot,
  ChangeSetOrigin,
  ChangeSetState,
  ChangeSetView,
  FileWindowMode,
  FileWindowView,
  FileWriteResultView,
  GitActionResult,
  GitEntryView,
  GitStateView,
  RestoreConflict,
  RestorePreviewView,
  RestoreRequestEntry,
  RestoreResultView,
  RestoreScopeEntry,
  ToolReceiptView,
} from "../../shared/contracts/changes";
import { AdapterError } from "../engine/errors";
import type { EngineAdapter, RestoreCapability, TurnArtifactRef } from "../engine/types";
import type { StateStore, StoredChangeFile, StoredChangeSet, StoredProject } from "../state/store";
import { GitError, GitService, validateGitPath } from "./git";

/**
 * Change receipts, Git awareness, and native restore.
 *
 * The engine's turn record is the source of truth for what changed. This
 * service stores its projection, presents attribution honestly, and uses the
 * engine's own `file-revert` route for restore. It does not scan the workspace
 * as a second snapshot engine, and it never runs `git reset`, `git clean`, or a
 * blanket checkout.
 */

export interface ChangeEngineAccess {
  adapter: EngineAdapter;
  workspace: string;
}

export interface ChangeLedgerOptions {
  store: StateStore;
  /** Null when the studio for this project is not live. */
  engine?: (projectId: ProjectId) => ChangeEngineAccess | null;
  git?: GitService;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export type ChangesErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ENGINE_UNAVAILABLE"
  | "RESTORE_UNAVAILABLE"
  | "RESTORE_CONFLICT"
  | "STALE_PREVIEW"
  | "RESTORE_FAILED"
  | "GIT_UNAVAILABLE"
  | "GIT_FAILED"
  | "COMMIT_REFUSED"
  | "WRITE_CONFLICT"
  | "WRITE_REFUSED";

export class ChangesError extends Error {
  constructor(
    readonly code: ChangesErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ChangesError";
  }
}

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const ENGINE_READ_LIMIT = 16 * 1024 * 1024;
const DEFAULT_WINDOW = 128 * 1024;

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "tar",
  "dmg",
  "pkg",
  "icns",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "mp3",
  "mp4",
  "mov",
  "wav",
  "sqlite",
  "db",
  "bin",
  "o",
  "a",
  "so",
  "dylib",
  "class",
  "jar",
  "exe",
]);

const DELTA_REASONS: Record<string, string> = {
  snapshots_disabled:
    "Workspace snapshots are disabled for this runtime, so no delta was recorded. Tool receipts, when present, are still listed.",
  workspace_too_large:
    "The workspace is larger than the engine's snapshot gate, so no delta was recorded.",
  too_many_files:
    "The workspace has more files than the engine's snapshot gate allows, so no delta was recorded.",
  unsafe_location:
    "The workspace location is not safe for the engine's snapshot store, so no delta was recorded.",
  snapshot_failed: "The engine could not take this turn's snapshot, so no delta was recorded.",
  not_captured:
    "This turn recorded no restore point (for example a compaction or purge), so no delta exists.",
  runtime_restarted:
    "The runtime restarted before this turn's delta settled. It is reconciled, never recomputed.",
  delta_failed: "The engine's own diff failed, so no delta was recorded.",
  receipt_unavailable:
    "Mona could not read this turn's change record from the engine; no delta is claimed.",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function binaryHint(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(extension);
}

function attributionFor(source: string, kind: string): ChangeAttribution {
  if (kind !== "file") return "artifact";
  if (source === "tool_mutation") return "tool";
  if (source === "workspace_changed_during_turn") return "workspace_delta";
  return "workspace_delta";
}

function changeFromEngine(value: TurnArtifactRef["change"]): ChangeKind {
  return value === "created" || value === "updated" || value === "deleted" || value === "renamed"
    ? value
    : "unknown";
}

interface LocalFileState {
  exists: boolean;
  regular: boolean;
  symlink: boolean;
  size: number | null;
  revision: string | null;
}

function readLocalState(absolutePath: string): LocalFileState {
  try {
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink()) {
      return { exists: true, regular: false, symlink: true, size: null, revision: null };
    }
    if (!info.isFile()) {
      return { exists: true, regular: false, symlink: false, size: null, revision: null };
    }
    const hash = createHash("sha256");
    const fd = openSync(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      let read = 0;
      while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, read));
      }
    } finally {
      closeSync(fd);
    }
    return {
      exists: true,
      regular: true,
      symlink: false,
      size: info.size,
      revision: hash.digest("hex"),
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { exists: false, regular: false, symlink: false, size: null, revision: null };
    }
    throw error;
  }
}

interface LocalWindow {
  availability: "available" | "binary" | "oversized" | "missing" | "unsupported";
  content: string | null;
  encoding: "utf-8" | "base64" | null;
  offset: number;
  sizeBytes: number | null;
  revision: string | null;
  truncated: boolean;
  note: string | null;
}

/**
 * Read a bounded window of a workspace file without following symlinks and
 * without leaving the project root. Used only for local previews; writes go
 * through the engine.
 */
export function readLocalWindow(
  root: string,
  path: string,
  offset = 0,
  limit = DEFAULT_WINDOW,
): LocalWindow {
  const checked = validateGitPath(path);
  if (!checked) {
    return {
      availability: "unsupported",
      content: null,
      encoding: null,
      offset,
      sizeBytes: null,
      revision: null,
      truncated: false,
      note: "the path is not a plain workspace-relative file",
    };
  }
  const rootReal = realpathSync(root);
  const absolute = resolve(rootReal, checked);
  let state: LocalFileState;
  try {
    const parent = realpathSync(dirname(absolute));
    if (parent !== rootReal && !parent.startsWith(rootReal + "/")) {
      return {
        availability: "unsupported",
        content: null,
        encoding: null,
        offset,
        sizeBytes: null,
        revision: null,
        truncated: false,
        note: "the path resolves outside the project folder",
      };
    }
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      return {
        availability: "unsupported",
        content: null,
        encoding: null,
        offset,
        sizeBytes: info.size,
        revision: null,
        truncated: false,
        note: info.isSymbolicLink()
          ? "the path is a symlink; Mona reads and writes regular files only"
          : "the path is not a regular file",
      };
    }
    if (info.size > ENGINE_READ_LIMIT) {
      return {
        availability: "oversized",
        content: null,
        encoding: null,
        offset,
        sizeBytes: info.size,
        revision: null,
        truncated: false,
        note: "the file is larger than 16 MiB; open it in Finder instead",
      };
    }
    state = readLocalState(absolute);
  } catch {
    return {
      availability: "missing",
      content: null,
      encoding: null,
      offset,
      sizeBytes: null,
      revision: null,
      truncated: false,
      note: "the file or its parent folder is not available",
    };
  }
  if (!state.exists) {
    return {
      availability: "missing",
      content: null,
      encoding: null,
      offset,
      sizeBytes: null,
      revision: null,
      truncated: false,
      note: "the file does not exist now",
    };
  }
  if (!state.regular) {
    return {
      availability: "unsupported",
      content: null,
      encoding: null,
      offset,
      sizeBytes: state.size,
      revision: state.revision,
      truncated: false,
      note: state.symlink
        ? "the path is a symlink; Mona reads and writes regular files only"
        : "the path is not a regular file",
    };
  }
  if ((state.size ?? 0) > ENGINE_READ_LIMIT) {
    return {
      availability: "oversized",
      content: null,
      encoding: null,
      offset,
      sizeBytes: state.size,
      revision: state.revision,
      truncated: false,
      note: "the file is larger than 16 MiB; open it in Finder instead",
    };
  }
  const size = state.size ?? 0;
  const bytesToRead = Math.min(Math.max(0, size - offset), Math.min(limit, MAX_PREVIEW_BYTES));
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(absolute, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, offset);
  } finally {
    closeSync(fd);
  }
  const nul = buffer.includes(0);
  if (nul) {
    return {
      availability: "binary",
      content: null,
      encoding: "base64",
      offset,
      sizeBytes: size,
      revision: state.revision,
      truncated: false,
      note: "the file contains binary bytes; no text is displayed",
    };
  }
  return {
    availability: "available",
    content: buffer.toString("utf8"),
    encoding: "utf-8",
    offset,
    sizeBytes: size,
    revision: state.revision,
    truncated: offset + bytesToRead < size,
    note: null,
  };
}

function applyWindow(
  text: string,
  offset: number,
  limit: number,
): { content: string; truncated: boolean } {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + limit);
  return { content: text.slice(start, end), truncated: end < text.length };
}

/**
 * The change ledger. One instance owns the read projections and the two
 * mutating paths (restore and commit). It serializes restore per project so two
 * requests cannot interleave on one workspace.
 */
export class ChangeLedger {
  private readonly store: StateStore;
  private readonly engineAccess: (projectId: ProjectId) => ChangeEngineAccess | null;
  private readonly git: GitService;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly restoring = new Set<string>();
  private readonly probeCache = new Map<string, { at: number; value: RestoreCapability }>();

  constructor(options: ChangeLedgerOptions) {
    this.store = options.store;
    this.engineAccess = options.engine ?? (() => null);
    this.git = options.git ?? new GitService();
    this.now = options.now ?? (() => new Date());
    this.newId =
      options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
  }

  // --------------------------------------------------------------- capture

  /**
   * Capture one finished turn from the live engine route, falling back to the
   * event payload it already delivered. A failure is stored as an explicit
   * unavailable receipt, never as an empty diff.
   */
  async captureTurn(input: {
    projectId: ProjectId;
    threadId: string;
    engineThreadId: string;
    turnId: string;
    adapter: EngineAdapter;
    payload: unknown;
  }): Promise<void> {
    try {
      const result = await input.adapter.readTurnArtifacts({
        threadId: input.engineThreadId as never,
        turnId: input.turnId as never,
      });
      await this.store.upsertChangeSet({
        projectId: input.projectId,
        threadId: input.threadId,
        engineThreadId: input.engineThreadId,
        turnId: input.turnId,
        state: result.workspace ? result.workspace.state : "unavailable",
        reason: result.workspace?.reason ?? (result.workspace ? null : "not_captured"),
        preSnapshotId: result.workspace?.preSnapshotId ?? null,
        postSnapshotId: result.workspace?.postSnapshotId ?? null,
        origin: "engine",
        // A route read that produced no workspace is weaker evidence than a
        // settled event: rank it so it can never erase a complete receipt.
        evidenceRank: result.workspace?.state === "settled" ? 3 : result.workspace !== null ? 2 : 1,
        truncated: result.workspace?.truncated ?? false,
        omitted: result.workspace?.omitted ?? null,
        note: this.noteForState(
          result.workspace?.state ?? "unavailable",
          result.workspace?.reason ?? (result.workspace ? null : "not_captured"),
        ),
        files: result.artifacts.flatMap((artifact) => {
          const file = this.toStoredFile(artifact);
          return file ? [file] : [];
        }),
      });
      return;
    } catch (error) {
      await this.capturePayload({
        projectId: input.projectId,
        threadId: input.threadId,
        engineThreadId: input.engineThreadId,
        turnId: input.turnId,
        payload: input.payload,
        origin: "turn.completed",
        fallbackReason: errorMessage(error),
      });
    }
  }

  /** A `turn.artifacts` event carries the same projection the route returns. */
  async captureArtifactsEvent(input: {
    projectId: ProjectId;
    threadId: string;
    engineThreadId: string;
    turnId: string;
    payload: unknown;
  }): Promise<void> {
    await this.capturePayload({
      ...input,
      origin: "turn.artifacts",
      fallbackReason: null,
    });
  }

  private async capturePayload(input: {
    projectId: ProjectId;
    threadId: string;
    engineThreadId: string;
    turnId: string;
    payload: unknown;
    origin: ChangeSetOrigin;
    fallbackReason: string | null;
  }): Promise<void> {
    const payload = objectValue(input.payload) ?? {};
    const workspace = objectValue(payload.workspace);
    const artifacts = arrayValue(payload.artifacts);
    if (!workspace && artifacts.length === 0) {
      if (input.fallbackReason === null) return;
      await this.store.upsertChangeSet({
        projectId: input.projectId,
        threadId: input.threadId,
        engineThreadId: input.engineThreadId,
        turnId: input.turnId,
        state: "unavailable",
        reason: "receipt_unavailable",
        origin: input.origin,
        evidenceRank: 1,
        note: `${DELTA_REASONS.receipt_unavailable} (${input.fallbackReason})`,
        files: [],
      });
      return;
    }
    const rawState = workspace?.state;
    const state: ChangeSetState =
      rawState === "pending" || rawState === "settled" || rawState === "unavailable"
        ? rawState
        : "unavailable";
    const reason = stringValue(workspace?.reason);
    const hasFiles = artifacts.length > 0;
    const rank = state === "settled" ? 3 : hasFiles ? 2 : 1;
    await this.store.upsertChangeSet({
      projectId: input.projectId,
      threadId: input.threadId,
      engineThreadId: input.engineThreadId,
      turnId: input.turnId,
      state,
      reason,
      preSnapshotId: stringValue(workspace?.pre_turn_snapshot_id),
      postSnapshotId: stringValue(workspace?.post_turn_snapshot_id),
      origin: input.origin,
      evidenceRank: rank,
      truncated: workspace?.truncated === true,
      omitted: numberValue(workspace?.omitted),
      note: this.noteForState(state, reason),
      files: artifacts.flatMap((value) => {
        const artifact = this.toArtifactRef(value);
        if (!artifact) return [];
        const file = this.toStoredFile(artifact);
        return file ? [file] : [];
      }),
    });
  }

  private noteForState(state: ChangeSetState, reason: string | null): string | null {
    if (state === "pending") {
      return "The engine is still computing this turn's workspace delta. The files below are what tool receipts already recorded.";
    }
    if (state === "unavailable") {
      return DELTA_REASONS[reason ?? ""] ?? "The engine reported no workspace delta for this turn.";
    }
    return null;
  }

  private toArtifactRef(value: unknown): TurnArtifactRef | null {
    const ref = objectValue(value);
    if (!ref) return null;
    const path = stringValue(ref.path);
    const id = stringValue(ref.id);
    if (!path || !id) return null;
    const kind = ref.kind;
    const change = ref.change;
    const source = ref.source;
    return {
      id,
      kind: kind === "file" || kind === "tool_output" || kind === "media" ? kind : "unknown",
      path,
      change:
        change === "created" || change === "updated" || change === "deleted" || change === "renamed"
          ? change
          : "unknown",
      previousPath: stringValue(ref.previous_path),
      sizeBytes: numberValue(ref.size),
      revision: stringValue(ref.revision),
      contentType: stringValue(ref.content_type),
      sessionId: stringValue(ref.session_id),
      itemId: stringValue(ref.item_id),
      toolCallId: stringValue(ref.tool_call_id),
      toolName: stringValue(ref.tool_name),
      source:
        source === "tool_mutation" ||
        source === "tool_output_spill" ||
        source === "tool_media" ||
        source === "workspace_changed_during_turn"
          ? source
          : "unknown",
      restoreSnapshotId: stringValue(ref.restore_snapshot_id),
      recordedAt: stringValue(ref.recorded_at),
    };
  }

  private toStoredFile(artifact: TurnArtifactRef): StoredChangeFile | null {
    if (artifact.kind === "unknown" || artifact.source === "unknown") return null;
    return {
      artifactId: artifact.id || null,
      path: artifact.path,
      previousPath: artifact.previousPath,
      kind: artifact.kind,
      change: changeFromEngine(artifact.change),
      source: artifact.source,
      toolName: artifact.toolName,
      toolCallId: artifact.toolCallId,
      itemId: artifact.itemId,
      sizeBytes: artifact.sizeBytes,
      revision: artifact.revision,
      restoreSnapshotId: artifact.restoreSnapshotId,
    };
  }

  // --------------------------------------------------------------- read view

  async snapshot(projectId: ProjectId, options: { limit?: number } = {}): Promise<ChangesSnapshot> {
    const project = await this.requireProject(projectId);
    const stored = await this.store.readChangeSets(projectId, options.limit ?? 20);
    const sets: ChangeSetView[] = [];
    for (const set of stored) {
      sets.push(await this.toSetView(set));
    }
    const engine = this.engineAccess(projectId);
    const restore = await this.restoreAvailability(projectId, engine, stored[0] ?? null);
    const git = await this.gitState(project, stored);
    const lastCommit = await this.store.latestCommit(projectId);
    const notes = [
      "A change receipt is the engine's record of what changed; it is not proof that every related file was written by the agent.",
    ];
    const missingDeltas = sets.filter((set) => set.state === "unavailable").length;
    if (missingDeltas > 0) {
      notes.push(
        `${missingDeltas} turn${missingDeltas === 1 ? "" : "s"} have no workspace delta. That is a missing receipt, not an empty diff.`,
      );
    }
    const unreceipted = git.entries.filter((entry) => entry.attribution === "unreceipted").length;
    if (unreceipted > 0) {
      notes.push(
        `${unreceipted} changed path${unreceipted === 1 ? "" : "s"} have no Mona receipt; they may be pre-existing, staged before this review, or edited outside Mona.`,
      );
    }
    if (!git.available && git.reason) notes.push(git.reason);
    if (!engine) {
      notes.push(
        "The live studio is not connected. Stored receipts and current files are shown; restore and checked writes need the running studio.",
      );
    }
    const sawTruncated = sets.some((set) => set.truncated);
    if (sawTruncated) {
      notes.push(
        "The engine capped at least one turn's artifact list; the omitted count is shown on that turn.",
      );
    }
    return {
      projectId,
      sets,
      git,
      lastCommit: lastCommit
        ? {
            shortHash: lastCommit.shortHash,
            subject: lastCommit.subject,
            paths: lastCommit.paths,
            createdAt: lastCommit.createdAt,
          }
        : null,
      receipts: {
        available: engine !== null,
        reason: engine
          ? null
          : "Stored receipts are shown. Connect the studio to re-read them from the engine.",
      },
      restore,
      notes,
      generatedAt: this.now().toISOString(),
    };
  }

  private async toSetView(set: StoredChangeSet): Promise<ChangeSetView> {
    const tools = await this.toolReceipts(set);
    return {
      id: set.id,
      turnId: set.turnId,
      threadId: set.threadId,
      taskId: set.taskId,
      state: set.state,
      reason: set.reason,
      preSnapshotId: set.preSnapshotId,
      postSnapshotId: set.postSnapshotId,
      capturedAt: set.capturedAt,
      origin: set.origin,
      truncated: set.truncated,
      omitted: set.omitted,
      files: set.files.map((file) => ({
        artifactId: file.artifactId,
        path: file.path,
        previousPath: file.previousPath,
        kind: file.kind,
        change: file.change,
        source: file.source,
        attribution: attributionFor(file.source, file.kind),
        toolName: file.toolName,
        toolCallId: file.toolCallId,
        itemId: file.itemId,
        sizeBytes: file.sizeBytes,
        revision: file.revision,
        restoreSnapshotId: file.restoreSnapshotId,
        binaryHint: binaryHint(file.path),
        oversized: (file.sizeBytes ?? 0) > ENGINE_READ_LIMIT,
      })),
      tools,
      note: set.note,
    };
  }

  private async toolReceipts(set: StoredChangeSet): Promise<ToolReceiptView[]> {
    const items = await this.store.listTurnItems(set.threadId, set.turnId, 200);
    const receipts: ToolReceiptView[] = [];
    for (const item of items) {
      const payload = objectValue(item.payload);
      const record = objectValue(payload?.item) ?? payload;
      if (!record) continue;
      const kind = stringValue(record.kind);
      if (kind !== null && kind !== "tool_call") continue;
      const artifacts = arrayValue(record.artifacts).flatMap((value) => {
        const artifact = objectValue(value);
        const id = artifact ? stringValue(artifact.id) : null;
        if (!artifact || !id) return [];
        return [
          {
            id,
            kind: stringValue(artifact.kind) ?? "unknown",
            path: stringValue(artifact.path),
            sizeBytes: numberValue(artifact.size),
            mediaType: stringValue(artifact.content_type),
          },
        ];
      });
      const status =
        stringValue(record.status) ?? (item.kind === "item.failed" ? "failed" : "completed");
      receipts.push({
        itemId: stringValue(record.id) ?? stringValue(record.item_id),
        toolCallId: stringValue(record.tool_call_id) ?? stringValue(record.call_id),
        toolName: stringValue(record.tool_name) ?? stringValue(record.name),
        status,
        summary: stringValue(record.summary) ?? stringValue(record.detail) ?? "",
        artifacts,
      });
    }
    return receipts;
  }

  private async gitState(project: StoredProject, sets: StoredChangeSet[]): Promise<GitStateView> {
    const receipted = new Map<
      string,
      { changeSetId: string; turnId: string; source: string; toolName: string | null }
    >();
    for (const set of sets) {
      for (const file of set.files) {
        if (file.kind !== "file") continue;
        if (receipted.has(file.path)) continue;
        receipted.set(file.path, {
          changeSetId: set.id,
          turnId: set.turnId,
          source: file.source,
          toolName: file.toolName,
        });
      }
    }
    let report;
    try {
      report = await this.git.status(project.canonicalPath);
    } catch (error) {
      return {
        available: false,
        reason: errorMessage(error),
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
        counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        stagedBeforeReview: 0,
      };
    }
    const entries: GitEntryView[] = report.entries.map((entry) => {
      const receipt = receipted.get(entry.path) ?? null;
      const attribution: ChangeAttribution = receipt
        ? receipt.source === "tool_mutation"
          ? "tool"
          : "workspace_delta"
        : "unreceipted";
      return {
        path: entry.path,
        originalPath: entry.originalPath,
        indexStatus: entry.indexStatus,
        worktreeStatus: entry.worktreeStatus,
        staged: entry.staged,
        unstaged: entry.unstaged,
        untracked: entry.untracked,
        conflicted: entry.conflicted,
        attribution,
        receipt: receipt
          ? {
              changeSetId: receipt.changeSetId,
              turnId: receipt.turnId,
              toolName: receipt.toolName,
            }
          : null,
      };
    });
    return {
      available: report.available,
      reason: report.reason,
      root: report.root,
      branch: report.branch,
      detached: report.detached,
      worktree: report.worktree,
      upstream: report.upstream,
      ahead: report.ahead,
      behind: report.behind,
      head: report.head,
      entries,
      truncated: report.truncated,
      counts: {
        staged: entries.filter((entry) => entry.staged).length,
        unstaged: entries.filter((entry) => entry.unstaged).length,
        untracked: entries.filter((entry) => entry.untracked).length,
        conflicted: entries.filter((entry) => entry.conflicted).length,
      },
      stagedBeforeReview: entries.filter((entry) => entry.staged).length,
    };
  }

  // ------------------------------------------------------------- file views

  async fileWindow(input: {
    projectId: ProjectId;
    changeSetId?: string;
    path: string;
    mode: FileWindowMode;
    offset?: number;
    limit?: number;
  }): Promise<FileWindowView> {
    const project = await this.requireProject(input.projectId);
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_WINDOW), 262_144);
    const set = await this.findSet(input.projectId, input.changeSetId, input.path);
    const engine = this.engineAccess(input.projectId);
    const base: FileWindowView = {
      path: input.path,
      mode: input.mode,
      availability: "unsupported",
      content: null,
      diff: null,
      encoding: null,
      offset,
      nextOffset: offset,
      totalBytes: null,
      truncated: false,
      revision: null,
      source: null,
      canEdit: false,
      note: null,
    };
    if (!set) {
      return {
        ...base,
        availability: "unsupported",
        note: "No stored change record names this path.",
      };
    }
    const ref = set.files.find((file) => file.path === input.path) ?? null;
    if (!ref) {
      return {
        ...base,
        availability: "unsupported",
        note: "This change set does not name that path.",
      };
    }
    if (input.mode === "diff") {
      return this.diffWindow({ project, engine, set, ref, offset, limit, base });
    }
    return this.textWindow({ project, engine, set, ref, offset, limit, base });
  }

  private async diffWindow(input: {
    project: StoredProject;
    engine: ChangeEngineAccess | null;
    set: StoredChangeSet;
    ref: StoredChangeSet["files"][number];
    offset: number;
    limit: number;
    base: FileWindowView;
  }): Promise<FileWindowView> {
    const { engine, set, ref, offset, limit, base } = input;
    if (ref.kind !== "file") {
      return {
        ...base,
        availability: "unsupported",
        note: "Tool output is not a diff; open it as text or media instead.",
      };
    }
    if (ref.toolCallId && engine) {
      try {
        const changes = await engine.adapter.readCallChanges({
          threadId: set.engineThreadId as never,
          turnId: set.turnId as never,
          toolCallId: ref.toolCallId,
        });
        if (changes.state === "pending") {
          return {
            ...base,
            availability: "unsupported",
            note: "The engine is still computing this call's span. Refresh after it settles.",
          };
        }
        if (changes.state === "unavailable") {
          return {
            ...base,
            availability: "unsupported",
            note: `The engine cannot resolve this call's span (${changes.reason ?? "unknown reason"}). The receipt still names the path and revision.`,
          };
        }
        const file = changes.files.find((entry) => entry.path === ref.path);
        if (!file) {
          return {
            ...base,
            availability: "unsupported",
            note: "The captured call span changed no file at this path.",
          };
        }
        if (file.diff === null) {
          return {
            ...base,
            availability: "unsupported",
            note: "The engine recorded this file but produced no patch for it (binary or no content delta).",
          };
        }
        const window = applyWindow(file.diff, offset, limit);
        return {
          ...base,
          availability: "available",
          diff: window.content,
          offset,
          nextOffset: offset + window.content.length,
          truncated: window.truncated || file.diffTruncated || changes.truncated,
          revision: file.revision,
          source: "snapshot",
          canEdit: false,
          note: file.diffTruncated
            ? "The engine truncated this patch."
            : changes.truncated
              ? "The engine capped the call's file list."
              : null,
        };
      } catch (error) {
        return {
          ...base,
          availability: "error",
          note: `The engine did not answer the call-changes route: ${errorMessage(error)}`,
        };
      }
    }
    // No call-level receipt: show the current local Git diff, labelled as such.
    try {
      const status = await this.git.status(input.project.canonicalPath);
      const entry = status.entries.find((candidate) => candidate.path === ref.path);
      if (!status.available) {
        return { ...base, availability: "unsupported", note: status.reason };
      }
      if (!entry) {
        return {
          ...base,
          availability: "unsupported",
          note: "The engine recorded no per-call diff, and Git reports no current change at this path.",
        };
      }
      if (entry.untracked) {
        return {
          ...base,
          availability: "unsupported",
          note: "The file is untracked, so Git has no baseline diff. Open it as text instead.",
        };
      }
      const diff = await this.git.diff(input.project.canonicalPath, ref.path, {
        staged: entry.staged && !entry.unstaged,
      });
      const window = applyWindow(diff.diff, offset, limit);
      return {
        ...base,
        availability: diff.binary ? "binary" : "available",
        diff: diff.binary ? null : window.content,
        offset,
        nextOffset: offset + (diff.binary ? 0 : window.content.length),
        truncated: window.truncated || diff.truncated,
        source: "git",
        note: "This is the current local Git diff, not a per-call engine diff; the engine recorded no call-level patch for this path.",
      };
    } catch (error) {
      return {
        ...base,
        availability: "error",
        note: `Git did not answer: ${errorMessage(error)}`,
      };
    }
  }

  private async textWindow(input: {
    project: StoredProject;
    engine: ChangeEngineAccess | null;
    set: StoredChangeSet;
    ref: StoredChangeSet["files"][number];
    offset: number;
    limit: number;
    base: FileWindowView;
  }): Promise<FileWindowView> {
    const { project, engine, set, ref, offset, limit, base } = input;
    if (ref.kind === "file") {
      if (engine && ref.artifactId) {
        try {
          const artifact = await engine.adapter.readTurnArtifact({
            threadId: set.engineThreadId as never,
            turnId: set.turnId as never,
            artifactId: ref.artifactId,
            offset,
            limit,
          });
          if (artifact.availability === "available") {
            return {
              ...base,
              availability: "available",
              content: artifact.content,
              encoding: artifact.encoding,
              offset: artifact.offset,
              nextOffset:
                artifact.offset +
                (artifact.content ? Buffer.byteLength(artifact.content, "utf8") : 0),
              totalBytes: artifact.totalBytes,
              truncated: artifact.truncated,
              revision: artifact.revision ?? ref.revision,
              source:
                artifact.current === true
                  ? "workspace"
                  : artifact.current === false
                    ? "snapshot"
                    : null,
              canEdit:
                artifact.current === true && engine !== null && sameWorkspace(project, engine),
              note:
                artifact.current === false
                  ? "Read from the turn's post-turn snapshot; the workspace no longer holds this revision."
                  : artifact.current === null
                    ? "The engine did not report whether the workspace still holds this revision, so the editor is disabled."
                    : null,
            };
          }
          if (artifact.availability === "missing") {
            return {
              ...base,
              availability: "missing",
              revision: ref.revision,
              source: "snapshot",
              note: artifact.note,
            };
          }
          if (artifact.availability === "oversized") {
            return {
              ...base,
              availability: "oversized",
              totalBytes: ref.sizeBytes,
              revision: ref.revision,
              note: artifact.note,
            };
          }
          return {
            ...base,
            availability: "binary",
            encoding: "base64",
            revision: ref.revision,
            note: artifact.note,
          };
        } catch (error) {
          // Fall through to the current workspace read.
          void error;
        }
      }
      if (engine && sameWorkspace(project, engine)) {
        try {
          const window = await engine.adapter.readWorkspaceFile({
            path: ref.path,
            offset,
            limit,
          });
          if (window.availability === "available" || window.availability === "binary") {
            return {
              ...base,
              availability: window.availability === "binary" ? "binary" : "available",
              content: window.content,
              encoding: window.encoding,
              offset: window.offset,
              nextOffset:
                window.offset + (window.content ? Buffer.byteLength(window.content, "utf8") : 0),
              totalBytes: window.sizeBytes,
              truncated: window.truncated,
              revision: window.revision,
              source: "workspace",
              canEdit: window.availability === "available",
              note: window.note,
            };
          }
          if (window.availability === "missing") {
            return {
              ...base,
              availability: "missing",
              note:
                ref.change === "deleted"
                  ? "The turn deleted this file; the engine's recorded revision was not readable."
                  : window.note,
            };
          }
          return {
            ...base,
            availability:
              window.availability === "oversized"
                ? "oversized"
                : window.availability === "forbidden"
                  ? "unsupported"
                  : "error",
            note: window.note,
          };
        } catch (error) {
          void error;
        }
      }
      const local = readLocalWindow(project.canonicalPath, ref.path, offset, limit);
      return {
        ...base,
        availability:
          local.availability === "available"
            ? "available"
            : local.availability === "binary"
              ? "binary"
              : local.availability === "oversized"
                ? "oversized"
                : local.availability === "missing"
                  ? "missing"
                  : "unsupported",
        content: local.content,
        encoding: local.encoding,
        offset: local.offset,
        nextOffset: local.offset + (local.content ? Buffer.byteLength(local.content, "utf8") : 0),
        totalBytes: local.sizeBytes,
        truncated: local.truncated,
        revision: local.revision ?? ref.revision,
        source: "workspace",
        canEdit: false,
        note:
          local.availability === "missing" && ref.change === "deleted"
            ? "The turn deleted this file. The recorded revision may still be readable from the engine."
            : local.note,
      };
    }
    // Tool output and media bytes live in the engine's session store.
    if (!engine) {
      return {
        ...base,
        availability: "unsupported",
        note: "Connect the studio to read tool output bytes; Mona does not keep a second copy.",
      };
    }
    if (!ref.artifactId) {
      return {
        ...base,
        availability: "unsupported",
        note: "The receipt carries no artifact id for this output.",
      };
    }
    try {
      const artifact = await engine.adapter.readTurnArtifact({
        threadId: set.engineThreadId as never,
        turnId: set.turnId as never,
        artifactId: ref.artifactId,
        offset,
        limit,
      });
      return {
        ...base,
        availability:
          artifact.availability === "available"
            ? "available"
            : artifact.availability === "missing"
              ? "missing"
              : artifact.availability === "oversized"
                ? "oversized"
                : "binary",
        content: artifact.content,
        encoding: artifact.encoding,
        offset: artifact.offset,
        nextOffset:
          artifact.offset + (artifact.content ? Buffer.byteLength(artifact.content, "utf8") : 0),
        totalBytes: artifact.totalBytes,
        truncated: artifact.truncated,
        revision: artifact.revision,
        source: "artifact",
        canEdit: false,
        note: artifact.note,
      };
    } catch (error) {
      return {
        ...base,
        availability: "error",
        note: `The engine did not answer the artifact route: ${errorMessage(error)}`,
      };
    }
  }

  async artifactWindow(input: {
    projectId: ProjectId;
    changeSetId: string;
    artifactId: string;
    offset?: number;
    limit?: number;
  }): Promise<ArtifactWindowView> {
    await this.requireProject(input.projectId);
    const set = await this.store.getChangeSet(input.changeSetId);
    if (!set || set.projectId !== input.projectId) {
      throw new ChangesError("NOT_FOUND", "that change set does not exist for this project");
    }
    const ref = set.files.find((file) => file.artifactId === input.artifactId) ?? null;
    const base: ArtifactWindowView = {
      artifactId: input.artifactId,
      availability: "unsupported",
      mediaType: null,
      sizeBytes: null,
      content: null,
      encoding: null,
      offset: input.offset ?? 0,
      nextOffset: input.offset ?? 0,
      truncated: false,
      note: null,
    };
    if (!ref) {
      return { ...base, note: "This change set does not record that artifact id." };
    }
    const engine = this.engineAccess(input.projectId);
    if (!engine) {
      return {
        ...base,
        mediaType: null,
        sizeBytes: ref.sizeBytes,
        note: "Connect the studio to read tool output bytes; Mona does not keep a second copy.",
      };
    }
    try {
      const artifact = await engine.adapter.readTurnArtifact({
        threadId: set.engineThreadId as never,
        turnId: set.turnId as never,
        artifactId: input.artifactId,
        offset: input.offset,
        limit: input.limit,
      });
      const mediaType =
        set.files.find((file) => file.artifactId === input.artifactId)?.kind === "media"
          ? "media"
          : null;
      return {
        artifactId: input.artifactId,
        availability:
          artifact.availability === "available"
            ? "available"
            : artifact.availability === "missing"
              ? "missing"
              : artifact.availability === "oversized"
                ? "oversized"
                : "binary",
        mediaType,
        sizeBytes: artifact.totalBytes ?? ref.sizeBytes,
        content: artifact.content,
        encoding: artifact.encoding,
        offset: artifact.offset,
        nextOffset:
          artifact.offset + (artifact.content ? Buffer.byteLength(artifact.content, "utf8") : 0),
        truncated: artifact.truncated,
        note: artifact.note,
      };
    } catch (error) {
      return {
        ...base,
        sizeBytes: ref.sizeBytes,
        note: `The engine did not answer the artifact route: ${errorMessage(error)}`,
      };
    }
  }

  // ---------------------------------------------------------------- restore

  private async restoreAvailability(
    projectId: ProjectId,
    engine: ChangeEngineAccess | null,
    latest: StoredChangeSet | null,
  ): Promise<{ available: boolean; reason: string | null }> {
    if (!engine) {
      return {
        available: false,
        reason:
          "Start the studio for this project to restore files through the engine's checked revert route. Mona does not keep a second snapshot store.",
      };
    }
    if (!latest) {
      return {
        available: false,
        reason: "No turn receipt exists yet. Restore needs an engine-recorded restore point.",
      };
    }
    const key = `${projectId}:${latest.engineThreadId}`;
    const cached = this.probeCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) {
      return {
        available: cached.value.fileRevert,
        reason: cached.value.reason,
      };
    }
    try {
      const probe = await engine.adapter.probeRestore(latest.engineThreadId as never);
      this.probeCache.set(key, { at: Date.now(), value: probe });
      return { available: probe.fileRevert, reason: probe.reason };
    } catch (error) {
      this.probeCache.delete(key);
      return {
        available: false,
        reason: `The engine's restore probe failed: ${errorMessage(error)}`,
      };
    }
  }

  async restorePreview(input: {
    projectId: ProjectId;
    changeSetId: string;
    paths: string[];
  }): Promise<RestorePreviewView> {
    const project = await this.requireProject(input.projectId);
    const set = await this.requireSet(input.projectId, input.changeSetId);
    const engine = this.engineAccess(input.projectId);
    const availability = await this.restoreAvailability(input.projectId, engine, set);
    const recoveryNote =
      "Every revert is preceded by a mandatory pre-restore snapshot of the workspace. " +
      "The engine keeps the newest 50 snapshots plus the newest 50 turn boundaries, so recovery is not permanent.";
    const scope: RestoreScopeEntry[] = [];
    const exclusions: RestorePreviewView["exclusions"] = [];
    const conflicts: RestoreConflict[] = [];
    let recent: Array<{ id: string; label: string; timestamp: number | null }> = [];
    if (engine) {
      try {
        recent = (await engine.adapter.listSnapshots(5)).map((entry) => ({
          id: entry.id,
          label: entry.label,
          timestamp: entry.timestamp,
        }));
      } catch {
        recent = [];
      }
    }
    const selected = [...new Set(input.paths)];
    for (const path of selected) {
      const ref = set.files.find((file) => file.path === path);
      if (!ref) {
        exclusions.push({
          path,
          reason: "unsupported",
          detail: "This change set does not record that path.",
        });
        continue;
      }
      if (ref.kind !== "file") {
        exclusions.push({
          path,
          reason: "not_a_workspace_file",
          detail:
            ref.kind === "media"
              ? "Media bytes are an artifact, not a workspace file the engine can revert."
              : "Tool output is an artifact, not a workspace file the engine can revert.",
        });
        continue;
      }
      const checked = validateGitPath(path);
      if (!checked) {
        exclusions.push({
          path,
          reason: "outside_workspace",
          detail: "The path is not a plain workspace-relative file.",
        });
        continue;
      }
      if (!ref.restoreSnapshotId) {
        exclusions.push({
          path,
          reason: "no_restore_point",
          detail:
            ref.source === "workspace_changed_during_turn"
              ? "The engine recorded no pre-turn restore point for this path."
              : "The engine recorded no restore point for this call. The path may be excluded from snapshots (binary, build output, or .gitignore).",
        });
        continue;
      }
      let local: LocalFileState;
      try {
        local = readLocalState(safeAbsolute(project.canonicalPath, checked));
      } catch (error) {
        exclusions.push({
          path,
          reason: "unsupported",
          detail: `The file could not be inspected: ${errorMessage(error)}`,
        });
        continue;
      }
      if (local.exists && !local.regular) {
        conflicts.push({
          path,
          kind: "not_a_regular_file",
          detail: local.symlink
            ? "The path is now a symlink. The engine reverts regular files only."
            : "The path is no longer a regular file.",
        });
        continue;
      }
      const expectedHash = local.exists && local.revision ? `sha256:${local.revision}` : "absent";
      if (local.exists && !local.revision) {
        exclusions.push({
          path,
          reason: "unsupported",
          detail: "The current file's hash could not be read.",
        });
        continue;
      }
      if (ref.revision) {
        if (!local.exists && ref.change !== "deleted") {
          conflicts.push({
            path,
            kind: "changed_after_turn",
            detail:
              "The file was deleted after the turn. Restoring it recreates the pre-turn content.",
          });
        } else if (local.revision && local.revision !== ref.revision) {
          conflicts.push({
            path,
            kind: "changed_after_turn",
            detail: `The file changed after the turn (recorded ${ref.revision.slice(0, 8)}, now ${local.revision.slice(0, 8)}).`,
          });
        }
      } else if (ref.change === "deleted") {
        if (local.exists) {
          conflicts.push({
            path,
            kind: "changed_after_turn",
            detail: "The file the turn deleted exists again; restoring would overwrite it.",
          });
        }
      } else if (local.exists) {
        // The engine recorded no revision for this path (a deleted turn path or
        // a delta blob over 16 MiB), so Mona cannot tell whether the file
        // changed after the turn. Never overwrite that silently.
        conflicts.push({
          path,
          kind: "unverifiable_revision",
          detail:
            "The engine recorded no revision for this path, so Mona cannot prove the bytes are still the turn's. Review the file, then acknowledge if reverting is still intended.",
        });
      }
      if (ref.source === "workspace_changed_during_turn") {
        conflicts.push({
          path,
          kind: "unattributed_change",
          detail:
            "The engine saw this path change during the turn but did not attribute it to a tool. It may be your edit; restoring pulls it back to the turn-start snapshot.",
        });
      }
      const action: RestoreScopeEntry["action"] =
        ref.change === "deleted" ? "recreated" : ref.change === "created" ? "removed" : "modified";
      scope.push({
        path,
        action,
        expectedHash,
        currentRevision: local.revision,
        recordedRevision: ref.revision,
        note:
          ref.change === "renamed" && ref.previousPath
            ? `The turn renamed ${ref.previousPath}; only this path is reverted.`
            : null,
      });
    }
    const requiresAcknowledgement = [
      ...new Set(
        conflicts
          .filter((conflict) => conflict.kind !== "already_matches")
          .map((conflict) => conflict.path),
      ),
    ];
    const planHash = sha256Hex(
      JSON.stringify({
        changeSetId: set.id,
        turnId: set.turnId,
        engine: availability.available,
        scope: [...scope]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((entry) => [entry.path, entry.action, entry.expectedHash]),
        conflicts: [...conflicts]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((entry) => [entry.path, entry.kind]),
      }),
    );
    return {
      projectId: input.projectId,
      changeSetId: set.id,
      turnId: set.turnId,
      planHash,
      generatedAt: this.now().toISOString(),
      engine: { available: availability.available, reason: availability.reason },
      scope,
      exclusions,
      conflicts,
      requiresAcknowledgement,
      recovery: {
        mechanism: "engine pre-restore snapshot",
        durable: false,
        note: recoveryNote,
        recent,
      },
      canRestore: availability.available && scope.length > 0,
      note:
        set.state === "pending"
          ? "The engine had not finished this turn's delta when it was captured; the scope is what the receipt names now."
          : set.state === "unavailable"
            ? "This turn has no complete delta. Only tool receipts with a recorded restore point can be reverted."
            : "The scope below is exactly the engine-recorded change for this turn. Nothing outside it is touched.",
    };
  }

  async restore(input: {
    projectId: ProjectId;
    changeSetId: string;
    paths: string[];
    expected: RestoreRequestEntry[];
    acknowledge: string[];
  }): Promise<RestoreResultView> {
    if (this.restoring.has(input.projectId)) {
      throw new ChangesError(
        "RESTORE_CONFLICT",
        "another restore is already running for this project",
      );
    }
    this.restoring.add(input.projectId);
    try {
      const project = await this.requireProject(input.projectId);
      const set = await this.requireSet(input.projectId, input.changeSetId);
      const preview = await this.restorePreview(input);
      const engine = this.engineAccess(input.projectId);
      if (!engine || !preview.engine.available) {
        throw new ChangesError(
          "RESTORE_UNAVAILABLE",
          preview.engine.reason ?? "the engine's restore route is unavailable",
          { preview },
        );
      }
      if (preview.scope.length === 0) {
        throw new ChangesError(
          "RESTORE_UNAVAILABLE",
          "nothing in this selection can be restored; the preview lists why each path is excluded",
          { preview },
        );
      }
      const expectedByPath = new Map(
        input.expected.map((entry) => [entry.path, entry.expectedHash]),
      );
      for (const entry of preview.scope) {
        const supplied = expectedByPath.get(entry.path);
        if (supplied === undefined || supplied !== entry.expectedHash) {
          throw new ChangesError(
            "STALE_PREVIEW",
            "the files changed since the restore preview; review the new preview before restoring",
            { preview },
          );
        }
      }
      const acknowledged = new Set(input.acknowledge);
      const unacknowledged = preview.requiresAcknowledgement.filter(
        (path) => !acknowledged.has(path),
      );
      if (unacknowledged.length > 0) {
        throw new ChangesError(
          "RESTORE_CONFLICT",
          "later or unattributed edits must be acknowledged before they are overwritten",
          { preview, paths: unacknowledged },
        );
      }
      const restored: RestoreResultView["restored"] = [];
      const refused: RestoreResultView["refused"] = [];
      // Anything the user selected that the preview excluded never ran; report
      // it rather than dropping it between preview and execution.
      const inScope = new Set(preview.scope.map((entry) => entry.path));
      let remaining = [
        ...input.paths.filter((path) => !inScope.has(path)),
        ...preview.scope.map((entry) => entry.path),
      ];
      for (const entry of preview.scope) {
        try {
          const receipt = await engine.adapter.revertFile({
            threadId: set.engineThreadId as never,
            path: entry.path,
            snapshotId: set.files.find((file) => file.path === entry.path)?.restoreSnapshotId ?? "",
            expectedHash: entry.expectedHash,
          });
          let afterRevision: string | null = null;
          try {
            afterRevision = readLocalState(
              safeAbsolute(project.canonicalPath, entry.path),
            ).revision;
          } catch {
            afterRevision = null;
          }
          await this.store.recordRestore({
            id: this.newId("rst"),
            projectId: input.projectId,
            changeSetId: set.id,
            threadId: set.threadId,
            turnId: set.turnId,
            path: entry.path,
            action: receipt.action,
            snapshotId: receipt.snapshotId,
            snapshotLabel: receipt.snapshotLabel,
            expectedHash: entry.expectedHash,
            beforeRevision: entry.currentRevision,
            afterRevision,
            outcome: "restored",
            note: null,
          });
          restored.push({
            path: entry.path,
            action: receipt.action,
            snapshotId: receipt.snapshotId,
            snapshotLabel: receipt.snapshotLabel ?? "",
            newRevision: afterRevision,
          });
          remaining = remaining.filter((path) => path !== entry.path);
        } catch (error) {
          const code = error instanceof AdapterError ? error.code : "RESTORE_FAILED";
          const message = errorMessage(error);
          await this.store.recordRestore({
            id: this.newId("rst"),
            projectId: input.projectId,
            changeSetId: set.id,
            threadId: set.threadId,
            turnId: set.turnId,
            path: entry.path,
            action: entry.action,
            snapshotId: set.files.find((file) => file.path === entry.path)?.restoreSnapshotId ?? "",
            expectedHash: entry.expectedHash,
            beforeRevision: entry.currentRevision,
            afterRevision: entry.currentRevision,
            outcome: "failed",
            note: message.slice(0, 2000),
          });
          refused.push({ path: entry.path, code, message });
          remaining = remaining.filter((path) => path !== entry.path);
          break;
        }
      }
      return {
        ok: refused.length === 0,
        restored,
        refused,
        notAttempted: remaining,
        recovery: preview.recovery,
        snapshot: await this.snapshot(input.projectId),
      };
    } finally {
      this.restoring.delete(input.projectId);
    }
  }

  // -------------------------------------------------------------------- git

  async stagePaths(input: { projectId: ProjectId; paths: string[] }): Promise<GitActionResult> {
    const project = await this.requireProject(input.projectId);
    this.requireGit();
    const before = await this.git.status(project.canonicalPath);
    if (!before.available) {
      throw new ChangesError(
        "GIT_UNAVAILABLE",
        before.reason ?? "Git is not available for this folder",
      );
    }
    try {
      await this.git.stage(project.canonicalPath, input.paths);
    } catch (error) {
      throw this.gitFailure(error);
    }
    return {
      ok: true,
      command: `git add -- ${input.paths.length} selected path${input.paths.length === 1 ? "" : "s"}`,
      note: "Only the selected paths were staged. Mona did not reset, unstage, or commit anything else.",
      commit: null,
      status: await this.gitState(project, await this.store.readChangeSets(input.projectId, 20)),
    };
  }

  async commitPaths(input: {
    projectId: ProjectId;
    message: string;
    paths: string[];
    includeUnstaged?: boolean;
  }): Promise<GitActionResult> {
    const project = await this.requireProject(input.projectId);
    this.requireGit();
    const before = await this.git.status(project.canonicalPath);
    if (!before.available) {
      throw new ChangesError(
        "GIT_UNAVAILABLE",
        before.reason ?? "Git is not available for this folder",
      );
    }
    const entries = new Map(before.entries.map((entry) => [entry.path, entry]));
    const missing: string[] = [];
    const mixed: string[] = [];
    for (const path of input.paths) {
      const entry = entries.get(path);
      if (!entry) {
        missing.push(path);
        continue;
      }
      if (entry.staged && entry.unstaged) mixed.push(path);
    }
    if (missing.length > 0) {
      throw new ChangesError(
        "COMMIT_REFUSED",
        "these selected paths have no current Git change; nothing would be committed for them",
        { paths: missing },
      );
    }
    if (mixed.length > 0 && input.includeUnstaged !== true) {
      throw new ChangesError(
        "COMMIT_REFUSED",
        "these selected files also have unstaged edits; committing them would include the whole working-tree content",
        { paths: mixed, includeUnstaged: false },
      );
    }
    let summary: string;
    try {
      await this.git.stage(project.canonicalPath, input.paths);
      const result = await this.git.commit(project.rootPath, input.message, input.paths);
      summary = result.summary;
      if (result.commit) {
        await this.store.recordCommit({
          id: this.newId("cmt"),
          projectId: input.projectId,
          commitHash: result.commit.commit,
          shortHash: result.commit.shortCommit,
          subject: result.commit.subject,
          paths: input.paths,
          message: input.message,
          note: "Committed from Mona's changes surface; unrelated staged entries were left in the index.",
        });
      }
      return {
        ok: true,
        command: `git add + git commit -m "<message>" -- ${input.paths.length} selected path${input.paths.length === 1 ? "" : "s"}`,
        note:
          `${result.commit?.shortCommit ?? "commit"} recorded. ` +
          "Unrelated staged entries and unstaged files were left untouched." +
          (summary ? ` Git said: ${summary.split("\n")[0]}` : ""),
        commit: result.commit
          ? {
              hash: result.commit.commit,
              shortCommit: result.commit.shortCommit,
              subject: result.commit.subject,
            }
          : null,
        status: await this.gitState(project, await this.store.readChangeSets(input.projectId, 20)),
      };
    } catch (error) {
      throw this.gitFailure(error);
    }
  }

  private requireGit(): void {
    if (!this.git.available) {
      throw new ChangesError("GIT_UNAVAILABLE", "Git was not found at a known system location");
    }
  }

  private gitFailure(error: unknown): ChangesError {
    if (error instanceof ChangesError) return error;
    if (error instanceof GitError) {
      if (error.code === "NOTHING_TO_COMMIT") {
        return new ChangesError("COMMIT_REFUSED", error.message, error.details);
      }
      // A command that ran and failed is not the same as Git being absent, and
      // an unsafe path is neither.
      return new ChangesError(
        error.code === "COMMAND_FAILED" || error.code === "INVALID_PATH"
          ? "GIT_FAILED"
          : "GIT_UNAVAILABLE",
        error.message,
        error.details,
      );
    }
    return new ChangesError("GIT_FAILED", errorMessage(error));
  }

  // ---------------------------------------------------------------- editor

  async writeFile(input: {
    projectId: ProjectId;
    path: string;
    content: string;
    expectedRevision: string;
  }): Promise<FileWriteResultView> {
    const project = await this.requireProject(input.projectId);
    const engine = this.engineAccess(input.projectId);
    if (!engine || !sameWorkspace(project, engine)) {
      throw new ChangesError(
        "ENGINE_UNAVAILABLE",
        "Start the studio for this project before editing; Mona writes through the engine's checked route.",
      );
    }
    if (!validateGitPath(input.path)) {
      throw new ChangesError("INVALID_INPUT", "that is not a plain workspace-relative file path");
    }
    try {
      const receipt = await engine.adapter.writeWorkspaceFile({
        path: input.path,
        content: input.content,
        expectedRevision: input.expectedRevision,
      });
      return {
        written: true,
        path: receipt.path,
        revision: receipt.revision,
        sizeBytes: receipt.sizeBytes,
        created: receipt.created,
        note: "Written through the engine's confined write route after checking the revision you edited.",
      };
    } catch (error) {
      if (error instanceof AdapterError && error.code === "WRITE_CONFLICT") {
        throw new ChangesError("WRITE_CONFLICT", error.message, error.details);
      }
      if (error instanceof AdapterError && error.code === "WRITE_REFUSED") {
        throw new ChangesError("WRITE_REFUSED", error.message, error.details);
      }
      throw new ChangesError(
        "WRITE_REFUSED",
        `the engine refused the write: ${errorMessage(error)}`,
      );
    }
  }

  async refresh(projectId: ProjectId): Promise<ChangesSnapshot> {
    const project = await this.requireProject(projectId);
    const engine = this.engineAccess(projectId);
    if (engine) {
      const sets = await this.store.readChangeSets(projectId, 10);
      for (const set of sets) {
        if (set.state === "settled" && set.evidenceRank >= 3) continue;
        try {
          await this.captureTurn({
            projectId,
            threadId: set.threadId,
            engineThreadId: set.engineThreadId,
            turnId: set.turnId,
            adapter: engine.adapter,
            payload: {},
          });
        } catch {
          // captureTurn already stores an honest unavailable receipt.
        }
      }
    }
    void project;
    return this.snapshot(projectId);
  }

  // ------------------------------------------------------------- internals

  private async requireProject(projectId: ProjectId): Promise<StoredProject> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new ChangesError("NOT_FOUND", "that project does not exist");
    return project;
  }

  private async requireSet(projectId: ProjectId, changeSetId: string): Promise<StoredChangeSet> {
    const set = await this.store.getChangeSet(changeSetId);
    if (!set || set.projectId !== projectId) {
      throw new ChangesError("NOT_FOUND", "that change set does not exist for this project");
    }
    return set;
  }

  private async findSet(
    projectId: ProjectId,
    changeSetId: string | undefined,
    path: string,
  ): Promise<StoredChangeSet | null> {
    if (changeSetId) {
      const set = await this.requireSet(projectId, changeSetId);
      return set;
    }
    const sets = await this.store.readChangeSets(projectId, 20);
    return sets.find((set) => set.files.some((file) => file.path === path)) ?? sets[0] ?? null;
  }

  /** Absolute path for the reveal action, validated against the project root. */
  async absoluteWorkspacePath(projectId: ProjectId, path: string): Promise<string> {
    const project = await this.requireProject(projectId);
    const checked = validateGitPath(path);
    if (!checked) {
      throw new ChangesError("INVALID_INPUT", "that is not a plain workspace-relative file path");
    }
    const root = realpathSync(project.rootPath);
    const absolute = resolve(root, checked);
    if (absolute !== root && !absolute.startsWith(root + "/")) {
      throw new ChangesError("INVALID_INPUT", "the path leaves the project folder");
    }
    if (existsSync(absolute)) {
      try {
        if (!statSync(absolute).isFile()) {
          throw new ChangesError("INVALID_INPUT", "that path is not a file");
        }
      } catch {
        // stat raced with removal; reveal the parent instead.
      }
    }
    return absolute;
  }
}

/** Resolve a validated relative path without letting a symlinked parent escape. */
function safeAbsolute(root: string, relativePath: string): string {
  const rootReal = realpathSync(root);
  const absolute = resolve(rootReal, relativePath);
  const parent = realpathSync(dirname(absolute));
  if (parent !== rootReal && !parent.startsWith(rootReal + "/")) {
    throw new ChangesError("INVALID_INPUT", "the path resolves outside the project folder");
  }
  return absolute;
}

function sameWorkspace(project: StoredProject, engine: ChangeEngineAccess): boolean {
  try {
    return realpathSync(engine.workspace) === realpathSync(project.canonicalPath);
  } catch {
    return engine.workspace === project.rootPath || engine.workspace === project.canonicalPath;
  }
}
