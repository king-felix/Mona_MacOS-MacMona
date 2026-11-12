import { z } from "zod";
import {
  EffectiveProfile,
  EventEnvelope,
  OperationKey,
  PermissionPosture,
  SubmissionState,
  ThreadId,
  TurnId,
  type EngineCapabilities,
  type SubmissionStatus,
} from "../../shared/contracts";
import { evaluateCompatibility } from "./compat";
import { AdapterError, UnsupportedCapabilityError } from "./errors";
import { EventProjector } from "./projector";
import { SseParser } from "./sse";
import type { SubmissionStore } from "./submission-store";
import { startOwnedRuntime, stopOwnedRuntime, type OwnedRuntime } from "./runtime-process";
import type {
  ArtifactContentWindow,
  CallChangeFile,
  CallChangesResult,
  CapabilityInvocation,
  CapabilityResult,
  EngineAdapter,
  FileRevertReceipt,
  HistoryPage,
  InterruptReceipt,
  ReconcileResult,
  RestoreCapability,
  RouteRequest,
  RuntimeHandle,
  RuntimeStartInput,
  SnapshotEntry,
  SubmissionReceipt,
  SubscribeInput,
  SubscriptionItem,
  ThreadRef,
  ThreadRequest,
  TurnArtifactRef,
  TurnArtifactsResult,
  TurnRecord,
  TurnWorkspaceState,
  UsageQuery,
  UsageReport,
  SubmitTurnInput,
  WorkspaceFileWindow,
  WorkspaceWriteReceipt,
} from "./types";
import { HttpRuntimeTransport, type RuntimeTransport, type TransportResponse } from "./transport";
import { WireInterrupt, WireRuntimeInfo, WireThread, WireTurn, WireUsageResponse } from "./wire";

export interface AdapterOptions {
  /** Absent until startOwnedRuntime supplies one. */
  transport?: RuntimeTransport;
  store: SubmissionStore;
  now?: () => Date;
}

const TERMINAL = new Set(["completed", "failed", "interrupted", "canceled"]);

function parseWith<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AdapterError(
      "MALFORMED_RESPONSE",
      `${context} did not match the pinned contract`,
      false,
      {
        issues: result.error.issues.slice(0, 6),
      },
    );
  }
  return result.data;
}

function asThreadId(value: string, context: string): ThreadId {
  const result = ThreadId.safeParse(value);
  if (!result.success) {
    throw new AdapterError("MALFORMED_RESPONSE", `${context} returned an invalid thread id`);
  }
  return result.data;
}

function asTurnId(value: string, context: string): TurnId {
  const result = TurnId.safeParse(value);
  if (!result.success) {
    throw new AdapterError("MALFORMED_RESPONSE", `${context} returned an invalid turn id`);
  }
  return result.data;
}

function mapStatus(status: string): SubmissionStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "canceled":
      return "canceled";
    default:
      return "outcome_unknown";
  }
}

// The receipt routes return loose projections. These helpers read only fields
// that are present and leave every unknown as null instead of guessing.
function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function changeKind(value: unknown): TurnArtifactRef["change"] {
  return value === "created" || value === "updated" || value === "deleted" || value === "renamed"
    ? value
    : "unknown";
}

const CHANGE_SOURCES = new Set([
  "tool_mutation",
  "tool_output_spill",
  "tool_media",
  "workspace_changed_during_turn",
]);

function changeSource(value: unknown): TurnArtifactRef["source"] {
  return typeof value === "string" && CHANGE_SOURCES.has(value)
    ? (value as TurnArtifactRef["source"])
    : "unknown";
}

function artifactKind(value: unknown): TurnArtifactRef["kind"] {
  return value === "file" || value === "tool_output" || value === "media" ? value : "unknown";
}

function errorBody(response: TransportResponse): string {
  const body = objectValue(response.json);
  const message = body ? (stringValue(body.message) ?? stringValue(body.error)) : null;
  return (message ?? response.text).slice(0, 500);
}

export class CodewhaleAdapter implements EngineAdapter {
  private transport: RuntimeTransport | null;
  private readonly store: SubmissionStore;
  private readonly now: () => Date;
  private info: WireRuntimeInfo | null = null;
  private capabilities: EngineCapabilities | null = null;
  private owned: OwnedRuntime | null = null;
  private readonly projectors = new Map<string, EventProjector>();

