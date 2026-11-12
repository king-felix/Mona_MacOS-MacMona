import { app, BrowserWindow, Menu, powerMonitor, session } from "electron";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMainWindow } from "./window";
import { hardenSession } from "./security";
import { installApplicationMenu } from "./menu";
import { registerIpc } from "./ipc";
import { discoverTools } from "./tool-discovery";
import { resolveAppPaths } from "./paths";
import { denyWindowOpen, isAllowedNavigation, shouldQuitOnWindowAllClosed } from "./navigation";
import { DesktopLifecycle } from "./desktop-lifecycle";
import { descendantsOf, readProcessEntry, readProcessTable } from "./supervisor/identity";
import {
  resolveSupervisorBinary,
  startSupervisor,
  stopByVerifiedIdentity,
  stopSupervisor,
} from "./supervisor/native";
import { controlSocketPath, newRecordId, OwnershipStore } from "./supervisor/records";
import {
  RuntimeSupervisor,
  type RuntimeDriver,
  type StartedRuntime,
} from "./supervisor/runtime-supervisor";
import { startOwnedRuntime, stopRecordedRuntime } from "./engine/runtime-process";
import { WorkController } from "./work/control";

app.setName("Mona");

const RENDERER_ROOT = join(__dirname, "../../renderer");
const PRELOAD_PATH = join(__dirname, "../preload/index.js");
const IS_SMOKE = process.argv.includes("--smoke");
const IS_LIFECYCLE_SMOKE = process.argv.includes("--lifecycle-smoke");

let mainWindow: BrowserWindow | null = null;
let lifecycle: DesktopLifecycle | null = null;
let supervisor: RuntimeSupervisor | null = null;
let smokeWorkspace: string | null = null;
let lifecycleEvidence: Record<string, unknown> = { schema_version: 1, ok: false, phases: [] };
let lifecycleSmokeStarted = false;

function hardenAllWebContents(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => denyWindowOpen());
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, RENDERER_ROOT)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAllowedNavigation(url, RENDERER_ROOT)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

function openWindow(): BrowserWindow {
  const window = createMainWindow({ rendererRoot: RENDERER_ROOT, preloadPath: PRELOAD_PATH });
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (IS_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void captureSmoke(window).catch((error: unknown) => {
        writeSmoke({ ok: false, error: String(error) });
        app.exit(1);
      });
    });
  }
  if (IS_LIFECYCLE_SMOKE && !lifecycleSmokeStarted) {
    lifecycleSmokeStarted = true;
    window.webContents.once("did-finish-load", () => {
      void runLifecycleSmoke(window).catch((error: unknown) => {
        const candidate = error as { message?: string; code?: string; details?: unknown };
        lifecycleEvidence = {
          ...lifecycleEvidence,
          ok: false,
          error: String(error),
          error_code: candidate.code ?? null,
          error_details: candidate.details ?? null,
        };
        writeLifecycleEvidence();
        app.exit(1);
      });
    });
  }
  return window;
}

async function captureSmoke(window: BrowserWindow): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 900));
  const renderer = await window.webContents.executeJavaScript(
    `(() => ({
       ready: document.body.dataset.ready === 'true',
       title: document.title,
       hasBridge: typeof window.mona === 'object' && window.mona !== null,
       navItems: Array.from(document.querySelectorAll('[data-nav]')).map((node) => node.textContent),
       versionText: document.querySelector('[data-testid="app-version"]')?.textContent ?? null,
       csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
       nodeGlobals: {
         require: typeof require,
         process: typeof process,
         module: typeof module,
         global: typeof globalThis
       },
       bridgeKeys: window.mona ? Object.keys(window.mona) : [],
       windowOpenResult: (() => {
         try {
           const opened = window.open('https://example.com/', '_blank');
           return opened === null ? 'null' : 'opened';
         } catch {
           return 'threw';
         }
       })()
     }))()`,
  );
  const paths = resolveAppPaths();
  const metrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    workingSetKb: metric.memory?.workingSetSize ?? null,
    cpuPercent: metric.cpu?.percentCPUUsage ?? null,
  }));
  const applicationMenu = Menu.getApplicationMenu();
  const menuRoles = (applicationMenu?.items ?? []).flatMap((item) =>
    (item.submenu?.items ?? []).flatMap((sub) => (sub.role ? [String(sub.role)] : [])),
  );
  writeSmoke({
    ok: true,
    schema_version: 1,
    captured_at: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    },
    renderer,
    security: {
      configured: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: process.env.MONA_DEVTOOLS === "1",
        windowOpen: "deny",
        navigation: "local-renderer-only",
        permissions: "deny-all",
      },
      observed: {
        require: renderer.nodeGlobals?.require ?? "unknown",
        process: renderer.nodeGlobals?.process ?? "unknown",
        module: renderer.nodeGlobals?.module ?? "unknown",
        bridgeKeys: renderer.bridgeKeys ?? [],
        windowOpenResult: renderer.windowOpenResult ?? "unknown",
      },
    },
    paths,
    metrics,
    tools: discoverTools(["codewhale", "git", "node"]),
    menu_roles: menuRoles,
    visible: window.isVisible(),
    total_working_set_kb: metrics.reduce((sum, metric) => sum + (metric.workingSetKb ?? 0), 0),
  });
  setTimeout(() => app.quit(), 250);
}

