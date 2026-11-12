import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MONA_BUNDLE_ID,
  MONA_SERVICE_BUNDLE_ID,
  type UninstallDataScope,
  type UninstallEntry,
  type UninstallView,
} from "../../shared/contracts/update";

/**
 * What an uninstall would do, read from the installed facts.
 *
 * The receipt and the ownership manifest are the only sources of package-owned
 * paths. A missing or invalid manifest yields "unavailable", never a guess. The
 * user's own state is always listed separately; removing Mona and deleting
 * projects are two different decisions.
 */

const OWNED_ROOTS = [
  "/Applications/Mona.app",
  "/Library/Services/Mona.service",
  "/Library/Application Support/Mona/install-receipt.json",
  "/Library/Application Support/Mona/owned-paths.json",
  "/Library/Application Support/Mona/uninstall-mona.sh",
] as const;

export interface InstalledFacts {
  receipt: {
    version: string;
    channel: string;
    package: string;
    manifestSha256: string | null;
    installedAt: string;
    appPath: string;
    servicePath: string;
  } | null;
  ownership: {
    version: string;
    channel: string;
    package: string;
    owned: Array<{ path: string; kind: string }>;
    preserves: string[];
  } | null;
  problems: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Read the installed receipt and ownership manifest. Read-only. */
export function readInstalledFacts(root = "/"): InstalledFacts {
  const receiptDir = join(root, "Library/Application Support/Mona");
  const receiptRaw = readJson(join(receiptDir, "install-receipt.json"));
  const ownershipRaw = readJson(join(receiptDir, "owned-paths.json"));
  const problems: string[] = [];

  let receipt: InstalledFacts["receipt"] = null;
  if (receiptRaw) {
    if (stringField(receiptRaw.product) !== "Mona") {
      problems.push("the install receipt does not name Mona");
    } else {
      receipt = {
        version: stringField(receiptRaw.version, "unknown"),
        channel: stringField(receiptRaw.channel, "unknown"),
        package: stringField(receiptRaw.package, "unknown"),
        manifestSha256: stringField(receiptRaw.manifest_sha256) || null,
        installedAt: stringField(receiptRaw.installed_at, "unknown"),
        appPath: stringField(receiptRaw.app_path, "/Applications/Mona.app"),
        servicePath: stringField(receiptRaw.service_path, "/Library/Services/Mona.service"),
      };
    }
  } else if (existsSync(join(receiptDir, "install-receipt.json"))) {
    problems.push("the install receipt is unreadable");
  }

  let ownership: InstalledFacts["ownership"] = null;
  if (ownershipRaw) {
    const owned = Array.isArray(ownershipRaw.owned)
      ? (ownershipRaw.owned as Array<Record<string, unknown>>)
          .map((entry) => ({ path: stringField(entry.path), kind: stringField(entry.kind) }))
          .filter((entry) => entry.path.length > 0)
      : [];
    ownership = {
      version: stringField(ownershipRaw.version, "unknown"),
      channel: stringField(ownershipRaw.channel, "unknown"),
      package: stringField(ownershipRaw.package, "unknown"),
      owned,
      preserves: Array.isArray(ownershipRaw.preserves)
        ? (ownershipRaw.preserves as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    };
  } else if (existsSync(join(receiptDir, "owned-paths.json"))) {
    problems.push("the ownership manifest is unreadable");
  }

  return { receipt, ownership, problems };
}

function bundleIdentifier(bundlePath: string): string | null {
  const plist = join(bundlePath, "Contents/Info.plist");
  if (!existsSync(plist)) return null;
  try {
    const text = readFileSync(plist, "utf8");
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function ownedEntry(root: string, path: string, kind: string): UninstallEntry {
  const absolute = join(root, path);
  const present = existsSync(absolute);
  if (!present) {
    return { path, kind, present: false, verified: true, detail: "not installed" };
  }
  let isSymlink = false;
  try {
    isSymlink = lstatSync(absolute).isSymbolicLink();
  } catch {
    isSymlink = false;
  }
  if (isSymlink) {
    return {
      path,
      kind,
      present: true,
      verified: false,
      detail: "refused: the path is a symlink",
    };
  }
  const allowed = OWNED_ROOTS.includes(path as (typeof OWNED_ROOTS)[number]);
  if (kind === "app-bundle" || kind === "service-bundle") {
    const expected = kind === "app-bundle" ? MONA_BUNDLE_ID : MONA_SERVICE_BUNDLE_ID;
    const actual = bundleIdentifier(absolute);
    return {
      path,
      kind,
      present: true,
      verified: allowed && actual === expected,
      detail:
        actual === expected
          ? `owned bundle ${expected}`
          : `refused: bundle identifier is ${actual ?? "missing"}, expected ${expected}`,
    };
  }
  return {
    path,
    kind,
    present: true,
    verified: allowed,
    detail: allowed ? "package-owned file" : "refused: not a known package-owned path",
  };
}

function dataScopes(home: string): UninstallDataScope[] {
  const scopes: Array<{ label: string; path: string; note: string }> = [
    {
      label: "Product state",
      path: join(home, "Library/Application Support/Mona"),
      note: "Database, backups, artifacts, and the project catalog for this user.",
    },
    {
      label: "Cache",
      path: join(home, "Library/Caches/Mona"),
      note: "Regenerable caches only.",
    },
    {
      label: "Logs",
      path: join(home, "Library/Logs/Mona"),
      note: "Local diagnostic logs.",
    },
    {
      label: "Preferences",
      path: join(home, "Library/Preferences/com.mona.workbench.plist"),
      note: "Window and preference state.",
    },
  ];
  return scopes.map((scope) => ({
    ...scope,
    exists: existsSync(scope.path),
  }));
}

export function uninstallView(options: {
  home: string;
  root?: string;
  utilityPath?: string | null;
}): UninstallView {
  const root = options.root ?? "/";
  const facts = readInstalledFacts(root);
  const owned = facts.ownership?.owned ?? [];
  const entries = owned.map((entry) => ownedEntry(root, entry.path, entry.kind));

  const installedUtility = join(root, "/Library/Application Support/Mona/uninstall-mona.sh");
  const utilityPath = options.utilityPath ?? installedUtility;
  const command = "/Library/Application Support/Mona/uninstall-mona.sh";
  const preserves = facts.ownership?.preserves ?? [
    "Projects and source folders",
    "~/.codewhale and any external Codewhale installation",
    "This user's product state, credentials, and history",
  ];

  return {
    applied: facts.receipt !== null && facts.ownership !== null,
    installedReceipt: facts.receipt
      ? {
          version: facts.receipt.version,
          channel: facts.receipt.channel,
          package: facts.receipt.package,
          manifestSha256: facts.receipt.manifestSha256,
          installedAt: facts.receipt.installedAt,
        }
      : null,
    ownershipManifestPresent: facts.ownership !== null,
    entries,
    userDataScopes: dataScopes(options.home),
    preserves,
    utility: {
      path: existsSync(utilityPath) ? command : null,
      signed: false,
      commands: {
        dryRun: `sudo sh "${command}" --dry-run`,
        removeService: `sudo sh "${command}" --yes`,
        removeUserData: `sh "${command}" --remove-user-data --home "${options.home}" --yes`,
      },
    },
    note:
      facts.problems.length > 0
        ? `${facts.problems.join("; ")}. Mona will not guess which paths it owns; reinstall the package or follow the manual guide.`
        : facts.receipt === null
          ? "This copy was not installed by the package, so there is no package-owned payload to remove."
          : "Removing Mona and deleting your state are separate actions. The default removes only the package-owned app and Finder Service.",
  };
}
