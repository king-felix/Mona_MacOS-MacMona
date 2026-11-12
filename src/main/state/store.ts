import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ProjectId,
  SubmissionState,
  TaskId,
  type AcceptanceCriterion,
  type BudgetScope,
  type CostAllocation,
  type CostState,
  type CriterionKind,
  type StepState,
  type SubmissionStatus,
  type TaskOwner,
  type TaskRunView,
  type TaskState,
  type TaskStatus,
  type TokenSemantics,
} from "../../shared/contracts";
import {
  ArtifactFileStore,
  type ArtifactFileStoreOptions,
  type WrittenArtifact,
} from "./artifact-files";
import { writeFileDurable, writeJsonDurable } from "./atomic-json";
import { MaintenanceBarrier } from "./barrier";
import {
  assertIntegrity,
  backupDatabase,
  checkIntegrity,
  ensurePrivateDir,
  nativeDiskProbe,
  openDatabase,
  secureFile,
  withTransaction,
  type DiskProbe,
} from "./database";
import { StateError } from "./errors";
import { identifyPath, type PathIdentity, type RepositoryKind } from "./identity";
import { migrateDatabase } from "./migrations";
import { decideTransition, EDITABLE_STATES, type TransitionActor } from "./task-machine";
import {
  buildBundle,
  bundleToFileText,
  canonicalJson,
  verifyBundle,
  type PortablePayload,
  type ProjectBundle,
} from "./portable";

export interface StoredProject {
  id: ProjectId;
  name: string;
  rootPath: string;
  canonicalPath: string;
  fsDev: number;
  fsIno: number;
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

export interface StoredTask {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  prompt: string;
  status: TaskStatus;
  executionOwner: TaskOwner;
  requirements: string[];
  nextStep: string | null;
  verificationFingerprint: string | null;
  verificationStale: boolean;
  staleReason: string | null;
  completedAt: string | null;
  importedFrom: string | null;
  /** The engine turn a Mona dispatch opened for this task, if one is active. */
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface StoredTaskStep {
  id: string;
  taskId: TaskId;
  ordinal: number;
  label: string;
  state: StepState;
  evidencePath: string | null;
  recordedAt: string;
  updatedAt: string;
}

export interface TaskTransitionRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId;
  fromStatus: string | null;
  toStatus: string;
  actor: TransitionActor;
  reason: string | null;
  createdAt: string;
}

export interface StartedTaskRun {
  task: StoredTask;
  run: TaskRunView;
}

export type BindingState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface RuntimeBinding {
  projectId: ProjectId;
  workspace: string;
  canonicalWorkspace: string;
  executable: string;
  engineVersion: string | null;
  engineCommit: string | null;
  port: number | null;
  state: BindingState;
  updatedAt: string;
}

export interface StoredThread {
  id: string;
  projectId: ProjectId;
  engineThreadId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTurn {
  id: string;
  threadId: string;
  status: string;
  provider: string | null;
  model: string | null;
  permissionPosture: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface StoredEvent {
  threadId: string;
  seq: number;
  kind: string;
  payload: unknown;
  timestamp: string;
  recordedAt: string;
  /** Null for rows recorded before v6; the envelope's turn is otherwise kept. */
  turnId?: string | null;
}

export interface StoredChangeFile {
  artifactId: string | null;
  path: string;
  previousPath: string | null;
  kind: "file" | "tool_output" | "media";
  change: "created" | "updated" | "deleted" | "renamed" | "unknown";
  source: "tool_mutation" | "tool_output_spill" | "tool_media" | "workspace_changed_during_turn";
  toolName: string | null;
  toolCallId: string | null;
  itemId: string | null;
  sizeBytes: number | null;
  revision: string | null;
  restoreSnapshotId: string | null;
}

export type StoredChangeState = "settled" | "pending" | "unavailable";
export type StoredChangeOrigin = "engine" | "turn.artifacts" | "turn.completed";

export interface StoredChangeSet {
  id: string;
  projectId: ProjectId;
  threadId: string;
  engineThreadId: string;
  turnId: string;
  taskId: string | null;
  state: StoredChangeState;
  reason: string | null;
  preSnapshotId: string | null;
  postSnapshotId: string | null;
  origin: StoredChangeOrigin;
  evidenceRank: number;
  truncated: boolean;
  omitted: number | null;
  note: string | null;
  capturedAt: string;
  files: StoredChangeFile[];
}

export interface StoredRestoreReceipt {
  id: string;
  projectId: ProjectId;
  changeSetId: string | null;
  threadId: string;
  turnId: string;
  path: string;
  action: string;
  snapshotId: string;
  snapshotLabel: string | null;
  expectedHash: string;
  beforeRevision: string | null;
  afterRevision: string | null;
  outcome: "restored" | "failed";
  note: string | null;
  createdAt: string;
}

export interface StoredCommitReceipt {
  id: string;
  projectId: ProjectId;
  commitHash: string;
  shortHash: string;
  subject: string;
  paths: string[];
  message: string;
  note: string | null;
  createdAt: string;
}

export interface UsageRecord {
  id: string;
  projectId: ProjectId | null;
  threadId: string | null;
  turnId: string | null;
  taskId: TaskId | null;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheMissTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costPicoUsd: number | null;
  costComplete: boolean;
  costState: CostState;
  costAllocation: CostAllocation;
  rateCardId: string | null;
  pricingReadAt: string | null;
  tokenSemantics: TokenSemantics;
  note: string | null;
  capturedAt: string;
}

export type UsageInput = Omit<
  UsageRecord,
  | "id"
  | "taskId"
  | "cacheMissTokens"
  | "costPicoUsd"
  | "costComplete"
  | "costState"
  | "costAllocation"
  | "rateCardId"
  | "pricingReadAt"
  | "tokenSemantics"
  | "note"
> & {
  taskId?: TaskId | null;
  cacheMissTokens?: number | null;
  costPicoUsd?: number | null;
  costComplete?: boolean;
  costState?: CostState;
  costAllocation?: CostAllocation;
  rateCardId?: string | null;
  pricingReadAt?: string | null;
  tokenSemantics?: TokenSemantics;
  note?: string | null;
};

export interface UsageSummary {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costPicoUsd: number;
  costComplete: boolean;
  observed: boolean;
  reportedTurns: number;
  estimatedTurns: number;
  unknownTurns: number;
  missingTurns: number;
  unallocatedTurns: number;
  /** Known cost that belongs to earlier turns but cannot be attributed to one. */
  residualPicoUsd: number;
}

export interface CostThreadMark {
  threadId: string;
  windowSince: string;
  reportedTotalPico: number | null;
  costComplete: boolean;
  updatedAt: string;
}

export interface StoredRateCard {
  id: string;
  provider: string;
  model: string;
  currency: "USD";
  unit: "per_million_tokens";
  cacheHitPico: number | null;
  cacheMissPico: number | null;
  outputPico: number | null;
  toolCallPico: number | null;
  reasoningInOutput: boolean;
  source: "user_supplied" | "provider_docs";
  sourceRef: string | null;
  revision: string;
  revisionNo: number;
  readAt: string;
}

export interface StoredBudget {
  id: string;
  projectId: ProjectId;
  scope: BudgetScope;
  limitPico: number;
  warnPico: number | null;
  enabled: boolean;
  timeZone: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDecision {
  id: string;
  projectId: ProjectId;
  title: string;
  body: string;
  createdAt: string;
}

export interface RequirementEvidenceRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  requirementId: string;
  path: string;
  digest: string | null;
  note: string | null;
  createdAt: string;
}

export interface AttemptRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  problemId: string;
  requirement: string;
  symptom: string | null;
  hypothesis: string;
  action: string;
  observed: string;
  materialProgress: boolean;
  evidence: string[];
  createdAt: string;
}

export type ProblemState = "open" | "blocked" | "resolved";
export type ProblemEventKind =
  "created" | "attempt" | "progress_reset" | "blocked" | "acknowledged" | "reopened" | "resolved";
export type ProblemActor = "agent" | "human" | "mona_queue";

/** One persistent problem: stable id, current symptom, and both counters. */
export interface StoredProblem {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  requirement: string;
  symptom: string;
  symptomFingerprint: string;
  status: ProblemState;
  totalAttempts: number;
  noProgressAttempts: number;
  helpNeeded: string | null;
  blockedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface StoredProblemEvent {
  id: string;
  projectId: ProjectId;
  problemId: string;
  kind: ProblemEventKind;
  actor: ProblemActor;
  reason: string | null;
  evidence: string[];
  createdAt: string;
}

export interface ProblemAttemptResult {
  problem: StoredProblem;
  attempt: AttemptRecord;
  events: StoredProblemEvent[];
  blocked: boolean;
  taskStatus: TaskState | null;
}

export interface ArtifactRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  digest: string;
  relPath: string;
  sizeBytes: number;
  mediaType: string;
  source: string;
  retentionClass: "temporary" | "diagnostic" | "evidence";
  createdAt: string;
}

export interface StoredSettings {
  scope: string;
  version: number;
  value: unknown;
  updatedAt: string;
}

export interface RetentionPolicy {
  temporaryDays?: number;
  diagnosticDays?: number;
  includeProtected?: boolean;
  now?: Date;
}

export interface RetentionPlan {
  candidates: ArtifactRecord[];
  protected: Array<{ artifact: ArtifactRecord; reason: string }>;
  warnings: string[];
}

export interface RetentionResult {
  deleted: ArtifactRecord[];
  protected: Array<{ artifact: ArtifactRecord; reason: string }>;
  freedBytes: number;
  warnings: string[];
}

export interface ImportOptions {
  /** Deliberate rebinding for a moved folder or a new machine. */
  rootPath?: string;
  mode?: "create" | "replace";
  expectedRevision?: number;
}

export interface ImportResult {
  project: StoredProject;
  mode: "create" | "replace";
  imported: {
    tasks: number;
    dependencies: number;
    evidence: number;
    attempts: number;
    decisions: number;
    threads: number;
    turns: number;
    drafts: number;
    settings: number;
    submissions: number;
  };
  missingArtifacts: string[];
}

export interface StateStoreOptions {
  dbPath: string;
  artifactRoot?: string;
  backupDir?: string;
  now?: () => Date;
  newId?: (prefix: string) => string;
  diskProbe?: DiskProbe;
  reserveBytes?: number;
  maxArtifactBytes?: number;
  projectQuotaBytes?: number;
  maxDatabaseBytes?: number;
  artifactOptions?: Partial<ArtifactFileStoreOptions>;
}

type DbRow = Record<string, string | number | null>;

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "running",
  "verifying",
  "completed",
  "blocked",
  "interrupted",
  "skipped",
];
const TASK_OWNERS: readonly TaskOwner[] = ["mona_queue", "native_workflow"];
const CRITERION_KINDS: readonly CriterionKind[] = ["check", "human"];
const MAX_CRITERIA = 50;
const MAX_STEPS = 50;
const MAX_REQUIREMENTS = 50;

/** Spec §8.4: three consecutive attempts without material progress stops the problem. */
export const MAX_NO_PROGRESS_ATTEMPTS = 3;

function asString(value: unknown): string {
  return String(value ?? "");
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function usageFromRow(row: DbRow): UsageRecord {
  return {
    id: asString(row.id),
    projectId: asNullableString(row.project_id) as ProjectId | null,
    threadId: asNullableString(row.thread_id),
    turnId: asNullableString(row.turn_id),
    taskId: asNullableString(row.task_id) as TaskId | null,
    provider: asString(row.provider),
    model: asString(row.model),
    inputTokens: asNumberOrNull(row.input_tokens),
    outputTokens: asNumberOrNull(row.output_tokens),
    cachedTokens: asNumberOrNull(row.cached_tokens),
    cacheMissTokens: asNumberOrNull(row.cache_miss_tokens),
    reasoningTokens: asNumberOrNull(row.reasoning_tokens),
    costUsd: asNumberOrNull(row.cost_usd),
    costPicoUsd: asNumberOrNull(row.cost_pico_usd),
    costComplete: Number(row.cost_complete) === 1,
    costState: asString(row.cost_state) as CostState,
    costAllocation: asString(row.cost_allocation) as CostAllocation,
    rateCardId: asNullableString(row.rate_card_id),
    pricingReadAt: asNullableString(row.pricing_read_at),
    tokenSemantics: asString(row.token_semantics) as TokenSemantics,
    note: asNullableString(row.note),
    capturedAt: asString(row.captured_at),
  };
}

function rateCardFromRow(row: DbRow): StoredRateCard {
  return {
    id: asString(row.id),
    provider: asString(row.provider),
    model: asString(row.model),
    currency: "USD",
    unit: "per_million_tokens",
    cacheHitPico: asNumberOrNull(row.cache_hit_pico),
    cacheMissPico: asNumberOrNull(row.cache_miss_pico),
    outputPico: asNumberOrNull(row.output_pico),
    toolCallPico: asNumberOrNull(row.tool_call_pico),
    reasoningInOutput: Number(row.reasoning_in_output) === 1,
    source: asString(row.source) as StoredRateCard["source"],
    sourceRef: asNullableString(row.source_ref),
    revision: asString(row.revision),
    revisionNo: asNumber(row.revision_no),
    readAt: asString(row.read_at),
  };
}

function budgetFromRow(row: DbRow): StoredBudget {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id) as ProjectId,
    scope: asString(row.scope) as BudgetScope,
    limitPico: asNumber(row.limit_pico),
    warnPico: asNumberOrNull(row.warn_pico),
    enabled: Number(row.enabled) === 1,
    timeZone: asString(row.time_zone),
    revision: asNumber(row.revision),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function costMarkFromRow(row: DbRow): CostThreadMark {
  return {
    threadId: asString(row.thread_id),
    windowSince: asString(row.window_since),
    reportedTotalPico: asNumberOrNull(row.reported_total_pico),
    costComplete: Number(row.cost_complete) === 1,
    updatedAt: asString(row.updated_at),
  };
}

function projectFromRow(row: DbRow): StoredProject {
  return {
    id: row.id as string as ProjectId,
    name: asString(row.name),
    rootPath: asString(row.root_path),
    canonicalPath: asString(row.canonical_path),
    fsDev: asNumber(row.fs_dev),
    fsIno: asNumber(row.fs_ino),
    repositoryKind: asString(row.repository_kind) as RepositoryKind,
    repositoryRoot: asNullableString(row.repository_root),
    worktreeName: asNullableString(row.worktree_name),
    accent: asNullableString(row.accent),
    monogram: asNullableString(row.monogram),
    archived: Number(row.archived) === 1,
    pinned: Number(row.pinned) === 1,
    removedAt: asNullableString(row.removed_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    revision: asNumber(row.revision),
  };
}

function taskFromRow(row: DbRow): StoredTask {
  let requirements: string[] = [];
  try {
    const parsed: unknown = JSON.parse(asString(row.requirements_json) || "[]");
    if (Array.isArray(parsed))
      requirements = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    requirements = [];
  }
  return {
    id: row.id as string as TaskId,
    projectId: row.project_id as string as ProjectId,
    title: asString(row.title),
    prompt: asString(row.prompt),
    status: asString(row.status) as TaskStatus,
    executionOwner: (asString(row.execution_owner) || "mona_queue") as TaskOwner,
    requirements,
    nextStep: asNullableString(row.next_step),
    verificationFingerprint: asNullableString(row.verification_fingerprint),
    verificationStale: Number(row.verification_stale) === 1,
    staleReason: asNullableString(row.stale_reason),
    completedAt: asNullableString(row.completed_at),
    importedFrom: asNullableString(row.imported_from),
    activeTurnId: asNullableString(row.active_turn_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    revision: asNumber(row.revision),
  };
}

function criterionFromRow(row: DbRow): AcceptanceCriterion {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id) as TaskId,
    ordinal: asNumber(row.ordinal),
    text: asString(row.text),
    kind: asString(row.kind) as CriterionKind,
    satisfied: Number(row.satisfied) === 1,
    satisfiedBy: asNullableString(row.satisfied_by) as AcceptanceCriterion["satisfiedBy"],
    evidencePath: asNullableString(row.evidence_path),
    updatedAt: asString(row.updated_at),
  };
}

function stepFromRow(row: DbRow): StoredTaskStep {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id) as TaskId,
    ordinal: asNumber(row.ordinal),
    label: asString(row.label),
    state: asString(row.state) as StepState,
    evidencePath: asNullableString(row.evidence_path),
    recordedAt: asString(row.recorded_at),
    updatedAt: asString(row.updated_at),
  };
}

function runFromRow(row: DbRow): TaskRunView {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id) as TaskId,
    owner: asString(row.owner) as TaskOwner,
    state: asString(row.state) as TaskRunView["state"],
    startedAt: asString(row.started_at),
    endedAt: asNullableString(row.ended_at),
    note: asNullableString(row.note),
  };
}

function attemptFromRow(row: DbRow): AttemptRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id) as ProjectId,
    taskId: asNullableString(row.task_id) as TaskId | null,
    problemId: asString(row.problem_id),
    requirement: asString(row.requirement),
    symptom: asNullableString(row.symptom),
    hypothesis: asString(row.hypothesis),
    action: asString(row.action),
    observed: asString(row.observed),
    materialProgress: Number(row.material_progress) === 1,
    evidence: JSON.parse(asString(row.evidence_json) || "[]") as string[],
    createdAt: asString(row.created_at),
  };
}

function problemFromRow(row: DbRow): StoredProblem {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id) as ProjectId,
    taskId: asNullableString(row.task_id) as TaskId | null,
    requirement: asString(row.requirement),
    symptom: asString(row.symptom),
    symptomFingerprint: asString(row.symptom_fingerprint),
    status: asString(row.status) as ProblemState,
    totalAttempts: asNumber(row.total_attempts),
    noProgressAttempts: asNumber(row.no_progress_attempts),
    helpNeeded: asNullableString(row.help_needed),
    blockedAt: asNullableString(row.blocked_at),
    resolvedAt: asNullableString(row.resolved_at),
    resolution: asNullableString(row.resolution),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    revision: asNumber(row.revision),
  };
}

function problemEventFromRow(row: DbRow): StoredProblemEvent {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id) as ProjectId,
    problemId: asString(row.problem_id),
    kind: asString(row.kind) as ProblemEventKind,
    actor: asString(row.actor) as ProblemActor,
    reason: asNullableString(row.reason),
    evidence: JSON.parse(asString(row.evidence_json) || "[]") as string[],
    createdAt: asString(row.created_at),
  };
}

/** Normalize a symptom so whitespace, case, and trailing punctuation do not
 * create a second problem for the same condition. */
function normalizeSymptom(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'\u2018\u2019\u201c\u201d]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:,]+$/g, "")
    .trim();
}

function symptomFingerprint(requirement: string, symptom: string): string {
  return createHash("sha256")
    .update(requirement.trim().toUpperCase())
    .update("\0")
    .update(normalizeSymptom(symptom))
    .digest("hex");
}

function validateRequirementIds(value: readonly string[]): string[] {
  if (value.length > MAX_REQUIREMENTS) {
    throw new StateError(
      "CONFLICT",
      `a task may reference at most ${MAX_REQUIREMENTS} requirements`,
    );
  }
  const unique = [...new Set(value.map((id) => id.trim()))];
  for (const id of unique) {
    if (!/^(MONA|MAC)-\d{3}$/.test(id)) {
      throw new StateError("CONFLICT", `requirement ids look like MONA-001 or MAC-001`, { id });
    }
  }
  return unique;
}

function validateCriteria(
  value: ReadonlyArray<{ text: string; kind: CriterionKind }>,
): Array<{ text: string; kind: CriterionKind }> {
  if (value.length > MAX_CRITERIA) {
    throw new StateError("CONFLICT", `a task may have at most ${MAX_CRITERIA} acceptance criteria`);
  }
  return value.map((criterion, index) => {
    const text = criterion.text.trim();
    if (text.length < 1 || text.length > 1000) {
      throw new StateError(
        "CONFLICT",
        `acceptance criterion ${index + 1} must be 1–1000 characters`,
      );
    }
    if (!CRITERION_KINDS.includes(criterion.kind)) {
      throw new StateError("CONFLICT", `unknown acceptance criterion kind ${criterion.kind}`);
    }
    return { text, kind: criterion.kind };
  });
}

