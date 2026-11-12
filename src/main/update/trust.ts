import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONA_BUNDLE_ID,
  MONA_PACKAGE_ID,
  MONA_PRODUCT,
  MONA_SERVICE_BUNDLE_ID,
  type BuildChannel,
  type PackageFacts,
  type PackageSignatureFacts,
  type UpdateCandidateSummary,
  type UpdateCheckView,
  type UpdateDecision,
  type UpdateInstallKind,
  type UpdateManifest,
  type UpdateRejectionCode,
  type UpdateSourceConfig,
} from "../../shared/contracts/update";
import { compareOsVersions, compareVersions } from "./version";

/**
 * The update trust policy, as a pure function over observed facts.
 *
 * Nothing here downloads, installs, or trusts a claim because a manifest made
 * it. The manifest is only as good as its signature, the package only as good
 * as its signature and the digest of its bytes, and the comparison only as good
 * as the parsed version and build. Every branch returns a reason a person can
 * act on; there is no "proceed anyway" path.
 */

/** A package larger than this is refused before it is hashed or expanded. */
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

export const EXPECTED_BUNDLE_ID = MONA_BUNDLE_ID;
export const EXPECTED_SERVICE_BUNDLE_ID = MONA_SERVICE_BUNDLE_ID;
export const EXPECTED_PACKAGE_ID = MONA_PACKAGE_ID;

export interface CurrentBuild {
  version: string;
  build: number;
  channel: BuildChannel;
  schemaVersion: number;
  engineVersion: string | null;
  engineCommit: string | null;
}

export interface AppliedPackage {
  sha256: string;
  version: string;
  at: string;
}

export interface TrustInput {
  mode: "manual" | "configured";
  source: UpdateSourceConfig;
  manifest: UpdateManifest | null;
  packageFacts: PackageFacts | null;
  current: CurrentBuild;
  hostOs: string;
  hostArch: string;
  applied: readonly AppliedPackage[];
  /** The user confirmed a disclosed engine change. */
  engineChangeConfirmed?: boolean;
  /** A package chosen through the file dialog (no manifest from a source). */
  localSelection?: boolean;
  /**
   * `announce` evaluates what an authenticated manifest can prove before the
   * package is downloaded; `package` evaluates the bytes themselves. Both run
   * the same policy, and installation requires the second.
   */
  stage?: "announce" | "package";
}

export interface TrustDecision {
  decision: UpdateDecision;
  code: UpdateRejectionCode | null;
  reason: string;
  candidate: UpdateCandidateSummary | null;
  engineChange: { from: string; to: string } | null;
}

function refuse(
  code: UpdateRejectionCode,
  reason: string,
  candidate?: UpdateCandidateSummary | null,
): TrustDecision {
  return { decision: "refused", code, reason, candidate: candidate ?? null, engineChange: null };
}

function sameTeam(expected: string | null, actual: string | null): boolean {
  if (expected === null) return actual === null;
  return actual !== null && actual.toUpperCase() === expected.toUpperCase();
}

function installKind(current: CurrentBuild, manifest: UpdateManifest): UpdateInstallKind {
  const versionOrder = compareVersions(manifest.version, current.version);
  if (versionOrder === 0 && manifest.build === current.build) return "reinstall";
  return "upgrade";
}

/**
 * Evaluate a candidate. The order is deliberate: identity before signature,
 * signature before digest, digest before version order, and version order
 * before replay. A refusal names the first failed guarantee, not the last.
 */
