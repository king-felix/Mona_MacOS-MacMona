import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { RuntimeLifecycleError } from "../supervisor/errors";
import {
  descendantsOf,
  listeningPids,
  probePort,
  readExecutablePath,
  readProcessEntry,
  readProcessTable,
} from "../supervisor/identity";
import {
  controlRequest,
  resolveSupervisorBinary,
  startSupervisor,
  stopByVerifiedIdentity,
  stopSupervisor,
  type SupervisorHandle,
  type SupervisorStopReceipt,
} from "../supervisor/native";
import {
  classifyOwnership,
  executableDigest,
  controlSocketPath,
  newRecordId,
  OwnershipStore,
  type OwnershipRecord,
  type RuntimeIdentity,
} from "../supervisor/records";
import { evaluateCompatibility } from "./compat";
import { AdapterError } from "./errors";
import {
  describeRuntimeStoreOwner,
  runtimeStoreOwner,
  runtimeStorePaths,
  type RuntimeStoreOwner,
} from "./runtime-store";
import type { RuntimeHandle, RuntimeStartInput } from "./types";
import { WireRuntimeInfo } from "./wire";

const NATIVE_BINARY = "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale";
const WRAPPER_BINARY = "/opt/homebrew/bin/codewhale";
const BUNDLED_RELATIVE = "engine/codewhale";

export interface ResolvedBinary {
  path: string;
  realPath: string;
  sha256: string;
  source: "env" | "bundled" | "installed_native";
}

export interface OwnedRuntime {
  supervisor: SupervisorHandle;
  runtime: RuntimeHandle;
  token: string;
  engine: RuntimeIdentity;
  listenerPid: number;
  record: OwnershipRecord;
  store: OwnershipStore;
  log: () => string;
}

const registry = new Map<number, OwnedRuntime>();

/**
 * The engine carried inside a packaged Mona. Only an installed bundle has a
 * resources directory; a development checkout falls through to the pinned
 * host installation, so `npm start` keeps working without packaging.
 */
export function bundledEnginePath(resourcesPath = process.resourcesPath): string | null {
  if (!resourcesPath) return null;
  const candidate = join(resourcesPath, BUNDLED_RELATIVE);
  return isExecutable(candidate) ? candidate : null;
}

/**
 * Resolve the self-contained native binary. The npm wrapper is deliberately not
 * accepted for owned runtimes: it adds a Node process layer and moves the
 * listener into a grandchild, which weakens identity checks. The path is
 * resolved to its real location and hashed so the record names the exact bytes.
 *
 * Order: an explicit CODEWHALE_BIN adoption, then the engine packaged inside
 * Mona, then the pinned host installation used by development builds. The
 * bundle is preferred over the host so a recipient never runs a different
 * engine merely because Homebrew happens to be present.
 */
export function resolveEngineBinary(): ResolvedBinary {
  const fromEnv = process.env.CODEWHALE_BIN;
  if (fromEnv) return describeBinary(fromEnv, "env");
  const bundled = bundledEnginePath();
  if (bundled) return describeBinary(bundled, "bundled");
  if (isExecutable(NATIVE_BINARY)) return describeBinary(NATIVE_BINARY, "installed_native");
  if (existsSync(WRAPPER_BINARY)) {
    throw new RuntimeLifecycleError(
      "MISSING_EXECUTABLE",
      "only the npm wrapper was found; the native Codewhale binary is required for owned runtime control",
      "install the native Codewhale build or set CODEWHALE_BIN to the native executable",
      { wrapper: WRAPPER_BINARY, expected_native: NATIVE_BINARY },
    );
  }
  throw new RuntimeLifecycleError(
    "MISSING_EXECUTABLE",
    "no Codewhale engine found",
    process.resourcesPath
      ? "reinstall Mona; the engine packaged inside the app is missing"
      : "install Codewhale or set CODEWHALE_BIN",
    {
      expected_native: process.resourcesPath
        ? join(process.resourcesPath, BUNDLED_RELATIVE)
        : NATIVE_BINARY,
    },
  );
}

