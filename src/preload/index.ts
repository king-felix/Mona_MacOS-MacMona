import { contextBridge, ipcRenderer, webUtils } from "electron";
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
import type {
  OpenFolderView,
  OpenResult,
  OpenStatusView,
  ServiceStatus,
} from "../shared/contracts/open";
import type {
  StudioActionResult,
  StudioMode,
  StudioPush,
  StudioReconcileResult,
  StudioSnapshot,
  StudioSubmitResult,
} from "../shared/contracts/studio";
import type {
  BoardSnapshot,
  ContextPreview,
  HandoffView,
  ImportPlanResult,
  ProblemView,
  QueueRunResult,
  ReconcileResult,
  TaskOwner,
  TaskPlan,
  TaskSelection,
  TaskView,
} from "../shared/contracts/board";

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

  // A dropped File never crosses as an object: the preload resolves its path
  // with Electron's supported API and the main process validates that path.
  pathForDroppedFile: (file: File): string | null => {
    try {
      const path = webUtils.getPathForFile(file);
      return typeof path === "string" && path.length > 0 ? path : null;
    } catch {
      return null;
    }
  },
  openDroppedFolder: (path: string): Promise<IpcResult<OpenFolderView>> =>
    ipcRenderer.invoke("open:folder", { path, source: "drop" }),
  openStatus: (): Promise<OpenStatusView> => ipcRenderer.invoke("open:status", {}),
  serviceStatus: (): Promise<ServiceStatus> => ipcRenderer.invoke("service:status", {}),
  refreshService: (): Promise<ServiceStatus> => ipcRenderer.invoke("service:refresh", {}),
  openServiceSettings: (): Promise<IpcResult<{ opened: boolean }>> =>
    ipcRenderer.invoke("service:open-settings", {}),
  onOpenResult: (callback: (result: OpenResult) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const result = payload as Partial<OpenResult>;
      if (typeof result.ok !== "boolean" || typeof result.source !== "string") return;
      callback(result as OpenResult);
    };
    ipcRenderer.on("open:result", listener);
    return () => ipcRenderer.removeListener("open:result", listener);
  },

  studioState: (projectId: ProjectId): Promise<IpcResult<StudioSnapshot>> =>
    ipcRenderer.invoke("studio:state", { projectId }),
  startStudio: (projectId: ProjectId): Promise<IpcResult<StudioSnapshot>> =>
    ipcRenderer.invoke("studio:start", { projectId }),
  submitTask: (
    projectId: ProjectId,
    prompt: string,
    mode: StudioMode,
  ): Promise<IpcResult<StudioSubmitResult>> =>
    ipcRenderer.invoke("studio:submit", { projectId, prompt, mode }),
  interruptNow: (projectId: ProjectId): Promise<IpcResult<StudioActionResult>> =>
    ipcRenderer.invoke("studio:interrupt", { projectId }),
  pauseAfterTask: (projectId: ProjectId): Promise<IpcResult<StudioActionResult>> =>
    ipcRenderer.invoke("studio:pause", { projectId }),
  resumeQueue: (projectId: ProjectId): Promise<IpcResult<StudioActionResult>> =>
    ipcRenderer.invoke("studio:resume-queue", { projectId }),
  cancelQueued: (projectId: ProjectId): Promise<IpcResult<StudioActionResult>> =>
    ipcRenderer.invoke("studio:cancel-queued", { projectId }),
  reconcileSubmission: (projectId: ProjectId): Promise<IpcResult<StudioReconcileResult>> =>
    ipcRenderer.invoke("studio:reconcile", { projectId }),
  stopStudio: (projectId: ProjectId): Promise<IpcResult<StudioActionResult>> =>
    ipcRenderer.invoke("studio:stop", { projectId }),
  boardSnapshot: (projectId: ProjectId): Promise<IpcResult<BoardSnapshot>> =>
    ipcRenderer.invoke("board:snapshot", { projectId }),
  createBoardTask: (input): Promise<IpcResult<TaskView>> =>
    ipcRenderer.invoke("board:create", input),
  updateBoardTask: (taskId, expectedRevision, input): Promise<IpcResult<TaskView>> =>
    ipcRenderer.invoke("board:update", { taskId, expectedRevision, ...input }),
  importTaskPlan: (projectId, plan): Promise<IpcResult<ImportPlanResult>> =>
    ipcRenderer.invoke("board:import", { projectId, plan }),
  importTaskPlanFile: (projectId: ProjectId): Promise<IpcResult<ImportPlanResult | null>> =>
    ipcRenderer.invoke("board:import-file", { projectId }),
  exportTaskPlan: (projectId: ProjectId): Promise<IpcResult<TaskPlan>> =>
    ipcRenderer.invoke("board:export", { projectId }),
  exportTaskPlanFile: (
    projectId: ProjectId,
  ): Promise<IpcResult<{ saved: boolean; path: string | null }>> =>
    ipcRenderer.invoke("board:export-file", { projectId }),
  previewTaskContext: (taskId): Promise<IpcResult<ContextPreview>> =>
    ipcRenderer.invoke("board:preview", { taskId }),
  selectNextTask: (projectId, owner?: TaskOwner): Promise<IpcResult<TaskSelection>> =>
    ipcRenderer.invoke("board:select", owner ? { projectId, owner } : { projectId }),
  addTaskEvidence: (input): Promise<IpcResult<TaskView>> =>
    ipcRenderer.invoke("board:evidence", input),
  satisfyTaskCriterion: (input): Promise<IpcResult<TaskView>> =>
    ipcRenderer.invoke("board:satisfy", input),
  verifyBoardTask: (taskId, expectedRevision): Promise<IpcResult<TaskView>> =>
    ipcRenderer.invoke("board:verify", { taskId, expectedRevision }),
  completeBoardTask: (taskId, expectedRevision): Promise<IpcResult<TaskView>> =>
    ipcRenderer.invoke("board:complete", { taskId, expectedRevision }),
  startBoardTask: (taskId, expectedRevision?: number) =>
    ipcRenderer.invoke(
      "board:start",
      expectedRevision === undefined ? { taskId } : { taskId, expectedRevision },
    ),
  resumeBoardTask: (taskId) => ipcRenderer.invoke("board:resume", { taskId }),
  reconcileBoard: (projectId: ProjectId, resume?: boolean): Promise<IpcResult<ReconcileResult>> =>
    ipcRenderer.invoke("board:reconcile", resume ? { projectId, resume: true } : { projectId }),
  boardHandoff: (projectId: ProjectId): Promise<IpcResult<HandoffView>> =>
    ipcRenderer.invoke("board:handoff", { projectId }),
  dispatchNextTask: (projectId: ProjectId): Promise<IpcResult<QueueRunResult>> =>
    ipcRenderer.invoke("board:dispatch-next", { projectId }),
  recordProblemAttempt: (
    input,
  ): Promise<IpcResult<{ problem: ProblemView; blocked: boolean; task: TaskView | null }>> =>
    ipcRenderer.invoke("board:attempt", input),
  acknowledgeProblem: (problemId: string, note?: string | null) =>
    ipcRenderer.invoke(
      "board:problem-acknowledge",
      note === undefined ? { problemId } : { problemId, note },
    ),
  resolveProblem: (problemId: string, resolution: string, evidence?: string[]) =>
    ipcRenderer.invoke(
      "board:problem-resolve",
      evidence === undefined ? { problemId, resolution } : { problemId, resolution, evidence },
    ),
  reopenProblem: (problemId: string, reason: string, evidence: string[]) =>
    ipcRenderer.invoke("board:problem-reopen", { problemId, reason, evidence }),

  onStudioChanged: (callback: (push: StudioPush) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const push = payload as Partial<StudioPush>;
      if (typeof push.projectId !== "string" || typeof push.state !== "string") return;
      callback(push as StudioPush);
    };
    ipcRenderer.on("studio:changed", listener);
    return () => ipcRenderer.removeListener("studio:changed", listener);
  },
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
