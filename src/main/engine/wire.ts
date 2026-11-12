import { z } from "zod";

/**
 * Wire validation for the pinned Runtime API. Fields Mona requires are
 * validated; unknown upstream fields are preserved. Conversion to Mona types
 * happens in the adapter, never in UI code.
 */

export const WireRuntimeInfo = z.looseObject({
  service: z.string().optional(),
  runtime_api_version: z.string().optional(),
  codewhale_version: z.string().min(1),
  codewhale_commit: z.string().min(1),
  bind_host: z.string().min(1),
  port: z.number().int().positive(),
  auth_required: z.boolean(),
  transports: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.boolean()),
});
export type WireRuntimeInfo = z.infer<typeof WireRuntimeInfo>;

export const WireUsage = z.looseObject({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
});
export type WireUsage = z.infer<typeof WireUsage>;

export const WireTurn = z.looseObject({
  id: z.string().min(1),
  thread_id: z.string().min(1),
  status: z.string().min(1),
  effective_provider: z.string().nullable().optional(),
  effective_model: z.string().nullable().optional(),
  permission_posture: z.string().nullable().optional(),
  usage: WireUsage.optional(),
});
export type WireTurn = z.infer<typeof WireTurn>;

export const WireThread = z.looseObject({
  id: z.string().min(1),
  workspace: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  model_provider: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  latest_turn_id: z.string().nullable().optional(),
  turns: z.array(WireTurn).optional(),
});
export type WireThread = z.infer<typeof WireThread>;

export const WireUsageResponse = z.looseObject({
  totals: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cached_tokens: z.number().optional(),
      reasoning_tokens: z.number().optional(),
      cost_usd: z.number().optional(),
      turns: z.number().optional(),
      cost_complete: z.boolean().optional(),
      unpriced_turns: z.number().optional(),
    })
    .optional(),
  buckets: z
    .array(
      z.looseObject({
        key: z.string(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cached_tokens: z.number().optional(),
        reasoning_tokens: z.number().optional(),
        cost_usd: z.number().optional(),
        cost_complete: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type WireUsageResponse = z.infer<typeof WireUsageResponse>;

export const WireInterrupt = z.looseObject({
  id: z.string().optional(),
  thread_id: z.string().optional(),
  status: z.string().optional(),
  interrupted: z.boolean().optional(),
});
