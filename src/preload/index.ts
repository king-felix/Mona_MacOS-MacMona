import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo, AppPathInfo, MonaBridge, ToolDiscovery } from "../shared/contracts/bridge";

/**
 * The only bridge the renderer gets. No raw ipcRenderer, no Node, no shell.
 * Each method maps to one validated main-process handler.
 */
const bridge: MonaBridge = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info", {}),
  getPaths: (): Promise<AppPathInfo> => ipcRenderer.invoke("app:paths", {}),
  discoverTools: (names?: string[]): Promise<ToolDiscovery[]> =>
    ipcRenderer.invoke("tools:discover", names === undefined ? {} : { names }),
};

contextBridge.exposeInMainWorld("mona", bridge);
