import { app, clipboard, ipcMain } from "electron";
import { discoverTools } from "./tool-discovery";
import { resolveAppPaths } from "./paths";
import { validateIpc, type IpcChannel } from "./ipc-contract";
import { senderIsTrusted } from "./ipc-sender";
import { StateError } from "./state/errors";
import type { ProjectService } from "./projects/service";
import type { WorkStudio } from "./work/studio";
import type { TaskBoard } from "./work/board";
import type { CostLedger } from "./work/costs";
import type { ChangeLedger } from "./work/changes";
import type { PolishService } from "./work/polish";
import type { AgentObservatory } from "./work/agents";
import type { RouteWorkbench } from "./work/settings";
import type { ExtensionWorkbench } from "./work/extensions";
import type { CapabilityExplorer } from "./work/capability";
import type { CommandCatalogService } from "./work/commands";
import { CommandDispatchService } from "./work/command-dispatch";
import type { ProjectMemory } from "./work/memory";
import type { PromptShelf } from "./work/shelf";
import type { ProjectHandoff } from "./work/handoff";
import type { TerminalManager } from "./terminal/session";
import type { ProjectId, TaskId } from "../shared/contracts/ids";
import type {
  DiagnosticsExportResult,
  DiagnosticsPreview,
  PromptPack,
} from "../shared/contracts/memory";
import type { ImportPlanResult } from "../shared/contracts/board";
import type { ZoomView } from "../shared/contracts/bridge";
import type { NativeFullscreen } from "./window-fullscreen";
import type { IpcResult, RuntimeStatusView, StateFacts } from "../shared/contracts/project-bridge";
import type {
  FolderRequestSource,
  OpenResult,
  OpenStatusView,
  ServiceStatus,
} from "../shared/contracts/open";
import type { SettingsDiagnosticsView } from "../shared/contracts/settings";
import type { RecoveryRestoreReceipt, RecoveryView } from "../shared/contracts/update";
import type { UpdateCoordinator } from "./update/coordinator";
import { uninstallView } from "./update/uninstall";

export interface IpcDependencies {
  projects: ProjectService;
  runtimeStatus: () => RuntimeStatusView;
  stateFacts: () => Promise<StateFacts>;
  studio: WorkStudio | null;
  board: TaskBoard | null;
  cost: CostLedger | null;
  changes: ChangeLedger | null;
  polish: PolishService | null;
  agents: AgentObservatory | null;
  settings: RouteWorkbench | null;
  extensions: ExtensionWorkbench | null;
  terminal: TerminalManager | null;
  capabilities: CapabilityExplorer | null;
  commands: CommandCatalogService | null;
  memory: ProjectMemory | null;
  shelf: PromptShelf | null;
  handoff: ProjectHandoff | null;
  update: UpdateCoordinator | null;
  /** Interface scale. Main owns the factor; the renderer only reads and asks. */
  zoom: {
    view: () => ZoomView;
    set: (factor: number) => Promise<ZoomView>;
  };
  /**
   * Native full screen, resolved from the invoking renderer's window. A null
   * answer means the request did not come from a window this process created,
   * and the handler refuses instead of guessing.
   */
  windowFullscreen: (webContentsId: number) => NativeFullscreen | null;
  /** Read-only recovery facts, plus one explicit verified-snapshot restore. */
  recovery: () => RecoveryView;
  restoreRecoverySnapshot: (input: {
    snapshotPath: string;
    expectedSchemaVersion: number;
  }) => Promise<RecoveryRestoreReceipt>;
  /** Choose one `.pkg` through the native open dialog; the path never escapes. */
  choosePackage: () => Promise<string | null>;
  /** Where package inspection and downloads happen, and the installed facts. */
  updateFacts: () => {
    home: string;
    cache: string;
    support: string;
    launchQuit: boolean;
  };
  /** Native dialogs and file writes for the memory surface, owned by the entry point. */
  memoryFiles: MemoryFileDialogs;
  /** Save an already-redacted diagnostics report through the native dialog. */
  exportDiagnostics: (
    report: SettingsDiagnosticsView,
  ) => Promise<{ saved: boolean; path: string | null }>;
  /** Explicit quit; the existing shutdown path interrupts and stops owned work. */
  quit: (interrupt: boolean) => Promise<{ requested: boolean; note: string }>;
  revealWorkspacePath: (projectId: ProjectId, path: string) => Promise<{ revealed: boolean }>;
  /** Native file dialogs live in the main entry point, not in the IPC layer. */
  importPlanFile: (projectId: ProjectId) => Promise<ImportPlanResult | null>;
  exportPlanFile: (projectId: ProjectId) => Promise<{ saved: boolean; path: string | null }>;
  /** Save a generated ledger file through the native dialog. */
  exportCostFile: (
    projectId: ProjectId,
    format: "json" | "csv",
  ) => Promise<{ saved: boolean; path: string | null }>;
  /** The one dispatcher for externally supplied folders (validated, journaled). */
  openRequest: (input: string, source: FolderRequestSource) => Promise<OpenResult>;
  openStatus: () => OpenStatusView;
  serviceStatus: () => ServiceStatus;
  refreshService: () => ServiceStatus;
  openServiceSettings: () => Promise<{ opened: boolean }>;
  chooseFolder: () => Promise<string | null>;
}

/**
 * Native dialogs and file writes for the P19 surface. They live in the entry
 * point so the IPC layer never learns a path it did not receive from a picker.
 */
export interface MemoryFileDialogs {
  chooseBundle: (kind: "handoff" | "settings", prefillPath?: string) => Promise<string | null>;
  exportHandoff: (projectId: ProjectId) => Promise<{
    saved: boolean;
    path: string | null;
    digest: string;
    entries: number;
    bytes: number;
    redactions: number;
  }>;
  exportSettingsBackup: () => Promise<{
    saved: boolean;
    path: string | null;
    digest: string;
    scopes: number;
    bytes: number;
  }>;
  exportPromptPack: (
    pack: PromptPack,
    suggestedName: string,
  ) => Promise<{ saved: boolean; path: string | null }>;
  importPromptPack: () => Promise<{ value: unknown | null; path: string | null }>;
  exportDiagnostics: (preview: DiagnosticsPreview) => Promise<DiagnosticsExportResult>;
}

