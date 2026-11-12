import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Navigation policy. The renderer is a local file document; anything that is
 * not a file inside the built renderer root is refused, including remote URLs
 * and local files outside the app.
 */
export function isAllowedNavigation(rawUrl: string, rendererRoot: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "file:") return false;
  let pathname: string;
  try {
    pathname = fileURLToPath(url);
  } catch {
    return false;
  }
  const root = resolve(rendererRoot);
  const target = resolve(pathname);
  return target === root || target.startsWith(root + sep);
}

export function denyWindowOpen(): { action: "deny" } {
  return { action: "deny" };
}

/** Pure lifecycle policy: closing the last window does not quit on macOS. */
export function shouldQuitOnWindowAllClosed(platform: string): boolean {
  return platform !== "darwin";
}
