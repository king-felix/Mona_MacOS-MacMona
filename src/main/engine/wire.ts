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
  /**
   * Optional because the pinned 0.10.2 build does not emit it. A later engine
   * that reports the reasoning setting it actually used is read here verbatim;
   * its absence stays "not reported", never "off".
   */
  effective_reasoning_effort: z.string().nullable().optional(),
  effective_reasoning_source: z.string().nullable().optional(),
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

// ---------------------------------------------------------------- P16 settings

export const WireProvider = z.looseObject({
  id: z.string().min(1),
  model_provider_id: z.string().nullable().optional(),
  display_name: z.string().optional(),
  default_model: z.string().nullable().optional(),
  has_model_catalog: z.boolean().optional(),
  credentialState: z.string().optional(),
  credentialSource: z.string().optional(),
  credentialWritable: z.boolean().optional(),
  credentialWritableReason: z.string().nullable().optional(),
  browserConnect: z.boolean().optional(),
});
export type WireProvider = z.infer<typeof WireProvider>;

export const WireProviderList = z.looseObject({
  current: z.string().nullable().optional(),
  current_provider_id: z.string().nullable().optional(),
  providers: z.array(WireProvider),
});
export type WireProviderList = z.infer<typeof WireProviderList>;

export const WireModel = z.looseObject({
  id: z.string().min(1),
  image_input: z.string().optional(),
  output_token_limit: z.string().optional(),
  reasoning_effort: z.string().optional(),
  reasoning_effort_levels: z.array(z.string()).optional(),
  reasoning_effort_source: z.string().nullable().optional(),
  facts: z
    .looseObject({
      effective_limits: z
        .looseObject({
          context_tokens: z.number().nullable().optional(),
          output_tokens: z.number().nullable().optional(),
        })
        .optional(),
      source: z.looseObject({ kind: z.string().optional() }).optional(),
    })
    .optional(),
});
export type WireModel = z.infer<typeof WireModel>;

export const WireModelList = z.looseObject({
  provider: z.string().min(1),
  model_provider_id: z.string().nullable().optional(),
  models: z.array(WireModel),
});
export type WireModelList = z.infer<typeof WireModelList>;

export const WireRuntimeConfig = z.looseObject({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  model_available: z.boolean().nullable().optional(),
  reasoning_effort: z.string().nullable().optional(),
  base_url: z.string().nullable().optional(),
  approval_mode: z.string().nullable().optional(),
  sandbox_mode: z.string().nullable().optional(),
  allow_shell: z.boolean().nullable().optional(),
  mcp_config_path: z.string().nullable().optional(),
  default_model: z.string().nullable().optional(),
});
export type WireRuntimeConfig = z.infer<typeof WireRuntimeConfig>;

export const WireConfigWrite = z.looseObject({
  key: z.string().min(1),
  value: z.unknown().optional(),
  message: z.string().optional(),
  persisted: z.boolean().optional(),
  requires_reload: z.boolean().optional(),
});
export type WireConfigWrite = z.infer<typeof WireConfigWrite>;

export const WireProviderSwitch = z.looseObject({
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  model_available: z.boolean().optional(),
  message: z.string().optional(),
  persisted: z.boolean().optional(),
});
export type WireProviderSwitch = z.infer<typeof WireProviderSwitch>;

export const WireProviderKeyWrite = z.looseObject({
  provider: z.string().min(1),
  stored: z.boolean().optional(),
  scope: z.string().optional(),
  backend: z.string().nullable().optional(),
  credentialState: z.string().optional(),
});
export type WireProviderKeyWrite = z.infer<typeof WireProviderKeyWrite>;

// ------------------------------------------------------------ P17 extensions

export const WireMcpServer = z.looseObject({
  name: z.string().min(1),
  origin: z.string().optional(),
  writable: z.boolean().optional(),
  auth_required: z.boolean().optional(),
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env_keys: z.array(z.string()).optional(),
  url: z.string().nullable().optional(),
  transport: z.string().nullable().optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
  env_header_keys: z.array(z.string()).optional(),
  has_bearer_token_env_var: z.boolean().optional(),
  scopes: z.array(z.string()).optional(),
  credential_configured: z.boolean().optional(),
  connected: z.boolean().optional(),
});
export type WireMcpServer = z.infer<typeof WireMcpServer>;

export const WireMcpServerList = z.looseObject({
  revision: z.string().min(1),
  servers: z.array(WireMcpServer),
});
export type WireMcpServerList = z.infer<typeof WireMcpServerList>;

export const WireMcpReconnect = z.looseObject({
  name: z.string().min(1),
  action: z.string().optional(),
  ok: z.boolean().optional(),
  revision: z.string().optional(),
  connection: z
    .looseObject({
      server: z.string().optional(),
      connected: z.boolean().optional(),
      auth_required: z.boolean().optional(),
      error: z.string().nullable().optional(),
    })
    .optional(),
});
export type WireMcpReconnect = z.infer<typeof WireMcpReconnect>;

