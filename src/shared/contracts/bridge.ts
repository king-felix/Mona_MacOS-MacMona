import type { ProjectId } from "./ids";
import type {
  IpcResult,
  OpenProjectResult,
  ProjectDetail,
  ProjectSummary,
  RuntimeStatusView,
  StateFacts,
} from "./project-bridge";
import type { UsageEvidence } from "./usage";

/** The complete, narrow surface the renderer may reach. Nothing else is exposed. */
export interface MonaBridge {
  getAppInfo(): Promise<AppInfo>;
  getPaths(): Promise<AppPathInfo>;
  discoverTools(names?: string[]): Promise<ToolDiscovery[]>;

  listProjects(query?: string, includeArchived?: boolean): Promise<IpcResult<ProjectSummary[]>>;
  openProject(rootPath?: string): Promise<IpcResult<OpenProjectResult | null>>;
  projectDetail(id: ProjectId): Promise<IpcResult<ProjectDetail>>;
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
