#!/usr/bin/env node
// R13 — qualify a built or installed Mona candidate from its own bytes.
//
// The packaging build verifies the payload it just assembled. This verifier
// answers a different question: *what is on disk now*, is it the build this
// checkout produced, and does it carry the features the review added? It reads
// the bundle's own component manifest, hashes every listed file, decodes every
// Mach-O header, and (optionally) runs the in-app acceptance sample against the
// installed app with an isolated home.
//
//   node scripts/r13-candidate-verify.mjs                       # /Applications/Mona.app
//   node scripts/r13-candidate-verify.mjs --app <path> --smoke
//   node scripts/r13-candidate-verify.mjs --app packaging/macos/out/stage/payload/Applications/Mona.app
//
// Exit 0 only when every required check passes. It starts no engine and makes no
// model request: the optional smoke is the app's own `--package-smoke` sample,
// which asserts the payload, not a turn.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { MINIMUM_MACOS } from "../packaging/macos/lib/distribution.mjs";
import { readMachO } from "../packaging/macos/lib/macho.mjs";
import { buildHostPatterns, isProbablyText, scanText } from "../packaging/macos/lib/secrets.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const appPath = resolve(option("--app", "/Applications/Mona.app"));
const outPath = resolve(
  option(
    "--out",
    join(ROOT, "docs/evidence/macos/review-studio/artifacts/r13-candidate-verify.json"),
  ),
);
const SMOKE = flag("--smoke");
const LAUNCH = flag("--launch");
let shutdownNotTestable = false;
const HOME = process.env.HOME ?? "";

const checks = {};
const facts = {};
function record(name, ok, detail) {
  checks[name] = { ok: ok === true, ...(detail === undefined ? {} : { detail }) };
}
function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function plist(path, key) {
  const result = capture("/usr/bin/plutil", ["-extract", key, "raw", path]);
  return result.status === 0 ? result.stdout.trim() : null;
}
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

// --- the bundle -------------------------------------------------------------

record("app_present", existsSync(appPath), appPath);
if (!checks.app_present.ok) finish();

const info = join(appPath, "Contents/Info.plist");
const identity = {
  bundle_id: plist(info, "CFBundleIdentifier"),
  version: plist(info, "CFBundleShortVersionString"),
  build: plist(info, "CFBundleVersion"),
  channel: plist(info, "MonaBuildChannel"),
  minimum_macos: plist(info, "LSMinimumSystemVersion"),
  executable: plist(info, "CFBundleExecutable"),
};
facts.identity = identity;
record(
  "bundle_identity",
  identity.bundle_id === "com.mona.workbench" && identity.executable === "Mona",
  identity,
);

