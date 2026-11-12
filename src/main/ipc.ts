import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { discoverTools } from "./tool-discovery";
import { resolveAppPaths } from "./paths";
import { validateIpc, type IpcChannel } from "./ipc-contract";
import { isAllowedNavigation } from "./navigation";

/**
 * Trusted-sender check. IPC answers only the local renderer document this
 * process loaded; a navigated or remote frame cannot invoke the bridge.
 */
export function senderIsTrusted(event: IpcMainInvokeEvent, rendererRoot: string): boolean {
  let url = "";
  try {
    url = event.senderFrame?.url ?? event.sender.getURL();
  } catch {
    return false;
  }
  return isAllowedNavigation(url, rendererRoot);
}

export function registerIpc(rendererRoot: string): void {
  const handle = (channel: IpcChannel, handler: (input: unknown) => unknown) => {
    ipcMain.handle(channel, async (event, raw) => {
      if (!senderIsTrusted(event, rendererRoot)) {
        throw new Error("untrusted IPC sender");
      }
      return handler(validateIpc(channel, raw));
    });
  };

  handle("app:info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  }));

  handle("app:paths", () => {
    const paths = resolveAppPaths();
    return {
      support: paths.support,
      cache: paths.cache,
      logs: paths.logs,
      database: paths.database,
    };
  });

  handle("tools:discover", (input) => {
    const names = (input as { names?: string[] }).names ?? ["codewhale", "git", "node"];
    return discoverTools(names);
  });
}
