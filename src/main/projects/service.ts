import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  EngineSnapshot,
  EvidenceSummary,
  HistoryItemPage,
  HistoryPage,
  HistorySearchResult,
  OpenProjectResult,
  ProjectDetail,
  ProjectSummary,
  RuntimeStatusView,
  StateFacts,
  StoredEventSummary,
  TaskSummary,
  UsageSummaryView,
} from "../../shared/contracts/project-bridge";
import type { RuntimeStatus } from "../supervisor/runtime-supervisor";
import { StateError } from "../state/errors";
import type { RuntimeBinding, StateStore, StoredEvent, StoredProject } from "../state/store";

export interface ProjectServiceOptions {
  store: StateStore;
  status: () => RuntimeStatus;
  chooseFolder: () => Promise<string | null>;
  reveal: (path: string) => void;
  branch?: (path: string) => string | null;
  stateFacts?: () => StateFacts;
}

const MAX_VIEW_BYTES = 64 * 1024;

/**
 * The boundary shape of one stored frame. Identity is copied, never invented:
 * a null `itemId`/`turnId` is a fact about a row written before that identity
 * was captured, and the renderer reports it as unknown.
 */
function eventSummary(event: StoredEvent): StoredEventSummary {
  return {
    threadId: event.threadId,
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    timestamp: event.timestamp,
    turnId: event.turnId ?? null,
    itemId: event.itemId ?? null,
  };
}

function summary(project: StoredProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    canonicalPath: project.canonicalPath,
    repositoryKind: project.repositoryKind,
    repositoryRoot: project.repositoryRoot,
    worktreeName: project.worktreeName,
    accent: project.accent,
    monogram: project.monogram,
    archived: project.archived,
    pinned: project.pinned,
    removedAt: project.removedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    revision: project.revision,
  };
}

