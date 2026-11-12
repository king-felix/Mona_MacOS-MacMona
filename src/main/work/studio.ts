import { createHash, randomUUID } from "node:crypto";
import type { EventEnvelope, ProjectId, ThreadId, TurnId } from "../../shared/contracts";
import { ThreadId as ThreadIdSchema } from "../../shared/contracts";
import { isKnownEventKind } from "../../shared/contracts/events";
import type {
  StudioActionResult,
  StudioConnectionState,
  StudioMode,
  StudioPush,
  StudioReconcileResult,
  StudioSnapshot,
  StudioSubmitOutcome,
  StudioSubmitResult,
} from "../../shared/contracts/studio";
import { CodewhaleAdapter } from "../engine/adapter";
import { AdapterError } from "../engine/errors";
import { HttpRuntimeTransport, type RuntimeTransport } from "../engine/transport";
import type { EngineAdapter, InterruptReceipt } from "../engine/types";
import { SqliteSubmissionStore } from "../state/submission-store";
import type { StoredProject, StateStore } from "../state/store";
import type { SupervisorStopReceipt } from "../supervisor/native";
import type { OwnedEndpoint, RuntimeStatus } from "../supervisor/runtime-supervisor";
import { WorkController } from "./control";
import {
  loadExecutionProfile,
  postureFor,
  profileView,
  type ExecutionProfile,
  type ModePosture,
} from "./profile";

export interface StudioSupervisor {
  ensure(workspace: string): Promise<RuntimeStatus>;
  endpoint(): OwnedEndpoint | null;
  status(): RuntimeStatus;
  stopOwned(
    reason?: string,
    options?: { force?: boolean; graceMs?: number },
  ): Promise<SupervisorStopReceipt>;
  isOwned(): boolean;
}

export interface WorkStudioOptions {
  store: StateStore;
  supervisor: StudioSupervisor;
  work: WorkController;
  /** Test seam: build the adapter over an injected transport. */
  newAdapter?: (transport: RuntimeTransport, projectId: ProjectId) => EngineAdapter;
  notify?: (push: StudioPush) => void;
  now?: () => Date;
  reconnect?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

export type StudioErrorCode =
  | "NOT_FOUND"
  | "STUDIO_BUSY"
  | "TURN_ACTIVE"
  | "NOT_CONNECTED"
  | "INVALID_INPUT"
  | "RUNTIME_UNAVAILABLE"
  | "UNSUPPORTED_INPUT";

export class StudioError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

interface ModeBinding {
  localThreadId: string;
  engineThreadId: ThreadId;
}

interface ActiveTurn {
  turnId: TurnId;
  binding: ModeBinding;
}

interface StudioSession {
  projectId: ProjectId;
  project: StoredProject;
  adapter: EngineAdapter;
  connection: StudioConnectionState;
  reason: string;
  since: string;
  engine: { version: string; commit: string } | null;
  port: number | null;
  owned: boolean;
  external: boolean;
  diagnostics: string[];
  pendingInput: string | null;
  active: ActiveTurn | null;
  lastMode: StudioMode | null;
  bindings: Partial<Record<StudioMode, ModeBinding>>;
  lastSubmissionKey: string | null;
  effective: NonNullable<StudioSnapshot["profile"]["effective"]> | null;
  effectiveTurnId: string | null;
  profile: ExecutionProfile;
  profileSource: "configured" | "default";
  submitting: boolean;
  stopped: boolean;
  abort: AbortController | null;
  pump: Promise<void> | null;
  pumpActive: boolean;
  pumpKey: string | null;
  usageRecorded: Set<string>;
}

const MAX_DIAGNOSTICS = 12;
const MAX_PROMPT = 100_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFatalStreamError(error: unknown): boolean {
  if (error instanceof AdapterError) {
    return error.code === "AUTH_FAILED" || error.code === "INCOMPATIBLE_ENGINE";
  }
  return false;
}

function pendingInputFor(kind: string): string | null {
  if (kind === "approval.decided" || kind === "user_input.answered") return null;
  if (/^approval\.(requested|required)$/.test(kind)) {
    return "The engine is waiting for an approval decision Mona cannot answer yet. Switch to Work with your saved Full Access profile, or answer in Codewhale. It will wait here rather than spin.";
  }
  if (/^user_input\.(requested|required)$/.test(kind) || kind === "clarification.requested") {
    return "The engine asked a clarification question. Mona does not yet answer clarifications; respond in Codewhale. The wait is real, not a hang.";
  }
  return null;
}

function terminalStatus(kind: string): "completed" | "failed" | "interrupted" | null {
  if (kind === "turn.completed") return "completed";
  if (kind === "turn.failed") return "failed";
  if (kind === "turn.interrupted") return "interrupted";
  return null;
}

function threadRowId(projectId: ProjectId, mode: StudioMode): string {
  return `thr_${createHash("sha256").update(`${projectId}:engine:${mode}`).digest("hex").slice(0, 16)}`;
}

function shellThreadId(projectId: ProjectId): string {
  return `thr_${createHash("sha256").update(projectId).digest("hex").slice(0, 16)}`;
}

function threadKey(projectId: ProjectId, mode: StudioMode): string {
  return `thread-${projectId}-${mode}`;
}

function stillWorkspace(status: RuntimeStatus, project: StoredProject): boolean {
  return (
    status.state === "running" &&
    (status.workspace === project.rootPath || status.workspace === project.canonicalPath)
  );
}

/**
 * The live work studio. It owns the authenticated connection to the engine
 * Mona started, one mutating turn per workspace, durable event ingestion, and
 * the honest control transitions. It never calls a model provider itself and
 * never fabricates a turn, a percentage, or a completion.
 */
export class WorkStudio {
  private readonly store: StateStore;
  private readonly supervisor: StudioSupervisor;
  private readonly work: WorkController;
  private readonly newAdapter: (transport: RuntimeTransport, projectId: ProjectId) => EngineAdapter;
  private readonly notify: (push: StudioPush) => void;
  private readonly now: () => Date;
  private readonly reconnectAttempts: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private active: StudioSession | null = null;
  private closed = false;

