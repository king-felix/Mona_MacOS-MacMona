import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { discoverTools } from "./tool-discovery";
import { resolveAppPaths } from "./paths";
import { validateIpc, type IpcChannel } from "./ipc-contract";
import { isAllowedNavigation } from "./navigation";
import { StateError } from "./state/errors";
import type { ProjectService } from "./projects/service";
import type { WorkStudio } from "./work/studio";
import type { TaskBoard } from "./work/board";
import type { CostLedger } from "./work/costs";
import type { ProjectId } from "../shared/contracts/ids";
import type { ImportPlanResult } from "../shared/contracts/board";
import type { IpcResult, RuntimeStatusView, StateFacts } from "../shared/contracts/project-bridge";
import type {
  FolderRequestSource,
  OpenResult,
  OpenStatusView,
  ServiceStatus,
} from "../shared/contracts/open";

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

export interface IpcDependencies {
  projects: ProjectService;
  runtimeStatus: () => RuntimeStatusView;
  stateFacts: () => Promise<StateFacts>;
  studio: WorkStudio | null;
  board: TaskBoard | null;
  cost: CostLedger | null;
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
    const candidate = error as { code?: string; message?: string };
    return {
      ok: false,
      error: {
        code: typeof candidate.code === "string" ? candidate.code : "INTERNAL",
        message: candidate.message ?? String(error),
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
}
