import { createHash, randomUUID } from "node:crypto";
import type { EventEnvelope, ProjectId, ThreadId, TurnId } from "../../shared/contracts";
import { ThreadId as ThreadIdSchema } from "../../shared/contracts";
import { eventItemId, isEnginePlumbingKind, isKnownEventKind } from "../../shared/contracts/events";
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
import { ChangeLedger, type ChangeEngineAccess } from "./changes";
import { WorkController } from "./control";
import { CostLedger } from "./costs";
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
  newAdapter?: (
    transport: RuntimeTransport,
    projectId: ProjectId,
    workspace: string,
  ) => EngineAdapter;
  notify?: (push: StudioPush) => void;
  /**
   * Called when an engine turn reaches a terminal event. It is how the work
   * board clears the dispatch→turn link, so a later interrupt cannot be
   * attributed to a task whose turn already finished.
   */
  onTurnFinished?: (projectId: ProjectId, turnId: string) => Promise<void> | void;
  /** P12 cost ledger. Optional so a test can inject its own rate-card world. */
  ledger?: CostLedger;
  /** P13 change receipts. Optional so tests can omit capture. */
  changes?: ChangeLedger;
  now?: () => Date;
  reconnect?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * How long the event stream may stay completely silent before Mona treats
     * it as stalled and reconnects. The engine sends `stream.progress`
     * keepalives, so only a dead or wedged peer reaches this.
     */
    idleTimeoutMs?: number;
  };
}

export type StudioErrorCode =
  | "NOT_FOUND"
  | "STUDIO_BUSY"
  | "TURN_ACTIVE"
  | "NOT_CONNECTED"
  | "INVALID_INPUT"
  | "RUNTIME_UNAVAILABLE"
  | "UNSUPPORTED_INPUT"
  | "BUDGET_STOP";

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
  /**
   * Null only for a conversation created while the studio was disconnected or
   * the engine thread could not be created yet. The next submission creates it
   * with the same deterministic operation key.
   */
  engineThreadId: ThreadId | null;
  mode: StudioMode;
  generation: number;
}

/** One conversation switch, as the command dispatcher reports it. */
export interface StudioCommandResult {
  status: "completed" | "deferred" | "busy" | "failed";
  note: string;
  thread: {
    mode: StudioMode;
    generation: number;
    localThreadId: string;
    engineThreadId: string | null;
    previousLocalThreadId: string | null;
    previousEngineThreadId: string | null;
  } | null;
  turnId: string | null;
  duplicate: boolean;
  snapshot: StudioSnapshot;
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
  /**
   * The `since_seq` a replay should use, or null to resume from the accepted
   * cursor. Set only when the engine reports that it skipped past this thread.
   */
  replaySince: number | null;
  /** Holes this session already asked the engine to replay and cannot fill. */
  skippedGaps: Set<number>;
  /** The engine-reported hole this connection was opened to replay, if any. */
  pendingGap: { from: number; to: number } | null;
}

const MAX_DIAGNOSTICS = 12;
const MAX_PROMPT = 100_000;

function rangeLabel(gap: { from: number; to: number }): string {
  return gap.from === gap.to ? String(gap.from) : `${gap.from}–${gap.to}`;
}

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

