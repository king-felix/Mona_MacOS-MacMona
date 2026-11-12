import { z } from "zod";
import { ProjectId, TaskId, ThreadId } from "./ids";

/**
 * Agent observatory and native orchestration contracts.
 *
 * The engine is authoritative for agent, goal, fleet, workflow, and run state.
 * Mona stores bounded projections so a disconnected observatory can say what it
 * last observed and when, but it never invents a lifecycle, a cost, or a parent
 * relationship the engine did not report.
 *
 * Routing rules encoded here:
 * - A task has exactly one execution owner. A native fleet run may start only a
 *   task owned by `native_workflow`, and Mona refuses a second start.
 * - Mona never runs a competing scheduler. A fleet's own workflow scheduler owns
 *   its internal steps; Mona reads and requests supported controls.
 * - Default execution is serial: one task per fleet run, one mutating run per
 *   workspace. Parallel launch is refused until the qualification reports every
 *   isolation, ownership, aggregate-limit, and merge-boundary check.
 */

export const ORCHESTRATION_KINDS = ["agent_run", "fleet_run", "fleet_worker"] as const;
export type OrchestrationKind = (typeof ORCHESTRATION_KINDS)[number];

export const NATIVE_ROLES = [
  "manager",
  "operator",
  "scout",
  "builder",
  "reviewer",
  "verifier",
  "consultant",
  "synthesizer",
  "worker",
  "planner",
  "custom",
] as const;
export type NativeRole = (typeof NATIVE_ROLES)[number];

export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Engine lifecycle vocabulary plus the states this build has observed. */
export const RUN_STATUSES = [
  "starting",
  "running",
  "online",
  "queued",
  "enqueued",
  "leased",
  "completed",
  "partial",
  "failed",
  "interrupted",
  "interrupted_continuable",
  "cancelled",
  "canceled",
  "stale",
  "unknown",
] as const;

export type SpendConfidence =
  /** The engine reported usage and a recorded rate card priced it. */
  | "priced"
  /** The engine reported tokens but no recorded rate card exists. */
  | "unpriced"
  /** The engine explicitly says usage is not reported (e.g. sub-agent ledger). */
  | "unknown"
  /** The engine surface does not carry usage at all (e.g. fleet receipts). */
  | "not_reported";

export type TestEvidenceState = "verified" | "self_reported" | "none" | "unknown";

