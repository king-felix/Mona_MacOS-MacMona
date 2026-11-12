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
}

export interface RuntimeHandle {
  pid: number;
  listenerPid: number;
  port: number;
  baseUrl: string;
  executable: string;
  startedAt: string;
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
}