  constructor(options: AdapterOptions) {
    this.transport = options.transport ?? null;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- discovery

  async discover(): Promise<EngineCapabilities> {
    if (this.capabilities) return this.capabilities;
    const response = await this.request("GET", "/v1/runtime/info");
    this.throwForAuth(response, "runtime info");
    if (response.status !== 200) {
      throw new AdapterError("RUNTIME_UNAVAILABLE", `runtime info returned ${response.status}`);
    }
    const info = parseWith(WireRuntimeInfo, response.json, "runtime info");
    const compatibility = evaluateCompatibility(info);
    if (!compatibility.compatible) {
      throw new AdapterError("INCOMPATIBLE_ENGINE", compatibility.reasons.join("; "), false, {
        compatibility,
      });
    }
    this.info = info;
    this.capabilities = {
      identity: {
        version: info.codewhale_version,
        commit: info.codewhale_commit,
      },
      transports: info.transports ?? [],
      capabilities: info.capabilities,
    };
    return this.capabilities;
  }

  async startOwnedRuntime(input: RuntimeStartInput): Promise<RuntimeHandle> {
    if (this.owned)
      throw new AdapterError("RUNTIME_UNAVAILABLE", "an owned runtime is already active");
    this.owned = await startOwnedRuntime(input);
    this.transport = new HttpRuntimeTransport({
      baseUrl: this.owned.runtime.baseUrl,
      token: this.owned.token,
    });
    this.info = null;
    this.capabilities = null;
    return this.owned.runtime;
  }

  async shutdownOwnedRuntime(handle: RuntimeHandle): Promise<{ stopped: boolean }> {
    const result = await stopOwnedRuntime(handle);
    const stopped = result.state === "stopped";
    // Keep the handle while survivors are known so a retry targets the same
    // tree; dropping it would invite a second owner beside the leftovers.
    if (stopped) {
      this.owned = null;
      this.info = null;
      this.capabilities = null;
    }
    return { stopped };
  }

  // ------------------------------------------------------------------- threads

  async createOrOpenThread(input: ThreadRequest): Promise<ThreadRef> {
    const caps = await this.discover();
    const body: Record<string, unknown> = { workspace: input.workspace };
    if (input.title !== undefined) body.title = input.title;
    if (input.execute) {
      body.auto_approve = input.execute.autoApprove;
      body.trust_mode = input.execute.trustMode;
      body.allow_shell = input.execute.allowShell;
    }
    if (input.allowedTools !== undefined) body.allowed_tools = input.allowedTools;
    if (input.operationKey !== undefined) {
      if (caps.capabilities["thread_create_idempotency"] !== true) {
        throw new UnsupportedCapabilityError(
          "thread_create_idempotency",
          "this runtime cannot replay a thread creation safely",
        );
      }
      body.operation_key = input.operationKey;
    }
    const response = await this.request("POST", "/v1/threads", body);
    this.throwForAuth(response, "thread create");
    if (response.status !== 200 && response.status !== 201) {
      throw new AdapterError(
        "MALFORMED_RESPONSE",
        `thread create returned ${response.status}`,
        false,
        {
          body: response.text.slice(0, 500),
        },
      );
    }
    const createBody = response.json as { thread?: unknown } | null;
    const thread = parseWith(
      WireThread,
      createBody && typeof createBody === "object" && "thread" in createBody
        ? createBody.thread
        : response.json,
      "thread create",
    );
    return {
      threadId: asThreadId(thread.id, "thread create"),
      workspace: thread.workspace ?? input.workspace,
      created: response.status === 201,
    };
  }

  // --------------------------------------------------------------------- turns

  async submitTurn(input: SubmitTurnInput): Promise<SubmissionReceipt> {
    const caps = await this.discover();
    if (caps.capabilities["turns"] !== true) {
      throw new UnsupportedCapabilityError("turns", "runtime does not advertise turns");
    }
    if (input.prompt.trim().length === 0) {
      throw new AdapterError("MALFORMED_RESPONSE", "prompt must not be empty");
    }
    const key = parseWith(OperationKey, input.operationKey, "operation key");
    const submittedAt = this.now().toISOString();
    const base: SubmissionState = {
      operationKey: key,
      threadId: input.threadId,
      turnId: null,
      status: "sending",
      submittedAt,
      reconciled: false,
    };
    // Intent is durable before transmission. A store failure means no send.
    await this.store.put(base);

    const body: Record<string, unknown> = { prompt: input.prompt };
    if (caps.capabilities["turn_operation_idempotency"] === true) body.operation_key = key;
    if (input.requested) {
      body.model_provider = input.requested.provider;
      body.model = input.requested.model;
      if (input.requested.reasoningEffort) body.reasoning_effort = input.requested.reasoningEffort;
    }
    if (input.autoApprove !== undefined) body.auto_approve = input.autoApprove;
    if (input.allowShell !== undefined) body.allow_shell = input.allowShell;
    if (input.trustMode !== undefined) body.trust_mode = input.trustMode;

    const path = `/v1/threads/${input.threadId}/turns`;
    let response: TransportResponse;
    try {
      response = await this.requireTransport().request("POST", path, body, { timeoutMs: 120_000 });
    } catch (error) {
      const submission = await this.markOutcomeUnknown(base, `transport error: ${String(error)}`);
      return {
        submission,
        turnId: null,
        accepted: false,
        outcomeUnknown: true,
        guidance: this.reconcileGuidance(caps, input.threadId, key),
      };
    }

    if (response.status === 401 || response.status === 403) {
      const submission = {
        ...base,
        status: "failed" as const,
        note: `authentication failed (${response.status})`,
      };
      await this.store.put(submission);
      throw new AdapterError("AUTH_FAILED", "runtime rejected the bearer token");
    }
    if (response.status === 409) {
      const submission = await this.markOutcomeUnknown(base, "operation conflict (409)");
      return {
        submission,
        turnId: null,
        accepted: false,
        outcomeUnknown: true,
        guidance: this.reconcileGuidance(caps, input.threadId, key),
      };
    }
    if (response.status < 200 || response.status >= 300) {
      const submission = {
        ...base,
        status: "failed" as const,
        note: `turn submit returned ${response.status}`,
      };
      await this.store.put(submission);
      return {
        submission,
        turnId: null,
        accepted: false,
        outcomeUnknown: false,
        guidance: null,
      };
    }

    const turn = this.extractTurn(response.json, "turn submit");
    if (turn.thread_id !== input.threadId) {
      const submission = await this.markOutcomeUnknown(
        base,
        `response belonged to ${turn.thread_id}, not ${input.threadId}`,
      );
      throw new AdapterError(
        "WRONG_THREAD",
        "turn response did not belong to the requested thread",
        false,
        {
          expected: input.threadId,
          observed: turn.thread_id,
          submission,
        },
      );
    }
    const turnId = asTurnId(turn.id, "turn submit");
    const submission: SubmissionState = {
      ...base,
      turnId,
      status: mapStatus(turn.status),
      reconciled: true,
    };
    await this.store.put(submission);
    return {
      submission,
      turnId,
      accepted: true,
      outcomeUnknown: false,
      guidance: null,
    };
  }

  async reconcileSubmission(input: { submission: SubmissionState }): Promise<ReconcileResult> {
    const caps = await this.discover();
    if (caps.capabilities["turn_operation_lookup"] !== true) {
      return {
        status: "outcome_unknown",
        turnId: input.submission.turnId,
        evidence: "none",
        guidance:
          "this runtime does not advertise read-only operation lookup; do not resubmit blindly",
      };
    }
    const path = `/v1/threads/${input.submission.threadId}/turn-operations/${encodeURIComponent(
      input.submission.operationKey,
    )}`;
    const response = await this.request("GET", path);
    this.throwForAuth(response, "operation lookup");

    if (response.status === 200) {
      const turn = this.extractTurn(response.json, "operation lookup");
      if (turn.thread_id !== input.submission.threadId) {
        throw new AdapterError("WRONG_THREAD", "lookup returned a turn from another thread");
      }
      const turnId = asTurnId(turn.id, "operation lookup");
      const status = mapStatus(turn.status);
      await this.store.put({
        ...input.submission,
        turnId,
        status,
        reconciled: true,
      });
      return { status, turnId, evidence: "lookup", guidance: null };
    }
    if (response.status === 404) {
      const submission = await this.markOutcomeUnknown(
        input.submission,
        "operation lookup reports no binding",
      );
      return {
        status: "outcome_unknown",
        turnId: submission.turnId,
        evidence: "lookup",
        guidance:
          "lookup reports no accepted turn; Mona will not resubmit automatically — decide explicitly",
      };
    }
    if (response.status === 409 || response.status >= 500) {
      await this.markOutcomeUnknown(input.submission, `lookup returned ${response.status}`);
      return {
        status: "outcome_unknown",
        turnId: input.submission.turnId,
        evidence: "lookup",
        guidance: "lookup is inconclusive; retry reconciliation later, never the write",
      };
    }
    throw new AdapterError("MALFORMED_RESPONSE", `operation lookup returned ${response.status}`);
  }

  // -------------------------------------------------------------------- stream

  async *subscribe(input: SubscribeInput): AsyncIterable<SubscriptionItem> {
    const caps = await this.discover();
    if (caps.capabilities["event_replay"] !== true) {
      throw new UnsupportedCapabilityError("event_replay", "runtime cannot replay event history");
    }
    const params = new URLSearchParams({ progress: "true" });
    if (input.sinceSeq !== undefined) params.set("since_seq", String(input.sinceSeq));
    let stream;
    try {
      stream = await this.requireTransport().stream(
        `/v1/threads/${input.threadId}/events?${params.toString()}`,
        { signal: input.signal },
      );
    } catch (error) {
      if (input.signal?.aborted) {
        yield { type: "end", reason: "aborted", lastSeq: input.sinceSeq ?? -1 };
        return;
      }
      throw new AdapterError("RUNTIME_UNAVAILABLE", `event stream failed: ${String(error)}`, true);
    }
    this.throwForAuth({ status: stream.status }, "event stream");
    if (stream.status !== 200) {
      throw new AdapterError("MALFORMED_RESPONSE", `event stream returned ${stream.status}`);
    }

    const projector = this.projectorFor(input.threadId);
    const parser = new SseParser();
    let lastSeq = input.sinceSeq ?? -1;
    try {
      for await (const chunk of stream.chunks) {
        if (input.signal?.aborted) {
          yield { type: "end", reason: "aborted", lastSeq };
          return;
        }
        let frames;
        try {
          frames = parser.push(chunk);
        } catch (error) {
          yield {
            type: "diagnostic",
            reason: String(error).includes("too_large") ? "event_too_large" : String(error),
          };
          return;
        }
        for (const frame of frames) {
          if (frame.event === "stream.end") {
            const payload = (frame.json ?? {}) as { reason?: string; last_seq?: number };
            yield {
              type: "end",
              reason: payload.reason ?? "stream_end",
              lastSeq: payload.last_seq ?? lastSeq,
            };
            return;
          }
          if (frame.malformedJson || frame.json === null) {
            yield { type: "diagnostic", reason: "malformed_json", raw: frame.data.slice(0, 500) };
            continue;
          }
          const frameObject = frame.json as { event?: unknown; state?: unknown; seq?: unknown };
          if (frameObject.event === "stream.progress") {
            // Transport frame, not a durable event: it carries no timestamp or
            // payload and must not advance the accepted event cursor.
            yield {
              type: "progress",
              state: typeof frameObject.state === "string" ? frameObject.state : "unknown",
              seq: typeof frameObject.seq === "number" ? frameObject.seq : -1,
            };
            continue;
          }
          const parsed = EventEnvelope.safeParse(frame.json);
          if (!parsed.success) {
            yield {
              type: "diagnostic",
              reason: "schema_drift",
              raw: frame.data.slice(0, 500),
            };
            continue;
          }
          const event = parsed.data;
          if (event.thread_id !== input.threadId) {
            yield {
              type: "diagnostic",
              reason: "wrong_thread",
              raw: `${event.thread_id} != ${input.threadId}`,
            };
            continue;
          }
          if (event.seq <= lastSeq && event.kind !== "stream.progress") continue;
          if (event.kind !== "stream.progress") lastSeq = Math.max(lastSeq, event.seq);
          projector.apply(event);
          yield { type: "event", event };
        }
      }
    } catch (error) {
      if (input.signal?.aborted) {
        yield { type: "end", reason: "aborted", lastSeq };
        return;
      }
      throw new AdapterError("RUNTIME_UNAVAILABLE", `event stream broke: ${String(error)}`, true);
    }
    yield { type: "end", reason: null, lastSeq };
  }

  // ------------------------------------------------------------------ control

  async interrupt(input: { threadId: ThreadId; turnId: TurnId }): Promise<InterruptReceipt> {
    const caps = await this.discover();
    if (caps.capabilities["turn_interrupt"] !== true) {
      throw new UnsupportedCapabilityError("turn_interrupt", "runtime cannot interrupt turns");
    }
    const response = await this.request(
      "POST",
      `/v1/threads/${input.threadId}/turns/${input.turnId}/interrupt`,
      {},
    );
    this.throwForAuth(response, "interrupt");
    if (response.status === 409) {
      // No active turn to stop; this is not an interrupt success or a crash.
      const history = await this.readHistory({ threadId: input.threadId });
      const turn = history.turns.find((candidate) => candidate.id === input.turnId) ?? null;
      return {
        interrupted: false,
        turn,
        note: "runtime reports no active turn to interrupt (409)",
      };
    }
    if (response.status !== 200) {
      throw new AdapterError("MALFORMED_RESPONSE", `interrupt returned ${response.status}`);
    }
    const receipt = parseWith(WireInterrupt, response.json, "interrupt receipt");
    if (receipt.thread_id && receipt.thread_id !== input.threadId) {
      throw new AdapterError("WRONG_THREAD", "interrupt receipt belonged to another thread");
    }
    // The HTTP receipt can arrive before the turn unwinds. Poll history briefly
    // for the terminal state instead of claiming confirmation from the request.
    let final: TurnRecord | null = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const history = await this.readHistory({ threadId: input.threadId });
      final = history.turns.find((turn) => turn.id === input.turnId) ?? null;
      if (final && TERMINAL.has(final.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const confirmed =
      receipt.interrupted === true ||
      (final !== null && (final.status === "interrupted" || final.status === "canceled"));
    return {
      interrupted: confirmed,
      turn: final,
      note: confirmed
        ? "interrupt confirmed by terminal turn state"
        : `interrupt accepted; final status ${final?.status ?? "unknown"}`,
    };
  }

  // ------------------------------------------------------------------- reading

  async readHistory(input: { threadId: ThreadId }): Promise<HistoryPage> {
    const response = await this.request("GET", `/v1/threads/${input.threadId}`);
    this.throwForAuth(response, "thread history");
    if (response.status === 404) {
      throw new AdapterError("WRONG_THREAD", "thread not found");
    }
    if (response.status !== 200) {
      throw new AdapterError("MALFORMED_RESPONSE", `thread history returned ${response.status}`);
    }
    const body = response.json as { thread?: unknown; turns?: unknown } | null;
    const threadValue =
      body && typeof body === "object" && "thread" in body ? body.thread : response.json;
    const thread = parseWith(WireThread, threadValue, "thread history");
    if (thread.id !== input.threadId) {
      throw new AdapterError("WRONG_THREAD", "history response belonged to another thread", false, {
        expected: input.threadId,
        observed: thread.id,
      });
    }
    const turnsValue =
      body && typeof body === "object" && "turns" in body ? body.turns : thread.turns;
    const turns = Array.isArray(turnsValue)
      ? turnsValue.map((turn) => parseWith(WireTurn, turn, "thread history turn"))
      : [];
    return {
      threadId: input.threadId,
      workspace: thread.workspace ?? null,
      turns: turns.map((turn) => this.mapTurn(turn)),
    };
  }

  async readUsage(input: UsageQuery): Promise<UsageReport> {
    const params = new URLSearchParams();
    if (input.since) params.set("since", input.since);
    if (input.until) params.set("until", input.until);
    params.set("group_by", input.groupBy ?? "thread");
    const response = await this.request("GET", `/v1/usage?${params.toString()}`);
    this.throwForAuth(response, "usage");
    if (response.status !== 200) {
      throw new AdapterError("MALFORMED_RESPONSE", `usage returned ${response.status}`);
    }
    const usage = parseWith(WireUsageResponse, response.json, "usage");
    const totals = usage.totals ?? {};
    return {
      totals: {
        inputTokens: totals.input_tokens ?? 0,
        outputTokens: totals.output_tokens ?? 0,
        cachedTokens: totals.cached_tokens ?? 0,
        reasoningTokens: totals.reasoning_tokens ?? 0,
        costUsd: totals.cost_usd ?? 0,
        costComplete: totals.cost_complete === true,
        turns: totals.turns ?? 0,
      },
      buckets: (usage.buckets ?? []).map((bucket) => ({
        key: bucket.key,
        inputTokens: bucket.input_tokens ?? 0,
        outputTokens: bucket.output_tokens ?? 0,
        cachedTokens: bucket.cached_tokens ?? 0,
        reasoningTokens: bucket.reasoning_tokens ?? 0,
        costUsd: bucket.cost_usd ?? 0,
        costComplete: bucket.cost_complete === true,
      })),
    };
  }

  async getEffectiveProfile(input: {
    threadId: ThreadId;
    turnId?: TurnId;
    requested: RouteRequest;
    strict?: boolean;
  }): Promise<EffectiveProfile> {
    const history = await this.readHistory({ threadId: input.threadId });
    const turn = input.turnId
      ? history.turns.find((candidate) => candidate.id === input.turnId)
      : history.turns[history.turns.length - 1];
    if (!turn) throw new AdapterError("MALFORMED_RESPONSE", "no turn available to verify");
    if (!turn.effectiveProvider || !turn.effectiveModel) {
      throw new AdapterError("MALFORMED_RESPONSE", "turn did not report an effective route");
    }
    const posture = PermissionPosture.safeParse(turn.permissionPosture ?? "unknown");
    const effectivePosture = posture.success ? posture.data : "unknown";
    const usedFallback =
      turn.effectiveProvider !== input.requested.provider ||
      turn.effectiveModel !== input.requested.model;
    const permissionMismatch =
      input.requested.permissionPosture === "full_access" && effectivePosture !== "full_access";
    const caps = await this.discover();
    const profile: EffectiveProfile = {
      requested: {
        provider: input.requested.provider,
        model: input.requested.model,
        reasoningEffort: input.requested.reasoningEffort,
      },
      effective: {
        provider: turn.effectiveProvider,
        model: turn.effectiveModel,
        permissionPosture: effectivePosture,
      },
      usedFallback,
      source: "configured",
      engine: caps.identity,
    };
    if (input.strict === true && (usedFallback || permissionMismatch)) {
      throw new AdapterError(
        "PROFILE_MISMATCH",
        `requested ${input.requested.provider}/${input.requested.model}/${input.requested.permissionPosture} but ` +
          `${turn.effectiveProvider}/${turn.effectiveModel}/${effectivePosture} ran`,
        false,
        { profile },
      );
    }
    return profile;
  }

  // -------------------------------------------- change receipts and restore

  async readTurnArtifacts(input: {
    threadId: ThreadId;
    turnId: TurnId;
  }): Promise<TurnArtifactsResult> {
    const response = await this.request(
      "GET",
      `/v1/threads/${encodeURIComponent(input.threadId)}/turns/${encodeURIComponent(
        input.turnId,
      )}/artifacts`,
    );
    this.throwForAuth(response, "turn artifacts");
    if (response.status === 404) {
      throw new AdapterError("MALFORMED_RESPONSE", "the runtime does not know this turn", false, {
        status: response.status,
      });
    }
    this.expectOk(response, "turn artifacts");
    const body = objectValue(response.json) ?? {};
    const workspaceBody = objectValue(body.workspace);
    let workspace: TurnWorkspaceState | null = null;
    if (workspaceBody) {
      const state = workspaceBody.state;
      workspace = {
        state:
          state === "pending" || state === "settled" || state === "unavailable"
            ? state
            : "unavailable",
        reason: stringValue(workspaceBody.reason),
        preSnapshotId: stringValue(workspaceBody.pre_turn_snapshot_id),
        postSnapshotId: stringValue(workspaceBody.post_turn_snapshot_id),
        truncated: booleanValue(workspaceBody.truncated) === true,
        omitted: numberValue(workspaceBody.omitted),
      };
    }
    return {
      turnId: stringValue(body.turn_id) ?? input.turnId,
      workspace,
      artifacts: arrayValue(body.artifacts).map((value) => this.mapArtifactRef(value)),
    };
  }

  async readTurnArtifact(input: {
    threadId: ThreadId;
    turnId: TurnId;
    artifactId: string;
    offset?: number;
    limit?: number;
    revision?: string;
  }): Promise<ArtifactContentWindow> {
    const query = new URLSearchParams();
    if (input.offset !== undefined) query.set("offset", String(input.offset));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.revision !== undefined) query.set("revision", input.revision);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.request(
      "GET",
      `/v1/threads/${encodeURIComponent(input.threadId)}/turns/${encodeURIComponent(
        input.turnId,
      )}/artifacts/${encodeURIComponent(input.artifactId)}${suffix}`,
    );
    this.throwForUnauthorized(response, "turn artifact");
    const base = {
      artifactId: input.artifactId,
      offset: input.offset ?? 0,
      totalBytes: null,
      revision: null,
      source: null,
      current: null,
      truncated: false,
    };
    if (response.status === 413) {
      return {
        ...base,
        availability: "oversized",
        content: null,
        encoding: null,
        note: "the runtime refuses to serve content above 16 MiB",
      };
    }
    if (response.status === 410 || response.status === 409 || response.status === 404) {
      return {
        ...base,
        availability: "missing",
        content: null,
        encoding: null,
        note:
          response.status === 410
            ? "the turn deleted this file, or the artifact bytes were pruned"
            : response.status === 409
              ? `the recorded revision is no longer available: ${errorBody(response)}`
              : "the runtime does not know this artifact",
      };
    }
    if (response.status === 403) {
      return {
        ...base,
        availability: "missing",
        content: null,
        encoding: null,
        note: "the reference is a symlink or leaves its root",
      };
    }
    this.expectOk(response, "turn artifact");
    const body = objectValue(response.json) ?? {};
    const encoding = body.encoding === "base64" ? "base64" : "utf-8";
    const binary = encoding === "base64";
    return {
      artifactId: input.artifactId,
      availability: binary ? "binary" : "available",
      content: binary ? null : stringValue(body.content),
      encoding,
      offset: numberValue(body.offset) ?? input.offset ?? 0,
      totalBytes: numberValue(body.size),
      revision: stringValue(body.revision),
      source: stringValue(body.source),
      current: booleanValue(body.current),
      truncated: booleanValue(body.truncated) === true,
      note: binary ? "binary content is read by the engine but not shown here" : null,
    };
  }

  async readCallChanges(input: {
    threadId: ThreadId;
    turnId: TurnId;
    toolCallId: string;
    limit?: number;
  }): Promise<CallChangesResult> {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 200)), 1000);
    const response = await this.request(
      "GET",
      `/v1/threads/${encodeURIComponent(input.threadId)}/turns/${encodeURIComponent(
        input.turnId,
      )}/calls/${encodeURIComponent(input.toolCallId)}/changes?limit=${limit}`,
    );
    this.throwForAuth(response, "tool call changes");
    if (response.status === 404) {
      return {
        state: "unavailable",
        reason: "call_not_found",
        files: [],
        truncated: false,
        note: "the runtime has no item or receipt for this tool call",
      };
    }
    if (response.status === 400) {
      return {
        state: "unavailable",
        reason: "bad_request",
        files: [],
        truncated: false,
        note: errorBody(response),
      };
    }
    this.expectOk(response, "tool call changes");
    const body = objectValue(response.json) ?? {};
    const rawState = body.state;
    const state =
      rawState === "captured" || rawState === "pending" || rawState === "unavailable"
        ? rawState
        : "unavailable";
    return {
      state,
      reason: stringValue(body.reason),
      files: arrayValue(body.files).map((value): CallChangeFile => {
        const file = objectValue(value) ?? {};
        return {
          path: stringValue(file.path) ?? "",
          change: changeKind(file.change),
          added: numberValue(file.added),
          removed: numberValue(file.removed),
          sizeBytes: numberValue(file.size),
          revision: stringValue(file.revision),
          restoreSnapshotId: stringValue(file.restore_snapshot_id),
          diff: typeof file.diff === "string" ? file.diff : null,
          diffTruncated: booleanValue(file.diff_truncated) === true,
        };
      }),
      truncated: booleanValue(body.truncated) === true,
      note: stringValue(body.note),
    };
  }

  async probeRestore(threadId: ThreadId): Promise<RestoreCapability> {
    const fileRevert = await this.request(
      "GET",
      `/v1/threads/${encodeURIComponent(threadId)}/file-revert`,
    );
    this.throwForAuth(fileRevert, "file revert probe");
    const revertAvailable = fileRevert.status !== 404;
    const snapshots = await this.request("GET", "/v1/snapshots?limit=1");
    this.throwForAuth(snapshots, "snapshot probe");
    const snapshotAvailable = snapshots.status >= 200 && snapshots.status < 300;
    const reason = !revertAvailable
      ? "this engine build has no file-revert route; restore needs a newer runtime"
      : !snapshotAvailable
        ? `the snapshot listing answered ${snapshots.status}; recovery points cannot be listed`
        : null;
    return { fileRevert: revertAvailable, snapshots: snapshotAvailable, reason };
  }

  async listSnapshots(limit = 20): Promise<SnapshotEntry[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 100);
    const response = await this.request("GET", `/v1/snapshots?limit=${bounded}`);
    this.throwForAuth(response, "snapshot listing");
    this.expectOk(response, "snapshot listing");
    const body = response.json;
    const rows = Array.isArray(body) ? body : arrayValue(objectValue(body)?.snapshots);
    return rows.flatMap((value) => {
      const row = objectValue(value);
      const id = row ? stringValue(row.id) : null;
      if (!row || !id) return [];
      return [
        {
          id,
          label: stringValue(row.label) ?? "",
          timestamp: numberValue(row.timestamp),
        },
      ];
    });
  }

  async revertFile(input: {
    threadId: ThreadId;
    path: string;
    snapshotId: string;
    expectedHash: string;
  }): Promise<FileRevertReceipt> {
    const response = await this.request(
      "POST",
      `/v1/threads/${encodeURIComponent(input.threadId)}/file-revert`,
      {
        path: input.path,
        snapshot_id: input.snapshotId,
        expected_hash: input.expectedHash,
      },
    );
    this.throwForAuth(response, "file revert");
    if (response.status === 409) {
      throw new AdapterError(
        "RESTORE_CONFLICT",
        `the engine refused the revert: ${errorBody(response)}`,
        false,
        { status: response.status, path: input.path },
      );
    }
    if (response.status === 400 || response.status === 404 || response.status === 422) {
      throw new AdapterError(
        "RESTORE_REFUSED",
        `the engine refused the revert: ${errorBody(response)}`,
        false,
        { status: response.status, path: input.path },
      );
    }
    if (response.status === 405) {
      throw new AdapterError(
        "RESTORE_UNAVAILABLE",
        "this engine build has no file-revert route",
        false,
      );
    }
    this.expectOk(response, "file revert");
    const body = objectValue(response.json) ?? {};
    const action = body.action;
    return {
      path: stringValue(body.path) ?? input.path,
      action: action === "recreated" || action === "removed" ? action : "modified",
      snapshotId: stringValue(body.snapshot_id) ?? input.snapshotId,
      snapshotLabel: stringValue(body.snapshot_label),
    };
  }

  async readWorkspaceFile(input: {
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<WorkspaceFileWindow> {
    const query = new URLSearchParams({ path: input.path });
    if (input.offset !== undefined) query.set("offset", String(input.offset));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const response = await this.request("GET", `/v1/workspace/files/read?${query.toString()}`);
    this.throwForUnauthorized(response, "workspace file read");
    const base = {
      offset: input.offset ?? 0,
      sizeBytes: null,
      revision: null,
      truncated: false,
    };
    if (response.status === 413) {
      return {
        ...base,
        availability: "oversized",
        content: null,
        encoding: null,
        note: "the runtime refuses to read files above 16 MiB",
      };
    }
    if (response.status === 404) {
      return {
        ...base,
        availability: "missing",
        content: null,
        encoding: null,
        note: "the file does not exist in the runtime workspace",
      };
    }
    if (response.status === 403 || response.status === 400) {
      return {
        ...base,
        availability: "forbidden",
        content: null,
        encoding: null,
        note: errorBody(response),
      };
    }
    this.expectOk(response, "workspace file read");
    const body = objectValue(response.json) ?? {};
    const encoding = body.encoding === "base64" ? "base64" : "utf-8";
    const binary = encoding === "base64";
    return {
      availability: binary ? "binary" : "available",
      content: binary ? null : typeof body.content === "string" ? body.content : null,
      encoding,
      offset: numberValue(body.offset) ?? input.offset ?? 0,
      sizeBytes: numberValue(body.size),
      revision: stringValue(body.revision),
      truncated: booleanValue(body.truncated) === true,
      note: binary ? "binary content is not displayed" : null,
    };
  }

  async writeWorkspaceFile(input: {
    path: string;
    content: string;
    expectedRevision: string;
  }): Promise<WorkspaceWriteReceipt> {
    const response = await this.request("PUT", "/v1/workspace/files", {
      path: input.path,
      content: input.content,
      expected_revision: input.expectedRevision,
    });
    this.throwForUnauthorized(response, "workspace file write");
    if (response.status === 409) {
      const body = objectValue(response.json);
      const current =
        (body ? (stringValue(body.current_revision) ?? stringValue(body.revision)) : null) ??
        /[a-f0-9]{64}/.exec(response.text)?.[0] ??
        null;
      throw new AdapterError(
        "WRITE_CONFLICT",
        `the file changed since it was read: ${errorBody(response)}`,
        false,
        { status: response.status, currentRevision: current, path: input.path },
      );
    }
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      throw new AdapterError(
        "WRITE_REFUSED",
        `the engine refused the write: ${errorBody(response)}`,
        false,
        { status: response.status, path: input.path },
      );
    }
    if (response.status === 413) {
      throw new AdapterError("WRITE_REFUSED", "the file exceeds the engine's 4 MiB write limit");
    }
    this.expectOk(response, "workspace file write");
    const body = objectValue(response.json) ?? {};
    return {
      path: stringValue(body.path) ?? input.path,
      sizeBytes: numberValue(body.size) ?? Buffer.byteLength(input.content, "utf8"),
      revision: stringValue(body.revision) ?? "",
      created: booleanValue(body.created) === true,
      writtenAt: stringValue(body.written_at),
    };
  }

  private mapArtifactRef(value: unknown): TurnArtifactRef {
    const ref = objectValue(value) ?? {};
    return {
      id: stringValue(ref.id) ?? "",
      kind: artifactKind(ref.kind),
      path: stringValue(ref.path) ?? "",
      change: changeKind(ref.change),
      previousPath: stringValue(ref.previous_path),
      sizeBytes: numberValue(ref.size),
      revision: stringValue(ref.revision),
      contentType: stringValue(ref.content_type),
      sessionId: stringValue(ref.session_id),
      itemId: stringValue(ref.item_id),
      toolCallId: stringValue(ref.tool_call_id),
      toolName: stringValue(ref.tool_name),
      source: changeSource(ref.source),
      restoreSnapshotId: stringValue(ref.restore_snapshot_id),
      recordedAt: stringValue(ref.recorded_at),
    };
  }

  async invokeCapability(input: CapabilityInvocation): Promise<CapabilityResult> {
    switch (input.name) {
      case "runtime.info": {
        const info = await this.discover();
        return { name: input.name, status: "ok", value: info };
      }
      case "providers.list": {
        const response = await this.request("GET", "/v1/providers");
        this.throwForAuth(response, "providers");
        this.expectOk(response, "providers");
        return { name: input.name, status: "ok", value: response.json };
      }
      case "providers.models": {
        const provider = input.args?.provider;
        if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
          throw new AdapterError("MALFORMED_RESPONSE", "providers.models requires a provider id");
        }
        const response = await this.request(
          "GET",
          `/v1/providers/${encodeURIComponent(provider)}/models`,
        );
        this.throwForAuth(response, "provider models");
        this.expectOk(response, "provider models");
        return { name: input.name, status: "ok", value: response.json };
      }
      case "usage.read": {
        const report = await this.readUsage({});
        return { name: input.name, status: "ok", value: report };
      }
      case "session.resume": {
        const sessionId = input.args?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw new AdapterError("MALFORMED_RESPONSE", "session.resume requires a session id");
        }
        const response = await this.request(
          "POST",
          `/v1/sessions/${encodeURIComponent(sessionId)}/resume-thread`,
          {},
        );
        this.throwForAuth(response, "session resume");
        if (response.status !== 200 && response.status !== 201) {
          throw new AdapterError(
            "MALFORMED_RESPONSE",
            `session resume returned ${response.status}`,
          );
        }
        return { name: input.name, status: "ok", value: response.json };
      }
      default:
        throw new UnsupportedCapabilityError(String(input.name), "not implemented by this adapter");
    }
  }

  // ------------------------------------------------------------------- helpers

  private requireTransport(): RuntimeTransport {
    if (!this.transport) {
      throw new AdapterError(
        "RUNTIME_UNAVAILABLE",
        "no runtime transport; start an owned runtime first",
      );
    }
    return this.transport;
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<TransportResponse> {
    try {
      return await this.requireTransport().request(method, path, body);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("RUNTIME_UNAVAILABLE", `request failed: ${String(error)}`, true);
    }
  }

  private throwForAuth(response: { status: number }, context: string): void {
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError("AUTH_FAILED", `${context}: runtime rejected the bearer token`);
    }
  }

  /**
   * File routes use 403 for a real path refusal (a symlink, `.git`, a directory),
   * so only a 401 is a credential failure there.
   */
  private throwForUnauthorized(response: { status: number }, context: string): void {
    if (response.status === 401) {
      throw new AdapterError("AUTH_FAILED", `${context}: runtime rejected the bearer token`);
    }
  }

  private expectOk(response: TransportResponse, context: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw new AdapterError(
        "MALFORMED_RESPONSE",
        `${context} returned ${response.status}`,
        false,
        {
          body: response.text.slice(0, 500),
        },
      );
    }
  }

  private extractTurn(value: unknown, context: string): WireTurn {
    const body = value as { turn?: unknown } | null;
    const candidate = body && typeof body === "object" && "turn" in body ? body.turn : value;
    return parseWith(WireTurn, candidate, `${context} turn`);
  }

  private mapTurn(turn: WireTurn): TurnRecord {
    return {
      id: asTurnId(turn.id, "turn"),
      threadId: asThreadId(turn.thread_id, "turn"),
      status: turn.status,
      effectiveProvider: turn.effective_provider ?? null,
      effectiveModel: turn.effective_model ?? null,
      permissionPosture: turn.permission_posture ?? null,
      usage: turn.usage
        ? {
            inputTokens: turn.usage.input_tokens ?? null,
            outputTokens: turn.usage.output_tokens ?? null,
            cachedTokens: turn.usage.prompt_cache_hit_tokens ?? null,
            cacheMissTokens: turn.usage.prompt_cache_miss_tokens ?? null,
            reasoningTokens: turn.usage.reasoning_tokens ?? null,
          }
        : null,
    };
  }

  private async markOutcomeUnknown(state: SubmissionState, note: string): Promise<SubmissionState> {
    const submission: SubmissionState = {
      ...state,
      status: "outcome_unknown",
      reconciled: false,
      note: note.slice(0, 2000),
    };
    await this.store.put(submission);
    return submission;
  }

  private reconcileGuidance(
    caps: EngineCapabilities,
    threadId: ThreadId,
    key: OperationKey,
  ): string {
    if (caps.capabilities["turn_operation_lookup"] === true) {
      return `outcome unknown; call reconcileSubmission for ${threadId} / ${key} before deciding`;
    }
    return "outcome unknown and this runtime has no read-only operation lookup; do not resubmit blindly";
  }

  /** Deterministic projection for reconnect verification and P04 recovery. */
  getProjectedState(threadId: ThreadId) {
    return this.projectors.get(threadId)?.snapshot() ?? null;
  }

  private projectorFor(threadId: ThreadId): EventProjector {
    let projector = this.projectors.get(threadId);
    if (!projector) {
      projector = new EventProjector(threadId);
      this.projectors.set(threadId, projector);
    }
    return projector;
  }
}

// Re-exported for the smoke script and P04 integration.
export { startOwnedRuntime, stopOwnedRuntime } from "./runtime-process";
