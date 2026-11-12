import type { ProjectId, TaskId } from "./ids";

/**
 * Work-board contracts. These types describe Mona-owned task state only: the
 * engine remains authoritative for conversation history, and no event here
 * starts inference by itself.
 *
 * The task states are exactly the ones in spec §8.2. `paused` and `failed` are
 * deliberately absent: pause is a queue boundary, and a failed verification is
 * an actionable result that returns the task to `running`.
 */
export type TaskState =
  "pending" | "running" | "verifying" | "completed" | "blocked" | "interrupted" | "skipped";

export const TASK_STATES: readonly TaskState[] = [
  "pending",
  "running",
  "verifying",
  "completed",
  "blocked",
  "interrupted",
  "skipped",
];

/**
 * Every task has exactly one execution owner. The Mona queue may start only
 * `mona_queue` tasks; a native workflow owns its own dispatch. Recording the
 * owner is what prevents two schedulers from starting the same task.
 */
export type TaskOwner = "mona_queue" | "native_workflow";

export const TASK_OWNERS: readonly TaskOwner[] = ["mona_queue", "native_workflow"];

export type CriterionKind = "check" | "human";

/** A configured acceptance criterion. `check` is machine-verified; `human` is
 * only satisfied by an explicit human action, never by model output. */
export interface AcceptanceCriterion {
  id: string;
  taskId: TaskId;
  ordinal: number;
  text: string;
  kind: CriterionKind;
  satisfied: boolean;
  satisfiedBy: "check" | "human" | null;
  evidencePath: string | null;
  updatedAt: string;
}

export type StepState = "pending" | "running" | "completed" | "skipped";

/** A recorded step. Resume starts at the first step that is not completed. */
export interface TaskStep {
  id: string;
  taskId: TaskId;
  ordinal: number;
  label: string;
  state: StepState;
  evidencePath: string | null;
  recordedAt: string;
  updatedAt: string;
}

export interface TaskRunView {
  id: string;
  taskId: TaskId;
  owner: TaskOwner;
  state: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  note: string | null;
}

export type ProblemStatus = "open" | "blocked" | "resolved";
export type ProblemEventKind =
  "created" | "attempt" | "progress_reset" | "blocked" | "acknowledged" | "reopened" | "resolved";
export type ProblemActor = "agent" | "human" | "mona_queue";

/** One recorded hypothesis-and-result cycle. */
export interface ProblemAttemptView {
  id: string;
  taskId: TaskId | null;
  requirement: string;
  symptom: string | null;
  hypothesis: string;
  action: string;
  observed: string;
  materialProgress: boolean;
  evidence: string[];
  createdAt: string;
}

export interface ProblemEventView {
  id: string;
  kind: ProblemEventKind;
  actor: ProblemActor;
  reason: string | null;
  evidence: string[];
  createdAt: string;
}

/** A stable problem with both counters and its full local audit history. */
export interface ProblemView {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  requirement: string;
  symptom: string;
  status: ProblemStatus;
  totalAttempts: number;
  noProgressAttempts: number;
  helpNeeded: string | null;
  blockedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  attempts: ProblemAttemptView[];
  events: ProblemEventView[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** The Victor handoff card: what stopped, why, and exactly what help is needed. */
export interface BlockedProblemCard {
  problemId: string;
  taskId: TaskId | null;
  taskTitle: string | null;
  requirement: string;
  symptom: string;
  totalAttempts: number;
  noProgressAttempts: number;
  evidence: string[];
  helpNeeded: string;
  blockedAt: string;
}

/** The full, honest view of one task. */
export interface TaskView {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  prompt: string;
  status: TaskState;
  owner: TaskOwner;
  requirements: string[];
  dependsOn: TaskId[];
  acceptance: AcceptanceCriterion[];
  evidence: Array<{
    requirementId: string;
    path: string;
    note: string | null;
    createdAt: string;
  }>;
  steps: TaskStep[];
  nextStep: string | null;
  verificationFingerprint: string | null;
  verificationStale: boolean;
  staleReason: string | null;
  completedAt: string | null;
  importedFrom: string | null;
  /** The engine turn this task's dispatch opened, if one is still active. */
  activeTurnId: string | null;
  openProblemCount: number;
  blockedProblemCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  activeRun: TaskRunView | null;
}

export interface BlockedTask {
  taskId: TaskId;
  reason: string;
  unmet: TaskId[];
  blocking: TaskId[];
}

/** Deterministic selection: first eligible task in creation order, or why not. */
export interface TaskSelection {
  owner: TaskOwner;
  taskId: TaskId | null;
  eligible: TaskId[];
  waiting: BlockedTask[];
  reason: string;
}

export interface HandoffView {
  projectId: ProjectId;
  currentTaskId: TaskId | null;
  currentTitle: string | null;
  currentStatus: TaskState | null;
  lastVerifiedStep: string | null;
  nextExactAction: string;
  blockers: Array<{ taskId: TaskId; title: string; reason: string }>;
  /** Blocked problems are the actionable handoff to Victor. */
  blockedProblems: BlockedProblemCard[];
  openAttempts: number;
  evidencePaths: string[];
  generatedAt: string;
}

export interface BoardSnapshot {
  projectId: ProjectId;
  tasks: TaskView[];
  problems: ProblemView[];
  selection: TaskSelection;
  handoff: HandoffView;
}

/**
 * Imported plans are inert data. Imports create `pending` tasks with no run and
 * no engine call; nothing starts until an explicit dispatch.
 */
export interface TaskPlan {
  format: "mona-task-plan";
  format_version: 1;
  name: string;
  tasks: Array<{
    key: string;
    title: string;
    prompt: string;
    owner?: TaskOwner;
    requirements?: string[];
    acceptance?: Array<{ text: string; kind: CriterionKind }>;
    steps?: string[];
    dependsOn?: string[];
    /** Informational only; import reports a non-pending status as deferred. */
    status?: TaskState;
  }>;
}

export interface ImportPlanResult {
  planName: string;
  created: Array<{ key: string; taskId: TaskId }>;
  taskCount: number;
  /** Statuses the plan carried that import did not apply, with the reason. */
  deferredStatuses: Array<{ key: string; from: TaskState; to: TaskState; reason: string }>;
  /** True because import never starts work. */
  inert: true;
}

export interface ContextPreview {
  taskId: TaskId;
  /** The exact text Mona would submit. Nothing else is injected. */
  text: string;
  bytes: number;
  criteriaCount: number;
  requirements: string[];
  /** Explicitly absent context, so the user can see the boundary. */
  excluded: string[];
  truncated: boolean;
}

export interface DispatchResult {
  dispatched: boolean;
  taskId: TaskId | null;
  owner: TaskOwner;
  runId: string | null;
  reason: string;
  /** True when the prompt was handed to the engine and accepted. */
  accepted: boolean;
  outcomeUnknown: boolean;
  preview: ContextPreview | null;
}

export interface QueueRunResult {
  ran: TaskId[];
  stoppedBecause: "one_prompt_per_assignment" | "no_eligible_task" | "paused" | "executor_failed";
  dispatches: DispatchResult[];
}

export interface ReconcileResult {
  projectId: ProjectId;
  resumed: Array<{ taskId: TaskId; step: string | null }>;
  stale: Array<{ taskId: TaskId; reason: string }>;
  unchanged: TaskId[];
  notes: string[];
}
