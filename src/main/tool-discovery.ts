import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ToolDiscovery } from "../shared/contracts/bridge";

/**
 * GUI-launched apps inherit a minimal PATH (usually `/usr/bin:/bin:...`), so a
 * Finder launch cannot rely on Homebrew. Search the inherited PATH first, then
 * the well-known developer locations.
 */
export const WELL_KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

const TOOL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface DiscoveryOptions {
  envPath?: string;
  wellKnownDirs?: string[];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function discoverTool(name: string, options: DiscoveryOptions = {}): ToolDiscovery {
  if (!TOOL_NAME.test(name)) {
    return { name, path: null, source: "missing" };
  }
  const envPath = options.envPath ?? process.env.PATH ?? "";
  const wellKnownDirs = options.wellKnownDirs ?? WELL_KNOWN_DIRS;
  const pathDirs = envPath.split(delimiter).filter((dir) => dir.length > 0 && isAbsolute(dir));

  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return { name, path: candidate, source: "environment_path" };
  }
  for (const dir of wellKnownDirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return { name, path: candidate, source: "well_known" };
  }
  return { name, path: null, source: "missing" };
}

export function discoverTools(names: string[]): ToolDiscovery[] {
  return names.map((name) => discoverTool(name));
}