export function evaluateUpdate(input: TrustInput): TrustDecision {
  const { manifest, current, source } = input;

  if (manifest === null) {
    return {
      decision: "manual",
      code: "no_source",
      reason:
        "No distribution source is configured. Mona shows manual package updates and accepts a package you choose.",
      candidate: null,
      engineChange: null,
    };
  }
  if (input.mode === "manual" && manifest.channel === "release") {
    // A release manifest is only meaningful when it came from an authenticated
    // source. Without one, Mona cannot verify the publisher team at all.
    return refuse(
      "release_updates_local_only",
      "A release package needs an authenticated distribution source; Mona will not install one from a file you chose.",
    );
  }

  const summary: UpdateCandidateSummary = {
    version: manifest.version,
    build: manifest.build,
    channel: manifest.channel,
    packageName: manifest.package.name,
    packageSha256: manifest.package.sha256,
    packageSize: manifest.package.sizeBytes,
    minimumMacOS: manifest.minimumMacOS,
    architectures: [...manifest.architectures],
    engineVersion: manifest.engine.version,
    teamId: manifest.teamId,
    notarized: manifest.package.notarized,
    releasedAt: manifest.releasedAt,
    installKind: installKind(current, manifest),
  };

  // 1. Identity. A package for another product is not "close enough".
  if (manifest.product !== MONA_PRODUCT) {
    return refuse(
      "product_mismatch",
      `This package is for ${manifest.product}, not ${MONA_PRODUCT}.`,
    );
  }
  if (
    manifest.bundleId !== EXPECTED_BUNDLE_ID ||
    manifest.serviceBundleId !== EXPECTED_SERVICE_BUNDLE_ID ||
    manifest.packageId !== EXPECTED_PACKAGE_ID
  ) {
    return refuse(
      "identity_mismatch",
      "The manifest names a different bundle or package identifier than this build owns.",
      summary,
    );
  }

  // 2. Trust tier. A local, unauthenticated package may not replace a release
  // install, and a release build must come from the configured team.
  if (manifest.channel === "local") {
    if (input.localSelection !== true) {
      return refuse(
        "local_package_not_allowed",
        "A local development build is installed only from a package you choose, never from a source feed.",
        summary,
      );
    }
    if (!source.allowLocalPackages) {
      return refuse(
        "local_package_not_allowed",
        "This configuration refuses local development packages; configure a signed release source instead.",
        summary,
      );
    }
    if (current.channel === "release") {
      return refuse(
        "local_package_not_allowed",
        "A release installation cannot be replaced by an unauthenticated local development build.",
        summary,
      );
    }
  } else {
    if (manifest.teamId === null) {
      return refuse("wrong_team", "The release manifest does not name a publisher team.");
    }
    if (source.teamId === null || !sameTeam(source.teamId, manifest.teamId)) {
      return refuse(
        "wrong_team",
        "The manifest's publisher team is not the team this source was configured to trust.",
        summary,
      );
    }
  }

  // 3. The package's own facts. A manifest that does not describe the bytes on
  // disk is a tampered or mismatched download. At the announce stage the
  // package has not been fetched, so these checks wait for the package stage.
  const stage = input.stage ?? "package";
  const facts = input.packageFacts;
  if (stage === "package" && facts === null) {
    return refuse("digest_mismatch", "The package could not be inspected.", summary);
  }
  if (stage === "package" && facts !== null) {
    if (facts.sizeBytes !== manifest.package.sizeBytes) {
      return refuse(
        "size_mismatch",
        `The package is ${facts.sizeBytes} bytes; the manifest declares ${manifest.package.sizeBytes}.`,
        summary,
      );
    }
    if (facts.sha256 !== manifest.package.sha256) {
      return refuse(
        "digest_mismatch",
        "The package bytes do not match the authenticated manifest digest.",
        summary,
      );
    }
    if (facts.package.identifier !== null && facts.package.identifier !== EXPECTED_PACKAGE_ID) {
      return refuse(
        "package_identity_mismatch",
        `The package identifier is ${facts.package.identifier}, not ${EXPECTED_PACKAGE_ID}.`,
        summary,
      );
    }
    if (facts.appBundleId !== null && facts.appBundleId !== EXPECTED_BUNDLE_ID) {
      return refuse(
        "package_identity_mismatch",
        "The package does not install this product's application bundle.",
        summary,
      );
    }
    if (facts.serviceBundleId !== null && facts.serviceBundleId !== EXPECTED_SERVICE_BUNDLE_ID) {
      return refuse(
        "package_identity_mismatch",
        "The package does not install this product's Finder Service.",
        summary,
      );
    }
    if (manifest.channel === "release") {
      if (facts.signature.status === "unsigned" || facts.signature.status === "unknown") {
        return refuse(
          "package_unsigned",
          "The package carries no verifiable Developer ID Installer signature.",
          summary,
        );
      }
      if (facts.signature.status === "adhoc") {
        return refuse(
          "package_adhoc",
          "The package is ad-hoc signed; it is a local development build, not a release.",
          summary,
        );
      }
      if (!facts.signature.developerIdInstaller) {
        return refuse(
          "package_unsigned",
          "The package signature is not a Developer ID Installer certificate.",
          summary,
        );
      }
      if (!sameTeam(manifest.teamId, facts.signature.teamId)) {
        return refuse(
          "wrong_team",
          "The package signature's team does not match the manifest's publisher team.",
          summary,
        );
      }
      if (!manifest.package.notarized) {
        return refuse(
          "notarization_missing",
          "This release package is not notarized; a release update requires an accepted notarization.",
          summary,
        );
      }
    } else if (facts.signature.status === "unknown") {
      return refuse(
        "package_unsigned",
        "The package signature could not be read, so its identity is unproven.",
        summary,
      );
    }
  }

  // 4. This host.
  if (!manifest.architectures.includes("arm64")) {
    return refuse(
      "architecture_mismatch",
      "This package does not include an arm64 build.",
      summary,
    );
  }
  if (input.hostArch !== "arm64") {
    return refuse(
      "architecture_mismatch",
      `This Mac reports ${input.hostArch}; Mona for macOS is an Apple Silicon build.`,
      summary,
    );
  }
  if (facts !== null && facts.architectures.length > 0 && !facts.architectures.includes("arm64")) {
    return refuse("architecture_mismatch", "The package payload is not an arm64 build.", summary);
  }
  if (!input.hostOs) {
    return refuse("os_too_old", "This Mac's macOS version could not be read.", summary);
  }
  if (compareOsVersions(manifest.minimumMacOS, input.hostOs) > 0) {
    return refuse(
      "os_too_old",
      `This update needs macOS ${manifest.minimumMacOS} or later; this Mac runs ${input.hostOs}.`,
      summary,
    );
  }

  // 5. Version order. Never a downgrade, and never a version this build cannot
  // order at all.
  if (compareVersions(manifest.version, current.version) < 0) {
    return refuse(
      "downgrade",
      `This package (${manifest.version}) is older than the installed ${current.version}.`,
      summary,
    );
  }
  if (compareVersions(manifest.version, current.version) === 0 && manifest.build < current.build) {
    return refuse(
      "downgrade",
      `This package (build ${manifest.build}) is older than the installed build ${current.build}.`,
      summary,
    );
  }

  // 6. Replay. The same bytes already applied on this Mac are not a new update.
  const applied = input.applied.find((entry) => entry.sha256 === manifest.package.sha256);
  if (applied) {
    return refuse(
      "replayed",
      `This exact package was already applied on ${applied.at} (${applied.version}). Choose a newer package.`,
      summary,
    );
  }

  // 7. The bundled engine never changes silently. A release must declare the
  // engine it ships; a different declared engine is a disclosed whole-app
  // change, never an independent engine update.
  if (manifest.channel === "release" && manifest.engine.version === "unknown") {
    return refuse(
      "engine_mismatch",
      "The release manifest does not declare which engine it ships.",
      summary,
    );
  }
  const currentEngine = current.engineVersion;
  const engineChange =
    currentEngine !== null &&
    manifest.engine.version !== "unknown" &&
    currentEngine !== manifest.engine.version
      ? { from: currentEngine, to: manifest.engine.version }
      : null;
  if (engineChange && input.engineChangeConfirmed !== true) {
    return {
      decision: "refused",
      code: "engine_change_unconfirmed",
      reason:
        `This update also changes the bundled engine ${engineChange.from} to ${engineChange.to}. ` +
        "Mona never changes the engine on its own; confirm the engine change to continue with the whole-app update.",
      candidate: summary,
      engineChange,
    };
  }

  return {
    decision: "available",
    code: null,
    reason:
      summary.installKind === "reinstall"
        ? `This is the same version (${manifest.version}, build ${manifest.build}); it reinstalls the package-owned files and keeps your state.`
        : `Mona ${manifest.version} (build ${manifest.build}) is available; the installed version is ${current.version}.`,
    candidate: summary,
    engineChange,
  };
}