function describeBinary(path: string, source: ResolvedBinary["source"]): ResolvedBinary {
  // External adoption is an explicit absolute path with recorded provenance.
  // A bare name would let the GUI launch environment resolve a different
  // binary than the one Mona hashed and displayed.
  if (source === "env" && !path.startsWith("/")) {
    throw new RuntimeLifecycleError(
      "MISSING_EXECUTABLE",
      `CODEWHALE_BIN must be an absolute path, not a PATH name: ${path}`,
      "set CODEWHALE_BIN to the full path of the adopted binary, or unset it to use the bundled engine",
      { executable: path },
    );
  }
  if (!existsSync(path)) {
    throw new RuntimeLifecycleError(
      "MISSING_EXECUTABLE",
      `Codewhale binary does not exist: ${path}`,
      "install the pinned Codewhale engine or set CODEWHALE_BIN",
      { executable: path },
    );
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new RuntimeLifecycleError(
      "NOT_EXECUTABLE",
      `Codewhale binary is not executable: ${path}`,
      "fix the file permissions or point CODEWHALE_BIN at an executable",
      { executable: path },
    );
  }
  const realPath = realpathSync(path);
  return { path, realPath, sha256: executableDigest(realPath), source };
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
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await findFreePort();
    const availability = await probePort(port);
    if (availability.free) return port;
  }
  throw new RuntimeLifecycleError(
    "PORT_IN_USE",
    "could not reserve a loopback port",
    "close other local services or retry",
  );
}

async function assertPortAvailable(port: number): Promise<void> {
  const availability = await probePort(port);
  if (availability.free) return;
  if (availability.reason === "permission_denied") {
    throw new RuntimeLifecycleError(
      "PERMISSION_DENIED",
      `permission denied binding 127.0.0.1:${port}`,
      "choose a port above 1024 or run from an account that may bind it",
      { port },
    );
  }
  throw new RuntimeLifecycleError(
    "PORT_IN_USE",
    `127.0.0.1:${port} is already in use`,
    "stop the process using the port or let Mona choose a free one",
    {
      port,
      listeners: availability.listeners,
      ownership_note: "an HTTP 200 on this port does not make it Mona's runtime",
    },
  );
}

/**
 * One runtime per user store, enforced below the desktop layer too: a live or
 * orphaned record for this workspace is reconciled first, and a record whose
 * pid cannot be proven ours blocks the start instead of being signalled.
 */
/**
 * The engine keeps one Runtime store per user home, so a second host in that
 * home (another Codewhale window, `codewhale web`, `serve --http`, a second
 * Mona) serves this runtime's port instead of this runtime. Detect that before
 * spending a spawn on it, and say what actually happened.
 *
 * Probing never blocks a start it cannot explain: an unreadable lock or a
 * missing `lsof` falls through to the listener check, which still refuses.
 */
export function assertRuntimeStoreAvailable(store: OwnershipStore): void {
  let owner: RuntimeStoreOwner | null = null;
  try {
    owner = runtimeStoreOwner();
  } catch {
    return;
  }
  if (!owner) return;
  const description = describeRuntimeStoreOwner(owner);
  // A leftover of Mona's own making is a different answer from a stranger's
  // host: the user can stop it from Mona, and the record already knows where.
  const known = store
    .list()
    .find((record) => record.childPid === owner.pid || record.supervisorPid === owner.pid);
  if (known) {
    throw new RuntimeLifecycleError(
      "ALREADY_OWNED",
      `Mona's own runtime for ${known.workspace} still owns this user's Codewhale store (${description})`,
      "stop that runtime from the Mona window that started it, then start this one; Mona will not share one store between two owners",
      {
        owner: { ...owner },
        ownership: { id: known.id, workspace: known.workspace, state: known.state },
        store: runtimeStorePaths(owner.home).directory,
      },
    );
  }
  throw new RuntimeLifecycleError(
    "ALREADY_OWNED",
    `another Codewhale runtime host already owns this user's Codewhale store (${description})`,
    "quit that host — its Codewhale window, `codewhale web`, `codewhale serve --http`, or a second Mona — then start this runtime again; Mona does not attach to a runtime it did not start",
    { owner: { ...owner }, store: runtimeStorePaths(owner.home).directory },
  );
}