  constructor(options: WorkStudioOptions) {
    this.store = options.store;
    this.supervisor = options.supervisor;
    this.work = options.work;
    this.newAdapter =
      options.newAdapter ??
      ((transport, projectId) =>
        new CodewhaleAdapter({
          transport,
          store: new SqliteSubmissionStore(options.store, projectId),
        }));
    this.notify = options.notify ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.reconnectAttempts = options.reconnect?.attempts ?? 6;
    this.reconnectBaseMs = options.reconnect?.baseDelayMs ?? 250;
    this.reconnectMaxMs = options.reconnect?.maxDelayMs ?? 4_000;
    this.sleep =
      options.reconnect?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // --------------------------------------------------------------- lifecycle

  async start(projectId: ProjectId): Promise<StudioSnapshot> {
    const existing = this.active;
    if (existing && existing.projectId === projectId && !existing.stopped) {
      if (
        existing.connection === "connected" ||
        existing.connection === "running" ||
        existing.connection === "reconnecting"
      ) {
        return this.snapshot(projectId);
      }
    }
    if (existing && existing.projectId !== projectId && !existing.stopped) {
      const live =
        existing.connection === "connected" ||
        existing.connection === "running" ||
        existing.connection === "reconnecting";
      if (live) {
        throw new StudioError(
          "STUDIO_BUSY",
          `${existing.project.name} has the single owned runtime. Stop it before starting another project; parallel ownership is not proven.`,
          { activeProjectId: existing.projectId, requestedProjectId: projectId },
        );
      }
    }

    const project = await this.store.getProject(projectId);
    if (!project) {
      throw new StudioError("NOT_FOUND", "project is not in the catalog", { projectId });
    }
    await this.stopPump(existing);

    const loaded = await loadExecutionProfile(this.store);
    const session: StudioSession = {
      projectId,
      project,
      adapter: null as unknown as EngineAdapter,
      connection: "connecting",
      reason: "starting the owned runtime",
      since: this.now().toISOString(),
      engine: null,
      port: null,
      owned: false,
      external: false,
      diagnostics: [],
      pendingInput: null,
      active: null,
      lastMode: null,
      bindings: {},
      lastSubmissionKey: null,
      effective: null,
      effectiveTurnId: null,
      profile: loaded.profile,
      profileSource: loaded.source,
      submitting: false,
      stopped: false,
      abort: null,
      pump: null,
      pumpActive: false,
      pumpKey: null,
      usageRecorded: new Set(),
    };
    this.active = session;
    this.push(session, "connection", "connecting");

    let status: RuntimeStatus;
    try {
      status = await this.supervisor.ensure(project.canonicalPath);
    } catch (error) {
      this.fail(session, "runtime_start_failed", errorMessage(error));
      return this.snapshot(projectId);
    }
    if (!stillWorkspace(status, project)) {
      this.fail(
        session,
        "wrong_workspace",
        status.state === "running"
          ? `The runtime is serving ${status.workspace ?? "another workspace"}, not ${project.rootPath}. Mona keeps one owner per user store.`
          : `The runtime is ${status.state}: ${status.reason}`,
      );
      return this.snapshot(projectId);
    }
    if (status.external || !this.supervisor.isOwned()) {
      this.fail(
        session,
        "external_runtime",
        "The running engine was started outside Mona. Attaching read-only is deliberate; Mona does not drive a runtime it did not start.",
      );
      return this.snapshot(projectId);
    }
    const endpoint = this.supervisor.endpoint();
    if (!endpoint) {
      this.fail(
        session,
        "no_endpoint",
        "The owned runtime has no authenticated loopback endpoint.",
      );
      return this.snapshot(projectId);
    }

    let transport: RuntimeTransport;
    try {
      transport = new HttpRuntimeTransport({ baseUrl: endpoint.baseUrl, token: endpoint.token });
    } catch (error) {
      this.fail(session, "endpoint_invalid", errorMessage(error));
      return this.snapshot(projectId);
    }
    session.adapter = this.newAdapter(transport, projectId);
    session.owned = true;
    session.port = endpoint.port;
    try {
      const caps = await session.adapter.discover();
      session.engine = { version: caps.identity.version, commit: caps.identity.commit };
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : "RUNTIME_UNAVAILABLE";
      this.fail(session, code.toLowerCase(), errorMessage(error));
      return this.snapshot(projectId);
    }
    try {
      await this.store.setRuntimeBinding({
        projectId,
        workspace: project.rootPath,
        canonicalWorkspace: project.canonicalPath,
        executable: endpoint.executable,
        engineVersion: session.engine?.version ?? null,
        engineCommit: session.engine?.commit ?? null,
        port: endpoint.port,
        state: "running",
        updatedAt: this.now().toISOString(),
      });
      await this.ensureShellThread(project);
    } catch (error) {
      this.fail(session, "state_write_failed", errorMessage(error));
      return this.snapshot(projectId);
    }

    this.setConnection(session, "connected", "authenticated loopback runtime is ready");
    return this.snapshot(projectId);
  }

  // --------------------------------------------------------------- submission

  async submit(
    projectId: ProjectId,
    input: { prompt: string; mode: StudioMode },
  ): Promise<StudioSubmitResult> {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new StudioError("INVALID_INPUT", "a task prompt must not be empty");
    }
    if (prompt.length > MAX_PROMPT) {
      throw new StudioError(
        "INVALID_INPUT",
        `a task prompt is limited to ${MAX_PROMPT} characters`,
      );
    }
    if (input.mode !== "plan" && input.mode !== "work") {
      throw new StudioError("INVALID_INPUT", "mode must be plan or work");
    }

    let session = this.active;
    if (!session || session.projectId !== projectId || session.stopped) {
      await this.start(projectId);
      session = this.active;
    }
    if (!session || session.projectId !== projectId) {
      throw new StudioError("RUNTIME_UNAVAILABLE", "the studio did not start for this project");
    }
    if (session.connection === "failed") {
      throw new StudioError("RUNTIME_UNAVAILABLE", session.reason);
    }
    if (session.submitting) {
      throw new StudioError("TURN_ACTIVE", "a submission is already being accepted");
    }
    if (session.active) {
      throw new StudioError(
        "TURN_ACTIVE",
        "one mutating turn per workspace is already active; interrupt it or wait for it to finish",
        { turnId: session.active.turnId },
      );
    }
    if (session.connection === "reconnecting") {
      throw new StudioError(
        "NOT_CONNECTED",
        "the event stream is reconnecting from the stored cursor; wait for it before submitting",
      );
    }
    if (session.connection !== "connected" && session.connection !== "running") {
      throw new StudioError(
        "NOT_CONNECTED",
        `the studio is ${session.connection}: ${session.reason}`,
      );
    }

    const binding = await this.ensureModeThread(session, input.mode);
    const posture = postureFor(input.mode, session.profile);
    const operationKey = `op-${randomUUID()}`;
    session.submitting = true;
    session.lastMode = input.mode;
    this.push(session, "submission", "sending");
    try {
      const receipt = await session.adapter.submitTurn({
        threadId: binding.engineThreadId,
        prompt,
        operationKey,
        requested: {
          provider: session.profile.provider,
          model: session.profile.model,
          ...(session.profile.reasoningEffort
            ? { reasoningEffort: session.profile.reasoningEffort }
            : {}),
          permissionPosture: posture.permissionPosture,
        },
        autoApprove: posture.autoApprove,
        allowShell: posture.allowShell,
        trustMode: posture.trustMode,
      });
      session.lastSubmissionKey = operationKey;

      let outcome: StudioSubmitOutcome = "rejected";
      let reconciliation: StudioSubmitResult["reconciliation"] = null;
      let turnId = receipt.turnId;
      let guidance = receipt.guidance;

      if (receipt.accepted && receipt.turnId) {
        outcome = "accepted";
        this.activate(session, binding, receipt.turnId, receipt.submission.status, operationKey);
        await this.startPump(session, binding);
      } else if (receipt.outcomeUnknown) {
        outcome = "outcome_unknown";
        // Read-only lookup only. A possibly accepted write is never resent.
        try {
          const resolved = await session.adapter.reconcileSubmission({
            submission: receipt.submission,
          });
          reconciliation = {
            status: resolved.status,
            turnId: resolved.turnId,
            evidence: resolved.evidence,
            guidance: resolved.guidance,
          };
          guidance = resolved.guidance ?? guidance;
          if (resolved.turnId && resolved.status !== "outcome_unknown") {
            outcome = "accepted";
            turnId = resolved.turnId;
            this.activate(session, binding, resolved.turnId, resolved.status, operationKey);
            await this.startPump(session, binding);
          }
        } catch (error) {
          this.diagnose(session, `reconciliation did not answer: ${errorMessage(error)}`);
        }
      } else {
        this.diagnose(
          session,
          `the runtime rejected the turn (${receipt.submission.status})${
            receipt.submission.note ? `: ${receipt.submission.note}` : ""
          }`,
        );
      }

      this.push(session, "submission", outcome);
      return {
        outcome,
        operationKey,
        turnId,
        note: receipt.submission.note ?? null,
        guidance,
        reconciliation,
        snapshot: await this.snapshot(projectId),
      };
    } finally {
      session.submitting = false;
    }
  }

