import type { InterruptReceipt } from "../engine/types";
import type { SupervisorStopReceipt } from "../supervisor/native";

export interface TaskRef {
  id: string;
  workspace: string;
}

export interface ActiveWork {
  task: TaskRef;
  turnId: string;
}

export interface WorkEffects {
  interrupt(input: { task: TaskRef; turnId: string }): Promise<InterruptReceipt>;
  stopOwnedRuntime(options: { force?: boolean; graceMs?: number }): Promise<SupervisorStopReceipt>;
}

export interface PauseTransition {
  action: "pause_after_task";
  boundary: "after_active_task" | "already_idle";
  active: TaskRef | null;
  queueDepth: number;
  note: string;
}

export interface InterruptTransition {
  action: "interrupt_now";
  requested: boolean;
  confirmed: boolean;
  uncertain: boolean;
  note: string;
  receipt: InterruptReceipt | null;
}

export interface CancelTransition {
  action: "cancel_queued";
  canceled: TaskRef[];
  note: string;
}

export interface QuitTransition {
  action: "quit_and_stop_work";
  interrupted: boolean;
  interruptUncertain: boolean;
  stopped: boolean;
  escalated: boolean;
  survivors: number[];
  rollback: "not_promised";
  notes: string[];
}

export interface WorkSnapshot {
  active: ActiveWork | null;
  queued: TaskRef[];
  pauseAfterTask: boolean;
  quitting: boolean;
}

/**
 * Pause-after-task, interrupt-now, and cancel-queued are different transitions
 * with different effects. Pause is a Mona queue boundary; interrupt is an
 * engine operation with a receipt; cancel removes future starts only.
 * Quit-and-stop-work composes interrupt then process shutdown, and never
 * promises that external side effects were rolled back.
 */
export class WorkController {
  private active: ActiveWork | null = null;
  private queue: TaskRef[] = [];
  private pauseBoundary = false;
  private quitting = false;

  constructor(
    private readonly effects: WorkEffects,
    private readonly interruptTimeoutMs = 15_000,
  ) {}

  snapshot(): WorkSnapshot {
    return {
      active: this.active,
      queued: [...this.queue],
      pauseAfterTask: this.pauseBoundary,
      quitting: this.quitting,
    };
  }

  enqueue(task: TaskRef): void {
    if (this.quitting) throw new Error("the queue is closed: quit and stop work is in progress");
    if (this.queue.some((candidate) => candidate.id === task.id)) return;
    this.queue.push(task);
  }

  begin(active: ActiveWork): void {
    if (this.quitting) throw new Error("cannot start work while quitting");
    this.active = active;
    this.queue = this.queue.filter((task) => task.id !== active.task.id);
  }

  /** End the active task; returns the next start only if the pause boundary allows it. */
  taskFinished(): { next: TaskRef | null; paused: boolean } {
    this.active = null;
    if (this.pauseBoundary) return { next: null, paused: true };
    return { next: this.queue.shift() ?? null, paused: false };
  }

  pauseAfterTask(): PauseTransition {
    this.pauseBoundary = true;
    return {
      action: "pause_after_task",
      boundary: this.active ? "after_active_task" : "already_idle",
      active: this.active?.task ?? null,
      queueDepth: this.queue.length,
      note: this.active
        ? "the active task continues; no new task starts after it"
        : "nothing is running; the queue will not start new work",
    };
  }

  resumeQueue(): void {
    this.pauseBoundary = false;
  }

  async interruptNow(): Promise<InterruptTransition> {
    if (!this.active) {
      return {
        action: "interrupt_now",
        requested: false,
        confirmed: false,
        uncertain: false,
        note: "no active turn to interrupt",
        receipt: null,
      };
    }
    const target = this.active;
    try {
      const receipt = await withTimeout(
        this.effects.interrupt({ task: target.task, turnId: target.turnId }),
        this.interruptTimeoutMs,
      );
      return {
        action: "interrupt_now",
        requested: true,
        confirmed: receipt.interrupted,
        uncertain: !receipt.interrupted,
        note: receipt.note,
        receipt,
      };
    } catch (error) {
      return {
        action: "interrupt_now",
        requested: true,
        confirmed: false,
        uncertain: true,
        note: `interrupt outcome unknown: ${String(error)}`,
        receipt: null,
      };
    }
  }

  cancelQueued(): CancelTransition {
    const canceled = this.queue;
    this.queue = [];
    return {
      action: "cancel_queued",
      canceled,
      note:
        canceled.length === 0
          ? "the queue was already empty"
          : `removed ${canceled.length} future start(s); the active task is untouched`,
    };
  }

  async quitAndStopWork(options: { force?: boolean } = {}): Promise<QuitTransition> {
    this.quitting = true;
    const notes: string[] = [];
    const canceled = this.cancelQueued();
    if (canceled.canceled.length > 0) notes.push(canceled.note);

    let interrupted = false;
    let interruptUncertain = false;
    if (this.active) {
      const interrupt = await this.interruptNow();
      interrupted = interrupt.confirmed;
      interruptUncertain = interrupt.uncertain;
      notes.push(interrupt.note);
    } else {
      notes.push("no active turn to interrupt");
    }

    const receipt = await this.effects.stopOwnedRuntime({
      force: options.force,
      graceMs: 8_000,
    });
    const stopped = receipt.state === "stopped";
    notes.push(
      stopped
        ? `runtime ${receipt.via} stop confirmed${receipt.escalated ? " after forced escalation" : ""}`
        : `runtime stop incomplete: ${receipt.survivors.length} survivor(s)`,
    );
    if (receipt.escalated) notes.push("forced termination is last-resort cleanup, not rollback");
    this.active = null;
    return {
      action: "quit_and_stop_work",
      interrupted,
      interruptUncertain,
      stopped,
      escalated: receipt.escalated || options.force === true,
      survivors: receipt.survivors,
      rollback: "not_promised",
      notes,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`operation did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
