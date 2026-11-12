import { startOwnedRuntime, stopRecordedRuntime } from "../engine/runtime-process";
import { lastStopReceipt, stopSupervisor } from "./native";
import type { OwnershipStore } from "./records";
import type { RuntimeDriver } from "./runtime-supervisor";

export interface ProductionDriverOptions {
  store: OwnershipStore;
  stateDir: string;
  logDir: string;
  startupTimeoutMs?: number;
}

/**
 * The real process driver: spawn the pinned engine under the native
 * supervisor, probe it over authenticated loopback, and stop it by verified
 * process identity. Shared by the desktop entry point and the smoke harness so
 * evidence exercises the same wiring the product ships.
 */
export function createProductionDriver(options: ProductionDriverOptions): RuntimeDriver {
  return {
    start: async (workspace) => {
      const owned = await startOwnedRuntime({
        workspace,
        stateDir: options.stateDir,
        logDir: options.logDir,
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
      });
      return {
        handle: owned.supervisor,
        token: owned.token,
        engine: owned.engine,
        listenerPid: owned.listenerPid,
        port: owned.runtime.port,
        baseUrl: owned.runtime.baseUrl,
        record: owned.record,
      };
    },
    stop: (handle, stopOptions) => stopSupervisor(handle, stopOptions),
    healthy: async (_handle, token, baseUrl) => {
      try {
        const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_500) });
        if (!health.ok) return false;
        const info = await fetch(`${baseUrl}/v1/runtime/info`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1_500),
        });
        return info.status === 200;
      } catch {
        return false;
      }
    },
    stopRecorded: (record) => stopRecordedRuntime(record),
    lastStopReceipt,
    markRecord: (record, patch) =>
      options.store.put({ ...record, ...patch, updatedAt: new Date().toISOString() }),
  };
}
