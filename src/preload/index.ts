import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo, AppPathInfo, MonaBridge, ToolDiscovery } from "../shared/contracts/bridge";
import type { ProjectId } from "../shared/contracts/ids";
import type {
  IpcResult,
  OpenProjectResult,
  ProjectDetail,
  ProjectSummary,
  RuntimeStatusView,
  StateFacts,
} from "../shared/contracts/project-bridge";

/**
 * The only bridge the renderer gets. No raw ipcRenderer, no Node, no shell.
 * Each method maps to one validated main-process handler. Catalog operations
 * return a typed result envelope so expected failures do not arrive as
 * stringified exceptions.
 */
const bridge: MonaBridge = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info", {}),
  getPaths: (): Promise<AppPathInfo> => ipcRenderer.invoke("app:paths", {}),
  discoverTools: (names?: string[]): Promise<ToolDiscovery[]> =>
    ipcRenderer.invoke("tools:discover", names === undefined ? {} : { names }),

  listProjects: (query?: string, includeArchived?: boolean): Promise<IpcResult<ProjectSummary[]>> =>
    ipcRenderer.invoke("projects:list", {
      ...(query ? { query } : {}),
      ...(includeArchived ? { includeArchived: true } : {}),
    }),
  openProject: (rootPath?: string): Promise<IpcResult<OpenProjectResult | null>> =>
    ipcRenderer.invoke("projects:open", rootPath ? { rootPath } : {}),
  projectDetail: (id: ProjectId): Promise<IpcResult<ProjectDetail>> =>
    ipcRenderer.invoke("projects:detail", { projectId: id }),
  renameProject: (id: ProjectId, name: string, expectedRevision: number) =>
    ipcRenderer.invoke("projects:rename", { projectId: id, name, expectedRevision }),
  setProjectPinned: (id: ProjectId, pinned: boolean, expectedRevision: number) =>
    ipcRenderer.invoke("projects:pin", { projectId: id, pinned, expectedRevision }),
  setProjectArchived: (id: ProjectId, archived: boolean, expectedRevision: number) =>
    ipcRenderer.invoke("projects:archive", { projectId: id, archived, expectedRevision }),
  removeProject: (id: ProjectId, expectedRevision: number) =>
    ipcRenderer.invoke("projects:remove", { projectId: id, expectedRevision }),
  relocateProject: (id: ProjectId, expectedRevision: number) =>
    ipcRenderer.invoke("projects:relocate", { projectId: id, expectedRevision }),
  revealProject: (id: ProjectId) => ipcRenderer.invoke("projects:reveal", { projectId: id }),
  saveProjectView: (id: ProjectId, view: Record<string, unknown>) =>
    ipcRenderer.invoke("projects:view", { projectId: id, view }),
  saveDraft: (projectId: ProjectId, threadId: string, text: string) =>
    ipcRenderer.invoke("projects:draft", { projectId, threadId, text }),

  runtimeStatus: (): Promise<RuntimeStatusView> => ipcRenderer.invoke("runtime:status", {}),
  stateFacts: (): Promise<StateFacts> => ipcRenderer.invoke("state:facts", {}),
  onProjectsChanged: (callback: (projectId?: string) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      const projectId =
        payload && typeof payload === "object" && "projectId" in payload
          ? (payload as { projectId?: unknown }).projectId
          : undefined;
      callback(typeof projectId === "string" ? projectId : undefined);
    };
    ipcRenderer.on("projects:changed", listener);
    return () => ipcRenderer.removeListener("projects:changed", listener);
  },
};

contextBridge.exposeInMainWorld("mona", bridge);
