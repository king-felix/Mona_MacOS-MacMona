import { z } from "zod";
import { ProjectId, TaskId } from "./ids";
import type { TaskState } from "./board";

/**
 * Project memory, prompt shelf, portable handoff, and diagnostics.
 *
 * Everything on this surface is local and deterministic. Search ranks stored
 * records; it never embeds, never calls a model, and never copies a repository
 * into a database. A handoff carries Mona-owned records and file pointers, not
 * engine sessions, credentials, environment dumps, or source.
 *
 * Two limits are stated in the types rather than in prose: `exactProviderRequest`
 * is always `false` (Mona cannot inspect the engine's assembled request), and
 * every import result is inert (nothing starts work).
 */

// ------------------------------------------------------------------- search

export const MEMORY_SOURCES = [
  "task",
  "decision",
  "evidence",
  "attempt",
  "problem",
  "prompt",
  "thread",
  "artifact",
] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_SOURCE_LABELS: Record<MemorySource, string> = {
  task: "Tasks",
  decision: "Decisions",
  evidence: "Evidence",
  attempt: "Attempts",
  problem: "Problems",
  prompt: "Prompt shelf",
  thread: "Threads",
  artifact: "Artifact metadata",
};

export interface MemoryPointer {
  kind: MemorySource;
  /** The record this hit names, so a screen can open the real thing. */
  recordId: string;
  /** A workspace-relative path when the record points at one. */
  path: string | null;
}

export interface MemoryHit {
  id: string;
  source: MemorySource;
  title: string;
  /** One bounded line around the first match, with secrets already redacted. */
  snippet: string;
  score: number;
  matchedTerms: string[];
  /** How many times the record body matched; a hint, never a relevance claim. */
  occurrences: number;
  redactions: number;
  updatedAt: string;
  pointer: MemoryPointer;
}

export interface MemorySourceCount {
  source: MemorySource;
  records: number;
  redactions: number;
  /** False when the store has no records of this kind for the project. */
  present: boolean;
}

export interface MemorySearchResult {
  projectId: string;
  query: string;
  terms: string[];
  hits: MemoryHit[];
  total: number;
  truncated: boolean;
  considered: number;
  sources: MemorySourceCount[];
  /** Search is a read over records; nothing about it is persisted. */
  persisted: false;
  redactions: number;
  durationMs: number;
  note: string;
}

export interface MemoryIndexStatus {
  projectId: string;
  generatedAt: string;
  /** Digest of the indexed record set, so two runs can be compared. */
  digest: string;
  counts: MemorySourceCount[];
  totalRecords: number;
  totalRedactions: number;
  stateRevision: number;
  repositoryContents: "on_demand";
  credentialsIndexed: false;
  embeddings: false;
  excluded: Array<{ what: string; why: string }>;
  retention: { note: string; evidenceProtected: boolean };
  note: string;
}

export interface WorkspaceSearchHit {
  path: string;
  line: number;
  text: string;
  truncated: boolean;
}

export interface WorkspaceSearchResult {
  projectId: string;
  query: string;
  hits: WorkspaceSearchHit[];
  filesScanned: number;
  filesSkipped: number;
  bytesScanned: number;
  truncated: boolean;
  skippedReasons: Array<{ reason: string; count: number }>;
  /** Scope is stated every time: this is a bounded read, not an index. */
  scope: string;
  persisted: false;
  note: string;
}

export const MemorySearchRequestSchema = z.strictObject({
  projectId: ProjectId,
  query: z.string().trim().min(1).max(200),
  sources: z.array(z.enum(MEMORY_SOURCES)).max(8).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const WorkspaceSearchRequestSchema = z.strictObject({
  projectId: ProjectId,
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(200).optional(),
});

// -------------------------------------------------------- context + resume

/**
 * Context slots are Mona-side choices about what Mona would submit. They are
 * not a view of the provider request: the engine assembles that, and 0.10.2
 * exposes no request inspection.
 */
export const CONTEXT_SLOTS = [
  "prompt",
  "acceptance",
  "requirements",
  "decisions",
  "evidence_pointers",
  "prior_attempts",
  "resume_packet",
] as const;
export type ContextSlot = (typeof CONTEXT_SLOTS)[number];

export const CONTEXT_SLOT_LABELS: Record<ContextSlot, string> = {
  prompt: "Task prompt",
  acceptance: "Acceptance criteria",
  requirements: "Requirement ids",
  decisions: "Project decisions",
  evidence_pointers: "Evidence pointers",
  prior_attempts: "Prior attempts",
  resume_packet: "Resume packet",
};

export interface ContextSlotView {
  slot: ContextSlot;
  label: string;
  available: boolean;
  included: boolean;
  items: number;
  bytes: number;
  note: string;
}

export interface ContextSelectionPreview {
  projectId: string;
  taskId: TaskId;
  /** The exact text Mona would submit with this selection. */
  text: string;
  bytes: number;
  slots: ContextSlotView[];
  included: ContextSlot[];
  /** Context that is deliberately never assembled by Mona. */
  excluded: string[];
  truncated: boolean;
  redactions: number;
  exactProviderRequest: false;
  providerRequestNote: string;
  note: string;
}

export const ContextSelectionRequestSchema = z.strictObject({
  projectId: ProjectId,
  taskId: TaskId,
  include: z.array(z.enum(CONTEXT_SLOTS)).max(7),
});

export interface ResumePointer {
  kind: "task" | "decision" | "evidence" | "attempt" | "file";
  label: string;
  value: string;
  available: boolean;
  note: string | null;
}

export interface ResumePacket {
  projectId: string;
  projectName: string;
  generatedAt: string;
  /** A concise, human-readable packet assembled from stored records only. */
  text: string;
  bytes: number;
  pointers: ResumePointer[];
  excluded: string[];
  stateRevision: number;
  /** Mona cannot show the provider request; the packet is Mona's own text. */
  exactProviderRequest: false;
  engineInspection: "unavailable";
  note: string;
}

// ------------------------------------------------------------ prompt shelf

export const ShelfVariableSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  description: z.string().max(200),
  required: z.boolean(),
  sample: z.string().max(200),
});
export type ShelfVariable = z.infer<typeof ShelfVariableSchema>;