const gitCount = capture("/usr/bin/git", ["-C", ROOT, "rev-list", "--count", "HEAD"]);
const sourceBuild = gitCount.status === 0 ? gitCount.stdout.trim() : null;
const head = capture("/usr/bin/git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
const dirty = capture("/usr/bin/git", ["-C", ROOT, "status", "--porcelain"]).stdout.trim();
facts.source = {
  commit: head.status === 0 ? head.stdout.trim() : null,
  build_number: sourceBuild,
  tree_clean: dirty.length === 0,
};
record(
  "build_number_matches_source",
  sourceBuild !== null && identity.build === sourceBuild && dirty.length === 0,
  {
    app: identity.build,
    source: sourceBuild,
    // The build numbers itself by commit count, so the tie only holds when the
    // tree that produced it is exactly this commit.
    tree_clean: dirty.length === 0,
    reason:
      dirty.length === 0
        ? null
        : "the checkout has uncommitted changes; the artifact cannot be tied to a commit",
  },
);

const manifestPath = join(appPath, "Contents/Resources/component-manifest.json");
record("component_manifest_present", existsSync(manifestPath), relative(ROOT, manifestPath));
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
facts.manifest = manifest
  ? {
      build: manifest.build,
      channel: manifest.channel,
      minimum_macos: manifest.minimum_macos,
      engine: manifest.engine,
      components: manifest.components.length,
    }
  : null;
record(
  "manifest_matches_bundle",
  manifest !== null && manifest.build === identity.build && manifest.channel === identity.channel,
  manifest ? { manifest_build: manifest.build, app_build: identity.build } : null,
);

// --- signatures -------------------------------------------------------------

const verify = capture("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
record("signature_verifies", verify.status === 0, verify.stderr.trim().slice(0, 400));

const described = capture("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
const authorityLine = described.stderr.split("\n").find((line) => /^Authority=/.test(line));
const teamLine = described.stderr.split("\n").find((line) => /^TeamIdentifier=/.test(line));
const runtimeLine = described.stderr.split("\n").find((line) => /^Runtime Version=/.test(line));
facts.signature = {
  authority: authorityLine ? authorityLine.replace(/^Authority=/, "") : null,
  team: teamLine ? teamLine.replace(/^TeamIdentifier=/, "") : null,
  hardened_runtime: runtimeLine ? runtimeLine.replace(/^Runtime Version=/, "") : null,
  tier: authorityLine ? "developer-id" : "ad-hoc local",
};
const assess = capture("/usr/bin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
facts.gatekeeper = {
  accepted: assess.status === 0,
  stdout: assess.stdout.trim().slice(0, 300),
  stderr: assess.stderr.trim().slice(0, 300),
};
// A local candidate is not expected to pass Gatekeeper; the record must say which
// tier it is rather than treating "rejected" as a build failure.
record(
  "signing_tier_recorded",
  facts.signature.tier === "developer-id" ||
    (facts.signature.tier === "ad-hoc local" && !facts.gatekeeper.accepted),
  { tier: facts.signature.tier, gatekeeper_accepted: facts.gatekeeper.accepted },
);

// --- components, architecture, minimum OS -----------------------------------

const components = manifest?.components ?? [];
const resourcesDir = join(appPath, "Contents/Resources");
const digestProblems = [];
const macho = [];
for (const component of components) {
  const path = join(resourcesDir, component.path);
  if (!existsSync(path)) {
    digestProblems.push({ path: component.path, problem: "missing" });
    continue;
  }
  const size = statSync(path).size;
  if (size !== component.size)
    digestProblems.push({ path: component.path, problem: `size ${size} != ${component.size}` });
  const digest = sha256(path);
  if (digest !== component.sha256)
    digestProblems.push({ path: component.path, problem: "sha256 differs" });
  const header = readMachO(readFileSync(path));
  if (header) {
    macho.push({
      path: component.path,
      architectures: header.architectures,
      min_os: header.minOs,
      listed_architectures: component.architectures,
    });
  }
}
facts.components_checked = components.length;
record("component_digests_match", components.length > 0 && digestProblems.length === 0, {
  checked: components.length,
  problems: digestProblems,
});

const wrongArchitecture = macho.filter((entry) =>
  entry.architectures.some((arch) => arch !== "arm64"),
);
record("arm64_only", macho.length > 0 && wrongArchitecture.length === 0, {
  mach_o_files: macho.length,
  violations: wrongArchitecture,
});

// The floor applies to the components Mona builds. The bundled engine is the
// pinned upstream 0.10.2 binary and keeps its own deployment target (11.0); it
// runs on 14.0+, and rewriting its header would be a silent engine change.
const appOwned = macho.filter((entry) => !entry.path.startsWith("engine/"));
const belowFloor = appOwned.filter(
  (entry) => entry.min_os && compareVersions(entry.min_os, MINIMUM_MACOS) < 0,
);
facts.minimum_os = {
  app_owned: [...new Set(appOwned.map((entry) => entry.min_os).filter(Boolean))].sort(),
  engine: macho
    .filter((entry) => entry.path.startsWith("engine/"))
    .map((entry) => ({
      path: entry.path,
      min_os: entry.min_os,
    })),
};
record("minimum_os_declared", belowFloor.length === 0, {
  floor: MINIMUM_MACOS,
  violations: belowFloor,
  note: "app-owned components only; the pinned engine keeps its own deployment target",
});

const required = [
  "native/mona-supervisor",
  "native/mona-pty",
  "engine/codewhale",
  "app/dist/main/main/index.js",
  "app/dist/main/preload/index.js",
];
const missingRequired = required.filter((path) => !existsSync(join(resourcesDir, path)));
record("native_components_present", missingRequired.length === 0, {
  required,
  missing: missingRequired,
});

// --- the review's own features, read from the shipped bundles ---------------

const mainBundle = join(resourcesDir, "app/dist/main");
const rendererBundle = join(resourcesDir, "app/dist/renderer");
function readTree(dir) {
  if (!existsSync(dir)) return "";
  return walk(dir)
    .filter((file) => /\.(js|css|html)$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}
const mainText = readTree(mainBundle);
const rendererText = readTree(rendererBundle);
// The renderer bundle is minified, so identifiers do not survive — the literals
// the reader sees and the channel names main registers do.
const markers = [
  { id: "projects:history-item", text: "R02 history item route" },
  { id: "commands:execute", text: "R04 command execution channel" },
  { id: "studio:answer-pending", text: "R07 pending-answer channel" },
  { id: "studio:follow-up-add", text: "R08 follow-up channel" },
  { id: "window:fullscreen:set", text: "R05 fullscreen channel" },
  { id: "Load earlier events", text: "R02 earlier-page control", in: "renderer" },
  { id: "Jump to latest", text: "R10 unread and jump control", in: "renderer" },
  { id: "Vivid", text: "R06 appearance intensity", in: "renderer" },
];
const missingMarkers = markers
  .filter(
    (marker) =>
      !(marker.in === "renderer" ? rendererText : mainText + rendererText).includes(marker.id),
  )
  .map((marker) => marker.text);
record("review_features_shipped", missingMarkers.length === 0, {
  markers: markers.length,
  missing: missingMarkers,
});

// --- hygiene ----------------------------------------------------------------

const textEntries = walk(appPath)
  .filter((file) => {
    try {
      return isProbablyText(readFileSync(file).subarray(0, 8192));
    } catch {
      return false;
    }
  })
  .map((file) => ({
    path: relative(appPath, file),
    text: readFileSync(file, "utf8").slice(0, 2_000_000),
  }));
const hostPatterns = buildHostPatterns(HOME, ROOT);
const hostHits = scanText(textEntries, hostPatterns, [
  {
    // The Git guard *names* the toolchain paths so it can decide whether
    // /usr/bin/git is a real tool or Apple's install-me stub. Same documented
    // allowance the packaging gate carries; it never depends on those paths.
    path: /\/app\/dist\/main\/main\/work\/git\.js$/,
    labels: ["command-line-tools-path", "xcode-path"],
  },
]);
record("no_developer_paths", hostHits.length === 0, {
  scanned: textEntries.length,
  hits: hostHits.slice(0, 10),
});

// --- optional in-app acceptance sample --------------------------------------

if (SMOKE) {
  const home = mkdtempSync(join(tmpdir(), "mona-r13-smoke-"));
  const reportPath = join(home, "package-smoke.json");
  const binary = join(appPath, "Contents/MacOS/Mona");
  const run = spawnSync(
    binary,
    [
      "--package-smoke",
      `--package-smoke-out=${reportPath}`,
      `--user-data-dir=${join(home, "Library/Application Support/Mona")}`,
    ],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: {
        HOME: home,
        CFFIXED_USER_HOME: home,
        TMPDIR: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
      },
    },
  );
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = null;
  }
  facts.package_smoke = {
    exit: run.status,
    ok: report?.ok === true,
    checks: report?.checks ?? null,
    stderr: (run.stderr ?? "").trim().slice(0, 400),
  };
  record("package_smoke", run.status === 0 && report?.ok === true, facts.package_smoke);
  rmSync(home, { recursive: true, force: true });
}

// --- optional LaunchServices qualification ----------------------------------

if (LAUNCH) {
  // Mirrors the packaging build's GUI phase: a real LaunchServices launch with a
  // fresh home, then a graceful TERM and a check that nothing is left behind.
  //
  // A copy that is not at /Applications/Mona.app while the installed app exists
  // is a duplicate by the product's own rule (src/main/install-location.ts): it
  // raises a modal notice and will not quit until someone answers it. The launch
  // is still real evidence; the shutdown assertion belongs to the installed copy.
  const duplicateCopy =
    appPath !== "/Applications/Mona.app" && existsSync("/Applications/Mona.app");
  shutdownNotTestable = duplicateCopy;
  const home = mkdtempSync(join(tmpdir(), "mona-r13-launch-"));
  const mainPattern = `${appPath}/Contents/MacOS/Mona`;
  const pids = (pattern) => {
    const result = capture("/usr/bin/pgrep", ["-f", pattern]);
    return result.status === 0
      ? result.stdout
          .split("\n")
          .map(Number)
          .filter((pid) => Number.isInteger(pid) && pid > 0)
      : [];
  };
  const before = new Set(pids(mainPattern));
  const opened = capture("/usr/bin/open", [
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
  ]);
  const deadline = Date.now() + 30_000;
  let mainPid = null;
  let rendererPid = null;
  while (Date.now() < deadline) {
    mainPid ??= pids(mainPattern).find((pid) => !before.has(pid)) ?? null;
    if (mainPid) {
      const children = capture("/usr/bin/pgrep", ["-P", String(mainPid)])
        .stdout.split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0)
        .map((pid) => ({
          pid,
          command: capture("/bin/ps", ["-p", String(pid), "-o", "command="]).stdout,
        }));
      rendererPid ??= children.find((child) => child.command.includes("(Renderer)"))?.pid ?? null;
    }
    if (mainPid && rendererPid) break;
    spawnSync("/bin/sleep", ["0.25"]);
  }
  let exited = false;
  if (mainPid) {
    capture("/bin/kill", ["-TERM", String(mainPid)]);
    const waitUntil = Date.now() + 10_000;
    while (Date.now() < waitUntil) {
      if (!pids(mainPattern).includes(mainPid)) {
        exited = true;
        break;
      }
      spawnSync("/bin/sleep", ["0.2"]);
    }
  }
  let modalNotice = null;
  if (duplicateCopy && mainPid) {
    const samplePath = join(tmpdir(), `mona-r13-sample-${mainPid}.txt`);
    capture("/usr/bin/sample", [String(mainPid), "1", "-file", samplePath]);
    if (existsSync(samplePath)) {
      modalNotice = readFileSync(samplePath, "utf8").includes("runModal");
      rmSync(samplePath, { force: true });
    }
  }
  facts.launch = {
    duplicate_copy: duplicateCopy,
    modal_notice_observed: modalNotice,
    open_exit: opened.status,
    open_stderr: opened.stderr.trim().slice(0, 300),
    main_pid: mainPid,
    renderer_pid: rendererPid,
    state_initialized: existsSync(join(home, "Library/Application Support/Mona/state")),
    exited_on_term: exited,
    leftover_helpers: pids("Mona Helper").filter((pid) => !before.has(pid)),
  };
  record(
    "launchservices_launch",
    opened.status === 0 &&
      mainPid !== null &&
      rendererPid !== null &&
      facts.launch.state_initialized,
    {
      main_pid: mainPid,
      renderer_pid: rendererPid,
      state_initialized: facts.launch.state_initialized,
      duplicate_copy: duplicateCopy,
    },
  );
  if (duplicateCopy) {
    // The product states the rule and enforces it; this is the measurement of
    // that enforcement, not a shutdown defect.
    record("duplicate_copy_notice", modalNotice === true, {
      detail:
        "a packaged copy outside /Applications/Mona.app raises a modal notice while the installed app exists; " +
        "graceful shutdown is therefore tested on the installed copy, which needs the installer.",
      modal_observed: modalNotice,
    });
    facts.shutdown = { tested: false, reason: "duplicate_copy_notice" };
  } else {
    record("graceful_shutdown", exited && facts.launch.leftover_helpers.length === 0, {
      exited,
      leftover_helpers: facts.launch.leftover_helpers,
    });
    facts.shutdown = { tested: true, exited, leftover_helpers: facts.launch.leftover_helpers };
  }
  if (!exited && mainPid) capture("/bin/kill", ["-KILL", String(mainPid)]);
  rmSync(home, { recursive: true, force: true });
}

finish();

function finish() {
  const optional = new Set([
    ...(SMOKE ? [] : ["package_smoke"]),
    ...(LAUNCH ? [] : ["launchservices_launch", "graceful_shutdown", "duplicate_copy_notice"]),
    ...(LAUNCH && !existsSync("/Applications/Mona.app") ? ["duplicate_copy_notice"] : []),
    ...(shutdownNotTestable ? ["graceful_shutdown"] : []),
  ]);
  const requiredChecks = Object.entries(checks).filter(([name]) => !optional.has(name));
  const failed = requiredChecks.filter(([, value]) => !value.ok).map(([name]) => name);
  const report = {
    schema_version: 1,
    label: "R13 candidate verification",
    captured_at: new Date().toISOString(),
    host: {
      macos: capture("/usr/bin/sw_vers", ["-productVersion"]).stdout.trim(),
      architecture: capture("/usr/bin/uname", ["-m"]).stdout.trim(),
    },
    app: appPath,
    ok: failed.length === 0,
    failed,
    checks,
    facts,
    note:
      "Read from the artifact itself: the bundle's own component manifest, every listed file hashed, " +
      "every Mach-O header decoded, and the shipped bundles searched for the review's own channel names. " +
      "No engine is started and no model request is made.",
  };
  const text = JSON.stringify(report, null, 2);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${text}\n`);
  }
  process.stdout.write(`${text}\n`);
  process.exit(report.ok ? 0 : 1);
}
