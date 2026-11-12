import type { SupervisorHandle, SupervisorStopReceipt } from "./native";
import {
  classifyOwnership,
  type OwnershipRecord,
  type OwnershipStore,
  type RuntimeIdentity,
} from "./records";
import { RestartPolicy } from "./restart";

export type RuntimeState =
  "disconnected" | "starting" | "running" | "reconnecting" | "stopping" | "stopped" | "failed";

export interface RuntimeFailure {
  code: string;
  message: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface RuntimeStatus {
  state: RuntimeState;
  reason: string;
  since: string;
  workspace: string | null;
  ownershipId: string | null;
  port: number | null;
  engine: RuntimeIdentity | null;
  /** True for a user-launched runtime Mona attached to read-only. */
  external: boolean;
  restarts: number;
  lastFailure: RuntimeFailure | null;
  pendingRestartInMs: number | null;
}

export interface StartedRuntime {
  handle: SupervisorHandle;
  token: string;
  engine: RuntimeIdentity;
  listenerPid: number;
  port: number;
  baseUrl: string;
  record: OwnershipRecord;
}

/** The process layer, injectable so lifecycle policy is testable without a spawn. */
export interface RuntimeDriver {
  start(workspace: string): Promise<StartedRuntime>;
  stop(
    handle: SupervisorHandle,
    options?: { graceMs?: number; force?: boolean },
  ): Promise<SupervisorStopReceipt>;
  healthy(handle: SupervisorHandle, token: string, baseUrl: string): Promise<boolean>;
  /** Stop a runtime described only by its durable record (after an app restart). */
  stopRecorded(record: OwnershipRecord): Promise<SupervisorStopReceipt>;
  markRecord(record: OwnershipRecord, patch: Partial<OwnershipRecord>): OwnershipRecord;
}

export interface RuntimeSupervisorOptions {
  driver: RuntimeDriver;
  store: OwnershipStore;
  restartPolicy?: RestartPolicy;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  onStatus?: (status: RuntimeStatus) => void;
  stopGraceMs?: number;
}

export class RuntimeOwnershipError extends Error {
  constructor(
    readonly code:
      "ALREADY_OWNED" | "STALE_OWNERSHIP" | "EXTERNAL_RUNTIME_NOT_OWNED" | "RUNTIME_NOT_RUNNING",
    message: string,
    readonly action: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeOwnershipError";
  }
}

interface CurrentRuntime extends StartedRuntime {
  startedAtMs: number;
}

/**
 * Owns exactly one runtime process per user store. It serializes workspaces,
 * keeps durable ownership records truthful, and restarts only the process after
 * a bounded crash sequence — it never resubmits work.
 */
export class RuntimeSupervisor {
  private readonly driver: RuntimeDriver;
  private readonly store: OwnershipStore;
  private readonly restartPolicy: RestartPolicy;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly onStatus: ((status: RuntimeStatus) => void) | undefined;
  private readonly stopGraceMs: number;
  private current: CurrentRuntime | null = null;
  private external: { workspace: string; port: number } | null = null;
  private statusValue: RuntimeStatus;
  private restartTimer: unknown = null;
  private shuttingDown = false;
  private readonly watched = new Set<string>();

