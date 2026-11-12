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
  CredentialClearReceipt,
  CredentialReceipt,
  ModelCatalogView,
  RouteChangeReceipt,
  SettingsDiagnosticsView,
  SettingsSnapshot,
} from "../shared/contracts/settings";
import type {
  ExtensionActionId,
  ExtensionActionReceipt,
  ExtensionsSnapshot,
  McpAddInput,
  McpToolView,
} from "../shared/contracts/extensions";
import type {
  FleetEvidenceView,
  FleetLaunchResult,
  FleetRunView,
  NativeRole,
  ObservatoryView,
  OrchestrationActionReceipt,
  OrchestrationEvent,
} from "../shared/contracts/agents";
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
  BudgetView,
  CostExport,
  CostLedgerView,
  CostRateCardView,
} from "../shared/contracts/cost";
import type {
  ArtifactWindowView,
  ChangesSnapshot,
  FileWindowView,
  FileWriteResultView,
  GitActionResult,
  RestorePreviewView,
  RestoreResultView,
} from "../shared/contracts/changes";
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
import type {
  NotificationReceiptView,
  PolishDigestView,
  PolishFocusTarget,
  PolishPreferences,
  PolishPreferencesPatch,
  PolishStatusView,
  ProjectIdentityInput,
  PromptFavorite,
} from "../shared/contracts/polish";

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

  costLedger: (projectId, options): Promise<IpcResult<CostLedgerView>> =>
    ipcRenderer.invoke("cost:ledger", {
      projectId,
      ...(options?.since ? { since: options.since } : {}),
      ...(options?.until ? { until: options.until } : {}),
      ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
    }),
  exportCostLedger: (projectId, format, options): Promise<IpcResult<CostExport>> =>
    ipcRenderer.invoke("cost:ledger", {
      projectId,
      format,
      ...(options?.since ? { since: options.since } : {}),
      ...(options?.until ? { until: options.until } : {}),
      ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
    }),
  exportCostLedgerFile: (projectId, format) =>
    ipcRenderer.invoke("cost:export-file", { projectId, format }),
  setCostBudget: (input): Promise<IpcResult<BudgetView>> =>
    ipcRenderer.invoke("cost:budget-set", input),
  clearCostBudget: (input): Promise<IpcResult<{ cleared: boolean }>> =>
    ipcRenderer.invoke("cost:budget-clear", input),
  setRateCard: (input): Promise<IpcResult<CostRateCardView>> =>
    ipcRenderer.invoke("cost:rate-set", input),
  previewCostRecalculation: (input) => ipcRenderer.invoke("cost:recalc-preview", input),

  changesSnapshot: (projectId: ProjectId, limit?: number): Promise<IpcResult<ChangesSnapshot>> =>
    ipcRenderer.invoke(
      "changes:snapshot",
      limit === undefined ? { projectId } : { projectId, limit },
    ),
  refreshChanges: (projectId: ProjectId): Promise<IpcResult<ChangesSnapshot>> =>
    ipcRenderer.invoke("changes:refresh", { projectId }),
  readChangeFile: (input): Promise<IpcResult<FileWindowView>> =>
    ipcRenderer.invoke("changes:file", input),
  readChangeArtifact: (input): Promise<IpcResult<ArtifactWindowView>> =>
    ipcRenderer.invoke("changes:artifact", input),
  previewRestore: (
    projectId: ProjectId,
    changeSetId: string,
    paths: string[],
  ): Promise<IpcResult<RestorePreviewView>> =>
    ipcRenderer.invoke("changes:restore-preview", { projectId, changeSetId, paths }),
  restoreChanges: (input): Promise<IpcResult<RestoreResultView>> =>
    ipcRenderer.invoke("changes:restore", input),
  stageGitPaths: (projectId: ProjectId, paths: string[]): Promise<IpcResult<GitActionResult>> =>
    ipcRenderer.invoke("changes:git-stage", { projectId, paths }),
  commitGitPaths: (input): Promise<IpcResult<GitActionResult>> =>
    ipcRenderer.invoke("changes:git-commit", input),
  writeWorkspaceFile: (input): Promise<IpcResult<FileWriteResultView>> =>
    ipcRenderer.invoke("changes:write-file", input),
  revealWorkspacePath: (
    projectId: ProjectId,
    path: string,
  ): Promise<IpcResult<{ revealed: boolean }>> =>
    ipcRenderer.invoke("changes:reveal", { projectId, path }),

  polishDigest: (projectId: ProjectId): Promise<IpcResult<PolishDigestView>> =>
    ipcRenderer.invoke("polish:digest", { projectId }),
  markPolishSeen: (projectId: ProjectId): Promise<IpcResult<{ seenAt: string }>> =>
    ipcRenderer.invoke("polish:mark-seen", { projectId }),
  polishStatus: (): Promise<IpcResult<PolishStatusView>> => ipcRenderer.invoke("polish:status", {}),
  refreshPolish: (projectId: ProjectId): Promise<IpcResult<PolishStatusView>> =>
    ipcRenderer.invoke("polish:refresh", { projectId }),
  setPolishPreferences: (patch: PolishPreferencesPatch): Promise<IpcResult<PolishPreferences>> =>
    ipcRenderer.invoke("polish:preferences-set", { patch }),
  setProjectIdentity: (input: {
    projectId: ProjectId;
    accent: ProjectIdentityInput["accent"];
    monogram: string | null;
    expectedRevision: number;
  }): Promise<IpcResult<ProjectSummary>> => ipcRenderer.invoke("polish:identity", input),
  promptFavorites: (): Promise<IpcResult<PromptFavorite[]>> =>
    ipcRenderer.invoke("polish:favorites", {}),
  savePromptFavorite: (input: {
    label: string;
    text: string;
  }): Promise<IpcResult<PromptFavorite>> => ipcRenderer.invoke("polish:favorite-save", input),
  removePromptFavorite: (id: string): Promise<IpcResult<{ removed: boolean }>> =>
    ipcRenderer.invoke("polish:favorite-remove", { id }),
  testNotification: (): Promise<IpcResult<NotificationReceiptView>> =>
    ipcRenderer.invoke("polish:notification-test", {}),
  quitMona: (interrupt: boolean): Promise<IpcResult<{ requested: boolean; note: string }>> =>
    ipcRenderer.invoke("polish:quit", { interrupt }),
  onPolishFocus: (callback: (target: PolishFocusTarget) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const target = payload as Partial<PolishFocusTarget>;
      if (typeof target.projectId !== "string" || typeof target.screen !== "string") return;
      callback(target as PolishFocusTarget);
    };
    ipcRenderer.on("polish:focus", listener);
    return () => ipcRenderer.removeListener("polish:focus", listener);
  },
  onToggleFocus: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("polish:toggle-focus", listener);
    return () => ipcRenderer.removeListener("polish:toggle-focus", listener);
  },

  agentObservatory: (projectId: ProjectId): Promise<IpcResult<ObservatoryView>> =>
    ipcRenderer.invoke("agents:observatory", { projectId }),
  agentFleetDetail: (projectId: ProjectId, runId: string): Promise<IpcResult<FleetRunView>> =>
    ipcRenderer.invoke("agents:fleet-detail", { projectId, runId }),
  agentFleetEvidence: (
    projectId: ProjectId,
    runId: string,
    taskId: string,
  ): Promise<IpcResult<FleetEvidenceView>> =>
    ipcRenderer.invoke("agents:fleet-evidence", { projectId, runId, taskId }),
  agentHistory: (projectId: ProjectId, limit?: number): Promise<IpcResult<OrchestrationEvent[]>> =>
    ipcRenderer.invoke("agents:history", { projectId, ...(limit === undefined ? {} : { limit }) }),
  cancelAgentRun: (
    projectId: ProjectId,
    runId: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:run-cancel", { projectId, runId }),
  controlFleetRun: (
    projectId: ProjectId,
    runId: string,
    action: "stop",
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:fleet-control", { projectId, runId, action }),
  controlFleetWorker: (
    projectId: ProjectId,
    workerId: string,
    action: "stop" | "restart",
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:worker-control", { projectId, workerId, action }),
  setThreadGoal: (
    projectId: ProjectId,
    threadId: string,
    objective: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:goal-set", { projectId, threadId, objective }),
  completeThreadGoal: (
    projectId: ProjectId,
    threadId: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:goal-complete", { projectId, threadId }),
  blockThreadGoal: (
    projectId: ProjectId,
    threadId: string,
    reason?: string | null,
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:goal-block", { projectId, threadId, reason: reason ?? null }),
  clearThreadGoal: (
    projectId: ProjectId,
    threadId: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>> =>
    ipcRenderer.invoke("agents:goal-clear", { projectId, threadId }),
  launchNativeFleet: (input: {
    projectId: ProjectId;
    taskId: never;
    expectedRevision?: number;
    name: string;
    role: NativeRole;
    instructions: string;
  }): Promise<IpcResult<FleetLaunchResult>> =>
    ipcRenderer.invoke("agents:launch-fleet", { ...input, parallelism: "serial" }),

  settingsSnapshot: (projectId: ProjectId): Promise<IpcResult<SettingsSnapshot>> =>
    ipcRenderer.invoke("settings:snapshot", { projectId }),
  settingsModels: (
    projectId: ProjectId,
    provider: string,
    exactId: string | null,
  ): Promise<IpcResult<ModelCatalogView>> =>
    ipcRenderer.invoke("settings:models", { projectId, provider, exactId }),
  saveSavedRoute: (input: {
    projectId: ProjectId;
    expectedRevision: number;
    provider: string;
    exactId: string | null;
    model: string;
    reasoningEffort: string | null;
    permissionPosture: "full_access" | "ask";
    autoApprove: boolean;
    trustMode: boolean;
    allowShell: boolean;
  }): Promise<IpcResult<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }>> =>
    ipcRenderer.invoke("settings:save-default", input),
  resetSavedRoute: (
    projectId: ProjectId,
    expectedRevision: number,
  ): Promise<IpcResult<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }>> =>
    ipcRenderer.invoke("settings:reset-default", { projectId, expectedRevision }),
  switchEngineRoute: (input: {
    projectId: ProjectId;
    provider: string;
    exactId: string | null;
    model: string;
    expectedConfigRevision: string | null;
    confirm: true;
  }): Promise<IpcResult<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }>> =>
    ipcRenderer.invoke("settings:switch-engine", input),
  setProviderCredential: (input: {
    projectId: ProjectId;
    provider: string;
    key: string;
    scope: "session" | "durable";
  }): Promise<IpcResult<CredentialReceipt>> => ipcRenderer.invoke("settings:set-credential", input),
  clearProviderCredential: (
    projectId: ProjectId,
    provider: string,
    scope: "session" | "durable",
  ): Promise<IpcResult<CredentialClearReceipt>> =>
    ipcRenderer.invoke("settings:clear-credential", { projectId, provider, scope }),
  settingsDiagnostics: (projectId: ProjectId): Promise<IpcResult<SettingsDiagnosticsView>> =>
    ipcRenderer.invoke("settings:diagnostics", { projectId }),
  exportSettingsDiagnostics: (
    projectId: ProjectId,
  ): Promise<IpcResult<{ saved: boolean; path: string | null; redactions: number }>> =>
    ipcRenderer.invoke("settings:export-diagnostics", { projectId }),

  extensionsSnapshot: (projectId: ProjectId): Promise<IpcResult<ExtensionsSnapshot>> =>
    ipcRenderer.invoke("extensions:snapshot", { projectId }),
  mcpTools: (
    projectId: ProjectId,
    server: string,
  ): Promise<IpcResult<{ tools: McpToolView[]; source: "live"; error: string | null }>> =>
    ipcRenderer.invoke("extensions:mcp-tools", { projectId, server }),
  addMcpServer: (
    projectId: ProjectId,
    input: McpAddInput & { expectedRevision: string },
  ): Promise<IpcResult<ExtensionActionReceipt>> =>
    ipcRenderer.invoke("extensions:mcp-add", { projectId, ...input }),
  extensionAction: (input: {
    projectId: ProjectId;
    action: ExtensionActionId;
    target: string;
    expectedRevision?: string | null;
  }): Promise<IpcResult<ExtensionActionReceipt>> => ipcRenderer.invoke("extensions:action", input),
  installExtension: (
    projectId: ProjectId,
    kind: "plugin" | "skill",
    source: string,
  ): Promise<IpcResult<ExtensionActionReceipt>> =>
    ipcRenderer.invoke("extensions:install", { projectId, kind, source }),

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
