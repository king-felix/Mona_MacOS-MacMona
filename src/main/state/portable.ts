import { createHash } from "node:crypto";
import { z } from "zod";
import { ProjectId, TaskId, Timestamp } from "../../shared/contracts/ids";
import { TaskStatus } from "../../shared/contracts/project";
import { SubmissionStatus } from "../../shared/contracts/submission";
import { StateError } from "./errors";

/**
 * Portable project state. Engine history, runtime bindings, executable paths,
 * ports, and tokens are deliberately absent: the bundle carries Mona-owned
 * records, decisions, and file pointers, not a competing transcript or a
 * machine-specific credential.
 */

const RepositoryKind = z.enum(["none", "git", "git_worktree"]);

// Pre-P10 bundles could carry `paused` or `failed`. They are still accepted as
// input and mapped to `interrupted` on import: neither state is a truthful
// completion, and the current state machine has no such edges.
const LegacyTaskStatus = z.enum(["paused", "failed"]);
const PortableTaskStatus = z.union([TaskStatus, LegacyTaskStatus]);

export const PortableProject = z.strictObject({
  id: ProjectId,
  name: z.string().min(1).max(200),
  rootPath: z.string().min(1).startsWith("/"),
  canonicalPath: z.string().min(1).startsWith("/"),
  repositoryKind: RepositoryKind,
  repositoryRoot: z.string().startsWith("/").nullable(),
  worktreeName: z.string().min(1).nullable(),
  accent: z.string().min(1).max(40).nullable(),
  monogram: z.string().min(1).max(4).nullable(),
  archived: z.boolean(),
  pinned: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  revision: z.number().int().min(1),
});

export const PortableTask = z.strictObject({
  id: TaskId,
  title: z.string().min(1).max(200),
  prompt: z.string().min(1),
  status: PortableTaskStatus,
  // Added by the P10 board. Optional so a bundle written before P10 still
  // imports: the missing fields fall back to the documented defaults rather
  // than inventing an owner or a completed state.
  executionOwner: z.enum(["mona_queue", "native_workflow"]).optional(),
  requirements: z.array(z.string().regex(/^(MONA|MAC)-\d{3}$/)).optional(),
  acceptance: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(1000),
        kind: z.enum(["check", "human"]),
      }),
    )
    .optional(),
  steps: z.array(z.string().min(1).max(500)).optional(),
  nextStep: z.string().max(500).nullable().optional(),
  verificationFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  verificationStale: z.boolean().optional(),
  staleReason: z.string().max(2000).nullable().optional(),
  completedAt: Timestamp.nullable().optional(),
  importedFrom: z.string().max(500).nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  revision: z.number().int().min(1),
});

export const PortableDependency = z.strictObject({
  taskId: TaskId,
  dependsOnTaskId: TaskId,
});

/** Acceptance criteria and recorded steps travel with the task they belong to. */
export const PortableAcceptance = z.strictObject({
  id: z.string().min(1),
  taskId: TaskId,
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1).max(1000),
  kind: z.enum(["check", "human"]),
  satisfied: z.boolean(),
  satisfiedBy: z.enum(["check", "human"]).nullable(),
  evidencePath: z.string().max(2048).nullable(),
  updatedAt: Timestamp,
});

export const PortableStep = z.strictObject({
  id: z.string().min(1),
  taskId: TaskId,
  ordinal: z.number().int().nonnegative(),
  label: z.string().min(1).max(500),
  state: z.enum(["pending", "running", "completed", "skipped"]),
  evidencePath: z.string().max(2048).nullable(),
  recordedAt: Timestamp,
  updatedAt: Timestamp,
});

export const PortableEvidence = z.strictObject({
  id: z.string().min(1),
  taskId: TaskId.nullable(),
  requirementId: z.string().regex(/^(MONA|MAC)-\d{3}$/),
  path: z.string().min(1),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  note: z.string().max(4000).nullable(),
  createdAt: Timestamp,
});

export const PortableAttempt = z.strictObject({
  id: z.string().min(1),
  taskId: TaskId.nullable(),
  problemId: z.string().min(1),
  requirement: z.string().min(1),
  symptom: z.string().nullable(),
  hypothesis: z.string().min(1),
  action: z.string().min(1),
  observed: z.string().min(1),
  materialProgress: z.boolean(),
  evidence: z.array(z.string()),
  createdAt: Timestamp,
});

