import { app, BrowserWindow, Menu, session } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMainWindow } from "./window";
import { hardenSession } from "./security";
import { installApplicationMenu } from "./menu";
import { registerIpc } from "./ipc";
import { discoverTools } from "./tool-discovery";
import { resolveAppPaths } from "./paths";
import { denyWindowOpen, isAllowedNavigation, shouldQuitOnWindowAllClosed } from "./navigation";

app.setName("Mona");

const RENDERER_ROOT = join(__dirname, "../../renderer");
const PRELOAD_PATH = join(__dirname, "../preload/index.js");
const IS_SMOKE = process.argv.includes("--smoke");

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

function openWindow(): ReturnType<typeof createMainWindow> {
  const window = createMainWindow({ rendererRoot: RENDERER_ROOT, preloadPath: PRELOAD_PATH });
  if (IS_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      void captureSmoke(window).catch((error: unknown) => {
        writeSmoke({ ok: false, error: String(error) });
        app.exit(1);
      });
    });
  }
  return window;
}

async function captureSmoke(window: ReturnType<typeof createMainWindow>): Promise<void> {
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  hardenAllWebContents();

  void app.whenReady().then(() => {
    hardenSession(session.defaultSession);
    installApplicationMenu();
    registerIpc(RENDERER_ROOT);
    openWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (shouldQuitOnWindowAllClosed(process.platform)) app.quit();
  });
}
