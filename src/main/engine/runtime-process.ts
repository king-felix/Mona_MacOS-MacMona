import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { createServer } from "node:net";
import { AdapterError } from "./errors";
import { HttpRuntimeTransport, type RuntimeTransport } from "./transport";
import type { RuntimeHandle, RuntimeStartInput } from "./types";

const NATIVE_BINARY = "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale";
const WRAPPER_BINARY = "/opt/homebrew/bin/codewhale";

export interface ResolvedBinary {
  path: string;
  source: "env" | "installed_native";
}

/**
 * Resolve the self-contained native binary. The npm wrapper is deliberately not
 * accepted here: it adds a Node process layer and moves the listener into a
 * grandchild, which complicates ownership. Packaging (P21) bundles the native
 * binary; P03 fails closed rather than guessing.
 */
export function resolveEngineBinary(): ResolvedBinary {
  const fromEnv = process.env.CODEWHALE_BIN;
  if (fromEnv) {
    if (!isExecutable(fromEnv)) {
      throw new AdapterError("RUNTIME_UNAVAILABLE", `CODEWHALE_BIN is not executable: ${fromEnv}`);
    }
    return { path: fromEnv, source: "env" };
  }
  if (isExecutable(NATIVE_BINARY)) {
    return { path: NATIVE_BINARY, source: "installed_native" };
  }
  if (existsSync(WRAPPER_BINARY)) {
    throw new AdapterError(
      "RUNTIME_UNAVAILABLE",
      "only the npm wrapper was found; the native Codewhale binary is required for owned runtime control",
      false,
      { wrapper: WRAPPER_BINARY, expected_native: NATIVE_BINARY },
    );
  }
  throw new AdapterError("RUNTIME_UNAVAILABLE", "no Codewhale binary found");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

export interface OwnedProcess {
  child: ChildProcess;
  handle: RuntimeHandle;
  transport: RuntimeTransport;
  log: () => string;
}

export async function startOwnedRuntime(input: RuntimeStartInput): Promise<OwnedProcess> {
  const binary = resolveEngineBinary();
  const port = input.port ?? (await findFreePort());
  const token = randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const child = spawn(
    binary.path,
    ["app-server", "--http", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: input.workspace,
      env: { ...process.env, ...input.env, CODEWHALE_RUNTIME_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let stderr = "";
  const capture = (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
  };
  child.stderr?.on("data", capture);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new AdapterError(
        "RUNTIME_UNAVAILABLE",
        `runtime exited with ${child.exitCode}`,
        false,
        {
          stderr: stderr.slice(-2000),
        },
      );
    }
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) {
        const infoResponse = await fetch(`${baseUrl}/v1/runtime/info`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        });
        const info = (await infoResponse.json()) as { port?: number };
        if (Number(info.port) !== port) {
          throw new AdapterError("RUNTIME_UNAVAILABLE", "runtime reported a different port");
        }
        const listeners = listeningPids(port);
        const tree = processTree(child.pid ?? -1);
        const listenerPid = listeners.find((pid) => tree.has(pid));
        if (!listenerPid) {
          throw new AdapterError(
            "RUNTIME_UNAVAILABLE",
            "listener is not owned by the spawned process",
            false,
            {
              listeners,
              tree: [...tree],
            },
          );
        }
        const handle: RuntimeHandle = {
          pid: child.pid ?? -1,
          listenerPid,
          port,
          baseUrl,
          executable: binary.path,
          startedAt,
        };
        rememberOwnedChild(handle.pid, child);
        return {
          child,
          handle,
          transport: new HttpRuntimeTransport({ baseUrl, token }),
          log: () => stderr,
        };
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;
    }
    await sleep(120);
  }
  killTree(child, "SIGTERM");
  throw new AdapterError("RUNTIME_UNAVAILABLE", "runtime start timed out", false, {
    stderr: stderr.slice(-2000),
  });
}

export async function stopOwnedRuntime(
  handle: RuntimeHandle,
  timeoutMs = 8000,
): Promise<{ stopped: boolean }> {
  const child = ownedChildren.get(handle.pid);
  if (!child || child.exitCode !== null) return { stopped: true };
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  killTree(child, "SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    killTree(child, "SIGKILL");
    await exited;
  }
  ownedChildren.delete(handle.pid);
  return { stopped: true };
}

const ownedChildren = new Map<number, ChildProcess>();

export function rememberOwnedChild(pid: number, child: ChildProcess): void {
  ownedChildren.set(pid, child);
}

export function processTree(root: number): Set<number> {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of (result.stdout ?? "").trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const next of children.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function listeningPids(port: number): number[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
  });
  return [
    ...new Set(
      (result.stdout ?? "")
        .split("\n")
        .filter((line) => line.startsWith("p"))
        .map((line) => Number(line.slice(1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
