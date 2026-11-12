import { BrowserWindow } from "electron";
import { join } from "node:path";
import { denyWindowOpen, isAllowedNavigation } from "./navigation";

export interface WindowOptions {
  rendererRoot: string;
  preloadPath: string;
  /** P06 visual harness only; the product shell is the default. */
  harness?: boolean;
}

export function createMainWindow({
  rendererRoot,
  preloadPath,
  harness,
}: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: "#f7f8fc",
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: process.env.MONA_DEVTOOLS === "1",
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => denyWindowOpen());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, rendererRoot)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedNavigation(url, rendererRoot)) event.preventDefault();
  });

  void window.loadFile(
    join(rendererRoot, "index.html"),
    harness ? { search: "?harness=1" } : undefined,
  );
  return window;
}