export interface TokenUsageView {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

export interface SpendView {
  confidence: SpendConfidence;
  usd: number | null;
  tokens: TokenUsageView | null;
  /** Exact provenance, e.g. "sub-agent worker ledger" or "fleet receipt". */
  source: string;
  note: string;
}

export interface TestEvidenceView {
  state: TestEvidenceState;
  total: number | null;
  passed: number | null;
  failed: number | null;
  note: string;
}

export interface ToolUsageView {
  names: string[];
  source: "events" | "receipt" | "not_exposed";
  note: string;
}

export interface BranchView {
  name: string | null;
  head: string | null;
  dirty: boolean | null;
  /** How the branch was learned: engine record or a local Git read now. */
  source: "engine" | "local_git";
}

export interface RunEventView {
  seq: number | null;
  at: string | null;
  status: string;
  message: string | null;
  kind: "lifecycle" | "event" | "tool" | "test" | "artifact";
}

export interface OrchestrationArtifactView {
  kind: string;
  path: string;
  checksum: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface AgentRunView {
  kind: "agent_run";
  runId: string;
  /** Engine worker id; often the same as the run id. */
  workerId: string | null;
  parentRunId: string | null;
  actorKind: string | null;
  role: string | null;
  label: string;
  objectiveSummary: string | null;
  status: string;
  rawStatus: string;
  taskId: TaskId | null;
  threadId: string | null;
  originTurnId: string | null;
  workspace: string | null;
  branch: BranchView | null;
  lastEvent: RunEventView | null;
  tools: ToolUsageView;
  tests: TestEvidenceView;
  spend: SpendView;
  artifacts: OrchestrationArtifactView[];
  children: AgentRunView[];
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  /** True only for a terminal engine status. */
  terminal: boolean;
}

export interface FleetTaskView {
  taskId: string;
  name: string | null;
  status: string;
  workerId: string | null;
  attempts: number;
  role: string | null;
  /** Engine receipt result when a receipt exists: completed/partial/failed. */
  receiptResult: string | null;
  score: { value: number | null; max: number | null; notes: string | null } | null;
}

export interface FleetWorkerView {
  kind: "fleet_worker";
  workerId: string;
  role: string | null;
  host: string | null;
  status: string;
  taskId: string | null;
  objective: string | null;
  lastEvent: RunEventView | null;
  heartbeatAt: string | null;
  artifacts: OrchestrationArtifactView[];
  lastError: string | null;
  spend: SpendView;
  tools: ToolUsageView;
  tests: TestEvidenceView;
  children: AgentRunView[];
}

export interface FleetEvidenceView {
  path: string | null;
  checksum: string | null;
  sizeBytes: number | null;
  truncated: boolean;
  content: unknown;
}

export interface FleetReceiptView {
  taskId: string;
  workerId: string | null;
  attempt: number | null;
  completedAt: string | null;
  result: string | null;
  failureKind: string | null;
  failureClass: string | null;
  retryEligible: boolean | null;
  score: { value: number | null; max: number | null; notes: string | null } | null;
  artifacts: OrchestrationArtifactView[];
  evidenceAvailable: boolean;
}

export interface FleetRunView {
  kind: "fleet_run";
  runId: string;
  name: string | null;
  lifecycle: string;
  target: string | null;
  workflow: { id: string | null; kind: string | null };
  roles: string[];
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  taskCount: number;
  workerCount: number;
  taskId: TaskId | null;
  linkedTaskRunId: string | null;
  lastEvent: RunEventView | null;
  events: RunEventView[];
  tasks: FleetTaskView[];
  workers: FleetWorkerView[];
  receipts: FleetReceiptView[];
  spend: SpendView;
  /** Aggregate spend is deliberately not added to child spend. */
  aggregateNote: string;
  children: FleetWorkerView[];
}

export interface GoalView {
  threadId: string;
  goalId: string | null;
  objective: string;
  status: GoalStatus | string;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  continuationCount: number | null;
  repeatedGapCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Mona reads and requests controls; the engine owns continuation. */
  source: "engine" | "stored";
  stale: boolean;
}

export interface ParallelCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ParallelQualification {
  requested: boolean;
  qualified: boolean;
  checks: ParallelCheck[];
  note: string;
}

export interface OrchestrationGap {
  id: string;
  title: string;
  status: "gap" | "unavailable" | "unsupported";
  detail: string;
}

export interface OrchestrationCapabilities {
  agentRuns: boolean;
  agentRunCancel: boolean;
  goals: boolean;
  goalControls: boolean;
  fleetCreate: boolean;
  fleetStart: boolean;
  fleetStop: boolean;
  workerStop: boolean;
  workerRestart: boolean;
  fleetReceipts: boolean;
  fleetReplay: boolean;
}

export interface ObservatorySummary {
  runs: number;
  running: number;
  terminal: number;
  failed: number;
  interrupted: number;
  unknownSpend: number;
  goalsActive: number;
  fleetRuns: number;
  fleetWorkers: number;
}

export interface ObservatoryView {
  projectId: ProjectId;
  observedAt: string;
  /** `engine` means every list came from the live runtime this call. */
  source: "engine" | "stored";
  connected: boolean;
  reason: string | null;
  runs: AgentRunView[];
  fleets: FleetRunView[];
  goals: GoalView[];
  summary: ObservatorySummary;
  ownership: {
    oneMutatingRunPerWorkspace: true;
    activeTaskRunId: string | null;
    activeTaskId: string | null;
    activeOwner: "mona_queue" | "native_workflow" | null;
    note: string;
  };
  parallel: ParallelQualification;
  capabilities: OrchestrationCapabilities;
  gaps: OrchestrationGap[];
  /** Last stored observation when disconnected; null when never observed. */
  lastObservedAt: string | null;
  notes: string[];
}

export interface FleetLaunchResult {
  receipt: OrchestrationActionReceipt;
  runId: string | null;
  taskId: TaskId;
}

export interface OrchestrationActionReceipt {
  action:
    | "agent_run_cancel"
    | "fleet_start"
    | "fleet_stop"
    | "worker_stop"
    | "worker_restart"
    | "goal_set"
    | "goal_complete"
    | "goal_block"
    | "goal_clear"
    | "fleet_create";
  accepted: boolean;
  /** HTTP status when an engine route answered; null for a local refusal. */
  status: number | null;
  runId: string | null;
  message: string;
  at: string;
  /** Present when the engine answered with a worker/run record. */
  record: Record<string, unknown> | null;
}

// ---------------------------------------------------------------- inputs

const RunIdSchema = z.string().trim().min(1).max(200);
const WorkerIdSchema = z.string().trim().min(1).max(200);

export const ObservatoryRequestSchema = z.strictObject({ projectId: ProjectId });
export const AgentRunCancelSchema = z.strictObject({
  projectId: ProjectId,
  runId: RunIdSchema,
});
export const FleetRunControlSchema = z.strictObject({
  projectId: ProjectId,
  runId: RunIdSchema,
  action: z.enum(["stop"]),
});
export const FleetWorkerControlSchema = z.strictObject({
  projectId: ProjectId,
  workerId: WorkerIdSchema,
  action: z.enum(["stop", "restart"]),
});
export const FleetReceiptRequestSchema = z.strictObject({
  projectId: ProjectId,
  runId: RunIdSchema,
  taskId: z.string().trim().min(1).max(200),
});
export const FleetEvidenceRequestSchema = FleetReceiptRequestSchema;

export const GoalSetSchema = z.strictObject({
  projectId: ProjectId,
  threadId: ThreadId,
  objective: z.string().trim().min(1).max(4000),
});
export const GoalThreadSchema = z.strictObject({
  projectId: ProjectId,
  threadId: ThreadId,
});
export const GoalBlockSchema = z.strictObject({
  projectId: ProjectId,
  threadId: ThreadId,
  /** Recorded locally; the engine block route carries no documented reason. */
  reason: z.string().trim().max(2000).nullable().optional(),
});

export const FleetLaunchSchema = z.strictObject({
  projectId: ProjectId,
  taskId: TaskId,
  expectedRevision: z.number().int().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(NATIVE_ROLES),
  instructions: z.string().trim().min(1).max(100_000),
  /** Serial is the only launch this build performs. */
  parallelism: z.literal("serial").default("serial"),
});

export type ObservatoryRequest = z.infer<typeof ObservatoryRequestSchema>;
export type AgentRunCancelInput = z.infer<typeof AgentRunCancelSchema>;
export type FleetRunControlInput = z.infer<typeof FleetRunControlSchema>;
export type FleetWorkerControlInput = z.infer<typeof FleetWorkerControlSchema>;
export type FleetReceiptRequest = z.infer<typeof FleetReceiptRequestSchema>;
export type GoalSetInput = z.infer<typeof GoalSetSchema>;
export type GoalThreadInput = z.infer<typeof GoalThreadSchema>;
export type GoalBlockInput = z.infer<typeof GoalBlockSchema>;
export type FleetLaunchInput = z.infer<typeof FleetLaunchSchema>;

// ------------------------------------------------- persisted projections

/**
 * A bounded local projection of one engine run. Deliberately excludes prompts,
 * tool output, and transcript content: the engine remains the record owner and
 * the local row exists only so a disconnected view can say what it last saw.
 */
export const OrchestrationRunRecordSchema = z.strictObject({
  projectId: ProjectId,
  kind: z.enum(ORCHESTRATION_KINDS),
  upstreamId: z.string().min(1).max(200),
  parentUpstreamId: z.string().max(200).nullable(),
  label: z.string().max(300),
  status: z.string().max(80),
  workspace: z.string().max(4096).nullable(),
  branch: z.string().max(300).nullable(),
  taskId: TaskId.nullable(),
  startedAt: z.string().max(64).nullable(),
  updatedAt: z.string().max(64).nullable(),
  lastSeenAt: z.string().max(64),
  terminal: z.boolean(),
  detail: z.record(z.string().max(80), z.unknown()).default({}),
});
export type OrchestrationRunRecord = z.infer<typeof OrchestrationRunRecordSchema>;

export const GoalObservationSchema = z.strictObject({
  projectId: ProjectId,
  threadId: z.string().min(1).max(100),
  goalId: z.string().max(200).nullable(),
  objective: z.string().max(4000),
  status: z.string().max(80),
  tokensUsed: z.number().nonnegative().nullable(),
  timeUsedSeconds: z.number().nonnegative().nullable(),
  continuationCount: z.number().nonnegative().nullable(),
  repeatedGapCount: z.number().nonnegative().nullable(),
  engineCreatedAt: z.string().max(64).nullable(),
  engineUpdatedAt: z.string().max(64).nullable(),
  observedAt: z.string().max(64),
});
export type GoalObservation = z.infer<typeof GoalObservationSchema>;

export const OrchestrationEventSchema = z.strictObject({
  id: z.string().min(1).max(200),
  projectId: ProjectId,
  action: z.string().min(1).max(80),
  upstreamId: z.string().max(200).nullable(),
  accepted: z.boolean(),
  status: z.number().int().nullable(),
  message: z.string().max(2000),
  createdAt: z.string().max(64),
});
export type OrchestrationEvent = z.infer<typeof OrchestrationEventSchema>;

/** Terminal engine statuses; `partial` is terminal but not a success claim. */
export const TERMINAL_RUN_STATUSES: readonly string[] = [
  "completed",
  "partial",
  "failed",
  "interrupted",
  "interrupted_continuable",
  "cancelled",
  "canceled",
  "stale",
];

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Map an engine status to the label Mona is willing to show, without upgrading it. */
export function runStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "online":
      return "Online (no active task)";
    case "queued":
    case "enqueued":
      return "Queued";
    case "leased":
      return "Leased";
    case "starting":
      return "Starting";
    case "completed":
      return "Completed";
    case "partial":
      return "Partial";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "interrupted_continuable":
      return "Interrupted (continuable)";
    case "cancelled":
    case "canceled":
      return "Cancelled";
    case "stale":
      return "Stale";
    case "unknown":
      return "Unknown";
    default:
      return status;
  }
}

