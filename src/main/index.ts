import { app, BrowserWindow, Menu, powerMonitor, session } from "electron";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
  lastStopReceipt,
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
import { StateStore } from "./state/store";
import { verifyPrivatePermissions } from "./state/paths";

app.setName("Mona");

const RENDERER_ROOT = join(__dirname, "../../renderer");
const PRELOAD_PATH = join(__dirname, "../preload/index.js");
const IS_SMOKE = process.argv.includes("--smoke");
const IS_LIFECYCLE_SMOKE = process.argv.includes("--lifecycle-smoke");
const IS_DESIGN_SHOTS = process.argv.includes("--design-shots");

let mainWindow: BrowserWindow | null = null;
let lifecycle: DesktopLifecycle | null = null;
let supervisor: RuntimeSupervisor | null = null;
let smokeWorkspace: string | null = null;
let lifecycleEvidence: Record<string, unknown> = { schema_version: 1, ok: false, phases: [] };
let lifecycleSmokeStarted = false;
let productState: StateStore | null = null;
let productStateError: string | null = null;

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
  if (IS_DESIGN_SHOTS) {
    window.webContents.once("did-finish-load", () => {
      void captureDesignShots(window)
        .catch((error: unknown) => {
          process.stderr.write(`design shots failed: ${String(error)}\n`);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
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
    state: productState
      ? {
          open: true,
          database: productState.path,
          permission_problems: verifyPrivatePermissions({
            home: app.getPath("home"),
            support: paths.support,
            cache: paths.cache,
            logs: paths.logs,
            state: paths.state,
            database: paths.database,
            backups: paths.backups,
            artifacts: paths.artifacts,
          }),
          stats: await productState.stats(),
        }
      : { open: false, error: productStateError },
    metrics,
    tools: discoverTools(["codewhale", "git", "node"]),
    menu_roles: menuRoles,
    visible: window.isVisible(),
    total_working_set_kb: metrics.reduce((sum, metric) => sum + (metric.workingSetKb ?? 0), 0),
  });
  setTimeout(() => app.quit(), 250);
}

interface ShotDefinition {
  name: string;
  state: {
    screen: string;
    theme: string;
    density: string;
    scenario: string;
    reducedMotion: boolean;
  };
  zoom?: number;
  chrome?: "full" | "minimal";
}

const DESIGN_SHOTS: ShotDefinition[] = [
  {
    name: "home-daybreak",
    state: {
      screen: "home",
      theme: "daybreak",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "home-afterglow-dense",
    state: {
      screen: "home",
      theme: "afterglow",
      density: "dense",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "home-empty",
    state: {
      screen: "home",
      theme: "daybreak",
      density: "comfortable",
      scenario: "empty",
      reducedMotion: false,
    },
  },
  {
    name: "studio-daybreak",
    state: {
      screen: "studio",
      theme: "daybreak",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "studio-afterglow",
    state: {
      screen: "studio",
      theme: "afterglow",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "studio-disconnected",
    state: {
      screen: "studio",
      theme: "daybreak",
      density: "comfortable",
      scenario: "disconnected",
      reducedMotion: false,
    },
  },
  {
    name: "studio-zoom-200",
    state: {
      screen: "studio",
      theme: "afterglow",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
    zoom: 2,
    chrome: "minimal",
  },
  {
    name: "board-daybreak-dense",
    state: {
      screen: "board",
      theme: "daybreak",
      density: "dense",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "board-blocked",
    state: {
      screen: "board",
      theme: "afterglow",
      density: "comfortable",
      scenario: "blocked",
      reducedMotion: false,
    },
  },
  {
    name: "cost-daybreak",
    state: {
      screen: "cost",
      theme: "daybreak",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "cost-unknown-afterglow",
    state: {
      screen: "cost",
      theme: "afterglow",
      density: "dense",
      scenario: "unknown-cost",
      reducedMotion: false,
    },
  },
  {
    name: "blocker-daybreak",
    state: {
      screen: "blocker",
      theme: "daybreak",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "blocker-afterglow-dense",
    state: {
      screen: "blocker",
      theme: "afterglow",
      density: "dense",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "settings-daybreak",
    state: {
      screen: "settings",
      theme: "daybreak",
      density: "comfortable",
      scenario: "default",
      reducedMotion: false,
    },
  },
  {
    name: "settings-afterglow",
    state: {
      screen: "settings",
      theme: "afterglow",
      density: "comfortable",
      scenario: "disconnected",
      reducedMotion: false,
    },
  },
];

async function settle(window: BrowserWindow, ms = 260): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await window.webContents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function captureDesignShots(window: BrowserWindow): Promise<void> {
  const outDir =
    process.env.MONA_DESIGN_SHOTS_DIR ??
    join(process.cwd(), "docs", "evidence", "macos", "artifacts");
  mkdirSync(outDir, { recursive: true });
  window.setSize(1280, 800);
  await window.webContents.executeJavaScript(
    "new Promise((resolve) => { const check = () => (document.body.dataset.ready === 'true' && window.__monaHarness) ? resolve(true) : setTimeout(check, 50); check(); })",
  );

  const manifest: Record<string, unknown> = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    window: { width: 1280, height: 800 },
    label: "TEST FIXTURE — NOT LIVE STATE",
    shots: [],
  };
  const shots: Array<Record<string, unknown>> = [];
  for (const shot of DESIGN_SHOTS) {
    window.webContents.setZoomFactor(shot.zoom ?? 1);
    await window.webContents.executeJavaScript(
      `document.documentElement.dataset.chrome = ${JSON.stringify(shot.chrome ?? "full")};

       window.__monaHarness.set(${JSON.stringify(shot.state)}); true`,
    );
    await settle(window);
    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    const relative = `docs/evidence/macos/artifacts/p06-${shot.name}.png`;
    writeFileSync(join(outDir, `p06-${shot.name}.png`), png);
    const facts = await window.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const label = ${JSON.stringify("TEST FIXTURE")};
      return {
        screen: root.dataset.screen,
        theme: root.dataset.theme,
        density: root.dataset.density,
        body_ready: document.body.dataset.ready === 'true',
        nav_count: document.querySelectorAll('[data-nav]').length,
        fixture_label_visible: document.body.textContent.includes(label),
        horizontal_overflow: root.scrollWidth > root.clientWidth + 1,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        body_zoom: document.body.style.zoom || '1',
      };
    })()`);
    shots.push({
      name: shot.name,
      state: shot.state,
      file: relative,
      bytes: png.length,
      width: image.getSize().width,
      height: image.getSize().height,
      facts,
    });
  }
  window.webContents.setZoomFactor(1);
  await window.webContents.executeJavaScript(
    'document.documentElement.dataset.chrome = "full"; true',
  );
  manifest.shots = shots;

  // Keyboard inspection: real Tab and Command-key input through Chromium.
  await window.webContents.executeJavaScript(
    `window.__monaHarness.set({ screen: 'home', theme: 'daybreak', density: 'comfortable', scenario: 'default', reducedMotion: false });
     document.querySelector('[data-nav]')?.blur();
     document.body.focus();
     true`,
  );
  await settle(window, 120);
  const describe = `(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: 'body', label: null, outline: null };
    const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 60) || el.getAttribute('placeholder');
    const style = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase(), label, outline: style.outlineStyle + ' ' + style.outlineWidth, focus_visible: el.matches(':focus-visible') };
  })()`;

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await settle(window, 80);
  const firstTab = await window.webContents.executeJavaScript(describe);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await settle(window, 80);
  const secondTab = await window.webContents.executeJavaScript(describe);

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta"] });
  await settle(window, 120);
  const commandScreen = await window.webContents.executeJavaScript(
    "document.documentElement.dataset.screen",
  );

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "k", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "k", modifiers: ["meta"] });
  await settle(window, 120);
  const palette = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return { open: Boolean(dialog), focused_inside: Boolean(dialog && dialog.contains(document.activeElement)), title: dialog?.querySelector('h2')?.textContent ?? null };
  })()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await settle(window, 120);
  const paletteClosed = await window.webContents.executeJavaScript(
    "document.querySelector('[role=\"dialog\"]') === null",
  );

  const keyboard = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    first_tab: firstTab,
    second_tab: secondTab,
    command_2_screen: commandScreen,
    palette_open: palette,
    palette_escape_closed: paletteClosed,
  };
  writeFileSync(join(outDir, "p06-keyboard.json"), JSON.stringify(keyboard, null, 2) + "\n");
  writeFileSync(join(outDir, "p06-shots.json"), JSON.stringify(manifest, null, 2) + "\n");
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
    lastStopReceipt,
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
    lastStopReceipt,
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
            verified: true,
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
    try {
      const appPaths = resolveAppPaths();
      const smokeState = IS_SMOKE || IS_LIFECYCLE_SMOKE;
      const stateRoot = smokeState
        ? mkdtempSync(join(tmpdir(), "mona-product-state-"))
        : appPaths.state;
      productState = await StateStore.open({
        dbPath: smokeState ? join(stateRoot, "mona.sqlite") : appPaths.database,
        backupDir: smokeState ? join(stateRoot, "backups") : appPaths.backups,
        artifactRoot: smokeState ? join(stateRoot, "artifacts") : appPaths.artifacts,
      });
    } catch (error) {
      productStateError = error instanceof Error ? error.message : String(error);
      // Browsing and diagnostics stay usable; project writes will report the
      // typed failure once the shell is connected (P07).
      process.stderr.write(`Mona state unavailable: ${productStateError}\n`);
    }
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

  app.on("before-quit", () => {
    void productState?.close();
  });

  app.on("window-all-closed", () => {
    if (shouldQuitOnWindowAllClosed(process.platform)) app.quit();
  });
}