// --------------------------------------------------------------- inspection

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  try {
    const stdout = execFileSync(command, args as string[], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
};

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/** Parse `pkgutil --check-signature` output. */
export function parsePackageSignature(text: string): PackageSignatureFacts {
  const authorities: string[] = [];
  const chain = /Certificate Chain:([\s\S]*)$/.exec(text);
  if (chain?.[1]) {
    for (const line of chain[1].split("\n")) {
      const match = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
      if (match?.[1]) authorities.push(match[1]);
    }
  }
  const statusLine = /Status:\s*(.+)/i.exec(text)?.[1]?.trim() ?? "";
  const team = /TeamIdentifier=(.+)/i.exec(text)?.[1]?.trim() ?? null;
  const identifier = /Identifier=(.+)/i.exec(text)?.[1]?.trim() ?? null;
  const developerIdInstaller = authorities.some((authority) =>
    /^Developer ID Installer:/i.test(authority),
  );
  let status: PackageSignatureFacts["status"] = "unknown";
  if (/no signature|not signed|unsigned/i.test(statusLine)) status = "unsigned";
  else if (/ad-?hoc/i.test(statusLine) || /Signature=adhoc/i.test(text)) status = "adhoc";
  else if (/signed/i.test(statusLine)) status = "signed";
  else if (authorities.length > 0) status = "signed";

  const teamFromAuthority = /\(([A-Z0-9]{5,20})\)\s*$/.exec(authorities[0] ?? "")?.[1] ?? null;

  return {
    status,
    teamId: team ?? teamFromAuthority,
    authorities,
    developerIdInstaller,
    identifier,
  };
}

interface PackageMetadata {
  version?: string;
  build?: number;
  channel?: string;
  bundleId?: string;
  serviceBundleId?: string;
  minimumMacOS?: string;
  architectures?: string[];
  engine?: { version: string; commit: string };
}

function readMetadata(path: string): PackageMetadata | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageMetadata;
  } catch {
    return null;
  }
}