export function readGitBranch(path: string): string | null {
  try {
    const branch = execFileSync("/usr/bin/git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch.length > 0 && branch.length <= 200 ? branch : null;
  } catch {
    return null;
  }
}

function stableThreadId(projectId: ProjectId): string {
  return `thr_${createHash("sha256").update(projectId).digest("hex").slice(0, 16)}`;
}

function bindingView(binding: RuntimeBinding | null): EngineSnapshot["binding"] {
  if (!binding) return null;
  return {
    workspace: binding.workspace,
    canonicalWorkspace: binding.canonicalWorkspace,
    executable: binding.executable,
    engineVersion: binding.engineVersion,
    engineCommit: binding.engineCommit,
    port: binding.port,
    state: binding.state,
    updatedAt: binding.updatedAt,
  };
}

export function engineSnapshot(
  status: RuntimeStatus,
  binding: RuntimeBinding | null,
  project: StoredProject,
): EngineSnapshot {
  const sameWorkspace =
    status.state === "running" &&
    status.workspace !== null &&
    (status.workspace === project.canonicalPath || status.workspace === project.rootPath);
  const runningElsewhere = status.state === "running" && !sameWorkspace;
  const blockedReason = sameWorkspace
    ? null
    : runningElsewhere
      ? "The running runtime serves a different workspace. Mona owns one runtime per user store."
      : status.state === "starting"
        ? "The runtime is starting. Execution waits for a verified listener."
        : status.state === "reconnecting"
          ? "The runtime is reconnecting. Wait for the health probe."
          : status.state === "failed"
            ? "The runtime failed to start. Inspect the typed failure before retrying."
            : binding
              ? "This project is bound, but its runtime is not running."
              : "No runtime is bound to this project yet.";
  return {
    state: status.state,
    reason: status.reason,
    owned: sameWorkspace && !status.external,
    external: status.external,
    workspace: status.workspace,
    port: status.port ?? binding?.port ?? null,
    engineVersion: status.engine?.version ?? binding?.engineVersion ?? null,
    engineCommit: status.engine?.commit ?? binding?.engineCommit ?? null,
    executable: binding?.executable ?? null,
    executablePresent: binding ? existsSync(binding.executable) : false,
    canExecute: sameWorkspace,
    blockedReason,
    binding: bindingView(binding),
  };
}

export function runtimeStatusView(status: RuntimeStatus): RuntimeStatusView {
  return {
    state: status.state,
    reason: status.reason,
    since: status.since,
    workspace: status.workspace,
    port: status.port,
    engine: status.engine ? { version: status.engine.version, commit: status.engine.commit } : null,
    external: status.external,
    restarts: status.restarts,
    lastFailure: status.lastFailure
      ? {
          code: status.lastFailure.code,
          message: status.lastFailure.message,
          action: status.lastFailure.action,
        }
      : null,
  };
}

/**
 * The catalog and shell service. It reads the transactional store and the
 * supervisor's real status; it never starts a runtime and never spends
 * inference. Opening a project registers it, creates at most one local shell
 * thread projection, and does not resume unfinished work.
 */
export class ProjectService {
  private readonly store: StateStore;
  private readonly status: () => RuntimeStatus;
  private readonly chooseFolder: () => Promise<string | null>;
  private readonly reveal: (path: string) => void;
  private readonly branch: (path: string) => string | null;
  private readonly facts: () => StateFacts;

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.status = options.status;
    this.chooseFolder = options.chooseFolder;
    this.reveal = options.reveal;
    this.branch = options.branch ?? readGitBranch;
    this.facts =
      options.stateFacts ??
      (() => ({
        open: true,
        database: this.store.path,
        projects: 0,
        tasks: 0,
        events: 0,
        artifacts: 0,
        integrity: [],
        permissionProblems: [],
      }));
  }

  async list(
    options: { query?: string; includeArchived?: boolean } = {},
  ): Promise<ProjectSummary[]> {
    const projects = await this.store.listProjects({
      query: options.query,
      includeArchived: options.includeArchived,
    });
    return projects.map(summary);
  }

  /** Catalog entry for one project, used by the open dispatcher's result. */
  async summaryById(id: ProjectId): Promise<ProjectSummary> {
    const project = await this.store.getProject(id, { includeRemoved: true });
    if (!project) {
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    }
    return summary(project);
  }

  async open(rootPath?: string): Promise<OpenProjectResult | null> {
    const path = rootPath ?? (await this.chooseFolder());
    if (!path) return null;
    const result = await this.store.openProject(path);
    await this.ensureThread(result.project);
    return { project: summary(result.project), created: result.created };
  }

  async detail(id: ProjectId): Promise<ProjectDetail> {
    const project = await this.store.getProject(id);
    if (!project)
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    const thread = await this.ensureThread(project);
    const [
      tasks,
      dependencies,
      threads,
      usage,
      usageByModel,
      evidence,
      view,
      draft,
      binding,
      page,
    ] = await Promise.all([
      this.store.listTasks(id),
      this.store.listDependencies(id),
      this.store.listThreads(id),
      this.store.summarizeUsage(id),
      this.store.usageByModel(id),
      this.store.listRequirementEvidence(id),
      this.store.getSettings(`view:${id}`),
      this.store.getDraft(id, thread.id),
      this.store.getRuntimeBinding(id),
      this.store.readProjectHistoryPage({ projectId: id, limit: 200 }),
    ]);
    const taskSummaries: TaskSummary[] = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      revision: task.revision,
      dependsOn: dependencies
        .filter((dependency) => dependency.taskId === task.id)
        .map((dependency) => dependency.dependsOnTaskId),
    }));
    const usageView: UsageSummaryView = {
      turns: usage.turns,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      costUsd: usage.costUsd,
      costComplete: usage.costComplete,
      observed: usage.observed,
      byModel: usageByModel,
    };
    const evidenceView: EvidenceSummary[] = evidence.map((entry) => ({
      requirementId: entry.requirementId,
      path: entry.path,
      note: entry.note,
      createdAt: entry.createdAt,
    }));
    return {
      project: summary(project),
      tasks: taskSummaries,
      dependencies,
      threads: threads.map((entry) => ({
        id: entry.id,
        title: entry.title,
        engineThreadId: entry.engineThreadId,
        updatedAt: entry.updatedAt,
      })),
      currentThreadId: thread.id,
      draft: draft === null ? null : { threadId: thread.id, text: draft },
      events: page.events.map(eventSummary),
      history: {
        olderCursor: page.olderCursor,
        hasMore: page.hasMore,
        storedTotal: page.storedTotal,
        pageSize: page.events.length,
      },
      usage: usageView,
      evidence: evidenceView,
      view: view?.value ?? null,
      branch: this.branch(project.rootPath),
      engine: engineSnapshot(this.status(), binding, project),
    };
  }

  /**
   * Read one older page of stored history. This is a read of Mona's own state:
   * it starts no runtime and makes no provider request.
   */
  async history(
    id: ProjectId,
    options: {
      before?: { recordedAt: string; rowId: number } | null;
      limit?: number;
      threadId?: string | null;
    } = {},
  ): Promise<HistoryPage> {
    const project = await this.store.getProject(id);
    if (!project) {
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    }
    const threadId = options.threadId ?? null;
    if (threadId !== null) {
      const threads = await this.store.listThreads(id);
      if (!threads.some((entry) => entry.id === threadId)) {
        throw new StateError("CONFLICT", "thread does not belong to this project", { threadId });
      }
    }
    const page = await this.store.readProjectHistoryPage({
      projectId: id,
      limit: options.limit,
      before: options.before ?? null,
      threadId,
    });
    return {
      events: page.events.map(eventSummary),
      olderCursor: page.olderCursor,
      hasMore: page.hasMore,
      storedTotal: page.storedTotal,
      pageSize: page.events.length,
      threadId,
    };
  }

  /**
   * Every stored frame of one item, so a card whose beginning predates the page
   * can be rebuilt from storage instead of from an inference. Reads only.
   */
  async historyItem(id: ProjectId, threadId: string, itemId: string): Promise<HistoryItemPage> {
    const project = await this.store.getProject(id);
    if (!project) {
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    }
    const threads = await this.store.listThreads(id);
    if (!threads.some((entry) => entry.id === threadId)) {
      throw new StateError("CONFLICT", "thread does not belong to this project", { threadId });
    }
    const result = await this.store.readItemEvents({ threadId, itemId });
    return {
      threadId,
      itemId,
      events: result.events.map(eventSummary),
      truncated: result.truncated,
      storedCount: result.storedCount,
    };
  }

  /**
   * R10. Search this project's stored conversation text. A read of Mona's own
   * state: no runtime, no model, and the query never leaves the process.
   */
  async searchEvents(
    id: ProjectId,
    query: string,
    options: { limit?: number; threadId?: string | null } = {},
  ): Promise<HistorySearchResult> {
    const project = await this.store.getProject(id);
    if (!project) {
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    }
    if (options.threadId) {
      const threads = await this.store.listThreads(id);
      if (!threads.some((entry) => entry.id === options.threadId)) {
        throw new StateError("CONFLICT", "thread does not belong to this project", {
          threadId: options.threadId,
        });
      }
    }
    const hits = await this.store.searchProjectEvents({
      projectId: id,
      query,
      limit: options.limit,
      threadId: options.threadId ?? null,
    });
    return { query: query.trim(), hits, scannedAt: new Date().toISOString() };
  }

  async rename(id: ProjectId, name: string, expectedRevision: number): Promise<ProjectSummary> {
    return summary(await this.store.renameProject(id, name, expectedRevision));
  }

  async setPinned(
    id: ProjectId,
    pinned: boolean,
    expectedRevision: number,
  ): Promise<ProjectSummary> {
    return summary(await this.store.setProjectPinned(id, pinned, expectedRevision));
  }

  async setArchived(
    id: ProjectId,
    archived: boolean,
    expectedRevision: number,
  ): Promise<ProjectSummary> {
    return summary(await this.store.setProjectArchived(id, archived, expectedRevision));
  }

  async remove(id: ProjectId, expectedRevision: number): Promise<ProjectSummary> {
    const removed = await this.store.removeProjectFromCatalog(id, expectedRevision);
    await this.store.clearRuntimeBinding(id);
    return summary(removed);
  }

  async relocate(id: ProjectId, expectedRevision: number): Promise<ProjectSummary | null> {
    const path = await this.chooseFolder();
    if (!path) return null;
    return summary(await this.store.relocateProject(id, path, expectedRevision));
  }

  async revealProject(id: ProjectId): Promise<void> {
    const project = await this.store.getProject(id, { includeRemoved: true });
    if (!project)
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    this.reveal(project.rootPath);
  }

  async saveView(id: ProjectId, view: Record<string, unknown>): Promise<void> {
    const serialized = JSON.stringify(view);
    if (serialized.length > MAX_VIEW_BYTES) {
      throw new StateError("CONFLICT", "project view state is too large", {
        bytes: serialized.length,
        max: MAX_VIEW_BYTES,
      });
    }
    await this.store.putSettings(`view:${id}`, view);
  }

  async saveDraft(id: ProjectId, threadId: string, text: string): Promise<void> {
    const project = await this.store.getProject(id);
    if (!project)
      throw new StateError("NOT_FOUND", "project is not in the catalog", { projectId: id });
    const threads = await this.store.listThreads(id);
    const thread = threads.find((entry) => entry.id === threadId);
    if (!thread) {
      throw new StateError("CONFLICT", "draft thread does not belong to this project", {
        threadId,
      });
    }
    if (text.trim().length === 0) {
      await this.store.deleteDraft(id, thread.id);
      return;
    }
    await this.store.putDraft(id, thread.id, text);
  }

  async stateFacts(): Promise<StateFacts> {
    const stats = await this.store.stats();
    const base = this.facts();
    return {
      ...base,
      open: true,
      database: this.store.path,
      projects: stats.projects,
      tasks: stats.tasks,
      events: stats.events,
      artifacts: stats.artifacts,
      integrity: stats.integrity,
    };
  }

  private async ensureThread(project: StoredProject): Promise<{ id: string; updatedAt: string }> {
    const threads = await this.store.listThreads(project.id);
    // The project's own shell thread has a deterministic id. Prefer it over
    // "most recently updated", which an archived engine thread can win and
    // thereby look like the current conversation.
    const localId = stableThreadId(project.id);
    const existing = threads.find((entry) => entry.id === localId) ?? threads[0];
    if (existing) return { id: existing.id, updatedAt: existing.updatedAt };
    const thread = await this.store.upsertThread({
      id: localId,
      projectId: project.id as ProjectId,
      title: "Local shell thread",
    });
    return { id: thread.id, updatedAt: thread.updatedAt };
  }
}
