/**
 * Upstream Codewhale Runtime API shapes, transcribed from the pinned
 * `RUNTIME_API.md` (v0.10.2). These types are deliberately not Mona contracts:
 * the adapter validates and converts them at the boundary, and no renderer
 * component may import this module.
 */

export interface WireRuntimeInfo {
  service: string;
  runtime_api_version: string;
  codewhale_version: string;
  codewhale_commit: string;
  bind_host: string;
  port: number;
  auth_required: boolean;
  transports: string[];
  capabilities: Record<string, boolean>;
}

export interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  reasoning_tokens?: number;
}

export interface WireTurn {
  id: string;
  thread_id: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled" | string;
  effective_provider?: string;
  effective_model?: string;
  permission_posture?: string;
  mode?: string;
  usage?: WireUsage;
  error?: unknown;
}

export interface WireThread {
  id: string;
  model?: string;
  model_provider?: string;
  model_provider_id?: string;
  workspace?: string;
  mode?: string;
  title?: string;
  archived?: boolean;
  latest_turn_id?: string | null;
  turns?: WireTurn[];
}

export interface WireSseEvent {
  schema_version: number;
  seq: number;
  previous_seq?: number;
  event: string;
  kind: string;
  thread_id: string;
  turn_id?: string;
  item_id?: string;
  timestamp: string;
  payload?: unknown;
  [extra: string]: unknown;
}

export interface WireUsageBucket {
  key: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cost_complete?: boolean;
  priced_turns?: number;
  unpriced_turns?: number;
  turns?: number;
}