/**
 * Inspect a package without executing it and without trusting its contents.
 * The metadata file is a convenience that must agree with `PackageInfo` and
 * the `Distribution`; the installer's own metadata is the primary source.
 */
export function inspectPackage(path: string, runner: CommandRunner = defaultRunner): PackageFacts {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("the package path is not a regular file");
  if (!path.endsWith(".pkg")) throw new Error("the package path does not end in .pkg");
  if (info.size === 0) throw new Error("the package is empty");

  const signatureRun = runner("/usr/sbin/pkgutil", ["--check-signature", path]);
  const signature = parsePackageSignature(`${signatureRun.stdout}\n${signatureRun.stderr}`);

  const template = mkdtempSync(join(tmpdir(), "mona-pkg-inspect-"));
  const expanded = join(template, "expanded");
  try {
    const expand = runner("/usr/sbin/pkgutil", ["--expand", path, expanded]);
    if (expand.status !== 0) {
      throw new Error(`could not expand the package metadata: ${expand.stderr.trim()}`);
    }
    let packageInfo = "";
    let distribution = "";
    let metadata: PackageMetadata | null = null;
    for (const entry of readdirSafe(expanded)) {
      if (entry.endsWith(".pkg")) {
        packageInfo += readIfPresent(join(expanded, entry, "PackageInfo"));
      }
    }
    distribution = readIfPresent(join(expanded, "Distribution"));
    metadata = readMetadata(join(expanded, "Resources", "update-metadata.json"));

    const identifier = /identifier="([^"]+)"/.exec(packageInfo)?.[1] ?? signature.identifier;
    const version =
      /<pkg-info[^>]*\bversion="([^"]+)"/.exec(packageInfo)?.[1] ?? metadata?.version ?? null;
    const appBundleId =
      /<bundle\b[^>]*\bpath="\.?\/?Applications\/Mona\.app"[^>]*\bid="([^"]+)"/.exec(
        packageInfo,
      )?.[1] ??
      /<bundle\b[^>]*\bid="([^"]+)"[^>]*\bpath="\.?\/?Applications\/Mona\.app"/.exec(
        packageInfo,
      )?.[1] ??
      metadata?.bundleId ??
      null;
    const serviceBundleId =
      /<bundle\b[^>]*\bpath="\.?\/?Library\/Services\/Mona\.service"[^>]*\bid="([^"]+)"/.exec(
        packageInfo,
      )?.[1] ??
      /<bundle\b[^>]*\bid="([^"]+)"[^>]*\bpath="\.?\/?Library\/Services\/Mona\.service"/.exec(
        packageInfo,
      )?.[1] ??
      metadata?.serviceBundleId ??
      null;
    const minimumMacOS =
      /<os-version[^>]*\bmin="([^"]+)"/.exec(distribution)?.[1] ?? metadata?.minimumMacOS ?? null;
    const hostArchitectures = /hostArchitectures="([^"]+)"/.exec(distribution)?.[1] ?? "";
    const architectures =
      metadata?.architectures && metadata.architectures.length > 0
        ? metadata.architectures
        : hostArchitectures
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    const buildMatch = /CFBundleVersion="(\d+)"/.exec(packageInfo)?.[1];
    const build = buildMatch ? Number(buildMatch) : metadata?.build;

    return {
      path,
      sha256: sha256File(path),
      sizeBytes: info.size,
      signature,
      package: {
        identifier,
        version,
        build: typeof build === "number" && Number.isFinite(build) ? build : null,
        installLocation: /install-location="([^"]+)"/.exec(packageInfo)?.[1] ?? null,
        minimumMacOS,
      },
      appBundleId,
      serviceBundleId,
      architectures,
      engine: metadata?.engine ?? null,
      source: "pkgutil",
    };
  } finally {
    rmSync(template, { recursive: true, force: true });
  }
}

