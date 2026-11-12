#!/usr/bin/env node
// P09 application proof: a real Finder Service handoff into a real Mona app.
//
// The native smoke proves the Service is discovered and launched by macOS. This
// script proves what the actual application does with the handoff:
//   - the folder is registered once and selected;
//   - the composer is focused;
//   - no runtime starts and no task is created;
//   - a second handoff reuses the same project and the same window.
//
// It uses a development bundle built from the local Electron runtime with Mona's
// bundle identifier, installed in ~/Applications (LaunchServices ignores bundles
// in temporary directories), ad-hoc signed, and removed again afterwards.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const HOME = homedir();
const LSR =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const APP = join(HOME, "Applications/MonaDev.app");
const SERVICE = join(HOME, "Library/Services/Mona.service");
const SERVICE_BUILD = join(ROOT, "native/macos-services/build/Mona.service");
const HARNESS = join(ROOT, "native/macos-services/build/P09Harness.app/Contents/MacOS/P09Harness");
const SUPPORT = join(HOME, "Library/Application Support/Mona");
const APP_REPORT = join(SUPPORT, "open-smoke.json");
const APP_SHOT = join(SUPPORT, "p09-open-handoff.png");
const SERVICE_RECEIPT = join(SUPPORT, "services/last-handoff.json");
const SERVICE_TRACE = join(SUPPORT, "services/service-trace.json");
const ARTIFACTS = join(ROOT, "docs/evidence/macos/artifacts");
const EVIDENCE = join(ARTIFACTS, "p09-app-handoff.json");
const MENU_TITLE = "Start new DS project with Mona";

