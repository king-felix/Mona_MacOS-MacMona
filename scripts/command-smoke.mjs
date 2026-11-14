#!/usr/bin/env node
// R03 command-autocomplete evidence. Launch the real Electron shell against a
// temporary state store and a real project, then drive the composer's Codewhale
// command list with real keyboard and pointer events. No runtime is started and
// no model request is made anywhere in this script or the app run it launches.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-command-smoke-"));
const outFile = join(outDir, "report.json");
const userDataDir = await mkdtemp(join(tmpdir(), "mona-command-smoke-userdata-"));

const child = spawn(electron, [".", "--command-smoke", `--user-data-dir=${userDataDir}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONA_COMMAND_SMOKE_OUT: outFile,
    MONA_COMMAND_SMOKE_OUT_DIR: join(
      ROOT,
      "docs",
      "evidence",
      "macos",
      "review-studio",
      "artifacts",
    ),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let report = null;
try {
  report = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  report = { ok: false, error: "command smoke report missing" };
}

const output = {
  ...report,
  electron: {
    exit: code,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
  },
};
console.log(JSON.stringify(output, null, 2));
await rm(outDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
