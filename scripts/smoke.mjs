#!/usr/bin/env node
// Launch the real Electron shell, verify what it actually loaded, and report
// bundle/process evidence. PATH is stripped to simulate a Finder launch.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-smoke-"));
const outFile = join(outDir, "smoke.json");

const child = spawn(electron, [".", "--smoke"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: "/usr/bin:/bin",
    MONA_SMOKE_OUT: outFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let result = null;
try {
  result = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  result = { ok: false, error: "smoke result missing" };
}

const EXPECTED_BRIDGE = [
  "getAppInfo",
  "getPaths",
  "discoverTools",
  "listProjects",
  "openProject",
  "projectDetail",
  "renameProject",
  "setProjectPinned",
  "setProjectArchived",
  "removeProject",
  "relocateProject",
  "revealProject",
  "saveProjectView",
  "saveDraft",
  "runtimeStatus",
  "stateFacts",
  "onProjectsChanged",
  "pathForDroppedFile",
  "openDroppedFolder",
  "openStatus",
  "serviceStatus",
  "refreshService",
  "openServiceSettings",
  "onOpenResult",
  "studioState",
  "startStudio",
  "submitTask",
  "interruptNow",
  "pauseAfterTask",
  "resumeQueue",
  "cancelQueued",
  "reconcileSubmission",
  "stopStudio",
  "onStudioChanged",
].sort();

const checks = {
  exit_zero: code === 0,
  ok: result.ok === true,
  renderer_ready: result.renderer?.ready === true,
  bridge_present: result.renderer?.hasBridge === true,
  version_rendered:
    typeof result.renderer?.versionText === "string" &&
    result.renderer.versionText.includes(result.app?.version ?? "?"),
  node_globals_absent:
    result.security?.observed?.require === "undefined" &&
    result.security?.observed?.process === "undefined" &&
    result.security?.observed?.module === "undefined",
  bridge_is_narrow:
    JSON.stringify([...(result.security?.observed?.bridgeKeys ?? [])].sort()) ===
    JSON.stringify(EXPECTED_BRIDGE),
  context_isolation: result.security?.configured?.contextIsolation === true,
  node_integration_off: result.security?.configured?.nodeIntegration === false,
  sandbox_on: result.security?.configured?.sandbox === true,
  web_security_on: result.security?.configured?.webSecurity === true,
  window_open_denied: result.security?.observed?.windowOpenResult === "null",
  csp_connect_none: String(result.renderer?.csp ?? "").includes("connect-src 'none'"),
  supports_paths:
    typeof result.paths?.support === "string" &&
    result.paths.support.includes("Application Support"),
  tool_found_without_shell_path: (result.tools ?? []).some(
    (tool) => tool.name === "codewhale" && tool.path,
  ),
  services_menu_present: (result.menu_roles ?? []).includes("services"),
  quit_menu_present: (result.menu_roles ?? []).includes("quit"),
  state_database_open: result.state?.open === true,
  state_integrity_clean: (result.state?.stats?.integrity ?? []).length === 0,
  state_permissions_private: (result.state?.permission_problems ?? []).length === 0,
};

const ok = Object.values(checks).every(Boolean);
const report = {
  ok,
  checks,
  app: result.app ?? null,
  renderer: result.renderer ?? null,
  security: result.security ?? null,
  paths: result.paths ?? null,
  state: result.state ?? null,
  tools: result.tools ?? null,
  menu_roles: result.menu_roles ?? null,
  process: {
    metrics: result.metrics ?? [],
    total_working_set_kb: result.total_working_set_kb ?? null,
  },
  electron: {
    exit: code,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
  },
};
console.log(JSON.stringify(report, null, 2));
await rm(outDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
