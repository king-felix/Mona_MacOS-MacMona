/**
 * Maintenance barrier. Every writer — adapter ingestion, the indexer, the task
 * runner, and the catalog UI — goes through this gate. A backup or restore
 * acquires it exclusively, so no connection can slip a write in mid-snapshot.
 *
 * Normal operations share the gate. Once maintenance is queued, new normal
 * operations queue behind it (writer-preference, so a busy app cannot starve a
 * backup). The barrier is deliberately not re-entrant: a public store method
 * acquires once and uses internal helpers afterwards.
 */
type OperationMode = "read" | "write";
type WaiterMode = OperationMode | "maintenance";

interface Waiter {
  mode: WaiterMode;
  resolve: () => void;
}

export interface BarrierSnapshot {
  active: number;
  maintenance: boolean;
  queued: number;
}

export class MaintenanceBarrier {
  private active = 0;
  private maintenanceActive = false;
  private readonly queue: Waiter[] = [];

  run<T>(mode: OperationMode, work: () => T | Promise<T>): Promise<T> {
    return this.acquire(mode).then(async () => {
      try {
        return await work();
      } finally {
        this.release(mode);
      }
    });
  }

  runMaintenance<T>(work: () => T | Promise<T>): Promise<T> {
    return this.acquire("maintenance").then(async () => {
      try {
        return await work();
      } finally {
        this.release("maintenance");
      }
    });
  }

  snapshot(): BarrierSnapshot {
    return { active: this.active, maintenance: this.maintenanceActive, queued: this.queue.length };
  }

  private acquire(mode: WaiterMode): Promise<void> {
    if (mode === "maintenance") {
      if (!this.maintenanceActive && this.active === 0 && this.queue.length === 0) {
        this.maintenanceActive = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => this.queue.push({ mode, resolve }));
    }
    // Fairness: any queued work (especially maintenance) runs first.
    if (this.maintenanceActive || this.queue.length > 0) {
      return new Promise((resolve) => this.queue.push({ mode, resolve }));
    }
    this.active += 1;
    return Promise.resolve();
  }

  private release(mode: WaiterMode): void {
    if (mode === "maintenance") this.maintenanceActive = false;
    else this.active -= 1;
    this.drain();
  }

  private drain(): void {
    if (this.maintenanceActive) return;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head === undefined) return;
      if (head.mode === "maintenance") {
        if (this.active !== 0) return;
        this.queue.shift();
        this.maintenanceActive = true;
        head.resolve();
        return;
      }
      this.queue.shift();
      this.active += 1;
      head.resolve();
    }
  }
}