const report = {
  schema_version: 1,
  label: "P09 APPLICATION HANDOFF — real Service into the built app",
  captured_at: "",
  ok: false,
  phases: [],
  steps: [],
  checks: {},
  service_receipt: null,
  app: null,
  screenshots: [],
  error: null,
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: options.cwd ?? ROOT,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function phase(name, extra = {}) {
  report.phases.push({ phase: name, at: new Date().toISOString(), ...extra });
}

function kill(pattern) {
  spawnSync("pkill", ["-f", pattern], { encoding: "utf8" });
}

/** Patch the cloned bundle's identity and sign it. */
function buildDevBundle() {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(join(HOME, "Applications"), { recursive: true });
  const copy = run("cp", ["-R", join(ROOT, "node_modules/electron/dist/Electron.app"), APP], {
    timeout: 180_000,
  });
  if (copy.status !== 0) throw new Error(`could not clone Electron.app: ${copy.stderr}`);

  const plistPath = join(APP, "Contents/Info.plist");
  const png = run("/usr/bin/plutil", [
    "-replace",
    "CFBundleIdentifier",
    "-string",
    "com.mona.workbench",
    plistPath,
  ]);
  if (png.status !== 0) throw new Error(`could not patch bundle identifier: ${png.stderr}`);
  run("/usr/bin/plutil", ["-replace", "CFBundleName", "-string", "Mona", plistPath]);
  run("/usr/bin/plutil", ["-replace", "CFBundleDisplayName", "-string", "Mona", plistPath]);
  run("/usr/bin/plutil", [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    "0.1.0-p09",
    plistPath,
  ]);

  const sign = run("codesign", ["--force", "--deep", "--sign", "-", APP], { timeout: 180_000 });
  const verify = run("codesign", ["--verify", "--strict", APP]);
  if (sign.status !== 0 || verify.status !== 0) {
    throw new Error(`dev bundle signing failed: ${sign.stderr} ${verify.stderr}`);
  }
  run(LSR, ["-f", APP], { timeout: 60_000 });
  const infoPath = "/tmp/mona-dev-info.json";
  run("/usr/bin/plutil", ["-convert", "json", "-o", infoPath, plistPath]);
  const identity = readJson(infoPath);
  return {
    path: APP,
    bundle_identifier: identity?.CFBundleIdentifier ?? null,
    signature: "ad-hoc",
    signed: sign.status === 0,
    verified: verify.status === 0,
  };
}

function installService() {
  rmSync(SERVICE, { recursive: true, force: true });
  mkdirSync(join(HOME, "Library/Services"), { recursive: true });
  cpSync(SERVICE_BUILD, SERVICE, { recursive: true });
  run(LSR, ["-f", SERVICE], { timeout: 60_000 });
  run(LSR, ["-f", join(ROOT, "native/macos-services/build/P09Harness.app")], { timeout: 60_000 });
}

function performService(folder) {
  const receipt = join(tmpdir(), "mona-p09-app-harness.json");
  rmSync(receipt, { force: true });
  const result = run(HARNESS, [
    "--mode",
    "url",
    "--service",
    MENU_TITLE,
    "--path",
    folder,
    "--receipt",
    receipt,
  ]);
  return { status: result.status, receipt: readJson(receipt) };
}

async function main() {
  rmSync(APP_REPORT, { force: true });
  rmSync(APP_SHOT, { force: true });
  kill("MonaDev.app/Contents/MacOS/Electron");
  kill("MonaProbe");
  kill("MonaService");
  await sleep(400);

  const build = run("npm", ["run", "build"], { timeout: 300_000 });
  if (build.status !== 0) throw new Error(`app build failed: ${build.stderr.slice(-2000)}`);
  phase("built");

  report.app = buildDevBundle();
  phase("dev_bundle", report.app);

  const serviceBuild = run("node", ["scripts/build-service.mjs"], { timeout: 180_000 });
  if (serviceBuild.status !== 0) throw new Error(`service build failed: ${serviceBuild.stderr}`);
  const fixtures = run("node", ["scripts/build-service-fixtures.mjs"], { timeout: 180_000 });
  if (fixtures.status !== 0) throw new Error(`fixture build failed: ${fixtures.stderr}`);
  installService();
  phase("service_installed", { path: SERVICE });

  const project = join(tmpdir(), `mona p09 project ${process.pid}`);
  mkdirSync(project, { recursive: true });
  const launch = run("open", ["-n", "-a", APP, "--args", ROOT, "--open-smoke"]);
  if (launch.status !== 0) throw new Error(`could not launch Mona: ${launch.stderr}`);
  phase("launched");

  const ready = await waitFor(
    () => (readJson(APP_REPORT)?.phases ?? []).some((entry) => entry.phase === "ready"),
    60_000,
  );
  if (!ready) throw new Error("the application never reported ready");

  // First handoff. If the Services daemon serves a stale record after the
  // bundle was replaced, reinstall once and retry — bounded and recorded.
  let first = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    rmSync(SERVICE_RECEIPT, { force: true });
    rmSync(SERVICE_TRACE, { force: true });
    const performed = performService(project);
    const observed = await waitFor(
      () =>
        (readJson(APP_REPORT)?.phases ?? []).some(
          (entry) => entry.phase === "first_observed" || entry.phase === "first_request",
        ),
      15_000,
    );
    report.steps.push({ step: "first_handoff", attempt, harness: performed.receipt, observed });
    if (observed) {
      first = performed;
      break;
    }
    installService();
    await sleep(800);
  }
  if (!first) throw new Error("the first Finder handoff never reached the application");
  phase("first_handoff");

  const reportAfterFirst = readJson(APP_REPORT);
  const second = performService(project);
  const secondObserved = await waitFor(
    () => (readJson(APP_REPORT)?.phases ?? []).some((entry) => entry.phase === "second_observed"),
    30_000,
  );
  report.steps.push({ step: "second_handoff", harness: second.receipt, observed: secondObserved });
  if (!secondObserved) throw new Error("the second Finder handoff never reached the application");
  phase("second_handoff");

  const finished = await waitFor(() => {
    const current = readJson(APP_REPORT);
    return Boolean(current?.captured_at);
  }, 30_000);
  const finalReport = readJson(APP_REPORT);
  phase("finished", { report_written: finished });

  const exited = await waitFor(
    () => !run("pgrep", ["-fl", "MonaDev.app/Contents/MacOS/Electron"]).stdout,
    20_000,
  );
  phase("app_exited", { exited });

  report.service_receipt = readJson(SERVICE_RECEIPT);
  report.service_trace = readJson(SERVICE_TRACE);

  const checks = {
    app_is_bundle_identity: report.app?.bundle_identifier === "com.mona.workbench",
    app_signed_and_verified: report.app?.signed === true && report.app?.verified === true,
    service_forwarded: first?.receipt?.performed === true && report.service_receipt?.ok === true,
    service_used_bundle_identity:
      report.service_receipt?.notes?.some((note) => note.includes("bundle identity")) === true,
    app_received_handoff: (reportAfterFirst?.phases ?? []).some(
      (entry) => entry.phase === "first_request",
    ),
    project_registered: finalReport?.checks?.handoff_created_project === true,
    studio_selected: finalReport?.checks?.studio_selected === true,
    composer_focused: finalReport?.checks?.composer_focused === true,
    no_runtime_started: finalReport?.checks?.no_runtime_started === true,
    no_task_created: finalReport?.checks?.no_task_created === true,
    single_window: finalReport?.checks?.single_window === true,
    catalog_not_duplicated: finalReport?.checks?.catalog_single_entry === true,
    second_handoff_reused: finalReport?.checks?.second_open_reused === true,
    same_project_selected: finalReport?.checks?.same_project_selected === true,
    renderer_not_fixture: finalReport?.checks?.renderer_not_fixture === true,
    app_exited_cleanly: exited,
  };
  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);

  mkdirSync(ARTIFACTS, { recursive: true });
  if (existsSync(APP_SHOT)) {
    cpSync(APP_SHOT, join(ARTIFACTS, "p09-open-handoff.png"));
    report.screenshots.push("docs/evidence/macos/artifacts/p09-open-handoff.png");
  }
  if (finalReport) {
    writeFileSync(join(ARTIFACTS, "p09-app-run.json"), `${JSON.stringify(finalReport, null, 2)}\n`);
  }
  return project;
}

let project = null;
try {
  project = await main();
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  kill("MonaDev.app/Contents/MacOS/Electron");
  kill("MonaService");
  rmSync(SERVICE, { recursive: true, force: true });
  run(LSR, ["-u", SERVICE], { timeout: 60_000 });
  run(LSR, ["-u", APP], { timeout: 60_000 });
  rmSync(APP, { recursive: true, force: true });
  rmSync(join(ROOT, "native/macos-services/build/P09Harness.app"), {
    recursive: true,
    force: true,
  });
  rmSync(APP_REPORT, { force: true });
  if (project) rmSync(project, { recursive: true, force: true });
  rmSync("/tmp/mona-dev-info.json", { force: true });
  report.captured_at = new Date().toISOString();
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({ ok: report.ok, checks: report.checks, evidence: EVIDENCE }, null, 2));
process.exit(report.ok ? 0 : 1);
