#!/usr/bin/env node
// P09 native proof: the Finder Service is discovered by macOS and launched by
// the Services mechanism, not by a terminal.
//
// The harness puts the pasteboard types Finder puts down and calls
// NSPerformService with the advertised menu title. A receiver app that claims
// Mona's bundle identity records exactly what it received. The Service itself
// is installed in the per-user Services folder (development scope) and removed
// again at the end.
//
// usage: node scripts/service-smoke.mjs [--keep-installed]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const HOME = process.env.HOME ?? tmpdir();
const LSR =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const SERVICE_SOURCE = join(ROOT, "native/macos-services/build/Mona.service");
const SERVICE_SERVICE_RECEIPT = join(
  HOME,
  "Library/Application Support/Mona/services/last-handoff.json",
);
const SERVICE_TRACE = join(HOME, "Library/Application Support/Mona/services/service-trace.json");
const PROBE_RECEIPT = join(HOME, "Library/Application Support/Mona/services/probe-received.json");
const INSTALLED = join(HOME, "Library/Services/Mona.service");
const MENU_TITLE = "Start new DS project with Mona";
const EVIDENCE = join(ROOT, "docs/evidence/macos/artifacts/p09-service-smoke.json");
const KEEP = process.argv.includes("--keep-installed");

const report = {
  schema_version: 1,
  label: "P09 NATIVE FINDER SERVICE — macOS discovery and launch",
  captured_at: new Date().toISOString(),
  ok: false,
  host: { platform: process.platform, arch: process.arch },
  build: null,
  registration: null,
  cases: [],
  checks: {},
  cleanup: {},
  error: null,
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function statIdentity(path) {
  const info = statSync(path);
  return { device: Number(info.dev), inode: Number(info.ino) };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function killProcesses(pattern) {
  spawnSync("pkill", ["-f", pattern], { encoding: "utf8" });
}

function engineProcesses() {
  const result = run("ps", ["-ax", "-o", "pid=,comm="]);
  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /codewhale|mona-supervisor/.test(line));
}

function perform({ mode = "url", paths = [] }) {
  const harness = join(
    ROOT,
    "native/macos-services/build/P09Harness.app/Contents/MacOS/P09Harness",
  );
  const receipt = join(tmpdir(), "mona-p09-harness.json");
  rmSync(receipt, { force: true });
  const args = ["--mode", mode, "--service", MENU_TITLE, "--receipt", receipt];
  for (const path of paths) args.push("--path", path);
  const result = run(harness, args, { timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: readJson(receipt),
  };
}

function resetReceipts() {
  for (const path of [SERVICE_SERVICE_RECEIPT, PROBE_RECEIPT, SERVICE_TRACE]) {
    rmSync(path, { force: true });
  }
}

/**
 * Perform the Service and wait for both receipts. Registration is refreshed and
 * retried once — pbs can briefly serve a stale record after a bundle is
 * replaced, and a bounded, recorded retry is honest where a hang is not.
 */
async function performAndObserve(name, folder) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    resetReceipts();
    killProcesses("MonaProbe");
    killProcesses("MonaService");
    await sleep(120);
    const started = Date.now();
    const performed = perform({ mode: "url", paths: [folder] });
    const received = await waitFor(() => existsSync(PROBE_RECEIPT), 12_000);
    const receipt = readJson(SERVICE_SERVICE_RECEIPT);
    const probe = readJson(PROBE_RECEIPT);
    attempts.push({
      attempt,
      performed: performed.status === 0 && performed.receipt?.performed === true,
      stdout: performed.stdout,
      service_receipt_written: receipt !== null,
      probe_received: received,
      elapsed_ms: Date.now() - started,
    });
    if (received) {
      killProcesses("MonaProbe");
      return { attempts, receipt, probe };
    }
    // Refresh the registration and try once more.
    run(LSR, ["-f", INSTALLED], { timeout: 20_000 });
    await sleep(600);
  }
  killProcesses("MonaProbe");
  return { attempts, receipt: readJson(SERVICE_SERVICE_RECEIPT), probe: null };
}

/**
 * Perform a selection and record what actually happened. The harness boolean
 * only says the request was sent; the Service's own receipt says whether the
 * Service ran.
 */
