import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnabledState,
  LastHandoff,
  RegistrationState,
  ServiceStatus,
} from "../../shared/contracts/open";

/**
 * Read-only inspection of the Finder Service installation and the last handoff.
 *
 * Everything here is evidence, not assumption: a missing registration is
 * reported as missing, an unreadable enabled-state is reported as unknown, and
 * a development (unpackaged) build says so instead of claiming Finder
 * integration it cannot have yet.
 */

export const SERVICE_BUNDLE_NAME = "Mona.service";
export const SERVICE_MENU_TITLE = "Start new DS project with Mona";
export const SERVICE_MESSAGE = "startProject";
export const SERVICE_BUNDLE_IDENTIFIER = "com.mona.workbench.service";
export const APP_BUNDLE_IDENTIFIER = "com.mona.workbench";

export interface ServiceStatusOptions {
  home: string;
  platform: string;
  arch: string;
  packaged: boolean;
  /** Development hook: a service bundle built in this repository. */
  servicePathOverride?: string | null;
  exec?: (file: string, args: string[]) => string | null;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
  now?: () => Date;
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function defaultExec(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function serviceInstallCandidates(home: string): string[] {
  return [
    `/Library/Services/${SERVICE_BUNDLE_NAME}`,
    join(home, "Library/Services", SERVICE_BUNDLE_NAME),
  ];
}

export function serviceReceiptPath(home: string): string {
  return join(home, "Library/Application Support/Mona/services/last-handoff.json");
}

function parseHandoff(raw: string | null): LastHandoff | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const number = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      at: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      ok: parsed.ok === true,
      code: typeof parsed.code === "string" ? parsed.code : null,
      resolvedPath: typeof parsed.resolved_path === "string" ? parsed.resolved_path : null,
      device: number(parsed.device),
      inode: number(parsed.inode),
      forwarded: parsed.forwarded === true,
      invocation: typeof parsed.invocation === "string" ? parsed.invocation : null,
    };
  } catch {
    return null;
  }
}

/**
 * The system's own list of vended services. Reading it is read-only; it is the
 * same data the Services menu renders from.
 */
function readVendedServices(
  readFile: (path: string) => string | null,
  home: string,
): string | null {
  const plist = join(home, "Library/Preferences/com.apple.ServicesMenu.Services.plist");
  const raw = readFile(plist);
  if (raw === null) return null;
  return raw;
}

function plistContainsService(raw: string | null, installPath: string | null): boolean | null {
  if (!raw) return null;
  // The plist may be XML or binary; the JSON conversion is done by `plutil` in
  // the caller, so here we only look for the identifying strings.
  const hasIdentifier = raw.includes(SERVICE_BUNDLE_IDENTIFIER);
  const hasTitle = raw.includes(SERVICE_MENU_TITLE) && raw.includes(SERVICE_MESSAGE);
  if (!hasIdentifier && !hasTitle) return false;
  if (installPath && raw.includes(installPath)) return true;
  return hasIdentifier || hasTitle;
}

