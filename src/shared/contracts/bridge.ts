import type { ProjectId, TaskId } from "./ids";
import type {
  HistoryCursor,
  HistoryItemPage,
  HistoryPage,
  IpcResult,
  OpenProjectResult,
  ProjectDetail,
  ProjectSummary,
  RuntimeStatusView,
  StateFacts,
} from "./project-bridge";
import type { OpenFolderView, OpenResult, OpenStatusView, ServiceStatus } from "./open";
import type {
  TerminalCreateResult,
  TerminalEvent,
  TerminalLogView,
  TerminalOutputView,
  TerminalSearchView,
  TerminalSessionView,
  TerminalSnapshot,
} from "./terminal";
import type { CapabilitySnapshot } from "./capability";
import type { CommandCatalogSnapshot } from "./commands";
import type { CommandExecuteRequest, CommandReceipt } from "./command-execution";
import type {
  ContextSelectionPreview,
  ContextSlot,
  ContextSlotView,
  DiagnosticsExportResult,
  DiagnosticsPreview,
  HandoffImportResult,
  HandoffInspection,
  HandoffPreview,
  MemoryIndexStatus,
  MemorySearchResult,
  MemorySource,
  PromptImportResult,
  PromptPack,
  PromptRenderRequest,
  PromptRenderResult,
  PromptShelfView,
  ResumePacket,
  SettingsBackupInspection,
  SettingsBackupView,
  SettingsRestoreResult,
  ShelfPrompt,
  ShelfSaveRequest,
  WorkspaceSearchResult,
} from "./memory";
import type { UsageEvidence } from "./usage";
import type { BudgetScope, BudgetView, CostExport, CostLedgerView, CostRateCardView } from "./cost";
import type {
  ArtifactWindowView,
  ChangesSnapshot,
  FileWindowMode,
  FileWindowView,
  FileWriteResultView,
  GitActionResult,
  RestorePreviewView,
  RestoreRequestEntry,
  RestoreResultView,
} from "./changes";
import type {
  BoardSnapshot,
  ContextPreview,
  HandoffView,
  ImportPlanResult,
  ProblemActor,
  ProblemView,
  QueueRunResult,
  ReconcileResult,
  TaskOwner,
  TaskPlan,
  TaskSelection,
  TaskView,
} from "./board";
import type {
  StudioActionResult,
  StudioMode,
  StudioPush,
  StudioReconcileResult,
  StudioSnapshot,
  StudioSubmitResult,
} from "./studio";
import type {
  NotificationReceiptView,
  PolishDigestView,
  PolishFocusTarget,
  PolishPreferences,
  PolishPreferencesPatch,
  PolishStatusView,
  ProjectIdentityInput,
  PromptFavorite,
} from "./polish";
import type {
  CredentialClearReceipt,
  CredentialReceipt,
  ModelCatalogView,
  RouteChangeReceipt,
  SettingsDiagnosticsView,
  SettingsSnapshot,
} from "./settings";
import type {
  ExtensionActionId,
  ExtensionActionReceipt,
  ExtensionsSnapshot,
  McpAddInput,
  McpToolView,
} from "./extensions";
import type {
  RecoveryRestoreReceipt,
  RecoveryView,
  UninstallView,
  UpdateCheckView,
  UpdateHandoffReceipt,
  UpdateIntentRecord,
  UpdateSourceConfig,
  UpdateStatusView,
} from "./update";
import type {
  FleetEvidenceView,
  FleetLaunchResult,
  FleetRunView,
  NativeRole,
  ObservatoryView,
  OrchestrationActionReceipt,
  OrchestrationEvent,
} from "./agents";

/** The complete, narrow surface the renderer may reach. Nothing else is exposed. */
export interface MonaBridge {
  getAppInfo(): Promise<AppInfo>;
  getPaths(): Promise<AppPathInfo>;
  /** Current interface scale, read from the main process that owns it. */
  zoom(): Promise<ZoomView>;
  /** Set an exact factor from the build's ladder; returns what was applied. */
  setZoom(factor: number): Promise<ZoomView>;
  /** The invoking window's observed native-fullscreen state. */
  windowFullscreen(): Promise<WindowFullscreenView>;
  /**
   * Ask the invoking window for native full screen. The reply is the state the
   * window reports, so a caller cannot treat the request as the outcome.
   */
  setWindowFullscreen(fullscreen: boolean): Promise<WindowFullscreenView>;
  discoverTools(names?: string[]): Promise<ToolDiscovery[]>;