export const PortableDecision = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  createdAt: Timestamp,
});

export const PortableThread = z.strictObject({
  id: z.string().min(1),
  engineThreadId: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const PortableTurn = z.strictObject({
  id: z.string().min(1),
  threadId: z.string().min(1),
  status: z.string().min(1),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  permissionPosture: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});

export const PortableUsage = z.strictObject({
  id: z.string().min(1),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  costComplete: z.boolean(),
  capturedAt: Timestamp,
  // P12 fields are optional so a pre-P12 bundle still imports. Rate-card ids
  // are deliberately not portable: they reference machine-local provenance.
  cacheMissTokens: z.number().int().nonnegative().nullable().optional(),
  costPicoUsd: z.number().int().nonnegative().nullable().optional(),
  costState: z
    .enum(["reported", "estimated", "unknown_price", "missing_usage", "unallocated"])
    .optional(),
  costAllocation: z.enum(["turn", "thread_delta", "none"]).optional(),
  pricingReadAt: Timestamp.nullable().optional(),
  tokenSemantics: z.enum(["inclusive_input", "exclusive_input", "unknown"]).optional(),
  note: z.string().max(2000).nullable().optional(),
});

export const PortableDraft = z.strictObject({
  threadId: z.string().min(1),
  text: z.string(),
  updatedAt: Timestamp,
});

export const PortableSetting = z.strictObject({
  scope: z.string().min(1),
  version: z.number().int().min(1),
  value: z.unknown(),
  updatedAt: Timestamp,
});

export const PortableArtifact = z.strictObject({
  id: z.string().min(1),
  taskId: TaskId.nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  source: z.string().min(1),
  retentionClass: z.enum(["temporary", "diagnostic", "evidence"]),
  createdAt: Timestamp,
});

export const PortablePath = z.strictObject({
  path: z.string().min(1).startsWith("/"),
  canonicalPath: z.string().min(1).startsWith("/"),
  active: z.boolean(),
  recordedAt: Timestamp,
});

export const PortableSubmission = z.strictObject({
  operationKey: z.string().min(8),
  threadId: z.string().min(1),
  turnId: z.string().nullable(),
  status: SubmissionStatus,
  submittedAt: Timestamp,
  reconciled: z.boolean(),
  note: z.string().max(2000).nullable(),
});

export const PortablePayload = z.strictObject({
  project: PortableProject,
  paths: z.array(PortablePath),
  tasks: z.array(PortableTask),
  acceptance: z.array(PortableAcceptance).optional(),
  steps: z.array(PortableStep).optional(),
  dependencies: z.array(PortableDependency),
  evidence: z.array(PortableEvidence),
  attempts: z.array(PortableAttempt),
  decisions: z.array(PortableDecision),
  threads: z.array(PortableThread),
  turns: z.array(PortableTurn),
  usage: z.array(PortableUsage),
  drafts: z.array(PortableDraft),
  settings: z.array(PortableSetting),
  artifacts: z.array(PortableArtifact),
  submissions: z.array(PortableSubmission),
});
export type PortablePayload = z.infer<typeof PortablePayload>;

export const ProjectBundle = z.strictObject({
  format: z.literal("mona-project-export"),
  format_version: z.literal(1),
  exported_at: Timestamp,
  redacted: z.literal(true),
  digest_algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  project_revision: z.number().int().min(1),
  payload: PortablePayload,
});
export type ProjectBundle = z.infer<typeof ProjectBundle>;

/**
 * Deterministic JSON: object keys sorted recursively. Two exports of the same
 * state produce the same digest regardless of insertion order.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      result[key] = canonicalize(item);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new StateError("IMPORT_INVALID", "state contains a non-finite number");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new StateError("IMPORT_INVALID", `state contains an unsupported ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestOfPayload(payload: PortablePayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function buildBundle(payload: PortablePayload, now: Date): ProjectBundle {
  const candidate = {
    format: "mona-project-export" as const,
    format_version: 1 as const,
    exported_at: now.toISOString(),
    redacted: true as const,
    digest_algorithm: "sha256" as const,
    digest: digestOfPayload(payload),
    project_revision: payload.project.revision,
    payload,
  };
  return ProjectBundle.parse(candidate);
}

export interface BundleProblem {
  path: string;
  message: string;
}

/** Structural validation plus referential integrity. Digest is checked here too. */
export function verifyBundle(value: unknown): {
  bundle: ProjectBundle | null;
  problems: BundleProblem[];
} {
  const parsed = ProjectBundle.safeParse(value);
  if (!parsed.success) {
    return {
      bundle: null,
      problems: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const bundle = parsed.data;
  const problems: BundleProblem[] = [];
  const expected = digestOfPayload(bundle.payload);
  if (expected !== bundle.digest) {
    problems.push({ path: "digest", message: "bundle digest does not match its payload" });
  }
  if (bundle.project_revision !== bundle.payload.project.revision) {
    problems.push({
      path: "project_revision",
      message: "bundle revision does not match the project",
    });
  }
  const taskIds = new Set(bundle.payload.tasks.map((task) => task.id as string));
  if (taskIds.size !== bundle.payload.tasks.length) {
    problems.push({ path: "tasks", message: "duplicate task ids" });
  }
  const threadIds = new Set(bundle.payload.threads.map((thread) => thread.id));
  if (threadIds.size !== bundle.payload.threads.length) {
    problems.push({ path: "threads", message: "duplicate thread ids" });
  }
  for (const [label, ids] of [
    ["evidence", bundle.payload.evidence.map((entry) => entry.id)],
    ["attempts", bundle.payload.attempts.map((entry) => entry.id)],
    ["decisions", bundle.payload.decisions.map((entry) => entry.id)],
    ["artifacts", bundle.payload.artifacts.map((entry) => entry.id)],
    ["submissions", bundle.payload.submissions.map((entry) => entry.operationKey)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      problems.push({ path: label, message: `duplicate ${label} ids` });
    }
  }
  const settingsScopes = bundle.payload.settings.map((setting) => setting.scope);
  if (new Set(settingsScopes).size !== settingsScopes.length) {
    problems.push({ path: "settings", message: "duplicate settings scopes" });
  }
  for (const dependency of bundle.payload.dependencies) {
    if (!taskIds.has(dependency.taskId)) {
      problems.push({ path: "dependencies", message: `unknown task ${dependency.taskId}` });
    }
    if (!taskIds.has(dependency.dependsOnTaskId)) {
      problems.push({
        path: "dependencies",
        message: `unknown prerequisite ${dependency.dependsOnTaskId}`,
      });
    }
    if (dependency.taskId === dependency.dependsOnTaskId) {
      problems.push({ path: "dependencies", message: "a task cannot depend on itself" });
    }
  }
  for (const evidence of bundle.payload.evidence) {
    if (evidence.taskId && !taskIds.has(evidence.taskId)) {
      problems.push({ path: "evidence", message: `unknown task ${evidence.taskId}` });
    }
  }
  for (const criterion of bundle.payload.acceptance ?? []) {
    if (!taskIds.has(criterion.taskId)) {
      problems.push({ path: "acceptance", message: `unknown task ${criterion.taskId}` });
    }
  }
  for (const step of bundle.payload.steps ?? []) {
    if (!taskIds.has(step.taskId)) {
      problems.push({ path: "steps", message: `unknown task ${step.taskId}` });
    }
  }
  for (const attempt of bundle.payload.attempts) {
    if (attempt.taskId && !taskIds.has(attempt.taskId)) {
      problems.push({ path: "attempts", message: `unknown task ${attempt.taskId}` });
    }
  }
  for (const artifact of bundle.payload.artifacts) {
    if (artifact.taskId && !taskIds.has(artifact.taskId)) {
      problems.push({ path: "artifacts", message: `unknown task ${artifact.taskId}` });
    }
  }
  for (const turn of bundle.payload.turns) {
    if (!threadIds.has(turn.threadId)) {
      problems.push({ path: "turns", message: `unknown thread ${turn.threadId}` });
    }
  }
  for (const draft of bundle.payload.drafts) {
    if (!threadIds.has(draft.threadId)) {
      problems.push({ path: "drafts", message: `unknown thread ${draft.threadId}` });
    }
  }
  return { bundle: problems.length === 0 ? bundle : null, problems };
}

export function bundleToFileText(bundle: ProjectBundle): string {
  return `${JSON.stringify(canonicalize(bundle), null, 2)}\n`;
}
