import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProductPaths } from "./state/paths";

export interface AppPaths {
  support: string;
  cache: string;
  logs: string;
  state: string;
  database: string;
  backups: string;
  artifacts: string;
  projects: string;
}

/**
 * Per-user storage. `userData`, `cache`, and `logs` are the OS-scoped
 * Application Support, Caches, and Logs directories; Mona never writes product
 * state into the workspace or a cloud-synced folder. The database path and its
 * permissions come from the state layer, which also rejects cloud-synced and
 * network locations.
 */
export function resolveAppPaths(): AppPaths {
  const product = resolveProductPaths({
    home: app.getPath("home"),
    appName: app.getName(),
    supportDir: app.getPath("userData"),
  });
  const projects = join(product.support, "projects");
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  return {
    support: product.support,
    cache: product.cache,
    logs: product.logs,
    state: product.state,
    database: product.database,
    backups: product.backups,
    artifacts: product.artifacts,
    projects,
  };
}
