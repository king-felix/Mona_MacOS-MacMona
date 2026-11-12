#!/usr/bin/env node
// Host and packaging readiness. Read-only: it runs no inference, starts no
// product process, and prints identity names, never private material.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const TOOLS = [
  "/usr/bin/codesign",
  "/usr/bin/pkgbuild",
  "/usr/bin/productbuild",
  "/usr/bin/productsign",
  "/usr/sbin/pkgutil",
  "/usr/bin/plutil",
  "/usr/bin/ditto",
  "/usr/sbin/installer",
  "/usr/bin/security",
];
const ENGINE =
  process.env.CODEWHALE_BIN ?? "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function version(command, args) {
  const result = run(command, args);
  return result.ok ? (result.stdout || result.stderr).split("\n")[0] : null;
}

const osVersion = version("/usr/bin/sw_vers", ["-productVersion"]);
const translated = run("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]);
const swift = run("xcrun", ["--sdk", "macosx", "swiftc", "--version"]);
const identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
const identityNames = identities.stdout
  .split("\n")
  .map((line) => /^\s*\d+\)\s+[0-9A-F]{40}\s+"(.+)"\s*$/.exec(line)?.[1])
  .filter(Boolean);
const disk = statfsSync(ROOT);
const freeGiB = (Number(disk.bavail) * Number(disk.bsize)) / 1024 ** 3;
const appBuilds = {
  supervisor: existsSync(join(ROOT, "native/macos-supervisor/build/mona-supervisor")),
  pty: existsSync(join(ROOT, "native/macos-pty/build/mona-pty")),
  service: existsSync(join(ROOT, "native/macos-services/build/Mona.service")),
  dist:
    existsSync(join(ROOT, "dist/main/main/index.js")) &&
    existsSync(join(ROOT, "dist/renderer/index.html")),
};
const engineVersion = existsSync(ENGINE) ? version(ENGINE, ["--version"]) : null;
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const checks = {
  macos: process.platform === "darwin",
  arm64: process.arch === "arm64",
  not_translated: translated.stdout !== "1",
  tools: TOOLS.every((tool) => existsSync(tool)),
  swift: swift.ok,
  engine: engineVersion !== null,
  artifacts: appBuilds.supervisor && appBuilds.pty && appBuilds.service && appBuilds.dist,
  disk_5gib: freeGiB >= 5,
};
const report = {
  schema_version: 1,
  prompt: "P21",
  ok: Object.values(checks).every(Boolean),
  host: {
    os: osVersion,
    arch: process.arch,
    rosetta: translated.stdout === "1",
    free_gib: Number(freeGiB.toFixed(1)),
  },
  tools: {
    codesign: version("/usr/bin/codesign", ["--version"]),
    pkgbuild: version("/usr/bin/pkgbuild", ["--version"]),
    productbuild: version("/usr/bin/productbuild", ["--version"]),
    swift: swift.ok ? swift.stdout.split("\n")[0] : null,
    xcode_select: run("/usr/bin/xcode-select", ["-p"]).stdout || null,
  },
  engine: {
    path_present: existsSync(ENGINE),
    version: engineVersion,
  },
  signing: {
    identities: identityNames,
    developer_id_application: identityNames.some((name) =>
      name.startsWith("Developer ID Application:"),
    ),
    developer_id_installer: identityNames.some((name) =>
      name.startsWith("Developer ID Installer:"),
    ),
    note: "P22 owns signed release qualification. Local packaging works without an identity.",
  },
  artifacts: appBuilds,
  product_version: String(packageJson.version).replace(/-p\d+$/, ""),
  checks,
  next: Object.values(checks).every(Boolean)
    ? "npm run mac:package:local"
    : "fix the failing checks, then run npm run mac:package:local",
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