async function assertNoLiveOwner(store: OwnershipStore, canonical: string): Promise<void> {
  const existing = store.forWorkspace(canonical);
  if (!existing) return;
  const evidence = classifyOwnership(existing);
  if (evidence.verdict === "live_owned" || evidence.verdict === "orphaned_owned") {
    const receipt = await stopRecordedRuntime(existing);
    store.put({
      ...existing,
      state: receipt.state === "stopped" ? "stopped" : "failed",
      updatedAt: new Date().toISOString(),
      stopReceipt: receipt as unknown as Record<string, unknown>,
    });
    if (receipt.state === "stopped") return;
    throw new RuntimeLifecycleError(
      "ALREADY_OWNED",
      `a runtime for this workspace did not stop (${receipt.state})`,
      "inspect the process tree; Mona will not start a second owner",
      { record: existing.id, survivors: receipt.survivors },
    );
  }
  if (evidence.verdict === "pid_reused" || evidence.verdict === "foreign_executable") {
    throw new RuntimeLifecycleError(
      "STALE_OWNERSHIP",
      evidence.note,
      "inspect the leftover process; Mona will not signal a pid it cannot prove it started",
      { record: existing.id, verdict: evidence.verdict },
    );
  }
  store.put({
    ...existing,
    state: "stopped",
    updatedAt: new Date().toISOString(),
    stopReceipt: { via: "record_reconcile", note: evidence.note, signaled: false },
  });
}

function canonicalWorkspace(workspace: string): string {
  let stats;
  try {
    stats = statSync(workspace);
  } catch {
    throw new RuntimeLifecycleError(
      "WORKSPACE_UNAVAILABLE",
      `workspace does not exist: ${workspace}`,
      "choose an existing folder",
      { workspace },
    );
  }
  if (!stats.isDirectory()) {
    throw new RuntimeLifecycleError(
      "WORKSPACE_UNAVAILABLE",
      `workspace is not a folder: ${workspace}`,
      "choose a folder, not a file",
      { workspace },
    );
  }
  return realpathSync(workspace);
}

export function defaultStateDir(): string {
  return join(homedir(), "Library", "Application Support", "Mona", "state");
}

