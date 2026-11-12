import { z } from "zod";
import { ProjectId, TaskId } from "../shared/contracts/ids";

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