function validateSteps(value: readonly string[]): string[] {
  if (value.length > MAX_STEPS) {
    throw new StateError("CONFLICT", `a task may have at most ${MAX_STEPS} steps`);
  }
  return value.map((label, index) => {
    const text = label.trim();
    if (text.length < 1 || text.length > 500) {
      throw new StateError("CONFLICT", `task step ${index + 1} must be 1–500 characters`);
    }
    return text;
  });
}

function artifactFromRow(row: DbRow): ArtifactRecord {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id) as ProjectId,
    taskId: asNullableString(row.task_id) as TaskId | null,
    digest: asString(row.digest),
    relPath: asString(row.rel_path),
    sizeBytes: asNumber(row.size_bytes),
    mediaType: asString(row.media_type),
    source: asString(row.source),
    retentionClass: asString(row.retention_class) as ArtifactRecord["retentionClass"],
    createdAt: asString(row.created_at),
  };
}

function bindingFromRow(row: DbRow): RuntimeBinding {
  return {
    projectId: row.project_id as string as ProjectId,
    workspace: asString(row.workspace),
    canonicalWorkspace: asString(row.canonical_workspace),
    executable: asString(row.executable),
    engineVersion: asNullableString(row.engine_version),
    engineCommit: asNullableString(row.engine_commit),
    port: asNumberOrNull(row.port),
    state: asString(row.state) as BindingState,
    updatedAt: asString(row.updated_at),
  };
}

function validateName(name: string, label: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new StateError("CONFLICT", `${label} must be between 1 and 200 characters`);
  }
  return trimmed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * The single writer for product state. Every mutation runs through `write()`,
 * which holds the maintenance barrier and one SQLite transaction; reads hold
 * the barrier in shared mode. A public store handle never exposes the database.
 */
export class StateStore {
  readonly barrier = new MaintenanceBarrier();
  private closed = false;

  private constructor(
    private db: DatabaseSync,
    private readonly options: Required<
      Pick<StateStoreOptions, "dbPath" | "backupDir" | "now" | "newId" | "reserveBytes">
    > &
      StateStoreOptions,
    readonly artifactFiles: ArtifactFileStore,
    private readonly diskProbe: DiskProbe,
    private readonly projectQuotaBytes: number,
    private readonly maxArtifactBytes: number,
  ) {}

  static async open(options: StateStoreOptions): Promise<StateStore> {
    ensurePrivateDir(dirname(options.dbPath));
    const backupDir = options.backupDir ?? join(dirname(options.dbPath), "backups");
    ensurePrivateDir(backupDir);
    const now = options.now ?? (() => new Date());
    const maxPageCount =
      options.maxDatabaseBytes === undefined
        ? undefined
        : Math.max(1, Math.floor(options.maxDatabaseBytes / 4096));
    const outcome = await migrateDatabase({
      dbPath: options.dbPath,
      now,
      backupDir,
      databaseOptions: { maxPageCount },
    });
    const artifactRoot = options.artifactRoot ?? join(dirname(options.dbPath), "..", "artifacts");
    const artifactFiles = new ArtifactFileStore({
      ...options.artifactOptions,
      root: artifactRoot,
      reserveBytes: options.reserveBytes,
      maxArtifactBytes: options.maxArtifactBytes,
      probe: options.diskProbe,
    });
    const store = new StateStore(
      outcome.db,
      {
        ...options,
        dbPath: options.dbPath,
        backupDir,
        now,
        newId: options.newId ?? ((prefix) => `${prefix}_${randomBytes(8).toString("hex")}`),
        reserveBytes: options.reserveBytes ?? 64 * 1024 * 1024,
      },
      artifactFiles,
      options.diskProbe ?? nativeDiskProbe,
      options.projectQuotaBytes ?? 512 * 1024 * 1024,
      options.maxArtifactBytes ?? 64 * 1024 * 1024,
    );
    return store;
  }

  get path(): string {
    return this.options.dbPath;
  }

  // ------------------------------------------------------------- primitives

  private now(): string {
    return this.options.now().toISOString();
  }

  private id(prefix: string): string {
    return this.options.newId(prefix);
  }

  private assertOpen(): void {
    if (this.closed) throw new StateError("CONFLICT", "state store is closed");
  }

  private assertHeadroom(): void {
    const free = this.diskProbe.freeBytes(dirname(this.options.dbPath));
    if (free < this.options.reserveBytes) {
      throw new StateError("DISK_FULL", "not enough free disk space to write state", {
        available: free,
        reserve: this.options.reserveBytes,
      });
    }
  }

  private async read<T>(work: (db: DatabaseSync) => T): Promise<T> {
    this.assertOpen();
    return this.barrier.run("read", () => work(this.db));
  }

  private async write<T>(work: (db: DatabaseSync, now: string) => T): Promise<T> {
    this.assertOpen();
    return this.barrier.run("write", () => {
      this.assertHeadroom();
      return withTransaction(this.db, () => {
        const result = work(this.db, this.now());
        this.bumpRevision(this.db);
        return result;
      });
    });
  }

  private bumpRevision(db: DatabaseSync): number {
    const row = db.prepare("SELECT value_json FROM meta WHERE key = 'state_revision'").get() as
      { value_json: string } | undefined;
    const next = (row ? Number(row.value_json) : 0) + 1;
    db.prepare(
      "INSERT INTO meta (key, value_json, updated_at) VALUES ('state_revision', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    ).run(String(next), this.now());
    return next;
  }

  async stateRevision(): Promise<number> {
    return this.read((db) => {
      const row = db.prepare("SELECT value_json FROM meta WHERE key = 'state_revision'").get() as
        { value_json: string } | undefined;
      return row ? Number(row.value_json) : 0;
    });
  }

  // --------------------------------------------------------------- projects

  private findProjectRow(db: DatabaseSync, id: string): DbRow | null {
    return (db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbRow | undefined) ?? null;
  }

  private requireProjectRow(db: DatabaseSync, id: string): DbRow {
    const row = this.findProjectRow(db, id);
    if (!row) throw new StateError("NOT_FOUND", `project ${id} does not exist`, { project_id: id });
    return row;
  }

  private findProjectByIdentity(db: DatabaseSync, identity: PathIdentity): DbRow | null {
    const row = db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_paths pp ON pp.project_id = p.id
         WHERE pp.active = 1 AND pp.fs_dev = ? AND pp.fs_ino = ?`,
      )
      .get(identity.dev, identity.ino) as DbRow | undefined;
    return row ?? null;
  }

  /**
   * A removed catalog entry keeps its path history. Re-opening that folder
   * revives the stable project id instead of creating a parallel record.
   */
  private findRemovedProjectByIdentity(db: DatabaseSync, identity: PathIdentity): DbRow | null {
    const row = db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_paths pp ON pp.project_id = p.id
         WHERE p.removed_at IS NOT NULL AND pp.fs_dev = ? AND pp.fs_ino = ?
         ORDER BY pp.recorded_at DESC LIMIT 1`,
      )
      .get(identity.dev, identity.ino) as DbRow | undefined;
    return row ?? null;
  }

  private insertActivePath(
    db: DatabaseSync,
    projectId: string,
    identity: PathIdentity,
    now: string,
  ): void {
    db.prepare(
      "INSERT INTO project_paths (project_id, path, canonical_path, fs_dev, fs_ino, active, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, ?) " +
        "ON CONFLICT(project_id, canonical_path) DO UPDATE SET active = 1, recorded_at = excluded.recorded_at",
    ).run(projectId, identity.input, identity.canonical, identity.dev, identity.ino, now);
  }

  async createProject(input: {
    name: string;
    rootPath: string;
    pinned?: boolean;
    accent?: string | null;
    monogram?: string | null;
  }): Promise<StoredProject> {
    const identity = identifyPath(input.rootPath);
    const name = validateName(input.name || basename(identity.canonical), "project name");
    return this.write((db, now) => {
      const existing = this.findProjectByIdentity(db, identity);
      if (existing) {
        throw new StateError("ALIAS_CONFLICT", "this folder is already in the project catalog", {
          project_id: existing.id,
          canonical_path: identity.canonical,
        });
      }
      const removed = this.findRemovedProjectByIdentity(db, identity);
      if (removed) {
        // Re-opening a folder removed from the catalog revives its stable
        // project id instead of creating a parallel history.
        db.prepare(
          "UPDATE projects SET name = ?, root_path = ?, canonical_path = ?, fs_dev = ?, fs_ino = ?, " +
            "repository_kind = ?, repository_root = ?, worktree_name = ?, removed_at = NULL, " +
            "updated_at = ?, revision = revision + 1 WHERE id = ?",
        ).run(
          name,
          identity.input,
          identity.canonical,
          identity.dev,
          identity.ino,
          identity.repository.kind,
          identity.repository.root,
          identity.repository.worktreeName,
          now,
          String(removed.id),
        );
        this.insertActivePath(db, String(removed.id), identity, now);
        return projectFromRow(this.requireProjectRow(db, String(removed.id)));
      }
      const id = this.id("prj");
      db.prepare(
        "INSERT INTO projects (id, name, root_path, canonical_path, fs_dev, fs_ino, repository_kind, " +
          "repository_root, worktree_name, accent, monogram, archived, pinned, removed_at, created_at, " +
          "updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 1)",
      ).run(
        id,
        name,
        identity.input,
        identity.canonical,
        identity.dev,
        identity.ino,
        identity.repository.kind,
        identity.repository.root,
        identity.repository.worktreeName,
        input.accent ?? null,
        input.monogram ?? null,
        input.pinned ? 1 : 0,
        now,
        now,
      );
      this.insertActivePath(db, id, identity, now);
      return projectFromRow(this.requireProjectRow(db, id));
    });
  }

  async openProject(rootPath: string): Promise<{ project: StoredProject; created: boolean }> {
    const identity = identifyPath(rootPath);
    const existing = await this.read((db) => this.findProjectByIdentity(db, identity));
    if (existing) {
      return { project: projectFromRow(existing), created: false };
    }
    const removed = await this.read((db) => this.findRemovedProjectByIdentity(db, identity));
    if (removed) {
      const revived = await this.createProject({
        name: basename(identity.canonical),
        rootPath,
      });
      return { project: revived, created: false };
    }
    try {
      const project = await this.createProject({
        name: basename(identity.canonical),
        rootPath,
      });
      return { project, created: true };
    } catch (error) {
      if (error instanceof StateError && error.code === "ALIAS_CONFLICT") {
        const raced = await this.read((db) => this.findProjectByIdentity(db, identity));
        if (raced) return { project: projectFromRow(raced), created: false };
      }
      throw error;
    }
  }

