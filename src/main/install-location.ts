import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Where this copy of Mona is running from. The installer always owns
 * `/Applications/Mona.app`; a packaged copy elsewhere (for example a developer
 * build) is allowed to run, but not silently alongside the installed one.
 */
export const STANDARD_APP_PATH = "/Applications/Mona.app";

export interface InstallLocation {
  bundlePath: string;
  standardPath: string;
  atStandardLocation: boolean;
  installedCopyPresent: boolean;
  /** A packaged copy outside /Applications while the installed copy exists. */
  duplicate: boolean;
}

export function inspectInstallLocation(options: {
  bundlePath: string;
  packaged: boolean;
  standardPath?: string;
  exists?: (path: string) => boolean;
}): InstallLocation {
  const standardPath = options.standardPath ?? STANDARD_APP_PATH;
  const exists = options.exists ?? existsSync;
  const bundlePath = resolve(options.bundlePath);
  const installedCopyPresent = exists(standardPath);
  const atStandardLocation = bundlePath === resolve(standardPath);
  return {
    bundlePath,
    standardPath,
    atStandardLocation,
    installedCopyPresent,
    duplicate: options.packaged && installedCopyPresent && !atStandardLocation,
  };
}