  constructor(options: RuntimeSupervisorOptions) {
    this.driver = options.driver;
    this.store = options.store;
    this.restartPolicy = options.restartPolicy ?? new RestartPolicy({}, options.now);
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs) as unknown);
    this.onStatus = options.onStatus;
    this.stopGraceMs = options.stopGraceMs ?? 8_000;
    this.statusValue = {
      state: "disconnected",
      reason: "never_started",
      since: new Date(this.now()).toISOString(),
      workspace: null,
      ownershipId: null,
      port: null,
      engine: null,
      external: false,
      restarts: 0,
      lastFailure: null,
      pendingRestartInMs: null,
    };
  }

  status(): RuntimeStatus {
    return { ...this.statusValue, restarts: this.restartPolicy.snapshot().attempts };
  }

  handle(): SupervisorHandle | null {
    return this.current?.handle ?? null;
  }

  token(): string | null {
    return this.current?.token ?? null;
  }

  workspace(): string | null {
    return this.current?.record.workspace ?? null;
  }

  /** True when Mona owns and can stop the runtime process. */
  isOwned(): boolean {
    return this.current !== null && !this.statusValue.external;
  }

  async ensure(workspace: string): Promise<RuntimeStatus> {
    if (this.current) {
      if (this.current.record.workspace === workspace && this.statusValue.state === "running") {
        return this.status();
      }
      if (this.statusValue.state === "failed" || this.statusValue.state === "stopped") {
        // A previous stop was incomplete or failed; clear the tree before a new start.
        await this.stopOwned("recover_before_start", { force: true }).catch(() => undefined);
        if (this.current) {
          throw new RuntimeOwnershipError(
            "RUNTIME_NOT_RUNNING",
            "the previous owned process tree could not be stopped",
            "inspect the process tree; Mona will not start a second owner",
          );
        }
      }
      if (this.statusValue.state === "starting" || this.statusValue.state === "running") {
        throw new RuntimeOwnershipError(
          "ALREADY_OWNED",
          `an owned runtime is already active for ${this.current.record.workspace}`,
          "stop the active runtime before starting another workspace; parallel ownership is not proven",
          { activeWorkspace: this.current.record.workspace },
        );
      }
    }
    if (this.shuttingDown) {
      throw new RuntimeOwnershipError(
        "RUNTIME_NOT_RUNNING",
        "the app is shutting down",
        "restart Mona to start a runtime",
      );
    }

    this.external = null;
    await this.reconcileRecords(workspace);
    this.setState("starting", "start_requested", { workspace, external: false });
    try {
      const started = await this.driver.start(workspace);
      this.current = { ...started, startedAtMs: this.now() };
      this.restartPolicy.noteStarted();
      this.watch(started.record.id, started.handle);
      this.setState("running", "started", {
        workspace,
        ownershipId: started.record.id,
        port: started.port,
        engine: started.engine,
        lastFailure: null,
        pendingRestartInMs: null,
      });
      return this.status();
    } catch (error) {
      const failure = toFailure(error);
      this.setState("failed", "start_failed", { lastFailure: failure, workspace });
      throw error;
    }
  }

  async stopOwned(
    reason = "requested",
    options: { force?: boolean; graceMs?: number } = {},
  ): Promise<SupervisorStopReceipt> {
    if (this.external) {
      throw new RuntimeOwnershipError(
        "EXTERNAL_RUNTIME_NOT_OWNED",
        `the runtime attached on port ${this.external.port} was started outside Mona`,
        "quit that runtime from its own owner; Mona will not signal it",
      );
    }
    if (!this.current) {
      return {
        ok: true,
        state: "stopped",
        graceful: true,
        escalated: false,
        survivors: [],
        via: "control_socket",
        note: `no owned runtime (${reason})`,
      };
    }
    this.clearRestart();
    const runtime = this.current;
    this.setState("stopping", reason, { pendingRestartInMs: null });
    let receipt = await this.driver.stop(runtime.handle, {
      force: options.force,
      graceMs: options.graceMs ?? this.stopGraceMs,
    });
    if (receipt.state !== "stopped" && options.force !== true) {
      // One bounded escalation, still scoped to the owned tree.
      const forced = await this.driver.stop(runtime.handle, { force: true, graceMs: 2_000 });
      receipt = { ...forced, escalated: true };
    }
    const stopped = receipt.state === "stopped";
    this.driver.markRecord(runtime.record, {
      state: stopped ? "stopped" : "failed",
      stopReceipt: receipt as unknown as Record<string, unknown>,
      updatedAt: new Date(this.now()).toISOString(),
    });
    // Retain the handle when survivors remain so the bounded forced step can
    // be retried; never start a second owner beside a known leftover tree.
    if (stopped) this.current = null;
    this.setState(stopped ? "stopped" : "failed", stopped ? "stopped" : "stop_incomplete", {
      ownershipId: stopped ? null : runtime.record.id,
      port: null,
      engine: stopped ? null : this.statusValue.engine,
      lastFailure: stopped
        ? null
        : {
            code: "STOP_INCOMPLETE",
            message: `runtime stop left ${receipt.survivors.length} process(es) alive`,
            action: "inspect the process tree; do not claim the work was rolled back",
            details: { receipt },
          },
    });
    if (!stopped) {
      throw new RuntimeOwnershipError(
        "RUNTIME_NOT_RUNNING",
        `runtime did not stop completely: ${receipt.survivors.join(", ")}`,
        "inspect the process tree; forced termination is not rollback",
        { receipt },
      );
    }
    return receipt;
  }

  /** Attach read-only to a runtime Mona did not start. Never stops it. */
  attachExternal(input: { workspace: string; port: number }): RuntimeStatus {
    this.clearRestart();
    this.current = null;
    this.external = { workspace: input.workspace, port: input.port };
    this.statusValue = {
      ...this.statusValue,
      state: "running",
      reason: "attached_external_read_only",
      since: new Date(this.now()).toISOString(),
      workspace: input.workspace,
      ownershipId: null,
      port: input.port,
      engine: null,
      external: true,
      lastFailure: null,
      pendingRestartInMs: null,
    };
    this.emit();
    return this.status();
  }

  noteRendererCrash(details?: Record<string, unknown>): RuntimeStatus {
    // A renderer crash does not touch the runtime. State stays exactly as it is.
    this.statusValue = {
      ...this.statusValue,
      reason:
        this.statusValue.state === "running"
          ? "running_after_renderer_crash"
          : this.statusValue.reason,
      lastFailure: this.statusValue.lastFailure,
    };
    this.emit(details);
    return this.status();
  }

  noteSuspend(): RuntimeStatus {
    if (this.statusValue.state === "running" && !this.statusValue.external) {
      this.setState("reconnecting", "system_sleep", { pendingRestartInMs: null });
    }
    return this.status();
  }

  async noteResume(): Promise<RuntimeStatus> {
    if (this.statusValue.state !== "reconnecting" || !this.current) return this.status();
    const runtime = this.current;
    let healthy = false;
    try {
      healthy = await this.driver.healthy(runtime.handle, runtime.token, runtime.baseUrl);
    } catch {
      healthy = false;
    }
    if (healthy) {
      this.setState("running", "resumed_after_sleep", { pendingRestartInMs: null });
      return this.status();
    }
    await this.handleUnhealthy("runtime_unreachable_after_wake");
    return this.status();
  }

  /** Called by the quit path: no restart may be scheduled after this point. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.clearRestart();
  }

  /** Reconcile records left by a previous app run; stops only verified owners. */
  async recover(): Promise<void> {
    await this.reconcileRecords(undefined);
  }

  private async reconcileRecords(workspace: string | undefined): Promise<void> {
    for (const record of this.store.live()) {
      if (workspace !== undefined && record.workspace === workspace) continue;
      const evidence = classifyOwnership(record);
      if (evidence.verdict === "live_owned" || evidence.verdict === "orphaned_owned") {
        await this.driver.stopRecorded(record);
        this.driver.markRecord(record, {
          state: "stopped",
          updatedAt: new Date(this.now()).toISOString(),
          stopReceipt: { via: "record_reconcile", note: evidence.note },
        });
        continue;
      }
      if (evidence.verdict === "pid_reused" || evidence.verdict === "foreign_executable") {
        this.driver.markRecord(record, {
          state: "failed",
          updatedAt: new Date(this.now()).toISOString(),
          stopReceipt: { via: "record_reconcile", note: evidence.note, signaled: false },
        });
        throw new RuntimeOwnershipError(
          "STALE_OWNERSHIP",
          evidence.note,
          "inspect the leftover process; Mona will not signal a pid it cannot prove it started",
          { record: record.id, verdict: evidence.verdict },
        );
      }
      this.driver.markRecord(record, {
        state: "stopped",
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
    this.store.pruneStopped();
  }

  private watch(recordId: string, handle: SupervisorHandle): void {
    if (this.watched.has(recordId)) return;
    this.watched.add(recordId);
    void handle.exit.then(({ code, signal }) => {
      if (this.current?.record.id !== recordId) return;
      this.noteProcessExit(recordId, code, signal);
    });
  }

  private noteProcessExit(
    recordId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const runtime = this.current;
    if (!runtime || runtime.record.id !== recordId) return;
    if (this.statusValue.state === "stopping" || this.statusValue.state === "stopped") return;
    const clean = code === 0 && signal === null;
    this.driver.markRecord(runtime.record, {
      state: "stopped",
      updatedAt: new Date(this.now()).toISOString(),
      stopReceipt: { via: "process_exit", code, signal },
    });
    const decision = this.restartPolicy.noteExit(clean);
    this.current = null;
    if (this.shuttingDown || !decision.restart) {
      this.setState("failed", decision.reason, {
        ownershipId: recordId,
        port: null,
        engine: null,
        lastFailure: {
          code: decision.reason === "restart_exhausted" ? "RESTART_EXHAUSTED" : "RUNTIME_EXITED",
          message: `runtime exited (code ${code ?? "none"}, signal ${signal ?? "none"})`,
          action:
            decision.reason === "restart_exhausted"
              ? "start the runtime manually after inspecting the log; Mona stopped restarting it"
              : "start the runtime manually; work was not resubmitted",
          details: { code, signal, decision },
        },
        pendingRestartInMs: null,
      });
      return;
    }
    const workspace = runtime.record.workspace;
    this.setState("reconnecting", "bounded_restart", {
      ownershipId: recordId,
      pendingRestartInMs: decision.delayMs,
      lastFailure: {
        code: "RUNTIME_EXITED",
        message: `runtime exited (code ${code ?? "none"}, signal ${signal ?? "none"})`,
        action: "process restart only; the pending turn is reconciled separately",
      },
    });
    this.scheduleRestart(workspace, decision.delayMs);
  }

  private async handleUnhealthy(reason: string): Promise<void> {
    const runtime = this.current;
    if (!runtime) return;
    const decision = this.restartPolicy.noteExit(false);
    // Stop the still-present process before starting a replacement so ownership
    // never forks into two runtimes on one user store.
    await this.driver.stop(runtime.handle, { graceMs: 2_000 });
    this.current = null;
    if (this.shuttingDown || !decision.restart) {
      this.setState("failed", `${reason}_restart_exhausted`, {
        lastFailure: {
          code: "RESTART_EXHAUSTED",
          message: `runtime unhealthy (${reason}) and restart budget is exhausted`,
          action: "inspect the runtime log, then start it manually",
        },
        pendingRestartInMs: null,
      });
      return;
    }
    this.setState("reconnecting", reason, { pendingRestartInMs: decision.delayMs });
    this.scheduleRestart(runtime.record.workspace, decision.delayMs);
  }

  private scheduleRestart(workspace: string, delayMs: number): void {
    this.clearRestart();
    this.restartTimer = this.schedule(() => {
      this.restartTimer = null;
      if (this.shuttingDown || this.current) return;
      this.setState("starting", "bounded_restart_start", { pendingRestartInMs: null });
      void this.driver
        .start(workspace)
        .then((started) => {
          if (this.shuttingDown) {
            void this.driver.stop(started.handle, { graceMs: 2_000 });
            return;
          }
          this.current = { ...started, startedAtMs: this.now() };
          this.restartPolicy.noteStarted();
          this.watch(started.record.id, started.handle);
          this.setState("running", "restarted", {
            workspace,
            ownershipId: started.record.id,
            port: started.port,
            engine: started.engine,
            pendingRestartInMs: null,
          });
        })
        .catch((error: unknown) => {
          this.setState("failed", "restart_failed", {
            lastFailure: toFailure(error),
            pendingRestartInMs: null,
          });
        });
    }, delayMs);
  }

  private clearRestart(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer as ReturnType<typeof setTimeout>);
      this.restartTimer = null;
    }
  }

  private setState(state: RuntimeState, reason: string, patch: Partial<RuntimeStatus> = {}): void {
    this.statusValue = {
      ...this.statusValue,
      ...patch,
      state,
      reason,
      since: new Date(this.now()).toISOString(),
    };
    this.emit();
  }

  private emit(details?: Record<string, unknown>): void {
    if (!this.onStatus) return;
    try {
      this.onStatus({ ...this.status(), ...(details ?? {}) } as RuntimeStatus);
    } catch {
      // Status reporting must never break the lifecycle.
    }
  }
}

export function toFailure(error: unknown): RuntimeFailure {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      action?: unknown;
      details?: unknown;
    };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "RUNTIME_START_FAILED",
      message: typeof candidate.message === "string" ? candidate.message : "runtime start failed",
      action:
        typeof candidate.action === "string"
          ? candidate.action
          : "inspect the runtime log and the engine executable",
      details:
        candidate.details && typeof candidate.details === "object"
          ? (candidate.details as Record<string, unknown>)
          : undefined,
    };
  }
  return {
    code: "RUNTIME_START_FAILED",
    message: String(error),
    action: "inspect the runtime log and the engine executable",
  };
}
