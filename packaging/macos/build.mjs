#!/usr/bin/env node
// P21 — build a self-contained Apple Silicon Mona.app and a flat installer.
//
// Local mode needs no Developer ID: it ad-hoc signs, labels the package and the
// app channel as a local development build, and never claims to be a shareable
// release. Release mode is owned by P22 and fails closed here: it refuses to
// emit an unsigned or unnotarized package that could be mistaken for production.
import { packager } from "@electron/packager";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { buildIconSet, renderInstallerBackground } from "./icon.mjs";
import {
  APP_BUNDLE_ID,
  APP_PATH,
  MINIMUM_MACOS,
  PACKAGE_ID,
  RECEIPT_PATH,
  SERVICE_BUNDLE_ID,
  SERVICE_PATH,
  OWNED_PATHS_PATH,
  UNINSTALL_PATH,
  UNINSTALL_SCRIPT,
  packageFileName,
  renderComponentPlist,
  renderDistribution,
  renderOwnedPaths,
} from "./lib/distribution.mjs";
import { readMachO } from "./lib/macho.mjs";
import { reviewUninstallScript } from "./lib/uninstall.mjs";
import { assertRehearsalRoot as guardRehearsalRoot } from "./lib/rehearsal.mjs";
import {
  DEFAULT_SECRET_PATTERNS,
  buildHostPatterns,
  isProbablyText,
  scanNames,
  scanText,
} from "./lib/secrets.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const PACKAGING = join(ROOT, "packaging/macos");
const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");
const PINNED_ENGINE = {
  version: "0.10.2",
  commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e",
  sha256: "da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d",
  source: "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale",
};
const NATIVE = {
  supervisor: join(ROOT, "native/macos-supervisor/build/mona-supervisor"),
  pty: join(ROOT, "native/macos-pty/build/mona-pty"),
  service: join(ROOT, "native/macos-services/build/Mona.service"),
};
const TOOLS = {
  codesign: "/usr/bin/codesign",
  pkgbuild: "/usr/bin/pkgbuild",
  productbuild: "/usr/bin/productbuild",
  productsign: "/usr/bin/productsign",
  pkgutil: "/usr/sbin/pkgutil",
  plutil: "/usr/bin/plutil",
  ditto: "/usr/bin/ditto",
  swiftc: ["xcrun", ["--sdk", "macosx", "swiftc"]],
  security: "/usr/bin/security",
  lsregister:
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
};

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const mode = option("--mode", "local");
if (mode !== "local" && mode !== "release") {
  console.error(`unknown --mode ${mode}; use local or release`);
  process.exit(2);
}
const channel = mode;
const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = option("--version", String(rootPackage.version).replace(/-p\d+$/, ""));
const build = option("--build", gitBuildNumber());
const outDir = resolve(option("--out", join(PACKAGING, "out")));
const stageDir = join(outDir, "stage");
const startedAt = new Date().toISOString();
const logLines = [];

function log(message) {
  logLines.push(message);
  console.log(`[p21] ${message}`);
}

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    timeout: options.timeout ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  const captured = {
    command: [command, ...commandArgs].join(" "),
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (captured.status !== 0 && !options.allowFailure) {
    fail(`${command} failed`, {
      command: captured.command,
      status: captured.status,
      stderr: captured.stderr.slice(-4000),
    });
  }
  return captured;
}

function capture(command, commandArgs, options = {}) {
  return run(command, commandArgs, { ...options, allowFailure: true });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function git(argsList) {
  const result = capture("/usr/bin/git", argsList);
  return result.status === 0 ? result.stdout.trim() : "";
}

function gitBuildNumber() {
  const count = git(["rev-list", "--count", "HEAD"]);
  return /^\d+$/.test(count) ? count : "1";
}

function walk(dir, options = {}) {
  const entries = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const info = lstatSync(path);
      const relativePath = relative(options.base ?? dir, path);
      if (info.isSymbolicLink()) {
        entries.push({ path, relativePath, kind: "symlink", info });
        continue;
      }
      if (info.isDirectory()) {
        if (
          options.skip?.some((skip) => relativePath === skip || relativePath.startsWith(`${skip}/`))
        ) {
          continue;
        }
        entries.push({ path, relativePath, kind: "directory", info });
        visit(path);
      } else if (info.isFile()) {
        entries.push({ path, relativePath, kind: "file", info });
      }
    }
  };
  visit(dir);
  return entries;
}

function machOInfo(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size < 8) return null;
    const header = Buffer.alloc(Math.min(info.size, 1024 * 1024));
    const fd = openSync(path, "r");
    let read = 0;
    try {
      read = readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
    return readMachO(header.subarray(0, read));
  } catch {
    return null;
  }
}

function normalizeMtimes(dir) {
  const entries = walk(dir);
  for (const entry of [...entries].reverse()) {
    lutimesSync(entry.path, FIXED_MTIME, FIXED_MTIME);
  }
  lutimesSync(dir, FIXED_MTIME, FIXED_MTIME);
}

function assertArm64Host() {
  if (process.platform !== "darwin")
    fail(`packaging requires macOS; this host is ${process.platform}`);
  if (process.arch !== "arm64")
    fail(`packaging requires an arm64 host; this host is ${process.arch}`);
  const uname = capture("/usr/bin/uname", ["-m"]);
  if (uname.stdout.trim() !== "arm64") fail(`uname reports ${uname.stdout.trim()}, not arm64`);
  const translated = capture("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]);
  if (translated.stdout.trim() === "1") fail("this process is running under Rosetta");
}

function checkTools() {
  for (const tool of [TOOLS.codesign, TOOLS.pkgbuild, TOOLS.productbuild, TOOLS.pkgutil]) {
    if (!existsSync(tool)) fail(`required packaging tool is missing: ${tool}`);
  }
  const swift = capture(TOOLS.swiftc[0], [...TOOLS.swiftc[1], "--version"]);
  if (swift.status !== 0) fail("swiftc is unavailable; install Xcode Command Line Tools");
  return {
    swift: (swift.stdout.split("\n")[0] ?? "").trim(),
    os: capture("/usr/bin/sw_vers", ["-productVersion"]).stdout.trim(),
    xcode: capture("/usr/bin/xcode-select", ["-p"]).stdout.trim(),
  };
}

function signingIdentities() {
  const result = capture(TOOLS.security, ["find-identity", "-v", "-p", "codesigning"]);
  const identities = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (match) identities.push({ sha1: match[1], name: match[2] });
  }
  return identities;
}

function ensureInputs() {
  if (flag("--skip-build")) {
    if (
      !existsSync(join(ROOT, "dist/main/main/index.js")) ||
      !existsSync(join(ROOT, "dist/renderer/index.html"))
    ) {
      fail("dist/ is missing and --skip-build was given");
    }
  } else {
    // Always rebuild: packaging an older dist than the source is the classic
    // way to ship a payload that does not contain the change under test.
    log("building main and renderer bundles");
    run("npm", ["run", "build"], { stdio: "inherit" });
  }
  const nativeBuilds = [
    [NATIVE.supervisor, "build:supervisor"],
    [NATIVE.pty, "build:pty"],
    [NATIVE.service, "build:service"],
  ];
  for (const [path, script] of nativeBuilds) {
    if (flag("--skip-build")) {
      if (!existsSync(path))
        fail(`native component is missing and --skip-build was given: ${path}`);
      continue;
    }
    log(`building native component with npm run ${script}`);
    run("npm", ["run", script], { stdio: "inherit" });
    if (!existsSync(path)) fail(`native build did not produce ${path}`);
  }
}

function resolveEngine() {
  const explicit = process.env.CODEWHALE_BIN;
  const path = explicit ?? PINNED_ENGINE.source;
  if (!existsSync(path)) fail(`qualified Codewhale engine is missing: ${path}`);
  const versionRun = run(path, ["--version"]);
  const parsed = /codewhale\s+(\S+)\s+\(([0-9a-f]+)\)/i.exec(versionRun.stdout);
  if (!parsed) fail(`could not read the engine version from ${path}`, versionRun.stdout);
  if (
    parsed[1] !== PINNED_ENGINE.version ||
    parsed[2].length < 12 ||
    !PINNED_ENGINE.commit.startsWith(parsed[2])
  ) {
    fail(
      `engine ${parsed[1]} (${parsed[2]}) is not the pinned ${PINNED_ENGINE.version} (${PINNED_ENGINE.commit.slice(0, 12)})`,
    );
  }
  const digest = sha256File(path);
  if (!explicit && digest !== PINNED_ENGINE.sha256) {
    fail(
      "the installed engine bytes differ from the qualified 0.10.2 artifact; " +
        "record an engine compatibility decision before packaging",
      { expected: PINNED_ENGINE.sha256, observed: digest },
    );
  }
  const info = machOInfo(path);
  if (!info?.architectures.includes("arm64")) fail("the engine binary is not arm64");
  return {
    path,
    source: explicit ? "explicit_external" : "installed_native",
    version: parsed[1],
    commit: PINNED_ENGINE.commit,
    upstream_sha256: digest,
    architectures: info.architectures,
    min_os: info.minOs,
  };
}

