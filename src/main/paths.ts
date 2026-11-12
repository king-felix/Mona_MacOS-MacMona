import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppPaths {
  support: string;
  cache: string;
  logs: string;
  state: string;
  projects: string;
}

/**
 * Per-user storage. `userData`, `cache`, and `logs` are the OS-scoped
 * Application Support, Caches, and Logs directories; Mona never writes product
 * state into the workspace or a cloud-synced folder.
 */
export function resolveAppPaths(): AppPaths {
  const support = app.getPath("userData");
  // Electron 45 no longer exposes a "cache" path; macOS caches live here.
  const cache = join(app.getPath("home"), "Library", "Caches", app.getName());
  const logs = app.getPath("logs");
  const state = join(support, "state");
  const projects = join(support, "projects");
  for (const dir of [support, cache, logs, state, projects]) {
    mkdirSync(dir, { recursive: true });
  }
  return { support, cache, logs, state, projects };
}