export interface ShelfVersion {
  version: number;
  body: string;
  digest: string;
  note: string | null;
  createdAt: string;
  variables: string[];
  acceptance: string[];
}

export interface ShelfPrompt {
  id: string;
  label: string;
  description: string;
  currentVersion: number;
  versions: ShelfVersion[];
  variables: ShelfVariable[];
  acceptance: string[];
  tags: string[];
  updatedAt: string;
  /** True when at least one stored version had secret-shaped text redacted. */
  redacted: boolean;
}

export interface PromptShelfView {
  prompts: ShelfPrompt[];
  storage: { scope: string; version: number };
  limits: { prompts: number; versionsPerPrompt: number; bodyBytes: number };
  note: string;
}

export interface ShelfSaveRequest {
  id?: string;
  label: string;
  description?: string;
  body: string;
  note?: string;
  acceptance?: string[];
  tags?: string[];
}

export interface PromptRenderRequest {
  promptId: string;
  version?: number;
  values: Record<string, string>;
}

export interface PromptRenderResult {
  promptId: string;
  version: number;
  text: string;
  bytes: number;
  /** Declared variables the caller did not supply. */
  missing: string[];
  /** Supplied names that are not placeholders in this version. */
  unknown: string[];
  acceptance: string[];
  /** Rendering is text substitution only; nothing is evaluated or executed. */
  inert: true;
}

export interface PromptPackPrompt {
  label: string;
  description: string;
  body: string;
  acceptance: string[];
  tags: string[];
  variables: ShelfVariable[];
}

export interface PromptPack {
  format: "mona-prompt-pack";
  format_version: 1;
  name: string;
  exported_at: string;
  digest_algorithm: "sha256";
  digest: string;
  prompts: PromptPackPrompt[];
}

export interface PromptImportResult {
  packName: string;
  created: Array<{ label: string; promptId: string }>;
  skipped: Array<{ label: string; reason: string }>;
  redactions: number;
  /** Import stores text; it does not run, send, or insert anything. */
  inert: true;
}

export const ShelfSaveRequestSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,63}$/)
    .optional(),
  label: z.string().trim().min(1).max(80),
  description: z.string().max(400).optional(),
  body: z.string().min(1).max(20_000),
  note: z.string().max(400).optional(),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  tags: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/))
    .max(8)
    .optional(),
});

export const PromptRenderRequestSchema = z.strictObject({
  promptId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  version: z.number().int().min(1).optional(),
  values: z.record(z.string().max(64), z.string().max(8_000)),
});

export const PromptRemoveRequestSchema = z.strictObject({
  promptId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
});

export const PromptExportRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  promptIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/))
    .max(50)
    .optional(),
});

// --------------------------------------------------------------- handoff

export interface HandoffEntry {
  path: string;
  digest: string;
  sizeBytes: number;
  kind: "manifest" | "project" | "readme" | "decisions" | "prompts" | "pointer" | "other";
}

export interface ArtifactDigestCheck {
  artifactId: string;
  digest: string;
  relPath: string;
  present: boolean;
  matches: boolean;
  note: string;
}

export interface HandoffPreview {
  projectId: string;
  projectName: string;
  generatedAt: string;
  entries: HandoffEntry[];
  totalBytes: number;
  counts: {
    tasks: number;
    decisions: number;
    evidence: number;
    attempts: number;
    prompts: number;
    pointers: number;
  };
  redactions: number;
  artifactChecks: ArtifactDigestCheck[];
  excluded: Array<{ what: string; why: string }>;
  canExport: boolean;
  projectRevision: number;
  note: string;
}

export interface RequalificationView {
  required: boolean;
  reasons: string[];
  /**
   * The local engine identity Mona knows. `checked` means a recorded identity
   * exists, not that a probe just ran: this surface starts no process, so the
   * value comes from the last capability snapshot and carries its capture time.
   */
  localEngine: {
    version: string | null;
    commit: string | null;
    checked: boolean;
    observedAt: string | null;
  };
  source: "capability_snapshot" | "none";
  machineBinding: "requalified" | "unavailable";
  note: string;
}

