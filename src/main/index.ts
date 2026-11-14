import { app, BrowserWindow, Menu, dialog, powerMonitor, session, shell } from "electron";
import { execFileSync } from "node:child_process";
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
import { join, relative, resolve } from "node:path";
import { createMainWindow } from "./window";
import { hardenSession } from "./security";
import { installApplicationMenu, type ApplicationMenuHandle } from "./menu";
import { ZoomController, zoomStore } from "./zoom";
import { NativeFullscreen } from "./window-fullscreen";
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
import { ChangeLedger } from "./work/changes";
import { PolishService } from "./work/polish";
import { AgentObservatory } from "./work/agents";
import { RouteWorkbench } from "./work/settings";
import { ExtensionWorkbench } from "./work/extensions";
import { CapabilityExplorer } from "./work/capability";
import { CommandCatalogService } from "./work/commands";
import { ProjectMemory } from "./work/memory";
import { PromptShelf } from "./work/shelf";
import { ProjectHandoff } from "./work/handoff";
import { TerminalManager } from "./terminal/session";
import { PolishPreferencesStore } from "./work/preferences";
import { PolishNotifier, type NotificationSources } from "./work/notifications";
import { AttentionController, KeepAwake } from "./work/attention";
import { createElectronAttentionHost, createElectronKeepAwakeHost } from "./work/attention-host";
import { createElectronNotificationHost } from "./work/notification-host";
import { StateError } from "./state/errors";
import { StateStore } from "./state/store";
import { verifyPrivatePermissions } from "./state/paths";
import { ProjectService, runtimeStatusView } from "./projects/service";
import { OpenCoordinator } from "./open/coordinator";
import { parseLaunchArguments } from "./open/folder-request";
import { inspectServiceStatus, refreshServiceRegistration } from "./open/service-status";
import { runPackageSmoke } from "./package-smoke";
import { inspectInstallLocation } from "./install-location";
import { UpdateCoordinator, readBuildInfo } from "./update/coordinator";
import {
  inspectRecovery,
  restoreSnapshotWithoutStore,
  selectSnapshotForRestore,
  type RecoveryPaths,
} from "./state/recovery";
import { CURRENT_SCHEMA_VERSION } from "./state/schema";
import type { RuntimeStatus } from "./supervisor/runtime-supervisor";
import type { ProjectId as StudioProjectId } from "../shared/contracts/ids";
import type {
  FolderRequestSource,
  OpenResult,
  OpenStatusView,
  ServiceStatus,
} from "../shared/contracts/open";
import type { PolishFocusTarget } from "../shared/contracts/polish";

app.setName("Mona");

const RENDERER_ROOT = join(__dirname, "../../renderer");
const PRELOAD_PATH = join(__dirname, "../preload/index.js");
const IS_SMOKE = process.argv.includes("--smoke");
const IS_LIFECYCLE_SMOKE = process.argv.includes("--lifecycle-smoke");
const IS_DESIGN_SHOTS = process.argv.includes("--design-shots");
const IS_SHELL_SMOKE = process.argv.includes("--shell-smoke");
const IS_STUDIO_SMOKE = process.argv.includes("--studio-smoke");
const IS_OPEN_SMOKE = process.argv.includes("--open-smoke");
const IS_HISTORY_SMOKE = process.argv.includes("--history-smoke");
const IS_COMMAND_SMOKE = process.argv.includes("--command-smoke");
const IS_IMMERSIVE_SMOKE = process.argv.includes("--immersive-smoke");
const IS_PACKAGE_SMOKE = process.argv.includes("--package-smoke");
const PACKAGE_SMOKE_OUT = (() => {
  const inline = process.argv.find((argument) => argument.startsWith("--package-smoke-out="));
  if (inline) return inline.slice("--package-smoke-out=".length);
  return process.env.MONA_PACKAGE_SMOKE_OUT ?? null;
})();

let mainWindow: BrowserWindow | null = null;
let lifecycle: DesktopLifecycle | null = null;
let supervisor: RuntimeSupervisor | null = null;
let smokeWorkspace: string | null = null;
let smokeStateDirectory: string | null = null;
let lifecycleEvidence: Record<string, unknown> = { schema_version: 1, ok: false, phases: [] };
let lifecycleSmokeStarted = false;
let productState: StateStore | null = null;
let productStateError: string | null = null;
let projectService: ProjectService | null = null;
let workController: WorkController | null = null;
let workStudio: WorkStudio | null = null;
let taskBoard: TaskBoard | null = null;
let costLedger: CostLedger | null = null;
let changeLedger: ChangeLedger | null = null;
let polishService: PolishService | null = null;
let agentObservatory: AgentObservatory | null = null;
let routeWorkbench: RouteWorkbench | null = null;
let extensionWorkbench: ExtensionWorkbench | null = null;
let terminalManager: TerminalManager | null = null;
let capabilityExplorer: CapabilityExplorer | null = null;
const commandCatalog = new CommandCatalogService();
let projectMemory: ProjectMemory | null = null;
let promptShelf: PromptShelf | null = null;
let projectHandoff: ProjectHandoff | null = null;
let updateCoordinator: UpdateCoordinator | null = null;
let polishMenu: ApplicationMenuHandle | null = null;
/** Interface scale survives relaunch through the settings table. */
let zoomController: ZoomController | null = null;
/**
 * Native full screen, one controller per window. Keyed by the web contents id
 * the IPC sender carries, so a request can only reach the window that made it.
 */
const fullscreenControllers = new Map<number, NativeFullscreen>();
let keepAwake: KeepAwake | null = null;
let activeProjectId: StudioProjectId | null = null;
let studioSmokeProjectId: string | null = null;
let studioSmokeRoot: string | null = null;
let historySmokeProjectId: string | null = null;
let commandSmokeProjectId: string | null = null;
let immersiveSmokeProjectId: string | null = null;
let openCoordinator: OpenCoordinator | null = null;
let resolveCoordinatorReady: (() => void) | null = null;
interface EngineIdentity {
  version: string | null;
  commit: string | null;
  binaryPresent: boolean;
  /** When the recorded snapshot was captured; null when nothing is recorded. */
  observedAt: string | null;
}

let cachedEngineIdentity: EngineIdentity = {
  version: null,
  commit: null,
  binaryPresent: false,
  observedAt: null,
};

/**
 * The engine identity recorded for this machine, for requalifying an imported
 * handoff.
 *
 * Nothing here starts a process. Presence is a PATH stat (`discoverTools`), and
 * version and commit come from the last capability snapshot the explorer stored.
 * The P19 surface promises no engine call, and an exec would both break that
 * promise and block the main thread, so a machine with no recorded snapshot
 * reports "unknown" until the capability explorer runs instead of probing.
 */
function engineIdentity(): EngineIdentity {
  return cachedEngineIdentity;
}

