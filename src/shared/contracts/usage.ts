import { z } from "zod";
import { Timestamp } from "./ids";

const TokenCount = z.number().int().nonnegative().nullable();

/**
 * Usage evidence is explicit about provenance. A missing cost is `unknown`,
 * never zero; a locally derived number is `estimated`, never "reported".
 */
export const UsageEvidence = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cachedTokens: TokenCount,
  reasoningTokens: TokenCount,
  costUsd: z.number().nonnegative().nullable(),
  costState: z.enum(["reported", "estimated", "unknown"]),
  source: z.enum(["engine_usage", "engine_receipt", "session_metadata", "fixture"]),
  capturedAt: Timestamp,
});
export type UsageEvidence = z.infer<typeof UsageEvidence>;

export const ErrorResult = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  message: z.string().min(1).max(4000),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorResult = z.infer<typeof ErrorResult>;

export function unknownUsage(provider: string, model: string): UsageEvidence {
  return {
    provider,
    model,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    costState: "unknown",
    source: "fixture",
    capturedAt: new Date(0).toISOString(),
  };
}