  private activate(
    session: StudioSession,
    binding: ModeBinding,
    turnId: TurnId,
    status: string,
    operationKey: string,
  ): void {
    session.active = { turnId, binding };
    this.setConnection(session, "running", "a turn is active");
    void this.store
      .upsertTurn({
        id: turnId,
        threadId: binding.localThreadId,
        status,
        provider: session.profile.provider,
        model: session.profile.model,
        permissionPosture: null,
        startedAt: this.now().toISOString(),
        endedAt: null,
      })
      .catch((error: unknown) =>
        this.diagnose(session, `turn projection was not stored: ${errorMessage(error)}`),
      );
    try {
      this.work.begin({
        task: { id: operationKey, workspace: session.project.canonicalPath },
        turnId,
      });
    } catch (error) {
      this.diagnose(session, `work controller refused the turn: ${errorMessage(error)}`);
    }
  }

  // ------------------------------------------------------------------ events

  private async startPump(session: StudioSession, binding: ModeBinding): Promise<void> {
    if (session.pumpActive && session.pumpKey === binding.engineThreadId) return;
    await this.stopPump(session);
    session.pumpKey = binding.engineThreadId;
    session.pumpActive = true;
    session.pump = this.runPump(session, binding).finally(() => {
      session.pumpActive = false;
      session.pump = null;
    });
  }

