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

  // P15 orchestration. Reads never start work; each mutation is an explicit
  // user action and is reported with the engine's own receipt.
  listAgentRuns(input?: { limit?: number }): Promise<EngineAgentRunList>;
  readAgentRun(runId: string): Promise<EngineAgentRun>;
  cancelAgentRun(runId: string): Promise<EngineControlReceipt>;
  listGoals(input?: { limit?: number; status?: string }): Promise<EngineGoal[]>;
  readThreadGoal(threadId: ThreadId): Promise<EngineGoal | null>;
  setThreadGoal(threadId: ThreadId, objective: string): Promise<EngineGoalTransition>;
  completeThreadGoal(threadId: ThreadId): Promise<EngineGoalTransition>;
  blockThreadGoal(threadId: ThreadId): Promise<EngineGoalTransition>;
  clearThreadGoal(threadId: ThreadId): Promise<{ cleared: boolean; status: number }>;
  listFleetRuns(): Promise<{ runs: EngineFleetRun[]; status: Record<string, unknown> | null }>;
  readFleetRun(runId: string): Promise<EngineFleetRunDetail>;
  createFleetRun(
    spec: FleetCreateSpec,
  ): Promise<{ run: EngineFleetRun; execution: string | null; warnings: string[] }>;
  startFleetRun(runId: string): Promise<EngineControlReceipt>;
  stopFleetRun(runId: string): Promise<EngineControlReceipt>;
  stopFleetWorker(workerId: string): Promise<EngineControlReceipt>;
  restartFleetWorker(workerId: string): Promise<EngineControlReceipt>;
  readFleetReceipt(runId: string, taskId: string): Promise<EngineFleetReceipt>;
  readFleetReceiptEvidence(
    runId: string,
    taskId: string,
  ): Promise<{
    path: string | null;
    checksum: string | null;
    sizeBytes: number | null;
    truncated: boolean;
    content: unknown;
  }>;
}

// ------------------------------------------------------- P15 orchestration
// Normalized at the adapter boundary so the observatory never re-parses raw
// engine JSON. Unknown fields are dropped here; `raw` keeps the record only for
// local diagnostics and is never rendered as a transcript.

export interface EngineRunEvent {
  seq: number | null;
  at: string | null;
  status: string;
  message: string | null;
  kind: "lifecycle" | "event" | "artifact";
  /** Tool name when the engine event names one; null when it does not. */
  tool: string | null;
}

export interface EngineArtifactRef {
  kind: string;
  path: string;
  checksum: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface EngineAgentUsage {
  /** `reported`, `unknown`, or an upstream word Mona passes through. */
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  note: string | null;
}

export interface EngineAgentRun {
  runId: string;
  workerId: string | null;
  parentRunId: string | null;
  actorKind: string | null;
  role: string | null;
  objective: string;
  status: string;
  model: string | null;
  provider: string | null;
  workspace: string | null;
  ownerSessionId: string | null;
  originTurnId: string | null;
  latestMessage: string | null;
  stepsTaken: number | null;
  events: EngineRunEvent[];
  artifacts: EngineArtifactRef[];
  usage: EngineAgentUsage;
  verification: { status: string | null; summary: string | null };
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  raw: Record<string, unknown>;
}

export interface EngineAgentRunList {
  runs: EngineAgentRun[];
  governor: {
    launchSlots: number | null;
    maxLaunchSlots: number | null;
    paused: boolean | null;
    recentRateLimits: number | null;
  } | null;
}

/** A goal transition with the HTTP status the engine actually answered. */
export interface EngineGoalTransition {
  goal: EngineGoal;
  status: number;
}

export interface EngineGoal {
  threadId: string;
  goalId: string | null;
  objective: string;
  status: string;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  continuationCount: number | null;
  repeatedGapCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EngineFleetTask {
  taskId: string;
  name: string | null;
  status: string;
  workerId: string | null;
  attempts: number;
  role: string | null;
}

export interface EngineFleetWorker {
  workerId: string;
  status: string;
  taskId: string | null;
  objective: string | null;
  role: string | null;
  host: string | null;
  lastEvent: EngineRunEvent | null;
  heartbeatAt: string | null;
  artifacts: EngineArtifactRef[];
  lastError: string | null;
  raw: Record<string, unknown>;
}

export interface EngineFleetReceipt {
  taskId: string;
  workerId: string | null;
  attempt: number | null;
  completedAt: string | null;
  result: string | null;
  failureKind: string | null;
  failureClass: string | null;
  retryEligible: boolean | null;
  score: { value: number | null; max: number | null; notes: string | null } | null;
  artifacts: EngineArtifactRef[];
  evidenceAvailable: boolean;
}

export interface EngineFleetRun {
  runId: string;
  name: string | null;
  lifecycle: string;
  target: string | null;
  workflow: { id: string | null; kind: string | null };
  roles: string[];
  taskCount: number;
  workerCount: number;
  tasks: EngineFleetTask[];
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  raw: Record<string, unknown>;
}

export interface EngineFleetRunDetail {
  run: EngineFleetRun;
  workers: EngineFleetWorker[];
  receipts: EngineFleetReceipt[];
  events: Array<{
    cursor: string | null;
    event: string;
    taskId: string | null;
    workerId: string | null;
    at: string | null;
    summary: string | null;
  }>;
  historyTruncated: boolean;
}

export interface FleetCreateSpec {
  target: "this_computer";
  name: string;
  roles: Array<{ name: string }>;
  workflow: {
    id: string;
    kind: "parallel";
    tasks: Array<{
      id: string;
      name: string;
      instructions: string;
      worker: { role: string };
    }>;
  };
}

export interface EngineControlReceipt {
  status: number;
  accepted: boolean;
  message: string;
  record: Record<string, unknown> | null;
}