export interface HandoffInspection {
  path: string;
  ok: boolean;
  problems: string[];
  manifest: { format: string; format_version: number; digest: string; created_at: string } | null;
  project: {
    id: string;
    name: string;
    rootPath: string;
    revision: number;
    tasks: number;
    decisions: number;
    evidence: number;
    attempts: number;
  } | null;
  missingLocalFiles: Array<{ path: string; requirement: string }>;
  staleDigests: Array<{ path: string; expected: string; actual: string | null }>;
  artifactChecks: ArtifactDigestCheck[];
  requalification: RequalificationView;
  /** What this bundle cannot carry, stated in the bundle and in the view. */
  cannotTransfer: string[];
  bytes: number;
}

export interface HandoffImportResult {
  projectId: string;
  projectName: string;
  mode: "create" | "replace";
  imported: {
    tasks: number;
    decisions: number;
    evidence: number;
    attempts: number;
    acceptance: number;
    steps: number;
  };
  missingLocalFiles: Array<{ path: string; requirement: string }>;
  staleDigests: Array<{ path: string; expected: string; actual: string | null }>;
  requalification: RequalificationView;
  /** Import creates records. It never dispatches a task or starts an engine. */
  startedWork: false;
  redactions: number;
  problems: string[];
}

export const HandoffExportRequestSchema = z.strictObject({
  projectId: z.string().min(1),
});

export const HandoffInspectRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096).startsWith("/"),
});

export const HandoffImportRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096).startsWith("/"),
  rootPath: z.string().min(1).max(4096).startsWith("/").optional(),
  mode: z.enum(["create", "replace"]).optional(),
  expectedRevision: z.number().int().min(1).optional(),
});

// ------------------------------------------------------ settings backup

export interface SettingsBackupScope {
  scope: string;
  version: number;
  digest: string;
  sizeBytes: number;
  included: boolean;
  reason: string | null;
}

export interface SettingsBackupView {
  generatedAt: string;
  scopes: SettingsBackupScope[];
  excluded: Array<{ scope: string; why: string }>;
  digest: string;
  text: string;
  stateRevision: number;
  note: string;
}

export interface SettingsBackupInspection {
  path: string;
  ok: boolean;
  problems: string[];
  scopes: Array<{
    scope: string;
    version: number;
    digest: string;
    localVersion: number | null;
    action: "create" | "update" | "noop" | "downgrade";
  }>;
  digest: string;
  bytes: number;
}

export interface SettingsRestoreRequest {
  path: string;
  mode: "merge" | "replace";
  scopes?: string[];
  expectedRevision?: number;
  /** A destructive scope list needs an explicit acknowledgement. */
  confirm?: boolean;
}

export interface SettingsRestoreResult {
  restored: boolean;
  applied: Array<{ scope: string; fromVersion: number | null; toVersion: number }>;
  /** Scopes cleared by a `replace` restore; their version history is retained. */
  reset: string[];
  skipped: Array<{ scope: string; reason: string }>;
  barrier: "exclusive";
  journal: string;
  snapshot: string;
  verification: string;
  stateRevision: number;
}

export const SettingsBackupRequestSchema = z.strictObject({});
export const SettingsBackupInspectSchema = z.strictObject({
  path: z.string().min(1).max(4096).startsWith("/"),
});
export const SettingsRestoreRequestSchema = z.strictObject({
  path: z.string().min(1).max(4096).startsWith("/"),
  mode: z.enum(["merge", "replace"]),
  scopes: z
    .array(z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/))
    .max(200)
    .optional(),
  expectedRevision: z.number().int().min(1).optional(),
  confirm: z.boolean().optional(),
});

// ------------------------------------------------------------ diagnostics

export interface DiagnosticsEntry {
  name: string;
  sizeBytes: number;
  digest: string;
  redactions: number;
}

export interface DiagnosticsPreview {
  generatedAt: string;
  entries: DiagnosticsEntry[];
  /** The exact text that would be written; already redacted. */
  text: string;
  bytes: number;
  digest: string;
  redactions: number;
  excluded: string[];
  environmentIncluded: false;
  credentialsIncluded: false;
  note: string;
}

export interface DiagnosticsExportResult {
  saved: boolean;
  path: string | null;
  digest: string;
  bytes: number;
  redactions: number;
}

export const DiagnosticsPreviewRequestSchema = z.strictObject({
  projectId: ProjectId.nullable().optional(),
});

// ---------------------------------------------------------- plan transfer

/**
 * A plan is a description of intended work. It carries status for a human
 * reader, but import never converts a recorded status into an unearned
 * completion; the deferred status is reported instead.
 */
export const PlanStatusSchema = z.enum([
  "pending",
  "running",
  "verifying",
  "completed",
  "blocked",
  "interrupted",
  "skipped",
]);

export interface PlanStatusDeferral {
  key: string;
  from: TaskState;
  to: TaskState;
  reason: string;
}
