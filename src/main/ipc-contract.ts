import { z } from "zod";
import { ProjectId, TaskId } from "../shared/contracts/ids";
import {
  FavoriteInputSchema,
  POLISH_ACCENTS,
  PolishPreferencesPatchSchema,
} from "../shared/contracts/polish";
import {
  AgentRunCancelSchema,
  FleetEvidenceRequestSchema,
  FleetLaunchSchema,
  FleetRunControlSchema,
  FleetWorkerControlSchema,
  GoalBlockSchema,
  GoalSetSchema,
  GoalThreadSchema,
} from "../shared/contracts/agents";

/**
 * Narrow IPC contract. Every invoke is a strict object: unknown fields are
 * rejection, not tolerance. A new capability is a deliberate schema change.
 */
export const IpcRequests = {
  "app:info": z.strictObject({}),
  "app:paths": z.strictObject({}),
  "tools:discover": z.strictObject({
    names: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/))
      .max(16)
      .optional(),
  }),
  "projects:list": z.strictObject({
    query: z.string().trim().max(200).optional(),
    includeArchived: z.boolean().optional(),
  }),
  // Every externally supplied folder enters here. Sources are enumerated so a
  // caller cannot claim an origin it does not have.
  "open:folder": z.strictObject({
    path: z.string().min(1).max(8192),
    source: z.enum(["drop"]),
  }),
  "open:status": z.strictObject({}),
  "service:status": z.strictObject({}),
  "service:refresh": z.strictObject({}),
  "service:open-settings": z.strictObject({}),
  "projects:open": z.strictObject({
    rootPath: z.string().min(1).max(4096).startsWith("/").optional(),
  }),
  "projects:detail": z.strictObject({ projectId: ProjectId }),
  "projects:rename": z.strictObject({
    projectId: ProjectId,
    name: z.string().min(1).max(200),
    expectedRevision: z.number().int().min(1),
  }),
  "projects:pin": z.strictObject({
    projectId: ProjectId,
    pinned: z.boolean(),
    expectedRevision: z.number().int().min(1),
  }),
  "projects:archive": z.strictObject({
    projectId: ProjectId,
    archived: z.boolean(),
    expectedRevision: z.number().int().min(1),
  }),
  "projects:remove": z.strictObject({
    projectId: ProjectId,
    expectedRevision: z.number().int().min(1),
  }),
  "projects:relocate": z.strictObject({
    projectId: ProjectId,
    expectedRevision: z.number().int().min(1),
  }),
  "projects:reveal": z.strictObject({ projectId: ProjectId }),
  "projects:view": z.strictObject({
    projectId: ProjectId,
    view: z.record(z.string().max(64), z.unknown()),
  }),
  "projects:draft": z.strictObject({
    projectId: ProjectId,
    threadId: z.string().min(1).max(200),
    text: z.string().max(200_000),
  }),
  "runtime:status": z.strictObject({}),
  "state:facts": z.strictObject({}),
  // Live work studio. Every call is an explicit user action; reading state and
  // rendering events never starts a runtime or spends inference.
  "studio:state": z.strictObject({ projectId: ProjectId }),
  "studio:start": z.strictObject({ projectId: ProjectId }),
  "studio:submit": z.strictObject({
    projectId: ProjectId,
    prompt: z.string().min(1).max(100_000),
    mode: z.enum(["plan", "work"]),
  }),
  "studio:interrupt": z.strictObject({ projectId: ProjectId }),
  "studio:pause": z.strictObject({ projectId: ProjectId }),
  "studio:resume-queue": z.strictObject({ projectId: ProjectId }),
  "studio:cancel-queued": z.strictObject({ projectId: ProjectId }),
  "studio:reconcile": z.strictObject({ projectId: ProjectId }),
  "studio:stop": z.strictObject({ projectId: ProjectId }),

  // Work board and durable continuation. These calls mutate Mona-owned task
  // state only; board:dispatch-next is the one call that can hand a prompt to
  // the engine, and only after explicit selection.
  "board:snapshot": z.strictObject({ projectId: ProjectId }),
  "board:create": z.strictObject({
    projectId: ProjectId,
    title: z.string().min(1).max(200),
    prompt: z.string().min(1).max(100_000),
    owner: z.enum(["mona_queue", "native_workflow"]).optional(),
    requirements: z
      .array(z.string().regex(/^(MONA|MAC)-\d{3}$/))
      .max(50)
      .optional(),
    acceptance: z
      .array(
        z.strictObject({ text: z.string().min(1).max(1000), kind: z.enum(["check", "human"]) }),
      )
      .max(50)
      .optional(),
    steps: z.array(z.string().min(1).max(500)).max(50).optional(),
    dependsOn: z.array(TaskId).max(50).optional(),
  }),
  "board:update": z.strictObject({
    taskId: TaskId,
    expectedRevision: z.number().int().min(1),
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000).optional(),
    owner: z.enum(["mona_queue", "native_workflow"]).optional(),
    requirements: z
      .array(z.string().regex(/^(MONA|MAC)-\d{3}$/))
      .max(50)
      .optional(),
    acceptance: z
      .array(
        z.strictObject({ text: z.string().min(1).max(1000), kind: z.enum(["check", "human"]) }),
      )
      .max(50)
      .optional(),
    steps: z.array(z.string().min(1).max(500)).max(50).optional(),
  }),
  "board:import": z.strictObject({ projectId: ProjectId, plan: z.unknown() }),
  "board:import-file": z.strictObject({ projectId: ProjectId }),
  "board:export": z.strictObject({ projectId: ProjectId }),
  "board:export-file": z.strictObject({ projectId: ProjectId }),
  "board:preview": z.strictObject({ taskId: TaskId }),
  "board:select": z.strictObject({
    projectId: ProjectId,
    owner: z.enum(["mona_queue", "native_workflow"]).optional(),
  }),
  "board:evidence": z.strictObject({
    projectId: ProjectId,
    taskId: TaskId,
    requirementId: z.string().regex(/^(MONA|MAC)-\d{3}$/),
    path: z.string().min(1).max(2048),
    note: z.string().max(4000).nullable().optional(),
  }),
  "board:satisfy": z.strictObject({
    taskId: TaskId,
    criterionId: z.string().min(1).max(200),
    expectedRevision: z.number().int().min(1),
    by: z.enum(["check", "human"]),
    evidencePath: z.string().min(1).max(2048).nullable().optional(),
  }),
  "board:verify": z.strictObject({
    taskId: TaskId,
    expectedRevision: z.number().int().min(1),
  }),
  "board:complete": z.strictObject({
    taskId: TaskId,
    expectedRevision: z.number().int().min(1),
  }),
  "board:start": z.strictObject({
    taskId: TaskId,
    expectedRevision: z.number().int().min(1).optional(),
  }),
  "board:resume": z.strictObject({ taskId: TaskId }),
  "board:reconcile": z.strictObject({
    projectId: ProjectId,
    resume: z.boolean().optional(),
  }),
  "board:handoff": z.strictObject({ projectId: ProjectId }),
  "board:dispatch-next": z.strictObject({ projectId: ProjectId }),

  // Problem ledger. Recording an attempt is the only call that can move the
  // three-attempt counters; acknowledgement cannot reset them.
  "board:attempt": z.strictObject({
    projectId: ProjectId,
    taskId: TaskId.nullable().optional(),
    requirement: z.string().regex(/^(MONA|MAC)-\d{3}$/),
    symptom: z.string().min(1).max(4000),
    hypothesis: z.string().min(1).max(4000),
    action: z.string().min(1).max(4000),
    observed: z.string().min(1).max(4000),
    materialProgress: z.boolean(),
    evidence: z.array(z.string().min(1).max(2048)).max(20).optional(),
    reason: z.string().max(2000).nullable().optional(),
    helpNeeded: z.string().max(4000).nullable().optional(),
    actor: z.enum(["agent", "human", "mona_queue"]).optional(),
  }),
  "board:problem-acknowledge": z.strictObject({
    problemId: z.string().min(1).max(200),
    note: z.string().max(2000).nullable().optional(),
  }),
  "board:problem-resolve": z.strictObject({
    problemId: z.string().min(1).max(200),
    resolution: z.string().min(1).max(4000),
    evidence: z.array(z.string().min(1).max(2048)).max(20).optional(),
  }),
  "board:problem-reopen": z.strictObject({
    problemId: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000),
    evidence: z.array(z.string().min(1).max(2048)).min(1).max(20),
  }),

  // Cost ledger. Every call is a local read or an explicit human edit; none can
  // start inference, and no call reads or writes a provider balance.
  "cost:ledger": z.strictObject({
    projectId: ProjectId,
    since: z.string().datetime().nullable().optional(),
    until: z.string().datetime().nullable().optional(),
    timeZone: z.string().min(1).max(64).optional(),
    format: z.enum(["view", "json", "csv"]).optional(),
  }),
  "cost:budget-set": z.strictObject({
    projectId: ProjectId,
    scope: z.enum(["session", "project", "day"]),
    limitUsd: z.number().positive().max(1_000_000),
    warnUsd: z.number().positive().max(1_000_000).nullable().optional(),
    enabled: z.boolean().optional(),
    timeZone: z.string().min(1).max(64).optional(),
    expectedRevision: z.number().int().min(1).optional(),
  }),
  "cost:budget-clear": z.strictObject({
    projectId: ProjectId,
    budgetId: z.string().min(1).max(200),
    expectedRevision: z.number().int().min(1).optional(),
  }),
  "cost:rate-set": z.strictObject({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    cacheHitPerMillion: z.number().nonnegative().max(100_000).nullable(),
    cacheMissPerMillion: z.number().nonnegative().max(100_000).nullable(),
    outputPerMillion: z.number().nonnegative().max(100_000).nullable(),
    toolCallPerMillion: z.number().nonnegative().max(100_000).nullable().optional(),
    reasoningInOutput: z.boolean().optional(),
    sourceRef: z.string().max(500).nullable().optional(),
  }),
  "cost:recalc-preview": z.strictObject({
    projectId: ProjectId,
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    cacheHitPerMillion: z.number().nonnegative().max(100_000).nullable(),
    cacheMissPerMillion: z.number().nonnegative().max(100_000).nullable(),
    outputPerMillion: z.number().nonnegative().max(100_000).nullable(),
    reasoningInOutput: z.boolean().optional(),
  }),
  "cost:export-file": z.strictObject({
    projectId: ProjectId,
    format: z.enum(["json", "csv"]),
  }),

  // Changes, Git, and restore. Reading never starts a runtime; every mutation
  // is an explicit user action and restore is gated by a fresh preview.
  "changes:snapshot": z.strictObject({
    projectId: ProjectId,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  "changes:refresh": z.strictObject({ projectId: ProjectId }),
  "changes:file": z.strictObject({
    projectId: ProjectId,
    changeSetId: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(4096),
    mode: z.enum(["text", "diff"]),
    offset: z.number().int().min(0).max(20_000_000).optional(),
    limit: z.number().int().min(1).max(262_144).optional(),
  }),
  "changes:artifact": z.strictObject({
    projectId: ProjectId,
    changeSetId: z.string().min(1).max(200),
    artifactId: z.string().min(1).max(300),
    offset: z.number().int().min(0).max(20_000_000).optional(),
    limit: z.number().int().min(1).max(262_144).optional(),
  }),
  "changes:restore-preview": z.strictObject({
    projectId: ProjectId,
    changeSetId: z.string().min(1).max(200),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  }),
  "changes:restore": z.strictObject({
    projectId: ProjectId,
    changeSetId: z.string().min(1).max(200),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
    expected: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(4096),
          expectedHash: z.string().min(1).max(100),
        }),
      )
      .min(1)
      .max(200),
    acknowledge: z.array(z.string().min(1).max(4096)).max(200).optional(),
  }),
  "changes:git-stage": z.strictObject({
    projectId: ProjectId,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  }),
  "changes:git-commit": z.strictObject({
    projectId: ProjectId,
    message: z.string().trim().min(1).max(500),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
    includeUnstaged: z.boolean().optional(),
  }),
  "changes:write-file": z.strictObject({
    projectId: ProjectId,
    path: z.string().min(1).max(4096),
    content: z.string().max(4_000_000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  "changes:reveal": z.strictObject({
    projectId: ProjectId,
    path: z.string().min(1).max(4096),
  }),

  // Daily-use polish. Everything here is a local read or an explicit user
  // preference; no channel starts a turn, calls a model, or mutates project work.
  "polish:digest": z.strictObject({ projectId: ProjectId }),
  "polish:mark-seen": z.strictObject({ projectId: ProjectId }),
  "polish:status": z.strictObject({}),
  "polish:refresh": z.strictObject({ projectId: ProjectId }),
  "polish:preferences-set": z.strictObject({ patch: PolishPreferencesPatchSchema }),
  "polish:identity": z.strictObject({
    projectId: ProjectId,
    accent: z.enum(POLISH_ACCENTS).nullable(),
    monogram: z.string().max(4).nullable(),
    expectedRevision: z.number().int().min(1),
  }),
  "polish:favorites": z.strictObject({}),
  "polish:favorite-save": FavoriteInputSchema,
  "polish:favorite-remove": z.strictObject({ id: z.string().min(1).max(80) }),
  "polish:notification-test": z.strictObject({}),
  // Quit is explicit; the existing shutdown path interrupts active work and
  // stops only the runtime Mona owns.
  "polish:quit": z.strictObject({ interrupt: z.boolean() }),

  // Native orchestration. Reads never start work; every control is explicit and
  // scoped to this project's live runtime. Fleet launch requires a task that is
  // already owned by native_workflow, so the Mona queue cannot double-dispatch.
  "agents:observatory": z.strictObject({ projectId: ProjectId }),
  "agents:fleet-detail": z.strictObject({
    projectId: ProjectId,
    runId: z.string().trim().min(1).max(200),
  }),
  "agents:fleet-evidence": FleetEvidenceRequestSchema,
  "agents:history": z.strictObject({
    projectId: ProjectId,
    limit: z.number().int().min(1).max(200).optional(),
  }),
  "agents:run-cancel": AgentRunCancelSchema,
  "agents:fleet-control": FleetRunControlSchema,
  "agents:worker-control": FleetWorkerControlSchema,
  "agents:goal-set": GoalSetSchema,
  "agents:goal-complete": GoalThreadSchema,
  "agents:goal-block": GoalBlockSchema,
  "agents:goal-clear": GoalThreadSchema,
  "agents:launch-fleet": FleetLaunchSchema,
} as const;

export type IpcChannel = keyof typeof IpcRequests;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof IpcRequests)[C]>;

export class IpcContractError extends Error {
  constructor(
    readonly code: "UNKNOWN_CHANNEL" | "MALFORMED_IPC",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "IpcContractError";
  }
}

export function isIpcChannel(value: string): value is IpcChannel {
  return Object.hasOwn(IpcRequests, value);
}

export function validateIpc(channel: string, payload: unknown): unknown {
  if (!isIpcChannel(channel)) {
    throw new IpcContractError("UNKNOWN_CHANNEL", `unknown IPC channel: ${channel}`);
  }
  const result = IpcRequests[channel].safeParse(payload);
  if (!result.success) {
    throw new IpcContractError(
      "MALFORMED_IPC",
      `malformed payload for ${channel}`,
      result.error.issues,
    );
  }
  return result.data;
}
