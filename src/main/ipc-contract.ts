import { z } from "zod";

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