  private async stopPump(session: StudioSession | null): Promise<void> {
    if (!session) return;
    session.abort?.abort();
    session.abort = null;
    const pending = session.pump;
    if (pending) {
      try {
        await pending;
      } catch {
        // The pump reports its own failure; stopping it is not an error.
      }
    }
    session.pump = null;
    session.pumpActive = false;
    session.pumpKey = null;
  }

  private async runPump(session: StudioSession, binding: ModeBinding): Promise<void> {
    let attempts = 0;
    while (!session.stopped && !this.closed) {
      const since = await this.store.getCursor(binding.localThreadId);
      const controller = new AbortController();
      session.abort = controller;
      let sawEvent = false;
      try {
        for await (const item of session.adapter.subscribe({
          threadId: binding.engineThreadId,
          sinceSeq: since,
          signal: controller.signal,
        })) {
          if (session.stopped || controller.signal.aborted) return;
          if (item.type === "event") {
            sawEvent = true;
            attempts = 0;
            const terminal = await this.ingest(session, binding, item.event);
            if (terminal) return;
          } else if (item.type === "diagnostic") {
            this.diagnose(session, `stream diagnostic: ${item.reason}`);
          } else if (item.type === "end") {
            break;
          }
        }
      } catch (error) {
        if (session.stopped || controller.signal.aborted) return;
        if (isFatalStreamError(error)) {
          this.fail(session, "stream_failed", errorMessage(error));
          return;
        }
        this.diagnose(session, `event stream broke: ${errorMessage(error)}`);
      } finally {
        if (session.abort === controller) session.abort = null;
      }
      if (session.stopped || this.closed) return;
      if (!session.active) return;
      attempts += sawEvent ? 1 : 2;
      if (attempts > this.reconnectAttempts) {
        this.fail(
          session,
          "stream_unstable",
          `the event stream ended ${attempts} times while the turn was still active`,
        );
        return;
      }
      this.setConnection(
        session,
        "reconnecting",
        "the event stream ended while the turn is active; reconnecting from the stored cursor",
      );
      await this.sleep(
        Math.min(this.reconnectBaseMs * 2 ** Math.max(0, attempts - 1), this.reconnectMaxMs),
      );
    }
  }

  /** Store one engine event, then update projections. Returns true on terminal. */
  private async ingest(
    session: StudioSession,
    binding: ModeBinding,
    event: EventEnvelope,
  ): Promise<boolean> {
    if (event.thread_id !== binding.engineThreadId) {
      this.diagnose(
        session,
        `ignored an event for ${event.thread_id}; this studio is bound to ${binding.engineThreadId}`,
      );
      return false;
    }
    const stored = await this.store.recordEvent({
      threadId: binding.localThreadId,
      seq: event.seq,
      kind: event.kind,
      payload: event.payload,
      timestamp: event.timestamp,
    });
    if (!stored.recorded) return false;
    this.push(session, "event", "recorded", {
      seq: event.seq,
      eventKind: event.kind,
      turnId: event.turn_id ?? null,
    });

    const pending = pendingInputFor(event.kind);
    if (pending !== null) {
      session.pendingInput = pending;
      this.diagnose(session, pending);
      this.push(session, "control", "pending_input");
      return false;
    }
    if (event.kind === "approval.decided" || event.kind === "user_input.answered") {
      session.pendingInput = null;
      this.push(session, "control", "input_answered");
      return false;
    }
    if (terminalStatus(event.kind) !== null) {
      await this.finishTurn(session, binding, event);
      return true;
    }
    if (event.kind === "turn.started" && event.turn_id && !session.active) {
      session.active = { turnId: event.turn_id, binding };
      try {
        this.work.begin({
          task: { id: `turn:${event.turn_id}`, workspace: session.project.canonicalPath },
          turnId: event.turn_id,
        });
      } catch (error) {
        this.diagnose(session, `work controller refused the turn: ${errorMessage(error)}`);
      }
      this.setConnection(session, "running", "a turn is active");
    }
    if (!isKnownEventKind(event.kind) && pendingInputFor(event.kind) === null) {
      this.diagnose(
        session,
        `Event "${event.kind}" is stored and inspectable but this build does not project it.`,
      );
    }
    return false;
  }

