import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledEnginePath,
  findFreePort,
  startOwnedRuntime,
  verifyListenerOwnership,
} from "../src/main/engine/runtime-process";
import {
  listeningPids,
  readExecutablePath,
  readProcessEntry,
} from "../src/main/supervisor/identity";
import { newRecordId, OwnershipStore } from "../src/main/supervisor/records";
import { RuntimeLifecycleError } from "../src/main/supervisor/errors";
import { existsSync } from "node:fs";

const originalBin = process.env.CODEWHALE_BIN;
const hasSupervisor = (() => {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") return false;
    return existsSync(join(process.cwd(), "native/macos-supervisor/build/mona-supervisor"));
  } catch {
    return false;
  }
})();

afterEach(() => {
  if (originalBin === undefined) delete process.env.CODEWHALE_BIN;
  else process.env.CODEWHALE_BIN = originalBin;
});

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "mona-runtime-"));
}

describe("runtime startup states are actionable", () => {
  it("refuses a missing workspace before spawning anything", async () => {
    const dir = stateDir();
    process.env.CODEWHALE_BIN = "/usr/bin/true";
    await expect(
      startOwnedRuntime({
        workspace: join(dir, "does-not-exist"),
        stateDir: dir,
        port: await findFreePort(),
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
  });

  it("names a missing executable", async () => {
    const dir = stateDir();
    process.env.CODEWHALE_BIN = join(dir, "missing-binary");
    await expect(
      startOwnedRuntime({ workspace: dir, stateDir: dir, port: await findFreePort() }),
    ).rejects.toMatchObject({
      code: "MISSING_EXECUTABLE",
      action: expect.stringContaining("install"),
    });
  });

  it("names a non-executable file", async () => {
    const dir = stateDir();
    const file = join(dir, "not-executable");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    process.env.CODEWHALE_BIN = file;
    await expect(
      startOwnedRuntime({ workspace: dir, stateDir: dir, port: await findFreePort() }),
    ).rejects.toMatchObject({ code: "NOT_EXECUTABLE" });
  });

  it("reports an occupied port without spawning a runtime", async () => {
    const dir = stateDir();
    const port = await findFreePort();
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    try {
      process.env.CODEWHALE_BIN = "/usr/bin/true";
      const error = await startOwnedRuntime({
        workspace: dir,
        stateDir: dir,
        port,
        supervisorPath: "/nonexistent-supervisor",
      }).catch((caught: unknown) => caught);
      // Port preflight runs before the supervisor is spawned.
      expect(error).toBeInstanceOf(RuntimeLifecycleError);
      expect((error as RuntimeLifecycleError).code).toBe("PORT_IN_USE");
      expect((error as RuntimeLifecycleError).action).toContain("port");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a listener outside the supervised tree as a stranger", async () => {
    const port = await findFreePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      // No Runtime-store owner in this probe: the generic diagnosis stands.
      expect(() =>
        verifyListenerOwnership(port, unrelated.pid as number, "/bin/sh", { owner: () => null }),
      ).toThrowError(/outside the supervised tree/);
    } finally {
      unrelated.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("names the Runtime-store owner instead of blaming the port", async () => {
    const port = await findFreePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const [listenerPid] = listeningPids(port);
      expect(listenerPid).toBeGreaterThan(0);
      let error: unknown = null;
      try {
        verifyListenerOwnership(port, unrelated.pid as number, "/bin/sh", {
          owner: () => ({
            pid: listenerPid as number,
            executable: "/bin/sleep",
            command: "/bin/sleep 30",
            home: "/tmp/engine-home",
            lockPath: "/tmp/engine-home/tasks/runtime/runtime-process.owner.lock",
          }),
        });
      } catch (caught) {
        error = caught;
      }
      const lifecycle = error as RuntimeLifecycleError;
      expect(lifecycle.code).toBe("OWNERSHIP_MISMATCH");
      expect(lifecycle.message).toContain("another Codewhale runtime host already owns");
      expect(lifecycle.message).toContain(`pid ${listenerPid}`);
      expect(lifecycle.action).toContain("Mona does not attach to a runtime it did not start");
      expect(lifecycle.details?.strangers).toEqual([listenerPid]);
    } finally {
      unrelated.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses to start beside a record it cannot prove it owns", async () => {
    const dir = realpathSync(stateDir());
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
      store.put({
        id: newRecordId(),
        workspace: dir,
        canonicalWorkspace: dir,
        executable: "/bin/sleep",
        executableSha256: "d".repeat(64),
        supervisorPid: 999_999,
        supervisorStartedAt: "Mon Jan  1 00:00:00 2001",
        childPid: unrelated.pid as number,
        // A start time that cannot belong to this pid means "reused", not "ours".
        childStartedAt: "Mon Jan  1 00:00:00 2001",
        pgid: unrelated.pid as number,
        port: 1,
        baseUrl: "http://127.0.0.1:1",
        controlSocket: join(dir, "gone.sock"),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "running",
        engine: null,
        startupReceipt: null,
        stopReceipt: null,
      });
      process.env.CODEWHALE_BIN = "/usr/bin/true";
      const error = await startOwnedRuntime({
        workspace: dir,
        stateDir: dir,
        port: await findFreePort(),
      }).catch((caught: unknown) => caught);
      expect((error as RuntimeLifecycleError).code).toBe("STALE_OWNERSHIP");
      expect(unrelated.exitCode).toBeNull();
    } finally {
      unrelated.kill("SIGKILL");
    }
  });

  it("stops a verified orphan record before starting a new owner", async () => {
    const dir = realpathSync(stateDir());
    const orphan = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const entry = readProcessEntry(orphan.pid as number);
    expect(entry).not.toBeNull();
    const store = new OwnershipStore(join(dir, "runtime-ownership.json"));
    store.put({
      id: newRecordId(),
      workspace: dir,
      canonicalWorkspace: dir,
      executable: readExecutablePath(orphan.pid as number) ?? "/bin/sleep",
      executableSha256: "e".repeat(64),
      supervisorPid: 999_999,
      supervisorStartedAt: "Mon Jan  1 00:00:00 2001",
      childPid: orphan.pid as number,
      childStartedAt: entry?.startedAt ?? "",
      pgid: orphan.pid as number,
      port: 1,
      baseUrl: "http://127.0.0.1:1",
      controlSocket: join(dir, "gone.sock"),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "running",
      engine: null,
      startupReceipt: null,
      stopReceipt: null,
    });
    process.env.CODEWHALE_BIN = "/usr/bin/true";
    const error = await startOwnedRuntime({
      workspace: dir,
      stateDir: dir,
      port: await findFreePort(),
      startupTimeoutMs: 3_000,
    }).catch((caught: unknown) => caught);
    // The orphan is gone, so the start proceeds; the fake engine then fails.
    expect((error as RuntimeLifecycleError).code).toBe("STARTUP_FAILED");
    const record = store.list().find((candidate) => candidate.childPid === orphan.pid);
    expect(record?.state).toBe("stopped");
    let alive = true;
    try {
      process.kill(orphan.pid as number, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it.skipIf(!hasSupervisor)(
    "reports a runtime that exits during startup and records the failure",
    async () => {
      const dir = stateDir();
      process.env.CODEWHALE_BIN = "/usr/bin/false";
      const port = await findFreePort();
      const error = await startOwnedRuntime({
        workspace: dir,
        stateDir: dir,
        port,
        startupTimeoutMs: 8_000,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeLifecycleError);
      expect((error as RuntimeLifecycleError).code).toBe("STARTUP_FAILED");
      const records = new OwnershipStore(join(dir, "runtime-ownership.json")).list();
      expect(records).toHaveLength(1);
      expect(records[0]?.state).toBe("failed");
      expect(records[0]?.stopReceipt).toMatchObject({ via: "startup_failure" });
    },
    20_000,
  );
});

describe("bundled engine resolution", () => {
  it("finds the engine inside an app's resources only when it is executable", () => {
    const resources = mkdtempSync(join(tmpdir(), "mona-resources-"));
    mkdirSync(join(resources, "engine"));
    const engine = join(resources, "engine/codewhale");
    writeFileSync(engine, "#!/bin/sh\n", "utf8");
    chmodSync(engine, 0o755);
    expect(bundledEnginePath(resources)).toBe(engine);
    expect(bundledEnginePath(join(resources, "missing"))).toBeNull();
    expect(bundledEnginePath(undefined)).toBeNull();
  });
});
