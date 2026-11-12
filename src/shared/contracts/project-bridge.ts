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

export interface StoredEventSummary {
  threadId: string;
  seq: number;
  kind: string;
  payload: unknown;
  timestamp: string;
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
  draft: { threadId: string; text: string } | null;
  events: StoredEventSummary[];
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
