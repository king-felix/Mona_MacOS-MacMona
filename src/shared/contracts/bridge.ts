import type { UsageEvidence } from "./usage";

/** The complete, narrow surface the renderer may reach. Nothing else is exposed. */
export interface MonaBridge {
  getAppInfo(): Promise<AppInfo>;
  getPaths(): Promise<AppPathInfo>;
  discoverTools(names?: string[]): Promise<ToolDiscovery[]>;
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
