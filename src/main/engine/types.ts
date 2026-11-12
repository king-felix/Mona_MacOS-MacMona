import type {
  EngineCapabilities,
  EffectiveProfile,
  EventEnvelope,
  OperationKey,
  SubmissionState,
  SubmissionStatus,
  ThreadId,
  TurnId,
} from "../../shared/contracts";

export interface RuntimeStartInput {
  workspace: string;
  port?: number;
  env?: Record<string, string>;
  /** Durable ownership-record directory; defaults to the per-user Mona state dir. */
  stateDir?: string;
  /** Runtime log directory; defaults to `<stateDir>/logs`. */
  logDir?: string;
  /** Explicit native supervisor path (tests and packaging). */
  supervisorPath?: string;
  graceMs?: number;
  startupTimeoutMs?: number;
  store?: import("../supervisor/records").OwnershipStore;
}

export interface RuntimeHandle {
  /** Supervisor pid: the process Mona owns and can ask to stop the tree. */
  pid: number;
  supervisorPid: number;
  /** Runtime child pid, verified as the supervisor's own child. */
  childPid: number;
  childStartedAt: string;
  pgid: number;
  listenerPid: number;
  port: number;
  baseUrl: string;
  controlSocket: string;
  executable: string;
  executableSha256: string;
  startedAt: string;
  engine: { version: string; commit: string } | null;
  ownershipId: string;
  compatibility?: import("./compat").CompatibilityReport;
}

export interface ThreadRequest {
  workspace: string;
  title?: string;
  operationKey?: OperationKey;
  /** Applied at thread creation so a later turn cannot silently widen policy. */
  execute?: {
    autoApprove: boolean;
    trustMode: boolean;
    allowShell: boolean;
  };
  /** Model-visible tool allowlist; `[]` is an explicit tool-free thread. */
  allowedTools?: string[];
}

export interface ThreadRef {
  threadId: ThreadId;
  workspace: string;
  created: boolean;
}

export interface RouteRequest {
  provider: string;
  model: string;
  reasoningEffort?: string;
  permissionPosture: "ask" | "full_access";
}

export interface SubmitTurnInput {
  threadId: ThreadId;
  prompt: string;
  operationKey: OperationKey;
  /** Omit to preserve the configured thread/Runtime route untouched. */
  requested?: RouteRequest;
  autoApprove?: boolean;
  allowShell?: boolean;
  trustMode?: boolean;
}

export interface SubmissionReceipt {
  submission: SubmissionState;
  turnId: TurnId | null;
  accepted: boolean;
  outcomeUnknown: boolean;
  guidance: string | null;
}

export interface ReconcileResult {
  status: SubmissionStatus;
  turnId: TurnId | null;
  evidence: "lookup" | "history" | "none";
  guidance: string | null;
}

export interface TurnRecord {
  id: TurnId;
  threadId: ThreadId;
  status: string;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  permissionPosture: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    cacheMissTokens: number | null;
    reasoningTokens: number | null;
  } | null;
}

export interface HistoryPage {
  threadId: ThreadId;
  workspace: string | null;
  turns: TurnRecord[];
}

export interface InterruptReceipt {
  interrupted: boolean;
  turn: TurnRecord | null;
  note: string;
}

export interface UsageQuery {
  since?: string;
  until?: string;
  groupBy?: "day" | "model" | "provider" | "thread";
}

export interface UsageBucket {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costComplete: boolean;
}

export interface UsageReport {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    costUsd: number;
    costComplete: boolean;
    turns: number;
  };
  buckets: UsageBucket[];
}

/** One engine-recorded artifact reference from a turn. */
export interface TurnArtifactRef {
  id: string;
  kind: "file" | "tool_output" | "media" | "unknown";
  path: string;
  change: "created" | "updated" | "deleted" | "renamed" | "unknown";
  previousPath: string | null;
  sizeBytes: number | null;
  revision: string | null;
  contentType: string | null;
  sessionId: string | null;
  itemId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  source:
    | "tool_mutation"
    | "tool_output_spill"
    | "tool_media"
    | "workspace_changed_during_turn"
    | "unknown";
  restoreSnapshotId: string | null;
  recordedAt: string | null;
}

export interface TurnWorkspaceState {
  state: "pending" | "settled" | "unavailable";
  reason: string | null;
  preSnapshotId: string | null;
  postSnapshotId: string | null;
  truncated: boolean;
  omitted: number | null;
}

export interface TurnArtifactsResult {
  turnId: string;
  workspace: TurnWorkspaceState | null;
  artifacts: TurnArtifactRef[];
}

export interface ArtifactContentWindow {
  artifactId: string;
  availability: "available" | "binary" | "oversized" | "missing";
  content: string | null;
  encoding: "utf-8" | "base64" | null;
  offset: number;
  totalBytes: number | null;
  revision: string | null;
  source: string | null;
  current: boolean | null;
  truncated: boolean;
  note: string | null;
}

