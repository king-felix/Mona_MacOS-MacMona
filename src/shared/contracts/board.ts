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
  openAttempts: number;
  evidencePaths: string[];
  generatedAt: string;
}

export interface BoardSnapshot {
  projectId: ProjectId;
  tasks: TaskView[];
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
  }>;
}

export interface ImportPlanResult {
  planName: string;
  created: Array<{ key: string; taskId: TaskId }>;
  taskCount: number;
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
