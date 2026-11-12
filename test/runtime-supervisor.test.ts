import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupervisorHandle, SupervisorStopReceipt } from "../src/main/supervisor/native";
import { newRecordId, OwnershipStore, type OwnershipRecord } from "../src/main/supervisor/records";
import { readExecutablePath, readProcessEntry } from "../src/main/supervisor/identity";
import { RestartPolicy } from "../src/main/supervisor/restart";
import {
  RuntimeOwnershipError,
  RuntimeSupervisor,
  type RuntimeDriver,
  type StartedRuntime,
} from "../src/main/supervisor/runtime-supervisor";

interface FakeRuntime {
  childPid: number;
  resolveExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

class FakeDriver implements RuntimeDriver {
  starts: string[] = [];
  stops: number[] = [];
  stoppedRecords: string[] = [];
  marks: Array<{ id: string; patch: Partial<OwnershipRecord> }> = [];
  runtimes: FakeRuntime[] = [];
  healthyResult = true;
  stubborn = false;
  private nextPid = 4_100;

  constructor(private readonly store: OwnershipStore) {}

  async start(workspace: string): Promise<StartedRuntime> {
    this.starts.push(workspace);
    const pid = this.nextPid++;
    let resolveExit!: (code: number | null, signal: NodeJS.Signals | null) => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => (resolveExit = resolve),
    );
    const handle = {
      binary: "/fake/supervisor",
      pid: pid + 1_000,
      childPid: pid,
      childStartedAt: "Wed Nov 11 18:00:00 2026",
      pgid: pid,
      controlSocket: `/tmp/fake-${pid}.sock`,
      process: { exitCode: null } as never,
      startedReceipt: {
        event: "started",
        supervisor_pid: pid + 1_000,
        child_pid: pid,
        child_start: "Wed Nov 11 18:00:00 2026",
        pgid: pid,
        executable: "/fake/engine",
        label: "runtime",
        token_source: "fd3",
      },
      events: [],
      exit,
      exitCode: () => null,
      stderrText: () => "",
      status: async () => ({ ok: true }) as never,
      stop: async () => stopReceipt(),
      closeOwnerChannel: () => undefined,
    } as unknown as SupervisorHandle;
    const record = this.store.put(recordFor(workspace, pid));
    this.runtimes.push({ childPid: pid, resolveExit });
    return {
      handle,
      token: `token-${pid}`,
      engine: { version: "0.10.2", commit: "ff466b2ed0bf" },
      listenerPid: pid,
      port: 7_000 + this.starts.length,
      baseUrl: `http://127.0.0.1:${7_000 + this.starts.length}`,
      record,
    };
  }

  async stop(): Promise<SupervisorStopReceipt> {
    this.stops.push(Date.now());
    return stopReceipt();
  }

  async healthy(): Promise<boolean> {
    return this.healthyResult;
  }

  async stopRecorded(record: OwnershipRecord): Promise<SupervisorStopReceipt> {
    this.stoppedRecords.push(record.id);
    if (this.stubborn) {
      return { ...stopReceipt(), ok: false, state: "survivors", survivors: [record.childPid] };
    }
    return stopReceipt();
  }

  markRecord(record: OwnershipRecord, patch: Partial<OwnershipRecord>): OwnershipRecord {
    this.marks.push({ id: record.id, patch });
    return this.store.put({ ...record, ...patch });
  }
}

function stopReceipt(): SupervisorStopReceipt {
  return {
    ok: true,
    state: "stopped",
    graceful: true,
    escalated: false,
    survivors: [],
    via: "control_socket",
  };
}

function recordFor(workspace: string, pid: number, overrides: Partial<OwnershipRecord> = {}) {
  const now = new Date().toISOString();
  return {
    id: newRecordId(),
    workspace,
    canonicalWorkspace: workspace,
    executable: "/fake/engine",
    executableSha256: "c".repeat(64),
    supervisorPid: pid + 1_000,
    supervisorStartedAt: "Wed Nov 11 18:00:00 2026",
    childPid: pid,
    childStartedAt: "Wed Nov 11 18:00:00 2026",
    pgid: pid,
    port: 7_000,
    baseUrl: "http://127.0.0.1:7000",
    controlSocket: `/tmp/fake-${pid}.sock`,
    startedAt: now,
    updatedAt: now,
    state: "running" as const,
    engine: null,
    startupReceipt: null,
    stopReceipt: null,
    ...overrides,
  };
}