  private async finishTurn(
    session: StudioSession,
    binding: ModeBinding,
    event: EventEnvelope,
  ): Promise<void> {
    const status = terminalStatus(event.kind) ?? "failed";
    const turnId = event.turn_id ?? session.active?.turnId ?? null;
    let effective: StudioSnapshot["profile"]["effective"] = null;
    let turnRecord = null;
    try {
      const history = await session.adapter.readHistory({ threadId: binding.engineThreadId });
      turnRecord = turnId ? (history.turns.find((turn) => turn.id === turnId) ?? null) : null;
      if (turnRecord) {
        await this.store.upsertTurn({
          id: turnRecord.id,
          threadId: binding.localThreadId,
          status: turnRecord.status,
          provider: turnRecord.effectiveProvider,
          model: turnRecord.effectiveModel,
          permissionPosture: turnRecord.permissionPosture,
          startedAt: this.now().toISOString(),
          endedAt: this.now().toISOString(),
        });
        if (turnRecord.effectiveProvider && turnRecord.effectiveModel) {
          const posture = postureFor(session.lastMode ?? "work", session.profile);
          try {
            const observed = await session.adapter.getEffectiveProfile({
              threadId: binding.engineThreadId,
              turnId: turnRecord.id,
              requested: {
                provider: session.profile.provider,
                model: session.profile.model,
                permissionPosture: posture.permissionPosture,
              },
            });
            effective = {
              provider: observed.effective.provider,
              model: observed.effective.model,
              permissionPosture: observed.effective.permissionPosture,
              usedFallback: observed.usedFallback,
            };
            session.effective = effective;
            session.effectiveTurnId = turnRecord.id;
          } catch (error) {
            this.diagnose(
              session,
              `effective profile could not be verified: ${errorMessage(error)}`,
            );
          }
        }
        await this.recordUsage(session, binding, turnRecord, event.timestamp);
      }
    } catch (error) {
      this.diagnose(session, `history did not answer after ${status}: ${errorMessage(error)}`);
    }

    if (session.lastSubmissionKey) {
      try {
        const submission = await this.store.getSubmission(session.lastSubmissionKey);
        if (submission) {
          await this.store.putSubmission(
            {
              ...submission,
              turnId: (turnRecord?.id ?? turnId ?? submission.turnId) as TurnId | null,
              status,
              reconciled: true,
            },
            session.projectId,
          );
        }
      } catch (error) {
        this.diagnose(session, `submission receipt was not updated: ${errorMessage(error)}`);
      }
    }

    session.active = null;
    session.pendingInput = null;
    this.work.taskFinished();
    if (status === "failed") {
      const payload = (event.payload ?? {}) as { reason?: unknown; error?: unknown };
      const reason =
        typeof payload.reason === "string"
          ? payload.reason
          : typeof payload.error === "string"
            ? payload.error
            : "the engine reported the turn as failed";
      this.diagnose(session, `turn failed: ${reason}`);
    }
    if (!session.stopped) {
      this.setConnection(session, "connected", `the turn ${status}`);
    }
    this.push(session, "submission", status, {
      eventKind: event.kind,
      turnId: turnRecord?.id ?? turnId ?? null,
    });
  }

  private async recordUsage(
    session: StudioSession,
    binding: ModeBinding,
    turn: {
      id: TurnId;
      effectiveProvider: string | null;
      effectiveModel: string | null;
      usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        cachedTokens: number | null;
        reasoningTokens: number | null;
      } | null;
    },
    timestamp: string,
  ): Promise<void> {
    if (session.usageRecorded.has(turn.id)) return;
    if (!turn.usage) {
      session.usageRecorded.add(turn.id);
      return;
    }
    const provider = turn.effectiveProvider ?? session.profile.provider;
    const model = turn.effectiveModel ?? session.profile.model;
    let costUsd: number | null = null;
    let costComplete = false;
    try {
      const since = new Date(Date.parse(timestamp) - 60_000).toISOString();
      const report = await session.adapter.readUsage({ since, groupBy: "thread" });
      const bucket = report.buckets.find((entry) => entry.key === binding.engineThreadId);
      if (bucket && bucket.costComplete) {
        costUsd = bucket.costUsd;
        costComplete = true;
      }
    } catch (error) {
      this.diagnose(
        session,
        `usage cost could not be read; it stays unknown: ${errorMessage(error)}`,
      );
    }
    try {
      await this.store.recordUsage({
        projectId: session.projectId,
        threadId: binding.localThreadId,
        turnId: turn.id,
        provider,
        model,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cachedTokens: turn.usage.cachedTokens,
        reasoningTokens: turn.usage.reasoningTokens,
        costUsd,
        costComplete,
        capturedAt: this.now().toISOString(),
      });
      session.usageRecorded.add(turn.id);
    } catch (error) {
      this.diagnose(session, `usage was not stored: ${errorMessage(error)}`);
    }
  }

  // ----------------------------------------------------------------- control

  async interrupt(projectId: ProjectId): Promise<StudioActionResult> {
    const session = this.requireSession(projectId);
    const transition = await this.work.interruptNow();
    if (transition.receipt && transition.receipt.interrupted && session.lastSubmissionKey) {
      const submission = await this.store.getSubmission(session.lastSubmissionKey);
      if (submission) {
        await this.store.putSubmission(
          { ...submission, status: "interrupted", reconciled: true, note: transition.note },
          session.projectId,
        );
      }
    }
    this.push(
      session,
      "control",
      transition.confirmed ? "interrupt_confirmed" : "interrupt_unconfirmed",
    );
    return {
      action: "interrupt_now",
      note: transition.note,
      confirmed: transition.receipt ? transition.confirmed : null,
      uncertain: transition.uncertain,
      stopped: null,
      survivors: [],
      rollback: "not_promised",
      snapshot: await this.snapshot(projectId),
    };
  }