function readIfPresent(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * A chosen local package has no manifest from a source, so the manifest is
 * derived from what the package itself declares. It is then evaluated by the
 * same policy, which is why an ad-hoc package can never pass as a release.
 */
export function manifestFromPackage(
  facts: PackageFacts,
  options: { version: string; build: number; channel: "local" },
): UpdateManifest {
  return {
    schemaVersion: 1,
    product: MONA_PRODUCT,
    channel: options.channel,
    version: options.version,
    build: options.build,
    bundleId: facts.appBundleId ?? EXPECTED_BUNDLE_ID,
    serviceBundleId: facts.serviceBundleId ?? EXPECTED_SERVICE_BUNDLE_ID,
    packageId: facts.package.identifier ?? EXPECTED_PACKAGE_ID,
    teamId: facts.signature.teamId,
    minimumMacOS: facts.package.minimumMacOS ?? "14.0",
    architectures: facts.architectures.length > 0 ? facts.architectures : ["arm64"],
    engine: facts.engine ?? { version: "unknown", commit: "unknown" },
    package: {
      url: facts.path,
      name: facts.path.split("/").pop() ?? "Mona-local.pkg",
      sha256: facts.sha256,
      sizeBytes: facts.sizeBytes,
      notarized: false,
    },
    releasedAt: new Date().toISOString(),
    notesUrl: null,
  };
}

/** A refusal view with no candidate, for a check that could not even start. */
export function refusalView(input: {
  code: UpdateRejectionCode;
  reason: string;
  current: CurrentBuild;
  mode: "manual" | "configured";
  baseUrl: string | null;
  checkedAt: string;
  keyFingerprint?: string | null;
}): UpdateCheckView {
  return {
    mode: input.mode,
    decision: "refused",
    code: input.code,
    reason: input.reason,
    checkedAt: input.checkedAt,
    current: {
      version: input.current.version,
      build: input.current.build,
      channel: input.current.channel,
      schemaVersion: input.current.schemaVersion,
      engineVersion: input.current.engineVersion,
    },
    candidate: null,
    engineChange: null,
    deferral: null,
    packagePath: null,
    source: {
      baseUrl: input.baseUrl,
      host: input.baseUrl === null ? null : safeHost(input.baseUrl),
      manifestAuthenticated: false,
      keyFingerprint: input.keyFingerprint ?? null,
    },
    inference: { requests: 0, note: "An update check is a local read; it makes no model call." },
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