function tail(path: string, bytes = 4_000): string {
  if (!existsSync(path)) return "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, Math.max(0, size - length));
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export async function startOwnedRuntime(input: RuntimeStartInput): Promise<OwnedRuntime> {
  const canonical = canonicalWorkspace(input.workspace);
  const binary = resolveEngineBinary();
  const supervisorBinary = resolveSupervisorBinary(input.supervisorPath);
  const stateDir = input.stateDir ?? defaultStateDir();
  const store = input.store ?? new OwnershipStore(join(stateDir, "runtime-ownership.json"));
  await assertNoLiveOwner(store, canonical);
  assertRuntimeStoreAvailable(store);
  const port = input.port ?? (await allocatePort());
  if (input.port !== undefined) await assertPortAvailable(port);

  const id = newRecordId();
  const controlSocket = controlSocketPath(stateDir, id);
  const logDir = input.logDir ?? join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${id}.log`);
  const startedAt = new Date().toISOString();
  const token = randomBytes(24).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;

  let record: OwnershipRecord = {
    id,
    workspace: input.workspace,
    canonicalWorkspace: canonical,
    executable: binary.realPath,
    executableSha256: binary.sha256,
    supervisorPid: -1,
    supervisorStartedAt: "",
    childPid: -1,
    childStartedAt: "",
    pgid: -1,
    port,
    baseUrl,
    controlSocket,
    startedAt,
    updatedAt: startedAt,
    state: "starting",
    engine: null,
    startupReceipt: null,
    stopReceipt: null,
  };
  store.put(record);

  let supervisor: SupervisorHandle | null = null;
  try {
    supervisor = await startSupervisor({
      binary: supervisorBinary,
      workspace: canonical,
      executable: binary.realPath,
      args: ["app-server", "--http", "--host", "127.0.0.1", "--port", String(port)],
      controlSocket,
      token,
      logPath,
      graceMs: input.graceMs ?? 8_000,
      label: "codewhale-runtime",
      env: input.env,
      timeoutMs: 10_000,
    });

    const supervisorStartedAt = readProcessEntry(supervisor.pid)?.startedAt;
    if (!supervisorStartedAt) {
      throw new RuntimeLifecycleError(
        "SUPERVISOR_UNAVAILABLE",
        "the supervisor exited before its identity could be recorded",
        "run `npm run build:supervisor` and check the runtime log",
      );
    }
    verifyChildIdentity(supervisor, binary.realPath);

    record = store.put({
      ...record,
      supervisorPid: supervisor.pid,
      supervisorStartedAt,
      childPid: supervisor.childPid,
      childStartedAt: supervisor.childStartedAt,
      pgid: supervisor.pgid,
      startupReceipt: { ...supervisor.startedReceipt },
      updatedAt: new Date().toISOString(),
    });

    const info = await awaitRuntimeReady({
      baseUrl,
      port,
      token,
      supervisor,
      timeoutMs: input.startupTimeoutMs ?? 25_000,
      logPath,
    });
    const compatibility = evaluateCompatibility(info);
    const engine: RuntimeIdentity = {
      version: info.codewhale_version,
      commit: info.codewhale_commit,
    };
    const listenerPid = verifyListenerOwnership(port, supervisor.childPid, binary.realPath);

    record = store.put({
      ...record,
      state: "running",
      engine,
      updatedAt: new Date().toISOString(),
    });

    const runtime: RuntimeHandle = {
      pid: supervisor.pid,
      supervisorPid: supervisor.pid,
      childPid: supervisor.childPid,
      childStartedAt: supervisor.childStartedAt,
      pgid: supervisor.pgid,
      port,
      baseUrl,
      controlSocket,
      executable: binary.realPath,
      executableSha256: binary.sha256,
      startedAt,
      engine,
      ownershipId: record.id,
      listenerPid,
      compatibility,
    };
    const owned: OwnedRuntime = {
      supervisor,
      runtime,
      token,
      engine,
      listenerPid,
      record,
      store,
      log: () => tail(logPath),
    };
    registry.set(runtime.childPid, owned);
    return owned;
  } catch (error) {
    if (supervisor) {
      await stopSupervisor(supervisor, { graceMs: 2_000 }).catch(() => undefined);
    }
    const failure =
      error instanceof AdapterError
        ? { code: error.code, message: error.message, details: error.details ?? null }
        : { code: "STARTUP_FAILED", message: String(error), details: null };
    store.put({
      ...record,
      state: "failed",
      updatedAt: new Date().toISOString(),
      stopReceipt: { via: "startup_failure", error: failure },
    });
    throw error;
  }
}

function verifyChildIdentity(supervisor: SupervisorHandle, expectedExecutable: string): void {
  const entry = readProcessEntry(supervisor.childPid);
  if (!entry) {
    throw new RuntimeLifecycleError(
      "STARTUP_FAILED",
      "the supervised runtime exited before ownership was verified",
      "inspect the runtime log; the engine may have rejected its arguments",
      { child_pid: supervisor.childPid, stderr: supervisor.stderrText().slice(-2000) },
    );
  }
  if (entry.ppid !== supervisor.pid) {
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      `pid ${supervisor.childPid} is not a child of the supervisor`,
      "stop the runtime and inspect the process tree",
      {
        child_pid: supervisor.childPid,
        expected_parent: supervisor.pid,
        observed_parent: entry.ppid,
      },
    );
  }
  if (entry.startedAt !== supervisor.childStartedAt) {
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      "the reported child start time does not match the live process",
      "stop the runtime and inspect the process tree; a pid may have been reused",
      {
        child_pid: supervisor.childPid,
        expected: supervisor.childStartedAt,
        observed: entry.startedAt,
      },
    );
  }
  const actual = readExecutablePath(supervisor.childPid);
  if (actual && resolve(actual) !== resolve(expectedExecutable)) {
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      `supervised pid runs ${actual}, not ${expectedExecutable}`,
      "stop the runtime and verify the engine binary",
      { child_pid: supervisor.childPid, expected: expectedExecutable, observed: actual },
    );
  }
}

interface ReadyInput {
  baseUrl: string;
  port: number;
  token: string;
  supervisor: SupervisorHandle;
  timeoutMs: number;
  logPath: string;
}

async function awaitRuntimeReady(input: ReadyInput): Promise<WireRuntimeInfo> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (input.supervisor.exitCode() !== null) {
      throw new RuntimeLifecycleError(
        "STARTUP_FAILED",
        `runtime exited during startup (code ${input.supervisor.exitCode()})`,
        "inspect the runtime log for the engine's error",
        {
          stderr: input.supervisor.stderrText().slice(-2000),
          log: tail(input.logPath),
          events: input.supervisor.events.slice(-5),
        },
      );
    }
    try {
      const health = await fetch(`${input.baseUrl}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (health.ok) {
        const response = await fetch(`${input.baseUrl}/v1/runtime/info`, {
          headers: { Authorization: `Bearer ${input.token}` },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status === 401 || response.status === 403) {
          throw new RuntimeLifecycleError(
            "STARTUP_FAILED",
            "the runtime rejected the private bearer token",
            "restart the runtime; another process may already own this user store",
            { status: response.status },
          );
        }
        if (response.status === 200) {
          const parsed = WireRuntimeInfo.safeParse(await response.json());
          if (!parsed.success) {
            throw new RuntimeLifecycleError(
              "OWNERSHIP_MISMATCH",
              "the process on the chosen port does not speak the pinned Runtime API",
              "stop the process using that port; an HTTP response alone is not ownership",
              { issues: parsed.error.issues.slice(0, 4) },
            );
          }
          const info = parsed.data;
          if (Number(info.port) !== input.port) {
            throw new RuntimeLifecycleError(
              "OWNERSHIP_MISMATCH",
              `runtime reported port ${info.port}, expected ${input.port}`,
              "stop the runtime and retry",
              { expected: input.port, observed: info.port },
            );
          }
          if (
            info.bind_host !== "127.0.0.1" &&
            info.bind_host !== "::1" &&
            info.bind_host !== "localhost"
          ) {
            throw new RuntimeLifecycleError(
              "OWNERSHIP_MISMATCH",
              `runtime bound ${info.bind_host}, which is not loopback`,
              "stop the runtime; Mona never accepts a non-loopback runtime",
              { bind_host: info.bind_host },
            );
          }
          return info;
        }
        lastError = new Error(`runtime info returned ${response.status}`);
      }
    } catch (error) {
      if (error instanceof RuntimeLifecycleError) throw error;
      lastError = error;
    }
    await sleep(150);
  }
  throw new RuntimeLifecycleError(
    "STARTUP_TIMEOUT",
    `runtime did not become ready within ${input.timeoutMs}ms`,
    "inspect the runtime log and retry; a slow first start can happen on a cold cache",
    {
      last_error: String(lastError),
      log: tail(input.logPath),
      stderr: input.supervisor.stderrText().slice(-2000),
    },
  );
}