export function inspectServiceStatus(options: ServiceStatusOptions): ServiceStatus {
  const exec = options.exec ?? defaultExec;
  const exists = options.exists ?? existsSync;
  const readFile =
    options.readFile ??
    ((path: string): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const now = options.now ?? (() => new Date());

  const detail: string[] = [];
  const supported = options.platform === "darwin" && options.arch === "arm64";
  if (!supported) detail.push(`unsupported host: ${options.platform}/${options.arch}`);

  const [systemPath, userPath] = serviceInstallCandidates(options.home);
  const override = options.servicePathOverride ?? null;
  let installPath: string | null = null;
  let scope: ServiceStatus["scope"] = null;
  if (override && exists(override)) {
    installPath = override;
    scope = "development";
  } else if (systemPath && exists(systemPath)) {
    installPath = systemPath;
    scope = "system";
  } else if (userPath && exists(userPath)) {
    installPath = userPath;
    scope = "user";
  }

  // Registration: the vended-services list, then LaunchServices as a fallback.
  let registration: RegistrationState = "unknown";
  let plistRaw: string | null = null;
  if (installPath) {
    const converted = exec("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(options.home, "Library/Preferences/com.apple.ServicesMenu.Services.plist"),
    ]);
    plistRaw = converted ?? readVendedServices(readFile, options.home);
    const fromPlist = plistContainsService(plistRaw, installPath);
    if (fromPlist === true) {
      registration = "registered";
      detail.push("registration: listed in the system's vended services");
    } else {
      // Not positively registered in the preference file: ask LaunchServices,
      // which is what actually launches the Service.
      const dump = exec(LSREGISTER, ["-dump"]);
      if (dump && dump.includes(SERVICE_MENU_TITLE) && dump.includes(SERVICE_MESSAGE)) {
        registration = "registered";
        detail.push("registration: found in the LaunchServices database");
      } else if (dump) {
        registration = "missing";
        detail.push("registration: not present in LaunchServices or the vended services list");
      } else {
        registration = "unknown";
        detail.push("registration: could not read the services database");
      }
    }
  }

  // Enabled state: `NSServicesStatus` in the pbs domain, when macOS records it.
  let enabled: EnabledState = "unknown";
  const statusPlist = exec("/usr/bin/defaults", ["read", "pbs", "NSServicesStatus"]);
  if (statusPlist) {
    const block = statusPlist
      .split("================================================")
      .find((entry) => entry.includes(SERVICE_MENU_TITLE));
    if (block) {
      const contextOff = /enabled_context_menu\s*=\s*0/.test(block);
      const servicesOff = /enabled_services_menu\s*=\s*0/.test(block);
      enabled = contextOff && servicesOff ? "disabled" : "enabled";
      detail.push(`enabled: recorded by macOS as ${enabled}`);
    } else {
      detail.push("enabled: macOS records no toggle for this service (default on)");
    }
  } else {
    detail.push("enabled: macOS has no services-status record; treated as unknown");
  }

  const handoff = parseHandoff(readFile(serviceReceiptPath(options.home)));

  const recovery: string[] = [];
  if (!supported) {
    recovery.push("The Finder Service is only built for Apple Silicon Macs.");
  } else if (!installPath) {
    recovery.push(
      `Install Mona to register the Service (installs ${SERVICE_BUNDLE_NAME} in /Library/Services).`,
    );
    recovery.push(
      `Until then you can still open a folder with File → Open Project… (⌘O) or by dropping it on the Mona window.`,
    );
  } else if (!options.packaged) {
    recovery.push(
      "This is a development build: Finder handoff targets the packaged Mona app. " +
        "The service bundle and its registration are verified separately, and P21 installs the pair together.",
    );
  } else if (registration !== "registered") {
    recovery.push("Open System Settings → General → Login Items & Extensions → Services.");
    recovery.push(`Turn on “${SERVICE_MENU_TITLE}”.`);
    recovery.push("If the entry is missing, reinstall Mona; the installer registers the Service.");
  } else if (enabled === "disabled") {
    recovery.push("Open System Settings → General → Login Items & Extensions → Services.");
    recovery.push(`Turn on “${SERVICE_MENU_TITLE}” again.`);
  }

  const installPathDisplay = installPath
    ? installPath.startsWith(`${options.home}/`)
      ? `~${installPath.slice(options.home.length)}`
      : installPath
    : null;

  return {
    supported,
    installed: installPath !== null,
    installPath,
    installPathDisplay,
    scope,
    registration,
    enabled,
    menuTitle: SERVICE_MENU_TITLE,
    message: SERVICE_MESSAGE,
    appIdentity: APP_BUNDLE_IDENTIFIER,
    packaged: options.packaged,
    lastHandoff: handoff,
    recovery,
    detail,
    checkedAt: now().toISOString(),
  };
}

/**
 * Ask LaunchServices to re-read the installed bundle. This uses Apple's own
 * support tool with a fixed, validated path — never a private `pbs` flag and
 * never an arbitrary path from the renderer.
 */
export function refreshServiceRegistration(
  installPath: string | null,
  exec: (file: string, args: string[]) => string | null = defaultExec,
): boolean {
  if (!installPath || !installPath.endsWith(`/${SERVICE_BUNDLE_NAME}`)) return false;
  if (!existsSync(installPath)) return false;
  exec(LSREGISTER, ["-f", installPath]);
  return true;
}