async function envelope<T>(work: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof StateError) {
      return {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
      };
    }
    const candidate = error as { code?: string; message?: string; details?: unknown };
    return {
      ok: false,
      error: {
        code: typeof candidate.code === "string" ? candidate.code : "INTERNAL",
        message: candidate.message ?? String(error),
        ...(candidate.details === undefined ? {} : { details: candidate.details }),
      },
    };
  }
}

export function registerIpc(rendererRoot: string, dependencies: IpcDependencies): void {
  const handle = (channel: IpcChannel, handler: (input: unknown) => unknown) => {
    ipcMain.handle(channel, async (event, raw) => {
      if (!senderIsTrusted(event, rendererRoot)) {
        throw new Error("untrusted IPC sender");
      }
      return handler(validateIpc(channel, raw));
    });
  };
  // The two window-scoped channels need the invoking sender: full screen is
  // applied to the window that asked, never to a process-global one.
  const scoped = (channel: IpcChannel, handler: (input: unknown, senderId: number) => unknown) => {
    ipcMain.handle(channel, async (event, raw) => {
      if (!senderIsTrusted(event, rendererRoot)) {
        throw new Error("untrusted IPC sender");
      }
      return handler(validateIpc(channel, raw), event.sender.id);
    });
  };
  const fullscreenFor = (senderId: number): NativeFullscreen => {
    const target = dependencies.windowFullscreen(senderId);
    if (!target) throw new Error("no Mona window owns this window request");
    return target;
  };

  handle("clipboard:write", (input) => {
    const value = input as { text: string; label: "message" | "code" | "prompt" };
    return envelope(async () => {
      // writeText rejects when the platform clipboard is unavailable (a locked
      // session, a headless CI host). That failure is returned, not swallowed.
      await clipboard.writeText(value.text);
      const readBack = await clipboard.readText();
      return {
        written: readBack === value.text,
        label: value.label,
        characters: value.text.length,
        note:
          readBack === value.text
            ? `Copied ${value.text.length} character${value.text.length === 1 ? "" : "s"} to the clipboard.`
            : "The clipboard did not hold the copied text; nothing was lost from the document.",
      };
    });
  });
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

  handle("app:zoom", () => dependencies.zoom.view());
  handle("app:zoom:set", (input) => dependencies.zoom.set((input as { factor: number }).factor));
  scoped("window:fullscreen", (_input, senderId) => fullscreenFor(senderId).view());
  scoped("window:fullscreen:set", (input, senderId) =>
    fullscreenFor(senderId).request((input as { fullscreen: boolean }).fullscreen),
  );

  handle("app:paths", () => {
    const paths = resolveAppPaths();
    return {
      support: paths.support,
      cache: paths.cache,
      logs: paths.logs,
      state: paths.state,
      database: paths.database,
      backups: paths.backups,
      artifacts: paths.artifacts,
    };
  });

  handle("tools:discover", (input) => {
    const names = (input as { names?: string[] }).names ?? ["codewhale", "git", "node"];
    return discoverTools(names);
  });

  handle("projects:list", (input) => {
    const value = input as { query?: string; includeArchived?: boolean };
    return envelope(() =>
      dependencies.projects.list({ query: value.query, includeArchived: value.includeArchived }),
    );
  });
  // The open dialog and the Finder handoff converge on the same validated
  // dispatcher, so both paths register identically and neither can start work.
  const openThroughDispatcher = async (
    target: string,
    source: FolderRequestSource,
  ): Promise<{
    project: Awaited<ReturnType<ProjectService["summaryById"]>>;
    created: boolean;
    result: OpenResult;
  }> => {
    const result = await dependencies.openRequest(target, source);
    if (!result.ok || !result.projectId) {
      throw new StateError("INVALID_PATH", result.message ?? "Mona could not open that folder.", {
        openCode: result.code,
        source,
      });
    }
    const project = await dependencies.projects.summaryById(result.projectId as ProjectId);
    return { project, created: result.created, result };
  };

  handle("projects:open", (input) => {
    const provided = (input as { rootPath?: string }).rootPath;
    return envelope(async () => {
      const target = provided ?? (await dependencies.chooseFolder());
      if (!target) return null;
      const opened = await openThroughDispatcher(target, provided ? "drop" : "dialog");
      return { project: opened.project, created: opened.created };
    });
  });
  handle("open:folder", (input) => {
    const value = input as { path: string; source: "drop" };
    return envelope(() => openThroughDispatcher(value.path, value.source));
  });
  handle("open:status", () => dependencies.openStatus());
  handle("service:status", () => dependencies.serviceStatus());
  handle("service:refresh", () => dependencies.refreshService());
  handle("service:open-settings", () => envelope(() => dependencies.openServiceSettings()));
  handle("projects:detail", (input) =>
    envelope(() => dependencies.projects.detail((input as { projectId: never }).projectId)),
  );
  handle("projects:history", (input) => {
    const value = input as {
      projectId: never;
      before?: { recordedAt: string; rowId: number } | null;
      limit?: number;
      threadId?: string | null;
    };
    return envelope(() =>
      dependencies.projects.history(value.projectId, {
        before: value.before ?? null,
        limit: value.limit,
        threadId: value.threadId ?? null,
      }),
    );
  });
  handle("projects:search", (input) => {
    const value = input as {
      projectId: never;
      query: string;
      limit?: number;
      threadId?: string | null;
    };
    return envelope(() =>
      dependencies.projects.searchEvents(value.projectId, value.query, {
        limit: value.limit,
        threadId: value.threadId ?? null,
      }),
    );
  });
  handle("projects:history-item", (input) => {
    const value = input as { projectId: never; threadId: string; itemId: string };
    return envelope(() =>
      dependencies.projects.historyItem(value.projectId, value.threadId, value.itemId),
    );
  });
  handle("projects:rename", (input) => {
    const value = input as { projectId: never; name: string; expectedRevision: number };
    return envelope(() =>
      dependencies.projects.rename(value.projectId, value.name, value.expectedRevision),
    );
  });
  handle("projects:pin", (input) => {
    const value = input as { projectId: never; pinned: boolean; expectedRevision: number };
    return envelope(() =>
      dependencies.projects.setPinned(value.projectId, value.pinned, value.expectedRevision),
    );
  });
  handle("projects:archive", (input) => {
    const value = input as { projectId: never; archived: boolean; expectedRevision: number };
    return envelope(() =>
      dependencies.projects.setArchived(value.projectId, value.archived, value.expectedRevision),
    );
  });
  handle("projects:remove", (input) => {
    const value = input as { projectId: never; expectedRevision: number };
    return envelope(() => dependencies.projects.remove(value.projectId, value.expectedRevision));
  });
  handle("projects:relocate", (input) => {
    const value = input as { projectId: never; expectedRevision: number };
    return envelope(() => dependencies.projects.relocate(value.projectId, value.expectedRevision));
  });
  handle("projects:reveal", (input) =>
    envelope(async () => {
      await dependencies.projects.revealProject((input as { projectId: never }).projectId);
      return { revealed: true };
    }),
  );
  handle("projects:view", (input) => {
    const value = input as { projectId: never; view: Record<string, unknown> };
    return envelope(async () => {
      await dependencies.projects.saveView(value.projectId, value.view);
      return { saved: true };
    });
  });
  handle("projects:draft", (input) => {
    const value = input as { projectId: never; threadId: string; text: string };
    return envelope(async () => {
      await dependencies.projects.saveDraft(value.projectId, value.threadId, value.text);
      return { saved: true };
    });
  });
  handle("runtime:status", () => dependencies.runtimeStatus());
  handle("state:facts", () => dependencies.stateFacts());

  const requireStudio = (): WorkStudio => {
    const studio = dependencies.studio;
    if (!studio) {
      throw Object.assign(
        new Error("the live studio is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return studio;
  };

  handle("studio:state", (input) =>
    envelope(() => requireStudio().snapshot((input as { projectId: never }).projectId)),
  );
  handle("studio:start", (input) =>
    envelope(() => requireStudio().start((input as { projectId: never }).projectId)),
  );
  handle("studio:submit", (input) => {
    const value = input as { projectId: never; prompt: string; mode: "plan" | "work" };
    return envelope(() =>
      requireStudio().submit(value.projectId, { prompt: value.prompt, mode: value.mode }),
    );
  });
  handle("studio:interrupt", (input) =>
    envelope(async () => {
      const value = input as { projectId: never };
      const result = await requireStudio().interrupt(value.projectId);
      if (!dependencies.board) return result;
      if (result.confirmed !== true && !result.uncertain) return result;
      try {
        const linked = await dependencies.board.noteEngineInterrupt(value.projectId, {
          turnId: result.turnId,
          confirmed: result.confirmed === true,
          uncertain: result.uncertain,
          note: result.note,
        });
        return { ...result, note: `${result.note}; ${linked.note}` };
      } catch (error) {
        return {
          ...result,
          note: `${result.note}; the linked task could not be annotated: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }),
  );
  handle("studio:pause", (input) =>
    envelope(() => requireStudio().pauseAfterTask((input as { projectId: never }).projectId)),
  );
  handle("studio:resume-queue", (input) =>
    envelope(() => requireStudio().resumeQueue((input as { projectId: never }).projectId)),
  );
  handle("studio:cancel-queued", (input) =>
    envelope(() => requireStudio().cancelQueued((input as { projectId: never }).projectId)),
  );
  handle("studio:reconcile", (input) =>
    envelope(() => requireStudio().reconcile((input as { projectId: never }).projectId)),
  );
  handle("studio:stop", (input) =>
    envelope(() => requireStudio().stop((input as { projectId: never }).projectId)),
  );
  handle("studio:follow-up-add", (input) => {
    const value = input as { projectId: never; prompt: string; mode: "plan" | "work" };
    return envelope(() =>
      requireStudio().enqueueFollowUp(value.projectId, {
        prompt: value.prompt,
        mode: value.mode,
      }),
    );
  });
  handle("studio:follow-up-edit", (input) => {
    const value = input as { projectId: never; followUpId: string; prompt: string };
    return envelope(() =>
      requireStudio().editFollowUp(value.projectId, value.followUpId, value.prompt),
    );
  });
  handle("studio:follow-up-cancel", (input) => {
    const value = input as { projectId: never; followUpId: string };
    return envelope(() => requireStudio().cancelFollowUp(value.projectId, value.followUpId));
  });
  handle("studio:follow-up-dispatch", (input) =>
    envelope(() => requireStudio().dispatchFollowUps((input as { projectId: never }).projectId)),
  );
  handle("studio:file-preview", (input) => {
    const value = input as { projectId: never; path: string };
    return envelope(() => requireStudio().previewFile(value.projectId, value.path));
  });
  handle("studio:answer-pending", (input) => {
    const value = input as {
      projectId: never;
      requestId: string;
      response: Parameters<WorkStudio["answerPending"]>[2];
    };
    return envelope(() =>
      requireStudio().answerPending(value.projectId, value.requestId, value.response),
    );
  });

  const requireSettings = (): RouteWorkbench => {
    const workbench = dependencies.settings;
    if (!workbench) {
      throw Object.assign(
        new Error("the configuration workbench is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return workbench;
  };

  handle("settings:snapshot", (input) =>
    envelope(() => requireSettings().snapshot((input as { projectId: never }).projectId)),
  );
  handle("settings:models", (input) => {
    const value = input as {
      projectId: never;
      provider: string;
      exactId: string | null;
    };
    return envelope(() => requireSettings().models(value.projectId, value.provider, value.exactId));
  });
  handle("settings:save-default", (input) => {
    const value = input as Parameters<RouteWorkbench["saveDefault"]>[0];
    return envelope(() => requireSettings().saveDefault(value));
  });
  handle("settings:reset-default", (input) => {
    const value = input as Parameters<RouteWorkbench["resetDefault"]>[0];
    return envelope(() => requireSettings().resetDefault(value));
  });
  handle("settings:set-reasoning-display", (input) => {
    const value = input as Parameters<RouteWorkbench["setReasoningDisplay"]>[0];
    return envelope(() => requireSettings().setReasoningDisplay(value));
  });
  handle("settings:switch-engine", (input) => {
    const value = input as Parameters<RouteWorkbench["switchEngineRoute"]>[0];
    return envelope(() => requireSettings().switchEngineRoute(value));
  });
  handle("settings:set-credential", (input) => {
    const value = input as Parameters<RouteWorkbench["setProviderCredential"]>[0];
    return envelope(() => requireSettings().setProviderCredential(value));
  });
  handle("settings:clear-credential", (input) => {
    const value = input as Parameters<RouteWorkbench["clearProviderCredential"]>[0];
    return envelope(() => requireSettings().clearProviderCredential(value));
  });
  handle("settings:diagnostics", (input) =>
    envelope(() => requireSettings().diagnostics((input as { projectId: never }).projectId)),
  );
  handle("settings:export-diagnostics", (input) =>
    envelope(async () => {
      const report = await requireSettings().diagnostics((input as { projectId: never }).projectId);
      const saved = await dependencies.exportDiagnostics(report);
      return { ...saved, redactions: report.redactions };
    }),
  );

  const requireExtensions = (): ExtensionWorkbench => {
    const workbench = dependencies.extensions;
    if (!workbench) {
      throw Object.assign(
        new Error("the extension workbench is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return workbench;
  };

  handle("extensions:snapshot", (input) =>
    envelope(() => requireExtensions().snapshot((input as { projectId: never }).projectId)),
  );
  handle("extensions:mcp-tools", (input) => {
    const value = input as { projectId: never; server: string };
    return envelope(() => requireExtensions().mcpTools(value.projectId, value.server));
  });
  handle("extensions:mcp-add", (input) => {
    const value = input as {
      projectId: never;
      expectedRevision: string;
      name: string;
      command: string | null;
      args: string[];
      url: string | null;
      transport: "sse" | null;
      enabled: boolean;
    };
    const { projectId, ...rest } = value;
    return envelope(() => requireExtensions().addMcp(projectId, rest));
  });
  handle("extensions:action", (input) => {
    const value = input as Parameters<ExtensionWorkbench["act"]>[0];
    return envelope(() => requireExtensions().act(value));
  });
  handle("extensions:install", (input) => {
    const value = input as {
      projectId: never;
      kind: "plugin" | "skill";
      source: string;
    };
    return envelope(() => requireExtensions().install(value.projectId, value.kind, value.source));
  });

  const requireBoard = (): TaskBoard => {
    const board = dependencies.board;
    if (!board) {
      throw Object.assign(
        new Error("the work board is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return board;
  };

  handle("board:snapshot", (input) =>
    envelope(() => requireBoard().snapshot((input as { projectId: never }).projectId)),
  );
  handle("board:create", (input) => {
    const value = input as {
      projectId: never;
      title: string;
      prompt: string;
      owner?: "mona_queue" | "native_workflow";
      requirements?: string[];
      acceptance?: Array<{ text: string; kind: "check" | "human" }>;
      steps?: string[];
      dependsOn?: never[];
    };
    return envelope(() => requireBoard().create(value));
  });
  handle("board:update", (input) => {
    const value = input as {
      taskId: never;
      expectedRevision: number;
      title?: string;
      prompt?: string;
      owner?: "mona_queue" | "native_workflow";
      requirements?: string[];
      acceptance?: Array<{ text: string; kind: "check" | "human" }>;
      steps?: string[];
    };
    const { taskId, expectedRevision, ...changes } = value;
    return envelope(() => requireBoard().update(taskId, expectedRevision, changes));
  });
  handle("board:import", (input) => {
    const value = input as { projectId: never; plan: unknown };
    return envelope(() => requireBoard().importPlan(value.projectId, value.plan));
  });
  handle("board:import-file", (input) =>
    envelope(() => dependencies.importPlanFile((input as { projectId: never }).projectId)),
  );
  handle("board:export", (input) =>
    envelope(() => requireBoard().exportPlan((input as { projectId: never }).projectId)),
  );
  handle("board:export-file", (input) =>
    envelope(() => dependencies.exportPlanFile((input as { projectId: never }).projectId)),
  );
  handle("board:preview", (input) =>
    envelope(() => requireBoard().previewContext((input as { taskId: never }).taskId)),
  );
  handle("board:select", (input) => {
    const value = input as { projectId: never; owner?: "mona_queue" | "native_workflow" };
    return envelope(() => requireBoard().selectNext(value.projectId, value.owner));
  });
  handle("board:evidence", (input) => {
    const value = input as {
      projectId: never;
      taskId: never;
      requirementId: string;
      path: string;
      note?: string | null;
    };
    return envelope(() => requireBoard().addEvidence(value));
  });
  handle("board:satisfy", (input) => {
    const value = input as {
      taskId: never;
      criterionId: string;
      expectedRevision: number;
      by: "check" | "human";
      evidencePath?: string | null;
    };
    return envelope(() => requireBoard().satisfy(value));
  });
  handle("board:verify", (input) => {
    const value = input as { taskId: never; expectedRevision: number };
    return envelope(() => requireBoard().verify(value.taskId, value.expectedRevision));
  });
  handle("board:complete", (input) => {
    const value = input as { taskId: never; expectedRevision: number };
    return envelope(() => requireBoard().complete(value.taskId, value.expectedRevision));
  });
  handle("board:start", (input) => {
    const value = input as { taskId: never; expectedRevision?: number };
    return envelope(() => requireBoard().startTask(value.taskId, value.expectedRevision));
  });
  handle("board:resume", (input) =>
    envelope(() => requireBoard().resumeTask((input as { taskId: never }).taskId)),
  );
  handle("board:reconcile", (input) => {
    const value = input as { projectId: never; resume?: boolean };
    return envelope(() =>
      requireBoard().reconcile(value.projectId, { resume: value.resume === true }),
    );
  });
  handle("board:handoff", (input) =>
    envelope(() => requireBoard().handoff((input as { projectId: never }).projectId)),
  );
  handle("board:attempt", (input) => {
    const value = input as {
      projectId: never;
      taskId?: never | null;
      requirement: string;
      symptom: string;
      hypothesis: string;
      action: string;
      observed: string;
      materialProgress: boolean;
      evidence?: string[];
      reason?: string | null;
      helpNeeded?: string | null;
      actor?: "agent" | "human" | "mona_queue";
    };
    return envelope(() =>
      requireBoard().recordAttempt({
        ...value,
        taskId: value.taskId ?? null,
      }),
    );
  });
  handle("board:problem-acknowledge", (input) => {
    const value = input as { problemId: string; note?: string | null };
    return envelope(() => requireBoard().acknowledgeProblem(value.problemId, value.note));
  });
  handle("board:problem-resolve", (input) => {
    const value = input as { problemId: string; resolution: string; evidence?: string[] };
    return envelope(() =>
      requireBoard().resolveProblem(value.problemId, {
        resolution: value.resolution,
        evidence: value.evidence,
      }),
    );
  });
  handle("board:problem-reopen", (input) => {
    const value = input as { problemId: string; reason: string; evidence: string[] };
    return envelope(() =>
      requireBoard().reopenProblem(value.problemId, {
        reason: value.reason,
        evidence: value.evidence,
      }),
    );
  });
  handle("board:dispatch-next", (input) => {
    const value = input as { projectId: never };
    return envelope(async () => {
      const board = requireBoard();
      const studio = dependencies.studio;
      if (!studio) {
        throw Object.assign(
          new Error("the live studio is unavailable because project state did not open"),
          { code: "RUNTIME_UNAVAILABLE" },
        );
      }
      return board.runOnce(
        value.projectId,
        async ({ preview }) => {
          const result = await studio.submit(value.projectId, {
            prompt: preview.text,
            mode: "work",
          });
          if (result.outcome === "accepted") {
            return {
              accepted: true,
              note: `turn ${result.turnId ?? "accepted"}`,
              turnId: result.turnId ?? null,
            };
          }
          return {
            accepted: false,
            outcomeUnknown: result.outcome === "outcome_unknown",
            note: result.note ?? result.outcome,
          };
        },
        {
          owner: "mona_queue",
          preflight: async () => {
            // A user-set budget blocks the next dispatch before any task run
            // starts, so a refusal is never mistaken for an unknown outcome.
            if (dependencies.cost) {
              const gate = await dependencies.cost.dispatchGate(
                value.projectId,
                new Date().toISOString(),
              );
              if (!gate.allowed) return gate.reasons.join(" ");
            }
            const snapshot = await studio.snapshot(value.projectId);
            if (snapshot.pauseAfterTask) {
              return "the Mona queue is paused after the current task; resume the queue before starting new work";
            }
            if (snapshot.activeTurnId) {
              return "a mutating turn is already active in this workspace";
            }
            if (snapshot.connection.state === "running" && !snapshot.canSubmit) {
              return snapshot.cannotSubmitReason ?? "the studio cannot submit right now";
            }
            return null;
          },
        },
      );
    });
  });

  // ------------------------------------------------------------- cost ledger
  const requireCost = (): CostLedger => {
    const cost = dependencies.cost;
    if (!cost) {
      throw Object.assign(
        new Error("the cost ledger is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return cost;
  };

  handle("cost:ledger", (input) => {
    const value = input as {
      projectId: never;
      since?: string | null;
      until?: string | null;
      timeZone?: string;
      format?: "view" | "json" | "csv";
    };
    return envelope(async () => {
      const ledger = requireCost();
      const options = {
        since: value.since ?? null,
        until: value.until ?? null,
        ...(value.timeZone ? { timeZone: value.timeZone } : {}),
      };
      if (value.format === "json" || value.format === "csv") {
        return ledger.exportLedger(value.projectId, { ...options, format: value.format });
      }
      return ledger.ledger(value.projectId, options);
    });
  });
  handle("cost:budget-set", (input) => {
    const value = input as {
      projectId: never;
      scope: "session" | "project" | "day";
      limitUsd: number;
      warnUsd?: number | null;
      enabled?: boolean;
      timeZone?: string;
      expectedRevision?: number;
    };
    return envelope(() => requireCost().setBudget(value));
  });
  handle("cost:budget-clear", (input) => {
    const value = input as {
      projectId: never;
      budgetId: string;
      expectedRevision?: number;
    };
    return envelope(() => requireCost().clearBudget(value));
  });
  handle("cost:rate-set", (input) => {
    const value = input as {
      provider: string;
      model: string;
      cacheHitPerMillion: number | null;
      cacheMissPerMillion: number | null;
      outputPerMillion: number | null;
      toolCallPerMillion?: number | null;
      reasoningInOutput?: boolean;
      sourceRef?: string | null;
    };
    return envelope(() => requireCost().setRateCard(value));
  });
  handle("cost:recalc-preview", (input) => {
    const value = input as {
      projectId: never;
      provider: string;
      model: string;
      cacheHitPerMillion: number | null;
      cacheMissPerMillion: number | null;
      outputPerMillion: number | null;
      reasoningInOutput?: boolean;
    };
    return envelope(() => requireCost().previewRecalculation(value.projectId, value));
  });
  handle("cost:export-file", (input) => {
    const value = input as { projectId: never; format: "json" | "csv" };
    return envelope(() => dependencies.exportCostFile(value.projectId, value.format));
  });

  // --------------------------------------------- changes, Git, and restore
  const requireChanges = (): ChangeLedger => {
    const changes = dependencies.changes;
    if (!changes) {
      throw Object.assign(
        new Error("the changes surface is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return changes;
  };

  handle("changes:snapshot", (input) => {
    const value = input as { projectId: never; limit?: number };
    return envelope(() => requireChanges().snapshot(value.projectId, { limit: value.limit }));
  });
  handle("changes:refresh", (input) =>
    envelope(() => requireChanges().refresh((input as { projectId: never }).projectId)),
  );
  handle("changes:file", (input) => {
    const value = input as {
      projectId: never;
      changeSetId?: string;
      path: string;
      mode: "text" | "diff";
      offset?: number;
      limit?: number;
    };
    return envelope(() => requireChanges().fileWindow(value));
  });
  handle("changes:artifact", (input) => {
    const value = input as {
      projectId: never;
      changeSetId: string;
      artifactId: string;
      offset?: number;
      limit?: number;
    };
    return envelope(() => requireChanges().artifactWindow(value));
  });
  handle("changes:restore-preview", (input) => {
    const value = input as { projectId: never; changeSetId: string; paths: string[] };
    return envelope(() => requireChanges().restorePreview(value));
  });
  handle("changes:restore", (input) => {
    const value = input as {
      projectId: never;
      changeSetId: string;
      paths: string[];
      expected: Array<{ path: string; expectedHash: string }>;
      acknowledge?: string[];
    };
    return envelope(() =>
      requireChanges().restore({ ...value, acknowledge: value.acknowledge ?? [] }),
    );
  });
  handle("changes:git-stage", (input) => {
    const value = input as { projectId: never; paths: string[] };
    return envelope(() => requireChanges().stagePaths(value));
  });
  handle("changes:git-commit", (input) => {
    const value = input as {
      projectId: never;
      message: string;
      paths: string[];
      includeUnstaged?: boolean;
    };
    return envelope(() => requireChanges().commitPaths(value));
  });
  handle("changes:write-file", (input) => {
    const value = input as {
      projectId: never;
      path: string;
      content: string;
      expectedRevision: string;
    };
    return envelope(() => requireChanges().writeFile(value));
  });
  handle("changes:reveal", (input) => {
    const value = input as { projectId: never; path: string };
    return envelope(() => dependencies.revealWorkspacePath(value.projectId, value.path));
  });

  // ----------------------------------------------------------- daily polish
  const requirePolish = (): PolishService => {
    const polish = dependencies.polish;
    if (!polish) {
      throw Object.assign(
        new Error("the polish surface is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return polish;
  };

  handle("polish:digest", (input) => {
    const value = input as { projectId: never };
    return envelope(() => requirePolish().digestView(value.projectId));
  });
  handle("polish:mark-seen", (input) => {
    const value = input as { projectId: never };
    return envelope(() => requirePolish().markSeen(value.projectId));
  });
  handle("polish:status", () => envelope(() => requirePolish().status()));
  handle("polish:refresh", (input) => {
    const value = input as { projectId: never };
    return envelope(() => requirePolish().refresh(value.projectId));
  });
  handle("polish:preferences-set", (input) => {
    const value = input as { patch: Parameters<PolishService["setPreferences"]>[0] };
    return envelope(() => requirePolish().setPreferences(value.patch));
  });
  handle("polish:identity", (input) => {
    const value = input as {
      projectId: never;
      accent: Parameters<PolishService["identity"]>[1]["accent"];
      monogram: string | null;
      expectedRevision: number;
    };
    return envelope(() =>
      requirePolish().identity(
        value.projectId,
        { accent: value.accent, monogram: value.monogram },
        value.expectedRevision,
      ),
    );
  });
  handle("polish:favorites", () => envelope(() => requirePolish().favorites()));
  handle("polish:favorite-save", (input) => {
    const value = input as { label: string; text: string };
    return envelope(() => requirePolish().saveFavorite(value));
  });
  handle("polish:favorite-remove", (input) =>
    envelope(() => requirePolish().removeFavorite((input as { id: string }).id)),
  );
  handle("polish:notification-test", () => envelope(() => requirePolish().notifyTest()));
  const requireAgents = (): AgentObservatory => {
    const agents = dependencies.agents;
    if (!agents) {
      throw Object.assign(
        new Error("the agent observatory is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return agents;
  };
  handle("agents:observatory", (input) =>
    envelope(() => requireAgents().snapshot((input as { projectId: never }).projectId)),
  );
  handle("agents:fleet-detail", (input) => {
    const value = input as { projectId: never; runId: string };
    return envelope(() => requireAgents().fleetDetail(value.projectId, value.runId));
  });
  handle("agents:fleet-evidence", (input) => {
    const value = input as { projectId: never; runId: string; taskId: string };
    return envelope(() =>
      requireAgents().fleetEvidence(value.projectId, value.runId, value.taskId),
    );
  });
  handle("agents:history", (input) => {
    const value = input as { projectId: never; limit?: number };
    return envelope(() => requireAgents().history(value.projectId, value.limit ?? 50));
  });
  handle("agents:run-cancel", (input) => {
    const value = input as { projectId: never; runId: string };
    return envelope(() => requireAgents().cancelAgentRun(value.projectId, value.runId));
  });
  handle("agents:fleet-control", (input) => {
    const value = input as { projectId: never; runId: string; action: "stop" };
    return envelope(() =>
      requireAgents().controlFleetRun(value.projectId, value.runId, value.action),
    );
  });
  handle("agents:worker-control", (input) => {
    const value = input as { projectId: never; workerId: string; action: "stop" | "restart" };
    return envelope(() =>
      requireAgents().controlWorker(value.projectId, value.workerId, value.action),
    );
  });
  handle("agents:goal-set", (input) => {
    const value = input as { projectId: never; threadId: string; objective: string };
    return envelope(() =>
      requireAgents().setGoal(value.projectId, value.threadId, value.objective),
    );
  });
  handle("agents:goal-complete", (input) => {
    const value = input as { projectId: never; threadId: string };
    return envelope(() => requireAgents().completeGoal(value.projectId, value.threadId));
  });
  handle("agents:goal-block", (input) => {
    const value = input as { projectId: never; threadId: string; reason?: string | null };
    return envelope(() =>
      requireAgents().blockGoal(value.projectId, value.threadId, value.reason ?? null),
    );
  });
  handle("agents:goal-clear", (input) => {
    const value = input as { projectId: never; threadId: string };
    return envelope(() => requireAgents().clearGoal(value.projectId, value.threadId));
  });
  handle("agents:launch-fleet", (input) => {
    const value = input as {
      projectId: never;
      taskId: never;
      expectedRevision?: number;
      name: string;
      role:
        | "manager"
        | "operator"
        | "scout"
        | "builder"
        | "reviewer"
        | "verifier"
        | "consultant"
        | "synthesizer"
        | "worker"
        | "planner"
        | "custom";
      instructions: string;
      parallelism: "serial";
    };
    return envelope(() => requireAgents().launchFleet(value.projectId, value as never));
  });

  // P18: integrated terminal. Bytes only; a session cannot reach the engine,
  // the board, or the workspace through this layer.
  const requireTerminal = (): TerminalManager => {
    const terminal = dependencies.terminal;
    if (!terminal) {
      throw Object.assign(
        new Error(
          "the terminal is unavailable on this host (the native mona-pty helper is missing)",
        ),
        { code: "TERMINAL_UNAVAILABLE" },
      );
    }
    return terminal;
  };

  handle("terminal:snapshot", () => envelope(() => requireTerminal().snapshot()));
  handle("terminal:create", (input) => {
    const value = input as { projectId?: never | null; cols?: number; rows?: number };
    return envelope(() => requireTerminal().create(value));
  });
  handle("terminal:write", (input) => {
    const value = input as { sessionId: string; data: string; encoding?: "text" | "base64" };
    return envelope(() => ({
      written: requireTerminal().write(value.sessionId, value.data, value.encoding ?? "text"),
    }));
  });
  handle("terminal:resize", (input) => {
    const value = input as { sessionId: string; cols: number; rows: number };
    return envelope(() => requireTerminal().resize(value.sessionId, value.cols, value.rows));
  });
  handle("terminal:close", (input) => {
    const value = input as { sessionId: string };
    return envelope(() => requireTerminal().close(value.sessionId));
  });
  handle("terminal:output", (input) => {
    const value = input as { sessionId: string; cursor?: number; maxBytes?: number };
    return envelope(() =>
      requireTerminal().output(value.sessionId, value.cursor ?? 0, value.maxBytes),
    );
  });
  handle("terminal:search", (input) => {
    const value = input as { sessionId: string; query: string };
    return envelope(() => requireTerminal().search(value.sessionId, value.query));
  });
  handle("terminal:log", (input) => {
    const value = input as { projectId: never; maxBytes?: number };
    return envelope(() => requireTerminal().log(value));
  });

  const requireCapabilities = (): CapabilityExplorer => {
    const explorer = dependencies.capabilities;
    if (!explorer) {
      throw Object.assign(
        new Error("the capability explorer is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return explorer;
  };

  handle("capability:snapshot", () => envelope(() => requireCapabilities().snapshot()));
  handle("capability:refresh", () => envelope(() => requireCapabilities().refresh()));
  handle("capability:report", () => envelope(() => requireCapabilities().report()));
  handle("commands:catalog", () => {
    const catalog = dependencies.commands;
    if (!catalog) {
      throw Object.assign(new Error("the command catalog is unavailable"), {
        code: "RUNTIME_UNAVAILABLE",
      });
    }
    return envelope(() => catalog.snapshot());
  });
  handle("commands:execute", (input) => {
    const catalog = dependencies.commands;
    if (!catalog) {
      throw Object.assign(new Error("the command catalog is unavailable"), {
        code: "RUNTIME_UNAVAILABLE",
      });
    }
    const dispatch = new CommandDispatchService({ catalog, studio: requireStudio() });
    return envelope(() =>
      dispatch.execute(input as Parameters<CommandDispatchService["execute"]>[0]),
    );
  });

  // P19: project memory, prompt shelf, handoff, and diagnostics. Each handler
  // maps to one validated channel; the workbench classes own the logic and the
  // dialogs stay in the main entry point.
  const requireMemory = (): ProjectMemory => {
    const memory = dependencies.memory;
    if (!memory) {
      throw Object.assign(
        new Error("project memory is unavailable because project state did not open"),
        { code: "RUNTIME_UNAVAILABLE" },
      );
    }
    return memory;
  };
  const requireShelf = (): PromptShelf => {
    const shelf = dependencies.shelf;
    if (!shelf) {
      throw Object.assign(new Error("the prompt shelf is unavailable on this host"), {
        code: "RUNTIME_UNAVAILABLE",
      });
    }
    return shelf;
  };
  const requireHandoff = (): ProjectHandoff => {
    const handoff = dependencies.handoff;
    if (!handoff) {
      throw Object.assign(new Error("portable handoff is unavailable on this host"), {
        code: "RUNTIME_UNAVAILABLE",
      });
    }
    return handoff;
  };
  const requireMemoryFiles = (): MemoryFileDialogs => dependencies.memoryFiles;

  handle("memory:search", (input) =>
    envelope(() =>
      requireMemory().search(
        input as { projectId: ProjectId; query: string; sources?: never; limit?: number },
      ),
    ),
  );
  handle("memory:index", (input) =>
    envelope(() => requireMemory().indexStatus((input as { projectId: ProjectId }).projectId)),
  );
  handle("memory:workspace-search", (input) =>
    envelope(() =>
      requireMemory().searchWorkspace(input as { projectId: ProjectId; query: string }),
    ),
  );
  handle("memory:resume", (input) =>
    envelope(() => requireMemory().resumePacket((input as { projectId: ProjectId }).projectId)),
  );
  handle("memory:context-slots", (input) => {
    const value = input as { projectId: ProjectId; taskId: TaskId };
    return envelope(() => requireMemory().contextSlots(value.projectId, value.taskId));
  });
  handle("memory:context-preview", (input) =>
    envelope(() =>
      requireMemory().contextSelection(
        input as { projectId: ProjectId; taskId: TaskId; include: never },
      ),
    ),
  );

  handle("shelf:view", () => envelope(() => requireShelf().view()));
  handle("shelf:save", (input) =>
    envelope(() => requireShelf().save(input as Parameters<PromptShelf["save"]>[0])),
  );
  handle("shelf:remove", (input) =>
    envelope(() => requireShelf().remove((input as { promptId: string }).promptId)),
  );
  handle("shelf:render", (input) =>
    envelope(() => requireShelf().render(input as Parameters<PromptShelf["render"]>[0])),
  );
  handle("shelf:export", (input) =>
    envelope(() => requireShelf().exportPack(input as { name?: string; promptIds?: string[] })),
  );
  handle("shelf:export-file", (input) =>
    envelope(async () => {
      const request = input as { name?: string; promptIds?: string[] };
      const pack = await requireShelf().exportPack(request);
      const suggested = `${(request.name ?? pack.name).replace(/[^A-Za-z0-9._-]+/g, "-")}.zip`;
      return requireMemoryFiles().exportPromptPack(pack, suggested);
    }),
  );
  handle("shelf:import-file", () =>
    envelope(async () => {
      const chosen = await requireMemoryFiles().importPromptPack();
      if (!chosen.value) return null;
      return requireShelf().importPack(chosen.value);
    }),
  );

  handle("handoff:preview", (input) =>
    envelope(() => requireHandoff().preview((input as { projectId: ProjectId }).projectId)),
  );
  handle("handoff:export-file", (input) =>
    envelope(() =>
      requireMemoryFiles().exportHandoff((input as { projectId: ProjectId }).projectId),
    ),
  );
  handle("handoff:choose", (input) =>
    envelope(() => requireMemoryFiles().chooseBundle("handoff", (input as { path?: string }).path)),
  );
  handle("handoff:inspect", (input) =>
    envelope(() => requireHandoff().inspect((input as { path: string }).path)),
  );
  handle("handoff:import", (input) =>
    envelope(() =>
      requireHandoff().importFrom(
        input as {
          path: string;
          rootPath?: string;
          mode?: "create" | "replace";
          expectedRevision?: number;
        },
      ),
    ),
  );

  handle("settings:backup-preview", () => envelope(() => requireHandoff().settingsBackup()));
  handle("settings:backup-file", () => envelope(() => requireMemoryFiles().exportSettingsBackup()));
  handle("settings:backup-choose", (input) =>
    envelope(() =>
      requireMemoryFiles().chooseBundle("settings", (input as { path?: string }).path),
    ),
  );
  handle("settings:backup-inspect", (input) =>
    envelope(() => requireHandoff().inspectSettingsBackup((input as { path: string }).path)),
  );
  handle("settings:restore", (input) =>
    envelope(() =>
      requireHandoff().restoreSettings(
        input as {
          path: string;
          mode: "merge" | "replace";
          scopes?: string[];
          expectedRevision?: number;
          confirm?: boolean;
        },
      ),
    ),
  );

  handle("diagnostics:preview", (input) =>
    envelope(() =>
      requireHandoff().diagnosticsPreview((input as { projectId?: ProjectId }).projectId ?? null),
    ),
  );
  handle("diagnostics:export-file", (input) =>
    envelope(async () => {
      const preview = await requireHandoff().diagnosticsPreview(
        (input as { projectId?: ProjectId }).projectId ?? null,
      );
      return requireMemoryFiles().exportDiagnostics(preview);
    }),
  );

  handle("polish:quit", (input) =>
    envelope(() => dependencies.quit((input as { interrupt: boolean }).interrupt)),
  );

  // P23: updates, recovery, uninstall. Reading state is local; the only action
  // that changes the machine is the verified handoff, and Installer owns the
  // privileged half of it.
  const requireUpdate = (): UpdateCoordinator => {
    if (!dependencies.update) {
      throw new StateError("CONFLICT", "the update surface is not available in this build");
    }
    return dependencies.update;
  };

  handle("update:status", () => envelope(() => requireUpdate().status()));

  handle("update:configure", (input) =>
    envelope(async () => {
      const config = await requireUpdate().configure(input);
      return { config, status: await requireUpdate().status() };
    }),
  );

  handle("update:check", (input) =>
    envelope(() =>
      requireUpdate().check({ refresh: (input as { refresh?: boolean }).refresh === true }),
    ),
  );

  handle("update:choose-package", () =>
    envelope(async () => {
      const path = await dependencies.choosePackage();
      if (path === null) return { chosen: false, view: null };
      return { chosen: true, view: await requireUpdate().inspectLocal(path) };
    }),
  );

  handle("update:inspect-local", (input) =>
    envelope(async () => {
      const supplied = (input as { path?: string }).path;
      const path = supplied ?? (await dependencies.choosePackage());
      if (path === null) throw new StateError("NOT_FOUND", "no package was chosen");
      return requireUpdate().inspectLocal(path);
    }),
  );

  handle("update:install", (input) =>
    envelope(() =>
      requireUpdate().install(
        input as {
          packagePath: string;
          expectedSha256: string;
          confirmedLocalBuild?: boolean;
        },
      ),
    ),
  );

  handle("update:confirm-engine-change", (input) =>
    envelope(() => {
      requireUpdate().confirmEngineChange((input as { packageSha256: string }).packageSha256);
      return { confirmed: true };
    }),
  );

  handle("update:cancel-intent", (input) =>
    envelope(() => requireUpdate().cancelIntent((input as { intentId: string }).intentId)),
  );

  handle("update:uninstall", () =>
    envelope(() => {
      const facts = dependencies.updateFacts();
      return uninstallView({ home: facts.home });
    }),
  );

  handle("state:recovery", () => envelope(() => dependencies.recovery()));

  handle("state:recovery-restore", (input) =>
    envelope(() => {
      const request = input as {
        snapshotPath: string;
        expectedSchemaVersion: number;
        confirmation: "restore-matching-snapshot";
      };
      // The schema in the request is the one the user was shown; the recovery
      // contract refuses a snapshot this build cannot open.
      return dependencies.restoreRecoverySnapshot({
        snapshotPath: request.snapshotPath,
        expectedSchemaVersion: request.expectedSchemaVersion,
      });
    }),
  );
}
