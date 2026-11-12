import { z } from "zod";
import { ProjectId } from "../shared/contracts/ids";

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