function threadRowId(projectId: ProjectId, mode: StudioMode, generation = 0): string {
  return `thr_${createHash("sha256")
    .update(`${projectId}:engine:${mode}:${generation}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * The id a project's first conversation used before schema v11. A project that
 * already has a conversation must keep it: the new generation-aware id is
 * different, so adoption looks for this exact legacy id rather than assuming
 * generation 0's current formula.
 */
function legacyThreadRowId(projectId: ProjectId, mode: StudioMode): string {
  return `thr_${createHash("sha256")
    .update(`${projectId}:engine:${mode}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function shellThreadId(projectId: ProjectId): string {
  return `thr_${createHash("sha256").update(projectId).digest("hex").slice(0, 16)}`;
}

function threadKey(projectId: ProjectId, mode: StudioMode, generation = 0): string {
  return `thread-${projectId}-${mode}-${generation}`;
}

function threadTitle(projectName: string, mode: StudioMode, generation: number): string {
  return generation === 0
    ? `${projectName} — ${mode}`
    : `${projectName} — ${mode} ${generation + 1}`;
}

function asThreadIdOrNull(value: string): ThreadId | null {
  const parsed = ThreadIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function storedThreadReceipt(value: unknown): StudioCommandResult["thread"] {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== "plan" && mode !== "work") return null;
  if (typeof record.localThreadId !== "string" || record.localThreadId.length === 0) return null;
  if (typeof record.generation !== "number" || !Number.isInteger(record.generation)) return null;
  const engine =
    typeof record.engineThreadId === "string" ? asThreadIdOrNull(record.engineThreadId) : null;
  return {
    mode,
    generation: record.generation,
    localThreadId: record.localThreadId,
    engineThreadId: engine,
    previousLocalThreadId:
      typeof record.previousLocalThreadId === "string" ? record.previousLocalThreadId : null,
    previousEngineThreadId:
      typeof record.previousEngineThreadId === "string"
        ? asThreadIdOrNull(record.previousEngineThreadId)
        : null,
  };
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
  private readonly newAdapter: (
    transport: RuntimeTransport,
    projectId: ProjectId,
    workspace: string,
  ) => EngineAdapter;
  private readonly notify: (push: StudioPush) => void;
  private readonly now: () => Date;
  private readonly reconnectAttempts: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly streamIdleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onTurnFinished:
    ((projectId: ProjectId, turnId: string) => Promise<void> | void) | null;
  private readonly ledger: CostLedger;
  private readonly changes: ChangeLedger | null;
  private active: StudioSession | null = null;
  private closed = false;

  constructor(options: WorkStudioOptions) {
    this.store = options.store;
    this.supervisor = options.supervisor;
    this.work = options.work;
    this.ledger = options.ledger ?? new CostLedger(options.store);
    this.changes = options.changes ?? null;
    this.newAdapter =
      options.newAdapter ??
      ((transport, projectId, workspace) =>
        new CodewhaleAdapter({
          transport,
          store: new SqliteSubmissionStore(options.store, projectId),
          workspace,
        }));
    this.notify = options.notify ?? (() => undefined);
    this.onTurnFinished = options.onTurnFinished ?? null;
    this.now = options.now ?? (() => new Date());
    this.reconnectAttempts = options.reconnect?.attempts ?? 6;
    this.reconnectBaseMs = options.reconnect?.baseDelayMs ?? 250;
    this.reconnectMaxMs = options.reconnect?.maxDelayMs ?? 4_000;
    this.streamIdleMs = options.reconnect?.idleTimeoutMs ?? 120_000;
    this.sleep =
      options.reconnect?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // --------------------------------------------------------------- lifecycle

  async start(projectId: ProjectId): Promise<StudioSnapshot> {
    const existing = this.active;
    if (existing && existing.projectId === projectId && !existing.stopped) {
      const looksLive =
        existing.connection === "connected" ||
        existing.connection === "running" ||
        existing.connection === "reconnecting";
      if (looksLive) {
        // A session can *claim* to be live while its pump is gone: the stream
        // ended, the reconnect budget was spent, or a stall killed the reader.
        // Returning early there made "Reconnect" a no-op, which is exactly how
        // a broken turn stayed broken across a reconnect.
        const binding = existing.active?.binding ?? this.latestBinding(existing);
        const pumping =
          existing.pumpActive === true && existing.pumpKey === (binding?.engineThreadId ?? null);
        if (pumping) return this.snapshot(projectId);
        if (!pumping) {
          this.diagnose(
            existing,
            "the previous stream reader is gone; re-attaching to the engine event stream",
          );
        }
        if (binding) {
          this.setConnection(existing, "reconnecting", "re-attaching to the engine event stream");
          await this.startPump(existing, binding);
          return this.snapshot(projectId);
        }
        // No binding at all: fall through and build a fresh session.
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
      replaySince: null,
      skippedGaps: new Set(),
      pendingGap: null,
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
    session.adapter = this.newAdapter(transport, projectId, project.canonicalPath);
    // An injected adapter factory keeps its own construction, so bind the
    // workspace fence here as well: engine reads must stay inside this project.
    session.adapter.scopeToWorkspace?.(project.canonicalPath);
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

    // A user-set budget blocks the next dispatch only. It never interrupts an
    // in-flight turn, and an in-flight provider request can still complete.
    const gate = await this.ledger.dispatchGate(projectId, this.now().toISOString(), {
      activeTurn: false,
    });
    if (!gate.allowed) {
      throw new StudioError("BUDGET_STOP", gate.reasons.join(" "), {
        gate,
      });
    }

    const initial = await this.ensureModeThread(session, input.mode);
    const binding = await this.ensureEngineThread(session, initial);
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) {
      throw new StudioError("RUNTIME_UNAVAILABLE", "the engine thread could not be created");
    }
    const posture = postureFor(input.mode, session.profile);
    const operationKey = `op-${randomUUID()}`;
    session.submitting = true;
    session.lastMode = input.mode;
    this.push(session, "submission", "sending");
    try {
      const receipt = await session.adapter.submitTurn({
        threadId: engineThreadId,
        prompt,
        operationKey,
        requested: {
          provider: session.profile.provider,
          exactId: session.profile.exactId,
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
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) return;
    if (session.pumpActive && session.pumpKey === engineThreadId) return;
    await this.stopPump(session);
    session.pumpKey = engineThreadId;
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
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) return;
    let attempts = 0;
    while (!session.stopped && !this.closed) {
      // `since_seq` is exclusive: resuming from the accepted cursor asks for
      // "everything after what this thread already has". A replay rewinds to the
      // sequence that preceded a hole the engine itself reported, so the known
      // loss can be refilled. Contiguity is never the resume point — `seq` is a
      // single counter shared by every Runtime thread, so the next number after
      // a stored frame usually belongs to another thread, not to a lost frame.
      const replaySince = session.replaySince;
      const since = replaySince ?? (await this.store.getCursor(binding.localThreadId));
      // What this connection is meant to repair. Captured before the pass and
      // concluded after it: a replay's outcome is only knowable once the
      // connection that carried it has ended.
      const replayTarget = replaySince === null ? null : session.pendingGap;
      session.replaySince = null;
      session.pendingGap = null;
      const controller = new AbortController();
      session.abort = controller;
      let sawEvent = false;
      try {
        for await (const item of session.adapter.subscribe({
          threadId: engineThreadId,
          sinceSeq: since,
          signal: controller.signal,
          idleMs: this.streamIdleMs,
        })) {
          if (session.stopped || controller.signal.aborted) return;
          if (item.type === "event") {
            sawEvent = true;
            attempts = 0;
            const outcome = await this.ingest(session, binding, item.event);
            // A gap is resolved before a terminal event is honoured: if the
            // turn ended while frames were missing, returning here would end
            // the pump with a permanent hole in the record. The replay
            // re-delivers the terminal event, which then finalises the turn.
            if (outcome.rewind) {
              // Deliberate replay, not instability: the reconnect count stays
              // at zero so recovery cannot masquerade as a failing stream.
              attempts = 0;
              break;
            }
            if (outcome.terminal) break;
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

      // Conclude the repair pass honestly. The ledger shrinks as stored events
      // arrive, so it — not a guess — says whether the replay filled the hole.
      if (replayTarget) {
        const remaining = (await this.store.listEventGaps(binding.localThreadId)).filter(
          (gap) => gap.from <= replayTarget.to && gap.to >= replayTarget.from,
        );
        if (remaining.length > 0) {
          // The engine does not have these frames. Record that once and stop
          // asking, so a legitimate skip cannot loop the stream forever.
          session.skippedGaps.add(replayTarget.from);
          this.diagnose(
            session,
            `event sequence gap: ${rangeLabel(replayTarget)} was replayed and not returned; recorded as a gap the engine skips`,
          );
        } else {
          this.diagnose(
            session,
            `event sequence gap: ${rangeLabel(replayTarget)} was replayed and filled`,
          );
        }
      }

      // A hole reported during this pass still gets exactly one repair pass,
      // even if the turn already ended: the terminal frame is stored, but the
      // record has a hole and a replay is the only way to fill it.
      const repairPass = session.pendingGap !== null;
      // A quiet end with no active turn and no hole is a finished turn, not an
      // unstable stream. The repair pass re-opened the stream under
      // "reconnecting", so a completed turn must not be left looking like a
      // stream that is still trying to recover.
      if (!session.active && !repairPass) {
        if (session.connection === "reconnecting") {
          this.setConnection(session, "connected", "the replay finished; no turn is active");
        }
        return;
      }

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
        repairPass
          ? "replaying the events the engine reported skipping"
          : sawEvent
            ? "the event stream ended while the turn is active; reconnecting from the accepted cursor"
            : "the event stream went quiet without ending; reconnecting from the accepted cursor",
      );
      await this.sleep(
        Math.min(this.reconnectBaseMs * 2 ** Math.max(0, attempts - 1), this.reconnectMaxMs),
      );
    }
  }

  /**
   * Store one engine event, then update projections. `terminal` ends the pump;
   * `rewind` asks it to reconnect from the sequence before a hole the engine
   * reported, so that hole can be replayed.
   */
  private async ingest(
    session: StudioSession,
    binding: ModeBinding,
    event: EventEnvelope,
  ): Promise<{ terminal: boolean; rewind: boolean }> {
    let rewind = false;
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) {
      this.diagnose(
        session,
        `ignored an event for ${event.thread_id}; this conversation has no engine thread yet`,
      );
      return { terminal: false, rewind };
    }
    if (event.thread_id !== engineThreadId) {
      this.diagnose(
        session,
        `ignored an event for ${event.thread_id}; this studio is bound to ${engineThreadId}`,
      );
      return { terminal: false, rewind };
    }
    const before = await this.store.getCursor(binding.localThreadId);
    const previous = event.previous_seq;
    // Loss is what the engine says it delivered and we did not accept — never a
    // jump in `seq`, which is one global counter shared by every Runtime thread
    // and therefore fills with other threads' numbers. `previous_seq` on this
    // per-thread stream is the last sequence delivered for THIS thread.
    if (before > 0 && typeof previous === "number" && previous > before) {
      const gap = { from: before + 1, to: previous };
      // Recorded before the replay is attempted: if the process dies mid-repair
      // the loss stays a fact instead of vanishing with the attempt.
      await this.store.recordEventGap({ threadId: binding.localThreadId, ...gap });
      if (!session.skippedGaps.has(gap.from)) {
        session.replaySince = before;
        session.pendingGap = gap;
        rewind = true;
        this.diagnose(
          session,
          `event sequence gap: ${rangeLabel(gap)} was not received; reconnecting from ${before} to ask the engine to replay it`,
        );
      } else {
        this.diagnose(
          session,
          `event sequence gap: ${rangeLabel(gap)} is already recorded as a gap the engine skips`,
        );
      }
      this.push(session, "control", "sequence_gap", { seq: event.seq, ...gap });
    }
    const stored = await this.store.recordEvent({
      threadId: binding.localThreadId,
      seq: event.seq,
      kind: event.kind,
      payload: event.payload,
      timestamp: event.timestamp,
      turnId: event.turn_id ?? null,
      itemId: eventItemId(event),
    });
    if (!stored.recorded) return { terminal: false, rewind };
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
      return { terminal: false, rewind };
    }
    if (event.kind === "approval.decided" || event.kind === "user_input.answered") {
      session.pendingInput = null;
      this.push(session, "control", "input_answered");
      return { terminal: false, rewind };
    }
    if (event.kind === "turn.artifacts" && event.turn_id && this.changes) {
      try {
        await this.changes.captureArtifactsEvent({
          projectId: session.projectId,
          threadId: binding.localThreadId,
          engineThreadId,
          turnId: event.turn_id,
          payload: event.payload,
        });
      } catch (error) {
        this.diagnose(session, `turn artifacts were not captured: ${errorMessage(error)}`);
      }
      return { terminal: false, rewind };
    }
    if (terminalStatus(event.kind) !== null) {
      await this.finishTurn(session, binding, event);
      // A terminal event that arrived across a hole finalises the turn, but the
      // pump must still reconnect to fill the hole: reporting `terminal` here
      // would end the stream with a permanent gap in the record.
      return { terminal: !rewind, rewind };
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
    // Drift is a kind this build has never seen. A plumbing frame it knows
    // (a heartbeat, a usage row) is not drift, and diagnosing every one of them
    // would push real diagnostics out of the bounded ring.
    if (
      !isKnownEventKind(event.kind) &&
      !isEnginePlumbingKind(event.kind) &&
      pendingInputFor(event.kind) === null
    ) {
      this.diagnose(
        session,
        `Event "${event.kind}" is stored and inspectable but this build does not project it.`,
      );
    }
    return { terminal: false, rewind };
  }

  private async finishTurn(
    session: StudioSession,
    binding: ModeBinding,
    event: EventEnvelope,
  ): Promise<void> {
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) return;
    const status = terminalStatus(event.kind) ?? "failed";
    const turnId = event.turn_id ?? session.active?.turnId ?? null;
    let effective: StudioSnapshot["profile"]["effective"] = null;
    let turnRecord = null;
    try {
      const history = await session.adapter.readHistory({ threadId: engineThreadId });
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
              threadId: engineThreadId,
              turnId: turnRecord.id,
              requested: {
                provider: session.profile.provider,
                exactId: session.profile.exactId,
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

    if (this.changes && turnId) {
      try {
        await this.changes.captureTurn({
          projectId: session.projectId,
          threadId: binding.localThreadId,
          engineThreadId,
          turnId,
          adapter: session.adapter,
          payload: event.payload,
        });
      } catch (error) {
        this.diagnose(session, `the change receipt was not stored: ${errorMessage(error)}`);
      }
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
    if (turnId && this.onTurnFinished) {
      try {
        await this.onTurnFinished(session.projectId, turnId);
      } catch (error) {
        this.diagnose(session, `the task turn link was not cleared: ${errorMessage(error)}`);
      }
    }
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
        cacheMissTokens?: number | null;
        reasoningTokens: number | null;
      } | null;
    },
    _timestamp: string,
  ): Promise<void> {
    if (session.usageRecorded.has(turn.id)) return;
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) return;
    const provider = turn.effectiveProvider ?? session.profile.provider;
    const model = turn.effectiveModel ?? session.profile.model;
    // The engine's aggregate is cumulative for a stable window, so the ledger
    // converts it into an exact per-turn delta. A failed read stays unknown.
    let aggregate: { costUsd: number; costComplete: boolean } | null = null;
    try {
      const report = await session.adapter.readUsage({ groupBy: "thread" });
      const bucket = report.buckets.find((entry) => entry.key === engineThreadId);
      if (bucket) {
        aggregate = { costUsd: bucket.costUsd, costComplete: bucket.costComplete };
      }
    } catch (error) {
      this.diagnose(
        session,
        `usage cost could not be read; it stays unknown: ${errorMessage(error)}`,
      );
    }
    const thread = await this.store.getThread(binding.localThreadId);
    try {
      await this.ledger.recordTurn({
        projectId: session.projectId,
        threadId: binding.localThreadId,
        turnId: turn.id,
        provider,
        model,
        usage: turn.usage
          ? {
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
              cachedTokens: turn.usage.cachedTokens,
              cacheMissTokens: turn.usage.cacheMissTokens ?? null,
              reasoningTokens: turn.usage.reasoningTokens,
            }
          : null,
        capturedAt: this.now().toISOString(),
        windowSince: thread?.createdAt ?? session.since,
        aggregate,
      });
      session.usageRecorded.add(turn.id);
    } catch (error) {
      this.diagnose(session, `usage was not stored: ${errorMessage(error)}`);
    }
  }

  // ----------------------------------------------------------------- control

  async interrupt(projectId: ProjectId): Promise<StudioActionResult> {
    const session = this.requireSession(projectId);
    // Capture the target before the interrupt: the receipt names the turn that
    // was actually asked to stop, so a caller never has to guess.
    const targetTurnId = session.active?.turnId ?? this.work.snapshot().active?.turnId ?? null;
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
      turnId: targetTurnId,
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
      turnId: null,
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
      turnId: null,
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
      turnId: null,
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
      turnId: null,
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
    if (!binding?.engineThreadId) {
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
    if (!binding?.engineThreadId) {
      throw new StudioError("NOT_CONNECTED", "no engine thread is bound yet");
    }
    const engineThreadId = binding.engineThreadId;
    let ingested = 0;
    let duplicates = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      for await (const item of session.adapter.subscribe({
        threadId: engineThreadId,
        sinceSeq: 0,
        signal: controller.signal,
      })) {
        if (item.type === "event") {
          if (item.event.thread_id !== engineThreadId) {
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
    // Silence and holes are read from the store, so they are facts about this
    // thread rather than a guess from the last push.
    const lastEvent = await this.store
      .lastEventAt(
        session?.active?.binding.localThreadId ??
          session?.bindings[session.lastMode ?? "work"]?.localThreadId ??
          "",
      )
      .catch(() => null);
    const gaps = await this.store
      .eventGaps(
        session?.active?.binding.localThreadId ??
          session?.bindings[session.lastMode ?? "work"]?.localThreadId ??
          "",
      )
      .catch(() => null);
    const silence =
      lastEvent === null ? null : Math.max(0, this.now().getTime() - Date.parse(lastEvent));
    const connection = session
      ? {
          state: session.connection,
          reason: session.reason,
          since: session.since,
          port: session.port,
          engine: session.engine,
          owned: session.owned,
          external: session.external,
          lastEventAt: lastEvent,
          silentForMs: silence,
          missing: (gaps?.gaps ?? []).map(([from, to]) => ({ from, to })),
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
          lastEventAt: null,
          silentForMs: null,
          missing: [],
        };
    const block = this.submitBlock(session, project, status);
    return {
      projectId,
      connection,
      // The conversation the user is in is the one their last mode selected:
      // `/new` can switch either mode, so preferring `work` would mislabel a
      // plan conversation as current.
      threadId:
        session?.bindings[session?.lastMode ?? "work"]?.localThreadId ??
        session?.bindings.work?.localThreadId ??
        session?.bindings.plan?.localThreadId ??
        null,
      engineThreadId:
        session?.active?.binding.engineThreadId ??
        session?.bindings[session?.lastMode ?? "work"]?.engineThreadId ??
        null,
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

  /**
   * Bind the studio to the newest conversation of this mode. A project's older
   * generations stay in the store, so restarting the app resumes the
   * conversation the user was actually in — not a fresh one, and not a guess
   * made from `updated_at` (which an old thread can win).
   */
  private async ensureModeThread(session: StudioSession, mode: StudioMode): Promise<ModeBinding> {
    const existing = session.bindings[mode];
    if (existing) return existing;
    const threads = await this.conversationThreads(session.projectId, mode);
    const newest = threads[0];
    if (newest) {
      const parsed = newest.engineThreadId ? ThreadIdSchema.safeParse(newest.engineThreadId) : null;
      const binding: ModeBinding = {
        localThreadId: newest.id,
        engineThreadId: parsed?.success ? parsed.data : null,
        mode,
        generation: newest.generation,
      };
      session.bindings[mode] = binding;
      return binding;
    }
    const generation = 0;
    const localThreadId = threadRowId(session.projectId, mode, generation);
    const title = threadTitle(session.project.name, mode, generation);
    const posture: ModePosture = postureFor(mode, session.profile);
    const thread = await session.adapter.createOrOpenThread({
      workspace: session.project.canonicalPath,
      title,
      operationKey: threadKey(session.projectId, mode, generation),
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
      title,
      mode,
      generation,
    });
    const binding: ModeBinding = {
      localThreadId,
      engineThreadId: thread.threadId,
      mode,
      generation,
    };
    session.bindings[mode] = binding;
    return binding;
  }

  /**
   * A thread created without an engine identity (offline, or a failed create)
   * gets one here, with the operation key derived from its generation. The key
   * is stable, so a lost response cannot create a second engine conversation.
   */
  private async ensureEngineThread(
    session: StudioSession,
    binding: ModeBinding,
  ): Promise<ModeBinding> {
    if (binding.engineThreadId) return binding;
    const title = threadTitle(session.project.name, binding.mode, binding.generation);
    const posture: ModePosture = postureFor(binding.mode, session.profile);
    const thread = await session.adapter.createOrOpenThread({
      workspace: session.project.canonicalPath,
      title,
      operationKey: threadKey(session.projectId, binding.mode, binding.generation),
      execute: {
        autoApprove: posture.autoApprove,
        trustMode: posture.trustMode,
        allowShell: posture.allowShell,
      },
    });
    await this.store.upsertThread({
      id: binding.localThreadId,
      projectId: session.projectId,
      engineThreadId: thread.threadId,
      title,
      mode: binding.mode,
      generation: binding.generation,
    });
    const updated: ModeBinding = { ...binding, engineThreadId: thread.threadId };
    session.bindings[binding.mode] = updated;
    return updated;
  }

  /**
   * Every conversation of this mode, newest first. Rows written before schema
   * v11 have no mode; only a row with a real engine identity is adopted as
   * generation 0, and it is relabelled in place rather than duplicated.
   */
  private async conversationThreads(projectId: ProjectId, mode: StudioMode) {
    const rows = await this.store.listModeThreads(projectId, mode);
    if (rows.length > 0) return rows;
    const legacy = await this.store.getThread(legacyThreadRowId(projectId, mode));
    if (!legacy || legacy.mode !== null || !legacy.engineThreadId) return [];
    const adopted = await this.store.upsertThread({
      id: legacy.id,
      projectId,
      engineThreadId: legacy.engineThreadId,
      title: legacy.title,
      mode,
      generation: 0,
    });
    return [adopted];
  }

  /**
   * R04 `/new`: start a new conversation while every earlier conversation keeps
   * its rows, events, turns, usage and drafts.
   *
   * The operation key is the durable half. The key's target thread is recorded
   * before the engine call, the engine create key is derived from (project,
   * mode, generation), and a repeat with the same key resumes that target
   * instead of allocating another generation. A lost response, a double click,
   * or a restart therefore cannot fork the conversation twice.
   */
  async newThread(
    projectId: ProjectId,
    options: { mode: StudioMode; operationKey: string; resolveBusy?: "interrupt" },
  ): Promise<StudioCommandResult> {
    if (options.mode !== "plan" && options.mode !== "work") {
      throw new StudioError("INVALID_INPUT", "mode must be plan or work");
    }
    const project = await this.store.getProject(projectId);
    if (!project)
      throw new StudioError("NOT_FOUND", "project is not in the catalog", { projectId });
    const session =
      this.active && this.active.projectId === projectId && !this.active.stopped
        ? this.active
        : null;

    const existing = await this.store.getCommandOperation(options.operationKey);
    if (existing && (existing.projectId !== projectId || existing.command !== "new")) {
      throw new StudioError(
        "INVALID_INPUT",
        "that operation key was already used for a different command or project",
        { operationKey: options.operationKey },
      );
    }
    if (existing?.status === "completed" && existing.result) {
      const stored = existing.result as {
        note?: unknown;
        thread?: unknown;
        status?: unknown;
      };
      const thread = storedThreadReceipt(stored.thread);
      if (thread) {
        // The same intent, already resolved. Return the first receipt and put
        // the live session back on the conversation it created.
        if (session) {
          session.bindings[thread.mode] = {
            localThreadId: thread.localThreadId,
            engineThreadId: thread.engineThreadId ? asThreadIdOrNull(thread.engineThreadId) : null,
            mode: thread.mode,
            generation: thread.generation,
          };
          session.lastMode = thread.mode;
        }
        return {
          status: stored.status === "deferred" ? "deferred" : "completed",
          note:
            typeof stored.note === "string"
              ? stored.note
              : `Conversation ${thread.localThreadId} already exists for this operation key.`,
          thread,
          turnId: null,
          duplicate: true,
          snapshot: await this.snapshot(projectId),
        };
      }
    }

    let localThreadId: string;
    let generation: number;
    let previousLocalThreadId: string | null = null;
    let previousEngineThreadId: ThreadId | null = null;
    let resumed = false;

    if (existing?.targetId) {
      // A retry of the same intent. Its target was fixed before the first
      // attempt, so resuming it cannot allocate a second generation. It may
      // still meet a turn that started after the first attempt, so the same
      // busy rule applies: never detach a running turn.
      localThreadId = existing.targetId;
      const row = await this.store.getThread(localThreadId);
      // A crash between recording the key and writing the row leaves the
      // pending record with its generation and no row. Falling back to
      // generation 0 would then reuse the first conversation's engine key, so
      // the recorded generation wins, and a last-resort allocation is fresh.
      const pendingMeta = existing.result as {
        generation?: unknown;
        thread?: unknown;
      } | null;
      const recordedThread = storedThreadReceipt(pendingMeta?.thread ?? null);
      const recordedGeneration =
        typeof pendingMeta?.generation === "number" && Number.isInteger(pendingMeta.generation)
          ? pendingMeta.generation
          : (recordedThread?.generation ?? null);
      if (row) {
        generation = row.generation;
      } else if (recordedGeneration !== null) {
        generation = recordedGeneration;
      } else {
        const allocated = await this.conversationThreads(projectId, options.mode);
        generation = allocated.reduce((max, entry) => Math.max(max, entry.generation), -1) + 1;
      }
      if (!row) {
        // The identity this key fixes must exist before the engine call, or a
        // second crash would allocate again.
        await this.store.upsertThread({
          id: localThreadId,
          projectId,
          title: threadTitle(project.name, options.mode, generation),
          mode: options.mode,
          generation,
        });
      }
      resumed = true;
      const active = session?.active ?? null;
      if (active && active.binding.localThreadId !== localThreadId) {
        if (options.resolveBusy !== "interrupt") {
          return {
            status: "busy",
            note: `A ${active.binding.mode} turn is running (${active.turnId}). Wait for it to finish, or choose Interrupt and start a new conversation. Mona will not detach a running turn and call it moved.`,
            thread: null,
            turnId: active.turnId,
            duplicate: true,
            snapshot: await this.snapshot(projectId),
          };
        }
        const receipt = await this.interrupt(projectId);
        if (receipt.confirmed !== true) {
          return {
            status: "failed",
            note: `The running turn (${active.turnId}) did not confirm an interrupt: ${receipt.note} The recorded /new operation was not resumed.`,
            thread: null,
            turnId: active.turnId,
            duplicate: true,
            snapshot: await this.snapshot(projectId),
          };
        }
        this.clearInterruptedTurn(session);
      }
    } else {
      const active = session?.active ?? null;
      if (active && options.resolveBusy !== "interrupt") {
        return {
          status: "busy",
          note: `A ${active.binding.mode} turn is running (${active.turnId}). Wait for it to finish, or choose Interrupt and start a new conversation. Mona will not detach a running turn and call it moved.`,
          thread: null,
          turnId: active.turnId,
          duplicate: false,
          snapshot: await this.snapshot(projectId),
        };
      }
      if (active && options.resolveBusy === "interrupt") {
        const receipt = await this.interrupt(projectId);
        if (receipt.confirmed !== true) {
          return {
            status: "failed",
            note: `The running turn (${active.turnId}) did not confirm an interrupt: ${receipt.note} No new conversation was created.`,
            thread: null,
            turnId: active.turnId,
            duplicate: false,
            snapshot: await this.snapshot(projectId),
          };
        }
        // Only a confirmed interrupt clears the in-memory turn. The old
        // thread's final frame is stored when that conversation is next
        // opened; the receipt says so rather than claiming it moved.
        this.clearInterruptedTurn(session);
      }
      const threads = await this.conversationThreads(projectId, options.mode);
      const newest = threads[0] ?? null;
      const bound = session?.bindings[options.mode] ?? null;
      generation = threads.reduce((max, row) => Math.max(max, row.generation), -1) + 1;
      localThreadId = threadRowId(projectId, options.mode, generation);
      previousLocalThreadId = bound?.localThreadId ?? newest?.id ?? null;
      previousEngineThreadId =
        bound?.engineThreadId ??
        (newest?.engineThreadId ? asThreadIdOrNull(newest.engineThreadId) : null);
      // Recorded before the engine write: a lost response leaves a target that
      // a retry can resume, not a gap that a retry fills with a second thread.
      await this.store.putCommandOperation({
        operationKey: options.operationKey,
        projectId,
        command: "new",
        targetId: localThreadId,
        status: "pending",
        // The generation travels with the key: if the row write is lost, a
        // resume still knows which conversation this intent allocated.
        result: { generation, mode: options.mode },
      });
      await this.store.upsertThread({
        id: localThreadId,
        projectId,
        title: threadTitle(project.name, options.mode, generation),
        mode: options.mode,
        generation,
      });
      if (session) {
        if (previousEngineThreadId && session.pumpKey === previousEngineThreadId) {
          await this.stopPump(session);
        }
        if (session.active?.binding.localThreadId === previousLocalThreadId) session.active = null;
      }
    }

    const row = await this.store.getThread(localThreadId);
    let engineThreadId: ThreadId | null = row?.engineThreadId
      ? asThreadIdOrNull(row.engineThreadId)
      : null;
    let status: StudioCommandResult["status"] = "completed";
    let note: string;

    if (engineThreadId === null) {
      if (session && (session.connection === "connected" || session.connection === "running")) {
        const posture = postureFor(options.mode, session.profile);
        try {
          const thread = await session.adapter.createOrOpenThread({
            workspace: project.canonicalPath,
            title: threadTitle(project.name, options.mode, generation),
            operationKey: threadKey(projectId, options.mode, generation),
            execute: {
              autoApprove: posture.autoApprove,
              trustMode: posture.trustMode,
              allowShell: posture.allowShell,
            },
          });
          engineThreadId = thread.threadId;
          await this.store.upsertThread({
            id: localThreadId,
            projectId,
            engineThreadId,
            title: threadTitle(project.name, options.mode, generation),
            mode: options.mode,
            generation,
          });
          note = `New ${options.mode} conversation created: local ${localThreadId}, engine ${engineThreadId}. The earlier conversation, its events, drafts and usage are unchanged.`;
        } catch (error) {
          status = "deferred";
          note = `New ${options.mode} conversation started locally (${localThreadId}), but the engine thread was not created yet: ${errorMessage(error)} It will be created with the next turn, with the same operation key.`;
        }
      } else {
        status = "deferred";
        note = `New ${options.mode} conversation started locally (${localThreadId}). The engine thread will be created when the studio connects; the earlier conversation is unchanged.`;
      }
    } else {
      note = `New ${options.mode} conversation created: local ${localThreadId}, engine ${engineThreadId}. The earlier conversation, its events, drafts and usage are unchanged.`;
    }
    if (resumed) note = `Resumed the recorded /new operation. ${note}`;

    const binding: ModeBinding = { localThreadId, engineThreadId, mode: options.mode, generation };
    if (session) {
      session.bindings[options.mode] = binding;
      session.lastMode = options.mode;
    }
    const thread = {
      mode: options.mode,
      generation,
      localThreadId,
      engineThreadId,
      previousLocalThreadId,
      previousEngineThreadId,
    };
    // A deferred conversation is a real local generation with a pending engine
    // identity. Keeping the operation pending is what lets the same key resume
    // it later; marking it completed would make a retry replay the failure.
    if (status === "deferred") {
      await this.store.putCommandOperation({
        operationKey: options.operationKey,
        projectId,
        command: "new",
        targetId: localThreadId,
        status: "pending",
        // The generation travels with the key on every write. A deferred
        // conversation is exactly the case a crash-window resume has to
        // recognise, so dropping it here would empty the rung that exists for
        // it.
        result: { note, thread, status, generation, mode: options.mode },
      });
    } else {
      await this.store.completeCommandOperation({
        operationKey: options.operationKey,
        projectId,
        command: "new",
        targetId: localThreadId,
        status: "completed",
        result: { note, thread, status },
      });
    }
    this.pushControl(projectId, "thread_new", "control", {});
    return {
      status,
      note,
      thread,
      turnId: null,
      duplicate: existing !== null,
      snapshot: await this.snapshot(projectId),
    };
  }

  /**
   * R04 native operations that act on the current conversation. Each requires
   * a live, bound conversation: none of them invents an engine turn or a
   * thread identity to look successful.
   */
  private requireLiveThread(
    projectId: ProjectId,
    mode: StudioMode,
  ): { session: StudioSession; binding: ModeBinding & { engineThreadId: ThreadId } } {
    const session = this.requireSession(projectId);
    if (session.connection !== "connected" && session.connection !== "running") {
      throw new StudioError(
        "NOT_CONNECTED",
        `the studio is ${session.connection}: ${session.reason}`,
      );
    }
    const binding = session.bindings[mode] ?? session.active?.binding ?? null;
    if (!binding) {
      throw new StudioError(
        "NOT_CONNECTED",
        "this project has no bound conversation yet; send a task or run /new first",
      );
    }
    const engineThreadId = binding.engineThreadId;
    if (!engineThreadId) {
      throw new StudioError(
        "NOT_CONNECTED",
        "this conversation has no engine thread yet; send a task first so the engine creates it",
      );
    }
    return { session, binding: { ...binding, engineThreadId } };
  }

  /** `/rename <title>` — the engine's own title patch, mirrored locally. */
  async renameConversation(
    projectId: ProjectId,
    options: { mode: StudioMode; title: string; operationKey: string },
  ): Promise<StudioCommandResult> {
    const { session, binding } = this.requireLiveThread(projectId, options.mode);
    const title = options.title.trim();
    if (title.length === 0) {
      throw new StudioError("INVALID_INPUT", "a title is required");
    }
    if (title.length > 200) {
      throw new StudioError("INVALID_INPUT", "a title is limited to 200 characters");
    }
    const receipt = await session.adapter.renameThread({
      threadId: binding.engineThreadId,
      title,
    });
    await this.store.upsertThread({
      id: binding.localThreadId,
      projectId,
      title: receipt.title,
      mode: options.mode,
      generation: binding.generation,
    });
    const note = `Renamed this conversation to “${receipt.title}”.`;
    const thread = this.threadReceipt(binding, binding);
    await this.store.completeCommandOperation({
      operationKey: options.operationKey,
      projectId,
      command: "rename",
      targetId: binding.localThreadId,
      status: "completed",
      result: { note, thread, status: "completed" },
    });
    this.pushControl(projectId, "thread_renamed", "control", {});
    return {
      status: "completed",
      note,
      thread,
      turnId: null,
      duplicate: false,
      snapshot: await this.snapshot(projectId),
    };
  }

  /** `/compact` — manual compaction. The engine may call the model. */
  async compactConversation(
    projectId: ProjectId,
    options: { mode: StudioMode; operationKey: string },
  ): Promise<StudioCommandResult> {
    const { session, binding } = this.requireLiveThread(projectId, options.mode);
    if (session.active) {
      throw new StudioError(
        "TURN_ACTIVE",
        `a turn is active (${session.active.turnId}); compaction waits for it to finish`,
      );
    }
    const receipt = await session.adapter.compactThread({
      threadId: binding.engineThreadId,
    });
    const note = `Compaction: ${receipt.note}`;
    await this.store.completeCommandOperation({
      operationKey: options.operationKey,
      projectId,
      command: "compact",
      targetId: binding.localThreadId,
      status: "completed",
      result: { note, thread: null, status: "completed" },
    });
    return {
      status: "completed",
      note,
      thread: null,
      turnId: null,
      duplicate: false,
      snapshot: await this.snapshot(projectId),
    };
  }

  /** `/fork` — a sibling conversation. The source thread is untouched. */
  async forkConversation(
    projectId: ProjectId,
    options: { mode: StudioMode; operationKey: string },
  ): Promise<StudioCommandResult> {
    const { session, binding } = this.requireLiveThread(projectId, options.mode);
    if (session.active) {
      // Adopting a fork rebinds the conversation, so an active turn would lose
      // its reader. Refuse rather than detach it and call it moved.
      throw new StudioError(
        "TURN_ACTIVE",
        `a turn is active (${session.active.turnId}); fork waits for it to finish`,
      );
    }
    const receipt = await session.adapter.forkThread({
      threadId: binding.engineThreadId,
      operationKey: options.operationKey,
    });
    const adopted = await this.adoptConversation(
      session,
      options.mode,
      receipt.threadId,
      `${session.project.name} — ${options.mode} fork`,
    );
    const note = `Forked this conversation (${binding.engineThreadId}) into a new ${options.mode} conversation (${receipt.threadId}). The source thread and its events are unchanged.${
      receipt.originalUserText
        ? ` The engine kept the source prompt: “${receipt.originalUserText.slice(0, 200)}”.`
        : ""
    }`;
    const thread = this.threadReceipt(adopted.binding, adopted.previous);
    await this.store.completeCommandOperation({
      operationKey: options.operationKey,
      projectId,
      command: "fork",
      targetId: adopted.binding.localThreadId,
      status: "completed",
      result: { note, thread, status: "completed" },
    });
    this.pushControl(projectId, "thread_new", "control", {});
    return {
      status: "completed",
      note,
      thread,
      turnId: null,
      duplicate: false,
      snapshot: await this.snapshot(projectId),
    };
  }

  /**
   * `/retry` — the engine forks with the last turn removed and immediately
   * starts a turn. It is not an in-place retry: the conversation becomes the
   * fork, and the source conversation stays readable.
   */
  async retryConversation(
    projectId: ProjectId,
    options: { mode: StudioMode; operationKey: string },
  ): Promise<StudioCommandResult> {
    const { session, binding } = this.requireLiveThread(projectId, options.mode);
    if (session.active) {
      throw new StudioError(
        "TURN_ACTIVE",
        `a turn is active (${session.active.turnId}); retry waits for it to finish`,
      );
    }
    const prior = await this.store.getCommandOperation(options.operationKey);
    if (prior) {
      // The same key was already attempted. A retry endpoint starts work and
      // may have forked, so a repeat cannot be answered by calling it again.
      throw new StudioError(
        "INVALID_INPUT",
        "this retry was already attempted; a repeat could fork a second conversation. Check the thread list before trying again.",
        { operationKey: options.operationKey },
      );
    }
    await this.store.putCommandOperation({
      operationKey: options.operationKey,
      projectId,
      command: "retry",
      targetId: binding.localThreadId,
      status: "pending",
    });
    const receipt = await session.adapter.retryThread({
      threadId: binding.engineThreadId,
      depth: 0,
    });
    const adopted = await this.adoptConversation(
      session,
      options.mode,
      receipt.threadId,
      `${session.project.name} — ${options.mode} retry`,
    );
    if (receipt.turnId) {
      this.activate(session, adopted.binding, receipt.turnId, "accepted", options.operationKey);
    }
    await this.startPump(session, adopted.binding);
    const note = receipt.turnId
      ? `Retried in a forked conversation (${receipt.threadId}); turn ${receipt.turnId} is running.`
      : `Retried in a forked conversation (${receipt.threadId}); the engine started a turn and its events are being read.`;
    const thread = this.threadReceipt(adopted.binding, adopted.previous);
    await this.store.completeCommandOperation({
      operationKey: options.operationKey,
      projectId,
      command: "retry",
      targetId: adopted.binding.localThreadId,
      status: "completed",
      result: { note, thread, status: "completed" },
    });
    return {
      status: "completed",
      note,
      thread,
      turnId: receipt.turnId,
      duplicate: false,
      snapshot: await this.snapshot(projectId),
    };
  }

  private async adoptConversation(
    session: StudioSession,
    mode: StudioMode,
    engineThreadId: ThreadId,
    titleBase: string,
  ): Promise<{ binding: ModeBinding; previous: ModeBinding | null }> {
    const threads = await this.conversationThreads(session.projectId, mode);
    const newest = threads[0] ?? null;
    const previous: ModeBinding | null =
      session.bindings[mode] ??
      (newest
        ? {
            localThreadId: newest.id,
            engineThreadId: newest.engineThreadId ? asThreadIdOrNull(newest.engineThreadId) : null,
            mode,
            generation: newest.generation,
          }
        : null);
    const generation = threads.reduce((max, row) => Math.max(max, row.generation), -1) + 1;
    const localThreadId = threadRowId(session.projectId, mode, generation);
    const title = generation === 0 ? titleBase : `${titleBase} ${generation + 1}`;
    await this.store.upsertThread({
      id: localThreadId,
      projectId: session.projectId,
      engineThreadId,
      title,
      mode,
      generation,
    });
    if (previous?.engineThreadId && session.pumpKey === previous.engineThreadId) {
      await this.stopPump(session);
    }
    if (session.active?.binding.localThreadId === previous?.localThreadId) session.active = null;
    const binding: ModeBinding = { localThreadId, engineThreadId, mode, generation };
    session.bindings[mode] = binding;
    session.lastMode = mode;
    return { binding, previous };
  }

  private threadReceipt(
    binding: ModeBinding,
    previous: ModeBinding | null,
  ): NonNullable<StudioCommandResult["thread"]> {
    return {
      mode: binding.mode,
      generation: binding.generation,
      localThreadId: binding.localThreadId,
      engineThreadId: binding.engineThreadId,
      previousLocalThreadId: previous?.localThreadId ?? null,
      previousEngineThreadId: previous?.engineThreadId ?? null,
    };
  }

  /**
   * A confirmed interrupt means the engine is no longer running that turn, so
   * the session may stop claiming it is. The connection returns to
   * `connected` only when it really was `running`; a failed or reconnecting
   * session is left exactly as it is.
   */
  private clearInterruptedTurn(session: StudioSession | null): void {
    if (!session) return;
    session.active = null;
    if (session.connection === "running") {
      this.setConnection(
        session,
        "connected",
        "the interrupted turn stopped; a new conversation is current",
      );
    }
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
  /**
   * The live adapter for a project, or null. The change ledger uses this for
   * receipt refreshes, restore, and checked writes. It never starts a runtime.
   */
  engineAccess(projectId: ProjectId): ChangeEngineAccess | null {
    const session = this.active;
    if (!session || session.projectId !== projectId || session.stopped) return null;
    if (session.connection !== "connected" && session.connection !== "running") return null;
    return { adapter: session.adapter, workspace: session.project.canonicalPath };
  }

  async close(): Promise<void> {
    this.closed = true;
    const session = this.active;
    if (session) {
      session.stopped = true;
      await this.stopPump(session);
    }
    this.active = null;
  }

  /** R04: the durable record of one command intent, for retry detection. */
  async commandOperation(operationKey: string) {
    return this.store.getCommandOperation(operationKey);
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