function writeSmoke(value: unknown): void {
  const out = process.env.MONA_SMOKE_OUT;
  if (!out) return;
  writeFileSync(out, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------- lifecycle smoke

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLifecycleEvidence(): void {
  const out = process.env.MONA_LIFECYCLE_SMOKE_OUT;
  if (!out) return;
  writeFileSync(out, JSON.stringify(lifecycleEvidence, null, 2) + "\n", "utf8");
}

function smokeDriver(stateDir: string): RuntimeDriver {
  const store = new OwnershipStore(join(stateDir, "runtime-ownership.json"));
  return {
    async start(workspace: string): Promise<StartedRuntime> {
      const id = newRecordId();
      const token = randomBytes(24).toString("hex");
      const controlSocket = controlSocketPath(stateDir, id);
      const handle = await startSupervisor({
        binary: resolveSupervisorBinary(),
        workspace,
        executable: "/bin/sh",
        args: ["-c", "sleep 300 & sleep 300"],
        controlSocket,
        token,
        logPath: join(stateDir, "smoke.log"),
        graceMs: 2_000,
      });
      const record = store.put({
        id,
        workspace,
        canonicalWorkspace: workspace,
        executable: "/bin/sh",
        executableSha256: "smoke",
        supervisorPid: handle.pid,
        supervisorStartedAt: readProcessEntry(handle.pid)?.startedAt ?? "",
        childPid: handle.childPid,
        childStartedAt: handle.childStartedAt,
        pgid: handle.pgid,
        port: 0,
        baseUrl: "",
        controlSocket,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "running",
        engine: { version: "smoke", commit: "smoke" },
        startupReceipt: { ...handle.startedReceipt },
        stopReceipt: null,
      });
      return {
        handle,
        token,
        engine: { version: "smoke", commit: "smoke" },
        listenerPid: -1,
        port: 0,
        baseUrl: "",
        record,
      };
    },
    stop: (handle, options) => stopSupervisor(handle, options),
    healthy: async () => true,
    stopRecorded: (record) =>
      stopByVerifiedIdentity({
        childPid: record.childPid,
        childStartedAt: record.childStartedAt,
        pgid: record.pgid,
      }),
    markRecord: (record, patch) =>
      store.put({ ...record, ...patch, updatedAt: new Date().toISOString() }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

async function runLifecycleSmoke(initialWindow: BrowserWindow): Promise<void> {
  const runtime = supervisor;
  const workspace = smokeWorkspace;
  if (!runtime || !workspace) throw new Error("lifecycle smoke runtime was not constructed");
  const phases: Array<Record<string, unknown>> = [];
  lifecycleEvidence = {
    schema_version: 1,
    ok: false,
    phases,
    pids: {},
    workspace,
  };

  const note = (phase: string, value: Record<string, unknown>) => phases.push({ phase, ...value });

  lifecycleEvidence.lifecycle_before_start = lifecycle?.status() ?? null;
  await runtime.ensure(workspace);
  const handle = runtime.handle();
  if (!handle) throw new Error("smoke runtime did not start");
  const tree = [...descendantsOf(handle.childPid, readProcessTable())];
  const pids = {
    supervisor: handle.pid,
    child: handle.childPid,
    pgid: handle.pgid,
    tree: [handle.childPid, ...tree],
  };
  lifecycleEvidence.pids = pids;
  note("started", {
    state: runtime.status().state,
    alive: pids.tree.filter(isAlive),
    runtime_status: runtime.status(),
  });

  // Synthetic power events exercise the real wiring; a lid close cannot be
  // scripted safely on the build machine.
  powerMonitor.emit("suspend");
  await new Promise((resolve) => setTimeout(resolve, 400));
  note("sleep", {
    runtime_state: runtime.status().state,
    child_alive: isAlive(handle.childPid),
  });
  powerMonitor.emit("resume");
  const woke = await waitFor(() => runtime.status().state === "running", 5_000);
  note("wake", {
    resumed: woke,
    runtime_state: runtime.status().state,
    same_work: runtime.handle()?.childPid === handle.childPid,
    child_alive: isAlive(handle.childPid),
  });

  initialWindow.webContents.forcefullyCrashRenderer();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  note("renderer_crash", {
    main_alive: true,
    renderer_crashes: lifecycle?.status().rendererCrashes ?? 0,
    runtime_state: runtime.status().state,
    child_alive: isAlive(handle.childPid),
    tree_alive: pids.tree.filter(isAlive),
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      mainWindow?.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  mainWindow?.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  note("window_closed", {
    windows: BrowserWindow.getAllWindows().length,
    runtime_state: runtime.status().state,
    child_alive: isAlive(handle.childPid),
    tree_alive: pids.tree.filter(isAlive),
  });

  openWindow();
  await new Promise((resolve) => setTimeout(resolve, 700));
  note("dock_reopen", {
    windows: BrowserWindow.getAllWindows().length,
    same_work: runtime.handle()?.childPid === handle.childPid,
    child_alive: isAlive(handle.childPid),
  });

  const expectedOpen = process.env.MONA_LIFECYCLE_SMOKE_OPEN_PATH;
  if (expectedOpen) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (lifecycle?.status().lastOpenRequest?.path === expectedOpen) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    note("second_instance", {
      expected: expectedOpen,
      received: lifecycle?.status().lastOpenRequest ?? null,
      windows: BrowserWindow.getAllWindows().length,
    });
  }

  lifecycleEvidence = {
    ...lifecycleEvidence,
    ok: true,
    phases,
    runtime_before_quit: runtime.status(),
    lifecycle_before_quit: lifecycle?.status() ?? null,
  };
  writeLifecycleEvidence();
  process.env.MONA_LIFECYCLE_SMOKE_QUITTING = "1";
  app.quit();
}

// ---------------------------------------------------------------- ownership wiring

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch must not become a second owner. It exits immediately; the
  // running instance receives the folder through `second-instance`.
  app.exit(0);
} else {
  const paths = resolveAppPaths();
  const store = new OwnershipStore(join(paths.state, "runtime-ownership.json"));
  const productionDriver: RuntimeDriver = {
    start: async (workspace) => {
      const owned = await startOwnedRuntime({
        workspace,
        stateDir: paths.state,
        logDir: paths.logs,
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
    stop: (handle, options) => stopSupervisor(handle, options),
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
    markRecord: (record, patch) => store.put({ ...record, ...patch }),
  };

  let runtimeSupervisor: RuntimeSupervisor;
  if (IS_LIFECYCLE_SMOKE) {
    const smokeStateDir = mkdtempSync(join(tmpdir(), "mona-lifecycle-smoke-"));
    smokeWorkspace = realpathSync(mkdtempSync(join(tmpdir(), "mona-lifecycle-work-")));
    runtimeSupervisor = new RuntimeSupervisor({
      driver: smokeDriver(smokeStateDir),
      store: new OwnershipStore(join(smokeStateDir, "runtime-ownership.json")),
    });
  } else {
    runtimeSupervisor = new RuntimeSupervisor({ driver: productionDriver, store });
  }
  supervisor = runtimeSupervisor;
  const work = new WorkController({
    interrupt: async () => {
      throw new Error("no engine adapter is attached before the project shell exists");
    },
    stopOwnedRuntime: (options) =>
      supervisor?.isOwned()
        ? supervisor.stopOwned("quit_and_stop_work", options)
        : Promise.resolve({
            ok: true,
            state: "stopped",
            graceful: true,
            escalated: false,
            survivors: [] as number[],
            via: "control_socket" as const,
            note: "no owned runtime",
          }),
  });

  lifecycle = new DesktopLifecycle({
    supervisor: runtimeSupervisor,
    work,
    currentWindow: () => mainWindow,
    openWindow,
    onStatus: (status) => {
      if (status.shutdownComplete) {
        lifecycleEvidence = { ...lifecycleEvidence, shutdown: status };
        writeLifecycleEvidence();
      }
    },
  });
  lifecycle.install();
  hardenAllWebContents();

  void app.whenReady().then(async () => {
    hardenSession(session.defaultSession);
    installApplicationMenu();
    registerIpc(RENDERER_ROOT);
    if (IS_LIFECYCLE_SMOKE) {
      // The smoke builds its own temporary supervisor; recover nothing from the
      // real user store so the evidence run cannot disturb product state.
      openWindow();
      const readyOut = process.env.MONA_LIFECYCLE_SMOKE_READY;
      if (readyOut) writeFileSync(readyOut, new Date().toISOString() + "\n", "utf8");
      return;
    }
    // Reconcile runtime ownership left by a previous run before any new work.
    await supervisor?.recover().catch(() => undefined);
    openWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (shouldQuitOnWindowAllClosed(process.platform)) app.quit();
  });
}