export interface ListenerOwnershipOptions {
  /** Test seam for the Runtime-store owner probe. */
  owner?: () => RuntimeStoreOwner | null;
}

function ownerAmong(
  strangers: number[],
  probe: (() => RuntimeStoreOwner | null) | undefined,
): RuntimeStoreOwner | null {
  let owner: RuntimeStoreOwner | null = null;
  try {
    owner = (probe ?? runtimeStoreOwner)();
  } catch {
    return null;
  }
  return owner && strangers.includes(owner.pid) ? owner : null;
}

export function verifyListenerOwnership(
  port: number,
  childPid: number,
  expectedExecutable: string,
  options: ListenerOwnershipOptions = {},
): number {
  const listeners = listeningPids(port);
  if (listeners.length === 0) {
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      `nothing is listening on 127.0.0.1:${port} after a successful health probe`,
      "stop the runtime and retry; the port may be shared",
      { port },
    );
  }
  const tree = descendantsOf(childPid, readProcessTable());
  tree.add(childPid);
  const strangers = listeners.filter((pid) => !tree.has(pid));
  if (strangers.length > 0) {
    const owner = ownerAmong(strangers, options.owner);
    if (owner) {
      // The port is not "occupied": the store already has an owner, and the
      // engine handed this port to it. Say so, because the fix is to quit that
      // host — not to hunt for a stray listener.
      throw new RuntimeLifecycleError(
        "OWNERSHIP_MISMATCH",
        `another Codewhale runtime host already owns this user's Codewhale store and served 127.0.0.1:${port} instead of the runtime Mona started (${describeRuntimeStoreOwner(owner)})`,
        "quit that host — its Codewhale window, `codewhale web`, `codewhale serve --http`, or a second Mona — then start this runtime again; Mona does not attach to a runtime it did not start",
        { port, listeners, strangers, child_pid: childPid, owner: { ...owner } },
      );
    }
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      `port ${port} is served by pid(s) outside the supervised tree`,
      "stop the runtime; the port is occupied by a process Mona did not start",
      { port, listeners, strangers, child_pid: childPid },
    );
  }
  const listener = listeners[0] as number;
  const actual = readExecutablePath(listener);
  if (actual && resolve(actual) !== resolve(expectedExecutable)) {
    throw new RuntimeLifecycleError(
      "OWNERSHIP_MISMATCH",
      `listener pid ${listener} runs ${actual}, not the owned engine binary`,
      "stop the runtime and verify the engine binary",
      { listener, expected: expectedExecutable, observed: actual },
    );
  }
  return listener;
}

