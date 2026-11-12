import { app, BrowserWindow, Menu, dialog, powerMonitor, session, shell } from "electron";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import { createProductionDriver } from "./supervisor/driver";
import { WorkController } from "./work/control";
import { WorkStudio } from "./work/studio";
import { TaskBoard } from "./work/board";
import { CostLedger } from "./work/costs";
import { StateError } from "./state/errors";
import { StateStore } from "./state/store";
import { verifyPrivatePermissions } from "./state/paths";
import { ProjectService, runtimeStatusView } from "./projects/service";
import { OpenCoordinator } from "./open/coordinator";
import { parseLaunchArguments } from "./open/folder-request";
import { inspectServiceStatus, refreshServiceRegistration } from "./open/service-status";
import type { RuntimeStatus } from "./supervisor/runtime-supervisor";
import type { ProjectId as StudioProjectId } from "../shared/contracts/ids";
import type {
  FolderRequestSource,
  OpenResult,
  OpenStatusView,
  ServiceStatus,
} from "../shared/contracts/open";

app.setName("Mona");

const RENDERER_ROOT = join(__dirname, "../../renderer");
const PRELOAD_PATH = join(__dirname, "../preload/index.js");
const IS_SMOKE = process.argv.includes("--smoke");
const IS_LIFECYCLE_SMOKE = process.argv.includes("--lifecycle-smoke");
const IS_DESIGN_SHOTS = process.argv.includes("--design-shots");
const IS_SHELL_SMOKE = process.argv.includes("--shell-smoke");
const IS_STUDIO_SMOKE = process.argv.includes("--studio-smoke");
const IS_OPEN_SMOKE = process.argv.includes("--open-smoke");

let mainWindow: BrowserWindow | null = null;
let lifecycle: DesktopLifecycle | null = null;
let supervisor: RuntimeSupervisor | null = null;
let smokeWorkspace: string | null = null;
let lifecycleEvidence: Record<string, unknown> = { schema_version: 1, ok: false, phases: [] };
let lifecycleSmokeStarted = false;
let productState: StateStore | null = null;
let productStateError: string | null = null;
let projectService: ProjectService | null = null;
let workController: WorkController | null = null;
let workStudio: WorkStudio | null = null;
let taskBoard: TaskBoard | null = null;
let costLedger: CostLedger | null = null;
let studioSmokeProjectId: string | null = null;
let studioSmokeRoot: string | null = null;
let openCoordinator: OpenCoordinator | null = null;
let resolveCoordinatorReady: (() => void) | null = null;
const coordinatorReady = new Promise<void>((resolve) => {
  resolveCoordinatorReady = resolve;
});
/** Every external open attempt observed by this process, in order. */
const openRequests: OpenResult[] = [];

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

/**
 * The one entry point for folders supplied from outside the renderer: a Finder
 * Service handoff (open-file), a second launch, cold-start argv, a drop, or the
 * native open dialog. Validation, journaling, and the "cannot start work"
 * guarantee all live behind this call.
 */
async function dispatchOpen(
  input: string,
  source: FolderRequestSource,
): Promise<OpenResult | null> {
  await coordinatorReady;
  if (!openCoordinator) return null;
  return openCoordinator.open(input, source);
}

const SERVICES_SETTINGS_URL = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

function serviceStatusFacts(): ServiceStatus {
  return inspectServiceStatus({
    home: app.getPath("home"),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    servicePathOverride: process.env.MONA_SERVICE_PATH ?? null,
  });
}

function openStatusFacts(): OpenStatusView {
  return { last: openCoordinator?.lastResult() ?? null, service: serviceStatusFacts() };
}

