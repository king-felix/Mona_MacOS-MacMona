import { z } from "zod";

/**
 * Mona contracts. These are deliberately separate from the upstream wire
 * shapes in `src/shared/engine-wire`: the adapter owns that conversion.
 */

export const PermissionPosture = z.enum([
  "ask",
  "read_only",
  "workspace_write",
  "danger_full_access",
  "full_access",
  "unknown",
]);
export type PermissionPosture = z.infer<typeof PermissionPosture>;

export const RouteIdentity = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
});
export type RouteIdentity = z.infer<typeof RouteIdentity>;

export const EngineIdentity = z.strictObject({
  version: z.string().min(1),
  /** Full commit when the engine reports it; 7+ hex characters. */
  commit: z.string().regex(/^[a-f0-9]{7,40}$/),
  binaryPath: z.string().startsWith("/").optional(),
  binarySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type EngineIdentity = z.infer<typeof EngineIdentity>;

export const EngineCapabilities = z.strictObject({
  identity: EngineIdentity,
  transports: z.array(z.string().min(1)),
  capabilities: z.record(z.string(), z.boolean()),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilities>;

/**
 * Requested versus effective configuration. A user-visible "supported" or
 * "Full Access" claim requires the effective side, never the request.
 */
export const EffectiveProfile = z.strictObject({
  requested: RouteIdentity,
  effective: RouteIdentity.extend({ permissionPosture: PermissionPosture }),
  usedFallback: z.boolean(),
  source: z.enum(["configured", "requested"]),
  engine: EngineIdentity,
});
export type EffectiveProfile = z.infer<typeof EffectiveProfile>;
