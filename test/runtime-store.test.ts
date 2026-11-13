import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRuntimeStoreAvailable } from "../src/main/engine/runtime-process";
import {
  codewhaleHome,
  describeRuntimeStoreOwner,
  runtimeStoreOwner,
  runtimeStorePaths,
} from "../src/main/engine/runtime-store";
import { RuntimeLifecycleError } from "../src/main/supervisor/errors";
import { newRecordId, OwnershipStore } from "../src/main/supervisor/records";

const lsofAvailable = spawnSync("lsof", ["-v"], { encoding: "utf8" }).status !== null;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A live process that keeps the lock open, exactly as a store owner would. */
function holdLock(lockPath: string): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');fs.openSync(process.argv[1],'r+');setInterval(()=>{},1000);",
      lockPath,
    ],
    { stdio: "ignore" },
  );
}

function prepareHome(): { home: string; lockPath: string } {
  const home = tempDir("mona-store-home-");
  const paths = runtimeStorePaths(home);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.ownerLock, "");
  writeFileSync(paths.ownerFile, JSON.stringify({ owner_id: "owner_test" }));
  return { home, lockPath: paths.ownerLock };
}

const holders: Array<ReturnType<typeof spawn>> = [];
const savedHome = process.env.CODEWHALE_HOME;

afterEach(() => {
  for (const child of holders.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  if (savedHome === undefined) delete process.env.CODEWHALE_HOME;
  else process.env.CODEWHALE_HOME = savedHome;
});

describe("engine home resolution", () => {
  it("honours an absolute CODEWHALE_HOME and ignores a bare name", () => {
    expect(codewhaleHome({ CODEWHALE_HOME: "/tmp/engine-home" }, "/Users/example")).toBe(
      "/tmp/engine-home",
    );
    expect(codewhaleHome({ CODEWHALE_HOME: "engine-home" }, "/Users/example")).toBe(
      "/Users/example/.codewhale",
    );
    expect(codewhaleHome({}, "/Users/example")).toBe("/Users/example/.codewhale");
  });

  it("names the owner lock inside the shared runtime store", () => {
    const paths = runtimeStorePaths("/tmp/engine-home");
    expect(paths.directory).toBe("/tmp/engine-home/tasks/runtime");
    expect(paths.ownerLock).toBe("/tmp/engine-home/tasks/runtime/runtime-process.owner.lock");
  });
});

describe("runtime store owner probe", () => {
  it("reports no owner when the store has no lock file", () => {
    const home = tempDir("mona-store-empty-");
    expect(runtimeStoreOwner({ home })).toBeNull();
  });

  it("reports no owner when the lock file has no live holder", () => {
    const home = tempDir("mona-store-idle-");
    const paths = runtimeStorePaths(home);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.ownerLock, "");
    expect(runtimeStoreOwner({ home })).toBeNull();
  });

  it("names the live holder without touching it", () => {
    const { home, lockPath } = prepareHome();
    const holder = holdLock(lockPath);
    holders.push(holder);
    const owner = runtimeStoreOwner({ home, holders: () => [holder.pid as number, 999_999] });
    expect(owner?.pid).toBe(holder.pid);
    expect(owner?.home).toBe(home);
    expect(describeRuntimeStoreOwner(owner!)).toContain(`pid ${holder.pid}`);
    expect(holder.exitCode).toBeNull();
  });
});

describe("start preflight", () => {
  const store = () => new OwnershipStore(join(tempDir("mona-store-records-"), "ownership.json"));

  it("allows a start when nothing owns the store", () => {
    process.env.CODEWHALE_HOME = tempDir("mona-store-free-");
    expect(() => assertRuntimeStoreAvailable(store())).not.toThrow();
  });

  it.skipIf(!lsofAvailable)(
    "refuses a start when another Codewhale host owns the store, and names it",
    () => {
      const { home, lockPath } = prepareHome();
      process.env.CODEWHALE_HOME = home;
      const holder = holdLock(lockPath);
      holders.push(holder);
      // Give lsof a moment to see the descriptor.
      const deadline = Date.now() + 3_000;
      let owner = null as ReturnType<typeof runtimeStoreOwner>;
      while (Date.now() < deadline) {
        owner = runtimeStoreOwner({ home });
        if (owner) break;
        spawnSync("sleep", ["0.05"]);
      }
      expect(owner?.pid).toBe(holder.pid);
      let error: unknown = null;
      try {
        assertRuntimeStoreAvailable(store());
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RuntimeLifecycleError);
      const lifecycle = error as RuntimeLifecycleError;
      expect(lifecycle.code).toBe("ALREADY_OWNED");
      expect(lifecycle.message).toContain("another Codewhale runtime host already owns");
      expect(lifecycle.message).toContain(`pid ${holder.pid}`);
      expect(lifecycle.action).toContain("quit that host");
      expect(lifecycle.details?.store).toBe(runtimeStorePaths(home).directory);
      // Mona never signals a store it does not own.
      expect(holder.exitCode).toBeNull();
    },
  );

  it.skipIf(!lsofAvailable)("names Mona's own leftover runtime as the owner", () => {
    const { home, lockPath } = prepareHome();
    process.env.CODEWHALE_HOME = home;
    const holder = holdLock(lockPath);
    holders.push(holder);
    const ownership = store();
    const workspace = tempDir("mona-store-other-workspace-");
    ownership.put({
      id: newRecordId(),
      workspace,
      canonicalWorkspace: workspace,
      executable: process.execPath,
      executableSha256: "a".repeat(64),
      supervisorPid: holder.pid as number,
      supervisorStartedAt: "Wed Nov 12 00:00:00 2026",
      childPid: holder.pid as number,
      childStartedAt: "Wed Nov 12 00:00:00 2026",
      pgid: holder.pid as number,
      port: 1,
      baseUrl: "http://127.0.0.1:1",
      controlSocket: join(home, "run", "test.sock"),
      startedAt: "2026-11-12T00:00:00.000Z",
      updatedAt: "2026-11-12T00:00:00.000Z",
      state: "failed",
      engine: null,
      startupReceipt: null,
      stopReceipt: null,
    });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && runtimeStoreOwner({ home }) === null) {
      spawnSync("sleep", ["0.05"]);
    }
    let error: unknown = null;
    try {
      assertRuntimeStoreAvailable(ownership);
    } catch (caught) {
      error = caught;
    }
    const lifecycle = error as RuntimeLifecycleError;
    expect(lifecycle.code).toBe("ALREADY_OWNED");
    expect(lifecycle.message).toContain("Mona's own runtime for");
    expect(lifecycle.message).toContain(workspace);
    expect(lifecycle.action).toContain("stop that runtime");
    expect(holder.exitCode).toBeNull();
  });
});
