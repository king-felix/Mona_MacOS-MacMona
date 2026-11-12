import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FolderRequestSource } from "../../shared/contracts/open";

/**
 * One validator for every way a folder can arrive: a Finder Service handoff, a
 * Dock drop, a window drop, `File → Open Project…`, a second launch, or an
 * `open-file` event.
 *
 * Rules, all enforced here rather than in prose:
 *  - only local `file:` URLs and absolute POSIX paths are accepted;
 *  - `file://other-host/...` is refused (it names a server, not a folder);
 *  - the item must exist, be a directory, and be readable;
 *  - symlinks and Finder aliases are resolved to the real folder so the same
 *    directory cannot become two catalog entries;
 *  - a disk root is refused;
 *  - an empty selection is refused, never treated as "the default folder";
 *  - the path is never interpolated into a shell command anywhere downstream.
 */

export type FolderRejectionCode =
  | "EMPTY_INPUT"
  | "UNSUPPORTED_SCHEME"
  | "REMOTE_FILE_URL"
  | "MALFORMED_URL"
  | "EMBEDDED_NULL"
  | "RELATIVE_PATH"
  | "MISSING"
  | "NOT_A_DIRECTORY"
  | "NOT_READABLE"
  | "UNAVAILABLE"
  | "ROOT_VOLUME";

export interface FolderRequest {
  /** Canonical, symlink-free folder path. */
  path: string;
  /** The path exactly as it arrived, for honest reporting. */
  input: string;
  source: FolderRequestSource;
  receivedAt: string;
  notes: string[];
}

export type FolderResolution =
  | { ok: true; request: FolderRequest }
  | { ok: false; input: string; code: FolderRejectionCode; message: string };

/** Filesystem port so error mapping is testable without fault injection on a real disk. */
export interface FolderProbe {
  stat(path: string): { isDirectory(): boolean };
  realpath(path: string): string;
  access(path: string): void;
}

const realProbe: FolderProbe = {
  stat: (path) => statSync(path),
  realpath: (path) => realpathSync.native(path),
  access: (path) => accessSync(path, constants.R_OK | constants.X_OK),
};

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function rejection(input: string, code: FolderRejectionCode, message: string): FolderResolution {
  return { ok: false, input, code, message };
}

function mapFsError(input: string, error: unknown): FolderResolution {
  const candidate = error as { code?: string; message?: string };
  switch (candidate.code) {
    case "ENOENT":
    case "ENOTDIR":
      return candidate.code === "ENOTDIR"
        ? rejection(
            input,
            "NOT_A_DIRECTORY",
            "Part of that path is not a folder. Mona opens project folders.",
          )
        : rejection(
            input,
            "MISSING",
            "That folder no longer exists. It may have been moved, renamed, or unmounted.",
          );
    case "EACCES":
    case "EPERM":
      return rejection(
        input,
        "NOT_READABLE",
        "Mona cannot read that folder. Grant access in System Settings → Privacy & Security, or open a folder inside your home folder.",
      );
    case "ELOOP":
    case "ENAMETOOLONG":
      return rejection(input, "MALFORMED_URL", "That path cannot be resolved on this Mac.");
    case "EIO":
    case "ETIMEDOUT":
    case "EDEADLK":
      return rejection(
        input,
        "UNAVAILABLE",
        "That folder is not available right now — it may be an online-only cloud item or an offline volume. Download it in Finder or reconnect the volume, then try again.",
      );
    default:
      return rejection(
        input,
        "UNAVAILABLE",
        `That folder could not be read: ${candidate.message ?? String(error)}`,
      );
  }
}

/**
 * Extract a local folder path from one input. Accepts `file:` URLs and
 * absolute paths; everything else is refused with a concrete reason.
 */
