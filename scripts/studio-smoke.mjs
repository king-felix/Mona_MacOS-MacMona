#!/usr/bin/env node
// Launch the real Electron shell with a temporary state store, start the owned
// pinned engine, run one tool-enabled Full Access task (write a file and run a
// test), interrupt a second turn, stop the runtime, and verify that history
// survives offline. Writes a JSON receipt and three UI screenshots.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-studio-smoke-"));
const outFile = join(outDir, "report.json");

const child = spawn(electron, [".", "--studio-smoke"], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONA_STUDIO_SMOKE_OUT: outFile,
    MONA_STUDIO_SMOKE_DIR: join(ROOT, "docs", "evidence", "macos", "artifacts"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

const timeout = setTimeout(() => child.kill("SIGKILL"), 260_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let report = null;
try {
  report = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  report = { ok: false, error: "studio smoke report missing" };
}

const output = {
  ...report,
  electron: {
    exit: code,
    stdout: stdout.slice(0, 3000),
    stderr: stderr.slice(0, 3000),
  },
};
console.log(JSON.stringify(output, null, 2));
await rm(outDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