export function emptyCapabilities(): OrchestrationCapabilities {
  return {
    agentRuns: false,
    agentRunCancel: false,
    goals: false,
    goalControls: false,
    fleetCreate: false,
    fleetStart: false,
    fleetStop: false,
    workerStop: false,
    workerRestart: false,
    fleetReceipts: false,
    fleetReplay: false,
  };
}

/** Features this build cannot faithfully surface yet. Each names its boundary. */
export function defaultOrchestrationGaps(
  capabilities: OrchestrationCapabilities,
): OrchestrationGap[] {
  const gaps: OrchestrationGap[] = [];
  if (!capabilities.agentRuns) {
    gaps.push({
      id: "agent-runs-unavailable",
      title: "Sub-agent receipts",
      status: "unavailable",
      detail:
        "The runtime did not advertise /v1/agent-runs. Mona shows no sub-agent rows instead of an empty success.",
    });
  }
  if (!capabilities.goals) {
    gaps.push({
      id: "goals-unavailable",
      title: "Native goals",
      status: "unavailable",
      detail: "The runtime did not advertise thread goals; goal controls stay disabled.",
    });
  }
  if (!capabilities.fleetCreate || !capabilities.fleetStart) {
    gaps.push({
      id: "managed-fleet-unavailable",
      title: "Managed fleet runs",
      status: "unavailable",
      detail:
        "The runtime did not advertise fleet_run_create/fleet_run_start; Mona will not simulate a fleet.",
    });
  }
  gaps.push({
    id: "goal-pause-no-route",
    title: "Pause an active goal",
    status: "gap",
    detail:
      "The pinned runtime exposes set, block, complete, and clear for a thread goal but no documented HTTP pause route. Mona offers block or clear; it does not fake a pause.",
  });
  gaps.push({
    id: "parallel-worktree-isolation",
    title: "Parallel builders in isolated worktrees",
    status: "gap",
    detail:
      "Fleet task workspaces are repo-relative and scoped inside the runtime workspace. Mona has not verified true per-task Git worktree isolation, so it launches one task serially and refuses parallel launch rather than sharing one mutable tree.",
  });
  gaps.push({
    id: "fleet-child-usage",
    title: "Fleet worker token and cost totals",
    status: "gap",
    detail:
      "Fleet receipts and worker records carry no per-worker usage. Sub-agent records report usage as unknown. Mona shows unknown spend and never adds parent and child totals.",
  });
  gaps.push({
    id: "goal-continuation-ownership",
    title: "Goal continuation is engine-scheduled",
    status: "gap",
    detail:
      "Setting an active goal starts engine work. Mona can set, block, complete, and clear a goal, but it does not drive goal continuation turns itself and does not present pause-after-task as gating them.",
  });
  return gaps;
}