  async pauseAfterTask(projectId: ProjectId): Promise<StudioActionResult> {
    const transition = this.work.pauseAfterTask();
    const session = this.active?.projectId === projectId ? this.active : null;
    if (session) this.push(session, "control", "pause_after_task");
    return {
      action: "pause_after_task",
      note: transition.note,
      confirmed: null,
      uncertain: false,
      stopped: null,
      survivors: [],
      rollback: "not_promised",
      snapshot: await this.snapshot(projectId),
    };
  }

  resumeQueue(projectId: ProjectId): Promise<StudioActionResult> {
    this.work.resumeQueue();
    this.pushControl(projectId, "queue_resumed");
    return this.snapshot(projectId).then((snapshot) => ({
      action: "resume_queue",
      note: "the queue boundary is cleared; new work may start",
      confirmed: null,
      uncertain: false,
      stopped: null,
      survivors: [],
      rollback: "not_promised",
      snapshot,
    }));
  }

  async cancelQueued(projectId: ProjectId): Promise<StudioActionResult> {
    const transition = this.work.cancelQueued();
    const session = this.active?.projectId === projectId ? this.active : null;
    if (session) this.push(session, "control", "cancel_queued");
    return {
      action: "cancel_queued",
      note: transition.note,
      confirmed: null,
      uncertain: false,
      stopped: null,
      survivors: [],
      rollback: "not_promised",
      snapshot: await this.snapshot(projectId),
    };
  }

  /**
   * Retry the read-only operation lookup after an unclear submission. This is
   * reconciliation, not a resend: no turn is submitted on this path.
   */
  async reconcile(projectId: ProjectId): Promise<StudioReconcileResult> {
    if (!this.active || this.active.projectId !== projectId || this.active.stopped) {
      await this.start(projectId);
    }
    const session = this.requireSession(projectId);
    if (session.connection === "failed") {
      throw new StudioError("RUNTIME_UNAVAILABLE", session.reason);
    }
    const key =
      session.lastSubmissionKey ??
      (await this.store.listSubmissions(projectId, 1))[0]?.operationKey ??
      null;
    if (!key) {
      throw new StudioError("INVALID_INPUT", "no submission is stored for this project");
    }
    const submission = await this.store.getSubmission(key);
    if (!submission) {
      throw new StudioError("INVALID_INPUT", "the stored submission record is missing");
    }
    const result = await session.adapter.reconcileSubmission({ submission });
    const binding = session.active?.binding ?? this.latestBinding(session);
    if (binding && result.turnId && result.status !== "outcome_unknown" && !session.active) {
      this.activate(session, binding, result.turnId, result.status, key);
      await this.startPump(session, binding);
    }
    this.push(session, "submission", result.status);
    return {
      status: result.status,
      turnId: result.turnId,
      evidence: result.evidence,
      guidance: result.guidance,
      snapshot: await this.snapshot(projectId),
    };
  }

  async stop(projectId: ProjectId): Promise<StudioActionResult> {
    const session = this.active?.projectId === projectId ? this.active : null;
    const endpoint = session ? this.supervisor.endpoint() : null;
    const notes: string[] = [];
    let interrupted = false;
    let uncertain = false;
    if (session?.active) {
      const transition = await this.work.interruptNow();
      interrupted = transition.confirmed;
      uncertain = transition.uncertain;
      notes.push(transition.note);
    }
    let stopped: boolean | null = null;
    let survivors: number[] = [];
    if (session) {
      session.stopped = true;
      await this.stopPump(session);
    }
    if (this.supervisor.status().state !== "stopped") {
      try {
        const receipt = await this.supervisor.stopOwned("studio_stop", { graceMs: 8_000 });
        stopped = receipt.state === "stopped";
        survivors = receipt.survivors;
        notes.push(
          stopped
            ? `runtime ${receipt.via} stop confirmed${receipt.escalated ? " after forced escalation" : ""}`
            : `runtime stop incomplete: ${receipt.survivors.length} survivor(s)`,
        );
        if (receipt.escalated) notes.push("forced termination is cleanup, not rollback");
      } catch (error) {
        stopped = false;
        notes.push(`runtime stop did not confirm: ${errorMessage(error)}`);
        uncertain = true;
      }
    } else {
      stopped = true;
      notes.push("no owned runtime was running");
    }
    if (session) {
      this.setConnection(session, "stopped", notes.join("; "));
      try {
        await this.store.setRuntimeBinding({
          projectId,
          workspace: session.project.rootPath,
          canonicalWorkspace: session.project.canonicalPath,
          executable: endpoint?.executable ?? "unknown",
          engineVersion: session.engine?.version ?? null,
          engineCommit: session.engine?.commit ?? null,
          port: null,
          state: stopped ? "stopped" : "failed",
          updatedAt: this.now().toISOString(),
        });
      } catch {
        // The runtime truth is already reported; a binding write failure is not a stop failure.
      }
    }
    return {
      action: "stop_runtime",
      note: notes.join("; "),
      confirmed: interrupted,
      uncertain,
      stopped,
      survivors,
      rollback: "not_promised",
      snapshot: await this.snapshot(projectId),
    };
  }