function openWindow(): BrowserWindow {
  const window = createMainWindow({
    rendererRoot: RENDERER_ROOT,
    preloadPath: PRELOAD_PATH,
    harness: IS_DESIGN_SHOTS,
  });
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
  if (IS_SHELL_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void runShellSmoke(window)
        .catch((error: unknown) => {
          process.stderr.write(`shell smoke failed: ${String(error)}\n`);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
    });
  }
  if (IS_STUDIO_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void runStudioSmoke(window)
        .catch((error: unknown) => {
          process.stderr.write(`studio smoke failed: ${String(error)}\n`);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
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
  if (IS_OPEN_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void runOpenSmoke(window)
        .catch((error: unknown) => {
          process.stderr.write(`open smoke failed: ${String(error)}\n`);
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

async function runShellSmoke(window: BrowserWindow): Promise<void> {
  const outDir =
    process.env.MONA_SHELL_SMOKE_OUT_DIR ??
    join(process.cwd(), "docs", "evidence", "macos", "artifacts");
  mkdirSync(outDir, { recursive: true });
  window.setSize(1280, 800);
  const waitFor = async (expression: string, timeoutMs = 8_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await window.webContents.executeJavaScript(expression);
      if (value) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  };

  const ready = await waitFor("document.body.dataset.ready === 'true'");
  const cards = await waitFor("document.querySelectorAll('[data-project-id]').length > 0");
  const home = await window.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('[data-project-id]').length,
    screen: document.documentElement.dataset.screen,
    fixture_label: document.body.textContent.includes('TEST FIXTURE'),
    nav_count: document.querySelectorAll('[data-nav]').length,
    version: document.querySelector('[data-testid="app-version"]')?.textContent ?? null,
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  const homeShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p07-shell-home.png"), homeShot.toPNG());

  // Keyboard path to Studio first: every major screen must be reachable without a mouse.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta"] });
  const keyboardStudio = await waitFor("document.documentElement.dataset.screen === 'studio'");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "1", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "1", modifiers: ["meta"] });
  const homeReturned = await waitFor("document.documentElement.dataset.screen === 'home'");

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-project-id]')?.click(); true",
  );
  const studioReady = await waitFor("document.documentElement.dataset.screen === 'studio'");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const studio = await window.webContents.executeJavaScript(`(() => ({
    screen: document.documentElement.dataset.screen,
    title: document.querySelector('.context-bar__title')?.textContent ?? null,
    engine: document.querySelector('.context-bar')?.textContent?.includes('Disconnected') ?? false,
    engine_not_started: document.querySelector('[data-testid="studio-connection"]')?.textContent?.includes('Not started') ?? false,
    draft_present: Boolean(document.querySelector('textarea')),
    draft_text: document.querySelector('textarea')?.value ?? null,
    send_enabled: Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('Send to engine') && !button.disabled),
    mode_controls: document.querySelectorAll('.segmented__option').length === 2,
    profile_reported: document.querySelector('[data-testid="studio-profile"]')?.textContent?.includes('deepseek / deepseek-flash') ?? false,
    event_present: document.body.textContent.includes('status.disconnected'),
    fake_percent: /\b\d+%\b/.test(document.body.textContent ?? ''),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  const composerFits = await window.webContents.executeJavaScript(`(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const send = document.querySelector('[data-testid="studio-send"]');
    const strip = document.querySelector('.control-strip');
    if (!send || !strip) return { ok: false, reason: 'missing send button or strip' };
    const sendRect = send.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    const covered = Array.from(document.elementsFromPoint(
      sendRect.left + sendRect.width / 2,
      sendRect.top + sendRect.height / 2,
    )).some((node) => strip.contains(node));
    return {
      ok: !covered && sendRect.bottom <= stripRect.top + 1 && sendRect.width > 0,
      send_bottom: Math.round(sendRect.bottom),
      strip_top: Math.round(stripRect.top),
      covered,
    };
  })()`);
  const studioShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p07-shell-studio.png"), studioShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "3", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "3", modifiers: ["meta"] });
  const boardReady = await waitFor("document.documentElement.dataset.screen === 'board'");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await window.webContents.executeJavaScript(`(() => {
    const main = document.getElementById('screen-main');
    if (main) main.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const board = await window.webContents.executeJavaScript(`(() => ({
    screen: document.documentElement.dataset.screen,
    task_present: document.body.textContent.includes('Make the catalog real'),
    lanes: document.querySelectorAll('.board__lane').length,
    victor_handoff: document.body.textContent.includes('Victor handoff'),
    blocked_attempts: document.body.textContent.includes('3 attempts · 3 consecutive without progress'),
    help_card: document.body.textContent.includes('new evidence or a decision is required'),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  await window.webContents.executeJavaScript(`(() => {
    const main = document.getElementById('screen-main');
    if (main) main.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const boardShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p07-shell-board.png"), boardShot.toPNG());
  writeFileSync(join(outDir, "p11-shell-board.png"), boardShot.toPNG());

  // P11: open the blocked task and prove the attempt ledger renders from state.
  await window.webContents.executeJavaScript(
    "document.querySelector('.task-card--blocked')?.click(); true",
  );
  const attemptDetail = await waitFor(
    "document.querySelector('.problem-list__item--blocked') !== null",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  await window.webContents.executeJavaScript(`(() => {
    const panels = Array.from(document.querySelectorAll('.problem-list__item--blocked'));
    const detailPanel = panels[panels.length - 1];
    detailPanel?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const attempts = await window.webContents.executeJavaScript(`(() => {
    const panels = Array.from(document.querySelectorAll('.problem-list__item--blocked'));
    const problem = panels[panels.length - 1] ?? null;
    return {
      blocked_problem_visible: Boolean(problem),
      total_consecutive:
        document.body.textContent?.includes('3 total · 3 without progress') === true &&
        document.body.textContent?.includes('3 attempts · 3 consecutive without progress') === true,
      attempt_records: document.querySelectorAll('.attempt-list li').length,
      audit_actions: Array.from(document.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Acknowledge (keeps count)'),
      ),
      reopen_control: Array.from(document.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Reopen with evidence'),
      ),
      resolve_control: Array.from(document.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Resolve with decision'),
      ),
      blocked_help: problem?.textContent?.includes('new evidence or a decision is required') ?? false,
      start_disabled: Array.from(document.querySelectorAll('button')).every(
        (button) => !button.textContent?.includes('Resume at recorded step') || button.disabled,
      ),
    };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const attemptShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p11-shell-attempts.png"), attemptShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "4", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "4", modifiers: ["meta"] });
  const costReady = await waitFor("document.documentElement.dataset.screen === 'cost'");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const cost = await window.webContents.executeJavaScript(`(() => ({
    screen: document.documentElement.dataset.screen,
    empty_usage: document.body.textContent.includes('No usage recorded for this project'),
    known_spend: document.body.textContent.includes('Known spend'),
    incomplete: document.body.textContent.includes('Spend is incomplete'),
    unknown_state: document.body.textContent.includes('Unknown price'),
    budget_row: document.body.textContent.includes('Within budget'),
    no_balance_claim: document.body.textContent.includes('never derives a remaining balance'),
    export_controls:
      Array.from(document.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Export CSV')) &&
      Array.from(document.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Export JSON')),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const costShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p12-shell-cost.png"), costShot.toPNG());
  // The lower half of the lens: rollups, price evidence, turns, and export.
  await window.webContents.executeJavaScript(`(() => {
    const region = document.querySelector('.screen--cost');
    if (region) window.scrollTo(0, region.scrollHeight);
    const detail = Array.from(document.querySelectorAll('.card')).find((card) =>
      card.textContent?.includes('Price evidence'));
    detail?.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const costDetailShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p12-shell-cost-detail.png"), costDetailShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "5", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "5", modifiers: ["meta"] });
  const settingsReady = await waitFor("document.documentElement.dataset.screen === 'settings'");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settings = await window.webContents.executeJavaScript(`(() => ({
    screen: document.documentElement.dataset.screen,
    database_visible: document.body.textContent.includes('mona.sqlite'),
    runtime_visible: document.body.textContent.includes('Runtime status'),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  const settingsShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p07-shell-settings.png"), settingsShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "k", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "k", modifiers: ["meta"] });
  const paletteReady = await waitFor("document.querySelector('[role=\"dialog\"]') !== null");
  const palette = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      open: Boolean(dialog),
      focus_inside: Boolean(dialog && dialog.contains(document.activeElement)),
      has_project_action: dialog?.textContent?.includes('Shell smoke project') ?? false
    };
  })()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  const paletteClosed = await waitFor("document.querySelector('[role=\"dialog\"]') === null");

  const checks: Record<string, boolean> = {
    ready,
    cards,
    home_screen: home.screen === "home",
    nav_count: home.nav_count === 5,
    fixture_label_absent: home.fixture_label === false,
    version_rendered: typeof home.version === "string" && home.version.startsWith("Mona "),
    keyboard_studio: keyboardStudio,
    home_returned: homeReturned,
    studio_ready: studioReady,
    studio_title: studio.title === "Shell smoke project",
    engine_state_reported: studio.engine === true || studio.engine_not_started === true,
    draft_present: studio.draft_present === true,
    draft_preserved: studio.draft_text?.includes("shell smoke project") === true,
    send_enabled: studio.send_enabled === true,
    mode_controls: studio.mode_controls === true,
    profile_reported: studio.profile_reported === true,
    offline_event: studio.event_present === true,
    no_fake_percent: studio.fake_percent === false,
    composer_above_strip: composerFits.ok === true,
    board_ready: boardReady && board.screen === "board",
    task_visible: board.task_present === true,
    board_lanes: board.lanes === 6,
    attempt_detail_open: attemptDetail === true,
    blocked_problem_panel: attempts.blocked_problem_visible === true,
    attempt_counters_rendered: attempts.total_consecutive === true,
    attempt_records_rendered: attempts.attempt_records === 3,
    acknowledge_keeps_count_label: attempts.audit_actions === true,
    reopen_control_present: attempts.reopen_control === true,
    resolve_control_present: attempts.resolve_control === true,
    blocked_help_in_detail: attempts.blocked_help === true,
    start_refused_while_blocked: attempts.start_disabled === true,
    victor_handoff_rendered: board.victor_handoff === true,
    blocked_attempt_counters: board.blocked_attempts === true,
    blocked_help_card: board.help_card === true,
    cost_screen: costReady && cost.screen === "cost",
    cost_known_spend: cost.known_spend === true,
    cost_incomplete_disclosed: cost.incomplete === true,
    cost_unknown_state_label: cost.unknown_state === true,
    cost_budget_rendered: cost.budget_row === true,
    cost_no_balance_claim: cost.no_balance_claim === true,
    cost_export_controls: cost.export_controls === true,
    settings_ready: settingsReady && settings.screen === "settings",
    database_visible: settings.database_visible === true,
    runtime_panel: settings.runtime_visible === true,
    palette_open: paletteReady && palette.open === true,
    palette_focus: palette.focus_inside === true,
    palette_project_action: palette.has_project_action === true,
    palette_escape: paletteClosed,
    no_horizontal_overflow:
      home.horizontal_overflow === false &&
      studio.horizontal_overflow === false &&
      board.horizontal_overflow === false &&
      cost.horizontal_overflow === false &&
      settings.horizontal_overflow === false,
  };
  const ok = Object.values(checks).every(Boolean);
  const report = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    ok,
    checks,
    facts: { home, studio, board, attempts, cost, settings, palette, composerFits },
    screenshots: [
      "docs/evidence/macos/artifacts/p07-shell-home.png",
      "docs/evidence/macos/artifacts/p07-shell-studio.png",
      "docs/evidence/macos/artifacts/p07-shell-board.png",
      "docs/evidence/macos/artifacts/p11-shell-board.png",
      "docs/evidence/macos/artifacts/p11-shell-attempts.png",
      "docs/evidence/macos/artifacts/p07-shell-settings.png",
      "docs/evidence/macos/artifacts/p12-shell-cost.png",
      "docs/evidence/macos/artifacts/p12-shell-cost-detail.png",
    ],
  };
  const out = process.env.MONA_SHELL_SMOKE_OUT;
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (!ok) process.exitCode = 1;
}

// ------------------------------------------------------------- studio smoke

const STUDIO_PROOF_TEST = `const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

test("hello.txt contains mona-p08", () => {
  const text = readFileSync(join(__dirname, "..", "hello.txt"), "utf8");
  assert.strictEqual(text.trim(), "mona-p08");
});
`;

const STUDIO_TASK = [
  "Work in the current workspace with the tools available.",
  "1. Create a file named hello.txt whose exact contents are the single line: mona-p08",
  "2. Run `node --test` in the workspace root.",
  "3. Reply with the test result and the exact file contents.",
  "Do not modify any other file.",
].join("\n");

const STUDIO_HOLD_TASK =
  "Run the shell command `sleep 20` in the workspace and wait for it to finish. " +
  "Then reply only with: done";

async function runStudioSmoke(window: BrowserWindow): Promise<void> {
  const outDir =
    process.env.MONA_STUDIO_SMOKE_DIR ??
    join(process.cwd(), "docs", "evidence", "macos", "artifacts");
  mkdirSync(outDir, { recursive: true });
  const studio = workStudio;
  const state = productState;
  const projects = projectService;
  const projectId = studioSmokeProjectId;
  const report: Record<string, unknown> = {
    schema_version: 1,
    label: "LIVE PINNED-ENGINE RUN — P08",
    captured_at: new Date().toISOString(),
    ok: false,
    checks: {},
    phases: [],
    screenshots: [],
  };
  const phase = (name: string, value: Record<string, unknown>) => {
    (report.phases as Array<Record<string, unknown>>).push({ phase: name, ...value });
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForDom = async (expression: string, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await window.webContents.executeJavaScript(expression)) return true;
      await sleep(100);
    }
    return false;
  };
  const domFacts = () =>
    window.webContents.executeJavaScript(`(() => {
      const strip = document.querySelector('.control-strip')?.textContent ?? '';
      const context = document.querySelector('.context-bar')?.textContent ?? '';
      return {
        screen: document.documentElement.dataset.screen,
        title: document.querySelector('.context-bar__title')?.textContent ?? null,
        timeline_entries: document.querySelectorAll('.timeline-event').length,
        connection: document.querySelector('[data-testid="studio-connection"]')?.textContent ?? null,
        profile: document.querySelector('[data-testid="studio-profile"]')?.textContent ?? null,
        cost: document.querySelector('[data-testid="studio-cost"]')?.textContent ?? null,
        strip_percent: /\\b\\d+%\\b/.test(strip + context),
        timeline_anchors: document.querySelectorAll('.timeline a[href], .studio a[href]').length,
        injected_nodes: document.querySelectorAll('.timeline script, .timeline img').length,
        ordered_list_marks: (() => {
          const list = document.querySelector('.markdown ol');
          return list ? getComputedStyle(list).listStyleType : null;
        })(),
      };
    })()`);

  try {
    if (!studio || !state || !projects || !projectId) {
      throw new Error("studio smoke was not wired with state, service, and project");
    }
    await waitForDom("document.body.dataset.ready === 'true'");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta"] });
    await waitForDom("document.documentElement.dataset.screen === 'studio'");

    const started = await studio.start(projectId as StudioProjectId);
    phase("start", {
      connection: started.connection.state,
      engine: started.connection.engine,
      port: started.connection.port,
      profile: started.profile,
      can_submit: started.canSubmit,
    });

    const submitted = await studio.submit(projectId as StudioProjectId, {
      prompt: STUDIO_TASK,
      mode: "work",
    });
    phase("submit", {
      outcome: submitted.outcome,
      turn_id: submitted.turnId,
      operation_key: submitted.operationKey,
      guidance: submitted.guidance,
    });
    await sleep(1_500);
    const runningSnapshot = await studio.snapshot(projectId as StudioProjectId);
    phase("running", {
      active_turn: runningSnapshot.activeTurnId,
      connection: runningSnapshot.connection.state,
    });
    const runningShot = await window.webContents.capturePage();
    const runningFile = "docs/evidence/macos/artifacts/p08-studio-run.png";
    writeFileSync(join(outDir, "p08-studio-run.png"), runningShot.toPNG());
    (report.screenshots as string[]).push(runningFile);

    const deadline = Date.now() + 150_000;
    let events: Awaited<ReturnType<typeof state.readProjectEvents>> = [];
    while (Date.now() < deadline) {
      events = await state.readProjectEvents(projectId as StudioProjectId, 500);
      if (events.some((event) => event.kind === "turn.completed")) break;
      if (events.some((event) => event.kind === "turn.failed" || event.kind === "turn.interrupted"))
        break;
      await sleep(700);
    }
    const completed = events.some((event) => event.kind === "turn.completed");
    await waitForDom("document.querySelectorAll('.timeline-event').length > 0", 15_000);
    await settle(window, 600);
    const liveDom = await domFacts();
    const liveShot = await window.webContents.capturePage();
    const liveFile = "docs/evidence/macos/artifacts/p08-studio-live.png";
    writeFileSync(join(outDir, "p08-studio-live.png"), liveShot.toPNG());
    (report.screenshots as string[]).push(liveFile);

    const helloPath = join(studioSmokeRoot ?? "", "hello.txt");
    const hello = existsSync(helloPath) ? readFileSync(helloPath, "utf8") : null;
    const eventText = JSON.stringify(events);
    const snapshot = await studio.snapshot(projectId as StudioProjectId);

    const beforeReplay = await state.readProjectEvents(projectId as StudioProjectId, 1000);
    const replayFirst = await studio.replay(projectId as StudioProjectId);
    const midReplay = await state.readProjectEvents(projectId as StudioProjectId, 1000);
    const replaySecond = await studio.replay(projectId as StudioProjectId);
    const afterReplay = await state.readProjectEvents(projectId as StudioProjectId, 1000);

    const hold = await studio.submit(projectId as StudioProjectId, {
      prompt: STUDIO_HOLD_TASK,
      mode: "work",
    });
    await sleep(4_000);
    const interrupt = await studio.interrupt(projectId as StudioProjectId);
    const afterInterrupt = await studio.snapshot(projectId as StudioProjectId);
    phase("interrupt", {
      submit_outcome: hold.outcome,
      confirmed: interrupt.confirmed,
      uncertain: interrupt.uncertain,
      note: interrupt.note,
      submission: afterInterrupt.submission,
    });

    const stopped = await studio.stop(projectId as StudioProjectId);
    await sleep(700);
    const offlineShot = await window.webContents.capturePage();
    const offlineFile = "docs/evidence/macos/artifacts/p08-studio-offline.png";
    writeFileSync(join(outDir, "p08-studio-offline.png"), offlineShot.toPNG());
    (report.screenshots as string[]).push(offlineFile);
    const offlineDom = await domFacts();
    const detail = await projects.detail(projectId as StudioProjectId);

    const checks = {
      runtime_connected: started.connection.state === "connected",
      engine_identity_pinned: started.connection.engine?.version === "0.10.2",
      profile_configured: started.profile.provider === "deepseek",
      submission_accepted: submitted.outcome === "accepted",
      turn_completed: completed,
      file_changed: hello !== null && hello.trim() === "mona-p08",
      test_command_observed: /node --test/.test(eventText),
      tool_card_rendered: liveDom.timeline_entries > 0,
      effective_route_observed: snapshot.profile.effective?.model === "deepseek-flash",
      effective_permission_full_access:
        snapshot.profile.effective?.permissionPosture === "full_access",
      cost_observed: snapshot.cost.observed,
      replay_duplicates_observed: replayFirst.duplicates > 0,
      replay_no_duplicate_rows: afterReplay.length === midReplay.length,
      replay_second_pass_ingests_nothing: replaySecond.ingested === 0,
      interrupt_answered: interrupt.confirmed === true,
      interrupt_submission_interrupted:
        afterInterrupt.submission?.status === "interrupted" &&
        afterInterrupt.submission.reconciled === true,
      runtime_stopped: stopped.stopped === true,
      offline_history_retained:
        detail.events.length >= beforeReplay.length && offlineDom.timeline_entries > 0,
      no_link_navigation: liveDom.timeline_anchors === 0 && offlineDom.timeline_anchors === 0,
      no_injected_nodes: liveDom.injected_nodes === 0 && offlineDom.injected_nodes === 0,
      no_fake_percent_in_chrome: liveDom.strip_percent === false,
      ordered_list_rendered: liveDom.ordered_list_marks === "decimal",
    };
    const ok = Object.values(checks).every(Boolean);
    report.checks = checks;
    report.ok = ok;
    report.engine = started.connection.engine;
    report.submission = {
      outcome: submitted.outcome,
      turn_id: submitted.turnId,
      operation_key: submitted.operationKey,
      final_status: snapshot.submission?.status ?? null,
    };
    report.cost = snapshot.cost;
    report.file = { path: helloPath, contents: hello };
    report.events = {
      count: events.length,
      kinds: events.map((event) => event.kind),
    };
    report.replay = {
      before: beforeReplay.length,
      first: replayFirst,
      mid: midReplay.length,
      second: replaySecond,
      after: afterReplay.length,
    };
    report.interrupt = {
      confirmed: interrupt.confirmed,
      uncertain: interrupt.uncertain,
      note: interrupt.note,
    };
    report.offline = {
      connection: stopped.snapshot.connection.state,
      history: detail.events.length,
    };
    report.dom = { live: liveDom, offline: offlineDom };
    report.hello_written_by_engine = hello;
  } catch (error) {
    const candidate = error as { message?: string; stack?: string };
    report.ok = false;
    report.error = { message: candidate.message ?? String(error), stack: candidate.stack ?? null };
  }
  const out = process.env.MONA_STUDIO_SMOKE_OUT;
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (report.ok !== true) process.exitCode = 1;
}

// ------------------------------------------------------------- open smoke

/**
 * P09 evidence runner. The driver performs the registered Finder Service
 * against a temporary project folder twice; this runner proves what the real
 * application did with it: registered once, selected, composer focused, no
 * runtime started, no task created, one window, one catalog entry.
 */
function openSmokeDir(): string {
  return join(app.getPath("home"), "Library", "Application Support", "Mona");
}

async function runOpenSmoke(window: BrowserWindow): Promise<void> {
  const reportPath = join(openSmokeDir(), "open-smoke.json");
  mkdirSync(openSmokeDir(), { recursive: true });
  const report: {
    schema_version: number;
    label: string;
    captured_at: string;
    ok: boolean;
    phases: Array<Record<string, unknown>>;
    checks: Record<string, boolean>;
    requests: Array<Record<string, unknown>>;
    facts: Record<string, unknown>;
    screenshots: string[];
    error?: unknown;
  } = {
    schema_version: 1,
    label: "P09 REAL APPLICATION HANDOFF — built app, macOS-registered Service",
    captured_at: "",
    ok: false,
    phases: [],
    checks: {},
    requests: [],
    facts: {},
    screenshots: [],
  };
  const flush = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const phase = (name: string, extra: Record<string, unknown> = {}) => {
    report.phases.push({ phase: name, at: new Date().toISOString(), ...extra });
    flush();
  };
  const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const evaluate = <T>(expression: string): Promise<T> =>
    window.webContents.executeJavaScript(expression) as Promise<T>;
  const waitFor = async (
    predicate: () => Promise<boolean> | boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(120);
    }
    return false;
  };

  try {
    await waitFor(
      async () => await evaluate<boolean>("document.body.dataset.ready === 'true'"),
      20_000,
    );
    phase("ready", { windows: BrowserWindow.getAllWindows().length });

    const firstSeen = await waitFor(() => openRequests.length >= 1, 90_000);
    if (!firstSeen) throw new Error("no Finder handoff reached the application");
    const first = openRequests[0] as OpenResult;
    const projectId = first.projectId as StudioProjectId;
    report.requests.push(first as unknown as Record<string, unknown>);
    phase("first_request", { source: first.source, ok: first.ok, path: first.path });

    const selected = await waitFor(
      async () => (await evaluate<string>("document.documentElement.dataset.screen")) === "studio",
      15_000,
    );
    await sleep(700);
    const dom = await evaluate<{
      screen: string | null;
      projects: number;
      composer_focused: boolean;
      composer_text: string | null;
      title: string | null;
      banner: boolean;
    }>(`(() => ({
      screen: document.documentElement.dataset.screen,
      projects: document.querySelectorAll('[data-project-id]').length,
      composer_focused: document.activeElement?.tagName === 'TEXTAREA',
      composer_text: document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement.value : null,
      title: document.querySelector('.context-bar__title')?.textContent ?? null,
      banner: document.body.textContent.includes('TEST FIXTURE'),
    }))()`);

    const image = await window.webContents.capturePage();
    // Evidence records names, never this machine's home path.
    writeFileSync(join(openSmokeDir(), "p09-open-handoff.png"), image.toPNG());
    report.screenshots.push("p09-open-handoff.png");

    const statsAfterFirst = await productState?.stats();
    const tasksAfterFirst = projectId ? await productState?.listTasks(projectId) : [];
    phase("first_observed", {
      selected,
      projects: statsAfterFirst?.projects ?? null,
      tasks: tasksAfterFirst?.length ?? null,
      engine: supervisor?.status().state ?? "unknown",
    });

    const secondSeen = await waitFor(() => openRequests.length >= 2, 90_000);
    if (!secondSeen) throw new Error("the second Finder handoff never arrived");
    const second = openRequests[1] as OpenResult;
    report.requests.push(second as unknown as Record<string, unknown>);
    await sleep(600);
    // The Finder panel must show what macOS actually reports, not a claim.
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "5", modifiers: ["meta"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "5", modifiers: ["meta"] });
    await waitFor(
      async () =>
        (await evaluate<string>("document.documentElement.dataset.screen")) === "settings",
      8_000,
    );
    await evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
        (node) => (node.textContent ?? '').trim() === 'Finder',
      );
      if (tab instanceof HTMLElement) tab.click();
      return Boolean(tab);
    })()`);
    await sleep(900);
    const finderPanel = await evaluate<{
      installed: boolean;
      registered: boolean;
      menu_title: boolean;
      handoff: boolean;
      recovery: boolean;
    }>(`(() => {
      const text = document.body.textContent ?? '';
      return {
        installed: text.includes('Library/Services/Mona.service'),
        registered: text.includes('registered'),
        menu_title: text.includes('Start new DS project with Mona'),
        handoff: text.includes('forwarded'),
        recovery: text.includes('Finder handoff is not ready yet'),
      };
    })()`);
    const panelShot = await window.webContents.capturePage();
    writeFileSync(join(openSmokeDir(), "p09-finder-panel.png"), panelShot.toPNG());
    report.screenshots.push("p09-finder-panel.png");

    const statsAfterSecond = await productState?.stats();
    const tasksAfterSecond = projectId ? await productState?.listTasks(projectId) : [];
    phase("second_observed", {
      created: second.created,
      project_id: second.projectId,
      projects: statsAfterSecond?.projects ?? null,
    });

    const checks: Record<string, boolean> = {
      handoff_reached_app: first.ok === true,
      handoff_source_service: first.source === "open_file" || first.source === "service",
      handoff_created_project: first.created === true,
      handoff_path_is_folder: typeof first.path === "string" && first.path.startsWith("/"),
      no_runtime_started:
        first.runtimeStarted === false && supervisor?.status().state !== "running",
      no_task_created:
        (tasksAfterFirst?.length ?? 0) === 0 && (tasksAfterSecond?.length ?? 0) === 0,
      studio_selected: dom.screen === "studio",
      composer_focused: dom.composer_focused === true,
      single_window: BrowserWindow.getAllWindows().length === 1,
      catalog_single_entry: statsAfterFirst?.projects === 1 && statsAfterSecond?.projects === 1,
      second_open_reused: second.ok === true && second.created === false,
      same_project_selected: second.projectId === first.projectId,
      renderer_not_fixture: dom.banner === false,
      finder_panel_installed: finderPanel.installed === true,
      finder_panel_registered: finderPanel.registered === true,
      finder_panel_menu_title: finderPanel.menu_title === true,
      finder_panel_last_handoff: finderPanel.handoff === true,
    };
    report.checks = checks;
    report.facts = {
      first,
      second,
      dom,
      finderPanel,
      tasks: tasksAfterSecond?.length ?? null,
      projects: statsAfterSecond?.projects ?? null,
      engine: supervisor?.status().state ?? "unknown",
      windows: BrowserWindow.getAllWindows().length,
    };
    report.ok = Object.values(checks).every(Boolean);
  } catch (error) {
    report.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    report.ok = false;
  }
  report.captured_at = new Date().toISOString();
  flush();
  if (report.ok !== true) process.exitCode = 1;
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
  // A Finder Service handoff arrives as an `open documents` Apple event. It
  // must be handled before `ready`: Electron emits it that early on a cold
  // launch, and `preventDefault` keeps the app from quitting on the event.
  app.on("open-file", (event, path) => {
    event.preventDefault();
    void dispatchOpen(path, "open_file");
  });

  const paths = resolveAppPaths();
  const store = new OwnershipStore(join(paths.state, "runtime-ownership.json"));
  const productionDriver: RuntimeDriver = createProductionDriver({
    store,
    stateDir: paths.state,
    logDir: paths.logs,
  });

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
    interrupt: async (input) => {
      if (!workStudio) {
        throw new Error("no live studio is attached to this workspace yet");
      }
      return workStudio.interruptTurn(input.task.workspace, input.turnId);
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
  workController = work;

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
    onOpenRequest: (request) => {
      void dispatchOpen(request.path, "second_instance");
    },
  });
  lifecycle.install();
  hardenAllWebContents();

  const fallbackStatus: RuntimeStatus = {
    state: "disconnected",
    reason: "no_supervisor",
    since: new Date(0).toISOString(),
    workspace: null,
    ownershipId: null,
    port: null,
    engine: null,
    external: false,
    restarts: 0,
    lastFailure: null,
    pendingRestartInMs: null,
  };

  const chooseProjectFolder = async (): Promise<string | null> => {
    const options = {
      title: "Open or create a project folder",
      buttonLabel: "Open project",
      properties: ["openDirectory", "createDirectory"] as const,
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, {
            ...options,
            properties: [...options.properties],
          })
        : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  const openProjectFromMenu = async (): Promise<void> => {
    if (!projectService) return;
    try {
      const opened = await projectService.open();
      if (opened && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("projects:changed", { projectId: opened.project.id });
      }
    } catch (error) {
      dialog.showErrorBox(
        "Mona could not open that folder",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const stateFacts = async () => {
    if (!projectService) {
      return {
        open: false,
        database: "",
        projects: 0,
        tasks: 0,
        events: 0,
        artifacts: 0,
        integrity: ["state unavailable"],
        permissionProblems: [],
      };
    }
    const paths = resolveAppPaths();
    const facts = await projectService.stateFacts();
    return {
      ...facts,
      permissionProblems: verifyPrivatePermissions({
        home: app.getPath("home"),
        support: paths.support,
        cache: paths.cache,
        logs: paths.logs,
        state: paths.state,
        database: paths.database,
        backups: paths.backups,
        artifacts: paths.artifacts,
      }),
    };
  };

  void app.whenReady().then(async () => {
    hardenSession(session.defaultSession);
    try {
      const appPaths = resolveAppPaths();
      const smokeState =
        IS_SMOKE || IS_LIFECYCLE_SMOKE || IS_SHELL_SMOKE || IS_STUDIO_SMOKE || IS_OPEN_SMOKE;
      const stateRoot = smokeState
        ? mkdtempSync(join(tmpdir(), "mona-product-state-"))
        : appPaths.state;
      productState = await StateStore.open({
        dbPath: smokeState ? join(stateRoot, "mona.sqlite") : appPaths.database,
        backupDir: smokeState ? join(stateRoot, "backups") : appPaths.backups,
        artifactRoot: smokeState ? join(stateRoot, "artifacts") : appPaths.artifacts,
      });
      projectService = new ProjectService({
        store: productState,
        status: () => supervisor?.status() ?? fallbackStatus,
        chooseFolder: chooseProjectFolder,
        reveal: (path) => shell.showItemInFolder(path),
      });
      openCoordinator = new OpenCoordinator({
        projects: projectService,
        journalPath: join(appPaths.support, "open", "last-open.json"),
        onResult: (result) => {
          openRequests.push(result);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("open:result", result);
            if (result.ok && result.projectId) {
              mainWindow.webContents.send("projects:changed", { projectId: result.projectId });
            }
          }
        },
      });
      resolveCoordinatorReady?.();
      resolveCoordinatorReady = null;
      if (workController && supervisor) {
        workStudio = new WorkStudio({
          store: productState,
          supervisor,
          work: workController,
          ledger: new CostLedger(productState),
          notify: (push) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("studio:changed", push);
            }
          },
          // A finished turn releases its task link, so a later interrupt of a
          // different turn can never be attributed to it.
          onTurnFinished: async (projectId, turnId) => {
            await taskBoard?.clearFinishedTurn(projectId, turnId);
          },
        });
      }
      if (productState) {
        taskBoard = new TaskBoard({ store: productState });
        costLedger = new CostLedger(productState);
      }
    } catch (error) {
      productStateError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Mona state unavailable: ${productStateError}\n`);
      dialog.showErrorBox(
        "Mona cannot open its project state",
        `${productStateError}\n\nMona will not run without its verified state store. ` +
          "The failed database and migration journal were preserved for diagnosis.",
      );
      app.quit();
      return;
    }

    if (IS_SHELL_SMOKE && projectService && productState) {
      const shellBase = mkdtempSync(join(tmpdir(), "mona-shell-smoke-project-"));
      const shellRoot = join(shellBase, "Shell smoke project");
      mkdirSync(shellRoot, { recursive: true });
      writeFileSync(join(shellRoot, "README.md"), "# Shell smoke\n", "utf8");
      const opened = await projectService.open(shellRoot);
      if (opened) {
        await productState.createTask({
          projectId: opened.project.id,
          title: "Make the catalog real",
          prompt: "Open a folder, select the project, and keep drafts local.",
        });
        // P11: a real blocked problem so the shell renders the Victor handoff
        // card and the attempt counters from stored state, not from a fixture.
        const attempted = await productState.createTask({
          projectId: opened.project.id,
          title: "An unproductive loop",
          prompt: "Make the failing check pass without lowering the requirement.",
          requirements: ["MONA-011"],
        });
        await productState.beginTaskRun({ taskId: attempted.id, owner: "mona_queue" });
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await productState.recordProblemAttempt({
            projectId: opened.project.id,
            taskId: attempted.id,
            requirement: "MONA-011",
            symptom: `the same assertion still fails after hypothesis ${attempt}`,
            hypothesis: `hypothesis ${attempt}: the cache key ignores the workspace`,
            action: `attempt ${attempt}: include the canonical path in the key`,
            observed: "the same assertion still fails",
            materialProgress: false,
            evidence: ["docs/evidence/macos/artifacts/p11-shell-blocked.txt"],
          });
        }
        const detail = await projectService.detail(opened.project.id);
        const thread = detail.threads[0];
        if (thread) {
          await productState.recordEvent({
            threadId: thread.id,
            seq: 1,
            kind: "status.disconnected",
            payload: {
              status: "disconnected",
              note: "No runtime bound; history remains readable.",
            },
            timestamp: new Date().toISOString(),
          });
        }
        await projectService.saveDraft(
          opened.project.id,
          thread?.id ?? detail.threads[0]?.id ?? "",
          "Keep this draft local to the shell smoke project.",
        );
        // P12: real stored usage with a reported turn and an unpriced turn, so
        // the cost lens renders mixed evidence rather than a fixture.
        await productState.recordUsage({
          projectId: opened.project.id,
          threadId: thread?.id ?? null,
          turnId: null,
          provider: "deepseek",
          model: "deepseek-flash",
          inputTokens: 1200,
          outputTokens: 40,
          cachedTokens: 800,
          cacheMissTokens: 400,
          reasoningTokens: 12,
          costUsd: 0.0042,
          costState: "reported",
          capturedAt: new Date().toISOString(),
        });
        await productState.recordUsage({
          projectId: opened.project.id,
          threadId: thread?.id ?? null,
          turnId: null,
          provider: "deepseek",
          model: "deepseek-flash",
          inputTokens: 900,
          outputTokens: 20,
          cachedTokens: 0,
          cacheMissTokens: 900,
          reasoningTokens: 0,
          costUsd: null,
          costState: "unknown_price",
          capturedAt: new Date().toISOString(),
        });
        await costLedger?.setBudget({
          projectId: opened.project.id,
          scope: "project",
          limitUsd: 5,
          warnUsd: 1,
        });
      }
    }

    if (IS_STUDIO_SMOKE && projectService && productState) {
      const base = mkdtempSync(join(tmpdir(), "mona-studio-smoke-project-"));
      const root = join(base, "Studio smoke project");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "README.md"), "# Studio smoke\n", "utf8");
      writeFileSync(join(root, "test", "proof.test.js"), STUDIO_PROOF_TEST, "utf8");
      const opened = await projectService.open(root);
      studioSmokeProjectId = opened?.project.id ?? null;
      studioSmokeRoot = root;
    }

    installApplicationMenu({ onOpenProject: () => void openProjectFromMenu() });

    const importPlanFile = async (projectId: StudioProjectId) => {
      if (!taskBoard) throw new StateError("CONFLICT", "the work board is unavailable");
      const target = mainWindow;
      const chosen = target
        ? await dialog.showOpenDialog(target, {
            title: "Import a Mona task plan",
            properties: ["openFile"],
            filters: [{ name: "Mona task plan", extensions: ["json"] }],
          })
        : { canceled: true, filePaths: [] as string[] };
      if (chosen.canceled || chosen.filePaths.length === 0) return null;
      const filePath = chosen.filePaths[0];
      if (!filePath) return null;
      if (statSync(filePath).size > 2_000_000) {
        throw new StateError("IMPORT_INVALID", "task plan is larger than 2 MB");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"));
      } catch (error) {
        throw new StateError(
          "IMPORT_INVALID",
          `task plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return taskBoard.importPlan(projectId, parsed);
    };

    const exportPlanFile = async (projectId: StudioProjectId) => {
      if (!taskBoard) throw new StateError("CONFLICT", "the work board is unavailable");
      const plan = await taskBoard.exportPlan(projectId);
      const target = mainWindow;
      const chosen = target
        ? await dialog.showSaveDialog(target, {
            title: "Export Mona task plan",
            defaultPath: `${plan.name.replace(/[^A-Za-z0-9._ -]/g, "-")}.plan.json`,
            filters: [{ name: "Mona task plan", extensions: ["json"] }],
          })
        : { canceled: true, filePath: undefined };
      if (chosen.canceled || !chosen.filePath) return { saved: false, path: null };
      writeFileSync(chosen.filePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      return { saved: true, path: chosen.filePath };
    };

    const exportCostFile = async (projectId: StudioProjectId, format: "json" | "csv") => {
      if (!costLedger) throw new StateError("CONFLICT", "the cost ledger is unavailable");
      const exported = await costLedger.exportLedger(projectId, { format });
      const target = mainWindow;
      const chosen = target
        ? await dialog.showSaveDialog(target, {
            title: "Export Mona cost ledger",
            defaultPath: exported.filename,
            filters: [
              {
                name: format === "csv" ? "Comma-separated values" : "Cost ledger JSON",
                extensions: [format],
              },
            ],
          })
        : { canceled: true, filePath: undefined };
      if (chosen.canceled || !chosen.filePath) return { saved: false, path: null };
      writeFileSync(chosen.filePath, exported.content, "utf8");
      return { saved: true, path: chosen.filePath };
    };

    registerIpc(RENDERER_ROOT, {
      projects: projectService,
      runtimeStatus: () => runtimeStatusView(supervisor?.status() ?? fallbackStatus),
      stateFacts,
      studio: workStudio,
      board: taskBoard,
      cost: costLedger,
      importPlanFile,
      exportPlanFile,
      exportCostFile,
      openRequest: async (input, source) => {
        const result = await dispatchOpen(input, source);
        if (!result) {
          throw Object.assign(new Error("Mona is still starting; try again in a moment."), {
            code: "RUNTIME_UNAVAILABLE",
          });
        }
        return result;
      },
      openStatus: openStatusFacts,
      serviceStatus: serviceStatusFacts,
      refreshService: () => {
        const before = serviceStatusFacts();
        refreshServiceRegistration(before.installPath);
        return serviceStatusFacts();
      },
      openServiceSettings: async () => {
        // A constant Apple URL scheme, never a caller-supplied target.
        await shell.openExternal(SERVICES_SETTINGS_URL);
        return { opened: true };
      },
      chooseFolder: chooseProjectFolder,
    });
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
    // A cold launch may carry the folder as an argument (a second launch is
    // handled by the single-instance event instead).
    const launchRequest = parseLaunchArguments(process.argv.slice(1), {
      appPath: app.getAppPath(),
      executablePath: process.execPath,
    });
    if (launchRequest) {
      void dispatchOpen(
        launchRequest.ok ? launchRequest.request.input : launchRequest.input,
        "argv",
      );
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });

  app.on("before-quit", () => {
    void workStudio?.close();
    void productState?.close();
  });

  app.on("window-all-closed", () => {
    if (shouldQuitOnWindowAllClosed(process.platform)) app.quit();
  });
}