  listProjects(query?: string, includeArchived?: boolean): Promise<IpcResult<ProjectSummary[]>>;
  openProject(rootPath?: string): Promise<IpcResult<OpenProjectResult | null>>;
  projectDetail(id: ProjectId): Promise<IpcResult<ProjectDetail>>;
  /** One older page of stored history; starts no runtime and asks no model. */
  projectHistory(
    id: ProjectId,
    options?: { before?: HistoryCursor | null; limit?: number; threadId?: string | null },
  ): Promise<IpcResult<HistoryPage>>;
  /** Every stored frame of one item, to rebuild a card cut off by paging. */
  projectHistoryItem(
    id: ProjectId,
    threadId: string,
    itemId: string,
  ): Promise<IpcResult<HistoryItemPage>>;
  renameProject(
    id: ProjectId,
    name: string,
    expectedRevision: number,
  ): Promise<IpcResult<ProjectSummary>>;
  setProjectPinned(
    id: ProjectId,
    pinned: boolean,
    expectedRevision: number,
  ): Promise<IpcResult<ProjectSummary>>;
  setProjectArchived(
    id: ProjectId,
    archived: boolean,
    expectedRevision: number,
  ): Promise<IpcResult<ProjectSummary>>;
  removeProject(id: ProjectId, expectedRevision: number): Promise<IpcResult<ProjectSummary>>;
  relocateProject(
    id: ProjectId,
    expectedRevision: number,
  ): Promise<IpcResult<ProjectSummary | null>>;
  revealProject(id: ProjectId): Promise<IpcResult<{ revealed: boolean }>>;
  saveProjectView(
    id: ProjectId,
    view: Record<string, unknown>,
  ): Promise<IpcResult<{ saved: boolean }>>;
  saveDraft(
    projectId: ProjectId,
    threadId: string,
    text: string,
  ): Promise<IpcResult<{ saved: boolean }>>;

  runtimeStatus(): Promise<RuntimeStatusView>;
  stateFacts(): Promise<StateFacts>;
  /** Main-process catalog changes (menu open, Finder handoff, relocation). */
  onProjectsChanged(callback: (projectId?: string) => void): () => void;

  // Finder handoff, Dock/window drops, and the open dialog.
  /** Resolve a dropped `File` to its absolute path inside the preload. */
  pathForDroppedFile(file: File): string | null;
  openDroppedFolder(path: string): Promise<IpcResult<OpenFolderView>>;
  openStatus(): Promise<OpenStatusView>;
  serviceStatus(): Promise<ServiceStatus>;
  refreshService(): Promise<ServiceStatus>;
  openServiceSettings(): Promise<IpcResult<{ opened: boolean }>>;
  /** Every external open attempt, accepted or refused, for honest reporting. */
  onOpenResult(callback: (result: OpenResult) => void): () => void;

  // Live work studio. Reading state never starts a runtime or spends inference.
  studioState(projectId: ProjectId): Promise<IpcResult<StudioSnapshot>>;
  startStudio(projectId: ProjectId): Promise<IpcResult<StudioSnapshot>>;
  submitTask(
    projectId: ProjectId,
    prompt: string,
    mode: StudioMode,
  ): Promise<IpcResult<StudioSubmitResult>>;
  interruptNow(projectId: ProjectId): Promise<IpcResult<StudioActionResult>>;
  pauseAfterTask(projectId: ProjectId): Promise<IpcResult<StudioActionResult>>;
  resumeQueue(projectId: ProjectId): Promise<IpcResult<StudioActionResult>>;
  cancelQueued(projectId: ProjectId): Promise<IpcResult<StudioActionResult>>;
  reconcileSubmission(projectId: ProjectId): Promise<IpcResult<StudioReconcileResult>>;
  stopStudio(projectId: ProjectId): Promise<IpcResult<StudioActionResult>>;
  /** Live connection, event, submission, and control updates from main. */
  onStudioChanged(callback: (push: StudioPush) => void): () => void;

