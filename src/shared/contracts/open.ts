import type { ProjectSummary } from "./project-bridge";

/**
 * Open-path contracts shared by main, preload, and the renderer.
 *
 * `runtimeStarted` and `taskCreated` are literal `false`: the open path is
 * structurally incapable of starting a runtime or creating work, and the type
 * says so where the renderer consumes it.
 */

export type FolderRequestSource =
  "service" | "argv" | "second_instance" | "open_file" | "drop" | "dialog";

export interface OpenResult {
  ok: boolean;
  source: FolderRequestSource;
  /** The path or URL exactly as it arrived. */
  input: string;
  /** Canonical, symlink-free folder path; null when refused. */
  path: string | null;
  projectId: string | null;
  projectName: string | null;
  created: boolean;
  code: string | null;
  message: string | null;
  notes: string[];
  at: string;
  runtimeStarted: false;
  taskCreated: false;
}

export type RegistrationState = "registered" | "missing" | "unknown";
export type EnabledState = "enabled" | "disabled" | "unknown";

export interface LastHandoff {
  at: string | null;
  ok: boolean;
  code: string | null;
  resolvedPath: string | null;
  device: number | null;
  inode: number | null;
  forwarded: boolean;
  invocation: string | null;
}

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  installPath: string | null;
  /** Tilde-abbreviated install path for display; never a home path in the UI. */
  installPathDisplay: string | null;
  scope: "system" | "user" | "development" | null;
  registration: RegistrationState;
  enabled: EnabledState;
  menuTitle: string;
  message: string;
  appIdentity: string;
  packaged: boolean;
  lastHandoff: LastHandoff | null;
  /** Exact user steps when the Service is not ready; empty when it is. */
  recovery: string[];
  detail: string[];
  checkedAt: string;
}

export interface OpenStatusView {
  last: OpenResult | null;
  service: ServiceStatus;
}

/** Result of an externally supplied folder, with the catalog entry it selected. */
export interface OpenFolderView {
  project: ProjectSummary;
  created: boolean;
  result: OpenResult;
}