function harness(options: { maxRestarts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mona-supervisor-"));
  const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
  const driver = new FakeDriver(store);
  let clock = 0;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const supervisor = new RuntimeSupervisor({
    driver,
    store,
    now: () => clock,
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    restartPolicy: new RestartPolicy(
      { maxRestarts: options.maxRestarts ?? 2, baseDelayMs: 100, maxDelayMs: 1_000 },
      () => clock,
    ),
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { supervisor, driver, store, scheduled, advance };
}

describe("runtime supervisor", () => {
  it("owns one runtime and reports it running", async () => {
    const { supervisor, driver } = harness();
    await supervisor.ensure("/tmp/ws-a");
    expect(driver.starts).toEqual(["/tmp/ws-a"]);
    expect(supervisor.status()).toMatchObject({ state: "running", workspace: "/tmp/ws-a" });
    expect(supervisor.isOwned()).toBe(true);
  });

  it("serializes workspaces instead of starting a second owner", async () => {
    const { supervisor } = harness();
    await supervisor.ensure("/tmp/ws-a");
    await expect(supervisor.ensure("/tmp/ws-b")).rejects.toBeInstanceOf(RuntimeOwnershipError);
    await expect(supervisor.ensure("/tmp/ws-b")).rejects.toMatchObject({ code: "ALREADY_OWNED" });
  });

  it("refuses a new start while the owned runtime is reconnecting", async () => {
    const { supervisor, driver } = harness();
    await supervisor.ensure("/tmp/ws-a");
    supervisor.noteSuspend();
    await expect(supervisor.ensure("/tmp/ws-b")).rejects.toMatchObject({
      code: "ALREADY_OWNED",
    });
    await expect(supervisor.ensure("/tmp/ws-a")).rejects.toMatchObject({
      code: "ALREADY_OWNED",
    });
    expect(driver.starts).toHaveLength(1);
    expect(driver.stoppedRecords).toEqual([]);
  });

  it("restarts only the process after an unexpected exit", async () => {
    const { supervisor, driver, scheduled, advance } = harness();
    await supervisor.ensure("/tmp/ws-a");
    advance(10);
    driver.runtimes[0]?.resolveExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supervisor.status().state).toBe("reconnecting");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(100);
    advance(200);
    scheduled[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.starts).toHaveLength(2);
    expect(supervisor.status().state).toBe("running");
  });

  it("stops restarting after the bounded budget and stays truthful", async () => {
    const { supervisor, driver, scheduled, advance } = harness({ maxRestarts: 1 });
    await supervisor.ensure("/tmp/ws-a");
    driver.runtimes[0]?.resolveExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    advance(200);
    scheduled[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.starts).toHaveLength(2);

    driver.runtimes[1]?.resolveExit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supervisor.status().state).toBe("failed");
    expect(supervisor.status().lastFailure?.code).toBe("RESTART_EXHAUSTED");
    expect(driver.starts).toHaveLength(2);
  });

  it("turns sleep into reconnecting, not a duplicate request", async () => {
    const { supervisor, driver } = harness();
    await supervisor.ensure("/tmp/ws-a");
    supervisor.noteSuspend();
    expect(supervisor.status().state).toBe("reconnecting");
    expect(supervisor.status().reason).toBe("system_sleep");
    expect(driver.stops).toHaveLength(0);
    await supervisor.noteResume();
    expect(supervisor.status().state).toBe("running");
    expect(driver.starts).toHaveLength(1);
  });

  it("stops an unreachable process before restarting it after wake", async () => {
    const { supervisor, driver, scheduled } = harness();
    await supervisor.ensure("/tmp/ws-a");
    supervisor.noteSuspend();
    driver.healthyResult = false;
    await supervisor.noteResume();
    expect(driver.stops).toHaveLength(1);
    expect(supervisor.status().state).toBe("reconnecting");
    expect(scheduled).toHaveLength(1);
  });

  it("stops the owned runtime and marks the record", async () => {
    const { supervisor, driver } = harness();
    await supervisor.ensure("/tmp/ws-a");
    const receipt = await supervisor.stopOwned("test");
    expect(receipt.state).toBe("stopped");
    expect(supervisor.status().state).toBe("stopped");
    expect(driver.stops).toHaveLength(1);
    expect(driver.marks.at(-1)?.patch.state).toBe("stopped");
  });

  it("never stops an externally launched runtime", async () => {
    const { supervisor } = harness();
    supervisor.attachExternal({ workspace: "/tmp/ws-a", port: 7_123 });
    expect(supervisor.status()).toMatchObject({ external: true, state: "running" });
    await expect(supervisor.stopOwned("quit")).rejects.toMatchObject({
      code: "EXTERNAL_RUNTIME_NOT_OWNED",
    });
  });

  it("refuses to signal a record whose pid was reused", async () => {
    const { supervisor, store, driver } = harness();
    const live = readProcessEntry(process.pid);
    expect(live).not.toBeNull();
    store.put(
      recordFor("/tmp/other", process.pid, {
        childStartedAt: "Mon Jan  1 00:00:00 2001",
        supervisorPid: 999_999,
        supervisorStartedAt: "Mon Jan  1 00:00:00 2001",
      }),
    );
    await expect(supervisor.ensure("/tmp/ws-a")).rejects.toMatchObject({
      code: "STALE_OWNERSHIP",
    });
    expect(driver.stoppedRecords).toHaveLength(0);
    expect(driver.starts).toHaveLength(0);
  });

  it("stops a stale record for the same workspace before starting a new owner", async () => {
    const { supervisor, store, driver } = harness();
    const live = readProcessEntry(process.pid);
    expect(live).not.toBeNull();
    const stale = store.put(
      recordFor("/tmp/ws-a", process.pid, {
        childStartedAt: live?.startedAt ?? "",
        supervisorPid: 999_999,
        supervisorStartedAt: "Mon Jan  1 00:00:00 2001",
        executable: readExecutablePath(process.pid) ?? "",
      }),
    );
    await supervisor.ensure("/tmp/ws-a");
    expect(driver.stoppedRecords).toEqual([stale.id]);
    expect(driver.starts).toEqual(["/tmp/ws-a"]);
    expect(supervisor.status().state).toBe("running");
  });

  it("refuses to start beside a leftover runtime that will not stop", async () => {
    const { supervisor, store, driver } = harness();
    const live = readProcessEntry(process.pid);
    expect(live).not.toBeNull();
    store.put(
      recordFor("/tmp/ws-a", process.pid, {
        childStartedAt: live?.startedAt ?? "",
        supervisorPid: 999_999,
        supervisorStartedAt: "Mon Jan  1 00:00:00 2001",
        executable: readExecutablePath(process.pid) ?? "",
      }),
    );
    driver.stubborn = true;
    await expect(supervisor.ensure("/tmp/ws-a")).rejects.toMatchObject({
      code: "STALE_OWNERSHIP",
    });
    expect(driver.starts).toHaveLength(0);
    driver.stubborn = false;
  });

  it("recovers a verified orphan from a previous run", async () => {
    const { supervisor, store, driver } = harness();
    const live = readProcessEntry(process.pid);
    expect(live).not.toBeNull();
    const record = store.put(
      recordFor("/tmp/other", process.pid, {
        childStartedAt: live?.startedAt ?? "",
        supervisorPid: 999_999,
        supervisorStartedAt: "Mon Jan  1 00:00:00 2001",
        executable: readExecutablePath(process.pid) ?? "",
      }),
    );
    await supervisor.recover();
    expect(driver.stoppedRecords).toEqual([record.id]);
  });
});