async function performAndObserveQuiet(name, options) {
  resetReceipts();
  killProcesses("MonaProbe");
  killProcesses("MonaService");
  await sleep(150);
  const result = perform(options);
  const serviceRan = await waitFor(() => existsSync(SERVICE_SERVICE_RECEIPT), 4_000);
  const receipt = readJson(SERVICE_SERVICE_RECEIPT);
  const probe = readJson(PROBE_RECEIPT);
  killProcesses("MonaService");
  await sleep(200);
  return {
    harness_performed: result.receipt?.performed ?? null,
    service_ran: serviceRan,
    service_receipt: receipt,
    probe_received: probe !== null,
    probe,
  };
}

function caseRecord(name, extra) {
  const record = { name, at: new Date().toISOString(), ...extra };
  report.cases.push(record);
  return record;
}

/**
 * Read what the system publishes about the Service. Both sources are caches
 * that the Services machinery fills in on first resolution, so they are sampled
 * before and after the first handoff.
 */
function readRegistration() {
  const dumpResult = run(LSR, ["-dump"], { timeout: 120_000 });
  const dump = dumpResult.stdout ?? "";
  const lines = dump.split("\n");
  // The dump pads the field, so match the record by its own shape.
  const recordIndex = lines.findIndex(
    (line) => /^service id:\s+/.test(line) && line.includes(MENU_TITLE),
  );
  const record = recordIndex >= 0 ? lines.slice(recordIndex, recordIndex + 6).join("\n") : null;

  const vendResult = run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    join(HOME, "Library/Preferences/com.apple.ServicesMenu.Services.plist"),
  ]);
  let vended = null;
  try {
    const parsed = JSON.parse(vendResult.stdout);
    vended =
      (parsed?.NSServices?.CFVendedServices ?? []).find(
        (entry) => entry?.NSBundleIdentifier === "com.mona.workbench.service",
      ) ?? null;
  } catch {
    vended = null;
  }

  const installedPlistResult = run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    join(INSTALLED, "Contents/Info.plist"),
  ]);
  let declared = null;
  try {
    const parsed = JSON.parse(installedPlistResult.stdout);
    declared = parsed?.NSServices?.[0] ?? null;
  } catch {
    declared = null;
  }

  return {
    discovered: Boolean(record) || vended !== null,
    record,
    dump_status: dumpResult.status,
    dump_bytes: dump.length,
    vended: vended
      ? {
          bundle_path: vended.NSBundlePath,
          menu_item: vended.NSMenuItem?.default ?? null,
          message: vended.NSMessage,
          send_file_types: vended.NSSendFileTypes ?? [],
          send_types: vended.NSSendTypes ?? [],
        }
      : null,
    declared: declared
      ? {
          menu_item: declared.NSMenuItem?.default ?? null,
          message: declared.NSMessage ?? null,
          port: declared.NSPortName ?? null,
          send_file_types: declared.NSSendFileTypes ?? [],
          send_types: declared.NSSendTypes ?? [],
          restricted: declared.NSRestricted ?? null,
        }
      : null,
    enabled_by_macos: (run("defaults", ["read", "pbs", "NSServicesStatus"]).stdout || "").includes(
      MENU_TITLE,
    ),
  };
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    report.ok = false;
    report.error = `the Finder Service proof requires macOS arm64; this host is ${process.platform}/${process.arch}`;
    writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }

  const build = run("node", [join(ROOT, "scripts/build-service.mjs")], { timeout: 120_000 });
  report.build =
    build.status === 0 ? JSON.parse(build.stdout) : { ok: false, stderr: build.stderr };
  if (build.status !== 0) throw new Error("service build failed");

  const fixtures = run("node", [join(ROOT, "scripts/build-service-fixtures.mjs")], {
    timeout: 120_000,
  });
  if (fixtures.status !== 0) throw new Error(`fixture build failed: ${fixtures.stderr}`);

  // Development installation: per-user Services folder, clearly scoped.
  rmSync(INSTALLED, { recursive: true, force: true });
  mkdirSync(join(HOME, "Library/Services"), { recursive: true });
  cpSync(SERVICE_SOURCE, INSTALLED, { recursive: true });
  writeFileSync(
    join(ROOT, "native/macos-services/build/install-manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        installed_at: new Date().toISOString(),
        scope: "user",
        path: INSTALLED,
        bundle_identifier: "com.mona.workbench.service",
        menu_title: MENU_TITLE,
        executable_sha256: sha256(join(INSTALLED, "Contents/MacOS/MonaService")),
        uninstall: `rm -rf "${INSTALLED}" && ${LSR} -u "${INSTALLED}"`,
      },
      null,
      2,
    )}\n`,
  );

  run(LSR, ["-f", INSTALLED], { timeout: 20_000 });
  run(LSR, ["-f", join(ROOT, "native/macos-services/build/MonaProbe.app")], { timeout: 20_000 });
  run(LSR, ["-f", join(ROOT, "native/macos-services/build/P09Harness.app")], { timeout: 20_000 });
  await sleep(1_200);

  const registrationBefore = readRegistration();
  report.registration = registrationBefore;

  const workspace = mkdtempSync(join(tmpdir(), "mona-p09-service-"));
  const plain = join(workspace, "plain folder");
  const awkward = join(workspace, "space 'quote' $dollar; semicolon");
  const newline = join(workspace, "line\nbreak");
  const unicode = join(workspace, "cafe\u0301-decomposed");
  const fileItem = join(workspace, "a file.txt");
  for (const path of [plain, awkward, newline, unicode]) mkdirSync(path, { recursive: true });
  writeFileSync(fileItem, "not a folder\n");

  const engineBefore = engineProcesses();

  // 1) The real path: a selected folder is forwarded to the app identity.
  const main = await performAndObserve("folder", plain);
  const probePath = main.probe?.paths?.[0] ?? null;
  const expectedIdentity = statIdentity(plain);
  const receivedIdentity = probePath && existsSync(probePath) ? statIdentity(probePath) : null;
  caseRecord("folder", {
    attempts: main.attempts,
    performed: main.attempts.some((attempt) => attempt.performed),
    service_receipt: main.receipt,
    probe: main.probe,
    expected_identity: expectedIdentity,
    received_identity: receivedIdentity,
  });

  report.registration_after_handoff = readRegistration();

  for (const [name, folder] of [
    ["awkward_characters", awkward],
    ["newline_in_name", newline],
    ["unicode_decomposed", unicode],
  ]) {
    const result = await performAndObserve(name, folder);
    caseRecord(name, {
      attempts: result.attempts,
      performed: result.attempts.some((attempt) => attempt.performed),
      service_receipt: result.receipt,
      probe: result.probe,
      expected_identity: statIdentity(folder),
      received_identity:
        result.probe?.paths?.[0] && existsSync(result.probe.paths[0])
          ? statIdentity(result.probe.paths[0])
          : null,
    });
  }

  // 2) A selected file still reaches the Service when a harness performs it
  //    directly (pbs does not re-filter the menu), and the Service refuses it.
  const fileCase = await performAndObserveQuiet("file", { mode: "url", paths: [fileItem] });
  caseRecord("file_selection", fileCase);

  // 3) No empty Finder-background invocation is possible: an empty pasteboard
  //    never reaches the Service at all.
  const emptyCase = await performAndObserveQuiet("empty", { mode: "empty" });
  caseRecord("empty_selection", emptyCase);

  // 4) A text-only selection never reaches the Service either.
  const textCase = await performAndObserveQuiet("text", { mode: "text", paths: ["hello"] });
  caseRecord("text_selection", textCase);

  // 5) Multi-selection is a deliberate decision in the Service, and a typed
  //    refusal in CLI mode. The alert itself is a human-facing control.
  const service = join(INSTALLED, "Contents/MacOS/MonaService");
  const multi = run(service, [
    "--cli",
    "--dry-run",
    "--pick-first",
    "--open-folder",
    plain,
    "--open-folder",
    awkward,
  ]);
  const multiRefused = run(service, [
    "--cli",
    "--dry-run",
    "--open-folder",
    plain,
    "--open-folder",
    awkward,
  ]);
  caseRecord("multi_selection", {
    pick_first: { status: multi.status, receipt: safeJson(multi.stdout) },
    refused: { status: multiRefused.status, receipt: safeJson(multiRefused.stdout) },
  });

  // 6) Validation refuses a file and a missing path with concrete codes.
  const fileRefusal = run(service, ["--cli", "--dry-run", "--open-folder", fileItem]);
  const missingRefusal = run(service, [
    "--cli",
    "--dry-run",
    "--open-folder",
    join(workspace, "gone"),
  ]);
  const httpsRefusal = run(service, [
    "--cli",
    "--dry-run",
    "--open-folder",
    "https://example.com/x",
  ]);
  caseRecord("cli_refusals", {
    file: { status: fileRefusal.status, code: safeJson(fileRefusal.stdout)?.code ?? null },
    missing: { status: missingRefusal.status, code: safeJson(missingRefusal.stdout)?.code ?? null },
    scheme: { status: httpsRefusal.status, code: safeJson(httpsRefusal.stdout)?.code ?? null },
  });

  const engineAfter = engineProcesses();

  const checks = {
    service_registered:
      main.attempts.some((attempt) => attempt.performed) ||
      report.registration_after_handoff?.discovered === true,
    service_listed_by_system:
      report.registration_after_handoff?.discovered === true ||
      report.registration?.discovered === true,
    service_discovered_by_macos: main.attempts.some((attempt) => attempt.performed),
    folder_forwarded: main.receipt?.forwarded === true && main.receipt?.ok === true,
    app_located_by_identity:
      main.receipt?.notes?.some((note) => note.includes("bundle identity")) === true,
    exact_folder_received:
      receivedIdentity !== null &&
      receivedIdentity.device === expectedIdentity.device &&
      receivedIdentity.inode === expectedIdentity.inode,
    service_receipt_matches: main.receipt?.resolved_path === plain,
    awkward_characters_forwarded: exactCase("awkward_characters"),
    newline_forwarded: exactCase("newline_in_name"),
    unicode_forwarded: exactCase("unicode_decomposed"),
    declared_folder_only:
      report.registration_after_handoff?.declared?.send_file_types?.includes("public.folder") ===
        true && (report.registration_after_handoff?.declared?.send_types ?? []).length === 0,
    file_selection_refused:
      report.cases.find((entry) => entry.name === "file_selection")?.service_receipt?.code ===
        "NOT_A_DIRECTORY" &&
      report.cases.find((entry) => entry.name === "file_selection")?.probe_received === false,
    empty_selection_refused:
      report.cases.find((entry) => entry.name === "empty_selection")?.service_receipt?.code ===
        "NO_FILE_URL" &&
      report.cases.find((entry) => entry.name === "empty_selection")?.probe_received === false,
    text_selection_refused:
      report.cases.find((entry) => entry.name === "text_selection")?.service_receipt?.code ===
        "NO_FILE_URL" &&
      report.cases.find((entry) => entry.name === "text_selection")?.probe_received === false,
    multi_requires_choice:
      report.cases.find((entry) => entry.name === "multi_selection")?.refused?.receipt?.code ===
      "MULTI_SELECTION",
    multi_pick_first_forwards:
      report.cases.find((entry) => entry.name === "multi_selection")?.pick_first?.receipt?.ok ===
      true,
    cli_file_refused:
      report.cases.find((entry) => entry.name === "cli_refusals")?.file?.code === "NOT_A_DIRECTORY",
    cli_missing_refused:
      report.cases.find((entry) => entry.name === "cli_refusals")?.missing?.code === "MISSING",
    cli_scheme_refused:
      report.cases.find((entry) => entry.name === "cli_refusals")?.scheme?.code ===
      "UNSUPPORTED_SCHEME",
    no_engine_process_spawned: engineAfter.length === engineBefore.length,
    no_orphaned_service: !run("pgrep", ["-f", "MonaService"]).stdout,
  };
  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);

  function exactCase(name) {
    const entry = report.cases.find((candidate) => candidate.name === name);
    const expected = entry?.expected_identity;
    const received = entry?.received_identity;
    return (
      entry?.performed === true &&
      entry?.service_receipt?.ok === true &&
      expected &&
      received &&
      expected.device === received.device &&
      expected.inode === received.inode
    );
  }
  return workspace;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let workspace = null;
try {
  workspace = await main();
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

// Cleanup: remove the development installation and the test-only app records.
killProcesses("MonaProbe");
killProcesses("MonaService");
if (!KEEP) {
  rmSync(INSTALLED, { recursive: true, force: true });
  run(LSR, ["-u", INSTALLED], { timeout: 20_000 });
  run(LSR, ["-u", join(ROOT, "native/macos-services/build/MonaProbe.app")], { timeout: 20_000 });
  run(LSR, ["-u", join(ROOT, "native/macos-services/build/P09Harness.app")], { timeout: 20_000 });
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}
report.cleanup = {
  kept_installed: KEEP,
  service_removed: !existsSync(INSTALLED),
  probe_unregistered: !run(LSR, ["-dump"], { timeout: 60_000 }).stdout.includes("MonaProbe.app"),
};

mkdirSync(join(ROOT, "docs/evidence/macos/artifacts"), { recursive: true });
writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: report.ok, checks: report.checks, evidence: EVIDENCE }, null, 2));
process.exit(report.ok ? 0 : 1);
