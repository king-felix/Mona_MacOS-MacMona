import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProcessEntry } from "../src/main/supervisor/identity";
import {
  controlRequest,
  resolveSupervisorBinary,
  startSupervisor,
  stopByVerifiedIdentity,
  stopSupervisor,
  type SupervisorHandle,
} from "../src/main/supervisor/native";

function supervisorBinary(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  try {
    const path = resolveSupervisorBinary();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const BINARY = supervisorBinary();
const enabled = BINARY !== null;

function isLive(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = (result.stdout ?? "").trim();
  return stat.length > 0 && !stat.startsWith("Z");
}

function readPids(path: string): number[] {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

interface Tree {
  handle: SupervisorHandle;
  dir: string;
  pids: number[];
  stop: () => Promise<void>;
}

async function startTree(script: string, options: { graceMs?: number } = {}): Promise<Tree> {
  if (!BINARY) throw new Error("supervisor binary unavailable");
  const dir = mkdtempSync(join(tmpdir(), "mona-native-"));
  const marker = join(dir, "pids");
  const parent = join(dir, "parent.cjs");
  writeFileSync(parent, script, "utf8");
  const handle = await startSupervisor({
    binary: BINARY,
    workspace: dir,
    executable: process.execPath,
    args: [parent, marker],
    controlSocket: join(dir, "control.sock"),
    token: "0123456789abcdef0123456789abcdef",
    graceMs: options.graceMs ?? 700,
  });
  const ready = await waitFor(() => existsSync(marker));
  if (!ready) {
    await stopSupervisor(handle, { graceMs: 500, force: true });
    throw new Error("tree did not report its pids");
  }
  const pids = readPids(marker);
  return {
    handle,
    dir,
    pids,
    stop: async () => {
      return await stopSupervisor(handle, { graceMs: options.graceMs ?? 700 });
    },
  };
}

const GRACEFUL_PARENT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const detached = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  detached: true,
  stdio: "ignore",
});
const plain = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
writeFileSync(process.argv[2], [process.pid, detached.pid, plain.pid].join(" "));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe.skipIf(!enabled)("native supervisor", () => {
  it("stops the entire owned tree and leaves unrelated processes alone", async () => {
    const unrelated = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    const tree = await startTree(GRACEFUL_PARENT);
    try {
      expect(tree.pids.every(isLive)).toBe(true);
      const receipt = await tree.stop();
      expect(receipt.state).toBe("stopped");
      expect(receipt.survivors).toEqual([]);
      expect(await waitFor(() => tree.pids.every((pid) => !isLive(pid)))).toBe(true);
      expect(isLive(unrelated.pid as number)).toBe(true);
    } finally {
      await tree.stop();
      unrelated.kill("SIGKILL");
    }
  }, 20_000);

  it("records the escaped process group and stops it by identity", async () => {
    const tree = await startTree(GRACEFUL_PARENT);
    try {
      const [parent, detached, plain] = tree.pids;
      const parentEntry = readProcessEntry(parent as number);
      const detachedEntry = readProcessEntry(detached as number);
      expect(parentEntry).not.toBeNull();
      expect(detachedEntry).not.toBeNull();
      // The detached grandchild escaped the owned process group.
      expect(detachedEntry?.pgid).not.toBe(parentEntry?.pgid);
      expect(plain).toBeGreaterThan(0);

      let tracked = 0;
      await waitFor(() => {
        const status = spawnSync(
          "/bin/sh",
          [
            "-c",
            `printf '{"op":"status"}\n' | nc -U -w 1 '${tree.handle.controlSocket}' 2>/dev/null | head -1`,
          ],
          { encoding: "utf8" },
        );
        try {
          tracked = Number((JSON.parse(status.stdout.trim()) as { tracked?: number }).tracked ?? 0);
        } catch {
          tracked = 0;
        }
        return tracked >= 3;
      }, 5_000);
      expect(tracked).toBeGreaterThanOrEqual(3);

      const receipt = await tree.stop();
      expect(receipt.state).toBe("stopped");
      expect(await waitFor(() => tree.pids.every((pid) => !isLive(pid)))).toBe(true);
    } finally {
      await tree.stop();
    }
  }, 20_000);

  it("escalates a TERM-ignoring tree to a bounded SIGKILL", async () => {
    const tree = await startTree(
      `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const stubborn = spawn("/bin/sh", ["-c", 'trap "" TERM; sleep 300'], { stdio: "ignore" });
writeFileSync(process.argv[2], [process.pid, stubborn.pid].join(" "));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      { graceMs: 600 },
    );
    try {
      const receipt = await tree.stop();
      expect(receipt.state).toBe("stopped");
      expect(receipt.escalated).toBe(true);
      expect(await waitFor(() => tree.pids.every((pid) => !isLive(pid)))).toBe(true);
    } finally {
      await tree.stop();
    }
  }, 20_000);

  it("stops the tree when the owner-liveness channel closes", async () => {
    const tree = await startTree(GRACEFUL_PARENT);
    try {
      tree.handle.closeOwnerChannel();
      expect(await waitFor(() => tree.pids.every((pid) => !isLive(pid)), 8_000)).toBe(true);
      expect(await waitFor(() => tree.handle.exitCode() !== null, 5_000)).toBe(true);
    } finally {
      await tree.stop();
    }
  }, 20_000);

  it("never signals a live pid whose start time does not match", async () => {
    const unrelated = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    try {
      await waitFor(() => readProcessEntry(unrelated.pid as number) !== null);
      const receipt = await stopByVerifiedIdentity({
        childPid: unrelated.pid as number,
        childStartedAt: "Mon Jan  1 00:00:00 2001",
        pgid: unrelated.pid as number,
      });
      expect(receipt.state).toBe("identity_mismatch");
      expect(isLive(unrelated.pid as number)).toBe(true);
    } finally {
      unrelated.kill("SIGKILL");
    }
  }, 10_000);

  it("reports a supervisor-level status receipt with the tracked tree", async () => {
    const tree = await startTree(GRACEFUL_PARENT);
    try {
      const status = await controlRequest(tree.handle.controlSocket, { op: "status" }, 3_000);
      expect(status.ok).toBe(true);
      expect(status.state).toBe("running");
      expect(status.child_pid).toBe(tree.handle.childPid);
      expect(Array.isArray(status.alive)).toBe(true);
    } finally {
      await tree.stop();
    }
  }, 20_000);
});

describe("native supervisor availability", () => {
  it("reports why native qualification is skipped when unavailable", () => {
    if (enabled) {
      expect(BINARY).toContain("mona-supervisor");
      return;
    }
    expect(["darwin", "linux", "win32"]).toContain(process.platform);
  });
});
