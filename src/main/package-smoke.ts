import { app } from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PINNED_ENGINE } from "./engine/compat";
import { resolveEngineBinary } from "./engine/runtime-process";
import { resolveSupervisorBinary } from "./supervisor/native";
import { resolvePtyBinary } from "./terminal/pty";
import { inspectServiceStatus } from "./open/service-status";

/**
 * Acceptance sample for an installed Mona. It proves the packaged payload is
 * complete and runnable without developer tools, and it deliberately never
 * starts a runtime, reads a credential, or calls a model. The packaging script
 * runs it from the installed app with a minimal environment.
 */
export interface PackageSmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PackageSmokeReport {
  schema_version: 1;
  ok: boolean;
  packaged: boolean;
  app_path: string;
  executable: string;
  arch: string;
  version: string;
  build_channel: string | null;
  install_path: string;
  installed_at_standard_location: boolean;
  service: { install_path: string; installed: boolean; enabled: boolean | null } | null;
  state_directory: string;
  runtime_started: false;
  inference_calls: 0;
  components: Array<{ path: string; sha256_ok: boolean }>;
  checks: PackageSmokeCheck[];
  generated_at: string;
}

interface ComponentManifest {
  schema_version?: number;
  components?: Array<{ path: string; sha256: string }>;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(binary: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      status: failed.status ?? 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? failed.message ?? ""),
    };
  }
}

export function runPackageSmoke(options: {
  reportPath: string;
  stateDirectory: string;
}): PackageSmokeReport {
  const checks: PackageSmokeCheck[] = [];
  const componentResults: Array<{ path: string; sha256_ok: boolean }> = [];
  const stateDirectory = options.stateDirectory;
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  const resources = process.resourcesPath;
  const installPath = app.isPackaged
    ? resolve(app.getAppPath(), "..", "..", "..")
    : app.getAppPath();
  const bundlePath = installPath.endsWith(".app") ? installPath : app.getAppPath();

  record(
    "packaged",
    app.isPackaged,
    app.isPackaged ? "running from an app bundle" : "not packaged",
  );

  const fileType = run("/usr/bin/file", ["-b", process.execPath]);
  const arch = /arm64/.test(fileType.stdout)
    ? "arm64"
    : /x86_64/.test(fileType.stdout)
      ? "x86_64"
      : "unknown";
  record("arm64 executable", arch === "arm64", `${process.execPath}: ${fileType.stdout.trim()}`);

  try {
    const engine = resolveEngineBinary();
    const version = run(engine.realPath, ["--version"]);
    const parsed = /codewhale\s+(\S+)\s+\(([0-9a-f]+)\)/i.exec(version.stdout);
    const versionOk =
      parsed?.[1] === PINNED_ENGINE.version &&
      (parsed?.[2]?.length ?? 0) >= 12 &&
      PINNED_ENGINE.commit.startsWith(parsed?.[2] ?? "\0");
    record(
      "bundled engine version",
      version.status === 0 && versionOk === true,
      parsed
        ? `codewhale ${parsed[1]} (${parsed[2]}) via ${engine.source}`
        : `unexpected --version output: ${version.stdout.trim() || version.stderr.trim()}`,
    );
    record(
      "bundled engine location",
      engine.source === "bundled",
      engine.source === "bundled" ? engine.realPath : `resolved through ${engine.source}`,
    );
  } catch (error) {
    record("bundled engine", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const supervisor = resolveSupervisorBinary();
    const help = run(supervisor, ["--help"]);
    record(
      "native supervisor",
      help.status === 0 && help.stdout.includes("--control"),
      `${supervisor} (${help.status === 0 ? "runs" : help.stderr.trim()})`,
    );
  } catch (error) {
    record("native supervisor", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const pty = resolvePtyBinary();
    const echo = run(pty, ["--shell", "/bin/echo", "--arg", "mona-package-smoke"]);
    record(
      "native pty",
      echo.status === 0 && echo.stdout.includes("mona-package-smoke"),
      `${pty} (${echo.status === 0 ? "spawned a shell" : echo.stderr.trim()})`,
    );
  } catch (error) {
    record("native pty", false, error instanceof Error ? error.message : String(error));
  }

  const capabilityPath = resources ? join(resources, "docs/codewhale-capabilities-macos.json") : "";
  let capabilityOk = false;
  try {
    const document = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
      capabilities?: unknown[];
    };
    capabilityOk = Array.isArray(document.capabilities) && document.capabilities.length > 0;
  } catch {
    capabilityOk = false;
  }
  record("capability inventory", capabilityOk, capabilityPath || "no resources directory");

  const manifestPath = resources ? join(resources, "component-manifest.json") : "";
  let manifest: ComponentManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ComponentManifest;
    record("component manifest", manifest.components !== undefined, manifestPath);
  } catch {
    record("component manifest", false, manifestPath || "no resources directory");
  }
  if (resources && manifest?.components) {
    for (const component of manifest.components) {
      const target = join(resources, component.path);
      let ok = false;
      try {
        ok = existsSync(target) && hashFile(target) === component.sha256;
      } catch {
        ok = false;
      }
      componentResults.push({ path: component.path, sha256_ok: ok });
    }
  }
  record(
    "component digests",
    componentResults.length > 0 && componentResults.every((component) => component.sha256_ok),
    `${componentResults.filter((component) => component.sha256_ok).length}/${componentResults.length} hashes match the manifest`,
  );

  const channel = readChannel();
  const standardPath = "/Applications/Mona.app";
  const installedAtStandard = resolve(bundlePath) === standardPath && existsSync(standardPath);
  const service = inspectServiceStatus({
    home: app.getPath("home"),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  });
  record(
    "install location",
    app.isPackaged ? installedAtStandard || bundlePath.startsWith("/Applications/") : true,
    bundlePath,
  );
  record("state directory", stateDirectory.length > 0, stateDirectory);

  const report: PackageSmokeReport = {
    schema_version: 1,
    ok: checks.every((check) => check.ok),
    packaged: app.isPackaged,
    app_path: app.getAppPath(),
    executable: process.execPath,
    arch,
    version: app.getVersion(),
    build_channel: channel,
    install_path: bundlePath,
    installed_at_standard_location: installedAtStandard,
    service: {
      install_path: service.installPath ?? "not installed",
      installed: service.installed,
      enabled: service.enabled === "enabled" ? true : service.enabled === "disabled" ? false : null,
    },
    state_directory: stateDirectory,
    runtime_started: false,
    inference_calls: 0,
    components: componentResults,
    checks,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

function readChannel(): string | null {
  // Info.plist values are available through app.getVersion for the version but
  // not for custom keys; Electron exposes the bundle path, so read the plist
  // once with a bounded parse instead of spawning a tool in the acceptance run.
  try {
    const infoPath = join(app.getAppPath(), "..", "..", "Info.plist");
    const xml = readFileSync(infoPath, "utf8");
    const match = /<key>MonaBuildChannel<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