export const WireMcpTool = z.looseObject({
  server: z.string().min(1),
  name: z.string().min(1),
  prefixed_name: z.string().optional(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
});
export type WireMcpTool = z.infer<typeof WireMcpTool>;

export const WireMcpTools = z.looseObject({
  tools: z.array(WireMcpTool),
  connections: z
    .array(
      z.looseObject({
        server: z.string(),
        connected: z.boolean().optional(),
        auth_required: z.boolean().optional(),
        error: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
export type WireMcpTools = z.infer<typeof WireMcpTools>;

export const WireSkill = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
  plugin_id: z.string().nullable().optional(),
  plugin_generation: z.number().nullable().optional(),
  plugin_content_hash: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  is_bundled: z.boolean().optional(),
  invocation: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  bundled_tier: z.string().nullable().optional(),
});
export type WireSkill = z.infer<typeof WireSkill>;

export const WireSkillList = z.looseObject({
  directory: z.string().nullable().optional(),
  directories: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  skills: z.array(WireSkill),
});
export type WireSkillList = z.infer<typeof WireSkillList>;

export const WireSkillDetail = WireSkill.extend({ body: z.string().optional() });
export type WireSkillDetail = z.infer<typeof WireSkillDetail>;

export const WirePluginInventory = z.looseObject({
  skills: z.number().optional(),
  mcp_servers: z.number().optional(),
  stdio_mcp_servers: z.number().optional(),
  remote_mcp_servers: z.number().optional(),
  commands: z.number().optional(),
  agents: z.number().optional(),
  hooks: z.number().optional(),
  lsp: z.number().optional(),
  native: z.number().optional(),
  filesystem_roots: z.array(z.string()).optional(),
  network_hosts: z.array(z.string()).optional(),
  lifecycle_mutation: z.boolean().optional(),
});
export type WirePluginInventory = z.infer<typeof WirePluginInventory>;

export const WirePlugin = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  display_name: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  scope: z.string().optional(),
  origin: z.string().optional(),
  path: z.string().optional(),
  state: z.string().optional(),
  enabled: z.boolean().optional(),
  trust_status: z.string().optional(),
  active: z.boolean().optional(),
  compatibility: z.string().optional(),
  inventory: WirePluginInventory.optional(),
  content_hash: z.string().nullable().optional(),
  capability_hash: z.string().nullable().optional(),
  diagnostics: z
    .array(z.looseObject({ level: z.string(), code: z.string(), message: z.string() }))
    .optional(),
  review: z
    .looseObject({
      token: z.string().nullable().optional(),
      capabilities: z.array(z.string()).optional(),
    })
    .optional(),
});
export type WirePlugin = z.infer<typeof WirePlugin>;

export const WirePluginList = z.looseObject({
  workspace: z.string().optional(),
  plugins: z.array(WirePlugin),
  registry_diagnostics: z.array(z.string()).optional(),
  validation_clean: z.boolean().nullable().optional(),
});
export type WirePluginList = z.infer<typeof WirePluginList>;

export const WireHook = z.looseObject({
  name: z.string().min(1),
  event: z.string().optional(),
  command: z.string().optional(),
  background: z.boolean().optional(),
  timeout_secs: z.number().nullable().optional(),
  source: z.string().optional(),
});
export type WireHook = z.infer<typeof WireHook>;

export const WireHooks = z.looseObject({
  workspace: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  hooks: z.array(WireHook),
  problems: z.array(z.string()).optional(),
});
export type WireHooks = z.infer<typeof WireHooks>;

export const WireInstructionSource = z.looseObject({
  kind: z.string().optional(),
  status: z.string().optional(),
  scope_dir: z.string().optional(),
  path: z.string().optional(),
  relative_path: z.string().nullable().optional(),
  exists: z.boolean().optional(),
  bytes: z.number().nullable().optional(),
  warning: z.string().nullable().optional(),
});
export type WireInstructionSource = z.infer<typeof WireInstructionSource>;

export const WireInstructions = z.looseObject({
  workspace: z.string().nullable().optional(),
  sources: z.array(WireInstructionSource),
});
export type WireInstructions = z.infer<typeof WireInstructions>;

export const WireWorkspaceStatus = z.looseObject({
  workspace: z.string().nullable().optional(),
  workspace_trusted: z.boolean().optional(),
});
export type WireWorkspaceStatus = z.infer<typeof WireWorkspaceStatus>;

export const WireWorkspaceTrust = z.looseObject({
  workspace: z.string().nullable().optional(),
  workspace_trusted: z.boolean().optional(),
  config_path: z.string().nullable().optional(),
  message: z.string().optional(),
});
export type WireWorkspaceTrust = z.infer<typeof WireWorkspaceTrust>;

export const WireCommand = z.looseObject({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  summary: z.string().optional(),
  kind: z.string().optional(),
  binding: z.string().optional(),
  hidden: z.boolean().optional(),
});
export type WireCommand = z.infer<typeof WireCommand>;

export const WireCommandList = z.looseObject({
  commands: z.array(WireCommand),
});
export type WireCommandList = z.infer<typeof WireCommandList>;