export interface CallChangeFile {
  path: string;
  change: "created" | "updated" | "deleted" | "renamed" | "unknown";
  added: number | null;
  removed: number | null;
  sizeBytes: number | null;
  revision: string | null;
  restoreSnapshotId: string | null;
  diff: string | null;
  diffTruncated: boolean;
}

export interface CallChangesResult {
  state: "captured" | "pending" | "unavailable";
  reason: string | null;
  files: CallChangeFile[];
  truncated: boolean;
  note: string | null;
}

export interface FileRevertReceipt {
  path: string;
  action: "modified" | "recreated" | "removed";
  snapshotId: string;
  snapshotLabel: string | null;
}

export interface RestoreCapability {
  fileRevert: boolean;
  snapshots: boolean;
  reason: string | null;
}

export interface SnapshotEntry {
  id: string;
  label: string;
  timestamp: number | null;
}

export interface WorkspaceFileWindow {
  availability: "available" | "binary" | "oversized" | "missing" | "forbidden" | "error";
  content: string | null;
  encoding: "utf-8" | "base64" | null;
  offset: number;
  sizeBytes: number | null;
  revision: string | null;
  truncated: boolean;
  note: string | null;
}

export interface WorkspaceWriteReceipt {
  path: string;
  sizeBytes: number;
  revision: string;
  created: boolean;
  writtenAt: string | null;
}

export type SubscriptionItem =
  | { type: "event"; event: EventEnvelope }
  | { type: "progress"; state: string; seq: number }
  | { type: "diagnostic"; reason: string; raw?: string }
  | { type: "end"; reason: string | null; lastSeq: number };

export interface SubscribeInput {
  threadId: ThreadId;
  sinceSeq?: number;
  signal?: AbortSignal;
}

export type CapabilityName =
  "runtime.info" | "providers.list" | "providers.models" | "usage.read" | "session.resume";

export interface CapabilityInvocation {
  name: CapabilityName;
  args?: Record<string, unknown>;
}

export interface CapabilityResult {
  name: CapabilityName;
  status: "ok" | "unsupported";
  value?: unknown;
  reason?: string;
}

/** The versioned boundary the rest of Mona is allowed to see. */
export interface EngineAdapter {
  discover(): Promise<EngineCapabilities>;
  startOwnedRuntime(input: RuntimeStartInput): Promise<RuntimeHandle>;
  shutdownOwnedRuntime(handle: RuntimeHandle): Promise<{ stopped: boolean }>;
  createOrOpenThread(input: ThreadRequest): Promise<ThreadRef>;
  submitTurn(input: SubmitTurnInput): Promise<SubmissionReceipt>;
  reconcileSubmission(input: { submission: SubmissionState }): Promise<ReconcileResult>;
  subscribe(input: SubscribeInput): AsyncIterable<SubscriptionItem>;
  interrupt(input: { threadId: ThreadId; turnId: TurnId }): Promise<InterruptReceipt>;
  readHistory(input: { threadId: ThreadId }): Promise<HistoryPage>;
  readUsage(input: UsageQuery): Promise<UsageReport>;
  getEffectiveProfile(input: {
    threadId: ThreadId;
    turnId?: TurnId;
    requested: RouteRequest;
    strict?: boolean;
  }): Promise<EffectiveProfile>;
  invokeCapability(input: CapabilityInvocation): Promise<CapabilityResult>;

  // P13 read-only receipts and the two verified mutation paths. All of these
  // run over the same authenticated loopback transport as every other call.
  readTurnArtifacts(input: { threadId: ThreadId; turnId: TurnId }): Promise<TurnArtifactsResult>;
  readTurnArtifact(input: {
    threadId: ThreadId;
    turnId: TurnId;
    artifactId: string;
    offset?: number;
    limit?: number;
    revision?: string;
  }): Promise<ArtifactContentWindow>;
  readCallChanges(input: {
    threadId: ThreadId;
    turnId: TurnId;
    toolCallId: string;
    limit?: number;
  }): Promise<CallChangesResult>;
  probeRestore(threadId: ThreadId): Promise<RestoreCapability>;
  listSnapshots(limit?: number): Promise<SnapshotEntry[]>;
  revertFile(input: {
    threadId: ThreadId;
    path: string;
    snapshotId: string;
    expectedHash: string;
  }): Promise<FileRevertReceipt>;
  readWorkspaceFile(input: {
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<WorkspaceFileWindow>;
  writeWorkspaceFile(input: {
    path: string;
    content: string;
    expectedRevision: string;
  }): Promise<WorkspaceWriteReceipt>;
}
