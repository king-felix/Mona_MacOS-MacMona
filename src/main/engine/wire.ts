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

// ------------------------------------------------- P15 orchestration reads
// These schemas validate identity and lifecycle only. Prompt text, tool output,
// and transcript bodies are deliberately not required: the observatory shows a
// bounded projection, and unknown fields are preserved but not rendered raw.

export const WireAgentRun = z.looseObject({
  spec: z
    .looseObject({
      worker_id: z.string().min(1).optional(),
      run_id: z.string().min(1).optional(),
      session_name: z.string().optional(),
      objective: z.string().optional(),
      role: z.string().nullable().optional(),
      agent_type: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      workspace: z.string().nullable().optional(),
      parent_run_id: z.string().nullable().optional(),
      parent_agent_id: z.string().nullable().optional(),
      parent_id: z.string().nullable().optional(),
      runtime_profile: z
        .looseObject({ provider: z.string().nullable().optional() })
        .nullable()
        .optional(),
    })
    .optional(),
  run_id: z.string().optional(),
  worker_id: z.string().optional(),
  parent_run_id: z.string().nullable().optional(),
  parent_agent_id: z.string().nullable().optional(),
  owner_session_id: z.string().nullable().optional(),
  runtime_origin_turn_id: z.string().nullable().optional(),
  actor_kind: z.string().nullable().optional(),
  status: z.string().min(1),
  latest_message: z.string().nullable().optional(),
  steps_taken: z.number().int().nonnegative().optional(),
  events: z.array(z.looseObject({})).optional(),
  artifacts: z.array(z.looseObject({})).optional(),
  usage: z.looseObject({ status: z.string().optional(), note: z.string().optional() }).optional(),
  verification: z
    .looseObject({ status: z.string().optional(), summary: z.string().optional() })
    .optional(),
  created_at_ms: z.number().optional(),
  updated_at_ms: z.number().optional(),
  started_at_ms: z.number().optional(),
  completed_at_ms: z.number().optional(),
});
export type WireAgentRun = z.infer<typeof WireAgentRun>;

export const WireAgentRunList = z.looseObject({
  runs: z.array(WireAgentRun).default([]),
  governor: z
    .looseObject({
      launch_slots: z.number().int().optional(),
      max_launch_slots: z.number().int().optional(),
      paused: z.boolean().optional(),
      recent_rate_limits: z.number().int().optional(),
    })
    .optional(),
});
export type WireAgentRunList = z.infer<typeof WireAgentRunList>;

export const WireThreadGoal = z.looseObject({
  thread_id: z.string().min(1),
  goal_id: z.string().nullable().optional(),
  objective: z.string(),
  status: z.string().min(1),
  tokens_used: z.number().nonnegative().optional(),
  time_used_seconds: z.number().nonnegative().optional(),
  continuation_count: z.number().int().nonnegative().optional(),
  repeated_gap_count: z.number().int().nonnegative().optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
});
export type WireThreadGoal = z.infer<typeof WireThreadGoal>;

export const WireGoalList = z.looseObject({
  goals: z.array(WireThreadGoal).default([]),
  next_cursor: z.string().optional(),
});
export type WireGoalList = z.infer<typeof WireGoalList>;

export const WireFleetWorker = z.looseObject({
  worker_id: z.string().min(1),
  status: z.string().min(1),
  run_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  objective: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  latest_heartbeat_at: z.string().nullable().optional(),
  latest_event: z
    .looseObject({
      seq: z.number().optional(),
      timestamp: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
      payload: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  artifacts: z.array(z.looseObject({})).optional(),
  last_error: z.string().nullable().optional(),
});
export type WireFleetWorker = z.infer<typeof WireFleetWorker>;

export const WireFleetWorkerList = z.looseObject({
  run_id: z.string().optional(),
  workers: z.array(WireFleetWorker).default([]),
});
export type WireFleetWorkerList = z.infer<typeof WireFleetWorkerList>;

export const WireFleetReceipt = z.looseObject({
  run_id: z.string().optional(),
  task_id: z.string().min(1),
  worker_id: z.string().nullable().optional(),
  attempt: z.number().int().optional(),
  completed_at: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  failure_kind: z.string().nullable().optional(),
  failure_class: z.string().nullable().optional(),
  retry_eligible: z.boolean().optional(),
  score: z
    .looseObject({
      value: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  artifacts: z.array(z.looseObject({})).optional(),
  saved_session_id: z.string().nullable().optional(),
  evidence_available: z.boolean().optional(),
});
export type WireFleetReceipt = z.infer<typeof WireFleetReceipt>;

export const WireFleetReceiptList = z.looseObject({
  run_id: z.string().optional(),
  receipts: z.array(WireFleetReceipt).default([]),
});
export type WireFleetReceiptList = z.infer<typeof WireFleetReceiptList>;

export const WireFleetRun = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  lifecycle_status: z.string().min(1),
  target: z.string().nullable().optional(),
  workflow: z
    .looseObject({ id: z.string().nullable().optional(), kind: z.string().nullable().optional() })
    .optional(),
  roles: z.array(z.string()).optional(),
  task_count: z.number().int().optional(),
  worker_count: z.number().int().optional(),
  tasks: z
    .array(
      z.looseObject({
        task_id: z.string().min(1),
        status: z.string(),
        leased_to: z.string().nullable().optional(),
        attempts: z.number().int().optional(),
      }),
    )
    .optional(),
  task_specs: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        name: z.string().nullable().optional(),
        worker: z.looseObject({ role: z.string().nullable().optional() }).nullable().optional(),
      }),
    )
    .optional(),
  worker_specs: z.array(z.looseObject({})).optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});
export type WireFleetRun = z.infer<typeof WireFleetRun>;

export const WireFleetRunList = z.looseObject({
  runs: z.array(WireFleetRun).default([]),
  status: z.record(z.string(), z.unknown()).optional(),
});
export type WireFleetRunList = z.infer<typeof WireFleetRunList>;

export const WireFleetRunCreate = z.looseObject({
  execution: z.string().optional(),
  run: WireFleetRun,
  warnings: z.array(z.string()).optional(),
});
export type WireFleetRunCreate = z.infer<typeof WireFleetRunCreate>;

export const WireFleetEventReplay = z.looseObject({
  run_id: z.string().optional(),
  events: z
    .array(
      z.looseObject({
        cursor: z.string().optional(),
        event: z.string().min(1),
        run_id: z.string().optional(),
        task_id: z.string().nullable().optional(),
        worker_id: z.string().nullable().optional(),
        timestamp: z.string().nullable().optional(),
        payload: z.unknown().optional(),
      }),
    )
    .default([]),
  history_truncated: z.boolean().optional(),
});
export type WireFleetEventReplay = z.infer<typeof WireFleetEventReplay>;

export const WireFleetEvidence = z.looseObject({
  run_id: z.string().optional(),
  task_id: z.string().optional(),
  path: z.string().optional(),
  checksum: z.string().nullable().optional(),
  size_bytes: z.number().optional(),
  truncated: z.boolean().optional(),
  content: z.unknown().optional(),
});
export type WireFleetEvidence = z.infer<typeof WireFleetEvidence>;