  /** Interrupt one owned active turn; the WorkController effect. */
  async interruptTurn(workspace: string, turnId: string): Promise<InterruptReceipt> {
    const session = this.active;
    if (!session || session.stopped) {
      return { interrupted: false, turn: null, note: "no live studio session is attached" };
    }
    if (session.project.canonicalPath !== workspace && session.project.rootPath !== workspace) {
      return {
        interrupted: false,
        turn: null,
        note: "the active turn belongs to a different workspace",
      };
    }
    const binding = session.active?.binding;
    if (!binding) {
      return { interrupted: false, turn: null, note: "no active turn to interrupt" };
    }
    try {
      const receipt = await session.adapter.interrupt({
        threadId: binding.engineThreadId,
        turnId: turnId as TurnId,
      });
      this.push(
        session,
        "control",
        receipt.interrupted ? "interrupt_confirmed" : "interrupt_unconfirmed",
      );
      return receipt;
    } catch (error) {
      this.diagnose(session, `interrupt did not answer: ${errorMessage(error)}`);
      return {
        interrupted: false,
        turn: null,
        note: `interrupt outcome unknown: ${errorMessage(error)}`,
      };
    }
  }

  /** Replay stored events from the beginning; duplicates are discarded, not re-run. */
  async replay(projectId: ProjectId): Promise<{
    ingested: number;
    duplicates: number;
    cursor: number;
  }> {
    const session = this.requireSession(projectId);
    const binding = session.active?.binding ?? this.latestBinding(session);
    if (!binding) {
      throw new StudioError("NOT_CONNECTED", "no engine thread is bound yet");
    }
    let ingested = 0;
    let duplicates = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      for await (const item of session.adapter.subscribe({
        threadId: binding.engineThreadId,
        sinceSeq: 0,
        signal: controller.signal,
      })) {
        if (item.type === "event") {
          if (item.event.thread_id !== binding.engineThreadId) {
            duplicates += 1;
            continue;
          }
          const before = await this.store.getCursor(binding.localThreadId);
          const stored = await this.store.recordEvent({
            threadId: binding.localThreadId,
            seq: item.event.seq,
            kind: item.event.kind,
            payload: item.event.payload,
            timestamp: item.event.timestamp,
          });
          const after = await this.store.getCursor(binding.localThreadId);
          if (stored.recorded && after > before) ingested += 1;
          else duplicates += 1;
        } else if (item.type === "end") {
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const cursor = await this.store.getCursor(binding.localThreadId);
    return { ingested, duplicates, cursor };
  }

  // ----------------------------------------------------------------- snapshot

  async snapshot(projectId: ProjectId): Promise<StudioSnapshot> {
    const project = await this.store.getProject(projectId, { includeRemoved: true });
    if (!project) {
      throw new StudioError("NOT_FOUND", "project is not in the catalog", { projectId });
    }
    const session = this.active?.projectId === projectId ? this.active : null;
    let profile: StudioSnapshot["profile"];
    if (session) {
      profile = profileView(
        session.profile,
        session.profileSource,
        session.effective,
        session.effectiveTurnId,
      );
    } else {
      const loaded = await loadExecutionProfile(this.store);
      profile = profileView(loaded.profile, loaded.source);
    }
    const usage = await this.store.summarizeUsage(projectId);
    const submissions = await this.store.listSubmissions(projectId, 1);
    const submissionKey = session?.lastSubmissionKey ?? submissions[0]?.operationKey ?? null;
    const submission = submissionKey
      ? await this.store.getSubmission(submissionKey).catch(() => null)
      : null;
    const work = this.work.snapshot();
    const status = this.supervisor.status();
    const connection = session
      ? {
          state: session.connection,
          reason: session.reason,
          since: session.since,
          port: session.port,
          engine: session.engine,
          owned: session.owned,
          external: session.external,
        }
      : {
          state: "not_started" as const,
          reason: stillWorkspace(status, project)
            ? "the runtime is running for this workspace; start the studio to attach"
            : status.state === "running"
              ? `the runtime is serving ${status.workspace ?? "another workspace"}`
              : `no studio session in this launch (runtime ${status.state})`,
          since: this.now().toISOString(),
          port: status.port,
          engine: status.engine
            ? { version: status.engine.version, commit: status.engine.commit }
            : null,
          owned: this.supervisor.isOwned(),
          external: status.external,
        };
    const block = this.submitBlock(session, project, status);
    return {
      projectId,
      connection,
      threadId:
        session?.bindings.work?.localThreadId ?? session?.bindings.plan?.localThreadId ?? null,
      engineThreadId: session?.active?.binding.engineThreadId ?? null,
      activeTurnId: session?.active?.turnId ?? null,
      lastMode: session?.lastMode ?? null,
      pauseAfterTask: work.pauseAfterTask,
      queued: work.queued.length,
      profile,
      cost: {
        observed: usage.observed,
        costUsd: usage.costUsd,
        costComplete: usage.costComplete,
        turns: usage.turns,
        label: !usage.observed
          ? "No usage recorded"
          : usage.costComplete
            ? `$${usage.costUsd.toFixed(4)} across ${usage.turns} turn${usage.turns === 1 ? "" : "s"}`
            : `At least $${usage.costUsd.toFixed(4)}; some turns are unpriced`,
      },
      submission: submission
        ? {
            operationKey: submission.operationKey,
            status: submission.status,
            turnId: submission.turnId,
            reconciled: submission.reconciled,
            note: submission.note ?? null,
            submittedAt: submission.submittedAt,
          }
        : null,
      diagnostics: session ? [...session.diagnostics] : [],
      pendingInput: session?.pendingInput ?? null,
      canSubmit: block === null,
      cannotSubmitReason: block,
      controls: {
        canInterrupt: session?.active !== null && session !== null,
        canPause:
          session !== null &&
          (session.connection === "connected" || session.connection === "running"),
        canCancelQueued: work.queued.length > 0,
        canStop:
          session !== null &&
          session.owned &&
          session.connection !== "stopped" &&
          session.connection !== "failed",
      },
    };
  }

  // ------------------------------------------------------------------ helpers

  private submitBlock(
    session: StudioSession | null,
    project: StoredProject,
    status: RuntimeStatus,
  ): string | null {
    if (!session) {
      if (status.state === "running" && !stillWorkspace(status, project)) {
        return `The single owned runtime is serving ${status.workspace ?? "another workspace"}. Stop it there before submitting here.`;
      }
      return null;
    }
    if (session.connection === "failed") return session.reason;
    if (session.submitting) return "A submission is being accepted.";
    if (session.active) return "One mutating turn per workspace is active; interrupt it or wait.";
    if (session.connection === "reconnecting") {
      return "The event stream is reconnecting from the stored cursor.";
    }
    if (session.connection !== "connected" && session.connection !== "running") {
      return `The studio is ${session.connection}: ${session.reason}`;
    }
    return null;
  }

  private async ensureModeThread(session: StudioSession, mode: StudioMode): Promise<ModeBinding> {
    const existing = session.bindings[mode];
    if (existing) return existing;
    const localThreadId = threadRowId(session.projectId, mode);
    const threads = await this.store.listThreads(session.projectId);
    const row = threads.find((thread) => thread.id === localThreadId);
    if (row?.engineThreadId) {
      const parsed = ThreadIdSchema.safeParse(row.engineThreadId);
      if (parsed.success) {
        const binding: ModeBinding = { localThreadId, engineThreadId: parsed.data };
        session.bindings[mode] = binding;
        return binding;
      }
    }
    const posture: ModePosture = postureFor(mode, session.profile);
    const thread = await session.adapter.createOrOpenThread({
      workspace: session.project.canonicalPath,
      title: `${session.project.name} — ${mode}`,
      operationKey: threadKey(session.projectId, mode),
      execute: {
        autoApprove: posture.autoApprove,
        trustMode: posture.trustMode,
        allowShell: posture.allowShell,
      },
    });
    await this.store.upsertThread({
      id: localThreadId,
      projectId: session.projectId,
      engineThreadId: thread.threadId,
      title: `${session.project.name} — ${mode}`,
    });
    const binding: ModeBinding = { localThreadId, engineThreadId: thread.threadId };
    session.bindings[mode] = binding;
    return binding;
  }

  private async ensureShellThread(project: StoredProject): Promise<void> {
    const threads = await this.store.listThreads(project.id);
    if (threads.length > 0) return;
    await this.store.upsertThread({
      id: shellThreadId(project.id),
      projectId: project.id,
      title: "Local shell thread",
    });
  }

  private latestBinding(session: StudioSession): ModeBinding | null {
    return (
      session.bindings[session.lastMode ?? "work"] ??
      session.bindings.work ??
      session.bindings.plan ??
      null
    );
  }

  private requireSession(projectId: ProjectId): StudioSession {
    const session = this.active?.projectId === projectId ? this.active : null;
    if (!session) {
      throw new StudioError("NOT_CONNECTED", "the studio has not started for this project", {
        projectId,
      });
    }
    return session;
  }

  private setConnection(
    session: StudioSession,
    state: StudioConnectionState,
    reason: string,
  ): void {
    session.connection = state;
    session.reason = reason;
    session.since = this.now().toISOString();
    this.push(session, "connection", state);
  }

  private fail(session: StudioSession, reason: string, message: string): void {
    session.reason = message;
    session.diagnostics = bounded([...session.diagnostics, `${reason}: ${message}`]);
    this.setConnection(session, "failed", message);
  }

  private diagnose(session: StudioSession, message: string): void {
    if (session.diagnostics.includes(message)) return;
    session.diagnostics = bounded([...session.diagnostics, message]);
  }

  private push(
    session: StudioSession,
    kind: StudioPush["kind"],
    state: string,
    extra: Omit<StudioPush, "projectId" | "kind" | "state"> = {},
  ): void {
    this.pushControl(session.projectId, state, kind, extra);
  }

  private pushControl(
    projectId: ProjectId,
    state: string,
    kind: StudioPush["kind"] = "control",
    extra: Omit<StudioPush, "projectId" | "kind" | "state"> = {},
  ): void {
    try {
      this.notify({ projectId, kind, state, ...extra });
    } catch {
      // A renderer that went away must not break ingestion.
    }
  }

  /** Stop all stream work; used when the app quits or state closes. */
  async close(): Promise<void> {
    this.closed = true;
    const session = this.active;
    if (session) {
      session.stopped = true;
      await this.stopPump(session);
    }
    this.active = null;
  }

  /** Testing/verification helper: which project holds the session. */
  activeProjectId(): ProjectId | null {
    return this.active?.projectId ?? null;
  }

  profile(): { profile: ExecutionProfile; source: "configured" | "default" } | null {
    return this.active ? { profile: this.active.profile, source: this.active.profileSource } : null;
  }
}

function bounded(values: string[]): string[] {
  return values.length > MAX_DIAGNOSTICS ? values.slice(values.length - MAX_DIAGNOSTICS) : values;
}
