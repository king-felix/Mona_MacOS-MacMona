#!/usr/bin/env node
// R02 long-session evidence. Launch the real Electron shell against a
// temporary state store holding a 10,000+ event project, then drive paged
// history: Load earlier, scroll anchoring, Jump to latest, and thread
// selection. No runtime is started and no model request is made anywhere in
// this script or the app run it launches.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-history-smoke-"));
const outFile = join(outDir, "report.json");
const userDataDir = await mkdtemp(join(tmpdir(), "mona-history-smoke-userdata-"));

const child = spawn(electron, [".", "--history-smoke", `--user-data-dir=${userDataDir}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONA_HISTORY_SMOKE_OUT: outFile,
    MONA_HISTORY_SMOKE_OUT_DIR: join(
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
  report = { ok: false, error: "history smoke report missing" };
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