  // P16 configuration workbench. Reading never starts a runtime or a model
  // call; only the explicit save/switch/credential calls write anything.
  settingsSnapshot(projectId: ProjectId): Promise<IpcResult<SettingsSnapshot>>;
  settingsModels(
    projectId: ProjectId,
    provider: string,
    exactId: string | null,
  ): Promise<IpcResult<ModelCatalogView>>;
  saveSavedRoute(input: {
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
  }): Promise<IpcResult<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }>>;
  resetSavedRoute(
    projectId: ProjectId,
    expectedRevision: number,
  ): Promise<IpcResult<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }>>;
  switchEngineRoute(input: {
    projectId: ProjectId;
    provider: string;
    exactId: string | null;
    model: string;
    expectedConfigRevision: string | null;
    confirm: true;
  }): Promise<IpcResult<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }>>;
  setProviderCredential(input: {
    projectId: ProjectId;
    provider: string;
    key: string;
    scope: "session" | "durable";
  }): Promise<IpcResult<CredentialReceipt>>;
  clearProviderCredential(
    projectId: ProjectId,
    provider: string,
    scope: "session" | "durable",
  ): Promise<IpcResult<CredentialClearReceipt>>;
  settingsDiagnostics(projectId: ProjectId): Promise<IpcResult<SettingsDiagnosticsView>>;
  exportSettingsDiagnostics(
    projectId: ProjectId,
  ): Promise<IpcResult<{ saved: boolean; path: string | null; redactions: number }>>;

  // P17 extension workbench. Reading lists metadata only; tool discovery is a
  // separate on-demand call. No inventory read starts a server.
  extensionsSnapshot(projectId: ProjectId): Promise<IpcResult<ExtensionsSnapshot>>;
  mcpTools(
    projectId: ProjectId,
    server: string,
  ): Promise<IpcResult<{ tools: McpToolView[]; source: "live"; error: string | null }>>;
  addMcpServer(
    projectId: ProjectId,
    input: McpAddInput & { expectedRevision: string },
  ): Promise<IpcResult<ExtensionActionReceipt>>;
  extensionAction(input: {
    projectId: ProjectId;
    action: ExtensionActionId;
    target: string;
    expectedRevision?: string | null;
  }): Promise<IpcResult<ExtensionActionReceipt>>;
  installExtension(
    projectId: ProjectId,
    kind: "plugin" | "skill",
    source: string,
  ): Promise<IpcResult<ExtensionActionReceipt>>;

  // Work board and durable continuation. Reading the board never starts work;
  // dispatchNextTask is the one call that can hand a prompt to the engine.
  boardSnapshot(projectId: ProjectId): Promise<IpcResult<BoardSnapshot>>;
  createBoardTask(input: {
    projectId: ProjectId;
    title: string;
    prompt: string;
    owner?: TaskOwner;
    requirements?: string[];
    acceptance?: Array<{ text: string; kind: "check" | "human" }>;
    steps?: string[];
    dependsOn?: TaskId[];
  }): Promise<IpcResult<TaskView>>;
  updateBoardTask(
    taskId: TaskId,
    expectedRevision: number,
    input: {
      title?: string;
      prompt?: string;
      owner?: TaskOwner;
      requirements?: string[];
      acceptance?: Array<{ text: string; kind: "check" | "human" }>;
      steps?: string[];
    },
  ): Promise<IpcResult<TaskView>>;
  importTaskPlan(projectId: ProjectId, plan: unknown): Promise<IpcResult<ImportPlanResult>>;
  importTaskPlanFile(projectId: ProjectId): Promise<IpcResult<ImportPlanResult | null>>;
  exportTaskPlan(projectId: ProjectId): Promise<IpcResult<TaskPlan>>;
  exportTaskPlanFile(
    projectId: ProjectId,
  ): Promise<IpcResult<{ saved: boolean; path: string | null }>>;
  previewTaskContext(taskId: TaskId): Promise<IpcResult<ContextPreview>>;
  selectNextTask(projectId: ProjectId, owner?: TaskOwner): Promise<IpcResult<TaskSelection>>;
  addTaskEvidence(input: {
    projectId: ProjectId;
    taskId: TaskId;
    requirementId: string;
    path: string;
    note?: string | null;
  }): Promise<IpcResult<TaskView>>;
  satisfyTaskCriterion(input: {
    taskId: TaskId;
    criterionId: string;
    expectedRevision: number;
    by: "check" | "human";
    evidencePath?: string | null;
  }): Promise<IpcResult<TaskView>>;
  verifyBoardTask(taskId: TaskId, expectedRevision: number): Promise<IpcResult<TaskView>>;
  completeBoardTask(taskId: TaskId, expectedRevision: number): Promise<IpcResult<TaskView>>;
  startBoardTask(
    taskId: TaskId,
    expectedRevision?: number,
  ): Promise<IpcResult<{ task: unknown; runId: string }>>;
  resumeBoardTask(
    taskId: TaskId,
  ): Promise<IpcResult<{ task: unknown; runId: string; step: string | null }>>;
  reconcileBoard(projectId: ProjectId, resume?: boolean): Promise<IpcResult<ReconcileResult>>;
  boardHandoff(projectId: ProjectId): Promise<IpcResult<HandoffView>>;
  dispatchNextTask(projectId: ProjectId): Promise<IpcResult<QueueRunResult>>;
  recordProblemAttempt(input: {
    projectId: ProjectId;
    taskId?: TaskId | null;
    requirement: string;
    symptom: string;
    hypothesis: string;
    action: string;
    observed: string;
    materialProgress: boolean;
    evidence?: string[];
    reason?: string | null;
    helpNeeded?: string | null;
    actor?: ProblemActor;
  }): Promise<IpcResult<{ problem: ProblemView; blocked: boolean; task: TaskView | null }>>;
  acknowledgeProblem(
    problemId: string,
    note?: string | null,
  ): Promise<IpcResult<{ problem: ProblemView }>>;
  resolveProblem(
    problemId: string,
    resolution: string,
    evidence?: string[],
  ): Promise<IpcResult<{ problem: ProblemView }>>;
  reopenProblem(
    problemId: string,
    reason: string,
    evidence: string[],
  ): Promise<IpcResult<{ problem: ProblemView }>>;

  // Cost ledger. Reads and explicit local edits only; no inference, no balance.
  costLedger(
    projectId: ProjectId,
    options?: { since?: string | null; until?: string | null; timeZone?: string },
  ): Promise<IpcResult<CostLedgerView>>;
  exportCostLedger(
    projectId: ProjectId,
    format: "json" | "csv",
    options?: { since?: string | null; until?: string | null; timeZone?: string },
  ): Promise<IpcResult<CostExport>>;
  exportCostLedgerFile(
    projectId: ProjectId,
    format: "json" | "csv",
  ): Promise<IpcResult<{ saved: boolean; path: string | null }>>;
  setCostBudget(input: {
    projectId: ProjectId;
    scope: BudgetScope;
    limitUsd: number;
    warnUsd?: number | null;
    enabled?: boolean;
    timeZone?: string;
    expectedRevision?: number;
  }): Promise<IpcResult<BudgetView>>;
  clearCostBudget(input: {
    projectId: ProjectId;
    budgetId: string;
    expectedRevision?: number;
  }): Promise<IpcResult<{ cleared: boolean }>>;
  setRateCard(input: {
    provider: string;
    model: string;
    cacheHitPerMillion: number | null;
    cacheMissPerMillion: number | null;
    outputPerMillion: number | null;
    toolCallPerMillion?: number | null;
    reasoningInOutput?: boolean;
    sourceRef?: string | null;
  }): Promise<IpcResult<CostRateCardView>>;
  previewCostRecalculation(input: {
    projectId: ProjectId;
    provider: string;
    model: string;
    cacheHitPerMillion: number | null;
    cacheMissPerMillion: number | null;
    outputPerMillion: number | null;
    reasoningInOutput?: boolean;
  }): Promise<
    IpcResult<{
      turns: number;
      beforePico: number;
      afterPico: number;
      changes: Array<{
        turnId: string | null;
        beforePico: number | null;
        afterPico: number | null;
      }>;
    }>
  >;

  // Changes, Git, and restore. Reads are local or read-only engine routes;
  // every mutation is an explicit user action and is checked against a preview.
  changesSnapshot(projectId: ProjectId, limit?: number): Promise<IpcResult<ChangesSnapshot>>;
  refreshChanges(projectId: ProjectId): Promise<IpcResult<ChangesSnapshot>>;
  readChangeFile(input: {
    projectId: ProjectId;
    changeSetId?: string;
    path: string;
    mode: FileWindowMode;
    offset?: number;
    limit?: number;
  }): Promise<IpcResult<FileWindowView>>;
  readChangeArtifact(input: {
    projectId: ProjectId;
    changeSetId: string;
    artifactId: string;
    offset?: number;
    limit?: number;
  }): Promise<IpcResult<ArtifactWindowView>>;
  previewRestore(
    projectId: ProjectId,
    changeSetId: string,
    paths: string[],
  ): Promise<IpcResult<RestorePreviewView>>;
  restoreChanges(input: {
    projectId: ProjectId;
    changeSetId: string;
    paths: string[];
    expected: RestoreRequestEntry[];
    acknowledge: string[];
  }): Promise<IpcResult<RestoreResultView>>;
  stageGitPaths(projectId: ProjectId, paths: string[]): Promise<IpcResult<GitActionResult>>;
  commitGitPaths(input: {
    projectId: ProjectId;
    message: string;
    paths: string[];
    includeUnstaged?: boolean;
  }): Promise<IpcResult<GitActionResult>>;
  writeWorkspaceFile(input: {
    projectId: ProjectId;
    path: string;
    content: string;
    expectedRevision: string;
  }): Promise<IpcResult<FileWriteResultView>>;
  revealWorkspacePath(
    projectId: ProjectId,
    path: string,
  ): Promise<IpcResult<{ revealed: boolean }>>;

  // Daily-use polish. Reads and explicit local preferences only; none of these
  // calls can start a turn or spend inference.
  polishDigest(projectId: ProjectId): Promise<IpcResult<PolishDigestView>>;
  markPolishSeen(projectId: ProjectId): Promise<IpcResult<{ seenAt: string }>>;
  polishStatus(): Promise<IpcResult<PolishStatusView>>;
  refreshPolish(projectId: ProjectId): Promise<IpcResult<PolishStatusView>>;
  setPolishPreferences(patch: PolishPreferencesPatch): Promise<IpcResult<PolishPreferences>>;
  setProjectIdentity(input: {
    projectId: ProjectId;
    accent: ProjectIdentityInput["accent"];
    monogram: string | null;
    expectedRevision: number;
  }): Promise<IpcResult<ProjectSummary>>;
  promptFavorites(): Promise<IpcResult<PromptFavorite[]>>;
  savePromptFavorite(input: { label: string; text: string }): Promise<IpcResult<PromptFavorite>>;
  removePromptFavorite(id: string): Promise<IpcResult<{ removed: boolean }>>;
  testNotification(): Promise<IpcResult<NotificationReceiptView>>;
  quitMona(interrupt: boolean): Promise<IpcResult<{ requested: boolean; note: string }>>;
  /** A notification click: focus the project and the evidence it names. */
  onPolishFocus(callback: (target: PolishFocusTarget) => void): () => void;
  /** Native Work → Toggle Focus Mode menu item. */
  onToggleFocus(callback: () => void): () => void;
  /**
   * Every observed native-fullscreen transition for this window, including the
   * ones the green button and Control-Command-F produce.
   */
  onFullscreenChanged(callback: (view: WindowFullscreenView) => void): () => void;

  // Native orchestration. Reads are local or read-only engine routes; every
  // control is an explicit action scoped to the project's live runtime.
  agentObservatory(projectId: ProjectId): Promise<IpcResult<ObservatoryView>>;
  agentFleetDetail(projectId: ProjectId, runId: string): Promise<IpcResult<FleetRunView>>;
  agentFleetEvidence(
    projectId: ProjectId,
    runId: string,
    taskId: string,
  ): Promise<IpcResult<FleetEvidenceView>>;
  agentHistory(projectId: ProjectId, limit?: number): Promise<IpcResult<OrchestrationEvent[]>>;
  cancelAgentRun(
    projectId: ProjectId,
    runId: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  controlFleetRun(
    projectId: ProjectId,
    runId: string,
    action: "stop",
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  controlFleetWorker(
    projectId: ProjectId,
    workerId: string,
    action: "stop" | "restart",
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  setThreadGoal(
    projectId: ProjectId,
    threadId: string,
    objective: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  completeThreadGoal(
    projectId: ProjectId,
    threadId: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  blockThreadGoal(
    projectId: ProjectId,
    threadId: string,
    reason?: string | null,
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  clearThreadGoal(
    projectId: ProjectId,
    threadId: string,
  ): Promise<IpcResult<OrchestrationActionReceipt>>;
  launchNativeFleet(input: {
    projectId: ProjectId;
    taskId: TaskId;
    expectedRevision?: number;
    name: string;
    role: NativeRole;
    instructions: string;
  }): Promise<IpcResult<FleetLaunchResult>>;

  // P18: integrated terminal. Bytes only. A terminal session has no reach into
  // the engine, the board, the workspace, or the rest of the bridge.
  terminalSnapshot(): Promise<IpcResult<TerminalSnapshot>>;
  terminalCreate(input: {
    projectId?: ProjectId | null;
    cols?: number;
    rows?: number;
  }): Promise<IpcResult<TerminalCreateResult>>;
  terminalWrite(input: {
    sessionId: string;
    data: string;
    encoding?: "text" | "base64";
  }): Promise<IpcResult<{ written: number }>>;
  terminalResize(input: {
    sessionId: string;
    cols: number;
    rows: number;
  }): Promise<IpcResult<TerminalSessionView>>;
  terminalClose(sessionId: string): Promise<IpcResult<TerminalSessionView>>;
  terminalOutput(input: {
    sessionId: string;
    cursor?: number;
    maxBytes?: number;
  }): Promise<IpcResult<TerminalOutputView>>;
  terminalSearch(input: {
    sessionId: string;
    query: string;
  }): Promise<IpcResult<TerminalSearchView>>;
  /** Read-only tail of the owned runtime's engine log for one project. */
  terminalLog(projectId: ProjectId): Promise<IpcResult<TerminalLogView>>;
  onTerminalEvent(callback: (event: TerminalEvent) => void): () => void;

  // P18: capability coverage. The snapshot is computed from the checked-in
  // inventory, a read-only help probe, and this build's entry-point registry.
  capabilitySnapshot(): Promise<IpcResult<CapabilitySnapshot>>;
  refreshCapabilities(): Promise<IpcResult<CapabilitySnapshot>>;
  capabilityReport(): Promise<IpcResult<{ json: string; markdown: string; filename: string }>>;
  /**
   * R03: the pinned slash-command catalog. A local read of checked-in data;
   * filtering and help in the renderer make no further request.
   */
  commandCatalog(): Promise<IpcResult<CommandCatalogSnapshot>>;
  /**
   * R04: execute one catalogued command through the main-process dispatcher.
   * The renderer never spawns a process and never sends a command to a model.
   */
  executeCommand(input: CommandExecuteRequest): Promise<IpcResult<CommandReceipt>>;

  // P19: project memory, prompt shelf, portable handoff, and diagnostics.
  // Every method here is a local read or an inert local write. None accepts a
  // free-form command, none starts a process (no engine probe, no runtime), and
  // none can start a turn or make a model call.
  memorySearch(input: {
    projectId: ProjectId;
    query: string;
    sources?: MemorySource[];
    limit?: number;
  }): Promise<IpcResult<MemorySearchResult>>;
  memoryIndex(projectId: ProjectId): Promise<IpcResult<MemoryIndexStatus>>;
  memoryWorkspaceSearch(input: {
    projectId: ProjectId;
    query: string;
    limit?: number;
  }): Promise<IpcResult<WorkspaceSearchResult>>;
  memoryResume(projectId: ProjectId): Promise<IpcResult<ResumePacket>>;
  memoryContextSlots(projectId: ProjectId, taskId: TaskId): Promise<IpcResult<ContextSlotView[]>>;
  memoryContextPreview(input: {
    projectId: ProjectId;
    taskId: TaskId;
    include: ContextSlot[];
  }): Promise<IpcResult<ContextSelectionPreview>>;

  promptShelf(): Promise<IpcResult<PromptShelfView>>;
  saveShelfPrompt(input: ShelfSaveRequest): Promise<IpcResult<ShelfPrompt>>;
  removeShelfPrompt(promptId: string): Promise<IpcResult<{ removed: boolean; id: string }>>;
  renderShelfPrompt(input: PromptRenderRequest): Promise<IpcResult<PromptRenderResult>>;
  exportShelfPack(input?: { name?: string; promptIds?: string[] }): Promise<IpcResult<PromptPack>>;
  exportShelfPackFile(input?: {
    name?: string;
    promptIds?: string[];
  }): Promise<IpcResult<{ saved: boolean; path: string | null }>>;
  importShelfPackFile(): Promise<IpcResult<PromptImportResult | null>>;

  handoffPreview(projectId: ProjectId): Promise<IpcResult<HandoffPreview>>;
  exportHandoff(projectId: ProjectId): Promise<
    IpcResult<{
      saved: boolean;
      path: string | null;
      digest: string;
      entries: number;
      bytes: number;
      redactions: number;
    }>
  >;
  chooseHandoff(path?: string): Promise<IpcResult<string | null>>;
  inspectHandoff(path: string): Promise<IpcResult<HandoffInspection>>;
  importHandoff(input: {
    path: string;
    rootPath?: string;
    mode?: "create" | "replace";
    expectedRevision?: number;
  }): Promise<IpcResult<HandoffImportResult>>;

  settingsBackupPreview(): Promise<IpcResult<SettingsBackupView>>;
  exportSettingsBackup(): Promise<
    IpcResult<{
      saved: boolean;
      path: string | null;
      digest: string;
      scopes: number;
      bytes: number;
    }>
  >;
  chooseSettingsBackup(path?: string): Promise<IpcResult<string | null>>;
  inspectSettingsBackup(path: string): Promise<IpcResult<SettingsBackupInspection>>;
  restoreSettings(input: {
    path: string;
    mode: "merge" | "replace";
    scopes?: string[];
    expectedRevision?: number;
    confirm?: boolean;
  }): Promise<IpcResult<SettingsRestoreResult>>;

  diagnosticsPreview(projectId?: ProjectId | null): Promise<IpcResult<DiagnosticsPreview>>;
  exportDiagnosticsBundle(
    projectId?: ProjectId | null,
  ): Promise<IpcResult<DiagnosticsExportResult>>;

  // P23: installer-mediated updates, migration recovery, and uninstall
  // guidance. A check is a local read of an explicitly configured source; the
  // only privileged step is the handoff to Apple Installer, which the user
  // authorizes there. None of these makes a model call.
  updateStatus(): Promise<IpcResult<UpdateStatusView>>;
  configureUpdateSource(input: {
    mode: "manual" | "configured";
    baseUrl: string | null;
    manifestPath: string | null;
    teamId: string | null;
    manifestKey: string | null;
    allowLocalPackages: boolean;
  }): Promise<IpcResult<{ config: UpdateSourceConfig; status: UpdateStatusView }>>;
  checkForUpdate(refresh?: boolean): Promise<IpcResult<UpdateCheckView>>;
  chooseUpdatePackage(): Promise<IpcResult<{ chosen: boolean; view: UpdateCheckView | null }>>;
  inspectLocalUpdate(path?: string): Promise<IpcResult<UpdateCheckView>>;
  installUpdate(input: {
    packagePath?: string;
    expectedSha256: string;
    confirmedLocalBuild?: boolean;
  }): Promise<IpcResult<UpdateHandoffReceipt>>;
  confirmEngineChange(packageSha256: string): Promise<IpcResult<{ confirmed: boolean }>>;
  cancelUpdateIntent(intentId: string): Promise<IpcResult<UpdateIntentRecord>>;
  uninstallGuide(): Promise<IpcResult<UninstallView>>;
  stateRecovery(): Promise<IpcResult<RecoveryView>>;
  restoreRecoverySnapshot(input: {
    snapshotPath: string;
    expectedSchemaVersion: number;
    confirmation: "restore-matching-snapshot";
  }): Promise<IpcResult<RecoveryRestoreReceipt>>;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  packaged: boolean;
}

export interface ZoomView {
  /** The applied page-zoom factor (1 = 100%). */
  factor: number;
  /** The same value as a display string, e.g. "125%". */
  percent: string;
  /** The ladder this build steps through, ascending. */
  steps: number[];
  min: number;
  max: number;
}

/**
 * Native macOS full screen, as the window itself reports it.
 *
 * `fullscreen` is an observation, never an intention: main reads it back from
 * the window in the `enter-full-screen` / `leave-full-screen` handlers, so a
 * click that macOS refuses cannot look like a state change. `pending` says a
 * request is in flight and has not been observed yet, which is why the UI can
 * say "entering full screen" without claiming it happened.
 */
export interface WindowFullscreenView {
  /** The OS state the window last reported. */
  fullscreen: boolean;
  /** A request was accepted and no transition has been observed yet. */
  pending: boolean;
  /** Whether this build can ask for native full screen at all. */
  available: boolean;
  /** Increments on every observed transition, so a UI can tell one from another. */
  epoch: number;
}

export interface AppPathInfo {
  support: string;
  cache: string;
  logs: string;
  /** Per-user SQLite database (Application Support); never in the workspace. */
  database?: string;
  state?: string;
  backups?: string;
  artifacts?: string;
}

export interface ToolDiscovery {
  name: string;
  path: string | null;
  source: "env" | "environment_path" | "well_known" | "missing";
}

export interface AppInfoEnvelope {
  app: AppInfo;
  usage: UsageEvidence | null;
}