export function resolveFolderRequest(
  raw: string,
  source: FolderRequestSource,
  options: { probe?: FolderProbe; now?: () => Date } = {},
): FolderResolution {
  const probe = options.probe ?? realProbe;
  const input = raw;
  if (typeof raw !== "string" || raw.length === 0 || raw.trim().length === 0) {
    return rejection(
      typeof raw === "string" ? raw : "",
      "EMPTY_INPUT",
      "Mona needs one selected folder.",
    );
  }
  if (raw.includes("\u0000")) {
    return rejection(input, "EMBEDDED_NULL", "That path contains a null character.");
  }

  const notes: string[] = [];
  let pathname: string;

  if (SCHEME_PATTERN.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return rejection(input, "MALFORMED_URL", "That file URL could not be parsed.");
    }
    if (url.protocol !== "file:") {
      return rejection(
        input,
        "UNSUPPORTED_SCHEME",
        `Mona opens local folders, not ${url.protocol.replace(":", "")} links.`,
      );
    }
    if (url.host && url.host.toLowerCase() !== "localhost") {
      return rejection(
        input,
        "REMOTE_FILE_URL",
        `'${url.host}' names a remote file server. Mona only opens folders on this Mac.`,
      );
    }
    try {
      pathname = fileURLToPath(url);
    } catch {
      return rejection(input, "MALFORMED_URL", "That file URL does not name a usable path.");
    }
    notes.push("url: parsed a file URL once");
    if (pathname !== raw) notes.push("url: percent-decoded before validation");
  } else {
    if (!isAbsolute(raw)) {
      return rejection(
        input,
        "RELATIVE_PATH",
        "Mona needs an absolute folder path, not a relative one.",
      );
    }
    pathname = raw;
  }

  const absolute = resolve(pathname);
  if (absolute === "/") {
    return rejection(
      input,
      "ROOT_VOLUME",
      "'/' is the startup disk. Open the project folder rather than the whole volume.",
    );
  }
  if (absolute.split("/").filter(Boolean).length === 1 && absolute.startsWith("/Volumes/")) {
    notes.push("volume_root: the folder is a volume root");
  }

  let stats: { isDirectory(): boolean };
  try {
    stats = probe.stat(absolute);
  } catch (error) {
    return mapFsError(input, error);
  }
  if (!stats.isDirectory()) {
    return rejection(
      input,
      "NOT_A_DIRECTORY",
      "That item is a file, not a folder. Mona opens project folders.",
    );
  }

  let canonical = absolute;
  try {
    canonical = probe.realpath(absolute);
  } catch (error) {
    return mapFsError(input, error);
  }
  if (canonical !== absolute) {
    notes.push("resolved: symlink or alias resolved before registration");
  }

  try {
    probe.access(canonical);
  } catch (error) {
    return mapFsError(input, error);
  }

  // APFS is normalization-insensitive, so a decomposed path is valid input.
  // Recording the fact keeps the catalog honest about what arrived.
  if (canonical.normalize("NFC") !== canonical) {
    notes.push("unicode: the filesystem path is decomposed (NFD)");
  }

  return {
    ok: true,
    request: {
      path: canonical,
      input,
      source,
      receivedAt: (options.now?.() ?? new Date()).toISOString(),
      notes,
    },
  };
}

/**
 * Parse the arguments of a cold launch or a second launch. Electron passes the
 * app path (and sometimes helper flags) ahead of the user's folder; those are
 * ignored, and only a real folder is returned.
 */
export function parseLaunchArguments(
  argv: readonly string[],
  options: {
    appPath: string;
    workingDirectory?: string;
    /** The running executable; launchers always put it in argv[0]. */
    executablePath?: string;
    probe?: FolderProbe;
    now?: () => Date;
  },
): FolderResolution | null {
  const probe = options.probe ?? realProbe;
  const appPath = resolve(options.appPath);
  const executablePath = options.executablePath ? resolve(options.executablePath) : null;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  let explicit: string | null = null;
  const candidates: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (argument === "--open-folder" || argument === "--open") {
      const value = argv[index + 1];
      if (value) {
        explicit = value;
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("-")) continue;
    const candidate = SCHEME_PATTERN.test(argument)
      ? argument
      : isAbsolute(argument)
        ? resolve(argument)
        : resolve(workingDirectory, argument);
    if (candidate === appPath) continue;
    if (executablePath !== null && candidate === executablePath) continue;
    if (candidate === workingDirectory && !isAbsolute(argument)) continue;
    // Launchers put the executable (and sometimes helper files) in argv; an
    // existing non-directory can never be a project folder, so it is noise.
    try {
      if (!probe.stat(candidate).isDirectory()) continue;
    } catch {
      // Missing paths are kept so a real mistake is reported, not swallowed.
    }
    candidates.push(candidate);
  }

  if (explicit !== null) {
    return resolveFolderRequest(explicit, "argv", {
      probe: options.probe,
      now: options.now,
    });
  }

  // A supplied-but-invalid folder is reported, not silently ignored; only a
  // launch with no folder argument at all returns null.
  let rejection: FolderResolution | null = null;
  for (const candidate of candidates.slice().reverse()) {
    const resolved = resolveFolderRequest(candidate, "argv", {
      probe: options.probe,
      now: options.now,
    });
    if (resolved.ok) return resolved;
    rejection = rejection ?? resolved;
  }
  return rejection;
}