  async listProjects(
    options: { includeArchived?: boolean; includeRemoved?: boolean; query?: string } = {},
  ): Promise<StoredProject[]> {
    return this.read((db) => {
      const clauses: string[] = [];
      const values: Array<string | number | null> = [];
      if (!options.includeArchived) clauses.push("archived = 0");
      if (!options.includeRemoved) clauses.push("removed_at IS NULL");
      if (options.query && options.query.trim()) {
        const pattern = `%${escapeLike(options.query.trim())}%`;
        clauses.push("(name LIKE ? ESCAPE '\\' OR root_path LIKE ? ESCAPE '\\')");
        values.push(pattern, pattern);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT * FROM projects ${where} ORDER BY pinned DESC, updated_at DESC, name COLLATE NOCASE`,
        )
        .all(...values) as DbRow[];
      return rows.map(projectFromRow);
    });
  }

  async getProject(
    id: ProjectId,
    options: { includeRemoved?: boolean } = {},
  ): Promise<StoredProject | null> {
    return this.read((db) => {
      const row = this.findProjectRow(db, id);
      if (!row) return null;
      if (!options.includeRemoved && row.removed_at !== null) return null;
      return projectFromRow(row);
    });
  }

  private mutateProject(
    db: DatabaseSync,
    id: ProjectId,
    expectedRevision: number,
    patch: Partial<Pick<StoredProject, "name" | "pinned" | "archived" | "accent" | "monogram">>,
    now: string,
  ): StoredProject {
    const row = this.requireProjectRow(db, id);
    if (Number(row.revision) !== expectedRevision) {
      throw new StateError("STALE_REVISION", "project changed since it was read", {
        project_id: id,
        expected_revision: expectedRevision,
        actual_revision: Number(row.revision),
      });
    }
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(validateName(patch.name, "project name"));
    }
    for (const [column, value] of [
      ["pinned", patch.pinned],
      ["archived", patch.archived],
    ] as const) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value ? 1 : 0);
      }
    }
    for (const [column, value] of [
      ["accent", patch.accent],
      ["monogram", patch.monogram],
    ] as const) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return projectFromRow(row);
    sets.push("updated_at = ?", "revision = revision + 1");
    values.push(now, id);
    db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return projectFromRow(this.requireProjectRow(db, id));
  }

  async renameProject(
    id: ProjectId,
    name: string,
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, { name }, now));
  }

  async setProjectPinned(
    id: ProjectId,
    pinned: boolean,
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, { pinned }, now));
  }

  async setProjectArchived(
    id: ProjectId,
    archived: boolean,
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, { archived }, now));
  }

  async setProjectIdentity(
    id: ProjectId,
    identity: { accent: string | null; monogram: string | null },
    expectedRevision: number,
  ): Promise<StoredProject> {
    return this.write((db, now) => this.mutateProject(db, id, expectedRevision, identity, now));
  }

  async removeProjectFromCatalog(id: ProjectId, expectedRevision: number): Promise<StoredProject> {
    return this.write((db, now) => {
      const row = this.requireProjectRow(db, id);
      if (row.removed_at !== null) {
        throw new StateError("CONFLICT", "project is already removed from the catalog", {
          project_id: id,
        });
      }
      if (Number(row.revision) !== expectedRevision) {
        throw new StateError("STALE_REVISION", "project changed since it was read", {
          project_id: id,
          expected_revision: expectedRevision,
          actual_revision: Number(row.revision),
        });
      }
      db.prepare("UPDATE project_paths SET active = 0 WHERE project_id = ?").run(id);
      db.prepare(
        "UPDATE projects SET removed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, now, id);
      return projectFromRow(this.requireProjectRow(db, id));
    });
  }

  async relocateProject(
    id: ProjectId,
    newRoot: string,
    expectedRevision: number,
  ): Promise<StoredProject> {
    const identity = identifyPath(newRoot);
    return this.write((db, now) => {
      const row = this.requireProjectRow(db, id);
      if (Number(row.revision) !== expectedRevision) {
        throw new StateError("STALE_REVISION", "project changed since it was read", {
          project_id: id,
          expected_revision: expectedRevision,
          actual_revision: Number(row.revision),
        });
      }
      const owner = this.findProjectByIdentity(db, identity);
      if (owner && String(owner.id) !== String(id)) {
        throw new StateError(
          "ALIAS_CONFLICT",
          "the new location already belongs to another project",
          {
            project_id: owner.id,
          },
        );
      }
      db.prepare("UPDATE project_paths SET active = 0 WHERE project_id = ?").run(id);
      this.insertActivePath(db, id, identity, now);
      db.prepare(
        "UPDATE projects SET root_path = ?, canonical_path = ?, fs_dev = ?, fs_ino = ?, " +
          "repository_kind = ?, repository_root = ?, worktree_name = ?, updated_at = ?, " +
          "revision = revision + 1 WHERE id = ?",
      ).run(
        newRoot,
        identity.canonical,
        identity.dev,
        identity.ino,
        identity.repository.kind,
        identity.repository.root,
        identity.repository.worktreeName,
        now,
        id,
      );
      return projectFromRow(this.requireProjectRow(db, id));
    });
  }

  async listProjectPaths(
    projectId: ProjectId,
  ): Promise<Array<{ path: string; canonicalPath: string; active: boolean; recordedAt: string }>> {
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT path, canonical_path, active, recorded_at FROM project_paths WHERE project_id = ? " +
            "ORDER BY active DESC, recorded_at DESC",
        )
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        path: asString(row.path),
        canonicalPath: asString(row.canonical_path),
        active: Number(row.active) === 1,
        recordedAt: asString(row.recorded_at),
      }));
    });
  }

  // --------------------------------------------------------------- bindings

  async setRuntimeBinding(binding: RuntimeBinding): Promise<RuntimeBinding> {
    return this.write((db) => {
      this.requireProjectRow(db, binding.projectId);
      db.prepare(
        "INSERT INTO runtime_bindings (project_id, workspace, canonical_workspace, executable, " +
          "engine_version, engine_commit, port, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(project_id) DO UPDATE SET workspace = excluded.workspace, " +
          "canonical_workspace = excluded.canonical_workspace, executable = excluded.executable, " +
          "engine_version = excluded.engine_version, engine_commit = excluded.engine_commit, " +
          "port = excluded.port, state = excluded.state, updated_at = excluded.updated_at",
      ).run(
        binding.projectId,
        binding.workspace,
        binding.canonicalWorkspace,
        binding.executable,
        binding.engineVersion,
        binding.engineCommit,
        binding.port,
        binding.state,
        binding.updatedAt,
      );
      return binding;
    });
  }

  async getRuntimeBinding(projectId: ProjectId): Promise<RuntimeBinding | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM runtime_bindings WHERE project_id = ?")
        .get(projectId) as DbRow | undefined;
      return row ? bindingFromRow(row) : null;
    });
  }

  async clearRuntimeBinding(projectId: ProjectId): Promise<void> {
    await this.write((db) => {
      db.prepare("DELETE FROM runtime_bindings WHERE project_id = ?").run(projectId);
    });
  }

  // ---------------------------------------------------------- threads/turns

  async upsertThread(input: {
    id: string;
    projectId: ProjectId;
    engineThreadId?: string | null;
    title?: string | null;
  }): Promise<StoredThread> {
    return this.write((db, now) => {
      this.requireProjectRow(db, input.projectId);
      db.prepare(
        "INSERT INTO threads (id, project_id, engine_thread_id, title, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET " +
          "engine_thread_id = excluded.engine_thread_id, title = COALESCE(excluded.title, threads.title), " +
          "updated_at = excluded.updated_at",
      ).run(input.id, input.projectId, input.engineThreadId ?? null, input.title ?? null, now, now);
      const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(input.id) as DbRow;
      return {
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        engineThreadId: asNullableString(row.engine_thread_id),
        title: asNullableString(row.title),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    });
  }

  async listThreads(projectId: ProjectId): Promise<StoredThread[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        engineThreadId: asNullableString(row.engine_thread_id),
        title: asNullableString(row.title),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      }));
    });
  }

  async upsertTurn(input: StoredTurn): Promise<StoredTurn> {
    return this.write((db) => {
      db.prepare(
        "INSERT INTO turns (id, thread_id, status, provider, model, permission_posture, started_at, ended_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, " +
          "provider = excluded.provider, model = excluded.model, " +
          "permission_posture = excluded.permission_posture, ended_at = excluded.ended_at",
      ).run(
        input.id,
        input.threadId,
        input.status,
        input.provider,
        input.model,
        input.permissionPosture,
        input.startedAt,
        input.endedAt,
      );
      return input;
    });
  }

  // ------------------------------------------------------------- submissions

  async putSubmission(
    state: SubmissionState,
    projectId?: ProjectId | null,
  ): Promise<SubmissionState> {
    const parsed = SubmissionState.parse(state);
    return this.write((db) => {
      db.prepare(
        "INSERT INTO submissions (operation_key, project_id, thread_id, turn_id, status, submitted_at, " +
          "reconciled, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(operation_key) DO UPDATE SET status = excluded.status, turn_id = excluded.turn_id, " +
          "reconciled = excluded.reconciled, note = excluded.note",
      ).run(
        parsed.operationKey,
        projectId ?? null,
        parsed.threadId,
        parsed.turnId,
        parsed.status,
        parsed.submittedAt,
        parsed.reconciled ? 1 : 0,
        parsed.note ?? null,
      );
      return parsed;
    });
  }

  async getSubmission(operationKey: string): Promise<SubmissionState | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM submissions WHERE operation_key = ?")
        .get(operationKey) as DbRow | undefined;
      if (!row) return null;
      const value: Record<string, unknown> = {
        operationKey: asString(row.operation_key),
        threadId: asString(row.thread_id),
        turnId: asNullableString(row.turn_id),
        status: asString(row.status) as SubmissionStatus,
        submittedAt: asString(row.submitted_at),
        reconciled: Number(row.reconciled) === 1,
      };
      if (row.note !== null) value.note = asString(row.note);
      return SubmissionState.parse(value);
    });
  }

  // ------------------------------------------------------------------- tasks

  async createTask(input: {
    projectId: ProjectId;
    title: string;
    prompt: string;
    dependsOn?: TaskId[];
    owner?: TaskOwner;
    requirements?: string[];
    acceptance?: Array<{ text: string; kind: CriterionKind }>;
    steps?: string[];
    importedFrom?: string | null;
  }): Promise<StoredTask> {
    const title = validateName(input.title, "task title");
    const prompt = input.prompt.trim();
    if (!prompt) throw new StateError("CONFLICT", "task prompt cannot be empty");
    if (prompt.length > 100_000) {
      throw new StateError("CONFLICT", "task prompt is limited to 100000 characters");
    }
    const owner = input.owner ?? "mona_queue";
    if (!TASK_OWNERS.includes(owner)) {
      throw new StateError("CONFLICT", `unknown task owner ${owner}`);
    }
    const requirements = validateRequirementIds(input.requirements ?? []);
    const criteria = validateCriteria(input.acceptance ?? []);
    const steps = validateSteps(input.steps ?? []);
    return this.write((db, now) => {
      const project = this.requireProjectRow(db, input.projectId);
      if (project.removed_at !== null) {
        throw new StateError("CONFLICT", "cannot add a task to a removed project", {
          project_id: input.projectId,
        });
      }
      const id = this.id("tsk");
      db.prepare(
        "INSERT INTO tasks (id, project_id, title, prompt, status, execution_owner, requirements_json, " +
          "imported_from, created_at, updated_at, revision) " +
          "VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1)",
      ).run(
        id,
        input.projectId,
        title,
        prompt,
        owner,
        JSON.stringify(requirements),
        input.importedFrom ?? null,
        now,
        now,
      );
      for (const dependency of input.dependsOn ?? []) {
        this.insertDependency(db, id, dependency, input.projectId, now);
      }
      this.insertCriteria(db, id, criteria, now);
      this.insertSteps(db, id, steps, now);
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  /**
   * Imported plans are inserted in one transaction. Keys are local to the plan
   * and resolve to real task ids only after insertion, so a failed import leaves
   * no half-created board.
   */
  async createTasks(input: {
    projectId: ProjectId;
    importedFrom?: string | null;
    tasks: ReadonlyArray<{
      key: string;
      title: string;
      prompt: string;
      owner?: TaskOwner;
      requirements?: string[];
      acceptance?: Array<{ text: string; kind: CriterionKind }>;
      steps?: string[];
      dependsOnKeys?: string[];
    }>;
  }): Promise<Array<{ key: string; task: StoredTask }>> {
    if (input.tasks.length === 0) {
      throw new StateError("CONFLICT", "an imported plan needs at least one task");
    }
    if (input.tasks.length > 200) {
      throw new StateError("CONFLICT", "an imported plan is limited to 200 tasks");
    }
    const keys = new Set<string>();
    const prepared = input.tasks.map((task) => {
      const key = task.key.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
        throw new StateError("CONFLICT", `plan key ${JSON.stringify(key)} is not a stable token`);
      }
      if (keys.has(key)) {
        throw new StateError("CONFLICT", `duplicate plan key ${key}`);
      }
      keys.add(key);
      const title = validateName(task.title, "task title");
      const prompt = task.prompt.trim();
      if (!prompt) throw new StateError("CONFLICT", `plan task ${key} has an empty prompt`);
      if (prompt.length > 100_000) {
        throw new StateError("CONFLICT", `plan task ${key} prompt is too long`);
      }
      const owner = task.owner ?? "mona_queue";
      if (!TASK_OWNERS.includes(owner)) {
        throw new StateError("CONFLICT", `plan task ${key} has unknown owner ${owner}`);
      }
      return {
        key,
        title,
        prompt,
        owner,
        requirements: validateRequirementIds(task.requirements ?? []),
        criteria: validateCriteria(task.acceptance ?? []),
        steps: validateSteps(task.steps ?? []),
        dependsOnKeys: [...new Set(task.dependsOnKeys ?? [])],
      };
    });
    for (const task of prepared) {
      for (const dependency of task.dependsOnKeys) {
        if (!keys.has(dependency)) {
          throw new StateError(
            "CONFLICT",
            `plan task ${task.key} depends on unknown key ${dependency}`,
          );
        }
        if (dependency === task.key) {
          throw new StateError("CONFLICT", `plan task ${task.key} depends on itself`);
        }
      }
    }
    this.assertPlanAcyclic(prepared);
    return this.write((db, now) => {
      const project = this.requireProjectRow(db, input.projectId);
      if (project.removed_at !== null) {
        throw new StateError("CONFLICT", "cannot add tasks to a removed project", {
          project_id: input.projectId,
        });
      }
      const ids = new Map<string, string>();
      for (const task of prepared) ids.set(task.key, this.id("tsk"));
      for (const task of prepared) {
        const id = ids.get(task.key);
        if (!id) throw new StateError("CONFLICT", "plan key resolution failed");
        db.prepare(
          "INSERT INTO tasks (id, project_id, title, prompt, status, execution_owner, requirements_json, " +
            "imported_from, created_at, updated_at, revision) " +
            "VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1)",
        ).run(
          id,
          input.projectId,
          task.title,
          task.prompt,
          task.owner,
          JSON.stringify(task.requirements),
          input.importedFrom ?? null,
          now,
          now,
        );
        this.insertCriteria(db, id, task.criteria, now);
        this.insertSteps(db, id, task.steps, now);
      }
      for (const task of prepared) {
        const id = ids.get(task.key);
        if (!id) continue;
        for (const dependency of task.dependsOnKeys) {
          const dependencyId = ids.get(dependency);
          if (!dependencyId) continue;
          this.insertDependency(db, id, dependencyId, input.projectId, now);
        }
      }
      this.assertNoDependencyCycle(db, input.projectId);
      return prepared.map((task) => {
        const id = ids.get(task.key) as string;
        return {
          key: task.key,
          task: taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow),
        };
      });
    });
  }

  private assertPlanAcyclic(
    tasks: ReadonlyArray<{ key: string; dependsOnKeys: readonly string[] }>,
  ): void {
    const graph = new Map<string, readonly string[]>(
      tasks.map((task) => [task.key, task.dependsOnKeys] as const),
    );
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (key: string, trail: string[]): void => {
      if (done.has(key)) return;
      if (visiting.has(key)) {
        throw new StateError("CONFLICT", `dependency cycle: ${[...trail, key].join(" -> ")}`);
      }
      visiting.add(key);
      for (const dependency of graph.get(key) ?? []) visit(dependency, [...trail, key]);
      visiting.delete(key);
      done.add(key);
    };
    for (const task of tasks) visit(task.key, []);
  }

  private assertNoDependencyCycle(db: DatabaseSync, projectId: ProjectId): void {
    const rows = db
      .prepare(
        `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
          JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
      )
      .all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>;
    const graph = new Map<string, string[]>();
    for (const row of rows) {
      const list = graph.get(String(row.task_id)) ?? [];
      list.push(String(row.depends_on_task_id));
      graph.set(String(row.task_id), list);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (key: string): void => {
      if (done.has(key)) return;
      if (visiting.has(key)) {
        throw new StateError("CONFLICT", "dependency graph contains a cycle", { task_id: key });
      }
      visiting.add(key);
      for (const dependency of graph.get(key) ?? []) visit(dependency);
      visiting.delete(key);
      done.add(key);
    };
    for (const key of graph.keys()) visit(key);
  }

  private insertCriteria(
    db: DatabaseSync,
    taskId: string,
    criteria: ReadonlyArray<{ text: string; kind: CriterionKind }>,
    now: string,
  ): void {
    criteria.forEach((criterion, ordinal) => {
      db.prepare(
        "INSERT INTO task_acceptance (id, task_id, ordinal, text, kind, satisfied, satisfied_by, " +
          "evidence_path, updated_at) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)",
      ).run(this.id("acp"), taskId, ordinal, criterion.text, criterion.kind, now);
    });
  }

  private insertSteps(
    db: DatabaseSync,
    taskId: string,
    labels: readonly string[],
    now: string,
  ): void {
    labels.forEach((label, ordinal) => {
      db.prepare(
        "INSERT INTO task_steps (id, task_id, ordinal, label, state, evidence_path, recorded_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)",
      ).run(this.id("stp"), taskId, ordinal, label, now, now);
    });
  }

  private insertDependency(
    db: DatabaseSync,
    taskId: string,
    dependsOnTaskId: string,
    projectId: ProjectId,
    now: string,
  ): void {
    if (taskId === dependsOnTaskId) {
      throw new StateError("CONFLICT", "a task cannot depend on itself", { task_id: taskId });
    }
    const prerequisite = db
      .prepare("SELECT project_id FROM tasks WHERE id = ?")
      .get(dependsOnTaskId) as { project_id: string } | undefined;
    if (!prerequisite) {
      throw new StateError("NOT_FOUND", `prerequisite task ${dependsOnTaskId} does not exist`);
    }
    if (String(prerequisite.project_id) !== String(projectId)) {
      throw new StateError("CONFLICT", "task dependencies cannot cross projects", {
        task_id: taskId,
        prerequisite: dependsOnTaskId,
      });
    }
    db.prepare(
      "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
    ).run(taskId, dependsOnTaskId, now);
  }

  async addTaskDependency(taskId: TaskId, dependsOnTaskId: TaskId): Promise<void> {
    await this.write((db, now) => {
      const task = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as
        { project_id: string } | undefined;
      if (!task) throw new StateError("NOT_FOUND", `task ${taskId} does not exist`);
      if (this.dependsTransitively(db, dependsOnTaskId, taskId)) {
        throw new StateError("CONFLICT", "dependency would create a cycle", {
          task_id: taskId,
          depends_on_task_id: dependsOnTaskId,
        });
      }
      this.insertDependency(db, taskId, dependsOnTaskId, String(task.project_id) as ProjectId, now);
    });
  }

  private dependsTransitively(db: DatabaseSync, from: string, target: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) continue;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const rows = db
        .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
        .all(current) as Array<{ depends_on_task_id: string }>;
      for (const row of rows) queue.push(String(row.depends_on_task_id));
    }
    return false;
  }

  async listTasks(projectId: ProjectId): Promise<StoredTask[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id")
        .all(projectId) as DbRow[];
      return rows.map(taskFromRow);
    });
  }

  async getTask(id: TaskId): Promise<StoredTask | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
      return row ? taskFromRow(row) : null;
    });
  }

  async listDependencies(
    projectId: ProjectId,
  ): Promise<Array<{ taskId: TaskId; dependsOnTaskId: TaskId }>> {
    return this.read((db) => {
      const rows = db
        .prepare(
          `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? ORDER BY d.task_id, d.depends_on_task_id`,
        )
        .all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>;
      return rows.map((row) => ({
        taskId: row.task_id as TaskId,
        dependsOnTaskId: row.depends_on_task_id as TaskId,
      }));
    });
  }

  async listAcceptance(taskId: TaskId): Promise<AcceptanceCriterion[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM task_acceptance WHERE task_id = ? ORDER BY ordinal")
        .all(taskId) as DbRow[];
      return rows.map(criterionFromRow);
    });
  }

  async listTaskSteps(taskId: TaskId): Promise<StoredTaskStep[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY ordinal")
        .all(taskId) as DbRow[];
      return rows.map(stepFromRow);
    });
  }

  async listTaskRuns(projectId: ProjectId): Promise<TaskRunView[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM task_runs WHERE project_id = ? ORDER BY started_at, id")
        .all(projectId) as DbRow[];
      return rows.map(runFromRow);
    });
  }

  async activeTaskRun(projectId: ProjectId): Promise<TaskRunView | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM task_runs WHERE project_id = ? AND state = 'running'")
        .get(projectId) as DbRow | undefined;
      return row ? runFromRow(row) : null;
    });
  }

  async listTaskTransitions(projectId: ProjectId): Promise<TaskTransitionRecord[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY created_at, rowid")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        taskId: asString(row.task_id) as TaskId,
        fromStatus: asNullableString(row.from_status),
        toStatus: asString(row.to_status),
        actor: asString(row.actor) as TransitionActor,
        reason: asNullableString(row.reason),
        createdAt: asString(row.created_at),
      }));
    });
  }

  /** Metadata edits are allowed only while no run is active. */
  async updateTask(
    id: TaskId,
    expectedRevision: number,
    input: {
      title?: string;
      prompt?: string;
      owner?: TaskOwner;
      requirements?: string[];
      acceptance?: Array<{ text: string; kind: CriterionKind }>;
      steps?: string[];
    },
  ): Promise<StoredTask> {
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, id);
      this.checkTaskRevision(row, expectedRevision);
      const status = asString(row.status) as TaskStatus;
      if (!EDITABLE_STATES.includes(status)) {
        throw new StateError("CONFLICT", `a ${status} task cannot be edited`, { task_id: id });
      }
      const title =
        input.title === undefined ? asString(row.title) : validateName(input.title, "task title");
      let prompt = asString(row.prompt);
      if (input.prompt !== undefined) {
        prompt = input.prompt.trim();
        if (!prompt) throw new StateError("CONFLICT", "task prompt cannot be empty");
        if (prompt.length > 100_000) {
          throw new StateError("CONFLICT", "task prompt is limited to 100000 characters");
        }
      }
      const owner = input.owner ?? (asString(row.execution_owner) as TaskOwner);
      if (!TASK_OWNERS.includes(owner)) {
        throw new StateError("CONFLICT", `unknown task owner ${owner}`);
      }
      const requirements =
        input.requirements === undefined
          ? taskFromRow(row).requirements
          : validateRequirementIds(input.requirements);
      db.prepare(
        "UPDATE tasks SET title = ?, prompt = ?, execution_owner = ?, requirements_json = ?, " +
          "updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(title, prompt, owner, JSON.stringify(requirements), now, id);
      if (input.acceptance !== undefined) {
        const criteria = validateCriteria(input.acceptance);
        db.prepare("DELETE FROM task_acceptance WHERE task_id = ?").run(id);
        this.insertCriteria(db, id, criteria, now);
      }
      if (input.steps !== undefined) {
        const steps = validateSteps(input.steps);
        db.prepare("DELETE FROM task_steps WHERE task_id = ?").run(id);
        this.insertSteps(db, id, steps, now);
        db.prepare("UPDATE tasks SET next_step = ? WHERE id = ?").run(steps[0] ?? null, id);
      }
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  /**
   * Satisfy one criterion. A `check` criterion can only be satisfied by a
   * recorded check result with an evidence path; a `human` criterion can only
   * be satisfied by an explicit human action. Model output cannot do either.
   */
  async satisfyAcceptance(
    taskId: TaskId,
    criterionId: string,
    expectedRevision: number,
    input: { by: "check" | "human"; evidencePath?: string | null },
  ): Promise<StoredTask> {
    if (input.by !== "check" && input.by !== "human") {
      throw new StateError("CONFLICT", `unknown verification source ${String(input.by)}`);
    }
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, taskId);
      this.checkTaskRevision(row, expectedRevision);
      const criterion = db
        .prepare("SELECT * FROM task_acceptance WHERE id = ? AND task_id = ?")
        .get(criterionId, taskId) as DbRow | undefined;
      if (!criterion) {
        throw new StateError("NOT_FOUND", "acceptance criterion is not on this task", {
          task_id: taskId,
          criterion_id: criterionId,
        });
      }
      if (asString(criterion.kind) !== input.by) {
        throw new StateError(
          "CONFLICT",
          `this is a ${asString(criterion.kind)} criterion; it cannot be satisfied by ${input.by}`,
          { task_id: taskId, criterion_id: criterionId },
        );
      }
      const evidencePath = input.evidencePath ?? null;
      if (
        evidencePath !== null &&
        (evidencePath.trim().length === 0 || evidencePath.length > 2048)
      ) {
        throw new StateError("CONFLICT", "evidence path must be 1–2048 characters");
      }
      if (input.by === "check" && !evidencePath) {
        throw new StateError("CONFLICT", "a check result needs an evidence path", {
          task_id: taskId,
          criterion_id: criterionId,
        });
      }
      db.prepare(
        "UPDATE task_acceptance SET satisfied = 1, satisfied_by = ?, evidence_path = ?, updated_at = ? " +
          "WHERE id = ?",
      ).run(input.by, evidencePath, now, criterionId);
      db.prepare("UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(
        now,
        taskId,
      );
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow);
    });
  }

  async setTaskStepState(
    taskId: TaskId,
    stepId: string,
    state: StepState,
    evidencePath?: string | null,
  ): Promise<StoredTaskStep> {
    if (!["pending", "running", "completed", "skipped"].includes(state)) {
      throw new StateError("CONFLICT", `unknown step state ${state}`);
    }
    return this.write((db, now) => {
      const step = db
        .prepare("SELECT * FROM task_steps WHERE id = ? AND task_id = ?")
        .get(stepId, taskId) as DbRow | undefined;
      if (!step) throw new StateError("NOT_FOUND", `step ${stepId} is not on task ${taskId}`);
      db.prepare(
        "UPDATE task_steps SET state = ?, evidence_path = COALESCE(?, evidence_path), updated_at = ? WHERE id = ?",
      ).run(state, evidencePath ?? null, now, stepId);
      const remaining = db
        .prepare(
          "SELECT label FROM task_steps WHERE task_id = ? AND state NOT IN ('completed', 'skipped') " +
            "ORDER BY ordinal LIMIT 1",
        )
        .get(taskId) as { label: string } | undefined;
      db.prepare(
        "UPDATE tasks SET next_step = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(remaining ? String(remaining.label) : null, now, taskId);
      return stepFromRow(db.prepare("SELECT * FROM task_steps WHERE id = ?").get(stepId) as DbRow);
    });
  }

  /**
   * Generic status write. Every edge, actor, prerequisite, and single-run rule
   * is enforced here; completion is deliberately unreachable from this method.
   */
  async updateTaskStatus(
    id: TaskId,
    status: TaskStatus,
    expectedRevision: number,
    options: { actor?: TransitionActor; reason?: string | null } = {},
  ): Promise<StoredTask> {
    if (!TASK_STATUSES.includes(status)) {
      throw new StateError("CONFLICT", `unknown task status ${status}`);
    }
    const actor = options.actor ?? "human";
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, id);
      this.checkTaskRevision(row, expectedRevision);
      const from = asString(row.status) as TaskState;
      const decision = decideTransition({
        from,
        to: status,
        actor,
        reason: options.reason ?? null,
      });
      if (!decision.allowed) {
        throw new StateError("CONFLICT", decision.reason ?? `${from} cannot become ${status}`, {
          task_id: id,
          from,
          to: status,
        });
      }
      if (actor === "mona_queue" && asString(row.execution_owner) !== "mona_queue") {
        throw new StateError("OWNER_MISMATCH", "the Mona queue does not own this task", {
          task_id: id,
          owner: asString(row.execution_owner),
        });
      }
      if (status === "running") {
        const unmet = this.unmetPrerequisites(db, id);
        if (unmet.length > 0) {
          throw new StateError("CONFLICT", "prerequisites must be completed before starting", {
            task_id: id,
            unmet,
          });
        }
        const blockedProblem = db
          .prepare("SELECT id FROM problems WHERE task_id = ? AND status = 'blocked' LIMIT 1")
          .get(id) as { id: string } | undefined;
        if (blockedProblem) {
          throw new StateError(
            "CONFLICT",
            "a blocked problem must be resolved or reopened with new evidence before this task starts",
            { task_id: id, problem_id: String(blockedProblem.id) },
          );
        }
        const other = db
          .prepare("SELECT id FROM tasks WHERE project_id = ? AND status = 'running' AND id <> ?")
          .get(asString(row.project_id), id) as { id: string } | undefined;
        if (other) {
          throw new StateError("CONFLICT", "workspace already has a mutating run", {
            task_id: id,
            running_task_id: String(other.id),
          });
        }
      }
      this.setTaskStatusRow(db, id, status, now);
      this.auditTaskTransition(
        db,
        asString(row.project_id) as ProjectId,
        id,
        from,
        status,
        actor,
        options.reason ?? null,
        now,
      );
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  /** Atomically claim the single mutating run and move the task to running. */
  async beginTaskRun(input: {
    taskId: TaskId;
    owner: TaskOwner;
    expectedRevision?: number;
    note?: string | null;
  }): Promise<StartedTaskRun> {
    if (!TASK_OWNERS.includes(input.owner)) {
      throw new StateError("CONFLICT", `unknown task owner ${input.owner}`);
    }
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, input.taskId);
      if (input.expectedRevision !== undefined) {
        this.checkTaskRevision(row, input.expectedRevision);
      }
      const from = asString(row.status) as TaskState;
      if (from !== "pending" && from !== "interrupted" && from !== "blocked") {
        throw new StateError("CONFLICT", `a ${from} task cannot start`, {
          task_id: input.taskId,
          status: from,
        });
      }
      if (asString(row.execution_owner) !== input.owner) {
        throw new StateError("OWNER_MISMATCH", "the task is owned by another execution owner", {
          task_id: input.taskId,
          task_owner: asString(row.execution_owner),
          run_owner: input.owner,
        });
      }
      const unmet = this.unmetPrerequisites(db, input.taskId);
      if (unmet.length > 0) {
        throw new StateError("CONFLICT", "prerequisites must be completed before starting", {
          task_id: input.taskId,
          unmet,
        });
      }
      const blockedProblem = db
        .prepare("SELECT id FROM problems WHERE task_id = ? AND status = 'blocked' LIMIT 1")
        .get(input.taskId) as { id: string } | undefined;
      if (blockedProblem) {
        throw new StateError(
          "CONFLICT",
          "a blocked problem must be resolved or reopened with new evidence before this task starts",
          { task_id: input.taskId, problem_id: String(blockedProblem.id) },
        );
      }
      const decision = decideTransition({ from, to: "running", actor: input.owner });
      if (!decision.allowed) {
        throw new StateError("CONFLICT", decision.reason ?? `${from} cannot start`, {
          task_id: input.taskId,
        });
      }
      const active = db
        .prepare("SELECT id FROM task_runs WHERE project_id = ? AND state = 'running'")
        .get(asString(row.project_id)) as { id: string } | undefined;
      if (active) {
        throw new StateError("CONFLICT", "workspace already has a mutating run", {
          task_id: input.taskId,
          running_run_id: String(active.id),
        });
      }
      const runId = this.id("run");
      try {
        db.prepare(
          "INSERT INTO task_runs (id, project_id, task_id, owner, state, started_at, ended_at, note) " +
            "VALUES (?, ?, ?, ?, 'running', ?, NULL, ?)",
        ).run(runId, asString(row.project_id), input.taskId, input.owner, now, input.note ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE|constraint/i.test(message)) {
          throw new StateError("CONFLICT", "workspace already has a mutating run", {
            task_id: input.taskId,
          });
        }
        throw error;
      }
      const step = db
        .prepare(
          "SELECT * FROM task_steps WHERE task_id = ? AND state NOT IN ('completed', 'skipped') " +
            "ORDER BY ordinal LIMIT 1",
        )
        .get(input.taskId) as DbRow | undefined;
      db.prepare(
        "UPDATE tasks SET status = 'running', active_turn_id = NULL, next_step = ?, updated_at = ?, " +
          "revision = revision + 1 WHERE id = ?",
      ).run(step ? String(step.label) : null, now, input.taskId);
      if (step) {
        const runningStep = db
          .prepare("SELECT id FROM task_steps WHERE task_id = ? AND state = 'running'")
          .get(input.taskId) as { id: string } | undefined;
        if (!runningStep) {
          db.prepare("UPDATE task_steps SET state = 'running', updated_at = ? WHERE id = ?").run(
            now,
            String(step.id),
          );
        }
      }
      this.auditTaskTransition(
        db,
        asString(row.project_id) as ProjectId,
        input.taskId,
        from,
        "running",
        input.owner,
        from === "interrupted"
          ? `resume at ${step ? String(step.label) : "recorded step"}`
          : from === "blocked"
            ? "started from a blocked task; no active blocked problem remains"
            : null,
        now,
      );
      return {
        task: taskFromRow(
          db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.taskId) as DbRow,
        ),
        run: runFromRow(db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as DbRow),
      };
    });
  }

  async finishTaskRun(
    runId: string,
    state: "completed" | "failed" | "interrupted",
    note?: string | null,
  ): Promise<TaskRunView> {
    return this.write((db, now) => {
      const run = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as
        DbRow | undefined;
      if (!run) throw new StateError("NOT_FOUND", `run ${runId} does not exist`);
      if (asString(run.state) !== "running") {
        throw new StateError("CONFLICT", "run is already finished", { run_id: runId });
      }
      db.prepare("UPDATE task_runs SET state = ?, ended_at = ?, note = ? WHERE id = ?").run(
        state,
        now,
        note ?? asNullableString(run.note),
        runId,
      );
      if (state === "failed" || state === "interrupted") {
        const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(asString(run.task_id)) as
          DbRow | undefined;
        if (task && asString(task.status) === "running") {
          db.prepare(
            "UPDATE tasks SET status = 'interrupted', active_turn_id = NULL, updated_at = ?, " +
              "revision = revision + 1 WHERE id = ?",
          ).run(now, asString(run.task_id));
          this.auditTaskTransition(
            db,
            asString(task.project_id) as ProjectId,
            asString(task.id) as TaskId,
            "running",
            "interrupted",
            asString(run.owner) as TaskOwner,
            note ?? `run ${state}`,
            now,
          );
        }
      }
      return runFromRow(db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId) as DbRow);
    });
  }

  /**
   * Record that implementation is ready for verification. The fingerprint is
   * the workspace state at this moment; a later mismatch reopens the task.
   */
  async markTaskVerifying(
    id: TaskId,
    expectedRevision: number,
    fingerprint: string,
    actor: "human" | "mona_queue" = "human",
  ): Promise<StoredTask> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new StateError("CONFLICT", "verification fingerprint must be a sha256 digest");
    }
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, id);
      this.checkTaskRevision(row, expectedRevision);
      const decision = decideTransition({
        from: asString(row.status) as TaskState,
        to: "verifying",
        actor,
      });
      if (!decision.allowed) {
        throw new StateError("CONFLICT", decision.reason ?? "task cannot enter verification", {
          task_id: id,
        });
      }
      db.prepare(
        "UPDATE tasks SET status = 'verifying', active_turn_id = NULL, verification_fingerprint = ?, " +
          "verification_stale = 0, stale_reason = NULL, updated_at = ?, revision = revision + 1 " +
          "WHERE id = ?",
      ).run(fingerprint, now, id);
      this.auditTaskTransition(
        db,
        asString(row.project_id) as ProjectId,
        id,
        asString(row.status) as TaskState,
        "verifying",
        actor,
        null,
        now,
      );
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  /**
   * The only path to `completed`. Every configured criterion must be satisfied,
   * and every declared requirement must have evidence linked to this task.
   */
  async completeTask(
    id: TaskId,
    expectedRevision: number,
    input: { fingerprint: string; actor?: "human" | "mona_queue" },
  ): Promise<StoredTask> {
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) {
      throw new StateError("CONFLICT", "verification fingerprint must be a sha256 digest");
    }
    const actor = input.actor ?? "human";
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, id);
      this.checkTaskRevision(row, expectedRevision);
      const from = asString(row.status) as TaskState;
      if (from !== "verifying") {
        throw new StateError("CONFLICT", "completion requires a task in verification", {
          task_id: id,
          status: from,
        });
      }
      const criteria = db
        .prepare("SELECT * FROM task_acceptance WHERE task_id = ? ORDER BY ordinal")
        .all(id) as DbRow[];
      if (criteria.length === 0) {
        throw new StateError("CONFLICT", "completion requires at least one acceptance criterion", {
          task_id: id,
        });
      }
      const unsatisfied = criteria
        .filter((criterion) => Number(criterion.satisfied) !== 1)
        .map((criterion) => ({ id: String(criterion.id), text: String(criterion.text) }));
      if (unsatisfied.length > 0) {
        throw new StateError("CONFLICT", "acceptance criteria are not satisfied", {
          task_id: id,
          unsatisfied,
        });
      }
      const requirements = taskFromRow(row).requirements;
      const missingEvidence = requirements.filter((requirement) => {
        const found = db
          .prepare(
            "SELECT 1 AS present FROM requirement_evidence WHERE task_id = ? AND requirement_id = ? LIMIT 1",
          )
          .get(id, requirement) as { present?: number } | undefined;
        return !found;
      });
      if (missingEvidence.length > 0) {
        throw new StateError("CONFLICT", "requirements need linked evidence before completion", {
          task_id: id,
          missing: missingEvidence,
        });
      }
      db.prepare(
        "UPDATE tasks SET status = 'completed', active_turn_id = NULL, completed_at = ?, " +
          "verification_fingerprint = ?, verification_stale = 0, stale_reason = NULL, " +
          "next_step = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, input.fingerprint, now, id);
      this.auditTaskTransition(
        db,
        asString(row.project_id) as ProjectId,
        id,
        from,
        "completed",
        actor,
        `acceptance passed: ${criteria.length} criteria`,
        now,
      );
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  /** Reconciliation only: the code moved, so the old verification is stale. */
  async markVerificationStale(id: TaskId, reason: string): Promise<StoredTask | null> {
    const text = reason.trim();
    if (!text) throw new StateError("CONFLICT", "a stale verification needs a reason");
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, id);
      const from = asString(row.status) as TaskState;
      if (from !== "completed" && from !== "verifying") {
        return taskFromRow(row);
      }
      if (from === "completed") {
        db.prepare(
          "UPDATE tasks SET status = 'verifying', completed_at = NULL, verification_stale = 1, " +
            "stale_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
        ).run(text, now, id);
        this.auditTaskTransition(
          db,
          asString(row.project_id) as ProjectId,
          id,
          from,
          "verifying",
          "reconciler",
          text,
          now,
        );
      } else {
        db.prepare(
          "UPDATE tasks SET verification_stale = 1, stale_reason = ?, updated_at = ?, " +
            "revision = revision + 1 WHERE id = ?",
        ).run(text, now, id);
      }
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow);
    });
  }

  private requireTaskRow(db: DatabaseSync, id: TaskId): DbRow {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new StateError("NOT_FOUND", `task ${id} does not exist`, { task_id: id });
    return row;
  }

  private checkTaskRevision(row: DbRow, expected: number): void {
    if (Number(row.revision) !== expected) {
      throw new StateError("STALE_REVISION", "task changed since it was read", {
        task_id: asString(row.id),
        expected_revision: expected,
        actual_revision: Number(row.revision),
      });
    }
  }

  private unmetPrerequisites(db: DatabaseSync, taskId: string): string[] {
    const rows = db
      .prepare(
        `SELECT d.depends_on_task_id AS id, t.status AS status
           FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
          WHERE d.task_id = ? AND t.status <> 'completed'`,
      )
      .all(taskId) as Array<{ id: string; status: string }>;
    return rows.map((row) => String(row.id));
  }

  private setTaskStatusRow(db: DatabaseSync, id: string, status: TaskStatus, now: string): void {
    db.prepare(
      "UPDATE tasks SET status = ?, active_turn_id = CASE WHEN ? = 'running' THEN active_turn_id " +
        "ELSE NULL END, updated_at = ?, revision = revision + 1 WHERE id = ?",
    ).run(status, status, now, id);
  }

  private auditTaskTransition(
    db: DatabaseSync,
    projectId: ProjectId,
    taskId: TaskId,
    from: TaskState,
    to: TaskState,
    actor: TransitionActor,
    reason: string | null,
    now: string,
  ): void {
    db.prepare(
      "INSERT INTO task_events (id, project_id, task_id, from_status, to_status, actor, reason, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(this.id("tev"), projectId, taskId, from, to, actor, reason, now);
  }

  // -------------------------------------------------------------- evidence

  async addRequirementEvidence(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    requirementId: string;
    path: string;
    digest?: string | null;
    note?: string | null;
  }): Promise<RequirementEvidenceRecord> {
    if (!/^(MONA|MAC)-\d{3}$/.test(input.requirementId)) {
      throw new StateError("CONFLICT", "requirement ids look like MONA-001 or MAC-001");
    }
    return this.write((db, now) => {
      const id = this.id("evd");
      db.prepare(
        "INSERT INTO requirement_evidence (id, project_id, task_id, requirement_id, path, digest, note, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.requirementId,
        input.path,
        input.digest ?? null,
        input.note ?? null,
        now,
      );
      return {
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        requirementId: input.requirementId,
        path: input.path,
        digest: input.digest ?? null,
        note: input.note ?? null,
        createdAt: now,
      };
    });
  }

  async listRequirementEvidence(projectId: ProjectId): Promise<RequirementEvidenceRecord[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM requirement_evidence WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        taskId: asNullableString(row.task_id) as TaskId | null,
        requirementId: asString(row.requirement_id),
        path: asString(row.path),
        digest: asNullableString(row.digest),
        note: asNullableString(row.note),
        createdAt: asString(row.created_at),
      }));
    });
  }

  /**
   * Legacy journal entry: an imported or historical attempt that predates the
   * problem ledger. Mona's dispatch path never calls this; it uses
   * `recordProblemAttempt`, whose counters and block transitions are enforced
   * inside one transaction.
   */
  async recordAttempt(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    problemId: string;
    requirement: string;
    symptom?: string | null;
    hypothesis: string;
    action: string;
    observed: string;
    materialProgress: boolean;
    evidence?: string[];
  }): Promise<AttemptRecord> {
    return this.write((db, now) => {
      const id = this.id("atp");
      const evidence = input.evidence ?? [];
      db.prepare(
        "INSERT INTO attempts (id, project_id, task_id, problem_id, requirement, symptom, hypothesis, " +
          "action, observed, material_progress, evidence_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.problemId,
        input.requirement,
        input.symptom ?? null,
        input.hypothesis,
        input.action,
        input.observed,
        input.materialProgress ? 1 : 0,
        JSON.stringify(evidence),
        now,
      );
      return {
        id,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        problemId: input.problemId,
        requirement: input.requirement,
        symptom: input.symptom ?? null,
        hypothesis: input.hypothesis,
        action: input.action,
        observed: input.observed,
        materialProgress: input.materialProgress,
        evidence,
        createdAt: now,
      };
    });
  }

  async listAttempts(projectId: ProjectId, problemId?: string): Promise<AttemptRecord[]> {
    return this.read((db) => {
      const rows = (
        problemId
          ? db
              .prepare(
                "SELECT * FROM attempts WHERE project_id = ? AND problem_id = ? ORDER BY created_at",
              )
              .all(projectId, problemId)
          : db
              .prepare("SELECT * FROM attempts WHERE project_id = ? ORDER BY created_at")
              .all(projectId)
      ) as DbRow[];
      return rows.map(attemptFromRow);
    });
  }

  async listProblems(projectId: ProjectId): Promise<StoredProblem[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM problems WHERE project_id = ? ORDER BY created_at, id")
        .all(projectId) as DbRow[];
      return rows.map(problemFromRow);
    });
  }

  async getProblem(problemId: string): Promise<StoredProblem | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as
        DbRow | undefined;
      return row ? problemFromRow(row) : null;
    });
  }

  async listProblemEvents(projectId: ProjectId, problemId?: string): Promise<StoredProblemEvent[]> {
    return this.read((db) => {
      const rows = (
        problemId
          ? db
              .prepare(
                "SELECT * FROM problem_events WHERE project_id = ? AND problem_id = ? " +
                  "ORDER BY created_at, rowid",
              )
              .all(projectId, problemId)
          : db
              .prepare(
                "SELECT * FROM problem_events WHERE project_id = ? ORDER BY created_at, rowid",
              )
              .all(projectId)
      ) as DbRow[];
      return rows.map(problemEventFromRow);
    });
  }

  /**
   * Record one hypothesis-and-result cycle against a stable problem. One
   * transaction creates or finds the problem, inserts the attempt, moves the
   * counters, and — at the third consecutive attempt without material progress —
   * blocks the problem and its running/verifying task. A fourth attempt against
   * a blocked problem is refused, as is a progress claim with no evidence.
   */
  async recordProblemAttempt(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    requirement: string;
    symptom: string;
    hypothesis: string;
    action: string;
    observed: string;
    materialProgress: boolean;
    evidence?: string[];
    reason?: string | null;
    helpNeeded?: string | null;
    actor?: ProblemActor;
  }): Promise<ProblemAttemptResult> {
    const requirement = input.requirement.trim().toUpperCase();
    if (!/^(MONA|MAC)-\d{3}$/.test(requirement)) {
      throw new StateError("CONFLICT", "requirement ids look like MONA-001 or MAC-001", {
        requirement: input.requirement,
      });
    }
    const symptom = input.symptom.trim();
    if (symptom.length < 1 || symptom.length > 4000) {
      throw new StateError("CONFLICT", "a symptom must be between 1 and 4000 characters");
    }
    for (const field of ["hypothesis", "action", "observed"] as const) {
      if (input[field].trim().length < 1) {
        throw new StateError("CONFLICT", `an attempt needs a non-empty ${field}`);
      }
    }
    const evidence = [...new Set((input.evidence ?? []).map((path) => path.trim()))].filter(
      (path) => path.length > 0,
    );
    const reason = input.reason?.trim() ?? "";
    if (input.materialProgress && evidence.length === 0 && reason.length === 0) {
      throw new StateError(
        "CONFLICT",
        "material progress needs linked evidence or a short reason before the counter resets",
      );
    }
    const actor = input.actor ?? "agent";
    const fingerprint = symptomFingerprint(requirement, symptom);

    return this.write((db, now) => {
      if (input.taskId) {
        this.requireTaskRow(db, input.taskId);
        const owner = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(input.taskId) as
          DbRow | undefined;
        if (owner && asString(owner.project_id) !== input.projectId) {
          throw new StateError("CONFLICT", "task is not in this project", {
            task_id: input.taskId,
          });
        }
      }

      // A task-bound attempt keys only on its task and requirement. It never
      // adopts a taskless problem, because a taskless row would leave the block
      // detached from the task that selection and beginTaskRun check.
      const row = input.taskId
        ? (db
            .prepare(
              "SELECT * FROM problems WHERE project_id = ? AND task_id = ? AND requirement = ? " +
                "AND status <> 'resolved' LIMIT 1",
            )
            .get(input.projectId, input.taskId, requirement) as DbRow | undefined)
        : (db
            .prepare(
              "SELECT * FROM problems WHERE project_id = ? AND symptom_fingerprint = ? " +
                "AND task_id IS NULL AND status <> 'resolved' LIMIT 1",
            )
            .get(input.projectId, fingerprint) as DbRow | undefined);

      const events: StoredProblemEvent[] = [];
      const event = (
        problemId: string,
        kind: ProblemEventKind,
        eventReason: string | null,
        eventEvidence: string[],
      ): void => {
        const id = this.id("pev");
        db.prepare(
          "INSERT INTO problem_events (id, project_id, problem_id, kind, actor, reason, " +
            "evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          input.projectId,
          problemId,
          kind,
          actor,
          eventReason,
          JSON.stringify(eventEvidence),
          now,
        );
        events.push({
          id,
          projectId: input.projectId,
          problemId,
          kind,
          actor,
          reason: eventReason,
          evidence: eventEvidence,
          createdAt: now,
        });
      };

      let problemId: string;
      if (!row) {
        problemId = this.id("prb");
        db.prepare(
          "INSERT INTO problems (id, project_id, task_id, requirement, symptom, " +
            "symptom_fingerprint, status, total_attempts, no_progress_attempts, help_needed, " +
            "blocked_at, resolved_at, resolution, created_at, updated_at, revision) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'open', 0, 0, NULL, NULL, NULL, NULL, ?, ?, 1)",
        ).run(
          problemId,
          input.projectId,
          input.taskId ?? null,
          requirement,
          symptom,
          fingerprint,
          now,
          now,
        );
        event(problemId, "created", `problem created for ${requirement}`, evidence);
      } else {
        problemId = asString(row.id);
        if (asString(row.status) === "blocked") {
          throw new StateError(
            "CONFLICT",
            "this problem is blocked after three attempts without progress; " +
              "reopen it with material new evidence or resolve it first",
            { problem_id: problemId, status: "blocked" },
          );
        }
      }

      const current = db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as DbRow;
      const total = asNumber(current.total_attempts) + 1;
      const noProgress = input.materialProgress ? 0 : asNumber(current.no_progress_attempts) + 1;
      const blocked = noProgress >= MAX_NO_PROGRESS_ATTEMPTS && !input.materialProgress;
      const helpNeeded = blocked
        ? input.helpNeeded?.trim() ||
          `Unblock ${requirement}: ${symptom} — new evidence or a decision is required.`
        : asNullableString(current.help_needed);
      const status = blocked ? "blocked" : "open";

      const attemptId = this.id("atp");
      db.prepare(
        "INSERT INTO attempts (id, project_id, task_id, problem_id, requirement, symptom, " +
          "hypothesis, action, observed, material_progress, evidence_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        attemptId,
        input.projectId,
        input.taskId ?? null,
        problemId,
        requirement,
        symptom,
        input.hypothesis,
        input.action,
        input.observed,
        input.materialProgress ? 1 : 0,
        JSON.stringify(evidence),
        now,
      );
      db.prepare(
        "UPDATE problems SET symptom = ?, symptom_fingerprint = ?, status = ?, " +
          "total_attempts = ?, no_progress_attempts = ?, help_needed = ?, " +
          "blocked_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(
        symptom,
        fingerprint,
        status,
        total,
        noProgress,
        helpNeeded,
        blocked ? now : asNullableString(current.blocked_at),
        now,
        problemId,
      );
      event(
        problemId,
        "attempt",
        input.materialProgress
          ? "material progress; consecutive counter reset"
          : `no material progress (${noProgress}/${MAX_NO_PROGRESS_ATTEMPTS})`,
        evidence,
      );
      if (input.materialProgress) {
        event(problemId, "progress_reset", reason || "material progress recorded", evidence);
      }

      let taskStatus: TaskState | null = null;
      if (blocked) {
        const blockHelp =
          helpNeeded ??
          `Unblock ${requirement}: ${symptom} — new evidence or a decision is required.`;
        event(problemId, "blocked", blockHelp, evidence);
        if (input.taskId) {
          taskStatus = this.blockTaskForProblem(db, input.taskId, blockHelp, now);
        }
      }

      return {
        problem: problemFromRow(
          db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as DbRow,
        ),
        attempt: attemptFromRow(
          db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as DbRow,
        ),
        events,
        blocked,
        taskStatus,
      };
    });
  }

  /** Acknowledgement is visibility, not progress: no counter changes. */
  async acknowledgeProblem(
    problemId: string,
    options: { note?: string | null; actor?: ProblemActor } = {},
  ): Promise<StoredProblem> {
    return this.write((db, now) => {
      const row = db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as
        DbRow | undefined;
      if (!row) throw new StateError("NOT_FOUND", `problem ${problemId} does not exist`);
      db.prepare(
        "INSERT INTO problem_events (id, project_id, problem_id, kind, actor, reason, " +
          "evidence_json, created_at) VALUES (?, ?, ?, 'acknowledged', ?, ?, '[]', ?)",
      ).run(
        this.id("pev"),
        asString(row.project_id),
        problemId,
        options.actor ?? "human",
        options.note?.trim() || "acknowledged without changing the attempt count",
        now,
      );
      db.prepare("UPDATE problems SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(
        now,
        problemId,
      );
      return problemFromRow(
        db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as DbRow,
      );
    });
  }

  /** A human decision ends the problem; attempts are history, never erased. */
  async resolveProblem(
    problemId: string,
    input: { resolution: string; evidence?: string[]; actor?: ProblemActor },
  ): Promise<StoredProblem> {
    const resolution = input.resolution.trim();
    if (resolution.length < 1) {
      throw new StateError("CONFLICT", "resolving a problem needs a recorded decision");
    }
    return this.write((db, now) => {
      const row = db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as
        DbRow | undefined;
      if (!row) throw new StateError("NOT_FOUND", `problem ${problemId} does not exist`);
      if (asString(row.status) === "resolved") {
        throw new StateError("CONFLICT", "problem is already resolved", { problem_id: problemId });
      }
      db.prepare(
        "UPDATE problems SET status = 'resolved', resolution = ?, resolved_at = ?, " +
          "help_needed = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(resolution, now, now, problemId);
      const evidence = [...new Set((input.evidence ?? []).map((p) => p.trim()))].filter(Boolean);
      db.prepare(
        "INSERT INTO problem_events (id, project_id, problem_id, kind, actor, reason, " +
          "evidence_json, created_at) VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?)",
      ).run(
        this.id("pev"),
        asString(row.project_id),
        problemId,
        input.actor ?? "human",
        resolution,
        JSON.stringify(evidence),
        now,
      );
      return problemFromRow(
        db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as DbRow,
      );
    });
  }

  /**
   * The only path that resets the consecutive counter on a blocked problem.
   * It requires material new evidence and a reason, keeps the total, and leaves
   * an audit record that a later session can read.
   */
  async reopenProblem(
    problemId: string,
    input: { reason: string; evidence: string[]; actor?: ProblemActor },
  ): Promise<StoredProblem> {
    const reason = input.reason.trim();
    const evidence = [...new Set((input.evidence ?? []).map((p) => p.trim()))].filter(Boolean);
    if (reason.length < 1) {
      throw new StateError("CONFLICT", "reopening a blocked problem needs a short reason");
    }
    if (evidence.length === 0) {
      throw new StateError(
        "CONFLICT",
        "reopening a blocked problem needs at least one new evidence path",
      );
    }
    return this.write((db, now) => {
      const row = db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as
        DbRow | undefined;
      if (!row) throw new StateError("NOT_FOUND", `problem ${problemId} does not exist`);
      if (asString(row.status) !== "blocked") {
        throw new StateError("CONFLICT", "only a blocked problem reopens on new evidence", {
          problem_id: problemId,
          status: asString(row.status),
        });
      }
      db.prepare(
        "UPDATE problems SET status = 'open', no_progress_attempts = 0, blocked_at = NULL, " +
          "help_needed = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(now, problemId);
      db.prepare(
        "INSERT INTO problem_events (id, project_id, problem_id, kind, actor, reason, " +
          "evidence_json, created_at) VALUES (?, ?, ?, 'reopened', ?, ?, ?, ?)",
      ).run(
        this.id("pev"),
        asString(row.project_id),
        problemId,
        input.actor ?? "human",
        reason,
        JSON.stringify(evidence),
        now,
      );
      return problemFromRow(
        db.prepare("SELECT * FROM problems WHERE id = ?").get(problemId) as DbRow,
      );
    });
  }

  /**
   * The mechanical gate for every dispatch path: a task with any blocked
   * problem cannot start, even if a caller skips board selection.
   */
  async blockedProblemsForTask(taskId: TaskId): Promise<StoredProblem[]> {
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT * FROM problems WHERE task_id = ? AND status = 'blocked' ORDER BY created_at",
        )
        .all(taskId) as DbRow[];
      return rows.map(problemFromRow);
    });
  }

  /** Attach the engine turn a Mona dispatch opened, so a confirmed interrupt
   * can name the task it stopped instead of guessing from timestamps. */
  async attachTaskTurn(taskId: TaskId, turnId: string | null): Promise<StoredTask> {
    return this.write((db, now) => {
      this.requireTaskRow(db, taskId);
      db.prepare(
        "UPDATE tasks SET active_turn_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      ).run(turnId, now, taskId);
      return taskFromRow(db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow);
    });
  }

  /**
   * Clear a dispatch→turn link when that exact turn ended. Matching on the turn
   * id means a finished turn never clears a link that a newer dispatch owns.
   */
  async clearTaskTurn(projectId: ProjectId, turnId: string): Promise<TaskId[]> {
    return this.write((db, now) => {
      const rows = db
        .prepare("SELECT id FROM tasks WHERE project_id = ? AND active_turn_id = ?")
        .all(projectId, turnId) as DbRow[];
      if (rows.length === 0) return [];
      db.prepare(
        "UPDATE tasks SET active_turn_id = NULL, updated_at = ?, revision = revision + 1 " +
          "WHERE project_id = ? AND active_turn_id = ?",
      ).run(now, projectId, turnId);
      return rows.map((row) => asString(row.id) as TaskId);
    });
  }

  /** Append an audit note without pretending a status transition happened. */
  async appendTaskEvent(input: {
    taskId: TaskId;
    actor: TransitionActor;
    reason: string;
  }): Promise<void> {
    return this.write((db, now) => {
      const row = this.requireTaskRow(db, input.taskId);
      const status = asString(row.status);
      db.prepare(
        "INSERT INTO task_events (id, project_id, task_id, from_status, to_status, actor, reason, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        this.id("tev"),
        asString(row.project_id),
        input.taskId,
        status,
        status,
        input.actor,
        input.reason,
        now,
      );
    });
  }

  private blockTaskForProblem(
    db: DatabaseSync,
    taskId: TaskId,
    helpNeeded: string,
    now: string,
  ): TaskState | null {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as DbRow | undefined;
    if (!row) return null;
    const from = asString(row.status) as TaskState;
    if (from !== "running" && from !== "verifying") return from;
    db.prepare(
      "UPDATE task_runs SET state = 'interrupted', ended_at = ?, note = ? " +
        "WHERE task_id = ? AND state = 'running'",
    ).run(now, helpNeeded, taskId);
    this.setTaskStatusRow(db, taskId, "blocked", now);
    this.auditTaskTransition(
      db,
      asString(row.project_id) as ProjectId,
      taskId,
      from,
      "blocked",
      asString(row.execution_owner) === "native_workflow" ? "native_workflow" : "mona_queue",
      helpNeeded,
      now,
    );
    return "blocked";
  }

  async addDecision(input: {
    projectId: ProjectId;
    title: string;
    body: string;
  }): Promise<StoredDecision> {
    return this.write((db, now) => {
      const id = this.id("dec");
      db.prepare(
        "INSERT INTO decisions (id, project_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, input.projectId, input.title, input.body, now);
      return {
        id,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        createdAt: now,
      };
    });
  }

  async listDecisions(projectId: ProjectId): Promise<StoredDecision[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        title: asString(row.title),
        body: asString(row.body),
        createdAt: asString(row.created_at),
      }));
    });
  }

  // ----------------------------------------------------------------- events

  async recordEvent(input: {
    threadId: string;
    seq: number;
    kind: string;
    payload: unknown;
    timestamp: string;
    /** The envelope's turn identity, kept so tool items can be joined to it. */
    turnId?: string | null;
  }): Promise<{ recorded: boolean; cursor: number }> {
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new StateError("CONFLICT", "event sequence must be a positive integer");
    }
    return this.write((db, now) => {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO events (thread_id, seq, kind, payload_json, timestamp, recorded_at, turn_id) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.threadId,
          input.seq,
          input.kind,
          JSON.stringify(input.payload),
          input.timestamp,
          now,
          input.turnId ?? null,
        );
      const recorded = Number(result.changes) > 0;
      const row = db
        .prepare("SELECT last_seq FROM event_cursors WHERE thread_id = ?")
        .get(input.threadId) as { last_seq: number } | undefined;
      const cursor = Math.max(Number(row?.last_seq ?? 0), recorded ? input.seq : 0);
      db.prepare(
        "INSERT INTO event_cursors (thread_id, last_seq, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at",
      ).run(input.threadId, cursor, now);
      return { recorded, cursor };
    });
  }

  async getCursor(threadId: string): Promise<number> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT last_seq FROM event_cursors WHERE thread_id = ?")
        .get(threadId) as { last_seq: number } | undefined;
      return Number(row?.last_seq ?? 0);
    });
  }

  async readEvents(threadId: string, afterSeq = 0, limit = 200): Promise<StoredEvent[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 1000);
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(threadId, afterSeq, bounded) as DbRow[];
      return rows.map((row) => ({
        threadId: asString(row.thread_id),
        seq: asNumber(row.seq),
        kind: asString(row.kind),
        payload: JSON.parse(asString(row.payload_json)),
        timestamp: asString(row.timestamp),
        recordedAt: asString(row.recorded_at),
        turnId: asNullableString(row.turn_id),
      }));
    });
  }

  /**
   * Tool records for one turn, read from the stored event projection. Rows
   * recorded before v6 have a null turn id, so they are simply absent here;
   * nothing is invented to fill the gap.
   */
  async listTurnItems(
    threadId: string,
    turnId: string,
    limit = 200,
  ): Promise<Array<{ seq: number; kind: string; payload: unknown; timestamp: string }>> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 1000);
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT * FROM events WHERE thread_id = ? AND turn_id = ? " +
            "AND kind IN ('item.completed', 'item.failed') ORDER BY seq LIMIT ?",
        )
        .all(threadId, turnId, bounded) as DbRow[];
      return rows.map((row) => ({
        seq: asNumber(row.seq),
        kind: asString(row.kind),
        payload: JSON.parse(asString(row.payload_json)),
        timestamp: asString(row.timestamp),
      }));
    });
  }

  /**
   * Timeline projection across every thread of one project. Threads are
   * projections; the project timeline must not fragment when a live engine
   * thread is added beside the local shell thread.
   */
  async readProjectEvents(projectId: ProjectId, limit = 200): Promise<StoredEvent[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 2000);
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT e.* FROM events e JOIN threads t ON t.id = e.thread_id " +
            "WHERE t.project_id = ? ORDER BY e.recorded_at ASC, e.seq ASC LIMIT ?",
        )
        .all(projectId, bounded) as DbRow[];
      return rows.map((row) => ({
        threadId: asString(row.thread_id),
        seq: asNumber(row.seq),
        kind: asString(row.kind),
        payload: JSON.parse(asString(row.payload_json)),
        timestamp: asString(row.timestamp),
        recordedAt: asString(row.recorded_at),
        turnId: asNullableString(row.turn_id),
      }));
    });
  }

  /** Most recent submissions for a project, newest first. Read-only. */
  async listSubmissions(projectId: ProjectId, limit = 20): Promise<SubmissionState[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 200);
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT * FROM submissions WHERE project_id = ? ORDER BY submitted_at DESC LIMIT ?",
        )
        .all(projectId, bounded) as DbRow[];
      return rows.map((row) => {
        const value: Record<string, unknown> = {
          operationKey: asString(row.operation_key),
          threadId: asString(row.thread_id),
          turnId: asNullableString(row.turn_id),
          status: asString(row.status) as SubmissionStatus,
          submittedAt: asString(row.submitted_at),
          reconciled: Number(row.reconciled) === 1,
        };
        if (row.note !== null) value.note = asString(row.note);
        return SubmissionState.parse(value);
      });
    });
  }

  // ------------------------------------------------------------------ usage

  /**
   * Record one observed turn. A turn is written at most once per thread: a
   * reconnect, a replay, or a restarted process returns the stored row instead
   * of adding a second charge. Price provenance is explicit and never inferred
   * from arrival order.
   */
  async recordUsage(input: UsageInput): Promise<UsageRecord> {
    return this.write((db, now) => {
      if (input.threadId !== null && input.turnId !== null) {
        const existing = db
          .prepare("SELECT * FROM usage_records WHERE thread_id = ? AND turn_id = ?")
          .get(input.threadId, input.turnId) as DbRow | undefined;
        if (existing) return usageFromRow(existing);
      }
      const id = this.id("usg");
      const costPico =
        input.costPicoUsd ??
        (input.costUsd === null ? null : Math.round(input.costUsd * 1_000_000_000_000));
      const costState: CostState =
        input.costState ??
        (costPico !== null && (input.costComplete ?? true) ? "reported" : "unknown_price");
      const costComplete = costState === "reported" || costState === "estimated";
      let taskId = input.taskId ?? null;
      if (!taskId && input.projectId && input.turnId) {
        const linked = db
          .prepare("SELECT id FROM tasks WHERE project_id = ? AND active_turn_id = ? LIMIT 1")
          .get(input.projectId, input.turnId) as { id: string } | undefined;
        taskId = (linked?.id as TaskId | undefined) ?? null;
      }
      const capturedAt = input.capturedAt || now;
      db.prepare(
        "INSERT INTO usage_records (id, project_id, thread_id, turn_id, task_id, provider, model, " +
          "input_tokens, output_tokens, cached_tokens, cache_miss_tokens, reasoning_tokens, " +
          "cost_usd, cost_pico_usd, cost_complete, cost_state, cost_allocation, rate_card_id, " +
          "pricing_read_at, token_semantics, note, captured_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.projectId,
        input.threadId,
        input.turnId,
        taskId,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cachedTokens,
        input.cacheMissTokens ?? null,
        input.reasoningTokens,
        costPico === null ? null : costPico / 1_000_000_000_000,
        costPico,
        costComplete ? 1 : 0,
        costState,
        input.costAllocation ?? "turn",
        input.rateCardId ?? null,
        input.pricingReadAt ?? null,
        input.tokenSemantics ?? "inclusive_input",
        input.note ?? null,
        capturedAt,
      );
      return usageFromRow(db.prepare("SELECT * FROM usage_records WHERE id = ?").get(id) as DbRow);
    });
  }

  /** Upgrade an existing turn's price evidence without touching its identity. */
  async updateUsageCost(input: {
    id: string;
    costPicoUsd: number;
    costState: CostState;
    costAllocation: CostAllocation;
    rateCardId: string | null;
    pricingReadAt: string | null;
    note: string | null;
  }): Promise<UsageRecord> {
    return this.write((db) => {
      const row = db.prepare("SELECT * FROM usage_records WHERE id = ?").get(input.id) as
        DbRow | undefined;
      if (!row) throw new StateError("NOT_FOUND", "usage row disappeared");
      const complete = input.costState === "reported" || input.costState === "estimated";
      db.prepare(
        "UPDATE usage_records SET cost_usd = ?, cost_pico_usd = ?, cost_complete = ?, " +
          "cost_state = ?, cost_allocation = ?, rate_card_id = ?, pricing_read_at = ?, note = ? " +
          "WHERE id = ?",
      ).run(
        input.costPicoUsd / 1_000_000_000_000,
        input.costPicoUsd,
        complete ? 1 : 0,
        input.costState,
        input.costAllocation,
        input.rateCardId,
        input.pricingReadAt,
        input.note,
        input.id,
      );
      return usageFromRow(
        db.prepare("SELECT * FROM usage_records WHERE id = ?").get(input.id) as DbRow,
      );
    });
  }

  async getUsageForTurn(threadId: string, turnId: string): Promise<UsageRecord | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM usage_records WHERE thread_id = ? AND turn_id = ?")
        .get(threadId, turnId) as DbRow | undefined;
      return row ? usageFromRow(row) : null;
    });
  }

  async countUsageForThread(threadId: string): Promise<number> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM usage_records WHERE thread_id = ?")
        .get(threadId) as DbRow;
      return asNumber(row.count);
    });
  }

  async listUsageRecords(
    projectId: ProjectId,
    range: { since?: string | null; until?: string | null; limit?: number } = {},
  ): Promise<UsageRecord[]> {
    return this.read((db) => {
      const conditions = ["project_id = ?"];
      const bind: Array<string | number> = [projectId];
      if (range.since) {
        conditions.push("captured_at >= ?");
        bind.push(range.since);
      }
      if (range.until) {
        conditions.push("captured_at < ?");
        bind.push(range.until);
      }
      const limit = Math.min(Math.max(range.limit ?? 5000, 1), 20_000);
      bind.push(limit);
      const rows = db
        .prepare(
          `SELECT * FROM usage_records WHERE ${conditions.join(" AND ")} ` +
            "ORDER BY captured_at ASC, id ASC LIMIT ?",
        )
        .all(...bind) as DbRow[];
      return rows.map(usageFromRow);
    });
  }

  async usageByModel(projectId: ProjectId): Promise<
    Array<{
      model: string;
      provider: string;
      turns: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheMissTokens: number;
      reasoningTokens: number;
      costUsd: number;
      costPicoUsd: number;
      costComplete: boolean;
      reportedTurns: number;
      estimatedTurns: number;
      unknownTurns: number;
    }>
  > {
    return this.read((db) => {
      const rows = db
        .prepare(
          `SELECT model, provider, COUNT(*) AS turns,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                  COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens,
                  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                  COALESCE(SUM(cost_pico_usd), 0) AS cost_pico_usd,
                  SUM(CASE WHEN cost_state = 'reported' THEN 1 ELSE 0 END) AS reported_rows,
                  SUM(CASE WHEN cost_state = 'estimated' THEN 1 ELSE 0 END) AS estimated_rows,
                  SUM(CASE WHEN cost_state IN ('unknown_price', 'missing_usage', 'unallocated')
                           THEN 1 ELSE 0 END) AS unknown_rows
           FROM usage_records WHERE project_id = ?
           GROUP BY provider, model ORDER BY model`,
        )
        .all(projectId) as DbRow[];
      return rows.map((row) => {
        const turns = asNumber(row.turns);
        const unknown = asNumber(row.unknown_rows);
        const costPico = asNumber(row.cost_pico_usd);
        return {
          model: asString(row.model),
          provider: asString(row.provider),
          turns,
          inputTokens: asNumber(row.input_tokens),
          outputTokens: asNumber(row.output_tokens),
          cachedTokens: asNumber(row.cached_tokens),
          cacheMissTokens: asNumber(row.cache_miss_tokens),
          reasoningTokens: asNumber(row.reasoning_tokens),
          costUsd: costPico / 1_000_000_000_000,
          costPicoUsd: costPico,
          costComplete: turns > 0 && unknown === 0,
          reportedTurns: asNumber(row.reported_rows),
          estimatedTurns: asNumber(row.estimated_rows),
          unknownTurns: unknown,
        };
      });
    });
  }

  async summarizeUsage(projectId: ProjectId): Promise<UsageSummary> {
    return this.read((db) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS turns,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                  COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens,
                  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                  COALESCE(SUM(cost_pico_usd), 0) AS cost_pico_usd,
                  SUM(CASE WHEN cost_state = 'reported' THEN 1 ELSE 0 END) AS reported_rows,
                  SUM(CASE WHEN cost_state = 'estimated' THEN 1 ELSE 0 END) AS estimated_rows,
                  SUM(CASE WHEN cost_state = 'unknown_price' THEN 1 ELSE 0 END) AS unknown_rows,
                  SUM(CASE WHEN cost_state = 'missing_usage' THEN 1 ELSE 0 END) AS missing_rows,
                  SUM(CASE WHEN cost_state = 'unallocated' THEN 1 ELSE 0 END) AS unallocated_rows
           FROM usage_records WHERE project_id = ?`,
        )
        .get(projectId) as DbRow;
      const residual = db
        .prepare(
          `SELECT COALESCE(SUM(residual), 0) AS residual FROM (
             SELECT MAX(0, m.reported_total_pico -
               COALESCE((SELECT SUM(u.cost_pico_usd) FROM usage_records u
                         WHERE u.thread_id = m.thread_id), 0)) AS residual
             FROM cost_thread_marks m JOIN threads t ON t.id = m.thread_id
             WHERE t.project_id = ? AND m.reported_total_pico IS NOT NULL
           )`,
        )
        .get(projectId) as DbRow;
      const turns = asNumber(row.turns);
      const definite = asNumber(row.reported_rows) + asNumber(row.estimated_rows);
      const residualPico = asNumber(residual.residual);
      const costPico = asNumber(row.cost_pico_usd) + residualPico;
      return {
        turns,
        inputTokens: asNumber(row.input_tokens),
        outputTokens: asNumber(row.output_tokens),
        cachedTokens: asNumber(row.cached_tokens),
        cacheMissTokens: asNumber(row.cache_miss_tokens),
        reasoningTokens: asNumber(row.reasoning_tokens),
        costUsd: costPico / 1_000_000_000_000,
        costPicoUsd: costPico,
        costComplete: turns > 0 && definite === turns && residualPico === 0,
        observed: turns > 0,
        reportedTurns: asNumber(row.reported_rows),
        estimatedTurns: asNumber(row.estimated_rows),
        unknownTurns: asNumber(row.unknown_rows),
        missingTurns: asNumber(row.missing_rows),
        unallocatedTurns: asNumber(row.unallocated_rows),
        residualPicoUsd: residualPico,
      };
    });
  }

  // ------------------------------------------------------------ cost marks

  async getThread(id: string): Promise<StoredThread | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as DbRow | undefined;
      if (!row) return null;
      return {
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        engineThreadId: asNullableString(row.engine_thread_id),
        title: asNullableString(row.title),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      };
    });
  }

  async getCostThreadMark(threadId: string): Promise<CostThreadMark | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM cost_thread_marks WHERE thread_id = ?")
        .get(threadId) as DbRow | undefined;
      return row ? costMarkFromRow(row) : null;
    });
  }

  async putCostThreadMark(input: {
    threadId: string;
    windowSince: string;
    reportedTotalPico: number | null;
    costComplete: boolean;
  }): Promise<CostThreadMark> {
    return this.write((db, now) => {
      db.prepare(
        "INSERT INTO cost_thread_marks (thread_id, window_since, reported_total_pico, " +
          "cost_complete, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(thread_id) DO UPDATE SET window_since = excluded.window_since, " +
          "reported_total_pico = excluded.reported_total_pico, " +
          "cost_complete = excluded.cost_complete, updated_at = excluded.updated_at",
      ).run(
        input.threadId,
        input.windowSince,
        input.reportedTotalPico,
        input.costComplete ? 1 : 0,
        now,
      );
      return costMarkFromRow(
        db
          .prepare("SELECT * FROM cost_thread_marks WHERE thread_id = ?")
          .get(input.threadId) as DbRow,
      );
    });
  }

  // ------------------------------------------------------------ rate cards

  async currentRateCard(provider: string, model: string): Promise<StoredRateCard | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          "SELECT * FROM rate_cards WHERE provider = ? AND model = ? AND superseded_at IS NULL",
        )
        .get(provider, model) as DbRow | undefined;
      return row ? rateCardFromRow(row) : null;
    });
  }

  async listRateCards(): Promise<StoredRateCard[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM rate_cards WHERE superseded_at IS NULL ORDER BY provider, model")
        .all() as DbRow[];
      return rows.map(rateCardFromRow);
    });
  }

  async saveRateCard(input: {
    provider: string;
    model: string;
    cacheHitPico: number | null;
    cacheMissPico: number | null;
    outputPico: number | null;
    toolCallPico: number | null;
    reasoningInOutput: boolean;
    source: "user_supplied" | "provider_docs";
    sourceRef: string | null;
    readAt: string;
  }): Promise<StoredRateCard> {
    const revision = createHash("sha256")
      .update(
        canonicalJson({
          provider: input.provider,
          model: input.model,
          cacheHitPico: input.cacheHitPico,
          cacheMissPico: input.cacheMissPico,
          outputPico: input.outputPico,
          toolCallPico: input.toolCallPico,
          reasoningInOutput: input.reasoningInOutput,
          readAt: input.readAt,
        }),
      )
      .digest("hex");
    return this.write((db, now) => {
      const current = db
        .prepare(
          "SELECT * FROM rate_cards WHERE provider = ? AND model = ? AND superseded_at IS NULL",
        )
        .get(input.provider, input.model) as DbRow | undefined;
      let revisionNo = 1;
      if (current) {
        revisionNo = asNumber(current.revision_no) + 1;
        db.prepare("UPDATE rate_cards SET superseded_at = ? WHERE id = ?").run(
          now,
          asString(current.id),
        );
      }
      const id = this.id("rate");
      db.prepare(
        "INSERT INTO rate_cards (id, provider, model, currency, unit, cache_hit_pico, " +
          "cache_miss_pico, output_pico, tool_call_pico, reasoning_in_output, source, source_ref, " +
          "revision, revision_no, read_at, created_at, superseded_at) " +
          "VALUES (?, ?, ?, 'USD', 'per_million_tokens', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(
        id,
        input.provider,
        input.model,
        input.cacheHitPico,
        input.cacheMissPico,
        input.outputPico,
        input.toolCallPico,
        input.reasoningInOutput ? 1 : 0,
        input.source,
        input.sourceRef,
        revision,
        revisionNo,
        input.readAt,
        now,
      );
      return rateCardFromRow(db.prepare("SELECT * FROM rate_cards WHERE id = ?").get(id) as DbRow);
    });
  }

  // ---------------------------------------------------------------- budgets

  async listBudgets(projectId: ProjectId): Promise<StoredBudget[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM budgets WHERE project_id = ? ORDER BY scope")
        .all(projectId) as DbRow[];
      return rows.map(budgetFromRow);
    });
  }

  async putBudget(input: {
    projectId: ProjectId;
    scope: BudgetScope;
    limitPico: number;
    warnPico: number | null;
    enabled: boolean;
    timeZone: string;
    expectedRevision?: number;
  }): Promise<StoredBudget> {
    if (input.limitPico <= 0) {
      throw new StateError("INVALID_INPUT", "a budget limit must be greater than zero");
    }
    if (input.warnPico !== null && (input.warnPico <= 0 || input.warnPico > input.limitPico)) {
      throw new StateError(
        "INVALID_INPUT",
        "a warning threshold must be above zero and at or below the limit",
      );
    }
    return this.write((db, now) => {
      const current = db
        .prepare("SELECT * FROM budgets WHERE project_id = ? AND scope = ?")
        .get(input.projectId, input.scope) as DbRow | undefined;
      if (current) {
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== asNumber(current.revision)
        ) {
          throw new StateError("CONFLICT", "the budget changed since it was read", {
            expected: input.expectedRevision,
            actual: asNumber(current.revision),
          });
        }
        db.prepare(
          "UPDATE budgets SET limit_pico = ?, warn_pico = ?, enabled = ?, time_zone = ?, " +
            "updated_at = ?, revision = revision + 1 WHERE id = ?",
        ).run(
          input.limitPico,
          input.warnPico,
          input.enabled ? 1 : 0,
          input.timeZone,
          now,
          asString(current.id),
        );
        return budgetFromRow(
          db.prepare("SELECT * FROM budgets WHERE id = ?").get(asString(current.id)) as DbRow,
        );
      }
      const id = this.id("bdg");
      db.prepare(
        "INSERT INTO budgets (id, project_id, scope, limit_pico, warn_pico, enabled, time_zone, " +
          "created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
      ).run(
        id,
        input.projectId,
        input.scope,
        input.limitPico,
        input.warnPico,
        input.enabled ? 1 : 0,
        input.timeZone,
        now,
        now,
      );
      return budgetFromRow(db.prepare("SELECT * FROM budgets WHERE id = ?").get(id) as DbRow);
    });
  }

  async clearBudget(input: {
    projectId: ProjectId;
    budgetId: string;
    expectedRevision?: number;
  }): Promise<{ cleared: boolean }> {
    return this.write((db) => {
      const row = db
        .prepare("SELECT * FROM budgets WHERE id = ? AND project_id = ?")
        .get(input.budgetId, input.projectId) as DbRow | undefined;
      if (!row) return { cleared: false };
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== asNumber(row.revision)
      ) {
        throw new StateError("CONFLICT", "the budget changed since it was read", {
          expected: input.expectedRevision,
          actual: asNumber(row.revision),
        });
      }
      db.prepare("DELETE FROM budgets WHERE id = ?").run(input.budgetId);
      return { cleared: true };
    });
  }

  async countActiveTaskRuns(projectId: ProjectId): Promise<number> {
    return this.read((db) => {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_runs WHERE project_id = ? AND state = 'running'",
        )
        .get(projectId) as DbRow;
      return asNumber(row.count);
    });
  }

  // ------------------------------------------------------------- capability

  async saveCapabilitySnapshot(input: {
    engineVersion: string;
    engineCommit: string;
    payload: unknown;
  }): Promise<{ id: string; digest: string; capturedAt: string }> {
    const actual = createHash("sha256").update(canonicalJson(input.payload)).digest("hex");
    return this.write((db, now) => {
      const id = this.id("cap");
      db.prepare(
        "INSERT INTO capability_snapshots (id, engine_version, engine_commit, digest, payload_json, captured_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.engineVersion,
        input.engineCommit,
        actual,
        JSON.stringify(input.payload),
        now,
      );
      return { id, digest: actual, capturedAt: now };
    });
  }

  async latestCapabilitySnapshot(): Promise<{
    engineVersion: string;
    engineCommit: string;
    digest: string;
    payload: unknown;
    capturedAt: string;
  } | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT * FROM capability_snapshots ORDER BY captured_at DESC, rowid DESC LIMIT 1")
        .get() as DbRow | undefined;
      if (!row) return null;
      return {
        engineVersion: asString(row.engine_version),
        engineCommit: asString(row.engine_commit),
        digest: asString(row.digest),
        payload: JSON.parse(asString(row.payload_json)),
        capturedAt: asString(row.captured_at),
      };
    });
  }

  // --------------------------------------------------------------- settings

  private validateScope(scope: string): string {
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(scope)) {
      throw new StateError("CONFLICT", "settings scope has invalid characters", { scope });
    }
    return scope;
  }

  async putSettings(scope: string, value: unknown): Promise<StoredSettings> {
    const validScope = this.validateScope(scope);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new StateError("CONFLICT", "settings value is not serializable");
    }
    return this.write((db, now) => {
      const current = db.prepare("SELECT version FROM settings WHERE scope = ?").get(validScope) as
        { version: number } | undefined;
      const version = Number(current?.version ?? 0) + 1;
      db.prepare(
        "INSERT INTO settings_versions (scope, version, value_json, recorded_at) VALUES (?, ?, ?, ?)",
      ).run(validScope, version, serialized, now);
      db.prepare(
        "INSERT INTO settings (scope, version, value_json, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(scope) DO UPDATE SET version = excluded.version, value_json = excluded.value_json, " +
          "updated_at = excluded.updated_at",
      ).run(validScope, version, serialized, now);
      return { scope: validScope, version, value, updatedAt: now };
    });
  }

  async getSettings(scope: string): Promise<StoredSettings | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM settings WHERE scope = ?").get(scope) as
        DbRow | undefined;
      if (!row) return null;
      return {
        scope: asString(row.scope),
        version: asNumber(row.version),
        value: JSON.parse(asString(row.value_json)),
        updatedAt: asString(row.updated_at),
      };
    });
  }

  async listSettingsVersions(
    scope: string,
  ): Promise<Array<{ version: number; value: unknown; recordedAt: string }>> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM settings_versions WHERE scope = ? ORDER BY version")
        .all(scope) as DbRow[];
      return rows.map((row) => ({
        version: asNumber(row.version),
        value: JSON.parse(asString(row.value_json)),
        recordedAt: asString(row.recorded_at),
      }));
    });
  }

  // ----------------------------------------------------------------- drafts

  async putDraft(projectId: ProjectId, threadId: string, text: string): Promise<void> {
    await this.write((db, now) => {
      db.prepare(
        "INSERT INTO drafts (project_id, thread_id, text, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(project_id, thread_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
      ).run(projectId, threadId, text, now);
    });
  }

  async getDraft(projectId: ProjectId, threadId: string): Promise<string | null> {
    return this.read((db) => {
      const row = db
        .prepare("SELECT text FROM drafts WHERE project_id = ? AND thread_id = ?")
        .get(projectId, threadId) as { text: string } | undefined;
      return row ? String(row.text) : null;
    });
  }

  async deleteDraft(projectId: ProjectId, threadId: string): Promise<void> {
    await this.write((db) => {
      db.prepare("DELETE FROM drafts WHERE project_id = ? AND thread_id = ?").run(
        projectId,
        threadId,
      );
    });
  }

  // --------------------------------------------------- changes and receipts

  /**
   * Upsert one turn's change projection. Evidence never regresses: a later
   * `turn.completed` without files cannot overwrite a settled artifact receipt,
   * and a newer settled route read replaces an older event projection.
   */
  async upsertChangeSet(input: {
    projectId: ProjectId;
    threadId: string;
    engineThreadId: string;
    turnId: string;
    taskId?: string | null;
    state: StoredChangeState;
    reason?: string | null;
    preSnapshotId?: string | null;
    postSnapshotId?: string | null;
    origin: StoredChangeOrigin;
    evidenceRank: number;
    truncated?: boolean;
    omitted?: number | null;
    note?: string | null;
    files: StoredChangeFile[];
  }): Promise<{ id: string; updated: boolean }> {
    this.assertOpen();
    if (!Number.isInteger(input.evidenceRank) || input.evidenceRank < 0) {
      throw new StateError("CONFLICT", "evidence rank must be a non-negative integer");
    }
    return this.write((db, now) => {
      const existing = db
        .prepare("SELECT * FROM change_sets WHERE thread_id = ? AND turn_id = ?")
        .get(input.threadId, input.turnId) as DbRow | undefined;
      if (existing && Number(existing.evidence_rank) > input.evidenceRank) {
        return { id: asString(existing.id), updated: false };
      }
      if (existing && input.files.length === 0) {
        // A capture that names no files never erases a receipt that has them.
        // Otherwise a late or empty read would turn a settled delta into "no
        // delta", and every restore entry point along with it.
        const counted = db
          .prepare("SELECT COUNT(*) AS n FROM change_files WHERE change_set_id = ?")
          .get(asString(existing.id)) as { n: number };
        if (Number(counted.n) > 0) {
          return { id: asString(existing.id), updated: false };
        }
      }
      const id = existing ? asString(existing.id) : this.id("chg");
      const truncated = input.truncated === true ? 1 : 0;
      if (existing) {
        db.prepare(
          "UPDATE change_sets SET state = ?, reason = ?, pre_snapshot_id = ?, post_snapshot_id = ?, " +
            "origin = ?, evidence_rank = ?, truncated = ?, omitted = ?, note = ?, captured_at = ?, " +
            "updated_at = ? WHERE id = ?",
        ).run(
          input.state,
          input.reason ?? null,
          input.preSnapshotId ?? null,
          input.postSnapshotId ?? null,
          input.origin,
          input.evidenceRank,
          truncated,
          input.omitted ?? null,
          input.note ?? null,
          now,
          now,
          id,
        );
        db.prepare("DELETE FROM change_files WHERE change_set_id = ?").run(id);
      } else {
        db.prepare(
          "INSERT INTO change_sets (id, project_id, thread_id, engine_thread_id, turn_id, task_id, " +
            "state, reason, pre_snapshot_id, post_snapshot_id, origin, evidence_rank, truncated, " +
            "omitted, note, captured_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          input.projectId,
          input.threadId,
          input.engineThreadId,
          input.turnId,
          input.taskId ?? null,
          input.state,
          input.reason ?? null,
          input.preSnapshotId ?? null,
          input.postSnapshotId ?? null,
          input.origin,
          input.evidenceRank,
          truncated,
          input.omitted ?? null,
          input.note ?? null,
          now,
          now,
        );
      }
      const insert = db.prepare(
        "INSERT INTO change_files (change_set_id, ordinal, artifact_id, path, previous_path, kind, " +
          "change, source, tool_name, tool_call_id, item_id, size_bytes, revision, " +
          "restore_snapshot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      input.files.forEach((file, index) => {
        insert.run(
          id,
          index,
          file.artifactId,
          file.path,
          file.previousPath,
          file.kind,
          file.change,
          file.source,
          file.toolName,
          file.toolCallId,
          file.itemId,
          file.sizeBytes,
          file.revision,
          file.restoreSnapshotId,
        );
      });
      return { id, updated: true };
    });
  }

  async readChangeSets(projectId: ProjectId, limit = 20): Promise<StoredChangeSet[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 50);
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT * FROM change_sets WHERE project_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT ?",
        )
        .all(projectId, bounded) as DbRow[];
      const statement = db.prepare(
        "SELECT * FROM change_files WHERE change_set_id = ? ORDER BY ordinal",
      );
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        threadId: asString(row.thread_id),
        engineThreadId: asString(row.engine_thread_id),
        turnId: asString(row.turn_id),
        taskId: asNullableString(row.task_id),
        state: asString(row.state) as StoredChangeState,
        reason: asNullableString(row.reason),
        preSnapshotId: asNullableString(row.pre_snapshot_id),
        postSnapshotId: asNullableString(row.post_snapshot_id),
        origin: asString(row.origin) as StoredChangeOrigin,
        evidenceRank: asNumber(row.evidence_rank),
        truncated: Number(row.truncated) === 1,
        omitted: asNumberOrNull(row.omitted),
        note: asNullableString(row.note),
        capturedAt: asString(row.captured_at),
        files: (statement.all(asString(row.id)) as DbRow[]).map((file) => ({
          artifactId: asNullableString(file.artifact_id),
          path: asString(file.path),
          previousPath: asNullableString(file.previous_path),
          kind: asString(file.kind) as StoredChangeFile["kind"],
          change: asString(file.change) as StoredChangeFile["change"],
          source: asString(file.source) as StoredChangeFile["source"],
          toolName: asNullableString(file.tool_name),
          toolCallId: asNullableString(file.tool_call_id),
          itemId: asNullableString(file.item_id),
          sizeBytes: asNumberOrNull(file.size_bytes),
          revision: asNullableString(file.revision),
          restoreSnapshotId: asNullableString(file.restore_snapshot_id),
        })),
      }));
    });
  }

  async getChangeSet(id: string): Promise<StoredChangeSet | null> {
    return this.read((db) => {
      const row = db.prepare("SELECT * FROM change_sets WHERE id = ?").get(id) as DbRow | undefined;
      if (!row) return null;
      const files = db
        .prepare("SELECT * FROM change_files WHERE change_set_id = ? ORDER BY ordinal")
        .all(id) as DbRow[];
      return {
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        threadId: asString(row.thread_id),
        engineThreadId: asString(row.engine_thread_id),
        turnId: asString(row.turn_id),
        taskId: asNullableString(row.task_id),
        state: asString(row.state) as StoredChangeState,
        reason: asNullableString(row.reason),
        preSnapshotId: asNullableString(row.pre_snapshot_id),
        postSnapshotId: asNullableString(row.post_snapshot_id),
        origin: asString(row.origin) as StoredChangeOrigin,
        evidenceRank: asNumber(row.evidence_rank),
        truncated: Number(row.truncated) === 1,
        omitted: asNumberOrNull(row.omitted),
        note: asNullableString(row.note),
        capturedAt: asString(row.captured_at),
        files: files.map((file) => ({
          artifactId: asNullableString(file.artifact_id),
          path: asString(file.path),
          previousPath: asNullableString(file.previous_path),
          kind: asString(file.kind) as StoredChangeFile["kind"],
          change: asString(file.change) as StoredChangeFile["change"],
          source: asString(file.source) as StoredChangeFile["source"],
          toolName: asNullableString(file.tool_name),
          toolCallId: asNullableString(file.tool_call_id),
          itemId: asNullableString(file.item_id),
          sizeBytes: asNumberOrNull(file.size_bytes),
          revision: asNullableString(file.revision),
          restoreSnapshotId: asNullableString(file.restore_snapshot_id),
        })),
      };
    });
  }

  async recordRestore(input: {
    id: string;
    projectId: ProjectId;
    changeSetId: string | null;
    threadId: string;
    turnId: string;
    path: string;
    action: string;
    snapshotId: string;
    snapshotLabel?: string | null;
    expectedHash: string;
    beforeRevision: string | null;
    afterRevision: string | null;
    outcome: "restored" | "failed";
    note?: string | null;
  }): Promise<StoredRestoreReceipt> {
    return this.write((db, now) => {
      db.prepare(
        "INSERT INTO restore_receipts (id, project_id, change_set_id, thread_id, turn_id, path, " +
          "action, snapshot_id, snapshot_label, expected_hash, before_revision, after_revision, " +
          "outcome, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.id,
        input.projectId,
        input.changeSetId,
        input.threadId,
        input.turnId,
        input.path,
        input.action,
        input.snapshotId,
        input.snapshotLabel ?? null,
        input.expectedHash,
        input.beforeRevision,
        input.afterRevision,
        input.outcome,
        input.note ?? null,
        now,
      );
      return {
        id: input.id,
        projectId: input.projectId,
        changeSetId: input.changeSetId,
        threadId: input.threadId,
        turnId: input.turnId,
        path: input.path,
        action: input.action,
        snapshotId: input.snapshotId,
        snapshotLabel: input.snapshotLabel ?? null,
        expectedHash: input.expectedHash,
        beforeRevision: input.beforeRevision,
        afterRevision: input.afterRevision,
        outcome: input.outcome,
        note: input.note ?? null,
        createdAt: now,
      };
    });
  }

  async listRestoreReceipts(projectId: ProjectId, limit = 50): Promise<StoredRestoreReceipt[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 200);
    return this.read((db) => {
      const rows = db
        .prepare(
          "SELECT * FROM restore_receipts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(projectId, bounded) as DbRow[];
      return rows.map((row) => ({
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        changeSetId: asNullableString(row.change_set_id),
        threadId: asString(row.thread_id),
        turnId: asString(row.turn_id),
        path: asString(row.path),
        action: asString(row.action),
        snapshotId: asString(row.snapshot_id),
        snapshotLabel: asNullableString(row.snapshot_label),
        expectedHash: asString(row.expected_hash),
        beforeRevision: asNullableString(row.before_revision),
        afterRevision: asNullableString(row.after_revision),
        outcome: asString(row.outcome) as StoredRestoreReceipt["outcome"],
        note: asNullableString(row.note),
        createdAt: asString(row.created_at),
      }));
    });
  }

  async recordCommit(input: {
    id: string;
    projectId: ProjectId;
    commitHash: string;
    shortHash: string;
    subject: string;
    paths: string[];
    message: string;
    note?: string | null;
  }): Promise<StoredCommitReceipt> {
    return this.write((db, now) => {
      db.prepare(
        "INSERT INTO commit_receipts (id, project_id, commit_hash, short_hash, subject, " +
          "paths_json, message, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.id,
        input.projectId,
        input.commitHash,
        input.shortHash,
        input.subject,
        JSON.stringify(input.paths),
        input.message,
        input.note ?? null,
        now,
      );
      return {
        id: input.id,
        projectId: input.projectId,
        commitHash: input.commitHash,
        shortHash: input.shortHash,
        subject: input.subject,
        paths: input.paths,
        message: input.message,
        note: input.note ?? null,
        createdAt: now,
      };
    });
  }

  async latestCommit(projectId: ProjectId): Promise<StoredCommitReceipt | null> {
    return this.read((db) => {
      const row = db
        .prepare(
          "SELECT * FROM commit_receipts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(projectId) as DbRow | undefined;
      if (!row) return null;
      let paths: string[] = [];
      try {
        const parsed = JSON.parse(asString(row.paths_json));
        if (Array.isArray(parsed)) paths = parsed.filter((value) => typeof value === "string");
      } catch {
        paths = [];
      }
      return {
        id: asString(row.id),
        projectId: asString(row.project_id) as ProjectId,
        commitHash: asString(row.commit_hash),
        shortHash: asString(row.short_hash),
        subject: asString(row.subject),
        paths,
        message: asString(row.message),
        note: asNullableString(row.note),
        createdAt: asString(row.created_at),
      };
    });
  }

  // -------------------------------------------------------------- artifacts

  async putArtifact(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    data: Buffer;
    mediaType: string;
    source: string;
    retentionClass: ArtifactRecord["retentionClass"];
  }): Promise<ArtifactRecord> {
    this.assertOpen();
    if (input.data.length > this.maxArtifactBytes) {
      throw new StateError("ARTIFACT_TOO_LARGE", "artifact exceeds the configured maximum", {
        size: input.data.length,
        max: this.maxArtifactBytes,
      });
    }
    return this.barrier.run("write", async () => {
      this.assertHeadroom();
      const used = this.usedArtifactBytes(input.projectId);
      if (used + input.data.length > this.projectQuotaBytes) {
        throw new StateError("QUOTA_EXCEEDED", "project artifact quota is exhausted", {
          used,
          requested: input.data.length,
          quota: this.projectQuotaBytes,
        });
      }
      const written: WrittenArtifact = this.artifactFiles.write({
        projectId: input.projectId,
        data: input.data,
        mediaType: input.mediaType,
      });
      try {
        return withTransaction(this.db, () => {
          const id = this.id("att");
          const now = this.now();
          this.db
            .prepare(
              "INSERT INTO artifacts (id, project_id, task_id, digest, rel_path, size_bytes, media_type, " +
                "source, retention_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              id,
              input.projectId,
              input.taskId ?? null,
              written.digest,
              written.relPath,
              written.sizeBytes,
              input.mediaType,
              input.source,
              input.retentionClass,
              now,
            );
          this.bumpRevision(this.db);
          return {
            id,
            projectId: input.projectId,
            taskId: input.taskId ?? null,
            digest: written.digest,
            relPath: written.relPath,
            sizeBytes: written.sizeBytes,
            mediaType: input.mediaType,
            source: input.source,
            retentionClass: input.retentionClass,
            createdAt: now,
          };
        });
      } catch (error) {
        // The metadata did not commit, so the fresh file is an orphan; remove
        // it now rather than leaving an unclaimed artifact behind.
        this.artifactFiles.remove(written.relPath);
        throw error;
      }
    });
  }

  private usedArtifactBytes(projectId: ProjectId): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS used FROM artifacts WHERE project_id = ?")
      .get(projectId) as { used: number };
    return Number(row.used);
  }

  async listArtifacts(projectId: ProjectId): Promise<ArtifactRecord[]> {
    return this.read((db) => {
      const rows = db
        .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[];
      return rows.map(artifactFromRow);
    });
  }

  async readArtifact(id: string): Promise<{ artifact: ArtifactRecord; data: Buffer }> {
    const artifact = await this.read((db) => {
      const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as DbRow | undefined;
      return row ? artifactFromRow(row) : null;
    });
    if (!artifact) throw new StateError("NOT_FOUND", `artifact ${id} does not exist`);
    const data = this.artifactFiles.read(artifact.relPath, { verifyDigest: true });
    return { artifact, data };
  }

  async planRetention(policy: RetentionPolicy = {}): Promise<RetentionPlan> {
    const now = policy.now ?? this.options.now();
    const temporaryDays = policy.temporaryDays ?? 7;
    const diagnosticDays = policy.diagnosticDays ?? 30;
    return this.read((db) => {
      const rows = db.prepare("SELECT * FROM artifacts").all() as DbRow[];
      const artifacts = rows.map(artifactFromRow);
      const candidates: ArtifactRecord[] = [];
      const protectedArtifacts: Array<{ artifact: ArtifactRecord; reason: string }> = [];
      const warnings: string[] = [];
      for (const artifact of artifacts) {
        if (artifact.retentionClass === "evidence") {
          // Evidence-class artifacts never expire automatically. Removing one
          // requires an explicit policy with a recorded warning.
          protectedArtifacts.push({ artifact, reason: "retention class is evidence" });
          warnings.push(`retained ${artifact.id}: retention class is evidence`);
          continue;
        }
        const ageDays = (now.getTime() - Date.parse(artifact.createdAt)) / 86_400_000;
        const limit = artifact.retentionClass === "temporary" ? temporaryDays : diagnosticDays;
        if (ageDays < limit) continue;

        const evidenceRef = db
          .prepare("SELECT id FROM requirement_evidence WHERE digest = ? OR path = ? LIMIT 1")
          .get(artifact.digest, artifact.relPath) as { id: string } | undefined;
        const blockedTask =
          artifact.taskId === null
            ? undefined
            : (db.prepare("SELECT status FROM tasks WHERE id = ?").get(artifact.taskId) as
                { status: string } | undefined);
        let reason: string | null = null;
        if (evidenceRef) reason = "referenced by requirement evidence";
        else if (
          blockedTask &&
          (blockedTask.status === "blocked" || blockedTask.status === "interrupted")
        ) {
          reason = `task is ${blockedTask.status}`;
        }
        if (reason) {
          protectedArtifacts.push({ artifact, reason });
          warnings.push(`retained ${artifact.id}: ${reason}`);
        } else {
          candidates.push(artifact);
        }
      }
      return { candidates, protected: protectedArtifacts, warnings };
    });
  }

  async pruneArtifacts(policy: RetentionPolicy = {}): Promise<RetentionResult> {
    const plan = await this.planRetention(policy);
    const includeProtected = policy.includeProtected ?? false;
    const toDelete = includeProtected
      ? [...plan.candidates, ...plan.protected.map((entry) => entry.artifact)]
      : [...plan.candidates];
    const warnings = [...plan.warnings];
    if (includeProtected && plan.protected.length > 0) {
      warnings.push(
        `explicit policy deleted ${plan.protected.length} protected artifact(s); review the reason list before relying on the evidence`,
      );
    }
    if (toDelete.length === 0) {
      return { deleted: [], protected: plan.protected, freedBytes: 0, warnings };
    }
    const freed = await this.barrier.run("write", () => {
      this.assertHeadroom();
      const ids = toDelete.map((artifact) => artifact.id);
      const placeholders = ids.map(() => "?").join(",");
      return withTransaction(this.db, () => {
        this.db.prepare(`DELETE FROM artifacts WHERE id IN (${placeholders})`).run(...ids);
        this.bumpRevision(this.db);
        return toDelete.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
      });
    });
    for (const artifact of toDelete) {
      if (!this.artifactFiles.remove(artifact.relPath)) {
        warnings.push(`metadata removed but file was already gone: ${artifact.relPath}`);
      }
    }
    return { deleted: toDelete, protected: plan.protected, freedBytes: freed, warnings };
  }

  async sweepOrphanArtifacts(options: { minAgeMs?: number } = {}): Promise<string[]> {
    const referenced = new Set(
      (await this.read((db) => db.prepare("SELECT rel_path FROM artifacts").all() as DbRow[])).map(
        (row) => asString(row.rel_path),
      ),
    );
    return this.artifactFiles.sweepOrphans(referenced, options);
  }

  // --------------------------------------------------------------- portable

  private collectPayload(db: DatabaseSync, projectId: ProjectId): PortablePayload {
    const project = projectFromRow(this.requireProjectRow(db, projectId));
    const paths = (
      db
        .prepare("SELECT * FROM project_paths WHERE project_id = ? ORDER BY recorded_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      path: asString(row.path),
      canonicalPath: asString(row.canonical_path),
      active: Number(row.active) === 1,
      recordedAt: asString(row.recorded_at),
    }));
    const tasks = (
      db
        .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => {
      const task = taskFromRow(row);
      return {
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        status: task.status,
        executionOwner: task.executionOwner,
        requirements: task.requirements,
        nextStep: task.nextStep,
        verificationFingerprint: task.verificationFingerprint,
        verificationStale: task.verificationStale,
        staleReason: task.staleReason,
        completedAt: task.completedAt,
        importedFrom: task.importedFrom,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        revision: task.revision,
      };
    });
    const acceptance = (
      db
        .prepare(
          `SELECT a.* FROM task_acceptance a JOIN tasks t ON t.id = a.task_id
            WHERE t.project_id = ? ORDER BY a.task_id, a.ordinal`,
        )
        .all(projectId) as DbRow[]
    ).map((row) => criterionFromRow(row));
    const steps = (
      db
        .prepare(
          `SELECT s.* FROM task_steps s JOIN tasks t ON t.id = s.task_id
            WHERE t.project_id = ? ORDER BY s.task_id, s.ordinal`,
        )
        .all(projectId) as DbRow[]
    ).map((row) => stepFromRow(row));
    const dependencies = (
      db
        .prepare(
          `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
           JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
        )
        .all(projectId) as Array<{ task_id: string; depends_on_task_id: string }>
    ).map((row) => ({
      taskId: row.task_id as TaskId,
      dependsOnTaskId: row.depends_on_task_id as TaskId,
    }));
    const evidence = (
      db
        .prepare("SELECT * FROM requirement_evidence WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: asString(row.id),
      taskId: asNullableString(row.task_id) as TaskId | null,
      requirementId: asString(row.requirement_id),
      path: asString(row.path),
      digest: asNullableString(row.digest),
      note: asNullableString(row.note),
      createdAt: asString(row.created_at),
    }));
    const attemptRows = db
      .prepare("SELECT * FROM attempts WHERE project_id = ? ORDER BY created_at")
      .all(projectId) as DbRow[];
    const attempts = attemptRows.map((row) => ({
      id: asString(row.id),
      taskId: asNullableString(row.task_id) as TaskId | null,
      problemId: asString(row.problem_id),
      requirement: asString(row.requirement),
      symptom: asNullableString(row.symptom),
      hypothesis: asString(row.hypothesis),
      action: asString(row.action),
      observed: asString(row.observed),
      materialProgress: Number(row.material_progress) === 1,
      evidence: JSON.parse(asString(row.evidence_json) || "[]") as string[],
      createdAt: asString(row.created_at),
    }));
    const decisions = (
      db
        .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: asString(row.id),
      title: asString(row.title),
      body: asString(row.body),
      createdAt: asString(row.created_at),
    }));
    const threadRows = db
      .prepare("SELECT * FROM threads WHERE project_id = ? ORDER BY created_at")
      .all(projectId) as DbRow[];
    const threads = threadRows.map((row) => ({
      id: asString(row.id),
      engineThreadId: asNullableString(row.engine_thread_id),
      title: asNullableString(row.title),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    }));
    const threadIds = threads.map((thread) => thread.id);
    const placeholders = threadIds.map(() => "?").join(",");
    const turns =
      threadIds.length === 0
        ? []
        : (
            db
              .prepare(
                `SELECT * FROM turns WHERE thread_id IN (${placeholders}) ORDER BY started_at`,
              )
              .all(...threadIds) as DbRow[]
          ).map((row) => ({
            id: asString(row.id),
            threadId: asString(row.thread_id),
            status: asString(row.status),
            provider: asNullableString(row.provider),
            model: asNullableString(row.model),
            permissionPosture: asNullableString(row.permission_posture),
            startedAt: asString(row.started_at),
            endedAt: asNullableString(row.ended_at),
          }));
    const usage = (
      db
        .prepare("SELECT * FROM usage_records WHERE project_id = ? ORDER BY captured_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      id: asString(row.id),
      threadId: asNullableString(row.thread_id),
      turnId: asNullableString(row.turn_id),
      provider: asString(row.provider),
      model: asString(row.model),
      inputTokens: asNumberOrNull(row.input_tokens),
      outputTokens: asNumberOrNull(row.output_tokens),
      cachedTokens: asNumberOrNull(row.cached_tokens),
      reasoningTokens: asNumberOrNull(row.reasoning_tokens),
      costUsd: asNumberOrNull(row.cost_usd),
      costComplete: Number(row.cost_complete) === 1,
      capturedAt: asString(row.captured_at),
      cacheMissTokens: asNumberOrNull(row.cache_miss_tokens),
      costPicoUsd: asNumberOrNull(row.cost_pico_usd),
      costState: asString(row.cost_state) as UsageRecord["costState"],
      costAllocation: asString(row.cost_allocation) as UsageRecord["costAllocation"],
      pricingReadAt: asNullableString(row.pricing_read_at),
      tokenSemantics: asString(row.token_semantics) as UsageRecord["tokenSemantics"],
      note: asNullableString(row.note),
    }));
    const drafts = (
      db
        .prepare("SELECT * FROM drafts WHERE project_id = ? ORDER BY updated_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      threadId: asString(row.thread_id),
      text: asString(row.text),
      updatedAt: asString(row.updated_at),
    }));
    const settings = (
      db
        .prepare(
          "SELECT * FROM settings WHERE scope = ? OR scope = ? OR scope LIKE ? ESCAPE '\\' ORDER BY scope",
        )
        .all(
          `project:${projectId}`,
          `view:${projectId}`,
          `project:${escapeLike(String(projectId))}:%`,
        ) as DbRow[]
    ).map((row) => ({
      scope: asString(row.scope),
      version: asNumber(row.version),
      value: JSON.parse(asString(row.value_json)),
      updatedAt: asString(row.updated_at),
    }));
    const artifacts = (
      db
        .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as DbRow[]
    ).map((row) => {
      const artifact = artifactFromRow(row);
      return {
        id: artifact.id,
        taskId: artifact.taskId,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        sizeBytes: artifact.sizeBytes,
        source: artifact.source,
        retentionClass: artifact.retentionClass,
        createdAt: artifact.createdAt,
      };
    });
    const submissions = (
      db
        .prepare("SELECT * FROM submissions WHERE project_id = ? ORDER BY submitted_at")
        .all(projectId) as DbRow[]
    ).map((row) => ({
      operationKey: asString(row.operation_key),
      threadId: asString(row.thread_id),
      turnId: asNullableString(row.turn_id),
      status: asString(row.status) as SubmissionStatus,
      submittedAt: asString(row.submitted_at),
      reconciled: Number(row.reconciled) === 1,
      note: asNullableString(row.note),
    }));

    return {
      project: {
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        canonicalPath: project.canonicalPath,
        repositoryKind: project.repositoryKind,
        repositoryRoot: project.repositoryRoot,
        worktreeName: project.worktreeName,
        accent: project.accent,
        monogram: project.monogram,
        archived: project.archived,
        pinned: project.pinned,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        revision: project.revision,
      },
      paths,
      tasks,
      acceptance,
      steps,
      dependencies,
      evidence,
      attempts,
      decisions,
      threads,
      turns,
      usage,
      drafts,
      settings,
      artifacts,
      submissions,
    };
  }

  async exportProject(projectId: ProjectId): Promise<ProjectBundle> {
    return this.read((db) => buildBundle(this.collectPayload(db, projectId), this.options.now()));
  }

  async exportProjectToFile(
    projectId: ProjectId,
    destination: string,
  ): Promise<{ digest: string; bundle: ProjectBundle }> {
    const bundle = await this.exportProject(projectId);
    writeFileDurable(destination, bundleToFileText(bundle));
    return { digest: bundle.digest, bundle };
  }

  async importProject(value: unknown, options: ImportOptions = {}): Promise<ImportResult> {
    const { bundle, problems } = verifyBundle(value);
    if (!bundle) {
      const digestProblem = problems.some((problem) => problem.path === "digest");
      throw new StateError(
        digestProblem ? "IMPORT_DIGEST_MISMATCH" : "IMPORT_INVALID",
        digestProblem
          ? "imported project digest does not match its contents"
          : "imported project is invalid",
        { problems: problems.slice(0, 20) },
      );
    }
    const payload = bundle.payload;
    const identity = identifyPath(options.rootPath ?? payload.project.rootPath);
    const mode = options.mode ?? "create";
    const missingArtifacts: string[] = [];
    return this.write((db, now) => {
      const existing = this.findProjectRow(db, payload.project.id);
      const owner = this.findProjectByIdentity(db, identity);
      if (owner && String(owner.id) !== String(payload.project.id)) {
        throw new StateError(
          "ALIAS_CONFLICT",
          "the imported folder already belongs to another project",
          {
            project_id: owner.id,
          },
        );
      }
      if (existing && mode !== "replace") {
        throw new StateError("CONFLICT", "project already exists; import needs replace mode", {
          project_id: payload.project.id,
          revision: Number(existing.revision),
        });
      }
      if (existing) {
        const actual = Number(existing.revision);
        if (options.expectedRevision !== undefined && options.expectedRevision !== actual) {
          throw new StateError(
            "IMPORT_REVISION_CONFLICT",
            "project changed since import was requested",
            {
              expected_revision: options.expectedRevision,
              actual_revision: actual,
            },
          );
        }
        if (payload.project.revision < actual) {
          throw new StateError(
            "IMPORT_REVISION_CONFLICT",
            "imported state is older than the local project",
            {
              imported_revision: payload.project.revision,
              local_revision: actual,
            },
          );
        }
        this.deleteProjectContents(db, payload.project.id);
      }

      const revision = existing ? Number(existing.revision) + 1 : payload.project.revision;
      if (existing) {
        db.prepare(
          "UPDATE projects SET name = ?, root_path = ?, canonical_path = ?, fs_dev = ?, fs_ino = ?, " +
            "repository_kind = ?, repository_root = ?, worktree_name = ?, accent = ?, monogram = ?, " +
            "archived = ?, pinned = ?, removed_at = NULL, updated_at = ?, revision = ? WHERE id = ?",
        ).run(
          payload.project.name,
          options.rootPath ?? payload.project.rootPath,
          identity.canonical,
          identity.dev,
          identity.ino,
          identity.repository.kind,
          identity.repository.root,
          identity.repository.worktreeName,
          payload.project.accent,
          payload.project.monogram,
          payload.project.archived ? 1 : 0,
          payload.project.pinned ? 1 : 0,
          now,
          revision,
          payload.project.id,
        );
      } else {
        db.prepare(
          "INSERT INTO projects (id, name, root_path, canonical_path, fs_dev, fs_ino, repository_kind, " +
            "repository_root, worktree_name, accent, monogram, archived, pinned, removed_at, created_at, " +
            "updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        ).run(
          payload.project.id,
          payload.project.name,
          options.rootPath ?? payload.project.rootPath,
          identity.canonical,
          identity.dev,
          identity.ino,
          identity.repository.kind,
          identity.repository.root,
          identity.repository.worktreeName,
          payload.project.accent,
          payload.project.monogram,
          payload.project.archived ? 1 : 0,
          payload.project.pinned ? 1 : 0,
          payload.project.createdAt,
          now,
          revision,
        );
      }
      this.insertActivePath(db, payload.project.id, identity, now);
      for (const path of payload.paths) {
        if (path.active) continue;
        db.prepare(
          "INSERT OR IGNORE INTO project_paths (project_id, path, canonical_path, fs_dev, fs_ino, active, recorded_at) " +
            "VALUES (?, ?, ?, 0, 0, 0, ?)",
        ).run(payload.project.id, path.path, path.canonicalPath, path.recordedAt);
      }

      for (const thread of payload.threads) {
        db.prepare(
          "INSERT INTO threads (id, project_id, engine_thread_id, title, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          thread.id,
          payload.project.id,
          thread.engineThreadId,
          thread.title,
          thread.createdAt,
          thread.updatedAt,
        );
      }
      for (const task of payload.tasks) {
        const status =
          task.status === "paused" || task.status === "failed" || task.status === "running"
            ? "interrupted"
            : task.status;
        db.prepare(
          "INSERT INTO tasks (id, project_id, title, prompt, status, execution_owner, requirements_json, " +
            "next_step, verification_fingerprint, verification_stale, stale_reason, completed_at, " +
            "imported_from, created_at, updated_at, revision) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          task.id,
          payload.project.id,
          task.title,
          task.prompt,
          status,
          task.executionOwner ?? "mona_queue",
          JSON.stringify(task.requirements ?? []),
          task.nextStep ?? null,
          task.verificationFingerprint ?? null,
          task.verificationStale ? 1 : 0,
          task.staleReason ?? null,
          task.completedAt ?? null,
          task.importedFrom ?? null,
          task.createdAt,
          task.updatedAt,
          task.revision,
        );
      }
      for (const criterion of payload.acceptance ?? []) {
        db.prepare(
          "INSERT INTO task_acceptance (id, task_id, ordinal, text, kind, satisfied, satisfied_by, " +
            "evidence_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          criterion.id,
          criterion.taskId,
          criterion.ordinal,
          criterion.text,
          criterion.kind,
          criterion.satisfied ? 1 : 0,
          criterion.satisfiedBy,
          criterion.evidencePath,
          criterion.updatedAt,
        );
      }
      for (const step of payload.steps ?? []) {
        db.prepare(
          "INSERT INTO task_steps (id, task_id, ordinal, label, state, evidence_path, recorded_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          step.id,
          step.taskId,
          step.ordinal,
          step.label,
          step.state,
          step.evidencePath,
          step.recordedAt,
          step.updatedAt,
        );
      }
      for (const dependency of payload.dependencies) {
        db.prepare(
          "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
        ).run(dependency.taskId, dependency.dependsOnTaskId, now);
      }
      for (const evidence of payload.evidence) {
        db.prepare(
          "INSERT INTO requirement_evidence (id, project_id, task_id, requirement_id, path, digest, note, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          evidence.id,
          payload.project.id,
          evidence.taskId,
          evidence.requirementId,
          evidence.path,
          evidence.digest,
          evidence.note,
          evidence.createdAt,
        );
      }
      for (const attempt of payload.attempts) {
        db.prepare(
          "INSERT INTO attempts (id, project_id, task_id, problem_id, requirement, symptom, hypothesis, " +
            "action, observed, material_progress, evidence_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          attempt.id,
          payload.project.id,
          attempt.taskId,
          attempt.problemId,
          attempt.requirement,
          attempt.symptom,
          attempt.hypothesis,
          attempt.action,
          attempt.observed,
          attempt.materialProgress ? 1 : 0,
          JSON.stringify(attempt.evidence),
          attempt.createdAt,
        );
      }
      for (const decision of payload.decisions) {
        db.prepare(
          "INSERT INTO decisions (id, project_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(decision.id, payload.project.id, decision.title, decision.body, decision.createdAt);
      }
      for (const turn of payload.turns) {
        db.prepare(
          "INSERT INTO turns (id, thread_id, status, provider, model, permission_posture, started_at, ended_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          turn.id,
          turn.threadId,
          turn.status,
          turn.provider,
          turn.model,
          turn.permissionPosture,
          turn.startedAt,
          turn.endedAt,
        );
      }
      for (const usage of payload.usage) {
        const costPico =
          usage.costPicoUsd ??
          (usage.costUsd === null ? null : Math.round(usage.costUsd * 1_000_000_000_000));
        const costState = usage.costState ?? (usage.costComplete ? "reported" : "unknown_price");
        db.prepare(
          "INSERT INTO usage_records (id, project_id, thread_id, turn_id, provider, model, " +
            "input_tokens, output_tokens, cached_tokens, cache_miss_tokens, reasoning_tokens, " +
            "cost_usd, cost_pico_usd, cost_complete, cost_state, cost_allocation, " +
            "pricing_read_at, token_semantics, note, captured_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          usage.id,
          payload.project.id,
          usage.threadId,
          usage.turnId,
          usage.provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedTokens,
          usage.cacheMissTokens ?? null,
          usage.reasoningTokens,
          costPico === null ? null : costPico / 1_000_000_000_000,
          costPico,
          costState === "reported" || costState === "estimated" ? 1 : 0,
          costState,
          usage.costAllocation ?? "turn",
          usage.pricingReadAt ?? null,
          usage.tokenSemantics ?? "inclusive_input",
          usage.note ?? null,
          usage.capturedAt,
        );
      }
      for (const draft of payload.drafts) {
        db.prepare(
          "INSERT INTO drafts (project_id, thread_id, text, updated_at) VALUES (?, ?, ?, ?)",
        ).run(payload.project.id, draft.threadId, draft.text, draft.updatedAt);
      }
      for (const setting of payload.settings) {
        db.prepare(
          "INSERT INTO settings (scope, version, value_json, updated_at) VALUES (?, ?, ?, ?)",
        ).run(setting.scope, setting.version, JSON.stringify(setting.value), setting.updatedAt);
        db.prepare(
          "INSERT INTO settings_versions (scope, version, value_json, recorded_at) VALUES (?, ?, ?, ?)",
        ).run(setting.scope, setting.version, JSON.stringify(setting.value), setting.updatedAt);
      }
      for (const artifact of payload.artifacts) {
        const relPath = this.artifactFiles.find(artifact.digest);
        if (!relPath) {
          missingArtifacts.push(artifact.digest);
          continue;
        }
        db.prepare(
          "INSERT INTO artifacts (id, project_id, task_id, digest, rel_path, size_bytes, media_type, " +
            "source, retention_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          artifact.id,
          payload.project.id,
          artifact.taskId,
          artifact.digest,
          relPath,
          artifact.sizeBytes,
          artifact.mediaType,
          artifact.source,
          artifact.retentionClass,
          artifact.createdAt,
        );
      }
      for (const submission of payload.submissions) {
        db.prepare(
          "INSERT INTO submissions (operation_key, project_id, thread_id, turn_id, status, submitted_at, " +
            "reconciled, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          submission.operationKey,
          payload.project.id,
          submission.threadId,
          submission.turnId,
          submission.status,
          submission.submittedAt,
          submission.reconciled ? 1 : 0,
          submission.note,
        );
      }

      return {
        project: projectFromRow(this.requireProjectRow(db, payload.project.id)),
        mode: existing ? "replace" : "create",
        imported: {
          tasks: payload.tasks.length,
          dependencies: payload.dependencies.length,
          evidence: payload.evidence.length,
          attempts: payload.attempts.length,
          decisions: payload.decisions.length,
          threads: payload.threads.length,
          turns: payload.turns.length,
          drafts: payload.drafts.length,
          settings: payload.settings.length,
          submissions: payload.submissions.length,
        },
        missingArtifacts,
      };
    });
  }

  private deleteProjectContents(db: DatabaseSync, projectId: string): void {
    db.prepare("DELETE FROM submissions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM artifacts WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM drafts WHERE project_id = ?").run(projectId);
    db.prepare(
      "DELETE FROM settings_versions WHERE scope = ? OR scope = ? OR scope LIKE ? ESCAPE '\\'",
    ).run(`project:${projectId}`, `view:${projectId}`, `project:${escapeLike(projectId)}:%`);
    db.prepare("DELETE FROM settings WHERE scope = ? OR scope = ? OR scope LIKE ? ESCAPE '\\'").run(
      `project:${projectId}`,
      `view:${projectId}`,
      `project:${escapeLike(projectId)}:%`,
    );
    db.prepare("DELETE FROM attempts WHERE project_id = ?").run(projectId);
    // Problems must go before tasks: a task delete sets problems.task_id NULL,
    // which would orphan an active ledger row and could collide on the taskless
    // fingerprint index. A replace import starts from a clean ledger.
    db.prepare("DELETE FROM problem_events WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM problems WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM requirement_evidence WHERE project_id = ?").run(projectId);
    db.prepare(
      "DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)",
    ).run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM decisions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM usage_records WHERE project_id = ?").run(projectId);
    db.prepare(
      "DELETE FROM cost_thread_marks WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)",
    ).run(projectId);
    db.prepare(
      "DELETE FROM turns WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)",
    ).run(projectId);
    db.prepare("DELETE FROM threads WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_paths WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM runtime_bindings WHERE project_id = ?").run(projectId);
  }

  // ---------------------------------------------------------- backup/restore

  async backupTo(destination: string): Promise<{ destination: string; integrity: string[] }> {
    this.assertOpen();
    return this.barrier.runMaintenance(async () => {
      await backupDatabase(this.db, destination);
      const snapshot = openDatabase({ path: destination, readonly: true });
      try {
        const report = checkIntegrity(snapshot);
        if (!report.ok) {
          throw new StateError("MIGRATION_FAILED", "backup snapshot failed validation", {
            problems: report.problems,
          });
        }
        return { destination, integrity: report.problems };
      } finally {
        snapshot.close();
      }
    });
  }

  async createSnapshot(label = "manual"): Promise<string> {
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "snapshot";
    const destination = join(
      this.options.backupDir,
      `snapshot-${safeLabel}-${this.now().replace(/[:.]/g, "-")}.sqlite`,
    );
    await this.backupTo(destination);
    return destination;
  }

  /**
   * Restore under the maintenance barrier. The current database is moved aside
   * as evidence, the snapshot is copied into place and validated, and the
   * pre-restore copy is put back if validation fails. Writers cannot slip in:
   * the barrier is exclusive for the whole operation.
   */
  async restoreFrom(
    source: string,
  ): Promise<{ restored: boolean; journal: string; preRestore: string }> {
    this.assertOpen();
    return this.barrier.runMaintenance(async () => {
      const stamp = this.now().replace(/[:.]/g, "-");
      const journalPath = join(this.options.backupDir, `restore-journal-${stamp}.json`);
      const preRestore = `${this.options.dbPath}.pre-restore-${stamp}`;
      const journal = {
        schema_version: 1,
        action: "restore",
        source,
        db_path: this.options.dbPath,
        state: "started",
        started_at: this.now(),
        updated_at: this.now(),
        pre_restore_path: preRestore,
        error: null as string | null,
      };
      writeJsonDurable(journalPath, journal);

      this.db.close();
      try {
        // Preserve the current database and its WAL sidecars.
        for (const suffix of ["", "-wal", "-shm"]) {
          const from = `${this.options.dbPath}${suffix}`;
          if (existsSync(from)) renameSync(from, `${preRestore}${suffix}`);
        }
        copyFileSync(source, this.options.dbPath);
        secureFile(this.options.dbPath);
        const outcome = await migrateDatabase({
          dbPath: this.options.dbPath,
          backupDir: this.options.backupDir,
          now: this.options.now,
        });
        this.db = outcome.db;
        assertIntegrity(this.db, "restored database");
        journal.state = "complete";
        journal.updated_at = this.now();
        writeJsonDurable(journalPath, journal);
        return { restored: true, journal: journalPath, preRestore };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        journal.state = "failed";
        journal.error = message;
        journal.updated_at = this.now();
        writeJsonDurable(journalPath, journal);
        // Put the pre-restore database back so a failed restore does not cost
        // the user their verified state.
        try {
          for (const suffix of ["", "-wal", "-shm"]) {
            const target = `${this.options.dbPath}${suffix}`;
            if (existsSync(target)) renameSync(target, `${target}.failed-restore-${stamp}`);
          }
          copyFileSync(preRestore, this.options.dbPath);
          secureFile(this.options.dbPath);
          this.db = openDatabase({ path: this.options.dbPath });
          assertIntegrity(this.db, "pre-restore database");
        } catch (restoreError) {
          journal.error = `${message}; rollback failed: ${
            restoreError instanceof Error ? restoreError.message : String(restoreError)
          }`;
          writeJsonDurable(journalPath, journal);
          throw new StateError("MAINTENANCE_FAILED", "restore failed and rollback failed", {
            journal_path: journalPath,
            pre_restore_path: preRestore,
            cause: journal.error,
          });
        }
        throw new StateError(
          "MAINTENANCE_FAILED",
          "restore failed; previous database was put back",
          {
            journal_path: journalPath,
            pre_restore_path: preRestore,
            cause: message,
          },
        );
      }
    });
  }

  // -------------------------------------------------------------- lifecycle

  async stats(): Promise<{
    projects: number;
    tasks: number;
    events: number;
    artifacts: number;
    settings: number;
    stateRevision: number;
    integrity: string[];
  }> {
    return this.read((db) => {
      const count = (table: string): number => {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        return Number(row.n);
      };
      const revisionRow = db
        .prepare("SELECT value_json FROM meta WHERE key = 'state_revision'")
        .get() as { value_json: string } | undefined;
      return {
        projects: count("projects"),
        tasks: count("tasks"),
        events: count("events"),
        artifacts: count("artifacts"),
        settings: count("settings"),
        stateRevision: revisionRow ? Number(revisionRow.value_json) : 0,
        integrity: checkIntegrity(db).problems,
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.barrier.runMaintenance(() => {
      if (this.closed) return;
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // A checkpoint failure is not a reason to leak the handle.
      }
      this.db.close();
      this.closed = true;
    });
  }
}
