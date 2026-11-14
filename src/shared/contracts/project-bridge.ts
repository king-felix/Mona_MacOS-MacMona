import type { ProjectId, TaskId } from "./ids";

/**
 * Result envelope for every project/state IPC call. Expected failures (a stale
 * revision, a moved folder, a missing project) cross the boundary as typed
 * codes instead of Electron's stringified exception.
 */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export type RepositoryKind = "none" | "git" | "git_worktree";

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  rootPath: string;
  canonicalPath: string;
  repositoryKind: RepositoryKind;
  repositoryRoot: string | null;
  worktreeName: string | null;
  accent: string | null;
  monogram: string | null;
  archived: boolean;
  pinned: boolean;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TaskSummary {
  id: TaskId;
  title: string;
  status: string;
  updatedAt: string;
  revision: number;
  dependsOn: TaskId[];
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  engineThreadId: string | null;
  updatedAt: string;
}

/**
 * The envelope identities a stored engine frame carries. `null` means the row
 * predates identity capture (or the engine omitted it); it never means "no
 * item exists", and it is never filled in by guessing.
 */
export interface StoredEventSummary {
  threadId: string;
  seq: number;
  kind: string;
  payload: unknown;
  timestamp: string;
  turnId: string | null;
  itemId: string | null;
}

/**
 * A keyset cursor over one project's stored events, in storage order.
 * `recordedAt` is the store's own receipt time and `rowId` breaks ties inside
 * one millisecond, so pages cannot skip or repeat a row when events arrive
 * between two reads. Sequence numbers are deliberately not the cursor: `seq`
 * is one global engine counter shared by every thread, and a hole in it is
 * never evidence that this transcript lost a frame.
 */
export interface HistoryCursor {
  recordedAt: string;
  rowId: number;
}

/** What the current page covers, so the UI can state its real scope. */
export interface HistoryWindow {
  /** Pass as `before` to read the next older page; null when none remains. */
  olderCursor: HistoryCursor | null;
  hasMore: boolean;
  /** Events stored for this project (or thread filter) in total. */
  storedTotal: number;
  /** Rows carried in the page this window describes. */
  pageSize: number;
}

/** One page of stored history, oldest-first within the page. */
export interface HistoryPage extends HistoryWindow {
  events: StoredEventSummary[];
  /** The thread filter this page was read with, if any. */
  threadId: string | null;
}

/** Every stored frame of one engine item, so a partial card can be rebuilt. */
export interface HistoryItemPage {
  threadId: string;
  itemId: string;
  events: StoredEventSummary[];
  /** True when the item has more stored frames than this response carries. */
  truncated: boolean;
  /** Frames stored for this item in the thread, including any not returned. */
  storedCount: number;
}

export interface EvidenceSummary {
  requirementId: string;
  path: string;
  note: string | null;
  createdAt: string;
}

export interface UsageSummaryView {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costComplete: boolean;
  observed: boolean;
  byModel: Array<{
    model: string;
    provider: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
    costComplete: boolean;
  }>;
}

export interface RuntimeBindingView {
  workspace: string;
  canonicalWorkspace: string;
  executable: string;
  engineVersion: string | null;
  engineCommit: string | null;
  port: number | null;
  state: string;
  updatedAt: string;
}

export interface EngineSnapshot {
  state: string;
  reason: string;
  owned: boolean;
  external: boolean;
  workspace: string | null;
  port: number | null;
  engineVersion: string | null;
  engineCommit: string | null;
  executable: string | null;
  executablePresent: boolean;
  /** True only when a running runtime serves this project's canonical workspace. */
  canExecute: boolean;
  blockedReason: string | null;
  binding: RuntimeBindingView | null;
}

export interface ProjectDetail {
  project: ProjectSummary;
  tasks: TaskSummary[];
  dependencies: Array<{ taskId: TaskId; dependsOnTaskId: TaskId }>;
  threads: ThreadSummary[];
  /**
   * The thread this project would use for new work right now. The Studio marks
   * it "current"; other threads are archived conversation, even before a
   * runtime exists to report its own thread id.
   */
  currentThreadId: string;
  draft: { threadId: string; text: string } | null;
  /** The newest page of stored history; older pages come from `projects:history`. */
  events: StoredEventSummary[];
  /** Scope and continuation of `events`. Never inferred from array length alone. */
  history: HistoryWindow;
  usage: UsageSummaryView;
  evidence: EvidenceSummary[];
  view: unknown;
  branch: string | null;
  engine: EngineSnapshot;
}

export interface RuntimeStatusView {
  state: string;
  reason: string;
  since: string;
  workspace: string | null;
  port: number | null;
  engine: { version: string; commit: string } | null;
  external: boolean;
  restarts: number;
  lastFailure: { code: string; message: string; action: string } | null;
}

export interface StateFacts {
  open: boolean;
  database: string;
  projects: number;
  tasks: number;
  events: number;
  artifacts: number;
  integrity: string[];
  permissionProblems: Array<{ path: string; mode: string; expected: string }>;
}

export interface OpenProjectResult {
  project: ProjectSummary;
  created: boolean;
}