function findElectronZip(electronVersion) {
  const cache = join(process.env.HOME ?? "", "Library/Caches/electron");
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache).sort()) {
    const candidate = join(cache, entry, `electron-v${electronVersion}-darwin-arm64.zip`);
    if (existsSync(candidate)) return dirname(candidate);
  }
  return null;
}

async function buildApp({ electronVersion, icon }) {
  const appSource = join(stageDir, "app");
  const packOut = join(stageDir, "packager");
  rmSync(appSource, { recursive: true, force: true });
  rmSync(packOut, { recursive: true, force: true });
  mkdirSync(join(appSource, "node_modules"), { recursive: true });
  cpSync(join(ROOT, "dist"), join(appSource, "dist"), { recursive: true });
  cpSync(join(ROOT, "node_modules/zod"), join(appSource, "node_modules/zod"), {
    recursive: true,
  });
  pruneSourceOnlyFiles(join(appSource, "node_modules/zod"));
  writeFileSync(
    join(appSource, "package.json"),
    JSON.stringify(
      {
        name: "mona",
        productName: "Mona",
        version,
        description: "Mona — a native Apple Silicon workbench for the Codewhale engine",
        main: "dist/main/main/index.js",
        private: true,
        license: "UNLICENSED",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  assertCleanAppSource(appSource);

  const electronZipDir = findElectronZip(electronVersion);
  if (!electronZipDir)
    log("Electron zip is not cached; the packager will fetch the pinned release");

  const results = await packager({
    dir: appSource,
    out: packOut,
    name: "Mona",
    platform: "darwin",
    arch: "arm64",
    electronVersion,
    ...(electronZipDir ? { electronZipDir } : {}),
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.developer-tools",
    appVersion: version,
    buildVersion: build,
    asar: false,
    overwrite: true,
    prune: false,
    osxSign: false,
    icon,
    extendInfo: {
      LSMinimumSystemVersion: MINIMUM_MACOS,
      CFBundleDisplayName: "Mona",
      MonaBuildChannel: channel,
      MonaBuildVersion: build,
      NSHumanReadableCopyright: "Mona. Local build; not for redistribution.",
    },
  });
  const appBundle = join(results[0], "Mona.app");
  if (!existsSync(appBundle)) fail("packager did not produce Mona.app");
  // Electron names its default icon electron.icns and the packager overwrites
  // those bytes with ours. Give the icon its real name so About, Finder, and
  // the installer show Mona rather than "Electron".
  const resources = join(appBundle, "Contents/Resources");
  copyFileSync(icon, join(resources, "Mona.icns"));
  // The same mark in the Windows container. macOS never reads an `.ico`, but the
  // logo is asked for in both formats, so it ships instead of existing only in
  // the build directory.
  copyFileSync(join(dirname(icon), "Mona.ico"), join(resources, "Mona.ico"));
  rmSync(join(resources, "electron.icns"), { force: true });
  run(TOOLS.plutil, [
    "-replace",
    "CFBundleIconFile",
    "-string",
    "Mona.icns",
    join(appBundle, "Contents/Info.plist"),
  ]);
  return appBundle;
}

/**
 * zod publishes source and declaration trees beside its runtime. They are not
 * loaded by Node, so removing them keeps the signed payload to runtime files
 * and makes the "no product source in the package" rule literal.
 */
function pruneSourceOnlyFiles(root) {
  for (const entry of walk(root)) {
    if (entry.kind !== "file") continue;
    if (/\.(ts|cts|mts|md|map)$/i.test(entry.relativePath)) {
      rmSync(entry.path, { force: true });
    }
  }
}

function assertCleanAppSource(appSource) {
  const allowed = new Set(["dist", "node_modules", "package.json"]);
  for (const name of readdirSync(appSource)) {
    if (!allowed.has(name)) fail(`unexpected staging input: ${name}`);
  }
  const moduleNames = readdirSync(join(appSource, "node_modules")).sort();
  if (moduleNames.length !== 1 || moduleNames[0] !== "zod") {
    fail(
      `the packaged app must carry only the runtime dependency zod, found: ${moduleNames.join(", ")}`,
    );
  }
  const files = walk(appSource, { base: appSource });
  for (const file of files) {
    if (file.kind === "symlink") fail(`staging input contains a symlink: ${file.relativePath}`);
    if (/\.map$/i.test(file.relativePath))
      fail(`staging input contains a source map: ${file.relativePath}`);
    if (/\.(ts|tsx|cts|mts)$/i.test(file.relativePath))
      fail(`staging input contains TypeScript source: ${file.relativePath}`);
  }
}

function licenseTexts() {
  return [
    {
      name: "Electron",
      version: readElectronVersion(),
      license: "MIT",
      source: "node_modules/electron/LICENSE",
      path: join(ROOT, "node_modules/electron/LICENSE"),
    },
    {
      name: "Chromium and third-party notices (Electron distribution)",
      version: readElectronVersion(),
      license: "see LICENSES.chromium.html",
      source: "node_modules/electron/dist/LICENSES.chromium.html",
      path: join(ROOT, "node_modules/electron/dist/LICENSES.chromium.html"),
    },
    {
      name: "Codewhale",
      version: PINNED_ENGINE.version,
      license: "MIT",
      source: "packaging/macos/resources/LICENSE.codewhale.txt",
      path: join(PACKAGING, "resources/LICENSE.codewhale.txt"),
    },
    {
      name: "React",
      version: readDependencyVersion("react"),
      license: "MIT",
      source: "node_modules/react/LICENSE",
      path: join(ROOT, "node_modules/react/LICENSE"),
    },
    {
      name: "React DOM",
      version: readDependencyVersion("react-dom"),
      license: "MIT",
      source: "node_modules/react-dom/LICENSE",
      path: join(ROOT, "node_modules/react-dom/LICENSE"),
    },
    {
      name: "zod",
      version: readDependencyVersion("zod"),
      license: "MIT",
      source: "node_modules/zod/LICENSE",
      path: join(ROOT, "node_modules/zod/LICENSE"),
    },
  ].map((license) => {
    if (!existsSync(license.path)) fail(`license text is missing: ${license.source}`);
    return { ...license, sha256: sha256File(license.path) };
  });
}

function readElectronVersion() {
  try {
    return readFileSync(join(ROOT, "node_modules/electron/dist/version"), "utf8").trim();
  } catch {
    return String(
      JSON.parse(readFileSync(join(ROOT, "node_modules/electron/package.json"), "utf8")).version,
    );
  }
}

function readDependencyVersion(name) {
  return JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version;
}

function writeNotices(resources, licenses) {
  const noticesDir = join(resources, "notices");
  mkdirSync(noticesDir, { recursive: true });
  const parts = [
    "Mona — third-party notices",
    `Version ${version} · ${channel === "local" ? "local development build" : "release build"}`,
    "",
    "Mona is a frontend for the Codewhale engine. The payload includes the pinned",
    "Codewhale 0.10.2 binary (MIT), Electron (MIT, with Chromium's third-party",
    "notices), React, React DOM, and zod (all MIT).",
    "",
  ];
  const files = [
    ["LICENSE.electron.txt", licenses[0].path],
    ["LICENSE.codewhale.txt", licenses[2].path],
    ["LICENSE.react.txt", licenses[3].path],
    ["LICENSE.react-dom.txt", licenses[4].path],
    ["LICENSE.zod.txt", licenses[5].path],
  ];
  for (const [name, source] of files) {
    copyFileSync(source, join(noticesDir, name));
    chmodSync(join(noticesDir, name), 0o644);
  }
  copyFileSync(licenses[1].path, join(noticesDir, "LICENSES.chromium.html"));
  chmodSync(join(noticesDir, "LICENSES.chromium.html"), 0o644);
  for (const [name, source] of files) {
    const text = readFileSync(source, "utf8").trim();
    parts.push(`===== ${name} =====`, "", text, "");
  }
  parts.push(
    "===== LICENSES.chromium.html =====",
    "",
    "The complete Chromium and third-party license text from the pinned Electron",
    "distribution is included beside this notice as LICENSES.chromium.html.",
    "",
  );
  writeFileSync(join(noticesDir, "THIRD-PARTY-NOTICES.txt"), parts.join("\n"), "utf8");
  return licenses;
}

function addPayloadResources(appBundle, engine, licenses) {
  const resources = join(appBundle, "Contents/Resources");
  mkdirSync(join(resources, "engine"), { recursive: true });
  mkdirSync(join(resources, "native"), { recursive: true });
  mkdirSync(join(resources, "docs"), { recursive: true });

  copyFileSync(engine.path, join(resources, "engine/codewhale"));
  chmodSync(join(resources, "engine/codewhale"), 0o755);
  copyFileSync(NATIVE.supervisor, join(resources, "native/mona-supervisor"));
  chmodSync(join(resources, "native/mona-supervisor"), 0o755);
  copyFileSync(NATIVE.pty, join(resources, "native/mona-pty"));
  chmodSync(join(resources, "native/mona-pty"), 0o755);
  copyFileSync(
    join(ROOT, "docs/codewhale-capabilities-macos.json"),
    join(resources, "docs/codewhale-capabilities-macos.json"),
  );
  writeNotices(resources, licenses);
  return resources;
}

function signNested(appBundle, identity) {
  const entries = walk(appBundle, { base: appBundle });
  const macho = entries
    .filter((entry) => entry.kind === "file" && machOInfo(entry.path))
    .map((entry) => entry.path)
    .sort((a, b) => b.split(sep).length - a.split(sep).length);
  log(`signing ${macho.length} nested Mach-O files`);
  for (const path of macho) {
    run(TOOLS.codesign, ["--force", "--sign", identity, path]);
  }
  const bundles = entries
    .filter((entry) => entry.kind === "directory" && /\.(app|framework|xpc)$/.test(entry.path))
    .map((entry) => entry.path)
    .filter((path) => path !== appBundle)
    .sort((a, b) => b.split(sep).length - a.split(sep).length);
  for (const path of bundles) {
    run(TOOLS.codesign, ["--force", "--sign", identity, path]);
  }
  return { signed_components: macho.length, nested_bundles: bundles.length };
}

/** The outer signature must come last: it seals every resource, including the manifest. */
function signOuter(appBundle, identity) {
  run(TOOLS.codesign, ["--force", "--sign", identity, appBundle]);
  const verify = run(TOOLS.codesign, ["--verify", "--deep", "--strict", appBundle], {
    allowFailure: true,
  });
  if (verify.status !== 0) fail("the signed app failed codesign verification", verify.stderr);
  return describeSignature(appBundle);
}

function describeSignature(path) {
  const result = capture(TOOLS.codesign, ["-dv", "--verbose=4", path]);
  const text = `${result.stdout}\n${result.stderr}`;
  const authority = /Authority=(.+)/.exec(text)?.[1]?.trim() ?? null;
  const team = /TeamIdentifier=(.+)/.exec(text)?.[1]?.trim() ?? null;
  return {
    authority,
    team_identifier: team,
    ad_hoc: /Signature=adhoc/.test(text) || /flags=.*adhoc/.test(text),
    verified: true,
  };
}

function buildServiceBundle(payloadDir) {
  const destination = join(payloadDir, "Library/Services/Mona.service");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(NATIVE.service, destination, { recursive: true });
  run(TOOLS.plutil, [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    version,
    join(destination, "Contents/Info.plist"),
  ]);
  run(TOOLS.plutil, [
    "-replace",
    "CFBundleVersion",
    "-string",
    build,
    join(destination, "Contents/Info.plist"),
  ]);
  return destination;
}

function signService(serviceBundle, identity) {
  const executable = join(serviceBundle, "Contents/MacOS/MonaService");
  run(TOOLS.codesign, ["--force", "--sign", identity, executable]);
  run(TOOLS.codesign, ["--force", "--sign", identity, serviceBundle]);
  const verify = run(TOOLS.codesign, ["--verify", "--deep", "--strict", serviceBundle], {
    allowFailure: true,
  });
  if (verify.status !== 0) fail("the signed Finder Service failed verification", verify.stderr);
  return describeSignature(serviceBundle);
}

function componentList(resources, engine) {
  const entries = [
    // The app mark, sealed like any other payload byte: the bundle icon is what
    // Finder, About, and the Dock draw.
    ["Mona.icns", "image"],
    ["Mona.ico", "image"],
    ["engine/codewhale", "engine"],
    ["native/mona-supervisor", "native-helper"],
    ["native/mona-pty", "native-helper"],
    ["docs/codewhale-capabilities-macos.json", "data"],
    ["notices/THIRD-PARTY-NOTICES.txt", "notice"],
    ["notices/LICENSE.electron.txt", "notice"],
    ["notices/LICENSE.codewhale.txt", "notice"],
    ["notices/LICENSE.react.txt", "notice"],
    ["notices/LICENSE.react-dom.txt", "notice"],
    ["notices/LICENSE.zod.txt", "notice"],
    ["notices/LICENSES.chromium.html", "notice"],
  ];
  return entries.map(([path, kind]) => {
    const absolute = join(resources, path);
    const info = machOInfo(absolute);
    const hash = sha256File(absolute);
    return {
      path,
      kind,
      sha256: hash,
      size: statSync(absolute).size,
      architectures: info?.architectures ?? null,
      min_os: info?.minOs ?? null,
      upstream_sha256: path === "engine/codewhale" ? engine.upstream_sha256 : null,
    };
  });
}

function writeComponentManifest(resources, engine, components, licenses) {
  const manifest = {
    schema_version: 1,
    product: "Mona",
    version,
    build,
    channel,
    bundle_identifier: APP_BUNDLE_ID,
    minimum_macos: MINIMUM_MACOS,
    engine: {
      version: engine.version,
      commit: engine.commit,
      source: engine.source,
      upstream_sha256: engine.upstream_sha256,
    },
    components,
    licenses: licenses.map((license) => ({
      name: license.name,
      version: license.version,
      license: license.license,
      sha256: license.sha256,
    })),
  };
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(resources, "component-manifest.json"), serialized, "utf8");
  chmodSync(join(resources, "component-manifest.json"), 0o644);
  return { manifest, sha256: sha256Text(serialized) };
}

function dylibScan(paths) {
  const problems = [];
  const reports = [];
  for (const path of paths) {
    const result = capture("/usr/bin/otool", ["-L", path]);
    if (result.status !== 0) continue;
    const libraries = result.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (")[0])
      .filter(Boolean);
    reports.push({ path: relative(ROOT, path), libraries });
    for (const library of libraries) {
      const forbidden = /^\/(Users|opt\/homebrew|Library\/Developer)/.test(library);
      if (forbidden) problems.push({ path: relative(ROOT, path), library });
    }
  }
  return { ok: problems.length === 0, problems, reports };
}

function archScan(label, baseDir) {
  const problems = [];
  const components = [];
  for (const entry of walk(baseDir)) {
    if (entry.kind !== "file") continue;
    const info = machOInfo(entry.path);
    if (!info) continue;
    components.push({
      path: `${label}/${entry.relativePath}`,
      architectures: info.architectures,
      min_os: info.minOs,
    });
    if (!info.architectures.includes("arm64")) {
      problems.push({ path: entry.relativePath, architectures: info.architectures });
    }
  }
  return { ok: problems.length === 0, problems, count: components.length, components };
}

function secretScan(payloadDir) {
  const entries = walk(payloadDir);
  const names = scanNames(entries.map((entry) => entry.relativePath));
  const textEntries = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const info = statSync(entry.path);
    if (info.size > 20 * 1024 * 1024) continue;
    const buffer = readFileSync(entry.path);
    if (!isProbablyText(buffer)) continue;
    textEntries.push({ path: entry.relativePath, text: buffer.toString("utf8") });
  }
  for (const name of ["preinstall", "postinstall"]) {
    const path = join(PACKAGING, "scripts", name);
    if (existsSync(path)) {
      textEntries.push({ path: `installer-script/${name}`, text: readFileSync(path, "utf8") });
    }
  }
  const hits = scanText(
    textEntries,
    [...DEFAULT_SECRET_PATTERNS, ...buildHostPatterns(process.env.HOME, ROOT)],
    [
      {
        // The Git guard *names* the toolchain paths so it can decide whether
        // /usr/bin/git is a real tool or Apple's install-me stub. It never
        // depends on them; the dylib scan proves the actual linkage.
        path: /\/app\/dist\/main\/main\/work\/git\.js$/,
        labels: ["command-line-tools-path", "xcode-path"],
      },
    ],
  );
  return {
    ok: hits.length === 0 && names.length === 0,
    text_files: textEntries.length,
    hits,
    forbidden_names: names,
  };
}

function buildInstallerScripts(scriptsDir, { packageFile, manifestSha }) {
  rmSync(scriptsDir, { recursive: true, force: true });
  mkdirSync(scriptsDir, { recursive: true });
  const replacements = {
    "@@VERSION@@": version,
    "@@CHANNEL@@": channel,
    "@@PACKAGE_FILE@@": packageFile,
    "@@MANIFEST_SHA256@@": manifestSha,
  };
  for (const name of ["preinstall", "postinstall"]) {
    let text = readFileSync(join(PACKAGING, "scripts", name), "utf8");
    for (const [token, value] of Object.entries(replacements)) {
      text = text.replaceAll(token, value);
    }
    if (text.includes("@@")) fail(`installer script ${name} has an unresolved placeholder`);
    const target = join(scriptsDir, name);
    writeFileSync(target, text, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
}

function installerResources(resourcesDir) {
  rmSync(resourcesDir, { recursive: true, force: true });
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(join(resourcesDir, "background.png"), renderInstallerBackground());
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font:13px -apple-system,Helvetica,sans-serif;color:#1d2733;margin:0;padding:2px 6px}
h1{font-size:15px;margin:0 0 6px}p{margin:0 0 8px;line-height:1.4}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
</style></head><body>
<h1>Mona ${version}${channel === "local" ? " — local development build" : ""}</h1>
<p>Installs <code>Mona.app</code> in Applications and its Finder Service in
<code>/Library/Services</code>. The payload is complete: no download, Homebrew,
Node, Xcode, or command-line developer tools are needed to install or launch it.</p>
<p>Installation does not start Mona, connect to a model, or copy anyone's
settings. The first launch by each user creates that user's own state under
<code>~/Library/Application Support/Mona</code>; credentials and external
Codewhale installations are never touched.</p>
<p>${channel === "local" ? "This build is ad-hoc signed and intended for local development. It is not a shareable, signed release." : "This build is signed for release."}</p>
</body></html>`;
  writeFileSync(join(resourcesDir, "readme.html"), html, "utf8");
}

function rehearseInstall(payloadDir, scriptsDir) {
  const rehearsal = mkdtempSync(join(tmpdir(), "mona-p21-install-"));
  try {
    return rehearseInstallIn(rehearsal, payloadDir, scriptsDir);
  } finally {
    // A rehearsal copies the whole payload; leaving it behind leaked ~390 MB per
    // build and, on a nearly full disk, eventually stopped the build itself.
    rmSync(rehearsal, { recursive: true, force: true });
  }
}

function rehearseInstallIn(rehearsal, payloadDir, scriptsDir) {
  const root = guardRehearsalRoot(join(rehearsal, "root"), tmpdir());
  mkdirSync(join(root, "Applications"), { recursive: true });
  mkdirSync(join(root, "Library/Application Support"), { recursive: true });
  // Unrelated content must survive; the scripts may only touch owned paths.
  mkdirSync(join(root, "Applications/Other.app/Contents"), { recursive: true });
  writeFileSync(join(root, "Applications/Other.app/Contents/Info.plist"), "sentinel", "utf8");
  writeFileSync(join(root, "Library/Application Support/other-config.json"), "keep", "utf8");

  const install = () => {
    run(TOOLS.ditto, [join(payloadDir, "Applications"), join(root, "Applications")]);
    run(TOOLS.ditto, [join(payloadDir, "Library"), join(root, "Library")]);
  };
  const environment = { ...process.env, MONA_INSTALL_ROOT: root };
  install();
  run(join(scriptsDir, "preinstall"), [], { env: environment });
  if (existsSync(join(root, APP_PATH))) fail("preinstall did not remove the previous app");
  if (existsSync(join(root, SERVICE_PATH))) fail("preinstall did not remove the previous service");
  install();
  run(join(scriptsDir, "postinstall"), [], { env: environment });
  const receiptPath = join(root, RECEIPT_PATH);
  if (!existsSync(receiptPath)) fail("postinstall did not write the install receipt");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.version !== version || receipt.channel !== channel) {
    fail("install receipt does not describe this build", receipt);
  }
  // Second cycle: an idempotent reinstall.
  install();
  run(join(scriptsDir, "preinstall"), [], { env: environment });
  install();
  run(join(scriptsDir, "postinstall"), [], { env: environment });
  const surviving =
    existsSync(join(root, "Applications/Other.app/Contents/Info.plist")) &&
    readFileSync(join(root, "Library/Application Support/other-config.json"), "utf8") === "keep";
  if (!surviving) fail("installer rehearsal removed unrelated content");
  const appPresent = existsSync(join(root, APP_PATH));
  const servicePresent = existsSync(join(root, SERVICE_PATH));
  return {
    ok: appPresent && servicePresent,
    root,
    receipt,
    app_present: appPresent,
    service_present: servicePresent,
    idempotent_reinstall: true,
  };
}

/**
 * Rehearse the real removal utility against a temporary root. The script's
 * `MONA_UNINSTALL_ROOT` hook is the same one the installers use; without it this
 * would have to run as root against this Mac, which a build must never do.
 *
 * The root is installed the way Installer does it — payload, then preinstall and
 * postinstall — so the receipt and ownership manifest the utility depends on are
 * the ones the package actually produces.
 */
function rehearseUninstall(payloadDir, scriptsDir) {
  const rehearsal = mkdtempSync(join(tmpdir(), "mona-p23-uninstall-"));
  try {
    return rehearseUninstallIn(rehearsal, payloadDir, scriptsDir);
  } finally {
    rmSync(rehearsal, { recursive: true, force: true });
  }
}

function rehearseUninstallIn(rehearsal, payloadDir, scriptsDir) {
  const root = guardRehearsalRoot(join(rehearsal, "root"), tmpdir());
  const script = join(payloadDir, UNINSTALL_PATH);
  const env = { ...process.env, MONA_INSTALL_ROOT: root, MONA_UNINSTALL_ROOT: root };
  const runScript = (args, extraEnv = {}) =>
    run(script, args, { env: { ...env, ...extraEnv }, allowFailure: true });

  // Unrelated content must survive the uninstall.
  mkdirSync(join(root, "Applications"), { recursive: true });
  mkdirSync(join(root, "Library/Application Support"), { recursive: true });
  mkdirSync(join(root, "Applications/Other.app/Contents"), { recursive: true });
  writeFileSync(
    join(root, "Applications/Other.app/Contents/Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>",
    "utf8",
  );
  writeFileSync(join(root, "Library/Application Support/keep-me.json"), "user config", "utf8");

  const installPayload = () => {
    run(TOOLS.ditto, [join(payloadDir, "Applications"), join(root, "Applications")]);
    run(TOOLS.ditto, [join(payloadDir, "Library"), join(root, "Library")]);
  };
  installPayload();
  run(join(scriptsDir, "preinstall"), [], { env });
  installPayload();
  run(join(scriptsDir, "postinstall"), [], { env });

  const ownedPaths = [
    join(root, APP_PATH),
    join(root, SERVICE_PATH),
    join(root, RECEIPT_PATH),
    join(root, OWNED_PATHS_PATH),
    join(root, UNINSTALL_PATH),
  ];
  const installed = ownedPaths.filter((path) => existsSync(path));

  // 1. A dry run lists owned paths and changes nothing.
  const dry = runScript(["--dry-run"]);
  const dryKeptEverything =
    installed.length === ownedPaths.length && installed.every((path) => existsSync(path));
  const dryListedOwned =
    dry.stdout.includes(join(root, APP_PATH)) &&
    dry.stdout.includes(join(root, SERVICE_PATH)) &&
    !dry.stdout.includes("keep-me.json");

  // 2. A refused case: no ownership manifest is never a guess.
  const bareRoot = guardRehearsalRoot(join(rehearsal, "bare"), tmpdir());
  mkdirSync(join(bareRoot, "Applications"), { recursive: true });
  const bare = run(script, ["--yes"], {
    env: { ...process.env, MONA_UNINSTALL_ROOT: bareRoot },
    allowFailure: true,
  });
  const bareRefused = bare.status !== 0 && /ownership manifest/i.test(bare.stderr);

  // 3. A wrong-identifier app is refused rather than deleted.
  const foreignRoot = guardRehearsalRoot(join(rehearsal, "foreign"), tmpdir());
  mkdirSync(join(foreignRoot, "Applications/Mona.app/Contents"), { recursive: true });
  writeFileSync(
    join(foreignRoot, "Applications/Mona.app/Contents/Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>",
    "utf8",
  );
  mkdirSync(join(foreignRoot, "Library/Application Support/Mona"), { recursive: true });
  writeFileSync(
    join(foreignRoot, "Library/Application Support/Mona/owned-paths.json"),
    JSON.stringify({
      product: "Mona",
      owned: [{ path: "/Applications/Mona.app", kind: "app-bundle" }],
    }),
    "utf8",
  );
  writeFileSync(
    join(foreignRoot, "Library/Application Support/Mona/install-receipt.json"),
    JSON.stringify({ product: "Mona", version: "0.0.0" }),
    "utf8",
  );
  const foreign = run(script, ["--yes"], {
    env: { ...process.env, MONA_UNINSTALL_ROOT: foreignRoot },
    allowFailure: true,
  });
  const foreignRefused =
    foreign.status !== 0 &&
    existsSync(join(foreignRoot, "Applications/Mona.app/Contents/Info.plist"));

  // 4. The destructive branch: user data is deleted only for the one home
  // named, only inside the rehearsal root, and never the payload's neighbours.
  const rehearsalHome = guardRehearsalRoot(join(root, "home"), tmpdir());
  mkdirSync(join(rehearsalHome, "Library/Application Support/Mona"), { recursive: true });
  writeFileSync(
    join(rehearsalHome, "Library/Application Support/Mona/mona.sqlite"),
    "state",
    "utf8",
  );
  mkdirSync(join(rehearsalHome, "projects"), { recursive: true });
  writeFileSync(join(rehearsalHome, "projects/kept.txt"), "source", "utf8");
  const userData = runScript(["--remove-user-data", "--home", rehearsalHome, "--yes"]);
  const userDataRemoved = !existsSync(join(rehearsalHome, "Library/Application Support/Mona"));
  const projectsKept = existsSync(join(rehearsalHome, "projects/kept.txt"));
  // A home outside the rehearsal root is refused, so the bound is real.
  const outsideHome = mkdtempSync(join(tmpdir(), "mona-p23-other-home-"));
  mkdirSync(join(outsideHome, "Library/Application Support/Mona"), { recursive: true });
  const outside = runScript(["--remove-user-data", "--home", outsideHome, "--yes"]);
  const outsideRefused =
    outside.status !== 0 && existsSync(join(outsideHome, "Library/Application Support/Mona"));

  // 5. The real removal of the package payload.
  const removal = runScript(["--yes"]);
  const removed = [
    join(root, APP_PATH),
    join(root, SERVICE_PATH),
    join(root, RECEIPT_PATH),
    join(root, OWNED_PATHS_PATH),
    join(root, UNINSTALL_PATH),
  ].every((path) => !existsSync(path));
  const unrelatedPreserved =
    existsSync(join(root, "Applications/Other.app/Contents/Info.plist")) &&
    existsSync(join(root, "Library/Application Support/keep-me.json"));

  const ok =
    dry.status === 0 &&
    dryKeptEverything &&
    dryListedOwned &&
    bareRefused &&
    foreignRefused &&
    userData.status === 0 &&
    userDataRemoved &&
    projectsKept &&
    outsideRefused &&
    removal.status === 0 &&
    removed &&
    unrelatedPreserved;
  return {
    ok,
    check: {
      dry_run_exit: dry.status,
      dry_run_changed_nothing: dryKeptEverything,
      dry_run_lists_owned: dryListedOwned,
      missing_manifest_refused: bareRefused,
      foreign_bundle_refused: foreignRefused,
      user_data_removed_for_the_named_home: userDataRemoved,
      projects_preserved_by_user_data_removal: projectsKept,
      home_outside_rehearsal_root_refused: outsideRefused,
      removal_exit: removal.status,
      removed_owned_paths: removed,
      unrelated_content_preserved: unrelatedPreserved,
    },
    dry_run_stdout: dry.stdout.trim().split("\n").slice(0, 12),
    removal_stdout: removal.stdout.trim().split("\n").slice(0, 12),
  };
}

function expandAndCompare(packageFile, payloadDir) {
  const expandedRoot = mkdtempSync(join(tmpdir(), "mona-p21-expand-"));
  const expanded = join(expandedRoot, "expanded");
  run(TOOLS.pkgutil, ["--expand-full", packageFile, expanded]);
  const payload = join(expanded, "component.pkg", "Payload");
  if (!existsSync(payload)) fail("expanded package has no Payload");
  const expected = walk(payloadDir)
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({ path: entry.relativePath, sha256: sha256File(entry.path) }));
  const actual = new Map(
    walk(payload)
      .filter((entry) => entry.kind === "file")
      .map((entry) => [entry.relativePath, sha256File(entry.path)]),
  );
  const mismatches = expected.filter((entry) => actual.get(entry.path) !== entry.sha256);
  const extras = [...actual.keys()].filter(
    (path) => !expected.some((entry) => entry.path === path),
  );
  // Framework layouts depend on relative symlinks; compare their targets too.
  const links = (base) =>
    new Map(
      walk(base)
        .filter((entry) => entry.kind === "symlink")
        .map((entry) => [entry.relativePath, readlinkSync(entry.path)]),
    );
  const expectedLinks = links(payloadDir);
  const actualLinks = links(payload);
  const linkMismatches = [...expectedLinks].filter(
    ([path, target]) => actualLinks.get(path) !== target,
  );
  return {
    ok: mismatches.length === 0 && extras.length === 0 && linkMismatches.length === 0,
    files: actual.size,
    links: actualLinks.size,
    mismatches,
    extras,
    link_mismatches: linkMismatches,
    expanded,
  };
}

/**
 * Read back what the built installer declares about itself.
 *
 * This is the exact input `src/main/update/trust.ts` uses to identify an update
 * candidate, so a package that installs correctly but declares nothing usable
 * would make every update refused (or worse, accepted as another product).
 */
function verifyDeclaredMetadata(packageFile, expected) {
  const root = mkdtempSync(join(tmpdir(), "mona-p23-declared-"));
  const expanded = join(root, "expanded");
  const result = capture(TOOLS.pkgutil, ["--expand", packageFile, expanded]);
  if (result.status !== 0) {
    return { ok: false, problems: ["the package could not be expanded"], status: result.status };
  }
  const distribution = existsSync(join(expanded, "Distribution"))
    ? readFileSync(join(expanded, "Distribution"), "utf8")
    : "";
  let packageInfo = "";
  for (const entry of readdirSync(expanded)) {
    if (entry.endsWith(".pkg")) {
      const path = join(expanded, entry, "PackageInfo");
      if (existsSync(path)) packageInfo += readFileSync(path, "utf8");
    }
  }
  const problems = [];
  if (!/hostArchitectures="arm64"/.test(distribution)) {
    problems.push("Distribution does not restrict installation to arm64");
  }
  if (
    !new RegExp(`<os-version\\s+min="${MINIMUM_MACOS.replace(/\./g, "\\.")}"`).test(distribution)
  ) {
    problems.push(`Distribution does not declare a minimum of macOS ${MINIMUM_MACOS}`);
  }
  if (!new RegExp(`<pkg-info[^>]*\\bidentifier="${PACKAGE_ID}"`).test(packageInfo)) {
    problems.push(`PackageInfo does not declare the package identifier ${PACKAGE_ID}`);
  }
  if (
    !new RegExp(`<pkg-info[^>]*\\bversion="${expected.version.replace(/\./g, "\\.")}"`).test(
      packageInfo,
    )
  ) {
    problems.push(`PackageInfo does not declare version ${expected.version}`);
  }
  for (const [bundlePath, identifier] of [
    ["Applications/Mona.app", APP_BUNDLE_ID],
    ["Library/Services/Mona.service", SERVICE_BUNDLE_ID],
  ]) {
    const pattern = new RegExp(
      `<bundle\\b[^>]*\\bpath="\\.?/?${bundlePath.replace(/[.]/g, "\\.")}"[^>]*\\bid="${identifier}"`,
    );
    const reversed = new RegExp(
      `<bundle\\b[^>]*\\bid="${identifier}"[^>]*\\bpath="\\.?/?${bundlePath.replace(/[.]/g, "\\.")}"`,
    );
    if (!pattern.test(packageInfo) && !reversed.test(packageInfo)) {
      problems.push(`PackageInfo does not declare the ${identifier} bundle`);
    }
  }
  const buildMatch = new RegExp(`CFBundleVersion="${expected.build}"`).test(packageInfo);
  if (!buildMatch) problems.push(`PackageInfo does not declare build ${expected.build}`);
  rmSync(root, { recursive: true, force: true });
  if (problems.length > 0) return { ok: false, problems, declares: [] };
  return {
    ok: true,
    problems: [],
    declares: [
      `package id ${PACKAGE_ID}`,
      `version ${expected.version}`,
      `build ${expected.build}`,
      `bundles ${APP_BUNDLE_ID} + ${SERVICE_BUNDLE_ID}`,
      "arm64 only",
      `macOS ${MINIMUM_MACOS}+`,
    ],
  };
}

function packageSignature(packageFile) {
  const result = capture(TOOLS.pkgutil, ["--check-signature", packageFile]);
  return {
    status: result.status,
    signed: /signed/i.test(result.stdout) && !/unsigned/i.test(result.stdout),
    stdout: result.stdout.trim(),
  };
}

function plistValue(path, key) {
  const result = capture(TOOLS.plutil, ["-extract", key, "raw", path]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function copyToApplications(appBundle) {
  const target = "/Applications/Mona.app";
  if (existsSync(target)) {
    const channelAtTarget = plistValue(join(target, "Contents/Info.plist"), "MonaBuildChannel");
    if (channelAtTarget !== "local") {
      fail(
        `a non-local Mona is installed at ${target}; refusing to overwrite it with an ` +
          "unqualified local build. Move it aside before running the local milestone.",
      );
    }
    // A real package install is root-owned, so the build cannot and must not
    // replace it. If its payload is exactly this build, use it; otherwise ask
    // for the package to be installed first instead of silently smoking an old
    // copy.
    if (appDigest(target) !== appDigest(appBundle)) {
      fail(
        `the installed copy at ${target} is not this build; install ` +
          `${basename(packageFileName({ version, channel }))} with administrator authorization, then re-run`,
      );
    }
    return { path: target, replaced: false, matched_installed_copy: true };
  }
  run(TOOLS.ditto, [appBundle, target]);
  return { path: target, replaced: false, installed: true };
}

function pidsMatching(pattern) {
  const result = capture("/usr/bin/pgrep", ["-f", pattern]);
  return result.status === 0
    ? result.stdout
        .split("\n")
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
}

/** Commands of a process's direct children, used to spot Electron's helpers. */
function childCommands(pid) {
  const children = capture("/usr/bin/pgrep", ["-P", String(pid)]);
  if (children.status !== 0) return [];
  return children.stdout
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((child) => Number.isInteger(child) && child > 0)
    .map((child) => ({
      pid: child,
      command: capture("/bin/ps", ["-p", String(child), "-o", "command="]).stdout.trim(),
    }))
    .filter((child) => child.command.length > 0);
}

/**
 * Launch the installed app through LaunchServices with a fresh home and prove a
 * window process actually came up. The smoke mode proves the payload without a
 * window; this phase proves the ordinary GUI launch path.
 */
function runGuiLaunch(appPath, home) {
  const mainPattern = `${appPath}/Contents/MacOS/Mona`;
  const before = new Set(pidsMatching(mainPattern));
  const open = run(
    "/usr/bin/open",
    [
      "-na",
      appPath,
      "--env",
      `HOME=${home}`,
      "--env",
      `CFFIXED_USER_HOME=${home}`,
      "--env",
      `TMPDIR=${home}`,
      "--args",
      `--user-data-dir=${join(home, "Library/Application Support/Mona")}`,
    ],
    { allowFailure: true, timeout: 30_000 },
  );
  const deadline = Date.now() + 30_000;
  let mainPid = null;
  let rendererPid = null;
  while (Date.now() < deadline) {
    const mains = pidsMatching(mainPattern).filter((pid) => !before.has(pid));
    mainPid ??= mains[0] ?? null;
    if (mainPid) {
      const helpers = childCommands(mainPid).filter((child) =>
        child.command.includes("Mona Helper"),
      );
      const renderer = helpers.find((child) => child.command.includes("(Renderer)"));
      rendererPid ??= renderer?.pid ?? null;
    }
    if (mainPid && rendererPid) break;
    spawnSync("/bin/sleep", ["0.25"]);
  }
  const screenshot = join(outDir, "gui-launch.png");
  const shot = run("/usr/sbin/screencapture", ["-x", screenshot], { allowFailure: true });
  let exited = false;
  if (mainPid) {
    capture("/bin/kill", ["-TERM", String(mainPid)]);
    const waitUntil = Date.now() + 10_000;
    while (Date.now() < waitUntil) {
      if (!pidsMatching(mainPattern).includes(mainPid)) {
        exited = true;
        break;
      }
      spawnSync("/bin/sleep", ["0.2"]);
    }
    if (!exited) {
      capture("/bin/kill", ["-KILL", String(mainPid)]);
      exited = true;
    }
  }
  const leftovers = pidsMatching("Mona Helper");
  return {
    ok:
      open.status === 0 &&
      mainPid !== null &&
      rendererPid !== null &&
      existsSync(join(home, "Library/Application Support/Mona/state")),
    open_status: open.status,
    open_stderr: open.stderr.trim(),
    main_pid: mainPid,
    renderer_pid: rendererPid,
    screenshot: shot.status === 0 ? basename(screenshot) : null,
    screenshot_error: shot.status === 0 ? null : shot.stderr.trim() || "screencapture failed",
    home,
    state_initialized: existsSync(join(home, "Library/Application Support/Mona/state")),
    launched_and_exited: exited,
    leftover_helpers: leftovers,
  };
}

function runPackageSmoke(appPath) {
  const home = mkdtempSync(join(tmpdir(), "mona-p21-home-"));
  const reportPath = join(outDir, "package-smoke.json");
  mkdirSync(join(home, "Library/Application Support"), { recursive: true });
  // Cocoa resolves the home directory through CFFIXED_USER_HOME, not HOME.
  // Both are set so the acceptance run cannot read or write the builder's real
  // per-user Mona state.
  const environment = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  };
  const result = run(
    join(appPath, "Contents/MacOS/Mona"),
    [
      "--package-smoke",
      `--package-smoke-out=${reportPath}`,
      `--user-data-dir=${join(home, "Library/Application Support/Mona")}`,
    ],
    { env: environment, allowFailure: true, timeout: 180_000 },
  );
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = null;
  }
  return {
    ok: result.status === 0 && report?.ok === true,
    status: result.status,
    report,
    home,
    stderr: result.stderr.slice(-2000),
  };
}

function serviceDescriptor(serviceBundle) {
  const executable = join(serviceBundle, "Contents/MacOS/MonaService");
  const result = capture(executable, ["--describe"]);
  return {
    ok: result.status === 0 && /com\.mona\.workbench\.service/.test(result.stdout),
    status: result.status,
    descriptor: result.status === 0 ? safeJson(result.stdout) : result.stderr.trim(),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function appDigest(appBundle) {
  // A stable content digest: sorted relative paths plus file hashes, skipping
  // CodeResources (whose bytes differ between identical ad-hoc signings).
  const entries = [];
  for (const entry of walk(appBundle)) {
    if (entry.kind === "file") {
      if (entry.relativePath.endsWith("_CodeSignature/CodeResources")) continue;
      entries.push(`${entry.relativePath}\0${sha256File(entry.path)}\n`);
    } else if (entry.kind === "symlink") {
      entries.push(`${entry.relativePath}\0link:${readlinkSync(entry.path)}\n`);
    }
  }
  return sha256Text(entries.join(""));
}

function writeReports({
  appBundle,
  packageFile,
  manifest,
  componentManifest,
  checks,
  engine,
  licenses,
  tools,
  installRehearsal,
  expand,
  smoke,
  gui,
}) {
  const packageBytes = readFileSync(packageFile);
  const packageDigest = createHash("sha256").update(packageBytes).digest("hex");
  const buildManifest = {
    schema_version: 1,
    prompt: "P21",
    mode,
    channel,
    version,
    build,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    host: {
      os: tools.os,
      arch: process.arch,
      xcode_select: tools.xcode,
      swift: tools.swift,
      node: process.version,
    },
    source: {
      git_head: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      package_lock_sha256: sha256File(join(ROOT, "package-lock.json")),
    },
    electron: {
      version: readElectronVersion(),
      abi: readFileSync(join(ROOT, "node_modules/electron/abi_version"), "utf8").trim(),
      zip_source: findElectronZip(readElectronVersion()) ? "cache" : "download",
    },
    engine: {
      version: engine.version,
      commit: engine.commit,
      source: engine.source,
      upstream_sha256: engine.upstream_sha256,
      packaged_sha256: componentManifest.components.find(
        (component) => component.path === "engine/codewhale",
      )?.sha256,
      architectures: engine.architectures,
      min_os: engine.min_os,
    },
    app: {
      path: APP_PATH,
      bundle_identifier: APP_BUNDLE_ID,
      minimum_macos: MINIMUM_MACOS,
      content_sha256: appDigest(appBundle),
      size: directorySize(appBundle),
      signature: checks.app_signature,
    },
    service: {
      path: SERVICE_PATH,
      bundle_identifier: SERVICE_BUNDLE_ID,
      signature: checks.service_signature,
      descriptor: checks.service_descriptor,
    },
    package: {
      file: basename(packageFile),
      sha256: packageDigest,
      size: packageBytes.length,
      identifier: PACKAGE_ID,
      signed: checks.package_signature.signed,
      signature: checks.package_signature,
      payload_files: checks.payload_files,
    },
    components: manifest.components,
    licenses: licenses.map((license) => ({
      name: license.name,
      version: license.version,
      license: license.license,
      sha256: license.sha256,
    })),
    checks,
    install: {
      authorized_install_performed: false,
      reason:
        "installing a flat package requires administrator authorization; the local milestone " +
        "verifies the payload, installer scripts, and an installed-copy launch instead",
      command: `sudo installer -pkg ${basename(packageFile)} -target /`,
      rehearsal: {
        ok: installRehearsal.ok,
        idempotent_reinstall: installRehearsal.idempotent_reinstall,
        receipt: installRehearsal.receipt,
      },
      expand: {
        ok: expand.ok,
        files: expand.files,
        links: expand.links,
        mismatches: expand.mismatches,
        extras: expand.extras,
        link_mismatches: expand.link_mismatches,
      },
      package_smoke: {
        ok: smoke.ok,
        status: smoke.status,
        report: smoke.report,
      },
      gui_launch: gui,
    },
  };
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(buildManifest, null, 2) + "\n",
    "utf8",
  );
  const receipt = {
    schema_version: 1,
    product: "Mona",
    version,
    channel,
    package: basename(packageFile),
    package_sha256: packageDigest,
    package_size: packageBytes.length,
    app_content_sha256: appDigest(appBundle),
    engine_version: engine.version,
    engine_commit: engine.commit,
    engine_packaged_sha256: buildManifest.engine.packaged_sha256,
    build,
    built_at: buildManifest.finished_at,
    installable_checks: {
      payload_expanded: expand.ok,
      installer_rehearsal: installRehearsal.ok,
      package_smoke: smoke.ok,
      gui_launch: gui.ok,
    },
  };
  writeFileSync(
    join(outDir, "install-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    join(outDir, "sha256.txt"),
    `${packageDigest}  ${basename(packageFile)}\n${appDigest(appBundle)}  Mona.app (content)\n`,
    "utf8",
  );
  writeFileSync(join(outDir, "build.log"), logLines.join("\n") + "\n", "utf8");
  return { buildManifest, receipt };
}

function directorySize(dir) {
  let total = 0;
  for (const entry of walk(dir)) {
    if (entry.kind === "file") total += statSync(entry.path).size;
  }
  return total;
}

async function main() {
  assertArm64Host();
  const tools = checkTools();
  if (mode === "release") {
    const identities = signingIdentities();
    const application = identities.find((identity) =>
      identity.name.startsWith("Developer ID Application:"),
    );
    const installer = identities.find((identity) =>
      identity.name.startsWith("Developer ID Installer:"),
    );
    if (!application || !installer) {
      fail(
        "release mode requires Developer ID Application and Developer ID Installer identities; " +
          "P22 owns signed release qualification. Use --mode local for an ad-hoc development package.",
        { identities_found: identities.length },
      );
    }
    fail(
      "release packaging is not enabled yet: P22 adds notarization, stapling, and release verification. " +
        "Use --mode local for this milestone.",
    );
  }
  log(`mode=${mode} version=${version} build=${build} electron=${readElectronVersion()}`);
  ensureInputs();
  const engine = resolveEngine();
  log(`engine ${engine.version} (${engine.commit.slice(0, 12)}) sha256=${engine.upstream_sha256}`);
  const licenses = licenseTexts();
  mkdirSync(outDir, { recursive: true });
  // A report on disk must never describe a different build. The later gates
  // rewrite these; the install gate can stop the build before they are
  // rewritten, and a stale manifest.json next to a fresh package is worse than
  // no report at all.
  for (const stale of [
    "manifest.json",
    "install-receipt.json",
    "package-smoke.json",
    "declared-metadata.json",
    "uninstall-rehearsal.json",
    "package-report.json",
  ]) {
    rmSync(join(outDir, stale), { force: true });
  }
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const icon = buildIconSet(join(stageDir, "tools"));
  const appBundle = await buildApp({ electronVersion: readElectronVersion(), icon });
  log(`app bundle assembled at ${basename(appBundle)}`);
  const resources = addPayloadResources(appBundle, engine, licenses);
  normalizeMtimes(appBundle);
  // Sign the payload components first, then seal them (and the manifest that
  // records their final bytes) with the outer app signature.
  const nested = signNested(appBundle, "-");
  log(
    `signed ${nested.signed_components} Mach-O files and ${nested.nested_bundles} nested bundles`,
  );
  const components = componentList(resources, engine);
  const { manifest: componentManifest, sha256: componentManifestSha } = writeComponentManifest(
    resources,
    engine,
    components,
    licenses,
  );
  normalizeMtimes(appBundle);
  const appSignature = signOuter(appBundle, "-");
  appSignature.signed_components = nested.signed_components;
  log("app signed ad-hoc and sealed");

  const payloadDir = join(stageDir, "payload");
  mkdirSync(join(payloadDir, "Applications"), { recursive: true });
  run(TOOLS.ditto, [appBundle, join(payloadDir, APP_PATH)]);
  const serviceBundle = buildServiceBundle(payloadDir);
  const serviceSignature = signService(serviceBundle, "-");
  const descriptor = serviceDescriptor(serviceBundle);
  const ownedPaths = renderOwnedPaths({
    version,
    channel,
    packageFile: packageFileName({ version, channel }),
    components,
  });
  mkdirSync(dirname(join(payloadDir, OWNED_PATHS_PATH)), { recursive: true });
  writeFileSync(join(payloadDir, OWNED_PATHS_PATH), ownedPaths, "utf8");
  chmodSync(join(payloadDir, OWNED_PATHS_PATH), 0o644);
  // P23's removal utility ships with the payload it removes. It is a plain
  // POSIX sh script, never a compiled helper, so its bounds are auditable.
  const uninstallSource = join(PACKAGING, "scripts", UNINSTALL_SCRIPT);
  if (!existsSync(uninstallSource)) fail(`missing ${UNINSTALL_SCRIPT}`);
  const uninstallText = readFileSync(uninstallSource, "utf8");
  const uninstallProblems = reviewUninstallScript(uninstallText);
  if (uninstallProblems.length > 0) {
    fail("the uninstall utility breaks its own bounds", uninstallProblems);
  }
  copyFileSync(uninstallSource, join(payloadDir, UNINSTALL_PATH));
  chmodSync(join(payloadDir, UNINSTALL_PATH), 0o755);

  const scriptsDir = join(stageDir, "scripts");
  const packageFile = join(outDir, packageFileName({ version, channel }));
  buildInstallerScripts(scriptsDir, {
    packageFile: basename(packageFile),
    manifestSha: componentManifestSha,
  });
  const componentPlist = join(stageDir, "component.plist");
  writeFileSync(componentPlist, renderComponentPlist(), "utf8");
  const componentPackage = join(stageDir, "component.pkg");
  run(TOOLS.pkgbuild, [
    "--root",
    payloadDir,
    "--component-plist",
    componentPlist,
    "--scripts",
    scriptsDir,
    "--identifier",
    PACKAGE_ID,
    "--version",
    version,
    "--install-location",
    "/",
    "--ownership",
    "recommended",
    componentPackage,
  ]);
  log("component package built");
  const resourcesDir = join(stageDir, "resources");
  installerResources(resourcesDir);
  const distribution = join(stageDir, "distribution.xml");
  writeFileSync(
    distribution,
    renderDistribution({
      version,
      channel,
      componentFile: basename(componentPackage),
    }),
    "utf8",
  );
  rmSync(packageFile, { force: true });
  run(TOOLS.productbuild, [
    "--distribution",
    distribution,
    "--resources",
    resourcesDir,
    "--package-path",
    stageDir,
    packageFile,
  ]);
  log(`installer built: ${basename(packageFile)}`);

  const pkgSignature = packageSignature(packageFile);
  // P23 verifies a candidate's identity from the package's *own* metadata (a
  // metadata-only expand), so the artifact must actually declare what that
  // reader depends on. A silently dropped resource taught this lesson: prove it.
  const declared = verifyDeclaredMetadata(packageFile, { version, build });
  // Persisted as it passes, so the evidence survives a later gate stopping the
  // build (for example an install that needs administrator authorization).
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "declared-metadata.json"),
    JSON.stringify(
      {
        schema_version: 1,
        captured_at: new Date().toISOString(),
        package: basename(packageFile),
        ...declared,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  if (!declared.ok)
    fail("the built package does not declare the identities it is verified by", declared);
  log(`declared metadata verified: ${declared.declares.join(", ")}`);
  const payloadFiles = capture(TOOLS.pkgutil, ["--payload-files", packageFile]);
  const payloadCount = payloadFiles.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  const archApp = archScan("Mona.app", join(payloadDir, APP_PATH));
  const archService = archScan("Mona.service", serviceBundle);
  if (!archApp.ok) fail("the app payload contains non-arm64 Mach-O code", archApp.problems);
  if (!archService.ok)
    fail("the service payload contains non-arm64 Mach-O code", archService.problems);
  const dylibs = dylibScan([
    join(payloadDir, APP_PATH, "Contents/MacOS/Mona"),
    join(payloadDir, APP_PATH, "Contents/Resources/engine/codewhale"),
    join(payloadDir, APP_PATH, "Contents/Resources/native/mona-supervisor"),
    join(payloadDir, APP_PATH, "Contents/Resources/native/mona-pty"),
    join(serviceBundle, "Contents/MacOS/MonaService"),
  ]);
  if (!dylibs.ok) fail("a native component links a build-machine library", dylibs.problems);
  const secrets = secretScan(payloadDir);
  if (!secrets.ok) fail("the payload failed the secret/path scan", secrets);
  const nativeModules = walk(payloadDir)
    .filter((entry) => entry.kind === "file" && entry.relativePath.endsWith(".node"))
    .map((entry) => entry.relativePath);
  if (nativeModules.length > 0)
    fail("the payload contains unqualified native modules", nativeModules);
  if (walk(payloadDir).some((entry) => entry.relativePath.endsWith(".asar"))) {
    fail("the payload contains an ASAR archive; executables must stay in the signed payload");
  }
  const expand = expandAndCompare(packageFile, payloadDir);
  if (!expand.ok) fail("the expanded package does not match the staged payload", expand);
  const rehearsal = rehearseInstall(payloadDir, scriptsDir);
  if (!rehearsal.ok) fail("installer rehearsal failed", rehearsal);
  // P23: the removal utility must honour the same ownership boundary the
  // install scripts do, proven by running the script the payload ships.
  const uninstallRehearsal = rehearseUninstall(payloadDir, scriptsDir);
  // Written as it happens, so a build that stops at a later gate (for example an
  // install that needs administrator authorization) still leaves this evidence.
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "uninstall-rehearsal.json"),
    JSON.stringify(
      {
        schema_version: 1,
        tool: "mac:package",
        captured_at: new Date().toISOString(),
        ...uninstallRehearsal,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  if (!uninstallRehearsal.ok) fail("uninstall rehearsal failed", uninstallRehearsal);
  // The checks above concern the artifact itself. Record them now, because the
  // next step installs into /Applications and needs administrator
  // authorization, and a human may run that days later.
  const packageReport = {
    schema_version: 1,
    product: "Mona",
    version,
    build,
    channel,
    package: basename(packageFile),
    package_sha256: sha256File(packageFile),
    package_size: statSync(packageFile).size,
    verified_at: new Date().toISOString(),
    gates: {
      declared_metadata: declared,
      architecture: { ok: archApp.ok && archService.ok },
      dependencies: { ok: dylibs.ok },
      secrets: { ok: secrets.ok },
      payload_expand: { ok: expand.ok, files: expand.files, links: expand.links },
      install_rehearsal: { ok: rehearsal.ok, idempotent_reinstall: rehearsal.idempotent_reinstall },
      uninstall_rehearsal: { ok: uninstallRehearsal.ok, check: uninstallRehearsal.check },
    },
    pending: ["package smoke against /Applications", "LaunchServices GUI launch"],
    note:
      "These gates concern the package bytes and passed without administrator authorization. " +
      "The install gates below require an authorized install; re-run after installing to complete the record.",
  };
  writeFileSync(
    join(outDir, "package-report.json"),
    JSON.stringify(packageReport, null, 2) + "\n",
    "utf8",
  );
  log(`package report written: sha256=${packageReport.package_sha256.slice(0, 16)}…`);

  // Rehearse the service's own descriptor from the payload.
  const installed = copyToApplications(join(payloadDir, APP_PATH));
  const smoke = runPackageSmoke(installed.path);
  if (!smoke.ok) fail("the installed package smoke failed", smoke);
  const guiHome = mkdtempSync(join(tmpdir(), "mona-p21-gui-"));
  const gui = runGuiLaunch(installed.path, guiHome);
  if (!gui.ok) fail("the installed app did not launch through LaunchServices", gui);

  const checks = {
    architecture: {
      ok: archApp.ok && archService.ok,
      app_mach_o: archApp.count,
      service_mach_o: archService.count,
      min_os_by_component: archApp.components
        .filter((component) => component.min_os)
        .map((component) => ({ path: component.path, min_os: component.min_os })),
    },
    dependencies: { ok: dylibs.ok, scanned: dylibs.reports.length, problems: dylibs.problems },
    secrets: {
      ok: secrets.ok,
      scanned_text_files: secrets.text_files,
      hits: secrets.hits,
      forbidden_names: secrets.forbidden_names,
    },
    native_modules: { ok: nativeModules.length === 0, found: nativeModules },
    asar: {
      ok: true,
      note: "no ASAR archive; app code and executables remain in the signed payload",
    },
    app_signature: appSignature.signature,
    service_signature: serviceSignature,
    service_descriptor: descriptor,
    declared_metadata: declared,
    package_signature: {
      signed: pkgSignature.signed,
      ad_hoc: false,
      stdout: pkgSignature.stdout.split("\n").slice(0, 6).join("\n"),
    },
    payload_files: payloadCount,
    package_expand: {
      ok: expand.ok,
      files: expand.files,
      links: expand.links,
      mismatches: expand.mismatches,
      extras: expand.extras,
      link_mismatches: expand.link_mismatches,
    },
    install_rehearsal: {
      ok: rehearsal.ok,
      idempotent_reinstall: rehearsal.idempotent_reinstall,
      receipt: rehearsal.receipt,
    },
    uninstall_rehearsal: {
      ok: uninstallRehearsal.ok,
      check: uninstallRehearsal.check,
      dry_run_stdout: uninstallRehearsal.dry_run_stdout,
      removal_stdout: uninstallRehearsal.removal_stdout,
    },
    package_smoke: { ok: smoke.ok, report: smoke.report, stderr: smoke.stderr },
    gui_launch: gui,
    installed_copy: {
      path: installed.path,
      installed_by: "ditto (local milestone)",
      replaced: installed.replaced,
    },
  };

  const reports = writeReports({
    appBundle: join(payloadDir, APP_PATH),
    packageFile,
    manifest: { components },
    componentManifest,
    checks,
    engine,
    licenses,
    tools,
    installRehearsal: rehearsal,
    expand,
    smoke,
    gui,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode,
        package: packageFile,
        package_sha256: reports.receipt.package_sha256,
        app: reports.receipt.app_content_sha256,
        checks: {
          architecture: checks.architecture.ok,
          dependencies: checks.dependencies.ok,
          secrets: checks.secrets.ok,
          expand: expand.ok,
          rehearsal: rehearsal.ok,
          uninstall_rehearsal: uninstallRehearsal.ok,
          package_smoke: smoke.ok,
          gui_launch: gui.ok,
        },
        manifest: join(outDir, "manifest.json"),
        receipt: join(outDir, "install-receipt.json"),
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  const details = error?.details ? `\n${JSON.stringify(error.details, null, 2)}` : "";
  console.error(
    `[p21] FAILED: ${error instanceof Error ? error.message : String(error)}${details}`,
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "build.log"),
    `${logLines.join("\n")}\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    "utf8",
  );
  process.exit(1);
}