export async function stopOwnedRuntime(
  handle: RuntimeHandle,
  options: { graceMs?: number; force?: boolean } = {},
): Promise<SupervisorStopReceipt> {
  const owned = registry.get(handle.childPid);
  if (owned) {
    const receipt = await stopSupervisor(owned.supervisor, options);
    owned.store.put({
      ...owned.record,
      state: receipt.state === "stopped" ? "stopped" : "failed",
      updatedAt: new Date().toISOString(),
      stopReceipt: { ...receipt } as unknown as Record<string, unknown>,
    });
    if (receipt.state === "stopped") registry.delete(handle.childPid);
    return receipt;
  }
  return stopByVerifiedIdentity(
    {
      childPid: handle.childPid,
      childStartedAt: handle.childStartedAt,
      pgid: handle.pgid,
    },
    { ...options, note: "no in-memory supervisor handle; verified identity fallback" },
  );
}

/** Stop a runtime known only from its durable record (app restart, recovery). */
export async function stopRecordedRuntime(
  record: OwnershipRecord,
  options: { graceMs?: number; force?: boolean } = {},
): Promise<SupervisorStopReceipt> {
  try {
    const status = await controlRequest(record.controlSocket, { op: "status" }, 1_500);
    if (status.ok === true && status.child_pid === record.childPid) {
      const response = await controlRequest(
        record.controlSocket,
        {
          op: options.force ? "force-stop" : "stop",
          graceMs: options.graceMs ?? 5_000,
          force: options.force === true,
        },
        (options.graceMs ?? 5_000) + 3_000,
      );
      return {
        ok: response.ok === true,
        state: String(response.state ?? "unknown"),
        graceful: options.force !== true,
        escalated: response.escalated === true,
        survivors: Array.isArray(response.survivors) ? (response.survivors as number[]) : [],
        exit: response.exit as SupervisorStopReceipt["exit"],
        via: "control_socket",
        verified:
          Array.isArray(response.survivors) && (response.survivors as number[]).length === 0,
      };
    }
  } catch {
    // Supervisor is gone; fall through to the verified-identity path.
  }
  return stopByVerifiedIdentity(
    {
      childPid: record.childPid,
      childStartedAt: record.childStartedAt,
      pgid: record.pgid,
    },
    { ...options, note: "supervisor unreachable; verified identity fallback" },
  );
}

export function ownedRuntimeFor(childPid: number): OwnedRuntime | undefined {
  return registry.get(childPid);
}

export function engineBinaryDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