async function loadEngineIdentity(store: StateStore | null): Promise<void> {
  const present = discoverTools(["codewhale"])[0]?.path != null;
  if (!store) {
    cachedEngineIdentity = {
      version: null,
      commit: null,
      binaryPresent: present,
      observedAt: null,
    };
    return;
  }
  try {
    const snapshot = await store.latestCapabilitySnapshot();
    cachedEngineIdentity = {
      version: snapshot?.engineVersion ?? null,
      commit: snapshot?.engineCommit ?? null,
      binaryPresent: present,
      observedAt: snapshot?.capturedAt ?? null,
    };
  } catch {
    cachedEngineIdentity = {
      version: null,
      commit: null,
      binaryPresent: present,
      observedAt: null,
    };
  }
}

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
  // The saved scale is applied to every window this launch creates, including a
  // Dock reopen, so the interface never comes back at a different size.
  zoomController?.apply(window);
  // Native full screen is observed per window and never restored: a relaunch
  // opens a normal window even when the last one was in its own Space.
  const contentsId = window.webContents.id;
  fullscreenControllers.set(
    contentsId,
    new NativeFullscreen({
      window,
      warn: (message: string) => process.stderr.write(`fullscreen: ${message}\n`),
    }),
  );
  window.on("closed", () => {
    fullscreenControllers.get(contentsId)?.dispose();
    fullscreenControllers.delete(contentsId);
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
  if (IS_HISTORY_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void runHistorySmoke(window)
        .catch((error: unknown) => {
          process.stderr.write(`history smoke failed: ${String(error)}\n`);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
    });
  }
  if (IS_IMMERSIVE_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void runImmersiveSmoke(window)
        .catch((error: unknown) => {
          process.stderr.write(`immersive smoke failed: ${String(error)}\n`);
          process.exitCode = 1;
        })
        .finally(() => app.quit());
    });
  }
  if (IS_COMMAND_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void runCommandSmoke(window)
        .catch((error: unknown) => {
          process.stderr.write(`command smoke failed: ${String(error)}\n`);
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

function showMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  return openWindow();
}

/**
 * Notification clicks and the menu-bar menu land here. The target names a
 * project and the evidence it refers to; the renderer selects it. This never
 * starts a runtime or a task.
 */
function focusPolish(target: PolishFocusTarget): void {
  const window = showMainWindow();
  if (typeof target.projectId === "string" && target.projectId.length > 0) {
    activeProjectId = target.projectId as StudioProjectId;
  }
  const send = (): void => {
    if (!window.isDestroyed()) window.webContents.send("polish:focus", target);
  };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
}

async function interruptActiveWork(): Promise<void> {
  const projectId = activeProjectId;
  if (!projectId || !workStudio) return;
  try {
    await workStudio.interrupt(projectId);
  } catch {
    // The receipt UI reports the real outcome; the menu action stays honest.
  }
  await polishService?.refresh(projectId).catch(() => undefined);
}

/** Recovery operates on paths, not on an open store, so it works when open fails. */
function recoveryPaths(): RecoveryPaths {
  const paths = resolveAppPaths();
  return { database: paths.database, backupsDir: paths.backups, supportDir: paths.support };
}

let cachedOsRelease: string | null = null;

/** The marketing macOS version, not the Darwin kernel release. */
function osRelease(): string {
  if (cachedOsRelease !== null) return cachedOsRelease;
  try {
    cachedOsRelease = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    cachedOsRelease = "";
  }
  return cachedOsRelease;
}

/**
 * State that could not be opened has three different causes and needs three
 * different answers. This dialog never offers a "try anyway": an older build
 * cannot open a newer schema, and saying otherwise would corrupt real work.
 */
async function reportStartupFailure(message: string): Promise<void> {
  const recovery = inspectRecovery(recoveryPaths());
  const matching = recovery.snapshots.filter((snapshot) => snapshot.appliesToThisBuild);
  const heading =
    recovery.state === "newer_schema"
      ? "This Mac's data was written by a newer Mona"
      : recovery.state === "migration_failed"
        ? "Mona could not migrate its project state"
        : "Mona cannot open its project state";

  const body = [
    message,
    "",
    recovery.problem?.message ?? "",
    "",
    `Current database schema: ${recovery.databaseSchemaVersion ?? "unreadable"}. This build: v${recovery.buildSchemaVersion}.`,
    recovery.journal
      ? `Migration journal: ${recovery.journal.state} (v${recovery.journal.fromVersion} to v${recovery.journal.toVersion}).`
      : "No migration journal was written.",
    `Support path: ${recovery.support.backupsPath}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  if (matching.length === 0) {
    dialog.showErrorBox(
      heading,
      `${body}\n\nNo snapshot this build can verify is available. ` +
        "Reinstall the build that wrote this data; the database and any journal were kept.",
    );
    return;
  }

  const newest = matching[0];
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    title: heading,
    message: heading,
    detail:
      `${body}\n\nA verified v${recovery.buildSchemaVersion} snapshot from ` +
      `${newest?.createdAt ?? "an earlier session"} can be restored. ` +
      "Everything recorded after that snapshot is discarded, and the current file is kept beside it.",
    buttons: ["Restore verified snapshot…", "Quit"],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice !== 0 || !newest) return;
  try {
    const receipt = await restoreSnapshotWithoutStore(recoveryPaths(), {
      snapshotPath: newest.path,
      expectedSchemaVersion: newest.schemaVersion,
    });
    process.stderr.write(
      `Mona restored ${receipt.snapshotPath}; the previous database is at ${receipt.replacedPath ?? "(none)"}\n`,
    );
    app.relaunch();
  } catch (error) {
    // The restore is failure-safe: a failed swap puts the previous database
    // back. Report what the receipt actually says rather than promising it.
    const details = (error as { details?: Record<string, unknown> }).details ?? {};
    const rollback = details.rollback;
    dialog.showErrorBox(
      "Mona could not restore that snapshot",
      `${error instanceof Error ? error.message : String(error)}\n` +
        (rollback === "ok" || rollback === null
          ? "The previous database is in place."
          : "The previous database could not be put back automatically. It is preserved beside the database file; see the support path recorded above."),
    );
  }
}

async function requestQuit(interrupt: boolean): Promise<{ requested: boolean; note: string }> {
  if (interrupt) await interruptActiveWork();
  setTimeout(() => app.quit(), 250);
  return {
    requested: true,
    note: interrupt
      ? "Quit requested. Active work was asked to interrupt; only the runtime Mona owns is stopped."
      : "Quit requested. If work is active, the shutdown path interrupts it before the owned runtime stops.",
  };
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

  // Evidence runs must not inherit the previous run's theme from localStorage.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "6", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "6", modifiers: ["meta"] });
  await waitFor("document.documentElement.dataset.screen === 'settings'");
  await window.webContents.executeJavaScript(`(() => {
    const daybreak = Array.from(document.querySelectorAll('.segmented__option')).find(
      (node) => (node.textContent ?? '').trim() === 'Daybreak',
    );
    if (daybreak instanceof HTMLElement) daybreak.click();
    const comfortable = Array.from(document.querySelectorAll('.segmented__option')).find(
      (node) => (node.textContent ?? '').trim() === 'Comfortable',
    );
    if (comfortable instanceof HTMLElement) comfortable.click();
    return Boolean(daybreak && comfortable);
  })()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "1", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "1", modifiers: ["meta"] });
  await waitFor("document.documentElement.dataset.screen === 'home'");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const home = await window.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('[data-project-id]').length,
    screen: document.documentElement.dataset.screen,
    fixture_label: document.body.textContent.includes('TEST FIXTURE'),
    nav_count: document.querySelectorAll('[data-nav]').length,
    version: document.querySelector('[data-testid="app-version"]')?.textContent ?? null,
    theme: document.documentElement.dataset.theme,
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  const homeShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p07-shell-home.png"), homeShot.toPNG());

  // P14: the Resume Brief and "Since you left" render from stored records.
  const resumeReady = await waitFor(
    "document.querySelector('[data-testid=\"resume-brief\"]') !== null",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const resume = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    const brief = document.querySelector('[data-testid="resume-brief"]');
    const since = document.querySelector('[data-testid="since-you-left"]');
    return {
      brief: Boolean(brief),
      heading: text.includes('Resume Brief'),
      next_action: Boolean(document.querySelector('[data-testid="resume-next"]')),
      blocker: text.includes('Unresolved blocker'),
      since_present: Boolean(since),
      since_entries: since ? since.querySelectorAll('.digest__item').length : 0,
      no_completion_percent: !/\b\d+%\b/.test(text),
      no_model_call: text.includes('no model call'),
      facts: document.querySelectorAll('[data-testid="resume-facts"] .detail-row').length,
    };
  })()`);
  const resumeShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p14-home-daybreak.png"), resumeShot.toPNG());

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
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    // P23 polish: the agent console is the wide surface, and the task /
    // requirements / context inspector sits beside the prompt box, not beside
    // the console. Measure it, so a future CSS edit cannot quietly undo it.
    layout: (() => {
      const studioEl = document.querySelector('.studio');
      const consoleEl = document.querySelector('.studio__timeline');
      const composerEl = document.querySelector('.composer');
      const inspectorEl = document.querySelector('.studio__inspector');
      if (!studioEl || !consoleEl || !composerEl || !inspectorEl) {
        return { ok: false, reason: 'missing studio regions' };
      }
      const box = (node) => node.getBoundingClientRect();
      const studioRect = box(studioEl);
      const consoleRect = box(consoleEl);
      const composerRect = box(composerEl);
      const inspectorRect = box(inspectorEl);
      const consoleShare = studioRect.width > 0 ? consoleRect.width / studioRect.width : 0;
      // Side by side: the inspector starts after the composer ends, and their
      // vertical ranges overlap, so they really share a row.
      const beside = inspectorRect.left >= composerRect.right - 1;
      const sameRow =
        inspectorRect.top < composerRect.bottom - 1 &&
        composerRect.top < inspectorRect.bottom - 1;
      return {
        ok: true,
        console_share: Math.round(consoleShare * 100) / 100,
        console_height: Math.round(consoleRect.height),
        console_above_composer: consoleRect.bottom <= composerRect.top + 1,
        inspector_beside_composer: beside && sameRow,
        inspector_width: Math.round(inspectorRect.width),
        composer_width: Math.round(composerRect.width),
      };
    })()
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

  // P13: receipts, attribution, and Git state from stored records.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "4", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "4", modifiers: ["meta"] });
  const changesReady = await waitFor("document.documentElement.dataset.screen === 'changes'");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const changes = await window.webContents.executeJavaScript(`(() => ({
    screen: document.documentElement.dataset.screen,
    settled: document.body.textContent.includes('Settled delta'),
    file: document.body.textContent.includes('src-app.ts'),
    tool: document.body.textContent.includes('Tool: edit_file'),
    delta: document.body.textContent.includes('Workspace delta'),
    receipt: document.body.textContent.includes('no restore point'),
    restore_unavailable: document.body.textContent.includes('Start the studio for this project'),
    git_branch: document.body.textContent.includes('main'),
    unreceipted: document.body.textContent.includes('No recorded turn names this path'),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  const changesShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p13-shell-changes.png"), changesShot.toPNG());

  // Open a recorded file lazily; without a live engine the honest local window
  // is shown instead of a fabricated diff.
  await window.webContents.executeJavaScript(
    "document.querySelector('.change-file__path')?.click(); true",
  );
  const changesFileReady = await waitFor("document.querySelector('.code-view') !== null");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const changesFile = await window.webContents.executeJavaScript(`(() => ({
    code_view: Boolean(document.querySelector('.code-view')),
    content: document.body.textContent.includes('export const reviewed = true;'),
    honest_source: document.body.textContent.includes('workspace'),
    horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }))()`);
  const changesFileShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p13-shell-changes-file.png"), changesFileShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "5", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "5", modifiers: ["meta"] });
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

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "6", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "6", modifiers: ["meta"] });
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

  // P16/P17: the configuration workbench is reachable without a runtime. With
  // no live engine it must say so and show no invented route, credential, or
  // health value. The live behavior is exercised by the dedicated smokes.
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#tab-route')?.click();
    return true;
  })()`);
  const routeReady = await waitFor(
    "document.body.textContent.includes('Saved new-thread default')",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const routeFacts = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    return {
      screen: document.documentElement.dataset.screen,
      heading: text.includes('Providers & route') || text.includes('Saved new-thread default'),
      offline_stated: text.includes('Live engine not connected'),
      no_fake_route: !text.includes('effective deepseek/'),
      policy_locked: text.includes('automatic routing: off') && text.includes('fallback: refuse'),
      horizontal_overflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  const routeShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p16-settings-route.png"), routeShot.toPNG());

  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#tab-extensions')?.click();
    return true;
  })()`);
  const extensionsReady = await waitFor("document.body.textContent.includes('Workspace scope')");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const extensionsFacts = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    return {
      screen: document.documentElement.dataset.screen,
      categories: ['MCP', 'Skills', 'Plugins', 'Hooks', 'Instructions', 'Commands'].every((label) =>
        Array.from(document.querySelectorAll('[role="tab"]')).some((node) =>
          node.textContent?.includes(label),
        ),
      ),
      offline_stated: text.includes('Live engine not connected'),
      gaps_stated: text.includes('Known limits'),
      no_fake_health: !text.includes('connected ·') && !text.includes('handshake succeeded'),
      horizontal_overflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  const extensionsShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p17-settings-extensions.png"), extensionsShot.toPNG());

  // P18: the palette ranks projects, prompts, settings, and engine capabilities
  // locally, and a capability row opens its real entry point.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "k", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "k", modifiers: ["meta"] });
  const capabilityPaletteReady = await waitFor(
    "document.querySelector('.palette__count') !== null",
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  const typePaletteQuery = async (value: string) => {
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#shell-palette-filter');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!(input instanceof HTMLInputElement) || !setter) return false;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  const paletteSnapshot = (): Promise<Record<string, unknown>> =>
    window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return {
        text: dialog?.textContent ?? '',
        badges: dialog?.querySelectorAll('.palette__detail .badge').length ?? 0,
        count: dialog?.querySelector('.palette__count')?.textContent ?? null,
        rows: dialog?.querySelectorAll('.palette__item').length ?? 0,
      };
    })()`);
  await typePaletteQuery("settings");
  const paletteSettings = await paletteSnapshot();
  await typePaletteQuery("doctor");
  const paletteDoctor = await paletteSnapshot();
  await typePaletteQuery("workflow");
  const paletteWorkflow = await paletteSnapshot();
  const paletteCapabilities = {
    open: capabilityPaletteReady,
    ranked_locally: String(paletteSettings.count ?? "").includes("ranked locally"),
    has_settings: String(paletteSettings.text).includes("Settings: Providers & route"),
    has_prompt:
      String(paletteSettings.text).includes("Insert prompt") ||
      String(paletteSettings.text).includes("Task:"),
    has_capability:
      String(paletteDoctor.text).includes("diagnostics") ||
      String(paletteDoctor.text).includes("doctor"),
    detail_badges: Number(paletteDoctor.badges) + Number(paletteWorkflow.badges),
    counts: {
      settings: paletteSettings.count,
      doctor: paletteDoctor.count,
      workflow: paletteWorkflow.count,
    },
  };
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor("document.querySelector('[role=\"dialog\"]') === null");

  // The capability explorer is a real screen, not a static table.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "8", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "8", modifiers: ["meta"] });
  const capabilitiesReady = await waitFor(
    "document.documentElement.dataset.screen === 'capabilities' && document.querySelectorAll('.capability-row').length > 10",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const capabilities = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    return {
      screen: document.documentElement.dataset.screen,
      rows: document.querySelectorAll('.capability-row').length,
      verdict: document.querySelector('[data-testid="capability-verdict"]')?.textContent ?? '',
      drift_matches: text.includes('matches the inventory'),
      drift_stated:
        text.includes('matches the inventory') ||
        text.includes('differs — re-qualification required') ||
        text.includes('unchecked'),
      features: document.querySelectorAll('[data-testid="feature-flags"] li').length,
      counts: document.querySelector('[data-testid="capability-count"]')?.textContent ?? '',
      horizontal_overflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  // A blocked gap names its route instead of offering a dead control.
  await window.webContents.executeJavaScript(`(() => {
    const row = Array.from(document.querySelectorAll('.capability-row')).find((node) =>
      node.textContent?.includes('workflow'),
    );
    if (row instanceof HTMLElement) row.click();
    return Boolean(row);
  })()`);
  const gapDetailReady = await waitFor(
    "document.querySelector('[data-testid=\"capability-detail\"]')?.textContent.includes('No in-app route') === true",
  );
  const gapDetail = await window.webContents.executeJavaScript(`(() => ({
    text: document.querySelector('[data-testid="capability-detail"]')?.textContent ?? '',
    no_open_button: !Array.from(document.querySelectorAll('[data-testid="capability-detail"] button')).some(
      (node) => node.textContent?.includes('Open'),
    ),
  }))()`);
  const capabilitiesShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p18-capabilities.png"), capabilitiesShot.toPNG());

  // A terminal row prefills the exact command in the integrated terminal.
  await window.webContents.executeJavaScript(`(() => {
    const row = Array.from(document.querySelectorAll('.capability-row')).find((node) =>
      node.textContent?.includes('doctor'),
    );
    if (row instanceof HTMLElement) row.click();
    return Boolean(row);
  })()`);
  await waitFor(
    "document.querySelector('[data-testid=\"capability-detail\"]')?.textContent.includes('codewhale doctor') === true",
  );
  await window.webContents.executeJavaScript(`(() => {
    const action = Array.from(document.querySelectorAll('[data-testid="capability-detail"] button')).find(
      (node) => node.textContent?.includes('Open Settings'),
    );
    if (action instanceof HTMLElement) action.click();
    return Boolean(action);
  })()`);
  const capabilityNavigates = await waitFor(
    "document.documentElement.dataset.screen === 'settings' && document.body.textContent.includes('Connection diagnostics')",
  );

  // The integrated terminal: a real native pty, a real shell, a real resize.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "j", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "j", modifiers: ["meta"] });
  const terminalPanelReady = await waitFor(
    "document.querySelector('[data-testid=\"terminal-panel\"]') !== null",
  );
  // Open the terminal from the palette's capability row, then start a shell.
  await window.webContents.executeJavaScript(`(() => {
    const create = Array.from(document.querySelectorAll('[data-testid="terminal-panel"] button')).find(
      (node) => node.textContent?.includes('New shell'),
    );
    if (create instanceof HTMLElement) create.click();
    return Boolean(create);
  })()`);
  const terminalSessionReady = await waitFor("document.querySelector('.terminal__tab') !== null");
  await new Promise((resolve) => setTimeout(resolve, 350));
  window.webContents.executeJavaScript(
    "document.querySelector('[data-testid=\"terminal-input\"]')?.focus()",
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  window.webContents.insertText("echo p18-terminal-ready\n");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  const terminalOutputReady = await waitFor(
    "document.querySelector('[data-testid=\"terminal-transcript\"]')?.textContent.includes('p18-terminal-ready') === true",
    10_000,
  );
  // A malicious OSC 8 hyperlink must stay inert text.
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-testid="terminal-input"]');
    if (input instanceof HTMLInputElement) input.focus();
    return true;
  })()`);
  window.webContents.insertText(
    "printf '\\033]8;;file:///etc/passwd\\007clickme\\033]8;;\\007\\n'\n",
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  const inertLinkReady = await waitFor(
    "document.querySelector('[data-testid=\"terminal-transcript\"]')?.textContent.includes('clickme') === true",
    10_000,
  );
  const terminalInert = await window.webContents.executeJavaScript(`(() => {
    const view = document.querySelector('[data-testid="terminal-transcript"]');
    const text = view?.textContent ?? '';
    return {
      clickme: text.includes('clickme'),
      no_href: view?.querySelector('a') === null,
      no_url: !text.includes('file:///etc/passwd'),
      no_escape: !text.includes('\u001b'),
    };
  })()`);
  // Resize reaches the child: ask the shell for its window size.
  await window.webContents.executeJavaScript(`(() => {
    const inputs = Array.from(document.querySelectorAll('.terminal__size input'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (inputs[0] && setter) {
      setter.call(inputs[0], '120');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (inputs[1] && setter) {
      setter.call(inputs[1], '40');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    }
    const resize = Array.from(document.querySelectorAll('[data-testid="terminal-panel"] button')).find(
      (node) => node.textContent?.trim() === 'Resize',
    );
    if (resize instanceof HTMLElement) resize.click();
    return Boolean(resize);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-testid=\"terminal-input\"]')?.focus()",
  );
  window.webContents.insertText("stty size\n");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  const resizeObserved = await waitFor(
    "document.querySelector('[data-testid=\"terminal-transcript\"]')?.textContent.includes('40 120') === true",
    10_000,
  );
  const terminalFacts = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    return {
      environment_stated: text.includes('startup files not sourced'),
      limits_stated: text.includes('full-screen programs are not emulated'),
      status: document.querySelector('.terminal__facts .badge')?.textContent ?? null,
      cols_rows: Array.from(document.querySelectorAll('.terminal__facts span')).map((node) => node.textContent),
    };
  })()`);
  const terminalShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p18-terminal.png"), terminalShot.toPNG());
  // Close the shell so the smoke leaves no child process behind.
  await window.webContents.executeJavaScript(`(() => {
    const close = Array.from(document.querySelectorAll('[data-testid="terminal-panel"] button')).find(
      (node) => node.textContent?.includes('Close session'),
    );
    if (close instanceof HTMLElement) close.click();
    return Boolean(close);
  })()`);
  const terminalClosed = await waitFor(
    "document.querySelector('.terminal__tab-status')?.textContent === 'exited'",
    10_000,
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "j", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "j", modifiers: ["meta"] });
  await waitFor("document.querySelector('[data-testid=\"terminal-panel\"]') === null");

  // P15: the agent observatory is reachable by keyboard and reports a detached
  // studio honestly. No runtime is started here, so this proves the stored /
  // disconnected path with an empty engine list rather than a simulated swarm.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "7", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "7", modifiers: ["meta"] });
  const agentsReady = await waitFor("document.documentElement.dataset.screen === 'agents'");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const agents = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    return {
      screen: document.documentElement.dataset.screen,
      header: text.includes('Real engine identities'),
      not_connected: text.includes('Not connected'),
      detached_reason: text.includes('The live studio is not attached'),
      stored_run: text.includes('fleet_shell_0001'),
      stored_worker: text.includes('fleet_shell_0001-local-1'),
      stored_agent: text.includes('agent_shell_0001'),
      stored_spend_unknown: text.includes('No spend value is retained locally'),
      serial_boundary: text.includes('Serial one-task launch is the only qualified mode.'),
      gap_rows: Array.from(document.querySelectorAll('.agent-gaps li')).length,
      parallel_checks: Array.from(document.querySelectorAll('.agent-check')).length,
      // A detached view publishes no capabilities, so the honest gate is the
      // capability message, not an offer to launch.
      launch_refused:
        text.includes('This runtime cannot start a fleet') &&
        !Array.from(document.querySelectorAll('button')).some((node) =>
          node.textContent?.includes('Launch serial run'),
        ),
      stored_goal: text.includes('Finish the shell smoke goal'),
      goal_control_locked: text.includes('This goal comes from a stored observation.'),
      no_fake_percent: !/\b\d+%\b/.test(text),
      horizontal_overflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);
  const agentsShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p15-agents-daybreak.png"), agentsShot.toPNG());

  // Select the stored sub-agent so the inspector's real fields are captured:
  // identity, task link, branch, last event, spend confidence, tools, tests.
  await window.webContents.executeJavaScript(`(() => {
    const summary = Array.from(document.querySelectorAll('summary')).find((node) =>
      node.textContent?.includes('agent_shell_0001'),
    );
    if (summary instanceof HTMLElement) summary.click();
    return Boolean(summary);
  })()`);
  const agentInspectorReady = await waitFor(
    "document.querySelector('[aria-label=\"Sub-agent inspector\"]') !== null",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const agentInspector = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('[aria-label="Sub-agent inspector"]');
    const text = panel?.textContent ?? '';
    return {
      open: Boolean(panel),
      identity: text.includes('agent_shell_0001'),
      parent: text.includes('root (no parent reported)'),
      spend: text.includes('Spend: Unknown'),
      tests: text.includes('Self-reported only') || text.includes('No test evidence'),
      tools: text.includes('Stored projection only'),
      artifacts: text.includes('No artifacts were reported'),
      cancel_disabled: Array.from(panel?.querySelectorAll('button') ?? []).some(
        (button) => button.textContent?.includes('Cancel run') && button.disabled === true,
      ),
      no_additive_total: text.includes('never adds a parent and child total'),
    };
  })()`);
  const agentInspectorShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p15-agents-inspector.png"), agentInspectorShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "6", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "6", modifiers: ["meta"] });
  const settingsReturned = await waitFor("document.documentElement.dataset.screen === 'settings'");

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

  // P14: attention settings, Focus Mode in Afterglow, and the shortcut list.
  await window.webContents.executeJavaScript(`(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
      (node) => (node.textContent ?? '').trim() === 'Attention',
    );
    if (tab instanceof HTMLElement) tab.click();
    return Boolean(tab);
  })()`);
  const attentionReady = await waitFor("document.body.textContent.includes('Quiet hours')");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const attention = await window.webContents.executeJavaScript(`(() => {
    const text = document.body.textContent ?? '';
    const loginSwitch = Array.from(document.querySelectorAll('[role="switch"]')).find(
      (node) => (node.textContent ?? '').includes('Open Mona at login'),
    );
    return {
      ready: text.includes('Quiet hours'),
      keep_awake: text.includes('Keep the Mac awake while work is active'),
      login_off: loginSwitch ? loginSwitch.getAttribute('aria-checked') === 'false' : false,
      menu_bar_state: text.includes('menu-bar status is installed'),
      test_button: Array.from(document.querySelectorAll('button')).some(
        (node) => node.textContent?.includes('Send test notification'),
      ),
      receipts: Boolean(document.querySelector('[data-testid="notification-receipts"]')),
    };
  })()`);
  const attentionShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p14-settings-attention.png"), attentionShot.toPNG());

  // The second half of the tab carries native state and delivery receipts.
  await window.webContents.executeJavaScript(`(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((node) =>
      node.textContent?.includes('Attention surfaces'),
    );
    card?.scrollIntoView({ block: 'start' });
    return Boolean(card);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const attentionDetailShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p14-settings-attention-native.png"), attentionDetailShot.toPNG());

  // Exercise the real notification path once and record what the system did.
  await window.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (node) => node.textContent?.includes('Send test notification'),
    );
    if (button instanceof HTMLElement) button.click();
    return Boolean(button);
  })()`);
  const notificationTest = await waitFor(
    "document.querySelector('[data-testid=\"notification-receipts\"]') !== null",
    5_000,
  );
  await window.webContents.executeJavaScript(`(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((node) =>
      node.textContent?.includes('Delivery receipts'),
    );
    card?.scrollIntoView({ block: 'start' });
    return Boolean(card);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const notification = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('[data-testid="notification-receipts"]');
    const text = list?.textContent ?? '';
    return {
      receipt: Boolean(list),
      text,
      shown: text.includes('shown'),
      handed_over: text.includes('handed over'),
      refused: text.includes('system refused'),
      suppressed_with_reason: text.includes('suppressed'),
    };
  })()`);
  const receiptsShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p14-settings-receipts.png"), receiptsShot.toPNG());

  // Switch to Afterglow so the second theme gets equal evidence.
  await window.webContents.executeJavaScript(`(() => {
    const appearance = Array.from(document.querySelectorAll('[role="tab"]')).find(
      (node) => (node.textContent ?? '').trim() === 'Appearance',
    );
    if (appearance instanceof HTMLElement) appearance.click();
    return Boolean(appearance);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterglow = await window.webContents.executeJavaScript(`(() => {
    const option = Array.from(document.querySelectorAll('.segmented__option')).find(
      (node) => (node.textContent ?? '').trim() === 'Afterglow',
    );
    if (option instanceof HTMLElement) option.click();
    return Boolean(option);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const themeApplied = await window.webContents.executeJavaScript(
    "document.documentElement.dataset.theme",
  );

  // P15: the same observatory in Afterglow, so both themes carry evidence.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "7", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "7", modifiers: ["meta"] });
  const agentsAfterglowReady = await waitFor(
    "document.documentElement.dataset.screen === 'agents'",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const agentsAfterglowShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p15-agents-afterglow.png"), agentsAfterglowShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta"] });
  await waitFor("document.documentElement.dataset.screen === 'studio'");
  window.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "F",
    modifiers: ["meta", "shift"],
  });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: ["meta", "shift"] });
  const focusOn = await waitFor("document.documentElement.dataset.focusMode === 'on'");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const focus = await window.webContents.executeJavaScript(`(() => ({
    focus_on: document.querySelector('[data-focus-mode="on"]') !== null,
    inspector_hidden: document.querySelector('[aria-label="Inspector"]') === null,
    control_strip: document.querySelector('.control-strip') !== null,
    interrupt_visible: document.body.textContent.includes('Interrupt now'),
    favorites: document.querySelectorAll('.favorite-chip').length,
    no_overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  }))()`);
  const focusComposer = await window.webContents.executeJavaScript(`(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const send = document.querySelector('[data-testid="studio-send"]');
    const strip = document.querySelector('.control-strip');
    if (!send || !strip) return { ok: false, reason: 'missing send or strip' };
    const sendRect = send.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    const covered = Array.from(document.elementsFromPoint(
      sendRect.left + sendRect.width / 2,
      sendRect.top + sendRect.height / 2,
    )).some((node) => strip.contains(node));
    window.scrollTo(0, 0);
    return { ok: !covered && sendRect.bottom <= stripRect.top + 1, covered };
  })()`);
  const focusShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p14-studio-focus-afterglow.png"), focusShot.toPNG());

  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "/", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "/", modifiers: ["meta"] });
  const shortcutsOpen = await waitFor(
    "document.querySelector('[data-testid=\"shortcut-list\"]') !== null",
  );
  const shortcuts = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('[data-testid="shortcut-list"]');
    return {
      open: Boolean(list),
      rows: list ? list.querySelectorAll('.shortcut-row').length : 0,
      focus_mode: list ? list.textContent.includes('Focus Mode') : false,
      deliberate_interrupt: list ? list.textContent.includes('Interrupt current work') : false,
    };
  })()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  const shortcutsClosed = await waitFor(
    "document.querySelector('[data-testid=\"shortcut-list\"]') === null",
  );

  // P14: a notification click focuses the named project and evidence. The real
  // macOS click cannot be scripted here, so this drives the same message the
  // click handler sends and proves the renderer's handling of it.
  const focusTargetProject = await window.webContents.executeJavaScript(
    "localStorage.getItem('mona.lastProject')",
  );
  window.webContents.send("polish:focus", {
    projectId: focusTargetProject,
    screen: "changes",
    taskId: null,
    problemId: null,
    changeSetId: "cs_notification_focus",
    fromNotification: true,
  });
  const notificationFocus = await waitFor("document.documentElement.dataset.screen === 'changes'");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const focusLanded = await window.webContents.executeJavaScript(`(() => ({
    screen: document.documentElement.dataset.screen,
    change_screen: document.querySelector('.change-set-wrap') !== null,
    focus_mode_remaining: document.documentElement.dataset.focusMode,
  }))()`);

  // P19: project memory. The screen reads stored records, shows the computed
  // index, previews a resume packet, and refuses to claim the provider request.
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "9", modifiers: ["meta"] });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "9", modifiers: ["meta"] });
  const memoryReady = await waitFor(
    "document.documentElement.dataset.screen === 'memory' && document.querySelector('[data-testid=\"memory-screen\"]') !== null",
  );
  // Wait for the resolved index, not just its container: the card renders a
  // loading state first and an assertion against that would be meaningless.
  await waitFor(
    "document.querySelector('[data-testid=\"memory-index\"]')?.textContent.includes('Credentials are never indexed.') === true",
  );
  const memoryIndexFacts = await window.webContents.executeJavaScript(`(() => {
    const index = document.querySelector('[data-testid="memory-index"]');
    const text = index?.textContent ?? '';
    return {
      index_present: Boolean(index),
      no_credentials: text.includes('Credentials are never indexed.'),
      on_demand: text.includes('on demand, never copied into the database'),
      not_persisted: text.includes('Search is a local read; nothing is persisted.'),
      excluded_rows: index ? index.querySelectorAll('li').length : 0,
      no_model_call: (document.body.textContent ?? '').includes('No model call is made here'),
    };
  })()`);
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-testid="memory-search-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'resume packet');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    input?.closest('form')?.requestSubmit();
    return Boolean(input);
  })()`);
  const memorySearchReady = await waitFor(
    "document.querySelectorAll('[data-testid=\"memory-hit\"]').length > 0",
  );
  const memorySearchFacts = await window.webContents.executeJavaScript(`(() => {
    const hits = Array.from(document.querySelectorAll('[data-testid="memory-hit"]'));
    const text = document.body.textContent ?? '';
    const summary = document.querySelector('[data-testid="memory-results"]')?.textContent ?? '';
    return {
      hits: hits.length,
      has_decision: hits.some((node) => node.textContent?.includes('Resume packet format')),
      summary_not_persisted: summary.includes('not persisted'),
      redacted: !text.includes('sk-cccccccc'),
      redaction_stated: /\\d+ redaction/.test(summary),
      summary: summary.slice(0, 240),
    };
  })()`);
  const memoryShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p19-memory-search.png"), memoryShot.toPNG());

  // Resume packet: Mona's own text, with the engine limit stated.
  await window.webContents.executeJavaScript(`(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"], .tabs__tab, button')).find(
      (node) => (node.textContent ?? '').trim() === 'Resume & context',
    );
    if (tab instanceof HTMLElement) tab.click();
    return Boolean(tab);
  })()`);
  const memoryResumeReady = await waitFor(
    "document.querySelector('[data-testid=\"memory-resume-text\"]') !== null",
  );
  const memoryResumeFacts = await window.webContents.executeJavaScript(`(() => {
    const text = document.querySelector('[data-testid="memory-resume-text"]')?.textContent ?? '';
    const body = document.body.textContent ?? '';
    return {
      has_text: text.length > 0,
      states_limit: body.includes('cannot show the assembled provider request'),
      names_project: text.includes('Shell smoke project'),
      no_secret: !text.includes('sk-cccccccc'),
    };
  })()`);

  // Context selection: toggling a slot grows the preview.
  // A task must be chosen before slots exist. Pick the seeded task by name, the
  // same way a person would, then toggle an optional slot.
  await window.webContents.executeJavaScript(`(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    const taskSelect = selects.find((node) =>
      Array.from(node.options).some((option) => option.textContent === 'Make the catalog real'),
    );
    if (!(taskSelect instanceof HTMLSelectElement)) return false;
    const target = Array.from(taskSelect.options).find(
      (option) => option.textContent === 'Make the catalog real',
    );
    if (!target) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(taskSelect, target.value);
    taskSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor("document.querySelector('[data-testid=\"memory-context-slots\"]') !== null");
  await window.webContents.executeJavaScript(`(() => {
    const slot = document.querySelector('[data-testid="memory-context-slots"]');
    const first = slot?.querySelector('input[type="checkbox"]');
    if (first instanceof HTMLElement) first.click();
    return Boolean(first);
  })()`);
  const contextReady = await waitFor(
    "document.querySelector('[data-testid=\"memory-context-preview\"]') !== null",
  );
  const memoryContextFacts = await window.webContents.executeJavaScript(`(() => {
    const preview = document.querySelector('[data-testid="memory-context-preview"]');
    const text = preview?.textContent ?? '';
    return {
      present: Boolean(preview),
      states_provider_limit: text.includes('no provider-request inspection'),
      bytes_stated: /\\d+ bytes/.test(text),
      slot_rows: document.querySelectorAll('[data-testid="memory-context-slots"] input').length,
    };
  })()`);

  // Prompt shelf: the seeded prompt exists and previews with a literal value.
  await window.webContents.executeJavaScript(`(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"], .tabs__tab, button')).find(
      (node) => (node.textContent ?? '').trim() === 'Prompt shelf',
    );
    if (tab instanceof HTMLElement) tab.click();
    return Boolean(tab);
  })()`);
  const shelfReady = await waitFor(
    "document.querySelector('[data-testid=\"memory-shelf-list\"]') !== null",
  );
  await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('[data-testid="memory-shelf-list"]');
    const button = Array.from(list?.querySelectorAll('button') ?? []).find((node) =>
      node.textContent?.includes('Resume packet check'),
    );
    if (button instanceof HTMLElement) button.click();
    return Boolean(button);
  })()`);
  await waitFor(
    "document.querySelector('[data-testid=\"memory-shelf-detail\"]')?.textContent.includes('Acceptance checklist') === true",
  );
  await window.webContents.executeJavaScript(`(() => {
    const detail = document.querySelector('[data-testid="memory-shelf-detail"]');
    const preview = Array.from(detail?.querySelectorAll('button') ?? []).find(
      (node) => (node.textContent ?? '').trim() === 'Preview',
    );
    if (preview instanceof HTMLElement) preview.click();
    return Boolean(preview);
  })()`);
  const shelfPreviewReady = await waitFor(
    "document.querySelector('[data-testid=\"memory-prompt-preview\"]') !== null",
  );
  const memoryShelfFacts = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('[data-testid="memory-shelf-list"]');
    const text = list?.textContent ?? '';
    const detail = document.querySelector('[data-testid="memory-shelf-detail"]')?.textContent ?? '';
    const preview = document.querySelector('[data-testid="memory-prompt-preview"]')?.textContent ?? '';
    return {
      has_seeded: text.includes('Resume packet check'),
      preview_present: preview.length > 0,
      keeps_unfilled_token: preview.includes('{{audience}}'),
      states_inert: detail.includes('never runs or sends anything'),
      limits_stated: (document.body.textContent ?? '').includes('versions per prompt'),
    };
  })()`);

  // Handoff & diagnostics: the preview names what a bundle cannot carry, and a
  // real archive round-trips through inspection.
  await window.webContents.executeJavaScript(`(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"], .tabs__tab, button')).find(
      (node) => (node.textContent ?? '').trim() === 'Handoff & diagnostics',
    );
    if (tab instanceof HTMLElement) tab.click();
    return Boolean(tab);
  })()`);
  const handoffReady = await waitFor(
    "document.querySelector('[data-testid=\"memory-handoff-preview\"]') !== null",
  );
  const memoryHandoffFacts = await window.webContents.executeJavaScript(`(() => {
    const preview = document.querySelector('[data-testid="memory-handoff-preview"]');
    const text = preview?.textContent ?? '';
    return {
      present: Boolean(preview),
      names_limits:
        text.toLowerCase().includes('engine conversation') || text.includes('sessions'),
      has_checks: text.includes('MONA-024') || preview.querySelectorAll('.badge').length > 0,
      no_secret: !text.includes('sk-cccccccc'),
    };
  })()`);
  const handoffShot = await window.webContents.capturePage();
  writeFileSync(join(outDir, "p19-memory-handoff.png"), handoffShot.toPNG());

  // Interface scale. Drive the real menu items — the path a key press takes —
  // then restore 100% so nothing after this observation sees a scaled window.
  const zoomMenu = (() => {
    const menu = Menu.getApplicationMenu();
    const item = (id: string) => menu?.getMenuItemById(id) ?? null;
    const inItem = item("zoom-in");
    const alias = item("zoom-in-equals");
    return {
      registered:
        Boolean(item("zoom-in")) &&
        Boolean(alias) &&
        Boolean(item("zoom-out")) &&
        Boolean(item("zoom-reset")),
      plus: inItem?.accelerator ?? null,
      equals: alias?.accelerator ?? null,
      alias_hidden: alias ? alias.visible === false : false,
      out: item("zoom-out")?.accelerator ?? null,
      reset: item("zoom-reset")?.accelerator ?? null,
    };
  })();
  const zoomBaseline = window.webContents.getZoomFactor();
  if (zoomMenu.registered) {
    Menu.getApplicationMenu()?.getMenuItemById("zoom-in-equals")?.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  const zoomAfterClick = window.webContents.getZoomFactor();
  const zoomStored = productState
    ? ((await productState.getSettings("app:zoom"))?.value as { factor?: number } | undefined)
    : undefined;
  const zoomStoredFactor = zoomStored?.factor ?? null;
  // Restore the baseline immediately: the scale check must not leak into any
  // later observation or capture in this run.
  if (Math.abs(window.webContents.getZoomFactor() - zoomBaseline) > 0.001) {
    await zoomController?.reset();
  }

  const checks: Record<string, boolean> = {
    ready,
    cards,
    home_screen: home.screen === "home",
    nav_count: home.nav_count === 9,
    fixture_label_absent: home.fixture_label === false,
    home_theme_daybreak: home.theme === "daybreak",
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
    zoom_menu_registered:
      zoomMenu.registered &&
      zoomMenu.plus === "CmdOrCtrl+Plus" &&
      zoomMenu.equals === "CmdOrCtrl+=" &&
      zoomMenu.alias_hidden === true &&
      zoomMenu.out === "CmdOrCtrl+-" &&
      zoomMenu.reset === "CmdOrCtrl+0",
    zoom_applies_through_menu: Math.abs(zoomAfterClick - 1.1) < 0.001,
    zoom_persisted: zoomStoredFactor === 1.1,
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
    changes_screen: changesReady && changes.screen === "changes",
    changes_receipt_rendered: changes.settled === true && changes.file === true,
    changes_attribution: changes.tool === true && changes.delta === true,
    changes_missing_restore_point: changes.receipt === true,
    changes_restore_unavailable: changes.restore_unavailable === true,
    changes_git_state: changes.git_branch === true && changes.unreceipted === true,
    changes_no_horizontal_overflow: changes.horizontal_overflow === false,
    changes_lazy_text_window:
      changesFileReady &&
      changesFile.code_view === true &&
      changesFile.content === true &&
      changesFile.horizontal_overflow === false,
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
    studio_console_spans_width: studio.layout.ok === true && studio.layout.console_share >= 0.9,
    studio_console_is_tall: studio.layout.ok === true && studio.layout.console_height >= 340,
    studio_console_above_composer:
      studio.layout.ok === true && studio.layout.console_above_composer === true,
    studio_inspector_beside_composer:
      studio.layout.ok === true && studio.layout.inspector_beside_composer === true,
    no_horizontal_overflow:
      home.horizontal_overflow === false &&
      studio.horizontal_overflow === false &&
      board.horizontal_overflow === false &&
      cost.horizontal_overflow === false &&
      settings.horizontal_overflow === false,
    resume_brief_rendered: resumeReady && resume.brief === true && resume.heading === true,
    resume_brief_has_next_action: resume.next_action === true,
    resume_brief_shows_blocker: resume.blocker === true,
    resume_brief_facts: resume.facts >= 5,
    resume_brief_no_percentage: resume.no_completion_percent === true,
    resume_brief_no_model_call: resume.no_model_call === true,
    since_you_left_rendered: resume.since_present === true && resume.since_entries >= 2,
    attention_settings_ready: attentionReady && attention.ready === true,
    attention_keep_awake_control: attention.keep_awake === true,
    attention_launch_at_login_off: attention.login_off === true,
    attention_menu_bar_reported: attention.menu_bar_state === true,
    attention_test_control: attention.test_button === true,
    afterglow_selected: afterglow === true && themeApplied === "afterglow",
    focus_mode_on: focusOn && focus.focus_on === true,
    focus_mode_hides_inspector: focus.inspector_hidden === true,
    focus_mode_keeps_controls: focus.control_strip === true && focus.interrupt_visible === true,
    focus_mode_no_overflow: focus.no_overflow === true,
    focus_mode_composer_usable: focusComposer.ok === true,
    notification_test_receipt:
      notificationTest &&
      notification.receipt === true &&
      (notification.shown === true ||
        notification.handed_over === true ||
        notification.refused === true ||
        notification.suppressed_with_reason === true),
    shortcuts_open: shortcutsOpen && shortcuts.open === true,
    shortcuts_cover_focus_and_interrupt:
      shortcuts.rows >= 8 &&
      shortcuts.focus_mode === true &&
      shortcuts.deliberate_interrupt === true,
    shortcuts_escape: shortcutsClosed,
    notification_click_focuses_project:
      notificationFocus && focusLanded.screen === "changes" && focusLanded.change_screen === true,
    agents_screen: agentsReady && agents.screen === "agents",
    agents_header: agents.header === true,
    agents_disconnected_honest:
      agents.not_connected === true &&
      agents.detached_reason === true &&
      agents.stored_run === true &&
      agents.stored_worker === true,
    agents_stored_agent_row: agents.stored_agent === true,
    agents_stored_spend_unknown: agents.stored_spend_unknown === true,
    agents_stored_goal_locked: agents.stored_goal === true && agents.goal_control_locked === true,
    agents_serial_boundary: agents.serial_boundary === true && agents.parallel_checks === 4,
    agents_gaps_visible: agents.gap_rows >= 5,
    agents_launch_refused: agents.launch_refused === true,
    agents_no_fake_percent: agents.no_fake_percent === true,
    agents_no_horizontal_overflow: agents.horizontal_overflow === false,
    agents_afterglow: agentsAfterglowReady,
    agents_inspector_open: agentInspectorReady && agentInspector.open === true,
    agents_inspector_identity: agentInspector.identity === true && agentInspector.parent === true,
    agents_inspector_honest_spend:
      agentInspector.spend === true && agentInspector.no_additive_total === true,
    agents_inspector_tests_and_tools:
      agentInspector.tests === true && agentInspector.tools === true,
    agents_inspector_terminal_cancel_disabled: agentInspector.cancel_disabled === true,
    palette_capabilities:
      capabilityPaletteReady &&
      paletteCapabilities.open === true &&
      paletteCapabilities.ranked_locally === true &&
      paletteCapabilities.has_settings === true &&
      paletteCapabilities.has_capability === true &&
      paletteCapabilities.detail_badges > 0,
    capabilities_explorer:
      capabilitiesReady &&
      capabilities.rows >= 50 &&
      capabilities.verdict.includes("Full parity is not claimed") &&
      capabilities.drift_stated === true &&
      capabilities.features > 0 &&
      capabilities.horizontal_overflow === false,
    capabilities_gap_named:
      gapDetailReady &&
      gapDetail.text.toLowerCase().includes("/v1/workflow") &&
      gapDetail.no_open_button === true,
    capability_entry_navigates: capabilityNavigates === true,
    memory_screen:
      memoryReady &&
      memoryIndexFacts.index_present === true &&
      memoryIndexFacts.no_model_call === true &&
      memoryIndexFacts.excluded_rows > 3,
    memory_index_honest:
      memoryIndexFacts.no_credentials === true &&
      memoryIndexFacts.on_demand === true &&
      memoryIndexFacts.not_persisted === true,
    memory_search:
      memorySearchReady &&
      memorySearchFacts.hits >= 2 &&
      memorySearchFacts.has_decision === true &&
      memorySearchFacts.summary_not_persisted === true,
    memory_search_redacts:
      memorySearchFacts.redacted === true && memorySearchFacts.redaction_stated === true,
    memory_resume:
      memoryResumeReady &&
      memoryResumeFacts.has_text === true &&
      memoryResumeFacts.names_project === true &&
      memoryResumeFacts.states_limit === true &&
      memoryResumeFacts.no_secret === true,
    memory_context:
      contextReady &&
      memoryContextFacts.present === true &&
      memoryContextFacts.states_provider_limit === true &&
      memoryContextFacts.bytes_stated === true,
    memory_shelf:
      shelfReady && memoryShelfFacts.has_seeded === true && memoryShelfFacts.states_inert === true,
    memory_handoff:
      handoffReady &&
      memoryHandoffFacts.present === true &&
      memoryHandoffFacts.names_limits === true &&
      memoryHandoffFacts.no_secret === true,
    terminal_panel: terminalPanelReady === true,
    terminal_session: terminalSessionReady === true,
    terminal_output: terminalOutputReady === true,
    terminal_link_inert:
      inertLinkReady === true &&
      terminalInert.clickme === true &&
      terminalInert.no_href === true &&
      terminalInert.no_url === true &&
      terminalInert.no_escape === true,
    terminal_resize_reaches_child: resizeObserved === true,
    terminal_environment_stated:
      terminalFacts.environment_stated === true && terminalFacts.limits_stated === true,
    terminal_exit_observed: terminalClosed === true,
    settings_returned: settingsReturned,
    settings_route_offline:
      routeReady &&
      routeFacts.offline_stated === true &&
      routeFacts.policy_locked === true &&
      routeFacts.no_fake_route === true &&
      routeFacts.horizontal_overflow === false,
    settings_extensions_categories:
      extensionsReady &&
      extensionsFacts.categories === true &&
      extensionsFacts.offline_stated === true &&
      extensionsFacts.gaps_stated === true &&
      extensionsFacts.no_fake_health === true &&
      extensionsFacts.horizontal_overflow === false,
  };
  const ok = Object.values(checks).every(Boolean);
  const report = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    ok,
    checks,
    facts: {
      home,
      studio,
      board,
      attempts,
      cost,
      settings,
      routeFacts,
      extensionsFacts,
      palette,
      composerFits,
      resume,
      attention,
      focus,
      focusComposer,
      notification,
      shortcuts,
      focusLanded,
      agents,
      agentInspector,
      paletteCapabilities,
      capabilities,
      gapDetail,
      memoryIndexFacts,
      memorySearchFacts,
      memoryResumeFacts,
      memoryContextFacts,
      memoryShelfFacts,
      shelfPreviewReady,
      memoryHandoffFacts,
      terminalInert,
      terminalFacts,
    },
    screenshots: [
      "docs/evidence/macos/artifacts/p07-shell-home.png",
      "docs/evidence/macos/artifacts/p07-shell-studio.png",
      "docs/evidence/macos/artifacts/p07-shell-board.png",
      "docs/evidence/macos/artifacts/p11-shell-board.png",
      "docs/evidence/macos/artifacts/p11-shell-attempts.png",
      "docs/evidence/macos/artifacts/p07-shell-settings.png",
      "docs/evidence/macos/artifacts/p13-shell-changes.png",
      "docs/evidence/macos/artifacts/p13-shell-changes-file.png",
      "docs/evidence/macos/artifacts/p12-shell-cost.png",
      "docs/evidence/macos/artifacts/p12-shell-cost-detail.png",
      "docs/evidence/macos/artifacts/p14-home-daybreak.png",
      "docs/evidence/macos/artifacts/p14-settings-attention.png",
      "docs/evidence/macos/artifacts/p14-settings-attention-native.png",
      "docs/evidence/macos/artifacts/p14-settings-receipts.png",
      "docs/evidence/macos/artifacts/p14-studio-focus-afterglow.png",
      "docs/evidence/macos/artifacts/p15-agents-daybreak.png",
      "docs/evidence/macos/artifacts/p15-agents-afterglow.png",
      "docs/evidence/macos/artifacts/p15-agents-inspector.png",
      "docs/evidence/macos/artifacts/p16-settings-route.png",
      "docs/evidence/macos/artifacts/p17-settings-extensions.png",
      "docs/evidence/macos/artifacts/p18-capabilities.png",
      "docs/evidence/macos/artifacts/p18-terminal.png",
      "docs/evidence/macos/artifacts/p19-memory-search.png",
      "docs/evidence/macos/artifacts/p19-memory-handoff.png",
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

// ------------------------------------------------------------ history smoke

/**
 * R02 evidence runner. It opens a real 10,000+ event project in the real shell
 * and drives the paged history: Load earlier, scroll anchoring, Jump to latest,
 * thread selection, and honest partial items. Reading history must not start a
 * runtime or ask a model; the connection check below asserts that.
 */
async function runHistorySmoke(window: BrowserWindow): Promise<void> {
  const outDir =
    process.env.MONA_HISTORY_SMOKE_OUT_DIR ??
    join(process.cwd(), "docs", "evidence", "macos", "artifacts");
  mkdirSync(outDir, { recursive: true });
  window.setSize(1280, 900);
  const report: Record<string, unknown> = {
    schema_version: 1,
    ok: false,
    checks: {} as Record<string, boolean>,
    phases: [] as unknown[],
  };
  const checks = report.checks as Record<string, boolean>;
  const phases = report.phases as Array<Record<string, unknown>>;
  const phase = (name: string, value: Record<string, unknown>): void => {
    phases.push({ name, ...value });
  };
  const waitFor = async (expression: string, timeoutMs = 30_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await window.webContents.executeJavaScript(expression);
      if (value) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  try {
    report.project = historySmokeProjectId;
    await waitFor("document.body.dataset.ready === 'true'");
    checks.catalog_rendered = await waitFor(
      "document.querySelectorAll('[data-project-id]').length > 0",
    );
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-project-id]')?.click(); true",
    );
    checks.studio_opened = await waitFor("document.documentElement.dataset.screen === 'studio'");
    checks.timeline_rendered = await waitFor(
      "document.querySelectorAll('.timeline-event').length > 0",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const initial = await window.webContents.executeJavaScript(`(() => {
      const text = document.body.textContent ?? '';
      const scope = document.querySelector('[data-testid="studio-history-scope"]');
      const select = document.querySelector('[data-testid="studio-thread-select"]');
      return {
        scope: scope?.textContent ?? null,
        cards: document.querySelectorAll('.timeline-event').length,
        newest_visible: text.includes('history frame 10050'),
        older_absent: !text.includes('history frame 9850'),
        load_button: Boolean(document.querySelector('[data-testid="studio-load-earlier"]')),
        jump_button: Boolean(document.querySelector('[data-testid="studio-jump-latest"]')),
        connection: document.querySelector('[data-testid="studio-connection"]')?.textContent ?? null,
        thread_options: select ? Array.from(select.options).map((option) => option.textContent) : [],
        thread_disabled: select ? select.disabled : null,
      };
    })()`);
    phase("initial", initial);
    const storedReported = Number(String(initial.scope ?? "").match(/(\d+) stored/)?.[1] ?? "0");
    report.stored_total = storedReported;
    checks.scope_reports_stored_total = storedReported >= 10_000;
    checks.scope_reports_older_pages = String(initial.scope ?? "").includes(
      "older pages available",
    );
    checks.newest_page_visible = initial.newest_visible === true;
    checks.older_page_not_yet_loaded = initial.older_absent === true;
    checks.load_earlier_offered = initial.load_button === true;
    checks.jump_absent_at_live_edge = initial.jump_button === false;
    checks.no_runtime_started = String(initial.connection ?? "").includes("Not started");
    checks.thread_selector_present = initial.thread_disabled === false;
    checks.thread_selector_distinguishes =
      initial.thread_options.some((label: string | null) => label?.includes("current")) &&
      initial.thread_options.some((label: string | null) => label?.includes("archived"));

    // Scroll away from the live edge, then load an older page. The content
    // above the viewport must grow by exactly the distance the viewport moves:
    // that is what "does not drag the reader down" means in pixels.
    const before = await window.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-testid="studio-timeline"]');
      if (!node) return null;
      node.scrollTop = 300;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { top: node.scrollTop, height: node.scrollHeight };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    checks.jump_appears_after_scrolling = await waitFor(
      `Boolean(document.querySelector('[data-testid="studio-jump-latest"]'))`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="studio-load-earlier"]')?.click(); true`,
    );
    checks.older_page_loaded = await waitFor(
      "(document.body.textContent ?? '').includes('history frame 9850')",
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = await window.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-testid="studio-timeline"]');
      if (!node) return null;
      return {
        top: node.scrollTop,
        height: node.scrollHeight,
        anchor_applications: Number(node.dataset.anchorApplications ?? -1),
        older_loads: Number(node.dataset.historyLoads ?? -1),
      };
    })()`);
    const anchorDelta =
      before && after
        ? Math.abs(after.top - before.top - (after.height - before.height))
        : Number.NaN;
    phase("anchor", { before, after, delta: anchorDelta });
    checks.scroll_anchor_held = Number.isFinite(anchorDelta) && anchorDelta <= 2;
    checks.older_page_rendered_once = await window.webContents.executeJavaScript(
      "((document.body.textContent ?? '').match(/history frame 9850/g) ?? []).length === 1",
    );

    // A second page proves the cursor continues rather than reloading one fixed
    // window.
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="studio-load-earlier"]')?.click(); true`,
    );
    checks.second_older_page_loaded = await waitFor(
      "(document.body.textContent ?? '').includes('history frame 9650')",
    );

    await window.webContents.executeJavaScript(
      `document.querySelector('[data-testid="studio-jump-latest"]')?.click(); true`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const atLatest = await window.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-testid="studio-timeline"]');
      if (!node) return null;
      return {
        distance: node.scrollHeight - node.scrollTop - node.clientHeight,
        jump_button: Boolean(document.querySelector('[data-testid="studio-jump-latest"]')),
        scope: document.querySelector('[data-testid="studio-history-scope"]')?.textContent ?? null,
      };
    })()`);
    phase("jump", atLatest);
    checks.jump_to_latest_returns_to_edge =
      atLatest !== null && atLatest.distance < 48 && atLatest.jump_button === false;

    const shot = await window.webContents.capturePage();
    const shotPath = join(outDir, "r02-history-long-session.png");
    writeFileSync(shotPath, shot.toPNG());
    // Repo-relative: the report is evidence that ships with the build, and an
    // absolute path would carry this machine's account name (D-101).
    report.screenshot = relative(process.cwd(), shotPath);
    report.ok = Object.values(checks).every(Boolean);
  } catch (error) {
    const candidate = error as { message?: string; stack?: string };
    report.ok = false;
    report.error = { message: candidate.message ?? String(error), stack: candidate.stack ?? null };
  }
  const out = process.env.MONA_HISTORY_SMOKE_OUT;
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (report.ok !== true) process.exitCode = 1;
}

// ----------------------------------------------------------- command smoke

/**
 * R03 evidence runner. It opens a real project in the real Electron shell and
 * drives the composer's command list with real keyboard and pointer events.
 * Autocomplete, filtering, and help are local reads: the connection stays
 * "Not started" and no model request is made.
 */
async function runCommandSmoke(window: BrowserWindow): Promise<void> {
  const outDir =
    process.env.MONA_COMMAND_SMOKE_OUT_DIR ??
    join(process.cwd(), "docs", "evidence", "macos", "review-studio", "artifacts");
  mkdirSync(outDir, { recursive: true });
  window.setSize(1280, 900);
  const report: Record<string, unknown> = {
    schema_version: 1,
    ok: false,
    checks: {} as Record<string, boolean>,
    facts: {} as Record<string, unknown>,
  };
  const checks = report.checks as Record<string, boolean>;
  const facts = report.facts as Record<string, unknown>;
  const waitFor = async (expression: string, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await window.webContents.executeJavaScript(expression);
      if (value) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  };
  const evaluate = async <T>(expression: string): Promise<T> =>
    (await window.webContents.executeJavaScript(expression)) as T;
  const typeText = async (value: string): Promise<string> =>
    evaluate<string>(`(() => {
      const element = document.querySelector("textarea");
      if (!element) throw new Error("composer textarea is absent");
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, ${JSON.stringify(value)});
      element.setSelectionRange(${JSON.stringify(value)}.length, ${JSON.stringify(value)}.length);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return element.value;
    })()`);
  const pressKey = async (
    init: Record<string, unknown>,
  ): Promise<{ prevented: boolean; value: string }> =>
    evaluate(`(() => {
      const element = document.querySelector("textarea");
      const event = new KeyboardEvent("keydown", ${JSON.stringify({ bubbles: true, cancelable: true, ...init })});
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, value: element.value };
    })()`);
  try {
    report.project = commandSmokeProjectId;
    await waitFor("document.body.dataset.ready === 'true'");
    checks.catalog_rendered = await waitFor(
      "document.querySelectorAll('[data-project-id]').length > 0",
    );
    await evaluate("document.querySelector('[data-project-id]')?.click(); true");
    checks.studio_opened = await waitFor("document.documentElement.dataset.screen === 'studio'");
    await waitFor("document.querySelector('textarea') !== null");
    await typeText("/");
    checks.menu_opens = await waitFor("document.querySelector('.command-menu') !== null");
    checks.listbox_is_labelled = await evaluate(
      "document.querySelector('[role=\"listbox\"]')?.getAttribute('aria-label') === 'Codewhale commands'",
    );
    const initial = await evaluate<Record<string, unknown>>(`(() => {
      const menu = document.querySelector(".command-menu");
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      return {
        header: menu?.querySelector(".command-menu__head")?.textContent ?? "",
        options: options.length,
        first: options[0]?.textContent ?? "",
        detail: menu?.querySelector(".command-menu__detail")?.textContent ?? "",
        connection:
          document.querySelector('[data-testid="studio-connection"]')?.textContent ?? "",
      };
    })()`);
    facts.initial = initial;
    checks.reports_catalog_total = String(initial.header ?? "").includes("109 catalogued");
    checks.has_real_description = String(initial.detail ?? "").length > 20;
    checks.connection_not_started = String(initial.connection ?? "").includes("Not started");

    await typeText("/he");
    const filtered = await evaluate<Record<string, unknown>>(`(() => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      return {
        count: options.length,
        first: options[0]?.textContent ?? "",
        detail: document.querySelector(".command-menu__detail")?.textContent ?? "",
      };
    })()`);
    facts.filtered = filtered;
    checks.filter_narrows =
      Number(filtered.count) > 0 && Number(filtered.count) < Number(initial.options);
    checks.filter_finds_help = String(filtered.first).includes("/help");
    checks.detail_shows_tui_route = String(filtered.detail).includes("TUI only");

    const accepted = await pressKey({ key: "Tab" });
    checks.tab_accepts = await waitFor("document.querySelector('textarea')?.value === '/help '");
    facts.tab = {
      prevented: accepted.prevented,
      value: await evaluate<string>("document.querySelector('textarea')?.value ?? ''"),
    };
    checks.menu_closed_after_accept = await waitFor(
      "document.querySelector('.command-menu') === null",
    );

    await typeText("/he");
    const escape = await pressKey({ key: "Escape" });
    checks.escape_closes_first = escape.prevented === true;
    checks.escape_keeps_draft = escape.value === "/he";
    checks.menu_closed_by_escape = await waitFor(
      "document.querySelector('.command-menu') === null",
    );

    await typeText("/he");
    const plainEnter = await pressKey({ key: "Enter" });
    checks.plain_enter_is_newline = plainEnter.prevented === false;

    await typeText("/he");
    await pressKey({ key: "Enter", metaKey: true });
    checks.ambiguous_explained = await waitFor(
      "document.querySelector('.notification__title')?.textContent?.includes('ambiguous') === true",
    );
    const ambiguousNotice = await evaluate<string>(
      "document.querySelector('.notification__title')?.textContent ?? ''",
    );
    facts.ambiguous_notice = ambiguousNotice;
    checks.ambiguous_keeps_draft =
      (await evaluate<string>("document.querySelector('textarea')?.value ?? ''")) === "/he";

    await typeText("/help");
    await pressKey({ key: "Enter", metaKey: true });
    checks.tui_only_explained = await waitFor(
      "document.querySelector('.notification__title')?.textContent?.includes('TUI-only') === true",
    );
    facts.tui_only_notice = await evaluate<string>(
      "document.querySelector('.notification__title')?.textContent ?? ''",
    );
    checks.engine_still_not_started = (
      await evaluate<string>(
        "document.querySelector('[data-testid=\"studio-connection\"]')?.textContent ?? ''",
      )
    ).includes("Not started");

    await typeText("/");
    // Wait for the composer's committed state, not just the DOM value: a
    // controlled input can show the previous draft until React commits the
    // edit, and the capture must show the list the app really renders.
    checks.unfiltered_list_restored = await waitFor(
      "document.querySelector('.command-menu__head')?.textContent?.includes('79 matches') === true",
      5_000,
    );
    facts.normal = await evaluate<Record<string, unknown>>(`(() => {
      const menu = document.querySelector(".command-menu");
      const compose = document.querySelector(".composer");
      const rect = menu?.getBoundingClientRect();
      const crect = compose?.getBoundingClientRect();
      return {
        top: rect?.top ?? null,
        bottom: rect?.bottom ?? null,
        height: rect?.height ?? null,
        composer_top: crect?.top ?? null,
        composer_height: crect?.height ?? null,
        viewport_height: window.innerHeight,
        header: document.querySelector(".command-menu__head")?.textContent ?? null,
        detail_height: document.querySelector(".command-menu__detail")?.getBoundingClientRect().height ?? null,
        body_height: document.querySelector(".command-menu__body")?.getBoundingClientRect().height ?? null,
        placement: document.querySelector(".command-menu")?.className ?? null,
      };
    })()`);
    const normalFacts = facts.normal as { top?: number | null; placement?: string };
    checks.menu_inside_viewport_at_default =
      (normalFacts.top ?? -1) >= 0 || normalFacts.placement?.includes("below") === true;
    const menuShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r03-command-menu.png"), menuShot.toPNG());

    // 200% page zoom: the floating list must stay inside the window and keep
    // its own scrolling, instead of pushing the composer or the page sideways.
    window.webContents.setZoomFactor(2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // A user at 200% zooms to the composer before typing; focus/scroll bring the
    // textarea into the viewport, and the list must then fit beside it.
    await evaluate("document.querySelector('textarea')?.scrollIntoView({ block: 'center' }); true");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await typeText("/");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const zoomed = await evaluate<Record<string, unknown>>(`(() => {
      const menu = document.querySelector(".command-menu");
      const rect = menu?.getBoundingClientRect();
      const body = document.querySelector(".command-menu__body");
      return {
        inside:
          rect !== undefined &&
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
        width: rect?.width ?? 0,
        viewport: window.innerWidth,
        top: rect?.top ?? null,
        bottom: rect?.bottom ?? null,
        height: rect?.height ?? null,
        viewport_height: window.innerHeight,
        scrolls: body ? body.scrollHeight > body.clientHeight : false,
        page_overflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        detail_visible: Boolean(document.querySelector(".command-menu__detail")),
        body_height:
          document.querySelector(".command-menu__body")?.getBoundingClientRect().height ?? 0,
        options: document.querySelectorAll('[role="option"]').length,
      };
    })()`);
    facts.zoomed = zoomed;
    checks.zoom_200_menu_inside_viewport = zoomed.inside === true;
    checks.zoom_200_no_page_overflow = zoomed.page_overflow === false;
    checks.zoom_200_list_usable = Number(zoomed.body_height ?? 0) >= 40;
    checks.zoom_200_options_present = Number(zoomed.options) > 0;
    const zoomShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r03-command-menu-200.png"), zoomShot.toPNG());
    window.webContents.setZoomFactor(1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    report.screenshots = ["r03-command-menu.png", "r03-command-menu-200.png"];
    report.ok = Object.values(checks).every(Boolean);
  } catch (error) {
    const candidate = error as { message?: string; stack?: string };
    report.ok = false;
    report.error = { message: candidate.message ?? String(error), stack: candidate.stack ?? null };
  }
  const out = process.env.MONA_COMMAND_SMOKE_OUT;
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (report.ok !== true) process.exitCode = 1;
}

// ---------------------------------------------------------- immersive smoke

/**
 * R05 evidence runner. Real Electron, a real window, a real AppKit full-screen
 * transition. It proves the things a jsdom test cannot: the dashboard is 44–56
 * logical pixels, the timeline takes the rest of the window, the rail is gone,
 * the composer cannot swallow the live turn, macOS itself reports the
 * transition, and no element is remounted — so the draft, its selection, the
 * console and the connection all survive the layout change.
 *
 * Nothing here starts an engine or asks a model anything.
 */
async function runImmersiveSmoke(window: BrowserWindow): Promise<void> {
  const outDir =
    process.env.MONA_IMMERSIVE_SMOKE_OUT_DIR ??
    join(process.cwd(), "docs", "evidence", "macos", "review-studio", "artifacts");
  mkdirSync(outDir, { recursive: true });
  window.setSize(1280, 800);
  const report: Record<string, unknown> = {
    schema_version: 1,
    label: "R05 FOCUS STUDIO AND NATIVE FULL SCREEN — no engine, no model request",
    captured_at: new Date().toISOString(),
    ok: false,
    checks: {} as Record<string, boolean>,
    facts: {} as Record<string, unknown>,
    native_events: [] as Array<Record<string, unknown>>,
    screenshots: [] as string[],
  };
  const checks = report.checks as Record<string, boolean>;
  const facts = report.facts as Record<string, unknown>;
  const nativeEvents = report.native_events as Array<Record<string, unknown>>;
  const screenshots = report.screenshots as string[];
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = async (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression);
  const waitFor = async (expression: string, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(80);
    }
    return false;
  };
  const poll = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(40);
    }
    return predicate();
  };
  const layoutScript = `(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    };
    const stage = box(".studio");
    const timeline = box(".studio__timeline");
    const composer = box(".composer");
    const textareaBox = box("textarea");
    const bar = box('[data-testid="studio-focus-bar"]');
    const rail = document.querySelector(".rail");
    const topbar = document.querySelector(".shell-topbar");
    const textarea = document.querySelector("textarea");
    const visible = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
    };
    return {
      screen: document.documentElement.dataset.screen,
      fullscreen: document.documentElement.dataset.fullscreen,
      focus: document.documentElement.dataset.focusMode,
      shell_focus: document.querySelector(".shell--focus") !== null,
      rail_display: rail ? getComputedStyle(rail).display : null,
      topbar_display: topbar ? getComputedStyle(topbar).display : null,
      stage, timeline, composer, bar, textarea: textareaBox,
      bar_height: bar ? bar.height : null,
      timeline_share: stage && timeline && stage.height > 0 ? timeline.height / stage.height : null,
      composer_share: stage && composer && stage.height > 0 ? composer.height / stage.height : null,
      textarea_value: textarea ? textarea.value : null,
      selection: textarea ? [textarea.selectionStart, textarea.selectionEnd] : null,
      same_studio: Boolean(window.__r05 && window.__r05.studio === document.querySelector(".studio")),
      same_textarea: Boolean(window.__r05 && window.__r05.textarea === textarea),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      connection:
        document.querySelector('[data-testid="focus-activity"]')?.textContent ??
        document.querySelector('[data-testid="studio-connection"]')?.textContent ??
        null,
      reachable: {
        send: visible('[data-testid="studio-send"]'),
        fullscreen: visible('[data-testid="studio-fullscreen"]') || visible('[data-testid="focus-fullscreen"]'),
        grip: visible('[data-testid="composer-grip"]'),
        exit: visible('[data-testid="focus-exit"]'),
        interrupt: visible('[data-testid="studio-focus-bar"] .button--danger'),
        timeline: visible('[data-testid="studio-timeline"]'),
      },
      scroll_y: (document.scrollingElement ?? document.documentElement).scrollTop,
      views: window.__r05views ?? [],
      active_element: (() => {
        const node = document.activeElement;
        return node ? String(node.tagName) + (node.id ? "#" + node.id : "") + "." + String(node.className) : null;
      })(),
    };
  })()`;
  const layout = (): Promise<Record<string, unknown>> =>
    evaluate(layoutScript) as Promise<Record<string, unknown>>;

  const record = (name: string) => () => {
    nativeEvents.push({
      event: name,
      at: new Date().toISOString(),
      is_fullscreen: window.isFullScreen(),
      bounds: window.getBounds(),
    });
  };
  const onEnter = record("enter-full-screen");
  const onLeave = record("leave-full-screen");
  window.on("enter-full-screen", onEnter);
  window.on("leave-full-screen", onLeave);

  try {
    if (!immersiveSmokeProjectId) throw new Error("the immersive smoke has no project");
    report.project = immersiveSmokeProjectId;
    await waitFor("document.body.dataset.ready === 'true'");
    checks.catalog_rendered = await waitFor(
      "document.querySelectorAll('[data-project-id]').length > 0",
    );
    await evaluate("document.querySelector('[data-project-id]')?.click(); true");
    checks.studio_opened = await waitFor("document.documentElement.dataset.screen === 'studio'");
    await waitFor("document.querySelector('textarea') !== null");
    await sleep(300);

    // Record the two nodes whose identity proves nothing was remounted, and
    // the bridge's own observation stream.
    await evaluate(`(() => {
      window.__r05views = [];
      window.mona.onFullscreenChanged((view) => window.__r05views.push(view));
      window.__r05 = {
        studio: document.querySelector(".studio"),
        textarea: document.querySelector("textarea"),
      };
      return true;
    })()`);

    const boundsBefore = window.getBounds();
    const normal = await layout();
    facts.normal = normal;
    checks.normal_layout_is_windowed =
      normal.fullscreen === "off" && normal.shell_focus === false && normal.rail_display !== "none";
    checks.normal_has_no_dashboard = normal.bar === null;
    const normalShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r05-studio-normal.png"), normalShot.toPNG());
    screenshots.push("r05-studio-normal.png");

    // A draft with a deliberate selection, so "preserved" means bytes and caret.
    await evaluate(`(() => {
      const element = document.querySelector("textarea");
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, "Refactor the retry path and keep the draft intact");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.setSelectionRange(6, 19);
      return element.value;
    })()`);

    // Focus Studio through its real control.
    checks.focus_control_clicked =
      (await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (node) => (node.textContent ?? "").trim() === "Focus Mode",
      );
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`)) === true;
    checks.focus_layout_entered = await waitFor("document.querySelector('.shell--focus') !== null");
    await sleep(300);
    const focus = await layout();
    facts.focus = focus;
    checks.focus_dashboard_present = focus.bar !== null;
    checks.focus_dashboard_is_slim =
      typeof focus.bar_height === "number" && focus.bar_height >= 44 && focus.bar_height <= 56;
    checks.focus_rail_hidden = focus.rail_display === "none";
    checks.focus_topbar_hidden = focus.topbar_display === "none";
    // The console takes the rest of the stage and dominates the composer. It is
    // not asked to be 100% of the window: the prompt box is part of the tool.
    checks.focus_timeline_fills_viewport =
      typeof focus.timeline_share === "number" &&
      focus.timeline_share > 0.5 &&
      focus.stage !== null &&
      focus.timeline !== null &&
      (focus.timeline as { bottom: number }).bottom <=
        (focus.stage as { bottom: number }).bottom + 1 &&
      (focus.timeline as { height: number }).height > (focus.composer as { height: number }).height;
    checks.focus_composer_bounded =
      typeof focus.composer_share === "number" && focus.composer_share <= 0.42;
    checks.focus_keeps_essentials =
      focus.reachable !== null &&
      Object.values(focus.reachable as Record<string, boolean>).every(Boolean);
    checks.focus_no_page_overflow = focus.overflow === false;
    checks.draft_preserved_into_focus =
      focus.textarea_value === "Refactor the retry path and keep the draft intact" &&
      JSON.stringify(focus.selection) === JSON.stringify([6, 19]);
    checks.focus_did_not_remount = focus.same_studio === true && focus.same_textarea === true;
    // Read the stored preference while the layout is on: reading it after the
    // exit could not tell "stored false" from "never stored at all".
    await sleep(450);
    const storedInFocus = (await projectService?.detail(
      immersiveSmokeProjectId as StudioProjectId,
    )) as { view?: Record<string, unknown> | null } | undefined;
    facts.stored_view_in_focus = storedInFocus?.view ?? null;
    checks.stored_view_recorded_focus_on = storedInFocus?.view?.focusMode === true;
    checks.stored_view_carries_no_fullscreen_key =
      storedInFocus?.view != null && !Object.keys(storedInFocus.view).includes("fullscreen");
    checks.focus_reports_no_runtime = String(focus.connection ?? "").includes("Not started");
    const focusShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r05-focus-windowed.png"), focusShot.toPNG());
    screenshots.push("r05-focus-windowed.png");

    // The command list is absolutely positioned above the composer. In this
    // layout the composer must not be a scroll container, or the list is
    // clipped away — the regression an earlier version shipped.
    await evaluate(`(() => {
      const element = document.querySelector("textarea");
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, "/");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    checks.focus_command_menu_opens = await waitFor(
      "document.querySelector('.command-menu') !== null",
    );
    const menu = await evaluate(`(() => {
      const node = document.querySelector(".command-menu");
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      // A point just inside the panel's top-left corner: if an ancestor clips
      // it, that point resolves to the clipping ancestor instead.
      const probe = document.elementFromPoint(
        Math.max(1, Math.min(window.innerWidth - 2, rect.left + 24)),
        Math.max(1, Math.min(window.innerHeight - 2, rect.top + 12)),
      );
      const scrollers = [];
      for (let node2 = node.parentElement; node2; node2 = node2.parentElement) {
        const style = getComputedStyle(node2);
        if (style.overflow !== "visible" || style.overflowY !== "visible") {
          scrollers.push(
            node2.className + " " + style.overflow + "/" + style.overflowY,
          );
        }
      }
      return {
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        inside_viewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
        hit_is_menu: Boolean(probe && node.contains(probe)),
        clipped_by: scrollers,
      };
    })()`);
    facts.focus_command_menu = menu;
    checks.focus_command_menu_readable =
      menu !== null &&
      Number((menu as { height: number }).height) > 80 &&
      (menu as { inside_viewport: boolean }).inside_viewport === true;
    checks.focus_command_menu_not_clipped =
      menu !== null && (menu as { hit_is_menu: boolean }).hit_is_menu === true;
    const menuShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r05-focus-command-menu.png"), menuShot.toPNG());
    screenshots.push("r05-focus-command-menu.png");
    // Escape closes the list and keeps the layout: the draft stays a draft.
    const escapedMenu = await evaluate(`(() => {
      const element = document.querySelector("textarea");
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, value: element.value };
    })()`);
    checks.focus_escape_closes_menu_first =
      (escapedMenu as { prevented: boolean }).prevented === true;
    checks.focus_escape_keeps_focus_layout =
      (await evaluate("document.documentElement.dataset.focusMode === 'on'")) === true;
    checks.focus_command_menu_closed = await waitFor(
      "document.querySelector('.command-menu') === null",
    );
    // Restore the draft the rest of the run measures.
    await evaluate(`(() => {
      const element = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, "Refactor the retry path and keep the draft intact");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.setSelectionRange(6, 19);
      return true;
    })()`);

    // The More popover: it must carry the values the narrow bar elides, and
    // Escape must close it before it can leave the layout.
    checks.focus_drawer_opens =
      (await evaluate(`(() => {
      const summary = document.querySelector('[data-testid="focus-more"]');
      if (!(summary instanceof HTMLElement)) return false;
      summary.click();
      return document.querySelector('.focus-bar__more')?.hasAttribute('open') === true;
    })()`)) === true;
    await sleep(200);
    const drawer = await evaluate(`(() => {
      const text = document.querySelector('.focus-bar__drawer')?.textContent ?? "";
      const box = document.querySelector('.focus-bar__drawer')?.getBoundingClientRect() ?? null;
      return {
        text,
        visible: Boolean(box && box.width > 0 && box.height > 0 && box.bottom <= window.innerHeight + 1),
        inside_viewport: Boolean(box && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1),
      };
    })()`);
    facts.focus_drawer = drawer;
    const drawerText = String((drawer as { text: string }).text);
    checks.focus_drawer_shows_values =
      drawerText.includes("deepseek / deepseek-flash") &&
      drawerText.includes("Spend") &&
      drawerText.includes("Tokens") &&
      // This project has no usage at all, so the honest wording is the absence
      // of a price — never $0.00.
      /(no usage recorded|not recorded|\$)/.test(drawerText) &&
      !drawerText.includes("$0.0000");
    checks.focus_drawer_visible = (drawer as { visible: boolean }).visible === true;
    const drawerShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r05-focus-drawer.png"), drawerShot.toPNG());
    screenshots.push("r05-focus-drawer.png");
    const drawerClosed = await evaluate(`(() => {
      const details = document.querySelector('.focus-bar__more');
      if (!(details instanceof HTMLElement)) return null;
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      details.dispatchEvent(event);
      return {
        prevented: event.defaultPrevented,
        open: details.hasAttribute('open'),
        focus_mode: document.documentElement.dataset.focusMode,
      };
    })()`);
    facts.focus_drawer_escape = drawerClosed;
    checks.focus_drawer_escape_closes_only_drawer =
      (drawerClosed as { prevented: boolean }).prevented === true &&
      (drawerClosed as { open: boolean }).open === false &&
      (drawerClosed as { focus_mode: string }).focus_mode === "on";

    // Composer resize from the keyboard, and the bound it may not pass.
    const beforeGrip = (await layout()) as { composer: { height: number } };
    checks.composer_grip_present =
      (await evaluate(`(() => {
      const grip = document.querySelector('[data-testid="composer-grip"]');
      if (!(grip instanceof HTMLElement)) return false;
      grip.focus();
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      return true;
    })()`)) === true;
    await sleep(150);
    const afterGrip = (await layout()) as {
      composer: { height: number };
      timeline: { height: number };
    };
    facts.composer_resize = {
      before: beforeGrip.composer?.height ?? null,
      after: afterGrip.composer?.height ?? null,
      timeline_after: afterGrip.timeline?.height ?? null,
    };
    checks.composer_grows_on_arrow =
      (afterGrip.composer?.height ?? 0) > (beforeGrip.composer?.height ?? 0) + 8;
    checks.timeline_survives_resize = (afterGrip.timeline?.height ?? 0) >= 120;

    // The extreme the pointer could reach: End asks for the largest allowed
    // composer. The live turn must still be on screen.
    await evaluate(`(() => {
      const grip = document.querySelector('[data-testid="composer-grip"]');
      grip?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(200);
    const atMax = await layout();
    facts.composer_max = atMax;
    checks.composer_max_keeps_timeline =
      typeof atMax.composer_share === "number" &&
      atMax.composer_share <= 0.42 &&
      (atMax.timeline as { height: number }).height >= 120;

    // Native full screen: the window's own transition, not a renderer boolean.
    // macOS defers the transition for an app that is not active, so the runner
    // asks for activation first and records every attempt it makes.
    // macOS ignores a full-screen request from an inactive app, so the runner
    // makes the window active first — and waits for it, because another app
    // (or the shell that launched this run) can take focus back.
    const activation: boolean[] = [];
    for (let attempt = 0; attempt < 12 && !window.isFocused(); attempt += 1) {
      app.focus({ steal: true });
      window.show();
      window.focus();
      await sleep(250);
      activation.push(window.isFocused());
    }
    facts.fullscreen_activation = {
      attempts: activation.length,
      focused: window.isFocused(),
      visible: window.isVisible(),
    };
    facts.fullscreen_preconditions = {
      visible: window.isVisible(),
      focused: window.isFocused(),
    };
    // The flag flips before AppKit reports the transition, so the event — not
    // isFullScreen() — is what this waits for. One request only: a second one
    // while AppKit is animating is a toggle, not a retry.
    const attempts: Array<Record<string, unknown>> = [];
    // The real path: the renderer clicks the control, which invokes
    // window:fullscreen:set, which resolves THIS window from its sender. The
    // smoke never calls setFullScreen itself, so the narrow IPC, its sender
    // scoping and the controller are all in the loop.
    checks.fullscreen_control_clicked =
      (await evaluate(`(() => {
      const button = document.querySelector('[data-testid="focus-fullscreen"]');
      if (!(button instanceof HTMLElement) || button.hasAttribute("disabled")) return false;
      button.click();
      return true;
    })()`)) === true;
    await sleep(250);
    attempts.push({ attempt: 1, at: new Date().toISOString(), focused: window.isFocused() });
    // While the request is in flight the controller publishes pending, and the
    // control says so instead of pretending the transition happened.
    facts.fullscreen_pending_view = await evaluate(`(() => {
      const node = document.querySelector('[data-testid="focus-fullscreen"]');
      return {
        busy: node?.getAttribute("aria-busy") ?? null,
        pressed: node?.getAttribute("aria-pressed") ?? null,
        disabled: node instanceof HTMLButtonElement ? node.disabled : null,
        fullscreen_dataset: document.documentElement.dataset.fullscreen,
      };
    })()`);
    const entered = await poll(
      () => nativeEvents.some((entry) => entry.event === "enter-full-screen"),
      15_000,
    );
    attempts.push({ attempt: 1, settled: true, entered, is_fullscreen: window.isFullScreen() });
    facts.fullscreen_attempts = attempts;
    checks.fullscreen_event_recorded = entered;
    checks.fullscreen_observed_by_macos = window.isFullScreen();
    checks.fullscreen_reported_to_ui = await waitFor(
      "document.documentElement.dataset.fullscreen === 'on'",
      8_000,
    );
    await sleep(500);
    const full = await layout();
    facts.fullscreen = full;
    checks.fullscreen_keeps_focus_layout =
      full.shell_focus === true && full.bar !== null && full.rail_display === "none";
    checks.fullscreen_timeline_still_fills =
      typeof full.timeline_share === "number" && full.timeline_share > 0.5;
    checks.fullscreen_preserved_draft =
      full.textarea_value === "Refactor the retry path and keep the draft intact" &&
      JSON.stringify(full.selection) === JSON.stringify([6, 19]);
    checks.fullscreen_did_not_remount = full.same_studio === true && full.same_textarea === true;
    checks.fullscreen_renderer_saw_observed_view =
      Array.isArray(full.views) &&
      (full.views as Array<{ fullscreen: boolean; pending: boolean; epoch: number }>).some(
        (view) => view.fullscreen === true && view.pending === false && view.epoch >= 1,
      );
    const fullShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r05-native-fullscreen.png"), fullShot.toPNG());
    screenshots.push("r05-native-fullscreen.png");

    // 200% scale inside the immersive layout: no feature may fall out of reach.
    // At 200% the logical viewport is about 640x366. The window's own controls
    // must still be reachable: the dashboard at the top of the scroll, the
    // composer at the bottom, and no horizontal overflow anywhere. Scrolling is
    // allowed here; a control that cannot be brought on screen is not.
    window.webContents.setZoomFactor(2);
    await sleep(700);
    // At this scale the document itself scrolls — the focus column is no longer
    // a fixed-height box — so the runner scrolls the real scroller, not the
    // main element.
    const scrollDocument = async (where: "top" | "bottom"): Promise<number> =>
      (await evaluate(`(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      scroller.scrollTop = ${where === "top" ? "0" : "scroller.scrollHeight"};
      return scroller.scrollTop;
    })()`)) as number;
    await scrollDocument("top");
    await sleep(250);
    const zoomTop = await layout();
    const zoomScrolled = await scrollDocument("bottom");
    await sleep(250);
    const zoomBottom = await layout();
    facts.zoom_200_scroll = {
      top: (zoomTop as { scrollY?: number }).scrollY ?? 0,
      bottom: zoomScrolled,
    };
    facts.zoom_200 = { top: zoomTop, bottom: zoomBottom };
    const topReach = (zoomTop.reachable ?? {}) as Record<string, boolean>;
    const bottomReach = (zoomBottom.reachable ?? {}) as Record<string, boolean>;
    checks.zoom_200_dashboard_reachable =
      topReach.fullscreen === true && topReach.exit === true && topReach.interrupt === true;
    checks.zoom_200_composer_reachable =
      bottomReach.send === true && bottomReach.grip === true && bottomReach.timeline === true;
    checks.zoom_200_no_page_overflow = zoomTop.overflow === false && zoomBottom.overflow === false;
    // Enlarged text may scroll, but the console must still be a console: the
    // earlier failure was a 72 px transcript under a 77% composer.
    checks.zoom_200_timeline_kept_share =
      (zoomTop.timeline as { height: number }).height >= 140 &&
      (zoomTop.timeline as { height: number }).height >
        (zoomTop.composer as { height: number }).height * 0.4;
    const zoomShot = await window.webContents.capturePage();
    writeFileSync(join(outDir, "r05-focus-200.png"), zoomShot.toPNG());
    screenshots.push("r05-focus-200.png");
    await scrollDocument("top");
    window.webContents.setZoomFactor(1);
    await sleep(400);

    // Leave native full screen; the stored layout preference is still on, so the
    // focused layout remains, and the window returns to the bounds it had.
    // Leaving goes through the same control, now showing the observed state.
    checks.fullscreen_exit_control_clicked =
      (await evaluate(`(() => {
      const button = document.querySelector('[data-testid="focus-fullscreen"]');
      if (!(button instanceof HTMLElement)) return false;
      if (button.getAttribute("aria-label") !== "Exit Full Screen") return false;
      button.click();
      return true;
    })()`)) === true;
    checks.fullscreen_exit_event_recorded = await poll(
      () => nativeEvents.some((entry) => entry.event === "leave-full-screen"),
      15_000,
    );
    // Never quit mid-transition: the next launch would inherit a stuck Space.
    await poll(() => !window.isFullScreen(), 8_000);
    await waitFor("document.documentElement.dataset.fullscreen === 'off'", 8_000);
    await sleep(500);
    checks.fullscreen_exit_observed_by_macos = !window.isFullScreen();
    const afterExit = await layout();
    facts.after_exit = afterExit;
    checks.exit_reported_to_ui = afterExit.fullscreen === "off";
    checks.focus_survives_fullscreen_exit =
      afterExit.shell_focus === true && afterExit.bar !== null;
    const boundsAfter = window.getBounds();
    checks.window_bounds_restored =
      boundsAfter.x === boundsBefore.x &&
      boundsAfter.y === boundsBefore.y &&
      boundsAfter.width === boundsBefore.width &&
      boundsAfter.height === boundsBefore.height;
    facts.bounds = { before: boundsBefore, after: boundsAfter };

    // Escape priority: the composer keeps it, the console gives it back.
    checks.escape_in_composer_keeps_focus =
      (await evaluate(`(() => {
      const element = document.querySelector("textarea");
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return document.documentElement.dataset.focusMode === "on";
    })()`)) === true;
    checks.escape_in_timeline_leaves_focus =
      (await evaluate(`(() => {
      const timeline = document.querySelector('[data-testid="studio-timeline"]');
      timeline.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return true;
    })()`)) === true;
    checks.focus_layout_left = await waitFor("document.querySelector('.shell--focus') === null");
    await sleep(400);
    const back = await layout();
    facts.after_escape = back;
    checks.rail_restored = back.rail_display !== "none";
    checks.draft_survives_layout_exit =
      back.textarea_value === "Refactor the retry path and keep the draft intact";

    // The stored preference is a layout, never the OS state.
    await sleep(400);
    const stored = await projectService?.detail(immersiveSmokeProjectId as StudioProjectId);
    const storedView = (stored?.view ?? null) as Record<string, unknown> | null;
    facts.stored_view = storedView;
    checks.stored_view_keeps_focus_preference = storedView?.focusMode === false;
    checks.stored_view_has_no_fullscreen_binding =
      storedView !== null && !Object.keys(storedView).includes("fullscreen");

    // The run never submitted anything: the connection stayed "Not started" for
    // the whole sequence, so no turn and no model request exists to account for.
    facts.engine_state = supervisor?.status().state ?? null;
    checks.no_runtime_or_model =
      String(back.connection ?? "").includes("Not started") &&
      (supervisor?.status().state ?? "stopped") !== "running";
    report.ok = Object.values(checks).every(Boolean);
  } catch (error) {
    const candidate = error as { message?: string; stack?: string };
    report.ok = false;
    report.error = { message: candidate.message ?? String(error), stack: candidate.stack ?? null };
  } finally {
    window.removeListener("enter-full-screen", onEnter);
    window.removeListener("leave-full-screen", onLeave);
    if (window.isFullScreen()) {
      // Leave cleanly and give AppKit its animation: quitting mid-transition
      // leaves the next launch with a Space that refuses to change.
      window.setFullScreen(false);
      await poll(() => !window.isFullScreen(), 8_000);
    }
  }
  const out = process.env.MONA_IMMERSIVE_SMOKE_OUT;
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (report.ok !== true) process.exitCode = 1;
}

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
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "6", modifiers: ["meta"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "6", modifiers: ["meta"] });
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
    polish: polishService ? await polishService.status() : null,
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

  // P20 main-crash phase: publish the live tree and then wait to be killed.
  // The owner-liveness channel in the supervisor is what must clean up, not a
  // graceful path, so nothing here may run a shutdown before the signal.
  const crashPath = process.env.MONA_LIFECYCLE_SMOKE_CRASH_PATH;
  if (crashPath) {
    lifecycleEvidence = { ...lifecycleEvidence, ok: true, phases, pids };
    writeFileSync(
      crashPath,
      JSON.stringify(
        { pids, runtime_state: runtime.status().state, workspace, ownership: smokeStateDirectory },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await new Promise<void>(() => {
      // Never resolves: the smoke script sends SIGKILL to this process.
    });
  }

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
    menu_bar_installed: polishService ? (await polishService.status()).menuBar.installed : false,
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
    smokeStateDirectory = smokeStateDir;
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
        IS_SMOKE ||
        IS_LIFECYCLE_SMOKE ||
        IS_SHELL_SMOKE ||
        IS_STUDIO_SMOKE ||
        IS_OPEN_SMOKE ||
        IS_HISTORY_SMOKE ||
        IS_COMMAND_SMOKE ||
        IS_IMMERSIVE_SMOKE;
      const stateRoot = smokeState
        ? mkdtempSync(join(tmpdir(), "mona-product-state-"))
        : appPaths.state;
      productState = await StateStore.open({
        dbPath: smokeState ? join(stateRoot, "mona.sqlite") : appPaths.database,
        backupDir: smokeState ? join(stateRoot, "backups") : appPaths.backups,
        artifactRoot: smokeState ? join(stateRoot, "artifacts") : appPaths.artifacts,
      });
      zoomController = new ZoomController({
        store: zoomStore(productState),
        window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
        warn: (message) => process.stderr.write(`zoom: ${message}\n`),
      });
      await zoomController.load();
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
          if (result.ok && result.projectId) {
            activeProjectId = result.projectId as StudioProjectId;
          }
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
      if (workController && supervisor && productState) {
        changeLedger = new ChangeLedger({
          store: productState,
          engine: (projectId) => workStudio?.engineAccess(projectId) ?? null,
        });
        workStudio = new WorkStudio({
          store: productState,
          supervisor,
          work: workController,
          ledger: new CostLedger(productState),
          changes: changeLedger,
          notify: (push) => {
            activeProjectId = push.projectId as StudioProjectId;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("studio:changed", push);
            }
            if (push.kind === "submission") {
              polishMenu?.setInterruptEnabled(
                push.state !== "completed" &&
                  push.state !== "failed" &&
                  push.state !== "interrupted" &&
                  push.state !== "canceled" &&
                  push.state !== "sending",
              );
            }
            // Turn start, turn end, control changes, and connection changes all
            // move attention or keep-awake scope. Streamed `event` pushes do
            // not, so a long turn does not re-read the board per token.
            if (push.kind !== "event") {
              void polishService?.refresh(push.projectId as StudioProjectId).catch(() => undefined);
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
        changeLedger ??= new ChangeLedger({
          store: productState,
          engine: (projectId) => workStudio?.engineAccess(projectId) ?? null,
        });
        // P15: native agents, goals, and fleet runs are read from the engine the
        // studio owns. The observatory never starts a runtime or a turn.
        agentObservatory = new AgentObservatory({
          store: productState,
          engine: (projectId) => workStudio?.engineAccess(projectId) ?? null,
        });
        // P16/P17 read this project's live runtime through the studio's
        // adapter. They never start a runtime, and the adapter type is the
        // narrower settings/extension surface rather than a new connection.
        const settingsEngine = (projectId: StudioProjectId) => {
          const access = workStudio?.engineAccess(projectId);
          return access
            ? {
                adapter:
                  access.adapter as unknown as import("./engine/types").EngineSettingsAdapter,
                workspace: access.workspace,
              }
            : null;
        };
        routeWorkbench = new RouteWorkbench({
          store: productState,
          engine: settingsEngine,
          studio: async (projectId) => workStudio?.snapshot(projectId) ?? null,
          backupDir: join(appPaths.backups, "engine-config"),
        });
        extensionWorkbench = new ExtensionWorkbench({
          store: productState,
          engine: settingsEngine,
        });
        // P18: the integrated terminal owns a native pty, not an engine
        // session. Its only inputs are a workspace path (for the shell's cwd)
        // and the owned runtime's log path (for the read-only log view).
        const ownership = store;
        terminalManager = new TerminalManager({
          workspaceFor: async (projectId) => {
            try {
              const detail = await projectService?.detail(projectId);
              return detail?.project.rootPath ?? null;
            } catch {
              return null;
            }
          },
          logPathFor: (workspace) => {
            let canonical = workspace;
            try {
              canonical = realpathSync(workspace);
            } catch {
              // A missing folder is not a log; the read reports it unavailable.
            }
            const record = ownership
              .list()
              .filter((entry) => entry.canonicalWorkspace === canonical)
              .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
            return record ? join(appPaths.logs, `${record.id}.log`) : null;
          },
          emit: (event) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("terminal:event", event);
            }
          },
        });
        capabilityExplorer = new CapabilityExplorer({ store: productState });
        // P19: memory, shelf, and handoff are local projections. None of them
        // can start a turn; the shelf only stores text, and the handoff writes
        // a redacted bundle chosen through a native dialog.
        // Engine identity is read from stored records before the workbenches are
        // constructed, so their sync readers never need to spawn anything.
        await loadEngineIdentity(productState);
        promptShelf = new PromptShelf({ store: productState, homeDir: app.getPath("home") });
        projectMemory = new ProjectMemory({
          store: productState,
          homeDir: app.getPath("home"),
          engineInfo: () => engineIdentity(),
          extraSources: async () => {
            if (!promptShelf) return [];
            const view = await promptShelf.view();
            return view.prompts.map((prompt) => ({
              source: "prompt" as const,
              id: prompt.id,
              title: prompt.label,
              body:
                prompt.versions.find((version) => version.version === prompt.currentVersion)
                  ?.body ?? "",
              updatedAt: prompt.updatedAt,
              pointer: { kind: "prompt" as const, recordId: prompt.id, path: null },
            }));
          },
        });
        projectHandoff = new ProjectHandoff({
          store: productState,
          homeDir: app.getPath("home"),
          engineInfo: () => engineIdentity(),
          productVersion: app.getVersion(),
          promptPack: async () => (promptShelf ? promptShelf.exportPack() : null),
        });
      }

      // P14: deterministic polish. Attention, notifications, and the digest read
      // stored records only; none of these objects can start a turn.
      if (productState && projectService && taskBoard) {
        const board = taskBoard;
        const cost = costLedger;
        const preferences = new PolishPreferencesStore({ store: productState });
        const sources: NotificationSources = {
          tasks: async (projectId) =>
            (await board.snapshot(projectId)).tasks.map((task) => ({
              id: task.id,
              title: task.title,
              completedAt: task.completedAt,
            })),
          problems: async (projectId) =>
            (await board.snapshot(projectId)).problems
              .filter((problem) => problem.status === "blocked")
              .map((problem) => ({
                id: problem.id,
                taskId: problem.taskId,
                title: problem.symptom,
                requirement: problem.requirement,
                helpNeeded: problem.helpNeeded ?? "a human decision is required",
                blockedAt: problem.blockedAt,
              })),
          budgets: async (projectId) => {
            if (!cost) return [];
            try {
              const ledger = await cost.ledger(projectId, {});
              return ledger.evaluations.map((evaluation) => ({
                id: evaluation.budgetId,
                level: evaluation.level,
                message: evaluation.message,
                at: evaluation.windowStart,
              }));
            } catch {
              return [];
            }
          },
        };
        const notificationHost = createElectronNotificationHost({ onFocus: focusPolish });
        const notifier = new PolishNotifier({
          store: productState,
          sources,
          host: notificationHost,
          preferences: () => preferences.get(),
          projectName: async (projectId) =>
            (await productState?.getProject(projectId, { includeRemoved: true }))?.name ??
            "project",
        });
        const attentionHost = createElectronAttentionHost({
          onOpen: () => showMainWindow(),
          onInterrupt: () => void interruptActiveWork(),
          onShowBlockers: () => {
            if (!activeProjectId) return;
            focusPolish({
              projectId: activeProjectId,
              screen: "board",
              taskId: null,
              problemId: null,
              changeSetId: null,
              fromNotification: false,
            });
          },
          onQuit: () => void requestQuit(true),
        });
        keepAwake = new KeepAwake(createElectronKeepAwakeHost());
        polishService = new PolishService({
          store: productState,
          board,
          projects: projectService,
          changes: changeLedger,
          cost: costLedger,
          notifier,
          attention: new AttentionController(attentionHost),
          keepAwake,
          preferences,
          isTurnActive: async (projectId) =>
            (await workStudio?.snapshot(projectId).catch(() => null))?.activeTurnId != null,
        });
        // P23: the installer-mediated update surface. It reads the installed
        // component manifest for its own identity, the store for active work and
        // applied packages, and the packaged `pkgutil` for a candidate. It never
        // queries a URL that no one configured.
        updateCoordinator = new UpdateCoordinator({
          store: productState,
          paths: { cache: appPaths.cache, support: appPaths.support },
          current: () =>
            readBuildInfo({
              resourcesPath: app.isPackaged ? process.resourcesPath : null,
              appVersion: app.getVersion(),
              packaged: app.isPackaged,
              schemaVersion: CURRENT_SCHEMA_VERSION,
            }),
          hostOs: () => osRelease(),
          hostArch: () => process.arch,
          activity: async () => {
            // The store is the primary probe: a submission is persisted before
            // it is sent, a running task carries its active turn, and a runtime
            // binding records a live engine. The supervisor is a second,
            // independent check on the process Mona actually owns.
            const items = [...((await productState?.activeWork()) ?? [])];
            if (supervisor?.status().state === "running") {
              items.push({
                projectId: "engine",
                projectName: "Codewhale runtime",
                kind: "runtime",
                taskId: null,
                taskTitle: null,
                detail: "Mona's owned engine runtime is running",
              });
            }
            return items;
          },
          shouldQuit: () =>
            !IS_SMOKE &&
            !IS_LIFECYCLE_SMOKE &&
            !IS_SHELL_SMOKE &&
            !IS_HISTORY_SMOKE &&
            !IS_COMMAND_SMOKE &&
            !IS_IMMERSIVE_SMOKE,
          // A successful handoff is the one point where quitting is correct:
          // every active item was checked first, so nothing is interrupted.
          afterHandoff: () => {
            // Give the screen a moment to show the receipt, then take the
            // normal shutdown path so the bundle is free for Installer.
            setTimeout(() => void requestQuit(true), 1_200);
          },
        });
        // A delivered handoff only counts once this launch sees the result: the
        // new version proves the migration ran, the old one proves Installer was
        // cancelled. Neither is inferred from a timestamp.
        await updateCoordinator.reconcileOnLaunch().catch(() => undefined);
      }
    } catch (error) {
      productStateError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Mona state unavailable: ${productStateError}\n`);
      if (!IS_SMOKE && !IS_LIFECYCLE_SMOKE) {
        await reportStartupFailure(productStateError);
      }
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
        // P13: a real dirty repository, so the changes lens renders real Git
        // state rather than a fixture. Failure leaves it honestly non-Git.
        try {
          execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: shellRoot });
          execFileSync("/usr/bin/git", ["config", "user.email", "mona@example.test"], {
            cwd: shellRoot,
          });
          execFileSync("/usr/bin/git", ["config", "user.name", "Mona Smoke"], { cwd: shellRoot });
          execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: shellRoot });
          execFileSync("/usr/bin/git", ["commit", "-qm", "base"], { cwd: shellRoot });
          writeFileSync(
            join(shellRoot, "README.md"),
            "# Shell smoke\n\nEdited in the working tree.\n",
          );
          writeFileSync(join(shellRoot, "user-notes.txt"), "pre-existing work\n");
          writeFileSync(join(shellRoot, "src-app.ts"), "export const reviewed = true;\n", "utf8");
        } catch {
          // The lens reports a non-Git folder honestly.
        }
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
        // P15: a stored orchestration observation from a previous engine run, so
        // the observatory renders its disconnected fallback with real rows and
        // real unknowns instead of an empty list. No runtime is started.
        await productState.upsertOrchestrationRun({
          projectId: opened.project.id,
          kind: "fleet_run",
          upstreamId: "fleet_shell_0001",
          parentUpstreamId: null,
          label: "shell smoke workflow",
          status: "completed",
          workspace: null,
          branch: null,
          taskId: null,
          startedAt: "2026-11-12T07:46:06.000Z",
          updatedAt: "2026-11-12T07:46:08.000Z",
          lastSeenAt: "2026-11-12T07:46:08.000Z",
          terminal: true,
          detail: { taskCount: 1, workerCount: 1, workflowKind: "parallel" },
        });
        await productState.upsertOrchestrationRun({
          projectId: opened.project.id,
          kind: "fleet_worker",
          upstreamId: "fleet_shell_0001-local-1",
          parentUpstreamId: "fleet_shell_0001",
          label: "reviewer fleet_shell_0001-local-1",
          status: "online",
          workspace: null,
          branch: null,
          taskId: null,
          startedAt: null,
          updatedAt: "2026-11-12T07:46:08.000Z",
          lastSeenAt: "2026-11-12T07:46:08.000Z",
          terminal: false,
          detail: { taskId: "answer", host: "local", lastError: null },
        });
        await productState.upsertOrchestrationRun({
          projectId: opened.project.id,
          kind: "agent_run",
          upstreamId: "agent_shell_0001",
          parentUpstreamId: null,
          label: "explore · Count the files",
          status: "interrupted",
          workspace: shellRoot,
          branch: "main",
          taskId: null,
          startedAt: "2026-11-12T07:45:30.000Z",
          updatedAt: "2026-11-12T07:45:31.000Z",
          lastSeenAt: "2026-11-12T07:45:31.000Z",
          terminal: true,
          detail: { role: "explore", usageStatus: "unknown", artifactCount: 0 },
        });
        await productState.upsertGoalObservation({
          projectId: opened.project.id,
          threadId: "thr_engine_shell_0001",
          goalId: "goal_shell_0001",
          objective: "Finish the shell smoke goal",
          status: "blocked",
          tokensUsed: 120,
          timeUsedSeconds: 42,
          continuationCount: 2,
          repeatedGapCount: 1,
          engineCreatedAt: "2026-11-12T07:40:00.000Z",
          engineUpdatedAt: "2026-11-12T07:44:00.000Z",
          observedAt: "2026-11-12T07:46:08.000Z",
        });
        // P13: a settled engine receipt plus a stored tool item, so the changes
        // lens renders attribution from state rather than a fixture.
        const changesThread = thread?.id ?? detail.threads[0]?.id ?? "thr_shell000000001";
        await productState.upsertChangeSet({
          projectId: opened.project.id,
          threadId: changesThread,
          engineThreadId: "thr_engine_shell_0001",
          turnId: "turn_shell_p13_0001",
          state: "settled",
          reason: null,
          preSnapshotId: "tree_pre_shell_0001",
          postSnapshotId: "tree_post_shell_0001",
          origin: "engine",
          evidenceRank: 3,
          note: null,
          files: [
            {
              artifactId: "file_shell_app",
              path: "src-app.ts",
              previousPath: null,
              kind: "file",
              change: "updated",
              source: "tool_mutation",
              toolName: "edit_file",
              toolCallId: "call_shell_0001",
              itemId: "item_shell_0001",
              sizeBytes: 42,
              revision: "a".repeat(64),
              restoreSnapshotId: "tree_pre_shell_0001",
            },
            {
              artifactId: "file_shell_notes",
              path: "notes.txt",
              previousPath: null,
              kind: "file",
              change: "created",
              source: "workspace_changed_during_turn",
              toolName: null,
              toolCallId: null,
              itemId: null,
              sizeBytes: 12,
              revision: "b".repeat(64),
              restoreSnapshotId: null,
            },
          ],
        });
        await productState.recordEvent({
          threadId: changesThread,
          seq: 2,
          kind: "item.completed",
          turnId: "turn_shell_p13_0001",
          payload: {
            item: {
              id: "item_shell_0001",
              kind: "tool_call",
              status: "completed",
              summary: "edit_file: src-app.ts",
              tool_name: "edit_file",
              tool_call_id: "call_shell_0001",
            },
          },
          timestamp: new Date().toISOString(),
        });
        // P14: a real catch-up watermark and a completed turn, so Home renders
        // "Since you left" from stored records rather than a fixture.
        await productState.putSettings(`polish:seen:${opened.project.id}`, {
          seenAt: new Date(Date.now() - 3_600_000).toISOString(),
        });
        await productState.putSettings("prompts:favorites", {
          items: [
            {
              id: "fav_0123456789abcdef",
              label: "Review the diff",
              text: "Review the diff and record what changed.",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        });
        await productState.recordEvent({
          threadId: changesThread,
          seq: 3,
          kind: "turn.completed",
          turnId: "turn_shell_p13_0001",
          payload: { turn_id: "turn_shell_p13_0001" },
          timestamp: new Date().toISOString(),
        });
        // P19: real decisions, evidence pointers, and a shelf prompt, so the
        // memory screen searches stored records and shows a real index. The
        // decision body holds a secret-shaped string, which must never reach
        // the screen as itself.
        await productState.addDecision({
          projectId: opened.project.id,
          title: "Resume packet format",
          body:
            "The resume packet is plain text assembled from stored records. " +
            // Deliberately secret-shaped; the redactor must remove it.
            `A rejected sample key was ${"sk-" + "c".repeat(28)}.`,
        });
        await productState.addDecision({
          projectId: opened.project.id,
          title: "Handoff scope",
          body: "The portable bundle carries records and pointers, never artifact bytes.",
        });
        await productState.addRequirementEvidence({
          projectId: opened.project.id,
          requirementId: "MONA-024",
          path: "README.md",
          note: "memory search reads stored records only",
        });
        await promptShelf?.save({
          label: "Resume packet check",
          description: "Ask for a packet before resuming a long task.",
          body: "Summarize {{project}} state for {{audience}} using stored records only.",
          acceptance: ["Names the next exact action", "Spells the current blocker"],
          tags: ["resume"],
        });
      }
    }

    if (IS_HISTORY_SMOKE && projectService && productState) {
      // R02 long-session evidence. The store is a real StateStore on this Mac;
      // the run below opens this project in the real Electron shell and pages
      // through its history. No runtime is started and no model is asked
      // anything.
      const base = mkdtempSync(join(tmpdir(), "mona-history-smoke-project-"));
      const root = join(base, "Long session");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "README.md"), "# Long session\n", "utf8");
      const opened = await projectService.open(root);
      historySmokeProjectId = opened?.project.id ?? null;
      if (opened) {
        const detail = await projectService.detail(opened.project.id);
        const thread = detail.threads[0];
        if (thread) {
          const start = Date.parse("2026-11-01T00:00:00.000Z");
          const total = 10_050;
          let seq = 1;
          await productState.recordEvent({
            threadId: thread.id,
            seq: seq++,
            kind: "thread.started",
            payload: {},
            timestamp: new Date(start).toISOString(),
          });
          // One long turn: 2,100 message frames for item_long, with a
          // heartbeat every 40 frames and a second item interleaved for the
          // first 300. The rest of the project is ordinary status history.
          const turnId = "turn_history_smoke_0001";
          await productState.recordEvent({
            threadId: thread.id,
            seq: seq++,
            kind: "turn.started",
            turnId,
            payload: { permission_posture: "full_access" },
            timestamp: new Date(start + seq * 10).toISOString(),
          });
          for (let index = 0; index < 2_100; index += 1) {
            if (index % 40 === 39) {
              await productState.recordEvent({
                threadId: thread.id,
                seq: seq++,
                kind: "operation.heartbeat",
                turnId,
                payload: { observed_at: new Date(start + seq * 10).toISOString() },
                timestamp: new Date(start + seq * 10).toISOString(),
              });
            }
            await productState.recordEvent({
              threadId: thread.id,
              seq: seq++,
              kind: "item.delta",
              turnId,
              itemId: "item_history_long",
              payload: { kind: "agent_message", delta: `long-${index} ` },
              timestamp: new Date(start + seq * 10).toISOString(),
            });
            if (index < 300) {
              await productState.recordEvent({
                threadId: thread.id,
                seq: seq++,
                kind: "item.delta",
                turnId,
                itemId: "item_history_short",
                payload: { kind: "agent_message", delta: `short-${index} ` },
                timestamp: new Date(start + seq * 10).toISOString(),
              });
            }
          }
          await productState.recordEvent({
            threadId: thread.id,
            seq: seq++,
            kind: "item.completed",
            turnId,
            itemId: "item_history_long",
            payload: {
              item: { id: "item_history_long", kind: "agent_message", status: "completed" },
            },
            timestamp: new Date(start + seq * 10).toISOString(),
          });
          await productState.recordEvent({
            threadId: thread.id,
            seq: seq++,
            kind: "item.completed",
            turnId,
            itemId: "item_history_short",
            payload: {
              item: { id: "item_history_short", kind: "agent_message", status: "completed" },
            },
            timestamp: new Date(start + seq * 10).toISOString(),
          });
          await productState.recordEvent({
            threadId: thread.id,
            seq: seq++,
            kind: "turn.completed",
            turnId,
            payload: {},
            timestamp: new Date(start + seq * 10).toISOString(),
          });
          while (seq <= total) {
            const frame = seq;
            await productState.recordEvent({
              threadId: thread.id,
              seq,
              kind: "status.note",
              payload: { note: `history frame ${frame}` },
              timestamp: new Date(start + seq * 10).toISOString(),
            });
            seq += 1;
          }
          // A second, older thread so the selector has to distinguish the
          // current conversation from archived history.
          const archived = await productState.upsertThread({
            id: "thr_history_archived",
            projectId: opened.project.id,
            title: "Archived work",
          });
          for (let index = 1; index <= 4; index += 1) {
            await productState.recordEvent({
              threadId: archived.id,
              seq: index,
              kind: "status.note",
              payload: { note: `archived frame ${index}` },
              timestamp: new Date(start + index * 10).toISOString(),
            });
          }
        }
      }
    }

    if (IS_COMMAND_SMOKE && projectService && productState) {
      // R03 evidence. A real store and a real folder; the runner below opens
      // this project in the shell and drives command autocomplete. No runtime
      // is started and no model is asked anything.
      const base = mkdtempSync(join(tmpdir(), "mona-command-smoke-project-"));
      const root = join(base, "Command smoke");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "README.md"), "# Command smoke\n", "utf8");
      const opened = await projectService.open(root);
      commandSmokeProjectId = opened?.project.id ?? null;
    }

    if (IS_IMMERSIVE_SMOKE && projectService && productState) {
      // R05 evidence. A real store and a real folder, opened in the real shell;
      // the runner enters Focus Studio and then native full screen. No runtime
      // is started and no model is asked anything.
      const base = mkdtempSync(join(tmpdir(), "mona-immersive-smoke-project-"));
      const root = join(base, "Immersive smoke");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "README.md"), "# Immersive smoke\n", "utf8");
      const opened = await projectService.open(root);
      immersiveSmokeProjectId = opened?.project.id ?? null;
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

    polishMenu = installApplicationMenu({
      onOpenProject: () => void openProjectFromMenu(),
      onInterrupt: () => void interruptActiveWork(),
      onShowBlockers: () => {
        if (!activeProjectId) return;
        focusPolish({
          projectId: activeProjectId,
          screen: "board",
          taskId: null,
          problemId: null,
          changeSetId: null,
          fromNotification: false,
        });
      },
      onToggleFocus: () => {
        const window = showMainWindow();
        window.webContents.send("polish:toggle-focus");
      },
      onZoomIn: () => void zoomController?.step("in"),
      onZoomOut: () => void zoomController?.step("out"),
      onZoomReset: () => void zoomController?.reset(),
      onQuit: () => void requestQuit(true),
    });

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
      zoom: {
        view: () => (zoomController ?? new ZoomController()).view(),
        set: async (factor: number) =>
          zoomController ? zoomController.set(factor) : new ZoomController().view(),
      },
      windowFullscreen: (webContentsId: number) => fullscreenControllers.get(webContentsId) ?? null,
      studio: workStudio,
      board: taskBoard,
      cost: costLedger,
      changes: changeLedger,
      polish: polishService,
      agents: agentObservatory,
      settings: routeWorkbench,
      extensions: extensionWorkbench,
      terminal: terminalManager,
      capabilities: capabilityExplorer,
      commands: commandCatalog,
      memory: projectMemory,
      shelf: promptShelf,
      handoff: projectHandoff,
      // P19 dialogs. Paths come from the picker, never from renderer text, and
      // every write is 0600 outside the workspace the user chose.
      memoryFiles: {
        chooseBundle: async (kind, prefillPath) => {
          const chosen = mainWindow
            ? await dialog.showOpenDialog(mainWindow, {
                title:
                  kind === "handoff" ? "Choose a Mona handoff bundle" : "Choose a settings backup",
                defaultPath: prefillPath ?? app.getPath("documents"),
                properties: ["openFile"],
                filters: [{ name: "Mona bundle", extensions: ["zip", "mona", "json"] }],
              })
            : { canceled: true, filePaths: [] };
          return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
        },
        exportHandoff: async (projectId) => {
          if (!projectHandoff) {
            throw Object.assign(new Error("portable handoff is unavailable"), {
              code: "RUNTIME_UNAVAILABLE",
            });
          }
          const preview = await projectHandoff.preview(projectId);
          const slug =
            preview.projectName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "project";
          const chosen = mainWindow
            ? await dialog.showSaveDialog(mainWindow, {
                title: "Export project handoff",
                defaultPath: join(app.getPath("documents"), `${slug}-handoff.zip`),
                filters: [{ name: "Mona handoff", extensions: ["zip"] }],
              })
            : { canceled: true, filePath: undefined };
          if (chosen.canceled || !chosen.filePath) {
            return { saved: false, path: null, digest: "", entries: 0, bytes: 0, redactions: 0 };
          }
          return projectHandoff.exportToFile(projectId, chosen.filePath);
        },
        exportSettingsBackup: async () => {
          if (!projectHandoff) {
            throw Object.assign(new Error("settings backup is unavailable"), {
              code: "RUNTIME_UNAVAILABLE",
            });
          }
          const view = await projectHandoff.settingsBackup();
          const chosen = mainWindow
            ? await dialog.showSaveDialog(mainWindow, {
                title: "Export settings backup",
                defaultPath: join(
                  app.getPath("documents"),
                  `mona-settings-${view.generatedAt.replace(/[:.]/g, "-")}.zip`,
                ),
                filters: [{ name: "Mona settings backup", extensions: ["zip"] }],
              })
            : { canceled: true, filePath: undefined };
          if (chosen.canceled || !chosen.filePath) {
            return { saved: false, path: null, digest: view.digest, scopes: 0, bytes: 0 };
          }
          return projectHandoff.exportSettingsToFile(chosen.filePath);
        },
        exportPromptPack: async (pack, suggestedName) => {
          const chosen = mainWindow
            ? await dialog.showSaveDialog(mainWindow, {
                title: "Export prompt pack",
                defaultPath: join(
                  app.getPath("documents"),
                  suggestedName.replace(/\.zip$/, ".json"),
                ),
                filters: [{ name: "Mona prompt pack", extensions: ["json"] }],
              })
            : { canceled: true, filePath: undefined };
          if (chosen.canceled || !chosen.filePath) return { saved: false, path: null };
          writeFileSync(chosen.filePath, `${JSON.stringify(pack, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          return { saved: true, path: chosen.filePath };
        },
        importPromptPack: async () => {
          const chosen = mainWindow
            ? await dialog.showOpenDialog(mainWindow, {
                title: "Import prompt pack",
                properties: ["openFile"],
                filters: [{ name: "Mona prompt pack", extensions: ["json"] }],
              })
            : { canceled: true, filePaths: [] };
          const path = chosen.canceled ? null : (chosen.filePaths[0] ?? null);
          if (!path) return { value: null, path: null };
          const text = readFileSync(path, "utf8");
          if (text.length > 4 * 1024 * 1024) {
            throw Object.assign(new Error("prompt pack is larger than 4 MiB"), {
              code: "IMPORT_INVALID",
            });
          }
          return { value: JSON.parse(text) as unknown, path };
        },
        exportDiagnostics: async (preview) => {
          const chosen = mainWindow
            ? await dialog.showSaveDialog(mainWindow, {
                title: "Export redacted diagnostics bundle",
                defaultPath: join(
                  app.getPath("documents"),
                  `mona-diagnostics-${preview.generatedAt.replace(/[:.]/g, "-")}.json`,
                ),
                filters: [{ name: "JSON", extensions: ["json"] }],
              })
            : { canceled: true, filePath: undefined };
          if (chosen.canceled || !chosen.filePath) {
            return {
              saved: false,
              path: null,
              digest: preview.digest,
              bytes: preview.bytes,
              redactions: preview.redactions,
            };
          }
          writeFileSync(chosen.filePath, preview.text, { encoding: "utf8", mode: 0o600 });
          return {
            saved: true,
            path: chosen.filePath,
            digest: preview.digest,
            bytes: preview.bytes,
            redactions: preview.redactions,
          };
        },
      },
      exportDiagnostics: async (report) => {
        const chosen = mainWindow
          ? await dialog.showSaveDialog(mainWindow, {
              title: "Export redacted diagnostics",
              defaultPath: join(app.getPath("documents"), `mona-diagnostics-${Date.now()}.json`),
              filters: [{ name: "JSON", extensions: ["json"] }],
            })
          : { canceled: true, filePath: undefined };
        if (chosen.canceled || !chosen.filePath) return { saved: false, path: null };
        writeFileSync(
          chosen.filePath,
          JSON.stringify(
            {
              schema_version: 1,
              product: "Mona",
              generated_at: report.generatedAt,
              ok: report.ok,
              summary: report.summary,
              warnings: report.warnings,
              redactions: report.redactions,
              report: report.redacted,
            },
            null,
            2,
          ),
          { encoding: "utf8", mode: 0o600 },
        );
        return { saved: true, path: chosen.filePath };
      },
      quit: requestQuit,
      revealWorkspacePath: async (projectId, path) => {
        const ledger = changeLedger;
        if (!ledger) {
          throw Object.assign(new Error("the changes surface is unavailable"), {
            code: "RUNTIME_UNAVAILABLE",
          });
        }
        const absolute = await ledger.absoluteWorkspacePath(projectId, path);
        shell.showItemInFolder(absolute);
        return { revealed: true };
      },
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
      update: updateCoordinator,
      recovery: () => inspectRecovery(recoveryPaths()),
      restoreRecoverySnapshot: async (input) => {
        const paths = recoveryPaths();
        // Verify first, in every path: the snapshot must be listed, must be the
        // one the user was shown, and must be one this build can open.
        const snapshot = selectSnapshotForRestore(paths, input);
        if (productState) {
          // A live store holds the only correct handle. `restoreFrom` takes the
          // maintenance barrier, closes before the swap, re-opens afterwards,
          // and rolls back on failure — swapping the file under it would leave
          // the store writing into the renamed inode and silently discard work.
          const outcome = await productState.restoreFrom(snapshot.path);
          return {
            restored: true,
            fromVersion: snapshot.schemaVersion,
            toVersion: CURRENT_SCHEMA_VERSION,
            snapshotPath: snapshot.path,
            replacedPath: outcome.preRestore,
            integrity: "ok" as const,
            note: "The previous database was moved aside, not deleted, and this build reopened the restored state under its maintenance barrier.",
          };
        }
        return restoreSnapshotWithoutStore(paths, input);
      },
      choosePackage: async () => {
        const chosen = mainWindow
          ? await dialog.showOpenDialog(mainWindow, {
              title: "Choose a Mona package to verify",
              defaultPath: app.getPath("downloads"),
              properties: ["openFile"],
              filters: [{ name: "Mona installer", extensions: ["pkg"] }],
            })
          : { canceled: true, filePaths: [] };
        return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
      },
      updateFacts: () => ({
        home: app.getPath("home"),
        cache: resolveAppPaths().cache,
        support: resolveAppPaths().support,
        launchQuit: false,
      }),
    });
    if (IS_PACKAGE_SMOKE) {
      if (!PACKAGE_SMOKE_OUT) {
        process.stderr.write("--package-smoke requires --package-smoke-out=<file>\n");
        app.exit(2);
        return;
      }
      try {
        const report = runPackageSmoke({
          reportPath: PACKAGE_SMOKE_OUT,
          stateDirectory: resolveAppPaths().state,
        });
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        app.exit(report.ok ? 0 : 1);
      } catch (error) {
        process.stderr.write(`package smoke failed: ${String(error)}\n`);
        app.exit(1);
      }
      return;
    }
    if (IS_LIFECYCLE_SMOKE) {
      // The smoke builds its own temporary supervisor; recover nothing from the
      // real user store so the evidence run cannot disturb product state.
      openWindow();
      const readyOut = process.env.MONA_LIFECYCLE_SMOKE_READY;
      if (readyOut) writeFileSync(readyOut, new Date().toISOString() + "\n", "utf8");
      return;
    }
    // A packaged copy outside /Applications is not silently treated as a second
    // install. If the installed copy exists, the user chooses which one runs.
    const installLocation = inspectInstallLocation({
      bundlePath: resolve(app.getAppPath(), "../../.."),
      packaged: app.isPackaged,
    });
    if (
      installLocation.duplicate &&
      !IS_SMOKE &&
      !IS_SHELL_SMOKE &&
      !IS_STUDIO_SMOKE &&
      !IS_HISTORY_SMOKE &&
      !IS_COMMAND_SMOKE &&
      !IS_IMMERSIVE_SMOKE
    ) {
      const choice = await dialog.showMessageBox({
        type: "warning",
        title: "Mona is installed in two places",
        message: "This Mona copy is not the installed application.",
        detail:
          `Running: ${installLocation.bundlePath}\n` +
          `Installed: ${installLocation.standardPath}\n\n` +
          "Open the installed copy to keep projects, settings, and updates in one place.",
        buttons: ["Continue with this copy", "Quit"],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response === 1) {
        app.quit();
        return;
      }
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
    keepAwake?.release();
    // A shell never outlives Mona: close every owned pty before the store does.
    void terminalManager?.disposeAll();
    void workStudio?.close();
    void productState?.close();
  });

  app.on("window-all-closed", () => {
    if (shouldQuitOnWindowAllClosed(process.platform)) app.quit();
  });
}
