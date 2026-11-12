// Minimal disposable client for the Codewhale Runtime API (`app-server --http`).
// Stdlib only: no dependency is added to the repository by the P01 spike.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { SseParser } from "./sse.mjs";

export const DEFAULT_BIN = process.env.CODEWHALE_BIN || "/opt/homebrew/bin/codewhale";

export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function newToken() {
  return randomBytes(24).toString("hex");
}

/**
 * Start one owned runtime. The bearer token travels through the environment,
 * never argv, and the child is this process's responsibility. A port stolen
 * between reservation and bind is retried with a fresh port.
 */
export async function startRuntime(options = {}) {
  const attempts = options.port ? 1 : 3;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await startOnce(options);
    } catch (error) {
      lastError = error;
      if (!/port_not_owned_by_child|runtime_exited|runtime_identity_port_mismatch/.test(error.message)) throw error;
    }
  }
  throw lastError;
}

const liveHandles = new Set();
let cleanupInstalled = false;
function track(handle) {
  liveHandles.add(handle);
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.on("exit", () => {
      for (const live of liveHandles) {
        try {
          killTree(live.child, "SIGKILL");
        } catch {}
      }
    });
  }
}

async function startOnce({
  bin = DEFAULT_BIN,
  workspace,
  port,
  token,
  extraEnv = {},
  startupTimeoutMs = 20_000,
  allowSharedOwner = false,
}) {
  const chosenPort = port ?? (await findFreePort());
  const chosenToken = token ?? newToken();
  // The npm wrapper resolves and spawns the native binary as a grandchild, so
  // the listener is not the immediate child. detached:true gives the whole
  // tree its own process group that this owner can signal without touching
  // unrelated Codewhale processes.
  const child = spawn(bin, ["app-server", "--http", "--host", "127.0.0.1", "--port", String(chosenPort)], {
    cwd: workspace,
    env: { ...process.env, ...extraEnv, CODEWHALE_RUNTIME_TOKEN: chosenToken },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const log = { stdout: "", stderr: "" };
  const capture = (which) => (chunk) => {
    log[which] += chunk.toString();
    if (log[which].length > 16_384) log[which] = log[which].slice(-16_384);
  };
  child.stdout.on("data", capture("stdout"));
  child.stderr.on("data", capture("stderr"));

  const baseUrl = `http://127.0.0.1:${chosenPort}`;
  const client = new RuntimeClient({ baseUrl, token: chosenToken });
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime_exited code=${child.exitCode} stderr=${log.stderr.slice(-2000)}`);
    }
    try {
      const health = await client.request("GET", "/health", undefined, { timeoutMs: 1000 });
      if (health.status === 200 && health.body?.status === "ok") {
        const identity = await verifyOwnership({ child, port: chosenPort, client, log, allowSharedOwner });
        const handle = { child, client, port: chosenPort, token: chosenToken, baseUrl, identity, log };
        track(handle);
        return handle;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  killTree(child, "SIGTERM");
  throw new Error(`runtime_start_timeout last=${lastError?.message ?? "none"} stderr=${log.stderr.slice(-2000)}`);
}

/** Verify the listening port belongs to our child's process tree, not merely that a port answers. */
export async function verifyOwnership({ child, port, client, log, allowSharedOwner = false }) {
  const pid = child.pid;
  const info = await client.request("GET", "/v1/runtime/info", undefined, { timeoutMs: 3000 });
  if (info.status !== 200) throw new Error(`runtime_info_status=${info.status}`);
  if (Number(info.body.port) !== port) {
    throw new Error(`runtime_identity_port_mismatch expected=${port} got=${info.body.port}`);
  }
  const tree = processTree(pid);
  const listeners = listeningPids(port);
  const owned = listeners.filter((listener) => tree.has(listener));
  if (owned.length === 0) {
    const raw = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout;
    if (allowSharedOwner && listeners.length > 0) {
      return {
        pid,
        listener_pid: listeners[0],
        descendants: [...tree],
        port,
        owned_socket: false,
        shared_owner_pid: listeners[0],
        codewhale_version: info.body.codewhale_version,
        codewhale_commit: info.body.codewhale_commit,
        capabilities: info.body.capabilities,
      };
    }
    throw new Error(
      `port_not_owned_by_child pid=${pid} port=${port} listeners=${listeners.join(",") || "none"} ` +
        `tree=${[...tree].join(",")} lsof=${JSON.stringify(raw?.slice(0, 400))} stderr=${(log.stderr || "").slice(-500)}`,
    );
  }
  return {
    pid,
    listener_pid: owned[0],
    descendants: [...tree],
    port,
    owned_socket: true,
    codewhale_version: info.body.codewhale_version,
    codewhale_commit: info.body.codewhale_commit,
    capabilities: info.body.capabilities,
  };
}

/** PIDs in the subtree rooted at `root`, including root (via ps ppid edges). */
export function processTree(root) {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map();
  for (const line of (ps.stdout || "").trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const next of children.get(queue.shift()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** PIDs listening on a loopback TCP port, via lsof field output. */
export function listeningPids(port) {
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" });
  const pids = (lsof.stdout || "")
    .split("\n")
    .filter((line) => line.startsWith("p"))
    .map((line) => Number(line.slice(1)))
    .filter(Boolean);
  return [...new Set(pids)];
}

/** Signal the child's whole process group, never processes by name. */
export function killTree(child, signal = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

export async function stopRuntime(handle, { timeoutMs = 8000 } = {}) {
  if (!handle?.child || handle.child.exitCode !== null) {
    liveHandles.delete(handle);
    return { stopped: true, alreadyExited: true };
  }
  const child = handle.child;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  killTree(child, "SIGTERM");
  const result = await Promise.race([exited, sleep(timeoutMs).then(() => null)]);
  if (result === null) {
    killTree(child, "SIGKILL");
    await exited;
    const remaining = listeningPids(handle.port);
    liveHandles.delete(handle);
    return { stopped: true, forced: true, remaining_listeners: remaining };
  }
  const remaining = listeningPids(handle.port);
  liveHandles.delete(handle);
  return { stopped: true, forced: false, remaining_listeners: remaining, ...result };
}

export class RuntimeClient {
  constructor({ baseUrl, token }) {
    if (!baseUrl || !token) throw new Error("baseUrl and token are required");
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async request(method, path, body, { timeoutMs = 30_000, headers = {} } = {}) {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), text, body: parsed };
  }

  /**
   * Follow a thread event stream. `onEvent` receives parsed envelopes plus
   * transport frames. Resolves when the stream ends or when `signal` aborts.
   */
  async streamThread(threadId, { sinceSeq, replayLimit, progress = true, onEvent, signal } = {}) {
    const params = new URLSearchParams();
    if (sinceSeq !== undefined && sinceSeq !== null) params.set("since_seq", String(sinceSeq));
    if (replayLimit !== undefined) params.set("replay_limit", String(replayLimit));
    if (progress) params.set("progress", "true");
    const query = params.toString();
    const response = await fetch(
      `${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events${query ? "?" + query : ""}`,
      {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
        signal,
      },
    );
    if (response.status !== 200) {
      const text = await response.text();
      throw new Error(`sse_status=${response.status} body=${text.slice(0, 500)}`);
    }
    const parser = new SseParser();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let frames = 0;
    for await (const chunk of response.body) {
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        frames += 1;
        if (onEvent) await onEvent(frame);
        if (frame.event === "stream.end") return { frames, lastEventId: parser.lastEventId };
      }
    }
    const remainder = decoder.decode();
    if (remainder) {
      for (const frame of parser.push(remainder)) {
        frames += 1;
        if (onEvent) await onEvent(frame);
      }
    }
    return { frames, lastEventId: parser.lastEventId, tail: parser.tail() };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout_waiting_for_${label}`);
}
